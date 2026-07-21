import { assertEquals } from "@std/assert";
import { serializeTicket } from "../src/canonical.ts";
import { appendChainEntry, readChain } from "../src/chain.ts";
import { cmdUntrack } from "../src/commands/local.ts";
import { Store } from "../src/store.ts";
import { makeBaseEntry, makeConfig, makeTicket } from "./helpers.ts";

Deno.test("untrack removes every local layer without requiring Jira access", () => {
  const dir = Deno.makeTempDirSync({ prefix: "jt-untrack-" });
  const previousCwd = Deno.cwd();
  const originalLog = console.log;
  console.log = () => {};

  try {
    const store = new Store(dir);
    store.ensureDirs();
    Deno.writeTextFileSync(
      `${store.jiraDir}/config.json`,
      JSON.stringify(makeConfig(), null, 2) + "\n",
    );

    const ticket = makeTicket({ key: "TST-1", summary: "Tracked locally" });
    store.writeBase(makeBaseEntry(ticket));
    store.writeWorking("TST-1", ticket);
    store.writeCommitted("TST-1", serializeTicket(ticket));
    store.ackSeen();
    store.writeDeletions([
      { key: "TST-1", summary: ticket.summary, requestedAt: "now", committed: true },
    ]);
    store.writeConflicts([
      { key: "TST-1", fields: ["summary"], detectedAt: "now", remote: {}, local: {} },
    ]);
    appendChainEntry(store, "agent", "tracked change", {
      "TST-1": { kind: "ticket", ticket },
    });

    Deno.chdir(dir);
    cmdUntrack(["TST-1"]);

    assertEquals(store.readWorking("TST-1"), null);
    assertEquals(store.readCommitted("TST-1"), null);
    assertEquals(store.readBase("TST-1"), null);
    assertEquals(store.readSeen("TST-1"), null);
    assertEquals(store.readDeletions(), []);
    assertEquals(store.readConflicts(), []);
    assertEquals(readChain(store).entries, []);
  } finally {
    console.log = originalLog;
    Deno.chdir(previousCwd);
    Deno.removeSync(dir, { recursive: true });
  }
});
