import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { serializeTicket } from "../src/canonical.ts";
import { compilePush } from "../src/compile.ts";
import { UserError } from "../src/errors.ts";
import { JiraApiError, type JiraClient } from "../src/jira/client.ts";
import { makeBaseEntry, makeMeta, makeTicket, tempStore } from "./helpers.ts";
import type { Store } from "../src/store.ts";

const meta = makeMeta();

/**
 * Fake client: only the endpoints compile needs (transitions, user search, editmeta).
 * Every known field is on every edit screen, except the ids `offScreen` names per issue.
 */
function fakeClient(offScreen: Record<string, string[]> = {}): JiraClient {
  return {
    // deno-lint-ignore no-explicit-any
    get(path: string): Promise<any> {
      const editmeta = path.match(/\/issue\/([A-Z]+-\d+)\/editmeta$/);
      if (editmeta) {
        const off = new Set(offScreen[editmeta[1]] ?? []);
        return Promise.resolve({
          fields: Object.fromEntries(
            meta.fields.filter((f) => !off.has(f.id)).map((f) => [f.id, { name: f.name }]),
          ),
        });
      }
      if (path.endsWith("/transitions")) {
        return Promise.resolve({
          transitions: [
            { id: "11", to: { name: "To Do" } },
            { id: "21", to: { name: "In Progress" } },
            { id: "31", to: { name: "Done" } },
          ],
        });
      }
      if (path.endsWith("/user/search")) {
        return Promise.resolve([
          { accountId: "acc-123", emailAddress: "owen@example.com" },
        ]);
      }
      throw new Error(`fake client: unexpected GET ${path}`);
    },
  } as unknown as JiraClient;
}

function ctx(store: Store, offScreen: Record<string, string[]> = {}) {
  return { store, meta, client: fakeClient(offScreen) };
}

Deno.test("push compiles from committed layer only — working-tree tampering is invisible", async () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-1", summary: "original" });
  store.writeBase(makeBaseEntry(base));
  const approved = { ...base, summary: "approved summary" };
  store.writeCommitted("TST-1", serializeTicket(approved));
  // Tamper: the working tree says something else entirely.
  store.writeWorking("TST-1", { ...base, summary: "TAMPERED after review" });

  const { ops } = await compilePush(ctx(store));
  assertEquals(ops.length, 1);
  // deno-lint-ignore no-explicit-any
  const fields = (ops[0].body as any).fields;
  assertEquals(fields.summary, "approved summary");
});

Deno.test("field updates compile: sprint, labels, custom fields, assignee, parent", async () => {
  const store = tempStore();
  const base = makeTicket({
    key: "TST-2",
    summary: "s",
    labels: ["old"],
    fields: { "Story Points": 3 },
  });
  store.writeBase(makeBaseEntry(base));
  const committed = {
    ...base,
    labels: ["old", "added"],
    sprint: "Sprint 42",
    parent: "TST-100",
    assignee: "owen@example.com",
    priority: "Highest",
    fields: { "Story Points": 8 },
  };
  store.writeCommitted("TST-2", serializeTicket(committed));

  const { ops, existingKeys } = await compilePush(ctx(store));
  assertEquals(existingKeys, ["TST-2"]);
  assertEquals(ops.length, 1);
  // deno-lint-ignore no-explicit-any
  const fields = (ops[0].body as any).fields;
  assertEquals(fields.labels, ["added", "old"]);
  assertEquals(fields.customfield_10020, 42); // sprint by name -> id
  assertEquals(fields.customfield_10016, 8); // Story Points by alias
  assertEquals(fields.parent, { key: "TST-100" });
  assertEquals(fields.assignee, { accountId: "acc-123" });
  assertEquals(fields.priority, { id: "1" });
  assertEquals(fields.summary, undefined); // unchanged fields are not sent
});

Deno.test("component-array fields compile to {name} objects", async () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-20", fields: { Components: ["api"] } });
  store.writeBase(makeBaseEntry(base));
  store.writeCommitted(
    "TST-20",
    serializeTicket({ ...base, fields: { Components: ["api", "webhooks"] } }),
  );

  const { ops } = await compilePush(ctx(store));
  assertEquals(ops.length, 1);
  // deno-lint-ignore no-explicit-any
  const fields = (ops[0].body as any).fields;
  assertEquals(fields.components, [{ name: "api" }, { name: "webhooks" }]);
});

Deno.test("component-array fields reject non-array values", async () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-21", fields: { Components: ["api"] } });
  store.writeBase(makeBaseEntry(base));
  store.writeCommitted(
    "TST-21",
    serializeTicket({ ...base, fields: { Components: "api" } }),
  );
  await assertRejects(() => compilePush(ctx(store)), UserError, "array of component names");
});

Deno.test("status change compiles to a transition with resolved id", async () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-3", status: "To Do" });
  store.writeBase(makeBaseEntry(base));
  store.writeCommitted("TST-3", serializeTicket({ ...base, status: "In Progress" }));

  const { ops } = await compilePush(ctx(store));
  assertEquals(ops.length, 1);
  assertEquals(ops[0].kind, "transition");
  assertEquals(ops[0].body, { transition: { id: "21" } });
});

Deno.test("creates order parents first and chain @refs", async () => {
  const store = tempStore();
  const epic = makeTicket({ type: "Epic", summary: "the epic" });
  delete epic.status;
  const child = makeTicket({ type: "Story", summary: "the story", parent: "@epic" });
  delete child.status;
  store.writeWorking("@epic", epic);
  store.writeWorking("@story", child);
  store.writeCommitted("@epic", serializeTicket(epic));
  store.writeCommitted("@story", serializeTicket(child));

  const { ops } = await compilePush(ctx(store));
  const creates = ops.filter((o) => o.kind === "create");
  assertEquals(creates.map((o) => o.refId), ["@epic", "@story"]);
  // deno-lint-ignore no-explicit-any
  assertEquals((creates[1].body as any).fields.parent, { key: "@epic" });
});

Deno.test("existing ticket re-parented onto a committed creation compiles in one push", async () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-30" });
  store.writeBase(makeBaseEntry(base));
  store.writeCommitted("TST-30", serializeTicket({ ...base, parent: "@epic" }));
  const epic = makeTicket({ type: "Epic", summary: "the epic" });
  delete epic.status;
  store.writeCommitted("@epic", serializeTicket(epic));

  const { ops } = await compilePush(ctx(store));
  // The create precedes the update, so the @ref resolves at execution time.
  assertEquals(ops.map((o) => o.kind), ["create", "update"]);
  assertEquals(ops[1].issue, "TST-30");
  // deno-lint-ignore no-explicit-any
  assertEquals((ops[1].body as any).fields.parent, { key: "@epic" });
});

Deno.test("existing ticket parent -> uncommitted @ref is a hard error", async () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-31" });
  store.writeBase(makeBaseEntry(base));
  store.writeCommitted("TST-31", serializeTicket({ ...base, parent: "@nope" }));
  await assertRejects(() => compilePush(ctx(store)), UserError, "not a committed new ticket");
});

Deno.test("link ops: direction mapping and cross-file dedupe", async () => {
  const store = tempStore();
  const a = makeTicket({ key: "TST-10", links: [] });
  const b = makeTicket({ key: "TST-11", links: [] });
  store.writeBase(makeBaseEntry(a));
  store.writeBase(makeBaseEntry(b));
  // Same link staged from both sides.
  store.writeCommitted(
    "TST-10",
    serializeTicket({ ...a, links: [{ type: "blocks", to: "TST-11" }] }),
  );
  store.writeCommitted(
    "TST-11",
    serializeTicket({ ...b, links: [{ type: "is blocked by", to: "TST-10" }] }),
  );

  const { ops } = await compilePush(ctx(store));
  const links = ops.filter((o) => o.kind === "link");
  assertEquals(links.length, 1); // deduped
  assertEquals(links[0].body, {
    type: { name: "Blocks" },
    inwardIssue: { key: "TST-10" },
    outwardIssue: { key: "TST-11" },
  });
});

Deno.test("unlink uses the stored link id", async () => {
  const store = tempStore();
  const a = makeTicket({ key: "TST-12", links: [{ type: "relates to", to: "TST-13" }] });
  store.writeBase(
    makeBaseEntry(a, {
      raw: {
        descriptionAdf: null,
        sprintId: null,
        assigneeAccountId: null,
        statusId: "1",
        linkIds: { "relates to|TST-13": "9999" },
      },
    }),
  );
  store.writeCommitted("TST-12", serializeTicket({ ...a, links: [] }));

  const { ops } = await compilePush(ctx(store));
  assertEquals(ops.length, 1);
  assertEquals(ops[0].kind, "unlink");
  assertEquals(ops[0].path, "/rest/api/3/issueLink/9999");
});

Deno.test("a link removed from both ends compiles to one DELETE", async () => {
  const store = tempStore();
  const raw = (linkIds: Record<string, string>) => ({
    raw: { descriptionAdf: null, sprintId: null, assigneeAccountId: null, statusId: "1", linkIds },
  });
  const a = makeTicket({ key: "TST-40", links: [{ type: "relates to", to: "TST-41" }] });
  const b = makeTicket({ key: "TST-41", links: [{ type: "relates to", to: "TST-40" }] });
  // One Jira link, seen from each end — the same id on both.
  store.writeBase(makeBaseEntry(a, raw({ "relates to|TST-41": "9001" })));
  store.writeBase(makeBaseEntry(b, raw({ "relates to|TST-40": "9001" })));
  store.writeCommitted("TST-40", serializeTicket({ ...a, links: [] }));
  store.writeCommitted("TST-41", serializeTicket({ ...b, links: [] }));

  const { ops } = await compilePush(ctx(store));
  assertEquals(ops.map((o) => [o.method, o.path]), [["DELETE", "/rest/api/3/issueLink/9001"]]);
});

Deno.test("a symmetric link added from both ends compiles to one POST", async () => {
  const store = tempStore();
  const a = makeTicket({ key: "TST-42" });
  const b = makeTicket({ key: "TST-43" });
  store.writeBase(makeBaseEntry(a));
  store.writeBase(makeBaseEntry(b));
  // "relates to" reads the same from both ends; sent twice, Jira would keep two links.
  store.writeCommitted("TST-42", serializeTicket({ ...a, links: [{ type: "relates to", to: "TST-43" }] }));
  store.writeCommitted("TST-43", serializeTicket({ ...b, links: [{ type: "relates to", to: "TST-42" }] }));

  const { ops } = await compilePush(ctx(store));
  assertEquals(ops.length, 1);
  assertEquals(ops[0].body, {
    type: { name: "Relates" },
    inwardIssue: { key: "TST-42" },
    outwardIssue: { key: "TST-43" },
  });
});

Deno.test("a custom field absent from the committed copy and null in base is no change", async () => {
  const store = tempStore();
  // Base was refetched after "Team" joined customFields; the committed copy predates it.
  const base = makeTicket({ key: "TST-44", type: "Epic", fields: { "Story Points": 3, Team: null } });
  store.writeBase(makeBaseEntry(base));
  store.writeCommitted(
    "TST-44",
    serializeTicket({ ...base, status: "In Progress", fields: { "Story Points": 3 } }),
  );

  const { ops } = await compilePush(ctx(store));
  assertEquals(ops.map((o) => o.kind), ["transition"], "no PUT clearing a field that has no value");
});

Deno.test("a custom field off the issue's edit screen is refused before anything is sent", async () => {
  const store = tempStore();
  const epic = makeTicket({ key: "TST-45", type: "Epic", fields: { Team: null } });
  const task = makeTicket({ key: "TST-46", fields: { Team: null } });
  store.writeBase(makeBaseEntry(epic));
  store.writeBase(makeBaseEntry(task));
  store.writeCommitted("TST-45", serializeTicket({ ...epic, fields: { Team: "Platform" } }));
  store.writeCommitted("TST-46", serializeTicket({ ...task, fields: { Team: "Platform" } }));

  const err = await assertRejects(
    () => compilePush(ctx(store, { "TST-45": ["customfield_10050"] })),
    UserError,
  );
  assertStringIncludes(err.message, "TST-45 (Epic): 'Team'");
  assertStringIncludes(err.message, "Nothing was sent");
  assert(!err.message.includes("TST-46"), "the Task's screen has the field");

  // Clearing it is a write too, and Jira refuses that just the same.
  store.writeBase(makeBaseEntry({ ...epic, fields: { Team: "Platform" } }));
  store.writeCommitted("TST-45", serializeTicket({ ...epic, fields: { Team: null } }));
  store.removeCommitted("TST-46");
  await assertRejects(
    () => compilePush(ctx(store, { "TST-45": ["customfield_10050"] })),
    UserError,
    "TST-45 (Epic): 'Team'",
  );
});

Deno.test("when Jira will not describe the edit screen, compile leaves the field to the push", async () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-47", fields: { Team: null } });
  store.writeBase(makeBaseEntry(base));
  store.writeCommitted("TST-47", serializeTicket({ ...base, fields: { Team: "Platform" } }));
  const client = {
    get(path: string) {
      if (path.endsWith("/editmeta")) {
        return Promise.reject(new JiraApiError("forbidden", 403, "GET", path));
      }
      return fakeClient().get(path);
    },
  } as unknown as JiraClient;

  const { ops } = await compilePush({ store, meta, client });
  // deno-lint-ignore no-explicit-any
  assertEquals((ops[0].body as any).fields, { customfield_10050: { value: "Platform" } });
});

Deno.test("new comments compile to comment ops; edited existing comments are fatal", async () => {
  const store = tempStore();
  const base = makeTicket({
    key: "TST-14",
    comments: [{ id: "1", author: "x", created: "y", body: "existing" }],
  });
  store.writeBase(makeBaseEntry(base));
  store.writeCommitted(
    "TST-14",
    serializeTicket({
      ...base,
      comments: [...base.comments, { body: "fresh comment" }],
    }),
  );
  const { ops } = await compilePush(ctx(store));
  assertEquals(ops.length, 1);
  assertEquals(ops[0].kind, "comment");

  // Now stage an edit to the existing comment.
  store.writeCommitted(
    "TST-14",
    serializeTicket({
      ...base,
      comments: [{ id: "1", author: "x", created: "y", body: "REWRITTEN" }],
    }),
  );
  await assertRejects(() => compilePush(ctx(store)), UserError, "append-only");
});

Deno.test("committed archive and unarchive intents compile to their own ops", async () => {
  const store = tempStore();
  store.writeIntents([
    { key: "TST-16", mode: "archive", summary: "old", requestedAt: "now", committed: true },
    { key: "TST-17", mode: "unarchive", summary: "back", requestedAt: "now", committed: true },
  ]);
  const { ops } = await compilePush(ctx(store));
  assertEquals(ops.length, 2);
  assertEquals(ops[0].method, "PUT");
  assertEquals(ops[0].path, "/rest/api/3/issue/archive");
  assertEquals(ops[0].body, { issueIdsOrKeys: ["TST-16"] });
  assertEquals(ops[1].method, "PUT");
  assertEquals(ops[1].path, "/rest/api/3/issue/unarchive");
  assertEquals(ops[1].body, { issueIdsOrKeys: ["TST-17"] });
});

Deno.test("committed deletions compile to DELETE ops", async () => {
  const store = tempStore();
  store.writeIntents([
    { key: "TST-15", mode: "delete", summary: "bye", requestedAt: "now", committed: true },
  ]);
  const { ops } = await compilePush(ctx(store));
  assertEquals(ops.length, 1);
  assertEquals(ops[0].method, "DELETE");
  assertEquals(ops[0].path, "/rest/api/3/issue/TST-15");
});

Deno.test("unreachable status target lists reachable ones", async () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-16", status: "To Do" });
  store.writeBase(makeBaseEntry(base));
  store.writeCommitted("TST-16", serializeTicket({ ...base, status: "Done" }));
  // fake client CAN reach Done — so make an unreachable one instead
  const meta2 = makeMeta({ statuses: ["To Do", "In Progress", "Done", "Blocked"] });
  store.removeCommitted("TST-16");
  store.writeCommitted("TST-16", serializeTicket({ ...base, status: "Blocked" }));
  await assertRejects(
    () => compilePush({ store, meta: meta2, client: fakeClient() }),
    UserError,
    "Reachable",
  );
});

Deno.test("nothing committed is a friendly error", async () => {
  const store = tempStore();
  await assertRejects(() => compilePush(ctx(store)), UserError, "nothing committed");
});
