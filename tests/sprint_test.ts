/**
 * Sprints meta does not know: meta lists only the configured board's active and
 * future sprints, but a ticket can sit in a sprint from another board, or one
 * started since the last `jt meta sync`. That must not block editing anything else.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cmdCommit } from "../src/commands/commit.ts";
import { cmdFetch } from "../src/commands/fetch.ts";
import { cmdPush } from "../src/commands/push.ts";
import { cmdAwait } from "../src/commands/push_detach.ts";
import { errorOf, withWorkspace } from "./workspace.ts";

Deno.test({
  name: "a ticket in a sprint meta does not know can still have other fields changed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withWorkspace(["Old task", "Epic"], async (ws) => {
      ws.mock.issues.get("TST-1")!.sprintId = 7; // meta knows only Sprint 42
      await cmdFetch(["TST-1"]);
      const store = ws.store();
      const ticket = store.readWorking("TST-1")!.ticket;
      assertEquals(ticket.sprint, "Sprint 7");

      store.writeWorking("TST-1", { ...ticket, parent: "TST-2" });
      cmdCommit([]);
      await cmdPush([]);
      await ws.decide(null, "approve");
      await cmdAwait([]);

      const remote = ws.mock.issues.get("TST-1")!;
      assertEquals(remote.parent, "TST-2");
      assertEquals(remote.sprintId, 7); // untouched: never sent
    });
  },
});

Deno.test({
  name: "moving a ticket to a sprint meta does not know is still refused at commit",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withWorkspace(["Task"], async (ws) => {
      const store = ws.store();
      store.writeWorking("TST-1", { ...store.readWorking("TST-1")!.ticket, sprint: "Sprint 99" });
      assertStringIncludes(await errorOf(() => cmdCommit([])), "unknown sprint 'Sprint 99'");
    });
  },
});
