# GlassPane

**English** · [简体中文](./README.zh-CN.md)

[![npm: glasspane-mcp](https://img.shields.io/npm/v/glasspane-mcp)](https://www.npmjs.com/package/glasspane-mcp)
[![npm: glasspane-install](https://img.shields.io/npm/v/glasspane-install)](https://www.npmjs.com/package/glasspane-install)
![license: MIT](https://img.shields.io/badge/license-MIT-green)
[![CI](https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml/badge.svg)](https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/jingzhao-l/GlassPane)](https://github.com/jingzhao-l/GlassPane/releases)

<center>
  <strong>A runtime verification engine that makes AI agents on macOS prove what they claim.</strong>
</center>

An AI agent says "I clicked Save and the setting took effect." Was that actually true?
GlassPane sits between the agent and the operating system: every UI operation it performs
through GlassPane leaves a **replayable evidence pack** — the accessibility tree before and
after, a pixel-difference measurement, an attribution verdict on whether *this* action caused
*this* change, and a checkpoint you can roll back to. Agents get 14 `gp_*` MCP tools; reviewers
get a report that says "unverified" when it cannot prove otherwise.

## Table of Contents

- [What it changes for you](#what-it-changes-for-you)
- [At a glance](#at-a-glance)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Connecting an MCP client](#connecting-an-mcp-client)
- [Tools](#tools)
- [What an evidence pack contains](#what-an-evidence-pack-contains)
- [Permissions and integrity design](#permissions-and-integrity-design)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Security](#security)
- [Directory structure](#directory-structure)
- [Development](#development)
- [Documentation](#documentation)
- [Relationship to the iterate ecosystem](#relationship-to-the-iterate-ecosystem)
- [Disclaimer](#disclaimer)
- [License](#license)

## What it changes for you

Without GlassPane, an agent driving a macOS app has one signal: the exit status of whatever it
typed. Accessibility APIs often return success for a call that changed nothing on screen, so the
agent reports "done", and the discrepancy surfaces days later in someone else's screenshot.

With GlassPane, the same operation goes through `gp_act`, and the answer comes back with
evidence attached: which element was targeted, what the tree looked like either side of it, how
many pixels moved, whether a concurrent human hand touched the app mid-operation, and how to undo it.

## At a glance

- **14 MCP tools, any MCP client** — Claude Desktop, Cursor, and other MCP hosts over stdio.
- **Act and confirm in one call** — `gp_act` performs an accessibility action and measures the
  result, so "the click did nothing" is a returned fact rather than an argument.
- **Attribution, not just observation** — `gp_diagnose` classifies a non-effecting operation:
  tree unchanged, change late, or contaminated by concurrent input.
- **Checkpoints and rollback** — `gp_snapshot` records a baseline; `gp_restore` replays action
  steps back to it, or diffs the current tree against it.
- **Evidence you can hand to a reviewer** — `gp_export_evidence` / `gp_recent_reports` render
  JSON, HTML or Markdown audit views; evidence packs are stored per operation.
- **Optional in-app probe for strong attribution** — [GlassPaneProbe](engine/probe) is a small
  Swift package an app can embed; with a live probe, attribution upgrades from "plausibly caused"
  to "caused, and here is the handler that ran".
- **LLDB bridge for the hard cases** — [bridge/](bridge) attaches to a running process to capture
  crash and runtime context that the accessibility layer cannot see.
- **Honest by construction** — the daemon reports permissions and state *as itself*; anything it
  cannot measure is shown as unverified and is never lit up to look good.

## Quick start

**1. Install** (macOS 14+; clones the pinned release tag, so the build is reproducible):

```bash
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh
```

**2. Grant permissions** in System Settings when the panel opens — Accessibility, Input
Monitoring, Screen Recording — for **`GlassPane Daemon`**. This is the one step that cannot be
automated; the panel drives you card by card and re-measures after each tick.

**3. Tell your MCP client about it** — the installer prints a ready-to-paste block with your real
paths at the end of the install. It looks like this:

```json
{
  "mcpServers": {
    "glasspane": {
      "command": "node",
      "args": ["<your checkout>/mcp-shell/dist/index.js"],
      "env": { "GLASSPANE_ENGINE_SOCK": "/Users/you/.glasspane/engine.sock" }
    }
  }
}
```

**4. Ask the agent to prove something.** In your MCP client:

> Attach to System Settings, find the Dark Mode checkbox, toggle it with `gp_act`, and show me the evidence that it changed.

A successful call returns the attribution verdict plus the before/after delta;
`gp_export_evidence` turns it into a report you can read or archive.

## Installation

### Requirements

| Requirement | Used for | Check |
|---|---|---|
| macOS 14+ | the engine (Accessibility / HID / Screen Recording APIs) | `sw_vers -productVersion` |
| Xcode Command Line Tools | building the Swift engine | `swift --version` |
| Node.js ≥ 18 | MCP shell + installer | `node --version` |
| git | fetching the source | `git --version` |
| Python 3.11 | LLDB bridge test suite only | `python3 --version` |

The installer probes each of these for real and stops with a per-item report if one is missing;
there is no "assume it's there" path.

### Channels

All three reach the same code path, and the two one-command channels clone the **same pinned
release tag** rather than a moving branch:

```bash
# 1) One-liner
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh

# 2) Through npm, no clone needed up front
npx glasspane-install

# 3) From a checkout you manage yourself
git clone --branch v1.1.0 https://github.com/jingzhao-l/GlassPane.git && cd GlassPane && node installer/cli.js
```

Set `GLASSPANE_REF=<tag>` to pick another release, or `GLASSPANE_REF=main` to track the trunk
(not recommended — `main` is not a fixed artifact). `--no-prompt --no-gui` gives a silent install;
`--help` lists every flag.

### What you have to do by hand

Two things, and only two:

1. **TCC permission ticks.** macOS does not allow programmatic granting. The grant subject is the
   daemon bundle (`GlassPane Daemon`), never your terminal and never the settings window.
2. **Confirming a destructive step** — replacing an older running instance.

### First launch and Gatekeeper

**Read this before installing on someone else's machine.** Builds are signed ad-hoc
(`codesign --sign -`), not with a Developer ID certificate, and are not notarized. On the
author's own machine that is fine; for outside users Gatekeeper will refuse the app on first
launch, and it must be allowed manually under System Settings → Privacy & Security. Notarization
removes that friction and is a pending, cost-gated decision (an Apple Developer Program
membership) — tracked in the [P6 publish record](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md).
We are not going to describe a "one-command install" as frictionless when it has a known manual step in it.

### What gets installed, and how to remove it

| Path | What it is |
|---|---|
| `~/Applications/GlassPane.app` | settings / permission guide panel |
| `~/Applications/GlassPane Daemon.app` | the daemon (the thing you grant TCC permissions to) |
| `~/Library/LaunchAgents/com.glasspane.daemon.plist` | launchd job (start at login) |
| `~/.glasspane/engine.sock` | daemon socket, mode `0600` |
| `~/.glasspane/evidence/` | per-operation evidence packs |
| `~/.glasspane/installer-daemon.log` | installer + daemon log |

```bash
launchctl bootout "gui/$(id -u)/com.glasspane.daemon" 2>/dev/null
rm -f ~/Library/LaunchAgents/com.glasspane.daemon.plist
rm -rf ~/Applications/GlassPane.app ~/Applications/"GlassPane Daemon.app"
rm -rf ~/.glasspane
```

Then remove the `GlassPane Daemon` rows from the four privacy lists in System Settings.
If only the launchd job was lost (it commonly happens while you wait to tick a permission box),
recover it without retyping launchctl incantations:

```bash
node installer/cli.js --restore-launchd
```

## Connecting an MCP client

Two equivalent forms:

```jsonc
// from a checkout — what the installer prints
{ "mcpServers": { "glasspane": { "command": "node", "args": ["/path/to/GlassPane/mcp-shell/dist/index.js"] } } }

// from npm — global install, same tools
{ "mcpServers": { "glasspane": { "command": "glasspane-mcp" } } }
```

`npm i -g glasspane-mcp` installs **only the transport layer**. It still needs the daemon, which
comes from the installer above. When the daemon is unreachable or a permission is missing, tool
calls return a structured error containing the exact remedy command — you should not need to open
a document to get unstuck.

## Tools

Authoritative list is whatever `tools/list` returns at runtime; this table is a map, not a spec.

| Group | Tool | What it does |
|---|---|---|
| Drive | `gp_attach` | Attach the engine to a running app by `bundleId` or `pid` |
| | `gp_observe` | Snapshot the attached app's accessibility tree |
| | `gp_act` | Perform an accessibility action (`press`, `increment`, `decrement`, `showMenu`, `confirm`, `cancel`, `pick`) and confirm the effect |
| Check | `gp_assert_element` | Assert an element's property — present, enabled, value as expected |
| | `gp_diagnose` | Classify why an operation didn't take: no change / late change / concurrent-input contamination |
| Evidence | `gp_last_evidence` | Full evidence pack for the latest (or a given) operation |
| | `gp_export_evidence` | Render one operation's pack as an HTML or Markdown audit report |
| | `gp_recent_reports` | Aggregate the last N operations into one audit view |
| Rollback | `gp_snapshot` | Capture a digest-only baseline of the tree |
| | `gp_restore` | Replay act steps back to the baseline, or diff against it |
| Probe | `gp_probe_status` | Which attached apps have a live `GlassPaneProbe`, and what it reported |
| Projects | `gp_project_list` / `gp_project_set` / `gp_project_get` | Register and read project-scoped configuration |

Note that `gp_act` drives the accessibility API's own action verbs; it does not write element
values directly and does not post synthesized HID events. Sliders and steppers change value
because `increment` / `decrement` are legal accessibility actions.

## What an evidence pack contains

Every operation yields a versioned `glasspane.evidence` pack (JSON, schema in
[kernel/schemas](kernel/schemas)) with:

- the **target selector** — how the element was identified, not just its label;
- **before/after accessibility trees** and the structural diff between them;
- a **pixel-difference measurement** for the affected window region (ratio and bounds; raw
  screenshots are not persisted to disk);
- an **attribution verdict**: `weak` by default, upgraded to `strong` only when a live
  `GlassPaneProbe` in the target app confirms the handler ran;
- a **contamination flag** when other input arrived during the operation;
- the **checkpoint steps** needed for `gp_restore`.

`soft → strong` attribution depends on a probe declaring its own pid, which any same-user process
can do — so a `strong` verdict means "a cooperating app confirmed this", not "this is
cryptographically proven". See [SECURITY.md](SECURITY.md).

## Permissions and integrity design

- State is reported by the **daemon measuring itself**, not inferred by the UI. The settings panel
  never measures on the daemon's behalf and never guesses.
- A permission that cannot be read shows as **unverified**. Nothing lights up to look good; the
  Developer Tools card in particular stays unverified rather than mirroring another card's state.
- The daemon must be started by launchd or a login item for its self-report to equal the real
  TCC seat — an instance started from a terminal inherits the *launcher's* verdict, so the panel
  shows the subject it actually measured.
- Evidence and approval records are hash-chained audit logs, not enforcement: they record what
  happened rather than gating it.

## Troubleshooting and FAQ

**Gatekeeper says the app can't be opened / is from an unidentified developer.**
Expected: builds are ad-hoc signed and not notarized (see
[Installation](#installation)). Allow it under System Settings → Privacy & Security, then reopen.

**The permission card stays red after I ticked it.** The tick probably landed on the wrong
subject — the entry must be `GlassPane Daemon`, not your terminal or `GlassPane.app`. The card
shows the subject it measured; re-run `node installer/cli.js --restore-launchd`, which restarts
the daemon under launchd and re-verifies.

**Tools return errors even though the panel is open.** The panel is not the service. Check the
daemon: `~/.glasspane/engine.sock` should exist and the daemon binary should answer
`--permissions`. If the socket is held by an older build, re-run the installer with
`--replace-daemon` — otherwise the app you granted permission to is not the app doing the work.

**Is anything sent off my machine?** No. The daemon is a local unix socket, the MCP shell is a
local stdio process, and evidence stays under `~/.glasspane/`. Note that `gp_observe` returns
accessibility trees into the agent conversation, so whatever your agent's provider logs, it logs
that tree — treat the transcript as sensitive.

**How do I know which version I'm running?** The daemon self-reports on `--permissions`, the
settings panel shows the same value, `tools/list` echoes it in the MCP `initialize` response, and
`node scripts/check-version.mjs` prints every place the version appears in a build. All of them
come from one number ([CHANGELOG.md](CHANGELOG.md)).

**Which macOS versions are supported?** 14 and later. The engine's real-hardware behaviors
(accessibility timing, event taps, screen recording) are what we test against; earlier releases
are out of scope.

## Security

GlassPane holds Accessibility, Input Monitoring and Screen Recording, registers a launchd job, and
can attach a debugger — it is powerful *and* attack surface. Report vulnerabilities as described in
[SECURITY.md](SECURITY.md); do not open a public issue with logs or evidence packs attached.

## Directory structure

```
GlassPane/
├── install.sh          one-command entry: locates/fetches source, delegates to installer
├── installer/          zero-dependency Node installer → npm `glasspane-install`
├── engine/             Swift package: glasspaned daemon, settings GUI, LLDB-free AX channel
│   ├── probe/          GlassPaneProbe SPM package (embed for strong attribution)
│   └── scripts/        make-app.sh — bundle + ad-hoc sign the two .app products
├── mcp-shell/          TypeScript MCP stdio server → npm `glasspane-mcp`
├── kernel/             JSON Schema truth source, shared with the iterate ecosystem
├── bridge/             Python LLDB bridge (crash/runtime capture)
├── spike/              feasibility experiments and their recorded results
├── scripts/            set-version / check-version — the single version line
├── specs/              implementation specs + acceptance records (P0–P6, PRD)
└── .github/workflows/  ci.yml (5 lanes + publish-shape guard), release.yml
```

## Development

Setup, how to run each test lane, and the commit/PR convention live in
[CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```bash
npm ci && npm run build && npm test --workspaces --if-present   # TS: kernel, mcp-shell, installer
cd engine && swift build && swift test                          # Swift engine + probe
cd bridge && python3 -m pytest -q                               # LLDB bridge
node scripts/check-version.mjs                                  # version-line drift guard
```

CI runs those lanes plus a **publish-shape guard**: it bundles `glasspane-mcp`, packs it,
installs the tarball into a clean directory and completes an MCP `initialize` handshake — because
packaging faults (a dangling `file:` dependency, a missing schema) only ever appear in the
published artifact, never in a local run.

Some acceptance steps cannot run in CI by design: accessibility, event taps and screen recording
need a logged-in GUI session and granted permissions. Those are recorded as real-hardware smoke
runs in [engine/smoke.md](engine/smoke.md) rather than silently skipped.

Release: `node scripts/set-version.mjs <semver>` writes the whole version line, then a tag triggers
a GitHub Release with a source tarball and `SHA256SUMS.txt`; npm publishing goes through
`release.yml` with provenance.

## Documentation

`specs/` is the design-of-record and acceptance ledger (Chinese). It is where claims are specified
and marked verified or not, so it is the closest thing to a reference manual:

| Document | Scope |
|---|---|
| [PRD](specs/GlassPane_PRD_v1.0.md) | product definition |
| [项目综述 5.8](specs/GlassPane_5.8_项目综述文档.md) | latest overall project review |
| [P0](specs/GlassPane_P0_实施规格_v1.0.md) | evidence core: attach / observe / act / attribution |
| [P1](specs/GlassPane_P1_实施规格_v1.2_GUI设置面板.md) | checkpoints, evidence lifecycle, GUI permission panel |
| [P2](specs/GlassPane_P2_实施规格_v2.0_并发归因污染防护.md) | concurrent-attribution contamination guards, degradation detection |
| [P3](specs/GlassPane_P3_实施规格_v3.0_三方消费者一致性.md) | consumer consistency, MCP message layer, bridge form |
| [P4](specs/GlassPane_P4_实施规格_v4.0_收口与里程碑一致性.md) | milestone closeout, npm naming decision, one-command install |
| [P5](specs/GlassPane_P5_实施规格_v5.0_方向候选四连批.md) | direction candidates |
| [P6](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md) | probe SDK, LLDB bridge, public publish record |

## Relationship to the iterate ecosystem

`kernel/` is the shared schema contract layer of the author's
[iterate](https://github.com/jingzhao-l/iterate-skill) ecosystem (`@iterate/kernel`): the same
JSON Schema definitions are consumed by iterate's review loop and by the GlassPane daemon and MCP
shell, with dual-language bindings checked against shared fixtures. GlassPane is the runtime
verification half of that pair — iterate reviews whether code is right; GlassPane proves whether an
agent's claimed UI effect actually happened. At publish time the kernel is bundled into
`glasspane-mcp`, so the npm package carries no `file:` dependency back to this repository.

## Disclaimer

GlassPane drives real applications on a real desktop, with permissions that let it read the
screen and act on other apps' UI. Run it on apps you intend to control, keep the evidence
directory out of shared locations, and treat exported reports as containing whatever was on screen.
Attribution verdicts are measurements and inferences, not a guarantee about a program's internals —
an app that lies about its own accessibility tree can still mislead any observer, which is exactly
why the probe path exists.

## License

MIT — see [LICENSE](LICENSE).
