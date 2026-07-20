/**
 * Self-contained HTML rendering for the review page (jt push --await-user) and the
 * read-only diff view (jt diff --web). Everything is rendered server-side from the
 * tool-owned layers; the page's only dynamism is tab switching, per-ticket decisions,
 * and the single POST that reports them.
 */
import { marked } from "marked";
import { diffTickets } from "../diff.ts";
import { lineDiff } from "../diff.ts";
import type { Ticket } from "../types.ts";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Markdown -> HTML for display. Committed markdown has already passed the mdToAdf
 * subset validation (no raw HTML constructs), and remote-sourced markdown comes from
 * adfToMd which escapes tag-like text — but escape defensively anyway by rendering
 * with marked and stripping is unnecessary; instead we rely on marked's encoding of
 * code spans plus the subset guarantee.
 */
export function mdToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

export interface TicketSection {
  id: string;
  title: string;
  html: string;
}

export interface ReviewPageModel {
  mode: "review" | "readonly";
  title: string;
  target: { baseUrl: string; project: string };
  tickets: {
    id: string;
    summary: string;
    kind: "create" | "update" | "delete";
    dependsOn: string[];
    diffHtml: string;
    opsJson: string;
  }[];
  commits: {
    seq: number;
    author: string;
    note: string;
    createdAt: string;
    sections: TicketSection[];
  }[];
  sinceReview: { fromSeq: number; sections: TicketSection[] } | null;
  nonce: string;
  timeoutMs: number;
}

/** Full diff of a ticket between two states (null = doesn't exist on that side). */
export function renderTicketDelta(from: Ticket | null, to: Ticket | null): string {
  if (!from && !to) return "";
  if (!from && to) return renderTicketCard(to, "create");
  if (from && !to) return `<div class="delete-card">staged deletion of <b>${escapeHtml(from.summary)}</b></div>`;
  const entries = diffTickets(from!, to!);
  if (entries.length === 0) return `<div class="nochange">no changes</div>`;
  const rows: string[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case "scalar":
        rows.push(
          `<div class="frow"><span class="fname">${escapeHtml(e.field)}</span>` +
            `<span class="old">${fmt(e.from)}</span><span class="arrow">→</span>` +
            `<span class="new">${fmt(e.to)}</span></div>`,
        );
        break;
      case "set": {
        const chips = [
          ...e.added.map((l) => `<span class="chip add">+${escapeHtml(l)}</span>`),
          ...e.removed.map((l) => `<span class="chip del">−${escapeHtml(l)}</span>`),
        ].join(" ");
        rows.push(`<div class="frow"><span class="fname">${escapeHtml(e.field)}</span>${chips}</div>`);
        break;
      }
      case "links":
        for (const l of e.added) {
          rows.push(
            `<div class="frow"><span class="fname">links</span><span class="chip add">+ ${
              escapeHtml(l.type)
            } ${escapeHtml(l.to)}</span></div>`,
          );
        }
        for (const l of e.removed) {
          rows.push(
            `<div class="frow"><span class="fname">links</span><span class="chip del">− ${
              escapeHtml(l.type)
            } ${escapeHtml(l.to)}</span></div>`,
          );
        }
        break;
      case "comments":
        for (const c of e.added) {
          rows.push(
            `<div class="frow"><span class="fname">comment</span>` +
              `<div class="comment new-comment"><div class="comment-tag">new — will be posted</div>${
                mdToHtml(c.body)
              }</div></div>`,
          );
        }
        for (const c of e.editedExisting) {
          rows.push(
            `<div class="frow warn">existing comment ${escapeHtml(c.id ?? "?")} edited — unsupported</div>`,
          );
        }
        for (const c of e.removedExisting) {
          rows.push(
            `<div class="frow warn">existing comment ${escapeHtml(c.id ?? "?")} removed — unsupported</div>`,
          );
        }
        break;
      case "text": {
        const hunks = lineDiff(e.from ?? "", e.to ?? "");
        const lines = hunks.map((h) =>
          h.lines.map((l) => {
            const cls = l.op === "+" ? "dl-add" : l.op === "-" ? "dl-del" : "dl-ctx";
            return `<div class="dl ${cls}"><span class="dl-op">${l.op}</span>${escapeHtml(l.text) || "&nbsp;"}</div>`;
          }).join("")
        ).join(`<div class="dl dl-sep">⋮</div>`);
        rows.push(
          `<div class="frow"><span class="fname">description</span><div class="descdiff">${lines}</div></div>`,
        );
        break;
      }
    }
  }
  return rows.join("\n");
}

export function renderTicketCard(t: Ticket, badge: string): string {
  const row = (k: string, v: string) =>
    `<div class="frow"><span class="fname">${escapeHtml(k)}</span><span>${v}</span></div>`;
  const rows: string[] = [];
  rows.push(row("project", `${escapeHtml(t.project)} / ${escapeHtml(t.type)}`));
  if (t.status) rows.push(row("status", escapeHtml(t.status)));
  if (t.labels.length) {
    rows.push(row("labels", t.labels.map((l) => `<span class="chip">${escapeHtml(l)}</span>`).join(" ")));
  }
  if (t.parent) rows.push(row("parent", escapeHtml(t.parent)));
  if (t.sprint !== null) rows.push(row("sprint", escapeHtml(String(t.sprint))));
  if (t.assignee) rows.push(row("assignee", escapeHtml(t.assignee)));
  if (t.priority) rows.push(row("priority", escapeHtml(t.priority)));
  for (const [k, v] of Object.entries(t.fields)) {
    if (v !== null) rows.push(row(k, escapeHtml(JSON.stringify(v))));
  }
  for (const l of t.links) rows.push(row("link", `${escapeHtml(l.type)} ${escapeHtml(l.to)}`));
  const desc = t.description !== null
    ? `<div class="desc md">${mdToHtml(t.description)}</div>`
    : "";
  const comments = t.comments.map((c) =>
    `<div class="comment ${c.id ? "" : "new-comment"}">` +
    (c.id
      ? `<div class="comment-tag">${escapeHtml(c.author ?? "?")} · ${escapeHtml(c.created ?? "")}</div>`
      : `<div class="comment-tag">new — will be posted</div>`) +
    mdToHtml(c.body) + `</div>`
  ).join("");
  return `<div class="create-card"><span class="badge badge-${badge}">${badge}</span>${rows.join("")}${desc}${comments}</div>`;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return `<i class="none">none</i>`;
  return escapeHtml(typeof v === "string" ? v : JSON.stringify(v));
}

export function renderPage(model: ReviewPageModel): string {
  const isReview = model.mode === "review";
  const ticketCards = model.tickets.map((t) => {
    const deps = t.dependsOn.length
      ? `<span class="deps" data-deps="${escapeHtml(t.dependsOn.join(","))}">needs ${
        escapeHtml(t.dependsOn.join(", "))
      }</span>`
      : "";
    const decision = isReview
      ? `<div class="decision" data-ticket="${escapeHtml(t.id)}">
          <label class="approve-lbl"><input type="radio" name="d-${escapeHtml(t.id)}" value="approve" checked> approve</label>
          <label class="reject-lbl"><input type="radio" name="d-${escapeHtml(t.id)}" value="reject"> reject</label>
          <input type="text" class="note" placeholder="note for the agent (optional, sent on reject)">
        </div>`
      : "";
    return `<section class="ticket" id="t-${escapeHtml(t.id)}" data-id="${escapeHtml(t.id)}" data-deps="${
      escapeHtml(t.dependsOn.join(","))
    }">
      <header>
        <span class="badge badge-${t.kind}">${t.kind}</span>
        <h3>${escapeHtml(t.id)} <span class="summary">${escapeHtml(t.summary)}</span></h3>
        ${deps}
      </header>
      ${decision}
      <div class="body">${t.diffHtml}</div>
      ${
      t.opsJson
        ? `<details class="ops"><summary>compiled API operations</summary><pre>${
          escapeHtml(t.opsJson)
        }</pre></details>`
        : ""
    }
    </section>`;
  }).join("\n");

  const commitTabs = model.commits.map((c) =>
    `<button class="tab" data-tab="commit-${c.seq}">
      <span class="c-seq">#${c.seq}</span> <span class="c-author c-${c.author}">${c.author}</span>
      <span class="c-note">${escapeHtml(c.note)}</span>
    </button>`
  ).join("");

  const commitPanels = model.commits.map((c) =>
    `<div class="panel" id="commit-${c.seq}" hidden>
      <div class="panel-note">Round delta — what <b>${c.author}</b> changed in “${
      escapeHtml(c.note)
    }” (${escapeHtml(c.createdAt)}). ${
      isReview ? "Approval always applies to the full proposed state, not this delta." : ""
    }</div>
      ${
      c.sections.map((s) =>
        `<section class="ticket"><header><h3>${escapeHtml(s.title)}</h3></header><div class="body">${s.html}</div></section>`
      ).join("")
    }
    </div>`
  ).join("");

  const sinceTab = model.sinceReview
    ? `<button class="tab" data-tab="since-review">since your last review</button>`
    : "";
  const sincePanel = model.sinceReview
    ? `<div class="panel" id="since-review" hidden>
        <div class="panel-note">Everything that changed since you last reviewed (commit #${model.sinceReview.fromSeq}).</div>
        ${
      model.sinceReview.sections.map((s) =>
        `<section class="ticket"><header><h3>${escapeHtml(s.title)}</h3></header><div class="body">${s.html}</div></section>`
      ).join("")
    }
      </div>`
    : "";

  const footer = isReview
    ? `<footer class="sendbar">
        <span id="count"></span>
        <span id="countdown"></span>
        <button id="send">Send decisions</button>
      </footer>`
    : "";

  const reviewJs = isReview
    ? `
    const nonce = ${JSON.stringify(model.nonce)};
    const deadline = Date.now() + ${model.timeoutMs};
    const tickets = [...document.querySelectorAll('section.ticket[data-id]')];
    function decisions() {
      const out = {};
      for (const t of tickets) {
        const id = t.dataset.id;
        const approve = t.querySelector('input[value="approve"]').checked;
        const note = t.querySelector('.note').value;
        out[id] = { approve, note };
      }
      return out;
    }
    function refresh() {
      const d = decisions();
      // dependency enforcement: reject cascades to dependents
      let changed = true;
      while (changed) {
        changed = false;
        for (const t of tickets) {
          const deps = (t.dataset.deps || '').split(',').filter(Boolean);
          const id = t.dataset.id;
          if (d[id].approve && deps.some((x) => d[x] && !d[x].approve)) {
            d[id].approve = false;
            t.querySelector('input[value="reject"]').checked = true;
            t.classList.add('dep-blocked');
            changed = true;
          }
        }
      }
      for (const t of tickets) {
        t.classList.toggle('rejected', !d[t.dataset.id].approve);
        if (d[t.dataset.id].approve) t.classList.remove('dep-blocked');
      }
      const n = Object.values(d).filter((x) => x.approve).length;
      document.getElementById('count').textContent = n + '/' + tickets.length + ' approved';
    }
    document.addEventListener('change', refresh);
    refresh();
    setInterval(() => {
      const left = Math.max(0, deadline - Date.now());
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      document.getElementById('countdown').textContent =
        left > 0 ? 'times out in ' + m + 'm ' + String(s).padStart(2, '0') + 's' : 'timed out';
    }, 500);
    document.getElementById('send').addEventListener('click', async () => {
      refresh();
      const res = await fetch('/decide/' + nonce, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: decisions() }),
      });
      document.body.innerHTML = res.ok
        ? '<div class="done">Decisions sent — jt is pushing the approved tickets. You can close this tab and return to your session.</div>'
        : '<div class="done">Something went wrong (' + res.status + '). Check the terminal.</div>';
    });`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <h1>${escapeHtml(model.title)}</h1>
  <div class="target">→ ${escapeHtml(model.target.baseUrl)} · project ${escapeHtml(model.target.project)}</div>
</header>
<nav class="tabs">
  <button class="tab active" data-tab="changes">changes (${model.tickets.length})</button>
  ${sinceTab}
  ${commitTabs}
</nav>
<main>
  <div class="panel" id="changes">${ticketCards}</div>
  ${sincePanel}
  ${commitPanels}
</main>
${footer}
<script>
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.hidden = true);
  b.classList.add('active');
  document.getElementById(b.dataset.tab).hidden = false;
}));
${reviewJs}
</script>
</body>
</html>`;
}

const CSS = `
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --border: #d1d9e0;
  --card: #f6f8fa; --add-bg: #dafbe1; --add-fg: #116329; --del-bg: #ffebe9; --del-fg: #82071e;
  --accent: #0969da; --warn: #9a6700;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --border: #30363d;
    --card: #161b22; --add-bg: #12261e; --add-fg: #3fb950; --del-bg: #25171c; --del-fg: #f85149;
    --accent: #4493f8; --warn: #d29922;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding-bottom: 70px;
}
.top { padding: 16px 20px 8px; }
.top h1 { margin: 0; font-size: 18px; }
.target { color: var(--muted); font-size: 12px; margin-top: 2px; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 20px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 5; }
.tab { background: none; border: 1px solid transparent; color: var(--muted); padding: 5px 10px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 13px; max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab:hover { background: var(--card); }
.tab.active { color: var(--fg); border-color: var(--border); background: var(--card); }
.c-seq { color: var(--muted); }
.c-author { font-weight: 600; }
.c-agent { color: var(--accent); }
.c-remote { color: var(--warn); }
main { padding: 16px 20px; max-width: 980px; margin: 0 auto; }
.panel-note { color: var(--muted); font-size: 13px; margin-bottom: 12px; }
section.ticket { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
section.ticket > header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--card); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
section.ticket h3 { margin: 0; font-size: 14px; }
.summary { font-weight: 400; color: var(--muted); }
.badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; }
.badge-create { background: var(--add-bg); color: var(--add-fg); }
.badge-update { background: var(--card); color: var(--accent); border: 1px solid var(--border); }
.badge-delete { background: var(--del-bg); color: var(--del-fg); }
.deps { font-size: 11px; color: var(--warn); }
.body { padding: 12px 14px; }
.frow { display: flex; gap: 10px; align-items: baseline; padding: 3px 0; flex-wrap: wrap; }
.fname { color: var(--muted); min-width: 90px; font-size: 12px; }
.old { color: var(--del-fg); text-decoration: line-through; }
.new { color: var(--add-fg); }
.arrow { color: var(--muted); }
.none { color: var(--muted); }
.chip { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; font-size: 12px; }
.chip.add { background: var(--add-bg); color: var(--add-fg); border-color: transparent; }
.chip.del { background: var(--del-bg); color: var(--del-fg); border-color: transparent; }
.descdiff { flex-basis: 100%; border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; font: 12px/1.6 ui-monospace, monospace; }
.dl { padding: 0 8px; white-space: pre-wrap; }
.dl-op { display: inline-block; width: 14px; color: var(--muted); }
.dl-add { background: var(--add-bg); color: var(--add-fg); }
.dl-del { background: var(--del-bg); color: var(--del-fg); }
.dl-ctx { color: var(--muted); }
.dl-sep { color: var(--muted); text-align: center; }
.desc.md, .comment { border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; margin-top: 8px; }
.comment-tag { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.new-comment { border-color: var(--add-fg); }
.md pre, .comment pre { background: var(--card); padding: 8px; border-radius: 6px; overflow-x: auto; }
.md code, .comment code { background: var(--card); padding: 1px 4px; border-radius: 4px; }
.create-card .badge { float: right; }
.delete-card { background: var(--del-bg); color: var(--del-fg); padding: 10px 14px; border-radius: 6px; }
.nochange { color: var(--muted); }
.frow.warn { color: var(--warn); }
details.ops { border-top: 1px solid var(--border); padding: 8px 14px; }
details.ops summary { cursor: pointer; color: var(--muted); font-size: 12px; }
details.ops pre { font-size: 11px; overflow-x: auto; }
.decision { display: flex; gap: 14px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--bg); }
.approve-lbl { color: var(--add-fg); }
.reject-lbl { color: var(--del-fg); }
.decision .note { flex: 1; background: var(--card); border: 1px solid var(--border); color: var(--fg); border-radius: 6px; padding: 4px 8px; font: inherit; font-size: 12px; }
section.ticket.rejected .body, section.ticket.rejected details.ops { opacity: 0.45; }
section.ticket.dep-blocked > header { outline: 1px solid var(--warn); }
.sendbar { position: fixed; bottom: 0; left: 0; right: 0; display: flex; gap: 16px; align-items: center; justify-content: flex-end; padding: 12px 20px; background: var(--card); border-top: 1px solid var(--border); }
#count, #countdown { color: var(--muted); font-size: 13px; }
#send { background: var(--add-fg); color: #fff; border: none; border-radius: 6px; padding: 8px 18px; font: inherit; font-weight: 600; cursor: pointer; }
#send:hover { filter: brightness(1.1); }
.done { display: flex; align-items: center; justify-content: center; height: 80vh; font-size: 16px; color: var(--muted); padding: 20px; text-align: center; }
`;
