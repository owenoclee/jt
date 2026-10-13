/**
 * Parent ⇄ child handoff for the detached push review flow.
 *
 * `jt push` compiles the changeset, writes a spec file, and spawns `jt _push-serve`,
 * which serves the review page and acts on the human's decision. Three files in the
 * proposal's directory (`.jira/` for the default proposal, `.jira/proposals/<name>/`
 * for a named one — so each proposal has its own review) carry the whole protocol:
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
 *
 * jt cancel SIGTERMs the child: while undecided it records a "cancelled" result and
 * exits; once a decision has landed (decidedAt on the pending file) it ignores the
 * signal — the decided outcome must settle and be collected.
 */
import { join } from "@std/path";
import type { AutoVerdict } from "../autoallow.ts";
import type { CompiledOp } from "../types.ts";
import type { ReviewOutcome } from "./server.ts";

export interface PushSpec {
  ops: CompiledOp[];
  warnings: string[];
  existingKeys: string[];
  /** What the user's settings auto-allow within this changeset (shown greyed out). */
  verdict?: AutoVerdict;
}

export interface PendingPush {
  pid: number;
  url: string;
  startedAt: string;
  /** Stamped the instant the decision POST lands. From then on jt cancel refuses:
      the decision — possibly the push itself — is already executing. */
  decidedAt?: string;
}

export interface PushResultFile {
  finishedAt: string;
  /** "error" = the server crashed before reaching a decision;
      "cancelled" = jt cancel stopped the review while it was still undecided. */
  status: ReviewOutcome["status"] | "error" | "cancelled";
  notes: Record<string, string>;
  pushFailure: string | null;
  /** Everything the child printed while deciding/executing; replayed by jt await. */
  log: string[];
}

export const specPath = (dir: string) => join(dir, "push-spec.json");
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

export const readSpec = (dir: string): PushSpec | null => readJson(specPath(dir));
export const writeSpec = (dir: string, spec: PushSpec): void =>
  Deno.writeTextFileSync(specPath(dir), JSON.stringify(spec));
export const clearSpec = (dir: string): void => remove(specPath(dir));

export const readPending = (dir: string): PendingPush | null => readJson(pendingPath(dir));
export const writePending = (dir: string, p: PendingPush): void =>
  Deno.writeTextFileSync(pendingPath(dir), JSON.stringify(p));
export const clearPending = (dir: string): void => remove(pendingPath(dir));

export const readResult = (dir: string): PushResultFile | null => readJson(resultPath(dir));
export const writeResult = (dir: string, r: PushResultFile): void =>
  Deno.writeTextFileSync(resultPath(dir), JSON.stringify(r));
export const clearResult = (dir: string): void => remove(resultPath(dir));

/** Is the review server still running? SIGCONT probes liveness without disturbing it. */
export function pidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}
