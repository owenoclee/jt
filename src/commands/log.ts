/**
 * jt log — the history of everything jt sent to Jira from this workspace.
 *
 * Read from the push journal: one entry per push, each recording how it was approved
 * (decided on the review page, or sent unreviewed under the user's auto-allow rules),
 * which proposal it came from, what changed on each ticket, and every API call made.
 * This is the audit trail — and, with --today, the answer to "what happened today?"
 * for a user whose settings let changes through without asking.
 */
import { parseArgs } from "@std/cli";
import { join } from "@std/path";
import { localContext } from "../context.ts";
import { fail } from "../errors.ts";
import { makeRefContext } from "../refs.ts";
import { dim } from "../render/colors.ts";
import { renderJournalEntry } from "../render/render.ts";
import { renderHistoryPage } from "../review/history.ts";
import type { JournalEntry } from "../types.ts";

/** Entries shown when no filter narrows the list. */
const DEFAULT_LIMIT = 10;

/**
 * "--since" accepts an age (90m, 12h, 3d, 2w) or a date / timestamp (2026-10-01,
 * 2026-10-01T09:00). A bare date means that day's local midnight.
 */
export function parseSince(text: string, now = new Date()): Date {
  const age = /^(\d+)\s*([mhdw])$/i.exec(text.trim());
  if (age) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
      age[2].toLowerCase() as "m" | "h" | "d" | "w"
    ];
    return new Date(now.getTime() - Number(age[1]) * unit);
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  const date = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    : new Date(text.trim());
  if (Number.isNaN(date.getTime())) {
    fail(`--since '${text}' is not an age (90m, 12h, 3d, 2w) or a date (2026-10-01)`);
  }
  return date;
}

/** Does this push touch `key`? Older entries have no change list — fall back to the ops. */
function touches(entry: JournalEntry, key: string): boolean {
  if (entry.changes?.some((c) => c.id === key || c.key === key)) return true;
  if (Object.values(entry.created ?? {}).includes(key)) return true;
  const inPath = new RegExp(`/${key}(/|$)`);
  return entry.ops.some((op) => inPath.test(op.path) || JSON.stringify(op.body ?? "").includes(`"${key}"`));
}

export function cmdLog(argv: string[]): void {
  const args = parseArgs(argv, { boolean: ["all", "full", "today", "web"], string: ["since"] });
  if (args.today && args.since) fail("--today and --since are mutually exclusive");
  const ctx = localContext();
  const { store } = ctx;
  const keys = (args._ as (string | number)[]).map((k) => String(k).toUpperCase());

  let since: Date | null = null;
  if (args.today) {
    const now = new Date();
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (args.since) {
    since = parseSince(args.since);
  }

  const all = store.listJournal();
  let entries = all;
  if (since) entries = entries.filter((e) => new Date(e.entry.startedAt) >= since!);
  if (keys.length) entries = entries.filter((e) => keys.some((k) => touches(e.entry, k)));

  // A time window or a ticket filter is already a deliberate selection — show all of
  // it. Only the unfiltered log is capped.
  const filtered = since !== null || keys.length > 0;
  const shown = args.all || filtered ? entries : entries.slice(0, DEFAULT_LIMIT);

  if (args.web) {
    const scope = args.today
      ? "today"
      : args.since
      ? `since ${args.since}`
      : shown.length < entries.length
      ? `latest ${shown.length} of ${entries.length} pushes`
      : "all pushes";
    const page = renderHistoryPage({
      entries: shown.map((e) => e.entry),
      target: { baseUrl: ctx.ws.config.baseUrl, project: ctx.ws.config.project },
      scope: keys.length ? `${scope} · ${keys.join(", ")}` : scope,
      refs: makeRefContext(store, ctx.ws.config),
    });
    const dir = join(store.jiraDir, "tmp");
    Deno.mkdirSync(dir, { recursive: true });
    const path = join(dir, `log-${Date.now()}.html`);
    Deno.writeTextFileSync(path, page);
    console.log(`history page: ${path}`);
    return;
  }

  if (shown.length === 0) {
    console.log(
      all.length === 0
        ? "no pushes yet"
        : `no pushes${args.today ? " today" : since ? ` since ${args.since}` : ""}${
          keys.length ? ` touching ${keys.join(", ")}` : ""
        } (${all.length} in the journal — jt log --all)`,
    );
    return;
  }
  const refs = makeRefContext(store, ctx.ws.config);
  console.log(
    shown.map((e) => renderJournalEntry(e.path, e.entry, { full: Boolean(args.full), refs })).join(
      "\n\n",
    ),
  );
  if (shown.length < entries.length) {
    console.log(dim(`\n(${entries.length - shown.length} older — jt log --all)`));
  }
}
