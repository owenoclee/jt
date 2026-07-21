import { parseArgs } from "@std/cli";
import { join } from "@std/path";
import { CREDENTIALS_PATH, DEFAULT_TRACKED_FIELDS, loadToken, loadWorkspace } from "../config.ts";
import { fail } from "../errors.ts";
import { Store } from "../store.ts";

export function cmdInit(argv: string[]): void {
  const args = parseArgs(argv, {
    string: ["base-url", "email", "project", "board"],
    boolean: ["force"],
  });
  const baseUrl = args["base-url"];
  const email = args.email;
  const project = args.project;
  const missing = [
    !baseUrl && "--base-url <https://yoursite.atlassian.net>",
    !email && "--email <you@example.com>",
    !project && "--project <KEY>",
  ].filter(Boolean);
  if (missing.length) fail(`jt init requires: ${missing.join(", ")}`);

  const root = Deno.cwd();
  const configPath = join(root, ".jira", "config.json");
  try {
    Deno.statSync(configPath);
    if (!args.force) fail(`${configPath} already exists (use --force to overwrite)`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound) && !args.force) {
      // stat failed for a reason other than "missing" — fall through and let write fail loudly
    }
  }

  const store = new Store(root);
  store.ensureDirs();
  const config = {
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    email: email!,
    project: project!.toUpperCase(),
    ...(args.board ? { boardId: Number(args.board) } : {}),
    trackedFields: DEFAULT_TRACKED_FIELDS,
    customFields: [],
    sync: { jql: `project = ${project!.toUpperCase()}` },
  };
  Deno.writeTextFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`initialized jt workspace at ${root}`);
  console.log(`  config: ${configPath}`);
  console.log(`  next:   jt meta sync   (build the alias maps)`);
  console.log(`          jt pull        (clone the project into tickets/)`);
  console.log(
    `  note:   the workspace mirrors sync.jql from the config — narrow it, or delete the`,
  );
  console.log(
    `          sync key to track tickets one by one (jt fetch <KEY...> | --jql '...')`,
  );
  console.log(
    `  note:   add custom field aliases (e.g. "Story Points") to customFields in the config`,
  );
}

export function cmdConfigShow(): void {
  const ws = loadWorkspace();
  console.log(`workspace: ${ws.root}`);
  console.log(JSON.stringify(ws.config, null, 2));
  try {
    const { source } = loadToken();
    console.log(`token: present (${source})`);
  } catch {
    console.log(`token: MISSING — export JIRA_API_TOKEN or write ${CREDENTIALS_PATH}`);
  }
}
