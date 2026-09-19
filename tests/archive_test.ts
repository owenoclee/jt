/**
 * Archiving end to end: stage → commit → approved push, on a mock Jira that behaves
 * like a Premium site (and, on request, like one without the feature).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdFetch } from "../src/commands/fetch.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdArchive, cmdDiff, cmdRestore, cmdRm, cmdUnarchive } from "../src/commands/local.ts";
import { cmdMeta } from "../src/commands/meta.ts";
import { cmdPush } from "../src/commands/push.ts";
import { cmdAwait } from "../src/commands/push_detach.ts";
import { clearResult, readPending, readResult } from "../src/review/handoff.ts";
import { intentFailure } from "../src/intents.ts";
import { Store } from "../src/store.ts";
import { MockJira } from "./mock_jira.ts";

async function approve(): Promise<void> {
  await cmdPush([]);
  const pending = readPending(join(Deno.cwd(), ".jira"));
  if (!pending) throw new Error("no pending review after push");
  const res = await fetch(pending.url.replace("/review/", "/decide/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve", notes: {} }),
  });
  await res.body?.cancel();
}

async function pushApproved(): Promise<void> {
  await approve();
  await cmdAwait([]);
}

/**
 * Same, for a push whose ops fail: `jt await` would exit(1), which a test runner
 * cannot survive, so the outcome is collected straight from the handoff file.
 */
async function pushApprovedFailing(): Promise<string[]> {
  await approve();
  const jiraDir = join(Deno.cwd(), ".jira");
  for (let i = 0; i < 200; i++) {
    const result = readResult(jiraDir);
    if (result) {
      clearResult(jiraDir);
      return result.log;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("push never recorded an outcome");
}

/** A workspace wired to a fresh mock, with `logs` capturing everything printed. */
async function withWorkspace(
  fn: (ctx: { mock: MockJira; store: Store; logs: string[] }) => Promise<void>,
): Promise<void> {
  const mock = new MockJira();
  mock.seedIssue({ summary: "Old task" });
  mock.seedIssue({ summary: "Second task" });
  mock.start();
  const dir = Deno.makeTempDirSync({ prefix: "jt-archive-" });
  const prevCwd = Deno.cwd();
  const prevToken = Deno.env.get("JIRA_API_TOKEN");
  Deno.chdir(dir);
  Deno.env.set("JIRA_API_TOKEN", "test-token");
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    cmdInit(["--base-url", mock.baseUrl, "--email", "t@example.com", "--project", "TST"]);
    await cmdMeta(["sync"]);
    await cmdFetch(["TST-1", "TST-2"]);
    await fn({ mock, store: new Store(dir), logs });
  } finally {
    console.log = origLog;
    Deno.chdir(prevCwd);
    if (prevToken === undefined) Deno.env.delete("JIRA_API_TOKEN");
    else Deno.env.set("JIRA_API_TOKEN", prevToken);
    await mock.stop();
  }
}

Deno.test("archive: stage, commit, push — the issue is archived, not deleted", async () => {
  await withWorkspace(async ({ mock, store, logs }) => {
    cmdArchive(["TST-1"]);
    assertEquals(store.status().find((s) => s.id === "TST-1")!.state, "archived");
    assert(logs.some((l) => l.includes("staged archiving")), logs.join("\n"));

    cmdCommit([]);
    assertEquals(store.status().find((s) => s.id === "TST-1")!.state, "archived+committed");
    cmdDiff(["--committed"]);
    assertStringIncludes(logs.join("\n"), "will archive:");

    await pushApproved();
    assert(mock.issues.get("TST-1")!.archived, "issue was not archived");
    assert(mock.issues.has("TST-1"), "archiving must not delete the issue");
    const archiveCalls = mock.requestLog.filter((r) => r.path === "/rest/api/3/issue/archive");
    assertEquals(archiveCalls.length, 1);
    assertEquals(archiveCalls[0].method, "PUT");
    assertEquals(archiveCalls[0].body, { issueIdsOrKeys: ["TST-1"] });
    // Archived issues leave the board, so every local trace goes with them.
    assertEquals(store.readBase("TST-1"), null);
    assertEquals(store.readWorking("TST-1"), null);
    assertEquals(store.readIntents(), []);
  });
});

Deno.test("unarchive: works on a key this workspace never tracked, and tracks it after", async () => {
  await withWorkspace(async ({ mock, store }) => {
    mock.issues.get("TST-2")!.archived = true;
    cmdArchive(["TST-1"]); // a second intent in the same changeset
    cmdUnarchive(["TST-2"]);
    cmdCommit([]);
    await pushApproved();

    assertEquals(mock.issues.get("TST-2")!.archived, false);
    const unarchive = mock.requestLog.find((r) => r.path === "/rest/api/3/issue/unarchive");
    assertEquals(unarchive?.method, "PUT");
    assertEquals(unarchive?.body, { issueIdsOrKeys: ["TST-2"] });
    // It is back on the board, so it comes back into the mirror.
    assertEquals(store.readWorking("TST-2")?.ticket.summary, "Second task");
    assertEquals(store.readIntents(), []);
  });
});

Deno.test("archive on a plan without it fails with the reason, and stays staged", async () => {
  await withWorkspace(async ({ mock, store, logs }) => {
    mock.archivingEnabled = false;
    cmdArchive(["TST-1"]);
    cmdCommit([]);
    const pushLog = await pushApprovedFailing();

    assertEquals(mock.issues.get("TST-1")!.archived, false);
    const printed = [...logs, ...pushLog].join("\n");
    assertStringIncludes(printed, "only available for premium editions");
    assertStringIncludes(printed, "requires a Jira Premium or Enterprise plan");
    // Nothing landed, so the intent is still there to retry or abandon.
    assertEquals(store.readIntents().length, 1);
  });
});

Deno.test("jt rm points at archiving, and restore undoes either", async () => {
  await withWorkspace(({ store, logs }) => {
    cmdRm(["TST-1"]);
    const printed = logs.join("\n");
    assertStringIncludes(printed, "deletion is permanent");
    assertStringIncludes(printed, "jt archive TST-1");
    assertEquals(store.status().find((s) => s.id === "TST-1")!.state, "deleted");

    cmdRestore(["TST-1"]);
    assertEquals(store.readIntents(), []);
    assertEquals(store.status().find((s) => s.id === "TST-1")!.state, "clean");

    cmdArchive(["TST-1"]);
    cmdRestore(["TST-1"]);
    assertEquals(store.readIntents(), []);
    assertEquals(store.status().find((s) => s.id === "TST-1")!.state, "clean");
    return Promise.resolve();
  });
});

Deno.test("a 200 that archived nothing fails the op instead of claiming success", () => {
  // The list endpoints report per-issue refusals inside a 200 body.
  assert(intentFailure("archive", "TST-1", { numberOfIssuesUpdated: 0, errors: null }));
  assert(intentFailure("archive", "TST-1", {
    numberOfIssuesUpdated: 1,
    errors: { issuesInError: ["TST-1"] },
  }));
  // A clean success, and an unfamiliar success shape, must both pass. The first is
  // verbatim what a live site returns for a successful archive.
  assertEquals(intentFailure("archive", "TST-1", { numberOfIssuesUpdated: 1, errors: {} }), null);
  assertEquals(intentFailure("archive", "TST-1", { numberOfIssuesUpdated: 1, errors: null }), null);
  assertEquals(intentFailure("unarchive", "TST-1", {}), null);
  assertEquals(intentFailure("unarchive", "TST-1", null), null);
});
