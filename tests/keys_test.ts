import { assertEquals } from "@std/assert";
import { compareTicketIds } from "../src/keys.ts";

Deno.test("compareTicketIds sorts Jira issue numbers numerically", () => {
  const ids = ["TST-600", "OTHER-2", "TST-60", "TST-599", "OTHER-10", "TST-601"];

  assertEquals(ids.sort(compareTicketIds), [
    "OTHER-2",
    "OTHER-10",
    "TST-60",
    "TST-599",
    "TST-600",
    "TST-601",
  ]);
});

Deno.test("compareTicketIds preserves lexical ordering for pending ticket ids", () => {
  assertEquals(["@story", "@epic", "TST-2"].sort(compareTicketIds), [
    "@epic",
    "@story",
    "TST-2",
  ]);
});
