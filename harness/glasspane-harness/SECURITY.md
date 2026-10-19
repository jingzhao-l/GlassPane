# Security Policy

## Reporting a vulnerability

Report privately to the maintainer of
[GlassPane](https://github.com/jingzhao-l/GlassPane) (the engine project and the owner of
this product). Include: what you ran, the version (`glasspane-harness --version`), the
engine version (`gp_probe_status` output), and a reproduction. Do not open a public issue
for a suspected vulnerability in the engine or the harness.

Please do not test against other people's applications without permission. This harness
can move a real UI (`gp_act`); "it is just a local app" is exactly the property that
makes a reportable bug.

## What this product does with permissions

On macOS the `gp_*` tools need the GlassPane engine, which needs system permissions:

| Permission | Why | If missing |
|---|---|---|
| Accessibility | read and drive the accessibility tree (`gp_observe`, `gp_act`) | engine reports the seat as not granted; the tool call answers with a remedy |
| Input monitoring | correlate input events with observed changes | attribution quality drops (engine-side, reported) |
| Screen recording | pixel diffs | `pixelDiff` signal absent; the engine says so |
| Developer tools (probe SDK) | optional in-app instrumentation | optional; the engine advertises it as absent |

Every mutating tool call goes through the harness permission plane (a prompt) before the
engine is asked to act, and the engine — not the harness — decides what happened. The
harness's own local state lives under the four XDG roots named by
`packages/core/src/global.ts`: `~/.local/share/glasspane-harness` (data),
`~/.cache/glasspane-harness` (cache), `~/.config/glasspane-harness` (config) and
`~/.local/state/glasspane-harness` (state). `~/.glasspane-harness/bin` is not a state root —
it is the one-click installer's fallback bin root (`scripts/install.sh`, `INSTALL_ROOT`).
Be exact about modes, because this page used to claim more than the code does: those four
roots are created with `fs.mkdir(path, { recursive: true })` and **no `mode` argument**, so
they take the process umask and are not a private-owner directory. What the code *does*
restrict: the decision-log file is opened with mode `0600` and then `fchmod`-ed to `0600`
(the installed `iterate-kernel`'s `dist/decision-log.js`), the directory the ledger is created
in is made `0700` when the binding has to create it
(`packages/opencode/src/tool/glasspane/kernel.ts`), and the lock/breaker directories under the
state root are `0700` (`packages/core/src/util/flock.ts`). So the audit trail is private; the
directories above it are as private as the umask makes them. Nothing in the tool surface writes
inside the engine's state root; the binding refuses that path by design.

### Code that comes with the repository is not executed

Opening a directory makes this product read that directory's config. It does **not** run
plugins it finds there: a file matching `<project>/.glasspane-harness/plugin/*.ts` (or
`plugins/`, or the upstream `.opencode` spelling) is discovered and then refused, because
importing it is arbitrary code execution and the process doing it holds the `gp_*`
accessibility surface — a drive-by checkout would otherwise get both code execution and the
ability to move real apps. Set `GLASSPANE_HARNESS_TRUST_PROJECT_PLUGINS=true` for a run where
you do trust the checkout, or put the plugin in your config's `plugin` list, which is a name
somebody wrote down and is loaded as before. The refusal is logged with the count of files it
held back; nothing about it is silent.

## Dependency posture

- Upstream opencode is **pinned** (`v1.18.32`) and the divergence from that pin is
  measured, not described: `harness/tools/fork-diff.mjs` and the weekly
  `harness-contract` workflow.
- The shared kernel is a **registry dependency** (`iterate-kernel`, exact-pinned in
  `packages/opencode/package.json`, resolved through the fork's lockfile). Its provenance is
  checked, not assumed: `script/kernel-pin.mjs --check` verifies the installed version, that
  `bun.lock` resolved it from the registry rather than a `file:`/`link:` path, the recorded
  lock integrity, and the per-file sha256 of every contract file the package ships
  (`contracts/kernel-pin.json`; `--check` prints how many that is — 26 measured 2026-10-13). Since 2026-10-08 there is no vendored copy of the kernel in
  this tree — `tool-surface.mjs` refuses the old `packages/opencode/vendor/kernel` path
  reappearing. The dependency is exempted from the 3-day `minimumReleaseAge` window because
  its upstream is the same maintainer, and its bytes remain pinned by lock integrity plus the
  pin manifest.
- Dependabot is disabled on purpose: an auto-bump can pass this repo's CI and still
  invalidate the recorded divergence surface.
- npm releases are published from this repo's Release workflow with `--provenance`, so the
  registry records a signed provenance statement tying the published tarball to the commit
  and workflow run that built it. What is **not** in place is npm's repository-side Trusted
  Publisher setting: publishing currently authenticates with the workflow's OIDC identity
  per-run, and a run that reports "staged, not published" has published nothing. `npm view
  glasspane-harness@<version>` and `npm audit signatures` are the checks, not a green job.
- Release assets (`glasspane-harness-darwin-<arch>.zip`) carry a `SHA256SUMS.txt` manifest
  and a detached GPG signature per asset (`.asc`). The signing key's full fingerprint is
  asserted, not just mentioned: `scripts/install.sh` carries both the armored public key and
  the fingerprint it requires a `VALIDSIG` to match. What is **not** yet asserted is that the
  release lane's `GPG_PRIVATE_KEY` secret *is* that key — CI signs with whatever the secret
  holds, so the installer's check is the enforcement point, not a CI step.
- Two ordering decisions close the window that made the above exploitable. The GitHub release
  is created **draft** and only `publish-release` makes it visible, after the manifest and every
  `.asc` have landed: a public release with no manifest was installable through the `curl` lane
  while the signing job was still running. And each `binaries` job records the sha256 of the
  archive it built as a workflow artifact; `checksums` refuses any served asset whose bytes do not
  match that build-time hash (and any hash with no asset), so the manifest is no longer computed
  from whatever the release happened to be serving at the moment the checksum ran.

## Verifying what you installed

A version string that prints is not evidence the bytes are the bytes that were published.
Both channels have a check, and neither check is performed on your behalf unless you ask:

```bash
# npm channel: does the registry vouch for these bytes, and does the attestation resolve?
npm audit signatures --prefix "$(npm root -g)/.."   # provenance + registry signatures

# release-asset channel: checksum, then signature, then the identity of the signer
shasum -a 256 -c SHA256SUMS.txt                     # integrity of the downloaded bytes
gpg --verify glasspane-harness-darwin-arm64.zip.asc \
           glasspane-harness-darwin-arm64.zip
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt     # the manifest itself is signed too
```

A checksum answers "did the transfer arrive intact"; only the signature answers "who made
this", and `SHA256SUMS.txt` is served from the same origin as the asset it lists — so on its
own it cannot survive a replaced release. An **absent** manifest or `.asc` is refused: the
release lane writes both for every target and fails the run when either is missing, so their
absence describes a broken or replaced release rather than a policy the installer may waive.
A signature that **does not verify**, or one made by a key other than the fingerprint above, is
refused for the same reason. Installing over a missing manifest is possible only by name —
`GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1` — and the summary line then records that the override,
not the release, is why nothing was verified.
