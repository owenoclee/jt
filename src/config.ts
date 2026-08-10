import { dirname, join } from "@std/path";
import { ConfigSchema } from "./schema.ts";
import { fail } from "./errors.ts";
import type { Config } from "./types.ts";

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

const configHome = () => join(Deno.env.get("HOME") ?? "~", ".config");

/** Where the durable API token lives: ~/.config/jt/credentials. */
export const credentialsPath = (): string => join(configHome(), "jt", "credentials");

/**
 * The pre-rename home, from when this tool was called jira-cli. Still read (after the
 * current path) so an existing install keeps working untouched; never written or
 * suggested. `jt config show` names it and points at the move.
 */
export const legacyCredentialsPath = (): string => join(configHome(), "jira-cli", "credentials");

export function loadToken(): { token: string; source: string } {
  const env = Deno.env.get("JIRA_API_TOKEN");
  if (env && env.trim()) return { token: env.trim(), source: "env:JIRA_API_TOKEN" };
  for (const path of [credentialsPath(), legacyCredentialsPath()]) {
    try {
      const file = Deno.readTextFileSync(path).trim();
      if (file) return { token: file, source: path };
    } catch {
      // absent or unreadable — try the next location
    }
  }
  fail(
    `no Jira API token found. Either export JIRA_API_TOKEN, or write it to ${credentialsPath()}:\n` +
      `  sh -c 'umask 077; mkdir -p ~/.config/jt; printf "%s" "$JIRA_API_TOKEN" > ~/.config/jt/credentials'`,
  );
}
