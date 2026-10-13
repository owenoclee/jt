/** The jt version. Release tags must match it exactly (see docs/releasing.md). */
export const VERSION = "0.5.0";

/** Where releases are published — and where the update check looks. */
export const REPO = "owenoclee/jt";

export interface ParsedVersion {
  core: [number, number, number];
  /** Pre-release identifiers ("rc", 1) — empty for a stable release. */
  pre: (string | number)[];
}

/** Parses "1.2.3" and "1.2.3-rc.1" (a leading "v" is tolerated); null if it is neither. */
export function parseVersion(text: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

export function isPrerelease(version: string): boolean {
  return (parseVersion(version)?.pre.length ?? 0) > 0;
}

/**
 * Semver precedence: negative when a < b. A pre-release sorts before the release it
 * leads up to (0.6.0-rc.2 < 0.6.0), and numerically within itself (rc.2 < rc.10).
 * Unparseable versions compare equal — never grounds for telling anyone to upgrade.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
