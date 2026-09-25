# Contributing

**English** · [简体中文](./CONTRIBUTING.zh-CN.md)

GlassPane is the **GUI testing and verification layer for AI coding agents on macOS**: an agent calls the
`gp_*` MCP tools to drive an app, and every operation returns the change it actually caused — the
accessibility tree before and after, a numeric pixel measurement, an attribution verdict, and a
checkpoint to roll back to. It exists because agents handle the static half of macOS development
(build, review, unit tests) but are blind at the runtime half, and the usual fallback of
"screenshot → vision model → click coordinates" cannot assert, attribute, repeat or undo. The core
asset is **honesty**: with no measurement the result reads "unverified" — the indicator never goes
green on a lie. Code, tests, docs and PR text all answer to that.

## 1. Development environment

| Dependency | Requirement | Why |
|---|---|---|
| macOS | 14+ | capture uses the macOS 14 form of ScreenCaptureKit (`SCScreenshotManager`, availability-guarded in [SCKCapturer.swift](./engine/Sources/GlassPaneEngine/SCKCapturer.swift)); permissions are 14's TCC |
| Node.js | >= 18 | mcp-shell / kernel / installer are Node ESM (CI runs Node 20) |
| Xcode CLT | `xcode-select --install` | `swift build` / `swift test`, and the bridge's `xcrun lldb` |
| Python | 3.11 | the LLDB bridge pytest suite (pytest is its only third-party dep) and the `engine/` smoke scripts |
| git | any recent version | the installer clones the pinned release tag automatically |

Start from the repo root: `npm ci` → `npm run build` → `cd engine && swift build`.

## 2. Repository layout and how each layer is tested

| Path | What it is | Test it locally |
|---|---|---|
| [engine/](./engine/) | Swift Package: the `glasspaned` background service (Accessibility / Input Monitoring / Screen Recording; unix socket `~/.glasspane/engine.sock`; launchd job `com.glasspane.daemon`) plus the `glasspane-settings` SwiftUI panel. [engine/scripts/make-app.sh](./engine/scripts/make-app.sh) assembles ad-hoc-signed `.app` bundles that the installer places under `~/Applications`, so the TCC pane shows a named, selectable entry instead of a binary hidden in `.build` | `swift build && swift test` in `engine/` |
| [engine/probe/](./engine/probe/) | Separate SPM package `GlassPaneProbe`: the in-process Z1–Z4.5 probe SDK for the app under test | `swift test` in `engine/probe/` |
| [mcp-shell/](./mcp-shell/) | TypeScript MCP stdio server, npm package `glasspane-mcp` | `npm test` in `mcp-shell/`; publish shape also via `npm run bundle` |
| [installer/](./installer/) | Zero-third-party-dependency Node ESM installer, npm package `glasspane-install` | `npm test --workspace glasspane-install` |
| [kernel/](./kernel/) | `@iterate/kernel`, private and **not published separately**: JSON Schema truth source [kernel/schemas/](./kernel/schemas/), shared with the author's iterate ecosystem, inlined into the bundle at publish time | `npm test` in `kernel/` |
| [bridge/](./bridge/) | Python LLDB bridge and pytest suite (the pure-logic core tests without lldb) | `python3 -m pytest -q` in `bridge/` |
| [spike/](./spike/) | feasibility experiments and measured records | not gated |
| [specs/](./specs/) | the Chinese implementation and acceptance specs (PRD, P0–P6, 5.6/5.7/5.8 reviews) = **design of record** | a doc change is itself the PR |

## 3. Gates: seven CI lanes, run them locally first

[.github/workflows/ci.yml](./.github/workflows/ci.yml) has seven jobs; CI only repeats what you should already have measured.

| CI job | Runner | What it measures |
|---|---|---|
| `swift` | macos-latest | engine build, pure-logic tests (no GUI permission needed), the probe package, and the signal-teardown gate `python3 .signal_smoke.py .build/debug/glasspaned`: SIGTERM/SIGINT must self-exit with code 0 and unlink both socket files |
| `bridge` | ubuntu-latest, Python 3.11 | queue / truncation / sentinel / argv / socket loopback, lldb-free |
| `kernel` | ubuntu-latest | C35 roundtrip against fixtures |
| `mcp-shell` | ubuntu-latest | dispatch + tools + engine client, then the publish-shape guard (`npm run bundle`, `npm pack`, install the tarball in a clean directory, complete an MCP `initialize` handshake); a leaked `file:` dep or a missing schema file surfaces here |
| `install-gate` | ubuntu-latest | the root layout that ships: installer units, the kernel → mcp-shell build, all workspace tests |
| `version-line` | ubuntu-latest | every version site against the root manifest |
| `docs` | ubuntu-latest | public docs health: relative links resolve, in-page and cross-page anchors exist, and each bilingual document has both legs (`node scripts/check-doc-links.mjs`) |

The commands the iterate runtime accepts are the closed list in [iterate.config.yaml](./iterate.config.yaml) → `validation.commands`, matched **verbatim**: extra flags or a different working directory are refused.

```text
npm run build
npm test --workspaces --if-present
node scripts/check-version.mjs
swift build --package-path engine
swift test --package-path engine
swift test --package-path engine/probe
python3 -m pytest -q bridge
sh -n install.sh
```

**The engine lanes need macOS 14+.** On Linux only the TypeScript and Python lanes run, so a Linux checkout cannot establish CI
parity alone. CI also cannot run any flow needing a logged-in GUI session, a real TCC seat or a real app under test: those are manual
smoke records in [engine/smoke.md](./engine/smoke.md), run on real hardware (or a self-hosted runner) and filed honestly, failures
and degraded forms included. "CI is green" is never a substitute for "verified on hardware".

## 4. Test isolation: never point a test at a real user path

- Tests inject their own temp locations. **Never construct `ProjectRegistry()` with the default path** — it resolves
  `~/.glasspane/projects.json`, the developer's own registry. One `swift test` run replaced 71 real registrations with 2 synthetic
  fixtures, unrecoverable: see the `live()` warning in [ProjectRegistry.swift](./engine/Sources/GlassPaneEngine/ProjectRegistry.swift) and the comment near `engine/Tests/GlassPaneEngineTests/EngineCoreTests.swift:1336`.
- Pointing `HOME` at a sandbox does not help — the home lookup behind those defaults ignores `HOME`
  ([StateRoot.swift](./engine/Sources/GlassPaneEngine/StateRoot.swift)). Use an explicit argument: `TestSandbox.directory(…)`, `TestSandbox.projectRegistry(…)`, `TestSandbox.evidenceStore(at:)` from [TestSupport.swift](./engine/Tests/GlassPaneEngineTests/TestSupport.swift).
- Two gates fail the suite rather than warn: [TestIsolationGateTests.swift](./engine/Tests/GlassPaneEngineTests/TestIsolationGateTests.swift)
  and [ProjectRegistryIsolationTests.swift](./engine/Tests/GlassPaneEngineTests/ProjectRegistryIsolationTests.swift), the latter
  forbidding in `Tests/` the calls `ProjectRegistry.live()`, `EvidenceStore.live()`, `ApprovalGate.defaultPath`,
  `EvidenceStore.defaultDirectory`, `LocalArchive.scanEvidence()`, `LocalArchive.readApprovalLedger()`. Never widen either gate to make a test pass — that reopens the hole.

## 5. Version line and releases

- MIT; repository `jingzhao-l/GlassPane`; npm bare names `glasspane-mcp` and `glasspane-install`; the kernel ships in no package of
  its own.
- One number serves the whole repo: root workspace, both npm packages, kernel, MCP `serverInfo`, daemon `hello`, the `.app` bundle
  version, the release tag pinned in [install.sh](./install.sh) and [installer/cli.js](./installer/cli.js), and the lockfiles.
- `node scripts/set-version.mjs <semver>` is the **only** way to change a version: it rewrites every site listed in
  [scripts/version-sites.mjs](./scripts/version-sites.mjs) in one pass. Hand-editing a single `package.json` causes drift and `node scripts/check-version.mjs`
  (job `version-line`) fails on it. Drift is dangerous, not cosmetic: a tag install yields source that differs from the registry
  package and a version that differs from the panel. Automation: [.github/workflows/release.yml](./.github/workflows/release.yml).

## 6. Commits and pull requests

- Conventional Commits prefix with a Chinese body, matching history: `fix: 请求超时定时器不再 unref……`,
  `ci+release: provenance 发布通道与 publish-shape 守卫……`, `docs: ……`, `install: ……`. Repo docs and commit bodies stay Chinese (`language: zh` in [iterate.config.yaml](./iterate.config.yaml)).
- **One logical change per commit** — practised here, not a slogan: a test and its implementation may share a `test+fix:` commit;
  changes spanning lanes get split. Branches `feat/…`, `fix/…`, `docs/…`, `infra/…`; PRs target `main`.
- Tick the checklist in [.github/pull_request_template.md](./.github/pull_request_template.md) honestly: anything not run stays
  unticked with "not run + reason". A tick on a line you did not run is a defect.

## 7. specs/ is the design of record

- Behaviour is specified and accepted in `specs/` first; code is one implementation of it. Change **behaviour** (semantics, error
  codes, degraded forms, permission subject, evidence fields) → update the matching `specs/` document in the same PR; a pure refactor with byte-identical behaviour → say so explicitly in the PR description.
- Adding or changing a `gp_*` tool means three places stay in sync, and a missing one is an incomplete change:
  [kernel/schemas/](./kernel/schemas/) (JSON Schema truth), the daemon's method table and classifier in
  [engine/Sources/GlassPaneEngine/](./engine/Sources/GlassPaneEngine/), and the tool table [mcp-shell/src/tools.ts](./mcp-shell/src/tools.ts).
- The error-code table (`GPErrorCode` in [ProtocolErrors.swift](./engine/Sources/GlassPaneEngine/ProtocolErrors.swift)) is frozen:
  fix failure paths under "code unchanged, semantics unchanged, remedy executable" — a remedy is a command an agent can run directly.

## 8. Verification honesty

- Nothing goes green without a measurement: status bits, `attribution.level`, the panel's permission cards, acceptance ticks. Not
  measured reads `unverified` / `INCONCLUSIVE` / a structured degradation.
- Do not manufacture a passing gate: skipping assertions, loosening thresholds, or feeding unit tests mocks for what only hardware
  can prove (debugger attach) is a defect, not a fix. A degraded form is labelled degraded — without Screen Recording, pixelDiff is
  null and the verdict degrades to INCONCLUSIVE; that is neither a failure nor a success.
- Permissions are ticked by a human in System Settings, item by item; no program can do it, and the granting subject must be the
  daemon binary itself — not the terminal, not the settings window. Changes to permission subject or artifact identity need hardware
  re-verification in [engine/smoke.md](./engine/smoke.md).

## 9. Communication

- Questions and feature requests: GitHub issues — the templates in [.github/ISSUE_TEMPLATE/](./.github/ISSUE_TEMPLATE/) ask for what
  this product needs. Security: [SECURITY.md](./SECURITY.md); do **not** paste tokens, raw logs or evidence packs into public issues.
- Reviewed by the single maintainer in [.github/CODEOWNERS](./.github/CODEOWNERS); small focused PRs merge faster than large ones.
  See also [README.md](./README.md) and [CHANGELOG.md](./CHANGELOG.md).
