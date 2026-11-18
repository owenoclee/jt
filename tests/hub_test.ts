/**
 * The review server, driven at its request handler: a proposal's link, the refresh
 * its page asks for, and the decision — against the mock Jira, with no socket.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdArchive } from "../src/commands/local.ts";
import { createHub } from "../src/review/hub.ts";
import { proposalView } from "../src/review/meta.ts";
import { registerWorkspace } from "../src/review/registry.ts";
import { decide, get, open, post } from "./hub_client.ts";
import { type TestWorkspace, withWorkspace } from "./workspace.ts";

/** Stage an edit to a ticket's summary in a proposal and submit it for review. */
async function submit(ws: TestWorkspace, name: string, edits: Record<string, string>, title = "A proposal") {
  await ws.as(name, () => {
    const store = ws.store(name);
    for (const [key, summary] of Object.entries(edits)) {
      store.writeWorking(key, { ...store.readWorking(key)!.ticket, summary });
    }
    cmdCommit(Object.keys(edits));
    store.writeMeta({ title, description: "Why: **because**.", submittedAt: new Date().toISOString() });
  });
  return registerWorkspace(ws.dir, "TST");
}

Deno.test("a proposal's link reads from disk; its page checks Jira; approving sends it", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    const hub = createHub();
    const slug = await submit(ws, "alpha", { "TST-1": "One, edited" }, "Rename the first one");
    assertEquals(slug, "TST");

    const before = ws.mock.requestLog.length;
    const res = await get(hub, "/p/TST/alpha");
    const local = await res.text();
    assertEquals(res.status, 200);
    assertEquals(ws.mock.requestLog.length, before, "a GET never talks to Jira");
    assertStringIncludes(local, "Rename the first one");
    assertStringIncludes(local, "awaiting your review");
    assertStringIncludes(local, "<strong>because</strong>");
    assertStringIncludes(local, "One, edited");
    assert(!local.includes('id="approve"'), "the link itself cannot decide");
    const csp = res.headers.get("content-security-policy") ?? "";
    assertStringIncludes(csp, "frame-ancestors 'none'");
    assertStringIncludes(csp, "default-src 'none'");
    assertEquals(res.headers.get("x-frame-options"), "DENY");

    const opened = await open(hub, "TST", "alpha");
    assert(opened.page && opened.token, JSON.stringify(opened.refresh));
    assertStringIncludes(opened.page, "Approve &amp; push all 1");
    assertStringIncludes(opened.page, "compiled API operations");
    assertEquals(ws.mock.issues.get("TST-1")!.summary, "One", "rendering sends nothing");

    const done = await decide(hub, "TST", "alpha", opened.token, "approve");
    assertEquals(done.status, 200, JSON.stringify(done.body));
    assertEquals(done.body.status, "pushed");
    assertEquals(done.body.pushFailure, null);
    assert(done.body.log!.some((l) => l.includes("approved and pushed 1 operation")), done.body.log!.join("\n"));
    assertEquals(ws.mock.issues.get("TST-1")!.summary, "One, edited");

    // Pushed: nothing staged, the proposal is gone, and the journal names it.
    assertEquals(ws.store().listProposals(), ["default"]);
    const entry = ws.store("alpha").lastPush()!;
    assertEquals(entry.title, "Rename the first one");
    assertEquals(entry.proposal, "alpha");
    assert(entry.review && entry.review.userAgent?.includes("jt test browser"));

    // The link still answers: what was sent, from the journal.
    const after = await (await get(hub, "/p/TST/alpha")).text();
    assertStringIncludes(after, "Rename the first one — pushed");
    assertStringIncludes(after, "One, edited");

    // ...and the inbox still knows where it went.
    const inbox = await (await get(hub, "/")).text();
    assertStringIncludes(inbox, "Pushed in the last week");
    assertStringIncludes(inbox.slice(inbox.indexOf("Pushed in the last week")), "Rename the first one");

    // The decision cannot be replayed.
    assertEquals((await decide(hub, "TST", "alpha", opened.token, "approve")).status, 409);
  });
});

Deno.test("requesting changes saves comments on the proposal and sends nothing", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    const hub = createHub();
    await submit(ws, "alpha", { "TST-1": "One, edited", "TST-2": "Two, edited" });
    const opened = await open(hub, "TST", "alpha");

    const empty = await decide(hub, "TST", "alpha", opened.token!, "request-changes");
    assertEquals(empty.status, 400, "asking for changes needs a comment");
    const both = await decide(hub, "TST", "alpha", opened.token!, "approve", [{ body: "hmm" }]);
    assertEquals(both.status, 400, "a comment is not an approval");

    const comments = [{ body: "Split this into two proposals" }, { on: "TST-2", body: "Keep the old name" }];
    const done = await decide(hub, "TST", "alpha", opened.token!, "request-changes", comments);
    assertEquals(done.status, 200, JSON.stringify(done.body));
    assertEquals(done.body.status, "changes-requested");
    assertEquals(ws.mock.issues.get("TST-1")!.summary, "One");

    const view = proposalView(ws.store("alpha"));
    assertEquals(view.status, "changes-requested");
    assertEquals(view.meta!.review!.comments, comments);
    assertEquals(view.meta!.submittedAt, undefined);
    assertEquals(view.staged, ["TST-1", "TST-2"], "the staged work is untouched");

    // The page shows the comments where they were made, and offers no decision.
    const page = await (await get(hub, "/p/TST/alpha")).text();
    assertStringIncludes(page, "changes requested");
    assertStringIncludes(page, "Split this into two proposals");
    assertStringIncludes(page, "Keep the old name");
    assert(!page.includes("csrf:"), "nothing to check against Jira until it is resubmitted");

    // A tab left open from before the decision can no longer approve.
    assertEquals((await decide(hub, "TST", "alpha", opened.token!, "approve")).status, 409);
  });
});

Deno.test("opening a proposal absorbs an edit made in Jira to a field it leaves alone", async () => {
  await withWorkspace(["One"], async (ws) => {
    const hub = createHub();
    await submit(ws, "alpha", { "TST-1": "One, edited" });

    ws.mock.issues.get("TST-1")!.labels = ["urgent"];
    ws.mock.touch("TST-1");

    const opened = await open(hub, "TST", "alpha");
    assert(opened.page && opened.token, JSON.stringify(opened.refresh));
    assertStringIncludes(opened.page, "Jira changed underneath this proposal");
    assertStringIncludes(opened.page, "labels (TST-1)");
    const store = ws.store("alpha");
    assertEquals(store.readBase("TST-1")!.ticket.labels, ["urgent"]);
    assertEquals(store.readCommitted("TST-1")!.ticket.labels, ["urgent"]);
    assertEquals(store.readCommitted("TST-1")!.ticket.summary, "One, edited");

    const done = await decide(hub, "TST", "alpha", opened.token, "approve");
    assertEquals(done.body.status, "pushed", JSON.stringify(done.body));
    assertEquals(ws.mock.issues.get("TST-1")!.summary, "One, edited");
    assertEquals(ws.mock.issues.get("TST-1")!.labels, ["urgent"], "the remote edit survives the push");
  });
});

Deno.test("a colleague's edit in Jira is not shown as the proposal changing since your review", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    const hub = createHub();
    await submit(ws, "alpha", { "TST-1": "One, edited", "TST-2": "Two, edited" });
    let opened = await open(hub, "TST", "alpha");
    await decide(hub, "TST", "alpha", opened.token!, "request-changes", [{ on: "TST-2", body: "not this one" }]);

    // The agent answers the comment on TST-2 and resubmits; meanwhile somebody labels TST-1 in Jira.
    await ws.as("alpha", () => {
      const store = ws.store("alpha");
      store.writeWorking("TST-2", { ...store.readWorking("TST-2")!.ticket, summary: "Two, edited differently" });
      cmdCommit(["TST-2"]);
      store.writeMeta({ title: "A proposal", description: "", submittedAt: new Date().toISOString() });
    });
    ws.mock.issues.get("TST-1")!.labels = ["from-a-colleague"];
    ws.mock.touch("TST-1");

    opened = await open(hub, "TST", "alpha");
    const page = opened.page!;
    assert(page, JSON.stringify(opened.refresh));
    // The rebase is reported as what it is...
    assertStringIncludes(page, "Jira changed underneath this proposal");
    // ...TST-1, which the author never touched again, stays collapsed as already reviewed...
    const card1 = page.slice(page.indexOf('id="t-TST-1"'), page.indexOf('id="t-TST-2"'));
    assertStringIncludes(page.slice(page.indexOf('id="t-TST-1"') - 60, page.indexOf('id="t-TST-1"')), "collapsed");
    assertStringIncludes(card1, "unchanged since your last review");
    // ...and only the author's change is listed as new since the review.
    const since = page.slice(page.indexOf('id="since-review"'), page.indexOf('id="commit-'));
    assertStringIncludes(since, "Two, edited differently");
    assert(!since.includes("from-a-colleague"), "the colleague's label is not the proposal's change");
    assert(!since.includes("TST-1"), since);
  });
});

Deno.test("an edit in Jira to the same field blocks the proposal until its agent acts", async () => {
  await withWorkspace(["One"], async (ws) => {
    const hub = createHub();
    await submit(ws, "alpha", { "TST-1": "One, edited" });

    ws.mock.issues.get("TST-1")!.summary = "One, renamed by a colleague";
    ws.mock.touch("TST-1");

    const opened = await open(hub, "TST", "alpha");
    assertEquals(opened.page, undefined);
    assertEquals(opened.refresh!.body, { reload: true });
    const view = proposalView(ws.store("alpha"));
    assertEquals(view.status, "blocked");
    assertStringIncludes(view.meta!.blocked!.reason, "TST-1: Jira changed summary");
    assertStringIncludes(view.meta!.blocked!.reason, "jt resolve TST-1");

    // Reloaded, the page says so, checks again, and learns nothing new: no reload loop.
    const again = await open(hub, "TST", "alpha");
    assertStringIncludes(again.local, "needs its agent");
    assertStringIncludes(again.local, "Jira changed summary");
    assertEquals(again.refresh!.body, { same: true });
    assertEquals(ws.mock.issues.get("TST-1")!.summary, "One, renamed by a colleague");
  });
});

Deno.test("a staged ticket deleted in Jira blocks the proposal instead of failing mid-push", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    const hub = createHub();
    await submit(ws, "alpha", { "TST-1": "One, edited", "TST-2": "Two, edited" });
    ws.mock.issues.delete("TST-2");

    const opened = await open(hub, "TST", "alpha");
    assertEquals(opened.page, undefined);
    const view = proposalView(ws.store("alpha"));
    assertEquals(view.status, "blocked");
    assertStringIncludes(view.meta!.blocked!.reason, "TST-2 no longer exists in Jira");
    assertEquals(ws.mock.issues.get("TST-1")!.summary, "One", "nothing was sent");
  });
});

Deno.test("approval sends only what the page showed: anything that moved reloads instead", async () => {
  await withWorkspace(["One"], async (ws) => {
    const hub = createHub();
    await submit(ws, "alpha", { "TST-1": "One, edited" });

    // Jira moves between rendering and approving.
    let opened = await open(hub, "TST", "alpha");
    ws.mock.issues.get("TST-1")!.labels = ["late"];
    ws.mock.touch("TST-1");
    let done = await decide(hub, "TST", "alpha", opened.token!, "approve");
    assertEquals(done.status, 409);
    assertEquals(done.body.reload, true);
    assertEquals(ws.mock.issues.get("TST-1")!.summary, "One");
    assertEquals(proposalView(ws.store("alpha")).status, "in-review", "still in review, just not as rendered");

    // The staged work changes underneath the rendered page without anyone saying so.
    await new Promise((r) => setTimeout(r, 5));
    opened = await open(hub, "TST", "alpha");
    assert(opened.token, JSON.stringify(opened.refresh));
    const store = ws.store("alpha");
    const committed = store.readCommitted("TST-1")!;
    store.writeCommitted("TST-1", committed.bytes.replace("One, edited", "One, tampered"));
    done = await decide(hub, "TST", "alpha", opened.token, "approve");
    assertEquals(done.status, 409);
    assertEquals(ws.mock.issues.get("TST-1")!.summary, "One", "what was not shown is not sent");
  });
});

Deno.test("work staged after submitting is not reviewable until it is submitted again", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    const hub = createHub();
    await submit(ws, "alpha", { "TST-1": "One, edited" });
    const opened = await open(hub, "TST", "alpha");

    await ws.as("alpha", () => {
      const store = ws.store("alpha");
      store.writeWorking("TST-2", { ...store.readWorking("TST-2")!.ticket, summary: "Two, edited" });
      cmdCommit(["TST-2"]);
    });
    assert(ws.logs.some((l) => l.includes("not part of that review until you run jt push -p alpha again")));

    assertEquals((await decide(hub, "TST", "alpha", opened.token!, "approve")).status, 409);
    const page = await open(hub, "TST", "alpha");
    assertStringIncludes(page.local, "being revised");
    assertStringIncludes(page.local, "Two, edited");
    assertEquals(page.refresh, undefined, "a proposal being revised is not checked or decided");
    assertEquals(ws.mock.issues.get("TST-1")!.summary, "One");
  });
});

Deno.test("only a page this server rendered can refresh or decide", async () => {
  await withWorkspace(["One"], async (ws) => {
    const hub = createHub();
    await submit(ws, "alpha", { "TST-1": "One, edited" });
    const opened = await open(hub, "TST", "alpha");
    const body = { decision: "approve", comments: [], token: opened.token };
    const path = "/p/TST/alpha/decide";

    const cases: [string, Record<string, string | null>][] = [
      ["another site's origin", { origin: "https://evil.example" }],
      ["no origin", { origin: null }],
      ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
      ["no fetch metadata (not a browser page)", { "sec-fetch-site": null }],
      ["a form post", { "content-type": "application/x-www-form-urlencoded" }],
      ["a text/plain post", { "content-type": "text/plain" }],
    ];
    for (const [what, headers] of cases) {
      const res = await post(hub, path, body, headers);
      assertEquals(res.status, 403, what);
      await res.body?.cancel();
    }
    const refresh = await post(hub, "/p/TST/alpha/refresh", { csrf: "guess", tag: "" });
    assertEquals(refresh.status, 409, "a refresh needs the secret a rendered page carries");
    await refresh.body?.cancel();
    assertEquals((await decide(hub, "TST", "alpha", "not-a-token", "approve")).status, 409);

    // A hostname of someone else's that resolves to this machine gets nothing.
    const rebound = await get(hub, "/p/TST/alpha", "http://attacker.example:5472");
    assertEquals(rebound.status, 404);
    await rebound.body?.cancel();

    // A proposal name that is not a name never reaches the filesystem.
    assertEquals((await get(hub, "/p/TST/..%2F..%2Fetc")).status, 404);
    assertEquals((await get(hub, "/p/NOPE/alpha")).status, 404);
    assertEquals((await get(hub, "/p/TST/never-existed")).status, 404);

    assertEquals(ws.mock.issues.get("TST-1")!.summary, "One", "none of that sent anything");
    // The real page still can.
    assertEquals((await decide(hub, "TST", "alpha", opened.token!, "approve")).body.status, "pushed");
  });
});

Deno.test("a script in a description that came from Jira does not run on the review page", async () => {
  await withWorkspace(["One"], async (ws) => {
    const hub = createHub();
    // The description reaches the page from the base layer, which commit never
    // validates: an archive card shows the ticket as Jira has it.
    const store = ws.store("alpha");
    const base = store.readBase("TST-1")!;
    base.ticket.description = "hello <script>alert('x')</script> <img src=x onerror=alert(1)>";
    store.writeBase(base);
    await ws.as("alpha", () => {
      cmdArchive(["TST-1"]);
      cmdCommit(["TST-1"]);
      store.writeMeta({ title: "Archive it", description: "<script>alert(2)</script>", submittedAt: new Date().toISOString() });
    });
    registerWorkspace(ws.dir, "TST");

    const opened = await open(hub, "TST", "alpha");
    for (const html of [opened.local, opened.page!]) {
      assert(html, JSON.stringify(opened.refresh));
      const scripts = html.match(/<script[^>]*>/g) ?? [];
      assertEquals(scripts.length, 1, "only the page's own script");
      assert(/^<script nonce="[^"]+">$/.test(scripts[0] ?? ""));
      assert(!html.includes("<img"), "no image tag from the description");
      assertStringIncludes(html, "&lt;script&gt;alert(2)&lt;/script&gt;");
    }
  });
});

Deno.test("the inbox lists every workspace's proposals, by whose move it is", async () => {
  await withWorkspace(["One", "Two"], async (ws) => {
    const hub = createHub();
    await submit(ws, "alpha", { "TST-1": "One, edited" }, "Waiting for the reviewer");
    await submit(ws, "beta", { "TST-2": "Two, edited" }, "Sent back");
    const opened = await open(hub, "TST", "beta");
    await decide(hub, "TST", "beta", opened.token!, "request-changes", [{ body: "no" }]);

    // A second workspace for the same project gets its own name in the URL.
    const other = Deno.makeTempDirSync({ prefix: "jt-ws2-" });
    Deno.mkdirSync(`${other}/.jira`);
    Deno.copyFileSync(`${ws.dir}/.jira/config.json`, `${other}/.jira/config.json`);
    assertEquals(registerWorkspace(other, "TST"), "TST-2");
    // And one that has since been deleted is reported, not fatal.
    const gone = Deno.makeTempDirSync({ prefix: "jt-ws3-" });
    registerWorkspace(gone, "OLD");
    Deno.removeSync(gone, { recursive: true });

    const res = await get(hub, "/");
    const html = await res.text();
    assertEquals(res.status, 200);
    const [yours, agents] = html.split("With the agent");
    assertStringIncludes(yours, "Waiting for the reviewer");
    assertStringIncludes(yours, 'href="/p/TST/alpha"');
    assertStringIncludes(agents, "Sent back");
    assertStringIncludes(agents, "1 comment waiting");
    assertStringIncludes(html, "Could not read workspace OLD");
  });
});

Deno.test("the server names itself, so jt can tell it from a stranger on the port", async () => {
  const hub = createHub({ version: "9.9.9" });
  const res = await get(hub, "/health");
  assertEquals(await res.json(), { name: "jt-review", version: "9.9.9", pid: Deno.pid });
  assertEquals(hub.busy(), false);
});
