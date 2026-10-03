/**
 * GlassPane x opencode spike plugin (throwaway; lives OUTSIDE the repository).
 *
 * Two jobs:
 *  1. RUNTIME hook liveness. The engine dispatches hooks by name
 *     (`hook[name]?.(input, output)`), so recording which keys the engine
 *     *accesses* on our returned Hooks object is the runtime twin of
 *     harness/tools/hook-liveness.mjs. The declared set is read from that
 *     tool's golden file, so the two probes can never drift apart silently.
 *  2. First real cross-process call: an opencode tool `gp_probe_status` that
 *     talks to the running glasspaned over its local socket and returns the
 *     daemon's own answer, structured as {title, output, metadata}.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import net from "node:net"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { tool } from "@opencode-ai/plugin"

const pathOf = (p: string) => dirname(p)
const SPIKE_DIR = new URL(".", import.meta.url).pathname
const FIRED = SPIKE_DIR + "hooks-fired.jsonl"

/**
 * Locate the GlassPane repository. Never a hard-coded machine path: an absolute
 * literal in a remedy string is how a documented fix turns into a phantom one
 * the day somebody clones somewhere else. Order: explicit env → the repo this
 * file was copied out of (marker walk-up) → give up loudly.
 */
function findRepo(): string {
  const candidates = [process.env.GLASSPANE_REPO]
  let dir = dirname(new URL(import.meta.url).pathname)
  for (let up = 0; up < 8 && dir !== "/"; up++, dir = pathOf(dir)) {
    candidates.push(dir)
    if (existsSync(pathOf(dir) + "/harness/upstream.json")) break
  }
  for (const c of candidates) {
    if (c && existsSync(c + "/harness/upstream.json")) return c
  }
  throw new Error("cannot locate the GlassPane repository (set GLASSPANE_REPO); the declared-hook list lives in harness/contracts/hook-liveness.json")
}
const REPO = findRepo()
const GOLDEN = REPO + "/harness/contracts/hook-liveness.json"
const SOCKET = process.env.GLASSPANE_SOCKET || `${homedir()}/.glasspane/engine.sock`
const INSTALLER = REPO + "/installer/cli.js"

const declared: string[] = JSON.parse(readFileSync(GOLDEN, "utf8")).hooks.map((h: { name: string }) => h.name)

function record(kind: "accessed" | "called", hook: string, extra?: unknown) {
  appendFileSync(FIRED, JSON.stringify({ kind, hook, at: new Date().toISOString(), extra }) + "\n")
}

/** NDJSON round-trip to glasspaned: one request frame in, one response frame out. */
function daemonRequest(method: string, params: Record<string, unknown> = {}, timeoutMs = 4000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET)
    let buf = ""
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const timer = setTimeout(
      () =>
        done(() => {
          sock.destroy()
          reject(new Error(`daemon ${method} timed out after ${timeoutMs}ms on ${SOCKET}`))
        }),
      timeoutMs,
    )
    sock.on("error", (e) =>
      done(() => {
        clearTimeout(timer)
        reject(new Error(`socket error to ${SOCKET}: ${e.message}`))
      }),
    )
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: 1, method, params }) + "\n")
    })
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      const frame = buf.slice(0, nl)
      done(() => {
        clearTimeout(timer)
        sock.end()
        try {
          resolve(JSON.parse(frame))
        } catch (e) {
          reject(new Error(`daemon replied a non-JSON frame: ${frame.slice(0, 200)}`))
        }
      })
    })
  })
}

/**
 * The engine's error contract is {code, message, remedy} and the remedy must be
 * something an agent can execute. The model only sees `output` (a string), so
 * the remedy goes in the text as well as in metadata — never metadata-only.
 */
function shape(result: any, fallbackRemedy: string) {
  if (result && typeof result === "object" && "error" in result) {
    const err = result.error as { code?: string; message?: string; remedy?: string }
    const code = err.code ?? "GP_E_INTERNAL"
    const message = err.message ?? "daemon returned an error without a message"
    const remedy = err.remedy ?? fallbackRemedy
    return {
      title: `glasspane: ${code}`,
      output: `${message}\nremedy: ${remedy}`,
      metadata: { code, message, remedy, source: "glasspaned" },
    }
  }
  const body = result?.result ?? result
  return {
    title: "glasspane: ok",
    output: JSON.stringify(body, null, 2),
    metadata: { ok: true, body, source: "glasspaned" },
  }
}

const probeStatus = tool({
  description:
    "Ask the GlassPane daemon what it can currently see: engine version, and whether the in-app probe SDK is connected. Read-only; no target app is attached or driven.",
  args: {},
  async execute() {
    try {
      const hello: any = await daemonRequest("hello")
      const probe: any = await daemonRequest("probe_status")
      const ok = shape(probe)
      return {
        ...ok,
        output: `engine ${hello?.result?.version ?? "?"} protocol ${hello?.result?.protocolVersion ?? "?"}\n${ok.output}`,
        metadata: { ...ok.metadata, engine: hello?.result },
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return {
        title: "glasspane: GP_E_ENGINE_UNREACHABLE",
        output: `${message}\nremedy: start the daemon with "node ${INSTALLER}" or check ${SOCKET}`,
        metadata: { code: "GP_E_ENGINE_UNREACHABLE", message, remedy: `start glasspaned; socket path ${SOCKET}` },
      }
    }
  },
})

export default async function GlassPaneHarnessSpike() {
  const hooks: Record<string, unknown> = {
    tool: { gp_probe_status: probeStatus },
  }
  for (const name of declared) {
    if (name === "tool") continue
    hooks[name] = async (input: unknown) => {
      record("called", name, Array.isArray(input) ? undefined : input)
    }
  }
  // Record every *access* too: the engine reaches for a hook name only when it
  // intends to dispatch it, which is exactly the fact we are measuring.
  return new Proxy(hooks, {
    get(target, prop: string | symbol) {
      if (typeof prop === "string" && declared.includes(prop)) record("accessed", prop)
      return target[prop]
    },
  })
}
