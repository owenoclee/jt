/**
 * End-to-end lifecycle against a mock Jira over real HTTP, driving the actual
 * command functions: init → meta sync → fetch → edit → commit → push → create
 * flow with @refs → links/comments/transitions → staleness → tamper → delete.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdFetch, cmdPull } from "../src/commands/fetch.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdRm } from "../src/commands/local.ts";
import { cmdMeta } from "../src/commands/meta.ts";
import { cmdPush } from "../src/commands/push.ts";
import { cmdAwait } from "../src/commands/push_detach.ts";
import { UserError } from "../src/errors.ts";
import { readPending } from "../src/review/handoff.ts";
import { Store } from "../src/store.ts";
import type { Ticket } from "../src/types.ts";
import { MockJira } from "./mock_jira.ts";

function readTicket(store: Store, id: string): Ticket {
  const wf = store.readWorking(id);
  if (!wf) throw new Error(`no working file for ${id}`);
  return wf.ticket;
}

/** Push is approval-only: approve on the detached review page, then collect via await. */
async function pushApproved(argv: string[] = []): Promise<void> {
  await cmdPush(argv); // returns as soon as the detached server reports its URL
  const pending = readPending(join(Deno.cwd(), ".jira"));
  if (!pending) throw new Error("no pending review after push");
  const res = await fetch(pending.url.replace("/review/", "/decide/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve", notes: {} }),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  await cmdAwait([]); // approved and pushed → exit code 0 path returns normally
}

Deno.test("e2e: full lifecycle against mock Jira", async (t) => {
  const mock = new MockJira();
  mock.seedIssue({ summary: "Seeded task", labels: ["seed"], storyPoints: 3 });
  mock.start();

  const dir = Deno.makeTempDirSync({ prefix: "jt-e2e-" });
  const prevCwd = Deno.cwd();
  const prevToken = Deno.env.get("JIRA_API_TOKEN");
  Deno.chdir(dir);
  Deno.env.set("JIRA_API_TOKEN", "test-token");
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));

  try {
    const store = new Store(dir);

    await t.step("init + meta sync + fetch", async () => {
      cmdInit(["--base-url", mock.baseUrl, "--email", "t@example.com", "--project", "TST"]);
      // track Story Points as a custom field
      const configPath = join(dir, ".jira", "config.json");
      const config = JSON.parse(Deno.readTextFileSync(configPath));
      config.customFields = ["Story Points"];
      Deno.writeTextFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

      await cmdMeta(["sync"]);
      await cmdFetch(["TST-1"]);
      const ticket = readTicket(store, "TST-1");
      assertEquals(ticket.summary, "Seeded task");
      assertEquals(ticket.fields["Story Points"], 3);
      assertEquals(store.status()[0].state, "clean");
    });

    await t.step("edit + commit + push updates the remote", async () => {
      const ticket = readTicket(store, "TST-1");
      store.writeWorking("TST-1", {
        ...ticket,
        summary: "Seeded task (edited)",
        labels: [...ticket.labels, "from-jt"],
        status: "In Progress",
        sprint: "Sprint 42",
        description: "# New description\n\nWith **bold** text.",
        fields: { "Story Points": 5 },
        comments: [...ticket.comments, { body: "posted by jt e2e" }],
      });
      cmdCommit([]);
      await pushApproved();

      const remote = mock.issues.get("TST-1")!;
      assertEquals(remote.summary, "Seeded task (edited)");
      assertEquals(remote.labels.sort(), ["from-jt", "seed"]);
      assertEquals(remote.status, "In Progress");
      assertEquals(remote.sprintId, 42);
      assertEquals(remote.storyPoints, 5);
      assertEquals(remote.comments.length, 1);

      // local state settled: clean, committed layer empty, base advanced
      assertEquals(store.listCommittedIds(), []);
      assertEquals(store.status()[0].state, "clean");
      const after = readTicket(store, "TST-1");
      assertEquals(after.comments.length, 1);
      assert(after.comments[0].id, "posted comment gained an id after refetch");
      assertEquals(after.description, "# New description\n\nWith **bold** text.");
    });

    await t.step("push is tamper-proof: working edits after commit are not sent", async () => {
      const ticket = readTicket(store, "TST-1");
      store.writeWorking("TST-1", { ...ticket, summary: "approved change" });
      cmdCommit([]);
      // tamper AFTER commit
      store.writeWorking("TST-1", { ...ticket, summary: "TAMPERED change" });
      await pushApproved();
      assertEquals(mock.issues.get("TST-1")!.summary, "approved change");
      // the tampered working copy survives as an uncommitted local edit
      assertEquals(store.status()[0].state, "modified");
      // put it back to clean for later steps
      const base = store.readBase("TST-1")!;
      store.writeWorking("TST-1", base.ticket);
    });

    await t.step("create epic + child with @refs, links, in one push", async () => {
      const epic: Ticket = {
        project: "TST",
        type: "Epic",
        summary: "Big epic",
        description: null,
        labels: [],
        parent: null,
        sprint: null,
        assignee: null,
        priority: null,
        links: [],
        comments: [],
        fields: { "Story Points": null },
      };
      const story: Ticket = {
        ...epic,
        type: "Story",
        summary: "Child story",
        parent: "@epic1",
        links: [{ type: "blocks", to: "TST-1" }],
        comments: [{ body: "first comment on the story" }],
      };
      store.writeWorking("@epic1", epic);
      store.writeWorking("@story1", story);
      cmdCommit([]);
      await pushApproved();

      // created remotely with parent chain
      const epicRemote = [...mock.issues.values()].find((i) => i.summary === "Big epic")!;
      const storyRemote = [...mock.issues.values()].find((i) => i.summary === "Child story")!;
      assertEquals(storyRemote.parent, epicRemote.key);
      // link direction: story blocks TST-1 => {inward: story, outward: TST-1}
      const link = [...mock.links.values()][0];
      assertEquals(link.typeName, "Blocks");
      assertEquals(link.inwardKey, storyRemote.key);
      assertEquals(link.outwardKey, "TST-1");
      assertEquals(storyRemote.comments.length, 1);

      // local files renamed to real keys and clean
      assert(store.readWorking(epicRemote.key));
      assert(store.readWorking(storyRemote.key));
      assertEquals(store.readWorking("@epic1"), null);
      const states = store.status();
      assert(states.every((s) => s.state === "clean"), JSON.stringify(states));
      // child's parent ref resolved to the real key
      assertEquals(readTicket(store, storyRemote.key).parent, epicRemote.key);
      // the link PARTNER (TST-1) was refetched too: its working copy shows the inverse edge
      assertEquals(readTicket(store, "TST-1").links, [
        { type: "is blocked by", to: storyRemote.key },
      ]);
    });

    await t.step("staleness guard refuses to push over remote changes", async () => {
      const ticket = readTicket(store, "TST-1");
      store.writeWorking("TST-1", { ...ticket, summary: "local change" });
      cmdCommit([]);
      // out-of-band remote change
      mock.issues.get("TST-1")!.summary = "changed in web UI";
      mock.touch("TST-1");
      await assertRejects(() => cmdPush([]), UserError, "remote changed");
      // the guard batched: one key-in search, not a GET per staged issue
      assert(mock.requestLog.some((r) =>
        r.path === "/rest/api/3/search/jql" && /key in/i.test(r.body?.jql ?? "")
      ));
      // strict JQL validation rejecting key-in degrades to per-key GETs, same verdict
      mock.rejectKeyInSearch = true;
      await assertRejects(() => cmdPush([]), UserError, "remote changed");
      mock.rejectKeyInSearch = false;
      // pull → conflict (both edited summary)
      await cmdPull();
      const conflicts = store.readConflicts();
      assertEquals(conflicts.length, 1);
      assertEquals(conflicts[0].fields, ["summary"]);
      // resolve by reverting to remote value locally
      store.writeConflicts([]);
      const fresh = mock.issues.get("TST-1")!;
      store.removeCommitted("TST-1");
      const base = store.readBase("TST-1")!;
      store.writeWorking("TST-1", { ...base.ticket, summary: fresh.summary });
      await cmdPull();
      assertEquals(store.status().find((s) => s.id === "TST-1")!.state, "clean");
    });

    await t.step("rm + commit + push deletes remotely and cleans up locally", async () => {
      const doomed = [...mock.issues.values()].find((i) => i.summary === "Child story")!;
      cmdRm([doomed.key]);
      cmdCommit([]);
      await pushApproved();
      assertEquals(mock.issues.has(doomed.key), false);
      assertEquals(store.readBase(doomed.key), null);
      assertEquals(store.readDeletions(), []);
      assertEquals(mock.links.size, 0, "links to the deleted issue are gone");
    });

    await t.step("push journal recorded every operation with approval provenance", () => {
      const journal = store.listJournal();
      assert(journal.length >= 3);
      const allOps = journal.flatMap((j) => j.entry.ops);
      assert(allOps.every((op) => op.ok));
      assertStringIncludes(JSON.stringify(allOps), "/rest/api/3/issue");
      // Push is approval-only: every entry carries the decision's provenance.
      for (const j of journal) {
        assert(j.entry.review, "journal entry missing review provenance");
        assert(j.entry.review!.decideMs >= 0);
        assert(j.entry.review!.userAgent, "decision POST recorded no user agent");
      }
    });
  } finally {
    console.log = origLog;
    Deno.chdir(prevCwd);
    if (prevToken === undefined) Deno.env.delete("JIRA_API_TOKEN");
    else Deno.env.set("JIRA_API_TOKEN", prevToken);
    await mock.stop();
  }
});
