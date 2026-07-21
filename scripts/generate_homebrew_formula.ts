import { dirname } from "@std/path";

interface FormulaOptions {
  version: string;
  arm64Sha256: string;
  x86_64Sha256: string;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function renderHomebrewFormula(options: FormulaOptions): string {
  if (!VERSION_PATTERN.test(options.version)) {
    throw new Error(`invalid version: ${options.version}`);
  }
  if (!SHA256_PATTERN.test(options.arm64Sha256)) {
    throw new Error("arm64 SHA-256 must be 64 lowercase hexadecimal characters");
  }
  if (!SHA256_PATTERN.test(options.x86_64Sha256)) {
    throw new Error("x86_64 SHA-256 must be 64 lowercase hexadecimal characters");
  }

  return `class Jt < Formula
  desc "Jira as a remote VCS for agent workflows"
  homepage "https://github.com/owenoclee/jt"
  url on_arch_conditional(
    arm:   "https://github.com/owenoclee/jt/releases/download/v${options.version}/jt-aarch64-apple-darwin.tar.gz",
    intel: "https://github.com/owenoclee/jt/releases/download/v${options.version}/jt-x86_64-apple-darwin.tar.gz",
  )
  sha256 on_arch_conditional(
    arm:   "${options.arm64Sha256}",
    intel: "${options.x86_64Sha256}",
  )
  license "MIT"

  depends_on :macos

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
  const formula = renderHomebrewFormula({
    version: valueAfter(Deno.args, "--version"),
    arm64Sha256: valueAfter(Deno.args, "--arm64-sha256"),
    x86_64Sha256: valueAfter(Deno.args, "--x86-64-sha256"),
  });

  await Deno.mkdir(dirname(output), { recursive: true });
  await Deno.writeTextFile(output, formula);
}
