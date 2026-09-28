# The shared kernel, and what "bidirectional" actually means

The harness consumes one shared semantic kernel with the rest of the iterate ecosystem
(`iterate-harness`, `iterate-plugin`, and a third project). This page is the standing
answer to three questions that keep coming back: what the kernel *is*, why it is not on
npm, and how much of the promised two-way integration exists today.

## What the kernel is

`@iterate/kernel` — the canonical home is `kernel/` in
[iterate-skill](https://github.com/jingzhao-l/iterate-skill). It is a **TypeScript semantic
layer**, not a verification engine:

| It owns | It must never own |
|---|---|
| schemas (config / evidence / decision-log entry), the audit-chain mapping, orchestration primitives, public validators | any verification reasoning — that stays in the Swift engine, 100% |

The fork's only doorway is `packages/opencode/src/tool/glasspane/kernel.ts`. It is
vendored *with provenance* into `packages/opencode/vendor/kernel` and pinned file-by-file
by sha256 in `harness/contracts/kernel-vendor.json`, which `kernel-vendor.mjs` enforces:
any edit inside the vendor directory turns red in CI, with no canonical checkout needed.
The accounting consequence is enforced too — `tool-surface.mjs` reads that manifest and
counts those files as a dependency, not as our tool surface.

We use it for exactly what it is: `decisionOutcomeFromEvidence` and
`decisionSummaryFromEvidence` (evidence → decision, read side), the decision-log chain
primitives (write side, used by the decision-log and compaction plugins), and its schemas.
The kernel transcribes; it never judges — that boundary is the architecture's first iron
law, and it is why the mapping lives in the kernel instead of in each shell.

## Why it is not published to npm

Because that is a **recorded decision, not an unfinished task**, with a technical driver:

- **P6 §13** (a directive executed 2026-09-21): the kernel is not published separately;
  a `file:` dependency leaks out of a published manifest, so the build-local shell inlines
  the bytes.
- **P4 §33.2**: registry publishing follows the iterate monorepo's own release policy.
- The fork cannot use a relative `../../kernel` import either: it ships as a
  **subtree-split repository**, so that path would break on the first release. That leaves
  vendoring or npm, and vendoring was chosen because npm is not published.
- The research note that first proposed "publish the kernel as action #0" **corrected
  itself**: it had read a strategy as a to-do. "npm dependency" in the architecture
  documents describes the dependency's *direction and accounting*, not an instruction to
  publish.

One more measured fact matters for timing: at the current pin the kernel exports three
schemas, a zod mirror, four `parse*` functions and `KernelSchemaError` — there is no
`invariant`, no `dimension`, and no decision-log writer on the canonical side. Publishing a
`0.1.0-draft.1` today would publish a package that does not yet carry the API the two-way
scenarios need.

## Is publishing to npm *required* for bidirectional integration?

**No — not for any specific scenario. Yes — for enforcing "one kernel" across N consumers
at scale.** Those are different claims, and conflating them is what makes this look
blocked.

What a two-way scenario (the R40 list) actually needs:

1. **One implementation and one schema, both sides agreeing on the semantics** — evidence
   attribution levels, circuit-breaker level, the opID ↔ decision-log hash chain.
   Vendoring achieves this. The distribution channel is irrelevant.
2. **The kernel exposing the hook the scenario needs** — `dimensionContext` for
   dimension-aware compression, a decision-log writer for "evidence into iterate's

## What exists today (2026-09-26, measured)

- **Consumption side: done and measured.** The fork consumes the shared kernel through
  one module, and the 23 vendored files are hash-pinned and CI-enforced.
- **Publishing: not done, by decision.** See above.
- **R40 scenarios: essentially not started.** The concrete blockers, all on the kernel
  side rather than ours:
  - `dimensionContext` does not exist at the pinned version — the one hard blocker for
    M4's dimension-aware compression, and the reason that half of M4 is documented as a
    boundary rather than a feature.
  - the canonical side has no decision-log **writer**; the first real producer of a
    decision-log entry is supposed to be this fork's plugin (M2) — the two are mutually
    dependent by design, plugin skeleton first.
- **A real finding, and a broken checker that found it for the wrong reason.** The new
  `kernel-vendor.mjs --probe` reported that our pinned ref was unreachable. Two things
  were true and only one of them was the checker's fault:
  - **Real:** the branch `kernel/decision-log-chain` — carrying the whole Phase B kernel
    work (the decision-log writer, the evidence→decision mapping, the frozen read-side
    compat) — had **never been pushed**. It existed only on one laptop, which is why no
    remote could resolve `bb80f97`. Fixed on 2026-09-27 by pushing the branch; the probe
    then reports "no drift" against the same pin.
  - **The checker was wrong:** its first version asked `git ls-remote` to resolve a raw
    commit SHA, and `ls-remote` only matches ref *names* — so it reported
    "ANCHOR UNREACHABLE" even for a ref that was certainly on the remote (proved by
    pinning the manifest to `main`'s head and watching it still fail). The fixed version
    compares the branch head with the pin — the only question `ls-remote` can answer —
    and explicitly declines to claim ancestry it cannot see.

  The lesson is the one this project keeps paying for: a tool's output is not evidence
  until the tool has been shown to be right. The push was justified by
  `git ls-remote --heads` (independently), not by the probe's verdict.

## Publishing `@iterate/kernel`: the decision, and what made it safe to consider

**Decision: not yet — and the reason is not caution, it is measurement.** Everything needed
to publish is now in place, and the one thing that is missing cannot be done from a machine
without an interactive npm login.

What the evidence says:

- **No consumer would benefit today.** The other shell in the ecosystem
  (`iterate-plugin`) has no kernel dependency at all — its dependencies are all
  `@deepseek-ai/*` and nothing in the tree references the kernel. Publishing under
  `@iterate` would change the delivery form for exactly one consumer: us.
- **The scope cannot be verified from here.** `npm org ls iterate` returns 403 with the
  token available on this machine, so "do we own `@iterate`?" has no answer available
  except by trying to publish. Creating a public npm organisation under an account is an
  outward-facing identity action, so it is not something to do unasked.
- **The published form had a real defect, now fixed.** The kernel's `exports` map offered
  only the barrel, and the barrel re-exports `schemas.ts`, which reads `../schemas/*.json`
  through `createRequire` at module load — the exact thing that broke this fork's
  single-file binary. Publishing that would have shipped a package that breaks its first
  consumer. The package now has a subpath export per module, a license, and a
  `prepublishOnly` build.
- **The zod range was a lie, and the conformance lane caught it.** The package pinned
  `zod: 3.25.76` while its schemas are written to work on zod 3 and 4 alike. So an
  installed copy pulled in its own zod 3 under a zod 4 consumer, and the kernel's error
  text changed with the *delivery form*: the same rejected fixture said `Invalid input`
  when vendored and `Invalid literal value` when installed. The dependency is now
  `>=3.25.76 <5`, and both forms answer identically.

**Proof the published form works, without publishing it.** `npm pack` → install the tarball
into an empty project → run all eight mirrored fixtures through both the vendored source
and the installed package: byte-identical answers, exit 0. A deliberately sabotaged copy
fails the same lane (5 of 8 fixtures, exit 1), so the lane is not vacuous.

**What remains is one command you run**, after confirming the scope is yours:

```bash
cd <iterate-skill checkout on kernel/decision-log-chain>
cd kernel && npx tsc -p tsconfig.json      # or: npm run build
npm version 0.1.0                           # from 0.1.0-draft.1
# set "private": false in package.json, then:
npm publish --provenance --access public
```

Then the switch on our side is one line, and it is a *checked* one:

```bash
bun harness/glasspane-harness/script/kernel-conformance.mjs --impl <path to the installed @iterate/kernel>
```

`product.json → kernel.mode` becomes `npm`, `kernel-vendor --check` then requires the
dependency instead of the vendor tree, and the conformance lane becomes the gate that keeps
the two delivery forms from quietly diverging.

## The two stages that would actually finish it

**Stage 1 — without publishing (what this repository can do now).**

1. Backflow the three modules we are ahead by to canonical, push them, and **re-anchor**
   `kernel-vendor.json` to a reachable ref. That restores the provenance chain and is a
   prerequisite for everything else.
2. Keep the probe on a schedule so a moved kernel is a finding rather than a surprise.
3. Add the conformance lane: run the kernel's own `fixtures/` through this fork's
   consumption path, so a semantic change in canonical fails in our CI *before* it fails in
   the product. That is the behavioural half of what npm would give us for free.
4. Ask the canonical side for the API the scenarios need — `dimensionContext`, a
   decision-log writer, invariant evaluation — as a **contract proposal with fixtures**,
   not as a private fork of the kernel.

**Stage 2 — when the API stabilises.**

5. Publish `@iterate/kernel@0.1.0` from the iterate monorepo. That means owning the
   `@iterate` npm scope — a different account from this one, so it is a cross-org step.
6. Flip the vendored import to a semver dependency: one import line in `kernel.ts` and
   nothing else, which is why that file was written the way it was — its header records
   this exact switch as the plan.

Until then the honest sentence is: *the harness consumes the shared kernel, and the two-way
scenarios are waiting on the kernel's API, not on a registry.*

   decision log", invariant evaluation for "invariant triggers re-verification". This is
   the actual blocker today, and it is an **API** problem, not a distribution problem.
3. **Cross-product verification that both sides really agree** — the R34 consumer matrix.
   This is where distribution matters:

| | vendored copies (today) | one npm version |
|---|---|---|
| identity | each consumer carries bytes; equality is a convention | one resolved version; `npm i` proves it |
| API break | found by a conformance suite, per consumer, after the fact | found at install/typecheck, in every consumer at once |
| version skew | a sync PR per consumer, like our fork sync | a resolvable dependency range |
| patches | re-vendor + re-record per consumer | one publish |
| what it does **not** give you | — | the semantics themselves |

So publishing is the cheapest way to make "N consumers, one kernel" *mechanically*
enforced rather than conventional — and it removes the per-consumer sync tax. It is not a
prerequisite for any R40 scenario; every one of them is blocked on kernel API work first.
