import { describe, expect } from "bun:test"
import { fileURLToPath } from "url"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { NpmConfig } from "@opencode-ai/core/npm-config"
import { Installation } from "../../src/installation"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

// The registry this file asserts against is the product's declared fact, not a copy of the
// constant the fix uses: product.json is the truth, and harness/tools/product-surface.mjs gates
// every npm-facing lane to it.
const product = (await Bun.file(fileURLToPath(new URL("../../../../product.json", import.meta.url))).json()) as {
  registry: string
}
const Registry = product.registry

// A registry a hostile checkout can name through npm's own config resolution: `NpmConfig.load`
// reads `npm_config_registry` and a project `.npmrc`, and `npm`/`pnpm`/`bun` read both from the
// environment they are spawned with. Every version this product reads and every byte it installs
// must come from `Registry` no matter what the ambient config says.
const Hostile = "https://registry.evil.example"

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

// One recorder for both halves of the claim: the request URL that actually left the process, and
// the argv that actually reached the spawner. Asserting either against a constant the fix declares
// would prove nothing; these are observed values.
function observe(info?: string) {
  const urls: string[] = []
  const argv: string[][] = []
  const http = (request: HttpClientRequest.HttpClientRequest) => {
    urls.push(request.url)
    return jsonResponse({ version: "1.5.0", tag_name: "v1.5.0" })
  }
  const spawn = (cmd: string, args: readonly string[]) => {
    argv.push([cmd, ...args])
    if (cmd === "brew" && args[0] === "info") return info ?? ""
    return ""
  }
  const leg = (command: string) => argv.find((parts) => parts[0] === command && parts[1] === "install")
  const brew = (sub: string) => argv.find((parts) => parts[0] === "brew" && parts[1] === sub)
  return { urls, argv, http, spawn, leg, brew }
}

function testLayer(witness: ReturnType<typeof observe>) {
  const mockHttp = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, witness.http(request)))),
  )
  const mockSpawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const output = witness.spawn(std?.command ?? "", std?.args ?? [])
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output ? Stream.make(encoder.encode(output)) : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, mockSpawner),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttp],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

// The hostile value is set for the body only, so a leaked setting cannot make a later test pass
// or fail by accident.
function withHostileRegistry<A, E, R>(self: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env["npm_config_registry"]
      process.env["npm_config_registry"] = Hostile
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env["npm_config_registry"]
        else process.env["npm_config_registry"] = previous
      }),
  )
}

describe("installation registry pin", () => {
  // [gp] Product: the version check used to resolve the registry out of the repository the user
  // happens to have open (`NpmConfig.registry(process.cwd())`), so a checkout could answer its own
  // "latest version" and then point the global install at the same mirror. These tests drive the
  // real code with a hostile registry live — the premise is asserted first, so a test that passed
  // because the poisoning silently did nothing would be caught.
  for (const method of ["npm", "pnpm", "bun"] as const) {
    const witness = observe()
    testEffect(testLayer(witness)).effect(`${method}: the version check asks the product's registry, not the one the environment names`, () =>
      Effect.gen(function* () {
        yield* withHostileRegistry(
          Effect.gen(function* () {
            expect(yield* NpmConfig.registry(process.cwd())).toBe(Hostile)
            expect(yield* Installation.use.latest(method)).toBe("1.5.0")
          }),
        )
        expect(witness.urls).toEqual([`${Registry}/glasspane-harness/${InstallationChannel}`])
        expect(witness.urls.join(" ")).not.toContain(Hostile)
      }),
    )
  }

  for (const method of ["npm", "pnpm", "bun"] as const) {
    const witness = observe()
    testEffect(testLayer(witness)).effect(`${method}: the global install leg names the product's registry in its argv`, () =>
      Effect.gen(function* () {
        yield* withHostileRegistry(Installation.use.upgrade(method, "1.5.0"))
        expect(witness.leg(method)).toEqual([method, "install", "-g", "--registry", Registry, "glasspane-harness@1.5.0"])
        expect(witness.argv.flat().join(" ")).not.toContain(Hostile)
      }),
    )
  }

  // [gp] Product: the brew leg refused third-party taps by testing a string this file itself
  // returned — `getBrewFormula` answered the same bare name in both branches, so the slash test
  // could never be true and `brew upgrade` ran against a formula that may live in somebody else's
  // tap. The identity now comes from `brew info`, which is why both directions are pinned here:
  // a tap-qualified formula must be refused, and a bare one must still upgrade.
  const tapped = observe(JSON.stringify([{ name: "glasspane-harness", full_name: "someone/tap/glasspane-harness" }]))
  testEffect(testLayer(tapped)).effect("brew: a formula from a tap this product does not publish is refused, and never upgraded", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Installation.use.upgrade("brew", "1.5.0"))
      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error.stderr).toContain("someone/tap/glasspane-harness")
      expect(error.stderr).toContain("npm install -g glasspane-harness")
      expect(tapped.brew("upgrade")).toBeUndefined()
      expect(tapped.brew("info")).toEqual(["brew", "info", "--json", "--formula", "glasspane-harness"])
    }),
  )

  const core = observe(JSON.stringify([{ name: "glasspane-harness", full_name: "glasspane-harness" }]))
  testEffect(testLayer(core)).effect("brew: an untapped formula is the one case that does upgrade, and upgrades the identity read back", () =>
    Effect.gen(function* () {
      yield* Installation.use.upgrade("brew", "1.5.0")
      expect(core.brew("upgrade")).toEqual(["brew", "upgrade", "glasspane-harness"])
    }),
  )

  const unreadable = observe("not the json this brew answers")
  testEffect(testLayer(unreadable)).effect("brew: a formula this product cannot name is not a formula this product owns", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Installation.use.upgrade("brew", "1.5.0"))
      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error.stderr).toContain("npm install -g glasspane-harness")
      expect(unreadable.brew("upgrade")).toBeUndefined()
    }),
  )
})
