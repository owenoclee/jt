/**
 * The workspaces the review server knows about: ~/.config/jt/workspaces.json.
 *
 * A proposal's link has to mean the same thing next week, from a server that was
 * restarted in between and was never told which directory it is for. So each workspace
 * gets a short stable name — its slug, in the URL — the first time it submits a
 * proposal, and the server finds the directory from that.
 */
import { join } from "@std/path";
import { configHome } from "../config.ts";
import { writeFileAtomic } from "../fsutil.ts";

export interface WorkspaceEntry {
  /** The workspace's name in review URLs: /p/<slug>/<proposal>. */
  slug: string;
  /** Its root directory (the one holding .jira/). */
  root: string;
}

export const registryPath = (): string => join(configHome(), "jt", "workspaces.json");

export function readRegistry(): WorkspaceEntry[] {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(registryPath()));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is WorkspaceEntry =>
      typeof e?.slug === "string" && typeof e?.root === "string"
    );
  } catch {
    return [];
  }
}

export function workspaceBySlug(slug: string): WorkspaceEntry | null {
  return readRegistry().find((e) => e.slug === slug) ?? null;
}

/**
 * The slug for a workspace, registering it on first sight. Named after its Jira
 * project, which is what the user calls it; a second workspace for the same project
 * gets a numbered one, since a slug must never come to mean a different directory.
 */
export function registerWorkspace(root: string, project: string): string {
  const entries = readRegistry();
  const known = entries.find((e) => e.root === root);
  if (known) return known.slug;
  const wanted = project.replace(/[^A-Za-z0-9_-]/g, "") || "workspace";
  const taken = new Set(entries.map((e) => e.slug));
  let slug = wanted;
  for (let n = 2; taken.has(slug); n++) slug = `${wanted}-${n}`;
  Deno.mkdirSync(join(configHome(), "jt"), { recursive: true });
  writeFileAtomic(registryPath(), JSON.stringify([...entries, { slug, root }], null, 2) + "\n");
  return slug;
}
