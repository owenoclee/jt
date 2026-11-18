/** Proposal state as read from disk: proposal.json beside the staged work. */
import { assertEquals } from "@std/assert";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdArchive, cmdRestore, cmdUncommit, cmdUntrack } from "../src/commands/local.ts";
import { cmdPush } from "../src/commands/push.ts";
import { writePending } from "../src/review/legacy.ts";
import { markRevised, proposalView } from "../src/review/meta.ts";
import type { ProposalMeta } from "../src/types.ts";
import { errorOf, withWorkspace } from "./workspace.ts";

const submitted = (extra: Partial<ProposalMeta> = {}): ProposalMeta => ({
  title: "A proposal",
  description: "",
  submittedAt: "2026-11-01T10:00:00.000Z",
  ...extra,
});

Deno.test("proposal state: from nothing staged to in review", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    await ws.as("alpha", () => {
      const store = ws.store("alpha");
      assertEquals(proposalView(store).status, "empty");

      store.writeWorking("TST-1", { ...store.readWorking("TST-1")!.ticket, summary: "One, edited" });
      cmdCommit(["TST-1"]);
      assertEquals(proposalView(store).status, "draft");
      assertEquals(proposalView(store).staged, ["TST-1"]);

      store.writeMeta(submitted());
      assertEquals(proposalView(store).status, "in-review");

      store.writeMeta(submitted({ blocked: { reason: "conflict", at: "2026-11-02T00:00:00.000Z" } }));
      assertEquals(proposalView(store).status, "blocked");

      store.writeMeta({
        title: "A proposal",
        description: "",
        review: { decidedAt: "2026-11-02T00:00:00.000Z", comments: [{ body: "Split this up" }] },
      });
      assertEquals(proposalView(store).status, "changes-requested");

      store.writeMeta(submitted({ pushing: { pid: Deno.pid, since: "2026-11-02T00:00:00.000Z" } }));
      assertEquals(proposalView(store).status, "pushing");
      // No process has this pid: the server died mid-push.
      store.writeMeta(submitted({ pushing: { pid: 2 ** 22 + 12345, since: "2026-11-02T00:00:00.000Z" } }));
      assertEquals(proposalView(store).status, "interrupted");
    });
  });
});

Deno.test("changing a submitted proposal's staged work marks it revised", async () => {
  await withWorkspace(["One", "Two", "Three"], async (ws) => {
    await ws.as("alpha", () => {
      const store = ws.store("alpha");
      const edit = (key: string, summary: string) =>
        store.writeWorking(key, { ...store.readWorking(key)!.ticket, summary });
      const resubmit = () => store.writeMeta(submitted());
      const status = () => proposalView(store).status;

      edit("TST-1", "One, edited");
      edit("TST-2", "Two, edited");
      cmdCommit(["TST-1", "TST-2"]);
      assertEquals(markRevised(store), false, "a draft has no review to invalidate");

      resubmit();
      edit("TST-1", "One, edited again");
      cmdCommit(["TST-1"]);
      assertEquals(status(), "revising", "commit");

      resubmit();
      cmdUncommit(["TST-2"]);
      assertEquals(status(), "revising", "uncommit");

      // Staging an intent over a committed copy drops that copy without a chain entry.
      // Nothing is staged until the intent is committed; the proposal is still marked.
      resubmit();
      cmdArchive(["TST-1"]);
      assertEquals(status(), "draft", "archive over a staged edit leaves nothing staged");
      assertEquals(store.readMeta()?.revised, true);
      cmdCommit(["TST-1"]);
      assertEquals(status(), "revising", "the committed intent is not what was submitted");

      resubmit();
      cmdRestore(["TST-1"]);
      assertEquals(proposalView(store).status, "empty", "the emptied proposal is gone");
    });
  });
});

Deno.test("an emptied proposal is tidied away, review state and all", async () => {
  await withWorkspace(["One"], async (ws) => {
    await ws.as("alpha", () => {
      const store = ws.store("alpha");
      store.writeWorking("TST-1", { ...store.readWorking("TST-1")!.ticket, summary: "One, edited" });
      cmdCommit(["TST-1"]);
      store.writeMeta(submitted());
      cmdUntrack(["TST-1"]);
      assertEquals(store.readMeta(), null);
      assertEquals(ws.store().listProposals(), ["default"]);
    });
    // The default proposal lives in .jira itself: only its review state is removed.
    const store = ws.store();
    store.writeMeta(submitted());
    store.dropIfDrained();
    assertEquals(store.readMeta(), null);
  });
});

Deno.test("a proposal mid-push is never tidied away", async () => {
  await withWorkspace(["One"], async (ws) => {
    await ws.as("alpha", () => {
      const store = ws.store("alpha");
      store.writeMeta(submitted({ pushing: { pid: Deno.pid, since: "2026-11-02T00:00:00.000Z" } }));
      store.dropIfDrained();
      assertEquals(store.readMeta()?.title, "A proposal");
    });
  });
});

Deno.test("a review an older jt left open is finished there before the proposal is submitted anew", async () => {
  await withWorkspace(["One"], async (ws) => {
    const store = ws.store();
    store.writeWorking("TST-1", { ...store.readWorking("TST-1")!.ticket, summary: "One, edited" });
    cmdCommit([]);
    // What jt 0.6 wrote while its one-shot review server was up (this process stands in for it).
    writePending(store.proposalDir, {
      pid: Deno.pid,
      url: "http://127.0.0.1:50123/review/abc",
      startedAt: new Date().toISOString(),
    });
    const view = proposalView(store);
    assertEquals(view.status, "legacy-review");
    assertEquals(view.legacyUrl, "http://127.0.0.1:50123/review/abc");

    const msg = await errorOf(() => cmdPush([]));
    assertEquals(msg.includes("older jt") && msg.includes("jt await") && msg.includes("jt cancel"), true, msg);
    assertEquals(store.readMeta(), null, "nothing was submitted over it");
  });
});
