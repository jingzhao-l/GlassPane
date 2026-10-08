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
- Directions worth reporting: a socket, gateway bind, permission or evidence path that is not covered by
  the boundary described below; anything that lets "unverified" pass as "verified"; a cross-user process
  reaching the daemon or the bridge; evidence escaping `~/.glasspane/` and a caller's explicit paths;
  launchd being re-registered. Any severity is welcome — in this project, displaying something unverified
  as verified is handled as a defect.

## 2. Threat model summary

**The boundary, stated plainly**: code running on this machine. There are **three** local surfaces, and
they do not have the same reach:

- the **unix socket** (section 2.2) is gated by file ownership and mode, so whoever can open it is
  running as your user;
- the **loopback HTTP gateway** (section 2.3) — which exists only if you start it yourself — is gated by
  one shared bearer token and is reachable over the loopback interface by **any local account**, not only
  by processes running as your user.
- the **scheduled updater** (section 2.8) carries no act and no token, but it can replace the binaries
  the other two are reached through.

Cross-network and already-rooted machines are not protected, and reports against those are usually judged
out of scope.

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
- Screen Recording: captures the frontmost window's image. Two consumers, one seat — pixel comparison
  (`pixelDiff`, degrades to `null` plus a verdict of INCONCLUSIVE when the permission is missing) and
  the explicit visual-review pass-through `gp_capture_view` (see below: it ships an image into the
  conversation but writes nothing). Both fail closed; neither falls back to a substitute window.
- Probe channel: listens on `~/.glasspane/probe.sock` and receives handler / state / checkpoint signals
  reported by the SDK inside the process under test.

### 2.2 Surface one: the daemon's unix socket

- `~/.glasspane/engine.sock`: parent directory `0700`, socket file `0600`; the daemon binds and chmods
  them itself, and refuses to serve at all when that directory cannot be brought to `0700`, is not a
  directory, or belongs to another account. `~/.glasspane/probe.sock`, the state files and the evidence
  archive get the same enforcement on the daemon's start-of-run sweep.
- **What the mode gates is users, not processes.** Every process running as your own user can open this
  socket; nothing about the mode makes the screen safe from code you have already run.
- **There is no peer authentication anywhere in the command path** — the daemon never checks a caller's
  uid, pid or code identity, there is no token and no encryption. Any process that can open this socket
  as that user can drive the daemon's full capability set equivalently, including operating other apps
  as the already-granted principal "GlassPane Daemon". The trust model is "any code on this machine =
  the agent's hands": code running under your account, and any MCP server or plugin you connect, is
  inside the circle.
- **Nothing on this path asks a human.** `attach`, `act`, `snapshot`, `restore`, `observe` and the rest
  of the socket method table are carried out as soon as the frame is accepted; there is no confirmation
  step, and no approval prompt between a caller and a click on the user's screen. The approval ledger is
  not a gate on it either: its records are written by the daemon itself (`daemon:auto`) after the outcome
  of a `restore`, as an audit trail, and the settings panel presents them as self-approval.
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
- How a caller finds the socket, and why the last resort is a guess it is meant to lose: `GLASSPANE_ENGINE_SOCK`,
  then an explicit `--socket-path`, then `$HOME/.glasspane/engine.sock`. That fallback reads `$HOME`
  **deliberately**, even though the daemon's own default location comes from the home the system records
  for the user, which does not consult `HOME`. In a process whose `$HOME` points into a sandbox the two
  sides therefore resolve different directories, and the caller is refused ("nothing is listening on the
  guessed path") instead of silently driving the live daemon — clicks, state writes, the whole act
  surface — on a machine it asked not to be on. Redirecting `$HOME` is not a supported way to isolate
  from a daemon, and it must not be upgraded into a way to reach one: name the socket, or don't. An
  installed pair agrees because the launchd job hands the daemon an explicit `--socket-path` (see
  section 2.5); read that value back rather than recomputing it.

### 2.3 Surface two: the loopback HTTP gateway

`glasspane-http` (the `glasspane-mcp` package's second bin, and the published `./http-gateway` export)
bridges HTTP/REST callers onto the same daemon socket: `GET /v1/hello`, the evidence reads, and
`POST /v1/tools/<name>` for every daemon method the shell forwards — which **includes `act`, `attach`,
`restore` and `snapshot`**. It is not started by the installer and not started by the MCP server; it
exists only while someone runs it. `gp_capture_view` and the orchestrated tools (export, report listing,
project ops) are not on this surface.

**Who can reach it.** It listens on `127.0.0.1` (default port 8787) and never on a wildcard, so no
network peer can reach it. But loopback TCP is not owner-only the way a socket file can be: **any local
account** can open that port. On this surface the file-mode gate of section 2.2 is replaced by a single
shared bearer token, and that token is the whole boundary.

**What stops them** — each of these refuses to start or exits; none of them downgrades instead:

- **Bind.** Only a loopback address *literal* is accepted: any address in `127.0.0.0/8`, or `::1`, in
  either the bare or the `::ffff:`-mapped spelling. `0.0.0.0`, `::`, any routable address and **any
  name — including `localhost`** — are refused with an error. A name is answered by `/etc/hosts` and
  DNS, so accepting one would hand the choice of interface, and therefore of who can reach the act
  surface, to whoever edits those files. Reach the gateway by name from the client side, where resolving
  it decides only where the request goes. `--port` is validated as decimal digits 0–65535 before anything
  is opened, so a mistyped value cannot quietly become port 80 or an ephemeral one.
- **The token.** Read from `GLASSPANE_HTTP_TOKEN`; never generated, never defaulted, empty refused. It
  must be at least 32 characters drawn from at least 8 distinct ones (`MIN_TOKEN_CHARS`,
  `MIN_TOKEN_DISTINCT_CHARS`; both the CLI and the gateway check it). A length floor alone is satisfied
  by `a` repeated 32 times, so the distinct-character arm is part of the rule, not decoration. Make one
  with `openssl rand -hex 16`.
- **How it is compared.** The expected and received bearer are each reduced to a SHA-256 digest and
  compared with a timing-safe equality, so a length mismatch never returns early and neither the length
  nor a matching prefix can be probed from response timing. That removes a prefix oracle; it does **not**
  make a short token unguessable, and there is no rate limit, lockout or attempt count here — a local
  process can send candidates at loopback speed. The guess cost is carried entirely by the token's
  length and variety.
- **A bind that fails is fatal.** `glasspane-http` exits 3 when it cannot bind, instead of carrying on.
  The path this closes: with the port already held by another process and this one still looking alive,
  every client keeps sending its requests — bearer token included — to whoever owns the port, and the
  operator has no signal that the gateway served nothing at all. A gateway that is not listening must not
  look alive.
- **What one request can cost.** A request body is capped at 256 KiB; an `ids=` evidence aggregation at
  20 ids and one shared 50 s wall-clock budget for the whole fan-out, so no single caller can fan into
  thousands of serial daemon round trips or hold the daemon's one connection past the point where its
  client has stopped listening.
- **What an error means.** HTTP status is derived from the error's author (`httpStatusForEngineCode`):
  a verdict the daemon produced about your request is a 4xx (`404` for no such operation or no evidence,
  `400` for bad params, `409` for a project limit, `422` for any other code the daemon authors), and a 5xx
  is only ever an answer about this gateway and its own shell — `503` nothing listening, `504` no answer
  inside the deadline, `502` an answer that could not be delivered, `500` the gateway failing to complete
  the request. This is a safety property, not cosmetics: a 5xx reads as
  "the request never landed, sending it again is the fix", and on `act` that reading is a second click on
  the user's screen. For the three methods whose repetition changes something — `act`, `attach`,
  `restore` — the error bodies say do not re-send, and point the caller at the routes that read what
  actually happened.

**What does *not* stop them:**

- **No TLS.** Plain HTTP over the loopback interface: the bearer token, and every body that comes back
  (accessibility titles and values, evidence text), travel in clear text. Nothing on this surface
  encrypts anything.
- **One shared token, no per-user identity.** Every client holding it is the same principal. The gateway
  cannot say which caller performed an operation, cannot revoke one caller without rotating the secret
  for all of them, and does not record one caller's identity anywhere the daemon could attribute an act
  to. The token is a gate, not an account.
- **The gateway adds a second door to the same capability set, not a new capability.** To bridge, it has
  to open the socket, so it runs as your user and gains nothing the socket did not already allow. What it
  changes is reach: the door it opens is one that other local accounts can knock on, which the socket's
  `0600` does not offer them.
- **Late replies are raw engine content.** When an answer lands after its caller was already given a
  deadline, the gateway writes that body to its own stderr, unredacted, capped at 64 KiB per reply with
  the un-logged remainder counted in a marker (`LOG_BODY_CHARS`). If you redirect that stderr into a
  file, it takes the mode that whatever started the gateway gave it — section 2.4 documents a
  world-readable file in the state root that exists today.

Practical consequences: do not leave this running when nothing is using it; treat the token as a
password (environment, not a command line or a shell history line); and prefer the MCP path or the
socket for anything that does not need HTTP, because those paths at least keep other accounts out by
permission rather than by a secret.

### 2.4 Evidence packs carry screen content out: what is on disk, and how to erase it

- Location: `~/.glasspane/evidence/<operationId>.json` (one file per operation; archive cap 10,000 packs
  by default, `EvidenceStore.defaultMaxFiles = 10_000`), `~/.glasspane/projects.json`,
  `~/.glasspane/approvals.json`, `~/.glasspane/installer-daemon.log` — launchd sends both stdout and
  stderr there — and `~/.glasspane/update.log`, the daily update agent's own log, which launchd opens
  the same way. Its content is what this machine has installed and updated: versions, staging paths,
  digests, tags, GPG verdicts and the reason every refusal happened.
- Content: the operation's selector (role / title / identifier — **titles are text from the app under
  test's own UI**), the action and its confirmation bit, an AX tree summary and node count, the
  changed-pixel ratio plus window geometry and window id, responsiveness and liveness signals, the
  `file:line` of any handler that fired, before/after normalized state strings (each truncated at
  ≤1 KiB), the classification verdict and the attribution. **The evidence path persists no raw
  screenshot** — only derived quantities. But `gp_observe` returns full accessibility trees into the
  MCP session, so that part lands in the agent host's context and in the remote model.
- **`gp_capture_view` is the only path that ships screen pixels anywhere, and it is a pass-through.**
  It encodes a PNG of the attached window and returns it as MCP image content; the daemon writes no
  file, and the tool deliberately has **no `path` parameter** — a model-chosen output path would put an
  arbitrary
  screen-content write into the protocol. What it cannot undo is the exposure: the image enters the
  conversation, so it reaches whatever your model provider retains, exactly like the accessibility
  trees above but with pixels instead of labels. Treat a session that used `gp_capture_view` as
  containing a screenshot of everything that was on that window, and prefer `gp_audit_ui` /
  `gp_assert_element` for anything a measurement can settle.
- **The two report renderers have no output path, and what they render goes to the model, not to disk.**
  `gp_export_evidence` accepts only `operationId` and `format` (`html` | `markdown`), `gp_recent_reports`
  only `limit` and `format`; both schemas are `additionalProperties: false`, so there is no path argument to
  pass and the shell writes no file. The rendered HTML/Markdown comes back as the tool result's **text
  content** — so it lands in your agent host's transcript and in whatever your model provider retains for
  that session. That is a *different* exposure from a file on disk, not a smaller one: the same interface
  text as the evidence pack above, but on the far side of the boundary instead of inside your `0700` state
  root, already read by somebody else's model, with no `chmod` and no "delete the directory" remedy that
  reaches it. Nothing here writes a report copy, so the mode tightening below has nothing to say about these
  two tools. Z4.5 Metal capture is the opposite shape and does write a file: it puts a `.gputrace` document
  into the **app under test's** temporary directory.
- **Modes on the state root, as measured rather than as intended.** On the machine this page was checked
  from: `~/.glasspane` `0700`, `engine.sock` `0600`, `approvals.json` and `projects.json` `0600` — the
  daemon enforces those on bind and on its start-of-run sweep. `~/.glasspane/installer-daemon.log`
  **measured `0644` for a long time and was the one file in the state root that no tightening covered**:
  the installer created it with `openSync(path, 'a')` (so the process umask decided the mode), and the
  start-of-run sweep touched the root, the registry, the approval chain and the evidence packs — not the
  launchd log. Both halves are closed now, and each is *verified* rather than assumed: the installer
  requests `0600` and re-reads the mode (a chmod that did not stick is reported as a failed write, not a
  warning), and the daemon's sweep now tightens a pre-existing log on the way up. Since 1.9.0 the same
  pair of measures covers the update agent's `~/.glasspane/update.log` as well: `registerAgent` creates it
  `0600` and re-reads it before launchd is handed the definition (a volume that will not hold the bit
  refuses the registration rather than installing a world-readable audit trail), and
  `StateRoot.updateLogFile` puts the name in the start-of-run sweep. What that sweep re-reads on this
  machine has not been re-measured against a live launchd job this round — registering one is not a
  decision a routine task makes on somebody's machine — so the `0644` figure for `update.log` is carried
  from its sibling's measurement, not from a fresh one here. Measured 2026-10-06 on
  an isolated state root with the debug daemon: `644` → `600`, root `755` → `700`, and the log's existing
  bytes left intact — tightening is a `chmod`, not a rewrite. What this does **not** buy: mode does not
  travel with a copy. This log is the daemon's own stdout and stderr — startup and socket paths, pids,
  client connect/disconnect, input-monitor and permission verdicts, engine error text — enough for
  another account to learn that GlassPane is installed here, which daemon is running and what it has been
  doing, so a copy dropped into a shared directory, a sync folder or a CI artifact is readable by
  whoever can read that copy.
- Cleanup. Size first, then prune by age:

  ```sh
  glasspaned --evidence-stats
  glasspaned --prune-evidence [--older-than <days>] [--project <id>] [--dry-run]
  ```

  The most direct option is to stop the daemon and delete `~/.glasspane/evidence/`. The approval ledger
  is checked with `glasspaned --approval-audit` / `--approval-verify` (SHA-256 hash chain).
- Do not put `~/.glasspane/` in cloud sync, shared directories, or CI artifacts. Redact per the rules in
  section 1 before filing an issue.

### 2.5 launchd persistence registered by the installer

- Writes `~/Library/LaunchAgents/com.glasspane.daemon.plist` — `RunAtLoad`, restart on abnormal exit,
  `ThrottleInterval 5`, executable pointing at `~/Applications/GlassPane Daemon.app`. This is a
  **user-level** agent that starts at login; no system-level persistence is taken. The job runs the daemon
  only; it does not start the HTTP gateway of section 2.3, and it carries no token.
- **Known, still open — where those paths come from.** The installer composes the socket path, the log
  path above and the `LaunchAgents` path from `process.env.HOME`. The daemon's own default home is the
  one the system records for the user, which does not consult `HOME`, so an install run with `HOME`
  pointing elsewhere writes the job, the socket and the log under the redirected directory while the
  evidence archive, the registry and the approval chain stay in the real home. The mixed result is
  bounded, not catastrophic — the job hands the daemon an explicit `--socket-path`, so the daemon serves
  the directory the installer named, and it refuses to bind unless that directory is owned by the
  installing user and can be brought to `0700` — but the two halves of the state do not sit together, and
  a caller that recomputes a path from `$HOME` instead of reading the job's value can end up pointed at
  the wrong one. Until this is closed: install with a normal `HOME`, and read the socket path back from
  `~/Library/LaunchAgents/com.glasspane.daemon.plist` rather than deriving it.
- To remove persistence:

  ```sh
  launchctl bootout gui/$(id -u)/com.glasspane.daemon
  rm ~/Library/LaunchAgents/com.glasspane.daemon.plist
  ```

- To repair a job that has been booted out — common while waiting for permissions to be ticked — use
  `node installer/cli.js --restore-launchd`: detect → bootstrap → verify the self-reported seat over
  `hello`. Passing `--no-launchd` at install time skips registration entirely.

### 2.6 The LLDB bridge's debugger-attach capability

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

### 2.7 Ad-hoc signing without notarization: what it prevents and what it does not

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

### 2.8 The scheduled updater: a local job that can replace the binaries

- **What it is**: a second user-level agent, `~/Library/LaunchAgents/com.glasspane.update.plist`, one run
  a day (12:00 local by default), **as the logged-in user, with no escalation**. It fetches the latest
  GitHub Release of the pinned repository over TLS and, when permitted, replaces
  `~/Applications/GlassPane.app`, `~/Applications/GlassPane Daemon.app` and the global `glasspane-mcp` /
  `glasspane-install` packages. The dials are the schedule and `GLASSPANE_UPDATE_BASE` (another *https*
  host; a cleartext one is refused rather than downgraded to). `--no-auto-update` at install, `disable`,
  or `GLASSPANE_UPDATE_DISABLE=1` take this section out of your threat model.
- **What the checks prove, and what they do not.** The archive's measured SHA-256 equals the digest in
  that same release's `SHA256SUMS`; the tag, the unpacked tree's own version line and the version that
  lands agree; the commit the release names has a green CI run on `main`; the npm packages are packed from
  that verified tree instead of being fetched again. That is integrity, version consistency and build
  traceability. Authorship is now a **checked** claim rather than an assumption: the release publishes a
  detached GPG signature over its checksum file (`SHA256SUMS-<ver>.txt.asc`), verified in a throwaway
  keyring against the public key this repository ships with the code. Read that precisely: *verified*
  means "these bytes match the key we ship", and since the key is distributed by the same channel, it is
  not proof that the author is the organisation — only that whoever signed it holds that key. A signature
  that is published and **does not check is a hard refusal that no consent overrides**. Where there is
  nothing to check — **no `.asc` published** (every release tagged before the signing job existed,
  `v1.3.1` among them) or **no `gpg` on this machine** — authorship is unknown, not proven: the scheduled
  run refuses and leaves `needs-consent`, and only a person may proceed with
  `updater check --consent unsigned-release`, which the state file and `gp_diagnose` then keep reporting
  for as long as that release is what is installed. What the residual leaves you: compare the digest the
  page shows against the release page before installing, keep automatic apply off and install by hand, or
  pin the version and update deliberately.
- **It hands node extra trust, and that is the part worth weighing.** node does not read the macOS
  trust store, so on a machine whose HTTPS is re-signed locally (corporate gateway, accelerator) the
  daily job cannot reach the release endpoint at all. The fix: at registration the updater exports
  every certificate from `SystemRootCertificates.keychain` and `System.keychain` into
  `~/.glasspane/ca-roots.pem` and points the job's `NODE_EXTRA_CA_CERTS` at it — measured on the
  author's machine: 158 + 5 = 163 certificates, 161 of them `CA:TRUE`. The consequences, stated in the
  direction they actually run:
  · **Additive only.** The Mozilla bundle stays in force and verification is never turned off — no
  `NODE_TLS_REJECT_UNAUTHORIZED`, no `--insecure`, no cleartext anywhere on the release path. That is
  no longer just a sentence here: `updater/test/trust-inversion.test.mjs` scans the shipped code for
  those switches, comments excluded, and its own self-test has to keep proving it can fail.
  · **Trust settings are not consulted.** `security find-certificate` lists certificates, not what
  macOS is willing to trust. A root an administrator explicitly *distrusted*, or a CA sitting in
  `System.keychain` for some unrelated purpose, becomes a trust anchor for this job even though the
  operating system would refuse it. This is a widening relative to system policy, and it is the real
  content of this bullet.
  · **Certificates that declare `CA:FALSE` are dropped, and that is provably loss-free.** Measured: a
  self-signed `CA:FALSE` certificate handed to node as the only extra anchor does not make a chain
  signed by it verify — OpenSSL refuses with `INVALID_PURPOSE` — so such a certificate could never have
  been used, and removing it only stops the recorded count from overstating what node will act on.
  Anything node cannot judge is kept: the two Apple service identities in this machine's export
  (`com.apple.systemdefault`, `com.apple.kerberos.kdc`) declare **no basic constraints at all** rather
  than `CA:FALSE`, so the filter leaves them in (measured on this machine: 163 kept of 163, 0 dropped;
  161 of them declare `CA:TRUE`). Dropping a legacy root on a guess is how the mechanism breaks.
  · **Who could abuse the widening.** Anyone able to add a CA to those keychains already holds
  administrator access to this machine, which is a strictly larger capability than the one described
  here; the residual risk is the pre-existing certificate, not the export. If you want node to trust
  less, set `NODE_EXTRA_CA_CERTS` to your own bundle before invoking the updater — the updater never
  deletes an inherited value, never retargets a path it did not export, and never sets the key when it
  has no usable bundle (an empty value would silently cancel yours).
  · **Why it is not filtered by trust settings.** Filtering means reading `security dump-trust-settings`,
  which has no machine-readable contract; a filter that silently dropped the intercepting root would
  break exactly the check this exists for. The failure modes that are visible stay visible: a bundle
  holding zero certificates is refused and reported, never recorded as `ok`.
- **The state root became security-relevant.** The job's instructions — including which script to execute —
  come from `~/.glasspane/update-state.json` and `~/.glasspane/update-install.json`, so anything that can
  write the state root or that path pointer can steer an update into `~/Applications` and your global npm
  packages. The daily job also executes a file **inside** the state root by name
  (`~/.glasspane/runtime/agent-entry.js`, the version-independent entry that resolves the pointer each run),
  so writing that file is scheduling code execution as the user; it is therefore written from the release
  tree's own bytes, read back and compared byte-for-byte before the registration that names it, kept `0600`
  under the `0700` root, and never created outside a state root that was actually given. Those files are
  `0600` under a `0700` root: the same gate as section 2.2, which **gates
  accounts, not your own processes** — same-user code is still the adversary, now holding a schedule and a
  binary-replacement capability, and the `~/.glasspane/` handling rules of section 2.4 apply to them.
- **It refuses instead of racing the daemon.** Before a swap, and again immediately before *every* restart
  (including one after a rollback), the updater asks the daemon over its socket whether it is idle; an
  answer means nothing was queued ahead of the probe, i.e. no act is in flight on your screen. No answer —
  busy, unreachable, or an unparsable reply — defers the round and restarts nothing, because
  `launchctl kickstart -k` cancels and rolls back whatever is in flight.
- **A daemon writing to somebody else's state root is not touched**, and the read that decides it fails
  closed: the arguments come from the *loaded* job via `launchctl print`, not from a plist launchd may
  have bootstrapped an older copy of. A job naming another `--state-dir` is refused rather than swapped,
  because replacing bundles another daemon uses changes a second installation, not this machine; output
  that cannot be parsed to the end (no arguments block, unbalanced braces) is "unknown", which is a
  refusal and never a default — a parser stopping at the first `}` would miss a `--state-dir` behind it.
  The settings panel deliberately cannot grant this one; only a person at a terminal can, with
  `apply --consent state-dir`.

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
- Any same-user process can connect to the socket and drive the daemon; the socket's `0600` gates other
  accounts, not other processes of your own account. A probe self-declares its pid. The HTTP gateway's
  only gate is the shared bearer token, it offers no TLS, and it is reachable by any local account that
  can hold the token. Cross-network isolation is out of scope (see section 2).
- No tool call on either surface waits for a person. A frame the socket accepts is carried out, and the
  gateway forwards to that same socket.
- Degradation when Screen Recording or Input Monitoring is missing (`pixelDiff: null`, INCONCLUSIVE, a
  change in the circuit-breaker tier), and tier-1 `restore` refusing with `GP_E_RESTORE_UNSUPPORTED`:
  these degrade honestly, they are not gates to be bypassed.
- The approval ledger currently holds only `daemon:auto` approve records. It is an **after-the-fact
  signed audit chain**, not a human approval gate, and nothing consults it before acting: it is an audit
  surface, not a check that can be switched on.

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
stopping the launchd jobs (`launchctl bootout`, sections 2.5 and 2.8) and removing the granted TCC seats.
