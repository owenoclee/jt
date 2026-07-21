/**
 * Mirror workflow e2e: init (mirror by default) → jt pull clones the project →
 * remote churn (edit / create / delete / leave-scope) flows in incrementally →
 * jt changes reports upstream news against the seen layer → --ack absorbs it.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cmdChanges } from "../src/commands/changes.ts";
import { cmdFetch, cmdPull } from "../src/commands/fetch.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdStatus } from "../src/commands/local.ts";
import { cmdMeta } from "../src/commands/meta.ts";
import { Store } from "../src/store.ts";
import { MockJira } from "./mock_jira.ts";

Deno.test("mirror: clone, incremental pull, changes/ack lifecycle", async (t) => {
  const mock = new MockJira();
  mock.seedIssue({ summary: "One" }); // TST-1
  mock.seedIssue({ summary: "Two" }); // TST-2
  mock.seedIssue({ summary: "Three" }); // TST-3
  mock.start();

  const dir = Deno.makeTempDirSync({ prefix: "jt-mirror-" });
  const prevCwd = Deno.cwd();
  const prevToken = Deno.env.get("JIRA_API_TOKEN");
  Deno.chdir(dir);
  Deno.env.set("JIRA_API_TOKEN", "test-token");
  let logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const output = () => logs.join("\n");

  try {
    const store = new Store(dir);

    await t.step("init defaults to mirroring the project; pull clones it", async () => {
      cmdInit(["--base-url", mock.baseUrl, "--email", "t@example.com", "--project", "TST"]);
      await cmdMeta(["sync"]);
      logs = [];
      await cmdPull();

      assertStringIncludes(output(), "cloned: 3 tickets");
      for (const key of ["TST-1", "TST-2", "TST-3"]) {
        assert(store.readWorking(key), `${key} materialized`);
        assert(store.readSeen(key), `${key} baseline seeded`);
      }
      const state = store.readSyncState();
      assert(state.watermark, "watermark recorded");
      assertEquals(state.scopeKeys, ["TST-1", "TST-2", "TST-3"]);

      logs = [];
      cmdChanges([]);
      assertStringIncludes(output(), "no upstream changes");
    });

    await t.step("overnight churn flows in: edit, create, delete", async () => {
      mock.issues.get("TST-1")!.summary = "One (renamed)";
      mock.touch("TST-1");
      mock.seedIssue({ summary: "Fresh overnight" }); // TST-4
      mock.issues.delete("TST-2");

      logs = [];
      await cmdPull();
      assertStringIncludes(output(), "deleted remotely — removed local copy");

      assertEquals(store.readWorking("TST-1")!.ticket.summary, "One (renamed)");
      assert(store.readWorking("TST-4"), "new remote ticket materialized");
      assertEquals(store.readWorking("TST-2"), null);
      assertEquals(store.readBase("TST-2"), null);
      assert(store.readSeen("TST-2"), "deletion stays visible as news until acked");
      assertEquals(store.readSyncState().scopeKeys, ["TST-1", "TST-3", "TST-4"]);
    });

    await t.step("jt changes reports the news; status points at it", () => {
      logs = [];
      cmdChanges([]);
      const out = output();
      assertStringIncludes(out, "TST-4");
      assertStringIncludes(out, "new");
      assertStringIncludes(out, "TST-1");
      assertStringIncludes(out, "summary");
      assertStringIncludes(out, "One (renamed)");
      assertStringIncludes(out, "TST-2");
      assertStringIncludes(out, "gone");

      logs = [];
      cmdStatus([]);
      assertStringIncludes(output(), "upstream change");
    });

    await t.step("--ack absorbs; changes goes quiet; seen tombstones cleared", () => {
      logs = [];
      cmdChanges(["--ack"]);
      logs = [];
      cmdChanges([]);
      assertStringIncludes(output(), "no upstream changes since your last ack");
      assertEquals(store.readSeen("TST-2"), null);

      logs = [];
      cmdStatus([]);
      const out = output();
      assert(!out.includes("upstream change"), "status footer cleared after ack");
      assertStringIncludes(out, "clean (jt status --all to list)");
    });

    await t.step("idle pull is cheap: no per-issue GETs, no changes reported", async () => {
      mock.requestLog.length = 0;
      logs = [];
      await cmdPull();
      const issueGets = mock.requestLog.filter(
        (r) => r.method === "GET" && /\/rest\/api\/3\/issue\//.test(r.path),
      );
      assertEquals(issueGets.length, 0, "unchanged tickets are never refetched individually");
      const searches = mock.requestLog.filter((r) => r.path === "/rest/api/3/search/jql");
      assert(searches.length <= 2, `expected at most 2 searches, saw ${searches.length}`);
      assertStringIncludes(output(), "unchanged");
    });

    await t.step("a ticket moved out of the project leaves the mirror", async () => {
      mock.issues.get("TST-3")!.project = "OTH";
      mock.touch("TST-3");
      logs = [];
      await cmdPull();
      assertStringIncludes(output(), "left the board — removed local copy");
      assertEquals(store.readWorking("TST-3"), null);

      logs = [];
      cmdChanges([]);
      assertStringIncludes(output(), "TST-3");
      assertStringIncludes(output(), "gone");
      cmdChanges(["--ack"]);
    });

    await t.step("a ticket moved into the project is discovered without an updated bump", async () => {
      // Old timestamp: below the watermark, so the incremental page skips it and the
      // straggler path must pick it up from scope membership.
      const moved = mock.seedIssue({ summary: "Moved in quietly" });
      moved.updated = new Date(1780000000000 - 10 * 60 * 1000).toISOString();
      logs = [];
      await cmdPull();
      assert(store.readWorking(moved.key), "moved-in ticket materialized");
      logs = [];
      cmdChanges(["--ack"]);
    });

    await t.step("local edits rebase against mirror churn; changes shows the remote side", async () => {
      const wf = store.readWorking("TST-1")!;
      store.writeWorking("TST-1", { ...wf.ticket, summary: "my local rename" });
      mock.issues.get("TST-1")!.labels = ["triaged"];
      mock.touch("TST-1");

      logs = [];
      await cmdPull();
      assertStringIncludes(output(), "rebased");
      const after = store.readWorking("TST-1")!.ticket;
      assertEquals(after.summary, "my local rename", "local edit preserved");
      assertEquals(after.labels, ["triaged"], "remote label flowed in");

      logs = [];
      cmdChanges([]);
      assertStringIncludes(output(), "labels");
      assertStringIncludes(output(), "+triaged");
      cmdChanges(["--ack"]);
      // put working back to clean for the conflict step
      store.writeWorking("TST-1", store.readBase("TST-1")!.ticket);
    });

    await t.step("conflicting churn surfaces in jt changes as held back", async () => {
      const wf = store.readWorking("TST-1")!;
      store.writeWorking("TST-1", { ...wf.ticket, summary: "local side" });
      mock.issues.get("TST-1")!.summary = "remote side";
      mock.touch("TST-1");

      logs = [];
      await cmdPull();
      assertStringIncludes(output(), "CONFLICT");
      logs = [];
      cmdChanges([]);
      assertStringIncludes(output(), "conflict");
      assertStringIncludes(output(), "jt resolve TST-1");

      // clean up: accept remote, clear the conflict record
      store.writeConflicts([]);
      store.writeWorking("TST-1", { ...wf.ticket, summary: "remote side" });
      await cmdPull();
      cmdChanges(["--ack"]);
    });

    await t.step("truncated search comments trigger an individual refetch", async () => {
      mock.searchCommentCap = 1;
      const target = mock.issues.get("TST-4")!;
      target.comments.push(
        { id: "9001", author: "A", created: "2026-07-21T08:00:00.000Z", body: mdDoc("first") },
        { id: "9002", author: "B", created: "2026-07-21T08:01:00.000Z", body: mdDoc("second") },
      );
      mock.touch("TST-4");
      mock.requestLog.length = 0;
      logs = [];
      await cmdPull();

      assertEquals(store.readWorking("TST-4")!.ticket.comments.length, 2);
      const refetch = mock.requestLog.find(
        (r) => r.method === "GET" && r.path === "/rest/api/3/issue/TST-4",
      );
      assert(refetch, "individual GET fired for the truncated issue");
    });

    await t.step("ad-hoc tracking outside the scope still works alongside the mirror", async () => {
      const other = mock.seedIssue({ summary: "Other project ticket", project: "OTH" });
      await cmdFetch([other.key]);
      assert(store.readWorking(other.key));
      await cmdPull(); // must not drop it: never was in scope
      assert(store.readWorking(other.key), "ad-hoc ticket survives mirror pulls");
    });
  } finally {
    console.log = origLog;
    Deno.chdir(prevCwd);
    if (prevToken === undefined) Deno.env.delete("JIRA_API_TOKEN");
    else Deno.env.set("JIRA_API_TOKEN", prevToken);
    await mock.stop();
  }
});

function mdDoc(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}
