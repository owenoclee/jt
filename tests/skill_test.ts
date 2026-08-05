/**
 * jt skill: the embedded SKILL.md installs into each agent's skills directory and is
 * byte-identical across targets (one contract, several homes).
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { cmdSkill } from "../src/commands/skill.ts";
import { UserError } from "../src/errors.ts";

function withTempHome(fn: (home: string) => void): void {
  const home = Deno.makeTempDirSync();
  const prevHome = Deno.env.get("HOME");
  const prevCodex = Deno.env.get("CODEX_HOME");
  Deno.env.set("HOME", home);
  Deno.env.delete("CODEX_HOME");
  try {
    fn(home);
  } finally {
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
    if (prevCodex === undefined) Deno.env.delete("CODEX_HOME");
    else Deno.env.set("CODEX_HOME", prevCodex);
    Deno.removeSync(home, { recursive: true });
  }
}

Deno.test("skill install writes the same SKILL.md for claude-code and codex", () => {
  withTempHome((home) => {
    cmdSkill(["install", "claude-code"]);
    cmdSkill(["install", "codex"]);
    const claude = Deno.readTextFileSync(join(home, ".claude", "skills", "jt", "SKILL.md"));
    const codex = Deno.readTextFileSync(join(home, ".codex", "skills", "jt", "SKILL.md"));
    assertStringIncludes(claude, "# jt agent contract");
    assertStringIncludes(claude, "\nname: jt\n");
    assertEquals(codex, claude);
  });
});

Deno.test("skill install honors CODEX_HOME over ~/.codex", () => {
  withTempHome((home) => {
    const codexHome = join(home, "custom-codex");
    Deno.env.set("CODEX_HOME", codexHome);
    cmdSkill(["install", "codex"]);
    assert(Deno.statSync(join(codexHome, "skills", "jt", "SKILL.md")).isFile);
  });
});

Deno.test("skill install overwrites a previous install in place", () => {
  withTempHome((home) => {
    const path = join(home, ".claude", "skills", "jt", "SKILL.md");
    Deno.mkdirSync(join(home, ".claude", "skills", "jt"), { recursive: true });
    Deno.writeTextFileSync(path, "stale contract\n");
    cmdSkill(["install", "claude-code"]);
    assertStringIncludes(Deno.readTextFileSync(path), "# jt agent contract");
  });
});

Deno.test("skill rejects unknown agents and subcommands", () => {
  withTempHome(() => {
    assertThrows(() => cmdSkill(["install", "cursor"]), UserError, "usage:");
    assertThrows(() => cmdSkill(["install"]), UserError, "usage:");
    assertThrows(() => cmdSkill(["frobnicate"]), UserError, "usage:");
  });
});
