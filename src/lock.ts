/**
 * One writer at a time per workspace.
 *
 * A workspace is written by more than one process: agents running jt commands, and the
 * review server, which rebases a proposal when its page is opened and settles every
 * layer after an approved push — at whatever moment the human gets to it. Settling
 * reads the committed and working copies back after the push has gone out, so a
 * `jt commit` landing in that window would be taken for the state that was just sent
 * and discarded. The lock makes each of them wait for the other instead.
 *
 * It is an advisory lock on .jira/lock, held for the length of one command or one
 * server action and released by the OS if the holder dies. It guards the tool-owned
 * layers; a ticket file open in an editor is outside it, as it always was.
 */
import { join } from "@std/path";
import { fail } from "./errors.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LockOptions {
  /** How long to wait for the current holder before giving up. */
  timeoutMs?: number;
}

export async function withWorkspaceLock<T>(
  root: string,
  fn: () => T | Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(join(root, ".jira", "lock"), { create: true, write: true });
  } catch {
    // No .jira to hold a lock in: not a workspace yet, so nothing to guard.
    return await fn();
  }
  try {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    while (!(await file.tryLock(true))) {
      if (Date.now() >= deadline) {
        fail(
          "this workspace is busy — another jt command, or a push the user just approved, " +
            "has been running for a while. Nothing was changed; run the command again.",
        );
      }
      await sleep(40);
    }
    try {
      return await fn();
    } finally {
      await file.unlock();
    }
  } finally {
    file.close();
  }
}
