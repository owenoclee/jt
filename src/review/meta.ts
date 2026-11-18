/**
 * What state a proposal is in — one answer for the CLI, the inbox and the page.
 *
 * A proposal is reviewed like a pull request: its author submits it and moves on, and
 * the human decides whenever they get to it. So its state has to live on disk, not in
 * a waiting process: proposal.json (see ProposalMeta) beside the staged work, and this
 * module reading the two together.
 */
import { pidAlive } from "../process.ts";
import { legacyReview } from "./legacy.ts";
import type { Store } from "../store.ts";
import type { ProposalMeta } from "../types.ts";

export type ProposalStatus =
  /** Nothing staged and nothing outstanding. */
  | "empty"
  /** Staged, but not submitted for review (never, or withdrawn with jt cancel). */
  | "draft"
  /** Submitted and waiting for the human. */
  | "in-review"
  /** Submitted, then changed: not reviewable again until jt push resubmits it. */
  | "revising"
  /** The human asked for changes; their notes wait for an agent. */
  | "changes-requested"
  /** Submitted, but checking it against Jira found something an agent must fix. */
  | "blocked"
  /** Approved; the review server is sending it now. */
  | "pushing"
  /** Approved, but the review server died while sending. */
  | "interrupted"
  /** Approved and sent, but the push stopped at a failure and left changes staged. */
  | "partly-pushed"
  /** A review page from an older jt is still open for it. */
  | "legacy-review";

export interface ProposalView {
  name: string;
  status: ProposalStatus;
  meta: ProposalMeta | null;
  /** Everything staged for push: committed tickets and committed intents. */
  staged: string[];
  /** Set for partly-pushed: what the last push left behind. */
  leftovers: { pushedAt: string; ids: string[] } | null;
  /** Set for legacy-review: the old page's URL, when it is still being served. */
  legacyUrl?: string;
}

export function proposalView(store: Store): ProposalView {
  const meta = store.readMeta();
  const staged = [
    ...store.listCommittedIds(),
    ...store.readIntents().filter((i) => i.committed).map((i) => i.key),
  ];
  const leftovers = store.leftovers();
  const view = (status: ProposalStatus, extra: Partial<ProposalView> = {}): ProposalView => ({
    name: store.proposal,
    status,
    meta,
    staged,
    leftovers,
    ...extra,
  });

  const legacy = legacyReview(store.proposalDir);
  if (legacy) return view("legacy-review", legacy.url ? { legacyUrl: legacy.url } : {});

  if (meta?.pushing) return view(pidAlive(meta.pushing.pid) ? "pushing" : "interrupted");
  // With nothing staged there is nothing to review, whatever the review state says:
  // the proposal was emptied (by its agent, or by Jira catching up with it).
  if (staged.length === 0) return view(store.readIntents().length > 0 ? "draft" : "empty");
  if (meta?.review) return view("changes-requested");
  if (meta?.submittedAt) {
    if (meta.blocked) return view("blocked");
    return view(meta.revised ? "revising" : "in-review");
  }
  return view(leftovers ? "partly-pushed" : "draft");
}

/** True while a decision could still land: jt await keeps waiting through these. */
export function awaitingDecision(status: ProposalStatus): boolean {
  return status === "in-review" || status === "pushing";
}

/**
 * Record that a submitted proposal's staged work has changed. Called by every command
 * that changes what a proposal would send — the reviewer must not be able to approve
 * work its author is still in the middle of. `jt push` clears it by resubmitting.
 *
 * Returns whether the proposal was in review, so the command can say so.
 */
export function markRevised(store: Store): boolean {
  const meta = store.readMeta();
  if (!meta?.submittedAt) return false;
  if (!meta.revised) store.writeMeta({ ...meta, revised: true });
  return true;
}

/** One line telling an agent its change is not under review yet. */
export function revisedNotice(name: string, flag: string): string {
  return `proposal '${name}' was submitted for review — this change is not part of that ` +
    `review until you run jt push${flag} again (its page shows "being revised" meanwhile)`;
}

/** How a state is named to a human, and how loudly: one vocabulary for page and inbox. */
export interface StatusPresentation {
  label: string;
  tone: "wait" | "ok" | "warn" | "error" | "muted";
  /** Whose move it is: the reviewer's, or an agent's. */
  waitingOn: "you" | "agent";
}

export function presentStatus(status: ProposalStatus): StatusPresentation {
  switch (status) {
    case "in-review":
      return { label: "awaiting your review", tone: "wait", waitingOn: "you" };
    case "pushing":
      return { label: "pushing", tone: "ok", waitingOn: "you" };
    case "revising":
      return { label: "being revised", tone: "muted", waitingOn: "agent" };
    case "changes-requested":
      return { label: "changes requested", tone: "warn", waitingOn: "agent" };
    case "blocked":
      return { label: "needs its agent", tone: "error", waitingOn: "agent" };
    case "interrupted":
      return { label: "push interrupted", tone: "error", waitingOn: "agent" };
    case "partly-pushed":
      return { label: "partly pushed", tone: "error", waitingOn: "agent" };
    case "legacy-review":
      return { label: "open in an older jt", tone: "warn", waitingOn: "agent" };
    case "draft":
      return { label: "draft", tone: "muted", waitingOn: "agent" };
    case "empty":
      return { label: "empty", tone: "muted", waitingOn: "agent" };
  }
}
