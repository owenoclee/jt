import { loadToken, loadWorkspace, type Workspace } from "./config.ts";
import { JiraClient } from "./jira/client.ts";
import { loadMeta } from "./resolve.ts";
import { Store } from "./store.ts";
import type { Meta } from "./types.ts";

export interface LocalContext {
  ws: Workspace;
  store: Store;
}

export function localContext(): LocalContext {
  const ws = loadWorkspace();
  return { ws, store: new Store(ws.root) };
}

export function withMeta(ctx: LocalContext): LocalContext & { meta: Meta } {
  return { ...ctx, meta: loadMeta(ctx.ws.jiraDir) };
}

export function withClient<T extends LocalContext>(ctx: T): T & { client: JiraClient } {
  const { token } = loadToken();
  return { ...ctx, client: new JiraClient(ctx.ws.config.baseUrl, ctx.ws.config.email, token) };
}
