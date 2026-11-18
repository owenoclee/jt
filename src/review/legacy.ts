/**
 * Reviews left open by jt 0.6 and earlier.
 *
 * Before proposals were reviewed like pull requests, `jt push` spawned a server per
 * review and described it in two files in the proposal's directory:
 *
 *   pending-push.json  the live review URL and the pid serving it
 *   push-result.json   the outcome, kept until `jt await` collected it — exactly once
 *
 * An upgrade can land while such a review is open. Its page still works (the old
 * process serves it), so jt still recognises the files: `jt await` collects the
 * outcome, `jt cancel` withdraws the review, and `jt push` waits for either before
 * submitting the proposal the new way. Nothing writes them any more except tests.
 */
import { join } from "@std/path";
import { pidAlive } from "../process.ts";

export interface PendingPush {
  pid: number;
  url: string;
  startedAt: string;
  /** Stamped the instant the decision POST landed; from then on it cannot be cancelled. */
  decidedAt?: string;
}

export interface PushResultFile {
  finishedAt: string;
  status: "pushed" | "changes-requested" | "stale" | "error" | "cancelled";
  notes: Record<string, string>;
  pushFailure: string | null;
  /** Everything the old server printed while deciding and sending; replayed by jt await. */
  log: string[];
}

export const pendingPath = (dir: string) => join(dir, "pending-push.json");
export const resultPath = (dir: string) => join(dir, "push-result.json");
export const pushLogPath = (dir: string) => join(dir, "last-push.log");

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(Deno.readTextFileSync(path)) as T;
  } catch {
    return null;
  }
}

function remove(path: string): void {
  try {
    Deno.removeSync(path);
  } catch {
    // already gone
  }
}

export const readPending = (dir: string): PendingPush | null => readJson(pendingPath(dir));
export const writePending = (dir: string, p: PendingPush): void =>
  Deno.writeTextFileSync(pendingPath(dir), JSON.stringify(p));
export const clearPending = (dir: string): void => remove(pendingPath(dir));

export const readResult = (dir: string): PushResultFile | null => readJson(resultPath(dir));
export const writeResult = (dir: string, r: PushResultFile): void =>
  Deno.writeTextFileSync(resultPath(dir), JSON.stringify(r));
export const clearResult = (dir: string): void => remove(resultPath(dir));

/** The old review this proposal still has open or uncollected, if any. */
export function legacyReview(dir: string): { url?: string; pending: PendingPush | null } | null {
  const pending = readPending(dir);
  if (pending && pidAlive(pending.pid)) return { url: pending.url, pending };
  if (readResult(dir)) return { pending: null };
  return null;
}

/** The exit code `jt await` gave a collected outcome in jt 0.6. */
export function legacyExitCode(result: PushResultFile): number {
  if (result.status === "changes-requested") return 2;
  if (result.status === "pushed" && !result.pushFailure) return 0;
  return 1;
}
