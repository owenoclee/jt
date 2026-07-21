import { assertEquals } from "@std/assert";
import { serializeTicket } from "../src/canonical.ts";
import { makeBaseEntry, makeTicket, tempStore } from "./helpers.ts";

Deno.test("status: clean / modified / committed / committed+modified", () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-1", summary: "one" });
  store.writeBase(makeBaseEntry(base));
  store.writeWorking("TST-1", base);
  assertEquals(store.status()[0].state, "clean");

  const edited = { ...base, summary: "one edited" };
  store.writeWorking("TST-1", edited);
  assertEquals(store.status()[0].state, "modified");

  store.writeCommitted("TST-1", serializeTicket(edited));
  assertEquals(store.status()[0].state, "committed");

  store.writeWorking("TST-1", { ...edited, labels: ["x"] });
  assertEquals(store.status()[0].state, "committed+modified");
});

Deno.test("status: new tickets and deletions", () => {
  const store = tempStore();
  const draft = makeTicket({ summary: "brand new" });
  delete draft.status;
  store.writeWorking("@draft", draft);
  assertEquals(store.status()[0], {
    id: "@draft",
    state: "new",
    summary: "brand new",
  });

  store.writeCommitted("@draft", serializeTicket(draft));
  assertEquals(store.status()[0].state, "new+committed");

  const base = makeTicket({ key: "TST-2", summary: "doomed" });
  store.writeBase(makeBaseEntry(base));
  store.writeDeletions([
    { key: "TST-2", summary: "doomed", requestedAt: "now", committed: false },
  ]);
  const st = store.status().find((s) => s.id === "TST-2")!;
  assertEquals(st.state, "deleted");
});

Deno.test("status: hand-deleted working file is flagged", () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-3", summary: "gone" });
  store.writeBase(makeBaseEntry(base));
  const st = store.status()[0];
  assertEquals(st.state, "missing");
});

Deno.test("status and ticket listings sort issue numbers numerically", () => {
  const store = tempStore();
  const keys = ["SCRUM-599", "SCRUM-60", "SCRUM-601", "SCRUM-600"];

  for (const key of keys) {
    const ticket = makeTicket({ key, project: "SCRUM", summary: key });
    store.writeBase(makeBaseEntry(ticket));
    store.writeWorking(key, ticket);
    store.writeCommitted(key, serializeTicket(ticket));
  }
  store.ackSeen();

  const expected = ["SCRUM-60", "SCRUM-599", "SCRUM-600", "SCRUM-601"];
  assertEquals(store.status().map((s) => s.id), expected);
  assertEquals(store.listWorking().map((w) => w.id), expected);
  assertEquals(store.listBaseKeys(), expected);
  assertEquals(store.listCommittedIds(), expected);
  assertEquals(store.listSeenKeys(), expected);
});

Deno.test("cosmetic reordering is not a change", () => {
  const store = tempStore();
  const base = makeTicket({
    key: "TST-4",
    labels: ["a", "b"],
    links: [
      { type: "blocks", to: "TST-9" },
      { type: "blocks", to: "TST-8" },
    ],
  });
  store.writeBase(makeBaseEntry(base));
  store.writeWorking("TST-4", {
    ...base,
    labels: ["b", "a"],
    links: [
      { type: "blocks", to: "TST-8" },
      { type: "blocks", to: "TST-9" },
    ],
  });
  assertEquals(store.status()[0].state, "clean");
});
