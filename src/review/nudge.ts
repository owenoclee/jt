/**
 * Keeping the push handoff from being dropped.
 *
 * `jt push` and `jt await` are two halves of one obligation: push serves the page,
 * await collects the human's decision. Between them sits an agent whose contract
 * (SKILL.md) may be hundreds of turns back in its context — far enough that the second
 * half quietly goes missing, leaving the human staring at an unopened URL and the agent
 * reporting a push that never happened.
 *
 * Documentation cannot fix that on its own; recency can. So push restates what is still
 * owed in its own output, at the moment it creates the obligation. Advisory text only:
 * nothing here changes exit codes or control flow.
 */
import { bold, dim, yellow } from "../render/colors.ts";

/**
 * The OS opener that hands a served page to the human — for the agent to run, not us.
 * `jt` deliberately does not open the page itself: spawning the opener from inside jt
 * proved unreliable under the non-TTY, sandboxed environments agents run in, whereas
 * the agent invoking it directly works. Printing the exact command is the reliable path.
 */
export function openerCommand(url: string): string {
  switch (Deno.build.os) {
    case "darwin":
      return `open '${url}'`;
    case "windows":
      return `start "" "${url}"`;
    default:
      return `xdg-open '${url}'`;
  }
}

/** Printed by jt push directly under the URL: what is still owed, in order. */
export function pushHandoffNotice(url: string): string {
  return [
    yellow(bold("NOT DONE — nothing has been sent to Jira yet. Two steps remain:")),
    `  1. open the review page for the user:  ${bold(openerCommand(url))}`,
    `  2. collect their decision:             ${bold("jt await")}`,
    dim("     blocks until they decide, then reports the outcome exactly once — exit"),
    dim("     0 pushed · 2 changes requested · 1 stale/failed/cancelled. Run it as a"),
    dim("     background task if your harness supports one."),
    yellow("Do not report this push as finished, and do not move on to other work,"),
    yellow("until jt await returns. jt cancel withdraws the review if plans change."),
  ].join("\n");
}
