/**
 * Review rounds on one proposal, driven through the review server against the mock
 * Jira: requesting changes sends nothing and leaves comments; the author reshapes the
 * changeset and resubmits; approval sends the whole of what is then staged. Also how
 * an author reads an outcome it did not wait for.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readChain, readReviewMarker } from "../src/chain.ts";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdUncommit } from "../src/commands/local.ts";
import { cmdPush } from "../src/commands/push.ts";
import { awaitOutcome, cmdCancel } from "../src/commands/review.ts";
import { loadWorkspace } from "../src/config.ts";
import { proposalView } from "../src/review/meta.ts";
import type { Ticket } from "../src/types.ts";
import { withWorkspace } from "./workspace.ts";

Deno.test("review rounds: comments, uncommit reshaping, collapse", async (t) => {
  await withWorkspace(["Existing task"], async (ws) => {
    const store = ws.store();
    const config = loadWorkspace().config;
    const { mock, logs } = ws;
    const blank: Ticket = {
      project: "TST",
      type: "Story",
      summary: "",
      description: null,
      labels: [],
      parent: null,
      sprint: null,
      assignee: null,
      priority: null,
      links: [],
      comments: [],
      fields: {},
    };
    store.writeWorking("@epic", { ...blank, type: "Epic", summary: "The epic" });
    store.writeWorking("@child", { ...blank, summary: "The child", parent: "@epic" });
    const existing = store.readWorking("TST-1")!.ticket;
    store.writeWorking("TST-1", { ...existing, summary: "Existing task (edited)" });
    cmdCommit(["-m", "round 1: propose everything"]);
    await cmdPush([]); // the default proposal is titled by its last commit note

    await t.step("requesting changes sends NOTHING; the comments wait on the proposal", async () => {
      const html = await ws.page(null);
      assertStringIncludes(html, "The epic");
      assertStringIncludes(html, "round 1: propose everything");
      assertStringIncludes(html, "Approve &amp; push all 3");

      const comments = [
        { on: "@epic", body: "more pizzazz" },
        { on: "TST-1", body: "actually ship this without the epics" },
      ];
      const done = await ws.decide(null, "request-changes", comments);
      assertEquals(done.status, "changes-requested");
      // atomic: nothing at all was sent
      assertEquals(mock.issues.get("TST-1")!.summary, "Existing task");
      assertEquals(mock.issues.size, 1);
      assertEquals(store.listCommittedIds().sort(), ["@child", "@epic", "TST-1"]);
      assert(done.log!.some((l) => l.includes("more pizzazz")));
      assertEquals(readReviewMarker(store)!.lastReviewedSeq, readChain(store).entries.at(-1)!.seq);

      // Nobody was waiting. The comments are there for whoever asks, every time.
      for (let i = 0; i < 2; i++) {
        const outcome = await awaitOutcome(store, config, 1000);
        assertEquals(outcome.code, 2);
        const said = outcome.lines.join("\n");
        assertStringIncludes(said, "changes requested — nothing was sent");
        assertStringIncludes(said, `comment on @epic: "more pizzazz"`);
        assertStringIncludes(said, `comment on TST-1: "actually ship this without the epics"`);
      }
    });

    await t.step("uncommit reshapes the changeset; the next page shows it collapsed-aware", async () => {
      // Per the comment: ship TST-1 alone. Unstage the epic AND its dependent child.
      cmdUncommit(["@epic", "@child"]);
      assertEquals(store.listCommittedIds(), ["TST-1"]);
      // working files untouched — still full of edits
      assertEquals(store.readWorking("@epic")!.ticket.summary, "The epic");
      assertEquals(proposalView(store).status, "changes-requested", "not in review until it is resubmitted");

      logs.length = 0;
      await cmdPush([]);
      assertStringIncludes(logs.join("\n"), "proposal resubmitted for review:");
      const html = await ws.page(null);
      // Uncommitted tickets are not sendable cards, but they do NOT vanish: the
      // reviewer who asked for the drop sees it recorded as withdrawn.
      assert(!html.includes(`id="t-@epic"`), "uncommitted tickets must not be sendable cards");
      assertStringIncludes(html, "Approve &amp; push all 1");
      assertStringIncludes(html, "withdrawn since your last review");
      assertStringIncludes(html, "The epic");
      // TST-1 was already seen at the last review and is byte-identical -> collapsed
      assertStringIncludes(html, "unchanged since your last review");
      assertStringIncludes(html, `class="ticket collapsed"`);
      // collapsed cards get a one-line header (long titles truncate instead of
      // wrapping the badge onto a second row)
      assertStringIncludes(html, `<header class="oneline">`);
      // The comment made last round is still under the ticket it was made on.
      const card = html.slice(html.indexOf('id="t-TST-1"'));
      assertStringIncludes(card, "your comment on the previous review");
      assertStringIncludes(card, "actually ship this without the epics");

      const done = await ws.decide(null, "approve");
      assertEquals(done.status, "pushed");
      assertEquals(done.pushFailure, null);
      assertEquals(mock.issues.get("TST-1")!.summary, "Existing task (edited)");
      assertEquals(store.listCommittedIds(), []);
      assertEquals(store.readMeta(), null, "pushed: nothing left to review");

      const outcome = await awaitOutcome(store, config, 1000);
      assertEquals(outcome.code, 0);
      assertStringIncludes(outcome.lines.join("\n"), "approved and pushed");
    });

    await t.step("revised + recommitted tickets push whole; chain resets when drained", async () => {
      const epic = store.readWorking("@epic")!.ticket;
      store.writeWorking("@epic", { ...epic, summary: "The epic, with pizzazz" });
      cmdCommit(["-m", "round 2: pizzazz per review"]);
      await cmdPush([]);

      const html = await ws.page(null);
      assertStringIncludes(html, "round 2: pizzazz per review");
      assertStringIncludes(html, "Approve &amp; push all 2");
      const done = await ws.decide(null, "approve");

      assertEquals(done.status, "pushed");
      const epicRemote = [...mock.issues.values()].find((i) => i.summary === "The epic, with pizzazz");
      const childRemote = [...mock.issues.values()].find((i) => i.summary === "The child");
      assert(epicRemote && childRemote);
      assertEquals(childRemote.parent, epicRemote.key);
      assertEquals(done.created, { "@epic": epicRemote.key, "@child": childRemote.key });
      assertEquals(store.listCommittedIds(), []);
      assertEquals(readChain(store).entries.length, 0);
      assertEquals(readReviewMarker(store), null);
    });
  });
});

Deno.test("jt await: waits while in review, and reports whatever ends the wait", async () => {
  await withWorkspace(["One"], async (ws) => {
    const store = ws.store("alpha");
    const config = loadWorkspace().config;
    await ws.as("alpha", async () => {
      store.writeWorking("TST-1", { ...store.readWorking("TST-1")!.ticket, summary: "One, edited" });
      cmdCommit(["TST-1"]);
      await cmdPush(["--title", "Rename one"]);

      // Still in review when the wait runs out: not an outcome, and nothing is lost.
      const timedOut = await awaitOutcome(store, config, 300);
      assertEquals(timedOut.code, 1);
      assertStringIncludes(timedOut.lines.join("\n"), "still in review");
      assertStringIncludes(timedOut.lines.join("\n"), "jt await -p alpha");
      assertEquals(proposalView(store).status, "in-review", "giving up the wait changes nothing");

      // Withdrawn while someone waits on it.
      const waiting = awaitOutcome(store, config, 5000);
      await new Promise((r) => setTimeout(r, 50));
      await cmdCancel();
      const withdrawn = await waiting;
      assertEquals(withdrawn.code, 1);
      assertStringIncludes(withdrawn.lines.join("\n"), "withdrawn from review — nothing was sent");

      // Approved while someone waits on it.
      await cmdPush([]);
      const pending = awaitOutcome(store, config, 5000);
      await new Promise((r) => setTimeout(r, 50));
      await ws.decide("alpha", "approve");
      const pushed = await pending;
      assertEquals(pushed.code, 0, pushed.lines.join("\n"));
      assertStringIncludes(pushed.lines.join("\n"), "approved and pushed");
      assertStringIncludes(pushed.lines.join("\n"), "Rename one");
      assertEquals(ws.mock.issues.get("TST-1")!.summary, "One, edited");
    });
  });
});

Deno.test("a commit that lands while an approved push is settling waits for it", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    const { withWorkspaceLock } = await import("../src/lock.ts");
    const store = ws.store("alpha");
    await ws.as("alpha", async () => {
      store.writeWorking("TST-1", { ...store.readWorking("TST-1")!.ticket, summary: "One, edited" });
      cmdCommit(["TST-1"]);
      await cmdPush(["--title", "Rename one"]);
      const { token } = await ws.open("alpha");

      // Hold the push open at its first request to Jira, the way a slow network would.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let sending = false;
      const { decide } = await import("./hub_client.ts");
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "PUT" && !sending) {
          sending = true;
          await held;
        }
        return await realFetch(input, init);
      }) as typeof fetch;
      try {
        const approving = decide(ws.hub, "TST", "alpha", token!, "approve");
        while (!sending) await new Promise((r) => setTimeout(r, 5));
        assertEquals(proposalView(store).status, "pushing");

        // An agent commits more to the same proposal at that moment — as jt's own
        // command dispatch does it, under the workspace lock.
        let committed = false;
        const commit = withWorkspaceLock(ws.dir, () => {
          store.writeWorking("TST-1", { ...store.readWorking("TST-1")!.ticket, labels: ["later"] });
          cmdCommit(["TST-1"]);
          committed = true;
        });
        await new Promise((r) => setTimeout(r, 80));
        assertEquals(committed, false, "the commit must wait for the push to settle");

        release();
        assertEquals((await approving).body.status, "pushed");
        await commit;
        // The push sent exactly what was approved, and the later commit survived it.
        assertEquals(ws.mock.issues.get("TST-1")!.summary, "One, edited");
        assertEquals(ws.mock.issues.get("TST-1")!.labels, []);
        assertEquals(store.readCommitted("TST-1")!.ticket.labels, ["later"]);
        assertEquals(store.readCommitted("TST-1")!.ticket.summary, "One, edited");
      } finally {
        globalThis.fetch = realFetch;
        release();
      }
    });
  });
});
