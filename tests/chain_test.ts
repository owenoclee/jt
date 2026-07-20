import { assert, assertEquals } from "@std/assert";
import { serializeTicket } from "../src/canonical.ts";
import {
  appendChainEntry,
  pruneChain,
  readChain,
  readReviewMarker,
  snapshotEqual,
  stateAtSeq,
  writeReviewMarker,
} from "../src/chain.ts";
import { makeTicket, tempStore } from "./helpers.ts";

Deno.test("chain: append, stateAtSeq, prune, reset", () => {
  const store = tempStore();
  const t1 = makeTicket({ key: "TST-1", summary: "round 1" });
  const t1v2 = { ...t1, summary: "round 2" };
  const t2 = makeTicket({ key: "TST-2", summary: "other" });

  // Simulate the changeset existing (chain reset checks the committed layer).
  store.writeCommitted("TST-1", serializeTicket(t1));
  store.writeCommitted("TST-2", serializeTicket(t2));

  appendChainEntry(store, "agent", "initial proposal", {
    "TST-1": { kind: "ticket", ticket: t1 },
    "TST-2": { kind: "ticket", ticket: t2 },
  });
  appendChainEntry(store, "agent", "tweak TST-1", {
    "TST-1": { kind: "ticket", ticket: t1v2 },
  });

  const chain = readChain(store);
  assertEquals(chain.entries.length, 2);
  assertEquals(chain.entries[0].seq, 1);
  assertEquals(chain.entries[1].seq, 2);

  // state at seq 1 = round 1; at seq 2 = round 2; TST-2 unchanged across both
  assertEquals(stateAtSeq(chain, "TST-1", 1), { kind: "ticket", ticket: t1 });
  assertEquals(stateAtSeq(chain, "TST-1", 2), { kind: "ticket", ticket: t1v2 });
  assert(snapshotEqual(stateAtSeq(chain, "TST-2", 1), stateAtSeq(chain, "TST-2", 2)));
  assertEquals(stateAtSeq(chain, "TST-99", 2), null);

  writeReviewMarker(store, 1);
  assertEquals(readReviewMarker(store)!.lastReviewedSeq, 1);

  // prune TST-1 (e.g. it was pushed): entry 2 empties out and disappears
  store.removeCommitted("TST-1");
  pruneChain(store, ["TST-1"]);
  const pruned = readChain(store);
  assertEquals(pruned.entries.length, 1);
  assertEquals(Object.keys(pruned.entries[0].tickets), ["TST-2"]);

  // prune TST-2 too: changeset drains, chain and marker reset
  store.removeCommitted("TST-2");
  pruneChain(store, ["TST-2"]);
  assertEquals(readChain(store).entries.length, 0);
  assertEquals(readReviewMarker(store), null);
});

Deno.test("chain: deletion snapshots and empty appends", () => {
  const store = tempStore();
  assertEquals(appendChainEntry(store, "agent", "noop", {}), null);
  store.writeDeletions([{ key: "TST-3", summary: "bye", requestedAt: "now", committed: true }]);
  appendChainEntry(store, "agent", "stage deletion", {
    "TST-3": { kind: "deletion", summary: "bye" },
  });
  const snap = stateAtSeq(readChain(store), "TST-3", 1);
  assertEquals(snap, { kind: "deletion", summary: "bye" });
  assert(snapshotEqual(snap, { kind: "deletion", summary: "bye" }));
  assert(!snapshotEqual(snap, null));
});
