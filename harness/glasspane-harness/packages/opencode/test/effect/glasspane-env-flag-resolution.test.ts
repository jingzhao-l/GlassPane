import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect } from "effect"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { it } from "../lib/effect"

// The production node, built per test: it resolves its flags from the environment through the
// product's single env resolver, which is what these tests drive. `RuntimeFlags.layer(overrides)`
// is the env-free test stub and is pinned separately at the bottom.
const readFlags = Effect.gen(function* () {
  return yield* RuntimeFlags.Service.useSync((flags) => flags)
}).pipe(Effect.provide(AppNodeBuilder.build(RuntimeFlags.node)))

function withEnv(vars: Record<string, string>) {
  return <A>(self: Effect.Effect<A>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Object.keys(vars).map((name) => [name, process.env[name]] as const)
        for (const [name, value] of Object.entries(vars)) process.env[name] = value
        return previous
      }),
      () => self,
      (previous) =>
        Effect.sync(() => {
          for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
          }
        }),
    )
}

describe("runtime flags env resolution", () => {
  // [gp] Product: `--pure` is written as GLASSPANE_HARNESS_PURE by the CLI middleware, and the
  // customize-harness skill injected into every session advertises GLASSPANE_HARNESS_ names. Those
  // names reached nothing here, because every flag in this service was a `Config.boolean("OPENCODE_*")`
  // lookup — one literal legacy name, with no trip through the resolver that owns the naming rule.
  it.effect("GLASSPANE_HARNESS_PURE reaches the pure flag", () =>
    Effect.gen(function* () {
      const flags = yield* withEnv({ GLASSPANE_HARNESS_PURE: "1" })(readFlags)
      expect(flags.pure).toBe(true)
    }),
  )

  it.effect("OPENCODE_PURE still reaches the pure flag", () =>
    Effect.gen(function* () {
      const flags = yield* withEnv({ OPENCODE_PURE: "1" })(readFlags)
      expect(flags.pure).toBe(true)
    }),
  )

  it.effect("the product's own name wins over the legacy one", () =>
    Effect.gen(function* () {
      const flags = yield* withEnv({ GLASSPANE_HARNESS_PURE: "0", OPENCODE_PURE: "1" })(readFlags)
      expect(flags.pure).toBe(false)
    }),
  )

  for (const [name, field] of [
    ["GLASSPANE_HARNESS_DISABLE_DEFAULT_PLUGINS", "disableDefaultPlugins"],
    ["GLASSPANE_HARNESS_DISABLE_EXTERNAL_SKILLS", "disableExternalSkills"],
  ] as const) {
    it.effect(`${name} reaches ${field}`, () =>
      Effect.gen(function* () {
        const flags = yield* withEnv({ [name]: "1" })(readFlags)
        expect(flags[field]).toBe(true)
      }),
    )
  }

  it.effect("an environment that answers nothing leaves the flags off", () =>
    Effect.gen(function* () {
      const flags = yield* withEnv({})(readFlags)
      expect(flags.pure).toBe(false)
      expect(flags.disableDefaultPlugins).toBe(false)
      expect(flags.disableExternalSkills).toBe(false)
    }),
  )

  // The stub layer stays env-free on purpose: a test that passes overrides must not have its
  // defaults decided by whatever the developer's shell exports.
  it.effect("the product's own name does not leak into the override stub layer", () =>
    Effect.gen(function* () {
      const flags = yield* withEnv({ GLASSPANE_HARNESS_PURE: "1" })(
        RuntimeFlags.Service.useSync((flags) => flags).pipe(Effect.provide(RuntimeFlags.layer())),
      )
      expect(flags.pure).toBe(false)
    }),
  )
})
