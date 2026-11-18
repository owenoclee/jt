/**
 * A stand-in for the reviewer's browser: drives the review server's request handler
 * the way a page does — open the link, let the page check the proposal against Jira,
 * load the reviewable view, decide — with the headers a browser would send.
 */
import type { Hub } from "../src/review/hub.ts";
import type { ReviewComment } from "../src/types.ts";

export const ORIGIN = "http://127.0.0.1:5472";
export const BROWSER = "Mozilla/5.0 (jt test browser)";

export function get(hub: Hub, path: string, origin = ORIGIN): Promise<Response> {
  return hub.handle(new Request(origin + path, { headers: { "user-agent": BROWSER } }));
}

/** A same-origin JSON POST, as the page's own script makes; `headers` overrides any of it. */
export function post(
  hub: Hub,
  path: string,
  body: unknown,
  headers: Record<string, string | null> = {},
): Promise<Response> {
  const all: Record<string, string> = {
    "content-type": "application/json",
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "user-agent": BROWSER,
  };
  for (const [k, v] of Object.entries(headers)) {
    if (v === null) delete all[k];
    else all[k] = v;
  }
  return hub.handle(
    new Request(ORIGIN + path, {
      method: "POST",
      headers: all,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

export interface Opened {
  /** The page the link itself returns: read-only, from disk. */
  local: string;
  localStatus: number;
  /** What the page's refresh request was answered with, if it made one. */
  refresh?: { status: number; body: Record<string, unknown> };
  /** The reviewable view, when the refresh produced one. */
  page?: string;
  token?: string;
}

/** Open a proposal's link and do what its page would do next. */
export async function open(hub: Hub, slug: string, name: string): Promise<Opened> {
  const path = `/p/${slug}/${name}`;
  const res = await get(hub, path);
  const local = await res.text();
  const out: Opened = { local, localStatus: res.status };
  const m = /csrf: ("[^"]*"), tag: ("(?:[^"\\]|\\.)*")/.exec(local);
  if (!m) return out;
  const r = await post(hub, `${path}/refresh`, { csrf: JSON.parse(m[1]), tag: JSON.parse(m[2]) });
  out.refresh = { status: r.status, body: await r.json() };
  const view = out.refresh.body.view;
  if (typeof view === "string") {
    out.page = await (await get(hub, `${path}?v=${view}`)).text();
    const t = /const decideToken = ("[^"]*")/.exec(out.page);
    if (t) out.token = JSON.parse(t[1]);
  }
  return out;
}

export interface Decided {
  status: number;
  body: {
    ok?: boolean;
    status?: string;
    pushFailure?: string | null;
    created?: Record<string, string>;
    log?: string[];
    reload?: boolean;
    error?: string;
  };
}

export async function decide(
  hub: Hub,
  slug: string,
  name: string,
  token: string,
  decision: "approve" | "request-changes",
  comments: ReviewComment[] = [],
): Promise<Decided> {
  const res = await post(hub, `/p/${slug}/${name}/decide`, { decision, comments, token });
  return { status: res.status, body: await res.json() };
}

/**
 * For tests that set their workspace up by hand (in the current directory) rather
 * than through withWorkspace: review the proposal `jt push` just submitted there.
 * `beforeDecide` runs between the page being rendered and the decision — the window
 * in which Jira can move under an open review.
 */
export async function reviewHere(
  hub: Hub,
  decision: "approve" | "request-changes",
  opts: { proposal?: string; comments?: ReviewComment[]; beforeDecide?: () => void; onPage?: (html: string) => void } = {},
): Promise<Decided["body"]> {
  const { readRegistry } = await import("../src/review/registry.ts");
  const { findWorkspaceRoot } = await import("../src/config.ts");
  const root = findWorkspaceRoot(Deno.cwd());
  const slug = readRegistry().find((e) => e.root === root)?.slug;
  if (!slug) throw new Error(`${root} has not submitted a proposal — jt push registers it`);
  const name = opts.proposal ?? "default";
  const opened = await open(hub, slug, name);
  if (!opened.page || !opened.token) {
    throw new Error(`${name} is not reviewable: ${JSON.stringify(opened.refresh ?? { status: opened.localStatus })}`);
  }
  opts.onPage?.(opened.page);
  opts.beforeDecide?.();
  const comments = opts.comments ?? (decision === "request-changes" ? [{ body: "please change this" }] : []);
  const done = await decide(hub, slug, name, opened.token, decision, comments);
  if (done.status !== 200) throw new Error(`the decision was answered ${done.status}: ${JSON.stringify(done.body)}`);
  return done.body;
}
