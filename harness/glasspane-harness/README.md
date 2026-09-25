# GlassPane Harness

> Evidence-honest GUI verification harness for macOS apps.
> An [opencode](https://github.com/anomalyco/opencode) fork carrying **GlassPane's** native
> `gp_*` tool surface — the engine decides what happened to an app; the harness shows you.

```
  ██████  ██  █████  ███████ ██████   ██  █████  ██    ██ ███████ ███    ██ ███████ ███████
 ██       ██ ██   ██ ██      ██   ██  ██ ██   ██ ██    ██ ██      ████   ██ ██      ██
 ███████  ██ ███████ █████   ██████   ██ ██   ██ ██    ██ █████   ██ ██  ██ █████   ███████
      ██  ██ ██   ██ ██      ██   ██  ██ ██   ██  ██  ██  ██      ██  ██ ██ ██      ██
 ██████   ██ ██   ██ ███████ ██   ██  ██ █████  ██   ████ ███████ ██   ██ ███████ ███████
```

**What it is.** A coding agent in your terminal (TUI + headless server + `run`), customized
for one job: driving and *verifying* real macOS app interfaces. Instead of an LLM guessing
whether a button worked, the agent calls a Swift engine that captures accessibility-tree
diffs, pixel diffs, crash and responsiveness signals, then reports **the engine's own
attribution** (`strong` / `soft` / `none`, circuit-breaker level, pass/fail/inconclusive) —
never a verdict invented in TypeScript. Every verified call is appended to a hash-chained
decision log, and a compaction hook re-injects those evidence anchors so summarising a
session can never quietly drop the audit chain.

**Product surface: CLI + TUI** (headless `serve`/`run` included). The upstream web UI, desktop
app and hosted console are **not shipped** — they live in the tree for lineage and syncing
only, and the embedded web UI is opt-in via `--embed-web-ui`. Rationale and cost: `FORK.md`.

---

## Install

```bash
# npm (recommended)
npm install -g glasspane-harness

# or bun
bun add -g glasspane-harness

# or one-click (POSIX: npm first, GitHub release asset as fallback)
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.sh | bash

# or one-click (Windows PowerShell)
irm https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.ps1 | iex
```

Both commands are installed: **`glasspane-harness`** and the short alias **`gp-harness`**.

Prerequisites: macOS 13+, and — for the `gp_*` tools — the **GlassPane** background service
running with Accessibility granted. Install GlassPane first
([jingzhao-l/GlassPane](https://github.com/jingzhao-l/GlassPane)); the installer prints the
exact next steps, and the agent can verify the engine with `gp_probe_status`.

## Quick start

```bash
glasspane-harness                       # interactive TUI
glasspane-harness run "attach to Notes, type a heading, and tell me whether the UI proved it"
glasspane-harness serve --port 4096     # headless server for other clients
```

In the TUI, the first thing to ask the agent for is always a `gp_probe_status` — it reports
the engine version, advertised capabilities and permission state, and every remedy the tool
surface emits points back at it.

## The `gp_*` tool surface

| Tool | What it does | Permissions |
|---|---|---|
| `gp_probe_status` | Engine self-report: version, capabilities, accessibility/developer-tools permissions | prompts (diagnostic entry point) |
| `gp_attach` | Attach to a running app by bundle id or pid | prompts |
| `gp_observe` | Snapshot the attached window's accessibility tree (digest, node count) | prompts |

## The evidence discipline (why this fork exists)

1. **Judgement stays in Swift.** Attribution, diagnosis class, circuit-breaker level and the
   pass/fail/inconclusive outcome are computed by the GlassPane engine. The harness
   transcribes; it never derives. (Enforced by a ratchet: `surface-semantics.mjs` fails CI
   when a tool surface grows a threshold, a pixel verdict or a pass/fail synthesis.)
2. **What the model reads is what the engine said.** Error codes and agent-executable
   remedies go into the tool's `output` string, not only into metadata.
3. **The audit chain is a product feature.** Verified calls are appended to a hash-chained
   decision log (op id ↔ entry hash); a fixed-point test re-computes the chain with two
   independent hashers so the ledger can be verified without trusting the writer.
4. **Compaction may not erase evidence.** The compaction hook injects the session's evidence
   anchors into the summarisation prompt; absence is stated as arithmetic
   ("gp_* calls: N · decisions recorded: M"), never assumed.

## Private customisation of the upstream fork

| Changed (product surface) | Kept on purpose (lineage) |
|---|---|
| Product name, binary, bins, npm packages, user agent, mDNS name, state root (`~/.local/share/glasspane-harness`), config file names (`glasspane-harness.json(c)`, upstream names still read), default TUI theme, `--version`/`serve`/upgrade/uninstall wording, README, installer, release pipeline | `@opencode-ai/*` workspace package names, `OPENCODE_*` env var names, protocol/type names, the web UI/app/console sources (not shipped), upstream AGENTS/CONTEXT docs |

`product.json` at this directory's root is the machine-readable truth for the left column;
`harness/tools/product-surface.mjs` fails CI when a script drifts from it, and
`harness/tools/brand-surface.mjs` ratchets brand strings. Upstream is pinned at `v1.18.32`;
every customisation commit carries the `[gp]` prefix, and the divergence surface is measured
(not prose) by `fork-diff`.

## Development

```bash
bun install                       # workspace (on TLS-intercepting networks bun needs
                                  # NODE_EXTRA_CA_CERTS — the reason and the experiment
                                  # are in ../../harness/glasspane-harness/FORK.md)
bun run typecheck                 # per package
bun test --timeout 30000          # fixed-point tests (run inside packages/opencode)
bun run build --single            # product build: CLI+TUI, no web UI embedded
```

The repo-side gates live one level up in `harness/` (hook-liveness, fork-diff,
kernel-vendor, tool-surface, surface-semantics, product-surface, brand-surface) — rationale,
negative controls and known boundaries are documented in `harness/README.md`, `FORK.md` and
`SYNCLOG.md`.

## License & attribution

MIT, like upstream. `LICENSE` is upstream's, unchanged; `NOTICE` records what this fork
changed and where the code came from. Upstream: [anomalyco/opencode](https://github.com/anomalyco/opencode)
`v1.18.32` © SST — without them this product does not exist, and `FORK.md` exists so that
claim stays true for future syncs.

| `gp_act` | Perform one accessibility action and return what the engine observed changing (op id ties it to the evidence pack) | prompts (moves a real app) |
| `gp_diagnose` | Classify an operation from its evidence pack (contaminated / out-of-band / callback / pre-existing / no-change) | prompts |
| `gp_last_evidence` | Fetch the evidence pack the engine archived for an operation | prompts |

Whether a method is available is **read from the running engine** (`hello.capabilities`) —
the list is never hard-coded, because it grows upstream of this file.
