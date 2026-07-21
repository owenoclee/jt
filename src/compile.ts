/**
 * Compiles the committed layer against the base layer into an ordered list of exact
 * API operations. Reads ONLY tool-owned layers (committed + base + meta) — never the
 * working tree — so a push can only ever send what was reviewed and committed.
 *
 * Op order: creates (parents first) → field updates → link adds → unlinks →
 * transitions → comments → deletes.
 */
// deno-lint-ignore-file no-explicit-any
import { mdToAdf } from "./adf/md_to_adf.ts";
import { chunks } from "./batch.ts";
import { fieldEqual } from "./canonical.ts";
import { diffComments, diffTickets } from "./diff.ts";
import { fail } from "./errors.ts";
import type { JiraClient } from "./jira/client.ts";
import {
  checkStatusKnown,
  resolveFieldAlias,
  resolveIssueType,
  resolveLinkType,
  resolvePriority,
  resolveSprint,
} from "./resolve.ts";
import type { Store } from "./store.ts";
import type { CompiledOp, LinkEntry, Meta, MetaField, Ticket } from "./types.ts";

export interface CompileContext {
  store: Store;
  meta: Meta;
  client: JiraClient;
  /** Per-compile memo for assignee email -> accountId lookups. */
  accountIds?: Map<string, string>;
}

export interface CompiledPush {
  ops: CompiledOp[];
  /** Existing issue keys involved (for the staleness guard). */
  existingKeys: string[];
  warnings: string[];
}

export async function compilePush(ctx: CompileContext): Promise<CompiledPush> {
  const { store, meta } = ctx;
  ctx.accountIds ??= new Map();

  const conflicts = store.readConflicts();
  if (conflicts.length > 0) {
    fail(
      `unresolved conflicts on: ${conflicts.map((c) => c.key).join(", ")} — ` +
        `edit the working file to the desired final state, then run jt resolve <KEY>`,
    );
  }

  const committedIds = store.listCommittedIds();
  const deletions = store.readDeletions().filter((d) => d.committed);
  const createIds = committedIds.filter((id) => id.startsWith("@"));
  const updateKeys = committedIds.filter((id) => !id.startsWith("@"));

  if (createIds.length === 0 && updateKeys.length === 0 && deletions.length === 0) {
    fail("nothing committed to push — run jt commit first (jt status to see changes)");
  }

  const warnings: string[] = [];
  const ops: CompiledOp[] = [];
  const linkOps: CompiledOp[] = [];
  const unlinkOps: CompiledOp[] = [];
  const transitionOps: CompiledOp[] = [];
  const commentOps: CompiledOp[] = [];
  const seenLinks = new Set<string>();

  // ---- creates, parents before children ----
  const createTickets = new Map<string, Ticket>();
  for (const id of createIds) {
    const c = ctx.store.readCommitted(id);
    if (!c) continue;
    if (c.ticket.comments.some((cm) => cm.id)) {
      fail(`${id}: a new ticket cannot contain comments with ids`);
    }
    createTickets.set(id, c.ticket);
  }
  for (const id of orderCreates(createTickets)) {
    const t = createTickets.get(id)!;
    ops.push(await compileCreate(ctx, id, t, warnings));
    const followUp = compileCreateFollowUp(ctx, id, t);
    if (followUp) ops.push(followUp);
    for (const link of t.links) {
      pushLinkOp(ctx, linkOps, seenLinks, id, link, createTickets);
    }
    if (t.status) {
      checkStatusKnown(meta, t.status);
      transitionOps.push({
        label: `transition ${id} to '${t.status}'`,
        kind: "transition",
        issue: id,
        method: "POST",
        path: `/rest/api/3/issue/${id}/transitions`,
        transitionTo: t.status,
      });
    }
    for (const cm of t.comments) {
      commentOps.push({
        label: `comment on ${id}`,
        kind: "comment",
        issue: id,
        method: "POST",
        path: `/rest/api/3/issue/${id}/comment`,
        body: { body: mdToAdf(cm.body) },
        commentBody: cm.body,
      });
    }
  }

  // ---- updates ----
  // Transition targets need a per-issue GET (available transitions depend on the
  // issue's current status). Resolve them concurrently up front — sequential GETs
  // here stalled compile (and the review URL) on large changesets.
  const transitionIds = new Map<string, string>();
  {
    const targets: [string, string][] = [];
    for (const key of updateKeys) {
      const committed = store.readCommitted(key);
      const base = store.readBase(key);
      if (!committed?.ticket.status || !base) continue;
      if (!fieldEqual(base.ticket, committed.ticket, "status")) {
        targets.push([key, checkStatusKnown(meta, committed.ticket.status)]);
      }
    }
    for (const group of chunks(targets, 8)) {
      await Promise.all(group.map(async ([key, target]) => {
        transitionIds.set(key, await findTransitionId(ctx.client, key, target));
      }));
    }
  }

  for (const key of updateKeys) {
    const committed = store.readCommitted(key);
    const base = store.readBase(key);
    if (!committed) continue;
    if (!base) fail(`${key} is committed but has no base snapshot — run jt fetch ${key}`);

    const entries = diffTickets(base.ticket, committed.ticket);
    const commentDiff = diffComments(base.ticket.comments, committed.ticket.comments);
    if (commentDiff.editedExisting.length || commentDiff.removedExisting.length) {
      fail(
        `${key}: existing comments were edited or removed in the committed state — ` +
          `comments are append-only; revert them and re-commit`,
      );
    }
    if (!fieldEqual(base.ticket, committed.ticket, "project")) {
      fail(`${key}: changing 'project' (moving issues between projects) is not supported`);
    }

    const fields = await compileFieldUpdates(ctx, key, base.ticket, committed.ticket, warnings);
    if (Object.keys(fields).length > 0) {
      ops.push({
        label: `update ${key}`,
        kind: "update",
        issue: key,
        method: "PUT",
        path: `/rest/api/3/issue/${key}`,
        body: { fields },
      });
    }

    for (const e of entries) {
      if (e.kind === "links") {
        for (const link of e.added) pushLinkOp(ctx, linkOps, seenLinks, key, link, createTickets);
        for (const link of e.removed) {
          const linkId = base.raw.linkIds[`${link.type}|${link.to}`];
          if (!linkId) {
            fail(`${key}: cannot unlink '${link.type} ${link.to}' — link id unknown; run jt pull`);
          }
          unlinkOps.push({
            label: `unlink ${key} '${link.type} ${link.to}'`,
            kind: "unlink",
            issue: key,
            method: "DELETE",
            path: `/rest/api/3/issueLink/${linkId}`,
          });
        }
      }
    }

    const statusChanged = !fieldEqual(base.ticket, committed.ticket, "status");
    if (statusChanged && committed.ticket.status) {
      const target = checkStatusKnown(meta, committed.ticket.status);
      transitionOps.push({
        label: `transition ${key} to '${target}'`,
        kind: "transition",
        issue: key,
        method: "POST",
        path: `/rest/api/3/issue/${key}/transitions`,
        body: { transition: { id: transitionIds.get(key)! } },
        transitionTo: target,
      });
    }

    for (const cm of commentDiff.added) {
      commentOps.push({
        label: `comment on ${key}`,
        kind: "comment",
        issue: key,
        method: "POST",
        path: `/rest/api/3/issue/${key}/comment`,
        body: { body: mdToAdf(cm.body) },
        commentBody: cm.body,
      });
    }
  }

  // ---- deletes ----
  const deleteOps: CompiledOp[] = deletions.map((d) => ({
    label: `delete ${d.key} ("${d.summary}")`,
    kind: "delete",
    issue: d.key,
    method: "DELETE",
    path: `/rest/api/3/issue/${d.key}`,
  }));

  const all = [...ops, ...linkOps, ...unlinkOps, ...transitionOps, ...commentOps, ...deleteOps];
  const existingKeys = [
    ...new Set([
      ...updateKeys,
      ...deletions.map((d) => d.key),
    ]),
  ];
  return { ops: all, existingKeys, warnings };
}

function orderCreates(tickets: Map<string, Ticket>): string[] {
  const ids = [...tickets.keys()];
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.has(id)) fail(`circular parent references among new tickets involving ${id}`);
    visiting.add(id);
    const parent = tickets.get(id)!.parent;
    if (parent?.startsWith("@")) {
      if (!tickets.has(parent)) {
        fail(`${id}: parent '${parent}' is not a committed new ticket — commit it first`);
      }
      visit(parent);
    }
    visiting.delete(id);
    done.add(id);
    ordered.push(id);
  };
  for (const id of ids.sort()) visit(id);
  return ordered;
}

async function compileCreate(
  ctx: CompileContext,
  id: string,
  t: Ticket,
  warnings: string[],
): Promise<CompiledOp> {
  const { meta } = ctx;
  const fields: Record<string, unknown> = {
    project: { key: t.project },
    issuetype: { id: resolveIssueType(meta, t.type).id },
    summary: t.summary,
  };
  if (t.description !== null) fields.description = mdToAdf(t.description);
  if (t.labels.length) fields.labels = [...t.labels].sort();
  if (t.priority !== null) fields.priority = { id: resolvePriority(meta, t.priority).id };
  if (t.assignee !== null) fields.assignee = { accountId: await resolveAccountId(ctx, t.assignee) };
  if (t.parent !== null && !t.parent.startsWith("@")) fields.parent = { key: t.parent };
  if (t.parent?.startsWith("@")) {
    // Placeholder; resolved to the created key at execution time.
    fields.parent = { key: t.parent };
  }
  if (t.descriptionLossy) {
    warnings.push(`${id}: descriptionLossy is set on a new ticket — flag ignored`);
  }
  return {
    label: `create ${id} ("${t.summary}")`,
    kind: "create",
    refId: id,
    issue: id,
    method: "POST",
    path: "/rest/api/3/issue",
    body: { fields },
  };
}

/** Sprint + custom fields go in a follow-up PUT: they are often not on the create screen. */
function compileCreateFollowUp(ctx: CompileContext, id: string, t: Ticket): CompiledOp | null {
  const fields: Record<string, unknown> = {};
  if (t.sprint !== null) {
    if (!ctx.meta.sprintFieldId) fail(`${id}: sprint set but no sprint field found — jt meta sync`);
    fields[ctx.meta.sprintFieldId] = resolveSprint(ctx.meta, t.sprint).id;
  }
  for (const [alias, value] of Object.entries(t.fields)) {
    if (value === null) continue;
    const fm = resolveFieldAlias(ctx.meta, alias);
    fields[fm.id] = compileCustomValue(fm, value, alias);
  }
  if (Object.keys(fields).length === 0) return null;
  return {
    label: `set sprint/custom fields on ${id}`,
    kind: "update",
    issue: id,
    method: "PUT",
    path: `/rest/api/3/issue/${id}`,
    body: { fields },
  };
}

async function compileFieldUpdates(
  ctx: CompileContext,
  key: string,
  base: Ticket,
  committed: Ticket,
  warnings: string[],
): Promise<Record<string, unknown>> {
  const { meta } = ctx;
  const fields: Record<string, unknown> = {};

  if (!fieldEqual(base, committed, "type")) {
    fields.issuetype = { id: resolveIssueType(meta, committed.type).id };
  }
  if (!fieldEqual(base, committed, "summary")) fields.summary = committed.summary;
  if (!fieldEqual(base, committed, "description")) {
    if (base.descriptionLossy) {
      warnings.push(
        `${key}: base description contains content outside the markdown subset — ` +
          `pushing replaces the whole description and that content will be lost`,
      );
    }
    fields.description = committed.description === null ? null : mdToAdf(committed.description);
  }
  if (!fieldEqual(base, committed, "labels")) fields.labels = [...committed.labels].sort();
  if (!fieldEqual(base, committed, "parent")) {
    if (committed.parent?.startsWith("@")) {
      fail(`${key}: parent '${committed.parent}' — existing tickets cannot reference pending creations yet (push the creation first)`);
    }
    fields.parent = committed.parent === null ? null : { key: committed.parent };
  }
  if (!fieldEqual(base, committed, "priority")) {
    fields.priority = committed.priority === null
      ? null
      : { id: resolvePriority(meta, committed.priority).id };
  }
  if (!fieldEqual(base, committed, "assignee")) {
    fields.assignee = committed.assignee === null
      ? null
      : { accountId: await resolveAccountId(ctx, committed.assignee) };
  }
  if (!fieldEqual(base, committed, "sprint")) {
    if (!meta.sprintFieldId) fail(`${key}: sprint changed but no sprint field found — jt meta sync`);
    fields[meta.sprintFieldId] = committed.sprint === null
      ? null
      : resolveSprint(meta, committed.sprint).id;
  }
  for (const alias of new Set([...Object.keys(base.fields), ...Object.keys(committed.fields)])) {
    if (fieldEqual(base, committed, `fields.${alias}`)) continue;
    const fm = resolveFieldAlias(meta, alias);
    const value = committed.fields[alias] ?? null;
    fields[fm.id] = value === null ? null : compileCustomValue(fm, value, alias);
  }
  return fields;
}

function compileCustomValue(fm: MetaField, value: unknown, alias: string): unknown {
  if (fm.schemaType === "option") {
    if (typeof value !== "string") fail(`field '${alias}': option fields take a string value`);
    return { value };
  }
  if (fm.schemaType === "array" && fm.schemaItems === "option") {
    if (!Array.isArray(value)) fail(`field '${alias}': expected an array of option strings`);
    return value.map((v) => ({ value: v }));
  }
  if (fm.schemaType === "number") {
    if (typeof value !== "number") fail(`field '${alias}': expected a number`);
    return value;
  }
  if (fm.schemaType === "user" || (fm.schemaType === "array" && fm.schemaItems === "user")) {
    fail(`field '${alias}': user-type custom fields are not supported yet`);
  }
  return value;
}

function pushLinkOp(
  ctx: CompileContext,
  linkOps: CompiledOp[],
  seen: Set<string>,
  issue: string,
  link: LinkEntry,
  creates: Map<string, Ticket>,
): void {
  if (link.to.startsWith("@") && !creates.has(link.to)) {
    fail(`${issue}: link target '${link.to}' is not a committed new ticket`);
  }
  const lt = resolveLinkType(ctx.meta, link.type);
  // "A blocks B" (outward phrase on A) is stored as {inwardIssue: A, outwardIssue: B}:
  // outwardIssue is the target of the outward phrase. Verified against a live instance.
  const [inward, outward] = lt.direction === "outward" ? [issue, link.to] : [link.to, issue];
  const canonical = `${lt.id}|${inward}|${outward}`;
  if (seen.has(canonical)) return; // same link staged from both sides
  seen.add(canonical);
  linkOps.push({
    label: `link: ${issue} ${link.type} ${link.to}`,
    kind: "link",
    issue,
    method: "POST",
    path: "/rest/api/3/issueLink",
    body: {
      type: { name: lt.name },
      inwardIssue: { key: inward },
      outwardIssue: { key: outward },
    },
  });
}

async function resolveAccountId(ctx: CompileContext, assignee: string): Promise<string> {
  if (assignee.startsWith("accountId:")) return assignee.slice("accountId:".length);
  const cached = ctx.accountIds?.get(assignee);
  if (cached) return cached;
  const users = (await ctx.client.get("/rest/api/3/user/search", { query: assignee })) as any[];
  const exact = users.filter(
    (u) => u.emailAddress && u.emailAddress.toLowerCase() === assignee.toLowerCase(),
  );
  if (exact.length === 1) {
    ctx.accountIds?.set(assignee, exact[0].accountId);
    return exact[0].accountId;
  }
  if (exact.length > 1) fail(`assignee '${assignee}' matches multiple users`);
  fail(
    `assignee '${assignee}' not found by email (the address may be private) — ` +
      `use "accountId:<id>" instead`,
  );
}

async function findTransitionId(client: JiraClient, key: string, target: string): Promise<string> {
  const res = (await client.get(`/rest/api/3/issue/${key}/transitions`)) as any;
  const transitions: any[] = res.transitions ?? [];
  const match = transitions.find(
    (t) => t.to?.name && t.to.name.toLowerCase() === target.toLowerCase(),
  );
  if (!match) {
    const available = transitions.map((t) => t.to?.name).filter(Boolean).join(", ");
    fail(
      `${key}: no direct transition to '${target}' from the current status. ` +
        `Reachable: ${available || "(none)"}`,
    );
  }
  return String(match.id);
}
