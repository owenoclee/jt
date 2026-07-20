/** Local-only verbs: status, diff, show, new, rm, untrack, resolve, log, schema. */
import { parseArgs } from "@std/cli";
import { basename } from "@std/path";
import { ticketsEqual } from "../canonical.ts";
import { localContext, withClient, withMeta } from "../context.ts";
import { diffTickets } from "../diff.ts";
import { fail } from "../errors.ts";
import { bold, cyan, dim, green, red } from "../render/colors.ts";
import { renderDiffEntries, renderJournalEntry, renderStatus, renderTicket } from "../render/render.ts";
import { ticketJsonSchema } from "../schema.ts";
import { fetchBaseEntry } from "../sync.ts";
import type { Ticket } from "../types.ts";

export function cmdStatus(): void {
  const { store } = localContext();
  console.log(renderStatus(store.status()));
}

export function cmdDiff(argv: string[]): void {
  const args = parseArgs(argv, { boolean: ["committed", "all"] });
  const { store } = localContext();
  const filter = (args._ as string[]).map(String);
  const wanted = (id: string) => filter.length === 0 || filter.includes(id);
  const sections: string[] = [];

  if (args.committed) {
    // What push will send: committed vs base.
    for (const id of store.listCommittedIds()) {
      if (!wanted(id)) continue;
      const committed = store.readCommitted(id)!;
      if (id.startsWith("@")) {
        sections.push(`${cyan("will create:")}\n${renderTicket(committed.ticket)}`);
        continue;
      }
      const base = store.readBase(id);
      if (!base) continue;
      const entries = diffTickets(base.ticket, committed.ticket);
      if (entries.length) sections.push(renderDiffEntries(id, committed.ticket.summary, entries));
    }
    for (const d of store.readDeletions().filter((d) => d.committed)) {
      if (!wanted(d.key)) continue;
      sections.push(`${red("will delete:")} ${bold(d.key)}  "${d.summary}"`);
    }
  } else {
    for (const s of store.status()) {
      if (!wanted(s.id)) continue;
      const working = store.readWorking(s.id);
      if (s.state === "new") {
        sections.push(`${cyan("new (uncommitted):")}\n${renderTicket(working!.ticket)}`);
        continue;
      }
      if (s.state === "new+committed+modified" || s.state === "committed+modified" || s.state === "modified") {
        const against = args.all
          ? store.readBase(s.id)?.ticket
          : (store.readCommitted(s.id)?.ticket ?? store.readBase(s.id)?.ticket);
        if (!against || !working) continue;
        const entries = diffTickets(against, working.ticket);
        if (entries.length) sections.push(renderDiffEntries(s.id, working.ticket.summary, entries));
        continue;
      }
      if (s.state === "deleted") {
        sections.push(`${red("will delete (uncommitted):")} ${bold(s.id)}  "${s.summary}"`);
        continue;
      }
      if (args.all && (s.state === "committed" || s.state === "new+committed")) {
        const base = store.readBase(s.id)?.ticket;
        const working2 = working?.ticket;
        if (base && working2) {
          const entries = diffTickets(base, working2);
          if (entries.length) sections.push(renderDiffEntries(s.id, working2.summary, entries));
        } else if (working2) {
          sections.push(`${cyan("new (committed):")}\n${renderTicket(working2)}`);
        }
      }
    }
  }

  if (sections.length === 0) {
    console.log(
      args.committed
        ? "nothing committed — jt commit stages approved changes for push"
        : "no uncommitted changes",
    );
    return;
  }
  console.log(sections.join("\n\n"));
}

export function cmdShow(argv: string[]): void {
  const args = parseArgs(argv, { boolean: ["base", "committed"] });
  const target = (args._ as string[]).map(String)[0];
  if (!target) fail("usage: jt show <KEY | @name | path> [--base|--committed]");
  const { store } = localContext();

  if (target.endsWith(".json")) {
    const wf = store.readWorkingFile(target);
    console.log(renderTicket(wf.ticket, basename(target)));
    return;
  }
  const id = target.startsWith("@") ? target : target.toUpperCase();
  let ticket: Ticket | undefined;
  let label: string;
  if (args.base) {
    ticket = store.readBase(id)?.ticket;
    label = "base — remote as of last fetch";
  } else if (args.committed) {
    ticket = store.readCommitted(id)?.ticket;
    label = "committed — approved for push";
  } else {
    ticket = store.readWorking(id)?.ticket;
    label = "working";
  }
  if (!ticket) fail(`no ${args.base ? "base" : args.committed ? "committed" : "working"} copy of ${id}`);
  console.log(renderTicket(ticket, label));
}

export function cmdNew(argv: string[]): void {
  const args = parseArgs(argv, { string: ["type", "summary", "parent"] });
  const name = (args._ as string[]).map(String)[0];
  if (!name) fail("usage: jt new <name> [--type Story] [--summary '...'] [--parent KEY|@name]");
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) {
    fail(`name '${name}' must be lowercase alphanumeric with dashes (it becomes tickets/${name}.json)`);
  }
  const ctx = localContext();
  if (ctx.store.workingExists(`@${name}`)) fail(`tickets/${name}.json already exists`);

  const fields: Record<string, unknown> = {};
  for (const alias of ctx.ws.config.customFields) fields[alias] = null;
  const ticket: Ticket = {
    project: ctx.ws.config.project,
    type: args.type ?? "Task",
    summary: args.summary ?? "TODO: summary",
    description: null,
    labels: [],
    parent: args.parent ?? null,
    sprint: null,
    assignee: null,
    priority: null,
    links: [],
    comments: [],
    fields,
  };
  ctx.store.writeWorking(`@${name}`, ticket);
  const path = ctx.store.workingPath(`@${name}`);
  console.log(`created ${path} ${dim(`(referenced as @${name} until pushed)`)}`);
  console.log(dim("edit the file, then: jt diff && jt commit && jt push"));
}

export function cmdRm(argv: string[]): void {
  const key = argv[0]?.toUpperCase();
  if (!key) fail("usage: jt rm <KEY>  (stages remote deletion; see also jt untrack)");
  const { store } = localContext();
  if (key.startsWith("@") || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
    fail(`'${argv[0]}' is not an issue key — pending creations are just files; delete tickets/${
      argv[0]?.replace(/^@/, "")
    }.json and jt untrack ${argv[0]}`);
  }
  const base = store.readBase(key);
  if (!base) fail(`${key} is not tracked (no base snapshot) — jt fetch ${key} first`);
  const deletions = store.readDeletions().filter((d) => d.key !== key);
  deletions.push({
    key,
    summary: base.ticket.summary,
    requestedAt: new Date().toISOString(),
    committed: false,
  });
  store.writeDeletions(deletions);
  store.removeWorking(key);
  store.removeCommitted(key);
  console.log(`${red("staged deletion")} of ${bold(key)} "${base.ticket.summary}"`);
  console.log(dim("jt commit && jt push to delete in Jira · jt untrack to abandon"));
}

export function cmdUntrack(argv: string[]): void {
  if (argv.length === 0) fail("usage: jt untrack <KEY|@name...>");
  const { store } = localContext();
  for (const raw of argv) {
    const id = raw.startsWith("@") ? raw : raw.toUpperCase();
    store.removeWorking(id);
    store.removeCommitted(id);
    if (!id.startsWith("@")) {
      store.removeBase(id);
      store.writeDeletions(store.readDeletions().filter((d) => d.key !== id));
      store.writeConflicts(store.readConflicts().filter((c) => c.key !== id));
    }
    console.log(`untracked ${id} ${dim("(local only — Jira is untouched)")}`);
  }
}

export async function cmdResolve(argv: string[]): Promise<void> {
  const key = argv[0]?.toUpperCase();
  if (!key) fail("usage: jt resolve <KEY>  (after a pull conflict: accepts your working file as the desired state on top of latest remote)");
  const ctx = withClient(withMeta(localContext()));
  const conflict = ctx.store.readConflicts().find((c) => c.key === key);
  if (!conflict) fail(`no recorded conflict for ${key}`);
  const working = ctx.store.readWorking(key);
  if (!working) fail(`${key} has no working file — jt untrack or jt fetch it first`);

  const fresh = await fetchBaseEntry(ctx.client, ctx.meta, ctx.ws.config, key);
  ctx.store.writeBase(fresh);
  ctx.store.removeCommitted(key);
  ctx.store.writeConflicts(ctx.store.readConflicts().filter((c) => c.key !== key));
  if (ticketsEqual(working.ticket, fresh.ticket)) {
    ctx.store.writeWorking(key, fresh.ticket);
    console.log(`${green("resolved")} ${key} — working file matches remote; nothing to commit`);
  } else {
    console.log(
      `${green("resolved")} ${key} — base advanced to latest remote; ` +
        `your working file is the desired state. Review: jt diff ${key}, then jt commit`,
    );
  }
}

export function cmdLog(argv: string[]): void {
  const args = parseArgs(argv, { boolean: ["all"] });
  const { store } = localContext();
  const entries = store.listJournal();
  if (entries.length === 0) {
    console.log("no pushes yet");
    return;
  }
  const shown = args.all ? entries : entries.slice(0, 10);
  console.log(shown.map((e) => renderJournalEntry(e.path, e.entry)).join("\n\n"));
  if (!args.all && entries.length > shown.length) {
    console.log(dim(`\n(${entries.length - shown.length} older — jt log --all)`));
  }
}

export function cmdSchema(): void {
  console.log(JSON.stringify(ticketJsonSchema(), null, 2));
}
