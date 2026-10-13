/**
 * Proposals: independent named changesets, so agents working in parallel in one
 * workspace each get their own commit layer, review page and outcome.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdArchive, cmdRestore, cmdStatus, cmdUncommit } from "../src/commands/local.ts";
import { cmdProposals } from "../src/commands/proposals.ts";
import { cmdPush } from "../src/commands/push.ts";
import { cmdAwait, cmdCancel } from "../src/commands/push_detach.ts";
import { UserError } from "../src/errors.ts";
import {
  activeProposal,
  DEFAULT_PROPOSAL,
  extractProposalFlag,
  setActiveProposal,
  validateProposalName,
} from "../src/proposal.ts";
import { readPending } from "../src/review/handoff.ts";
import { Store } from "../src/store.ts";
import { makeBaseEntry, makeTicket, tempStore } from "./helpers.ts";
import { errorOf, withWorkspace } from "./workspace.ts";

Deno.test("the -p flag is global: found anywhere in argv and removed from it", () => {
  assertEquals(extractProposalFlag(["commit", "-p", "auth", "TST-1", "-m", "note"]), {
    proposal: "auth",
    rest: ["commit", "TST-1", "-m", "note"],
  });
  assertEquals(extractProposalFlag(["--proposal=auth", "push"]), { proposal: "auth", rest: ["push"] });
  assertEquals(extractProposalFlag(["status"]), { proposal: null, rest: ["status"] });
  assertThrows(() => extractProposalFlag(["push", "-p"]), UserError, "needs a proposal name");
  assertThrows(() => validateProposalName("../escape"), UserError, "invalid proposal name");
  assertThrows(() => validateProposalName("Has Spaces"), UserError, "invalid proposal name");
});

Deno.test("the active proposal: flag, then $JT_PROPOSAL, then default", () => {
  const prev = Deno.env.get("JT_PROPOSAL");
  try {
    Deno.env.delete("JT_PROPOSAL");
    assertEquals(activeProposal(), DEFAULT_PROPOSAL);
    Deno.env.set("JT_PROPOSAL", "from-env");
    assertEquals(activeProposal(), "from-env");
    setActiveProposal("from-flag");
    assertEquals(activeProposal(), "from-flag");
  } finally {
    setActiveProposal(null);
    if (prev === undefined) Deno.env.delete("JT_PROPOSAL");
    else Deno.env.set("JT_PROPOSAL", prev);
  }
});

Deno.test("store: the default proposal keeps its paths; a named one gets its own", () => {
  const store = tempStore();
  const named = store.scoped("auth");
  assertEquals(store.committedDir, join(store.root, ".jira", "committed"));
  assertEquals(store.intentsFile, join(store.root, ".jira", "intents.json"));
  assertEquals(named.committedDir, join(store.root, ".jira", "proposals", "auth", "committed"));
  assertEquals(named.baseDir, store.baseDir, "base is shared: there is one Jira");
  assertEquals(named.ticketsDir, store.ticketsDir, "the working tree is shared");

  const t = makeTicket({ key: "TST-1", summary: "One" });
  store.writeBase(makeBaseEntry(t));
  store.writeWorking("TST-1", { ...t, summary: "One, edited" });
  named.writeCommitted("TST-1", store.readWorking("TST-1")!.bytes);

  assertEquals(store.listCommittedIds(), [], "another proposal's commits are not this one's");
  assertEquals(named.listCommittedIds(), ["TST-1"]);
  assertEquals(store.heldBy("TST-1"), "auth");
  assertEquals(store.holder("TST-1").proposal, "auth");
  assertEquals(store.listProposals(), ["default", "auth"]);

  // Status is one view of the whole tree, naming who holds what.
  const row = store.status().find((s) => s.id === "TST-1")!;
  assertEquals(row.state, "committed");
  assertEquals(row.proposal, "auth");

  named.removeCommitted("TST-1");
  named.dropIfDrained();
  assertEquals(store.listProposals(), ["default"], "a drained proposal leaves no directory");
});

Deno.test({
  name: "two proposals are staged, reviewed and pushed independently",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    await withWorkspace(["First", "Second", "Third"], async (ws) => {
      const edit = (key: string, summary: string) => {
        const store = ws.store();
        store.writeWorking(key, { ...store.readWorking(key)!.ticket, summary });
      };
      edit("TST-1", "First (agent a)");
      edit("TST-2", "Second (agent b)");
      edit("TST-3", "Third (nobody's yet)");

      await t.step("a named proposal takes only the tickets it is given", async () => {
        const msg = await errorOf(() => ws.as("a", () => cmdCommit([])));
        assertStringIncludes(msg, "name the tickets");
        await ws.as("a", () => cmdCommit(["TST-1", "-m", "a's change"]));
        await ws.as("b", () => cmdCommit(["TST-2", "-m", "b's change"]));
        assertEquals(ws.store("a").listCommittedIds(), ["TST-1"]);
        assertEquals(ws.store("b").listCommittedIds(), ["TST-2"]);
        assertEquals(ws.store().listCommittedIds(), []);
      });

      await t.step("a ticket belongs to one proposal at a time", async () => {
        edit("TST-1", "First (b wants it too)");
        const msg = await errorOf(() => ws.as("b", () => cmdCommit(["TST-1"])));
        assertStringIncludes(msg, "already staged in proposal 'a'");
        assertStringIncludes(msg, "jt uncommit TST-1 -p a");
        // ...and one proposal cannot rewrite another's staged state.
        assertStringIncludes(
          await errorOf(() => ws.as("b", () => cmdRestore(["TST-1"]))),
          "staged in proposal 'a'",
        );
        assertStringIncludes(await errorOf(() => cmdArchive(["TST-1"])), "staged in proposal 'a'");
        edit("TST-1", "First (agent a)");
      });

      await t.step("an unscoped commit leaves other proposals' tickets alone", () => {
        cmdCommit([]);
        assertEquals(ws.store().listCommittedIds(), ["TST-3"]);
        cmdUncommit(["TST-3"]);
        ws.logs.length = 0;
        cmdUncommit(["TST-1"]); // held by a — the default proposal must not release it
        assertStringIncludes(ws.logs.join("\n"), "staged in proposal 'a'");
        assertEquals(ws.store("a").listCommittedIds(), ["TST-1"]);
      });

      await t.step("status and jt proposals show who holds what", async () => {
        ws.logs.length = 0;
        await ws.as("a", () => cmdStatus([]));
        const out = ws.logs.join("\n");
        assertStringIncludes(out, "proposal: a");
        assertStringIncludes(out, "[proposal b]");
        assertStringIncludes(out, "1 ready to push"); // b's ticket is not a's to push

        ws.logs.length = 0;
        cmdProposals();
        const listing = ws.logs.join("\n");
        assertStringIncludes(listing, "jt push -p a");
        assertStringIncludes(listing, "jt push -p b");
      });

      await t.step("both reviews are live at once, each on its own page", async () => {
        ws.logs.length = 0;
        await ws.as("a", () => cmdPush([]));
        await ws.as("b", () => cmdPush([]));
        const out = ws.logs.join("\n");
        assertStringIncludes(out, "jt await -p a"); // the handoff names its proposal
        assertStringIncludes(out, "jt await -p b");
        const pageA = await ws.page("a");
        const pageB = await ws.page("b");
        assertStringIncludes(pageA, "proposal a");
        assertStringIncludes(pageA, "First (agent a)");
        assert(!pageA.includes("Second (agent b)"), "a's page must not carry b's ticket");
        assertStringIncludes(pageB, "Second (agent b)");
        assertEquals(readPending(ws.store().proposalDir), null, "the default proposal has no review");

        // An agent that forgot its -p is pointed at the reviews that do exist.
        const msg = await errorOf(() => cmdAwait([]));
        assertStringIncludes(msg, "nothing to await");
        assertStringIncludes(msg, "jt await -p a");
        assertStringIncludes(await errorOf(() => ws.as("a", () => cmdPush([]))), "already pending");
      });

      await t.step("approving one sends only that one; cancelling the other sends nothing", async () => {
        await ws.decide("a", "approve");
        await ws.as("a", () => cmdAwait([]));
        assertEquals(ws.mock.issues.get("TST-1")!.summary, "First (agent a)");
        assertEquals(ws.mock.issues.get("TST-2")!.summary, "Second", "b is still under review");
        assert(readPending(ws.store("b").proposalDir), "b's review survives a's push");
        assertEquals(ws.store().listProposals(), ["default", "b"], "a drained and was removed");

        await ws.as("b", () => cmdCancel());
        assertEquals(ws.mock.issues.get("TST-2")!.summary, "Second");
        assertEquals(ws.store("b").listCommittedIds(), ["TST-2"], "cancel keeps the commit");

        await ws.as("b", () => cmdPush([]));
        await ws.decide("b", "approve");
        await ws.as("b", () => cmdAwait([]));
        assertEquals(ws.mock.issues.get("TST-2")!.summary, "Second (agent b)");
        assertEquals(ws.store().listProposals(), ["default"]);

        const journal = ws.store().listJournal().map((j) => j.entry.proposal).sort();
        assertEquals(journal, ["a", "b"], "each push is journaled under its proposal");
      });
    });
  },
});

Deno.test("a conflict on a ticket outside the changeset does not block the push", async () => {
  const { compilePush } = await import("../src/compile.ts");
  const { makeMeta } = await import("./helpers.ts");
  const store: Store = tempStore();
  for (const key of ["TST-1", "TST-2"]) {
    const t = makeTicket({ key, summary: key });
    store.writeBase(makeBaseEntry(t));
    store.writeWorking(key, { ...t, summary: `${key} edited` });
  }
  const mine = store.scoped("mine");
  mine.writeCommitted("TST-1", store.readWorking("TST-1")!.bytes);
  store.writeConflicts([
    { key: "TST-2", fields: ["summary"], detectedAt: "2026-01-01T00:00:00Z", remote: {}, local: {} },
  ]);
  // deno-lint-ignore no-explicit-any
  const client = {} as any;
  const { ops } = await compilePush({ store: mine, meta: makeMeta(), client });
  assertEquals(ops.map((o) => o.label), ["update TST-1"]);

  store.writeConflicts([
    { key: "TST-1", fields: ["summary"], detectedAt: "2026-01-01T00:00:00Z", remote: {}, local: {} },
  ]);
  assertStringIncludes(
    await errorOf(() => compilePush({ store: mine, meta: makeMeta(), client })),
    "unresolved conflicts on: TST-1",
  );
});

Deno.test("a pull rebases a ticket in whichever proposal holds it", async () => {
  const { integrateFetched } = await import("../src/sync.ts");
  const { readChain } = await import("../src/chain.ts");
  const store = tempStore();
  const t = makeTicket({ key: "TST-1", summary: "One", labels: [] });
  store.writeBase(makeBaseEntry(t));
  store.writeWorking("TST-1", { ...t, summary: "One, edited" });
  const held = store.scoped("auth");
  held.writeCommitted("TST-1", store.readWorking("TST-1")!.bytes);

  // The command doing the pull is scoped to the default proposal; the staged copy is not.
  const fresh = makeBaseEntry({ ...t, labels: ["from-remote"] }, { updated: "2026-02-02T00:00:00.000Z" });
  assertEquals(integrateFetched(store, fresh).kind, "rebased");
  const rebased = held.readCommitted("TST-1")!.ticket;
  assertEquals(rebased.summary, "One, edited", "the local edit survives");
  assertEquals(rebased.labels, ["from-remote"], "the remote edit flows into the staged copy");
  assertEquals(store.listCommittedIds(), [], "nothing leaks into the default proposal");
  assertEquals(readChain(store).entries.length, 0);
});
