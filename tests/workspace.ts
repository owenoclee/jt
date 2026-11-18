/** A jt workspace wired to a fresh mock Jira, for integration tests that push. */
import "./hermetic.ts";
import { join } from "@std/path";
import { cmdFetch } from "../src/commands/fetch.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdMeta } from "../src/commands/meta.ts";
import { setServerLauncher } from "../src/commands/serve.ts";
import { setActiveProposal } from "../src/proposal.ts";
import { createHub, type Hub } from "../src/review/hub.ts";
import { Store } from "../src/store.ts";
import type { ReviewComment } from "../src/types.ts";
import { decide, type Decided, open, type Opened, ORIGIN } from "./hub_client.ts";
import { MockJira } from "./mock_jira.ts";

/** The workspace's name on the review server: its project key. */
export const SLUG = "TST";

export interface TestWorkspace {
  mock: MockJira;
  dir: string;
  logs: string[];
  /** The workspace seen through a proposal (the default one when unnamed). */
  store: (proposal?: string) => Store;
  /** Run `fn` as if every command in it had been given `-p proposal`. */
  as: <T>(proposal: string | null, fn: () => T | Promise<T>) => Promise<T>;
  /** Write the user's settings file (what ~/.config/jt/settings.json would hold). */
  writeSettings: (settings: unknown) => void;
  /**
   * The review server, in this process: `jt push` in a test finds this one instead of
   * starting a real one. Driven with the helpers in hub_client.ts.
   */
  hub: Hub;
  /** Open a submitted proposal's link as its reviewer's browser would. */
  open: (proposal: string | null) => Promise<Opened>;
  /**
   * Review a submitted proposal: open its page and decide. Approving sends the push
   * before this returns. Asking for changes needs comments; one is supplied if none
   * are given. Throws unless the decision was accepted.
   */
  decide: (
    proposal: string | null,
    decision: "approve" | "request-changes",
    comments?: ReviewComment[],
  ) => Promise<Decided["body"]>;
  /** The HTML of the reviewable page a submitted proposal has. */
  page: (proposal: string | null) => Promise<string>;
}

export async function withWorkspace(
  seed: string[],
  fn: (ws: TestWorkspace) => Promise<void>,
): Promise<void> {
  const mock = new MockJira();
  for (const summary of seed) mock.seedIssue({ summary });
  mock.start();
  const dir = Deno.makeTempDirSync({ prefix: "jt-ws-" });
  const home = Deno.makeTempDirSync({ prefix: "jt-home-" });
  const prev = {
    cwd: Deno.cwd(),
    token: Deno.env.get("JIRA_API_TOKEN"),
    home: Deno.env.get("HOME"),
    log: console.log,
  };
  Deno.chdir(dir);
  Deno.env.set("JIRA_API_TOKEN", "test-token");
  Deno.env.set("HOME", home);
  const logs: string[] = [];
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));

  const store = (proposal?: string) => new Store(dir, proposal);
  const hub = createHub();
  setServerLauncher(() => Promise.resolve(ORIGIN));
  const reviewable = async (proposal: string | null): Promise<Opened & { page: string; token: string }> => {
    const opened = await open(hub, SLUG, proposal ?? "default");
    if (!opened.page || !opened.token) {
      throw new Error(
        `${proposal ?? "the default proposal"} is not reviewable: ` +
          JSON.stringify(opened.refresh ?? { status: opened.localStatus }),
      );
    }
    return opened as Opened & { page: string; token: string };
  };
  try {
    cmdInit(["--base-url", mock.baseUrl, "--email", "t@example.com", "--project", "TST"]);
    await cmdMeta(["sync"]);
    await cmdFetch(seed.map((_, i) => `TST-${i + 1}`));
    await fn({
      mock,
      dir,
      logs,
      store,
      as: async (proposal, run) => {
        setActiveProposal(proposal);
        try {
          return await run();
        } finally {
          setActiveProposal(null);
        }
      },
      writeSettings: (settings) => {
        Deno.mkdirSync(join(home, ".config", "jt"), { recursive: true });
        Deno.writeTextFileSync(join(home, ".config", "jt", "settings.json"), JSON.stringify(settings));
      },
      hub,
      open: (proposal) => open(hub, SLUG, proposal ?? "default"),
      decide: async (proposal, decision, comments) => {
        const { token } = await reviewable(proposal);
        const said = comments ?? (decision === "request-changes" ? [{ body: "please change this" }] : []);
        const done = await decide(hub, SLUG, proposal ?? "default", token, decision, said);
        if (done.status !== 200) {
          throw new Error(`the decision was answered ${done.status}: ${JSON.stringify(done.body)}`);
        }
        return done.body;
      },
      page: async (proposal) => (await reviewable(proposal)).page,
    });
  } finally {
    setServerLauncher(null);
    setActiveProposal(null);
    console.log = prev.log;
    Deno.chdir(prev.cwd);
    if (prev.token === undefined) Deno.env.delete("JIRA_API_TOKEN");
    else Deno.env.set("JIRA_API_TOKEN", prev.token);
    if (prev.home === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prev.home);
    await mock.stop();
  }
}

/** The message of the error `fn` throws; fails the test if it does not throw. */
export async function errorOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected an error, but nothing was thrown");
}
