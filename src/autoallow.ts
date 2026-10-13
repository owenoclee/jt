/**
 * Auto-allow: which parts of a changeset the user's settings let through unreviewed.
 *
 * Classification is per ticket, per change — the vocabulary is the diff's own field
 * names, so what is greyed out on the review page is exactly what a rule matched.
 * The changeset still travels as a unit: when every change in it is auto-allowed,
 * push sends it with no review page; otherwise the whole of it waits for the human,
 * with the auto-allowed part shown but de-emphasised. Nothing is ever split and sent
 * ahead of the rest.
 */
import { diffTickets } from "./diff.ts";
import type { TicketPlan } from "./review/plan.ts";
import { type AutoAllowRule, describeRule } from "./settings.ts";
import type { Store } from "./store.ts";

/** Marks a ticket whose whole plan one rule covers (create / archive / unarchive). */
export const WHOLE_TICKET = "*";

export interface TicketVerdict {
  /** Diff field names covered by a rule — or [WHOLE_TICKET]. */
  auto: string[];
  /** Every change on this ticket is covered. */
  all: boolean;
}

export interface AutoVerdict {
  tickets: Record<string, TicketVerdict>;
  /** The whole changeset is covered: push may send it without a review. */
  allAuto: boolean;
  /** The rules that matched something, as shown to the user and journaled. */
  rules: string[];
}

export const NO_AUTO: AutoVerdict = { tickets: {}, allAuto: false, rules: [] };

/** A diff field name -> the action name rules use for it. */
function actionOf(field: string): string {
  return field === "comments" ? "comment" : field;
}

export function classifyChangeset(
  store: Store,
  plans: TicketPlan[],
  rules: AutoAllowRule[],
): AutoVerdict {
  const tickets: Record<string, TicketVerdict> = {};
  const matched = new Set<AutoAllowRule>();
  if (rules.length === 0 || plans.length === 0) return { tickets, allAuto: false, rules: [] };

  const find = (action: string, project: string, status?: string): AutoAllowRule | undefined =>
    rules.find((r) => {
      const ruleAction = r.action === "fields.*" && action.startsWith("fields.") ? action : r.action;
      if (ruleAction !== action) return false;
      if (r.project && r.project !== project.toUpperCase()) return false;
      if (r.to) {
        const target = status?.toLowerCase();
        return target !== undefined && r.to.some((t) => t.toLowerCase() === target);
      }
      return true;
    });

  for (const plan of plans) {
    const base = plan.id.startsWith("@") ? null : store.readBase(plan.id);
    const committed = store.readCommitted(plan.id);

    if (plan.kind !== "update") {
      // A deletion is permanent: no rule can name it (settings.ts rejects one that tries).
      const project = committed?.ticket.project ?? base?.ticket.project ?? plan.id.split("-")[0];
      const rule = plan.kind === "delete" ? undefined : find(plan.kind, project);
      if (rule) matched.add(rule);
      tickets[plan.id] = { auto: rule ? [WHOLE_TICKET] : [], all: Boolean(rule) };
      continue;
    }

    if (!base || !committed) {
      tickets[plan.id] = { auto: [], all: false };
      continue;
    }
    const entries = diffTickets(base.ticket, committed.ticket);
    const auto: string[] = [];
    for (const e of entries) {
      // Replacing a description jt could only partly read destroys remote content;
      // that always gets a human look, whatever the rules say.
      if (e.field === "description" && base.ticket.descriptionLossy) continue;
      const rule = find(actionOf(e.field), committed.ticket.project, committed.ticket.status);
      if (!rule) continue;
      matched.add(rule);
      auto.push(e.field);
    }
    tickets[plan.id] = { auto, all: entries.length > 0 && auto.length === entries.length };
  }

  return {
    tickets,
    allAuto: plans.every((p) => tickets[p.id]?.all),
    rules: rules.filter((r) => matched.has(r)).map(describeRule),
  };
}

/** "TST-1 (status, assignee)" per ticket with something auto-allowed, for terminal output. */
export function summarizeAuto(verdict: AutoVerdict): string[] {
  return Object.entries(verdict.tickets)
    .filter(([, v]) => v.auto.length > 0)
    .map(([id, v]) =>
      v.auto.includes(WHOLE_TICKET) ? id : `${id} (${v.auto.map(actionOf).join(", ")})`
    );
}
