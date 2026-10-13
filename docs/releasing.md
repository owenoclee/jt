# Releasing jt

Releases are built by GitHub Actions when a `v*` tag is pushed. The tag must match the `VERSION`
constant in `src/version.ts` exactly (for example, tag `v0.6.0` for `VERSION = "0.6.0"`).

The release workflow:

1. Runs the test suite.
2. Compiles Linux and macOS executables for x86-64 and ARM64.
3. Publishes `.tar.gz` archives and `SHA256SUMS`.
4. Updates the formulae in `owenoclee/homebrew-tap` with the macOS archive checksums.

## Stable releases and release candidates

The version decides the channel. Only two shapes are accepted; the workflow fails on anything else.

| Version      | GitHub release           | `Formula/jt.rb` | `Formula/jt-rc.rb` |
| ------------ | ------------------------ | --------------- | ------------------ |
| `0.6.0`      | normal, marked latest    | updated         | updated            |
| `0.6.0-rc.1` | pre-release, not latest  | **untouched**   | updated            |

To cut a candidate, set `VERSION = "0.6.0-rc.1"`, commit, and push the tag `v0.6.0-rc.1`. To ship it,
set `VERSION = "0.6.0"` and push `v0.6.0`.

A release candidate reaches nobody who did not ask for one:

- `brew install owenoclee/tap/jt` and `brew upgrade` only ever see `jt.rb`, which a candidate never
  changes. The formula generator independently refuses to write a pre-release version into it.
- The GitHub release is flagged as a pre-release, so `releases/latest` — the README's download
  link — still resolves to the last stable version.
- A stable build's update notice only compares against stable releases.

### Why a second formula

Homebrew has no per-formula "opt in to pre-releases" switch: the `devel` spec was removed, and
`--HEAD` means building from source, which a prebuilt-binary formula cannot offer. The supported way
to offer a pre-release channel is a separate formula, so installing it *is* the opt-in:

```sh
brew install owenoclee/tap/jt-rc     # after: brew uninstall jt
```

`jt-rc` and `jt` both install a `jt` binary, so each declares the other with `conflicts_with` and
Homebrew refuses to link both. `jt-rc` follows every release, stable ones included, so a tester is
moved forward to `0.6.0` when it ships rather than left on `0.6.0-rc.2`; `brew upgrade` orders the
versions correctly (`0.6.0-rc.1` < `0.6.0-rc.2` < `0.6.0`). Because Homebrew reads `0.6.0` out of a
`v0.6.0-rc.1` download URL, `jt-rc.rb` states its `version` explicitly.

To go back to stable: `brew uninstall jt-rc && brew install owenoclee/tap/jt`.

The first release cut with this workflow creates `Formula/jt-rc.rb` in the tap.

## Homebrew tap authentication

The `jt` repository has an Actions secret named `HOMEBREW_TAP_DEPLOY_KEY`. Its public key is
configured as a write-enabled deploy key on `owenoclee/homebrew-tap`. This gives the release job
write access only to the tap rather than storing a general-purpose personal access token.

If the key ever needs rotating, generate a new Ed25519 key pair, replace the tap's write-enabled
deploy key, and replace the Actions secret with the private key.
