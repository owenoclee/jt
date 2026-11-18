/**
 * Bringing a proposal up to date with Jira before it is reviewed.
 *
 * A proposal may wait days for its review, and Jira does not wait with it. Opening its
 * page therefore does for its staged tickets exactly what `jt fetch KEY...` would:
 * fetch what moved and rebase the proposal onto it, so the diff the reviewer reads is
 * against Jira as it is now. A remote edit to a field the proposal leaves alone is
 * absorbed (and recorded in the commit chain as a "remote" entry). What cannot be
 * absorbed — the same field changed on both sides, a ticket that no longer exists —
 * is a problem only the proposal's agent can fix, and is reported instead.
 */
import { integrateWithChain, type Rebase, recordRebases } from "../commands/fetch.ts";
import { type PushContext, remoteUpdated } from "../commands/push.ts";
import { proposalFlag } from "../proposal.ts";
import { fetchBaseEntry } from "../sync.ts";

export interface RefreshResult {
  /** Why the proposal cannot be reviewed as it stands; empty when it can. */
  problems: string[];
}

export async function refreshProposal(ctx: PushContext): Promise<RefreshResult> {
  const { store } = ctx;
  // Everything staged that Jira can be asked about. A pending creation has nothing
  // to fetch; an issue waiting to be un-archived is, being archived, not on the board
  // to be found — its absence is the state the proposal expects, not a deletion.
  const keys = [
    ...new Set([
      ...store.listCommittedIds().filter((id) => !id.startsWith("@")),
      ...store.readIntents().filter((i) => i.committed && i.mode !== "unarchive").map((i) => i.key),
    ]),
  ].filter((key) => store.readBase(key) !== null);

  const problems: string[] = [];
  const flag = proposalFlag(store.proposal);
  if (keys.length > 0) {
    const remote = await remoteUpdated(ctx, keys);
    const rebases: Rebase[] = [];
    for (const key of keys) {
      const updated = remote.get(key);
      if (updated === undefined) {
        problems.push(
          `${key} no longer exists in Jira (deleted, or moved out of reach) — run jt pull, ` +
            `take it out of the proposal, then jt push${flag} again`,
        );
        continue;
      }
      if (updated === store.readBase(key)!.updated) continue;
      const entry = await fetchBaseEntry(ctx.client, ctx.meta, ctx.ws.config, key);
      integrateWithChain(store, entry, rebases);
    }
    recordRebases(rebases);
  }
  // Conflicts on staged tickets, whether this refresh found them or an earlier pull did.
  const staged = new Set(keys);
  for (const c of store.readConflicts().filter((c) => staged.has(c.key))) {
    problems.push(
      `${c.key}: Jira changed ${c.fields.join(", ")}, which this proposal also changes — edit ` +
        `tickets/${c.key}.json to the state you want, run jt resolve ${c.key}, commit, ` +
        `then jt push${flag} again`,
    );
  }
  return { problems };
}
