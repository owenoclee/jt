/**
 * Groups compiled ops into per-ticket plans for the review page, and computes the
 * dependency closure that partial (per-ticket) approval must respect: a pending
 * creation can only ship if every pending ticket it references (parent @ref, link
 * endpoint) ships in the same push.
 */
import type { Store } from "../store.ts";
import type { CompiledOp } from "../types.ts";

export interface TicketPlan {
  id: string;
  kind: "create" | "update" | "delete";
  summary: string;
  ops: CompiledOp[];
  /** Other pending ids that must be approved together with this one. */
  dependsOn: string[];
}

export function buildTicketPlans(store: Store, ops: CompiledOp[]): TicketPlan[] {
  const byId = new Map<string, TicketPlan>();
  for (const op of ops) {
    let plan = byId.get(op.issue);
    if (!plan) {
      const kind = op.kind === "create" ? "create" : op.kind === "delete" ? "delete" : "update";
      byId.set(op.issue, plan = { id: op.issue, kind, summary: "", ops: [], dependsOn: [] });
    }
    if (op.kind === "create") plan.kind = "create";
    if (op.kind === "delete") plan.kind = "delete";
    plan.ops.push(op);
    for (const dep of refsIn(op)) {
      if (dep !== op.issue && !plan.dependsOn.includes(dep)) plan.dependsOn.push(dep);
    }
  }
  for (const plan of byId.values()) {
    plan.summary = summaryOf(store, plan.id);
  }
  return [...byId.values()];
}

function refsIn(op: CompiledOp): string[] {
  const refs: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "key" && typeof v === "string" && v.startsWith("@")) refs.push(v);
        else walk(v);
      }
    }
  };
  walk(op.body);
  return refs;
}

function summaryOf(store: Store, id: string): string {
  const committed = store.readCommitted(id);
  if (committed) return committed.ticket.summary;
  const deletion = store.readDeletions().find((d) => d.key === id);
  if (deletion) return deletion.summary;
  return store.readBase(id)?.ticket.summary ?? "";
}

export interface FilterResult {
  ops: CompiledOp[];
  approved: string[];
  /** Approved tickets dropped because a dependency was not approved. */
  dropped: { id: string; reason: string }[];
}

/** Keep only ops of approved tickets whose dependency closure is fully approved. */
export function filterOpsForApproved(
  plans: TicketPlan[],
  allOps: CompiledOp[],
  approvedIds: string[],
): FilterResult {
  const approved = new Set(approvedIds);
  const dropped: { id: string; reason: string }[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const plan of plans) {
      if (!approved.has(plan.id)) continue;
      const missing = plan.dependsOn.filter((d) => !approved.has(d));
      if (missing.length) {
        approved.delete(plan.id);
        dropped.push({ id: plan.id, reason: `requires ${missing.join(", ")}` });
        changed = true;
      }
    }
  }
  // Preserve global op order (creates before links etc.) by filtering the full list.
  const ops = allOps.filter((op) => approved.has(op.issue));
  return { ops, approved: [...approved], dropped };
}
