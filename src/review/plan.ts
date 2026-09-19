/** Groups compiled ops into per-ticket plans for review-page rendering. */
import type { Store } from "../store.ts";
import type { CompiledOp, IntentMode } from "../types.ts";

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
