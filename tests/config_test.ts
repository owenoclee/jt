/**
 * Credential discovery: the environment first, then ~/.config/jt/credentials, then the
 * pre-rename ~/.config/jira-cli/credentials — so installs predating the rename keep
 * authenticating untouched while everything new points at the current path.
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { cmdConfigShow } from "../src/commands/init.ts";
import { credentialsPath, legacyCredentialsPath, loadToken } from "../src/config.ts";
import { UserError } from "../src/errors.ts";

function withTempHome(fn: (home: string) => void): void {
  const home = Deno.makeTempDirSync({ prefix: "jt-home-" });
  const prevHome = Deno.env.get("HOME");
  const prevToken = Deno.env.get("JIRA_API_TOKEN");
  Deno.env.set("HOME", home);
  Deno.env.delete("JIRA_API_TOKEN");
  try {
    fn(home);
  } finally {
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
    if (prevToken === undefined) Deno.env.delete("JIRA_API_TOKEN");
    else Deno.env.set("JIRA_API_TOKEN", prevToken);
    Deno.removeSync(home, { recursive: true });
  }
}

function writeCredential(path: string, token: string): void {
  Deno.mkdirSync(dirname(path), { recursive: true });
  Deno.writeTextFileSync(path, token + "\n");
}

Deno.test("the credentials file lives under ~/.config/jt", () => {
  withTempHome((home) => {
    assertEquals(credentialsPath(), join(home, ".config", "jt", "credentials"));
    writeCredential(credentialsPath(), "current-token");
    assertEquals(loadToken(), { token: "current-token", source: credentialsPath() });
  });
});

Deno.test("the pre-rename jira-cli path still authenticates, but jt wins", () => {
  withTempHome((home) => {
    assertEquals(legacyCredentialsPath(), join(home, ".config", "jira-cli", "credentials"));
    writeCredential(legacyCredentialsPath(), "old-token");
    assertEquals(loadToken(), { token: "old-token", source: legacyCredentialsPath() });

    writeCredential(credentialsPath(), "current-token");
    assertEquals(loadToken(), { token: "current-token", source: credentialsPath() });
  });
});

Deno.test("JIRA_API_TOKEN outranks both files", () => {
  withTempHome(() => {
    writeCredential(credentialsPath(), "current-token");
    writeCredential(legacyCredentialsPath(), "old-token");
    Deno.env.set("JIRA_API_TOKEN", "  env-token  ");
    assertEquals(loadToken(), { token: "env-token", source: "env:JIRA_API_TOKEN" });
  });
});

Deno.test("with no token anywhere, the error names only the current path", () => {
  withTempHome(() => {
    const err = assertThrows(() => loadToken(), UserError);
    assertStringIncludes(err.message, credentialsPath());
    assertStringIncludes(err.message, "~/.config/jt");
    assertEquals(err.message.includes("jira-cli"), false, "never advertise the old location");
  });
});

Deno.test("jt config show flags a token still read from the old location", () => {
  withTempHome((home) => {
    const root = join(home, "ws");
    Deno.mkdirSync(join(root, ".jira"), { recursive: true });
    Deno.writeTextFileSync(
      join(root, ".jira", "config.json"),
      JSON.stringify({
        baseUrl: "https://example.atlassian.net",
        email: "t@example.com",
        project: "TST",
        customFields: [],
      }),
    );
    const prevCwd = Deno.cwd();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      Deno.chdir(root);
      writeCredential(legacyCredentialsPath(), "old-token");
      cmdConfigShow();
      assertStringIncludes(logs.join("\n"), `token: present (${legacyCredentialsPath()})`);
      assertStringIncludes(logs.join("\n"), `move it to ${credentialsPath()}`);

      logs.length = 0;
      writeCredential(credentialsPath(), "current-token");
      cmdConfigShow();
      assertEquals(logs.join("\n").includes("pre-rename"), false, "no nag once moved");
    } finally {
      console.log = origLog;
      Deno.chdir(prevCwd);
    }
  });
});
