import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Fixed point for the product guard on the embedded web-app build.
 *
 * `packages/app/vite.config.ts` is upstream's file (byte-identical to the reference clone),
 * and it activates `@sentry/vite-plugin` whenever `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and
 * `SENTRY_PROJECT` are all present — uploading sourcemaps to a third party and deleting
 * the `.map` files under `dist` after. No release workflow sets them today, but the
 * activation is env-driven and ambient, so any future CI or dev machine that does would
 * silently push this product's sources to Sentry.
 *
 * The product's guard lives at the one place this product controls the app build: the
 * `bun run --cwd ../../app build` invocation in `packages/opencode/script/build.ts`. That
 * invocation must name every SENTRY_* switch the app config reads as empty, so the plugin
 * cannot activate through this product's build lane. The test scans the literal command
 * line; removing any one of the clears makes its matching case red — the reverse control.
 */
const FORK = path.join(import.meta.dir, "../../../..")
const BUILD = readFileSync(path.join(FORK, "packages/opencode/script/build.ts"), "utf8")

describe("glasspane embedded web-app build cannot push to a third party", () => {
  // The named contract: the app-build invocation names every SENTRY switch as empty, so
  // `@sentry/vite-plugin`'s activation condition (`SENTRY_AUTH_TOKEN && SENTRY_ORG &&
  // SENTRY_PROJECT`) can never be satisfied by this product's build lane.
  test("the app build clears every SENTRY_* switch the app config reads", () => {
    for (const name of [
      "SENTRY_AUTH_TOKEN",
      "SENTRY_ORG",
      "SENTRY_PROJECT",
      "SENTRY_RELEASE",
      "VITE_SENTRY_RELEASE",
    ]) {
      expect(BUILD).toContain(`${name}=`)
    }
  })

  // Reverse control, the other half: `build.ts` really is the entry point that runs the app
  // build (the guard would be vacuous if it sat on a line nobody executes). The embedded
  // web-UI bundle is built unless `--skip-embed-web-ui`, so the invocation is on the
  // product's default build path.
  test("build.ts runs the app build on its default path", () => {
    expect(BUILD).toContain("bun run --cwd")
    expect(BUILD).toContain("../../app")
    expect(BUILD).toContain("createEmbeddedWebUIBundle")
  })
})
