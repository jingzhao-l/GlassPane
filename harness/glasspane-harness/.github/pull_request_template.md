## What this changes

<!-- one paragraph; product-facing changes name the surface (CLI/TUI, web app, docs, packaging) -->

## The checklist this line does not let you skip

- [ ] `fork-diff --record` is in the same commit as any change under the vendored tree
      (a golden that describes yesterday's tree is a lie with a timestamp).
- [ ] `product.json` is updated **first** if a name, version, bin, platform package, target
      or install URL changed; `product-surface --check` then proves every script agrees.
- [ ] `brand-surface --check` passes: no new upstream brand string in a product file, and
      the lineage count did not grow.
- [ ] Fixed points: new behaviour has a test that can fail without a human reading prose.
      Reverse control included (break it → red → restore → green).
- [ ] Typecheck and the package's tests pass; `E7`/`E8` re-run if the runtime path moved.
- [ ] Judgement did not leak into a shell: no threshold, pixel verdict or pass/fail
      synthesis in a tool surface.
- [ ] `SYNCLOG.md` records the batch: measured numbers, gates, and what was *not* run.

## Boundaries, stated

- What did you not verify, and why (credentials, hardware, a second OS, a real model)?
- What is a follow-up rather than part of this change?
