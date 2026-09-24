# GlassPane Security Policy

**English** · [简体中文](./SECURITY.zh-CN.md)

GlassPane is not an ordinary utility library. It holds high-risk macOS permissions — Accessibility,
Input Monitoring, Screen Recording, Developer Tools — and uses them to drive any app the user has
granted, running as the logged-in user. It is therefore an attack surface in its own right. This
document states the threat model as it actually is: who can do what, what lands on disk, and where the
boundary sits. Nothing below is dressed up, and no response deadline is promised that does not exist
yet.

## 1. Reporting a vulnerability

- The repository is `jingzhao-l/GlassPane` (public, MIT). **Once private vulnerability reporting is
  enabled** (Settings → Security → Private vulnerability reporting), prefer a private GitHub security
  advisory: `https://github.com/jingzhao-l/GlassPane/security/advisories/new`. That entry point is not
  confirmed to be enabled on this repository; if it is unavailable, use the fallback below.
- Fallback: open a normal issue describing only the **symptom and the impact**. Keep reproduction steps
  and artifacts on your side; a maintainer will follow up by direct message to collect them.
- On either path: **do not** paste tokens, raw logs from `~/.glasspane/`, evidence-pack JSON, exported
  reports, or screenshots into a public issue. Those files can contain account names, real names and
  email content belonging to other people, visible on the screens that were under test.
- Directions worth reporting: a socket, permission or evidence path that is not covered by the boundary
  described below; anything that lets "unverified" pass as "verified"; a cross-user process reaching the
  daemon or the bridge; evidence escaping `~/.glasspane/` and a caller's explicit paths; launchd being
  re-registered. Any severity is welcome — in this project, displaying something unverified as verified
  is handled as a defect.

## 2. Threat model summary

**The boundary, stated plainly**: other processes running with the same privileges as the logged-in
user on this machine. Cross-user, cross-network, and already-rooted machines are not protected, and
reports against those are usually judged out of scope.

### 2.1 What the daemon can see, what it can do, and as whom

- `glasspaned` is started by a launchd user agent (`gui/<uid>`) **as the logged-in user** — not as root,
  with no privilege escalation.
- Accessibility: reads the AX tree of any app (control titles and attribute text included) and acts on
  any app through `AXUIElementPerformAction`, using 7 accessibility verbs (press, increment, decrement,
  showMenu, confirm, cancel, pick). The current implementation does not write `AXValue` and does not
  post synthesized CGEvent keyboard or mouse events.
- Input Monitoring: a global (session-level) event tap used to tell apart "this change came from the
  agent" from "this change came from a human" — it **reads** the user's input stream; the callback
  forwards each event unchanged, and nothing in the engine posts synthesized events. It is not a channel
  the daemon uses to inject input.
- Screen Recording: captures the frontmost window's image for pixel comparison. Without that permission
  this degrades to `pixelDiff: null` plus a verdict of INCONCLUSIVE.
- Probe channel: listens on `~/.glasspane/probe.sock` and receives handler / state / checkpoint signals
  reported by the SDK inside the process under test.

### 2.2 The unix socket is the only local trust boundary

- `~/.glasspane/engine.sock`: parent directory `0700`, socket file `0600`; the daemon binds and chmods
  them itself.
- **There is no peer authentication anywhere in the command path** — the daemon never checks a caller's
  uid, pid or code identity, there is no token and no encryption. Any process that can open this socket
  as that user can drive the daemon's full capability set equivalently, including operating other apps
  as the already-granted principal "GlassPane Daemon". The trust model is "any code on this machine =
  the agent's hands": code running under your account, and any MCP server or plugin you connect, is
  inside the circle.
- `~/.glasspane/probe.sock` has the same ownership and mode, but the connecting side **names its own
  pid** (a field in the `hello` frame), and that claim is checked only against the kernel's view of the
  connection — never against any code identity. A cooperating or lying same-user app can therefore
  register as the probe for its own pid and inject handler/state signals; because a present probe signal
  upgrades attribution from `soft` to `strong`, **attribution strength is forgeable by a same-user
  process**. This is known, labelled here as such, and it is not a cross-user escalation.
- The daemon offers `--force-socket`, which can take over an already-occupied socket, and
  `--replace-daemon`, which terminates the running instance first. An older or maliciously started
  instance can displace the granted principal. After installing, check the panel's "Daemon status →
  subject" against the binary path that is actually running.

### 2.3 Evidence packs carry screen content out: what is on disk, and how to erase it

- Location: `~/.glasspane/evidence/<operationId>.json` (one file per operation; archive cap 10,000 packs
  by default, `EvidenceStore.defaultMaxFiles = 10_000`), `~/.glasspane/projects.json`,
  `~/.glasspane/approvals.json`, and `~/.glasspane/installer-daemon.log` — launchd sends both stdout and
  stderr there.
- Content: the operation's selector (role / title / identifier — **titles are text from the app under
  test's own UI**), the action and its confirmation bit, an AX tree summary and node count, the
  changed-pixel ratio plus window geometry and window id, responsiveness and liveness signals, the
  `file:line` of any handler that fired, before/after normalized state strings (each truncated at
  ≤1 KiB), the classification verdict and the attribution. **Raw screenshots are not persisted** — only
  derived quantities. But `gp_observe` returns full accessibility trees into the MCP session, so that
  part lands in the agent host's context and in the remote model.
- Exports are copies: the HTML/Markdown reports produced by `gp_export_evidence` / `gp_recent_reports`
  are written to the path the caller specifies and contain the same interface text. Z4.5 Metal capture
  writes a `.gputrace` document into the **app under test's** temporary directory.
- Cleanup. Size first, then prune by age:

  ```sh
  glasspaned --evidence-stats
  glasspaned --prune-evidence [--older-than <days>] [--project <id>] [--dry-run]
  ```

  The most direct option is to stop the daemon and delete `~/.glasspane/evidence/`. The approval ledger
  is checked with `glasspaned --approval-audit` / `--approval-verify` (SHA-256 hash chain).
- Do not put `~/.glasspane/` in cloud sync, shared directories, or CI artifacts. Redact per the rules in
  section 1 before filing an issue.

### 2.4 launchd persistence registered by the installer

- Writes `~/Library/LaunchAgents/com.glasspane.daemon.plist` — `RunAtLoad`, restart on abnormal exit,
  `ThrottleInterval 5`, executable pointing at `~/Applications/GlassPane Daemon.app`. This is a
  **user-level** agent that starts at login; no system-level persistence is taken.
- To remove persistence:

  ```sh
  launchctl bootout gui/$(id -u)/com.glasspane.daemon
  rm ~/Library/LaunchAgents/com.glasspane.daemon.plist
  ```

- To repair a job that has been booted out — common while waiting for permissions to be ticked — use
  `node installer/cli.js --restore-launchd`: detect → bootstrap → verify the self-reported seat over
  `hello`. Passing `--no-launchd` at install time skips registration entirely.

### 2.5 The LLDB bridge's debugger-attach capability

- `bridge/glasspane_bridge.py` uses the `xcrun lldb` SB API to **launch a new process or attach to an
  existing pid**, reading backtraces, registers and local variables, and arming hardware watchpoints.
  Attaching to a running process requires "Privacy & Security → Developer Tools" to be ticked by hand,
  and that seat has no query API.
- This is the strongest capability in the project: **any input that can drive the bridge is equivalent
  to being able to read memory inside the target process.** The bridge therefore ships only as a
  standalone CLI/script asset — the daemon never spawns lldb, and there is no socket command that
  forwards to the bridge. When extending this project, do not wire the bridge into a `gp_*` tool or into
  any input a remote party can influence: that widens the "same-user code on this machine" boundary into
  remote code debugging.

### 2.6 Ad-hoc signing without notarization: what it prevents and what it does not

- Distribution builds are signed ad-hoc, with an identifier-only designated requirement that carries no
  cdhash:

  ```sh
  codesign --force --sign - \
    --identifier "$bundle_id" \
    -r="designated => identifier \"$bundle_id\"" \
    "$app_dir"
  ```

  The purpose is narrow: the TCC seat survives rebuilds, and System Settings shows an entry with a name
  and an icon.
- It provides **no** publisher identity, distribution integrity or tamper resistance: no Developer ID, no
  notarization, no stapling. Anyone can rebuild a bundle under the same identifier; on a machine that
  granted permission by identifier, a replaced binary can still be accepted as the granted principal.
  Build only from commits you have reviewed, and treat `~/Applications` and `~/.glasspane/` as
  security-relevant assets.
- Notarization is what would close that gap, and it is a **deferred owner decision gated on a paid Apple
  Developer Program membership**. It is not enabled; no document here claims that it is.
- Visible consequence on the user side: the first launch is blocked by Gatekeeper and must be allowed
  manually in System Settings. The one-command install's `curl … | sh` is "execute a remote script" —
  read the script first, or point `GLASSPANE_REPO` at a local clone.

## 3. These are **not** security issues (by design)

- Permissions have to be ticked by a human in System Settings; no API lets the program tick them. The
  drag-to-guide affordance is navigation, not authorization.
- The granted subject must be the daemon (`GlassPane Daemon` / `glasspaned`) — not your terminal, not the
  settings window. "The terminal can run it" does not mean "the daemon can run it", and readings that
  differ per subject are the real semantics.
- The Developer Tools seat has no query API, so the permission row keeps reporting "unverifiable" instead
  of lighting up; an explicit, user-triggered capability probe runs bounded real `xcrun lldb` invocations
  and reports what it measured. Never falsely showing something as verified is a requirement here, not a
  defect.
- Any same-user process can connect to the socket and drive the daemon; a probe self-declares its pid;
  cross-user and network isolation are out of scope (see section 2).
- Degradation when Screen Recording or Input Monitoring is missing (`pixelDiff: null`, INCONCLUSIVE, a
  change in the circuit-breaker tier), and tier-1 `restore` refusing with `GP_E_RESTORE_UNSUPPORTED`:
  these degrade honestly, they are not gates to be bypassed.
- The approval ledger currently holds only `daemon:auto` approve records. It is an **after-the-fact
  signed audit chain**, not a human approval gate.

## 4. Affected versions

| Version | Supported |
|---|---|
| 1.1.x | ✅ current release line (1.1.0 and 1.1.1 tagged and published); security fixes ship here |
| 1.0.x | ❌ no longer patched (the release lines were unified onto 1.1.x) |
| 0.x (releases before `glasspane-mcp@0.1.0` / `glasspane-install@1.0.0`) | ❌ no patches — upgrade |

**No fix-time commitment (SLA) yet**: one maintainer, no security team, so there is no "responds within
X days / fixed within Y days" promise to make. What can be promised: private advisories are read and
answered, confirmed issues are fixed on the `1.1.x` line, and the impact range plus workarounds are
stated in the Release notes and CHANGELOG. If you need a temporary workaround, the two most effective are
stopping the launchd job (`launchctl bootout`, see 2.4) and removing the granted TCC seats.
