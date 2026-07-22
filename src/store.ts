/**
 * Workspace layer store.
 *
 *   tickets/<KEY>.json        working tree — the only layer the agent edits
 *   tickets/<name>.json       pending creation (no `key` field); referenced as "@<name>"
 *   .jira/base/<KEY>.json     remote state as of last fetch (tool-owned)
 *   .jira/committed/<id>.json approved snapshots (tool-owned byte copies of working files)
 *   .jira/deletions.json      deletion intents (jt rm)
 *   .jira/conflicts.json      unresolved pull conflicts
 *   .jira/journal/            push audit log
 *   .jira/seen/<KEY>.json     remote state as last known to the user (ack / approved pushes)
 *   .jira/sync.json           mirror watermark + scope membership (tool-owned)
 */
import { basename, join } from "@std/path";
import { serializeTicket, ticketsEqual } from "./canonical.ts";
import { fail } from "./errors.ts";
import { compareTicketIds } from "./keys.ts";
import { parseTicket } from "./schema.ts";
import type {
  BaseEntry,
  ConflictRecord,
  DeletionIntent,
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
  readonly baseDir: string;
  readonly committedDir: string;
  readonly journalDir: string;
  readonly ticketsDir: string;
  readonly seenDir: string;
  readonly deletionsFile: string;
  readonly conflictsFile: string;
  readonly syncFile: string;

  constructor(public root: string) {
    this.jiraDir = join(root, ".jira");
    this.baseDir = join(this.jiraDir, "base");
    this.committedDir = join(this.jiraDir, "committed");
    this.journalDir = join(this.jiraDir, "journal");
    this.ticketsDir = join(root, "tickets");
    this.seenDir = join(this.jiraDir, "seen");
    this.deletionsFile = join(this.jiraDir, "deletions.json");
    this.conflictsFile = join(this.jiraDir, "conflicts.json");
    this.syncFile = join(this.jiraDir, "sync.json");
  }

  ensureDirs(): void {
    for (const d of [this.jiraDir, this.baseDir, this.committedDir, this.journalDir, this.ticketsDir, this.seenDir]) {
      Deno.mkdirSync(d, { recursive: true });
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

  // ---- deletions / conflicts ----

  readDeletions(): DeletionIntent[] {
    try {
      return JSON.parse(Deno.readTextFileSync(this.deletionsFile)) as DeletionIntent[];
    } catch {
      return [];
    }
  }

  writeDeletions(deletions: DeletionIntent[]): void {
    if (deletions.length === 0) {
      try {
        Deno.removeSync(this.deletionsFile);
      } catch {
        // already gone
      }
      return;
    }
    Deno.writeTextFileSync(this.deletionsFile, JSON.stringify(deletions, null, 2) + "\n");
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
    const path = join(this.journalDir, `${stamp}-push.json`);
    Deno.writeTextFileSync(path, JSON.stringify(entry, null, 2) + "\n");
    return path;
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
    const committedIds = new Set(this.listCommittedIds());
    const baseKeys = new Set(this.listBaseKeys());
    const deletions = new Map(this.readDeletions().map((d) => [d.key, d]));
    const conflicts = new Map(this.readConflicts().map((c) => [c.key, c]));

    const ids = new Set<string>([
      ...working.keys(),
      ...committedIds,
      ...baseKeys,
      ...deletions.keys(),
    ]);

    const out: TicketStatus[] = [];
    for (const id of [...ids].sort(compareTicketIds)) {
      const w = working.get(id) ?? null;
      const c = committedIds.has(id) ? this.readCommitted(id) : null;
      const base = id.startsWith("@") ? null : this.readBase(id);
      const del = deletions.get(id);
      const summary = w?.ticket.summary ?? c?.ticket.summary ?? base?.ticket.summary ?? "";

      if (conflicts.has(id)) {
        const cf = conflicts.get(id)!;
        out.push({ id, state: "conflict", summary, detail: `fields: ${cf.fields.join(", ")}` });
        continue;
      }
      if (del) {
        out.push({
          id,
          state: del.committed ? "deleted+committed" : "deleted",
          summary: del.summary,
        });
        continue;
      }
      if (!w && base) {
        out.push({
          id,
          state: "missing",
          summary,
          detail: "working file was deleted by hand — run `jt rm` (delete in Jira) or `jt untrack`",
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
