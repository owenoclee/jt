import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../src/errors.ts";
import { writeFileAtomic } from "../src/fsutil.ts";
import { withWorkspaceLock } from "../src/lock.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function workspace(): string {
  const root = Deno.makeTempDirSync({ prefix: "jt-lock-" });
  Deno.mkdirSync(join(root, ".jira"));
  return root;
}

Deno.test("the workspace lock makes a second holder wait for the first", async () => {
  const root = workspace();
  const order: string[] = [];
  const first = withWorkspaceLock(root, async () => {
    order.push("first in");
    await sleep(150);
    order.push("first out");
  });
  await sleep(20); // let the first one take the lock
  const second = withWorkspaceLock(root, () => {
    order.push("second in");
  });
  await Promise.all([first, second]);
  assertEquals(order, ["first in", "first out", "second in"]);
});

Deno.test("the lock is released when its holder throws", async () => {
  const root = workspace();
  await assertRejects(() =>
    withWorkspaceLock(root, () => {
      throw new Error("boom");
    })
  );
  assertEquals(await withWorkspaceLock(root, () => "free"), "free");
});

Deno.test("waiting on a held lock gives up with a message, having changed nothing", async () => {
  const root = workspace();
  let ran = false;
  const holder = withWorkspaceLock(root, () => sleep(300));
  await sleep(20);
  const err = await assertRejects(
    () => withWorkspaceLock(root, () => void (ran = true), { timeoutMs: 80 }),
    UserError,
  );
  assert(err.message.includes("busy"), err.message);
  assertEquals(ran, false);
  await holder;
});

Deno.test("a directory that is not a workspace is not locked", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "jt-nolock-" });
  assertEquals(await withWorkspaceLock(dir, () => 7), 7);
});

Deno.test("an atomic write replaces the file and leaves no temp file behind", () => {
  const dir = Deno.makeTempDirSync({ prefix: "jt-atomic-" });
  const path = join(dir, "state.json");
  writeFileAtomic(path, "one");
  writeFileAtomic(path, "two");
  assertEquals(Deno.readTextFileSync(path), "two");
  assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["state.json"]);
});
