/**
 * Canonical serialization and comparison of ticket files.
 *
 * Every layer stores tickets via `serializeTicket`, so identical state means identical
 * bytes. Comparison normalizes ordering (labels, links, fields keys) so cosmetic
 * reordering by the agent never reads as a change.
 */
import type { CommentEntry, LinkEntry, Ticket } from "./types.ts";
import { compareTicketIds } from "./keys.ts";

const KEY_ORDER: (keyof Ticket)[] = [
  "key",
  "updated",
  "project",
  "type",
  "summary",
  "status",
  "description",
  "descriptionLossy",
  "labels",
  "parent",
  "sprint",
  "assignee",
  "priority",
  "links",
  "comments",
  "fields",
];

const COMMENT_KEY_ORDER: (keyof CommentEntry)[] = ["id", "author", "created", "body"];

export function normalizeTicket(t: Ticket): Ticket {
  const links = [...t.links].sort(compareLinks);
  const fields: Record<string, unknown> = {};
  for (const k of Object.keys(t.fields).sort()) fields[k] = t.fields[k];
  const out: Ticket = {
    ...t,
    labels: [...t.labels].sort(),
    links,
    comments: t.comments.map((c) => ({ ...c })),
    fields,
  };
  if (out.descriptionLossy === false || out.descriptionLossy === undefined) {
    delete out.descriptionLossy;
  }
  if (out.key === undefined) delete out.key;
  if (out.updated === undefined) delete out.updated;
  if (out.status === undefined) delete out.status;
  return out;
}

function compareLinks(a: LinkEntry, b: LinkEntry): number {
  return a.type.localeCompare(b.type) || compareTicketIds(a.to, b.to);
}

/** Stable, fixed-key-order JSON with trailing newline. */
export function serializeTicket(t: Ticket): string {
  const n = normalizeTicket(t);
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    if (n[k] !== undefined) {
      ordered[k] = k === "comments" ? n.comments.map(orderComment) : n[k];
    }
  }
  return JSON.stringify(ordered, null, 2) + "\n";
}

function orderComment(c: CommentEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of COMMENT_KEY_ORDER) if (c[k] !== undefined) out[k] = c[k];
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined).sort();
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => k === bk[i] && deepEqual(ao[k], bo[k]));
}

/** Field-level equality of tickets, ignoring ordering and the informational fields. */
export function ticketsEqual(a: Ticket, b: Ticket): boolean {
  return serializeForCompare(a) === serializeForCompare(b);
}

function serializeForCompare(t: Ticket): string {
  const n = normalizeTicket(t);
  delete n.descriptionLossy;
  delete n.updated;
  return serializeTicket(n);
}

/**
 * The set of diffable top-level field names, with custom fields expanded as
 * "fields.<alias>". Informational fields (`descriptionLossy`, `updated`) are excluded,
 * which is what keeps them out of diffs, merges, conflicts, and compiled pushes.
 */
export function ticketFieldNames(...tickets: Ticket[]): string[] {
  const names = new Set<string>([
    "project",
    "type",
    "summary",
    "status",
    "description",
    "labels",
    "parent",
    "sprint",
    "assignee",
    "priority",
    "links",
    "comments",
  ]);
  for (const t of tickets) for (const k of Object.keys(t.fields)) names.add(`fields.${k}`);
  return [...names];
}

export function getField(t: Ticket, name: string): unknown {
  if (name.startsWith("fields.")) return t.fields[name.slice("fields.".length)];
  return (t as unknown as Record<string, unknown>)[name];
}

export function setField(t: Ticket, name: string, value: unknown): void {
  if (name.startsWith("fields.")) {
    const alias = name.slice("fields.".length);
    if (value === undefined) delete t.fields[alias];
    else t.fields[alias] = value;
    return;
  }
  const rec = t as unknown as Record<string, unknown>;
  if (value === undefined) delete rec[name];
  else rec[name] = value;
}

/** Equality for a single named field between two tickets (order-insensitive). */
export function fieldEqual(a: Ticket, b: Ticket, name: string): boolean {
  const na = normalizeTicket(a);
  const nb = normalizeTicket(b);
  return deepEqual(getField(na, name), getField(nb, name));
}
