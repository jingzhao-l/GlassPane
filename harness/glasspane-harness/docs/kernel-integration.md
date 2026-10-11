# The shared kernel, and what "bidirectional" actually means

The harness consumes one shared semantic kernel with the rest of the iterate ecosystem
(`iterate-harness`, `iterate-plugin`, and a third project). This page is the standing
answer to three questions that keep coming back: what the kernel *is*, how it reaches this
fork (its delivery form changed on 2026-10-08 — a vendored source copy became a pinned npm
dependency), and how much of the promised two-way integration exists today.

## What the kernel is

`@iterate/kernel` — the canonical home is `kernel/` in
[iterate-skill](https://github.com/jingzhao-l/iterate-skill), published to npm as
**`iterate-kernel`**. It is a **TypeScript semantic layer**, not a verification engine:

| It owns | It must never own |
|---|---|
| schemas (config / evidence / decision-log entry), the audit-chain mapping, orchestration primitives, public validators | any verification reasoning — that stays in the Swift engine, 100% |

The fork's only doorway is `packages/opencode/src/tool/glasspane/kernel.ts`. We use it for
exactly what it is: `decisionOutcomeFromEvidence` and `decisionSummaryFromEvidence`
(evidence → decision, read side), the decision-log chain primitives (write side, used by
the decision-log and compaction plugins), `dimensionContext` (the dimension accounting M4
renders verbatim), and the `parse*` validators that gate what reaches those mappings. The
three JSON Schema files belong to the package too — this fork pins their bytes as contract,
but it does not import the module that reads them off disk at load time, because that module
is reachable only through the barrel (see below). The kernel transcribes; it never judges —
that boundary is the architecture's first iron law, and it is why the mapping lives in the
kernel instead of in each shell.

## How the fork gets it: a pinned dependency (since 2026-10-08)

The kernel is **not vendored**. `packages/opencode/vendor/kernel/` (25 files — 11 sources,
3 schemas, 11 fixtures) was deleted, and `packages/opencode` now resolves `iterate-kernel`
as a normal dependency at an exact pin (`0.1.3`), recorded with registry resolution and
integrity in `bun.lock`.

Two gates carry what `kernel-vendor.mjs` used to carry — one replaced outright, one rewritten
to aim at the installed package:

- **`script/kernel-pin.mjs`** (with `contracts/kernel-pin.json`) is the provenance gate, and
  it checks four separate things: the *installed* version equals the pin; the `bun.lock`
  specifier for that resolution is **empty**, i.e. it came from the registry and not from
  `file:`/`link:` (a local-path resolution would mean the product ships a directory nobody
  else can install); the lock integrity equals the pinned integrity; and the sha256 of the
  **17 contract files the package ships** (13 fixtures + 4 schemas) equals what the manifest
  records. `--probe` asks the registry (`npm view iterate-kernel version`) rather than
  `git ls-remote`, because the thing that goes stale now is the published line, not a branch
  head.
- **`script/kernel-conformance.mjs`** is the behaviour gate: it runs the corpus that ships
  *inside the installed package* through the installed `dist`, and `--impl <path>` runs a
  second implementation (a canonical checkout) and requires byte-identical answers. Since
  2026-10-08 it also drives `dimension-context`, which the fork consumes but which nothing
  had ever checked against a fixture.

Immutability moved from "our vendor tree equals our manifest" to "the artifact npm served
for this version is the artifact we recorded" — which is only a stronger statement because
somebody checks it.

Three accounting consequences are worth naming:

- `tool-surface.mjs` no longer excludes any kernel lines, because there are none in the tree:
  the vendored exclusion is **0 files / 0 lines** (it was 11 files / 1,464 lines). The golden
  now records `kernel: iterate-kernel@0.1.4` so the change of caliber is readable on the ruler
  rather than only in a commit message. And the guard inverted: `measureFork` **refuses** the
  tree if `packages/opencode/vendor/kernel` reappears, because its 1,464 dependency lines
  would be billed as our authorship with nothing left to exclude them.
- The mirrored contract corpus `harness/contracts/kernel-fixtures/` (9 files) was deleted. A
  mirror is a second source of truth, and it had already drifted — 9 here against 11 published.
  The corpus is pinned by sha256 in `kernel-pin.json` instead.
- `tools/sync-kernel.sh --target=fork` refuses outright and prints the replacement procedure:
  bump the dependency in `packages/opencode/package.json`, `bun install`, then
  `node script/kernel-pin.mjs --record`, then `bun script/kernel-conformance.mjs --impl <canonical
  kernel checkout>`. Copying bytes into a vendor tree would recreate the copy this retirement
  exists to remove. `--target=repo` (the `kernel/` mirror for mcp-shell) is unchanged for now.

**One import-shape constraint, and it is a product requirement, not a style choice.**
`kernel.ts` imports per-module subpaths (`iterate-kernel/parse` and friends) and never the
barrel. The barrel re-exports `schemas`, which reads the three JSON Schemas next to the
package at module load through `createRequire(import.meta.url)` — a runtime file read that a
single-file binary cannot satisfy. This is measured, not argued: after the switch,
`bun run script/build.ts --single --skip-install --skip-embed-web-ui` compiles and its own
boot smoke passes (`dist/glasspane-harness-darwin-arm64/bin/glasspane-harness --version` →
`0.7.0`). Changing the delivery form means re-running that lane, because "it builds" is
otherwise last batch's conclusion.

## Why it took until now to publish

Not publishing was a **recorded decision**, not an unfinished task:

- **P6 §13** (a directive executed 2026-09-21): the kernel is not published separately; a
  `file:` dependency leaks out of a published manifest, so the build-local shell inlines the
  bytes. **P4 §33.2**: registry publishing follows the iterate monorepo's own release policy.
- The fork could not use a relative `../../kernel` import either: it ships as a
  **subtree-split repository**, so that path breaks on the first release. That left vendoring
  or npm, and npm was not published — so vendoring.
- The research note that first proposed "publish the kernel as action #0" **corrected itself**:
  it had read a strategy as a to-do. "npm dependency" in the architecture documents describes
  the dependency's *direction and accounting*, not an instruction to publish.

The decision was reversed on the iterate side, and the enabling fact was small and
measurable: **`0.1.2` ships the fixtures inside the tarball; `0.1.1` shipped none** (measured
with `npm pack`). Until a consumer could obtain the contract bytes, vendoring was the only
form that let it hold them. Two other defects had to be fixed first, and both were found by
our own lanes:

- The `exports` map offered only the barrel, and the barrel pulled `schemas` with its
  module-load file read — publishing that would have shipped a package that breaks its first
  consumer. There is now a subpath export per module, a license, and a `prepublishOnly` build.
- The package pinned `zod: 3.25.76` while its schemas are written to work on zod 3 and 4
  alike. An installed copy therefore pulled its own zod 3 under a zod 4 consumer, and the
  kernel's *error text* changed with the delivery form: the same rejected fixture said
  `Invalid input` vendored and `Invalid literal value` installed. The range is now
  `>=3.25.76 <5`, and the two forms answer identically — the conformance lane prints the
  remaining zod-major difference in error prose as a note instead of hiding it.

Publishing also never required the `@iterate` scope that the earlier drafts of this page
treated as a blocker. The package is unscoped (`iterate-kernel`), so "do we own the scope?"
was a question about a form nobody had to take.

## Is publishing to npm *required* for bidirectional integration?

**No — not for any specific scenario. Yes — for enforcing "one kernel" across N consumers
at scale.** Those are different claims, and conflating them is what made this look blocked
for so long.

What a two-way scenario (the R40 list) actually needs:

1. **One implementation and one schema, both sides agreeing on the semantics** — evidence
   attribution levels, circuit-breaker level, the opID ↔ decision-log hash chain. Any
   delivery form achieves this; the channel is irrelevant.
2. **The kernel exposing the hook the scenario needs** — `dimensionContext` for
   dimension-aware compression, a decision-log writer for "evidence into iterate's decision
   log", invariant evaluation for "invariant triggers re-verification". This is an **API**
   problem, not a distribution problem.
3. **Cross-product verification that both sides really agree** — the R34 consumer matrix.
   This is where distribution matters:

| | vendored copies (before 2026-10-08) | one npm version (today) |
|---|---|---|
| identity | each consumer carries bytes; equality is a convention | one resolved version; `npm i` proves it |
| API break | found by a conformance suite, per consumer, after the fact | found at install/typecheck, in every consumer at once |
| version skew | a sync PR per consumer, like our fork sync | a resolvable dependency range |
| patches | re-vendor + re-record per consumer | one publish |
| what it does **not** give you | — | the semantics themselves |

So publishing is the cheapest way to make "N consumers, one kernel" *mechanically* enforced
rather than conventional — and it removes the per-consumer sync tax. It is not a prerequisite
for any R40 scenario; every one of them was blocked on kernel API work first.

## What exists today (2026-10-08, measured)

- **Consumption side: done and measured.** One module touches the kernel, and it resolves a
  registry package whose version, lock integrity and 17 contract files are pinned by
  `contracts/kernel-pin.json`.
- **Publishing: done, by the iterate side, and consumed.** `iterate-kernel@0.1.3` (0.1.1 → 0.1.2 added the contract corpus to the tarball; 0.1.2 → 0.1.3 added `evidence-decision.ok-01.json`, the transcription contract the Python half of iterate-harness is written against).
- **Behaviour parity: measured across two implementations.** Nine fixtures produce identical
  answers through the installed `dist` and through a canonical kernel checkout
  (`kernel-conformance --impl`), with the zod-major error-prose difference reported as a note.
- **Both former API blockers are gone.** `dimensionContext` is in the dependency and the fork
  consumes it (`kernel.ts` → `dimensionCoverage` → `src/plugin/glasspane-compaction.ts`), so
  the sentence this page used to carry — "`dimensionContext` does not exist at the pinned
  version" — is no longer true and was not corrected when the pin moved. The decision-log
  writer is likewise in the dependency (`appendDecisionLogEntry`), produced by this fork's M2
  plugin path rather than by a private second implementation.
- **A latent silent pass, found while making the switch.**
  `packages/opencode/test/tool/glasspane-kernel.test.ts` resolved the provenance manifest five
  `../` levels up, which landed on `harness/contracts/kernel-vendor.json` — a file that never
  existed there. Its `existsSync` guard printed a warning and returned, so the test was green
  while checking nothing. Resolution now lives in
  `packages/opencode/test/lib/kernel-contract.ts` (walk up until found; a missing pin is a
  failure, not a warning).

## The probe, and the lesson from its first failure

`kernel-pin.mjs --probe` today asks the registry for the latest published version, reports
drift, and changes nothing — a finding for a human, not a CI failure, because our bytes are
exactly what the manifest declares and that is what `--check` enforces.

Its predecessor (`kernel-vendor.mjs --probe`) asked `git ls-remote` to resolve a raw commit
SHA, and `ls-remote` only matches ref *names*, so it reported "ANCHOR UNREACHABLE" for a ref
that was certainly on the remote (proved by pinning the manifest to `main`'s head and
watching it still fail). Behind that was one real finding: the branch carrying the whole
Phase B kernel work had **never been pushed** — it existed on one laptop, which is why no
remote could resolve the anchor. Fixed on 2026-09-27 by pushing the branch; the probe then
reported no drift against the same pin. The corrected version compared the branch head with
the pin — the only question `ls-remote` can answer — and declined to claim ancestry it could
not see.

The lesson is the one this project keeps paying for: a tool's output is not evidence until
the tool has been shown to be right. The push was justified by `git ls-remote --heads`
(independently), not by the probe's verdict.

## What was proved before publishing, and what is left

**Proof without publishing** (the pre-switch evidence, kept because it is what made the
switch a measurement rather than a bet): `npm pack` → install the tarball into an empty
project → run the then-mirrored fixtures through both the vendored source and the installed
package → byte-identical answers, exit 0. A deliberately sabotaged copy failed the same lane
(exit 1), so the lane was not vacuous. The mirror it compared against has since been deleted;
the corpus now comes from inside the package and is hash-pinned.

What the switch did **not** finish:

1. **`harness/glasspane-harness/product.json → kernel` still describes the old form** —
   `mode: vendored`, `version: 0.1.0-draft.1`, `enforcedBy: …/kernel-vendor.mjs`. Nothing
   reads that block any more (the reader was `kernel-vendor.mjs`'s declared-mode check, and
   `kernel-pin.mjs` uses `product.json` only to find the tree root), so it is stale prose in
   a machine-readable file rather than a red gate. It needs the owner's decision on the
   field's shape before it is rewritten.
2. **The mcp-shell mirror under `kernel/` is still synced by `tools/sync-kernel.sh
   --target=repo`.** That mirror is scheduled for retirement in a later batch; this page does
   not claim it is gone.
3. **The API questions the R40 list still needs** (invariant evaluation among them) remain
   kernel-side work, to be asked for as a **contract proposal with fixtures** rather than as a
   private fork of the kernel. Distribution is no longer one of them.

Until those close, the honest sentence is: *the harness consumes the shared kernel as a
pinned dependency; what the two-way scenarios still wait on is the kernel's API, not the
registry.*
