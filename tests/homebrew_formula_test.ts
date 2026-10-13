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
  assertStringIncludes(formula, "class Jt < Formula");
  assertStringIncludes(formula, 'conflicts_with "owenoclee/tap/jt-rc"');
  assertEquals(formula.includes("\n  version "), false, "stable versions are read from the URL");
  assertEquals(formula.endsWith("\n"), true);
});

Deno.test("release candidates get their own opt-in formula, never the stable one", () => {
  const rc = renderHomebrewFormula({
    version: "1.3.0-rc.2",
    arm64Sha256: ARM_SHA,
    x86_64Sha256: INTEL_SHA,
    channel: "rc",
  });
  assertStringIncludes(rc, "class JtRc < Formula");
  assertStringIncludes(rc, "releases/download/v1.3.0-rc.2/jt-aarch64-apple-darwin.tar.gz");
  // Homebrew would read "1.3.0" out of that URL; the candidate must say what it is.
  assertStringIncludes(rc, 'version "1.3.0-rc.2"');
  assertStringIncludes(rc, 'conflicts_with "owenoclee/tap/jt"');
  assertStringIncludes(rc, 'bin.install "jt"');

  // The rc channel also carries stable releases, so testers are moved forward.
  assertStringIncludes(
    renderHomebrewFormula({
      version: "1.3.0",
      arm64Sha256: ARM_SHA,
      x86_64Sha256: INTEL_SHA,
      channel: "rc",
    }),
    'version "1.3.0"',
  );

  assertThrows(
    () =>
      renderHomebrewFormula({
        version: "1.3.0-rc.2",
        arm64Sha256: ARM_SHA,
        x86_64Sha256: INTEL_SHA,
      }),
    Error,
    "refusing to write the stable formula",
  );
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
