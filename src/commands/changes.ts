/**
 * jt changes — upstream news: what the remote did since your last acknowledgment.
 *
 * Diffs the seen layer (last-acked remote state) against base (current remote state),
 * canonical-vs-canonical. Read-only bookkeeping: seen never feeds compile or push.
 */
import { parseArgs } from "@std/cli";
import { ticketsEqual } from "../canonical.ts";
import { localContext } from "../context.ts";
import { diffTickets } from "../diff.ts";
import { makeRefContext } from "../refs.ts";
import { bold, dim, green, red } from "../render/colors.ts";
import { renderDiffEntries } from "../render/render.ts";
import type { Store } from "../store.ts";

export function cmdChanges(argv: string[]): void {
  const args = parseArgs(argv, { boolean: ["ack"] });
  const { store, ws } = localContext();
  const refs = makeRefContext(store, ws.config);
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
  const keys = [...new Set([...baseKeys, ...seenKeys])].sort().filter(wanted);
  const sections: string[] = [];
  let added = 0;
  let changed = 0;
  let gone = 0;

  for (const key of keys) {
    const base = store.readBase(key);
    const seen = store.readSeen(key);
    if (conflicts.has(key)) {
      const cf = conflicts.get(key)!;
      changed++;
      sections.push(
        `${red("conflict")}  ${bold(key)}  remote changed ${cf.fields.join(", ")} — ` +
          `held back until: jt resolve ${key}`,
      );
      continue;
    }
    if (base && !seen) {
      added++;
      const meta = `${base.ticket.type}${base.ticket.status ? ` · ${base.ticket.status}` : ""}`;
      sections.push(`${green("new     ")}  ${bold(key)}  ${base.ticket.summary}  ${dim(`(${meta})`)}`);
    } else if (!base && seen) {
      gone++;
      sections.push(
        `${red("gone    ")}  ${bold(key)}  ${seen.ticket.summary}  ${dim("(deleted or left the board)")}`,
      );
    } else if (base && seen) {
      const entries = diffTickets(seen.ticket, base.ticket);
      if (entries.length === 0) continue;
      changed++;
      sections.push(renderDiffEntries(key, base.ticket.summary, entries, refs));
    }
  }

  if (sections.length === 0) {
    console.log(
      filter.length
        ? "no upstream changes for those tickets since your last ack"
        : "no upstream changes since your last ack",
    );
  } else {
    console.log(sections.join("\n\n"));
    console.log("");
    console.log(
      dim(
        `${added} new · ${changed} changed · ${gone} gone since your last ack` +
          (args.ack ? "" : " — jt changes --ack when absorbed"),
      ),
    );
  }

  if (args.ack) {
    store.ackSeen(filter.length ? keys : undefined);
    console.log(dim(filter.length ? `acknowledged: ${keys.join(", ")}` : "acknowledged — all caught up"));
  }
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
