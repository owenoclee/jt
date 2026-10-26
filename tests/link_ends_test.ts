/**
 * A link has two ends, and a ticket file shows it from its own end. Removing or adding
 * one link from both ends is still one link: one request, and a removal Jira has
 * already made is done, not a failure that stops the push halfway.
 */
import "./hermetic.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readChain } from "../src/chain.ts";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdFetch } from "../src/commands/fetch.ts";
import { cmdStatus } from "../src/commands/local.ts";
import { cmdProposals } from "../src/commands/proposals.ts";
import { cmdPush } from "../src/commands/push.ts";
import type { Store } from "../src/store.ts";
import type { Ticket } from "../src/types.ts";
import { errorOf, type TestWorkspace, withWorkspace } from "./workspace.ts";

/** TST-1 "relates to" TST-2 in Jira, fetched into both files. */
async function linkOneAndTwo(ws: TestWorkspace): Promise<void> {
  ws.mock.links.set("500", {
    id: "500",
    typeName: "Relates",
    inwardKey: "TST-1",
    outwardKey: "TST-2",
  });
  await cmdFetch(["TST-1", "TST-2"]);
}

function edit(store: Store, key: string, patch: Partial<Ticket>): void {
  store.writeWorking(key, { ...store.readWorking(key)!.ticket, ...patch });
}

Deno.test("a link removed from both ends is deleted once", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    await linkOneAndTwo(ws);
    const store = ws.store();
    assertEquals(store.readWorking("TST-1")!.ticket.links, [{ type: "relates to", to: "TST-2" }]);
    edit(store, "TST-1", { links: [] });
    edit(store, "TST-2", { links: [] });
    cmdCommit([]);

    ws.logs.length = 0;
    await cmdPush(["--dry-run"]);
    assertEquals(ws.logs.join("\n").match(/DELETE/g)?.length, 1, "one DELETE in the plan");

    ws.writeSettings({ autoAllow: ["links"] });
    ws.mock.requestLog.length = 0;
    await cmdPush([]);
    const deletes = ws.mock.requestLog.filter((r) => r.method === "DELETE").map((r) => r.path);
    assertEquals(deletes, ["/rest/api/3/issueLink/500"]);
    assertEquals(ws.mock.links.size, 0);
    assertEquals(store.status().map((s) => s.state), ["clean", "clean"]);
    assertEquals(store.listCommittedIds(), []);
    assertEquals(readChain(store).entries, [], "both ends left the commit chain");
  });
});

Deno.test("removing a link Jira no longer has counts as done", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    await linkOneAndTwo(ws);
    const store = ws.store();
    edit(store, "TST-1", { links: [], status: "In Progress" });
    cmdCommit([]);
    // Someone removes the link in Jira first (without bumping `updated`, so the push
    // is not refused as stale and really sends its DELETE).
    ws.mock.links.delete("500");

    ws.writeSettings({ autoAllow: ["links", "status"] });
    ws.logs.length = 0;
    await cmdPush([]);
    assertStringIncludes(ws.logs.join("\n"), "already gone from Jira");
    assertEquals(ws.mock.issues.get("TST-1")!.status, "In Progress", "the push went on past it");
    const entry = store.listJournal()[0].entry;
    assertEquals(entry.result, "success");
    assertEquals(entry.ops.find((o) => o.method === "DELETE")?.status, 404);
    assertEquals(store.status().map((s) => s.state), ["clean", "clean"]);
  });
});

Deno.test("a symmetric link added from both ends is created once", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    const store = ws.store();
    edit(store, "TST-1", { links: [{ type: "relates to", to: "TST-2" }] });
    edit(store, "TST-2", { links: [{ type: "relates to", to: "TST-1" }] });
    cmdCommit([]);
    ws.writeSettings({ autoAllow: ["links"] });
    await cmdPush([]);
    assertEquals(ws.mock.links.size, 1);
    assertEquals(store.status().map((s) => s.state), ["clean", "clean"]);
    assertEquals(store.listCommittedIds(), []);
  });
});

Deno.test("what a partial push left staged is named as such, not as new work", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    const store = ws.store("cleanup");
    ws.writeSettings({ autoAllow: ["labels", "status"] });
    await ws.as("cleanup", async () => {
      edit(store, "TST-1", { labels: ["done-here"] });
      edit(store, "TST-2", { status: "Done" });
      cmdCommit(["TST-1", "TST-2"]);
      ws.mock.intercept = (method, path) =>
        method === "POST" && path.endsWith("/TST-2/transitions")
          ? new Response(JSON.stringify({ errorMessages: ["transition refused"] }), { status: 400 })
          : null;
      const err = await errorOf(() => cmdPush([]));
      assertStringIncludes(err, "push incomplete");
      assertStringIncludes(err, "TST-2 — not new work");
      assertStringIncludes(err, "jt uncommit -p cleanup TST-2");
      assertStringIncludes(err, "ask the user which");
    });
    assertEquals(store.listCommittedIds(), ["TST-2"], "what landed drained; the rest stayed");

    // Days later, another agent looks around — from the default proposal.
    ws.logs.length = 0;
    cmdProposals();
    const proposals = ws.logs.join("\n");
    assertStringIncludes(proposals, "partly pushed on");
    assertStringIncludes(proposals, "(left over)");
    assertStringIncludes(proposals, "jt push -p cleanup");
    assert(!proposals.includes("not pushed yet"), proposals);

    ws.logs.length = 0;
    cmdStatus([]);
    assertStringIncludes(ws.logs.join("\n"), "left over from the partial push on");
    assertStringIncludes(ws.logs.join("\n"), "jt log TST-2");
  });
});
