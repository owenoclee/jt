/**
 * jt serve — the review server as a process, and how every other command finds it.
 *
 * One server per user, on one fixed loopback port, for every workspace: that is what
 * makes a proposal's link durable. It is started on demand — `jt push` makes sure it is
 * up before printing a link, and any command run in a workspace with a proposal in
 * review revives it after a reboot — and it keeps running, because the human may get to
 * a review hours or days later. `jt serve` runs it in the foreground instead.
 *
 * ~/.config/jt/review-server.json says where it is (pid, port, version). A jt of a
 * different version replaces it: the process that renders a review is the one that
 * sends it, so it must never be older than the jt that staged the work.
 */
import { parseArgs } from "@std/cli";
import { basename, fromFileUrl, join } from "@std/path";
import { configHome, findWorkspaceRoot, loadWorkspace } from "../config.ts";
import { fail } from "../errors.ts";
import { writeFileAtomic } from "../fsutil.ts";
import { DEFAULT_PROPOSAL } from "../proposal.ts";
import { pidAlive } from "../process.ts";
import { createHub } from "../review/hub.ts";
import { registerWorkspace } from "../review/registry.ts";
import { loadSettings } from "../settings.ts";
import { Store } from "../store.ts";
import { VERSION } from "../version.ts";

/** J-I-R-A on a phone keypad. */
export const DEFAULT_REVIEW_PORT = 5472;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ServerState {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
}

export const serverStatePath = (): string => join(configHome(), "jt", "review-server.json");
export const serverLogPath = (): string => join(configHome(), "jt", "review-server.log");

export function readServerState(): ServerState | null {
  try {
    const s = JSON.parse(Deno.readTextFileSync(serverStatePath())) as ServerState;
    return typeof s?.pid === "number" && typeof s?.port === "number" ? s : null;
  } catch {
    return null;
  }
}

/** The port the server should listen on: $JT_REVIEW_PORT, the user's settings, or 5472. */
export function configuredPort(): number {
  const env = Deno.env.get("JT_REVIEW_PORT")?.trim();
  if (env) {
    const n = Number(env);
    if (!Number.isInteger(n) || n < 0 || n > 65535) fail(`JT_REVIEW_PORT must be a port number, not '${env}'`);
    return n;
  }
  try {
    return loadSettings().reviewPort ?? DEFAULT_REVIEW_PORT;
  } catch {
    return DEFAULT_REVIEW_PORT; // a broken settings file is jt push's to report
  }
}

const originOf = (port: number): string => `http://127.0.0.1:${port}`;

/**
 * Where review links point, without starting anything: the running server if there is
 * one, else the port one would start on. Null when that cannot be known (a test
 * server on an ephemeral port that is not running).
 */
export function reviewOrigin(): string | null {
  const state = readServerState();
  if (state && pidAlive(state.pid)) return originOf(state.port);
  const port = configuredPort();
  return port === 0 ? null : originOf(port);
}

export const proposalUrl = (origin: string, slug: string, proposal: string): string =>
  `${origin}/p/${slug}/${proposal}`;

interface Health {
  name: string;
  version: string;
  pid: number;
}

/** Ask whatever is on the port whether it is a jt review server. Null if it is not. */
async function health(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`${originOf(port)}/health`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return body?.name === "jt-review" ? body as Health : null;
  } catch {
    return null;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) await sleep(100);
  return !pidAlive(pid);
}

/** Tests replace the launcher with a server of their own. */
let launcher: () => Promise<string> = startOrFindServer;
export function setServerLauncher(fn: (() => Promise<string>) | null): void {
  launcher = fn ?? startOrFindServer;
}

/** Make sure the review server is running, and return its origin. */
export const ensureServer = (): Promise<string> => launcher();

async function startOrFindServer(): Promise<string> {
  const state = readServerState();
  if (state && pidAlive(state.pid)) {
    const h = await health(state.port);
    if (h && h.pid === state.pid) {
      if (h.version === VERSION) return originOf(state.port);
      // Started by another jt (an upgrade since, most likely). It finishes any push
      // it is in the middle of before it goes.
      try {
        Deno.kill(state.pid, "SIGTERM");
      } catch {
        // gone already
      }
      if (!(await waitForExit(state.pid, 60_000))) {
        fail(
          `the review server from jt ${h.version} (pid ${state.pid}) is still running and has not ` +
            `stopped — it may be sending an approved push. Try again shortly.`,
        );
      }
    }
  }
  return await spawnServer();
}

/** Start `jt serve` detached and wait until it answers. */
async function spawnServer(): Promise<string> {
  // Decide by what is executing NOW: under the deno CLI (deno run / deno task / an
  // installed wrapper) spawn `deno run main.ts`; otherwise this process IS the
  // compiled jt binary — Deno.execPath() is jt itself, so spawn it directly. Never
  // infer from main.ts's presence on disk: a compiled binary on a machine that also
  // has the source tree at its compile-time path (any dev machine) would wrongly
  // exec `jt run ... main.ts`, which is an unknown jt command.
  const mainModule = new URL("../main.ts", import.meta.url);
  const configFile = new URL("../../deno.json", import.meta.url);
  const underDenoCli = basename(Deno.execPath()).replace(/\.exe$/, "") === "deno";
  const serve = ["serve", "--background"];
  const args = underDenoCli
    ? [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "--allow-run",
      "--config",
      fromFileUrl(configFile),
      fromFileUrl(mainModule),
      ...serve,
    ]
    : serve;
  const before = readServerState()?.startedAt;
  const child = new Deno.Command(Deno.execPath(), {
    args,
    // Not any workspace: the server belongs to the user, not to wherever this ran.
    cwd: Deno.env.get("HOME") ?? "/",
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();

  const died = child.status.then((s) => s.code);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = readServerState();
    if (state && state.startedAt !== before && pidAlive(state.pid)) {
      const h = await health(state.port);
      if (h && h.pid === state.pid) {
        child.unref();
        return originOf(state.port);
      }
    }
    const code = await Promise.race([died, sleep(100).then(() => null)]);
    if (code !== null) {
      // It may have bowed out because a server is already there (two commands racing
      // to start one): that is as good as having started it.
      const now = readServerState();
      if (now && pidAlive(now.pid) && (await health(now.port))?.version === VERSION) {
        return originOf(now.port);
      }
      fail(`the review server could not start${logTail()} — run jt serve to see it fail in the foreground`);
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  fail(`the review server did not start within 15s${logTail()}`);
}

function logTail(): string {
  try {
    const lines = Deno.readTextFileSync(serverLogPath()).trim().split("\n").slice(-3);
    return lines.length && lines[0] ? `: ${lines.join(" ")}` : "";
  } catch {
    return "";
  }
}

/**
 * After a reboot nothing is serving the links that are already out there. Any command
 * run in a workspace with a proposal waiting for review starts the server again — in
 * passing, without waiting for it, and without ever failing the command.
 */
export function reviveServerIfNeeded(): void {
  try {
    const root = findWorkspaceRoot(Deno.cwd());
    if (!root || configuredPort() === 0) return;
    const state = readServerState();
    if (state && pidAlive(state.pid)) return;
    const store = new Store(root, DEFAULT_PROPOSAL);
    const waiting = store.listProposals().some((name) => store.scoped(name).readMeta()?.submittedAt);
    if (!waiting) return;
    spawnServer().catch(() => {});
  } catch {
    // best effort only
  }
}

/** jt serve [--stop | --status] — run the review server in the foreground. */
export async function cmdServe(argv: string[]): Promise<void> {
  const args = parseArgs(argv, { boolean: ["stop", "status", "background"] });
  const state = readServerState();
  const running = state && pidAlive(state.pid) ? await health(state.port) : null;

  if (args.status) {
    console.log(
      running
        ? `review server: running (jt ${running.version}, pid ${running.pid}) at ${originOf(state!.port)}/`
        : "review server: not running — jt review starts it",
    );
    return;
  }
  if (args.stop) {
    if (!running) {
      console.log("review server: not running");
      return;
    }
    Deno.kill(running.pid, "SIGTERM");
    if (!(await waitForExit(running.pid, 60_000))) {
      fail(`the review server (pid ${running.pid}) has not stopped — it may be sending an approved push`);
    }
    console.log("review server stopped — proposal links will not open until it runs again (jt review)");
    return;
  }

  // In the background nobody reads stdout: say what happened where the launcher looks.
  const say = args.background
    ? (line: string) => {
      try {
        Deno.mkdirSync(join(configHome(), "jt"), { recursive: true });
        Deno.writeTextFileSync(serverLogPath(), `${new Date().toISOString()} ${line}\n`, { append: true });
      } catch {
        // a log nobody can write is not a reason to stop serving
      }
    }
    : (line: string) => console.log(line);

  if (running && running.version === VERSION) {
    say(`the review server is already running (pid ${running.pid}) at ${originOf(state!.port)}/`);
    return;
  }

  const port = configuredPort();
  const hub = createHub();
  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve({ hostname: "127.0.0.1", port, onListen: () => {} }, (req) => hub.handle(req));
  } catch (e) {
    if (!(e instanceof Deno.errors.AddrInUse)) throw e;
    const other = await health(port);
    const what = other
      ? `a review server from jt ${other.version} (pid ${other.pid}) — stop it with: kill ${other.pid}`
      : "another program";
    const reason = `port ${port} on 127.0.0.1 is in use by ${what}. Proposal links are tied to the ` +
      `port, so jt will not pick another by itself. user: free the port, or set "reviewPort" in ` +
      `~/.config/jt/settings.json.`;
    say(reason);
    fail(reason);
  }
  const actual = server.addr.port;
  const mine: ServerState = { pid: Deno.pid, port: actual, version: VERSION, startedAt: new Date().toISOString() };
  Deno.mkdirSync(join(configHome(), "jt"), { recursive: true });
  writeFileAtomic(serverStatePath(), JSON.stringify(mine, null, 2) + "\n");
  say(`jt review server (jt ${VERSION}, pid ${Deno.pid}) listening at ${originOf(actual)}/`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // An approved push in flight is finished first: stopping half-way through would
    // leave part of it in Jira and nothing recorded.
    while (hub.busy()) await sleep(100);
    if (readServerState()?.pid === Deno.pid) {
      try {
        Deno.removeSync(serverStatePath());
      } catch {
        // already gone
      }
    }
    say("jt review server stopped");
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  await server.finished;
}

/** jt review — for the human: where the inbox is, making sure it is being served. */
export async function cmdReview(): Promise<void> {
  // Run inside a workspace, this also puts that workspace on the inbox.
  const root = findWorkspaceRoot(Deno.cwd());
  if (root) registerWorkspace(root, loadWorkspace(root).config.project);
  const origin = await ensureServer();
  console.log(`proposals: ${origin}/`);
}
