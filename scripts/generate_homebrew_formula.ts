import { dirname } from "@std/path";

/**
 * Two formulae ship from one release pipeline:
 *
 *   stable -> Formula/jt.rb      what `brew install owenoclee/tap/jt` gives everyone
 *   rc     -> Formula/jt-rc.rb   release candidates; nobody gets one without asking
 *
 * Homebrew has no "opt in to pre-releases" switch for a formula (the old `devel` spec
 * is gone, and `--HEAD` means building from source). A second formula is the
 * mechanism: installing jt-rc is the opt-in, and stable users never see a candidate.
 * Both install the same `jt` binary, so each declares the other a conflict.
 */
export type Channel = "stable" | "rc";

interface FormulaOptions {
  version: string;
  arm64Sha256: string;
  x86_64Sha256: string;
  /** Defaults to the stable formula. */
  channel?: Channel;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TAP = "owenoclee/tap";

export function isPrereleaseVersion(version: string): boolean {
  return version.includes("-");
}

export function renderHomebrewFormula(options: FormulaOptions): string {
  const channel = options.channel ?? "stable";
  if (!VERSION_PATTERN.test(options.version)) {
    throw new Error(`invalid version: ${options.version}`);
  }
  if (channel === "stable" && isPrereleaseVersion(options.version)) {
    // The guard that keeps a candidate away from everyone who did not ask for one.
    throw new Error(
      `refusing to write the stable formula for pre-release ${options.version} — ` +
        `release candidates ship only as jt-rc`,
    );
  }
  if (!SHA256_PATTERN.test(options.arm64Sha256)) {
    throw new Error("arm64 SHA-256 must be 64 lowercase hexadecimal characters");
  }
  if (!SHA256_PATTERN.test(options.x86_64Sha256)) {
    throw new Error("x86_64 SHA-256 must be 64 lowercase hexadecimal characters");
  }

  const rc = channel === "rc";
  // Homebrew reads "0.6.0" out of a v0.6.0-rc.1 download URL, so the candidate
  // formula states its version outright; otherwise `brew upgrade` could never tell
  // one candidate from the next.
  const versionLine = rc ? `\n  version "${options.version}"` : "";
  const other = rc ? "jt" : "jt-rc";

  return `class ${rc ? "JtRc" : "Jt"} < Formula
  desc "${rc ? "Jira as a remote VCS for agent workflows (release candidates)" : "Jira as a remote VCS for agent workflows"}"
  homepage "https://github.com/owenoclee/jt"
  url on_arch_conditional(
    arm:   "https://github.com/owenoclee/jt/releases/download/v${options.version}/jt-aarch64-apple-darwin.tar.gz",
    intel: "https://github.com/owenoclee/jt/releases/download/v${options.version}/jt-x86_64-apple-darwin.tar.gz",
  )${versionLine}
  sha256 on_arch_conditional(
    arm:   "${options.arm64Sha256}",
    intel: "${options.x86_64Sha256}",
  )
  license "MIT"

  depends_on :macos

  conflicts_with "${TAP}/${other}", because: "both install a \`jt\` binary"

  def install
    bin.install "jt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/jt --version")
  end
end
`;
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index === -1 || !value || value.startsWith("--")) {
    throw new Error(`missing ${flag}`);
  }
  return value;
}

if (import.meta.main) {
  const output = valueAfter(Deno.args, "--output");
  const channel = Deno.args.includes("--channel") ? valueAfter(Deno.args, "--channel") : "stable";
  if (channel !== "stable" && channel !== "rc") {
    throw new Error(`--channel must be stable or rc, not ${channel}`);
  }
  const formula = renderHomebrewFormula({
    version: valueAfter(Deno.args, "--version"),
    arm64Sha256: valueAfter(Deno.args, "--arm64-sha256"),
    x86_64Sha256: valueAfter(Deno.args, "--x86-64-sha256"),
    channel,
  });

  await Deno.mkdir(dirname(output), { recursive: true });
  await Deno.writeTextFile(output, formula);
}
