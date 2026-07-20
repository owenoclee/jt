/** Builds .jira/meta.json: the on-disk alias maps used for all name->id resolution. */
// deno-lint-ignore-file no-explicit-any
import type { JiraClient } from "./jira/client.ts";
import type { Config, Meta } from "./types.ts";

export async function syncMeta(client: JiraClient, config: Config): Promise<Meta> {
  const [fieldsRaw, issueTypesRaw, linkTypesRaw, prioritiesRaw, statusesRaw] = await Promise.all([
    client.get("/rest/api/3/field"),
    client.get(`/rest/api/3/issue/createmeta/${config.project}/issuetypes`, {
      maxResults: "200",
    }),
    client.get("/rest/api/3/issueLinkType"),
    client.get("/rest/api/3/priority"),
    client.get(`/rest/api/3/project/${config.project}/statuses`),
  ]);

  const fields = (fieldsRaw as any[]).map((f) => ({
    id: f.id as string,
    name: f.name as string,
    custom: Boolean(f.custom),
    schemaType: f.schema?.type as string | undefined,
    schemaCustom: f.schema?.custom as string | undefined,
    schemaItems: f.schema?.items as string | undefined,
  }));

  const issueTypes = ((issueTypesRaw as any).issueTypes ?? (issueTypesRaw as any).values ?? [])
    .map((t: any) => ({
      id: String(t.id),
      name: t.name as string,
      subtask: Boolean(t.subtask),
    }));

  const linkTypes = ((linkTypesRaw as any).issueLinkTypes ?? []).map((lt: any) => ({
    id: String(lt.id),
    name: lt.name as string,
    inward: lt.inward as string,
    outward: lt.outward as string,
  }));

  const priorities = (prioritiesRaw as any[]).map((p) => ({
    id: String(p.id),
    name: p.name as string,
  }));

  const statusNames = new Set<string>();
  for (const perType of statusesRaw as any[]) {
    for (const s of perType.statuses ?? []) statusNames.add(s.name);
  }

  const sprintFieldId =
    fields.find((f) => f.schemaCustom === "com.pyxis.greenhopper.jira:gh-sprint")?.id ?? null;

  let boardId: number | null = config.boardId ?? null;
  let sprints: Meta["sprints"] = [];
  if (boardId === null) {
    try {
      const boards = (await client.get("/rest/agile/1.0/board", {
        projectKeyOrId: config.project,
      })) as any;
      const values: any[] = boards.values ?? [];
      const scrum = values.find((b) => b.type === "scrum") ?? values[0];
      boardId = scrum ? Number(scrum.id) : null;
    } catch {
      boardId = null; // no agile boards — sprints simply unavailable
    }
  }
  if (boardId !== null) {
    try {
      let startAt = 0;
      while (true) {
        const page = (await client.get(`/rest/agile/1.0/board/${boardId}/sprint`, {
          state: "active,future",
          startAt: String(startAt),
        })) as any;
        for (const s of page.values ?? []) {
          sprints.push({ id: Number(s.id), name: s.name as string, state: s.state as string });
        }
        if (page.isLast !== false) break;
        startAt += (page.values ?? []).length;
        if (!page.values?.length) break;
      }
    } catch {
      sprints = []; // board has no sprint support
    }
  }

  return {
    syncedAt: new Date().toISOString(),
    fields,
    issueTypes,
    linkTypes,
    priorities,
    statuses: [...statusNames],
    sprints,
    sprintFieldId,
    boardId,
  };
}
