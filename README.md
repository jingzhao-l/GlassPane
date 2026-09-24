# GlassPane

**English** · [简体中文](./README.zh-CN.md)

[![npm: glasspane-mcp](https://img.shields.io/npm/v/glasspane-mcp)](https://www.npmjs.com/package/glasspane-mcp)
[![npm: glasspane-install](https://img.shields.io/npm/v/glasspane-install)](https://www.npmjs.com/package/glasspane-install)
[![downloads: glasspane-mcp](https://img.shields.io/npm/dm/glasspane-mcp?label=glasspane-mcp%20dl%2Fmo)](https://www.npmjs.com/package/glasspane-mcp)
[![downloads: glasspane-install](https://img.shields.io/npm/dm/glasspane-install?label=glasspane-install%20dl%2Fmo)](https://www.npmjs.com/package/glasspane-install)
![license: MIT](https://img.shields.io/badge/license-MIT-green)
[![CI](https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml/badge.svg)](https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/jingzhao-l/GlassPane)](https://github.com/jingzhao-l/GlassPane/releases)

<center>
  <strong>GUI testing and verification for AI coding agents on macOS.</strong><br/>
  Let your agent drive the app, assert what actually changed, and prove it — instead of sending you a screenshot.
</center>

Your AI agent can write the code, run the linter, and pass the unit tests. It cannot tell you whether
the settings toggle it clicked actually flipped — because for a GUI app, the agent has no way to
*observe* the interface. So either it declares success unverified, or it grabs a screenshot and
guesses at pixel coordinates.

GlassPane supplies that missing half of the loop. It exposes a macOS app's interface as a
structured, scriptable test surface over MCP: your agent performs an accessibility action and gets
back **the change it caused** — an element-identified tree diff and a numeric pixel measurement —
not an image it has to squint at. It can assert element state, roll the app back to a checkpoint,
and export evidence a human can audit. Build → reach a state → operate → observe → diagnose → fix →
re-verify, without a human in the middle of every round.

## Table of Contents

- [The problem it solves](#the-problem-it-solves)
- [Why not screenshots](#why-not-screenshots)
- [At a glance](#at-a-glance)
- [Quick start](#quick-start)
- [Installation](#installation)
- [What it cannot do](#what-it-cannot-do)
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

## The problem it solves

On macOS, an agent's toolchain covers the static half of development well: compile, type-check,
review, run tests that live in the terminal. The runtime half of a GUI app is where it falls off a
cliff:

| The loop | Who can do it today |
|---|---|
| write code → static review → unit tests | agent, already fine |
| build → launch app → reach a UI state → operate → **observe** → diagnose → fix → re-verify | **missing**, or done by screenshot + vision model |

Without the second row you don't have an autonomous macOS developer, you have a code typist that
reports optimistically. The consequences are concrete: "the checkbox is wired up" turns out to mean
the action handler never fired; a layout regression ships because nobody looked; a fix is applied
three times because the agent can't see that the first two didn't take.

GlassPane gives the agent eyes and hands with an accountability trail:

- **hands** — `gp_act` performs an accessibility action on an element it identified by role/title/
  hierarchy, and reports whether the UI responded;
- **eyes** — `gp_observe` returns the accessibility tree; `gp_assert_element` checks a property
  (present / enabled / value) as a pass-fail result; the affected window region is measured for
  pixel change;
- **judgement** — `gp_diagnose` classifies a non-effecting operation: nothing changed, it changed
  late, or a concurrent human hand contaminated the measurement;
- **undo** — `gp_snapshot` / `gp_restore` take the app back to a prior state, so the agent can
  re-run a test instead of leaving your machine in a half-configured mess;
- **proof** — `gp_export_evidence` / `gp_recent_reports` render the whole thing as a report you can
  read in a browser or archive next to the commit.

## Why not screenshots

Taking a screenshot and asking a vision model about it is a real option, and it is what most
agent setups fall back to. It is the wrong tool for a verification loop, for reasons that have
nothing to do with model quality:

| | Screenshot + vision | GlassPane |
|---|---|---|
| unit of attention | regions of pixels | named elements (`AXCheckBox "Dark Mode"`, path in the tree) |
| result of an operation | an image to interpret | a structured diff of what changed, plus `changedPixelRatio` and its bounds |
| assertion | "does this look enabled?" | pass/fail on a specific element property |
| cause | assumed | attributed, and upgraded to `strong` when the app embeds [GlassPaneProbe](engine/probe) |
| repeatability | different image each run, different answer | same query, same verdict; diffable reports |
| cost per check | a vision-model round trip per observation | a local accessibility query |
| rollback | none | checkpoint and restore |
| audit trail | your chat log | an evidence pack on disk |

The important line is the last two. A screenshot workflow cannot answer "put it back", and it
cannot answer "show me" without re-opening the conversation.

To be fair about the trade-off: a vision model can still judge things GlassPane does not — visual
taste, whether a design *looks* right, or content in a view that exposes no accessibility tree at
all. GlassPane measures; it does not have taste. Use both for what they are good at.

## At a glance

- **15 MCP tools over stdio** — Claude Desktop, Cursor, or any MCP host; `tools/list` is the
  authoritative surface.
- **Act-and-confirm in one call** — the operation returns the change it produced, so "my click did
  nothing" is a fact in the transcript rather than an argument later.
- **Element-level assertions** — present / enabled / value, as booleans with the selector that was
  resolved.
- **Layout operability audit** — `gp_audit_ui` walks element geometry and applies deterministic
  rules: zero-sized or out-of-window controls are blocking; undersized hit targets, clipped
  elements and overlapping targets are advisory. Geometry it could not read never counts toward a
  `pass`, and a truncated overlap scan says so.
- **Numerical pixel verification** — how much of the target region changed and where, computed
  locally; no screenshot is stored or shipped to a model.
- **Attribution with a strength ladder** — `weak` by default; `strong` when the app under test
  embeds the probe SDK and confirms its own handler ran.
- **Contamination detection** — if a human touches the app mid-operation, the measurement says so
  instead of quietly blaming the agent's click.
- **Checkpoints and rollback** — snapshot a baseline; restore by replaying recorded steps.
- **Crash and runtime capture** — an [LLDB bridge](bridge) attaches to the running process for
  cases the accessibility layer cannot see.
- **Project-scoped configuration** — per-app storage paths, recipes and calibration roots via
  `gp_project_*`.
- **Honest by construction** — anything not measured reports as unverified. Indicators never light
  up to look good, and that applies to the permission panel as much as to a verdict.

## Quick start

**1. Install** (macOS 14+; fetches the pinned release tag, so the build is reproducible):

```bash
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh
```

**2. Grant permissions** when the panel opens — Accessibility, Input Monitoring, Screen Recording —
for **`GlassPane Daemon`**. macOS forbids programmatic granting, so this is the one manual step; the
panel walks you card by card and re-measures after each tick.

**3. Register the MCP server** — the installer prints a ready-to-paste block with your real paths:

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

**4. Give your agent a test job, not a question.** The shape that works:

> Build and launch the app, open Settings, toggle Dark Mode with `gp_act`, assert the checkbox is
> now checked with `gp_assert_element`, and if anything didn't take, `gp_diagnose` it. Roll it back
> afterwards and show me the evidence.

You get a verdict with a before/after delta attached, and a report you can open with
`gp_export_evidence`.

## Installation

### Requirements

| Requirement | Used for | Check |
|---|---|---|
| macOS 14+ | the engine (accessibility / screen capture APIs) | `sw_vers -productVersion` |
| Xcode Command Line Tools | building the Swift engine | `swift --version` |
| Node.js ≥ 18 | MCP shell and installer | `node --version` |
| git | fetching the source | `git --version` |
| Python 3.11 | LLDB bridge test suite only | `python3 --version` |

The installer probes each one for real and stops with a per-item report if something is missing;
there is no "assume present" path.

### Channels

All three reach the same code. The two one-command channels clone the **same pinned release tag**
rather than a moving branch, so two installs on the same day get the same source:

```bash
# 1) One-liner
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh

# 2) Through npm (bootstraps its own clone of the pinned tag)
npx glasspane-install

# 3) From a checkout you manage (v1.1.1 is the tag install.sh currently pins)
git clone --branch v1.1.1 https://github.com/jingzhao-l/GlassPane.git && cd GlassPane && node installer/cli.js
```

`GLASSPANE_REF=<tag>` selects another release; `GLASSPANE_REF=main` tracks the trunk, which is not a
fixed artifact. `--no-prompt --no-gui` is a silent install; `--help` lists every flag.

### What you have to do by hand

1. **TCC permission ticks.** The grant subject is the daemon bundle (`GlassPane Daemon`) — not your
   terminal, not the settings window.
2. **Confirming a destructive step** — replacing an older running instance.

### First launch and Gatekeeper

**Before installing on anyone else's machine:** builds are ad-hoc signed (`codesign --sign -`), not
Developer ID, and not notarized. On your own Mac that is invisible; for outside users Gatekeeper
refuses the first launch until they allow it under System Settings → Privacy & Security.
Notarization removes that step and is a deferred, cost-gated decision (Apple Developer Program
membership) — recorded in the [P6 publish record](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md).
A "one-command install" that has a known manual step in it should say so.

### What gets installed, and how to remove it

| Path | What it is |
|---|---|
| `~/Applications/GlassPane.app` | settings / permission guide panel |
| `~/Applications/GlassPane Daemon.app` | the daemon (the TCC grant subject) |
| `~/Library/LaunchAgents/com.glasspane.daemon.plist` | launchd job (start at login) |
| `~/.glasspane/engine.sock` | daemon socket, mode `0600` |
| `~/.glasspane/evidence/` | per-operation evidence packs |
| `~/.glasspane/installer-daemon.log` | installer and daemon log |

```bash
launchctl bootout "gui/$(id -u)/com.glasspane.daemon" 2>/dev/null
rm -f ~/Library/LaunchAgents/com.glasspane.daemon.plist
rm -rf ~/Applications/GlassPane.app ~/Applications/"GlassPane Daemon.app"
rm -rf ~/.glasspane
```

Then delete the `GlassPane Daemon` rows from the privacy lists in System Settings. If only the
launchd job was lost (common while waiting for a permission tick), recover it without retyping
launchctl:

```bash
node installer/cli.js --restore-launchd
```

## What it cannot do

Stated plainly, because these determine whether it fits your workflow:

- **No headless runs.** Accessibility, event taps and screen capture need a logged-in GUI session.
  It works on a Mac you are signed into — including a dedicated test Mac or a self-hosted runner
  with an active session — not in a container with no window server.
- **Drag gestures cannot be synthesized.** macOS accepts synthesized clicks but not a SwiftUI
  `.onDrag` session (measured, not assumed). Button/menu/value-stepper flows are covered; a
  drag-and-drop-only feature is not drivable yet.
- **Seven accessibility verbs, not arbitrary input.** `gp_act` performs `press`, `increment`,
  `decrement`, `showMenu`, `confirm`, `cancel`, `pick`. It does not write element values directly and
  does not post synthetic HID events, so free-text typing into a field is out of scope.
- **Apps that lie or stay silent.** If a target exposes no useful accessibility tree, structural
  verification is limited to what little it publishes; that is when the probe SDK (or a vision
  model) earns its place.
- **`strong` attribution requires a cooperating app.** It means the app's own embedded probe
  confirmed the handler ran — see [SECURITY.md](SECURITY.md) for what that does and does not prove.

## Connecting an MCP client

Two equivalent forms:

```jsonc
// from a checkout — exactly what the installer prints
{ "mcpServers": { "glasspane": { "command": "node", "args": ["/path/to/GlassPane/mcp-shell/dist/index.js"] } } }

// from npm — same tools, global command
{ "mcpServers": { "glasspane": { "command": "glasspane-mcp" } } }
```

`npm i -g glasspane-mcp` installs **the transport layer only**; the daemon still comes from the
installer above. With the daemon unreachable or a permission missing, tool calls return a structured
error containing the exact remedy command — you should not need a document to get unstuck.

## Tools

`tools/list` at runtime is authoritative; this is a map.

| Group | Tool | What it does |
|---|---|---|
| Drive | `gp_attach` | Attach to a running app by `bundleId` or `pid` |
| | `gp_observe` | Return the attached app's accessibility tree |
| | `gp_act` | Perform one of the 7 accessibility actions and confirm the effect |
| Assert | `gp_assert_element` | Pass/fail on an element property — present, enabled, value |
| | `gp_audit_ui` | Read-only layout audit: element geometry plus deterministic rules, with a `pass` / `advisory` / `blocking` / `insufficient` verdict and its coverage |
| | `gp_diagnose` | Classify a non-effecting operation: no change / late / contaminated |
| Evidence | `gp_last_evidence` | Full evidence pack for the latest (or a given) operation |
| | `gp_export_evidence` | Render one operation as an HTML or Markdown audit report |
| | `gp_recent_reports` | Aggregate the last N operations into one audit view |
| Rollback | `gp_snapshot` | Capture a digest-only baseline of the tree |
| | `gp_restore` | Replay recorded steps back to the baseline, or diff against it |
| Probe | `gp_probe_status` | Which attached apps have a live `GlassPaneProbe`, and what it reported |
| Projects | `gp_project_list` / `gp_project_set` / `gp_project_get` | Register and read per-app configuration |

`gp_audit_ui` records no operation and writes no evidence pack: it measures the interface as it
currently stands, which is why its verdict is allowed to answer `insufficient` instead of
confidently clean. Geometry is deliberately kept out of the tree digest — a hover, an animation or
a moving cursor must not be able to make "did this action change this screen?" answer yes.

## What an evidence pack contains

Each operation produces a versioned `glasspane.evidence` pack (JSON; schema in
[kernel/schemas](kernel/schemas)) holding:

- the **target selector** — how the element was identified, not merely its label;
- **before/after accessibility trees** and the structural diff;
- a **pixel-difference measurement** for the affected window region (`changedPixelRatio` and bounds;
  raw screenshots are not persisted);
- an **attribution verdict** — `weak` by default, `strong` only when a live
  [GlassPaneProbe](engine/probe) in the target app confirms the handler executed;
- a **contamination flag** when other input arrived mid-operation;
- the **checkpoint steps** `gp_restore` replays.

## Permissions and integrity design

- State comes from the **daemon measuring itself**, never inferred by the UI. The settings panel
  does not measure on the daemon's behalf and does not guess.
- Anything unreadable shows as **unverified**. No indicator lights up to look good — the Developer
  Tools card keeps its own measured status rather than borrowing another card's colour.
- The daemon must be started by launchd or a login item for its self-report to equal the real TCC
  seat; an instance started from a terminal inherits the *launcher's* verdict, so the panel shows
  the subject it actually measured.
- Evidence and approval records are hash-chained audit logs. They record what happened; they are not
  an enforcement gate.

## Troubleshooting and FAQ

**Gatekeeper blocks the app / "unidentified developer".** Expected — builds are ad-hoc signed and
notarization is a pending decision (see [Installation](#installation)). Allow it under System
Settings → Privacy & Security, then reopen.

**I ticked the permission and the card is still red.** It was probably ticked for the wrong subject:
the entry must be `GlassPane Daemon`, not your terminal and not `GlassPane.app`. The card shows the
subject it measured; run `node installer/cli.js --restore-launchd` to move the service under launchd
and re-verify.

**Panel is open but tools error.** The panel is not the service. Check that `~/.glasspane/engine.sock`
exists and that the daemon answers `--permissions`. If an older build holds the socket, re-run the
installer with `--replace-daemon` — otherwise the app you granted permission to is not the app doing
the work.

**The agent says the change happened but the UI did not move.** That is the case `gp_diagnose`
exists for; it separates "no structural change", "change arrived late", and "input contamination".
If your feature is drag-only, check [What it cannot do](#what-it-cannot-do) first.

**Does anything leave my machine?** No. Local unix socket, local stdio process, evidence under
`~/.glasspane/`. But `gp_observe` returns accessibility trees *into the agent conversation*, so
whatever your model provider logs, it logs that tree — treat transcripts as sensitive.

**Which version am I running?** The daemon self-reports on `--permissions`, the panel shows the same
value, the MCP `initialize` response echoes it, and `node scripts/check-version.mjs` prints every
place the version appears. All of it comes from one number ([CHANGELOG.md](CHANGELOG.md)).

**Which macOS versions are supported?** 14 and later; that is what the accessibility, event-tap and
screen-capture behaviour is measured against.

## Security

GlassPane holds Accessibility, Input Monitoring and Screen Recording, registers a launchd job, reads
the event stream and can attach a debugger. It is powerful and it is attack surface. How to report a
vulnerability, and the threat model in detail, are in [SECURITY.md](SECURITY.md)
([简体中文](SECURITY.zh-CN.md)). Please don't open a public issue containing logs or evidence packs.

## Directory structure

```
GlassPane/
├── install.sh          one-command entry: locates/fetches source, delegates to installer
├── installer/          zero-dependency Node installer → npm `glasspane-install`
├── engine/             Swift package: glasspaned daemon, settings GUI, accessibility channel
│   ├── probe/          GlassPaneProbe SPM package (embed it for strong attribution)
│   └── scripts/        make-app.sh — bundle + ad-hoc sign the two .app products
├── mcp-shell/          TypeScript MCP stdio server → npm `glasspane-mcp`
├── kernel/             JSON Schema truth source, shared with the iterate ecosystem
├── bridge/             Python LLDB bridge (crash / runtime capture)
├── spike/              feasibility experiments and recorded results
├── scripts/            set-version / check-version — the single version line
├── specs/              implementation specs + acceptance records (PRD, P0–P6, audits)
├── ITERATE.md          this repo's own iterate onboarding knowledge base
└── .github/workflows/  ci.yml (7 lanes + publish-shape guard), release.yml
```

## Development

Setup, the per-layer test commands, the commit and PR conventions, and the rules for writing tests
that must not touch a developer's real `~/.glasspane` are in [CONTRIBUTING.md](CONTRIBUTING.md)
([简体中文](CONTRIBUTING.zh-CN.md)). The short version:

```bash
npm ci && npm run build && npm test --workspaces --if-present   # TS: kernel, mcp-shell, installer
swift build --package-path engine && swift test --package-path engine   # Swift engine
swift test --package-path engine/probe                           # probe SDK
python3 -m pytest -q bridge                                      # LLDB bridge
node scripts/check-version.mjs                                   # version-line drift guard
```

CI also runs a **publish-shape guard**: it bundles `glasspane-mcp`, packs it, installs the tarball
into a clean directory and completes an MCP `initialize` handshake — because packaging faults (a
dangling `file:` dependency, a missing schema) only ever appear in the published artifact.

Acceptance steps that need a real GUI session cannot run in CI by design; they are recorded as
hardware smoke runs in [engine/smoke.md](engine/smoke.md) instead of being silently skipped.

Releases: `node scripts/set-version.mjs <semver>` writes the whole version line; pushing a tag
produces a GitHub Release with a source tarball and `SHA256SUMS.txt`; npm publishing goes through
`release.yml` with provenance.

## Documentation

`specs/` is the design-of-record and the acceptance ledger (Chinese). It is where claims get
specified and marked verified or not, so it is the closest thing to a reference manual:

| Document | Scope |
|---|---|
| [PRD](specs/GlassPane_PRD_v1.0.md) | product definition and the closed-loop argument |
| [项目综述 5.8](specs/GlassPane_5.8_项目综述文档.md) | latest overall project review |
| [P0](specs/GlassPane_P0_实施规格_v1.0.md) | evidence core: attach / observe / act / attribution |
| [P1](specs/GlassPane_P1_实施规格_v1.2_GUI设置面板.md) | checkpoints, evidence lifecycle, GUI permission panel |
| [P2](specs/GlassPane_P2_实施规格_v2.0_并发归因污染防护.md) | concurrent-attribution contamination, degradation detection |
| [P3](specs/GlassPane_P3_实施规格_v3.0_三方消费者一致性.md) | consumer consistency, MCP message layer, bridge form |
| [P4](specs/GlassPane_P4_实施规格_v4.0_收口与里程碑一致性.md) | milestone closeout, npm naming decisions, one-command install |
| [P5](specs/GlassPane_P5_实施规格_v5.0_方向候选四连批.md) | direction candidates |
| [P6](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md) | probe SDK, LLDB bridge, public publish record |
| [Audit 2026-09-22](specs/GlassPane_Audit_2026-09-22_全量审查与UI迭代.md) | full review and UI iteration record |

## Relationship to the iterate ecosystem

`kernel/` is the shared schema contract layer of the author's
[iterate](https://github.com/jingzhao-l/iterate-skill) ecosystem (`@iterate/kernel`): the same JSON
Schema definitions are consumed by iterate's multi-round review loop and by the GlassPane daemon and
MCP shell, with dual-language bindings checked against shared fixtures. The two halves are
complementary — iterate reviews whether the code is right; GlassPane verifies whether the running
app actually does what the agent claims it made it do. At publish time the kernel is bundled into
`glasspane-mcp`, so the npm package carries no `file:` dependency back to this repository.

This repository also dogfoods that ecosystem: [ITERATE.md](ITERATE.md) and
[iterate.config.yaml](iterate.config.yaml) are its own onboarding artifacts, so an `/iterate` run
here reviews code against the same validation commands CI enforces. Verified 2026-09-22:
`iterate doctor` 18 checks ok, `iterate fingerprint` no drift.

## Disclaimer

GlassPane drives real applications on a real desktop with permissions that let it read the screen and
act on other apps' interfaces. Point it at apps you intend to control, keep the evidence directory
out of shared locations, and treat exported reports as containing whatever was on screen. Attribution
verdicts are measurements and inferences, not guarantees about a program's internals — an app that
misreports its own accessibility tree can still mislead any observer, which is why the probe path
exists.

## License

MIT — see [LICENSE](LICENSE).
