/**
 * Workspace layer store.
 *
 *   tickets/<KEY>.json        working tree — the only layer the agent edits
 *   tickets/<name>.json       pending creation (no `key` field); referenced as "@<name>"
 *   .jira/base/<KEY>.json     remote state as of last fetch (tool-owned)
 *   .jira/committed/<id>.json approved snapshots (tool-owned byte copies of working files)
 *   .jira/intents.json        staged whole-issue intents (jt rm / archive / unarchive)
 *   .jira/conflicts.json      unresolved pull conflicts
 *   .jira/journal/            push audit log
 *   .jira/seen/<KEY>.json     remote state as last known to the user (ack / approved pushes)
 *   .jira/sync.json           mirror watermark + scope membership (tool-owned)
 *
 * The committed layer and the intents file are per PROPOSAL (see proposal.ts). The
 * default proposal keeps them at the paths above; a named one keeps its own copies
 * under .jira/proposals/<name>/, beside its commit chain and review handoff files.
 * Everything else — working tree, base, seen, conflicts, journal — is shared: there is
 * one Jira, and one file per ticket. A ticket is therefore held by at most one proposal
 * at a time, and a Store is always scoped to one.
 */
import { basename, dirname, join } from "@std/path";
import { serializeTicket, ticketsEqual } from "./canonical.ts";
import { fail } from "./errors.ts";
import { compareTicketIds } from "./keys.ts";
import { parseTicket } from "./schema.ts";
import { intentState } from "./intents.ts";
import { DEFAULT_PROPOSAL } from "./proposal.ts";
import type {
  BaseEntry,
  ConflictRecord,
  IssueIntent,
  JournalEntry,
  SyncState,
  Ticket,
  TicketStatus,
} from "./types.ts";

export interface WorkingFile {
  /** Issue key, or "@<stem>" for a pending creation. */
  id: string;
  path: string;
  ticket: Ticket;
  bytes: string;
}

export class Store {
  readonly jiraDir: string;
  /** Where every named proposal keeps its directory. */
  readonly proposalsDir: string;
  /** This proposal's own directory — .jira itself for the default proposal. */
  readonly proposalDir: string;
  readonly baseDir: string;
  readonly committedDir: string;
  readonly journalDir: string;
  readonly ticketsDir: string;
  readonly seenDir: string;
  readonly intentsFile: string;
  /** Pre-0.5 home of the intents file, read once so an in-flight workspace carries over. */
  readonly legacyDeletionsFile: string;
  readonly conflictsFile: string;
  readonly syncFile: string;

  constructor(public root: string, readonly proposal: string = DEFAULT_PROPOSAL) {
    this.jiraDir = join(root, ".jira");
    this.proposalsDir = join(this.jiraDir, "proposals");
    this.proposalDir = proposal === DEFAULT_PROPOSAL
      ? this.jiraDir
      : join(this.proposalsDir, proposal);
    this.baseDir = join(this.jiraDir, "base");
    this.committedDir = join(this.proposalDir, "committed");
    this.journalDir = join(this.jiraDir, "journal");
    this.ticketsDir = join(root, "tickets");
    this.seenDir = join(this.jiraDir, "seen");
    this.intentsFile = join(this.proposalDir, "intents.json");
    this.legacyDeletionsFile = join(this.proposalDir, "deletions.json");
    this.conflictsFile = join(this.jiraDir, "conflicts.json");
    this.syncFile = join(this.jiraDir, "sync.json");
  }

  ensureDirs(): void {
    for (const d of [this.jiraDir, this.baseDir, this.committedDir, this.journalDir, this.ticketsDir, this.seenDir]) {
      Deno.mkdirSync(d, { recursive: true });
    }
  }

  // ---- proposals ----

  /** The same workspace seen through another proposal. */
  scoped(proposal: string): Store {
    return proposal === this.proposal ? this : new Store(this.root, proposal);
  }

  /** Every proposal with a directory on disk, default first. */
  listProposals(): string[] {
    let named: string[] = [];
    try {
      named = [...Deno.readDirSync(this.proposalsDir)]
        .filter((e) => e.isDirectory)
        .map((e) => e.name)
        .sort();
    } catch {
      // no named proposals yet
    }
    return [DEFAULT_PROPOSAL, ...named];
  }

  /**
   * Which proposal holds each ticket — a committed copy or a staged intent, committed
   * or not. A ticket is held by at most one; should two ever claim it, this proposal's
   * own claim wins so its commands keep acting on what they staged.
   */
  holders(): Map<string, string> {
    const out = new Map<string, string>();
    const names = this.listProposals().filter((n) => n !== this.proposal);
    for (const name of [...names, this.proposal]) {
      const s = this.scoped(name);
      for (const id of s.listCommittedIds()) out.set(id, name);
      for (const intent of s.readIntents()) out.set(intent.key, name);
    }
    return out;
  }

  /** The proposal holding `id`, or null when nothing has staged it. */
  heldBy(id: string): string | null {
    const order = [this.proposal, ...this.listProposals().filter((n) => n !== this.proposal)];
    for (const name of order) {
      const s = this.scoped(name);
      if (s.committedExists(id) || s.readIntents().some((i) => i.key === id)) return name;
    }
    return null;
  }

  /** This workspace scoped to whichever proposal holds `id` — itself when none does. */
  holder(id: string): Store {
    return this.scoped(this.heldBy(id) ?? this.proposal);
  }

  /** True once nothing is staged here and no review is pending or uncollected. */
  isDrained(): boolean {
    if (this.listCommittedIds().length > 0 || this.readIntents().length > 0) return false;
    return !["chain.json", "push-spec.json", "pending-push.json", "push-result.json"].some((f) => {
      try {
        Deno.statSync(join(this.proposalDir, f));
        return true;
      } catch {
        return false;
      }
    });
  }

  /**
   * Remove a named proposal's directory once it has drained, so finished proposals do
   * not accumulate. The default proposal lives in .jira itself and is never removed.
   */
  dropIfDrained(): void {
    if (this.proposal === DEFAULT_PROPOSAL || !this.isDrained()) return;
    try {
      Deno.removeSync(this.proposalDir, { recursive: true });
    } catch {
      // already gone
    }
  }

  // ---- working tree ----

  workingPath(id: string): string {
    return join(this.ticketsDir, `${idToStem(id)}.json`);
  }

  listWorking(): WorkingFile[] {
    const out: WorkingFile[] = [];
    let entries: Deno.DirEntry[] = [];
    try {
      entries = [...Deno.readDirSync(this.ticketsDir)];
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      out.push(this.readWorkingFile(join(this.ticketsDir, e.name)));
    }
    return out.sort((a, b) => compareTicketIds(a.id, b.id));
  }

  readWorkingFile(path: string): WorkingFile {
    let bytes: string;
    try {
      bytes = Deno.readTextFileSync(path);
    } catch {
      fail(`cannot read ${path}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(bytes);
    } catch (e) {
      fail(`${path} is not valid JSON: ${e instanceof Error ? e.message : e}`);
    }
    const ticket = parseTicket(data, path);
    const stem = basename(path).replace(/\.json$/, "");
    if (ticket.key) {
      if (ticket.key !== stem) {
        fail(
          `${path}: file is named '${stem}' but its key is '${ticket.key}' — ` +
            `working files for existing tickets must be named <KEY>.json`,
        );
      }
      return { id: ticket.key, path, ticket, bytes };
    }
    return { id: `@${stem}`, path, ticket, bytes };
  }

  readWorking(id: string): WorkingFile | null {
    try {
      return this.readWorkingFile(this.workingPath(id));
    } catch {
      return null;
    }
  }

  workingExists(id: string): boolean {
    try {
      Deno.statSync(this.workingPath(id));
      return true;
    } catch {
      return false;
    }
  }

  writeWorking(id: string, ticket: Ticket): void {
    Deno.mkdirSync(this.ticketsDir, { recursive: true });
    Deno.writeTextFileSync(this.workingPath(id), serializeTicket(ticket));
  }

  removeWorking(id: string): void {
    try {
      Deno.removeSync(this.workingPath(id));
    } catch {
      // already gone
    }
  }

  // ---- base layer ----

  basePath(key: string): string {
    return join(this.baseDir, `${key}.json`);
  }

  readBase(key: string): BaseEntry | null {
    try {
      return JSON.parse(Deno.readTextFileSync(this.basePath(key))) as BaseEntry;
    } catch {
      return null;
    }
  }

  listBaseKeys(): string[] {
    try {
      return [...Deno.readDirSync(this.baseDir)]
        .filter((e) => e.isFile && e.name.endsWith(".json"))
        .map((e) => e.name.replace(/\.json$/, ""))
        .sort(compareTicketIds);
    } catch {
      return [];
    }
  }

  writeBase(entry: BaseEntry): void {
    Deno.mkdirSync(this.baseDir, { recursive: true });
    Deno.writeTextFileSync(this.basePath(entry.key), JSON.stringify(entry, null, 2) + "\n");
  }

  removeBase(key: string): void {
    try {
      Deno.removeSync(this.basePath(key));
    } catch {
      // already gone
    }
  }

  // ---- committed layer (byte copies of approved working files) ----

  committedPath(id: string): string {
    return join(this.committedDir, `${idToStem(id)}.json`);
  }

  committedExists(id: string): boolean {
    try {
      Deno.statSync(this.committedPath(id));
      return true;
    } catch {
      return false;
    }
  }

  readCommitted(id: string): WorkingFile | null {
    const path = this.committedPath(id);
    let bytes: string;
    try {
      bytes = Deno.readTextFileSync(path);
    } catch {
      return null;
    }
    const ticket = parseTicket(JSON.parse(bytes), path);
    return { id, path, ticket, bytes };
  }

  listCommittedIds(): string[] {
    try {
      return [...Deno.readDirSync(this.committedDir)]
        .filter((e) => e.isFile && e.name.endsWith(".json"))
        .map((e) => stemToId(e.name.replace(/\.json$/, "")))
        .sort(compareTicketIds);
    } catch {
      return [];
    }
  }

  writeCommitted(id: string, bytes: string): void {
    Deno.mkdirSync(this.committedDir, { recursive: true });
    Deno.writeTextFileSync(this.committedPath(id), bytes);
  }

  removeCommitted(id: string): void {
    try {
      Deno.removeSync(this.committedPath(id));
    } catch {
      // already gone
    }
  }

  // ---- seen layer (last-known-to-the-user remote state; advances on jt changes --ack
  // and, for human-approved push deltas, during push settle) ----

  seenPath(key: string): string {
    return join(this.seenDir, `${key}.json`);
  }

  readSeen(key: string): { ticket: Ticket; bytes: string } | null {
    const path = this.seenPath(key);
    let bytes: string;
    try {
      bytes = Deno.readTextFileSync(path);
    } catch {
      return null;
    }
    return { ticket: parseTicket(JSON.parse(bytes), path), bytes };
  }

  listSeenKeys(): string[] {
    try {
      return [...Deno.readDirSync(this.seenDir)]
        .filter((e) => e.isFile && e.name.endsWith(".json"))
        .map((e) => e.name.replace(/\.json$/, ""))
        .sort(compareTicketIds);
    } catch {
      return [];
    }
  }

  removeSeen(key: string): void {
    try {
      Deno.removeSync(this.seenPath(key));
    } catch {
      // already gone
    }
  }

  writeSeen(key: string, ticket: Ticket): void {
    Deno.mkdirSync(this.seenDir, { recursive: true });
    Deno.writeTextFileSync(this.seenPath(key), serializeTicket(ticket));
  }

  /** Acknowledge upstream state: seen becomes a byte-copy of every base ticket. */
  ackSeen(keys?: string[]): void {
    Deno.mkdirSync(this.seenDir, { recursive: true });
    const wanted = keys ? new Set(keys) : null;
    for (const key of this.listBaseKeys()) {
      if (wanted && !wanted.has(key)) continue;
      Deno.writeTextFileSync(this.seenPath(key), serializeTicket(this.readBase(key)!.ticket));
    }
    const baseKeys = new Set(this.listBaseKeys());
    for (const key of this.listSeenKeys()) {
      if (baseKeys.has(key)) continue;
      if (wanted && !wanted.has(key)) continue;
      this.removeSeen(key);
    }
  }

  // ---- mirror sync state ----

  readSyncState(): SyncState {
    try {
      return JSON.parse(Deno.readTextFileSync(this.syncFile)) as SyncState;
    } catch {
      return { watermark: null, scopeKeys: [] };
    }
  }

  writeSyncState(state: SyncState): void {
    Deno.writeTextFileSync(this.syncFile, JSON.stringify(state, null, 2) + "\n");
  }

  // ---- intents / conflicts ----

  readIntents(): IssueIntent[] {
    for (const path of [this.intentsFile, this.legacyDeletionsFile]) {
      try {
        const raw = JSON.parse(Deno.readTextFileSync(path)) as IssueIntent[];
        // Entries written before 0.5 predate the mode field; they were all deletions.
        return raw.map((i) => ({ ...i, mode: i.mode ?? "delete" }));
      } catch {
        // absent or unreadable — try the legacy path
      }
    }
    return [];
  }

  writeIntents(intents: IssueIntent[]): void {
    try {
      Deno.removeSync(this.legacyDeletionsFile);
    } catch {
      // nothing to migrate
    }
    if (intents.length === 0) {
      try {
        Deno.removeSync(this.intentsFile);
      } catch {
        // already gone
      }
      return;
    }
    Deno.mkdirSync(dirname(this.intentsFile), { recursive: true });
    Deno.writeTextFileSync(this.intentsFile, JSON.stringify(intents, null, 2) + "\n");
  }

  readConflicts(): ConflictRecord[] {
    try {
      return JSON.parse(Deno.readTextFileSync(this.conflictsFile)) as ConflictRecord[];
    } catch {
      return [];
    }
  }

  writeConflicts(conflicts: ConflictRecord[]): void {
    if (conflicts.length === 0) {
      try {
        Deno.removeSync(this.conflictsFile);
      } catch {
        // already gone
      }
      return;
    }
    Deno.writeTextFileSync(this.conflictsFile, JSON.stringify(conflicts, null, 2) + "\n");
  }

  // ---- journal ----

  appendJournal(entry: JournalEntry): string {
    Deno.mkdirSync(this.journalDir, { recursive: true });
    const stamp = entry.startedAt.replace(/[:.]/g, "-");
    // Proposals push independently, possibly in the same millisecond: the name keeps
    // their journal files apart. The default proposal keeps the historical filename.
    const suffix = this.proposal === DEFAULT_PROPOSAL ? "" : `-${this.proposal}`;
    const path = join(this.journalDir, `${stamp}-push${suffix}.json`);
    Deno.writeTextFileSync(path, JSON.stringify(entry, null, 2) + "\n");
    return path;
  }

  /** This proposal's latest push from the journal, or null when it has never pushed. */
  lastPush(): JournalEntry | null {
    // Filenames start with the push's start time, so they sort chronologically; only
    // the newest of this proposal's needs reading.
    const suffix = this.proposal === DEFAULT_PROPOSAL
      ? "-push.json"
      : `-push-${this.proposal}.json`;
    let names: string[];
    try {
      names = [...Deno.readDirSync(this.journalDir)]
        .filter((e) => e.isFile && e.name.endsWith(suffix))
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return null;
    }
    for (const name of names) {
      const entry = JSON.parse(Deno.readTextFileSync(join(this.journalDir, name))) as JournalEntry;
      if ((entry.proposal ?? DEFAULT_PROPOSAL) === this.proposal) return entry;
    }
    return null;
  }

  /**
   * What this proposal's last push left staged when it stopped at a failure: the ids
   * it was sending that are still committed. A human approved these once already, so
   * they are leftovers to retry or drop, not new work — and are labelled as such.
   */
  leftovers(): { pushedAt: string; ids: string[] } | null {
    const last = this.lastPush();
    if (last?.result !== "partial") return null;
    const staged = new Set([
      ...this.listCommittedIds(),
      ...this.readIntents().filter((i) => i.committed).map((i) => i.key),
    ]);
    const ids = (last.changes ?? []).map((c) => c.key ?? c.id).filter((id) => staged.has(id));
    return ids.length > 0 ? { pushedAt: last.startedAt, ids } : null;
  }

  listJournal(): { path: string; entry: JournalEntry }[] {
    try {
      return [...Deno.readDirSync(this.journalDir)]
        .filter((e) => e.isFile && e.name.endsWith(".json"))
        .map((e) => {
          const path = join(this.journalDir, e.name);
          return { path, entry: JSON.parse(Deno.readTextFileSync(path)) as JournalEntry };
        })
        .sort((a, b) => b.entry.startedAt.localeCompare(a.entry.startedAt));
    } catch {
      return [];
    }
  }

  // ---- status ----

  status(): TicketStatus[] {
    const working = new Map(this.listWorking().map((w) => [w.id, w]));
    const baseKeys = new Set(this.listBaseKeys());
    const conflicts = new Map(this.readConflicts().map((c) => [c.key, c]));

    // Committed copies and intents live per proposal; a ticket's state is read from
    // whichever proposal holds it, and names that proposal so callers can tell their
    // own staged work from another agent's.
    const held = new Map<string, { store: Store; intent?: IssueIntent }>();
    const names = this.listProposals().filter((n) => n !== this.proposal);
    for (const name of [...names, this.proposal]) {
      const s = this.scoped(name);
      for (const id of s.listCommittedIds()) held.set(id, { store: s });
      for (const intent of s.readIntents()) held.set(intent.key, { store: s, intent });
    }

    const ids = new Set<string>([...working.keys(), ...baseKeys, ...held.keys()]);

    const leftovers = new Map<string, ReturnType<Store["leftovers"]>>();
    const leftoverNote = (s: Store, id: string): { detail?: string } => {
      if (!leftovers.has(s.proposal)) leftovers.set(s.proposal, s.leftovers());
      const left = leftovers.get(s.proposal);
      if (!left?.ids.includes(id)) return {};
      const day = left.pushedAt.slice(0, 10);
      return { detail: `left over from the partial push on ${day} — jt log ${id}` };
    };

    const out: TicketStatus[] = [];
    for (const id of [...ids].sort(compareTicketIds)) {
      const h = held.get(id);
      const proposal = h ? { proposal: h.store.proposal } : {};
      const w = working.get(id) ?? null;
      const c = h && !h.intent ? h.store.readCommitted(id) : null;
      const base = id.startsWith("@") ? null : this.readBase(id);
      const intent = h?.intent;
      const summary = w?.ticket.summary ?? c?.ticket.summary ?? base?.ticket.summary ?? "";

      if (conflicts.has(id)) {
        const cf = conflicts.get(id)!;
        out.push({
          id,
          state: "conflict",
          summary,
          detail: `fields: ${cf.fields.join(", ")}`,
          ...proposal,
        });
        continue;
      }
      if (intent) {
        out.push({
          id,
          state: intentState(intent.mode, intent.committed),
          summary: intent.summary,
          ...(intent.committed ? leftoverNote(h!.store, id) : {}),
          ...proposal,
        });
        continue;
      }
      if (!w && base) {
        out.push({
          id,
          state: "missing",
          summary,
          detail:
            "working file was deleted by hand — run `jt archive`/`jt rm` (changes Jira) or `jt untrack`",
          ...proposal,
        });
        continue;
      }
      if (!w) continue; // stale committed entry without working file — ignore

      if (!base) {
        // pending creation
        if (c) {
          out.push({
            id,
            state: ticketsEqual(w.ticket, c.ticket) ? "new+committed" : "new+committed+modified",
            summary,
            ...leftoverNote(h!.store, id),
            ...proposal,
          });
        } else {
          out.push({ id, state: "new", summary });
        }
        continue;
      }

      if (c) {
        out.push({
          id,
          state: ticketsEqual(w.ticket, c.ticket) ? "committed" : "committed+modified",
          summary,
          ...leftoverNote(h!.store, id),
          ...proposal,
        });
      } else {
        out.push({
          id,
          state: ticketsEqual(w.ticket, base.ticket) ? "clean" : "modified",
          summary,
        });
      }
    }
    return out;
  }
}

function idToStem(id: string): string {
  return id.startsWith("@") ? id.slice(1) : id;
}

function stemToId(stem: string): string {
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(stem) ? stem : `@${stem}`;
}
