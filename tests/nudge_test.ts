/**
 * What jt push says once a proposal is submitted is the contract restated at the
 * moment it matters: its reader may hold instructions from before proposals were
 * reviewed like pull requests, when a push meant opening a page and waiting on it.
 * (proposals_test.ts asserts the notice reaches real push output; this pins its content.)
 */
import { assert, assertStringIncludes } from "@std/assert";
import { submittedNotice } from "../src/review/nudge.ts";

Deno.test("jt push's notice: nothing is sent, hand over the link, and stop", () => {
  const notice = submittedNotice("auth-cleanup");
  assertStringIncludes(notice, "nothing has been sent to Jira");
  assertStringIncludes(notice, "give the user the link");
  assertStringIncludes(notice, "you may finish your turn");
  // What an agent with the old contract would do next, named so it does not.
  assertStringIncludes(notice, "Do not open the link");
  assertStringIncludes(notice, "do not wait");
  assertStringIncludes(notice, "jt await -p auth-cleanup"); // only on request, and scoped
  assertStringIncludes(notice, "jt proposals");
  assert(!submittedNotice("default").includes("-p default"), "the default proposal needs no flag");
});
