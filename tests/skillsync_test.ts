/**
 * Skill sync: a copy jt wrote is kept in step with the binary; a copy someone edited is
 * left alone and warned about; an agent without the skill is never given one.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  SHIPPED_SKILLS,
  SKILL_MD,
  skillHash,
  skillSyncEnabled,
  type SkillSyncOptions,
  syncInstalledSkills,
} from "../src/skillsync.ts";

const OLD = "---\nname: jt\n---\n\n# jt agent contract (0.1)\n";
const NEW = "---\nname: jt\n---\n\n# jt agent contract (0.2)\n";

Deno.test("the current SKILL.md is listed as shipped", async () => {
  const hash = await skillHash(SKILL_MD);
  assert(
    hash in SHIPPED_SKILLS,
    `SKILL.md changed: add  "${hash}": "<version that will ship it>",  to SHIPPED_SKILLS in ` +
      "src/skillsync.ts, so later builds recognise the copies this one installs",
  );
});

Deno.test("every shipped entry is a sha256 and a version", () => {
  for (const [hash, version] of Object.entries(SHIPPED_SKILLS)) {
    assert(/^[0-9a-f]{64}$/.test(hash), hash);
    assert(/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(version), version);
  }
});

Deno.test("skill sync never runs for commands whose output is machine-read", () => {
  for (const cmd of ["skill", "schema", "_push-serve"]) assertEquals(skillSyncEnabled(cmd), false);
  for (const cmd of ["status", "push", "await", "version", undefined]) {
    assertEquals(skillSyncEnabled(cmd), true);
  }
});

async function harness() {
  const home = Deno.makeTempDirSync({ prefix: "jt-skillsync-" });
  const state = { now: 1_800_000_000_000, printed: [] as string[] };
  const claude = join(home, ".claude", "skills", "jt", "SKILL.md");
  const codex = join(home, ".codex", "skills", "jt", "SKILL.md");
  const install = (path: string, text: string) => {
    Deno.mkdirSync(join(path, ".."), { recursive: true });
    Deno.writeTextFileSync(path, text);
  };
  const opts: SkillSyncOptions = {
    home,
    embedded: NEW,
    shipped: { [await skillHash(OLD)]: "0.1.0", [await skillHash(NEW)]: "0.2.0" },
    version: "0.2.0",
    cachePath: join(home, ".config", "jt", "skill-check.json"),
    now: () => state.now,
    print: (line) => state.printed.push(line),
  };
  const run = () => syncInstalledSkills(opts);
  return { home, state, claude, codex, install, run };
}

const withCodexHome = async (value: string | undefined, fn: () => Promise<void>) => {
  const prev = Deno.env.get("CODEX_HOME");
  if (value === undefined) Deno.env.delete("CODEX_HOME");
  else Deno.env.set("CODEX_HOME", value);
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("CODEX_HOME");
    else Deno.env.set("CODEX_HOME", prev);
  }
};

Deno.test("a copy an older jt installed is refreshed, and the agent told to re-read it", async () => {
  await withCodexHome(undefined, async () => {
    const h = await harness();
    h.install(h.claude, OLD);
    await h.run();
    assertEquals(Deno.readTextFileSync(h.claude), NEW);
    assertEquals(h.state.printed.length, 1);
    assertStringIncludes(h.state.printed[0], "~/.claude/skills/jt/SKILL.md (from jt 0.1.0)");
    assertStringIncludes(h.state.printed[0], "Run `jt skill show`");
    assertEquals([...Deno.readDirSync(join(h.claude, ".."))].length, 1, "no temp file left");

    await h.run();
    assertEquals(h.state.printed.length, 1, "once refreshed, nothing more to say");
  });
});

Deno.test("line-ending and BOM changes do not make a copy 'edited'", async () => {
  await withCodexHome(undefined, async () => {
    const h = await harness();
    h.install(h.claude, "﻿" + OLD.replaceAll("\n", "\r\n"));
    await h.run();
    assertEquals(Deno.readTextFileSync(h.claude), NEW);

    h.install(h.claude, NEW.replaceAll("\n", "\r\n"));
    await h.run();
    assertEquals(h.state.printed.length, 1, "already current apart from line endings");
  });
});

Deno.test("an edited copy is left alone, and the warning tells the agent not to overwrite it", async () => {
  await withCodexHome(undefined, async () => {
    const h = await harness();
    const edited = OLD + "\nAlways use project SBX.\n";
    h.install(h.claude, edited);
    await h.run();
    assertEquals(Deno.readTextFileSync(h.claude), edited);
    assertEquals(h.state.printed.length, 1);
    const notice = h.state.printed[0];
    assertStringIncludes(notice, "has local edits");
    assertStringIncludes(notice, "run `jt skill show`");
    assertStringIncludes(notice, "Do not run `jt skill install` yourself");
    assertStringIncludes(notice, "`jt skill install claude-code` replaces it");

    await h.run();
    assertEquals(h.state.printed.length, 1, "warned at most once a day");
    h.state.now += 24 * 60 * 60 * 1000;
    await h.run();
    assertEquals(h.state.printed.length, 2, "and again the next day");
  });
});

Deno.test("an agent without the skill is never given one", async () => {
  await withCodexHome(undefined, async () => {
    const h = await harness();
    h.install(h.claude, OLD);
    await h.run();
    let codexExists = true;
    try {
      Deno.statSync(join(h.home, ".codex"));
    } catch {
      codexExists = false;
    }
    assertEquals(codexExists, false);
  });
});

Deno.test("codex copies are found under CODEX_HOME and named in the advice", async () => {
  const h = await harness();
  const codexHome = join(h.home, "custom-codex");
  const path = join(codexHome, "skills", "jt", "SKILL.md");
  await withCodexHome(codexHome, async () => {
    h.install(path, OLD);
    h.install(h.claude, "something else entirely\n");
    await h.run();
  });
  assertEquals(Deno.readTextFileSync(path), NEW);
  assertEquals(h.state.printed.length, 2);
  assertStringIncludes(h.state.printed.join("\n"), "`jt skill install claude-code` replaces it");
});

Deno.test("an unreadable cache or unwritable skill never throws", async () => {
  await withCodexHome(undefined, async () => {
    const h = await harness();
    h.install(h.claude, OLD);
    Deno.chmodSync(join(h.claude, ".."), 0o555);
    try {
      await h.run();
      assertEquals(Deno.readTextFileSync(h.claude), OLD);
      assertEquals(h.state.printed.length, 0, "nothing claimed when nothing was written");
    } finally {
      Deno.chmodSync(join(h.claude, ".."), 0o755);
    }
  });
});
