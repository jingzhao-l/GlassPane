#!/usr/bin/env bun
/**
 * [gp] Refused. This is upstream's publisher for this package, and this product does not ship it.
 *
 * What the upstream body did: laid a dist tree of the built binaries out (declaring
 * `os: ["darwin", "linux", "win32"]`, `cpu: ["arm64", "x64"]`, plus one package per platform
 * under the same scope), then packed each one and ran the real registry publish —
 * `--access public` — for names this fork does not own. Publishing into another project's
 * scope from a fork is supply-chain impersonation, not distribution. The product's npm surface
 * is exactly three packages (the wrapper + the two macOS platform packages), built and
 * validated by `packages/opencode/script/publish.ts` and dispatched only by
 * `.github/workflows/release.yml` (`product.json` → `npm.publishPolicy`, FORK.md 纪律 5).
 * The linux/win32 in that manifest are a second reason: this product is macOS-only by
 * decision, so this publisher also ships targets the product refuses to build.
 *
 * The workspace still consumes this package by name through `workspace:*` — that is local
 * resolution, never the registry — so the manifest keeps its name and this script keeps its
 * path as a dead end: a future upstream sync lands on a refusal that says why, instead of
 * silently re-acquiring a publisher for someone else's names.
 * `harness/tools/product-surface.mjs` rule `no-foreign-publish` discovers this file by
 * walking the packages tree for per-package publish scripts and asserts the refusal holds,
 * in code, with no publish call and no upstream-scope identifier left in the executable text.
 *
 * Remedy — the product's own release lane, from the fork root:
 *   cd packages/opencode && bun run script/publish.ts --dry-run
 *   docs: docs/release.md
 */
console.error("glasspane-harness: this script does not publish anything, on purpose.")
console.error("  It is upstream's publisher for this package: it would put a stranger-scope")
console.error("  name — and platforms this product does not build — on the public registry,")
console.error("  from a fork. This product ships only the names product.json declares.")
console.error("  Remedy (the product's own release lane):")
console.error("    cd packages/opencode && bun run script/publish.ts --dry-run")
console.error("    docs: docs/release.md")
process.exit(2)
