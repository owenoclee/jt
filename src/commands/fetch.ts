import { parseArgs } from "@std/cli";
import { appendChainEntry, type ChainSnapshot, pruneChain } from "../chain.ts";
import { localContext, withClient, withMeta } from "../context.ts";
import { fail } from "../errors.ts";
import { JiraApiError, type JiraClient } from "../jira/client.ts";
import { searchKeys, searchPage } from "../jira/search.ts";
import { dim, green, red, yellow } from "../render/colors.ts";
import {
  commentsTruncated,
  fetchBaseEntry,
  fetchFieldList,
  integrateFetched,
  issueToBaseEntry,
} from "../sync.ts";
import { ticketsEqual } from "../canonical.ts";
import type { Store } from "../store.ts";
import type { Meta } from "../types.ts";

type PullCtx = ReturnType<typeof localContext> & { meta: Meta; client: JiraClient };

/**
 * Concurrent edits during pagination can reorder issues across pages and hide one from
 * every page we see; re-covering this window on the next pull catches them. Re-integration
 * is idempotent and unchanged issues are skipped by their `updated` stamp, so overlap is
 * nearly free.
 */
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

interface PullCounts {
  new: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  removed: number;
}

/**
 * Integrate a fetched entry and record any committed-layer rewrite in the chain as a
 * synthetic "remote" entry (or prune, when the rebase drained the ticket entirely).
 */
function integrateWithChain(
  store: Store,
  entry: Parameters<typeof integrateFetched>[1],
  rebases: { key: string; fields: string[]; snapshot: ChainSnapshot }[],
): ReturnType<typeof integrateFetched> {
  const key = entry.key;
  const before = store.readCommitted(key)?.bytes ?? null;
  const result = integrateFetched(store, entry);
  const after = store.readCommitted(key);
  if (before !== null && after === null) {
    pruneChain(store, [key]); // rebase made committed equal base — left the changeset
  } else if (after && after.bytes !== before && result.kind === "rebased") {
    rebases.push({
      key,
      fields: result.fields,
      snapshot: { kind: "ticket", ticket: after.ticket },
    });
  }
  return result;
}

function recordRebases(
  store: Store,
  rebases: { key: string; fields: string[]; snapshot: ChainSnapshot }[],
): void {
  if (rebases.length === 0) return;
  const note = `rebase: remote changed ${
    rebases.map((r) => `${r.fields.join("/")} (${r.key})`).join(", ")
  }`;
  appendChainEntry(
    store,
    "remote",
    note,
    Object.fromEntries(rebases.map((r) => [r.key, r.snapshot])),
  );
}

export async function cmdFetch(argv: string[]): Promise<void> {
  const args = parseArgs(argv, { string: ["jql", "limit"] });
  const ctx = withClient(withMeta(localContext()));
  let keys = (args._ as string[]).map((k) => String(k).toUpperCase());

  if (args.jql) {
    const limit = args.limit ? Number(args.limit) : 50;
    keys = [...keys, ...(await searchKeys(ctx.client, args.jql, limit))];
  }
  if (keys.length === 0) fail("jt fetch requires issue keys or --jql '...'");

  const rebases: Parameters<typeof recordRebases>[1] = [];
  for (const key of [...new Set(keys)]) {
    const entry = await fetchBaseEntry(ctx.client, ctx.meta, ctx.ws.config, key);
    report(key, integrateWithChain(ctx.store, entry, rebases));
  }
  recordRebases(ctx.store, rebases);
}

export async function cmdPull(argv: string[] = []): Promise<void> {
  const args = parseArgs(argv, { boolean: ["full"] });
  const ctx = withClient(withMeta(localContext()));
  const { store } = ctx;
  const syncJql = ctx.ws.config.sync?.jql;
  const prevState = store.readSyncState();
  const firstSync = prevState.watermark === null;
  const prevScope = new Set(prevState.scopeKeys);

  const rebases: Parameters<typeof recordRebases>[1] = [];
  const counts: PullCounts = { new: 0, updated: 0, unchanged: 0, conflicts: 0, removed: 0 };
  const integrated = new Set<string>();
  let scope = new Set<string>();

  if (syncJql) {
    if (/\border\s+by\b/i.test(syncJql)) {
      fail("sync.jql must not contain ORDER BY — jt pull adds its own ordering");
    }
    scope = new Set(
      await pullScope(ctx, syncJql, Boolean(args.full), !firstSync, rebases, counts, integrated),
    );
  }

  // Everything tracked but outside the scope: ad-hoc keys, deletion intents, departures.
  const rest = [...new Set([...store.listBaseKeys(), ...store.readDeletions().map((d) => d.key)])]
    .filter((k) => !scope.has(k) && !integrated.has(k));
  if (!syncJql && rest.length === 0) {
    console.log("nothing tracked — run: jt fetch <KEY...>");
    return;
  }
  for (const key of rest) {
    try {
      const entry = await fetchBaseEntry(ctx.client, ctx.meta, ctx.ws.config, key);
      if (syncJql && prevScope.has(key)) {
        handleLeftScope(store, key, entry, rebases, counts);
      } else {
        report(key, integrateWithChain(store, entry, rebases));
      }
    } catch (e) {
      if (e instanceof JiraApiError && e.status === 404) {
        handleRemoteDeleted(store, key);
        counts.removed++;
      } else {
        throw e;
      }
    }
  }
  recordRebases(store, rebases);

  if (syncJql) {
    if (firstSync) {
      store.ackSeen();
      console.log(`cloned: ${scope.size} tickets → tickets/`);
      console.log(dim("  baseline recorded — jt changes will report upstream edits from here on"));
      return;
    }
    const parts = [`${scope.size} in scope`];
    if (counts.new) parts.push(green(`${counts.new} new`));
    if (counts.updated) parts.push(yellow(`${counts.updated} updated`));
    if (counts.removed) parts.push(red(`${counts.removed} removed`));
    if (counts.conflicts) parts.push(red(`${counts.conflicts} in conflict`));
    parts.push(dim(`${counts.unchanged} unchanged`));
    console.log(`pull: ${parts.join(" · ")}`);
    if (counts.new || counts.updated || counts.removed) {
      console.log(dim("  jt changes — review upstream edits since your last ack"));
    }
  }
}

/**
 * Mirror the sync scope: one newest-first full-field search pages until it drops below
 * the watermark (or the scope is exhausted), each hit feeding the normal 3-way
 * integration. Scope membership comes from the same paging when it ran to the end,
 * else from a keys-only sweep.
 */
async function pullScope(
  ctx: PullCtx,
  jql: string,
  full: boolean,
  verbose: boolean,
  rebases: Parameters<typeof recordRebases>[1],
  counts: PullCounts,
  integrated: Set<string>,
): Promise<string[]> {
  const { store, client, meta } = ctx;
  const config = ctx.ws.config;
  const stored = full ? null : store.readSyncState().watermark;
  const cutoff = stored === null || Number.isNaN(Date.parse(stored)) ? null : Date.parse(stored);
  const fields = fetchFieldList(meta, config);

  let maxUpdatedMs = cutoff ?? 0;
  let maxUpdatedIso: string | null = cutoff === null ? null : stored;
  let token: string | undefined;
  let sawOlder = false;
  let complete = false;
  const paged: string[] = [];

  while (true) {
    const page = await searchPage(client, `${jql} ORDER BY updated DESC`, fields, token);
    const issues = page.issues ?? [];
    for (const issue of issues) {
      const key = issue.key as string;
      paged.push(key);
      const upd: string = issue.fields?.updated ?? "";
      const updMs = Date.parse(upd);
      if (!Number.isNaN(updMs) && updMs > maxUpdatedMs) {
        maxUpdatedMs = updMs;
        maxUpdatedIso = upd;
      }
      if (cutoff !== null && !Number.isNaN(updMs) && updMs < cutoff) {
        sawOlder = true; // ordered newest-first: nothing below the watermark has news
        continue;
      }
      const old = store.readBase(key);
      if (!full && old && old.updated === upd) {
        counts.unchanged++;
        integrated.add(key);
        continue;
      }
      const entry = commentsTruncated(issue)
        ? await fetchBaseEntry(client, meta, config, key)
        : issueToBaseEntry(issue, meta, config);
      reportScope(key, integrateWithChain(store, entry, rebases), counts, verbose);
      integrated.add(key);
    }
    if (!page.nextPageToken || issues.length === 0) {
      complete = true;
      break;
    }
    if (sawOlder) break; // deeper pages are older still
    token = page.nextPageToken;
  }

  const scopeKeys = complete ? [...new Set(paged)] : await searchKeys(client, jql, Infinity);

  // Stragglers: in scope but unknown locally and not integrated above (e.g. moved into
  // scope without an `updated` bump). Rare — fetched individually.
  for (const key of scopeKeys) {
    if (integrated.has(key) || store.readBase(key)) continue;
    const entry = await fetchBaseEntry(client, meta, config, key);
    reportScope(key, integrateWithChain(store, entry, rebases), counts, verbose);
    integrated.add(key);
  }

  let watermark: string | null = null;
  if (maxUpdatedIso !== null) {
    const overlapped = maxUpdatedMs - WATERMARK_OVERLAP_MS;
    watermark = new Date(cutoff === null ? overlapped : Math.max(overlapped, cutoff)).toISOString();
  }
  store.writeSyncState({ watermark, scopeKeys: [...scopeKeys].sort() });
  return scopeKeys;
}

/** A previously scoped ticket still exists remotely but no longer matches sync.jql. */
function handleLeftScope(
  store: Store,
  key: string,
  entry: Parameters<typeof integrateFetched>[1],
  rebases: Parameters<typeof recordRebases>[1],
  counts: PullCounts,
): void {
  const base = store.readBase(key);
  const working = store.readWorking(key);
  const clean = base && working && ticketsEqual(working.ticket, base.ticket) &&
    !store.listCommittedIds().includes(key) &&
    !store.readDeletions().some((d) => d.key === key);
  if (clean) {
    store.removeWorking(key);
    store.removeBase(key);
    counts.removed++;
    console.log(`  ${key} ${yellow("left the board — removed local copy")}`);
    return;
  }
  report(key, integrateWithChain(store, entry, rebases));
  console.log(
    `  ${key} ${yellow("left the board but has local changes — still tracked (jt untrack to drop)")}`,
  );
}

function handleRemoteDeleted(store: Store, key: string): void {
  const intent = store.readDeletions().find((d) => d.key === key);
  if (intent) {
    store.writeDeletions(store.readDeletions().filter((d) => d.key !== key));
    store.removeBase(key);
    store.removeCommitted(key);
    console.log(`  ${key} ${dim("already deleted remotely — deletion intent cleared")}`);
    return;
  }
  const base = store.readBase(key);
  const working = store.readWorking(key);
  const clean = base && working && ticketsEqual(working.ticket, base.ticket) &&
    !store.listCommittedIds().includes(key);
  if (clean) {
    store.removeWorking(key);
    store.removeBase(key);
    console.log(`  ${key} ${yellow("deleted remotely — removed local copy")}`);
  } else {
    console.log(
      `  ${key} ${red("deleted remotely but you have local changes")} — jt untrack ${key} to drop them`,
    );
  }
}

function report(key: string, result: ReturnType<typeof integrateFetched>): void {
  switch (result.kind) {
    case "created":
      console.log(`  ${key} ${green("fetched")} → tickets/${key}.json`);
      break;
    case "refreshed":
      console.log(`  ${key} ${dim("refreshed")}`);
      break;
    case "rebased":
      console.log(
        `  ${key} ${yellow("rebased")} — remote changed: ${result.fields.join(", ") || "(comments)"}`,
      );
      break;
    case "kept":
      console.log(`  ${key} ${dim("base updated; working file left as-is")}`);
      break;
    case "conflict":
      console.log(
        `  ${key} ${red("CONFLICT")} on ${result.fields.join(", ")} — ` +
          `edit the working file to the desired final state, then: jt resolve ${key}`,
      );
      break;
  }
}

/** Like report(), but summary-oriented: at mirror scale only events that need eyes get a line. */
function reportScope(
  key: string,
  result: ReturnType<typeof integrateFetched>,
  counts: PullCounts,
  verbose: boolean,
): void {
  switch (result.kind) {
    case "created":
      counts.new++;
      if (verbose) console.log(`  ${key} ${green("new")} → tickets/${key}.json`);
      break;
    case "refreshed":
      counts.updated++;
      break;
    case "rebased":
      counts.updated++;
      console.log(
        `  ${key} ${yellow("rebased")} — remote changed: ${result.fields.join(", ") || "(comments)"}`,
      );
      break;
    case "kept":
      counts.updated++;
      console.log(`  ${key} ${dim("base updated; working file left as-is")}`);
      break;
    case "conflict":
      counts.conflicts++;
      console.log(
        `  ${key} ${red("CONFLICT")} on ${result.fields.join(", ")} — ` +
          `edit the working file to the desired final state, then: jt resolve ${key}`,
      );
      break;
  }
}

