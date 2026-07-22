/**
 * Push settle and the seen layer: a human-approved push is knowledge, so the exact
 * approved delta is absorbed into seen (no self-news in jt changes) while genuinely
 * unacked remote news keeps reporting. Also covers the one-push flow of re-parenting
 * an existing ticket onto a pending creation, including @ref rewriting of the
 * committed layer after a partial failure.
 */
import { assert, assertEquals } from "@std/assert";
import { cmdChanges, upstreamChangeCount } from "../src/commands/changes.ts";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdPull } from "../src/commands/fetch.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdRm } from "../src/commands/local.ts";
import { cmdMeta } from "../src/commands/meta.ts";
import { checkStaleness } from "../src/commands/push.ts";
import { compilePush } from "../src/compile.ts";
import { localContext, withClient, withMeta } from "../src/context.ts";
import { type ReviewOutcome, runReviewFlow } from "../src/review/server.ts";
import { Store } from "../src/store.ts";
import type { Ticket } from "../src/types.ts";
import { MockJira } from "./mock_jira.ts";

function readTicket(store: Store, id: string): Ticket {
  const wf = store.readWorking(id);
  if (!wf) throw new Error(`no working file for ${id}`);
  return wf.ticket;
}

/**
 * Compile + review + approve over HTTP (not cmdPush: that exits the process on a
 * partial failure, which one step here provokes deliberately). `beforeDecide` runs
 * between page-served and approval — the window where remote state can shift.
 */
async function approvePush(beforeDecide?: () => void): Promise<ReviewOutcome> {
  const ctx = withClient(withMeta(localContext()));
  const compiled = await compilePush(ctx);
  await checkStaleness(ctx, compiled.existingKeys);
  let url = "";
  const flow = runReviewFlow(ctx, compiled, { timeoutMs: 10_000, onServe: (u) => (url = u) });
  while (!url) await new Promise((r) => setTimeout(r, 5));
  beforeDecide?.();
  const res = await fetch(url.replace("/review/", "/decide/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve", notes: {} }),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  return await flow;
}

Deno.test("push absorbs the approved delta into seen; remote news survives", async (t) => {
  const mock = new MockJira();
  mock.seedIssue({ summary: "First task" }); // TST-1
  mock.seedIssue({ summary: "Second task" }); // TST-2
  mock.start();

  const dir = Deno.makeTempDirSync({ prefix: "jt-seen-" });
  const prevCwd = Deno.cwd();
  const prevToken = Deno.env.get("JIRA_API_TOKEN");
  Deno.chdir(dir);
  Deno.env.set("JIRA_API_TOKEN", "test-token");
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));

  try {
    const store = new Store(dir);
    cmdInit(["--base-url", mock.baseUrl, "--email", "t@example.com", "--project", "TST"]);
    await cmdMeta(["sync"]);
    await cmdPull(); // first sync clones the mirror and records the seen baseline
    assertEquals(upstreamChangeCount(store), 0);

    const blank: Ticket = {
      project: "TST",
      type: "Task",
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

    await t.step("epic + re-parent of an existing ticket in ONE push; no self-news", async () => {
      store.writeWorking("@epic", { ...blank, type: "Epic", summary: "Big epic" });
      store.writeWorking("TST-1", { ...readTicket(store, "TST-1"), parent: "@epic" });
      cmdCommit([]);
      const outcome = await approvePush();
      assertEquals(outcome.status, "pushed");
      assertEquals(outcome.pushFailure, null);

      const epicRemote = [...mock.issues.values()].find((i) => i.summary === "Big epic")!;
      const epicKey = epicRemote.key;
      assertEquals(mock.issues.get("TST-1")!.parent, epicKey);
      const states = store.status();
      assert(states.every((s) => s.state === "clean"), JSON.stringify(states));

      // The user approved exactly this changeset — none of it comes back as news.
      assertEquals(store.readSeen("TST-1")!.ticket.parent, epicKey);
      assert(store.readSeen(epicKey), "created ticket enters the seen baseline");
      assertEquals(upstreamChangeCount(store), 0);
    });

    await t.step("unacked remote news survives a push touching the same ticket", async () => {
      // A colleague labels TST-2; we pull but do NOT ack.
      mock.issues.get("TST-2")!.labels = ["colleague"];
      mock.touch("TST-2");
      await cmdPull();
      assertEquals(upstreamChangeCount(store), 1);

      // Our own approved edit to the same ticket...
      store.writeWorking("TST-2", { ...readTicket(store, "TST-2"), summary: "Second (edited)" });
      cmdCommit(["TST-2"]);
      await approvePush();

      // ...is absorbed, while the colleague's labels stay reportable news.
      const seen2 = store.readSeen("TST-2")!.ticket;
      assertEquals(seen2.summary, "Second (edited)");
      assertEquals(seen2.labels, []);
      assertEquals(upstreamChangeCount(store), 1);
    });

    await t.step("posted comments and link edges absorb — on both endpoints", async () => {
      const t1 = readTicket(store, "TST-1");
      store.writeWorking("TST-1", {
        ...t1,
        links: [{ type: "blocks", to: "TST-2" }],
        comments: [...t1.comments, { body: "approved comment" }],
      });
      cmdCommit(["TST-1"]);
      await approvePush();

      const seen1 = store.readSeen("TST-1")!.ticket;
      assertEquals(seen1.links, [{ type: "blocks", to: "TST-2" }]);
      assertEquals(seen1.comments.length, 1);
      assert(seen1.comments[0].id, "absorbed comment carries the posted id");

      // The link partner absorbed the inverse edge, but kept its pending label news.
      const seen2 = store.readSeen("TST-2")!.ticket;
      assertEquals(seen2.links, [{ type: "is blocked by", to: "TST-1" }]);
      assertEquals(seen2.labels, []);
      assertEquals(upstreamChangeCount(store), 1);
    });

    await t.step("an ack still clears what it always cleared", () => {
      cmdChanges(["--ack"]);
      assertEquals(upstreamChangeCount(store), 0);
      assertEquals(store.readSeen("TST-2")!.ticket.labels, ["colleague"]);
    });

    await t.step("pushed deletion drops the seen entry — no phantom 'gone'", async () => {
      cmdRm(["TST-1"]);
      cmdCommit(["TST-1"]);
      await approvePush();
      assertEquals(mock.issues.has("TST-1"), false);
      assertEquals(store.readSeen("TST-1"), null);
      assertEquals(store.listBaseKeys().includes("TST-1"), false);
    });

    await t.step("partial failure: committed @refs still rewrite to the created key", async () => {
      store.writeWorking("@epic2", { ...blank, type: "Epic", summary: "Second epic" });
      store.writeWorking("TST-2", { ...readTicket(store, "TST-2"), parent: "@epic2" });
      cmdCommit([]);
      // TST-2 vanishes remotely between review and approval: the create lands, the
      // re-parent PUT 404s, and the push settles as partial.
      const outcome = await approvePush(() => {
        mock.issues.delete("TST-2");
      });
      assert(outcome.pushFailure, "expected a partial push");

      const epic2 = [...mock.issues.values()].find((i) => i.summary === "Second epic")!;
      // The pending delta survives — with the @ref already resolved, so the next
      // compile (where @epic2 is no longer a pending creation) still works.
      assertEquals(store.readCommitted("TST-2")!.ticket.parent, epic2.key);
      assertEquals(readTicket(store, "TST-2").parent, epic2.key);
    });
  } finally {
    console.log = origLog;
    Deno.chdir(prevCwd);
    if (prevToken === undefined) Deno.env.delete("JIRA_API_TOKEN");
    else Deno.env.set("JIRA_API_TOKEN", prevToken);
    await mock.stop();
  }
});
