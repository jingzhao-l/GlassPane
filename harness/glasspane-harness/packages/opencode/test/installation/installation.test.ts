import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("latest", () => {
    // The update path may only ever resolve a version from infrastructure this
    // product owns. Every case below records the URLs the code actually asked for,
    // because the defect being pinned was a correct-looking version number that came
    // from upstream's release feed: the answer was only half the claim, the source was
    // the other half.
    const collect = () => {
      const urls: string[] = []
      return {
        urls,
        record: (request: HttpClientRequest.HttpClientRequest) => {
          urls.push(request.url)
        },
        // No case here may resolve upstream's repository, whatever it resolves instead.
        asksNothingOfUpstream: () => expect(urls.some((url) => url.includes("api.github.com/repos/anomalyco/"))).toBe(false),
      }
    }

    const curlFeed = collect()
    testEffect(
      testLayer((request) => {
        curlFeed.record(request)
        return jsonResponse({ tag_name: "v0.7.1" })
      }),
    ).effect("a curl install reads this product's own releases, and strips the v prefix", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("curl")
        expect(result).toBe("0.7.1")
        expect(curlFeed.urls).toEqual(["https://api.github.com/repos/jingzhao-l/glasspane-harness/releases/latest"])
        curlFeed.asksNothingOfUpstream()
      }),
    )

    const curlUnreachable = collect()
    testEffect(
      testLayer((request) => {
        curlUnreachable.record(request)
        return new Response("no such release", { status: 404 })
      }),
    ).effect("a curl install whose own feed is unreachable resolves to no version at all", () =>
      Effect.gen(function* () {
        // Absent, not guessed: the caller's `catch` is what turns this into "no
        // update to report", and the previous behaviour here was to fall through to
        // upstream's feed and report that number as ours.
        const exit = yield* Effect.exit(Installation.use.latest("curl"))
        expect(exit._tag).toBe("Failure")
        expect(curlUnreachable.urls).toEqual(["https://api.github.com/repos/jingzhao-l/glasspane-harness/releases/latest"])
        curlUnreachable.asksNothingOfUpstream()
      }),
    )

    const npmCalls: string[] = []
    testEffect(
      testLayer((request) => {
        npmCalls.push(request.url)
        return jsonResponse({ version: "1.5.0" })
      }),
    ).effect("reads npm versions via registry", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("npm")
        expect(result).toBe("1.5.0")
        expect(npmCalls).toContain(`https://registry.npmjs.org/glasspane-harness/${InstallationChannel}`)
      }),
    )

    const bunCalls: string[] = []
    testEffect(
      testLayer((request) => {
        bunCalls.push(request.url)
        return jsonResponse({ version: "1.6.0" })
      }),
    ).effect("reads bun versions via registry", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("bun")
        expect(result).toBe("1.6.0")
        expect(bunCalls).toContain(`https://registry.npmjs.org/glasspane-harness/${InstallationChannel}`)
      }),
    )

    const pnpmCalls: string[] = []
    testEffect(
      testLayer((request) => {
        pnpmCalls.push(request.url)
        return jsonResponse({ version: "1.7.0" })
      }),
    ).effect("reads pnpm versions via registry", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("pnpm")
        expect(result).toBe("1.7.0")
        expect(pnpmCalls).toContain(`https://registry.npmjs.org/glasspane-harness/${InstallationChannel}`)
      }),
    )

    // brew, Chocolatey and Scoop carry no `glasspane-harness` package. Upstream's code
    // queried them anyway — Chocolatey and Scoop by upstream's *package id* — so each
    // of these used to hand back a version number for something this product never
    // published. There is no such channel, and saying so is the whole answer.
    for (const method of ["scoop", "choco", "brew", "yarn", "unknown"] as const) {
      const asked: string[] = []
      testEffect(
        testLayer((request) => {
          asked.push(request.url)
          return jsonResponse({ version: "9.9.9", tag_name: "v9.9.9", versions: { stable: "9.9.9" }, d: { results: [{ Version: "9.9.9" }] } })
        }),
      ).effect(`${method} is not a channel this product publishes: no version, and no request`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.latest(method))
          expect(error).toBeInstanceOf(Installation.NoUpdateChannelError)
          expect(error.method).toBe(method)
          expect(error.remedy).toContain("npm install -g glasspane-harness")
          expect(error.message).toBe(error.remedy)
          expect(asked).toEqual([])
        }),
      )
    }
  })

  describe("upgrade", () => {
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => {
          if (cmd === "npm") return { code: 1, stderr: "token=secret command output" }
          return ""
        },
      ),
    ).effect("returns sanitized typed errors for failed package upgrades", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(error.stderr).not.toContain("command output")
      }),
    )

    testEffect(
      testLayer(
        () => new Response("install script with token=secret", { status: 200 }),
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return "GNU bash"
          if (cmd === "bash" || cmd === "sh") return { code: 1, stderr: "script output with token=secret" }
          return ""
        },
      ),
    ).effect("returns sanitized typed errors when the curl install script fails", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("curl", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for curl (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(error.stderr).not.toContain("script output")
      }),
    )

    testEffect(
      testLayer(
        () => new Response("install script", { status: 200 }),
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return { code: 1, stderr: "missing" }
          if (cmd === "bash") return { code: 1, stderr: "should not execute installer with bash" }
          if (cmd === "sh") return "ok"
          return ""
        },
      ),
    ).effect("falls back to sh when bash is unavailable during curl upgrade", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("curl", "9.9.9")
      }),
    )
  })
})
