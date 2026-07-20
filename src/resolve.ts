/**
 * Alias resolution against the on-disk meta map (.jira/meta.json). Resolution never
 * guesses: exact-or-unique case-insensitive matches only, ambiguity is a hard error,
 * and a missing alias tells the user to re-sync.
 */
import { join } from "@std/path";
import { fail } from "./errors.ts";
import type { Meta, MetaField } from "./types.ts";

export function metaPath(jiraDir: string): string {
  return join(jiraDir, "meta.json");
}

export function loadMeta(jiraDir: string): Meta {
  try {
    return JSON.parse(Deno.readTextFileSync(metaPath(jiraDir))) as Meta;
  } catch {
    fail("no .jira/meta.json — run: jt meta sync");
  }
}

export function saveMeta(jiraDir: string, meta: Meta): void {
  Deno.writeTextFileSync(metaPath(jiraDir), JSON.stringify(meta, null, 2) + "\n");
}

function uniqueMatch<T>(
  candidates: T[],
  label: (t: T) => string,
  query: string,
  kind: string,
  hint?: string,
): T {
  const exact = candidates.filter((c) => label(c) === query);
  if (exact.length === 1) return exact[0];
  const ci = candidates.filter((c) => label(c).toLowerCase() === query.toLowerCase());
  if (ci.length === 1) return ci[0];
  if (ci.length > 1) {
    fail(`${kind} '${query}' is ambiguous: matches ${ci.map(label).join(", ")}`);
  }
  const known = candidates.map(label).sort();
  fail(
    `unknown ${kind} '${query}'.${hint ? ` ${hint}` : ""} Known: ${known.join(", ") || "(none)"}`,
  );
}

export function resolveFieldAlias(meta: Meta, alias: string): MetaField {
  if (/^customfield_\d+$/.test(alias)) {
    const byId = meta.fields.find((f) => f.id === alias);
    if (byId) return byId;
    fail(`unknown field id '${alias}' — run: jt meta sync`);
  }
  return uniqueMatch(meta.fields, (f) => f.name, alias, "field", "Run `jt meta sync` if new.");
}

export function resolveIssueType(meta: Meta, name: string): { id: string; name: string } {
  return uniqueMatch(meta.issueTypes, (t) => t.name, name, "issue type");
}

export interface ResolvedLinkType {
  id: string;
  name: string;
  /** Whether the file's phrase is this type's outward or inward description. */
  direction: "outward" | "inward";
  outward: string;
  inward: string;
}

export function resolveLinkType(meta: Meta, phrase: string): ResolvedLinkType {
  const matches: ResolvedLinkType[] = [];
  for (const lt of meta.linkTypes) {
    if (lt.outward.toLowerCase() === phrase.toLowerCase()) {
      matches.push({ id: lt.id, name: lt.name, direction: "outward", outward: lt.outward, inward: lt.inward });
    }
    if (lt.inward.toLowerCase() === phrase.toLowerCase()) {
      matches.push({ id: lt.id, name: lt.name, direction: "inward", outward: lt.outward, inward: lt.inward });
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // Symmetric link types (e.g. Relates) use the same phrase for both directions —
    // that's one type matched twice, not ambiguity. Prefer the outward form.
    const ids = new Set(matches.map((m) => m.id));
    if (ids.size === 1) return matches.find((m) => m.direction === "outward") ?? matches[0];
    fail(`link phrase '${phrase}' is ambiguous across link types`);
  }
  const known = meta.linkTypes.flatMap((lt) => [lt.outward, lt.inward]).sort();
  fail(`unknown link phrase '${phrase}'. Known: ${known.join(", ") || "(none)"}`);
}

export function resolveSprint(meta: Meta, sprint: string | number): { id: number; name: string } {
  if (typeof sprint === "number") {
    const byId = meta.sprints.find((s) => s.id === sprint);
    return byId ?? { id: sprint, name: `sprint ${sprint}` };
  }
  const m = uniqueMatch(
    meta.sprints,
    (s) => s.name,
    sprint,
    "sprint",
    "Only active/future sprints of the configured board are known; run `jt meta sync` to refresh.",
  );
  return { id: m.id, name: m.name };
}

export function resolvePriority(meta: Meta, name: string): { id: string; name: string } {
  return uniqueMatch(meta.priorities, (p) => p.name, name, "priority");
}

export function checkStatusKnown(meta: Meta, name: string): string {
  const match = meta.statuses.find((s) => s.toLowerCase() === name.toLowerCase());
  if (!match) {
    fail(`unknown status '${name}'. Known: ${[...meta.statuses].sort().join(", ")}`);
  }
  return match;
}
