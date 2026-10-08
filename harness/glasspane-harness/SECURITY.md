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
harness's own local state lives under `~/.glasspane-harness` (0700) and the decision log
is written 0600. Nothing in the tool surface writes inside the engine's state root; the
binding refuses that path by design.

## Dependency posture

- Upstream opencode is **pinned** (`v1.18.32`) and the divergence from that pin is
  measured, not described: `harness/tools/fork-diff.mjs` and the weekly
  `harness-contract` workflow.
- The vendored `@iterate/kernel` mirror is pinned by per-file sha256 with a provenance
  manifest.
- Dependabot is disabled on purpose: an auto-bump can pass this repo's CI and still
  invalidate the recorded divergence surface.
- npm releases are published from this repo's Release workflow with `--provenance`, so the
  registry records a signed provenance statement tying the published tarball to the commit
  and workflow run that built it. What is **not** in place is npm's repository-side Trusted
  Publisher setting: publishing currently authenticates with the workflow's OIDC identity
  per-run, and a run that reports "staged, not published" has published nothing. `npm view
  glasspane-harness@<version>` and `npm audit signatures` are the checks, not a green job.
- Release assets (`glasspane-harness-darwin-<arch>.zip`) carry a `SHA256SUMS.txt` manifest
  and a detached GPG signature per asset (`.asc`), signed by the key whose full fingerprint
  is recorded in `product.json` and embedded in `scripts/install.sh`.

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
own it cannot survive a replaced release. An **absent** `.asc` is a policy gap and the
installer says so and continues; a signature that **does not verify**, or one made by a key
other than the fingerprint above, is a tampering signal and the installer refuses it.
