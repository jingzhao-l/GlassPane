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

// [gp] Product: the refusal is one sentence, built in one place, because the CLI has to be able
// to give it without pretending to look a version up: an explicit `[target]` skips the version
// check, and the check is where the refusal used to live.
export function noUpdateChannel(method: Method) {
  return new NoUpdateChannelError({
    method,
    remedy:
      method === "unknown"
        ? "glasspane-harness cannot tell how this copy was installed, so it has no version to check against — update with `npm install -g glasspane-harness`, or re-run the installer from https://github.com/jingzhao-l/glasspane-harness"
        : `glasspane-harness publishes no ${method} package, so there is no ${method} version to check against — update with \`npm install -g glasspane-harness\`, or re-run the installer from https://github.com/jingzhao-l/glasspane-harness`,
  })
}

// [gp] Product: this product's releases are its own repository's, and that feed is
// the only place its update path may read a version from. (Lineage: the fork's
// upstream is `anomalyco/opencode`, whose releases answer for a different program.)
const ReleaseRepo = "jingzhao-l/glasspane-harness"

// [gp] Product: and its npm lane reads this product's registry, not the ambient one.
// `NpmConfig.load` honours a *project* `.npmrc` and `npm_config_registry`, so resolving the
// registry per repository let the repository a user cd's into decide both where the version
// check asks and where the `install -g` it then runs downloads the bytes it executes from.
// Every other npm-facing path pins it for exactly this reason — `script/postinstall.mjs`
// (`REGISTRY`, passed as `--registry`), `script/verify-published.ts`, `scripts/install.sh`.
// The literal is the same product fact those files read: product.json → `registry`.
const Registry = "https://registry.npmjs.org"

// [gp] Product: the channels this product publishes a version feed to. It is one list on
// purpose: `latest()` refuses every method outside it, and `glasspane-harness upgrade
// --method` must not offer a channel the update path would only refuse.
export const UpdateChannels: readonly Method[] = ["curl", "npm", "pnpm", "bun"]

export const isUpdateChannel = (method: Method) => UpdateChannels.includes(method)

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const NpmPackage = Schema.Struct({ version: Schema.String })
// One entry of `brew info --json --formula <name>`. Only the identity is read here, and
// `full_name` is the field that carries it: a formula from a tap is named `someone/tap/<name>`,
// a formula from homebrew-core is named bare.
const BrewFormula = Schema.Struct({ full_name: Schema.String })

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
    //
    // The identity has to be read from the machine, not from this file: upstream returned the
    // same bare name from both branches here, so the tap test at the upgrade leg could never be
    // true and `brew upgrade glasspane-harness` ran against a formula that may live in somebody
    // else's tap. Homebrew 7 answers `brew info --json --formula <name>` with a flat array of
    // formula objects (older releases answer `{"formulae": …}`), and `full_name` is the field
    // that carries the tap: tap-qualified names contain "/". An identity that does not decode is
    // no identity, and the upgrade leg refuses on that rather than guessing a formula is ours.
    const getBrewFormula = Effect.fnUntraced(function* () {
      const info = yield* text(["brew", "info", "--json", "--formula", "glasspane-harness"])
      const formulae = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(BrewFormula)))(info).pipe(
        Effect.orElseSucceed(() => []),
      )
      return formulae[0]?.full_name ?? ""
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
    // product's own package on this product's pinned registry. Nothing here asks another
    // project's infrastructure what version it is, and nothing here lets the checkout
    // decide where to ask.
    const latestFromChannel = Effect.fnUntraced(function* (detectedMethod: Method) {
      if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
        const response = yield* httpOk.execute(
          HttpClientRequest.get(`${Registry}/glasspane-harness/${InstallationChannel}`).pipe(HttpClientRequest.acceptJson),
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
          if (output.includes("glasspane-harness")) {
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
        if (!isUpdateChannel(detectedMethod)) {
          return yield* noUpdateChannel(detectedMethod)
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
            upgradeResult = yield* run(["npm", "install", "-g", "--registry", Registry, `glasspane-harness@${target}`])
            break
          case "pnpm":
            upgradeResult = yield* run(["pnpm", "install", "-g", "--registry", Registry, `glasspane-harness@${target}`])
            break
          case "bun":
            upgradeResult = yield* run(["bun", "install", "-g", "--registry", Registry, `glasspane-harness@${target}`])
            break
          case "brew": {
            const formula = yield* getBrewFormula()
            const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
            // [gp] Product: a tap-qualified identity — or no readable identity at all — is not
            // this product's formula, because this product publishes no tap. Upgrading it would
            // fetch somebody else's repository and run its install, so the leg answers with the
            // way out instead. It used to be unreachable: `getBrewFormula` returned the same bare
            // name from both branches, so `includes("/")` could never be true, and the refusal
            // below it ran through `echo` with exit code 0 — a refusal the caller reported as
            // "Upgrade complete".
            if (formula === "" || formula.includes("/")) {
              return yield* new UpgradeFailedError({
                stderr: formula
                  ? `glasspane-harness publishes no Homebrew tap, and the installed formula is ${formula} — upgrade with \`npm install -g glasspane-harness\``
                  : "glasspane-harness publishes no Homebrew tap, and this install's formula cannot be named — upgrade with `npm install -g glasspane-harness`",
              })
            }
            upgradeResult = yield* run(["brew", "upgrade", formula], { env })
            break
          }
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
        }
        if (!upgradeResult || upgradeResult.code !== 0) {
          // The sanitizer below exists to keep *fetched script output* — and any token in
          // it — out of the user's face. The curl leg has no fetched output any more, and
          // what it returns instead is this product's own refusal, carrying the way out.
          // Re-sanitizing that threw the sentence away, so the refusal the code wrote was
          // a refusal nobody could read: the user got "Upgrade failed for curl (exit code
          // 1)." with no hint that curl is not a self-upgrade channel here at all.
          const reason =
            m === "curl" && upgradeResult?.stderr ? upgradeResult.stderr : upgradeFailure(m, upgradeResult)
          return yield* new UpgradeFailedError({ stderr: reason })
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
