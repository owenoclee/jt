/** In-memory Jira Cloud fixture served over real HTTP for end-to-end tests. */
// deno-lint-ignore-file no-explicit-any

interface MockIssue {
  key: string;
  project: string;
  issuetype: string;
  summary: string;
  description: any;
  status: string;
  labels: string[];
  parent: string | null;
  priority: string | null;
  assignee: { accountId: string; emailAddress: string } | null;
  sprintId: number | null;
  storyPoints: number | null;
  comments: { id: string; author: string; created: string; body: any }[];
  updated: string;
}

const ISSUE_TYPES = [
  { id: "10000", name: "Epic", subtask: false },
  { id: "10001", name: "Story", subtask: false },
  { id: "10002", name: "Task", subtask: false },
];
const TRANSITIONS = [
  { id: "11", to: { name: "To Do" } },
  { id: "21", to: { name: "In Progress" } },
  { id: "31", to: { name: "Done" } },
];
const PRIORITIES = [
  { id: "1", name: "Highest" },
  { id: "3", name: "Medium" },
];

export class MockJira {
  issues = new Map<string, MockIssue>();
  links = new Map<string, { id: string; typeName: string; inwardKey: string; outwardKey: string }>();
  requestLog: { method: string; path: string; body?: any }[] = [];
  /** When set, search results inline at most this many comments per issue (total stays honest). */
  searchCommentCap: number | null = null;
  /** Simulate Jira's strict JQL validation rejecting `key in (...)` (e.g. a key no longer exists). */
  rejectKeyInSearch = false;
  #issueCounter = 1;
  #idCounter = 1000;
  #clock = 0;
  #server?: Deno.HttpServer;
  baseUrl = "";

  seedIssue(overrides: Partial<MockIssue> & { summary: string }): MockIssue {
    const key = `TST-${this.#issueCounter++}`;
    const issue: MockIssue = {
      key,
      project: "TST",
      issuetype: "Task",
      description: null,
      status: "To Do",
      labels: [],
      parent: null,
      priority: null,
      assignee: null,
      sprintId: null,
      storyPoints: null,
      comments: [],
      updated: this.#tick(),
      ...overrides,
    };
    this.issues.set(issue.key, issue);
    return issue;
  }

  #tick(): string {
    this.#clock += 1;
    return new Date(1780000000000 + this.#clock * 1000).toISOString();
  }

  touch(key: string): void {
    const issue = this.issues.get(key);
    if (issue) issue.updated = this.#tick();
  }

  start(): void {
    this.#server = Deno.serve({ port: 0, onListen: () => {} }, (req) => this.#handle(req));
    const addr = this.#server.addr as Deno.NetAddr;
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await this.#server?.shutdown();
  }

  async #handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = req.method === "POST" || req.method === "PUT"
      ? await req.json().catch(() => undefined)
      : undefined;
    this.requestLog.push({ method: req.method, path, body });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const notFound = () =>
      json({ errorMessages: ["Issue does not exist or you do not have permission to see it."] }, 404);

    // ---- meta endpoints ----
    if (path === "/rest/api/3/field") {
      return json([
        { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
        { id: "customfield_10016", name: "Story Points", custom: true, schema: { type: "number" } },
        {
          id: "customfield_10020",
          name: "Sprint",
          custom: true,
          schema: { type: "array", custom: "com.pyxis.greenhopper.jira:gh-sprint", items: "json" },
        },
      ]);
    }
    if (path === "/rest/api/3/issue/createmeta/TST/issuetypes") {
      return json({ issueTypes: ISSUE_TYPES });
    }
    if (path === "/rest/api/3/issueLinkType") {
      return json({
        issueLinkTypes: [
          { id: "10100", name: "Blocks", inward: "is blocked by", outward: "blocks" },
          { id: "10101", name: "Relates", inward: "relates to", outward: "relates to" },
        ],
      });
    }
    if (path === "/rest/api/3/priority") return json(PRIORITIES);
    if (path === "/rest/api/3/project/TST/statuses") {
      return json([
        { name: "Task", statuses: [{ name: "To Do" }, { name: "In Progress" }, { name: "Done" }] },
      ]);
    }
    if (path === "/rest/agile/1.0/board") return json({ values: [{ id: 1, type: "scrum" }] });
    if (path === "/rest/agile/1.0/board/1/sprint") {
      return json({ values: [{ id: 42, name: "Sprint 42", state: "active" }], isLast: true });
    }
    if (path === "/rest/api/3/user/search") {
      return json([{ accountId: "acc-1", emailAddress: "t@example.com" }]);
    }
    if (path === "/rest/api/3/search/jql" && req.method === "POST") {
      const jql: string = body?.jql ?? "";
      let list = [...this.issues.values()];
      const proj = jql.match(/project\s*=\s*([A-Z][A-Z0-9_]*)/);
      if (proj) list = list.filter((i) => i.project === proj[1]);
      const keyIn = jql.match(/key\s+in\s+\(([^)]*)\)/i);
      if (keyIn) {
        if (this.rejectKeyInSearch) {
          return json({ errorMessages: ["An issue with key does not exist for field 'key'."] }, 400);
        }
        const wanted = new Set(keyIn[1].split(",").map((s) => s.trim()));
        list = list.filter((i) => wanted.has(i.key));
      }
      if (/order by updated desc/i.test(jql)) {
        list.sort((a, b) => b.updated.localeCompare(a.updated));
      } else {
        list.sort((a, b) => a.key.localeCompare(b.key));
      }
      const max = Math.min(Number(body?.maxResults ?? 50), 100);
      const start = Number(body?.nextPageToken ?? 0);
      const pageIssues = list.slice(start, start + max);
      const fields: string[] = body?.fields ?? ["key"];
      const keyOnly = fields.length === 1 && (fields[0] === "key" || fields[0] === "id");
      const issues = pageIssues.map((i) => keyOnly ? { key: i.key } : this.#render(i, true));
      const next = start + max < list.length ? { nextPageToken: String(start + max) } : {};
      return json({ issues, ...next });
    }

    // ---- issue CRUD ----
    if (path === "/rest/api/3/issue" && req.method === "POST") {
      const f = body.fields;
      const typeName = ISSUE_TYPES.find((t) => t.id === f.issuetype?.id)?.name ?? "Task";
      const issue = this.seedIssue({
        summary: f.summary,
        project: f.project?.key ?? "TST",
        issuetype: typeName,
        description: f.description ?? null,
        labels: f.labels ?? [],
        priority: f.priority ? PRIORITIES.find((p) => p.id === f.priority.id)?.name ?? null : null,
        assignee: f.assignee ? { accountId: f.assignee.accountId, emailAddress: "t@example.com" } : null,
        parent: f.parent?.key ?? null,
      });
      return json({ id: issue.key, key: issue.key }, 201);
    }

    const issueMatch = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/);
    if (issueMatch) {
      const issue = this.issues.get(issueMatch[1]);
      if (!issue) return notFound();
      if (req.method === "GET") return json(this.#render(issue));
      if (req.method === "PUT") {
        this.#applyUpdate(issue, body.fields ?? {});
        return new Response(null, { status: 204 });
      }
      if (req.method === "DELETE") {
        this.issues.delete(issue.key);
        for (const [id, l] of this.links) {
          if (l.inwardKey === issue.key || l.outwardKey === issue.key) this.links.delete(id);
        }
        return new Response(null, { status: 204 });
      }
    }

    const transMatch = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/transitions$/);
    if (transMatch) {
      const issue = this.issues.get(transMatch[1]);
      if (!issue) return notFound();
      if (req.method === "GET") return json({ transitions: TRANSITIONS });
      const t = TRANSITIONS.find((t) => t.id === body.transition?.id);
      if (!t) return json({ errorMessages: ["invalid transition"] }, 400);
      issue.status = t.to.name;
      issue.updated = this.#tick();
      return new Response(null, { status: 204 });
    }

    const commentMatch = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/);
    if (commentMatch && req.method === "POST") {
      const issue = this.issues.get(commentMatch[1]);
      if (!issue) return notFound();
      const comment = {
        id: String(this.#idCounter++),
        author: "Mock User",
        created: this.#tick(),
        body: body.body,
      };
      issue.comments.push(comment);
      issue.updated = this.#tick();
      return json({ id: comment.id }, 201);
    }

    if (path === "/rest/api/3/issueLink" && req.method === "POST") {
      const id = String(this.#idCounter++);
      const inwardKey = body.inwardIssue.key;
      const outwardKey = body.outwardIssue.key;
      if (!this.issues.has(inwardKey) || !this.issues.has(outwardKey)) return notFound();
      this.links.set(id, { id, typeName: body.type.name, inwardKey, outwardKey });
      this.touch(inwardKey);
      this.touch(outwardKey);
      return new Response(null, { status: 201 });
    }
    const linkMatch = path.match(/^\/rest\/api\/3\/issueLink\/(\d+)$/);
    if (linkMatch && req.method === "DELETE") {
      const link = this.links.get(linkMatch[1]);
      if (!link) return notFound();
      this.links.delete(linkMatch[1]);
      this.touch(link.inwardKey);
      this.touch(link.outwardKey);
      return new Response(null, { status: 204 });
    }

    return json({ errorMessages: [`mock: unhandled ${req.method} ${path}`] }, 500);
  }

  #applyUpdate(issue: MockIssue, fields: Record<string, any>): void {
    if ("summary" in fields) issue.summary = fields.summary;
    if ("description" in fields) issue.description = fields.description;
    if ("labels" in fields) issue.labels = fields.labels;
    if ("parent" in fields) issue.parent = fields.parent?.key ?? null;
    if ("priority" in fields) {
      issue.priority = fields.priority
        ? PRIORITIES.find((p) => p.id === fields.priority.id)?.name ?? null
        : null;
    }
    if ("assignee" in fields) {
      issue.assignee = fields.assignee
        ? { accountId: fields.assignee.accountId, emailAddress: "t@example.com" }
        : null;
    }
    if ("issuetype" in fields) {
      issue.issuetype = ISSUE_TYPES.find((t) => t.id === fields.issuetype.id)?.name ?? issue.issuetype;
    }
    if ("customfield_10016" in fields) issue.storyPoints = fields.customfield_10016;
    if ("customfield_10020" in fields) issue.sprintId = fields.customfield_10020;
    issue.updated = this.#tick();
  }

  #render(issue: MockIssue, forSearch = false): any {
    const issuelinks: any[] = [];
    for (const l of this.links.values()) {
      const type = {
        id: l.typeName === "Blocks" ? "10100" : "10101",
        name: l.typeName,
        inward: l.typeName === "Blocks" ? "is blocked by" : "relates to",
        outward: l.typeName === "Blocks" ? "blocks" : "relates to",
      };
      if (l.inwardKey === issue.key) {
        issuelinks.push({ id: l.id, type, outwardIssue: { key: l.outwardKey } });
      } else if (l.outwardKey === issue.key) {
        issuelinks.push({ id: l.id, type, inwardIssue: { key: l.inwardKey } });
      }
    }
    return {
      key: issue.key,
      fields: {
        summary: issue.summary,
        description: issue.description,
        status: { id: "1", name: issue.status },
        labels: issue.labels,
        parent: issue.parent ? { key: issue.parent } : null,
        priority: issue.priority ? { name: issue.priority } : null,
        assignee: issue.assignee,
        updated: issue.updated,
        issuetype: { name: issue.issuetype },
        project: { key: issue.project },
        comment: {
          comments: forSearch && this.searchCommentCap !== null
            ? issue.comments.slice(0, this.searchCommentCap)
            : issue.comments,
          total: issue.comments.length,
        },
        issuelinks,
        customfield_10020: issue.sprintId === null
          ? null
          : [{ id: issue.sprintId, name: `Sprint ${issue.sprintId}`, state: "active" }],
        customfield_10016: issue.storyPoints,
      },
    };
  }
}
