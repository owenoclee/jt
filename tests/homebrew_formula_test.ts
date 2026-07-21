import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { renderHomebrewFormula } from "../scripts/generate_homebrew_formula.ts";

const ARM_SHA = "a".repeat(64);
const INTEL_SHA = "b".repeat(64);

Deno.test("Homebrew formula selects checksummed macOS archives by architecture", () => {
  const formula = renderHomebrewFormula({
    version: "1.2.3",
    arm64Sha256: ARM_SHA,
    x86_64Sha256: INTEL_SHA,
  });

  assertStringIncludes(formula, "url on_arch_conditional(");
  assertStringIncludes(formula, "releases/download/v1.2.3/jt-aarch64-apple-darwin.tar.gz");
  assertStringIncludes(formula, `arm:   "${ARM_SHA}"`);
  assertStringIncludes(formula, "releases/download/v1.2.3/jt-x86_64-apple-darwin.tar.gz");
  assertStringIncludes(formula, `intel: "${INTEL_SHA}"`);
  assertStringIncludes(formula, "depends_on :macos");
  assertStringIncludes(formula, 'bin.install "jt"');
  assertStringIncludes(formula, 'shell_output("#{bin}/jt --version")');
  assertEquals(formula.endsWith("\n"), true);
});

Deno.test("Homebrew formula rejects unsafe release metadata", () => {
  assertThrows(
    () =>
      renderHomebrewFormula({
        version: '1.2.3"\n  system "bad"',
        arm64Sha256: ARM_SHA,
        x86_64Sha256: INTEL_SHA,
      }),
    Error,
    "invalid version",
  );
  assertThrows(
    () =>
      renderHomebrewFormula({
        version: "1.2.3",
        arm64Sha256: "not-a-checksum",
        x86_64Sha256: INTEL_SHA,
      }),
    Error,
    "arm64 SHA-256",
  );
});
