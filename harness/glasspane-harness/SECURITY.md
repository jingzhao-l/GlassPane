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
- npm releases carry provenance in CI (Trusted Publisher, staged-only); the install path
  is `npm install -g glasspane-harness` or the reviewed one-click installer.
