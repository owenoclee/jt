/**
 * Keeping installed agent skills in step with the binary.
 *
 * `jt skill install` copies the SKILL.md embedded in this binary into an agent's skills
 * directory. Upgrading jt replaces the binary but not that copy, and nobody remembers to
 * reinstall it — so the agent goes on following the contract of a different jt. Every
 * command therefore checks the copies first.
 *
 * Whether jt may replace a copy is decided by its content alone. SHIPPED_SKILLS lists
 * every SKILL.md any jt has embedded: a copy matching one of them was written by jt and
 * not touched since, so it is refreshed in place. A copy matching none has been edited,
 * and is left alone with a warning (at most once a day). Only agents that already have
 * the skill are looked at — jt never installs into an agent the user did not choose.
 *
 * The reader of these notices is usually an agent, and by definition one whose loaded
 * contract is the stale one — so each notice spells out what to do in full rather than
 * relying on SKILL.md to explain it. Every failure is silent: this must never be the
 * reason a command fails.
 */
import { join } from "@std/path";
import { configHome } from "./config.ts";
import { dim, yellow } from "./render/colors.ts";
import { SILENT_COMMANDS } from "./update.ts";
import { VERSION } from "./version.ts";
import SKILL_MD from "../SKILL.md" with { type: "text" };

/** The agent skill this binary ships — what `jt skill show` prints and `install` writes. */
export { SKILL_MD };

/** Where each agent discovers skills; `jt skill install <agent>` writes SKILL.md here. */
export const SKILL_DIRS: Record<string, (home: string) => string> = {
  "claude-code": (home) => join(home, ".claude", "skills", "jt"),
  "codex": (home) => join(Deno.env.get("CODEX_HOME") ?? join(home, ".codex"), "skills", "jt"),
};

/**
 * sha256 of every SKILL.md a jt has embedded, with the first version that shipped it.
 * Append-only. A test fails until the current SKILL.md is listed, so every binary
 * recognises the copies written by every earlier one.
 */
export const SHIPPED_SKILLS: Readonly<Record<string, string>> = {
  "fbd40ccf99f38857928fa3d340edc628fb095264b37a743356a6d22d7f9a9354": "0.1.0",
  "1d3f28ea65dbc3c73535e993a3edc9c6badbbbec0c73ae8317e8d0367ea64abd": "0.2.0",
  "13fc59243c51cb3653a15d0c25318950a5cfba630e22c231c068dd1221ccab00": "0.3.0",
  "e7b9ad4eda261c694898c9553652ac77dcdf1f35319864884886e8993cf05208": "0.4.0",
  "7361cda125634eef897ecafe18434b72e85d0fba1d121666d90bc8416e63a0fd": "0.4.1",
  "a01153f3a20c819fe2d962ff62fe0761b050e6c22f4a3a4083f69aa9db96ce56": "0.5.0",
  "a261cafe3d43ba097efac5aeafb27ece183ae837b84afad2dab4cea1b6ab95ef": "0.6.0-rc.1",
  "b3ca85bd394a2fcd4ebed945b6f73363a183a211cc26709a35e1ed58de22cc1d": "0.6.0-rc.4",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The hash a copy is recognised by. jt writes the embedded text byte for byte, but an
 * editor or sync tool may have added a BOM or CRLF line endings since — that is not an
 * edit worth protecting, so neither counts.
 */
export async function skillHash(text: string): Promise<string> {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SkillSyncOptions {
  home?: string;
  /** The SKILL.md this build ships; tests substitute their own. */
  embedded?: string;
  shipped?: Readonly<Record<string, string>>;
  version?: string;
  cachePath?: string;
  now?: () => number;
  print?: (line: string) => void;
}

/** Per path: when an edited copy was last warned about, and against which embedded skill. */
type WarnCache = Record<string, { warnedAt: number; warnedFor: string }>;

export const skillCheckCachePath = (): string => join(configHome(), "jt", "skill-check.json");

export function skillSyncEnabled(cmd: string | undefined): boolean {
  return cmd === undefined || !SILENT_COMMANDS.has(cmd);
}

function tildePath(path: string, home: string): string {
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

export function refreshedNotice(path: string, from: string, version: string): string {
  return [
    yellow(`jt: updated the agent skill at ${path} (from jt ${from}) to match jt ${version}.`),
    dim("  agent: the jt instructions in your context are from an older jt. Run `jt skill show`"),
    dim("  and follow that version for the rest of this session. No need to tell the user."),
  ].join("\n");
}

export function editedNotice(path: string, agent: string, version: string): string {
  return [
    yellow(`jt: the agent skill at ${path} has local edits and is out of date for jt ${version};`),
    yellow("  it was left unchanged."),
    dim("  agent: run `jt skill show` and follow that version for this session. Tell the user"),
    dim("  their installed jt skill is out of date. Do not run `jt skill install` yourself —"),
    dim("  it would discard their edits."),
    dim(`  user:  \`jt skill install ${agent}\` replaces it with the current version.`),
  ].join("\n");
}

function readCache(path: string): WarnCache {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(path));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as WarnCache : {};
  } catch {
    return {};
  }
}

/** Replace via rename so an agent loading the skill never sees a half-written file. */
function replaceFile(path: string, text: string): void {
  const tmp = `${path}.jt-${Deno.pid}.tmp`;
  Deno.writeTextFileSync(tmp, text);
  try {
    Deno.renameSync(tmp, path);
  } catch (e) {
    try {
      Deno.removeSync(tmp);
    } catch {
      // nothing left to clean up
    }
    throw e;
  }
}

/** Refresh stale, untouched skill copies and warn about edited ones. Never throws. */
export async function syncInstalledSkills(opts: SkillSyncOptions = {}): Promise<void> {
  try {
    const home = opts.home ?? Deno.env.get("HOME");
    if (!home) return;
    const embedded = opts.embedded ?? SKILL_MD;
    const shipped = opts.shipped ?? SHIPPED_SKILLS;
    const version = opts.version ?? VERSION;
    const now = opts.now ?? Date.now;
    const print = opts.print ?? ((line: string) => console.error(line));
    const cachePath = opts.cachePath ?? skillCheckCachePath();
    const current = await skillHash(embedded);
    let cache: WarnCache | null = null;

    for (const [agent, dirFor] of Object.entries(SKILL_DIRS)) {
      const path = join(dirFor(home), "SKILL.md");
      let installed: string;
      try {
        installed = Deno.readTextFileSync(path);
      } catch {
        continue; // not installed for this agent — not ours to add
      }
      const hash = await skillHash(installed);
      if (hash === current) continue;

      const from = shipped[hash];
      if (from !== undefined) {
        try {
          replaceFile(path, embedded);
          print(refreshedNotice(tildePath(path, home), from, version));
        } catch {
          // unwritable: try again next command
        }
        continue;
      }

      cache ??= readCache(cachePath);
      const last = cache[path];
      if (last && last.warnedFor === current && now() - last.warnedAt < DAY_MS) continue;
      print(editedNotice(tildePath(path, home), agent, version));
      cache[path] = { warnedAt: now(), warnedFor: current };
      try {
        Deno.mkdirSync(join(cachePath, ".."), { recursive: true });
        Deno.writeTextFileSync(cachePath, JSON.stringify(cache) + "\n");
      } catch {
        // an unwritable cache only means the warning repeats
      }
    }
  } catch {
    // keeping the skill current is a courtesy; it never fails a command
  }
}
