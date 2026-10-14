/**
 * The agent skill (SKILL.md) ships inside the binary via a raw text import, so an
 * installed jt can always reproduce the contract that matches its own version. Copies
 * installed by an older jt are refreshed by every later one (see src/skillsync.ts).
 */
import { join } from "@std/path";
import { fail } from "../errors.ts";
import { SKILL_DIRS, SKILL_MD } from "../skillsync.ts";

const USAGE = `usage: jt skill show | jt skill install <${Object.keys(SKILL_DIRS).join("|")}>`;

export function cmdSkill(argv: string[]): void {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "show":
      Deno.stdout.writeSync(new TextEncoder().encode(SKILL_MD));
      return;
    case "install": {
      const dirFor = rest[0] && SKILL_DIRS[rest[0]];
      if (!dirFor) fail(USAGE);
      const home = Deno.env.get("HOME");
      if (!home) fail("$HOME is not set — cannot locate the skills directory");
      const dir = dirFor(home);
      const path = join(dir, "SKILL.md");
      let replaced = true;
      try {
        Deno.statSync(path);
      } catch {
        replaced = false;
      }
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(path, SKILL_MD);
      console.log(`installed: ${path}${replaced ? " (replaced previous version)" : ""}`);
      return;
    }
    default:
      fail(USAGE);
  }
}
