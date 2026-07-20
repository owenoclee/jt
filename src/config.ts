import { dirname, join } from "@std/path";
import { ConfigSchema } from "./schema.ts";
import { fail } from "./errors.ts";
import type { Config } from "./types.ts";

export const DEFAULT_TRACKED_FIELDS = [
  "summary",
  "description",
  "status",
  "labels",
  "parent",
  "sprint",
  "assignee",
  "priority",
];

export interface Workspace {
  root: string;
  jiraDir: string;
  config: Config;
}

export function findWorkspaceRoot(from: string): string | null {
  let dir = from;
  while (true) {
    try {
      Deno.statSync(join(dir, ".jira", "config.json"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

export function loadWorkspace(cwd = Deno.cwd()): Workspace {
  const root = findWorkspaceRoot(cwd);
  if (!root) {
    fail(`not a jt workspace (no .jira/config.json found in ${cwd} or any parent) — run: jt init`);
  }
  const path = join(root, ".jira", "config.json");
  let data: unknown;
  try {
    data = JSON.parse(Deno.readTextFileSync(path));
  } catch (e) {
    fail(`cannot read ${path}: ${e instanceof Error ? e.message : e}`);
  }
  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    fail(`invalid config ${path}:\n${issues.join("\n")}`);
  }
  return { root, jiraDir: join(root, ".jira"), config: result.data };
}

export const CREDENTIALS_PATH = join(
  Deno.env.get("HOME") ?? "~",
  ".config",
  "jira-cli",
  "credentials",
);

export function loadToken(): { token: string; source: string } {
  const env = Deno.env.get("JIRA_API_TOKEN");
  if (env && env.trim()) return { token: env.trim(), source: "env:JIRA_API_TOKEN" };
  try {
    const file = Deno.readTextFileSync(CREDENTIALS_PATH).trim();
    if (file) return { token: file, source: CREDENTIALS_PATH };
  } catch {
    // fall through
  }
  fail(
    `no Jira API token found. Either export JIRA_API_TOKEN, or write it to ${CREDENTIALS_PATH}:\n` +
      `  sh -c 'umask 077; mkdir -p ~/.config/jira-cli; printf "%s" "$JIRA_API_TOKEN" > ~/.config/jira-cli/credentials'`,
  );
}
