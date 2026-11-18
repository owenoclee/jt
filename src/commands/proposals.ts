/**
 * jt proposals — every proposal, what state its review is in, and whose move it is.
 *
 * This is where an agent picks work back up. It submitted a proposal and stopped; the
 * human decided later, with nobody waiting. So the outcome has to be findable by an
 * agent that was not there for it — possibly a different one, in a later session: what
 * the reviewer asked for, what was pushed, what is stuck.
 */
import { localContext } from "../context.ts";
import { DEFAULT_PROPOSAL, explicitProposalFlag, leftoverAdvice } from "../proposal.ts";
import { bold, cyan, dim, green, red, yellow } from "../render/colors.ts";
import { type ProposalView, proposalView } from "../review/meta.ts";
import type { Store } from "../store.ts";
import { commentLines, linkFor } from "./review.ts";

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_MAX = 5;

/** One line on where the review stands and what, if anything, to do about it. */
function reviewLine(view: ProposalView, store: Store, flag: string): string {
  const link = linkFor(store);
  switch (view.status) {
    case "in-review":
      return green(`in review${link ? `: ${link}` : ""}`) + dim(" — the user's move; nothing to do");
    case "revising":
      return yellow(`changed since it was submitted — jt push${flag} submits it for review again`);
    case "changes-requested": {
      const n = view.meta?.review?.comments.length ?? 0;
      return yellow(
        `changes requested (${n} comment${n === 1 ? "" : "s"}) — address them, commit, then jt push${flag}`,
      );
    }
    case "blocked":
      return red(`not reviewable — fix what is below, then jt push${flag}`);
    case "pushing":
      return yellow(`approved — being sent to Jira now (jt await${flag} reports the outcome)`);
    case "interrupted":
      return red(
        `the review server stopped while sending this approved push — jt pull and jt log, then jt push${flag}`,
      );
    case "partly-pushed":
      return yellow(
        `partly pushed on ${view.leftovers!.pushedAt.slice(0, 10)} — the push stopped at a failure`,
      );
    case "legacy-review":
      return yellow(
        `a review opened by an older jt is still pending${view.legacyUrl ? `: ${view.legacyUrl}` : ""} — ` +
          `jt await${flag}`,
      );
    case "draft":
      return dim(
        view.staged.length ? `not submitted — jt push${flag} --title "..."` : "nothing committed yet",
      );
    case "empty":
      return dim("idle");
  }
}

export function cmdProposals(): void {
  const { store } = localContext();
  const lines: string[] = [];
  const open = new Set<string>();
  for (const name of store.listProposals()) {
    const s = store.scoped(name);
    s.dropIfDrained(); // finished proposals are tidied as they are noticed
    const view = proposalView(s);
    if (view.status === "empty") continue;
    open.add(name);

    const flag = explicitProposalFlag(name);
    const left = view.leftovers;
    const leftover = (id: string) => (left?.ids.includes(id) ? ` ${dim("(left over)")}` : "");
    const ids = [
      ...s.listCommittedIds().map((id) => `${id}${leftover(id)}`),
      ...s.readIntents().map((i) =>
        `${i.key} (${i.mode}${i.committed ? "" : ", uncommitted"})${leftover(i.key)}`
      ),
    ];
    const here = name === store.proposal ? cyan(" (this one)") : "";
    lines.push(`${bold(name)}${here}  ${reviewLine(view, s, flag)}`);
    if (view.meta?.title) lines.push(`  ${JSON.stringify(view.meta.title)}`);
    if (ids.length) lines.push(`  ${ids.join(", ")}`);
    if (view.status === "changes-requested") lines.push(...commentLines(view.meta!.review!.comments));
    if (view.status === "blocked") {
      lines.push(...(view.meta?.blocked?.reason ?? "").split("\n").map((l) => `  ${l}`));
    }
    if (view.status === "partly-pushed") lines.push(dim(`  ${leftoverAdvice(left!.ids, flag)}`));
  }

  // What the user approved while nobody was waiting: the last week's reviewed pushes.
  const cutoff = new Date(Date.now() - RECENT_MS).toISOString();
  const recent = store.listJournal(cutoff)
    .map((j) => j.entry)
    .filter((e) => e.review && !open.has(e.proposal ?? DEFAULT_PROPOSAL))
    .slice(0, RECENT_MAX);
  if (recent.length) {
    if (lines.length) lines.push("");
    lines.push(dim("approved and pushed in the last week (jt log has the detail):"));
    for (const e of recent) {
      const created = Object.entries(e.created ?? {}).map(([ref, key]) => `${ref} → ${key}`).join(", ");
      const result = e.result === "success" ? green("pushed") : red("stopped at a failure");
      lines.push(
        `  ${bold(e.proposal ?? DEFAULT_PROPOSAL)}  ${result} ${e.startedAt.slice(0, 16).replace("T", " ")}` +
          (e.title ? `  ${JSON.stringify(e.title)}` : "") +
          (created ? dim(`  created: ${created}`) : ""),
      );
    }
  }

  if (lines.length === 0) {
    console.log("nothing staged in any proposal — jt commit stages changes, jt push submits them for review");
    return;
  }
  console.log(lines.join("\n"));
  if (store.proposal === DEFAULT_PROPOSAL) {
    console.log(dim("\nwork on a named one with -p NAME on any command (or JT_PROPOSAL=NAME)"));
  }
}
