/**
 * jt changes — upstream news: what the remote did since your last acknowledgment.
 *
 * Diffs the seen layer (last-acked remote state) against base (current remote state),
 * canonical-vs-canonical. Read-only bookkeeping: seen never feeds compile or push.
 * --web serves the same news as a glanceable purple "informational" page whose only
 * action is Acknowledge (equivalent to jt changes --ack).
 */
import { parseArgs } from "@std/cli";
import { ticketsEqual } from "../canonical.ts";
import { localContext } from "../context.ts";
import { type DiffEntry, diffTickets } from "../diff.ts";
import { fail } from "../errors.ts";
import { compareTicketIds } from "../keys.ts";
import { makeRefContext } from "../refs.ts";
import { bold, dim, green, red } from "../render/colors.ts";
import { renderDiffEntries } from "../render/render.ts";
import {
  escapeHtml,
  renderFieldRows,
  renderPage,
  renderTicketCard,
  renderTicketDelta,
  type ReviewPageModel,
} from "../review/html.ts";
import type { Store } from "../store.ts";
import type { Ticket } from "../types.ts";

export interface ChangesWebOptions {
  timeoutMs?: number;
  port?: number;
  /** Test hook: called with the page URL once the server is listening. */
  onServe?: (url: string) => void;
}

interface ChangeItem {
  key: string;
  kind: "new" | "changed" | "gone" | "conflict";
  summary: string;
  seen: Ticket | null;
  base: Ticket | null;
  entries: DiffEntry[];
  conflictFields: string[];
}

export function cmdChanges(argv: string[], webOpts: ChangesWebOptions = {}): void | Promise<void> {
  const args = parseArgs(argv, { boolean: ["ack", "web", "full"], string: ["timeout"] });
  if (args.ack && args.web) {
    fail("--ack and --web are mutually exclusive — the web page has an Acknowledge button");
  }
  const ctx = localContext();
  const { store } = ctx;
  const filter = (args._ as string[]).map((k) => String(k).toUpperCase());
  const wanted = (k: string) => filter.length === 0 || filter.includes(k);

  const baseKeys = store.listBaseKeys();
  const seenKeys = store.listSeenKeys();
  if (baseKeys.length === 0 && seenKeys.length === 0) {
    console.log("nothing tracked — run: jt pull (or jt fetch <KEY...>)");
    return;
  }
  if (seenKeys.length === 0 && !args.ack) {
    console.log("no baseline yet — run: jt changes --ack to record current remote state as seen");
    return;
  }

  const conflicts = new Map(store.readConflicts().map((c) => [c.key, c]));
  const keys = [...new Set([...baseKeys, ...seenKeys])].sort(compareTicketIds).filter(wanted);
  const items: ChangeItem[] = [];

  for (const key of keys) {
    const base = store.readBase(key)?.ticket ?? null;
    const seen = store.readSeen(key)?.ticket ?? null;
    const item = (kind: ChangeItem["kind"], summary: string, entries: DiffEntry[] = []) =>
      items.push({
        key,
        kind,
        summary,
        seen,
        base,
        entries,
        conflictFields: conflicts.get(key)?.fields ?? [],
      });
    if (conflicts.has(key)) {
      item("conflict", (base ?? seen)?.summary ?? "");
    } else if (base && !seen) {
      item("new", base.summary);
    } else if (!base && seen) {
      item("gone", seen.summary);
    } else if (base && seen) {
      const entries = diffTickets(seen, base);
      if (entries.length > 0) item("changed", base.summary, entries);
    }
  }

  const ackKeys = filter.length ? keys : undefined;
  if (args.web) return changesWeb(ctx, items, ackKeys, webOpts, args.timeout);

  const added = items.filter((i) => i.kind === "new").length;
  const gone = items.filter((i) => i.kind === "gone").length;
  const changed = items.length - added - gone;
  const countLine = `${added} new · ${changed} changed · ${gone} gone`;

  // --ack absorbs without reprinting: the news was already surfaced by a plain
  // jt changes (or the --web page), so a second copy is pure noise.
  if (args.ack) {
    if (items.length > 0) console.log(dim(`absorbed: ${countLine}`));
    store.ackSeen(ackKeys);
    console.log(dim(filter.length ? `acknowledged: ${keys.join(", ")}` : "acknowledged — all caught up"));
    return;
  }

  const refs = makeRefContext(store, ctx.ws.config);
  const sections = items.map((it) => {
    switch (it.kind) {
      case "conflict":
        return `${red("conflict")}  ${bold(it.key)}  remote changed ${it.conflictFields.join(", ")} — ` +
          `held back until: jt resolve ${it.key}`;
      case "new": {
        const meta = `${it.base!.type}${it.base!.status ? ` · ${it.base!.status}` : ""}`;
        return `${green("new     ")}  ${bold(it.key)}  ${it.base!.summary}  ${dim(`(${meta})`)}`;
      }
      case "gone":
        return `${red("gone    ")}  ${bold(it.key)}  ${it.seen!.summary}  ${dim("(deleted or left the board)")}`;
      case "changed":
        return renderDiffEntries(it.key, it.base!.summary, it.entries, refs, {
          compactText: !args.full,
        });
    }
  });

  if (sections.length === 0) {
    console.log(
      filter.length
        ? "no upstream changes for those tickets since your last ack"
        : "no upstream changes since your last ack",
    );
  } else {
    const elided = !args.full && items.some((i) => i.entries.some((e) => e.kind === "text"));
    console.log(sections.join("\n\n"));
    console.log("");
    console.log(
      dim(
        `${countLine} since your last ack — ` +
          (elided ? "jt changes --full for description diffs · " : "") +
          "--web to show the user · --ack when absorbed",
      ),
    );
  }
}

/** jt changes --web: the upstream news as a page; the Acknowledge button acks and exits. */
function changesWeb(
  ctx: ReturnType<typeof localContext>,
  items: ChangeItem[],
  ackKeys: string[] | undefined,
  opts: ChangesWebOptions,
  timeoutArg: string | undefined,
): void | Promise<void> {
  if (items.length === 0) {
    console.log(
      ackKeys
        ? "no upstream changes for those tickets since your last ack"
        : "no upstream changes since your last ack",
    );
    return;
  }
  const { store } = ctx;
  const refs = makeRefContext(store, ctx.ws.config);
  const tickets: ReviewPageModel["tickets"] = items.map((it) => {
    let diffHtml: string;
    switch (it.kind) {
      case "new":
        diffHtml = renderTicketCard(it.base!, "new", refs);
        break;
      case "gone":
        diffHtml = `<div class="delete-card">deleted or left the board since your last ack</div>` +
          renderFieldRows(it.seen!, [], refs);
        break;
      case "conflict":
        diffHtml = `<div class="conflict-card">remote changed <b>${
          escapeHtml(it.conflictFields.join(", "))
        }</b> — held back until: <code>jt resolve ${escapeHtml(it.key)}</code></div>`;
        break;
      case "changed":
        diffHtml = renderTicketDelta(it.seen, it.base, refs);
        break;
    }
    return { id: it.key, summary: it.summary, kind: it.kind, unchangedSinceReview: false, diffHtml, opsJson: "" };
  });

  const timeoutMs = opts.timeoutMs ?? (timeoutArg ? Number(timeoutArg) * 1000 : 600_000);
  const model: ReviewPageModel = {
    mode: "info",
    title: `jt changes — ${items.length} upstream change${items.length === 1 ? "" : "s"} since your last ack`,
    target: { baseUrl: ctx.ws.config.baseUrl, project: ctx.ws.config.project },
    tickets,
    commits: [],
    sinceReview: null,
    nonce: crypto.randomUUID(),
    timeoutMs,
  };
  return serveChangesPage(model, opts, timeoutMs, () => {
    store.ackSeen(ackKeys);
    console.log(dim(ackKeys ? `acknowledged: ${ackKeys.join(", ")}` : "acknowledged — all caught up"));
  });
}

/** Serve the page on loopback and wait for one Acknowledge POST (or timeout = no ack). */
async function serveChangesPage(
  model: ReviewPageModel,
  opts: ChangesWebOptions,
  timeoutMs: number,
  onAck: () => void,
): Promise<void> {
  const html = renderPage(model);
  let resolveAck!: (acked: boolean) => void;
  const acked = new Promise<boolean>((r) => (resolveAck = r));
  let done = false;

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: opts.port ?? 0, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === `/changes/${model.nonce}`) {
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (req.method === "POST" && url.pathname === `/ack/${model.nonce}` && !done) {
        done = true;
        resolveAck(true);
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  );

  const addr = server.addr as Deno.NetAddr;
  const url = `http://127.0.0.1:${addr.port}/changes/${model.nonce}`;
  console.log(`${bold("changes page:")} ${url}`);
  console.log(dim("glance it over — Acknowledge there records it as seen; waiting..."));
  opts.onServe?.(url);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), timeoutMs);
  });
  const wasAcked = await Promise.race([acked, timeout]);
  clearTimeout(timer);
  await server.shutdown();
  if (wasAcked) onAck();
  else console.log(dim("page expired without an ack — nothing recorded (jt changes --ack also works)"));
}

/** New + changed + gone count for the status footer. Conflicted tickets are already badged there. */
export function upstreamChangeCount(store: Store): number {
  const seenKeys = store.listSeenKeys();
  if (seenKeys.length === 0) return 0;
  const conflicted = new Set(store.readConflicts().map((c) => c.key));
  const baseKeys = store.listBaseKeys();
  let count = 0;
  for (const key of new Set([...baseKeys, ...seenKeys])) {
    if (conflicted.has(key)) continue;
    const base = store.readBase(key);
    const seen = store.readSeen(key);
    if (!base || !seen) {
      count++;
      continue;
    }
    if (!ticketsEqual(base.ticket, seen.ticket)) count++;
  }
  return count;
}
