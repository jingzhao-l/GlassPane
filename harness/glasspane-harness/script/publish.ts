#!/usr/bin/env bun
/**
 * [gp] Refused. This is upstream's release orchestrator, and this product does not have one.
 *
 * What the upstream body did, from the fork root:
 *   - rewrote `"version"` in **every** `package.json` in the tree, then reinstalled, then
 *     ran the sdk build script;
 *   - published the three scoped internal packages (sdk, plugin, ui) to the public npm
 *     registry under **upstream's scope**, with `--access public --tag latest` — packages
 *     this product does not own, from a fork;
 *   - `git tag` + `git push --force-with-lease --no-verify`, then `git push HEAD:dev`, then
 *     `gh release edit --draft=false` against `$GH_REPO`.
 *
 * `glasspane-harness` publishes exactly three packages, all named for the product: the
 * wrapper and the two macOS platform packages, built and validated by
 * `packages/opencode/script/publish.ts`, plus GitHub release assets from
 * `.github/workflows/release.yml`. That is the whole distribution (`product.json` →
 * `npm.publishPolicy`; `FORK.md` 纪律 5: nothing is pushed to infrastructure we do not
 * own). Leaving a working "publish someone else's package names" entry point one `cd` away
 * from the fork root is the failure mode that rule exists to prevent, and `docs/release.md`
 * tells a reader to run `bun run script/publish.ts` from `packages/opencode` — where that
 * resolves to the product script, not this one.
 *
 * The file is kept as a dead end on purpose: a future upstream sync lands on a refusal that
 * says why, instead of silently re-acquiring a script that publishes under another project's
 * names. `harness/tools/product-surface.mjs` (rule `no-foreign-publish`) asserts this stays a
 * refusal and that it never invokes the per-package publish scripts again.
 *
 * Remedy — the real release path, from the fork root:
 *   cd packages/opencode && bun run script/publish.ts --dry-run   # validate every tarball
 *   and, for an actual publish, dispatch the release workflow (docs/release.md).
 */
console.error("glasspane-harness: this script does not publish anything, on purpose.")
console.error("  It is upstream's orchestrator: it would npm-publish the scoped sdk/plugin/ui")
console.error("  packages under upstream's npm scope — names this product does not own — and")
console.error("  force-push tags with --no-verify.")
console.error("  Remedy (the product's own release lane):")
console.error("    cd packages/opencode && bun run script/publish.ts --dry-run")
console.error("    docs: docs/release.md, product.json → npm.publishPolicy")
process.exit(2)
