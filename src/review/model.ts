/** Builds the review-page model from the tool-owned layers (no network). */
import {
  type ChainSnapshot,
  readChain,
  readReviewMarker,
  snapshotEqual,
  stateAtSeq,
} from "../chain.ts";
import { compareTicketIds } from "../keys.ts";
import { NO_REFS, type RefContext } from "../refs.ts";
import type { Store } from "../store.ts";
import type { Config, Ticket } from "../types.ts";
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
  timeoutMs: number,
  refs: RefContext = NO_REFS,
): ReviewPageModel {
  const chain = readChain(store);
  const marker = readReviewMarker(store);
  const tickets = plans.map((p) => {
    const base = p.id.startsWith("@") ? null : store.readBase(p.id);
    const committed = store.readCommitted(p.id);
    const from = base?.ticket ?? null;
    const to = p.kind === "delete" ? null : committed?.ticket ?? null;
    // Collapse only on byte-identical proof: the snapshot the user last reviewed
    // equals the current tip snapshot for this ticket.
    const unchangedSinceReview = marker !== null &&
      stateAtSeq(chain, p.id, marker.lastReviewedSeq) !== null &&
      snapshotEqual(
        stateAtSeq(chain, p.id, marker.lastReviewedSeq),
        stateAtSeq(chain, p.id, chain.entries.at(-1)?.seq ?? 0),
      );
    return {
      id: p.id,
      summary: p.summary,
      kind: p.kind,
      unchangedSinceReview,
      diffHtml: renderTicketDelta(from, to, refs),
      opsJson: JSON.stringify(
        p.ops.map((o) => ({ method: o.method, path: o.path, body: o.body })),
        null,
        2,
      ),
    };
  });

  return {
    mode: "review",
    title: `jt push review — ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`,
    target: { baseUrl: config.baseUrl, project: config.project },
    tickets,
    commits: buildCommitViews(store, refs),
    sinceReview: buildSinceReview(store, plans.map((p) => p.id), refs),
    nonce: crypto.randomUUID(),
    timeoutMs,
  };
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
      const to = snap.kind === "deletion" ? null : snap.ticket;
      const fromForDelete = from ??
        (snap.kind === "deletion" ? ({ summary: snap.summary } as unknown as Ticket) : null);
      return {
        id,
        summary: snap.kind === "deletion" ? `(deletion) ${snap.summary}` : snap.ticket.summary,
        html: renderTicketDelta(snap.kind === "deletion" ? fromForDelete : from, to, refs),
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
