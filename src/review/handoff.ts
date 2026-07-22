/**
 * Parent ⇄ child handoff for the detached push review flow.
 *
 * `jt push` compiles the changeset, writes a spec file, and spawns `jt _push-serve`,
 * which serves the review page and acts on the human's decision. Three files under
 * `.jira/` carry the whole protocol:
 *
 *   push-spec.json     parent → child: the compiled ops (what the page shows is
 *                      exactly what ships); deleted by the child once loaded
 *   pending-push.json  child → world: the live review URL + pid; deleted when the
 *                      child exits
 *   push-result.json   child → `jt await`: the outcome + captured output; deleted
 *                      when the outcome is collected (exactly once)
 *
 * Ordering invariant: the child writes push-result.json BEFORE removing
 * pending-push.json, so there is no window where the server is gone but its outcome
 * is unrecorded. A pending file whose pid is dead therefore means the child was
 * killed outright — the result file, if any, still reports the last recorded state.
 */
import { join } from "@std/path";
import type { CompiledOp } from "../types.ts";
import type { ReviewOutcome } from "./server.ts";

export interface PushSpec {
  ops: CompiledOp[];
  warnings: string[];
  existingKeys: string[];
  timeoutMs: number;
}

export interface PendingPush {
  pid: number;
  url: string;
  startedAt: string;
  timeoutMs: number;
}

export interface PushResultFile {
  finishedAt: string;
  /** "error" = the server crashed before reaching a decision. */
  status: ReviewOutcome["status"] | "error";
  notes: Record<string, string>;
  pushFailure: string | null;
  /** Everything the child printed while deciding/executing; replayed by jt await. */
  log: string[];
}

export const specPath = (jiraDir: string) => join(jiraDir, "push-spec.json");
export const pendingPath = (jiraDir: string) => join(jiraDir, "pending-push.json");
export const resultPath = (jiraDir: string) => join(jiraDir, "push-result.json");
export const pushLogPath = (jiraDir: string) => join(jiraDir, "last-push.log");

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

export const readSpec = (jiraDir: string): PushSpec | null => readJson(specPath(jiraDir));
export const writeSpec = (jiraDir: string, spec: PushSpec): void =>
  Deno.writeTextFileSync(specPath(jiraDir), JSON.stringify(spec));
export const clearSpec = (jiraDir: string): void => remove(specPath(jiraDir));

export const readPending = (jiraDir: string): PendingPush | null => readJson(pendingPath(jiraDir));
export const writePending = (jiraDir: string, p: PendingPush): void =>
  Deno.writeTextFileSync(pendingPath(jiraDir), JSON.stringify(p));
export const clearPending = (jiraDir: string): void => remove(pendingPath(jiraDir));

export const readResult = (jiraDir: string): PushResultFile | null => readJson(resultPath(jiraDir));
export const writeResult = (jiraDir: string, r: PushResultFile): void =>
  Deno.writeTextFileSync(resultPath(jiraDir), JSON.stringify(r));
export const clearResult = (jiraDir: string): void => remove(resultPath(jiraDir));

/** Is the review server still running? SIGCONT probes liveness without disturbing it. */
export function pidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}
