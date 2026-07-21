/**
 * jt push: the single remote-mutating verb — and it is approval-only.
 *
 * Compiles committed−base into exact API ops (never reading the working tree), checks
 * remote staleness, then hands the changeset to the browser review page served from
 * this same process (see src/review/server.ts). A human decision there is the only
 * thing that executes; no headless mutation path exists. --dry-run prints the
 * compiled plan and stops. Executed ops are journaled with approval provenance.
 */
// deno-lint-ignore-file no-explicit-any
import { parseArgs } from "@std/cli";
import { chunks } from "../batch.ts";
import { serializeTicket, ticketsEqual } from "../canonical.ts";
import { pruneChain } from "../chain.ts";
import { compilePush, type CompiledPush } from "../compile.ts";
import { localContext, withClient, withMeta } from "../context.ts";
import { fail } from "../errors.ts";
import { JiraApiError, type JiraClient } from "../jira/client.ts";
import { searchPage } from "../jira/search.ts";
import { bold, cyan, dim, green, red, yellow } from "../render/colors.ts";
// Type-only: the runtime import of the review server stays dynamic (it imports us back).
import type { ReviewOptions } from "../review/server.ts";
import { fetchBaseEntry, integrateFetched } from "../sync.ts";
import type {
  BaseEntry,
  CommentEntry,
  CompiledOp,
  JournalEntry,
  JournalOpResult,
  Meta,
} from "../types.ts";

export type PushContext = ReturnType<typeof localContext> & { meta: Meta; client: JiraClient };

export async function cmdPush(
  argv: string[],
  reviewOpts: Partial<ReviewOptions> = {},
): Promise<void> {
  const args = parseArgs(argv, {
    boolean: ["dry-run"],
    string: ["timeout"],
  });
  const ctx = withClient(withMeta(localContext()));

  const compiled = await compilePush(ctx);
  await checkStaleness(ctx, compiled.existingKeys);

  if (args["dry-run"]) {
    printPlan(compiled.ops, compiled.warnings);
    console.log(`\n${cyan("dry-run")} — nothing sent`);
    return;
  }
  const { runReviewFlow } = await import("../review/server.ts");
  const timeoutMs = args.timeout ? Number(args.timeout) * 1000 : 600_000;
  const outcome = await runReviewFlow(ctx, compiled, { timeoutMs, ...reviewOpts });
  // Exit codes for the agent loop: 0 = approved and pushed whole,
  // 2 = changes requested (notes on stdout), 1 = timeout/stale/push failure.
  if (outcome.status === "timeout" || outcome.status === "stale" || outcome.pushFailure) {
    Deno.exit(1);
  }
  if (outcome.status === "changes-requested") Deno.exit(2);
}

/** Refuse (before any mutation) if remote moved past our base for any staged ticket. */
export async function checkStaleness(ctx: PushContext, existingKeys: string[]): Promise<void> {
  const tracked = existingKeys
    .map((key) => ({ key, base: ctx.store.readBase(key) }))
    .filter((e): e is { key: string; base: BaseEntry } => e.base !== null);
  const stale: string[] = [];
  for (const chunk of chunks(tracked, 200)) {
    const remote = await remoteUpdated(ctx, chunk.map((e) => e.key));
    for (const { key, base } of chunk) {
      const upd = remote.get(key); // absent = gone remotely (delete of already-gone issue)
      if (upd && upd !== base.updated) stale.push(key);
    }
  }
  if (stale.length) {
    fail(
      `remote changed since your last fetch: ${stale.join(", ")} — run jt pull, ` +
        `review, re-commit if needed, then push again`,
    );
  }
}

/**
 * `updated` per key in one search round-trip instead of a GET per issue — large
 * changesets were stalling here before the review URL could print. Jira rejects the
 * whole `key in (...)` query if any key no longer exists, so a 400 falls back to
 * per-key GETs (bounded concurrency), where a 404 means the same thing: gone.
 */
async function remoteUpdated(ctx: PushContext, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    let token: string | undefined;
    do {
      const page = await searchPage(ctx.client, `key in (${keys.join(", ")})`, ["updated"], token);
      for (const issue of page.issues ?? []) {
        out.set(issue.key, issue.fields?.updated ?? "");
      }
      token = page.nextPageToken;
    } while (token);
    return out;
  } catch (e) {
    if (!(e instanceof JiraApiError) || e.status !== 400) throw e;
    out.clear();
  }
  for (const group of chunks(keys, 8)) {
    await Promise.all(group.map(async (key) => {
      try {
        const res = (await ctx.client.get(`/rest/api/3/issue/${key}`, { fields: "updated" })) as any;
        if (res.fields?.updated) out.set(key, res.fields.updated);
      } catch (e) {
        if (e instanceof JiraApiError && e.status === 404) return;
        throw e;
      }
    }));
  }
  return out;
}

export function printPlan(ops: CompiledOp[], warnings: string[]): void {
  console.log(bold(`push plan (${ops.length} operation${ops.length === 1 ? "" : "s"}):`));
  for (const w of warnings) console.log(`  ${yellow("warning:")} ${w}`);
  for (const op of ops) {
    console.log(`\n  ${cyan(op.method.padEnd(6))} ${op.path}  ${dim(op.label)}`);
    if (op.body !== undefined) {
      console.log(indent(JSON.stringify(op.body, null, 2), "    "));
    }
    if (op.transitionTo && !op.body) {
      console.log(dim(`    (transition to '${op.transitionTo}' — id resolved after creation)`));
    }
  }
}

export interface PushResult {
  journal: JournalEntry;
  journalPath: string;
  refMap: Map<string, string>;
  failure: string | null;
  okCount: number;
}

/** Execute ops in order, settle all local layers against reality, journal, prune chain. */
export async function executePush(
  ctx: PushContext,
  ops: CompiledOp[],
  review?: JournalEntry["review"],
): Promise<PushResult> {
  const { store, client } = ctx;
  const journal: JournalEntry = {
    startedAt: new Date().toISOString(),
    result: "success",
    ...(review ? { review } : {}),
    ops: [],
    created: {},
  };
  const refMap = new Map<string, string>();
  const opOutcomes = new Map<string, { ok: number; failed: number }>();
  const postedComments = new Map<string, string[]>();
  let failure: string | null = null;

  const outcome = (issue: string) => {
    let o = opOutcomes.get(issue);
    if (!o) opOutcomes.set(issue, o = { ok: 0, failed: 0 });
    return o;
  };

  for (const op of ops) {
    const resolved = resolveRefs(op, refMap);
    const rec: JournalOpResult = {
      label: resolved.label,
      method: resolved.method,
      path: resolved.path,
      body: resolved.body,
      ok: false,
    };
    journal.ops.push(rec);
    try {
      let body = resolved.body;
      if (resolved.kind === "transition" && !body) {
        const transitionId = await findTransition(client, resolved.path, resolved.transitionTo!);
        body = { transition: { id: transitionId } };
        rec.body = body;
      }
      const response = await client.request(resolved.method, resolved.path, body);
      rec.ok = true;
      rec.status = 200;
      if (resolved.kind === "create") {
        const key = (response as any)?.key;
        if (!key) throw new Error("create returned no issue key");
        refMap.set(op.refId!, key);
        journal.created![op.refId!] = key;
        console.log(`  ${green("✓")} ${resolved.label} ${bold(`→ ${key}`)}`);
      } else {
        console.log(`  ${green("✓")} ${resolved.label}`);
      }
      outcome(op.issue).ok++;
      if (op.kind === "comment" && op.commentBody !== undefined) {
        postedComments.set(op.issue, [...(postedComments.get(op.issue) ?? []), op.commentBody]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rec.ok = false;
      rec.error = msg;
      if (e instanceof JiraApiError) rec.status = e.status;
      console.log(`  ${red("✗")} ${resolved.label}\n    ${red(msg)}`);
      outcome(op.issue).failed++;
      failure = msg;
      break;
    }
  }
  // Ops after a failure never ran — count them as failed for their issues.
  if (failure) {
    for (const op of ops.slice(journal.ops.length)) outcome(op.issue).failed++;
  }

  journal.finishedAt = new Date().toISOString();
  journal.result = failure ? "partial" : "success";
  if (failure) journal.error = failure;

  // ---- settle local state against reality ----
  // The remote changes we just made came from the committed layer, so no 3-way
  // conflict machinery here: base advances to fresh remote state; drifted working
  // edits are preserved; posted comments are de-duplicated by their markdown body.

  // Deletions that succeeded: drop every trace locally.
  for (const d of store.readDeletions().filter((d) => d.committed)) {
    const deleted = journal.ops.some(
      (o) => o.ok && o.method === "DELETE" && o.path.endsWith(`/issue/${d.key}`),
    );
    if (deleted) {
      store.removeBase(d.key);
      store.removeCommitted(d.key);
      store.removeWorking(d.key);
      store.writeDeletions(store.readDeletions().filter((x) => x.key !== d.key));
      store.writeConflicts(store.readConflicts().filter((c) => c.key !== d.key));
    }
  }

  // Creations: swap @name over to the real key.
  for (const [refId, key] of refMap) {
    const committed = store.readCommitted(refId);
    const working = store.readWorking(refId);
    const fullyApplied = (opOutcomes.get(refId)?.failed ?? 0) === 0;
    const untouchedSinceCommit = Boolean(working && committed && working.bytes === committed.bytes);
    store.removeCommitted(refId);
    store.removeWorking(refId);
    const fresh = await tryFetch(ctx, key);
    if (fresh) store.writeBase(fresh);
    if (fullyApplied && untouchedSinceCommit && fresh) {
      store.writeWorking(key, fresh.ticket);
    } else {
      // Keep intent: drifted edits, or committed intents whose follow-up ops failed.
      const source = (untouchedSinceCommit ? committed : working) ?? committed;
      if (source) {
        const t = structuredClone(source.ticket);
        t.key = key;
        rewriteRefs(t, refMap);
        t.comments = reconcileComments(
          fresh?.ticket.comments ?? [],
          t.comments,
          postedComments.get(refId) ?? [],
        );
        store.writeWorking(key, t);
      }
    }
  }
  // Any other working file may reference the newly created keys.
  if (refMap.size > 0) {
    for (const wf of store.listWorking()) {
      const t = structuredClone(wf.ticket);
      if (rewriteRefs(t, refMap)) store.writeWorking(wf.id, t);
    }
  }

  // Link/unlink ops mutate BOTH endpoints remotely — the partner issue needs a
  // refetch too, even though it had no ops of its own.
  const partnerKeys = new Set<string>();
  for (const rec of journal.ops) {
    if (!rec.ok) continue;
    const body = rec.body as { inwardIssue?: { key: string }; outwardIssue?: { key: string } };
    if (rec.path.endsWith("/issueLink") && body) {
      for (const k of [body.inwardIssue?.key, body.outwardIssue?.key]) {
        if (k && !k.startsWith("@")) partnerKeys.add(k);
      }
    }
    const unlinkOp = ops.find((o) => o.kind === "unlink" && o.path === rec.path);
    if (unlinkOp) {
      const base = store.readBase(unlinkOp.issue);
      const entry = Object.entries(base?.raw.linkIds ?? {}).find(([, id]) =>
        rec.path.endsWith(`/issueLink/${id}`)
      );
      if (entry) partnerKeys.add(entry[0].split("|")[1]);
    }
  }

  // Existing tickets that had ops: advance base, clear/trim committed, refresh working.
  const settledKeys = [...opOutcomes.keys()].filter((id) => !id.startsWith("@"));
  for (const key of settledKeys) {
    if (!store.readBase(key)) continue; // deleted above
    const o = opOutcomes.get(key)!;
    if (o.ok === 0) continue; // nothing landed; local state still accurate
    const committed = store.readCommitted(key);
    const working = store.readWorking(key);
    const posted = postedComments.get(key) ?? [];
    const fresh = await tryFetch(ctx, key);
    if (!fresh) {
      console.log(yellow(`  warning: could not refetch ${key} — run jt pull`));
      continue;
    }
    store.writeBase(fresh);
    if (o.failed === 0) {
      store.removeCommitted(key);
      if (!working || (committed && working.bytes === committed.bytes)) {
        store.writeWorking(key, fresh.ticket);
      } else {
        const t = structuredClone(working.ticket);
        t.comments = reconcileComments(fresh.ticket.comments, t.comments, posted);
        store.writeWorking(key, t);
      }
    } else {
      // Partial: keep the remaining delta committed (minus what landed).
      if (committed) {
        const t = structuredClone(committed.ticket);
        t.comments = reconcileComments(fresh.ticket.comments, t.comments, posted);
        if (ticketsEqual(t, fresh.ticket)) store.removeCommitted(key);
        else store.writeCommitted(key, serializeTicket(t));
      }
      if (working) {
        const t = structuredClone(working.ticket);
        t.comments = reconcileComments(fresh.ticket.comments, t.comments, posted);
        store.writeWorking(key, t);
      }
    }
  }

  // Refresh link partners (3-way: the only remote change is the link edge we made,
  // so clean partners refresh and locally-edited ones rebase).
  const alreadySettled = new Set([...settledKeys, ...refMap.values()]);
  for (const key of partnerKeys) {
    if (alreadySettled.has(key) || !store.readBase(key)) continue;
    const fresh = await tryFetch(ctx, key);
    if (fresh) integrateFetched(store, fresh);
  }

  // Tickets that drained out of the changeset leave the commit chain.
  const committedNow = new Set(store.listCommittedIds());
  const committedDeletions = new Set(
    store.readDeletions().filter((d) => d.committed).map((d) => d.key),
  );
  const drained = [...new Set([...opOutcomes.keys(), ...refMap.keys()])].filter(
    (id) => !committedNow.has(id) && !committedDeletions.has(id),
  );
  pruneChain(store, drained);

  const journalPath = store.appendJournal(journal);
  return {
    journal,
    journalPath,
    refMap,
    failure,
    okCount: journal.ops.filter((o) => o.ok).length,
  };
}

async function tryFetch(ctx: PushContext, key: string): Promise<BaseEntry | null> {
  try {
    return await fetchBaseEntry(ctx.client, ctx.meta, ctx.ws.config, key);
  } catch {
    return null;
  }
}

/**
 * Remote comments (with ids) are the truth; local id-less entries survive only if
 * they were NOT posted in this push. Each posted body consumes one matching entry.
 */
function reconcileComments(
  remote: CommentEntry[],
  local: CommentEntry[],
  postedBodies: string[],
): CommentEntry[] {
  const budget = new Map<string, number>();
  for (const b of postedBodies) budget.set(b, (budget.get(b) ?? 0) + 1);
  const pending = local.filter((c) => {
    if (c.id) return false;
    const left = budget.get(c.body) ?? 0;
    if (left > 0) {
      budget.set(c.body, left - 1);
      return false;
    }
    return true;
  });
  return [...remote, ...pending];
}

function resolveRefs(op: CompiledOp, refMap: Map<string, string>): CompiledOp {
  const out = structuredClone(op);
  out.path = out.path.replace(/@[a-z0-9][a-z0-9-_]*/g, (m) => {
    const key = refMap.get(m);
    if (!key) throw new Error(`unresolved reference '${m}' in ${op.label}`);
    return key;
  });
  if (out.body) walkKeys(out.body, refMap, op.label);
  return out;
}

/** Replace "@name" strings in `key` slots (parent / inwardIssue / outwardIssue). */
function walkKeys(node: unknown, refMap: Map<string, string>, label: string): void {
  if (Array.isArray(node)) {
    for (const item of node) walkKeys(item, refMap, label);
    return;
  }
  if (node && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (k === "key" && typeof v === "string" && v.startsWith("@")) {
        const resolved = refMap.get(v);
        if (!resolved) throw new Error(`unresolved reference '${v}' in ${label}`);
        rec[k] = resolved;
      } else {
        walkKeys(v, refMap, label);
      }
    }
  }
}

/** Rewrite @refs in parent/links to real keys; returns whether anything changed. */
function rewriteRefs(
  t: { parent: string | null; links: { to: string }[] },
  refMap: Map<string, string>,
): boolean {
  let changed = false;
  if (t.parent && refMap.has(t.parent)) {
    t.parent = refMap.get(t.parent)!;
    changed = true;
  }
  for (const l of t.links) {
    if (refMap.has(l.to)) {
      l.to = refMap.get(l.to)!;
      changed = true;
    }
  }
  return changed;
}

async function findTransition(
  client: JiraClient,
  transitionPath: string,
  target: string,
): Promise<string> {
  const res = (await client.get(transitionPath)) as any;
  const match = (res.transitions ?? []).find(
    (t: any) => t.to?.name && t.to.name.toLowerCase() === target.toLowerCase(),
  );
  if (!match) {
    const available = (res.transitions ?? []).map((t: any) => t.to?.name).filter(Boolean).join(", ");
    throw new Error(`no transition to '${target}' — reachable: ${available || "(none)"}`);
  }
  return String(match.id);
}

function indent(text: string, pad: string): string {
  return text.split("\n").map((l) => pad + l).join("\n");
}

export type { CompiledPush };
