/** jt proposals — what is staged where: every proposal, its tickets, and its review. */
import { localContext } from "../context.ts";
import { DEFAULT_PROPOSAL, explicitProposalFlag } from "../proposal.ts";
import { bold, cyan, dim, green, yellow } from "../render/colors.ts";
import { pidAlive, readPending, readResult } from "../review/handoff.ts";

export function cmdProposals(): void {
  const { store } = localContext();
  const lines: string[] = [];
  for (const name of store.listProposals()) {
    const s = store.scoped(name);
    s.dropIfDrained(); // finished proposals are tidied as they are noticed
    const ids = [
      ...s.listCommittedIds(),
      ...s.readIntents().map((i) => `${i.key} (${i.mode}${i.committed ? "" : ", uncommitted"})`),
    ];
    const pending = readPending(s.proposalDir);
    const result = readResult(s.proposalDir);
    if (ids.length === 0 && !pending && !result) continue;

    const flag = explicitProposalFlag(name);
    const review = result
      ? yellow(`outcome waiting — jt await${flag}`)
      : pending && pidAlive(pending.pid)
      ? (pending.decidedAt
        ? yellow(`decided, settling — jt await${flag}`)
        : green(`in review: ${pending.url} — jt await${flag}`))
      : ids.length
      ? dim(`not pushed yet — jt push${flag}`)
      : dim("idle");
    const here = name === store.proposal ? cyan(" (this one)") : "";
    lines.push(`${bold(name)}${here}  ${review}`);
    if (ids.length) lines.push(`  ${ids.join(", ")}`);
  }
  if (lines.length === 0) {
    console.log("nothing staged in any proposal — jt commit stages changes for push");
    return;
  }
  console.log(lines.join("\n"));
  if (store.proposal === DEFAULT_PROPOSAL) {
    console.log(dim("\nwork on a named one with -p NAME on any command (or JT_PROPOSAL=NAME)"));
  }
}
