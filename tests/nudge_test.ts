/**
 * The push handoff is restated in-band by the command that creates it: jt push's own
 * output names both steps still owed, so the obligation is the freshest thing in an
 * agent's context rather than a contract read long ago. (detach_test.ts asserts the
 * notice reaches real push output; this pins its content.)
 */
import { assertStringIncludes } from "@std/assert";
import { openerCommand, pushHandoffNotice } from "../src/review/nudge.ts";

Deno.test("jt push's notice names both remaining steps", () => {
  const url = "http://127.0.0.1:9999/review/abc";
  const notice = pushHandoffNotice(url);
  assertStringIncludes(notice, "NOT DONE");
  assertStringIncludes(notice, openerCommand(url)); // a command to run, not a URL to paste
  assertStringIncludes(notice, "jt await");
});
