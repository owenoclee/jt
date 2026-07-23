/**
 * Detached push integration: jt push spawns a real child process serving the review
 * page and returns with the URL at once; jt await collects the outcome exactly once
 * with the old blocking-push exit-code semantics. Approve, request-changes, and the
 * one-review-at-a-time guard are all driven over real HTTP against the mock Jira.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdFetch } from "../src/commands/fetch.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdMeta } from "../src/commands/meta.ts";
import { cmdPush } from "../src/commands/push.ts";
import { cmdAwait, exitCodeFor } from "../src/commands/push_detach.ts";
import {
  clearResult,
  readPending,
  readResult,
  readSpec,
  type PushResultFile,
} from "../src/review/handoff.ts";
import { Store } from "../src/store.ts";
import { MockJira } from "./mock_jira.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function decide(url: string, decision: string, notes: Record<string, string> = {}) {
  const res = await fetch(url.replace("/review/", "/decide/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, notes }),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
}

async function pollResult(jiraDir: string, timeoutMs = 15_000): Promise<PushResultFile> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = readResult(jiraDir);
    if (r) return r;
    await sleep(100);
  }
  throw new Error("no push result appeared in time");
}

Deno.test({
  name: "detached push: URL immediately, await collects each outcome once",
  // The review server is a real detached child; its process handle and the decide
  // fetches outlive individual steps by design.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const mock = new MockJira();
    mock.seedIssue({ summary: "Existing task" });
    mock.start();

    const dir = Deno.makeTempDirSync({ prefix: "jt-detach-" });
    const jiraDir = join(dir, ".jira");
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
      const t1 = store.readWorking("TST-1")!.ticket;
      store.writeWorking("TST-1", { ...t1, summary: "Existing task (edited)" });
      cmdCommit(["-m", "round 1"]);

      let url = "";

      await t.step("push prints the URL and returns while the page is live", async () => {
        await cmdPush([]);
        const urlLine = logs.find((l) => l.includes("review page:"));
        assert(urlLine, "push must print the review URL");
        url = urlLine.match(/http:\/\/127\.0\.0\.1:\d+\/review\/[a-z0-9-]+/)![0];
        assert(readPending(jiraDir), "pending-push.json must exist while the page is live");
        assertEquals(readSpec(jiraDir), null, "the child must consume the spec file");
        const page = await fetch(url);
        assertStringIncludes(await page.text(), "Existing task (edited)");
      });

      await t.step("a second push refuses while the review is pending", async () => {
        let msg = "";
        try {
          await cmdPush([]);
        } catch (e) {
          msg = e instanceof Error ? e.message : String(e);
        }
        assertStringIncludes(msg, "already pending");
      });

      await t.step("request-changes: notes recorded, nothing sent, exit code 2", async () => {
        await decide(url, "request-changes", { "TST-1": "less edited please" });
        const result = await pollResult(jiraDir);
        assertEquals(result.status, "changes-requested");
        assertEquals(result.notes["TST-1"], "less edited please");
        assertEquals(exitCodeFor(result), 2);
        assertEquals(mock.issues.get("TST-1")!.summary, "Existing task");
        assert(
          result.log.some((l) => l.includes("less edited please")),
          "the replayable log must carry the notes",
        );
        assertEquals(readPending(jiraDir), null, "pending file must be gone after settling");
        clearResult(jiraDir); // collected (via exitCodeFor) — clear as jt await would
      });

      await t.step("approve: await reports pushed and cleans up exactly once", async () => {
        await cmdPush([]);
        const urlLine = logs.findLast((l) => l.includes("review page:"))!;
        url = urlLine.match(/http:\/\/127\.0\.0\.1:\d+\/review\/[a-z0-9-]+/)![0];
        await decide(url, "approve");
        await cmdAwait([]); // pushed → exit code 0 → returns normally
        assertEquals(mock.issues.get("TST-1")!.summary, "Existing task (edited)");
        assert(logs.some((l) => l.includes("approved and pushed")));
        assertEquals(readResult(jiraDir), null, "outcome must be consumed by await");
        assertEquals(readPending(jiraDir), null);
        let msg = "";
        try {
          await cmdAwait([]);
        } catch (e) {
          msg = e instanceof Error ? e.message : String(e);
        }
        assertStringIncludes(msg, "nothing to await");
      });
    } finally {
      console.log = origLog;
      Deno.chdir(prevCwd);
      if (prevToken === undefined) Deno.env.delete("JIRA_API_TOKEN");
      else Deno.env.set("JIRA_API_TOKEN", prevToken);
      await mock.stop();
    }
  },
});
