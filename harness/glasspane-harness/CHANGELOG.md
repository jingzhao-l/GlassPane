# Changelog

All notable changes to **glasspane-harness** (the product) are recorded here. The
per-batch measurements of the *fork* live in `SYNCLOG.md`; upstream opencode's own
changelog is not this file's subject.

The format follows [Keep a Changelog](https://keepachangelog.com/); the product uses
semantic versioning starting at `0.1.0` (pre-1.0: the surface may still move, the evidence
contract does not).

## [0.1.0] - 2026-09-25

First public release of the private customisation. Everything below is a decision that
used to be upstream's, recorded so the next release notes can be diffed against reality.

### Added
- Product identity: `glasspane-harness` (binaries, `gp-harness` alias, npm wrapper
  `glasspane-harness` + 12 platform packages, user agent, mDNS name, `~/.glasspane-harness`
  state root, `glasspane-harness.json(c)` config names with upstream names kept as legacy
  fallbacks, default TUI theme, basic-auth default user name).
- GlassPane's native `gp_*` tool surface: `gp_probe_status`, `gp_attach`, `gp_observe`,
  `gp_act`, `gp_diagnose`, `gp_last_evidence` — capabilities read from the running engine,
  never hard-coded.
- Evidence discipline: hash-chained decision log (op id ↔ entry hash) written through the
  vendored `@iterate/kernel`; a compaction hook that re-injects the session's evidence
  anchors; tool-surface ratchets that keep judgement in the engine (no threshold, pixel
  verdict or pass/fail synthesis in a shell).
- Session-flow evidence rendering in the TUI (engine refusal vs engine answer are visually
  distinct; the row model is a pure function the fixed points pin).
- Product surfaces: CLI + TUI, the **web app embedded in the binary**, the docs site and
  in-repo `docs/`, SDKs shipped with the tree.
- One-click installers (`scripts/install.sh`, `install.ps1`): npm first, GitHub release
  asset as fallback, verification step, and the GlassPane-daemon prerequisite spelled out.
- Fixed-point tests for every module (M1–M5), plus two runtime probes: E7 (decision chain
  against bytes the engine wrote) and E8 (the compaction hook against a real host).

### Changed
- Project configuration directory is `.glasspane-harness/`; `.opencode/` is still read
  (legacy), and when both exist the product's directory wins the merge.
- Web UI embedding is the default again (`--skip-embed-web-ui` opts out).
- `glasspane-harness --version` reports the manifest's version verbatim (it used to
  inherit upstream's release-time patch bump and print a version that was never built).

### Removed (on purpose, recorded)
- The hosted console / enterprise / stats stack and its SST infrastructure — a private
  harness has no organisation-and-quota back office.
- Paths that would have executed or published *another project's* assets: the upstream
  docker/AUR/Homebrew publishing tail and the `opencode.ai/install` self-upgrade.
- The Electron desktop app is not shipped in 0.1.0 (second batch; needs signing and
  notarisation accounts). It remains in the tree as lineage.

## [0.2.0] - 2026-09-25

The companion product surfaces, brought in as first-class citizens (owner decision:
"那几个配套产品面还是需要的"), plus the release infrastructure around them.

### Added
- **Web app embedded in the binary again** (upstream default, and what iterate-harness
  does with its dashboard): `glasspane-harness serve` serves the browser UI from the same
  process. `--skip-embed-web-ui` still produces a CLI-only build, and a build without the
  bundle starts and says the UI is absent instead of failing.
- Product README (EN + 简体中文) rebuilt in the iterate-harness shape: language switch,
  npm-downloads / version / CI / license / stars badges, product-surface table, the
  problem statement, quick start, docs index, and the attribution block.
- `assets/logo.svg` + `assets/banner.svg` (SVG on purpose: the brand stays diffable text).
- `docs/` (six pages: index, install, tools, evidence, migrate-from-opencode,
  troubleshooting) — the in-repo canonical documentation the READMEs link to.
- `CHANGELOG.md` for the product (this file), `SECURITY.md` for the product (upstream's
  pointed at upstream's disclosure process).
- GitHub issue templates (bug with a mandatory `gp_probe_status` payload, feature with an
  "which evidence does it rely on" question) and a PR template carrying the line's
  checklist (fork-diff record, product.json first, brand gate, fixed points with reverse
  controls, stated boundaries).

### Changed
- The docs link checker now covers the product's documents too (24 files, 212 links): a
  dead link in the product README is the same red as one in the repository's.
- The M1 rows in `FORK.md` / `SYNCLOG.md` no longer hard-code a tool count — the count was
  a claim the checker could not verify, and this line's doctrine is "read it from
  `hello.capabilities`, never copy it".

### Not in this release
- The docs **site** (`packages/web`) is still upstream's Astro/Starlight tree: it builds
  and is kept for lineage, but its content is not yet our documentation. Until that is
  done, the canonical docs are `docs/` in this repository — the docs site is marked
  `not-yet-ours` in `product.json` rather than being quietly presented as finished.
- Electron desktop app (second batch; needs signing and notarisation accounts).

## [0.5.1] - 2026-09-26

**The same content as 0.5.0, published cleanly.** 0.5.0 exists on the registry because
two publishes of it were launched by mistake and raced; npm accepted one and staged the
other, which burned the number for the wrapper. The release moved to 0.5.1, and
`publish.ts` now takes an exclusive lock (`dist/.publish.lock`, an atomic `mkdir`) so two
publishes cannot run at once — a mistake that cost a version number is now a script bug
instead of an operator one.

## [0.5.0] - 2026-09-26

**The product surface says our name, everywhere a person can see it — and the trees that
were never ours are gone from the repository.**

### Changed — the private-isation, audited rather than assumed
- **Environment variables**: every knob now has a `GLASSPANE_HARNESS_*` name, resolved in
  one place (`flag/flag.ts`'s `read()`). The old `OPENCODE_*` names still work — a
  private-isation that silently ignores a setting someone already exported is its own bug.
- **What we call ourselves on the wire**: `X-Title`, `X-Source`, `User-Agent`,
  `originator`, `HTTP-Referer`, the MCP client name and the OTLP service name all say
  `glasspane-harness`. Previously a request to OpenRouter, Cerebras, Kilo, Vercel,
  NVIDIA, Zenmux or a user's own web fetch identified itself as opencode.
- **The user's own files**: the database is `glasspane-harness.db` (with a one-time rename
  of the old file — losing someone's session history would be the worst possible
  private-isation bug), the log is `glasspane-harness.log`, and the server's basic-auth
  default username is the product's rather than `opencode`.
- **The LAN**: the mDNS default is now actually `glasspane-harness.local`. The help text
  was rebranded in 0.1.0 while the value was not, so the product advertised one domain and
  announced another.
- **The CLI**: `scriptName` is the product's, which is what `--help` and usage errors print.
  The ACP integration (what editors launch) no longer advertises a login that cannot exist.
- **The built-in skill** is `customize-harness`, and its body documents this product's
  config paths. It is injected into every session, so its text is product surface.
- **No third-party `$schema` is written into your config any more.** Upstream injected
  `https://opencode.ai/config.json` into every file it opened; the first line of a user's
  own config was somebody else's URL.
- First-party remnants removed from the TUI and web app: the Zen upsell and its link, the
  "free models" claims, the paid-plan nudge, the recommended tags, the provider ordering
  that floated the house gateway to the top.

### Removed — trees that were never this product
`packages/console`, `packages/enterprise`, `packages/stats`, `packages/web` (the docs
site), `packages/storybook`, `packages/containers`, `packages/function`,
`packages/identity`, `packages/slack`, `packages/docs`, plus `artifacts/` (an upstream
promo-video project for a model release), `.vscode/`, `install/` (the upstream
`opencode.ai/install` script), `nix/` + `flake.*`, `sdks/vscode` (an editor extension),
`infra/` + `sst.config.ts`, `perf/`, `github/` (the upstream bot action) and
`screenshot-uk.png`. None of them were referenced by shipped code — measured, not assumed.

**Kept on purpose**: `packages/desktop` (product surface, batch 2), `patches/` (bun
applies them at install time), `specs/` (the design record of the code we maintain).

### Gates
- `brand-surface` gained five rule classes — first-party gateway, wire identity, foreign
  schema writes, product file names, and removed trees — with a short explicit allowance
  list for the three places that legitimately *read* an old name (the database migration,
  the legacy config file names, a stored theme id).
- The ruler's own blind spot was fixed: `fork-diff` used to treat gitignored build output
  as "a file that exists but was never committed", which is the same class of false
  positive as the import bug it was built to catch.

## [0.4.0] - 2026-09-25

**A complete programming agent with the GlassPane kernel fused in — and no account to
log into.** This release is mostly the removal of a first-party vendor surface, plus the
npm and docs work that goes with it.

### Added
- `docs/models-and-keys.md` — the model catalog and the three ways to supply a key
  (env var, `{env:NAME}` config template, TUI `/connect`). "Bring your own key" is now the
  documented model story, not an accident.
- `docs/release.md` — the release runbook, including the **npm trusted-publisher setup**
  for all three packages (the field values are pinned to what `release.yml` presents:
  owner `jingzhao-l`, repo `glasspane-harness`, workflow `release.yml`, environment
  `release`). Until that is configured, CI cannot publish; the manual path is documented
  too.
- **npm READMEs.** 0.2.0's npm pages were a bare version string. The wrapper now ships the
  product README (EN + 中文) and each platform package ships a short README that says what
  the binary is and points at the wrapper. `publish.ts --dry-run` fails without them, so a
  README-less tarball cannot ship.
- The publishing jobs carry `environment: release`, which is both the value npm's trusted
  publisher must match and a place to require a human reviewer.

### Changed
- **This repository's own project directory is now `.glasspane-harness/`** (was upstream's
  `.opencode/`): the agent, command, skill, glossary and theme config that opencode used to
  develop itself now lives under the product's own name, so the repo dogfoods the rename.
  `.opencode/` is kept as a *read-only compatibility target* in a user's project — a
  `product-surface` assertion fails if a `.opencode/` reappears at the root **or** if the
  compat read is deleted.
- The repo's dev config file is `glasspane-harness.jsonc` (the name the product reads
  first).

### Removed — the first-party account surface (BYOK instead)
- The `opencode` first-party provider is filtered out of the model catalog.
- `auth login` / `logout` / `switch`, the `/org` TUI command and the console-org dialog.
- `/experimental/console*` server endpoints, the console-managed-provider config state,
  and the provider dialog's "managed by console" branch.
- Session sharing to opencode's cloud: the share modules, share/unshare endpoints, the
  `share` and `autoshare` config keys, the TUI `/share` command and the web app's share
  affordances (kept in the component shape, permanently off, one line to flip).
- The local `account` / `account_state` tables are no longer managed by the schema. The
  tables remain in existing databases — no destructive migration; the rows are inert.
- `import <share-url>` no longer fetches console shares; import a local JSON export.

Everything else in the catalog is untouched: Anthropic, OpenAI, Google, GitHub Copilot,
Bedrock, Azure, OpenRouter and the rest still ship, unlocked by your own key.

## [0.3.0] - 2026-09-25

**macOS-only, and the npm distribution says so.** The GlassPane engine, its four macOS
permission seats and the whole evidence pipeline exist only on macOS, so the product is
macOS-only (owner decision). The npm side enforces it rather than describing it.

### Changed
- The npm distribution is macOS-only: the wrapper declares `os: ["darwin"]` /
  `cpu: ["arm64", "x64"]`, so `npm install` on Linux or Windows is **refused by the
  package manager with a reason** instead of downloading a binary that cannot run. The
  target matrix in `product.json` is now exactly the two macOS targets.
- `scripts/install.ps1` (Windows one-click) is **removed** — the POSIX installer is the
  only one, and on a non-macOS host it says "macOS-only is a decision, not a missing
  port" and exits.
- The Linux/Windows/Intel-baseline platform packages published before this decision are
  **deprecated on npm with the reason attached** (they cannot be unpublished; a
  deprecation that explains itself beats a package that still installs).
- The release lane builds the two macOS targets on `macos-14` / `macos-13`.

### Added — npm infrastructure
- `publish.ts --dry-run`: packs every artifact and validates its shape **without
  touching the registry** — bin targets exist inside the tarball, the platform binary is
  present and executable, the wrapper's `optionalDependencies` match `product.json`'s
  target matrix, and the wrapper's `os`/`cpu` agree with the product's platform block.
  Wired into the fork's CI, so a broken package shape fails a PR instead of a release.
- `verify-published.ts`: "published" is not "works" — installs the **published** tarball
  into a throwaway prefix, runs `--version`, and confirms the embedded web app is served
  by that binary. Runs as the release lane's final job; on a non-macOS host it asserts
  that npm refuses the install.
- Wrapper metadata completed for its npm page: `engines.node`, `funding`,
  `publishConfig` (access + tag), `sideEffects`, and a dist-tag policy —
  `latest` for stable, `next` for anything on a non-latest channel, so a preview can
  never be installed by `npm i -g glasspane-harness` by accident.
- The npm publish/deprecation policy is recorded in `product.json` (`npm` block) so it
  travels with the code instead of living in someone's head.

### Docs
- READMEs, `docs/install.md`, `docs/index.md` and `docs/troubleshooting.md` state the
  platform boundary up front, with the npm `EBADPLATFORM` case in the troubleshooting
  table.
