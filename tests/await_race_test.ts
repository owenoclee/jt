/**
 * jt await must not miss a review that settles while it is looking.
 *
 * The review server records its outcome and then removes its pending file. An await
 * that reads "no outcome yet", then "no pending review", has straddled that moment —
 * and used to report that there was nothing to await, leaving the outcome uncollected.
 */
import { assert, assertEquals } from "@std/assert";
import { cmdInit } from "../src/commands/init.ts";
import { cmdAwait } from "../src/commands/push_detach.ts";
import {
  clearPending,
  readResult,
  resultPath,
  writePending,
  writeResult,
} from "../src/review/handoff.ts";
import { Store } from "../src/store.ts";

Deno.test("await collects an outcome that lands between its two looks", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "jt-await-race-" });
  const prevCwd = Deno.cwd();
  const realRead = Deno.readTextFileSync;
  const realLog = console.log;
  const logs: string[] = [];
  Deno.chdir(dir);
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    cmdInit(["--base-url", "https://example.atlassian.net", "--email", "t@example.com", "--project", "TST"]);
    const proposalDir = new Store(Deno.cwd()).proposalDir;
    writePending(proposalDir, {
      pid: Deno.pid,
      url: "http://127.0.0.1:1/review/x",
      startedAt: new Date().toISOString(),
    });

    // The server settles at the worst moment: just after await's first look for an
    // outcome, just before its look for a pending review.
    let settled = false;
    Deno.readTextFileSync = ((path: string | URL, ...rest: []) => {
      if (!settled && String(path) === resultPath(proposalDir)) {
        settled = true;
        writeResult(proposalDir, {
          finishedAt: new Date().toISOString(),
          status: "pushed",
          notes: {},
          pushFailure: null,
          log: ["approved and pushed 1 operation"],
        });
        clearPending(proposalDir);
        throw new Deno.errors.NotFound("no outcome yet");
      }
      return realRead(path, ...rest);
    }) as typeof Deno.readTextFileSync;

    await cmdAwait([]);
    assert(settled, "the race was never staged");
    assert(logs.includes("approved and pushed 1 operation"), "the outcome must be reported");
    assertEquals(readResult(proposalDir), null, "and collected exactly once");
  } finally {
    Deno.readTextFileSync = realRead;
    console.log = realLog;
    Deno.chdir(prevCwd);
  }
});
