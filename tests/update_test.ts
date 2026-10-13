/** Update advice: told once a day when a newer jt exists; never updated, never blocked. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  pickLatest,
  type ReleaseInfo,
  startUpdateCheck,
  updateCheckEnabled,
  upgradeCommand,
} from "../src/update.ts";
import { compareVersions, isPrerelease, parseVersion } from "../src/version.ts";

const RELEASES: ReleaseInfo[] = [
  { tag_name: "v0.6.0-rc.2", prerelease: true },
  { tag_name: "v0.5.0" },
  { tag_name: "v0.6.0-rc.1", prerelease: true },
  { tag_name: "v0.4.1" },
  { tag_name: "v9.9.9", draft: true },
  { tag_name: "nightly" },
];

Deno.test("versions order by semver, release candidates before their release", () => {
  const order = ["0.6.0", "0.5.0", "0.6.0-rc.10", "0.6.0-rc.2", "0.10.0", "0.6.0-rc.1"];
  assertEquals([...order].sort(compareVersions), [
    "0.5.0",
    "0.6.0-rc.1",
    "0.6.0-rc.2",
    "0.6.0-rc.10",
    "0.6.0",
    "0.10.0",
  ]);
  assertEquals(compareVersions("v0.5.0", "0.5.0"), 0);
  assertEquals(compareVersions("garbage", "0.5.0"), 0, "an unparseable version is never 'older'");
  assert(isPrerelease("0.6.0-rc.1") && !isPrerelease("0.6.0"));
  assertEquals(parseVersion("1.2.3-rc.4")?.pre, ["rc", 4]);
});

Deno.test("a stable build hears only about stable releases; a candidate build about everything", () => {
  assertEquals(pickLatest(RELEASES, "0.4.1"), "0.5.0");
  assertEquals(pickLatest(RELEASES, "0.6.0-rc.1"), "0.6.0-rc.2");
  assertEquals(pickLatest([], "0.5.0"), null);
});

Deno.test("the advised command matches how jt was installed", () => {
  assertEquals(upgradeCommand("/opt/homebrew/Cellar/jt/0.5.0/bin/jt"), "brew upgrade owenoclee/tap/jt");
  assertEquals(
    upgradeCommand("/opt/homebrew/Cellar/jt-rc/0.6.0-rc.1/bin/jt"),
    "brew upgrade owenoclee/tap/jt-rc",
  );
  assertStringIncludes(upgradeCommand("/Users/u/.deno/bin/deno"), "deno task install");
  assertStringIncludes(upgradeCommand("/usr/local/bin/jt"), "github.com/owenoclee/jt/releases");
});

function harness(current: string) {
  const dir = Deno.makeTempDirSync({ prefix: "jt-update-" });
  const state = { now: 1_800_000_000_000, fetches: 0, printed: [] as string[], fail: false };
  const run = async (cmd = "status") => {
    await startUpdateCheck(cmd, {
      current,
      cachePath: join(dir, "nested", "update-check.json"),
      now: () => state.now,
      execPath: "/opt/homebrew/Cellar/jt/0.4.1/bin/jt",
      print: (line) => state.printed.push(line),
      fetchReleases: () => {
        state.fetches++;
        return state.fail ? Promise.reject(new Error("offline")) : Promise.resolve(RELEASES);
      },
    })();
  };
  return { state, run };
}

Deno.test("an outdated jt is told once a day, and asks GitHub once a day", async () => {
  const { state, run } = harness("0.4.1");
  await run();
  assertEquals(state.fetches, 1);
  assertEquals(state.printed.length, 1);
  assertStringIncludes(state.printed[0], "jt 0.5.0 is available — you are running 0.4.1");
  assertStringIncludes(state.printed[0], "brew upgrade owenoclee/tap/jt");
  assertStringIncludes(state.printed[0], "never updates itself");

  await run();
  await run("push");
  assertEquals(state.fetches, 1, "the answer is cached for a day");
  assertEquals(state.printed.length, 1, "and the notice is not repeated on every command");

  await run("version"); // asking for the version is asking; say it again, from the cache
  assertEquals([state.fetches, state.printed.length], [1, 2]);

  state.now += 25 * 60 * 60 * 1000;
  await run();
  assertEquals([state.fetches, state.printed.length], [2, 3]);
});

Deno.test("a current jt, and an offline one, say nothing", async () => {
  const current = harness("0.5.0");
  await current.run();
  assertEquals(current.state.printed, []);

  const offline = harness("0.4.1");
  offline.state.fail = true;
  await offline.run();
  await offline.run();
  assertEquals(offline.state.printed, []);
  assertEquals(offline.state.fetches, 1, "a failed check backs off for the day too");
});

Deno.test("the check can be switched off, and stays out of machine-read commands", () => {
  const prev = { off: Deno.env.get("JT_NO_UPDATE_CHECK"), ci: Deno.env.get("CI") };
  try {
    Deno.env.delete("JT_NO_UPDATE_CHECK");
    Deno.env.delete("CI");
    assertEquals(updateCheckEnabled("status"), true);
    assertEquals(updateCheckEnabled("_push-serve"), false);
    assertEquals(updateCheckEnabled("schema"), false);
    Deno.env.set("JT_NO_UPDATE_CHECK", "1");
    assertEquals(updateCheckEnabled("status"), false);
  } finally {
    for (const [name, value] of [["JT_NO_UPDATE_CHECK", prev.off], ["CI", prev.ci]] as const) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});
