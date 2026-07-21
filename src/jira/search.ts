/** Enhanced JQL search (POST /search/jql, nextPageToken pagination). */
// deno-lint-ignore-file no-explicit-any
import type { JiraClient } from "./client.ts";

export async function searchPage(
  client: JiraClient,
  jql: string,
  fields: string[],
  nextPageToken?: string,
  maxResults = 100,
): Promise<{ issues: any[]; nextPageToken?: string }> {
  const body: Record<string, unknown> = { jql, maxResults, fields };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  return (await client.post("/rest/api/3/search/jql", body)) as any;
}

export async function searchKeys(
  client: JiraClient,
  jql: string,
  limit: number,
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  while (keys.length < limit) {
    const page = await searchPage(client, jql, ["key"], token, Math.min(100, limit - keys.length));
    const issues = page.issues ?? [];
    for (const issue of issues) keys.push(issue.key);
    token = page.nextPageToken;
    if (!token || issues.length === 0) break;
  }
  return keys;
}
