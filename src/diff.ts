/** Field-level ticket diffs and a small LCS line differ for descriptions. */
import { fieldEqual, getField, normalizeTicket, ticketFieldNames } from "./canonical.ts";
import type { CommentEntry, LinkEntry, Ticket } from "./types.ts";

export type DiffEntry =
  | { field: string; kind: "scalar"; from: unknown; to: unknown }
  | { field: "description"; kind: "text"; from: string | null; to: string | null }
  | { field: "labels"; kind: "set"; added: string[]; removed: string[] }
  | { field: "links"; kind: "links"; added: LinkEntry[]; removed: LinkEntry[] }
  | {
    field: "comments";
    kind: "comments";
    added: CommentEntry[];
    editedExisting: CommentEntry[];
    removedExisting: CommentEntry[];
  };

export function diffTickets(from: Ticket, to: Ticket): DiffEntry[] {
  const a = normalizeTicket(from);
  const b = normalizeTicket(to);
  const out: DiffEntry[] = [];
  for (const field of ticketFieldNames(a, b)) {
    if (fieldEqual(a, b, field)) continue;
    if (field === "description") {
      out.push({ field, kind: "text", from: a.description, to: b.description });
    } else if (field === "labels") {
      out.push({
        field,
        kind: "set",
        added: b.labels.filter((l) => !a.labels.includes(l)),
        removed: a.labels.filter((l) => !b.labels.includes(l)),
      });
    } else if (field === "links") {
      const keyOf = (l: LinkEntry) => `${l.type}|${l.to}`;
      const aKeys = new Set(a.links.map(keyOf));
      const bKeys = new Set(b.links.map(keyOf));
      out.push({
        field,
        kind: "links",
        added: b.links.filter((l) => !aKeys.has(keyOf(l))),
        removed: a.links.filter((l) => !bKeys.has(keyOf(l))),
      });
    } else if (field === "comments") {
      out.push({ field, kind: "comments", ...diffComments(a.comments, b.comments) });
    } else {
      out.push({ field, kind: "scalar", from: getField(a, field), to: getField(b, field) });
    }
  }
  return out;
}

export function diffComments(from: CommentEntry[], to: CommentEntry[]): {
  added: CommentEntry[];
  editedExisting: CommentEntry[];
  removedExisting: CommentEntry[];
} {
  const fromById = new Map(from.filter((c) => c.id).map((c) => [c.id!, c]));
  const toById = new Map(to.filter((c) => c.id).map((c) => [c.id!, c]));
  const added = to.filter((c) => !c.id);
  const editedExisting = [...toById.values()].filter((c) => {
    const orig = fromById.get(c.id!);
    return orig !== undefined && orig.body !== c.body;
  });
  const removedExisting = [...fromById.values()].filter((c) => !toById.has(c.id!));
  return { added, editedExisting, removedExisting };
}

export interface LineDiffHunk {
  lines: { op: " " | "+" | "-"; text: string }[];
}

/** Unified-style line diff (LCS), grouped into hunks with `context` lines around changes. */
export function lineDiff(fromText: string, toText: string, context = 2): LineDiffHunk[] {
  const a = fromText.split("\n");
  const b = toText.split("\n");
  const ops = lcsOps(a, b);

  const hunks: LineDiffHunk[] = [];
  let current: LineDiffHunk | null = null;
  let pendingContext: { op: " " | "+" | "-"; text: string }[] = [];
  let trailing = 0;

  for (const op of ops) {
    if (op.op === " ") {
      if (current) {
        if (trailing < context) {
          current.lines.push(op);
          trailing++;
        } else {
          current = null;
          pendingContext = [op];
        }
      } else {
        pendingContext.push(op);
        if (pendingContext.length > context) pendingContext.shift();
      }
    } else {
      if (!current) {
        current = { lines: [...pendingContext] };
        pendingContext = [];
        hunks.push(current);
      }
      current.lines.push(op);
      trailing = 0;
    }
  }
  return hunks;
}

function lcsOps(a: string[], b: string[]): { op: " " | "+" | "-"; text: string }[] {
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: { op: " " | "+" | "-"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: "-", text: a[i] });
      i++;
    } else {
      out.push({ op: "+", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ op: "-", text: a[i++] });
  while (j < n) out.push({ op: "+", text: b[j++] });
  return out;
}
