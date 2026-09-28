# Migrate from opencode

If you used an upstream `opencode` install (or a build of this fork before the
private customisation), here is the rename map. Nothing in the agent's behaviour changed
except what this table lists; the evidence surface is additive.

## Names

| Before | After |
|---|---|
| `opencode` binary, `opencode-ai` npm package | `glasspane-harness` / `gp-harness` binaries, `glasspane-harness` npm package (+ `glasspane-harness-<platform>`) |
| `~/.local/share/opencode`, `~/.config/opencode` | `~/.glasspane-harness` equivalents (the old ones are not read; the uninstaller can remove them) |
| `opencode.json(c)` project config | `glasspane-harness.json(c)` — the old names are still read as legacy fallbacks |
| `.opencode/` project directory | `.glasspane-harness/` — `.opencode/` is still read, and when both exist the product's directory wins the merge. (This repository dogfoods the rule: its own agent/command/skill config lives in `.glasspane-harness/`.) |
| `x-opencode-directory` header, `OPENCODE_*` env vars | unchanged (kept as lineage identifiers on purpose) |
| `@opencode-ai/*` workspace packages | unchanged (same reason) |

## Commands and behaviour

- `--version` now prints the product's manifest version verbatim. (It used to inherit
  upstream's release-time patch bump and could print a version that was never built.)
- `upgrade` / `uninstall` act on the product package. The curl self-upgrade path is gone:
  it used to fetch and execute `opencode.ai/install`; use `npm install -g glasspane-harness`
  or `scripts/install.sh`.
- The hosted console / enterprise stack and the publishing paths that pushed to upstream
  registries (docker, AUR, Homebrew tap) are gone from this product.
- **There is no account to log into, and no first-party model gateway** (0.4.0). Removed:
  `auth login` / `logout` / `switch`, the `/org` command and org switcher, the
  `/experimental/console*` endpoints and console-managed-provider state, session sharing to
  opencode's cloud (plus the `share` / `autoshare` config keys), and the `opencode` entry
  in the model catalog. Every other provider and model is unchanged and runs on **your own
  API key** — see [`models-and-keys.md`](models-and-keys.md). If your workflow used
  `opencode auth login` or a console share link, the replacement is an API key (env var,
  `{env:NAME}` in the config file, or `/connect`) and, for sharing, exporting the session
  to a JSON file and importing it with `glasspane-harness import <file>`.

## Kept deliberately

The agent loop, provider integrations, sessions, permissions, the TUI, the web app and the
SDK/plugin surfaces are upstream's, at tag `v1.18.32` — the account surface above is the
only capability-shaped removal, and it is a vendor login rather than a capability. `FORK.md` and `SYNCLOG.md` record
every customisation commit (`[gp]` prefix) with its measurements, so a future sync is a
diff you can read rather than a claim.
