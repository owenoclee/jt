import { assertEquals, assertRejects } from "@std/assert";
import { serializeTicket } from "../src/canonical.ts";
import { compilePush } from "../src/compile.ts";
import { UserError } from "../src/errors.ts";
import type { JiraClient } from "../src/jira/client.ts";
import { makeBaseEntry, makeMeta, makeTicket, tempStore } from "./helpers.ts";
import type { Store } from "../src/store.ts";

const meta = makeMeta();

/** Fake client: only the endpoints compile needs (transitions + user search). */
function fakeClient(): JiraClient {
  return {
    // deno-lint-ignore no-explicit-any
    get(path: string): Promise<any> {
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

function ctx(store: Store) {
  return { store, meta, client: fakeClient() };
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

Deno.test("committed deletions compile to DELETE ops", async () => {
  const store = tempStore();
  store.writeDeletions([
    { key: "TST-15", summary: "bye", requestedAt: "now", committed: true },
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
