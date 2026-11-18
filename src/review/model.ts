/** Builds the review-page model from the tool-owned layers (no network). */
import { type AutoVerdict, NO_AUTO } from "../autoallow.ts";
import {
  type Chain,
  type ChainSnapshot,
  readChain,
  readReviewMarker,
  snapshotEqual,
  stateAtSeq,
} from "../chain.ts";
import { intentNoun } from "../intents.ts";
import { compareTicketIds } from "../keys.ts";
import { DEFAULT_PROPOSAL } from "../proposal.ts";
import { NO_REFS, type RefContext } from "../refs.ts";
import type { Store } from "../store.ts";
import type { Config, IntentMode, Ticket } from "../types.ts";
import {
  renderTicketDelta,
  renderWithdrawnCard,
  type ReviewPageModel,
  type TicketSection,
} from "./html.ts";
import type { TicketPlan } from "./plan.ts";

export function buildPageModel(
  store: Store,
  config: Config,
  plans: TicketPlan[],
  refs: RefContext = NO_REFS,
  verdict: AutoVerdict = NO_AUTO,
): ReviewPageModel {
  const chain = readChain(store);
  const marker = readReviewMarker(store);
  const cards = plans.map((p) => {
    const auto = verdict.tickets[p.id];
    const base = p.id.startsWith("@") ? null : store.readBase(p.id);
    const committed = store.readCommitted(p.id);
    const from = base?.ticket ?? null;
    const intentMode = p.kind === "create" || p.kind === "update" ? null : p.kind;
    const to = intentMode ? null : committed?.ticket ?? null;
    // Collapse only on proof that the author left it alone: the snapshot the user
    // last reviewed is byte-identical to the tip — or differs only by rebases onto
    // edits made in Jira, which change what the proposal sits on, not what it asks for.
    const unchangedSinceReview = marker !== null &&
      stateAtSeq(chain, p.id, marker.lastReviewedSeq) !== null &&
      (snapshotEqual(
        stateAtSeq(chain, p.id, marker.lastReviewedSeq),
        stateAtSeq(chain, p.id, chain.entries.at(-1)?.seq ?? 0),
      ) || !changedByAuthorSince(chain, p.id, marker.lastReviewedSeq));
    return {
      id: p.id,
      summary: p.summary,
      kind: p.kind,
      unchangedSinceReview,
      // A wholly auto-allowed ticket is greyed out as a card; within a mixed one only
      // the auto-allowed rows are.
      autoAllowed: Boolean(auto?.all),
      diffHtml: renderTicketDelta(
        from,
        to,
        refs,
        intentMode ? { mode: intentMode, summary: p.summary } : undefined,
        auto && !auto.all ? new Set(auto.auto) : undefined,
      ),
      opsJson: JSON.stringify(
        p.ops.map((o) => ({ method: o.method, path: o.path, body: o.body })),
        null,
        2,
      ),
    };
  });

  // What needs the reviewer's eyes first; what their own settings already allow, last.
  const tickets = [...cards.filter((t) => !t.autoAllowed), ...cards.filter((t) => t.autoAllowed)];
  const named = store.proposal === DEFAULT_PROPOSAL ? "" : `proposal ${store.proposal} — `;

  return {
    mode: "review",
    title: `jt push review — ${named}${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`,
    target: { baseUrl: config.baseUrl, project: config.project },
    tickets,
    commits: buildCommitViews(store, refs),
    sinceReview: buildSinceReview(store, plans.map((p) => p.id), refs),
    nonce: crypto.randomUUID(),
  };
}

/**
 * The staged changeset as cards, from the committed and base layers alone — no
 * compiled operations, so no network. `jt diff --committed --web` shows this, and so
 * does a proposal's page before it has been checked against Jira.
 */
export function buildCommittedTickets(
  store: Store,
  refs: RefContext = NO_REFS,
  wanted: (id: string) => boolean = () => true,
): ReviewPageModel["tickets"] {
  const tickets: ReviewPageModel["tickets"] = [];
  const push = (
    id: string,
    summary: string,
    kind: "create" | "update" | IntentMode,
    from: Ticket | null,
    to: Ticket | null,
  ) => {
    const intent = kind === "create" || kind === "update" ? undefined : { mode: kind, summary };
    const diffHtml = renderTicketDelta(from, to, refs, intent);
    if (diffHtml) {
      tickets.push({ id, summary, kind, unchangedSinceReview: false, diffHtml, opsJson: "" });
    }
  };
  for (const id of store.listCommittedIds()) {
    if (!wanted(id)) continue;
    const committed = store.readCommitted(id)!;
    const base = id.startsWith("@") ? null : store.readBase(id);
    push(id, committed.ticket.summary, base ? "update" : "create", base?.ticket ?? null, committed.ticket);
  }
  for (const i of store.readIntents().filter((i) => i.committed)) {
    if (!wanted(i.key)) continue;
    push(i.key, i.summary, i.mode, store.readBase(i.key)?.ticket ?? null, null);
  }
  return tickets;
}

/**
 * Has the proposal's own content for this ticket changed since `seq`? A "remote" chain
 * entry is a rebase: Jira moved, and the staged copy was carried onto the new state
 * with the proposal's edits intact. That is news about Jira, reported as such on the
 * page; it is not a change to review again — unless the rebase took the ticket out of
 * the proposal altogether, which the reviewer must be told.
 */
function changedByAuthorSince(chain: Chain, id: string, seq: number): boolean {
  return chain.entries.some((e) => {
    const snap = e.seq > seq ? e.tickets[id] : undefined;
    return snap !== undefined && (e.author !== "remote" || snap.kind === "withdrawn");
  });
}

function snapshotTicket(s: ChainSnapshot | null): Ticket | null {
  return s && s.kind === "ticket" ? s.ticket : null;
}

export function buildCommitViews(
  store: Store,
  refs: RefContext = NO_REFS,
): ReviewPageModel["commits"] {
  const chain = readChain(store);
  return chain.entries.map((entry) => {
    const sections: TicketSection[] = Object.entries(entry.tickets).map(([id, snap]) => {
      if (snap.kind === "withdrawn") {
        return {
          id,
          summary: `(withdrawn) ${snap.summary}`,
          html: renderWithdrawnCard("commit"),
        };
      }
      const prior = stateAtSeq(chain, id, entry.seq - 1);
      const base = id.startsWith("@") ? null : store.readBase(id);
      const from = snapshotTicket(prior) ?? base?.ticket ?? null;
      if (snap.kind === "deletion") {
        const mode = snap.mode ?? "delete";
        return {
          id,
          summary: `(${intentNoun(mode)}) ${snap.summary}`,
          html: renderTicketDelta(from, null, refs, { mode, summary: snap.summary }),
        };
      }
      return {
        id,
        summary: snap.ticket.summary,
        html: renderTicketDelta(from, snap.ticket, refs),
      };
    });
    return {
      seq: entry.seq,
      author: entry.author,
      note: entry.note,
      createdAt: entry.createdAt,
      sections,
    };
  });
}

export function buildSinceReview(
  store: Store,
  ids: string[],
  refs: RefContext = NO_REFS,
): ReviewPageModel["sinceReview"] {
  const chain = readChain(store);
  const marker = readReviewMarker(store);
  const tipSeq = chain.entries.at(-1)?.seq ?? 0;
  if (!marker || marker.lastReviewedSeq >= tipSeq) return null;

  const sections: TicketSection[] = [];
  for (const id of ids) {
    const priorSnap = stateAtSeq(chain, id, marker.lastReviewedSeq);
    const currentSnap = stateAtSeq(chain, id, tipSeq);
    if (snapshotEqual(priorSnap, currentSnap)) continue;
    // Moved only by a rebase: a colleague's edit in Jira, not something this proposal
    // changed since the review.
    if (priorSnap !== null && !changedByAuthorSince(chain, id, marker.lastReviewedSeq)) continue;
    const base = id.startsWith("@") ? null : store.readBase(id);
    // A withdrawn prior means the reviewer last saw this ticket OUT of the changeset —
    // its re-entry diffs against base, like a ticket entering for the first time.
    const from = snapshotTicket(priorSnap) ??
      (priorSnap === null || priorSnap.kind === "withdrawn" ? base?.ticket ?? null : null);
    const to = currentSnap === null || currentSnap.kind !== "ticket" ? null : currentSnap.ticket;
    const summary = to?.summary ?? from?.summary ?? "";
    sections.push({ id, summary, html: renderTicketDelta(from, to, refs) });
  }

  // Tickets that LEFT the changeset since the review: chain history, no current plan,
  // and a withdrawal tombstone at the tip. Shown exactly once — after the next review
  // the marker moves past the tombstone.
  const planIds = new Set(ids);
  const chainIds = [...new Set(chain.entries.flatMap((e) => Object.keys(e.tickets)))]
    .filter((id) => !planIds.has(id))
    .sort(compareTicketIds);
  for (const id of chainIds) {
    const priorSnap = stateAtSeq(chain, id, marker.lastReviewedSeq);
    const currentSnap = stateAtSeq(chain, id, tipSeq);
    if (currentSnap?.kind !== "withdrawn") continue;
    if (priorSnap === null || priorSnap.kind === "withdrawn") continue; // reviewer never saw it staged
    sections.push({ id, summary: currentSnap.summary, html: renderWithdrawnCard("since") });
  }
  return sections.length > 0 ? { fromSeq: marker.lastReviewedSeq, sections } : null;
}
