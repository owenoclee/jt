/** Local-only verbs: status, diff, show, new, rm, archive, unarchive, untrack, resolve, log, schema. */
import { parseArgs } from "@std/cli";
import { basename, join } from "@std/path";
import { ticketsEqual } from "../canonical.ts";
import { pruneChain, withdrawFromChain } from "../chain.ts";
import { renderPage, renderTicketCard, renderTicketDelta, type ReviewPageModel } from "../review/html.ts";
import { buildCommitViews, buildSinceReview } from "../review/model.ts";
import { localContext, withClient, withMeta } from "../context.ts";
import { diffTickets } from "../diff.ts";
import { fail } from "../errors.ts";
import { COMMITTED_INTENT_STATES, intentNoun, STAGED_INTENT_STATES } from "../intents.ts";
import { makeRefContext } from "../refs.ts";
import { bold, cyan, dim, green, red, yellow } from "../render/colors.ts";
import { upstreamChangeCount } from "./changes.ts";
import { renderDiffEntries, renderJournalEntry, renderStatus, renderTicket } from "../render/render.ts";
import { ticketJsonSchema } from "../schema.ts";
import { fetchBaseEntry } from "../sync.ts";
import type { IntentMode, Ticket } from "../types.ts";

export function cmdStatus(argv: string[] = []): void {
  const args = parseArgs(argv, { boolean: ["all"] });
  const { store } = localContext();
  console.log(renderStatus(store.status(), { all: Boolean(args.all) }));
  const upstream = upstreamChangeCount(store);
  if (upstream > 0) {
    console.log(yellow(`  ↓ ${upstream} upstream change${upstream === 1 ? "" : "s"} since your last ack — jt changes`));
  }
}

export function cmdDiff(argv: string[]): void {
  const args = parseArgs(argv, { boolean: ["committed", "all", "web"] });
  const ctx = localContext();
  const { store } = ctx;
  const filter = (args._ as string[]).map(String);
  const wanted = (id: string) => filter.length === 0 || filter.includes(id);
  if (args.web) {
    diffWeb(ctx, Boolean(args.committed), Boolean(args.all), wanted);
    return;
  }
  const refs = makeRefContext(store, ctx.ws.config);
  const sections: string[] = [];

  if (args.committed) {
    // What push will send: committed vs base.
    for (const id of store.listCommittedIds()) {
      if (!wanted(id)) continue;
      const committed = store.readCommitted(id)!;
      if (id.startsWith("@")) {
        sections.push(`${cyan("will create:")}\n${renderTicket(committed.ticket, undefined, refs)}`);
        continue;
      }
      const base = store.readBase(id);
      if (!base) continue;
      const entries = diffTickets(base.ticket, committed.ticket);
      if (entries.length) {
        sections.push(renderDiffEntries(id, committed.ticket.summary, entries, refs));
      }
    }
    for (const i of store.readIntents().filter((i) => i.committed)) {
      if (!wanted(i.key)) continue;
      sections.push(`${intentHeading(i.mode)} ${bold(i.key)}  "${i.summary}"`);
    }
  } else {
    for (const s of store.status()) {
      if (!wanted(s.id)) continue;
      const working = store.readWorking(s.id);
      if (s.state === "new") {
        sections.push(`${cyan("new (uncommitted):")}\n${renderTicket(working!.ticket, undefined, refs)}`);
        continue;
      }
      if (s.state === "new+committed+modified" || s.state === "committed+modified" || s.state === "modified") {
        const against = args.all
          ? store.readBase(s.id)?.ticket
          : (store.readCommitted(s.id)?.ticket ?? store.readBase(s.id)?.ticket);
        if (!against || !working) continue;
        const entries = diffTickets(against, working.ticket);
        if (entries.length) {
          sections.push(renderDiffEntries(s.id, working.ticket.summary, entries, refs));
        }
        continue;
      }
      if (STAGED_INTENT_STATES.includes(s.state)) {
        const intent = store.readIntents().find((i) => i.key === s.id)!;
        sections.push(`${intentHeading(intent.mode, true)} ${bold(s.id)}  "${s.summary}"`);
        continue;
      }
      if (args.all && (s.state === "committed" || s.state === "new+committed")) {
        const base = store.readBase(s.id)?.ticket;
        const working2 = working?.ticket;
        if (base && working2) {
          const entries = diffTickets(base, working2);
          if (entries.length) sections.push(renderDiffEntries(s.id, working2.summary, entries, refs));
        } else if (working2) {
          sections.push(`${cyan("new (committed):")}\n${renderTicket(working2, undefined, refs)}`);
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

/** jt diff --web: render the current diff as a read-only PR-style page and open it. */
function diffWeb(
  ctx: ReturnType<typeof localContext>,
  committedView: boolean,
  all: boolean,
  wanted: (id: string) => boolean,
): void {
  const { store } = ctx;
  const refs = makeRefContext(store, ctx.ws.config);
  const tickets: ReviewPageModel["tickets"] = [];
  const push = (
    id: string,
    summary: string,
    kind: "create" | "update" | IntentMode,
    from: Ticket | null,
    to: Ticket | null,
  ) => {
    const intent = kind === "create" || kind === "update" ? undefined : { mode: kind, summary };
    const diffHtml = renderTicketDelta(from, to, refs, intent);
    if (diffHtml) {
      tickets.push({ id, summary, kind, unchangedSinceReview: false, diffHtml, opsJson: "" });
    }
  };

  if (committedView) {
    for (const id of store.listCommittedIds()) {
      if (!wanted(id)) continue;
      const committed = store.readCommitted(id)!;
      const base = id.startsWith("@") ? null : store.readBase(id);
      push(
        id,
        committed.ticket.summary,
        base ? "update" : "create",
        base?.ticket ?? null,
        committed.ticket,
      );
    }
    for (const i of store.readIntents().filter((i) => i.committed)) {
      if (!wanted(i.key)) continue;
      push(i.key, i.summary, i.mode, store.readBase(i.key)?.ticket ?? null, null);
    }
  } else {
    for (const s of store.status()) {
      if (!wanted(s.id)) continue;
      const working = store.readWorking(s.id);
      const base = s.id.startsWith("@") ? null : store.readBase(s.id);
      if (s.state === "new") push(s.id, s.summary, "create", null, working!.ticket);
      else if (
        STAGED_INTENT_STATES.includes(s.state) || COMMITTED_INTENT_STATES.includes(s.state)
      ) {
        const intent = store.readIntents().find((i) => i.key === s.id)!;
        push(s.id, s.summary, intent.mode, base?.ticket ?? null, null);
      } else if (working && base) {
        const against = all ? base.ticket : store.readCommitted(s.id)?.ticket ?? base.ticket;
        push(s.id, working.ticket.summary, "update", against, working.ticket);
      } else if (working && !base && all) {
        push(s.id, s.summary, "create", null, working.ticket);
      }
    }
  }

  const model: ReviewPageModel = {
    mode: "readonly",
    title: committedView ? "jt diff --committed (what push will send)" : "jt diff (uncommitted changes)",
    target: { baseUrl: ctx.ws.config.baseUrl, project: ctx.ws.config.project },
    tickets,
    commits: buildCommitViews(store, refs),
    sinceReview: buildSinceReview(store, tickets.map((t) => t.id), refs),
    nonce: "",
  };
  const dir = join(store.jiraDir, "tmp");
  Deno.mkdirSync(dir, { recursive: true });
  const path = join(dir, `diff-${Date.now()}.html`);
  Deno.writeTextFileSync(path, renderPage(model));
  console.log(`diff page: ${path}`);
}

export function cmdShow(argv: string[]): void {
  const args = parseArgs(argv, { boolean: ["base", "committed", "web"] });
  const targets = (args._ as string[]).map(String);
  const ctx = localContext();
  const { store } = ctx;

  if (args.web) {
    showWeb(ctx, targets, Boolean(args.base), Boolean(args.committed));
    return;
  }
  const target = targets[0];
  if (!target) fail("usage: jt show <KEY | @name | path> [--base|--committed] | jt show --web [KEY...]");
  const refs = makeRefContext(store, ctx.ws.config);

  if (target.endsWith(".json")) {
    const wf = store.readWorkingFile(target);
    console.log(renderTicket(wf.ticket, basename(target), refs));
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
  console.log(renderTicket(ticket, label, refs));
}

/** jt show --web: read-only workspace browser — fully rendered ticket cards. */
function showWeb(
  ctx: ReturnType<typeof localContext>,
  targets: string[],
  base: boolean,
  committed: boolean,
): void {
  const { store } = ctx;
  const refs = makeRefContext(store, ctx.ws.config);
  const layer = base ? "base" : committed ? "committed" : "working";
  const statuses = store.status();
  const ids = targets.length
    ? targets.map((t) => (t.startsWith("@") ? t : t.toUpperCase()))
    : statuses.map((s) => s.id);

  const tickets: ReviewPageModel["tickets"] = [];
  for (const id of ids) {
    const ticket = base
      ? store.readBase(id)?.ticket
      : committed
      ? store.readCommitted(id)?.ticket
      : store.readWorking(id)?.ticket;
    if (!ticket) continue;
    const state = statuses.find((s) => s.id === id)?.state ?? "clean";
    tickets.push({
      id,
      summary: `${ticket.summary}  (${state})`,
      kind: "view",
      unchangedSinceReview: false,
      diffHtml: renderTicketCard(ticket, "view", refs),
      opsJson: "",
    });
  }
  if (tickets.length === 0) fail(`nothing to show in the ${layer} layer`);

  const model: ReviewPageModel = {
    mode: "readonly",
    title: `jt workspace — ${tickets.length} ticket${tickets.length === 1 ? "" : "s"} (${layer})`,
    target: { baseUrl: ctx.ws.config.baseUrl, project: ctx.ws.config.project },
    tickets,
    commits: buildCommitViews(store, refs),
    sinceReview: null,
    nonce: "",
  };
  const dir = join(store.jiraDir, "tmp");
  Deno.mkdirSync(dir, { recursive: true });
  const path = join(dir, `show-${Date.now()}.html`);
  Deno.writeTextFileSync(path, renderPage(model));
  console.log(`workspace page: ${path}`);
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

/** jt uncommit: `git restore --staged` — keep working edits, remove from the changeset. */
export function cmdUncommit(argv: string[]): void {
  if (argv.length === 0) fail("usage: jt uncommit <KEY|@name...>  (keeps your edits; removes from what push will send)");
  const { store } = localContext();
  const withdrawn: Record<string, string> = {};
  for (const raw of argv) {
    const id = raw.startsWith("@") ? raw : raw.toUpperCase();
    const intents = store.readIntents();
    const intent = intents.find((i) => i.key === id && i.committed);
    if (intent) {
      intent.committed = false;
      store.writeIntents(intents);
      withdrawn[id] = intent.summary;
      console.log(
        `uncommitted ${bold(id)} ${
          dim(`(${intentNoun(intent.mode)} intent kept, no longer staged for push)`)
        }`,
      );
      continue;
    }
    const committed = store.readCommitted(id);
    if (!committed) {
      console.log(`${id}: nothing committed`);
      continue;
    }
    store.removeCommitted(id);
    withdrawn[id] = committed.ticket.summary;
    console.log(`uncommitted ${bold(id)} ${dim("(working edits kept — see jt status)")}`);
  }
  withdrawFromChain(store, "agent", `uncommit ${Object.keys(withdrawn).join(", ")}`, withdrawn);
}

/** jt restore: `git checkout -- <file>` — reset working file to committed-if-staged else base. */
export function cmdRestore(argv: string[]): void {
  if (argv.length === 0) {
    fail("usage: jt restore <KEY|@name...>  (discards working edits: resets to committed if staged, else to base; undoes jt rm/archive/unarchive)");
  }
  const { store } = localContext();
  for (const raw of argv) {
    const id = raw.startsWith("@") ? raw : raw.toUpperCase();
    const intents = store.readIntents();
    const intent = intents.find((i) => i.key === id);
    if (intent) {
      const noun = intentNoun(intent.mode);
      const base = store.readBase(id);
      store.writeIntents(intents.filter((i) => i.key !== id));
      if (intent.committed) {
        withdrawFromChain(store, "agent", `restore ${id} (${noun} undone)`, {
          [id]: intent.summary,
        });
      } else {
        pruneChain(store, [id]);
      }
      // An unarchive can be staged for a key that was never in the mirror; there is
      // then no base to put back, and dropping the intent is the whole restore.
      if (base) store.writeWorking(id, base.ticket);
      console.log(
        `restored ${bold(id)} ${
          dim(base ? `(${noun} undone; working file back from base)` : `(${noun} undone)`)
        }`,
      );
      continue;
    }
    const committed = store.readCommitted(id);
    const base = id.startsWith("@") ? null : store.readBase(id);
    const source = committed?.ticket ?? base?.ticket;
    if (!source) fail(`${id}: nothing to restore from (no committed or base copy)`);
    store.writeWorking(id, source);
    console.log(
      `restored ${bold(id)} from ${committed ? "committed" : "base"} ${dim("(working edits discarded)")}`,
    );
  }
}

export function cmdRm(argv: string[]): void {
  stageIntent("delete", argv);
}

export function cmdArchive(argv: string[]): void {
  stageIntent("archive", argv);
}

export function cmdUnarchive(argv: string[]): void {
  stageIntent("unarchive", argv);
}

const USAGE: Record<IntentMode, string> = {
  delete:
    "jt rm <KEY>  (stages permanent deletion; jt archive is reversible, jt untrack is local-only)",
  archive: "jt archive <KEY>  (stages archiving — reversible with jt unarchive)",
  unarchive: "jt unarchive <KEY>  (stages un-archiving of an archived issue)",
};

/**
 * Stage a whole-issue intent. Nothing reaches Jira here: like every other change it
 * waits for commit and an approved push.
 */
function stageIntent(mode: IntentMode, argv: string[]): void {
  const key = argv[0]?.toUpperCase();
  if (!key) fail(`usage: ${USAGE[mode]}`);
  const { store } = localContext();
  if (key.startsWith("@") || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
    fail(
      `'${argv[0]}' is not an issue key — pending creations are just files; delete tickets/${
        argv[0]?.replace(/^@/, "")
      }.json and jt untrack ${argv[0]}`,
    );
  }
  const base = store.readBase(key);
  // An archived issue has usually already left the mirror, so unarchiving is the one
  // intent that may name a key this workspace has never seen.
  if (!base && mode !== "unarchive") {
    fail(`${key} is not tracked (no base snapshot) — jt fetch ${key} first`);
  }
  const summary = base?.ticket.summary ?? "";
  const intents = store.readIntents().filter((i) => i.key !== key);
  intents.push({ key, mode, summary, requestedAt: new Date().toISOString(), committed: false });
  store.writeIntents(intents);
  if (mode !== "unarchive") {
    store.removeWorking(key);
    store.removeCommitted(key);
  }
  const named = summary ? `${bold(key)} "${summary}"` : bold(key);
  const colour = mode === "delete" ? red : yellow;
  console.log(`${colour(`staged ${intentNoun(mode)}`)} of ${named}`);
  if (mode === "delete") {
    console.log(
      yellow("  deletion is permanent — ") +
        dim(`jt archive ${key} is reversible and usually what you want`),
    );
  }
  if (mode === "archive") {
    console.log(dim("  archiving needs a Jira Premium or Enterprise plan"));
  }
  console.log(dim(`jt commit && jt push to ${mode} in Jira · jt restore ${key} to abandon`));
}

/** "will delete:" / "will archive:" — the heading a staged intent gets in jt diff. */
function intentHeading(mode: IntentMode, uncommitted = false): string {
  const text = `will ${mode}${uncommitted ? " (uncommitted)" : ""}:`;
  return mode === "delete" ? red(text) : yellow(text);
}

export function cmdUntrack(argv: string[]): void {
  if (argv.length === 0) fail("usage: jt untrack <KEY|@name...>");
  const { store } = localContext();
  for (const raw of argv) {
    const id = raw.startsWith("@") ? raw : raw.toUpperCase();
    // Untracking something that was staged for push shrinks the changeset — record a
    // withdrawal tombstone; plain cleanup of unstaged tickets just prunes.
    const committed = store.readCommitted(id);
    const committedIntent = store.readIntents().find((i) => i.key === id && i.committed);
    store.removeWorking(id);
    store.removeCommitted(id);
    if (!id.startsWith("@")) {
      store.removeBase(id);
      store.removeSeen(id);
      store.writeIntents(store.readIntents().filter((i) => i.key !== id));
      store.writeConflicts(store.readConflicts().filter((c) => c.key !== id));
    }
    if (committed || committedIntent) {
      withdrawFromChain(store, "agent", `untrack ${id}`, {
        [id]: committed?.ticket.summary ?? committedIntent!.summary,
      });
    } else {
      pruneChain(store, [id]);
    }
    console.log(`untracked ${id} ${dim("(local only — Jira is untouched)")}`);
  }
}

export async function cmdResolve(argv: string[]): Promise<void> {
  const key = argv[0]?.toUpperCase();
  if (!key) {
    fail(
      "usage: jt resolve <KEY>  (after a pull conflict: accepts your working file as the desired state on top of latest remote)",
    );
  }
  const ctx = withClient(withMeta(localContext()));
  const conflict = ctx.store.readConflicts().find((c) => c.key === key);
  if (!conflict) fail(`no recorded conflict for ${key}`);
  const working = ctx.store.readWorking(key);
  if (!working) fail(`${key} has no working file — jt untrack or jt fetch it first`);

  const fresh = await fetchBaseEntry(ctx.client, ctx.meta, ctx.ws.config, key);
  ctx.store.writeBase(fresh);
  ctx.store.removeCommitted(key);
  pruneChain(ctx.store, [key]);
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
  const args = parseArgs(argv, { boolean: ["all", "full"] });
  const { store } = localContext();
  const entries = store.listJournal();
  if (entries.length === 0) {
    console.log("no pushes yet");
    return;
  }
  const shown = args.all ? entries : entries.slice(0, 10);
  console.log(
    shown.map((e) => renderJournalEntry(e.path, e.entry, { full: Boolean(args.full) })).join(
      "\n\n",
    ),
  );
  if (!args.all && entries.length > shown.length) {
    console.log(dim(`\n(${entries.length - shown.length} older — jt log --all)`));
  }
}

export function cmdSchema(): void {
  console.log(JSON.stringify(ticketJsonSchema(), null, 2));
}
