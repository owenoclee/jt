import { loadToken, loadWorkspace, type Workspace } from "./config.ts";
import { fail } from "./errors.ts";
import { JiraClient } from "./jira/client.ts";
import { activeProposal } from "./proposal.ts";
import { loadMeta } from "./resolve.ts";
import { Store } from "./store.ts";
import type { Meta } from "./types.ts";

export interface LocalContext {
  ws: Workspace;
  store: Store;
}

export function localContext(): LocalContext {
  const ws = loadWorkspace();
  return { ws, store: new Store(ws.root, activeProposal()) };
}

/**
 * The context for one named workspace and proposal, taken from neither the current
 * directory nor $JT_PROPOSAL. The review server works this way: it is one process
 * serving every workspace, started from wherever some command happened to run.
 */
export function contextFor(root: string, proposal: string): LocalContext {
  const ws = loadWorkspace(root);
  // loadWorkspace walks up to the nearest workspace; a root that is not one itself
  // must not quietly resolve to a parent.
  if (ws.root !== root) fail(`${root} is not a jt workspace (no .jira/config.json there)`);
  return { ws, store: new Store(root, proposal) };
}

export function withMeta(ctx: LocalContext): LocalContext & { meta: Meta } {
  return { ...ctx, meta: loadMeta(ctx.ws.jiraDir) };
}

export function withClient<T extends LocalContext>(ctx: T): T & { client: JiraClient } {
  const { token, source } = loadToken();
  return {
    ...ctx,
    client: new JiraClient(ctx.ws.config.baseUrl, ctx.ws.config.email, token, source),
  };
}
