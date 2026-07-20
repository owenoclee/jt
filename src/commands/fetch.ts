// deno-lint-ignore-file no-explicit-any
import { parseArgs } from "@std/cli";
import { localContext, withClient, withMeta } from "../context.ts";
import { fail } from "../errors.ts";
import { JiraApiError } from "../jira/client.ts";
import { dim, green, red, yellow } from "../render/colors.ts";
import { fetchBaseEntry, integrateFetched } from "../sync.ts";
import { ticketsEqual } from "../canonical.ts";

export async function cmdFetch(argv: string[]): Promise<void> {
  const args = parseArgs(argv, { string: ["jql", "limit"] });
  const ctx = withClient(withMeta(localContext()));
  let keys = (args._ as string[]).map((k) => String(k).toUpperCase());

  if (args.jql) {
    const limit = args.limit ? Number(args.limit) : 50;
    keys = [...keys, ...(await searchKeys(ctx.client, args.jql, limit))];
  }
  if (keys.length === 0) fail("jt fetch requires issue keys or --jql '...'");

  for (const key of [...new Set(keys)]) {
    const entry = await fetchBaseEntry(ctx.client, ctx.meta, ctx.ws.config, key);
    report(key, integrateFetched(ctx.store, entry));
  }
}

export async function cmdPull(): Promise<void> {
  const ctx = withClient(withMeta(localContext()));
  const deletions = ctx.store.readDeletions();
  const keys = [...new Set([...ctx.store.listBaseKeys(), ...deletions.map((d) => d.key)])];
  if (keys.length === 0) {
    console.log("nothing tracked — run: jt fetch <KEY...>");
    return;
  }
  for (const key of keys) {
    try {
      const entry = await fetchBaseEntry(ctx.client, ctx.meta, ctx.ws.config, key);
      report(key, integrateFetched(ctx.store, entry));
    } catch (e) {
      if (e instanceof JiraApiError && e.status === 404) {
        handleRemoteDeleted(ctx.store, key);
      } else {
        throw e;
      }
    }
  }
}

function handleRemoteDeleted(store: ReturnType<typeof localContext>["store"], key: string): void {
  const intent = store.readDeletions().find((d) => d.key === key);
  if (intent) {
    store.writeDeletions(store.readDeletions().filter((d) => d.key !== key));
    store.removeBase(key);
    store.removeCommitted(key);
    console.log(`  ${key} ${dim("already deleted remotely — deletion intent cleared")}`);
    return;
  }
  const base = store.readBase(key);
  const working = store.readWorking(key);
  const clean = base && working && ticketsEqual(working.ticket, base.ticket) &&
    !store.listCommittedIds().includes(key);
  if (clean) {
    store.removeWorking(key);
    store.removeBase(key);
    console.log(`  ${key} ${yellow("deleted remotely — removed local copy")}`);
  } else {
    console.log(
      `  ${key} ${red("deleted remotely but you have local changes")} — jt untrack ${key} to drop them`,
    );
  }
}

function report(key: string, result: ReturnType<typeof integrateFetched>): void {
  switch (result.kind) {
    case "created":
      console.log(`  ${key} ${green("fetched")} → tickets/${key}.json`);
      break;
    case "refreshed":
      console.log(`  ${key} ${dim("refreshed")}`);
      break;
    case "rebased":
      console.log(
        `  ${key} ${yellow("rebased")} — remote changed: ${result.fields.join(", ") || "(comments)"}`,
      );
      break;
    case "kept":
      console.log(`  ${key} ${dim("base updated; working file left as-is")}`);
      break;
    case "conflict":
      console.log(
        `  ${key} ${red("CONFLICT")} on ${result.fields.join(", ")} — ` +
          `edit the working file to the desired final state, then: jt resolve ${key}`,
      );
      break;
  }
}

async function searchKeys(client: any, jql: string, limit: number): Promise<string[]> {
  const keys: string[] = [];
  let nextPageToken: string | undefined;
  while (keys.length < limit) {
    const body: Record<string, unknown> = {
      jql,
      maxResults: Math.min(100, limit - keys.length),
      fields: ["key"],
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const page = (await client.post("/rest/api/3/search/jql", body)) as any;
    for (const issue of page.issues ?? []) keys.push(issue.key);
    nextPageToken = page.nextPageToken;
    if (!nextPageToken || (page.issues ?? []).length === 0) break;
  }
  return keys;
}
