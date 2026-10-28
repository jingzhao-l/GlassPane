# GlassPane

> **English** · [简体中文](./README.zh-CN.md)

<center>
  <strong>GUI testing and verification for AI coding agents on macOS.</strong><br/>
  Let your agent drive the app, assert what actually changed, and prove it — instead of sending you a screenshot.
</center>

<br/>

<p align="center">
  <a href="https://www.npmjs.com/package/glasspane-mcp"><img src="https://img.shields.io/npm/dt/glasspane-mcp?label=Downloads&style=for-the-badge&color=2ea44f&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://github.com/jingzhao-l/GlassPane/releases"><img src="https://img.shields.io/github/v/release/jingzhao-l/GlassPane?style=for-the-badge" alt="GitHub release"></a>
  <a href="https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml"><img src="https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge" alt="License"></a>
  <a href="https://github.com/jingzhao-l/GlassPane"><img src="https://img.shields.io/github/stars/jingzhao-l/GlassPane?style=social&label=Star" alt="GitHub stars"></a>
</p>

> Want to support this project? A GitHub **Star** is the best thank-you and helps more developers discover GlassPane.

---

## Table of Contents

- [About This Project](#about-this-project)
- [At a Glance](#at-a-glance)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Usage](#usage)
- [MCP Tool Reference](#mcp-tool-reference)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [FAQ](#faq)
- [Security](#security)
- [Directory Structure](#directory-structure)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## About This Project

**GlassPane** is a macOS runtime-verification layer for AI coding agents. Your agent can write the code, run the linter, and pass the unit tests. It cannot tell you whether the settings toggle it clicked actually flipped — because for a GUI app, the agent has no way to *observe* the interface. So either it declares success unverified, or it grabs a screenshot and guesses at pixel coordinates.

GlassPane supplies that missing half of the loop. It exposes a macOS app's interface as a structured, scriptable test surface over MCP: your agent performs an accessibility action and gets back **the change it caused** — an element-identified tree diff and a numeric pixel measurement — not an image it has to squint at. It can assert element state, roll the app back to a checkpoint, and export evidence a human can audit. Build → reach a state → operate → observe → diagnose → fix → re-verify, without a human in the middle of every round.

The operating mechanism is a closed loop:

```text
attach → observe → act → measure the change → assert → diagnose if nothing moved
       → roll back to the checkpoint → export the evidence pack
```

### The two GlassPane projects

**GlassPane is one half of a pair.** The other half is **[GlassPane Harness](https://github.com/jingzhao-l/glasspane-harness)**, a coding agent for the terminal that carries the same `gp_*` surface natively. The two projects are installable and usable separately, but they are designed around one contract:

- **this repository — the engine and the transport.** The Swift daemon measures the app; `glasspane-mcp` exposes the measurement over MCP to Claude Desktop, Cursor, or any other MCP host. Install with the one-command installer below.
- **[GlassPane Harness](https://github.com/jingzhao-l/glasspane-harness) — the agent side.** An AI coding agent (an upstream [opencode](https://github.com/anomalyco/opencode) fork) that calls the engine through native `gp_*` tools, appends verified calls to a hash-chained decision log, and re-injects those evidence anchors when a long session is compacted. Install it from npm; it expects the engine to be running with Accessibility granted and prints the exact remedy when it is not.

The division of labour is the same as the one described above: **the engine decides what the application did, and the harness transcribes; it never invents a verdict.** Neither product is a client of the other's private API — both consume the same published contract layer, so the formats that cross the boundary are one definition rather than two files evolving apart. The harness is installable on its own:

```bash
# The agent side. Requires the engine below to be installed and running with Accessibility granted.
npm install -g glasspane-harness
```

> The rest of this document describes **this repository**: the engine, the MCP shell and the installer. The harness has its own README — [GlassPane Harness](https://github.com/jingzhao-l/glasspane-harness) (source [`harness/glasspane-harness/README.md`](harness/glasspane-harness/README.md)).

### The problem it solves

On macOS, an agent's toolchain covers the static half of development well: compile, type-check, review, run tests that live in the terminal. The runtime half of a GUI app is where it falls off a cliff:

| The loop | Who can do it today |
|---|---|
| write code → static review → unit tests | agent, already fine |
| build → launch app → reach a UI state → operate → **observe** → diagnose → fix → re-verify | **missing**, or done by screenshot + vision model |

Without the second row you don't have an autonomous macOS developer, you have a code typist that reports optimistically. The consequences are concrete: "the checkbox is wired up" turns out to mean the action handler never fired; a layout regression ships because nobody looked; a fix is applied three times because the agent can't see that the first two didn't take.

GlassPane gives the agent eyes and hands with an accountability trail:

- **hands** — `gp_act` performs an accessibility action on an element it identified by role/title/hierarchy, and reports whether the UI responded;
- **eyes** — `gp_observe` returns the accessibility tree; `gp_assert_element` checks one of the five element properties (`title` / `value` / `role` / `enabled` / `focused`) as a pass-fail result; the affected window region is measured for pixel change;
- **judgement** — `gp_diagnose` classifies a non-effecting operation: nothing changed, it changed late, or a concurrent human hand contaminated the measurement;
- **undo** — `gp_snapshot` / `gp_restore` take the app back to a prior state, so the agent can re-run a test instead of leaving your machine in a half-configured mess;
- **proof** — `gp_export_evidence` / `gp_recent_reports` render the whole thing as an HTML or Markdown report that comes back as text in the session — they take no path and write no file, so saving it for a browser or beside a commit is your step; the settings panel's report button is the only writer of a report file.

### Why not screenshots

Taking a screenshot and asking a vision model about it is a real option, and it is what most agent setups fall back to. It is the wrong tool for a verification loop, for reasons that have nothing to do with model quality:

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

The important line is the last two. A screenshot workflow cannot answer "put it back", and it cannot answer "show me" without re-opening the conversation.

To be fair about the trade-off: a vision model can still judge things GlassPane does not — visual taste, whether a design *looks* right, or content in a view that exposes no accessibility tree at all. GlassPane measures; it does not have taste. Use both for what they are good at.

### Relationship to the iterate ecosystem

The shared schema contract layer is the author's [iterate](https://github.com/jingzhao-l/iterate-skill) ecosystem kernel, published as [`iterate-kernel`](https://www.npmjs.com/package/iterate-kernel): the same JSON Schema definitions are consumed by iterate's multi-round review loop and by the GlassPane daemon and MCP shell, with dual-language bindings checked against shared fixtures. The two halves are complementary — iterate reviews whether the code is right; GlassPane verifies whether the running app actually does what the agent claims it made it do. Each TypeScript consumer installs that package: `mcp-shell` bundles it into `glasspane-mcp` (so the published artifact carries no `file:` dependency back to this repository), and the fork resolves it through its own lockfile with provenance in `harness/glasspane-harness/contracts/kernel-pin.json`. [kernel/](kernel/) therefore holds only the pinned copy of that package's corpus — `fixtures/` and `schemas/` — because the Swift C35 leg and the release archive's requirement list read those bytes and cannot import TypeScript.

This repository also dogfoods that ecosystem: [ITERATE.md](ITERATE.md) and [iterate.config.yaml](iterate.config.yaml) are its own onboarding artifacts, so an `/iterate` run here reviews code against the same validation commands CI enforces. Verified 2026-09-22: `iterate doctor` 18 checks ok, `iterate fingerprint` no drift.

---

## At a Glance

- **16 MCP tools over stdio** — Claude Desktop, Cursor, or any MCP host; `tools/list` is the authoritative surface.
- **Act-and-confirm in one call** — the operation returns the change it produced, so "my click did nothing" is a fact in the transcript rather than an argument later.
- **Element-level assertions** — one of `title` / `value` / `role` / `enabled` / `focused`, as booleans with the selector that was resolved.
- **Layout operability audit** — `gp_audit_ui` walks element geometry and applies deterministic rules: zero-sized or out-of-window controls are blocking; undersized hit targets, clipped elements and overlapping targets are advisory. Geometry it could not read never counts toward a `pass`, and a truncated or budget-stopped scan says so. On large interfaces the walk can stop early by design; it then reports what it measured plus `complete: false` rather than nothing.
- **Numerical pixel verification** — how much of the target region changed and where, computed locally; that measurement stores no screenshot and ships none to a model.
- **Attribution with a strength ladder** — `soft` by default; `strong` when the app under test embeds the probe SDK and confirms its own handler ran; `weak` only when contamination dominates.
- **Contamination detection** — if a human touches the app mid-operation, the measurement says so instead of quietly blaming the agent's click.
- **Checkpoints and rollback** — snapshot a baseline; restore by replaying recorded steps.
- **Crash and runtime capture** — an [LLDB bridge](bridge) attaches to the running process for cases the accessibility layer cannot see.
- **An explicit visual-review channel** — `gp_capture_view` hands one PNG of the window to *your* model when the question is genuinely visual (does this look right). It is a pass-through: the engine encodes and writes nothing, the image travels into the conversation and stops there.
- **Project-scoped configuration** — per-app storage paths, recipes and calibration roots via `gp_project_*`.
- **Honest by construction** — anything not measured reports as unverified. Indicators never light up to look good, and that applies to the permission panel as much as to a verdict.

---

## Quick Start

### 1. Install

macOS 14+. npm first — one command, and it is also what leaves `glasspane doctor` / `glasspane update`
behind for later:

```bash
npx glasspane-install
```

The same install over the script channel (fetch, then run — two steps on purpose: piped into `sh`, a
failed `curl` leaves stdin empty, `sh` reaches EOF and exits 0, so an install that did nothing reports
success):

```bash
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh
```

Either way it fetches the pinned release tag, so the build is reproducible; see
[Channels](#channels) for the third path and what each one costs.

### 2. Grant permissions

When the panel opens, grant Accessibility, Input Monitoring and Screen Recording for **`GlassPane Daemon`**. macOS forbids programmatic granting, so this is the one manual step; the panel walks you card by card and re-measures after each tick.

### 3. Register the MCP server

The installer prints a ready-to-paste block with your real paths:

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

### 4. Give your agent a test job, not a question

The shape that works:

> Build and launch the app, open Settings, toggle Dark Mode with `gp_act`, assert the checkbox is
> now checked with `gp_assert_element`, and if anything didn't take, `gp_diagnose` it. Roll it back
> afterwards and show me the evidence.

You get a verdict with a before/after delta attached, and a report `gp_export_evidence` returns as HTML/Markdown text in the session (it writes no file — only the panel's report button does).

If you want the agent side of the loop instead of wiring your own host, install [GlassPane Harness](#the-two-glasspane-projects) after step 2.

---

## Installation

### Requirements

| Requirement | Used for | Check |
|---|---|---|
| macOS 14+ | the engine (accessibility / screen capture APIs) | `sw_vers -productVersion` |
| Xcode Command Line Tools | building the Swift engine | `swift --version` |
| Node.js ≥ 18 | MCP shell and installer | `node --version` |
| git | fetching the source | `git --version` |
| Python 3.11 | LLDB bridge test suite only | `python3 --version` |

The installer's preflight probes the rows of this table that name something it can actually ask the host for — the Swift toolchain (`swift`), Node.js ≥ 18 (`node`) and `git` — plus `npm` and `open`, which the table does not list because they are not requirements a person chose to satisfy but parts of what those rows install. In total it checks **five commands**, and `installer/cli.js:PREFLIGHT_PROBED_COMMANDS` is where that count is read from; a missing one stops the install with a per-item report. The `macOS 14+` and `Python 3.11` rows are not probed at install time and the table says how to check them yourself: the macOS major version is enforced when LaunchServices opens the bundle (`LSMinimumSystemVersion` = 14.0), and `python3` is needed only by the LLDB bridge test suite, so a missing one surfaces as that suite failing rather than as an install refusal. For the commands it does probe there is no "assume present" path, and nothing silently stands in for the rows it does not probe — each of those says who checks it.

### Channels

All three reach the same code. The two one-command channels clone the **same pinned release tag** rather than a moving branch, so two installs on the same day get the same source. **npm first**: it is the shortest path, it is the one that also leaves the `glasspane` command on your PATH, and it is the same channel the updater's own remedy hands out when a machine cannot refresh its global layer.

```bash
# 1) Through npm (bootstraps its own clone of the pinned tag, then builds and installs).
#    Add `-g` if you want the `glasspane` command to stay: `npm install -g glasspane-install`,
#    then `glasspane-install`, and afterwards `glasspane doctor` / `glasspane update`.
npx glasspane-install

# 2) Fetch then run. Kept in two steps: with `curl … | sh`, a curl that fails leaves `sh` reading
#    an empty stdin, and the pipeline exits 0 — the exit code is exactly what an absent-minded
#    agent or CI reads, so it has to be the real one.
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh

# 3) From a checkout you manage. `install.sh` pins one release tag (its `GLASSPANE_RELEASE` default,
#    rewritten by `scripts/set-version.mjs` on every release) — clone that tag, not `main`, unless you
#    mean to install an unreleased tree. The tag below is not verified by eye: it is a derived site
#    owned by `scripts/version-sites.mjs`, and `scripts/check-doc-links.mjs` reddens when it stops
#    matching install.sh.
git clone --branch v1.25.2 https://github.com/jingzhao-l/GlassPane.git && cd GlassPane && node installer/cli.js
```

What npm does **not** deliver: the Swift engine. Every channel above ends in the same `swift build`
against your Command Line Tools, because `glasspane-mcp` on npm is the transport and
`glasspane-install` is the installer, not a prebuilt app bundle. Saying it the other way round would
send someone to install the requirements table above and then wait for a binary that never arrives.

### After installing: one command, three verbs

`glasspane-install` puts a second command on your PATH, and that command is the answer to "the panel's
button failed and I do not know where my install went":

```bash
glasspane doctor    # reads the machine: install pointer, updater state, the loaded daemon job, the
                    # socket, and the two global npm packages. One line each, and a line that cannot
                    # be read says so — "absent" and "I could not look" are different answers
glasspane update    # check, then install what passed; exits with the updater's own code
glasspane status    # the updater's one-line summary, verbatim
```

It resolves everything through `~/.glasspane/update-install.json`, which is the file the installer
writes and the panel reads, so it cannot start guessing at a checkout. It runs no `sudo`, deletes
nothing, and where a repair needs a person it names the tool and the directories instead of handing
out a command that escalates.

`GLASSPANE_REF=<tag>` selects another release; `GLASSPANE_REF=main` tracks the trunk, which is not a fixed artifact. `--no-prompt --no-gui` is a silent install; `--help` lists every flag.

### What you have to do by hand

1. **TCC permission ticks.** The grant subject is the daemon bundle (`GlassPane Daemon`) — not your terminal, not the settings window.
2. **Confirming a destructive step** — replacing an older running instance.

### First launch and Gatekeeper

**Before installing on anyone else's machine:** builds are ad-hoc signed (`codesign --sign -`), not Developer ID, and not notarized. On your own Mac that is invisible; for outside users Gatekeeper refuses the first launch until they allow it under System Settings → Privacy & Security. Notarization removes that step and is a deferred, cost-gated decision (Apple Developer Program membership) — recorded in the [P6 publish record](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md). A "one-command install" that has a known manual step in it should say so.

### What gets installed, and how to remove it

| Path | What it is |
|---|---|
| `~/Applications/GlassPane.app` | settings / permission guide panel |
| `~/Applications/GlassPane Daemon.app` | the daemon (the TCC grant subject) |
| `~/Library/LaunchAgents/com.glasspane.daemon.plist` | launchd job (start at login) |
| `~/Library/LaunchAgents/com.glasspane.update.plist` | launchd job for the daily update check |
| `~/.glasspane/engine.sock` | daemon socket, mode `0600` |
| `~/.glasspane/evidence/` | per-operation evidence packs |
| `~/.glasspane/installer-daemon.log` | installer and daemon log |
| `~/.glasspane/update-state.json`, `update-install.json`, `update.log`, `update-staging/`, `update-backup/` | updater state, its record of where the program lives, its log, and the download/rollback areas |

```bash
launchctl bootout "gui/$(id -u)/com.glasspane.daemon" 2>/dev/null
launchctl bootout "gui/$(id -u)/com.glasspane.update" 2>/dev/null
rm -f ~/Library/LaunchAgents/com.glasspane.daemon.plist
rm -f ~/Library/LaunchAgents/com.glasspane.update.plist
rm -rf ~/Applications/GlassPane.app ~/Applications/"GlassPane Daemon.app"
rm -rf ~/.glasspane
```

Then delete the `GlassPane Daemon` rows from the privacy lists in System Settings. If only the launchd job was lost (common while waiting for a permission tick), recover it without retyping launchctl:

```bash
node installer/cli.js --restore-launchd
```

### Keeping GlassPane up to date

The installer registers a per-user job that asks the release page once a day and, when it is allowed to, swaps in the new version. The page that drives it is the **更新** (Updates) section of `GlassPane.app` — the panel's labels are Chinese-only today, so they are quoted as they appear.

- **What gets updated**: the two bundles in `~/Applications` (settings panel and daemon; the daemon is restarted as part of the swap) and the two global npm packages, `glasspane-mcp` and `glasspane-install`. All of it comes out of **one** release archive whose checksum was verified — the npm packages are packed from that same verified tree instead of being fetched from the registry, so the code that was checked and the code that lands cannot be two different things.
- **When**: one run a day at a fixed local time, 12:00 by default (`enable --hour 3 --minute 45` moves it). A swap only happens while the daemon is idle, so an update never starts in the middle of a run your agent is performing on screen; a busy daemon defers that round and the next slot retries.
- **Do it right now, by hand**: press 「立即检查」 (check now) to fetch and verify, then 「安装更新」 (install update) to apply what passed. The card above the buttons shows current version, newest version, when it last checked, the version waiting, and its full `sha256` — copy it and compare against the release page if you want to be sure of what you are installing. `gp_diagnose` answers the same question for an agent: whether this machine is behind, and as what. Or from a terminal, without hunting for where the install went: `glasspane update` (and `glasspane doctor` when something did not take).
- **One half failing does not cancel the other.** The update has two layers — the two `.app` bundles, and the two global npm packages. If this run cannot reach `npm`, or cannot write where npm puts a global package, the bundles still install, the daemon still restarts and is read back, and the verdict is `applied` carrying `npm-not-refreshed`: the same sentence then names the one command that finishes the rest (`npm install -g glasspane-mcp@<version> glasspane-install@<version>`), and it keeps being shown on the page and in `gp_diagnose` until that line has been run. This replaced a whole-update refusal that had been leaving machines on an old version for days, over a global layer they had never had anyway.
- A button that has nothing to do stays **visible and disabled, with a reason line under it** — the panel never hides a control to avoid explaining it, and never shows a failure as a success.
- **A major version is never applied on a schedule.** It waits as an offer, with the reason on the page (跨大版本升级，可能改变对外行为), and pressing 「安装更新」 is what confirms it. Nothing is skipped silently: `--consent major` is that button's effect, and the scheduled run does not have it.
- **A release nobody signed is not installed by the schedule either.** Every release from `v1.5.0` onward publishes a detached GPG signature over its checksum file, and signing is a step the release workflow cannot skip: if the signature is not produced and is not non-empty on disk, the Release is never created. Verified against the key shipped with this program, that is what turns "who published this" from an assumption into a checked claim (and it means exactly *matches the key we ship*). The older tags are the ones with nothing to check — `v1.4.0` shipped without its `.asc` (the signing step was silently skipped and the two files were back-signed by hand afterwards), and `v1.3.1` predates the signing job. So: if there is nothing to check — no signature published, or no `gpg` on the machine — the daily run stops and says so on the page; you may proceed once by hand with `updater check --consent unsigned-release`, and the state file and `gp_diagnose` keep reporting that release as installed **without authorship proof**. A signature that is published and does not check is refused outright: no consent overrides it. The 「安装更新」 button does not grant this one — it only ever carries `--consent major` — but you do not need a terminal for it: when that gate is the reason the check stopped, the same page offers 「信任这个发布并重新检查」, and pressing it is `updater check --consent unsigned-release`. The terminal form remains the fallback for a headless machine.
- **Turn automatic update off for good** — any one of these, and the last is the strongest:

  ```bash
  node installer/cli.js --no-auto-update    # at install time: the job is never registered
  node "<updater>" disable                 # any time later; `enable` reverses it
  GLASSPANE_UPDATE_DISABLE=1               # also refuses a later enable, so it survives re-installs
  ```

  `<updater>` is the program path the page itself lists under 更新器 → 程序. Off is not mute: the page keeps reporting 自动更新已关闭 with the time of the last check, and check/install still work by hand — the switch governs the schedule, not your ability to update.
- **Machine was asleep or switched off at the fixed time**: macOS replays a run missed while asleep, but not one missed while powered off. So nothing depends on that: unless the page has something more specific to tell you (a version waiting, or a refusal and why), a check older than 36 hours is reported as 检查已过期, with how long ago it actually looked and the check button live.
- **"The rollback needed a human"** means exit code 5 — the new version went in, failed the read-back check after restart, and putting the old version back did not verify either. The tool stops guessing from there: 「安装更新」 is disabled and its reason line tells you to reinstall by hand (自动退回没成功，请先人工重新安装) — that is, re-run the [installer](#channels) so `~/Applications` is rebuilt from source, then reopen this page. When the restore *does* verify (exit code 4) you are back on the previous version and the page says so plainly.

---

## Usage

### In an AI assistant

A test job is a sequence the agent can execute and verify, not a question it has to interpret. The four verbs map directly onto the tool surface:

| You want | The agent calls |
|---|---|
| "is the app running and attached?" | `gp_attach`, then `gp_probe_status` for the engine's self-report |
| "what is on screen?" | `gp_observe` |
| "flip the toggle and tell me what happened" | `gp_act` (returns the change it caused) |
| "is it now checked?" | `gp_assert_element` (pass/fail on `title` / `value` / `role` / `enabled` / `focused`) |
| "why didn't it move?" | `gp_diagnose` (no change / late / contaminated) |
| "show me the proof" | `gp_last_evidence`, `gp_export_evidence`, `gp_recent_reports` |
| "put it back" | `gp_snapshot`, then `gp_restore` |

Two rules of thumb make the difference between a verification and a guess:

- **Ask for a delta, not a description.** "Toggle it and assert the checkbox" gives a measurable result; "toggle it and tell me if it worked" invites prose.
- **Give the agent the rollback step in the same job.** If the run is expected to leave configuration behind, end the instruction with `gp_restore`, so a failed attempt does not accumulate on your machine.

### In the terminal

The terminal is for installation, service liveness and the update line — not for driving the app. Driving an app goes through MCP from the host.

```bash
# Install / repair / re-register the launchd job
node installer/cli.js
node installer/cli.js --restore-launchd

# Ask the daemon itself whether it is alive (the panel is not the service)
printf '{"id":0,"method":"hello"}\n' | nc -U ~/.glasspane/engine.sock

# Check the updater and the version line
node "<updater>" check
node scripts/check-version.mjs
```

### Connecting an MCP client

Two equivalent forms *for an MCP client* (the package installs a third command, described below):

```jsonc
// from a checkout — exactly what the installer prints
{ "mcpServers": { "glasspane": { "command": "node", "args": ["/path/to/GlassPane/mcp-shell/dist/index.js"] } } }

// from npm — same tools, global command
{ "mcpServers": { "glasspane": { "command": "glasspane-mcp" } } }
```

`npm i -g glasspane-mcp` installs **the transport layer only**; the daemon still comes from the installer above. With the daemon unreachable or a permission missing, tool calls return a structured error containing the exact remedy command — you should not need a document to get unstuck.

The same package installs a second command, `glasspane-http` (and publishes it as the `./http-gateway` export — measured from `mcp-shell/package.json`'s `bin` and `exports`). It is not a third MCP form: it bridges HTTP/REST callers onto the *same* daemon socket, it is started by nobody except you, and its trust boundary — loopback-only bind, a bearer token you must supply, and the fact that it exposes `act`, `attach`, `restore` and `snapshot` — is spelled out in [SECURITY.md](SECURITY.md) §2.3.

### What it cannot do

Stated plainly, because these determine whether it fits your workflow:

- **No headless runs.** Accessibility, event taps and screen capture need a logged-in GUI session. It works on a Mac you are signed into — including a dedicated test Mac or a self-hosted runner with an active session — not in a container with no window server.
- **Drag gestures cannot be synthesized.** macOS accepts synthesized clicks but not a SwiftUI `.onDrag` session (measured, not assumed). Button/menu/value-stepper flows are covered; a drag-and-drop-only feature is not drivable yet.
- **Seven accessibility verbs, not arbitrary input.** `gp_act` performs `press`, `increment`, `decrement`, `showMenu`, `confirm`, `cancel`, `pick`. It does not write element values directly and does not post synthetic HID events, so free-text typing into a field is out of scope.
- **Apps that lie or stay silent.** If a target exposes no useful accessibility tree, structural verification is limited to what little it publishes; that is when the probe SDK — or `gp_capture_view` plus a vision model — earns its place.
- **A visual impression is not a measurement.** `gp_capture_view` exists for taste and gestalt, which no rule can judge. But it does not repeat, it cannot be asserted, and it is bounded by the daemon's frame budget (a large window is refused with a suggested `scale` rather than quietly downsampled). Ask it "does this look wrong"; do not ask it "did the checkbox change", because that is what `gp_assert_element` is for.
- **`strong` attribution requires a cooperating app.** It means the app's own embedded probe confirmed the handler ran — see [SECURITY.md](SECURITY.md) for what that does and does not prove.

---

## MCP Tool Reference

`tools/list` at runtime is authoritative; this is a map.

| Group | Tool | What it does |
|---|---|---|
| Drive | `gp_attach` | Attach to a running app by `bundleId` or `pid` |
| | `gp_observe` | Return the attached app's accessibility tree |
| | `gp_act` | Perform one of the 7 accessibility actions and confirm the effect |
| Assert | `gp_assert_element` | Pass/fail on an element property — `title`, `value`, `role`, `enabled`, `focused` |
| | `gp_audit_ui` | Read-only layout audit: element geometry plus deterministic rules, with a `pass` / `advisory` / `blocking` / `insufficient` verdict and its coverage |
| | `gp_diagnose` | Classify a non-effecting operation: no change / late / contaminated |
| Evidence | `gp_last_evidence` | Full evidence pack for the latest (or a given) operation |
| | `gp_export_evidence` | Render one operation as an HTML or Markdown audit report |
| | `gp_recent_reports` | Aggregate the last N operations into one audit view |
| Rollback | `gp_snapshot` | Capture a digest-only baseline of the tree |
| | `gp_restore` | Replay recorded steps back to the baseline, or diff against it |
| Visual | `gp_capture_view` | Send one PNG of the current window to your model for visual review; writes nothing to disk |
| Probe | `gp_probe_status` | Which attached apps have a live `GlassPaneProbe`, and what it reported |
| Projects | `gp_project_list` / `gp_project_set` / `gp_project_get` | Register and read per-app configuration |

`gp_audit_ui` records no operation and writes no evidence pack: it measures the interface as it currently stands, which is why its verdict is allowed to answer `insufficient` instead of confidently clean. Geometry is deliberately kept out of the tree digest — a hover, an animation or a moving cursor must not be able to make "did this action change this screen?" answer yes.

---

## How It Works

### What an evidence pack contains

Each operation produces a versioned `glasspane.evidence` pack (JSON; schema in [kernel/schemas](kernel/schemas)) holding:

- the **target selector** — how the element was identified, not merely its label;
- **before/after accessibility-tree digests** (fixed-width hashes, plus the node count and a changed flag — the pack stores digests, not the trees) and their structural diff;
- a **pixel-difference measurement** for the affected window region (`changedPixelRatio` and bounds; raw screenshots are not persisted);
- an **attribution verdict** — `soft` by default, `strong` only when a live [GlassPaneProbe](engine/probe) in the target app confirms the handler executed, and `weak` only when contamination is measured for that window;
- a **contamination flag** when other input arrived mid-operation;
- the **checkpoint steps** `gp_restore` replays.

### Two-way integration with the review loop

GlassPane is one half of a pair. The other half is [`iterate-harness`](https://pypi.org/project/iterate-harness/), the loop that reviews and fixes the code an agent changed here. The two do not talk through a chat log: everything that crosses the boundary is written by one side as a verifiable record and read by the other.

- **Evidence reaches the audit chain.** `gp_last_evidence` is the call that answers with an [evidence pack](#what-an-evidence-pack-contains) — the other four accept a `dimension` and return no pack, which is why a dimension declared on them is reported as unverified — and the harness appends a hash-chained entry for every decision recorded from a pack: `~/.local/share/glasspane-harness/decisions.jsonl`, or wherever `GLASSPANE_DECISION_LOG` points. The review loop writes its own decisions to `.iterate/decision-log.jsonl` in the project under review, in the same chain format, so a claim quoted from the other side's file is verified before it is used: a rewritten line is refused with the number of the line where the chain stops, and the answer is never "let me read it leniently instead". The reader that runs in production today is the loop's — `fix_proof` verifies GlassPane's ledger before citing it. The fork carries the same verifier, and a fixed-point test pins that a chain written by the loop verifies there; its own production path writes its ledger rather than reading the loop's. A project can name the *other* harness's ledger as its source of fix evidence once, with `ih iterate glasspane-ledger <absolute path>`: the link is written only after the whole chain verifies, and it pins the chain's first entry — a ledger that was replaced rather than extended stops qualifying.
- **A review dimension travels with the call.** Five `gp_*` tools take an optional `dimension` argument on each surface, and they are the *same* five: `gp_act`, `gp_observe`, `gp_diagnose`, `gp_last_evidence`, `gp_attach`. `gp_probe_status` takes none on either surface, on purpose: a self-report produces no evidence frame, so a declaration on it could never be counted against a decision. What echoes the declaration back is the surface you called — the MCP shell or the fork — not the engine: `dimension` is stripped before a request leaves, the engine never sees the word, and the echo line is written by that surface. The loop witnesses the echo, and a decision that contradicts what was already witnessed for that operation id is refused (`KERNEL_E_DIMENSION_CONTEST`) instead of quietly becoming a second record.
- **A failed check sends the loop back to the app.** When a round's invariant re-check fails, the loop asks the running application again — read-only, through the host's own MCP transport. The calls it actually builds are one `gp_last_evidence` plus one `gp_diagnose` per recorded operation; the allow-list that decides what may be asked at all is the five read-only tools (`gp_probe_status` / `gp_observe` / `gp_diagnose` / `gp_last_evidence` / `gp_recent_reports`). A call that would mutate the app is refused by name; nothing in this channel can click for you.
- **Compaction knows what was reviewed.** When a long session is summarised, the harness re-injects the session's evidence anchors — operation id, outcome, ledger line, entry hash — so a summary cannot drop the pointer back into the chain. The run's plan (`.iterate/run-plan.json`, or `GLASSPANE_RUN_PLAN`) decides what goes first: history of dimensions this run never planned is dropped before history of the dimensions it did, and the injected block says which rule it used. Where a declared dimension could not reach an anchor — the engine attaches an evidence pack to `gp_last_evidence` alone — the block prints how many declarations were lost, so that gap is a reading rather than a paragraph someone hopes is still true.
- **A fix is not accepted on the agent's word.** Before the loop advances a repair recipe, it reads three measured things: this round's invariant verdict, the project's recipe (`recipeConfigPath`, or `GLASSPANE_RECIPE`), and a chain-verified ledger line recording a passing outcome against an operation id. Anything absent or unmeasured is refused by name (`RECIPE_GATE_E_*`). The answer is recorded in the project's ledger — on the round that sends, and on a round that passed and therefore sent nothing (from `iterate-harness` 2.11.1) — while a contract refusal writes no ledger bytes, because a decision that was never made must not become an audit entry. Both doors read it back: `/iterate gate` in a session, `ih iterate gate` in a terminal.
- **Both tool surfaces speak one provider contract.** The fork and the MCP shell each register the same provider id and the same prerequisites per method, and a gate that runs both registrations — not greps them — reddens when they diverge or when the one-sided methods stop being a recorded list.

What stays where it belongs: the engine decides what the application did, and neither harness judges an interface on its own. The gate reports and withholds; it does not run the recipe, because neither product ships a recipe executor — the progress pointer is written by whoever performs the fix. Both halves consume the same published contract layer, [`iterate-kernel`](https://www.npmjs.com/package/iterate-kernel), so the formats above are not two files evolving on their own: there is one source for each format, the Python side pins the corpus it codes against by sha256, and a change to the published contract reddens a hash check before it can become a silent re-generation. The boundary is worth naming: whether the two *implementations* still agree on a case the corpus never wrote down is answered by another command — `scripts/diff_kernel_implementations.py`, which drives the same corpus through both and compares verdict by verdict. It is an operator command, not a CI step, so it counts when someone runs it.

### Permissions and integrity design

- State comes from the **daemon measuring itself**, never inferred by the UI. The settings panel does not measure on the daemon's behalf and does not guess.
- Anything unreadable shows as **unverified**. No indicator lights up to look good — the Developer Tools card keeps its own measured status rather than borrowing another card's colour.
- The daemon must be started by launchd or a login item for its self-report to equal the real TCC seat; an instance started from a terminal inherits the *launcher's* verdict, so the panel shows the subject it actually measured.
- Evidence and approval records are hash-chained audit logs. They record what happened; they are not an enforcement gate.

---

## Configuration

GlassPane has one configuration surface for the engine and one for each consumer. None of it is a config file you edit by hand: the installer writes the service paths, the MCP host owns its own JSON block, and the harness reads its own run plan and recipe.

### Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `GLASSPANE_ENGINE_SOCK` | `glasspane-mcp`, `glasspane-http` | Daemon socket path; defaults to `~/.glasspane/engine.sock` |
| `GLASSPANE_REF` | `install.sh`, installer | Release tag to install; `main` tracks the trunk, which is not a fixed artifact |
| `GLASSPANE_UPDATE_DISABLE` | updater | Set to `1` to refuse enabling the scheduled update, including through a later re-install |
| `GLASSPANE_DECISION_LOG` | GlassPane Harness | Where the decision ledger is written instead of `~/.local/share/glasspane-harness/decisions.jsonl` |
| `GLASSPANE_RUN_PLAN` | GlassPane Harness | Run plan that decides which dimension history is dropped first when a session is compacted |
| `GLASSPANE_RECIPE` | GlassPane Harness | Recipe the fix gate reads, when the run plan does not name a `recipeConfigPath` |

### Per-app configuration

Application-specific settings live with the app, not in a global file. `gp_project_set` registers an app by bundle id; `gp_project_get` reports the resolved storage paths, recipe and calibration roots; `gp_project_list` shows what is registered. The records are what the evidence packs and the review-loop gate read, so changing them changes what "verified" means for that app.

### Update schedule

The daily check is a launchd job; its time and consent level are the updater's, not the panel's. `enable --hour 3 --minute 45` moves the slot; the panel's buttons are the same commands with the same consent semantics described under [Keeping GlassPane up to date](#keeping-glasspane-up-to-date).

---

## FAQ

### Installation

**Gatekeeper blocks the app / "unidentified developer".** Expected — builds are ad-hoc signed and notarization is a pending decision (see [Installation](#installation)). Allow it under System Settings → Privacy & Security, then reopen.

**I ticked the permission and the card is still red.** It was probably ticked for the wrong subject: the entry must be `GlassPane Daemon`, not your terminal and not `GlassPane.app`. The card shows the subject it measured; run `node installer/cli.js --restore-launchd` to move the service under launchd and re-verify.

### Usage

**Panel is open but tools error.** The panel is not the service. Ask the socket itself: `printf '{"id":0,"method":"hello"}\n' | nc -U ~/.glasspane/engine.sock` returns the running daemon's `hello` — its version, capabilities and state root — and that is the liveness read. Do not substitute `glasspaned --permissions`: that flag measures the **TCC seats of whichever process runs it** and opens no socket at all (its own `--help` says so), so a green JSON there says nothing about the service. If an older build holds the socket, re-run the installer with `--replace-daemon` — otherwise the app you granted permission to is not the app doing the work.

**The agent says the change happened but the UI did not move.** That is the case `gp_diagnose` exists for; it separates "no structural change", "change arrived late", and "input contamination". If your feature is drag-only, check [What it cannot do](#what-it-cannot-do) first.

**Which macOS versions are supported?** 14 and later; that is what the accessibility, event-tap and screen-capture behaviour is measured against.

### Security

**Does anything leave my machine?** No. Local unix socket, local stdio process, evidence under `~/.glasspane/`. But `gp_observe` returns accessibility trees *into the agent conversation*, so whatever your model provider logs, it logs that tree — treat transcripts as sensitive.

**Which version am I running?** The daemon prints its own version on `glasspaned --version` — `--permissions` does **not** carry a version key, it only measures the TCC seats — the panel shows the same value, the MCP `initialize` response echoes it, and `node scripts/check-version.mjs` prints every place the version appears. All of it comes from one number ([CHANGELOG.md](CHANGELOG.md)).

---

## Security

GlassPane holds Accessibility, Input Monitoring and Screen Recording, registers a launchd job, reads the event stream and can attach a debugger. It is powerful and it is attack surface. How to report a vulnerability, and the threat model in detail, are in [SECURITY.md](SECURITY.md) ([简体中文](SECURITY.zh-CN.md)). Please don't open a public issue containing logs or evidence packs.

---

## Directory Structure

```
GlassPane/
├── install.sh          one-command entry: locates/fetches source, delegates to installer
├── installer/          zero-dependency Node installer → npm `glasspane-install`
├── engine/             Swift package: glasspaned daemon, settings GUI, accessibility channel
│   ├── probe/          GlassPaneProbe SPM package (embed it for strong attribution)
│   └── scripts/        make-app.sh — bundle + ad-hoc sign the two .app products
├── mcp-shell/          TypeScript MCP stdio server → npm `glasspane-mcp`
├── kernel/             pinned corpus (schemas + fixtures) of the published iterate-kernel
├── bridge/             Python LLDB bridge (crash / runtime capture)
├── updater/            the daily update job and its consent gates
├── harness/            GlassPane Harness fork (own repo, own release line; excluded from this product's archive)
├── spike/              feasibility experiments and recorded results
├── scripts/            set-version / check-version — the single version line
├── specs/              implementation specs + acceptance records (PRD, P0–P6, audits)
├── ITERATE.md          this repo's own iterate onboarding knowledge base
└── .github/workflows/  ci.yml (10 lanes; the publish-shape guard is a step in one of them), release.yml
```

---

## Contributing

Setup, the per-layer test commands, the commit and PR conventions, and the rules for writing tests that must not touch a developer's real `~/.glasspane` are in [CONTRIBUTING.md](CONTRIBUTING.md) ([简体中文](CONTRIBUTING.zh-CN.md)). The short version:

```bash
npm ci && npm run build && npm test --workspaces --if-present   # TS workspaces: mcp-shell, installer, updater (kernel/ has no package.json)
swift build --package-path engine && swift test --package-path engine   # Swift engine
swift test --package-path engine/probe                           # probe SDK
python3 -m pytest -q bridge                                      # LLDB bridge
node scripts/check-version.mjs                                   # version-line drift guard
```

CI also runs a **publish-shape guard**: it bundles `glasspane-mcp`, packs it, installs the tarball into a clean directory and completes an MCP `initialize` handshake — because packaging faults (a dangling `file:` dependency, a missing schema) only ever appear in the published artifact.

Acceptance steps that need a real GUI session cannot run in CI by design; they are recorded as hardware smoke runs in [engine/smoke.md](engine/smoke.md) instead of being silently skipped.

Releases: `node scripts/set-version.mjs <semver>` writes the whole version line; pushing a tag produces a GitHub Release whose archive is the tagged tree — less `harness/`, the vendored fork no install step reads and which is 86.9% of the repository's tracked bytes (64,535,347 of 74,253,356, measured 2026-10-20 — recompute it with `git ls-tree -r -l HEAD`, summing blob sizes per path) — plus the built JavaScript the updater cannot produce on the target (`mcp-shell/dist`, `mcp-shell/schemas` — `scripts/make-release-archive.mjs`), together with `SHA256SUMS-<version>.txt` (the version is part of the file name — the updater asks for that name); npm publishing goes through `release.yml` with provenance.

### Documentation

`specs/` is the design-of-record and the acceptance ledger (Chinese). It is where claims get specified and marked verified or not, so it is the closest thing to a reference manual:

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
| [双向集成 2026-10-25](specs/GlassPane_双向集成_2026-10-25_状态.md) | the five two-way scenarios with the review loop: row-by-row state, the evidence path for each, and what is measured rather than stated |
| [更新系统 2026-10-26](specs/GlassPane_更新系统_2026-10-26_状态.md) | why an in-app update could detect a release and still fail: the four root causes, the partial-success contract with the one npm command it hands you, and the release-by-release readings taken on the published artifacts |

The sibling product's documents live with it: [GlassPane Harness documentation](https://github.com/jingzhao-l/glasspane-harness/tree/main/docs) covers install, the tool surface, the evidence discipline and the release line.

---

## Disclaimer

GlassPane drives real applications on a real desktop with permissions that let it read the screen and act on other apps' interfaces. Point it at apps you intend to control, keep the evidence directory out of shared locations, and treat exported reports as containing whatever was on screen. Attribution verdicts are measurements and inferences, not guarantees about a program's internals — an app that misreports its own accessibility tree can still mislead any observer, which is why the probe path exists.

---

## License

MIT — see [LICENSE](LICENSE).
