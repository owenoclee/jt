/**
 * jt proposals — every proposal, what state its review is in, and whose move it is.
 *
 * This is where an agent picks work back up. It submitted a proposal and stopped; the
 * human decided later, with nobody waiting. So the outcome has to be findable by an
 * agent that was not there for it — possibly a different one, in a later session: what
 * the reviewer asked for, what was pushed, what is stuck.
 *
 * The text form is written for that agent: each state comes with what to do about it.
 * `--json` is the same facts as one document, for a script (a status line, a dashboard,
 * an orchestrator polling its workers' proposals) — no advice, and a shape that holds
 * still: every key is always present, null when it does not apply.
 */
import { parseArgs } from "@std/cli";
import { localContext } from "../context.ts";
import { DEFAULT_PROPOSAL, explicitProposalFlag, leftoverAdvice } from "../proposal.ts";
import { bold, cyan, dim, green, red, yellow } from "../render/colors.ts";
import {
  presentStatus,
  type ProposalStatus,
  type ProposalView,
  proposalView,
} from "../review/meta.ts";
import type { Store } from "../store.ts";
import type { IntentMode, JournalEntry } from "../types.ts";
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

/** One staged change, as `jt proposals --json` reports it. */
export interface ProposalTicketJson {
  /** The issue key, or "@name" for a ticket that does not exist in Jira yet. */
  id: string;
  change: "create" | "update" | IntentMode;
  /** False for an archive, un-archive or deletion that is staged but not committed. */
  committed: boolean;
  /** Approved once already: a push that stopped at a failure left it behind. */
  leftover: boolean;
}

/** One open proposal, as `jt proposals --json` reports it. */
export interface ProposalJson {
  name: string;
  /** The proposal this command was run for (-p NAME, JT_PROPOSAL, or the default). */
  current: boolean;
  status: Exclude<ProposalStatus, "empty">;
  /** Whose move it is; null while an approved push is being sent. */
  waitingOn: "user" | "agent" | null;
  title: string | null;
  /** Markdown. */
  description: string | null;
  /** The review page; null until the workspace has submitted its first proposal. */
  url: string | null;
  /** Set while it is submitted for review. */
  submittedAt: string | null;
  tickets: ProposalTicketJson[];
  /** Set when the user asked for changes and nothing has been resubmitted since. */
  changesRequestedAt: string | null;
  /** The comments of that review; `on` is null for one on the proposal as a whole. */
  comments: { on: string | null; body: string }[];
  /** Why it cannot be reviewed as it stands; set for status "blocked". */
  blocked: { reason: string; at: string } | null;
  /** When the push that left the leftover tickets behind was sent. */
  partlyPushedAt: string | null;
}

/** A reviewed push of a proposal that is no longer open. */
export interface RecentPushJson {
  proposal: string;
  title: string | null;
  /** "partial": the push stopped at a failure. */
  result: "success" | "partial";
  pushedAt: string;
  /** The keys Jira gave the tickets it created: "@name" → key. */
  created: Record<string, string>;
}

export interface ProposalsJson {
  proposals: ProposalJson[];
  /** Approved and pushed in the last seven days, newest first. */
  recentPushes: RecentPushJson[];
}

function waitingOn(status: ProposalStatus): ProposalJson["waitingOn"] {
  if (status === "pushing") return null; // approved and on its way: nobody's move
  return presentStatus(status).waitingOn === "you" ? "user" : "agent";
}

function proposalJson(s: Store, view: ProposalView, current: string): ProposalJson {
  const left = new Set(view.leftovers?.ids ?? []);
  const review = view.status === "changes-requested" ? view.meta!.review! : null;
  return {
    name: view.name,
    current: view.name === current,
    status: view.status as ProposalJson["status"],
    waitingOn: waitingOn(view.status),
    title: view.meta?.title || null,
    description: view.meta?.description || null,
    url: view.status === "legacy-review" ? view.legacyUrl ?? null : linkFor(s),
    submittedAt: view.meta?.submittedAt ?? null,
    tickets: [
      ...s.listCommittedIds().map((id): ProposalTicketJson => ({
        id,
        change: id.startsWith("@") ? "create" : "update",
        committed: true,
        leftover: left.has(id),
      })),
      ...s.readIntents().map((i): ProposalTicketJson => ({
        id: i.key,
        change: i.mode,
        committed: i.committed,
        leftover: left.has(i.key),
      })),
    ],
    changesRequestedAt: review?.decidedAt ?? null,
    comments: (review?.comments ?? []).map((c) => ({ on: c.on ?? null, body: c.body })),
    blocked: view.status === "blocked" ? view.meta?.blocked ?? null : null,
    partlyPushedAt: view.leftovers?.pushedAt ?? null,
  };
}

function recentPushJson(e: JournalEntry): RecentPushJson {
  return {
    proposal: e.proposal ?? DEFAULT_PROPOSAL,
    title: e.title ?? null,
    result: e.result === "success" ? "success" : "partial",
    pushedAt: e.startedAt,
    created: e.created ?? {},
  };
}

export function cmdProposals(argv: string[] = []): void {
  const args = parseArgs(argv, { boolean: ["json"] });
  const { store } = localContext();
  const open: { s: Store; view: ProposalView }[] = [];
  for (const name of store.listProposals()) {
    const s = store.scoped(name);
    s.dropIfDrained(); // finished proposals are tidied as they are noticed
    const view = proposalView(s);
    if (view.status !== "empty") open.push({ s, view });
  }

  // What the user approved while nobody was waiting: the last week's reviewed pushes.
  const names = new Set(open.map((o) => o.view.name));
  const cutoff = new Date(Date.now() - RECENT_MS).toISOString();
  const pushed = store.listJournal(cutoff)
    .map((j) => j.entry)
    .filter((e) => e.review && !names.has(e.proposal ?? DEFAULT_PROPOSAL));

  if (args.json) {
    const doc: ProposalsJson = {
      proposals: open.map(({ s, view }) => proposalJson(s, view, store.proposal)),
      recentPushes: pushed.map(recentPushJson),
    };
    console.log(JSON.stringify(doc, null, 2));
    return;
  }

  const lines: string[] = [];
  for (const { s, view } of open) {
    const name = view.name;
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

  const recent = pushed.slice(0, RECENT_MAX);
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
