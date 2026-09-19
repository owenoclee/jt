/** Thin Jira Cloud REST client: basic auth, JSON, retries on 429/5xx, typed errors. */
import { credentialsPath } from "../config.ts";

/** Where a new API token comes from — quoted whenever auth fails. */
export const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

export class JiraApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public method: string,
    public path: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

/**
 * Jira stamps this header on every response whose credentials were rejected —
 * including responses that do not look like failures at all. Verified against a live
 * site with a bad token: `GET /rest/api/3/issue/KEY` answers 404 "issue does not exist
 * or you do not have permission" (localized), and `POST /rest/api/3/search/jql`
 * answers 200 with an empty issue list, as if the project had been emptied. Reading
 * the status alone, an expired token looks exactly like every ticket being deleted
 * remotely — so the header is what we read. A valid token never carries it.
 */
const AUTH_FAILED_HEADER = "x-seraph-loginreason";
const AUTH_FAILED = "AUTHENTICATED_FAILED";

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export class JiraClient {
  #authHeader: string;
  #email: string;
  #tokenSource: string;

  constructor(public baseUrl: string, email: string, token: string, tokenSource = "") {
    this.#authHeader = "Basic " + btoa(`${email}:${token}`);
    this.#email = email;
    this.#tokenSource = tokenSource;
  }

  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    let lastError: JiraApiError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.#authHeader,
          Accept: "application/json",
          // Without this, a rejected request comes back in the site's default language
          // — confirmed against a live site, where the same 404 reads
          // "事务不存在或者您没有查看的权限。" with no Accept-Language and
          // "Issue does not exist or you do not have permission to see it." with one.
          "Accept-Language": "en",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if ((res.headers.get(AUTH_FAILED_HEADER) ?? "").includes(AUTH_FAILED)) {
        const seen = await res.text();
        throw new JiraApiError(
          authFailure(method, path, res.status, jiraDetail(parseBody(seen)), {
            email: this.#email,
            tokenSource: this.#tokenSource,
          }),
          res.status,
          method,
          path,
          seen,
        );
      }

      if (res.ok) {
        if (res.status === 204) return null;
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }

      const errBody = parseBody(await res.text());
      lastError = new JiraApiError(
        formatJiraError(method, path, res.status, errBody, {
          email: this.#email,
          tokenSource: this.#tokenSource,
        }),
        res.status,
        method,
        path,
        errBody,
      );
      if (!RETRYABLE.has(res.status)) throw lastError;
      const retryAfter = Number(res.headers.get("Retry-After"));
      const delay = retryAfter > 0 ? retryAfter * 1000 : attempt * 1500;
      await new Promise((r) => setTimeout(r, delay));
    }
    throw lastError;
  }

  get(path: string, query?: Record<string, string>) {
    return this.request("GET", path, undefined, query);
  }
  post(path: string, body?: unknown) {
    return this.request("POST", path, body);
  }
  put(path: string, body?: unknown) {
    return this.request("PUT", path, body);
  }
  delete(path: string, query?: Record<string, string>) {
    return this.request("DELETE", path, undefined, query);
  }
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface AuthContext {
  email: string;
  tokenSource: string;
}

function formatJiraError(
  method: string,
  path: string,
  status: number,
  body: unknown,
  auth?: AuthContext,
): string {
  const detail = jiraDetail(body);
  const base = `Jira API ${method} ${path} failed (HTTP ${status})${detail ? ` — ${detail}` : ""}`;
  const hint = explain(status, detail, auth) || explainArchive(status, path) ||
    explainInvalidInput(status, detail);
  return hint ? `${base}\n${hint}` : base;
}

/** Jira's own words, from whichever shape this endpoint answers errors in. */
function jiraDetail(body: unknown): string {
  const parts: string[] = [];
  if (body && typeof body === "object") {
    const b = body as {
      errorMessages?: string[];
      errors?: Record<string, string>;
      message?: string;
    };
    if (Array.isArray(b.errorMessages)) parts.push(...b.errorMessages);
    if (b.errors && typeof b.errors === "object") {
      parts.push(...Object.entries(b.errors).map(([k, v]) => `${k}: ${v}`));
    }
    // Some endpoints (and every gateway in front of them) answer with `message`
    // instead — and localize it, which is how an expired token ends up reported in
    // a language nobody asked for.
    if (!parts.length && typeof b.message === "string" && b.message) parts.push(b.message);
  } else if (typeof body === "string" && body) {
    parts.push(stripHtml(body).slice(0, 300));
  }
  return parts.join("; ");
}

function stripHtml(text: string): string {
  if (!/<[a-z!/]/i.test(text)) return text.trim();
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** A request Jira served as an anonymous stranger, whatever status it chose to use. */
function authFailure(
  method: string,
  path: string,
  status: number,
  detail: string,
  auth: AuthContext,
): string {
  const evidence = detail ? ` — ${detail}` : "";
  return `Jira rejected the credentials on ${method} ${path} ` +
    `(HTTP ${status}, ${AUTH_FAILED_HEADER}: ${AUTH_FAILED})${evidence}\n` +
    expiredTokenHint(auth) + "\n" +
    `  nothing was read: an unauthenticated request is answered as if the data were ` +
    `missing (404s, empty searches), so this is not a deleted ticket or an empty project`;
}

function expiredTokenHint(auth?: AuthContext): string {
  const where = auth?.tokenSource ? ` (in use: ${auth.tokenSource})` : "";
  const account = auth?.email ? ` It must belong to ${auth.email}.` : "";
  return `  your Jira API token was rejected — it has most likely expired or been revoked${where}\n` +
    `  create a new one at ${TOKEN_PAGE} and set JIRA_API_TOKEN or write it to ${credentialsPath()}.${account}`;
}

/**
 * Turn the two auth failures into something actionable. Jira answers an expired or
 * revoked API token with a bare 401 whose body is unhelpful — sometimes an HTML login
 * page, sometimes a message in the site's language — so the status code, not the text,
 * is what we read.
 */
/**
 * Jira refuses a malformed rich-text document with a bare `INVALID_INPUT` and nothing
 * else — no field, no position. `jt commit` catches these before a push is ever
 * served (see src/adf/validate.ts); reaching one here means a document slipped past
 * that check, so name the usual culprits rather than passing the blankness along.
 */
function explainInvalidInput(status: number, detail: string): string {
  if (status !== 400 || !/INVALID_INPUT/.test(detail)) return "";
  return "  Jira rejected the rich text itself. Usual causes: a code span that is also " +
    "bold/italic/struck, or a heading, rule or quote nested inside a blockquote or list " +
    "item — all invalid in ADF. Fix the markdown and commit again";
}

/** Archiving is Premium/Enterprise only, and Jira's refusal doesn't always say so. */
function explainArchive(status: number, path: string): string {
  if (status < 400 || status >= 500) return "";
  if (!/\/archive$|\/issue\/unarchive$/.test(path)) return "";
  return "  archiving issues requires a Jira Premium or Enterprise plan — on other plans, " +
    "use jt rm (permanent) or close the ticket instead";
}

function explain(status: number, detail: string, auth?: AuthContext): string {
  if (status !== 401 && status !== 403) return "";
  if (status === 401) return expiredTokenHint(auth);
  const where = auth?.tokenSource ? ` (in use: ${auth.tokenSource})` : "";
  if (/captcha/i.test(detail)) {
    return `  Jira is demanding a CAPTCHA — sign in to the site in a browser once, then retry.`;
  }
  return `  the credentials are accepted but not permitted to do this. If this used to work, ` +
    `the API token may have been revoked — a new one: ${TOKEN_PAGE}${where}`;
}
