/**
 * The commit chain: an append-only history of the current changeset, for the review
 * page. Purely presentational/audit metadata — push always compiles from the committed
 * LAYER (tip state); the chain exists so review rounds can be diffed and attributed.
 *
 * Entries are authored by "agent" (jt commit) or "remote" (jt pull rebases — synthetic
 * entries recording that the ground moved under the proposal; they can only ever
 * shrink or block the push payload, never expand it).
 */
import { join } from "@std/path";
import { serializeTicket } from "./canonical.ts";
import type { Store } from "./store.ts";
import type { Ticket } from "./types.ts";

export type ChainSnapshot =
  | { kind: "ticket"; ticket: Ticket }
  | { kind: "deletion"; summary: string };

export interface ChainEntry {
  seq: number;
  author: "agent" | "remote";
  note: string;
  createdAt: string;
  /** Snapshots of the tickets this entry touched (full committed state after the entry). */
  tickets: Record<string, ChainSnapshot>;
}

export interface Chain {
  entries: ChainEntry[];
}

export interface ReviewMarker {
  lastReviewedSeq: number;
  decidedAt: string;
}

function chainPath(store: Store): string {
  return join(store.jiraDir, "chain.json");
}

function markerPath(store: Store): string {
  return join(store.jiraDir, "review-marker.json");
}

export function readChain(store: Store): Chain {
  try {
    return JSON.parse(Deno.readTextFileSync(chainPath(store))) as Chain;
  } catch {
    return { entries: [] };
  }
}

function writeChain(store: Store, chain: Chain): void {
  if (chain.entries.length === 0) {
    try {
      Deno.removeSync(chainPath(store));
    } catch {
      // already gone
    }
    return;
  }
  Deno.writeTextFileSync(chainPath(store), JSON.stringify(chain, null, 2) + "\n");
}

export function appendChainEntry(
  store: Store,
  author: "agent" | "remote",
  note: string,
  tickets: Record<string, ChainSnapshot>,
): ChainEntry | null {
  if (Object.keys(tickets).length === 0) return null;
  const chain = readChain(store);
  const seq = (chain.entries[chain.entries.length - 1]?.seq ?? 0) + 1;
  const entry: ChainEntry = {
    seq,
    author,
    note,
    createdAt: new Date().toISOString(),
    tickets,
  };
  chain.entries.push(entry);
  writeChain(store, chain);
  return entry;
}

/**
 * Remove pushed/abandoned tickets from the chain. Entries left empty disappear;
 * when the whole changeset has drained, the chain and review marker reset.
 */
export function pruneChain(store: Store, ids: string[]): void {
  if (ids.length === 0) return;
  const chain = readChain(store);
  for (const entry of chain.entries) {
    for (const id of ids) delete entry.tickets[id];
  }
  chain.entries = chain.entries.filter((e) => Object.keys(e.tickets).length > 0);
  writeChain(store, chain);
  if (changesetEmpty(store)) resetChain(store);
}

export function resetChain(store: Store): void {
  writeChain(store, { entries: [] });
  try {
    Deno.removeSync(markerPath(store));
  } catch {
    // already gone
  }
}

function changesetEmpty(store: Store): boolean {
  return store.listCommittedIds().length === 0 &&
    !store.readDeletions().some((d) => d.committed);
}

/**
 * The state of a ticket as of a chain seq (inclusive): the latest snapshot at or
 * before `seq`, or null if the ticket hadn't entered the changeset yet.
 */
export function stateAtSeq(chain: Chain, id: string, seq: number): ChainSnapshot | null {
  let found: ChainSnapshot | null = null;
  for (const entry of chain.entries) {
    if (entry.seq > seq) break;
    if (entry.tickets[id]) found = entry.tickets[id];
  }
  return found;
}

export function readReviewMarker(store: Store): ReviewMarker | null {
  try {
    return JSON.parse(Deno.readTextFileSync(markerPath(store))) as ReviewMarker;
  } catch {
    return null;
  }
}

export function writeReviewMarker(store: Store, seq: number): void {
  const marker: ReviewMarker = { lastReviewedSeq: seq, decidedAt: new Date().toISOString() };
  Deno.writeTextFileSync(markerPath(store), JSON.stringify(marker, null, 2) + "\n");
}

/** Snapshot helper: the committed state of `id` right now, as a ChainSnapshot. */
export function currentSnapshot(store: Store, id: string): ChainSnapshot | null {
  const committed = store.readCommitted(id);
  if (committed) return { kind: "ticket", ticket: committed.ticket };
  const deletion = store.readDeletions().find((d) => d.key === id && d.committed);
  if (deletion) return { kind: "deletion", summary: deletion.summary };
  return null;
}

export function snapshotEqual(a: ChainSnapshot | null, b: ChainSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "deletion" || b.kind === "deletion") return true;
  return serializeTicket(a.ticket) === serializeTicket(b.ticket);
}
