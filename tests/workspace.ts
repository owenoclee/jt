/** A jt workspace wired to a fresh mock Jira, for integration tests that push. */
import "./hermetic.ts";
import { join } from "@std/path";
import { cmdFetch } from "../src/commands/fetch.ts";
import { cmdInit } from "../src/commands/init.ts";
import { cmdMeta } from "../src/commands/meta.ts";
import { setActiveProposal } from "../src/proposal.ts";
import { readPending } from "../src/review/handoff.ts";
import { Store } from "../src/store.ts";
import { MockJira } from "./mock_jira.ts";

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
  /** POST a decision to the review page a proposal has pending. */
  decide: (proposal: string | null, decision: "approve" | "request-changes") => Promise<void>;
  /** The HTML of the review page a proposal has pending. */
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
  const pendingUrl = (proposal: string | null): string => {
    const pending = readPending(store(proposal ?? undefined).proposalDir);
    if (!pending) throw new Error(`no review pending for ${proposal ?? "the default proposal"}`);
    return pending.url;
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
      decide: async (proposal, decision) => {
        const res = await fetch(pendingUrl(proposal).replace("/review/", "/decide/"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, notes: {} }),
        });
        if (res.status !== 200) throw new Error(`decision POST answered ${res.status}`);
        await res.body?.cancel();
      },
      page: async (proposal) => await (await fetch(pendingUrl(proposal))).text(),
    });
  } finally {
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
