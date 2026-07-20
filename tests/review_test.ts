/**
 * Review-flow integration: drives jt push --await-user's server over real HTTP
 * against the mock Jira — page rendering, per-ticket decisions, dependency
 * enforcement, rejection notes, queue draining across rounds, since-last-review.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readChain, readReviewMarker } from "../src/chain.ts";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdFetch } from "../src/commands/fetch.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdMeta } from "../src/commands/meta.ts";
import { checkStaleness, type PushContext } from "../src/commands/push.ts";
import { compilePush } from "../src/compile.ts";
import { localContext, withClient, withMeta } from "../src/context.ts";
import { runReviewFlow } from "../src/review/server.ts";
import { Store } from "../src/store.ts";
import type { Ticket } from "../src/types.ts";
import { MockJira } from "./mock_jira.ts";

async function decideViaHttp(
  ctx: PushContext,
  decisions: Record<string, { approve: boolean; note: string }>,
  onPage?: (html: string) => void,
) {
  const compiled = await compilePush(ctx);
  await checkStaleness(ctx, compiled.existingKeys);
  let pageUrl = "";
  const flow = runReviewFlow(ctx, compiled, {
    timeoutMs: 10_000,
    openBrowser: false,
    onServe: (url) => (pageUrl = url),
  });
  // poll until the server reports its URL
  while (!pageUrl) await new Promise((r) => setTimeout(r, 5));
  const pageRes = await fetch(pageUrl);
  const html = await pageRes.text();
  onPage?.(html);
  const decideUrl = pageUrl.replace("/review/", "/decide/");
  const res = await fetch(decideUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisions }),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  return await flow;
}

Deno.test("review flow: per-ticket decisions, deps, notes, draining rounds", async (t) => {
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
    // epic + child + an update to the existing ticket
    store.writeWorking("@epic", { ...blank, type: "Epic", summary: "The epic" });
    store.writeWorking("@child", { ...blank, summary: "The child", parent: "@epic" });
    const existing = store.readWorking("TST-1")!.ticket;
    store.writeWorking("TST-1", { ...existing, summary: "Existing task (edited)" });
    cmdCommit(["-m", "round 1: propose everything"]);

    const ctx = withClient(withMeta(localContext()));

    await t.step("round 1: page renders; approve TST-1, reject epic; child auto-drops", async () => {
      const outcome = await decideViaHttp(ctx, {
        "TST-1": { approve: true, note: "" },
        "@epic": { approve: false, note: "epic summary needs more pizzazz" },
        "@child": { approve: true, note: "" }, // depends on @epic -> must drop
      }, (html) => {
        assertStringIncludes(html, "The epic");
        assertStringIncludes(html, "round 1: propose everything");
        assertStringIncludes(html, "Existing task (edited)");
        assertStringIncludes(html, `data-deps="@epic"`); // dependency wired into the page
      });

      assertEquals(outcome.status, "partial");
      assertEquals(outcome.approved, ["TST-1"]);
      assertEquals(outcome.rejected.map((r) => r.id), ["@epic"]);
      assertEquals(outcome.rejected[0].note, "epic summary needs more pizzazz");
      assertEquals(outcome.droppedForDeps.map((d) => d.id), ["@child"]);

      // TST-1 pushed and drained; epic + child remain committed
      assertEquals(mock.issues.get("TST-1")!.summary, "Existing task (edited)");
      assertEquals(store.listCommittedIds().sort(), ["@child", "@epic"]);
      // rejection note reached stdout for the agent
      assert(logs.some((l) => l.includes("epic summary needs more pizzazz")));
      // review marker recorded at chain tip
      assertEquals(readReviewMarker(store)!.lastReviewedSeq, readChain(store).entries.at(-1)!.seq);
    });

    await t.step("round 2: revised epic shows in since-review; both push; chain resets", async () => {
      const epic = store.readWorking("@epic")!.ticket;
      store.writeWorking("@epic", { ...epic, summary: "The epic, now with pizzazz" });
      cmdCommit(["-m", "round 2: pizzazz per review"]);

      const outcome = await decideViaHttp(ctx, {
        "@epic": { approve: true, note: "" },
        "@child": { approve: true, note: "" },
      }, (html) => {
        // page shows only the remaining two tickets, the round-2 commit, and since-review
        assertStringIncludes(html, "round 2: pizzazz per review");
        assertStringIncludes(html, "since your last review");
        assert(!html.includes("Existing task (edited)"), "pushed ticket must not reappear");
      });

      assertEquals(outcome.status, "pushed");
      const epicRemote = [...mock.issues.values()].find((i) =>
        i.summary === "The epic, now with pizzazz"
      );
      const childRemote = [...mock.issues.values()].find((i) => i.summary === "The child");
      assert(epicRemote && childRemote);
      assertEquals(childRemote.parent, epicRemote.key);

      // changeset drained: committed empty, chain + marker reset
      assertEquals(store.listCommittedIds(), []);
      assertEquals(readChain(store).entries.length, 0);
      assertEquals(readReviewMarker(store), null);
    });

    await t.step("timeout sends nothing", async () => {
      const w = store.readWorking("TST-1")!.ticket;
      store.writeWorking("TST-1", { ...w, labels: ["late-label"] });
      cmdCommit([]);
      const compiled = await compilePush(ctx);
      const outcome = await runReviewFlow(ctx, compiled, {
        timeoutMs: 100,
        openBrowser: false,
      });
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
