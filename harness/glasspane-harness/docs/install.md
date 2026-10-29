# Install

## Channels

All channels are macOS-only (see [Platform support](index.md#platform-support)).

```bash
npm install -g glasspane-harness     # recommended; installs the wrapper + your Mac's package
bun add -g glasspane-harness
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/v0.12.5/scripts/install.sh | bash
```

Both commands are available afterwards: `glasspane-harness` and `gp-harness`. The npm and bun
channels get the second name from the wrapper's `bin` map (`packages/opencode/script/publish.ts`
points both entries at the same file); the release asset carries one binary, so on the one-click
channel `scripts/install.sh` creates the alias beside it and refuses the install when that name is
not executable.

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
advertised capabilities, and the macOS permission seats the daemon measures. Every remedy
the tool surface emits points back at that call, so it is the first thing to read when
something is off. The set of seats is the engine's to decide — this page deliberately does
not count them, because a documented number is how a renamed seat turns into a lie.

A version that prints is not evidence the bytes are the bytes that were published, so each
delivery channel has an integrity story of its own. The two commands below are checks on what
you already installed — the installer runs neither of them against your installed tree, so if
you want that answer, ask for it:

```bash
# npm channel — does the registry vouch for these bytes, and is there an attestation?
npm audit signatures --prefix "$(npm prefix -g)"

# release-asset channel — checksum, then signature, then *which key* made it
shasum -a 256 -c SHA256SUMS.txt
gpg --verify glasspane-harness-darwin-arm64.zip.asc glasspane-harness-darwin-arm64.zip
```

The installer's release-asset path runs both of those itself, and it stops when either one cannot
be done.
A release that publishes no `SHA256SUMS.txt` or no `.asc` is refused rather than warned about:
this product's release lane writes a manifest covering every target and signs each asset, and it
fails the run if either is missing — so their absence describes a broken or replaced release, not
a policy the installer gets to waive. A signature that does not verify, or one made by a key other
than the fingerprint the installer carries, is refused for the same reason. The installer also keeps
"this release has no manifest" apart from "I could not read the manifest": a blocked fetch (a proxy
that re-signs TLS, a 403, an HTTP 200 carrying HTML) is reported as a fetch failure, never as an
unpublished release.

The npm path is the other shape, and it is the one `scripts/install.sh` takes first when `npm` is
on `PATH`: it installs from the registry named on the command line, so the integrity evidence is
npm's own `dist.integrity` check against that registry, and the product's signature is not checked
on that channel. The summary line says exactly that, because a line that named only the missing half
would accuse the channel of doing less than it does. The two exit codes carry the difference: **0**
means installed with the evidence this channel can produce, and **3** means installed with nothing
checked at all — which the asset path reaches only under the override below. Widening 3 to cover the
npm path would make the documented one-liner exit nonzero on success, and the first thing a script
does with a nonzero success is add `|| true`, which is how an honest signal becomes noise.

Only you can decide to install anyway, and saying so is an explicit act:

```bash
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/v0.12.5/scripts/install.sh | GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 bash
```

The override has to be set for the shell that reads the script, not for `curl`: a leading
`GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 curl … | bash` binds the variable to `curl` alone, the
piped `bash` never sees it, and the run is refused again by the very line that offered the
escape. If you ran the installer from a file instead, the same override is a normal prefix
(`GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 bash scripts/install.sh`).

The install summary then names the override in the state it prints
(`sha256: skipped by GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1`), so the log of that run cannot be read
later as a verified install. The run also ends with **exit 3** rather than 0 — "installed, not
verified" is a different outcome from "installed, verified", and an agent that scripts this channel
branches on the exit code, not on a sentence. A machine with no `gpg` — which stock macOS is, since it ships no
GnuPG — is refused the same way and is told how to fix it (`brew install gnupg`): a missing tool
is installable, and the provenance check it makes impossible is the one check the other side
cannot fake.

That distinction matters because `SHA256SUMS.txt` is downloaded from the same origin as the
asset it lists, so on its own it cannot survive a swapped release; the signature is the one
check whose answer the other side cannot produce.

The web app is embedded: `glasspane-harness serve --port 4096` serves it from the same
process (a build made with `--skip-embed-web-ui` starts and says the UI is absent).
## Uninstall

```bash
glasspane-harness uninstall        # removes local state; removes the package where a
                                   # package manager owns it
npm uninstall -g glasspane-harness # or remove the package directly
```

What the command does is per channel, and `packages/opencode/src/cli/cmd/uninstall.ts` is the
authority for it:

- **npm / pnpm / bun**: deletes the local-state roots named below, then runs that package
  manager's own removal — `npm uninstall -g glasspane-harness`,
  `pnpm uninstall -g glasspane-harness` or `bun remove -g glasspane-harness`.
- **curl / self-installed binary** (an executable whose path contains `.glasspane-harness/bin`
  or `.local/bin`): deletes the same local-state roots and strips the installer's PATH line out
  of the shell rc file it recognizes, but it does not delete the binary. It prints the two lines
  that do — `rm "<that binary>"`, and, when that directory is a `.glasspane-harness` or
  `.opencode` one, `rmdir "<that bin dir>" 2>/dev/null`. On this channel the command is still on
  PATH until you run them.

`--dry-run` prints the same plan and changes nothing. `--keep-data` and `--keep-config` hold back
those two roots; cache and state are removed on every channel.

Local state lives under the four XDG roots that `packages/core/src/global.ts` names —
`~/.local/share/glasspane-harness` (data), `~/.cache/glasspane-harness` (cache),
`~/.config/glasspane-harness` (config) and `~/.local/state/glasspane-harness` (state), each
one `<xdg-basedir>/glasspane-harness` and each overridable through the matching `XDG_*_HOME`.
`~/.glasspane-harness/bin` is a different thing: it is the one-click installer's *fallback bin
root* (`scripts/install.sh`, `INSTALL_ROOT`, overridable with `GLASSPANE_HARNESS_HOME`), and no
local state is written there.
A legacy `~/.config/opencode` / `~/.local/share/opencode` from an earlier upstream
install is not read by this product and is not touched by the uninstaller unless you
remove it yourself.
