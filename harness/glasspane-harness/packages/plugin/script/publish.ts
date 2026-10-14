#!/usr/bin/env bun
/**
 * [gp] Refused. This is upstream's publisher for this package, and this product does not ship it.
 *
 * What the upstream body did: `bun tsc`, rewrote `exports` to dist paths, packed the
 * directory and ran the real registry publish — `--access public` — for a package named
 * under upstream anomalyco's scope. This fork does not own that scope; publishing into it
 * from a fork is supply-chain impersonation, not distribution. The product's npm surface
 * is exactly three packages (the wrapper + the two macOS platform packages), built and
 * validated by `packages/opencode/script/publish.ts` and dispatched only by
 * `.github/workflows/release.yml` (`product.json` → `npm.publishPolicy`, FORK.md 纪律 5).
 *
 * The workspace still consumes this package by name through `workspace:*` — that is local
 * resolution, never the registry — so the manifest keeps its name and this script keeps
 * its path as a dead end: a future upstream sync lands on a refusal that says why,
 * instead of silently re-acquiring a publisher for someone else's names.
 * `harness/tools/product-surface.mjs` rule `no-foreign-publish` reads this file directly
 * and asserts the refusal holds, in code, with no publish call and no upstream-scope
 * identifier left in the executable text.
 *
 * Remedy — the product's own release lane, from the fork root:
 *   cd packages/opencode && bun run script/publish.ts --dry-run
 *   docs: docs/release.md
 */
console.error("glasspane-harness: this script does not publish anything, on purpose.")
console.error("  It is upstream's publisher for this package: it would put a stranger-scope")
console.error("  name on the public registry from a fork. This product ships only the names")
console.error("  product.json declares.")
console.error("  Remedy (the product's own release lane):")
console.error("    cd packages/opencode && bun run script/publish.ts --dry-run")
console.error("    docs: docs/release.md")
process.exit(2)
