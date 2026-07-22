/**
 * Compact-by-default terminal output (agents pay per token):
 * jt changes folds description edits into ±line counts unless --full,
 * --ack absorbs without reprinting the diffs, jt log folds successful ops,
 * and the web pages carry unchanged-field context rows behind the ⚙ panel.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cmdChanges } from "../src/commands/changes.ts";
import { cmdInit } from "../src/commands/init.ts";
import { renderJournalEntry } from "../src/render/render.ts";
import { renderPage, renderTicketDelta, type ReviewPageModel } from "../src/review/html.ts";
import { Store } from "../src/store.ts";
import type { JournalEntry } from "../src/types.ts";
import { makeBaseEntry, makeTicket } from "./helpers.ts";

Deno.test("jt changes: compact description stat, --full hunks, --ack without reprint", async (t) => {
  const dir = Deno.makeTempDirSync({ prefix: "jt-compact-" });
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
    store.writeBase(makeBaseEntry(makeTicket({
      key: "TST-1",
      summary: "One",
      description: "alpha\nbeta\ngamma",
    })));
    store.ackSeen();
    store.writeBase(makeBaseEntry(makeTicket({
      key: "TST-1",
      summary: "One",
      description: "alpha\nbeta (edited)\ngamma\ndelta",
    })));

    await t.step("default folds the description edit into a ±stat", () => {
      logs = [];
      cmdChanges([]);
      const out = output();
      assertStringIncludes(out, "description: +2 −1 lines");
      assert(!out.includes("beta (edited)"), "no hunk lines by default");
      assertStringIncludes(out, "jt changes --full for description diffs");
    });

    await t.step("--full prints the line diff", () => {
      logs = [];
      cmdChanges(["--full"]);
      const out = output();
      assertStringIncludes(out, "+ beta (edited)");
      assertStringIncludes(out, "- beta");
    });

    await t.step("--ack prints counts only, never the diffs", () => {
      logs = [];
      cmdChanges(["--ack"]);
      const out = output();
      assertStringIncludes(out, "absorbed: 0 new · 1 changed · 0 gone");
      assertStringIncludes(out, "acknowledged — all caught up");
      assert(!out.includes("description"), "ack does not reprint the field diffs");

      logs = [];
      cmdChanges([]);
      assertStringIncludes(output(), "no upstream changes");
    });
  } finally {
    console.log = origLog;
    Deno.chdir(prevCwd);
  }
});

Deno.test("jt log: successful ops fold into a count; --full lists them", () => {
  const entry: JournalEntry = {
    startedAt: "2026-07-22T09:00:00.000Z",
    result: "partial",
    ops: [
      { label: "update TST-1", method: "PUT", path: "/rest/api/3/issue/TST-1", ok: true, status: 200 },
      { label: "comment on TST-1", method: "POST", path: "/rest/api/3/issue/TST-1/comment", ok: true, status: 200 },
      { label: "delete TST-2", method: "DELETE", path: "/rest/api/3/issue/TST-2", ok: false, error: "403 forbidden" },
    ],
  };
  const compact = renderJournalEntry("journal/x.json", entry);
  assertStringIncludes(compact, "2 ops ✓");
  assertStringIncludes(compact, "delete TST-2");
  assertStringIncludes(compact, "403 forbidden");
  assert(!compact.includes("update TST-1"), "successful ops are folded");

  const full = renderJournalEntry("journal/x.json", entry, { full: true });
  assertStringIncludes(full, "update TST-1");
  assertStringIncludes(full, "comment on TST-1");
});

Deno.test("web pages: unchanged-field context rows and the ⚙ panel", async (t) => {
  const from = makeTicket({
    key: "TST-1",
    summary: "One",
    labels: ["api"],
    parent: "TST-100",
    description: "the body",
    fields: { "Story Points": 5 },
  });

  await t.step("update delta interleaves muted context rows for untouched fields", () => {
    const to = { ...from, summary: "One (renamed)" };
    const html = renderTicketDelta(from, to);
    assertStringIncludes(html, 'class="frow chg"');
    assertStringIncludes(html, 'data-ctx-field="labels"');
    assertStringIncludes(html, 'data-ctx-field="parent"');
    assertStringIncludes(html, 'data-ctx-field="Story Points"');
    assertStringIncludes(html, 'data-ctx-field="description"');
    assert(!html.includes('data-ctx-field="summary"'), "changed fields are not context");
  });

  await t.step("changed fields render in place of their context row", () => {
    const to = { ...from, labels: ["api", "hot"] };
    const html = renderTicketDelta(from, to);
    assert(!html.includes('data-ctx-field="labels"'));
    assertStringIncludes(html, 'data-ctx-field="parent"');
  });

  await t.step("field order is identical no matter which fields changed", () => {
    const fieldOrder = (html: string) =>
      [...html.matchAll(/<span class="fname">([^<]+)<\/span>/g)]
        .map((m) => m[1])
        .filter((f) => f !== "summary");
    const summaryChanged = renderTicketDelta(from, { ...from, summary: "x" });
    const labelsChanged = renderTicketDelta(from, { ...from, labels: ["api", "hot"] });
    const sprintChanged = renderTicketDelta(from, { ...from, sprint: "Sprint 43" });
    assertEquals(fieldOrder(labelsChanged), fieldOrder(summaryChanged));
    assertEquals(fieldOrder(sprintChanged), fieldOrder(summaryChanged));
  });

  await t.step("delete delta shows the whole ticket as context", () => {
    const html = renderTicketDelta(from, null);
    assertStringIncludes(html, "delete-card");
    assertStringIncludes(html, 'data-ctx-field="labels"');
  });

  await t.step("the page ships the field cog and its script", () => {
    const model: ReviewPageModel = {
      mode: "readonly",
      title: "t",
      target: { baseUrl: "https://example.atlassian.net", project: "TST" },
      tickets: [{
        id: "TST-1",
        summary: "One",
        kind: "update",
        unchangedSinceReview: false,
        diffHtml: renderTicketDelta(from, { ...from, summary: "x" }),
        opsJson: "",
      }],
      commits: [],
      sinceReview: null,
      nonce: "",
      timeoutMs: 0,
    };
    const html = renderPage(model);
    assertStringIncludes(html, 'id="fieldgear"');
    assertStringIncludes(html, 'id="fieldcfg"');
    assertStringIncludes(html, "jt-ctx-fields");
  });
});
