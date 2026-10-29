import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

afterEach(() => {
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  // This expectation named upstream's default (`opencode`) while `header()` and `ServerAuth.Config`
  // both default to this product's name, and `cli/cmd/run.ts:198` / `attach.ts:43` advertise
  // `'glasspane-harness'` to the user. The file was red the whole time: the fork's CI runs a
  // hand-written list of seven test paths (`packages/opencode`), and this one is not in it — so a
  // failing assertion here is invisible to every lane. The list now names this file.
  test("defaults to the product's own username", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("glasspane-harness:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })
})

// The enforcement layer and the presentation layer have to read ONE knob. `cli/cmd/serve.ts`
// suppresses "server is unsecured" through `Flag`, which resolves the product name first; this
// service read the literal `OPENCODE_SERVER_PASSWORD` and nothing else. Measured before the fix:
// with `GLASSPANE_HARNESS_SERVER_PASSWORD` set and the legacy name absent, the warning was gone and
// `required()` still answered false — an operator who believed they had authenticated the server
// was serving every route open. These four cases pin both halves of that pair.
describe("ServerAuth.Config reads the same name the warning reads", () => {
  const readAuthConfig = ServerAuth.Config.useSync((config) => config)
  const load = (env: Record<string, string>) =>
    Effect.runPromise(
      readAuthConfig.pipe(
        Effect.provide(ServerAuth.Config.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))),
      ),
    )

  test("the product name alone enables authentication", async () => {
    const config = await load({ GLASSPANE_HARNESS_SERVER_PASSWORD: "product-secret" })
    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "glasspane-harness", password: Redacted.make("product-secret") }, config)).toBe(true)
  })

  test("the legacy name still enables authentication", async () => {
    const config = await load({ OPENCODE_SERVER_PASSWORD: "legacy-secret" })
    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "glasspane-harness", password: Redacted.make("legacy-secret") }, config)).toBe(true)
  })

  test("the product name wins when both are set", async () => {
    const config = await load({
      GLASSPANE_HARNESS_SERVER_PASSWORD: "product-secret",
      OPENCODE_SERVER_PASSWORD: "legacy-secret",
    })
    expect(ServerAuth.authorized({ username: "glasspane-harness", password: Redacted.make("product-secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "glasspane-harness", password: Redacted.make("legacy-secret") }, config)).toBe(false)
  })

  test("neither name set means no authentication is claimed", async () => {
    const config = await load({})
    expect(ServerAuth.required(config)).toBe(false)
  })

  test("the username honours the product name, and its legacy spelling, over the default", async () => {
    expect((await load({ GLASSPANE_HARNESS_SERVER_PASSWORD: "p", GLASSPANE_HARNESS_SERVER_USERNAME: "operator" })).username).toBe("operator")
    expect((await load({ GLASSPANE_HARNESS_SERVER_PASSWORD: "p", OPENCODE_SERVER_USERNAME: "legacy-operator" })).username).toBe("legacy-operator")
    expect((await load({ GLASSPANE_HARNESS_SERVER_PASSWORD: "p" })).username).toBe("glasspane-harness")
  })

  test("the header this surface sends matches what it enforces", async () => {
    // `header()` goes through `Flag`, i.e. the product name; the server used to reject exactly that
    // credential, so a same-product client could not talk to its own `serve`.
    Flag.OPENCODE_SERVER_PASSWORD = "round-trip"
    Flag.OPENCODE_SERVER_USERNAME = undefined
    try {
      const config = await load({ GLASSPANE_HARNESS_SERVER_PASSWORD: "round-trip" })
      const sent = ServerAuth.header()
      expect(sent).toBeDefined()
      const decoded = Buffer.from((sent ?? "").replace("Basic ", ""), "base64").toString("utf8")
      const [username, password] = decoded.split(":")
      expect(ServerAuth.authorized({ username, password: Redacted.make(password) }, config)).toBe(true)
    } finally {
      Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
      Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
    }
  })
})
