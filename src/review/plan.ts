/** Groups compiled ops into per-ticket plans for review-page rendering. */
import type { Store } from "../store.ts";
import type { CompiledOp } from "../types.ts";

export interface TicketPlan {
  id: string;
  kind: "create" | "update" | "delete";
  summary: string;
  ops: CompiledOp[];
}

export function buildTicketPlans(store: Store, ops: CompiledOp[]): TicketPlan[] {
  const byId = new Map<string, TicketPlan>();
  for (const op of ops) {
    let plan = byId.get(op.issue);
    if (!plan) {
      const kind = op.kind === "create" ? "create" : op.kind === "delete" ? "delete" : "update";
      byId.set(op.issue, plan = { id: op.issue, kind, summary: "", ops: [] });
    }
    if (op.kind === "create") plan.kind = "create";
    if (op.kind === "delete") plan.kind = "delete";
    plan.ops.push(op);
  }
  for (const plan of byId.values()) {
    plan.summary = summaryOf(store, plan.id);
  }
  return [...byId.values()];
}

function summaryOf(store: Store, id: string): string {
  const committed = store.readCommitted(id);
  if (committed) return committed.ticket.summary;
  const deletion = store.readDeletions().find((d) => d.key === id);
  if (deletion) return deletion.summary;
  return store.readBase(id)?.ticket.summary ?? "";
}
