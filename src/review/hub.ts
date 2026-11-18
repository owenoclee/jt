/**
 * The review server: one long-lived loopback process that serves every proposal in
 * every workspace, each at a link that stays good — /p/<workspace>/<proposal> — plus
 * the inbox at /. It is the only path to a reviewed remote mutation: the process that
 * shows the changeset is the one that sends it, and it sends only what it showed.
 *
 * A proposal's link is a plain GET and does nothing but read: it renders what is on
 * disk. Checking the proposal against Jira (and rebasing it) is a POST the page makes
 * itself, as is the decision. Both are refused unless they come from this origin, so
 * another site the reviewer has open can set neither off; and a decision is bound, by
 * a token minted when the reviewable page was rendered, to that submission and to a
 * hash of the operations it showed. If either has moved, nothing is sent and the page
 * reloads.
 *
 * This file is the request handler only — no socket, no process state — so tests call
 * it directly. `jt serve` (src/commands/serve.ts) puts it on a port.
 */
import { classifyChangeset } from "../autoallow.ts";
import { readChain } from "../chain.ts";
import { checkStaleness, type PushContext } from "../commands/push.ts";
import { type CompiledPush, compilePush } from "../compile.ts";
import { contextFor, type LocalContext, withClient, withMeta } from "../context.ts";
import { UserError } from "../errors.ts";
import { withWorkspaceLock } from "../lock.ts";
import { DEFAULT_PROPOSAL, proposalFlag, validateProposalName } from "../proposal.ts";
import { makeRefContext } from "../refs.ts";
import { loadSettings } from "../settings.ts";
import type { Store } from "../store.ts";
import type { CompiledOp, ProposalMeta } from "../types.ts";
import { VERSION } from "../version.ts";
import { renderHistoryPage } from "./history.ts";
import { CSS, escapeHtml, mdToHtml, type ProposalHeader, renderPage, type ReviewPageModel } from "./html.ts";
import { type InboxRow, renderInbox } from "./inbox.ts";
import { presentStatus, type ProposalView, proposalView } from "./meta.ts";
import { buildCommittedTickets, buildCommitViews, buildPageModel, buildSinceReview } from "./model.ts";
import { buildTicketPlans } from "./plan.ts";
import { refreshProposal } from "./refresh.ts";
import { readRegistry, workspaceBySlug } from "./registry.ts";
import { applyDecision, type Decision, parseComments } from "./decision.ts";

export interface HubOptions {
  /** How this build names itself on /health; tests pretend to be another version. */
  version?: string;
  now?: () => number;
}

export interface Hub {
  handle(req: Request): Promise<Response>;
  /** True while an approved push is being sent — not a moment to stop the process. */
  busy(): boolean;
}

/** A reviewable rendering of a proposal: what a decision token is bound to. */
interface View {
  slug: string;
  name: string;
  /** The submission this was rendered for; a resubmission makes it stale. */
  submittedAt: string;
  /** sha256 of the compiled operations the page showed. */
  digest: string;
  html: string;
  cspNonce: string;
  servedAt: number;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const VIEW_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_PUSH_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_REUSE_MS = 3000;
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const digestOf = (ops: CompiledOp[]): Promise<string> => sha256(JSON.stringify(ops));

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What the page compares to know whether a refresh changed anything it is showing. */
function stateTag(view: ProposalView): string {
  return `${view.status}|${view.meta?.submittedAt ?? ""}|${view.meta?.blocked?.reason ?? ""}`;
}

export function createHub(opts: HubOptions = {}): Hub {
  const version = opts.version ?? VERSION;
  const now = opts.now ?? (() => Date.now());
  /** Proves a refresh POST came from a page this process rendered. */
  const secret = crypto.randomUUID();
  const views = new Map<string, View>();
  const refreshing = new Map<string, Promise<Reply>>();
  const lastView = new Map<string, { at: number; id: string }>();
  let pushes = 0;

  // ---- responses ----

  function html(body: string, cspNonce: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Nothing loads from anywhere, and only the page's own inline script and
        // style run. What a review page renders includes text that came from Jira.
        "Content-Security-Policy": [
          "default-src 'none'",
          `script-src 'nonce-${cspNonce}'`,
          `style-src 'nonce-${cspNonce}'`,
          "connect-src 'self'",
          "img-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "no-store",
      },
    });
  }

  function json(body: Record<string, unknown>, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "no-store",
      },
    });
  }

  function notice(title: string, text: string, status: number): Response {
    const cspNonce = crypto.randomUUID();
    return html(
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${cspNonce}">${CSS}</style>
</head>
<body>
<header class="top">
  <a class="crumb" href="/">← all proposals</a>
  <h1>${escapeHtml(title)}</h1>
</header>
<main><div class="nochange">${escapeHtml(text)}</div></main>
</body>
</html>`,
      cspNonce,
      status,
    );
  }

  // ---- request checks ----

  /**
   * The request must be addressed to this server by a loopback name. A page on another
   * site can point a hostname of its own at 127.0.0.1 (DNS rebinding) and would then
   * be same-origin with whatever answered — unless the answer depends on the name.
   */
  function loopback(url: URL): boolean {
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  }

  /**
   * A state-changing request must come from a page this server served: same origin,
   * said so by the browser itself (Sec-Fetch-Site cannot be set by page script), and
   * JSON — a content type no cross-site form can send without a preflight this server
   * never answers.
   */
  function fromOwnPage(req: Request, url: URL): boolean {
    return req.headers.get("origin") === url.origin &&
      req.headers.get("sec-fetch-site") === "same-origin" &&
      (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
  }

  // ---- proposals ----

  function locate(slug: string, name: string): { root: string; ctx: LocalContext } | string {
    const entry = workspaceBySlug(slug);
    if (!entry) return `No workspace called '${slug}' is registered with this review server.`;
    try {
      validateProposalName(name);
      return { root: entry.root, ctx: contextFor(entry.root, name) };
    } catch (e) {
      return message(e);
    }
  }

  /** What the page says about the proposal as a whole, for the state it is in. */
  function headerFor(slug: string, view: ProposalView, store: Store): ProposalHeader {
    const meta = view.meta;
    const flag = proposalFlag(view.name);
    const banners: ProposalHeader["banners"] = [];
    switch (view.status) {
      case "revising":
        banners.push({
          tone: "warn",
          text: "Its agent has changed the staged work since submitting it. What is shown is " +
            `the current state, which cannot be approved until the agent submits it again (jt push${flag}).`,
        });
        break;
      case "changes-requested":
        banners.push({
          tone: "info",
          text: "You asked for changes. Your comments are saved on the proposal for the agent " +
            "that picks it up; it comes back for review when that agent submits it again.",
        });
        break;
      case "blocked":
        banners.push({
          tone: "error",
          text: `This proposal cannot be reviewed as it stands — it needs its agent.\n${meta?.blocked?.reason ?? ""}`,
        });
        break;
      case "pushing":
        banners.push({ tone: "info", text: "You approved this; it is being sent to Jira now. Reload in a moment." });
        break;
      case "interrupted":
        banners.push({
          tone: "error",
          text: "The review server stopped while sending this approved push, so part of it may " +
            `have reached Jira. An agent should run jt pull and jt log, then jt push${flag} to submit what is left.`,
        });
        break;
      case "partly-pushed":
        banners.push({
          tone: "error",
          text: "You approved this, but the push stopped at a failure. The changes shown were " +
            `approved and never sent. jt log says why; jt push${flag} submits them again, jt uncommit${flag} drops them.`,
        });
        break;
      case "draft":
        banners.push({ tone: "info", text: `Staged, but not submitted for review (jt push${flag} submits it).` });
        break;
      case "legacy-review":
        banners.push({
          tone: "warn",
          text: "A review page from an older jt is still open for this proposal" +
            (view.legacyUrl ? ` at ${view.legacyUrl}` : "") + `. Decide it there, or run jt cancel${flag}.`,
        });
        break;
    }
    // Rebases onto remote edits made since the submission: say so, in the chain's words.
    if (meta?.submittedAt) {
      const absorbed = readChain(store).entries
        .filter((e) => e.author === "remote" && e.createdAt > meta.submittedAt!)
        .map((e) => e.note.replace(/^rebase: /, ""));
      if (absorbed.length) {
        banners.push({
          tone: "info",
          text: "Jira changed underneath this proposal after it was submitted, and it was moved " +
            `onto the new state (${absorbed.join("; ")}). What is shown is what it would send now.`,
        });
      }
    }
    const comments = meta?.review
      ? { label: "your comment · waiting for the agent", items: meta.review.comments }
      : meta?.previousReview
      ? { label: "your comment on the previous review", items: meta.previousReview.comments }
      : undefined;
    return {
      name: view.name,
      workspace: slug,
      title: meta?.title || (view.name === DEFAULT_PROPOSAL ? "Default proposal" : view.name),
      descriptionHtml: meta?.description ? mdToHtml(meta.description) : "",
      status: presentStatus(view.status),
      ...(meta?.submittedAt ? { submittedAt: meta.submittedAt } : {}),
      banners,
      ...(comments ? { comments } : {}),
      inboxUrl: "/",
    };
  }

  /** GET /p/<slug>/<name>: read-only, from disk. Never talks to Jira, never writes. */
  function page(slug: string, name: string, url: URL): Response {
    const found = locate(slug, name);
    if (typeof found === "string") return notice("No such proposal", found, 404);
    const { ctx } = found;
    const { store } = ctx;
    const view = proposalView(store);
    const path = `/p/${slug}/${name}`;

    const viewId = url.searchParams.get("v");
    if (viewId) {
      const v = views.get(viewId);
      const current = v && v.slug === slug && v.name === name && view.status === "in-review" &&
        view.meta?.submittedAt === v.submittedAt && now() - v.servedAt < VIEW_TTL_MS;
      if (current) return html(v.html, v.cspNonce);
      // Stale or unknown (the server restarted, the proposal moved on): start over.
      return new Response(null, { status: 302, headers: { Location: path } });
    }

    const cspNonce = crypto.randomUUID();
    const target = { baseUrl: ctx.ws.config.baseUrl, project: ctx.ws.config.project };
    const refs = makeRefContext(store, ctx.ws.config);
    if (view.status === "empty") {
      const last = store.lastPush();
      if (!last) {
        return notice(
          "No such proposal",
          `Nothing is staged in a proposal called '${name}' in ${slug}, and it has never been pushed.`,
          404,
        );
      }
      return html(
        renderHistoryPage({
          entries: [last],
          target,
          scope: `proposal ${name}`,
          refs,
          cspNonce,
          heading: `${last.title ?? name} — ${last.result === "success" ? "pushed" : "partly pushed"}`,
          back: { href: "/", label: "← all proposals" },
        }),
        cspNonce,
      );
    }

    const header = headerFor(slug, view, store);
    if (view.status === "in-review" || view.status === "blocked") {
      header.refresh = { url: `${path}/refresh`, csrf: secret, tag: stateTag(view) };
    }
    const tickets = buildCommittedTickets(store, refs);
    const model: ReviewPageModel = {
      mode: "readonly",
      title: header.title,
      target,
      tickets,
      commits: buildCommitViews(store, refs),
      sinceReview: buildSinceReview(store, tickets.map((t) => t.id), refs),
      nonce: "",
      proposal: header,
      cspNonce,
    };
    return html(renderPage(model), cspNonce);
  }

  /**
   * POST …/refresh: bring the proposal up to date with Jira and, when it can be
   * reviewed, render the reviewable view and hand back its id.
   */
  async function refresh(slug: string, name: string, seenTag: string): Promise<Reply> {
    const found = locate(slug, name);
    if (typeof found === "string") return { status: 404, body: { error: found } };
    const key = `${slug}/${name}`;
    return await withWorkspaceLock(found.root, async () => {
      let ctx: PushContext;
      try {
        ctx = withClient(withMeta(contextFor(found.root, name)));
      } catch (e) {
        return { status: 502, body: { error: message(e) } };
      }
      const { store } = ctx;
      let view = proposalView(store);
      const unchanged = (): Reply => {
        const tag = stateTag(proposalView(store));
        return { status: 200, body: tag === seenTag ? { same: true } : { reload: true } };
      };
      if (view.status !== "in-review" && view.status !== "blocked") return unchanged();

      // A reload moments after a render gets that render back, not another round trip.
      const recent = lastView.get(key);
      const reusable = recent && now() - recent.at < REFRESH_REUSE_MS ? views.get(recent.id) : undefined;
      if (reusable && view.status === "in-review" && reusable.submittedAt === view.meta?.submittedAt) {
        return { status: 200, body: { view: recent!.id } };
      }

      let problems: string[];
      let compiled: CompiledPush | null = null;
      try {
        problems = (await refreshProposal(ctx)).problems;
        view = proposalView(store);
        if (view.staged.length === 0) {
          // Jira caught up with everything the proposal wanted: nothing left to review.
          store.writeMeta(null);
          store.dropIfDrained();
          return { status: 200, body: { reload: true } };
        }
        if (problems.length === 0) {
          try {
            compiled = await compilePush(ctx);
          } catch (e) {
            // A refusal to compile is about the proposal (an unknown value, a field Jira
            // will not accept); anything else is about reaching Jira.
            if (!(e instanceof UserError)) throw e;
            problems = [e.message];
          }
        }
      } catch (e) {
        // Jira unreachable, the token rejected: nothing is known to be wrong with the
        // proposal, so nothing is recorded against it.
        return { status: 502, body: { error: message(e) } };
      }

      const meta = view.meta!;
      if (problems.length > 0 || compiled === null) {
        const reason = problems.join("\n");
        if (meta.blocked?.reason !== reason) {
          store.writeMeta({ ...meta, blocked: { reason, at: new Date(now()).toISOString() } });
        }
        return unchanged();
      }
      if (meta.blocked) {
        const { blocked: _cleared, ...rest } = meta;
        store.writeMeta(rest);
        view = proposalView(store);
      }

      const plans = buildTicketPlans(store, compiled.ops);
      let verdict;
      try {
        verdict = classifyChangeset(store, plans, loadSettings().autoAllow);
      } catch (e) {
        return { status: 502, body: { error: message(e) } };
      }
      const id = crypto.randomUUID();
      const cspNonce = crypto.randomUUID();
      const header = headerFor(slug, view, store);
      header.decide = { url: `/p/${slug}/${name}/decide`, token: id };
      for (const w of compiled.warnings) header.banners.push({ tone: "warn", text: w });
      const model: ReviewPageModel = {
        ...buildPageModel(store, ctx.ws.config, plans, makeRefContext(store, ctx.ws.config), verdict),
        proposal: header,
        cspNonce,
      };
      const servedAt = now();
      for (const [old, v] of views) if (servedAt - v.servedAt > VIEW_TTL_MS) views.delete(old);
      views.set(id, {
        slug,
        name,
        submittedAt: view.meta!.submittedAt!,
        digest: await digestOf(compiled.ops),
        html: renderPage(model),
        cspNonce,
        servedAt,
      });
      lastView.set(key, { at: servedAt, id });
      return { status: 200, body: { view: id } };
    });
  }

  /** POST …/decide: the human's decision on exactly the view they were shown. */
  async function decide(
    slug: string,
    name: string,
    body: Record<string, unknown>,
    userAgent: string | null,
  ): Promise<Reply> {
    const reload: Reply = { status: 409, body: { reload: true } };
    const v = typeof body.token === "string" ? views.get(body.token) : undefined;
    if (!v || v.slug !== slug || v.name !== name) return reload;
    if (body.decision !== "approve" && body.decision !== "request-changes") {
      return { status: 400, body: { error: "unknown decision" } };
    }
    const comments = parseComments(body);
    if (body.decision === "request-changes" && comments.length === 0) {
      return {
        status: 400,
        body: { error: "Say what should change: comment on a ticket, or on the proposal as a whole." },
      };
    }
    if (body.decision === "approve" && comments.length > 0) {
      return {
        status: 400,
        body: { error: "A review with comments asks for changes; clear them to approve." },
      };
    }
    const found = locate(slug, name);
    if (typeof found === "string") return { status: 404, body: { error: found } };

    return await withWorkspaceLock(found.root, async () => {
      let ctx: PushContext;
      try {
        ctx = withClient(withMeta(contextFor(found.root, name)));
      } catch (e) {
        return { status: 502, body: { error: message(e) } };
      }
      const { store } = ctx;
      const view = proposalView(store);
      // Withdrawn, resubmitted, revised, already decided in another tab: whatever this
      // page showed is no longer what is in review.
      if (view.status !== "in-review" || view.meta?.submittedAt !== v.submittedAt) return reload;
      const meta: ProposalMeta = view.meta;
      const decidedAt = new Date(now()).toISOString();
      const decision: Decision = {
        decision: body.decision as Decision["decision"],
        comments,
        provenance: { decidedAt, decideMs: now() - v.servedAt, userAgent },
      };
      const log: string[] = [];
      const print = (line: string) => log.push(line.replace(ANSI, ""));

      if (decision.decision === "request-changes") {
        await applyDecision(ctx, { ops: [], warnings: [], existingKeys: [] }, decision, { print });
        store.writeMeta({
          title: meta.title,
          description: meta.description,
          review: { decidedAt, comments },
        });
        views.delete(body.token as string);
        return { status: 200, body: { ok: true, status: "changes-requested", log } };
      }

      // Approve. Jira may have moved since the page was rendered, and so may the
      // proposal: compile again and send only if it is still exactly what was shown.
      let compiled: CompiledPush;
      try {
        const shown = [
          ...store.listCommittedIds().filter((id) => !id.startsWith("@")),
          ...store.readIntents().filter((i) => i.committed).map((i) => i.key),
        ];
        await checkStaleness(ctx, shown);
        compiled = await compilePush(ctx);
      } catch (e) {
        if (e instanceof UserError) return reload;
        return { status: 502, body: { error: `not sent — ${message(e)}` } };
      }
      if (await digestOf(compiled.ops) !== v.digest) return reload;

      let verdict;
      try {
        verdict = classifyChangeset(store, buildTicketPlans(store, compiled.ops), loadSettings().autoAllow);
      } catch (e) {
        return { status: 502, body: { error: `not sent — ${message(e)}` } };
      }
      store.writeMeta({ ...meta, pushing: { pid: Deno.pid, since: decidedAt } });
      views.delete(body.token as string);
      pushes++;
      try {
        const outcome = await applyDecision(ctx, compiled, decision, {
          verdict,
          title: meta.title,
          print,
          stalenessChecked: true,
        });
        if (outcome.pushFailure) {
          // Whatever did not land stays staged, approved but unsent; it is no longer
          // in review, and what happens to it next is not this page's to decide.
          store.writeMeta({ title: meta.title, description: meta.description });
        } else {
          store.writeMeta(null);
          store.dropIfDrained();
        }
        return {
          status: 200,
          body: {
            ok: true,
            status: outcome.status,
            pushFailure: outcome.pushFailure,
            created: outcome.created ?? {},
            log,
          },
        };
      } catch (e) {
        // Not a refusal from Jira (those end the push cleanly) but a crash part-way.
        const reason = `the push crashed part-way (${message(e)}) — some of it may have reached Jira. ` +
          `Run jt pull and jt log, then jt push${proposalFlag(name)} to submit what is left.`;
        store.writeMeta({
          title: meta.title,
          description: meta.description,
          submittedAt: meta.submittedAt,
          blocked: { reason, at: decidedAt },
        });
        return { status: 500, body: { error: reason, log } };
      } finally {
        pushes--;
      }
    });
  }

  function inbox(): Response {
    const rows: InboxRow[] = [];
    const pushed: InboxRow[] = [];
    const unreadable: string[] = [];
    const recent = new Date(now() - RECENT_PUSH_MS).toISOString();
    for (const entry of readRegistry()) {
      let base: LocalContext;
      try {
        base = contextFor(entry.root, DEFAULT_PROPOSAL);
      } catch {
        unreadable.push(entry.slug);
        continue;
      }
      for (const name of base.store.listProposals()) {
        const view = proposalView(base.store.scoped(name));
        if (view.status === "empty") continue;
        const waiting = view.meta?.review?.comments.length ?? 0;
        const detail = view.status === "changes-requested"
          ? `${waiting} comment${waiting === 1 ? "" : "s"} waiting`
          : view.status === "blocked"
          ? view.meta?.blocked?.reason.split("\n")[0].slice(0, 140)
          : undefined;
        rows.push({
          workspace: entry.slug,
          project: base.ws.config.project,
          name,
          title: view.meta?.title || (name === DEFAULT_PROPOSAL ? "Default proposal" : name),
          status: presentStatus(view.status),
          tickets: view.staged.length,
          ...(view.meta?.submittedAt ? { submittedAt: view.meta.submittedAt } : {}),
          url: `/p/${entry.slug}/${name}`,
          ...(detail ? { detail } : {}),
        });
      }
      // What the reviewer approved lately, so a finished proposal has somewhere to be
      // found. Its link shows what was sent — the latest push under that name.
      const open = new Set(rows.filter((r) => r.workspace === entry.slug).map((r) => r.name));
      const seen = new Set<string>();
      for (const { entry: e } of base.store.listJournal(recent)) {
        const name = e.proposal ?? DEFAULT_PROPOSAL;
        if (!e.review || open.has(name) || seen.has(name)) continue;
        seen.add(name);
        pushed.push({
          workspace: entry.slug,
          project: base.ws.config.project,
          name,
          title: e.title || (name === DEFAULT_PROPOSAL ? "Default proposal" : name),
          status: e.result === "success"
            ? { label: "pushed", tone: "ok", waitingOn: "you" }
            : { label: "stopped at a failure", tone: "error", waitingOn: "you" },
          tickets: e.changes?.length ?? 0,
          pushedAt: e.startedAt,
          url: `/p/${entry.slug}/${name}`,
        });
      }
    }
    // Oldest submission first: what has waited longest is what to look at first.
    rows.sort((a, b) => (a.submittedAt ?? "~").localeCompare(b.submittedAt ?? "~"));
    pushed.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
    const cspNonce = crypto.randomUUID();
    return html(renderInbox({ rows, pushed, cspNonce, unreadable }), cspNonce);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!loopback(url)) return new Response("not found", { status: 404 });
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json({ name: "jt-review", version, pid: Deno.pid });
      }
      if (req.method === "GET" && url.pathname === "/") return inbox();

      const m = /^\/p\/([^/]+)\/([^/]+)(?:\/(refresh|decide))?$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const [, slug, name, action] = m.map((part) => (part === undefined ? part : decodeURIComponent(part)));
      if (!action) {
        if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
        return page(slug, name, url);
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!fromOwnPage(req, url)) return json({ error: "this request did not come from a jt review page" }, 403);
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return json({ error: "bad request" }, 400);

      if (action === "refresh") {
        if (body.csrf !== secret) return json({ reload: true }, 409);
        const key = `${slug}/${name}`;
        let running = refreshing.get(key);
        if (!running) {
          running = refresh(slug, name, typeof body.tag === "string" ? body.tag : "")
            .finally(() => refreshing.delete(key));
          refreshing.set(key, running);
        }
        const reply = await running;
        return json(reply.body, reply.status);
      }
      const reply = await decide(slug, name, body, req.headers.get("user-agent"));
      return json(reply.body, reply.status);
    } catch (e) {
      return req.method === "GET"
        ? notice("Something went wrong", message(e), 500)
        : json({ error: message(e) }, 500);
    }
  }

  return { handle, busy: () => pushes > 0 };
}
