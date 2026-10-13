/**
 * Auto-allow: changes the user's own settings let through without a review. A changeset
 * made entirely of them is sent by jt push itself; mixed with anything else, the whole
 * changeset still waits for the human, with the auto-allowed part greyed out.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { classifyChangeset } from "../src/autoallow.ts";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdConfigShow } from "../src/commands/init.ts";
import { cmdArchive, cmdRm } from "../src/commands/local.ts";
import { cmdPush } from "../src/commands/push.ts";
import { cmdAwait } from "../src/commands/push_detach.ts";
import { UserError } from "../src/errors.ts";
import { readPending } from "../src/review/handoff.ts";
import { buildTicketPlans } from "../src/review/plan.ts";
import { parseSettings } from "../src/settings.ts";
import type { CompiledOp, Ticket } from "../src/types.ts";
import { makeBaseEntry, makeTicket, tempStore } from "./helpers.ts";
import { errorOf, withWorkspace } from "./workspace.ts";

const rules = (autoAllow: unknown[]) => parseSettings({ autoAllow }, "settings.json").autoAllow;

Deno.test("settings: rules are validated, normalized, and never include deletion", () => {
  assertEquals(rules(["assignee", "comments", "transition", "fields.Story Points"]), [
    { action: "assignee" },
    { action: "comment" },
    { action: "status" },
    { action: "fields.Story Points" },
  ]);
  assertEquals(rules([{ action: "status", to: ["In Progress"], project: "eng" }]), [
    { action: "status", project: "ENG", to: ["In Progress"] },
  ]);
  assertThrows(() => rules(["asignee"]), UserError, "unknown action 'asignee'");
  assertThrows(() => rules(["delete"]), UserError, "can never be auto-allowed");
  assertThrows(() => rules([{ action: "assignee", to: ["x"] }]), UserError, "only applies to the status");
  assertThrows(() => parseSettings({ autoAlow: [] }, "settings.json"), UserError, "invalid settings");
  assertEquals(parseSettings({}, "settings.json"), { autoAllow: [], updateCheck: true });
});

/** A store holding one existing ticket with `edit` committed on top of it. */
function staged(edit: Partial<Ticket>, base: Partial<Ticket> = {}) {
  const store = tempStore();
  const t = makeTicket({ key: "TST-1", summary: "One", ...base });
  store.writeBase(makeBaseEntry(t));
  store.writeWorking("TST-1", { ...t, ...edit });
  store.writeCommitted("TST-1", store.readWorking("TST-1")!.bytes);
  const op: CompiledOp = { label: "update TST-1", kind: "update", issue: "TST-1", method: "PUT", path: "/x" };
  return { store, plans: buildTicketPlans(store, [op]) };
}

Deno.test("classification: per change, in the diff's own field names", () => {
  const { store, plans } = staged({
    assignee: "a@example.com",
    status: "In Progress",
    summary: "One, renamed",
    comments: [{ body: "note" }],
  });
  const verdict = classifyChangeset(store, plans, rules(["assignee", "status", "comment"]));
  assertEquals(verdict.tickets["TST-1"], { auto: ["status", "assignee", "comments"], all: false });
  assertEquals(verdict.allAuto, false, "the summary edit still needs a human");
  assertEquals(verdict.rules, ["assignee", "status", "comment"]);

  // Without the summary edit the whole changeset is covered.
  const covered = staged({ assignee: "a@example.com", status: "In Progress" });
  assert(classifyChangeset(covered.store, covered.plans, rules(["assignee", "status"])).allAuto);
  // No rules, no auto-allow — the default.
  assertEquals(classifyChangeset(covered.store, covered.plans, []).allAuto, false);
});

Deno.test("classification: rules can be scoped by project and by target status", () => {
  const done = staged({ status: "Done" });
  const toProgress = rules([{ action: "status", to: ["In Progress"] }]);
  assertEquals(classifyChangeset(done.store, done.plans, toProgress).allAuto, false);
  const progress = staged({ status: "in progress" });
  assert(classifyChangeset(progress.store, progress.plans, toProgress).allAuto);

  const otherProject = rules([{ action: "status", project: "ENG" }]);
  assertEquals(classifyChangeset(done.store, done.plans, otherProject).allAuto, false);
  assert(classifyChangeset(done.store, done.plans, rules([{ action: "status", project: "tst" }])).allAuto);
});

Deno.test("classification: replacing a lossy description always gets a human look", () => {
  const lossy = staged({ description: "rewritten" }, { description: "old", descriptionLossy: true });
  assertEquals(classifyChangeset(lossy.store, lossy.plans, rules(["description"])).allAuto, false);
  const clean = staged({ description: "rewritten" }, { description: "old" });
  assert(classifyChangeset(clean.store, clean.plans, rules(["description"])).allAuto);
});

Deno.test({
  name: "push: a fully auto-allowed changeset is sent at once; a mixed one is reviewed whole",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    await withWorkspace(["First", "Second"], async (ws) => {
      const store = ws.store();
      const edit = (key: string, patch: Partial<Ticket>) =>
        store.writeWorking(key, { ...store.readWorking(key)!.ticket, ...patch });

      await t.step("with no settings file every push is reviewed, as before", async () => {
        edit("TST-1", { status: "In Progress" });
        cmdCommit([]);
        await cmdPush([]);
        assert(readPending(store.proposalDir), "a status change needs review until the user says otherwise");
        await ws.decide(null, "request-changes");
        await errorOfExit(() => cmdAwait([]));
        assertEquals(ws.mock.issues.get("TST-1")!.status, "To Do");
      });

      await t.step("the user allows status + comment: push sends them with no page", async () => {
        ws.writeSettings({ autoAllow: ["status", "comment"] });
        edit("TST-1", { status: "In Progress", comments: [{ body: "picking this up" }] });
        cmdCommit([]);
        ws.logs.length = 0;
        await cmdPush([]);
        const out = ws.logs.join("\n");
        assertStringIncludes(out, "auto-allowed");
        assertStringIncludes(out, "status, comment");
        assertStringIncludes(out, "nothing to await");
        assert(!out.includes("review page:"), "no review page for a fully auto-allowed push");
        assertEquals(readPending(store.proposalDir), null);
        assertEquals(ws.mock.issues.get("TST-1")!.status, "In Progress");
        assertEquals(ws.mock.issues.get("TST-1")!.comments.length, 1);
        assertEquals(store.listCommittedIds(), [], "the changeset drained");
        assertStringIncludes(await errorOf(() => cmdAwait([])), "nothing to await");

        const entry = store.listJournal()[0].entry;
        assertEquals(entry.review, undefined, "nobody decided this one");
        assertEquals(entry.autoApproved?.rules, ["status", "comment"]);
        assertEquals(entry.changes?.[0].auto, ["status", "comments"]);
        assertEquals(entry.changes?.[0].applied, "all");
      });

      await t.step("mixed with an unallowed change, the whole changeset waits — greyed, not sent", async () => {
        edit("TST-1", { status: "Done", summary: "First, renamed" });
        edit("TST-2", { status: "In Progress" });
        cmdCommit([]);
        ws.logs.length = 0;
        await cmdPush([]);
        assertStringIncludes(ws.logs.join("\n"), "review page:");
        assertEquals(ws.mock.issues.get("TST-2")!.status, "To Do", "nothing is sent ahead of the review");

        const html = await ws.page(null);
        assertStringIncludes(html, "auto-allowed based on your configuration");
        // TST-1 mixes both: its status row is greyed at the bottom of the card.
        const card1 = html.slice(html.indexOf('id="t-TST-1"'), html.indexOf('id="t-TST-2"'));
        assert(card1.indexOf("First, renamed") < card1.indexOf('class="auto-rows"'), "auto rows come last");
        assertStringIncludes(card1.slice(card1.indexOf('class="auto-rows"')), "Done");
        // TST-2 is wholly auto-allowed: its card is greyed and sorted after TST-1.
        assertStringIncludes(html, 'class="ticket auto-allowed" id="t-TST-2"');
        assert(html.indexOf('id="t-TST-1"') < html.indexOf('id="t-TST-2"'));
        assertStringIncludes(html, "Approve &amp; push all 2");

        await ws.decide(null, "approve");
        await cmdAwait([]);
        assertEquals(ws.mock.issues.get("TST-1")!.summary, "First, renamed");
        assertEquals(ws.mock.issues.get("TST-2")!.status, "In Progress");
        const entry = store.listJournal()[0].entry;
        assert(entry.review, "a human approved this push");
        assertEquals(entry.autoApproved, undefined);
        assertEquals(entry.changes?.map((c) => [c.id, c.auto]), [
          ["TST-1", ["status"]],
          ["TST-2", ["status"]],
        ]);
      });

      await t.step("deletion is never auto-allowed; archiving only when named", async () => {
        ws.writeSettings({ autoAllow: ["status", "comment", "archive"] });
        cmdRm(["TST-2"]);
        cmdCommit([]);
        await cmdPush([]);
        assert(readPending(store.proposalDir), "a deletion always goes to review");
        assert(ws.mock.issues.has("TST-2"));
        await ws.decide(null, "request-changes");
        await errorOfExit(() => cmdAwait([]));

        cmdArchive(["TST-2"]); // replaces the deletion intent
        cmdCommit([]);
        await cmdPush([]);
        assertEquals(readPending(store.proposalDir), null);
        assert(ws.mock.issues.get("TST-2")!.archived, "archiving was auto-allowed");
      });

      await t.step("a broken settings file stops the push instead of guessing", async () => {
        ws.writeSettings({ autoAllow: ["everything"] });
        edit("TST-1", { status: "To Do" });
        cmdCommit([]);
        assertStringIncludes(await errorOf(() => cmdPush([])), "unknown action 'everything'");
        assertEquals(ws.mock.issues.get("TST-1")!.status, "Done");
        ws.logs.length = 0;
        cmdConfigShow();
        assertStringIncludes(ws.logs.join("\n"), "auto-allow: INVALID");
      });
    });
  },
});

/**
 * jt await exits the process on a non-zero outcome (2 = changes requested). Stub the
 * exit so the outcome is still collected the way the real command collects it.
 */
async function errorOfExit(fn: () => Promise<void>): Promise<number> {
  const realExit = Deno.exit;
  let code = 0;
  Deno.exit = ((c?: number) => {
    code = c ?? 0;
    throw new Error(`exit ${code}`);
  }) as typeof Deno.exit;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("exit ")) throw e;
  } finally {
    Deno.exit = realExit;
  }
  return code;
}
