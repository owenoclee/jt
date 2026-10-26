/**
 * Compiles the committed layer against the base layer into an ordered list of exact
 * API operations. Reads ONLY tool-owned layers (committed + base + meta) — never the
 * working tree — so a push can only ever send what was reviewed and committed.
 *
 * Op order: creates (parents first) → field updates → link adds → unlinks →
 * transitions → comments → whole-issue intents (delete / archive / unarchive).
 */
// deno-lint-ignore-file no-explicit-any
import { mdToAdf } from "./adf/md_to_adf.ts";
import { chunks } from "./batch.ts";
import { fieldEqual } from "./canonical.ts";
import { diffComments, diffTickets } from "./diff.ts";
import { intentOp } from "./intents.ts";
import { fail } from "./errors.ts";
import { JiraApiError, type JiraClient } from "./jira/client.ts";
import { DEFAULT_PROPOSAL, proposalFlag } from "./proposal.ts";
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

  const committedIds = store.listCommittedIds();
  const intents = store.readIntents().filter((i) => i.committed);
  const createIds = committedIds.filter((id) => id.startsWith("@"));
  const updateKeys = committedIds.filter((id) => !id.startsWith("@"));

  // Conflicts block the tickets they are on. A conflict on a ticket outside this
  // changeset — another agent's, in another proposal or not staged at all — is not
  // this push's to resolve, and must not hold it up.
  const staged = new Set([...updateKeys, ...intents.map((i) => i.key)]);
  const conflicts = store.readConflicts().filter((c) => staged.has(c.key));
  if (conflicts.length > 0) {
    fail(
      `unresolved conflicts on: ${conflicts.map((c) => c.key).join(", ")} — ` +
        `edit the working file to the desired final state, then run jt resolve <KEY>`,
    );
  }

  if (createIds.length === 0 && updateKeys.length === 0 && intents.length === 0) {
    const flag = proposalFlag(store.proposal);
    const here = store.proposal === DEFAULT_PROPOSAL ? "" : ` in proposal '${store.proposal}'`;
    const elsewhere = store.listProposals().filter((name) => {
      if (name === store.proposal) return false;
      const s = store.scoped(name);
      return s.listCommittedIds().length > 0 || s.readIntents().some((i) => i.committed);
    });
    fail(
      `nothing committed to push${here} — run jt commit${flag} first (jt status to see changes)` +
        (elsewhere.length
          ? `\n  staged in other proposals: ${elsewhere.join(", ")} — push one with jt push -p <name>`
          : ""),
    );
  }

  const warnings: string[] = [];
  const ops: CompiledOp[] = [];
  const linkOps: CompiledOp[] = [];
  const unlinkOps: CompiledOp[] = [];
  const transitionOps: CompiledOp[] = [];
  const commentOps: CompiledOp[] = [];
  const seenLinks = new Set<string>();
  const seenUnlinks = new Set<string>();

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
        body: { body: mdToAdf(cm.body, "comment") },
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

  // A custom field that is not on an issue's edit screen fails that issue's whole PUT
  // with a 400 ("cannot be set. It is not on the appropriate screen, or unknown") —
  // mid-push, after earlier ops have landed. Ask Jira's editmeta first, and refuse
  // here instead, before anything is sent.
  {
    const targets: [string, Ticket, string[]][] = [];
    for (const key of updateKeys) {
      const committed = store.readCommitted(key);
      const base = store.readBase(key);
      if (!committed || !base) continue;
      const aliases = changedCustomFields(base.ticket, committed.ticket);
      if (aliases.length) targets.push([key, committed.ticket, aliases]);
    }
    const refused = new Map<string, string[]>();
    for (const group of chunks(targets, 8)) {
      await Promise.all(group.map(async ([key, , aliases]) => {
        const editable = await editableFieldIds(ctx.client, key);
        if (!editable) return; // Jira gave no answer; the push itself will find out
        const off = aliases.filter((a) => !editable.has(resolveFieldAlias(meta, a).id));
        if (off.length) refused.set(key, off);
      }));
    }
    if (refused.size > 0) {
      const lines = targets
        .filter(([key]) => refused.has(key))
        .map(([key, t]) => {
          const names = refused.get(key)!.map((a) => `'${a}'`).join(", ");
          return `  - ${key} (${t.type}): ${names}`;
        });
      fail(
        `Jira will not let these fields be set — they are not on the issue's edit screen, ` +
          `usually because the field does not apply to that issue type:\n${lines.join("\n")}\n` +
          `Nothing was sent. Put each field back to its base value in the working file ` +
          `(jt show KEY --base), jt commit KEY, then push again. Adding the field to that ` +
          `screen is a Jira configuration change: the user's call, not the agent's.`,
      );
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

    const fields = await compileFieldUpdates(
      ctx,
      key,
      base.ticket,
      committed.ticket,
      createTickets,
      warnings,
    );
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
          // Removed from both ends is still one link: Jira deletes it once, by id.
          if (seenUnlinks.has(linkId)) continue;
          seenUnlinks.add(linkId);
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
        body: { body: mdToAdf(cm.body, "comment") },
        commentBody: cm.body,
      });
    }
  }

  // ---- whole-issue intents (delete / archive / unarchive) ----
  const intentOps: CompiledOp[] = intents.map(intentOp);

  const all = [...ops, ...linkOps, ...unlinkOps, ...transitionOps, ...commentOps, ...intentOps];
  const existingKeys = [
    ...new Set([
      ...updateKeys,
      ...intents.map((i) => i.key),
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
  if (t.description !== null) fields.description = mdToAdf(t.description, "description");
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
  creates: Map<string, Ticket>,
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
    fields.description = committed.description === null
      ? null
      : mdToAdf(committed.description, "description");
  }
  if (!fieldEqual(base, committed, "labels")) fields.labels = [...committed.labels].sort();
  if (!fieldEqual(base, committed, "parent")) {
    if (committed.parent?.startsWith("@") && !creates.has(committed.parent)) {
      fail(`${key}: parent '${committed.parent}' is not a committed new ticket — commit it first`);
    }
    // An @ref parent stays a placeholder here; creates run first and the ref
    // resolves to the created key at execution time.
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
  for (const alias of changedCustomFields(base, committed)) {
    const fm = resolveFieldAlias(meta, alias);
    const value = committed.fields[alias] ?? null;
    fields[fm.id] = value === null ? null : compileCustomValue(fm, value, alias);
  }
  return fields;
}

/** Aliases of the custom fields whose value `committed` changes from `base`. */
function changedCustomFields(base: Ticket, committed: Ticket): string[] {
  return [...new Set([...Object.keys(base.fields), ...Object.keys(committed.fields)])]
    .filter((alias) => !fieldEqual(base, committed, `fields.${alias}`));
}

/**
 * The field ids `key`'s edit screen lets this user set, per Jira's editmeta — or null
 * when Jira gives no usable answer: an error, or no fields at all (what a user without
 * edit permission sees). Null means unknown, never "nothing is editable".
 */
async function editableFieldIds(client: JiraClient, key: string): Promise<Set<string> | null> {
  try {
    const res = (await client.get(`/rest/api/3/issue/${key}/editmeta`)) as any;
    const ids = Object.keys(res?.fields ?? {});
    return ids.length > 0 ? new Set(ids) : null;
  } catch (e) {
    if (e instanceof JiraApiError && !e.authRejected) return null;
    throw e;
  }
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
  if (fm.schemaType === "array" && fm.schemaItems === "component") {
    if (!Array.isArray(value)) fail(`field '${alias}': expected an array of component names`);
    return value.map((v) => ({ name: v }));
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
  // A symmetric type ("relates to" both ways) reads the same from either end, so
  // A's "relates to B" and B's "relates to A" are one link — but sent as two POSTs,
  // Jira would store A→B and B→A as two. Key those by the unordered pair.
  const symmetric = lt.inward.toLowerCase() === lt.outward.toLowerCase();
  const canonical = symmetric
    ? `${lt.id}|${[inward, outward].sort().join("|")}`
    : `${lt.id}|${inward}|${outward}`;
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
