/**
 * A custom field's key can be absent from a ticket file for ordinary reasons: the field
 * joined `customFields` after the ticket was fetched, or Jira does not have the field
 * on that issue at all. Absent and null both mean "no value" — neither may read as a
 * change, and above all neither may compile to a write Jira can refuse.
 */
import "./hermetic.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdFetch } from "../src/commands/fetch.ts";
import { cmdStatus } from "../src/commands/local.ts";
import { cmdProposals } from "../src/commands/proposals.ts";
import { cmdPush } from "../src/commands/push.ts";
import { diffTickets } from "../src/diff.ts";
import { issueToBaseEntry } from "../src/sync.ts";
import { makeBaseEntry, makeConfig, makeMeta, makeTicket, tempStore } from "./helpers.ts";
import { errorOf, withWorkspace } from "./workspace.ts";

/** Track one more custom field, as a user editing .jira/config.json would. */
function addCustomField(dir: string, alias: string): void {
  const path = join(dir, ".jira", "config.json");
  const config = JSON.parse(Deno.readTextFileSync(path));
  config.customFields = [...config.customFields, alias];
  Deno.writeTextFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

/** The requests that change something in Jira (searches are reads sent as POST). */
function writes(log: { method: string; path: string }[]): string[] {
  return log
    .filter((r) => r.method !== "GET" && !r.path.endsWith("/search/jql"))
    .map((r) => `${r.method} ${r.path}`);
}

Deno.test("an absent custom-field key and null are the same value", () => {
  const store = tempStore();
  const base = makeTicket({ key: "TST-1", fields: { "Story Points": null } });
  store.writeBase(makeBaseEntry(base));
  store.writeWorking("TST-1", { ...base, fields: {} });
  assertEquals(store.status()[0].state, "clean");
  assertEquals(diffTickets(base, { ...base, fields: {} }), []);

  // A real value is still a change, in either direction.
  assertEquals(diffTickets(base, { ...base, fields: { "Story Points": 5 } }).length, 1);
  assertEquals(
    diffTickets({ ...base, fields: { "Story Points": 5 } }, { ...base, fields: {} }).length,
    1,
  );
});

Deno.test("fetch leaves out a custom field Jira does not return for the issue", () => {
  const meta = makeMeta();
  const config = makeConfig({ customFields: ["Story Points", "Team"] });
  const entry = issueToBaseEntry(
    {
      key: "TST-1",
      fields: {
        summary: "An epic",
        issuetype: { name: "Epic" },
        project: { key: "TST" },
        status: { name: "To Do" },
        customfield_10016: null, // on this issue, and empty
        // customfield_10050 (Team) is not returned: the issue does not have it
      },
    },
    meta,
    config,
  );
  assertEquals(entry.ticket.fields, { "Story Points": null });
});

Deno.test("a partial push leaves no phantom field change behind", async () => {
  await withWorkspace(["First"], async (ws) => {
    const store = ws.store();
    ws.writeSettings({ autoAllow: ["status", "labels"] });

    const t = store.readWorking("TST-1")!.ticket;
    store.writeWorking("TST-1", { ...t, labels: ["picked"], status: "In Progress" });
    cmdCommit(["TST-1"]);
    // Then a field joins customFields. Base refetches carry it from now on (as null);
    // the staged copies were made before and do not have the key.
    addCustomField(ws.dir, "Story Points");

    // The label PUT lands, then the transition is refused: a partial push.
    ws.mock.intercept = (method, path) =>
      method === "POST" && path.endsWith("/TST-1/transitions")
        ? new Response(JSON.stringify({ errorMessages: ["transition refused"] }), { status: 400 })
        : null;
    const err = await errorOf(() => cmdPush([]));
    assertStringIncludes(err, "push incomplete");
    assertStringIncludes(err, "still staged:");
    assertStringIncludes(err, "not new work");

    const base = store.readBase("TST-1")!.ticket;
    assertEquals(base.fields, { "Story Points": null }, "the refetched base has the new field");
    const left = store.readCommitted("TST-1")!.ticket;
    assertEquals(diffTickets(base, left).map((e) => e.field), ["status"]);

    ws.logs.length = 0;
    cmdStatus([]);
    assertStringIncludes(ws.logs.join("\n"), "left over from the partial push on");
    ws.logs.length = 0;
    cmdProposals();
    assertStringIncludes(ws.logs.join("\n"), "partly pushed on");

    // The retry sends what was left — the transition — and nothing else: still
    // auto-allowed, and no PUT clearing a field that never had a value.
    ws.mock.intercept = null;
    ws.mock.requestLog.length = 0;
    await cmdPush([]);
    assertEquals(writes(ws.mock.requestLog), ["POST /rest/api/3/issue/TST-1/transitions"]);
    assertEquals(store.status()[0].state, "clean");
    ws.logs.length = 0;
    cmdProposals();
    assert(!ws.logs.join("\n").includes("partly pushed"), "nothing is left over once it lands");
  });
});

Deno.test("a partial push moves what it leaves staged onto the refreshed base", async () => {
  await withWorkspace(["First"], async (ws) => {
    const store = ws.store();
    ws.writeSettings({ autoAllow: ["status", "labels"] });
    const t = store.readWorking("TST-1")!.ticket;
    store.writeWorking("TST-1", { ...t, labels: ["picked"], status: "In Progress" });
    cmdCommit(["TST-1"]);

    ws.mock.intercept = (method, path) => {
      // An automation answers the label edit by raising the priority.
      if (method === "PUT" && path.endsWith("/issue/TST-1")) {
        ws.mock.issues.get("TST-1")!.priority = "Highest";
      }
      return method === "POST" && path.endsWith("/TST-1/transitions")
        ? new Response(JSON.stringify({ errorMessages: ["transition refused"] }), { status: 400 })
        : null;
    };
    await errorOf(() => cmdPush([]));

    // Nobody here edited the priority: the staged copies follow Jira, rather than
    // holding the old value for the next push to send back.
    assertEquals(store.readCommitted("TST-1")!.ticket.priority, "Highest");
    assertEquals(store.readWorking("TST-1")!.ticket.priority, "Highest");
    const base = store.readBase("TST-1")!.ticket;
    assertEquals(diffTickets(base, store.readCommitted("TST-1")!.ticket).map((e) => e.field), [
      "status",
    ]);
  });
});

Deno.test("setting a field the issue's edit screen lacks is refused before anything is sent", async () => {
  await withWorkspace(["An epic"], async (ws) => {
    addCustomField(ws.dir, "Story Points");
    ws.mock.issues.get("TST-1")!.issuetype = "Epic";
    ws.mock.offScreen = { Epic: ["customfield_10016"] };
    await cmdFetch(["TST-1"]);

    const store = ws.store();
    const t = store.readWorking("TST-1")!.ticket;
    store.writeWorking("TST-1", { ...t, status: "Done", fields: { "Story Points": 5 } });
    cmdCommit([]);
    ws.mock.requestLog.length = 0;
    const err = await errorOf(() => cmdPush([]));
    assertStringIncludes(err, "TST-1 (Epic): 'Story Points'");
    assertStringIncludes(err, "Nothing was sent");
    assertEquals(writes(ws.mock.requestLog), []);
  });
});
