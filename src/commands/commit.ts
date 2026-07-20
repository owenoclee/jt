/**
 * jt commit: byte-copy approved working files into the tool-owned committed layer.
 * Validates aliases against meta and the markdown subset up front, so bad state is
 * rejected at commit time instead of failing mid-push.
 */
import { ticketsEqual } from "../canonical.ts";
import { localContext, withMeta } from "../context.ts";
import { diffComments } from "../diff.ts";
import { fail, UserError } from "../errors.ts";
import { mdToAdf } from "../adf/md_to_adf.ts";
import { bold, dim, green } from "../render/colors.ts";
import {
  checkStatusKnown,
  resolveFieldAlias,
  resolveIssueType,
  resolveLinkType,
  resolvePriority,
  resolveSprint,
} from "../resolve.ts";
import type { Store } from "../store.ts";
import type { Meta, Ticket } from "../types.ts";

export function cmdCommit(argv: string[]): void {
  const ctx = withMeta(localContext());
  const { store, meta } = ctx;
  const filter = argv.map((a) => (a.startsWith("@") ? a : a.toUpperCase()));
  const statuses = store.status();
  const committable = statuses.filter((s) =>
    ["modified", "new", "committed+modified", "new+committed+modified", "deleted"].includes(s.state)
  );
  const targets = filter.length
    ? committable.filter((s) => filter.includes(s.id))
    : committable;

  if (filter.length) {
    for (const f of filter) {
      if (!statuses.some((s) => s.id === f)) fail(`${f} is not tracked`);
      if (!committable.some((s) => s.id === f)) {
        const st = statuses.find((s) => s.id === f)!;
        console.log(`${f}: nothing to commit (${st.state})`);
      }
    }
  }
  if (targets.length === 0) {
    console.log("nothing to commit");
    return;
  }

  const committed: string[] = [];
  for (const s of targets) {
    if (s.state === "deleted") {
      const deletions = store.readDeletions();
      const d = deletions.find((x) => x.key === s.id);
      if (d) {
        d.committed = true;
        store.writeDeletions(deletions);
        committed.push(`${s.id} (deletion)`);
      }
      continue;
    }
    const working = store.readWorking(s.id);
    if (!working) continue;
    validateForCommit(store, meta, s.id, working.ticket);
    store.writeCommitted(s.id, working.bytes);
    committed.push(s.id);
  }

  console.log(`${green("committed:")} ${committed.map(bold).join(", ")}`);
  console.log(dim("review what push will send: jt diff --committed · then: jt push"));
}

function validateForCommit(store: Store, meta: Meta, id: string, t: Ticket): void {
  const problems: string[] = [];
  const check = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof UserError) problems.push(e.message);
      else throw e;
    }
  };

  check(() => resolveIssueType(meta, t.type));
  if (t.status) check(() => checkStatusKnown(meta, t.status!));
  if (t.priority !== null) check(() => resolvePriority(meta, t.priority!));
  if (t.sprint !== null) check(() => resolveSprint(meta, t.sprint!));
  if (t.description !== null) check(() => mdToAdf(t.description!));
  for (const alias of Object.keys(t.fields)) check(() => resolveFieldAlias(meta, alias));
  for (const link of t.links) {
    check(() => resolveLinkType(meta, link.type));
    if (link.to.startsWith("@") && !store.workingExists(link.to)) {
      problems.push(`link target '${link.to}' has no working file`);
    }
  }
  for (const c of t.comments) check(() => mdToAdf(c.body));
  if (t.parent?.startsWith("@") && !store.workingExists(t.parent)) {
    problems.push(`parent '${t.parent}' has no working file`);
  }

  const base = id.startsWith("@") ? null : store.readBase(id);
  if (base) {
    const cd = diffComments(base.ticket.comments, t.comments);
    if (cd.editedExisting.length) {
      problems.push(
        `existing comments edited (${cd.editedExisting.map((c) => c.id).join(", ")}) — comments are append-only`,
      );
    }
    if (cd.removedExisting.length) {
      problems.push(
        `existing comments removed (${cd.removedExisting.map((c) => c.id).join(", ")}) — comments are append-only`,
      );
    }
    if (base.ticket.project !== t.project) {
      problems.push("changing 'project' is not supported");
    }
    if (ticketsEqual(base.ticket, t)) return; // caller filtered; defensive
  } else {
    if (t.key) problems.push("new ticket files must not set 'key'");
    if (t.comments.some((c) => c.id)) problems.push("new tickets cannot contain comments with ids");
  }

  if (problems.length) {
    fail(`${id}: cannot commit:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}
