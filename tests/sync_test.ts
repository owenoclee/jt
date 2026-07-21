import { assert, assertEquals } from "@std/assert";
import { serializeTicket, ticketsEqual } from "../src/canonical.ts";
import { diffTickets } from "../src/diff.ts";
import { integrateFetched } from "../src/sync.ts";
import { makeBaseEntry, makeTicket, tempStore } from "./helpers.ts";

Deno.test("integrate: first fetch materializes working file", () => {
  const store = tempStore();
  const fresh = makeBaseEntry(makeTicket({ key: "TST-1", summary: "hello" }));
  const result = integrateFetched(store, fresh);
  assertEquals(result.kind, "created");
  assertEquals(store.readWorking("TST-1")!.ticket.summary, "hello");
  assertEquals(store.readBase("TST-1")!.updated, fresh.updated);
});

Deno.test("integrate: clean working file is refreshed to remote state", () => {
  const store = tempStore();
  const v1 = makeBaseEntry(makeTicket({ key: "TST-1", summary: "v1" }));
  integrateFetched(store, v1);
  const v2 = makeBaseEntry(makeTicket({ key: "TST-1", summary: "v2" }), {
    updated: "2026-02-01T00:00:00.000Z",
  });
  const result = integrateFetched(store, v2);
  assertEquals(result.kind, "refreshed");
  assertEquals(store.readWorking("TST-1")!.ticket.summary, "v2");
});

Deno.test("integrate: disjoint local + remote edits rebase cleanly", () => {
  const store = tempStore();
  const v1 = makeBaseEntry(makeTicket({ key: "TST-1", summary: "v1", labels: [] }));
  integrateFetched(store, v1);
  // local edit: labels
  const w = store.readWorking("TST-1")!.ticket;
  store.writeWorking("TST-1", { ...w, labels: ["local-label"] });
  // remote edit: summary
  const v2 = makeBaseEntry(makeTicket({ key: "TST-1", summary: "v2 remote", labels: [] }), {
    updated: "2026-02-01T00:00:00.000Z",
  });
  const result = integrateFetched(store, v2);
  assertEquals(result.kind, "rebased");
  const after = store.readWorking("TST-1")!.ticket;
  assertEquals(after.summary, "v2 remote"); // remote flowed in
  assertEquals(after.labels, ["local-label"]); // local preserved
});

Deno.test("integrate: overlapping edits become a conflict and nothing moves", () => {
  const store = tempStore();
  const v1 = makeBaseEntry(makeTicket({ key: "TST-1", summary: "v1" }));
  integrateFetched(store, v1);
  const w = store.readWorking("TST-1")!.ticket;
  store.writeWorking("TST-1", { ...w, summary: "local version" });
  const v2 = makeBaseEntry(makeTicket({ key: "TST-1", summary: "remote version" }), {
    updated: "2026-02-01T00:00:00.000Z",
  });
  const result = integrateFetched(store, v2);
  assertEquals(result.kind, "conflict");
  assert(result.kind === "conflict" && result.fields.includes("summary"));
  // base NOT advanced, working untouched
  assertEquals(store.readBase("TST-1")!.ticket.summary, "v1");
  assertEquals(store.readWorking("TST-1")!.ticket.summary, "local version");
  assertEquals(store.readConflicts().length, 1);
});

Deno.test("integrate: both sides changing to the same value is not a conflict", () => {
  const store = tempStore();
  const v1 = makeBaseEntry(makeTicket({ key: "TST-1", status: "To Do" }));
  integrateFetched(store, v1);
  const w = store.readWorking("TST-1")!.ticket;
  store.writeWorking("TST-1", { ...w, status: "Done" });
  const v2 = makeBaseEntry(makeTicket({ key: "TST-1", status: "Done" }), {
    updated: "2026-02-01T00:00:00.000Z",
  });
  const result = integrateFetched(store, v2);
  assert(result.kind === "refreshed" || result.kind === "rebased");
  assertEquals(store.status()[0].state, "clean");
});

Deno.test("integrate: remote comments merge with local unposted comments", () => {
  const store = tempStore();
  const v1 = makeBaseEntry(makeTicket({ key: "TST-1", comments: [] }));
  integrateFetched(store, v1);
  const w = store.readWorking("TST-1")!.ticket;
  store.writeWorking("TST-1", {
    ...w,
    comments: [{ body: "my new local comment" }],
  });
  const v2 = makeBaseEntry(
    makeTicket({
      key: "TST-1",
      comments: [{ id: "100", author: "Someone", created: "2026-02-01", body: "remote comment" }],
    }),
    { updated: "2026-02-01T00:00:00.000Z" },
  );
  const result = integrateFetched(store, v2);
  assertEquals(result.kind, "rebased");
  const after = store.readWorking("TST-1")!.ticket;
  assertEquals(after.comments.length, 2);
  assertEquals(after.comments[0].id, "100");
  assertEquals(after.comments[1].body, "my new local comment");
});

Deno.test("integrate: committed layer is rebased too and dropped when it equals base", () => {
  const store = tempStore();
  const v1 = makeBaseEntry(makeTicket({ key: "TST-1", summary: "v1" }));
  integrateFetched(store, v1);
  const w = store.readWorking("TST-1")!.ticket;
  const edited = { ...w, summary: "pushed already" };
  store.writeWorking("TST-1", edited);
  store.writeCommitted("TST-1", serializeTicket(edited));
  // Remote now shows exactly the committed state (e.g. it was pushed out-of-band).
  const v2 = makeBaseEntry(makeTicket({ key: "TST-1", summary: "pushed already" }), {
    updated: "2026-02-01T00:00:00.000Z",
  });
  integrateFetched(store, v2);
  assertEquals(store.readCommitted("TST-1"), null); // nothing left to push
  assertEquals(store.status()[0].state, "clean");
});

Deno.test("updated: invisible to diff, equality, and conflict detection", () => {
  const a = makeTicket({ key: "TST-1", updated: "2026-01-01T00:00:00.000Z" });
  const b = makeTicket({ key: "TST-1", updated: "2026-02-01T00:00:00.000Z" });
  assertEquals(diffTickets(a, b), []);
  assert(ticketsEqual(a, b));
});

Deno.test("updated: stamps working files on fetch and refreshes on rebase", () => {
  const store = tempStore();
  const v1 = makeBaseEntry(
    makeTicket({ key: "TST-1", summary: "v1", updated: "2026-01-01T00:00:00.000Z" }),
  );
  integrateFetched(store, v1);
  assertEquals(store.readWorking("TST-1")!.ticket.updated, "2026-01-01T00:00:00.000Z");

  const w = store.readWorking("TST-1")!.ticket;
  store.writeWorking("TST-1", { ...w, labels: ["local-label"] });
  const v2 = makeBaseEntry(
    makeTicket({ key: "TST-1", summary: "v2", updated: "2026-02-01T00:00:00.000Z" }),
    { updated: "2026-02-01T00:00:00.000Z" },
  );
  const result = integrateFetched(store, v2);
  assertEquals(result.kind, "rebased");
  const after = store.readWorking("TST-1")!.ticket;
  assertEquals(after.updated, "2026-02-01T00:00:00.000Z");
  assertEquals(after.labels, ["local-label"]);
});

Deno.test("updated: committed byte-copy keeps its commit-time value through a rebase", () => {
  const store = tempStore();
  const v1 = makeBaseEntry(
    makeTicket({ key: "TST-1", summary: "v1", updated: "2026-01-01T00:00:00.000Z" }),
  );
  integrateFetched(store, v1);
  const w = store.readWorking("TST-1")!.ticket;
  const edited = { ...w, summary: "local edit" };
  store.writeWorking("TST-1", edited);
  store.writeCommitted("TST-1", serializeTicket(edited));
  const before = store.readCommitted("TST-1")!.bytes;

  // Remote bumped only its timestamp (e.g. an untracked field changed there).
  const v2 = makeBaseEntry(
    makeTicket({ key: "TST-1", summary: "v1", updated: "2026-02-01T00:00:00.000Z" }),
    { updated: "2026-02-01T00:00:00.000Z" },
  );
  const result = integrateFetched(store, v2);
  assertEquals(result.kind, "rebased");
  assertEquals(store.readCommitted("TST-1")!.bytes, before); // reviewed bytes unchanged
  assertEquals(store.readWorking("TST-1")!.ticket.updated, "2026-02-01T00:00:00.000Z");
});
