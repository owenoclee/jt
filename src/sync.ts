/**
 * Fetching remote issues into canonical BaseEntry form, and integrating fetched
 * state into the workspace layers (3-way rebase; conflicts on overlapping edits).
 */
// deno-lint-ignore-file no-explicit-any
import { adfToMd } from "./adf/adf_to_md.ts";
import {
  fieldEqual,
  getField,
  serializeTicket,
  setField,
  ticketFieldNames,
  ticketsEqual,
} from "./canonical.ts";
import type { JiraClient } from "./jira/client.ts";
import { resolveFieldAlias } from "./resolve.ts";
import type { Store } from "./store.ts";
import type { BaseEntry, CommentEntry, Config, ConflictRecord, Meta, Ticket } from "./types.ts";

const BUILTIN_FETCH_FIELDS = [
  "summary",
  "description",
  "status",
  "labels",
  "parent",
  "priority",
  "assignee",
  "updated",
  "issuetype",
  "project",
  "comment",
  "issuelinks",
];

export async function fetchBaseEntry(
  client: JiraClient,
  meta: Meta,
  config: Config,
  key: string,
): Promise<BaseEntry> {
  const customIds = config.customFields.map((alias) => resolveFieldAlias(meta, alias));
  const fieldList = [
    ...BUILTIN_FETCH_FIELDS,
    ...(meta.sprintFieldId ? [meta.sprintFieldId] : []),
    ...customIds.map((f) => f.id),
  ];
  const issue = (await client.get(`/rest/api/3/issue/${key}`, {
    fields: fieldList.join(","),
  })) as any;
  return issueToBaseEntry(issue, meta, config);
}

export function issueToBaseEntry(issue: any, meta: Meta, config: Config): BaseEntry {
  const f = issue.fields ?? {};
  const { md, lossy } = adfToMd(f.description);

  // Sprint: the field holds every sprint the issue was ever in; current = last non-closed.
  let sprintId: number | null = null;
  let sprintName: string | null = null;
  if (meta.sprintFieldId && Array.isArray(f[meta.sprintFieldId])) {
    const open = f[meta.sprintFieldId].filter((s: any) => s && s.state !== "closed");
    const current = open[open.length - 1];
    if (current) {
      sprintId = Number(current.id);
      sprintName = current.name ?? null;
    }
  }

  // Links, relative to this issue: outwardIssue present => this issue --outward--> other.
  const links: Ticket["links"] = [];
  const linkIds: Record<string, string> = {};
  for (const l of f.issuelinks ?? []) {
    const other = l.outwardIssue ?? l.inwardIssue;
    if (!other) continue;
    const phrase = l.outwardIssue ? l.type?.outward : l.type?.inward;
    const entry = { type: phrase as string, to: other.key as string };
    links.push(entry);
    if (l.id) linkIds[`${entry.type}|${entry.to}`] = String(l.id);
  }

  const comments: CommentEntry[] = (f.comment?.comments ?? []).map((c: any) => ({
    id: String(c.id),
    author: c.author?.displayName ?? undefined,
    created: c.created ?? undefined,
    body: adfToMd(c.body).md,
  }));

  const fields: Record<string, unknown> = {};
  for (const alias of config.customFields) {
    const fm = resolveFieldAlias(meta, alias);
    fields[alias] = canonicalizeCustomValue(fm, f[fm.id]);
  }

  const assignee = f.assignee
    ? (f.assignee.emailAddress || `accountId:${f.assignee.accountId}`)
    : null;

  const ticket: Ticket = {
    key: issue.key,
    project: f.project?.key ?? config.project,
    type: f.issuetype?.name ?? "Task",
    summary: f.summary ?? "",
    status: f.status?.name,
    description: f.description ? md : null,
    ...(lossy ? { descriptionLossy: true } : {}),
    labels: [...(f.labels ?? [])].sort(),
    parent: f.parent?.key ?? null,
    sprint: sprintName ?? sprintId,
    assignee,
    priority: f.priority?.name ?? null,
    links,
    comments,
    fields,
  };

  return {
    key: issue.key,
    fetchedAt: new Date().toISOString(),
    updated: f.updated ?? "",
    ticket,
    raw: {
      descriptionAdf: f.description ?? null,
      sprintId,
      assigneeAccountId: f.assignee?.accountId ?? null,
      statusId: f.status?.id ? String(f.status.id) : null,
      linkIds,
    },
  };
}

function canonicalizeCustomValue(
  fm: { schemaType?: string; schemaItems?: string },
  value: any,
): unknown {
  if (value === null || value === undefined) return null;
  if (fm.schemaType === "option") return value.value ?? null;
  if (fm.schemaType === "array" && fm.schemaItems === "option") {
    return (value as any[]).map((v) => v.value);
  }
  if (fm.schemaType === "user") {
    return value.emailAddress || `accountId:${value.accountId}`;
  }
  if (fm.schemaType === "array" && fm.schemaItems === "user") {
    return (value as any[]).map((v) => v.emailAddress || `accountId:${v.accountId}`);
  }
  return value;
}

export type IntegrateResult =
  | { kind: "created" } // first fetch, working file materialized
  | { kind: "refreshed" } // no local changes, all layers refreshed
  | { kind: "rebased"; fields: string[] } // local changes preserved, remote changes merged
  | { kind: "kept" } // base seeded/advanced; existing working file left untouched
  | { kind: "conflict"; fields: string[] };

/**
 * Integrate a freshly fetched BaseEntry into the layers.
 *
 * 3-way semantics: remote changes to fields the user didn't touch flow into working
 * (and committed) copies; overlapping edits become a conflict record and nothing moves.
 * Comments merge structurally (remote comments + local id-less additions) — append-only
 * data can't conflict.
 */
export function integrateFetched(store: Store, fresh: BaseEntry): IntegrateResult {
  const key = fresh.key;
  const old = store.readBase(key);
  const working = store.readWorking(key);
  const committed = store.readCommitted(key);

  if (!old) {
    store.writeBase(fresh);
    if (!working) {
      store.writeWorking(key, fresh.ticket);
      return { kind: "created" };
    }
    // A working file existed before any base (hand-crafted): leave it; status will show drift.
    return { kind: "kept" };
  }

  const names = ticketFieldNames(old.ticket, fresh.ticket, working?.ticket ?? fresh.ticket);
  const remoteChanged = names.filter(
    (n) => n !== "comments" && !fieldEqual(old.ticket, fresh.ticket, n),
  );
  const localChanged = names.filter((n) => {
    if (n === "comments") return false;
    const w = working && !fieldEqual(old.ticket, working.ticket, n);
    const c = committed && !fieldEqual(old.ticket, committed.ticket, n);
    return Boolean(w || c);
  });

  // Overlap that actually disagrees (both sides changing to the same value is fine).
  const conflicting = remoteChanged.filter((n) => {
    if (!localChanged.includes(n)) return false;
    const local = working ?? committed;
    return local ? !fieldEqual(local.ticket, fresh.ticket, n) : false;
  });

  if (conflicting.length > 0) {
    const local = working ?? committed;
    const conflicts = store.readConflicts().filter((c) => c.key !== key);
    const record: ConflictRecord = {
      key,
      fields: conflicting,
      detectedAt: new Date().toISOString(),
      remote: Object.fromEntries(conflicting.map((n) => [n, getField(fresh.ticket, n)])),
      local: Object.fromEntries(conflicting.map((n) => [n, getField(local!.ticket, n)])),
    };
    store.writeConflicts([...conflicts, record]);
    return { kind: "conflict", fields: conflicting };
  }

  store.writeBase(fresh);

  if (!working && !committed) return { kind: "kept" };

  if (localChanged.length === 0 && !hasLocalNewComments(working, committed)) {
    // Nothing local: refresh everything to canonical fetched state.
    if (working) store.writeWorking(key, fresh.ticket);
    if (committed) store.removeCommitted(key);
    return { kind: "refreshed" };
  }

  // Rebase: remote-changed fields flow in where not locally edited; comments merge.
  const rebase = (t: Ticket): Ticket => {
    const out = structuredClone(t);
    for (const n of remoteChanged) {
      const locallyEdited = !fieldEqual(old.ticket, t, n);
      if (!locallyEdited) setField(out, n, getField(fresh.ticket, n));
    }
    out.comments = mergeComments(fresh.ticket.comments, t.comments);
    if (fresh.ticket.descriptionLossy) out.descriptionLossy = true;
    return out;
  };

  if (working) store.writeWorking(key, rebase(working.ticket));
  if (committed) {
    const rebased = rebase(committed.ticket);
    if (ticketsEqual(rebased, fresh.ticket)) store.removeCommitted(key);
    else store.writeCommitted(key, serializeTicket(rebased));
  }
  return { kind: "rebased", fields: remoteChanged };
}

function hasLocalNewComments(
  working: { ticket: Ticket } | null,
  committed: { ticket: Ticket } | null,
): boolean {
  return Boolean(
    working?.ticket.comments.some((c) => !c.id) || committed?.ticket.comments.some((c) => !c.id),
  );
}

function mergeComments(remote: CommentEntry[], local: CommentEntry[]): CommentEntry[] {
  const localNew = local.filter((c) => !c.id);
  return [...remote, ...localNew];
}
