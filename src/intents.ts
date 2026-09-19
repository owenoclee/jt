/**
 * Whole-issue intents: delete, archive, unarchive.
 *
 * No field edit can express these, so they are staged beside the ticket layers
 * (.jira/intents.json) rather than inside them, and follow the same commit → push →
 * approve path as any other change.
 *
 * Archiving is reversible and is what most teams want; deletion is not, and is
 * permanent the moment the review page is approved. `jt rm` therefore points at
 * `jt archive`. Archiving is a Jira Premium/Enterprise feature — on other plans the
 * archive call comes back 4xx, explained at that point rather than guessed at here.
 */
import type { CompiledOp, IntentMode, IssueIntent, TicketState } from "./types.ts";

const STATE: Record<IntentMode, string> = {
  delete: "deleted",
  archive: "archived",
  unarchive: "unarchived",
};

/** Status states that mean "an intent is staged but not committed", and their pair. */
export const STAGED_INTENT_STATES: TicketState[] = ["deleted", "archived", "unarchived"];
export const COMMITTED_INTENT_STATES: TicketState[] = [
  "deleted+committed",
  "archived+committed",
  "unarchived+committed",
];

export function intentState(mode: IntentMode, committed: boolean): TicketState {
  return (committed ? `${STATE[mode]}+committed` : STATE[mode]) as TicketState;
}

const NOUN: Record<IntentMode, string> = {
  delete: "deletion",
  archive: "archiving",
  unarchive: "unarchiving",
};

/** "deletion" / "archiving" / "unarchiving" — the noun, for commit and chain labels. */
export function intentNoun(mode: IntentMode): string {
  return NOUN[mode];
}

/**
 * The compiled API call for a committed intent.
 *
 * Archiving has no per-issue route — the documented `PUT /issue/{key}/archive` answers
 * "No endpoint" on a live Jira Cloud site (checked against v2 and v3). Both directions
 * are list endpoints instead, which jt calls with a list of one so each ticket keeps
 * its own reviewable, journalled operation.
 */
export function intentOp(intent: IssueIntent): CompiledOp {
  const { key, mode, summary } = intent;
  const label = `${mode} ${key} ("${summary}")`;
  if (mode === "delete") {
    return {
      label,
      kind: "delete",
      issue: key,
      method: "DELETE",
      path: `/rest/api/3/issue/${key}`,
    };
  }
  return {
    label,
    kind: mode === "archive" ? "archive" : "unarchive",
    issue: key,
    method: "PUT",
    path: `/rest/api/3/issue/${mode === "archive" ? "archive" : "unarchive"}`,
    body: { issueIdsOrKeys: [key] },
  };
}

/**
 * The list endpoints answer 200 even when they changed nothing — a per-issue refusal
 * is reported inside the body. Treat a reported failure as a failed op rather than
 * letting a push claim a ticket was archived when it was not. Written to accuse only
 * on positive evidence of failure: an unfamiliar success shape must not read as one.
 */
export function intentFailure(mode: IntentMode, key: string, response: unknown): string | null {
  const body = response as {
    numberOfIssuesUpdated?: number;
    errors?: { issuesInError?: unknown[]; issueIsSubtask?: unknown } | unknown[] | null;
  } | null;
  if (!body || typeof body !== "object") return null;
  if (body.numberOfIssuesUpdated === 0) {
    return `${mode} of ${key} changed nothing — Jira reported no issues updated` +
      detailOf(body.errors);
  }
  const errors = body.errors;
  const reported = Array.isArray(errors)
    ? errors.length > 0
    : Boolean(errors && Object.values(errors).some((v) => Array.isArray(v) ? v.length > 0 : v));
  if (reported) return `${mode} of ${key} was refused${detailOf(errors)}`;
  return null;
}

function detailOf(errors: unknown): string {
  if (!errors) return "";
  const text = JSON.stringify(errors);
  return text && text !== "{}" && text !== "[]" ? ` — ${text}` : "";
}
