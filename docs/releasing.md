# Releasing jt

Releases are built by GitHub Actions when a `v*` tag is pushed. The tag must match the `VERSION`
constant in `src/main.ts` exactly (for example, tag `v0.3.0` for `VERSION = "0.3.0"`).

The release workflow:

1. Runs the test suite.
2. Compiles Linux and macOS executables for x86-64 and ARM64.
3. Publishes `.tar.gz` archives and `SHA256SUMS`.
4. Updates `Formula/jt.rb` in `owenoclee/homebrew-tap` with the macOS archive checksums.

## Homebrew tap authentication

The `jt` repository has an Actions secret named `HOMEBREW_TAP_DEPLOY_KEY`. Its public key is
configured as a write-enabled deploy key on `owenoclee/homebrew-tap`. This gives the release job
write access only to the tap rather than storing a general-purpose personal access token.

If the key ever needs rotating, generate a new Ed25519 key pair, replace the tap's write-enabled
deploy key, and replace the Actions secret with the private key.
