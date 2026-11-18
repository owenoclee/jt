/**
 * The inbox: every open proposal in every workspace, on one page — the place the
 * reviewer goes when they get to it. Built from local state alone; nothing here
 * talks to Jira.
 */
import { CSS, escapeHtml } from "./html.ts";
import type { StatusPresentation } from "./meta.ts";

export interface InboxRow {
  /** The workspace's slug, as in the URL. */
  workspace: string;
  project: string;
  name: string;
  title: string;
  status: StatusPresentation;
  tickets: number;
  submittedAt?: string;
  /** Set on a row for a proposal that has been pushed. */
  pushedAt?: string;
  url: string;
  /** One line of extra context: how many comments wait, why it is blocked. */
  detail?: string;
}

export interface InboxModel {
  rows: InboxRow[];
  /** Proposals approved and pushed lately, newest first: where a finished one went. */
  pushed: InboxRow[];
  cspNonce: string;
  /** Registered workspaces whose directory could not be read, by slug. */
  unreadable: string[];
}

function rowHtml(r: InboxRow): string {
  const count = `${r.tickets} ticket${r.tickets === 1 ? "" : "s"}`;
  const when = r.submittedAt
    ? ` · submitted <time datetime="${escapeHtml(r.submittedAt)}">${escapeHtml(r.submittedAt)}</time>`
    : "";
  return `<a class="prow" href="${escapeHtml(r.url)}">
    <span class="prow-main">
      <span class="prow-title">${escapeHtml(r.title)}</span>
      <span class="prow-meta">${escapeHtml(r.workspace)} / <b>${escapeHtml(r.name)}</b> · ${count}${when}${
    r.pushedAt ? ` · pushed <time datetime="${escapeHtml(r.pushedAt)}">${escapeHtml(r.pushedAt)}</time>` : ""
  }${
    r.detail ? ` · ${escapeHtml(r.detail)}` : ""
  }</span>
    </span>
    <span class="pstate pstate-${r.status.tone}">${escapeHtml(r.status.label)}</span>
  </a>`;
}

export function renderInbox(m: InboxModel): string {
  const nonce = ` nonce="${escapeHtml(m.cspNonce)}"`;
  const yours = m.rows.filter((r) => r.status.waitingOn === "you");
  const agents = m.rows.filter((r) => r.status.waitingOn === "agent");
  const section = (title: string, rows: InboxRow[], empty: string) =>
    `<h2 class="inbox-h">${title} <span class="summary">${rows.length}</span></h2>` +
    (rows.length
      ? `<div class="prows">${rows.map(rowHtml).join("\n")}</div>`
      : `<div class="nochange">${empty}</div>`);
  const unreadable = m.unreadable.length
    ? `<div class="banner banner-warn">Could not read ${m.unreadable.length === 1 ? "workspace" : "workspaces"} ${
      escapeHtml(m.unreadable.join(", "))
    } — moved or deleted? Proposals there are not listed.</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>jt proposals${yours.length ? ` (${yours.length})` : ""}</title>
<style${nonce}>${CSS}${INBOX_CSS}</style>
</head>
<body>
<header class="top">
  <h1>Proposals</h1>
  <div class="target">changes to Jira that agents have staged with jt — nothing is sent until you approve it</div>
</header>
${unreadable}
<main>
${section("Awaiting your review", yours, "Nothing is waiting for you.")}
${section("With the agent", agents, "Nothing is waiting on an agent.")}
${m.pushed.length ? section("Pushed in the last week", m.pushed, "") : ""}
</main>
<script${nonce}>
document.querySelectorAll('time[datetime]').forEach((el) => {
  const then = new Date(el.dateTime);
  if (isNaN(then)) return;
  const mins = Math.round((Date.now() - then) / 60000);
  el.title = then.toLocaleString();
  el.textContent = mins < 1 ? 'just now' : mins < 60 ? mins + 'm ago'
    : mins < 1440 ? Math.round(mins / 60) + 'h ago' : Math.round(mins / 1440) + 'd ago';
});
</script>
</body>
</html>`;
}

const INBOX_CSS = `
body { padding-bottom: 24px; }
.inbox-h { font-size: 14px; margin: 22px 0 10px; }
.inbox-h:first-child { margin-top: 4px; }
.prows { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.prow { display: flex; align-items: center; gap: 12px; padding: 11px 14px; color: inherit; text-decoration: none; border-top: 1px solid var(--border); }
.prow:first-child { border-top: none; }
.prow:hover { background: var(--card); }
.prow-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.prow-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prow-meta { color: var(--muted); font-size: 12px; }
.prow .pstate { margin-left: 0; flex-shrink: 0; }
`;
