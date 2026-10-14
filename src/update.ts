/**
 * Update advice: tell the user when a newer jt exists. Advice only — jt never
 * downloads, installs, or replaces anything.
 *
 * At most once a day jt asks GitHub for the release list, bounded by a short timeout,
 * and remembers the answer in ~/.config/jt/update-check.json. When that answer is
 * newer than the running version, one line goes to stderr — also at most once a day,
 * so an agent running jt a hundred times is not told a hundred times. Every failure
 * (offline, rate-limited, unwritable cache) is silent: this must never be the reason
 * a command fails or stalls.
 *
 * A stable build is only ever pointed at stable releases; a release-candidate build is
 * pointed at whatever is newest, candidates included.
 *
 * Off switches: JT_NO_UPDATE_CHECK=1, or "updateCheck": false in the settings file.
 */
import { join } from "@std/path";
import { configHome } from "./config.ts";
import { dim, yellow } from "./render/colors.ts";
import { loadSettings } from "./settings.ts";
import { compareVersions, isPrerelease, parseVersion, REPO, VERSION } from "./version.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;
/** How long a finished command waits on an in-flight check before giving up on it. */
const GRACE_MS = 1200;

interface Cache {
  checkedAt: number;
  /** Newest version relevant to this build's channel, without the leading "v". */
  latest: string | null;
  notifiedAt: number;
  /** Which version the last notice was about — a newer one is announced at once. */
  notifiedFor: string | null;
}

export interface ReleaseInfo {
  tag_name: string;
  prerelease?: boolean;
  draft?: boolean;
}

export interface UpdateCheckOptions {
  current?: string;
  cachePath?: string;
  now?: () => number;
  fetchReleases?: (signal: AbortSignal) => Promise<ReleaseInfo[]>;
  execPath?: string;
  print?: (line: string) => void;
  graceMs?: number;
}

export const updateCachePath = (): string => join(configHome(), "jt", "update-check.json");

/** The newest published version a build on `current`'s channel should hear about. */
export function pickLatest(releases: ReleaseInfo[], current: string): string | null {
  const candidates = releases
    .filter((r) => !r.draft && parseVersion(r.tag_name) !== null)
    .map((r) => r.tag_name.replace(/^v/, ""))
    .filter((v) => isPrerelease(current) || !isPrerelease(v));
  return candidates.sort(compareVersions).at(-1) ?? null;
}

/** How this particular jt was installed decides what "update" means. */
export function upgradeCommand(execPath: string): string {
  const cellar = /\/Cellar\/(jt(?:-rc)?)\//.exec(execPath);
  if (cellar) return `brew upgrade owenoclee/tap/${cellar[1]}`;
  if (/(^|\/)deno(\.exe)?$/.test(execPath)) return "git pull && deno task install";
  return `download it from https://github.com/${REPO}/releases`;
}

export function updateAdvice(current: string, latest: string, execPath: string): string {
  return [
    yellow(`jt ${latest} is available — you are running ${current}.`),
    dim(`  update: ${upgradeCommand(execPath)}`),
    dim(`  notes:  https://github.com/${REPO}/releases/tag/v${latest}`),
    dim("  jt never updates itself. Silence this notice with JT_NO_UPDATE_CHECK=1."),
  ].join("\n");
}

function readCache(path: string): Cache {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(path)) as Partial<Cache>;
    return {
      checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : 0,
      latest: typeof raw.latest === "string" ? raw.latest : null,
      notifiedAt: typeof raw.notifiedAt === "number" ? raw.notifiedAt : 0,
      notifiedFor: typeof raw.notifiedFor === "string" ? raw.notifiedFor : null,
    };
  } catch {
    return { checkedAt: 0, latest: null, notifiedAt: 0, notifiedFor: null };
  }
}

function writeCache(path: string, cache: Cache): void {
  try {
    Deno.mkdirSync(join(path, ".."), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify(cache) + "\n");
  } catch {
    // an unwritable cache only means the check repeats — never an error
  }
}

async function fetchReleaseList(signal: AbortSignal): Promise<ReleaseInfo[]> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    signal,
    headers: { "Accept": "application/vnd.github+json", "User-Agent": `jt/${VERSION}` },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`GitHub answered ${res.status}`);
  }
  return await res.json() as ReleaseInfo[];
}

/** Commands whose output is consumed by something other than a person or agent reading it. */
export const SILENT_COMMANDS = new Set(["_push-serve", "schema", "skill"]);
/** Commands that may show known advice but never go to the network for it. */
const OFFLINE_COMMANDS = new Set(["version", "--version", "help", "--help", "-h"]);

export function updateCheckEnabled(cmd: string | undefined): boolean {
  if (cmd !== undefined && SILENT_COMMANDS.has(cmd)) return false;
  if (Deno.env.get("JT_NO_UPDATE_CHECK") || Deno.env.get("CI")) return false;
  try {
    return loadSettings().updateCheck;
  } catch {
    return true; // a broken settings file is push's problem to report, not this notice's
  }
}

/**
 * Begin a check alongside the command; call the returned function once the command
 * has finished to print any advice. Neither half throws.
 */
export function startUpdateCheck(
  cmd: string | undefined,
  opts: UpdateCheckOptions = {},
): () => Promise<void> {
  const current = opts.current ?? VERSION;
  const path = opts.cachePath ?? updateCachePath();
  const now = opts.now ?? Date.now;
  const print = opts.print ?? ((line: string) => console.error(line));
  const cache = readCache(path);

  const offline = cmd === undefined || OFFLINE_COMMANDS.has(cmd);
  const controller = new AbortController();
  let refresh: Promise<void> | null = null;
  if (!offline && now() - cache.checkedAt >= DAY_MS) {
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    refresh = (opts.fetchReleases ?? fetchReleaseList)(controller.signal)
      .then((releases) => {
        cache.latest = pickLatest(releases, current);
        cache.checkedAt = now();
      })
      .catch(() => {
        // Offline or rate-limited: back off for the day rather than retrying on
        // every command, and keep whatever was known before.
        cache.checkedAt = now();
      })
      .finally(() => clearTimeout(timer));
  }

  return async () => {
    try {
      if (refresh) {
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<void>((r) => {
          graceTimer = setTimeout(r, opts.graceMs ?? GRACE_MS);
        });
        await Promise.race([refresh, grace]);
        clearTimeout(graceTimer);
        controller.abort(); // a check still in flight must not keep the process alive
        await refresh;
      }
      const { latest } = cache;
      const outdated = latest !== null && compareVersions(latest, current) > 0;
      const due = now() - cache.notifiedAt >= DAY_MS || cache.notifiedFor !== latest;
      if (outdated && (due || cmd === "version" || cmd === "--version")) {
        print(updateAdvice(current, latest, opts.execPath ?? Deno.execPath()));
        cache.notifiedAt = now();
        cache.notifiedFor = latest;
      }
      if (refresh || outdated) writeCache(path, cache);
    } catch {
      // advice is a courtesy; it never fails a command
    }
  };
}
