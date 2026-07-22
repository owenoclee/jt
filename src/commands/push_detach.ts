/**
 * The detached half of jt push. `jt _push-serve` (hidden, spawned by jt push) runs
 * the review server in its own process so `jt push` can print the URL and return
 * immediately; `jt await` collects the outcome — exactly once — with the exit codes
 * the blocking push used to have (0 pushed · 2 changes requested · 1 otherwise).
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

  const { runReviewFlow } = await import("../review/server.ts");
  try {
    const outcome = await runReviewFlow(
      ctx,
      { ops: spec.ops, warnings: spec.warnings, existingKeys: spec.existingKeys },
      {
        timeoutMs: spec.timeoutMs,
        announce: false,
        onServe: (url) =>
          writePending(jiraDir, {
            pid: Deno.pid,
            url,
            startedAt: new Date().toISOString(),
            timeoutMs: spec.timeoutMs,
          }),
      },
    );
    finish({ status: outcome.status, notes: outcome.notes, pushFailure: outcome.pushFailure });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    capture(`review server crashed: ${msg}`);
    finish({ status: "error", notes: {}, pushFailure: msg });
    Deno.exit(1);
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
    const deadline = args.timeout
      ? Date.now() + Number(args.timeout) * 1000
      : Date.parse(pending.startedAt) + pending.timeoutMs + 15_000;
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
      fail("gave up waiting — the review page may still be open; run jt await again");
    }
  }
  clearResult(jiraDir);
  for (const line of result.log) console.log(line);
  const code = exitCodeFor(result);
  if (code !== 0) Deno.exit(code);
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}
