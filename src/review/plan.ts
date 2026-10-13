/** Groups compiled ops into per-ticket plans for review-page rendering. */
import { type AutoVerdict, NO_AUTO } from "../autoallow.ts";
import { diffTickets } from "../diff.ts";
import type { Store } from "../store.ts";
import type { CompiledOp, IntentMode, JournalChange } from "../types.ts";

export interface TicketPlan {
  id: string;
  kind: "create" | "update" | IntentMode;
  summary: string;
  ops: CompiledOp[];
}

export function buildTicketPlans(store: Store, ops: CompiledOp[]): TicketPlan[] {
  const byId = new Map<string, TicketPlan>();
  for (const op of ops) {
    let plan = byId.get(op.issue);
    if (!plan) {
      byId.set(op.issue, plan = { id: op.issue, kind: planKind(op), summary: "", ops: [] });
    }
    // A whole-issue intent (or a creation) defines the card whatever else it carries.
    if (op.kind !== "update") plan.kind = planKind(op);
    plan.ops.push(op);
  }
  for (const plan of byId.values()) {
    plan.summary = summaryOf(store, plan.id);
  }
  return [...byId.values()];
}

/**
 * The journal's per-ticket record of a changeset, taken from the layers as they stand
 * BEFORE the push settles them. `applied` starts pessimistic; executePush fills it in.
 */
export function describeChanges(
  store: Store,
  plans: TicketPlan[],
  verdict: AutoVerdict = NO_AUTO,
): JournalChange[] {
  return plans.map((p) => {
    const auto = verdict.tickets[p.id]?.auto ?? [];
    const change: JournalChange = {
      id: p.id,
      summary: p.summary,
      kind: p.kind,
      ...(auto.length ? { auto } : {}),
      applied: "none",
    };
    const committed = store.readCommitted(p.id);
    if (p.kind === "create" && committed) change.ticket = committed.ticket;
    if (p.kind === "update" && committed) {
      const base = store.readBase(p.id);
      if (base) change.entries = diffTickets(base.ticket, committed.ticket);
    }
    return change;
  });
}

function planKind(op: CompiledOp): TicketPlan["kind"] {
  switch (op.kind) {
    case "create":
    case "delete":
    case "archive":
    case "unarchive":
      return op.kind;
    default:
      return "update";
  }
}

function summaryOf(store: Store, id: string): string {
  const committed = store.readCommitted(id);
  if (committed) return committed.ticket.summary;
  const intent = store.readIntents().find((i) => i.key === id);
  if (intent) return intent.summary;
  return store.readBase(id)?.ticket.summary ?? "";
}
