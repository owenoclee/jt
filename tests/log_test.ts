/**
 * jt log — the audit trail: every push, how it was approved, and what it changed on
 * each ticket, filterable by time and ticket, in the terminal or as a page.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdLog, parseSince } from "../src/commands/log.ts";
import { cmdPush } from "../src/commands/push.ts";
import { cmdAwait } from "../src/commands/push_detach.ts";
import { UserError } from "../src/errors.ts";
import { renderJournalEntry } from "../src/render/render.ts";
import type { JournalEntry } from "../src/types.ts";
import { withWorkspace } from "./workspace.ts";

Deno.test("--since takes an age or a date", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  assertEquals(parseSince("3d", now).toISOString(), "2026-10-10T12:00:00.000Z");
  assertEquals(parseSince("90m", now).toISOString(), "2026-10-13T10:30:00.000Z");
  assertEquals(parseSince("2w", now).toISOString(), "2026-09-29T12:00:00.000Z");
  const day = parseSince("2026-10-01", now);
  assertEquals([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()], [2026, 9, 1, 0]);
  assertThrows(() => parseSince("yesterday-ish", now), UserError, "not an age");
});

Deno.test("a journal entry renders what changed, how it was approved, and from which proposal", () => {
  const entry: JournalEntry = {
    startedAt: "2026-10-13T09:00:00.000Z",
    result: "success",
    proposal: "auth",
    autoApproved: { settings: "/home/u/.config/jt/settings.json", rules: ["status"] },
    changes: [
      {
        id: "TST-1",
        summary: "Login",
        kind: "update",
        entries: [{ field: "status", kind: "scalar", from: "To Do", to: "Done" }],
        auto: ["status"],
        applied: "all",
      },
      { id: "@epic", key: "TST-9", summary: "The epic", kind: "create", applied: "all" },
      { id: "TST-2", summary: "Old", kind: "archive", auto: ["*"], applied: "none" },
    ],
    ops: [{ label: "transition TST-1", method: "POST", path: "/x", ok: true, status: 200 }],
  };
  const out = renderJournalEntry("journal/x.json", entry);
  assertStringIncludes(out, "[proposal auth]");
  assertStringIncludes(out, "sent without review under your settings: status");
  assertStringIncludes(out, 'status: "To Do" → "Done"');
  assertStringIncludes(out, "(auto-allowed: status)");
  assertStringIncludes(out, "TST-9 (@epic)");
  assertStringIncludes(out, "not applied"); // the archiving that never landed is not hidden
});

Deno.test({
  name: "jt log: reviewed and auto-allowed pushes, filtered by ticket and by day",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withWorkspace(["First", "Second"], async (ws) => {
      const store = ws.store();
      const edit = (key: string, patch: Record<string, unknown>) =>
        store.writeWorking(key, { ...store.readWorking(key)!.ticket, ...patch });

      // One push decided by a human...
      edit("TST-1", { summary: "First, renamed", description: "line one\nline two" });
      cmdCommit([]);
      await cmdPush([]);
      await ws.decide(null, "approve");
      await cmdAwait([]);
      // ...and one the settings let through.
      ws.writeSettings({ autoAllow: ["status"] });
      edit("TST-2", { status: "Done" });
      cmdCommit([]);
      await cmdPush([]);

      ws.logs.length = 0;
      cmdLog([]);
      const all = ws.logs.join("\n");
      assertStringIncludes(all, "approved in the browser");
      assertStringIncludes(all, "sent without review under your settings: status");
      assertStringIncludes(all, 'summary: "First" → "First, renamed"');
      assertStringIncludes(all, "description: +2"); // line counts only, until --full
      assertStringIncludes(all, 'status: "To Do" → "Done"');
      assert(all.indexOf("TST-2") < all.indexOf("TST-1"), "newest push first");

      ws.logs.length = 0;
      cmdLog(["--full", "tst-1"]);
      const one = ws.logs.join("\n");
      assertStringIncludes(one, "+ line one");
      assert(!one.includes("TST-2"), "the ticket filter drops pushes that did not touch it");

      ws.logs.length = 0;
      cmdLog(["--today"]);
      assertStringIncludes(ws.logs.join("\n"), "TST-2");
      ws.logs.length = 0;
      cmdLog(["--since", "2999-01-01"]);
      assertStringIncludes(ws.logs.join("\n"), "no pushes since 2999-01-01");

      ws.logs.length = 0;
      cmdLog(["--web", "--today"]);
      const path = ws.logs.join("\n").match(/history page: (.+\.html)/)![1];
      const html = Deno.readTextFileSync(path);
      assertStringIncludes(html, "jt history — today");
      assertStringIncludes(html, "2 pushes, 1 sent without review");
      assertStringIncludes(html, "reviewed · approved");
      assertStringIncludes(html, "auto-allowed · status");
      assertStringIncludes(html, "First, renamed");
      assertStringIncludes(html, `${ws.mock.baseUrl}/browse/TST-2`);
    });
  },
});
