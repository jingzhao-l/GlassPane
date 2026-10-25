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
package's eight JSON Schema files belong to the package too — this fork pins their bytes as
contract (they are the eight `schemas/` entries of `contracts/kernel-pin.json`'s `corpus`),
but it does not import the module that reads them off disk at load time, because that module
is reachable only through the barrel (see below). The kernel transcribes; it never judges —
that boundary is the architecture's first iron law, and it is why the mapping lives in the
kernel instead of in each shell.

## How the fork gets it: a pinned dependency (since 2026-10-08)

The kernel is **not vendored**. `packages/opencode/vendor/kernel/` (25 files — 11 sources,
3 schemas, 11 fixtures) was deleted, and `packages/opencode` now resolves `iterate-kernel`
as a normal dependency at an exact pin — the number itself lives in
`contracts/kernel-pin.json` and `bun.lock`, not in this sentence, which was stale within a
week of being written. Resolution comes from the registry, with integrity recorded in
`bun.lock`.

Two gates carry what `kernel-vendor.mjs` used to carry — one replaced outright, one rewritten
to aim at the installed package:

- **`script/kernel-pin.mjs`** (with `contracts/kernel-pin.json`) is the provenance gate, and
  it checks four separate things: the *installed* version equals the pin; the `bun.lock`
  specifier for that resolution is **empty**, i.e. it came from the registry and not from
  `file:`/`link:` (a local-path resolution would mean the product ships a directory nobody
  else can install); the lock integrity equals the pinned integrity; and the sha256 of every
  contract file the package ships equals what the manifest records. That fourth check walks
  the manifest's own `corpus` array — the list, and therefore the count, lives there and not
  in this sentence (26 entries as recorded on 2026-10-18; `--check` prints how many it read).
  `--probe` asks the registry (`npm view iterate-kernel version`) rather than
  `git ls-remote`, because the thing that goes stale now is the published line, not a branch
  head.
- **`script/kernel-conformance.mjs`** is the behaviour gate: it runs the corpus that ships
  *inside the installed package* through the installed `dist`, and `--impl <path>` runs a
  second implementation (a canonical checkout) and requires byte-identical answers. The set it
  drives is derived from the pin, not typed in: 16 fixtures today, which is every `.json`
  fixture in `contracts/kernel-pin.json`'s `corpus` that this lane has a `kind` for (the two
  `report.ok-01.*` files ship in the corpus but no fixture kind consumes them). Since
  2026-10-08 it also drives `dimension-context`, which the fork consumes but which nothing
  had ever checked against a fixture.

Immutability moved from "our vendor tree equals our manifest" to "the artifact npm served
for this version is the artifact we recorded" — which is only a stronger statement because
somebody checks it.

Three accounting consequences are worth naming:

- `tool-surface.mjs` no longer excludes any kernel lines, because there are none in the tree:
  the vendored exclusion is **0 files / 0 lines** (it was 11 files / 1,464 lines). The golden
  now records `kernel: {package: iterate-kernel, version: 0.1.8}` under `surfaces.fork`
  (`harness/contracts/tool-surface.json`, observed 2026-10-18) so the change of caliber is
  readable on the ruler rather than only in a commit message. And the guard inverted:
  `measureFork` **refuses** the tree if `packages/opencode/vendor/kernel` reappears, because
  its 1,464 dependency lines would be billed as our authorship with nothing left to exclude
  them.
- The mirrored contract corpus `harness/contracts/kernel-fixtures/` (9 files) was deleted. A
  mirror is a second source of truth, and it had already drifted — 9 here against 11 published.
  The corpus is pinned by sha256 in `kernel-pin.json` instead.
- `tools/sync-kernel.sh --target=fork` refuses outright and prints the replacement procedure:
  bump the dependency in `packages/opencode/package.json`, `bun install`, then
  `node script/kernel-pin.mjs --record`, then `bun script/kernel-conformance.mjs --impl <canonical
  kernel checkout>`. Copying bytes into a vendor tree would recreate the copy this retirement
  exists to remove. `--target=repo` retired on the same shape, on 2026-10-18: the `kernel/`
  code mirror existed for `mcp-shell`'s `file:../kernel` dependency, and `mcp-shell` now
  consumes the published package, so the mirror lost its last consumer — and nothing ever
  provenanced `kernel/src`, which is how it sat on 0.1.7 while the registry served 0.1.8. The
  script now takes no working mode: **both** targets print one refusal and exit 2, naming
  three replacement commands (corpus → `node scripts/check-kernel-corpus.mjs --record`; fork
  pin → `node harness/glasspane-harness/script/kernel-pin.mjs --record`; behaviour →
  `bun harness/glasspane-harness/script/kernel-conformance.mjs`). `kernel/` at the repository
  root survives as the pinned corpus only — 18 `fixtures/` and 8 `schemas/`, the same bytes
  `contracts/kernel-pin.json` hashes.

**One import-shape constraint, and it is a product requirement, not a style choice.**
`kernel.ts` imports per-module subpaths (`iterate-kernel/parse` and friends) and never the
barrel. The barrel re-exports `schemas`, which reads the eight JSON Schemas next to the
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

## What exists today (re-read against the pin recorded 2026-10-18)

- **Consumption side: done and measured.** One module touches the kernel, and it resolves a
  registry package whose version, lock integrity and per-file contract hashes are pinned by
  `contracts/kernel-pin.json` (its `corpus`: 26 entries as recorded on 2026-10-18).
- **Publishing: done by the iterate side, and consumed here.** The version this fork resolves
  is whatever `contracts/kernel-pin.json` records — 0.1.8 as of its 2026-10-18 recording, and
  `packages/opencode/package.json`'s dependency line is checked against that number by
  `product-surface.mjs`. At the 2026-10-08 switch it was `0.1.3` (0.1.1 → 0.1.2 added the
  contract corpus to the tarball; 0.1.2 → 0.1.3 added `evidence-decision.ok-01.json`, the
  transcription contract the Python half of iterate-harness is written against).
- **Behaviour parity: what runs unattended is one implementation; the second is an operator
  command.** `bun script/kernel-conformance.mjs` without `--impl` answers
  `16 fixture(s) through 1 implementation(s)` (measured 2026-10-25, rc=0): every shipped fixture is
  checked against the golden recorded in `contracts/kernel-conformance.json`, which is a real guard —
  against *this* implementation drifting. Comparing the installed `dist` with a canonical kernel
  checkout (where the zod-major error-prose difference is reported as a note) needs `--impl` pointed at
  that checkout, and no CI step does that. The Python side is the same shape:
  `scripts/diff_kernel_implementations.py` exists, is an operator command, and measured rc=2 on the
  2026-10-25 machine because no built `iterate-kernel` dist was reachable. So what is unattended
  between the two implementations is the sha256-pinned corpus (`tests/kernel_fixtures/manifest.json`,
  whose own comment says it is deliberately NOT generated from the kernel but a copy pinned by sha256),
  not a run of both. One more reading to keep honest: `contracts/kernel-conformance.json` carries
  `"version": "0.1.9"` while the dependency pin is `0.1.10` — that field is a provenance stamp of
  where the fixtures came from, not a version judgment; the judgment is the per-fixture digest.
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

Two of the three things the switch left open have since closed. This page used to claim the
opposite about both of them; the closed ones stay listed because the claim they retired is the
point.

1. **`harness/glasspane-harness/product.json → kernel` — closed.** This page said the block
   still described the old form (`mode: vendored`, `version: 0.1.0-draft.1`,
   `enforcedBy: …/kernel-vendor.mjs`). Those keys are gone. The block now carries
   `"provenance": "contracts/kernel-pin.json"` plus `why`, `canonical`, `docs`, `conformance`
   and `history` — a pointer, not a fourth copy of the version, because a copied fact is the
   one that goes quiet when it stops being true. The reader is `product-surface.mjs`'s
   `kernel-provenance` rule: the pointer must resolve to a readable pin, that pin must declare
   `iterate-kernel`, `packages/opencode/package.json`'s dependency line must equal the pinned
   version, `packages/opencode/vendor/kernel` must not reappear, and every `corpus` entry must
   name a file with a 64-hex sha256 (a shape check, deliberately not a count).
2. **The `kernel/` code mirror — closed 2026-10-18.** `tools/sync-kernel.sh` no longer copies
   anything: both `--target` values print the same refusal and exit 2, naming the three
   replacement commands above. `mcp-shell` consumes the published package now, so the mirror
   lost its last consumer, and `kernel/` at the repository root holds only the pinned corpus
   (`fixtures/` + `schemas/`), whose 26 files hash-match `contracts/kernel-pin.json` exactly.
3. **The API questions the R40 list needed — closed as of 2026-10-25, measured per row.** This
   page spent several revisions carrying the sentence "what the two-way scenarios still wait on
   is the kernel's API". That is no longer what the tree says, and the honest version is a list,
   because the five rows did not all close the same way:

   | Row | What makes it real today | What is still stated rather than measured |
   |---|---|---|
   | ① invariant → re-verification | the loop's publish site sends through the host's awaited MCP transport (`reverify_trigger`), and the request is the kernel's own frame | recipe steps stay out of that request on purpose: the contract builds a request only from a *failing* report, so no send can also carry ④'s permission — naming a step there would ask the engine to move the app while its own re-check is failing |
   | ② dimension-aware compaction | 面 B reads the plan from `GLASSPANE_RUN_PLAN` **or** the project's own `.iterate/run-plan.json`; `selectAnchors` ranks the drop by the kernel's own `dimensionContext` accounting and the block names which rule it used | a dimension declared on a method that emits no evidence pack still reaches no anchor — `last_evidence` is the engine's only emitting method. That gap is now a number the block prints (`declaredWithoutAnchor`) instead of a paragraph in this file: the count is what makes it comparable between runs, and it falls toward zero on its own if the engine widens its emitting surface |
   | ③ evidence → decision log | the reader that runs in production today is the **loop's**: `fix_proof` verifies GlassPane's ledger through the kernel's verifier before citing it, and a project can name that ledger as its source once (`.iterate/glasspane-ledger.json`, `/iterate glasspane-ledger <path>`), which pins the genesis entry so a replaced chain refuses with `LEDGER_LINK_E_STALE`. The fork carries the *same* verifier (`kernel.ts:verifyLedger`) and a fixed-point test proves a chain written by the loop verifies there — but its own production path writes its ledger rather than reading the loop's. So two writers agree byte-for-byte (sha256 `eaa9dc7d…`, three drafts, samples pinned in both suites) and only one of the two directions has a production reader | the two default ledger paths are still different files; the link makes the other harness's ledger this project's recorded default, and `GLASSPANE_DECISION_LOG` stays the one-shot override that outranks it |
   | ④ repair → invariant re-check → re-verify | the recipe hand-off (`glasspane_recipe.py`) plus the gate that reads only measured things — the round's invariant verdict, a held recipe, a chain-verifiable ledger line — refusing by name on every path the round can publish; the answer is written into that round's ledger line — including the round that passed and therefore sent nothing (iterate-harness 2.11.1) — and both doors read it back, `/iterate gate` in a session and `ih iterate gate` in a terminal, while a contract refusal writes no ledger bytes | the gate reports and withholds; nothing in-process enforces it on the agent that drives the recipe, and neither product has a step executor, so it answers "may the recipe proceed", not "which step is next" — a progress pointer would have to be written by whoever performs the fix |
   | ⑤ provider contract | both surfaces register through the kernel and both consume their registry on the live path; `harness/tools/provider-surface.mjs` reconciles the two tables by *running* them (identity, overlap agreement, the asymmetry ledger) | the asymmetry (面 B forwards `diagnose-pixel`/`diagnose-probed`, 面 A does not) is deliberate and recorded, not eliminated |

So the honest sentence is: *the harness consumes the shared kernel as a pinned dependency, and
each of the five two-way rows now has a producer, a consumer and a guard that can go red.* What
remains open is named row by row above, and none of it is "the kernel's API" any more.

