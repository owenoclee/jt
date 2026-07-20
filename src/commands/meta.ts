import { localContext, withClient } from "../context.ts";
import { fail } from "../errors.ts";
import { syncMeta } from "../metasync.ts";
import { bold, dim } from "../render/colors.ts";
import { loadMeta, metaPath, saveMeta } from "../resolve.ts";

export async function cmdMeta(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "sync") {
    const ctx = withClient(localContext());
    const meta = await syncMeta(ctx.client, ctx.ws.config);
    saveMeta(ctx.ws.jiraDir, meta);
    console.log(`wrote ${metaPath(ctx.ws.jiraDir)}`);
    console.log(
      `  ${meta.fields.length} fields · ${meta.issueTypes.length} issue types · ` +
        `${meta.linkTypes.length} link types · ${meta.statuses.length} statuses · ` +
        `${meta.sprints.length} open sprints${meta.boardId ? ` (board ${meta.boardId})` : ""}`,
    );
    return;
  }
  if (sub === "show" || sub === undefined) {
    const ctx = localContext();
    const meta = loadMeta(ctx.ws.jiraDir);
    console.log(`${bold("meta")} synced ${meta.syncedAt}  ${dim(metaPath(ctx.ws.jiraDir))}`);
    console.log(`  issue types: ${meta.issueTypes.map((t) => t.name).join(", ")}`);
    console.log(
      `  link phrases: ${meta.linkTypes.flatMap((l) => [l.outward, l.inward]).sort().join(", ")}`,
    );
    console.log(`  priorities: ${meta.priorities.map((p) => p.name).join(", ")}`);
    console.log(`  statuses: ${[...meta.statuses].sort().join(", ")}`);
    console.log(
      `  sprints: ${meta.sprints.map((s) => `${s.name} (${s.state})`).join(", ") || "(none)"}`,
    );
    console.log(`  sprint field: ${meta.sprintFieldId ?? "(none)"} · board: ${meta.boardId ?? "(none)"}`);
    console.log(dim(`  ${meta.fields.length} fields known — custom field aliases resolve against these`));
    return;
  }
  fail(`unknown subcommand 'jt meta ${sub}' — use: jt meta sync | jt meta show`);
}
