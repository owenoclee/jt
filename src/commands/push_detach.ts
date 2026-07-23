/**
 * The detached half of jt push. `jt _push-serve` (hidden, spawned by jt push) runs
 * the review server in its own process so `jt push` can print the URL and return
 * immediately; `jt await` collects the outcome — exactly once — with the exit codes
 * the blocking push used to have (0 pushed · 2 changes requested · 1 otherwise).
 * The page itself never expires; `jt cancel` withdraws an undecided review.
 */
import { parseArgs } from "@std/cli";
import { fromFileUrl } from "@std/path";
import { localContext, withClient, withMeta } from "../context.ts";
import { fail } from "../errors.ts";
import { dim } from "../render/colors.ts";
import {
  clearPending,
  clearResult,
  clearSpec,
  type PendingPush,
  pidAlive,
  pushLogPath,
  type PushResultFile,
  readPending,
  readResult,
  readSpec,
  specPath,
  writePending,
  writeResult,
} from "../review/handoff.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn `jt _push-serve` detached and return the review URL it reports. */
export async function spawnReviewServer(root: string, jiraDir: string): Promise<string> {
  // Running from source (deno run, or the deno install wrapper): spawn `deno run
  // main.ts`. Compiled binary (main.ts not on disk): the executable IS jt.
  const mainModule = new URL("../main.ts", import.meta.url);
  const configFile = new URL("../../deno.json", import.meta.url);
  const fromSource = mainModule.protocol === "file:" && exists(fromFileUrl(mainModule));
  const args = fromSource
    ? [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "--config",
      fromFileUrl(configFile),
      fromFileUrl(mainModule),
      "_push-serve",
    ]
    : ["_push-serve"];
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();

  const died = child.status.then((s) => s.code);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pending = readPending(jiraDir);
    if (pending) {
      child.unref();
      return pending.url;
    }
    const code = await Promise.race([died, sleep(100).then(() => null)]);
    if (code !== null) {
      clearSpec(jiraDir);
      fail(`the review server exited immediately (code ${code}) — see ${pushLogPath(jiraDir)}`);
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  clearSpec(jiraDir);
  fail(`the review server did not start within 15s — see ${pushLogPath(jiraDir)}`);
}

/** jt _push-serve — the detached review server. Spawned by jt push; not for humans. */
export async function cmdPushServe(): Promise<void> {
  const ctx = withClient(withMeta(localContext()));
  const jiraDir = ctx.ws.jiraDir;
  const spec = readSpec(jiraDir);
  if (!spec) fail(`no push spec at ${specPath(jiraDir)} — jt _push-serve is spawned by jt push`);
  clearSpec(jiraDir);

  // Detached: stdout goes nowhere. Capture everything for push-result.json (replayed
  // by jt await) and mirror it to last-push.log for post-mortems.
  const log: string[] = [];
  const logFile = Deno.openSync(pushLogPath(jiraDir), {
    write: true,
    create: true,
    truncate: true,
  });
  const enc = new TextEncoder();
  const capture = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    log.push(line);
    logFile.writeSync(enc.encode(line + "\n"));
  };
  console.log = capture;
  console.error = capture;

  const finish = (r: Omit<PushResultFile, "finishedAt" | "log">) => {
    writeResult(jiraDir, { finishedAt: new Date().toISOString(), log, ...r });
    clearPending(jiraDir); // result exists before pending disappears — await never races
    logFile.close();
  };

  // jt cancel SIGTERMs this process. Undecided: record a cancelled outcome and stop.
  // Decided: ignore the signal — the outcome is already executing and must settle;
  // cancel learns it lost the race from the decidedAt stamp on the pending file.
  let decided = false;
  const onSigterm = () => {
    if (decided) return;
    capture("review cancelled — nothing was sent");
    finish({ status: "cancelled", notes: {}, pushFailure: null });
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGTERM", onSigterm);

  const { runReviewFlow } = await import("../review/server.ts");
  let pending: PendingPush | null = null;
  try {
    const outcome = await runReviewFlow(
      ctx,
      { ops: spec.ops, warnings: spec.warnings, existingKeys: spec.existingKeys },
      {
        announce: false,
        onServe: (url) => {
          pending = { pid: Deno.pid, url, startedAt: new Date().toISOString() };
          writePending(jiraDir, pending);
        },
        onDecision: () => {
          decided = true;
          if (pending) writePending(jiraDir, { ...pending, decidedAt: new Date().toISOString() });
        },
      },
    );
    finish({ status: outcome.status, notes: outcome.notes, pushFailure: outcome.pushFailure });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    capture(`review server crashed: ${msg}`);
    finish({ status: "error", notes: {}, pushFailure: msg });
    Deno.exit(1);
  } finally {
    Deno.removeSignalListener("SIGTERM", onSigterm);
  }
}

/** The agent-loop exit code for a collected outcome, mirroring the old blocking push. */
export function exitCodeFor(result: PushResultFile): number {
  if (result.status === "changes-requested") return 2;
  if (result.status === "pushed" && !result.pushFailure) return 0;
  return 1;
}

/** jt await — block until the pending review settles, then report it exactly once. */
export async function cmdAwait(argv: string[]): Promise<void> {
  const args = parseArgs(argv, { string: ["timeout"] });
  const { ws } = localContext();
  const jiraDir = ws.jiraDir;

  let result = readResult(jiraDir);
  if (!result) {
    const pending = readPending(jiraDir);
    if (!pending) {
      fail("nothing to await — no pending review and no uncollected outcome (jt push first)");
    }
    console.log(dim(`waiting on the review at ${pending.url} ...`));
    // Bounds this wait, never the review: giving up collects nothing and the page
    // stays live — rerun jt await to keep waiting.
    const timeoutMs = args.timeout ? Number(args.timeout) * 1000 : 600_000;
    const deadline = Date.now() + timeoutMs;
    while (!result && Date.now() < deadline) {
      await sleep(250);
      result = readResult(jiraDir);
      if (!result && !pidAlive(pending.pid)) {
        await sleep(500); // the server may exit between writing the result and our probe
        result = readResult(jiraDir);
        if (!result) {
          clearPending(jiraDir);
          fail(
            `the review server is gone without recording an outcome — ` +
              `see ${pushLogPath(jiraDir)} and jt log`,
          );
        }
      }
    }
    if (!result) {
      fail(
        "gave up waiting — the review page is still live; run jt await again " +
          "(or jt cancel to withdraw the review)",
      );
    }
  }
  clearResult(jiraDir);
  for (const line of result.log) console.log(line);
  const code = exitCodeFor(result);
  if (code !== 0) Deno.exit(code);
}

/**
 * jt cancel — withdraw the pending review deliberately: stop its server; nothing is
 * sent. Refused once the decision has landed (the outcome, and possibly the push
 * itself, is already executing — collect it with jt await instead).
 */
export async function cmdCancel(): Promise<void> {
  const { ws } = localContext();
  const jiraDir = ws.jiraDir;
  const pending = readPending(jiraDir);
  if (!pending) {
    if (readResult(jiraDir)) {
      fail("nothing to cancel — the review already settled; run jt await to collect its outcome");
    }
    fail("nothing to cancel — no review is pending");
  }
  if (pending.decidedAt) {
    fail("too late to cancel — the review was already decided; jt await reports the outcome");
  }
  if (pidAlive(pending.pid)) {
    try {
      Deno.kill(pending.pid, "SIGTERM");
    } catch {
      // exited between the liveness probe and the signal
    }
    const deadline = Date.now() + 10_000;
    while (pidAlive(pending.pid) && Date.now() < deadline) {
      await sleep(100);
      if (readPending(jiraDir)?.decidedAt) {
        fail("too late to cancel — the review was decided first; jt await reports the outcome");
      }
    }
    if (pidAlive(pending.pid)) {
      fail(
        `the review server (pid ${pending.pid}) is still running — ` +
          `it may be executing a decision; run jt await`,
      );
    }
  }
  const result = readResult(jiraDir);
  if (result && result.status !== "cancelled") {
    fail("too late to cancel — the review already settled; run jt await to collect its outcome");
  }
  if (result) clearResult(jiraDir); // the server's own cancellation record — collected here
  clearPending(jiraDir);
  console.log("review cancelled — nothing was sent");
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}
