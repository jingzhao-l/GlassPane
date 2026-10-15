# Install

## Channels

All channels are macOS-only (see [Platform support](index.md#platform-support)).

```bash
npm install -g glasspane-harness     # recommended; installs the wrapper + your Mac's package
bun add -g glasspane-harness
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.sh | bash
```

Both commands are available afterwards: `glasspane-harness` and `gp-harness`.

One caveat that is the package manager's, not the product's: the wrapper's `postinstall`
is what copies the real binary into place, and some managers do not run install scripts
by default. Measured with 0.7.0: `bun add -g` installs the package and skips that step, so
the command answers with its own remedy instead of a version. From 0.7.7 that remedy names
**this install's own directory**, so the printed line is the fix verbatim — measured from an
unrelated working directory (`/`), where the answer was

```
cd "/Users/you/node_modules/glasspane-harness" && node postinstall.mjs
```

(`bun` put the global package under `$HOME/node_modules` on that machine), and running it
left `glasspane-harness --version` reporting the version. On 0.7.6 and earlier the same
message named a path relative to a project root — a global install has no such place, so the
line only worked if you happened to already stand in the right directory. The message also
offers `bun pm trust glasspane-harness`, measured to run the same postinstall for a project
install. With npm 11+ the same gating shows up as an `allow-scripts` warning on a first
install; there the install still completes and the command works (also measured), and the
one-click installer retries with `--allow-scripts` when npm refuses.

If npm's global prefix is not writable, either use the one-click installer (it falls back
to a per-user install root) or:

```bash
npm install -g --prefix "$HOME/.local" glasspane-harness
export PATH="$HOME/.local/bin:$PATH"
```

## Prerequisites

- **macOS 13+ only** (Apple silicon or Intel). The package declares `os: darwin`, so npm
  refuses the install on Linux or Windows — deliberately: the engine, the permission model
  and the evidence pipeline are macOS, and no other build exists or is planned.
- Node 18+ (only for the npm path), and a shell for the one-click path.
- For the `gp_*` tools: the **GlassPane** background service, running, with Accessibility
  granted. Without it every tool call answers `GP_E_ENGINE_UNREACHABLE` with a remedy —
  that is the engine speaking, not a broken install.

## Verify

```bash
glasspane-harness --version        # the product's manifest version, verbatim
gp-harness --version               # the second shipped command, same binary
```

Then, inside a session, ask for `gp_probe_status`. It reports the engine version,
advertised capabilities, and the four permission seats. Every remedy the tool surface
emits points back at that call, so it is the first thing to read when something is off.

A version that prints is not evidence the bytes are the bytes that were published, so the
two delivery channels each have their own check. Neither one runs on your behalf unless
you ask:

```bash
# npm channel — does the registry vouch for these bytes, and is there an attestation?
npm audit signatures --prefix "$(npm prefix -g)"

# release-asset channel — checksum, then signature, then *which key* made it
shasum -a 256 -c SHA256SUMS.txt
gpg --verify glasspane-harness-darwin-arm64.zip.asc glasspane-harness-darwin-arm64.zip
```

The `curl` channel runs both of those itself, and it stops when either one cannot be done.
A release that publishes no `SHA256SUMS.txt` or no `.asc` is refused rather than warned about:
this product's release lane writes a manifest covering every target and signs each asset, and it
fails the run if either is missing — so their absence describes a broken or replaced release, not
a policy the installer gets to waive. A signature that does not verify, or one made by a key other
than the fingerprint the installer carries, is refused for the same reason. The installer also keeps
"this release has no manifest" apart from "I could not read the manifest": a blocked fetch (a proxy
that re-signs TLS, a 403, an HTTP 200 carrying HTML) is reported as a fetch failure, never as an
unpublished release.

Only you can decide to install anyway, and saying so is an explicit act:

```bash
GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.sh | bash
```

The install summary then names the override in the state it prints
(`sha256: skipped by GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1`), so the log of that run cannot be read
later as a verified install. A machine with no `gpg` still installs after the checksum passes and
says its provenance was skipped — that is a missing tool, not a missing signature.

That distinction matters because `SHA256SUMS.txt` is downloaded from the same origin as the
asset it lists, so on its own it cannot survive a swapped release; the signature is the one
check whose answer the other side cannot produce.

The web app is embedded: `glasspane-harness serve --port 4096` serves it from the same
process (a build made with `--skip-embed-web-ui` starts and says the UI is absent).

## Uninstall

```bash
glasspane-harness uninstall        # removes the CLI and its local state
npm uninstall -g glasspane-harness # or remove the package directly
```

Local state lives under `~/.glasspane-harness` (and `~/.config/glasspane-harness`).
A legacy `~/.config/opencode` / `~/.local/share/opencode` from an earlier upstream
install is not read by this product and is not touched by the uninstaller unless you
remove it yourself.
