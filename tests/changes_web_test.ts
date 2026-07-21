/**
 * jt changes --web: serves the upstream news as a loopback page; the Acknowledge
 * button advances the seen layer exactly like jt changes --ack. Timeout acks nothing.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { cmdChanges } from "../src/commands/changes.ts";
import { cmdInit } from "../src/commands/init.ts";
import { UserError } from "../src/errors.ts";
import { Store } from "../src/store.ts";
import { makeBaseEntry, makeTicket } from "./helpers.ts";

async function serveAndFetch(
  argv: string[],
  timeoutMs: number,
): Promise<{ html: string; url: string; flow: void | Promise<void> }> {
  let url = "";
  const flow = cmdChanges(argv, { timeoutMs, onServe: (u) => (url = u) });
  while (!url) await new Promise((r) => setTimeout(r, 5));
  const res = await fetch(url);
  return { html: await res.text(), url, flow };
}

async function ack(url: string): Promise<number> {
  const res = await fetch(url.replace("/changes/", "/ack/"), { method: "POST" });
  await res.body?.cancel();
  return res.status;
}

Deno.test("changes --web: glance page, ack via POST advances seen", async (t) => {
  const dir = Deno.makeTempDirSync({ prefix: "jt-changes-web-" });
  const prevCwd = Deno.cwd();
  Deno.chdir(dir);
  let logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const output = () => logs.join("\n");

  try {
    cmdInit([
      "--base-url",
      "https://example.atlassian.net",
      "--email",
      "t@example.com",
      "--project",
      "TST",
    ]);
    const store = new Store(dir);

    // Baseline: TST-1 and TST-2 acked; then churn — TST-1 edited, TST-3 new, TST-2 gone.
    store.writeBase(makeBaseEntry(makeTicket({ key: "TST-1", summary: "One" })));
    store.writeBase(makeBaseEntry(makeTicket({ key: "TST-2", summary: "Two" })));
    store.ackSeen();
    store.writeBase(makeBaseEntry(makeTicket({ key: "TST-1", summary: "One (renamed)", labels: ["hot"] })));
    store.writeBase(makeBaseEntry(makeTicket({ key: "TST-3", summary: "Fresh" })));
    store.removeBase("TST-2");

    await t.step("--ack --web is rejected", () => {
      assertThrows(() => cmdChanges(["--ack", "--web"]), UserError, "mutually exclusive");
    });

    await t.step("page shows the news with the informational identity; ack absorbs", async () => {
      const { html, url, flow } = await serveAndFetch(["--web"], 10_000);
      assertStringIncludes(html, "One (renamed)");
      assertStringIncludes(html, "badge-changed");
      assertStringIncludes(html, "TST-3");
      assertStringIncludes(html, "badge-new");
      assertStringIncludes(html, "badge-gone"); // TST-2
      assertStringIncludes(html, "info-banner");
      assertStringIncludes(html, 'class="info"');
      assertStringIncludes(html, "Acknowledge all 3");

      assertEquals(await ack(url), 200);
      await flow;
      assertEquals(store.readSeen("TST-1")!.ticket.summary, "One (renamed)");
      assert(store.readSeen("TST-3"), "new ticket acked into seen");
      assertEquals(store.readSeen("TST-2"), null, "tombstone cleared");
      assert(logs.some((l) => l.includes("acknowledged — all caught up")));

      logs = [];
      cmdChanges([]);
      assertStringIncludes(output(), "no upstream changes");
    });

    await t.step("filtered --web acks only the filtered keys", async () => {
      store.writeBase(makeBaseEntry(makeTicket({ key: "TST-1", summary: "One v3" })));
      store.writeBase(makeBaseEntry(makeTicket({ key: "TST-3", summary: "Fresh v2" })));

      const { html, url, flow } = await serveAndFetch(["TST-1", "--web"], 10_000);
      assertStringIncludes(html, "One v3");
      assert(!html.includes("Fresh v2"), "filtered-out ticket not on the page");
      assertEquals(await ack(url), 200);
      await flow;

      assertEquals(store.readSeen("TST-1")!.ticket.summary, "One v3");
      assertEquals(store.readSeen("TST-3")!.ticket.summary, "Fresh", "TST-3 not acked");
    });

    await t.step("timeout acks nothing", async () => {
      logs = [];
      const { flow } = await serveAndFetch(["--web"], 300);
      await flow;
      assertEquals(store.readSeen("TST-3")!.ticket.summary, "Fresh");
      assert(logs.some((l) => l.includes("nothing recorded")));
    });

    await t.step("quiet workspace prints the terminal message, no server", () => {
      store.ackSeen();
      logs = [];
      const result = cmdChanges(["--web"]);
      assertEquals(result, undefined);
      assertStringIncludes(output(), "no upstream changes since your last ack");
    });
  } finally {
    console.log = origLog;
    Deno.chdir(prevCwd);
  }
});
