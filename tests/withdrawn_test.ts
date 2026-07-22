/**
 * Withdrawal tombstones: tickets that leave the changeset without being pushed
 * (uncommit / untrack / restore of a staged deletion) stay visible to the reviewer
 * as "withdrawn" instead of silently vanishing from the review page's history.
 * Before anyone has reviewed (no marker), a drained chain still resets.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { serializeTicket } from "../src/canonical.ts";
import { appendChainEntry, readChain, readReviewMarker, writeReviewMarker } from "../src/chain.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdRestore, cmdUncommit, cmdUntrack } from "../src/commands/local.ts";
import { buildCommitViews, buildSinceReview } from "../src/review/model.ts";
import { Store } from "../src/store.ts";
import type { Ticket } from "../src/types.ts";
import { makeBaseEntry, makeTicket } from "./helpers.ts";

function workspace(): { dir: string; store: Store } {
  const dir = Deno.makeTempDirSync({ prefix: "jt-withdrawn-" });
  Deno.chdir(dir);
  cmdInit([
    "--base-url",
    "https://example.atlassian.net",
    "--email",
    "t@example.com",
    "--project",
    "TST",
  ]);
  return { dir, store: new Store(dir) };
}

function stage(store: Store, ticket: Ticket): void {
  store.writeBase(makeBaseEntry(ticket));
  store.writeWorking(ticket.key!, ticket);
  store.writeCommitted(ticket.key!, serializeTicket(ticket));
}

Deno.test("uncommit after a review leaves a withdrawal tombstone, shown exactly once", async (t) => {
  const prevCwd = Deno.cwd();
  const origLog = console.log;
  console.log = () => {};
  try {
    const { store } = workspace();
    const one = makeTicket({ key: "TST-1", summary: "One (edited)" });
    const two = makeTicket({ key: "TST-2", summary: "Two (edited)" });
    stage(store, one);
    stage(store, two);
    appendChainEntry(store, "agent", "round 1", {
      "TST-1": { kind: "ticket", ticket: one },
      "TST-2": { kind: "ticket", ticket: two },
    });
    writeReviewMarker(store, 1); // the human reviewed round 1

    await t.step("uncommit appends a withdrawn snapshot instead of rewriting history", () => {
      cmdUncommit(["TST-2"]);
      assertEquals(store.listCommittedIds(), ["TST-1"]);
      const chain = readChain(store);
      assertEquals(chain.entries.length, 2, "round 1 history is preserved");
      const tip = chain.entries.at(-1)!;
      assertEquals(tip.author, "agent");
      assertEquals(tip.note, "uncommit TST-2");
      assertEquals(tip.tickets["TST-2"], { kind: "withdrawn", summary: "Two (edited)" });
    });

    await t.step("since-review reports the withdrawal", () => {
      const since = buildSinceReview(store, ["TST-1"]);
      assert(since, "since-review present");
      assertEquals(since.sections.length, 1);
      assertEquals(since.sections[0].id, "TST-2");
      assertEquals(since.sections[0].summary, "Two (edited)");
      assertStringIncludes(since.sections[0].html, "withdrawn-card");
      assertStringIncludes(since.sections[0].html, "withdrawn since your last review");
    });

    await t.step("commit tabs label the withdrawal round", () => {
      const commits = buildCommitViews(store);
      const tip = commits.at(-1)!;
      assertEquals(tip.sections[0].summary, "(withdrawn) Two (edited)");
      assertStringIncludes(tip.sections[0].html, "withdrawn-card");
    });

    await t.step("once reviewed, the tombstone stops reporting", () => {
      writeReviewMarker(store, 2);
      assertEquals(buildSinceReview(store, ["TST-1"]), null);
    });

    await t.step("re-committing after a seen withdrawal diffs against base again", () => {
      const twoV2 = { ...two, summary: "Two v3" };
      store.writeCommitted("TST-2", serializeTicket(twoV2));
      appendChainEntry(store, "agent", "round 2", {
        "TST-2": { kind: "ticket", ticket: twoV2 },
      });
      const since = buildSinceReview(store, ["TST-1", "TST-2"]);
      assert(since);
      assertEquals(since.sections.length, 1);
      assertEquals(since.sections[0].id, "TST-2");
      assertStringIncludes(since.sections[0].html, "Two v3");
      assert(!since.sections[0].html.includes("withdrawn-card"));
    });
  } finally {
    console.log = origLog;
    Deno.chdir(prevCwd);
  }
});

Deno.test("uncommit draining an unreviewed changeset still resets the chain", () => {
  const prevCwd = Deno.cwd();
  const origLog = console.log;
  console.log = () => {};
  try {
    const { store } = workspace();
    const one = makeTicket({ key: "TST-1", summary: "One (edited)" });
    stage(store, one);
    appendChainEntry(store, "agent", "draft", { "TST-1": { kind: "ticket", ticket: one } });

    cmdUncommit(["TST-1"]);
    assertEquals(store.listCommittedIds(), []);
    assertEquals(readChain(store).entries, [], "no reviewer, no tombstones — clean slate");
    assertEquals(readReviewMarker(store), null);
  } finally {
    console.log = origLog;
    Deno.chdir(prevCwd);
  }
});

Deno.test("untrack and restore of staged work also leave tombstones", async (t) => {
  const prevCwd = Deno.cwd();
  const origLog = console.log;
  console.log = () => {};
  try {
    const { store } = workspace();
    const one = makeTicket({ key: "TST-1", summary: "One (edited)" });
    const two = makeTicket({ key: "TST-2", summary: "Two (edited)" });
    const three = makeTicket({ key: "TST-3", summary: "Three" });
    stage(store, one);
    stage(store, two);
    store.writeBase(makeBaseEntry(three));
    store.writeDeletions([
      { key: "TST-3", summary: "Three", requestedAt: "now", committed: true },
    ]);
    appendChainEntry(store, "agent", "round 1", {
      "TST-1": { kind: "ticket", ticket: one },
      "TST-2": { kind: "ticket", ticket: two },
      "TST-3": { kind: "deletion", summary: "Three" },
    });
    writeReviewMarker(store, 1);

    await t.step("untrack of a committed ticket", () => {
      cmdUntrack(["TST-2"]);
      const tip = readChain(store).entries.at(-1)!;
      assertEquals(tip.note, "untrack TST-2");
      assertEquals(tip.tickets["TST-2"], { kind: "withdrawn", summary: "Two (edited)" });
    });

    await t.step("restore undoing a committed deletion", () => {
      cmdRestore(["TST-3"]);
      assertEquals(store.readDeletions(), []);
      const tip = readChain(store).entries.at(-1)!;
      assertEquals(tip.note, "restore TST-3 (deletion undone)");
      assertEquals(tip.tickets["TST-3"], { kind: "withdrawn", summary: "Three" });
      const since = buildSinceReview(store, ["TST-1"]);
      assert(since);
      assertEquals(since.sections.map((s) => s.id), ["TST-2", "TST-3"]);
    });
  } finally {
    console.log = origLog;
    Deno.chdir(prevCwd);
  }
});
