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
the command answers with its own remedy instead of a version — and that remedy is the fix,
verbatim:

```
cd node_modules/glasspane-harness && node postinstall.mjs
```

Run it from wherever the package manager put the package (`bun` puts global packages under
`$HOME/node_modules`). Verified: after it, `glasspane-harness --version` reports the
version. With npm 11+ the same gating shows up as an `allow-scripts` warning on a first
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

The `curl` channel runs both of those itself. What it does with each outcome is the part
worth knowing: a release that publishes no `.asc`, or a machine with no `gpg`, is a policy
gap — it warns, names the gap, and installs, because an unsigned release is not evidence
of tampering. A signature that **does not verify**, one made by a key other than the
fingerprint the installer itself carries, or a signature fetch
that fails for a reason that is not 404, is a tampering signal — it refuses and exits.
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
