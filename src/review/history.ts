/**
 * The history page (jt log --web): every push in the selected window, newest first,
 * grouped by day — how each was approved, which proposal it came from, and what it
 * changed on each ticket. Static and read-only: a file, not a server.
 */
import type { RefContext } from "../refs.ts";
import type { JournalChange, JournalEntry } from "../types.ts";
import { AUTO_HINT, CSS, escapeHtml, renderEntryRows, renderTicketCard } from "./html.ts";

export interface HistoryPageModel {
  entries: JournalEntry[];
  target: { baseUrl: string; project: string };
  /** What the page covers, in words: "today", "since 3d", "latest 10 of 42 pushes". */
  scope: string;
  refs: RefContext;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function approvalHtml(e: JournalEntry): string {
  if (e.autoApproved) {
    return `<span class="h-approval h-auto" title="${escapeHtml(e.autoApproved.settings)}">` +
      `auto-allowed · ${escapeHtml(e.autoApproved.rules.join(", "))}</span>`;
  }
  if (e.review) {
    const secs = (e.review.decideMs / 1000).toFixed(e.review.decideMs < 10_000 ? 1 : 0);
    return `<span class="h-approval h-reviewed">reviewed · approved ${secs}s after serving</span>`;
  }
  return `<span class="h-approval h-unknown">no approval recorded</span>`;
}

function changeHtml(c: JournalChange, m: HistoryPageModel): string {
  const key = c.key ?? c.id;
  const label = key.startsWith("@")
    ? escapeHtml(key)
    : `<a class="ref" href="${escapeHtml(`${m.target.baseUrl}/browse/${key}`)}" target="_blank" rel="noopener">${
      escapeHtml(key)
    }</a>`;
  const wholeAuto = Boolean(c.auto?.includes("*"));
  const outcome = c.applied === "all"
    ? ""
    : `<span class="h-fail">${c.applied === "partial" ? "partially applied" : "not applied"}</span>`;
  let body: string;
  if (c.kind === "update" && c.entries) {
    body = renderEntryRows(c.entries, m.refs, new Set(wholeAuto ? [] : c.auto ?? []));
  } else if (c.kind === "create" && c.ticket) {
    body = renderTicketCard(c.ticket, "create", m.refs);
  } else {
    body = `<div class="${c.kind === "delete" ? "delete" : "archive"}-card">${escapeHtml(c.kind)}</div>`;
  }
  // The shared renderers speak in the review page's future tense; this is the past.
  body = body.replaceAll("new — will be posted", c.applied === "none" ? "comment — not posted" : "comment posted");
  return `<section class="ticket${wholeAuto ? " auto-allowed" : ""}">
    <header>
      <span class="badge badge-${c.kind}">${c.kind}</span>
      <h3>${label} <span class="summary">${escapeHtml(c.summary)}</span></h3>
      ${wholeAuto ? `<span class="auto-tag">${AUTO_HINT}</span>` : ""}
      ${outcome}
    </header>
    <div class="body">${body}</div>
  </section>`;
}

function pushHtml(e: JournalEntry, m: HistoryPageModel): string {
  const failed = e.ops.filter((op) => !op.ok);
  const changes = e.changes
    ? e.changes.map((c) => changeHtml(c, m)).join("\n")
    // Entries written before jt recorded per-ticket changes: the op labels are all
    // there is.
    : `<ul class="h-ops">${e.ops.map((op) => `<li>${escapeHtml(op.label)}</li>`).join("")}</ul>`;
  const failures = failed.map((op) =>
    `<div class="frow warn">✗ ${escapeHtml(op.label)} — ${escapeHtml(op.error ?? "failed")}</div>`
  ).join("");
  return `<article class="h-push">
    <div class="h-head">
      <span class="h-time">${localTime(new Date(e.startedAt))}</span>
      <span class="badge ${e.result === "success" ? "badge-create" : "badge-delete"}">${e.result}</span>
      ${approvalHtml(e)}
      ${e.proposal ? `<span class="chip">proposal ${escapeHtml(e.proposal)}</span>` : ""}
      <span class="h-count">${e.ops.length} op${e.ops.length === 1 ? "" : "s"}</span>
    </div>
    ${failures}
    ${changes}
  </article>`;
}

export function renderHistoryPage(m: HistoryPageModel): string {
  const days = new Map<string, JournalEntry[]>();
  for (const e of m.entries) {
    const day = localDay(new Date(e.startedAt));
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  const auto = m.entries.filter((e) => e.autoApproved).length;
  const body = m.entries.length === 0
    ? `<div class="nochange">nothing was pushed in this window</div>`
    : [...days.entries()].map(([day, entries]) =>
      `<h2 class="h-day">${day} <span class="summary">${entries.length} push${
        entries.length === 1 ? "" : "es"
      }</span></h2>${entries.map((e) => pushHtml(e, m)).join("\n")}`
    ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jt history — ${escapeHtml(m.scope)}</title>
<style>${CSS}${HISTORY_CSS}</style>
</head>
<body class="show-ctx">
<header class="top">
  <h1>jt history — ${escapeHtml(m.scope)}</h1>
  <div class="target">applied to ${escapeHtml(m.target.baseUrl)} · project ${
    escapeHtml(m.target.project)
  } · ${m.entries.length} push${m.entries.length === 1 ? "" : "es"}, ${auto} sent without review</div>
</header>
<main>${body}</main>
</body>
</html>`;
}

const HISTORY_CSS = `
body { padding-bottom: 24px; }
.h-day { font-size: 15px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.h-push { margin-bottom: 22px; }
.h-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 8px; }
.h-time { font: 13px ui-monospace, monospace; }
.h-approval { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
.h-reviewed { background: var(--add-bg); color: var(--add-fg); }
.h-auto { background: var(--info-bg); color: var(--info); }
.h-unknown { color: var(--warn); border: 1px solid var(--warn); }
.h-count { color: var(--muted); font-size: 12px; margin-left: auto; }
.h-fail { color: var(--del-fg); font-size: 12px; margin-left: auto; }
.h-ops { color: var(--muted); font-size: 13px; }
/* Here grey would mislead: an auto-allowed change still happened. Tag it, keep it legible. */
section.ticket.auto-allowed, .auto-rows { opacity: 1; }
`;
