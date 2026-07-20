import { Store } from "../src/store.ts";
import type { BaseEntry, Config, Meta, Ticket } from "../src/types.ts";

export function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    project: "TST",
    type: "Task",
    summary: "A ticket",
    status: "To Do",
    description: null,
    labels: [],
    parent: null,
    sprint: null,
    assignee: null,
    priority: null,
    links: [],
    comments: [],
    fields: {},
    ...overrides,
  };
}

export function makeBaseEntry(ticket: Ticket, overrides: Partial<BaseEntry> = {}): BaseEntry {
  return {
    key: ticket.key!,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    ticket,
    raw: {
      descriptionAdf: null,
      sprintId: null,
      assigneeAccountId: null,
      statusId: "1",
      linkIds: {},
    },
    ...overrides,
  };
}

export function makeMeta(overrides: Partial<Meta> = {}): Meta {
  return {
    syncedAt: "2026-01-01T00:00:00.000Z",
    fields: [
      { id: "customfield_10016", name: "Story Points", custom: true, schemaType: "number" },
      { id: "customfield_10020", name: "Sprint", custom: true, schemaType: "array", schemaCustom: "com.pyxis.greenhopper.jira:gh-sprint" },
      { id: "customfield_10050", name: "Team", custom: true, schemaType: "option" },
      { id: "summary", name: "Summary", custom: false, schemaType: "string" },
    ],
    issueTypes: [
      { id: "10000", name: "Epic", subtask: false },
      { id: "10001", name: "Story", subtask: false },
      { id: "10002", name: "Task", subtask: false },
    ],
    linkTypes: [
      { id: "10100", name: "Blocks", inward: "is blocked by", outward: "blocks" },
      { id: "10101", name: "Relates", inward: "relates to", outward: "relates to" },
    ],
    priorities: [
      { id: "1", name: "Highest" },
      { id: "3", name: "Medium" },
    ],
    statuses: ["To Do", "In Progress", "Done"],
    sprints: [
      { id: 42, name: "Sprint 42", state: "active" },
      { id: 43, name: "Sprint 43", state: "future" },
    ],
    sprintFieldId: "customfield_10020",
    boardId: 1,
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: "https://example.atlassian.net",
    email: "test@example.com",
    project: "TST",
    trackedFields: ["summary", "description", "status", "labels", "parent", "sprint", "assignee", "priority"],
    customFields: ["Story Points"],
    ...overrides,
  };
}

export function tempStore(): Store {
  const dir = Deno.makeTempDirSync({ prefix: "jt-test-" });
  const store = new Store(dir);
  store.ensureDirs();
  return store;
}
