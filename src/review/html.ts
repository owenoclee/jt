/**
 * Self-contained HTML rendering for the review page (jt push) and the
 * read-only diff view (jt diff --web). Everything is rendered server-side from the
 * tool-owned layers; the page's only dynamism is tab switching, per-ticket decisions,
 * and the single POST that reports them.
 */
import { Marked } from "marked";
import { type DiffEntry, diffTickets } from "../diff.ts";
import { lineDiff } from "../diff.ts";
import { intentNoun } from "../intents.ts";
import { NO_REFS, type RefContext } from "../refs.ts";
import type { IntentMode, ReviewComment, Ticket } from "../types.ts";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SAFE_LINK = /^(https?:|mailto:)/i;

const safeMarkdown = new Marked({
  renderer: {
    // Raw HTML is shown as the text it is, never handed to the browser.
    html(token) {
      return escapeHtml(token.text);
    },
    // Only links that go somewhere on the web keep their href; anything else
    // (javascript:, data:, a relative path into this server) is left as its text.
    link(token) {
      if (SAFE_LINK.test(token.href.trim())) return false;
      return this.parser.parseInline(token.tokens);
    },
    image(token) {
      return escapeHtml(token.text || token.href);
    },
  },
});

/**
 * Markdown -> HTML for display, safe to put on a page that can approve a push.
 *
 * What is rendered here is not all jt's own: a ticket's description comes from Jira
 * as whoever last edited it left it, and reaches a review page unvalidated on delete
 * and archive cards and in copies rebased onto a remote edit. Every proposal's page
 * shares one origin, so markup that ran as script in one could act on any of them.
 * Raw HTML is therefore escaped and link targets are allowlisted; the server's
 * Content-Security-Policy is the second line, not the only one.
 */
export function mdToHtml(md: string): string {
  return safeMarkdown.parse(md, { async: false }) as string;
}

export interface TicketSection {
  id: string;
  summary: string;
  html: string;
}

/** A ticket reference as HTML: the key linked to Jira, plus its summary when known. */
function refHtml(id: string, refs: RefContext): string {
  const url = refs.browseUrl(id);
  const key = url
    ? `<a class="ref" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(id)}</a>`
    : escapeHtml(id);
  const summary = refs.summaryOf(id);
  return summary ? `${key} <span class="refsum">${escapeHtml(summary)}</span>` : key;
}

export interface ReviewPageModel {
  /**
   * "review" = decision page (approve/request), "readonly" = static diff/show,
   * "info" = upstream news (jt changes --web): purple-badged glance page whose only
   * action is Acknowledge — nothing is ever sent from it.
   */
  mode: "review" | "readonly" | "info";
  title: string;
  target: { baseUrl: string; project: string };
  tickets: {
    id: string;
    summary: string;
    kind:
      | "create"
      | "update"
      | "delete"
      | "archive"
      | "unarchive"
      | "view"
      | "new"
      | "changed"
      | "gone"
      | "conflict";
    /** Byte-identical to what the user saw at their last review — collapsed by default. */
    unchangedSinceReview: boolean;
    /** Every change on this ticket is auto-allowed by the user's settings: greyed out. */
    autoAllowed?: boolean;
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
  /** Info pages only — drives the expiry countdown. Review pages never expire. */
  timeoutMs?: number;
  /** Set on a proposal's own page on the review server: its header, and what the
      page may do. */
  proposal?: ProposalHeader;
  /** The nonce in this response's Content-Security-Policy, for the inline style and
      script. Pages written to disk have no policy and no nonce. */
  cspNonce?: string;
}

/** What a proposal's page says about the proposal itself, above its changes. */
export interface ProposalHeader {
  name: string;
  /** The workspace's short name on the review server. */
  workspace: string;
  title: string;
  /** The author's description, already rendered to safe HTML. */
  descriptionHtml: string;
  status: { label: string; tone: "wait" | "ok" | "warn" | "error" | "muted" };
  submittedAt?: string;
  /** Plain-text notices under the header: what was absorbed from Jira, what blocks. */
  banners: { tone: "info" | "warn" | "error"; text: string }[];
  /** Review comments already made, shown where they were made: under their ticket,
      or under the description for a comment on the proposal as a whole. */
  comments?: { label: string; items: ReviewComment[] };
  inboxUrl: string;
  /** Present when this view may decide: where to POST, and the token binding the
      decision to exactly what was rendered. */
  decide?: { url: string; token: string };
  /** Present when the page should ask the server to check the proposal against Jira.
      `tag` is the state this page shows, so the server can say whether it moved. */
  refresh?: { url: string; csrf: string; tag: string };
}

/**
 * Full diff of a ticket between two states (null = doesn't exist on that side). A
 * whole-issue intent has no "to" state: `intent` says which one, so the card can name
 * it — a deletion and an archiving are not the same promise.
 */
export function renderTicketDelta(
  from: Ticket | null,
  to: Ticket | null,
  refs: RefContext = NO_REFS,
  intent?: { mode: IntentMode; summary?: string },
  autoFields?: Set<string>,
): string {
  if (!from && to) return renderTicketCard(to, "create", refs);
  if (!to && intent) {
    const summary = from?.summary ?? intent.summary ?? "";
    const card = `<div class="${intent.mode === "delete" ? "delete" : "archive"}-card">staged ${
      intentNoun(intent.mode)
    }${summary ? ` of <b>${escapeHtml(summary)}</b>` : ""}</div>`;
    return card + (from ? renderFieldRows(from, [], refs) : "");
  }
  if (!from && !to) return "";
  if (from && !to) {
    return `<div class="delete-card">staged deletion of <b>${escapeHtml(from.summary)}</b></div>` +
      renderFieldRows(from, [], refs);
  }
  const entries = diffTickets(from!, to!);
  if (entries.length === 0) return `<div class="nochange">no changes</div>`;
  return renderFieldRows(to!, entries, refs, autoFields);
}

/**
 * One flat field list per card, always in the same canonical order — changed fields
 * render their diff with a bold name, untouched ones render as muted context rows.
 * Interleaving in a fixed order (rather than a changed/unchanged split) lets a
 * reviewer learn where each field lives on the card. Context rows carry
 * data-ctx-field for the ⚙ panel and stay hidden until its script applies the saved
 * preferences.
 *
 * The one exception to the fixed order: changes the user's settings auto-allow
 * (`autoFields`) leave their slot and gather at the bottom, greyed out under a hint —
 * so what is left in place is precisely what still needs a decision.
 */
export function renderFieldRows(
  t: Ticket,
  entries: DiffEntry[],
  refs: RefContext = NO_REFS,
  autoFields: Set<string> = new Set(),
): string {
  const byField = new Map<string, DiffEntry>(entries.map((e) => [e.field, e]));
  const rows: string[] = [];
  const autoRows: string[] = [];
  const none = (label = "none") => `<i class="none">${label}</i>`;
  const ctx = (field: string, html: string, block = false) =>
    rows.push(
      `<div class="frow ctx" data-ctx-field="${escapeHtml(field)}">` +
        `<span class="fname">${escapeHtml(field)}</span>` +
        (block ? html : `<span class="ctxval">${html}</span>`) +
        `</div>`,
    );
  // Renders the diff rows at this field's canonical slot; reports whether it was changed.
  const changed = (field: string): boolean => {
    const e = byField.get(field);
    if (e) (autoFields.has(field) ? autoRows : rows).push(...changedRows(e, refs));
    return e !== undefined;
  };

  changed("project");
  changed("summary"); // unchanged summary lives in the card header
  if (!changed("type")) ctx("type", escapeHtml(t.type));
  if (!changed("status") && t.status) ctx("status", escapeHtml(t.status));
  if (!changed("labels")) {
    ctx(
      "labels",
      t.labels.length
        ? t.labels.map((l) => `<span class="chip">${escapeHtml(l)}</span>`).join(" ")
        : none(),
    );
  }
  if (!changed("parent")) ctx("parent", t.parent ? refHtml(t.parent, refs) : none());
  if (!changed("sprint")) {
    ctx("sprint", t.sprint === null ? none("backlog") : escapeHtml(String(t.sprint)));
  }
  if (!changed("assignee")) {
    ctx("assignee", t.assignee ? escapeHtml(t.assignee) : none("unassigned"));
  }
  if (!changed("priority")) ctx("priority", t.priority ? escapeHtml(t.priority) : none());
  const aliases = new Set([
    ...Object.keys(t.fields),
    ...[...byField.keys()]
      .filter((f) => f.startsWith("fields."))
      .map((f) => f.slice("fields.".length)),
  ]);
  for (const alias of [...aliases].sort()) {
    if (changed(`fields.${alias}`)) continue;
    const v = t.fields[alias];
    ctx(
      alias,
      v === null || v === undefined
        ? none()
        : escapeHtml(typeof v === "string" ? v : JSON.stringify(v)),
    );
  }
  if (!changed("links") && t.links.length) {
    ctx(
      "links",
      t.links
        .map((l) => `<span class="chip">${escapeHtml(l.type)} ${refHtml(l.to, refs)}</span>`)
        .join(" "),
    );
  }
  if (!changed("description") && t.description !== null) {
    ctx("description", `<div class="desc md ctxval">${mdToHtml(t.description)}</div>`, true);
  }
  changed("comments"); // existing comments are never context — only diffs render
  if (autoRows.length) {
    rows.push(`<div class="auto-rows"><div class="auto-hint">${AUTO_HINT}</div>${autoRows.join("\n")}</div>`);
  }
  return rows.join("\n");
}

export const AUTO_HINT = "auto-allowed based on your configuration";

/** The diff rows for a recorded delta alone, no ticket around them (jt log --web). */
export function renderEntryRows(
  entries: DiffEntry[],
  refs: RefContext = NO_REFS,
  autoFields: Set<string> = new Set(),
): string {
  const rows = entries.filter((e) => !autoFields.has(e.field)).flatMap((e) => changedRows(e, refs));
  const auto = entries.filter((e) => autoFields.has(e.field)).flatMap((e) => changedRows(e, refs));
  if (auto.length) {
    rows.push(`<div class="auto-rows"><div class="auto-hint">${AUTO_HINT}</div>${auto.join("\n")}</div>`);
  }
  return rows.join("\n");
}

/** Card body for a ticket that left the changeset without being pushed. */
export function renderWithdrawnCard(context: "commit" | "since"): string {
  const msg = context === "since"
    ? "withdrawn since your last review — the proposed change you reviewed is no longer " +
      "part of the changeset and will not be sent"
    : "withdrawn — no longer part of the changeset; nothing will be sent for this ticket";
  return `<div class="withdrawn-card">${msg}</div>`;
}

/** The diff rows for one changed field (bold name via .chg). */
function changedRows(e: DiffEntry, refs: RefContext): string[] {
  const rows: string[] = [];
  const display = e.field.startsWith("fields.") ? e.field.slice("fields.".length) : e.field;
  const name = `<span class="fname">${escapeHtml(display)}</span>`;
  switch (e.kind) {
    case "scalar": {
      const val = (v: unknown) =>
        e.field === "parent" && typeof v === "string" ? refHtml(v, refs) : fmt(v);
      rows.push(
        `<div class="frow chg">${name}` +
          `<span class="old">${val(e.from)}</span><span class="arrow">→</span>` +
          `<span class="new">${val(e.to)}</span></div>`,
      );
      break;
    }
    case "set": {
      const chips = [
        ...e.added.map((l) => `<span class="chip add">+${escapeHtml(l)}</span>`),
        ...e.removed.map((l) => `<span class="chip del">−${escapeHtml(l)}</span>`),
      ].join(" ");
      rows.push(`<div class="frow chg">${name}${chips}</div>`);
      break;
    }
    case "links":
      for (const l of e.added) {
        rows.push(
          `<div class="frow chg"><span class="fname">links</span><span class="chip add">+ ${
            escapeHtml(l.type)
          } ${refHtml(l.to, refs)}</span></div>`,
        );
      }
      for (const l of e.removed) {
        rows.push(
          `<div class="frow chg"><span class="fname">links</span><span class="chip del">− ${
            escapeHtml(l.type)
          } ${refHtml(l.to, refs)}</span></div>`,
        );
      }
      break;
    case "comments":
      for (const c of e.added) {
        rows.push(
          `<div class="frow chg"><span class="fname">comment</span>` +
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
      rows.push(`<div class="frow chg">${name}<div class="descdiff">${lines}</div></div>`);
      break;
    }
  }
  return rows;
}

export function renderTicketCard(t: Ticket, badge: string, refs: RefContext = NO_REFS): string {
  const row = (k: string, v: string) =>
    `<div class="frow"><span class="fname">${escapeHtml(k)}</span><span>${v}</span></div>`;
  const rows: string[] = [];
  rows.push(row("project", `${escapeHtml(t.project)} / ${escapeHtml(t.type)}`));
  if (t.status) rows.push(row("status", escapeHtml(t.status)));
  if (t.labels.length) {
    rows.push(row("labels", t.labels.map((l) => `<span class="chip">${escapeHtml(l)}</span>`).join(" ")));
  }
  if (t.parent) rows.push(row("parent", refHtml(t.parent, refs)));
  if (t.sprint !== null) rows.push(row("sprint", escapeHtml(String(t.sprint))));
  if (t.assignee) rows.push(row("assignee", escapeHtml(t.assignee)));
  if (t.priority) rows.push(row("priority", escapeHtml(t.priority)));
  for (const [k, v] of Object.entries(t.fields)) {
    if (v !== null) rows.push(row(k, escapeHtml(JSON.stringify(v))));
  }
  for (const l of t.links) rows.push(row("link", `${escapeHtml(l.type)} ${refHtml(l.to, refs)}`));
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
  const isInfo = model.mode === "info";
  const p = model.proposal;
  // Inline style and script carry the nonce the server put in the page's CSP; pages
  // written to disk (jt diff --web, jt log --web) have neither.
  const nonce = model.cspNonce ? ` nonce="${escapeHtml(model.cspNonce)}"` : "";
  // Header ids link to the ticket in Jira; pending creations ("@name") have nowhere to link.
  const heading = (id: string, summary: string) => {
    const label = id.startsWith("@")
      ? escapeHtml(id)
      : `<a class="ref" href="${
        escapeHtml(`${model.target.baseUrl}/browse/${id}`)
      }" target="_blank" rel="noopener">${escapeHtml(id)}</a>`;
    return `<h3>${label} <span class="summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span></h3>`;
  };
  const earlier = (on: string | undefined) =>
    (p?.comments?.items ?? []).filter((c) => c.on === on).map((c) =>
      `<div class="rcomment"><div class="comment-tag">${escapeHtml(p!.comments!.label)}</div>${
        escapeHtml(c.body)
      }</div>`
    ).join("");
  const firstAuto = model.tickets.findIndex((t) => t.autoAllowed);
  const ticketCards = model.tickets.map((t, index) => {
    const collapsed = t.unchangedSinceReview;
    // Auto-allowed cards sort last (see buildPageModel); one divider introduces them.
    const divider = t.autoAllowed && index === firstAuto && firstAuto > 0
      ? `<div class="auto-divider">${AUTO_HINT} — sent with the rest when you approve</div>`
      : "";
    const autoBadge = t.autoAllowed ? `<span class="auto-tag">${AUTO_HINT}</span>` : "";
    const unchangedBadge = collapsed
      ? `<span class="unchanged">unchanged since your last review ✓
           <button class="expand" type="button">expand</button></span>`
      : "";
    // Comments sit under the changes they are about, as on a pull request: the ones
    // already made, then a box for a new one while the page can still decide.
    const said = earlier(t.id);
    const box = isReview
      ? `<textarea class="note" rows="1" placeholder="Comment on ${
        escapeHtml(t.id)
      } — asks for changes instead of approving"></textarea>`
      : "";
    const note = said || box
      ? `<div class="notebar" data-ticket="${escapeHtml(t.id)}">${said}${box}</div>`
      : "";
    return `${divider}<section class="ticket${collapsed ? " collapsed" : ""}${
      t.autoAllowed ? " auto-allowed" : ""
    }" id="t-${escapeHtml(t.id)}" data-id="${escapeHtml(t.id)}">
      <header${collapsed ? ' class="oneline"' : ""}>
        <span class="badge badge-${t.kind}">${t.kind}</span>
        ${heading(t.id, t.summary)}
        ${autoBadge}
        ${unchangedBadge}
      </header>
      <div class="body">${t.diffHtml}</div>
      ${
      t.opsJson
        ? `<details class="ops"><summary>compiled API operations</summary><pre>${
          escapeHtml(t.opsJson)
        }</pre></details>`
        : ""
    }
      ${note}
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
        `<section class="ticket"><header>${heading(s.id, s.summary)}</header><div class="body">${s.html}</div></section>`
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
        `<section class="ticket"><header>${heading(s.id, s.summary)}</header><div class="body">${s.html}</div></section>`
      ).join("")
    }
      </div>`
    : "";

  const footer = isReview
    ? `<footer class="sendbar">
        <textarea id="overall" rows="1" placeholder="Comment on the proposal as a whole — asks for changes instead of approving"></textarea>
        <button id="request" type="button">Request changes</button>
        <button id="approve" type="button">Approve &amp; push all ${model.tickets.length}</button>
      </footer>`
    : isInfo
    ? `<footer class="sendbar">
        <span id="countdown"></span>
        <span class="ack-hint">closing the tab acknowledges nothing</span>
        <button id="ack" type="button">Acknowledge all ${model.tickets.length}</button>
      </footer>`
    : "";

  const infoBanner = isInfo
    ? `<div class="info-banner"><span class="info-glyph">↓</span> upstream news — a read-only
       glance at what changed in Jira since your last ack. Nothing is sent from this page;
       Acknowledge only records it as seen.</div>`
    : "";

  // A proposal's own header: what it is called, where it stands, and what its author
  // and its reviewer have said about it as a whole.
  const count = `${model.tickets.length} ticket${model.tickets.length === 1 ? "" : "s"}`;
  const top = p
    ? `<header class="top">
  <a class="crumb" href="${escapeHtml(p.inboxUrl)}">← all proposals</a>
  <h1>${escapeHtml(p.title)} <span class="pstate pstate-${p.status.tone}">${escapeHtml(p.status.label)}</span></h1>
  <div class="target">proposal <b>${escapeHtml(p.name)}</b> in ${escapeHtml(p.workspace)} · ${count}${
      p.submittedAt
        ? ` · submitted <time datetime="${escapeHtml(p.submittedAt)}">${escapeHtml(p.submittedAt)}</time>`
        : ""
    } · → ${escapeHtml(model.target.baseUrl)} · project ${escapeHtml(model.target.project)}</div>
</header>
<div id="banners">${
      p.banners.map((b) => `<div class="banner banner-${b.tone}">${escapeHtml(b.text)}</div>`).join("")
    }</div>
${p.descriptionHtml ? `<section class="pdesc md">${p.descriptionHtml}</section>` : ""}
${earlier(undefined) ? `<section class="pcomments">${earlier(undefined)}</section>` : ""}`
    : `<header class="top">
  <h1>${escapeHtml(model.title)}</h1>
  <div class="target">→ ${escapeHtml(model.target.baseUrl)} · project ${escapeHtml(model.target.project)}</div>
</header>`;

  // The decision. A comment anywhere means "request changes": the two are mutually
  // exclusive, because an approval is sent at once and nobody would read the comment.
  const decideUrl = p?.decide?.url ?? `/decide/${model.nonce}`;
  const reviewJs = isReview
    ? `
    const decideUrl = ${JSON.stringify(decideUrl)};
    const decideToken = ${JSON.stringify(p?.decide?.token ?? "")};
    const tickets = [...document.querySelectorAll('section.ticket[data-id]')];
    const overall = document.getElementById('overall');
    function comments() {
      const out = [];
      const general = overall.value.trim();
      if (general) out.push({ body: general });
      for (const t of tickets) {
        const v = t.querySelector('.note')?.value?.trim();
        if (v) out.push({ on: t.dataset.id, body: v });
      }
      return out;
    }
    const approveBtn = document.getElementById('approve');
    const requestBtn = document.getElementById('request');
    const approveLabel = approveBtn.textContent;
    function refreshButtons() {
      const n = comments().length;
      approveBtn.disabled = n > 0;
      approveBtn.textContent = n > 0
        ? 'Approve blocked — ' + n + ' comment' + (n === 1 ? '' : 's') + ' pending'
        : approveLabel;
      approveBtn.title = n > 0 ? 'Clear the comments to approve, or Request changes.' : '';
      requestBtn.disabled = n === 0;
      requestBtn.title = n === 0 ? 'Say what should change: comment on a ticket, or on the proposal.' : '';
    }
    document.addEventListener('input', (e) => {
      if (e.target.tagName === 'TEXTAREA') {
        e.target.style.height = 'auto';
        e.target.style.height = e.target.scrollHeight + 'px';
      }
      refreshButtons();
    });
    refreshButtons();
    function finished(headline, lines, ok) {
      const done = document.createElement('div');
      done.className = 'done' + (ok ? '' : ' done-bad');
      const h = document.createElement('h2');
      h.textContent = headline;
      done.appendChild(h);
      if (lines && lines.length) {
        const pre = document.createElement('pre');
        pre.textContent = lines.join('\\n');
        done.appendChild(pre);
      }
      if (${JSON.stringify(Boolean(p))}) {
        const back = document.createElement('a');
        back.href = ${JSON.stringify(p?.inboxUrl ?? "/")};
        back.textContent = '← all proposals';
        done.appendChild(back);
      }
      document.body.replaceChildren(done);
    }
    async function send(decision) {
      approveBtn.disabled = requestBtn.disabled = true;
      if (decision === 'approve') approveBtn.textContent = 'Pushing…';
      let res, body = {};
      try {
        res = await fetch(decideUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, comments: comments(), token: decideToken }),
        });
        body = await res.json().catch(() => ({}));
      } catch (e) {
        finished('The review server did not answer — nothing was recorded.', [String(e)], false);
        return;
      }
      // The proposal, or Jira underneath it, changed after this page was rendered:
      // nothing was sent, and the page reloads to show what is true now.
      if (res.status === 409 && body.reload) { location.replace(location.pathname); return; }
      if (!res.ok) {
        finished(body.error || 'Something went wrong (' + res.status + ') — nothing was recorded.', body.log, false);
        return;
      }
      if (decision !== 'approve') {
        finished('Changes requested — nothing was sent. Your comments are saved on the proposal for its agent.', [], true);
      } else if (body.pushFailure) {
        finished('Approved, but the push stopped at a failure.', body.log, false);
      } else {
        finished('Approved and pushed.', body.log, true);
      }
    }
    approveBtn.addEventListener('click', () => send('approve'));
    requestBtn.addEventListener('click', () => send('request-changes'));`
    : "";
  // A proposal's link renders what is on disk and touches nothing. Checking it against
  // Jira is a request this page makes itself, so no other site can set it off.
  const refreshJs = p?.refresh
    ? `
    (async () => {
      const banners = document.getElementById('banners');
      const note = document.createElement('div');
      note.className = 'banner banner-info';
      note.textContent = 'Checking this proposal against Jira…';
      banners.prepend(note);
      try {
        const res = await fetch(${JSON.stringify(p.refresh.url)}, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrf: ${JSON.stringify(p.refresh.csrf)}, tag: ${JSON.stringify(p.refresh.tag)} }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.view) { location.replace(location.pathname + '?v=' + encodeURIComponent(body.view)); return; }
        if (body.reload) { location.replace(location.pathname); return; }
        if (res.ok && body.same) { note.remove(); return; }
        note.className = 'banner banner-error';
        note.textContent = (body.error || 'Could not check this proposal against Jira (' + res.status + ').') +
          ' Showing it as it was last staged; it cannot be approved from this view. Reload to try again.';
      } catch (e) {
        note.className = 'banner banner-error';
        note.textContent = 'The review server did not answer (' + e + '). Reload to try again.';
      }
    })();`
    : "";
  // Timestamps arrive as ISO strings; show them in the reader's own terms.
  const timeJs = p
    ? `
    document.querySelectorAll('time[datetime]').forEach((el) => {
      const then = new Date(el.dateTime);
      if (isNaN(then)) return;
      const mins = Math.round((Date.now() - then) / 60000);
      el.title = then.toLocaleString();
      el.textContent = mins < 1 ? 'just now' : mins < 60 ? mins + 'm ago'
        : mins < 1440 ? Math.round(mins / 60) + 'h ago' : Math.round(mins / 1440) + 'd ago';
    });`
    : "";
  const infoJs = isInfo
    ? `
    const nonce = ${JSON.stringify(model.nonce)};
    const deadline = Date.now() + ${model.timeoutMs ?? 600_000};
    setInterval(() => {
      const left = Math.max(0, deadline - Date.now());
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      document.getElementById('countdown').textContent =
        left > 0 ? 'page expires in ' + m + 'm ' + String(s).padStart(2, '0') + 's' : 'expired';
    }, 500);
    document.getElementById('ack').addEventListener('click', async () => {
      const res = await fetch('/ack/' + nonce, { method: 'POST' });
      document.body.innerHTML = res.ok
        ? '<div class="done">Acknowledged — current remote state recorded as seen. You can close this tab.</div>'
        : '<div class="done">Something went wrong (' + res.status + '). Check the terminal.</div>';
    });`
    : "";
  const expandJs = `
    document.querySelectorAll('.expand').forEach((b) => b.addEventListener('click', () => {
      b.closest('section.ticket').classList.remove('collapsed');
      b.remove();
    }));`;
  // Unchanged-field context: the ⚙ panel controls a master toggle plus one checkbox per
  // field found on the page. Preferences persist in localStorage — per origin, so they
  // carry across every proposal on the review server. No \${} interpolation here.
  const ctxJs = `
    const ctxFields = [...new Set(
      [...document.querySelectorAll('[data-ctx-field]')].map((el) => el.dataset.ctxField),
    )];
    if (ctxFields.length) {
      const gear = document.getElementById('fieldgear');
      const cfg = document.getElementById('fieldcfg');
      const master = document.getElementById('ctxmaster');
      const list = document.getElementById('cfgfields');
      gear.hidden = false;
      let prefs = { show: true, hidden: ['description'] };
      try {
        const saved = JSON.parse(localStorage.getItem('jt-ctx-fields'));
        if (saved && typeof saved.show === 'boolean' && Array.isArray(saved.hidden)) prefs = saved;
      } catch {}
      for (const f of ctxFields) {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.field = f;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + f));
        list.appendChild(label);
      }
      function applyCtx() {
        document.body.classList.toggle('show-ctx', prefs.show);
        master.checked = prefs.show;
        for (const cb of list.querySelectorAll('input')) {
          cb.checked = !prefs.hidden.includes(cb.dataset.field);
          cb.disabled = !prefs.show;
        }
        document.querySelectorAll('.frow.ctx').forEach((el) => {
          el.classList.toggle('ctx-off', prefs.hidden.includes(el.dataset.ctxField));
        });
        try { localStorage.setItem('jt-ctx-fields', JSON.stringify(prefs)); } catch {}
      }
      gear.addEventListener('click', () => { cfg.hidden = !cfg.hidden; });
      document.addEventListener('click', (e) => {
        if (!cfg.hidden && !cfg.contains(e.target) && !gear.contains(e.target)) cfg.hidden = true;
      });
      master.addEventListener('change', () => { prefs.show = master.checked; applyCtx(); });
      list.addEventListener('change', (e) => {
        const f = e.target.dataset.field;
        prefs.hidden = prefs.hidden.filter((x) => x !== f);
        if (!e.target.checked) prefs.hidden.push(f);
        applyCtx();
      });
      applyCtx();
    }`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(p ? `${p.title} — jt proposal ${p.name}` : model.title)}</title>
<style${nonce}>${CSS}</style>
</head>
<body${isInfo ? ' class="info"' : ""}>
${top}
${infoBanner}
<nav class="tabs">
  <button class="tab active" data-tab="changes">changes (${model.tickets.length})</button>
  ${sinceTab}
  ${commitTabs}
  <div class="gearwrap">
    <button class="tab" id="fieldgear" type="button" title="choose which unchanged fields to show" hidden>⚙ fields</button>
    <div id="fieldcfg" hidden>
      <label><input type="checkbox" id="ctxmaster"> show unchanged fields</label>
      <div id="cfgfields"></div>
    </div>
  </div>
</nav>
<main>
  <div class="panel" id="changes">${ticketCards}</div>
  ${sincePanel}
  ${commitPanels}
</main>
${footer}
<script${nonce}>
document.querySelectorAll('.tab[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab[data-tab]').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.hidden = true);
  b.classList.add('active');
  document.getElementById(b.dataset.tab).hidden = false;
}));
${expandJs}
${ctxJs}
${timeJs}
${reviewJs}
${refreshJs}
${infoJs}
</script>
</body>
</html>`;
}

export const CSS = `
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --border: #d1d9e0;
  --card: #f6f8fa; --add-bg: #dafbe1; --add-fg: #116329; --del-bg: #ffebe9; --del-fg: #82071e;
  --accent: #0969da; --warn: #9a6700; --info: #8250df; --info-bg: #fbefff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --border: #30363d;
    --card: #161b22; --add-bg: #12261e; --add-fg: #3fb950; --del-bg: #25171c; --del-fg: #f85149;
    --accent: #4493f8; --warn: #d29922; --info: #a371f7; --info-bg: #2a2140;
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
.badge-archive, .badge-unarchive { background: var(--info-bg); color: var(--info); }
.badge-view { background: var(--card); color: var(--muted); border: 1px solid var(--border); }
.badge-new { background: var(--add-bg); color: var(--add-fg); }
.badge-changed { background: var(--info-bg); color: var(--info); }
.badge-gone { background: var(--del-bg); color: var(--del-fg); }
.badge-conflict { background: none; color: var(--warn); border: 1px solid var(--warn); }
/* Informational identity (jt changes --web): purple ribbon + banner + card spines make
   the glance-and-close page unmistakable next to the neutral review/diff pages. */
body.info { border-top: 4px solid var(--info); }
body.info .top h1 { color: var(--info); }
.info-banner { background: var(--info-bg); color: var(--info); padding: 8px 20px; font-size: 13px; }
.info-glyph { font-weight: 700; margin-right: 4px; }
body.info section.ticket { border-left: 4px solid var(--info); }
.conflict-card { color: var(--warn); border: 1px solid var(--warn); border-radius: 6px; padding: 10px 14px; }
.ack-hint { color: var(--muted); font-size: 12px; }
#ack { background: var(--info); color: #fff; border: none; border-radius: 6px; padding: 8px 18px; font: inherit; font-weight: 600; cursor: pointer; }
#ack:hover { filter: brightness(1.1); }
.unchanged { font-size: 12px; color: var(--add-fg); margin-left: auto; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; flex-shrink: 0; }
/* Already-seen cards keep a one-line header: a long title truncates (hover for the
   full text) rather than wrapping the unchanged badge onto a second row. */
section.ticket > header.oneline { flex-wrap: nowrap; }
header.oneline .badge { flex-shrink: 0; }
header.oneline h3 { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.expand { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 6px; padding: 2px 8px; font: inherit; font-size: 11px; cursor: pointer; }
section.ticket.collapsed .body,
section.ticket.collapsed details.ops,
section.ticket.collapsed .notebar { display: none; }
section.ticket.collapsed > header { border-bottom: none; }
.body { padding: 12px 14px; }
.frow { display: flex; gap: 10px; align-items: baseline; padding: 3px 0; flex-wrap: wrap; }
.fname { color: var(--muted); min-width: 90px; font-size: 12px; }
/* Unchanged-field context: hidden until the ⚙ script applies the saved preferences. */
.gearwrap { margin-left: auto; position: relative; }
#fieldcfg { position: absolute; right: 0; top: calc(100% + 6px); background: var(--bg);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; min-width: 220px;
  box-shadow: 0 4px 16px rgba(0,0,0,.18); z-index: 10; display: flex; flex-direction: column;
  gap: 4px; font-size: 13px; }
#fieldcfg[hidden] { display: none; }
#fieldcfg label { display: flex; gap: 6px; align-items: center; cursor: pointer; white-space: nowrap; }
#fieldcfg > label { font-weight: 600; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
#cfgfields { display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow-y: auto; }
.frow.chg .fname { font-weight: 700; color: var(--fg); }
.frow.ctx { display: none; }
body.show-ctx .frow.ctx { display: flex; }
body.show-ctx .frow.ctx.ctx-off { display: none; }
.frow.ctx, .frow.ctx .ctxval { color: var(--muted); }
.frow.ctx .chip { opacity: .85; }
.frow.ctx .desc.md { flex-basis: 100%; margin-top: 4px; }
a.ref { color: inherit; text-decoration: underline dotted; text-underline-offset: 2px; }
a.ref:hover { color: var(--accent); }
h3 a.ref { text-decoration: none; }
h3 a.ref:hover { text-decoration: underline; }
.refsum { color: var(--muted); font-size: 12px; }
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
.archive-card { background: var(--info-bg); color: var(--info); padding: 10px 14px; border-radius: 6px; }
.withdrawn-card { color: var(--muted); border: 1px dashed var(--border); border-radius: 6px; padding: 10px 14px; }
.nochange { color: var(--muted); }
/* Auto-allowed by the user's settings: present and readable, but out of the way — the
   reviewer's attention belongs to everything that is not greyed. */
.auto-rows { flex-basis: 100%; margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--border); opacity: .55; }
.auto-rows:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.auto-rows:hover, section.ticket.auto-allowed:hover { opacity: .9; }
.auto-hint, .auto-tag { font-size: 11px; color: var(--muted); font-style: italic; }
.auto-tag { margin-left: auto; white-space: nowrap; }
section.ticket.auto-allowed { opacity: .55; }
.auto-divider { color: var(--muted); font-size: 12px; margin: 24px 0 10px; padding-top: 12px; border-top: 1px dashed var(--border); }
.frow.warn { color: var(--warn); }
details.ops { border-top: 1px solid var(--border); padding: 8px 14px; }
details.ops summary { cursor: pointer; color: var(--muted); font-size: 12px; }
details.ops pre { font-size: 11px; overflow-x: auto; }
.notebar { padding: 8px 14px; border-top: 1px solid var(--border); }
.notebar .note { width: 100%; background: var(--card); border: 1px solid var(--border); color: var(--fg); border-radius: 6px; padding: 5px 10px; font: inherit; font-size: 12px; }
.sendbar { position: fixed; bottom: 0; left: 0; right: 0; display: flex; gap: 12px; align-items: center; justify-content: flex-end; padding: 12px 20px; background: var(--card); border-top: 1px solid var(--border); }
#countdown { color: var(--muted); font-size: 13px; margin-right: auto; }
#approve { background: var(--add-fg); color: #fff; border: none; border-radius: 6px; padding: 8px 18px; font: inherit; font-weight: 600; cursor: pointer; }
#approve:disabled { background: var(--card); color: var(--muted); border: 1px solid var(--border); cursor: not-allowed; }
#request { background: none; color: var(--del-fg); border: 1px solid var(--del-fg); border-radius: 6px; padding: 8px 18px; font: inherit; font-weight: 600; cursor: pointer; }
#approve:hover:not(:disabled), #request:hover { filter: brightness(1.1); }
.done { display: flex; flex-direction: column; gap: 14px; align-items: center; justify-content: center; min-height: 80vh; font-size: 16px; color: var(--muted); padding: 20px; text-align: center; }
.done h2 { margin: 0; font-size: 17px; color: var(--fg); }
.done-bad h2 { color: var(--del-fg); }
.done pre { text-align: left; font: 12px/1.6 ui-monospace, monospace; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; max-width: 900px; width: 100%; overflow-x: auto; white-space: pre-wrap; }
.done a { color: var(--accent); font-size: 13px; }
/* A proposal's own page: header, description and review comments. */
.crumb { font-size: 12px; color: var(--muted); text-decoration: none; }
.crumb:hover { color: var(--accent); }
.pstate { font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 10px; vertical-align: middle; margin-left: 6px; white-space: nowrap; }
.pstate-wait { background: var(--accent); color: #fff; }
.pstate-ok { background: var(--add-bg); color: var(--add-fg); }
.pstate-warn { color: var(--warn); border: 1px solid var(--warn); }
.pstate-error { background: var(--del-bg); color: var(--del-fg); }
.pstate-muted { background: var(--card); color: var(--muted); border: 1px solid var(--border); }
.banner { padding: 8px 20px; font-size: 13px; border-top: 1px solid var(--border); white-space: pre-line; }
.banner-info { background: var(--card); color: var(--muted); }
.banner-warn { color: var(--warn); }
.banner-error { background: var(--del-bg); color: var(--del-fg); }
.pdesc, .pcomments { max-width: 980px; margin: 14px auto 0; padding: 0 20px; }
.md table { border-collapse: collapse; margin: 8px 0; }
.md th, .md td { border: 1px solid var(--border); padding: 3px 10px; text-align: left; }
.md th { background: var(--card); }
.pdesc > :first-child { margin-top: 0; }
.pdesc > :last-child { margin-bottom: 0; }
.rcomment { border: 1px solid var(--warn); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; font-size: 13px; white-space: pre-wrap; }
.notebar textarea.note, #overall { display: block; resize: vertical; min-height: 30px; font-family: inherit; line-height: 1.5; }
#overall { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border); color: var(--fg); border-radius: 6px; padding: 5px 10px; font-size: 13px; }
#request:disabled { opacity: .5; cursor: not-allowed; }
`;
