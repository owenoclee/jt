/**
 * The review server as a real process: `jt push` starts it, its links answer over
 * real HTTP, a browser-shaped request can refresh and approve, a later jt of another
 * version replaces it, and `jt serve --stop` ends it. Everything else about reviews
 * is tested against the request handler in-process (hub_test.ts).
 */
import "./hermetic.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdFetch } from "../src/commands/fetch.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdMeta } from "../src/commands/meta.ts";
import { cmdPush } from "../src/commands/push.ts";
import { cmdServe, ensureServer, readServerState, setServerLauncher } from "../src/commands/serve.ts";
import { pidAlive } from "../src/process.ts";
import { Store } from "../src/store.ts";
import { VERSION } from "../src/version.ts";
import { MockJira } from "./mock_jira.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the page's own script sends, and a browser adds, on a same-origin POST. */
function browserPost(url: string, body: unknown): Promise<Response> {
  const origin = new URL(url).origin;
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

Deno.test({
  name: "jt push starts a real review server; its link refreshes, approves and survives",
  // The server is a real detached process that outlives individual steps by design.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const mock = new MockJira();
    mock.seedIssue({ summary: "Existing task" });
    mock.start();

    const dir = Deno.makeTempDirSync({ prefix: "jt-serve-" });
    const home = Deno.makeTempDirSync({ prefix: "jt-serve-home-" });
    const prev = {
      cwd: Deno.cwd(),
      token: Deno.env.get("JIRA_API_TOKEN"),
      home: Deno.env.get("HOME"),
      port: Deno.env.get("JT_REVIEW_PORT"),
      log: console.log,
    };
    Deno.chdir(dir);
    Deno.env.set("JIRA_API_TOKEN", "test-token");
    Deno.env.set("HOME", home);
    Deno.env.set("JT_REVIEW_PORT", "0"); // any free port: this must not meet a real server
    setServerLauncher(null);
    const logs: string[] = [];
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    const link = () =>
      logs.findLast((l) => l.includes("for review:"))!.match(/http:\/\/127\.0\.0\.1:\d+\/p\/TST\/default/)![0];

    try {
      const store = new Store(dir);
      cmdInit(["--base-url", mock.baseUrl, "--email", "t@example.com", "--project", "TST"]);
      await cmdMeta(["sync"]);
      await cmdFetch(["TST-1"]);
      store.writeWorking("TST-1", { ...store.readWorking("TST-1")!.ticket, summary: "Existing task (edited)" });
      cmdCommit(["-m", "round 1"]);

      let url = "";
      let pid = 0;

      await t.step("push starts the server and prints a link that answers", async () => {
        await cmdPush([]);
        url = link();
        const state = readServerState()!;
        pid = state.pid;
        assert(pidAlive(pid) && pid !== Deno.pid, "the server is its own process");
        assertEquals(state.version, VERSION);
        assertEquals(new URL(url).port, String(state.port));

        const res = await fetch(url);
        const html = await res.text();
        assertEquals(res.status, 200);
        assertStringIncludes(html, "Existing task (edited)");
        assertStringIncludes(html, "round 1"); // the default proposal's title is its commit note
        assertStringIncludes(res.headers.get("content-security-policy") ?? "", "frame-ancestors 'none'");
        assertEquals(mock.issues.get("TST-1")!.summary, "Existing task", "nothing is sent by submitting");
      });

      await t.step("the page's own requests check it against Jira and approve it", async () => {
        const local = await (await fetch(url)).text();
        const m = /csrf: ("[^"]*"), tag: ("(?:[^"\\]|\\.)*")/.exec(local)!;
        const body = { csrf: JSON.parse(m[1]), tag: JSON.parse(m[2]) };

        // Anything that is not a page of this server asking is refused.
        const bare = await fetch(`${url}/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        assertEquals(bare.status, 403);
        await bare.body?.cancel();

        const refreshed = await (await browserPost(`${url}/refresh`, body)).json();
        assert(typeof refreshed.view === "string", JSON.stringify(refreshed));
        const page = await (await fetch(`${url}?v=${refreshed.view}`)).text();
        assertStringIncludes(page, "Approve &amp; push all 1");
        const token = JSON.parse(/const decideToken = ("[^"]*")/.exec(page)![1]);

        const res = await browserPost(`${url}/decide`, { decision: "approve", comments: [], token });
        const done = await res.json();
        assertEquals(res.status, 200, JSON.stringify(done));
        assertEquals(done.status, "pushed");
        assertEquals(mock.issues.get("TST-1")!.summary, "Existing task (edited)");
        assertEquals(store.listCommittedIds(), [], "the server settled the workspace");

        // Pushed: the same link now shows what was sent.
        assertStringIncludes(await (await fetch(url)).text(), "round 1 — pushed");
      });

      await t.step("the next submission finds the same server at the same link", async () => {
        store.writeWorking("TST-1", { ...store.readWorking("TST-1")!.ticket, labels: ["second-round"] });
        cmdCommit(["-m", "round 2"]);
        await cmdPush([]);
        assertEquals(link(), url);
        assertEquals(readServerState()!.pid, pid, "no second server was started");
      });

      await t.step("jt serve --stop ends it, and says what that means for links", async () => {
        logs.length = 0;
        await cmdServe(["--stop"]);
        assertEquals(pidAlive(pid), false);
        assertEquals(readServerState(), null, "a stopped server leaves no state behind");
        assertStringIncludes(logs.join("\n"), "proposal links will not open");
      });

      await t.step("a server left by another version of jt is replaced, not reused", async () => {
        const old = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--allow-read",
            "--allow-write",
            "--allow-env",
            "--allow-net",
            "--config",
            fromFileUrl(new URL("../deno.json", import.meta.url)),
            fromFileUrl(new URL("./fixtures/old_server.ts", import.meta.url)),
          ],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
        for (let i = 0; i < 150 && readServerState()?.version !== "0.0.1"; i++) await sleep(100);
        const stale = readServerState()!;
        assertEquals(stale.version, "0.0.1");
        assertEquals(stale.pid, old.pid);

        const origin = await ensureServer();
        const now = readServerState()!;
        assertEquals(now.version, VERSION);
        assert(now.pid !== stale.pid);
        assertEquals(pidAlive(stale.pid), false, "the old server was stopped");
        assertEquals((await (await fetch(`${origin}/health`)).json()).version, VERSION);
        await old.status;

        // The proposal submitted before the swap is still there to review.
        const html = await (await fetch(`${origin}/p/TST/default`)).text();
        assertStringIncludes(html, "round 2");
        assertStringIncludes(html, "awaiting your review");
      });
    } finally {
      const state = readServerState();
      if (state && pidAlive(state.pid) && state.pid !== Deno.pid) {
        try {
          Deno.kill(state.pid, "SIGTERM");
        } catch {
          // gone already
        }
      }
      console.log = prev.log;
      Deno.chdir(prev.cwd);
      for (const [name, value] of [["JIRA_API_TOKEN", prev.token], ["HOME", prev.home], ["JT_REVIEW_PORT", prev.port]] as const) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
      await mock.stop();
    }
  },
});
