/** Terminal renderers for status, diffs, tickets, and the push journal. */
import { bold, cyan, dim, green, red, yellow } from "./colors.ts";
import type { DiffEntry } from "../diff.ts";
import { lineDiff } from "../diff.ts";
import { NO_REFS, type RefContext } from "../refs.ts";
import type { JournalEntry, Ticket, TicketStatus } from "../types.ts";

export function renderStatus(statuses: TicketStatus[], opts: { all?: boolean } = {}): string {
  if (statuses.length === 0) return "no tracked tickets — run: jt pull, jt fetch <KEY...> or jt new";
  const shown = opts.all ? statuses : statuses.filter((s) => s.state !== "clean");
  const lines: string[] = [];
  if (shown.length > 0) {
    const width = Math.max(...shown.map((s) => s.id.length));
    for (const s of shown) {
      const badge = stateBadge(s.state);
      const id = s.id.padEnd(width);
      const detail = s.detail ? `  ${dim(`(${s.detail})`)}` : "";
      lines.push(`  ${badge}  ${bold(id)}  ${s.summary}${detail}`);
    }
    lines.push("");
  }
  const pushable = statuses.filter((s) =>
    ["committed", "new+committed", "deleted+committed"].includes(s.state)
  ).length;
  const dirty = statuses.filter((s) =>
    ["modified", "new", "deleted", "committed+modified", "new+committed+modified"].includes(s.state)
  ).length;
  const hidden = statuses.length - shown.length;
  lines.push(
    dim(
      `${statuses.length} tracked · ${dirty} with uncommitted changes · ${pushable} ready to push` +
        (hidden > 0 ? ` · ${hidden} clean (jt status --all to list)` : ""),
    ),
  );
  return lines.join("\n");
}

function stateBadge(state: TicketStatus["state"]): string {
  switch (state) {
    case "clean":
      return dim("clean    ");
    case "modified":
      return yellow("modified ");
    case "committed":
      return green("committed");
    case "committed+modified":
      return yellow("cmt+mod  ");
    case "new":
      return cyan("new      ");
    case "new+committed":
      return green("new+cmt  ");
    case "new+committed+modified":
      return yellow("new+mod  ");
    case "deleted":
      return red("deleted  ");
    case "deleted+committed":
      return red("del+cmt  ");
    case "missing":
      return red("missing! ");
    case "conflict":
      return red("CONFLICT ");
  }
}

export function renderDiffEntries(
  id: string,
  summary: string,
  entries: DiffEntry[],
  refs: RefContext = NO_REFS,
): string {
  const lines: string[] = [`${bold(id)}  ${summary}`];
  for (const e of entries) {
    switch (e.kind) {
      case "scalar": {
        const val = (v: unknown) =>
          e.field === "parent" && typeof v === "string" ? fmtRef(v, refs) : fmtValue(v);
        lines.push(`  ${cyan(e.field)}: ${val(e.from)} ${dim("→")} ${val(e.to)}`);
        break;
      }
      case "set": {
        const parts = [
          ...e.added.map((l) => green(`+${l}`)),
          ...e.removed.map((l) => red(`-${l}`)),
        ];
        lines.push(`  ${cyan(e.field)}: ${parts.join(" ")}`);
        break;
      }
      case "links":
        for (const l of e.added) {
          lines.push(`  ${cyan("links")}: ${green(`+ ${l.type} ${fmtRef(l.to, refs)}`)}`);
        }
        for (const l of e.removed) {
          lines.push(`  ${cyan("links")}: ${red(`- ${l.type} ${fmtRef(l.to, refs)}`)}`);
        }
        break;
      case "comments":
        for (const c of e.added) {
          lines.push(`  ${cyan("comments")}: ${green("+ (new)")} ${firstLine(c.body)}`);
        }
        for (const c of e.editedExisting) {
          lines.push(
            `  ${cyan("comments")}: ${red(`! existing comment ${c.id} edited (unsupported — revert it)`)}`,
          );
        }
        for (const c of e.removedExisting) {
          lines.push(
            `  ${cyan("comments")}: ${red(`! existing comment ${c.id} removed (unsupported — restore it)`)}`,
          );
        }
        break;
      case "text": {
        lines.push(`  ${cyan("description")}:`);
        const hunks = lineDiff(e.from ?? "", e.to ?? "");
        for (const h of hunks) {
          for (const l of h.lines) {
            const text = `    ${l.op} ${l.text}`;
            lines.push(l.op === "+" ? green(text) : l.op === "-" ? red(text) : dim(text));
          }
          lines.push(dim("    ⋮"));
        }
        if (hunks.length > 0) lines.pop();
        break;
      }
    }
  }
  return lines.join("\n");
}

function firstLine(s: string): string {
  const line = s.split("\n")[0];
  return line.length > 80 ? line.slice(0, 77) + "..." : line;
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return dim("(none)");
  if (typeof v === "string") return JSON.stringify(v);
  return JSON.stringify(v);
}

/** A ticket reference: the key, plus its summary in parens when locally known. */
function fmtRef(id: string, refs: RefContext): string {
  const summary = refs.summaryOf(id);
  return summary ? `${id} ${dim(`(${summary})`)}` : id;
}

export function renderTicket(t: Ticket, label?: string, refs: RefContext = NO_REFS): string {
  const lines: string[] = [];
  const head = t.key ? `${bold(t.key)}  ${t.summary}` : `${cyan("(new)")}  ${t.summary}`;
  lines.push(label ? `${head}  ${dim(`[${label}]`)}` : head);
  const row = (k: string, v: string) => lines.push(`  ${dim(k.padEnd(10))} ${v}`);
  row("project", `${t.project} / ${t.type}`);
  if (t.status) row("status", t.status);
  row("labels", t.labels.length ? t.labels.join(", ") : dim("(none)"));
  row("parent", t.parent ? fmtRef(t.parent, refs) : dim("(none)"));
  row("sprint", t.sprint === null ? dim("(backlog)") : String(t.sprint));
  row("assignee", t.assignee ?? dim("(unassigned)"));
  row("priority", t.priority ?? dim("(none)"));
  if (t.updated) row("updated", dim(t.updated));
  for (const [k, v] of Object.entries(t.fields)) {
    row(k, v === null ? dim("(none)") : JSON.stringify(v));
  }
  for (const l of t.links) row("link", `${l.type} ${fmtRef(l.to, refs)}`);
  if (t.description !== null) {
    lines.push("");
    if (t.descriptionLossy) {
      lines.push(yellow("  (description contains content outside the markdown subset — lossy view)"));
    }
    lines.push(indent(t.description, "  "));
  }
  for (const c of t.comments) {
    lines.push("");
    const who = c.id ? `${c.author ?? "?"} · ${c.created ?? ""}` : green("(new — will be posted)");
    lines.push(`  ${dim("comment")} ${who}`);
    lines.push(indent(c.body, "    "));
  }
  return lines.join("\n");
}

function indent(text: string, pad: string): string {
  return text.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

export function renderJournalEntry(path: string, e: JournalEntry): string {
  const lines: string[] = [];
  const badge = e.result === "success"
    ? green(e.result)
    : e.result === "dry-run"
    ? cyan(e.result)
    : red(e.result);
  lines.push(`${bold(e.startedAt)}  ${badge}  ${dim(path)}`);
  for (const op of e.ops) {
    const status = op.ok ? green(String(op.status ?? "ok")) : red(String(op.status ?? "ERR"));
    lines.push(`  ${status}  ${op.method.padEnd(6)} ${op.path}  ${dim(op.label)}`);
    if (!op.ok && op.error) lines.push(`         ${red(op.error)}`);
  }
  if (e.created && Object.keys(e.created).length) {
    lines.push(
      `  ${dim("created:")} ${
        Object.entries(e.created).map(([ref, key]) => `${ref} → ${key}`).join(", ")
      }`,
    );
  }
  return lines.join("\n");
}
