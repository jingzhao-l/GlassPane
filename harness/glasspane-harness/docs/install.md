# Install

## Channels

```bash
npm install -g glasspane-harness     # recommended; installs the wrapper + your platform's package
bun add -g glasspane-harness
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.sh | bash
irm https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.ps1 | iex
```

Both commands are available afterwards: `glasspane-harness` and `gp-harness`.

If npm's global prefix is not writable, either use the one-click installer (it falls back
to a per-user install root) or:

```bash
npm install -g --prefix "$HOME/.local" glasspane-harness
export PATH="$HOME/.local/bin:$PATH"
```

## Prerequisites

- macOS 13+ (the engine is macOS-only today; on other systems the harness runs as a client
  against a macOS host).
- Node 18+ (only for the npm path), and a shell for the one-click path.
- For the `gp_*` tools: the **GlassPane** background service, running, with Accessibility
  granted. Without it every tool call answers `GP_E_ENGINE_UNREACHABLE` with a remedy —
  that is the engine speaking, not a broken install.

## Verify

```bash
glasspane-harness --version        # the product's manifest version, verbatim
```

Then, inside a session, ask for `gp_probe_status`. It reports the engine version,
advertised capabilities, and the four permission seats. Every remedy the tool surface
emits points back at that call, so it is the first thing to read when something is off.

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
