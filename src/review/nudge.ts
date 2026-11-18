/**
 * What `jt push` says once a proposal is submitted.
 *
 * The reader is usually an agent, and possibly one whose copy of the contract
 * (SKILL.md) is hundreds of turns back in its context — or predates this flow
 * altogether, from when a push meant opening a page and waiting on it. Documentation
 * cannot fix that on its own; recency can. So push restates, at the moment it matters,
 * what the agent now does and what it must not. Advisory text only: nothing here
 * changes exit codes or control flow.
 */
import { proposalFlag } from "../proposal.ts";
import { bold, dim, yellow } from "../render/colors.ts";

/** Printed directly under the proposal's link. */
export function submittedNotice(proposal: string): string {
  const flag = proposalFlag(proposal);
  return [
    yellow(bold("SUBMITTED — nothing has been sent to Jira. The user approves it on that page, whenever")),
    yellow(bold("they get to it, and that is what sends it.")),
    "  agent: give the user the link in your reply, with a line on what the proposal does.",
    "         That is the end of your part: you may finish your turn.",
    dim("         Do not open the link for them, do not fetch or drive the page, and do not wait"),
    dim(`         on the review. (Only if the user asks you to wait: jt await${flag}.)`),
    dim("  later: jt proposals shows whether it was pushed, or which changes the user asked for."),
  ].join("\n");
}
