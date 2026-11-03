#!/usr/bin/env bun
/**
 * [gp] Refused. This is upstream's release-stamping step, and it stamps a release this product
 * does not make from here.
 *
 * What the upstream body did, in the order it did it:
 *   - `gh release create v<version> -d --target <sha> …` with **no `--repo`**, so the release landed
 *     on whatever repository `gh` was configured for. Run from a maintainer's clone of the fork
 *     with upstream as a remote, that is upstream's releases;
 *   - `gh release create` again for the `beta` channel, then echoed `release=<databaseId>` and
 *     `tag=<v…>` onto the workflow output, which is what the publish jobs take as their target.
 *
 * Two consequences made this a dead end rather than a warning:
 *   1. it creates the release *before* anything has proved the tree is releasable. The fork's lane
 *      creates the tag inside `release.yml`'s `version-check` job, after the tree anchor and
 *      `script/assert-ci-green.mjs` have answered (docs/release.md); a script that creates a release
 *      from a shell skips both, and a published tag is not cheap to unwind;
 *   2. this fork does not have the branches it reads. It targets `beta` and asks `gh` for a default
 *      remote, while the product's release path is `release.yml` with `GH_REPO` set explicitly
 *      (`packages/opencode/script/build.ts`'s upload step is the only place this product touches
 *      `gh release`, and it names `--repo ${GH_REPO}` on every call).
 *
 * Kept as a dead end in the shape `script/publish.ts` uses, so an upstream sync replays onto a
 * refusal that says why instead of re-acquiring a release trigger. `harness/tools/product-surface.mjs`
 * rule `no-foreign-publish` is the reader for that promise; it currently only opens the per-package
 * `script/publish.ts` files, so these three dev-only mutators (`script/release`, `script/beta.ts`,
 * this file) are gated by `packages/opencode/test/script/upstream-dev-mutators.test.ts` until the
 * rule covers them by name.
 *
 * Remedy — the real release path:
 *   gh workflow run release.yml --repo <product repo> -f confirm=true   (docs/release.md)
 */
console.error("glasspane-harness: this script creates no release, on purpose.")
console.error("  It is upstream's stamping step: `gh release create` with no --repo, ahead of any")
console.error("  version-check or CI-green gate this product's lane requires.")
console.error("  Remedy: dispatch .github/workflows/release.yml (docs/release.md).")
process.exit(2)
