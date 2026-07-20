/** Thin Jira Cloud REST client: basic auth, JSON, retries on 429/5xx, typed errors. */

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

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export class JiraClient {
  #authHeader: string;

  constructor(public baseUrl: string, email: string, token: string) {
    this.#authHeader = "Basic " + btoa(`${email}:${token}`);
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
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (res.ok) {
        if (res.status === 204) return null;
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }

      const errText = await res.text();
      let errBody: unknown;
      try {
        errBody = JSON.parse(errText);
      } catch {
        errBody = errText;
      }
      lastError = new JiraApiError(
        formatJiraError(method, path, res.status, errBody),
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

function formatJiraError(method: string, path: string, status: number, body: unknown): string {
  const parts: string[] = [];
  if (body && typeof body === "object") {
    const b = body as { errorMessages?: string[]; errors?: Record<string, string> };
    if (Array.isArray(b.errorMessages)) parts.push(...b.errorMessages);
    if (b.errors && typeof b.errors === "object") {
      parts.push(...Object.entries(b.errors).map(([k, v]) => `${k}: ${v}`));
    }
  } else if (typeof body === "string" && body) {
    parts.push(body.slice(0, 300));
  }
  const detail = parts.length ? ` — ${parts.join("; ")}` : "";
  return `Jira API ${method} ${path} failed (HTTP ${status})${detail}`;
}
