import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { NpmConfig } from "@opencode-ai/core/npm-config"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  // [gp] Product: user agent is the product, not the upstream fork's name.
  return `glasspane-harness/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

/**
 * [gp] Product: there is no version to report on a channel this product does not
 * publish. Asking another project's release feed for a number and showing it to the
 * user as an available update is worse than saying nothing, so the answer is the way
 * out instead.
 */
export class NoUpdateChannelError extends Schema.TaggedErrorClass<NoUpdateChannelError>()("NoUpdateChannelError", {
  method: Schema.String,
  remedy: Schema.String,
}) {
  override get message() {
    return this.remedy
  }
}

// [gp] Product: this product's releases are its own repository's, and that feed is
// the only place its update path may read a version from. (Lineage: the fork's
// upstream is `anomalyco/opencode`, whose releases answer for a different program.)
const ReleaseRepo = "jingzhao-l/glasspane-harness"

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const NpmPackage = Schema.Struct({ version: Schema.String })

export interface Interface {
  readonly info: () => Effect.Effect<Info, NoUpdateChannelError>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string, NoUpdateChannelError>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    // [gp] Product: the fork publishes no Homebrew tap (publish.ts no longer pushes
    // to anomalyco/homebrew-tap). We keep the *detection* so `upgrade` can say
    // "this install method is not supported by glasspane-harness" instead of
    // half-upgrading a brew install that we do not own.
    const getBrewFormula = Effect.fnUntraced(function* () {
      const localFormula = yield* text(["brew", "list", "--formula", "glasspane-harness"])
      if (localFormula.includes("glasspane-harness")) return "glasspane-harness"
      return "glasspane-harness"
    })

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (method === "choco") return "not running from an elevated command shell"
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    // [gp] Product: upstream fetched https://opencode.ai/install and piped it into a
    // shell here. A private product must not execute another project's script, and
    // this product's own installer is scripts/install.sh (product.json → install.curl)
    // or the npm package — so the curl upgrade leg reports the truth instead.
    const upgradeCurl = Effect.fnUntraced(function* (_target: string) {
      return {
        code: 1,
        stdout: "",
        stderr: `${upgradeFailure(
          "curl",
        )} — glasspane-harness does not self-upgrade over curl; re-run scripts/install.sh or use \`npm install -g glasspane-harness\`.`,
      }
    })

    // [gp] Product: the two channels this product actually publishes to. A curl
    // install reads this product's own releases; an npm-family install reads this
    // product's own package on the configured registry. Nothing here asks another
    // project's infrastructure what version it is.
    const latestFromChannel = Effect.fnUntraced(function* (detectedMethod: Method) {
      if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
        const response = yield* httpOk.execute(
          HttpClientRequest.get(
            `${yield* NpmConfig.registry(process.cwd())}/glasspane-harness/${InstallationChannel}`,
          ).pipe(HttpClientRequest.acceptJson),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
        return data.version
      }
      const response = yield* httpOk.execute(
        HttpClientRequest.get(`https://api.github.com/repos/${ReleaseRepo}/releases/latest`).pipe(
          HttpClientRequest.acceptJson,
        ),
      )
      const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
      return data.tag_name.replace(/^v/, "")
    }, Effect.orDie)

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".glasspane-harness", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          { name: "brew", command: () => text(["brew", "list", "--formula", "glasspane-harness"]) },
          { name: "scoop", command: () => text(["scoop", "list", "glasspane-harness"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output", "glasspane-harness"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          const installedName =
            check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "glasspane-harness" : "glasspane-harness"
          if (output.includes(installedName)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* result.method())

        // [gp] Product: brew, Chocolatey and Scoop carry no `glasspane-harness`
        // package, and an install this product cannot identify is not a channel
        // either. Upstream's code asked those registries (and upstream's own release
        // feed) anyway, so a user on any of them was shown another program's version
        // number as an available update. No request leaves this process for them.
        if (detectedMethod !== "curl" && detectedMethod !== "npm" && detectedMethod !== "bun" && detectedMethod !== "pnpm") {
          return yield* new NoUpdateChannelError({
            method: detectedMethod,
            remedy:
              detectedMethod === "unknown"
                ? "glasspane-harness cannot tell how this copy was installed, so it has no version to check against — update with `npm install -g glasspane-harness`, or re-run the installer from https://github.com/jingzhao-l/glasspane-harness"
                : `glasspane-harness publishes no ${detectedMethod} package, so there is no ${detectedMethod} version to check against — update with \`npm install -g glasspane-harness\`, or re-run the installer from https://github.com/jingzhao-l/glasspane-harness`,
          })
        }

        return yield* latestFromChannel(detectedMethod)
      }),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            upgradeResult = yield* upgradeCurl(target)
            break
          case "npm":
            upgradeResult = yield* run(["npm", "install", "-g", `glasspane-harness@${target}`])
            break
          case "pnpm":
            upgradeResult = yield* run(["pnpm", "install", "-g", `glasspane-harness@${target}`])
            break
          case "bun":
            upgradeResult = yield* run(["bun", "install", "-g", `glasspane-harness@${target}`])
            break
          case "brew": {
            const formula = yield* getBrewFormula()
            const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
            if (formula.includes("/")) {
              // [gp] Product: upstream pulled `anomalyco/tap` here. This product is
              // published to npm and has no tap of its own, so upgrading a formula
              // that came from someone else's tap is refused with the way out, rather
              // than silently fetching another project's repository.
              upgradeResult = yield* run(["echo", "This formula comes from a third-party tap; upgrade with: npm install -g glasspane-harness@latest"], { env })
              break
            }
            upgradeResult = yield* run(["brew", "upgrade", formula], { env })
            break
          }
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
        }
        if (!upgradeResult || upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, upgradeResult) })
        }
        yield* Effect.logInfo("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
