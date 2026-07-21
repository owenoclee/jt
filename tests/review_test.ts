/**
 * Review-flow integration: drives jt push's review server over real HTTP
 * against the mock Jira — atomic approve/request-changes, per-ticket notes,
 * uncommit reshaping the changeset between rounds, unchanged-since-review
 * collapse, timeout.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readChain, readReviewMarker } from "../src/chain.ts";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdFetch } from "../src/commands/fetch.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdUncommit } from "../src/commands/local.ts";
import { cmdMeta } from "../src/commands/meta.ts";
import { checkStaleness, type PushContext } from "../src/commands/push.ts";
import { compilePush } from "../src/compile.ts";
import { localContext, withClient, withMeta } from "../src/context.ts";
import { type Decision, runReviewFlow } from "../src/review/server.ts";
import { Store } from "../src/store.ts";
import type { Ticket } from "../src/types.ts";
import { MockJira } from "./mock_jira.ts";

async function decideViaHttp(
  ctx: PushContext,
  decision: Decision,
  onPage?: (html: string) => void,
) {
  const compiled = await compilePush(ctx);
  await checkStaleness(ctx, compiled.existingKeys);
  let pageUrl = "";
  const flow = runReviewFlow(ctx, compiled, {
    timeoutMs: 10_000,
    onServe: (url) => (pageUrl = url),
  });
  while (!pageUrl) await new Promise((r) => setTimeout(r, 5));
  const pageRes = await fetch(pageUrl);
  const html = await pageRes.text();
  onPage?.(html);
  const res = await fetch(pageUrl.replace("/review/", "/decide/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decision),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  return await flow;
}

Deno.test("review flow: atomic gate, notes, uncommit reshaping, collapse", async (t) => {
  const mock = new MockJira();
  mock.seedIssue({ summary: "Existing task" });
  mock.start();

  const dir = Deno.makeTempDirSync({ prefix: "jt-review-" });
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
    await cmdFetch(["TST-1"]);

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

    const ctx = withClient(withMeta(localContext()));

    await t.step("request-changes sends NOTHING; notes come back", async () => {
      const outcome = await decideViaHttp(ctx, {
        decision: "request-changes",
        notes: { "@epic": "more pizzazz", "TST-1": "actually ship this without the epics" },
      }, (html) => {
        assertStringIncludes(html, "The epic");
        assertStringIncludes(html, "round 1: propose everything");
        assertStringIncludes(html, "Approve &amp; push all 3");
      });

      assertEquals(outcome.status, "changes-requested");
      assertEquals(outcome.notes["@epic"], "more pizzazz");
      // atomic: nothing at all was sent
      assertEquals(mock.issues.get("TST-1")!.summary, "Existing task");
      assertEquals(mock.issues.size, 1);
      assertEquals(store.listCommittedIds().sort(), ["@child", "@epic", "TST-1"]);
      assert(logs.some((l) => l.includes("more pizzazz")));
      assertEquals(readReviewMarker(store)!.lastReviewedSeq, readChain(store).entries.at(-1)!.seq);
    });

    await t.step("uncommit reshapes the changeset; next page shows it collapsed-aware", async () => {
      // Per the note: ship TST-1 alone. Unstage the epic AND its dependent child.
      cmdUncommit(["@epic", "@child"]);
      assertEquals(store.listCommittedIds(), ["TST-1"]);
      // working files untouched — still full of edits
      assertEquals(store.readWorking("@epic")!.ticket.summary, "The epic");

      const outcome = await decideViaHttp(ctx, { decision: "approve", notes: {} }, (html) => {
        assert(!html.includes("The epic"), "uncommitted tickets must not be on the page");
        // TST-1 was already seen at the last review and is byte-identical -> collapsed
        assertStringIncludes(html, "unchanged since your last review");
        assertStringIncludes(html, `class="ticket collapsed"`);
      });

      assertEquals(outcome.status, "pushed");
      assertEquals(outcome.pushFailure, null);
      assertEquals(mock.issues.get("TST-1")!.summary, "Existing task (edited)");
      assertEquals(store.listCommittedIds(), []);
    });

    await t.step("revised + recommitted tickets push whole; chain resets when drained", async () => {
      const epic = store.readWorking("@epic")!.ticket;
      store.writeWorking("@epic", { ...epic, summary: "The epic, with pizzazz" });
      cmdCommit(["-m", "round 2: pizzazz per review"]);

      const outcome = await decideViaHttp(ctx, { decision: "approve", notes: {} }, (html) => {
        assertStringIncludes(html, "round 2: pizzazz per review");
        assertStringIncludes(html, "Approve &amp; push all 2");
      });

      assertEquals(outcome.status, "pushed");
      const epicRemote = [...mock.issues.values()].find((i) => i.summary === "The epic, with pizzazz");
      const childRemote = [...mock.issues.values()].find((i) => i.summary === "The child");
      assert(epicRemote && childRemote);
      assertEquals(childRemote.parent, epicRemote.key);
      assertEquals(store.listCommittedIds(), []);
      assertEquals(readChain(store).entries.length, 0);
      assertEquals(readReviewMarker(store), null);
    });

    await t.step("timeout sends nothing", async () => {
      const w = store.readWorking("TST-1")!.ticket;
      store.writeWorking("TST-1", { ...w, labels: ["late-label"] });
      cmdCommit([]);
      const compiled = await compilePush(ctx);
      const outcome = await runReviewFlow(ctx, compiled, { timeoutMs: 100 });
      assertEquals(outcome.status, "timeout");
      assertEquals(mock.issues.get("TST-1")!.labels.includes("late-label"), false);
    });
  } finally {
    console.log = origLog;
    Deno.chdir(prevCwd);
    if (prevToken === undefined) Deno.env.delete("JIRA_API_TOKEN");
    else Deno.env.set("JIRA_API_TOKEN", prevToken);
    await mock.stop();
  }
});
