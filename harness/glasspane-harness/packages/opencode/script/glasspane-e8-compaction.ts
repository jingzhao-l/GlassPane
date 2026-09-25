/**
 * E8 — M4's runtime proof: the compaction hook fires in a real host, and the
 * block it injects reaches the model that writes the summary.
 *
 *   cd packages/opencode && bun run script/glasspane-e8-compaction.ts
 *
 * What this adds over the fixed-point tests: the hook is dispatched by the real
 * plugin host during a real compaction, over real session messages, and its
 * effect is observed at the provider boundary — the mock model below records
 * every request body, so the assertion is "the summarisation request contained
 * the transcribed anchors", not "the hook function returned".
 *
 * No credentials, no network, no spend: the provider is an OpenAI-compatible
 * mock on localhost (`@ai-sdk/openai-compatible` is bundled in this build, so
 * nothing gets installed). The only real dependency is the tool surface's own
 * daemon socket, and even that is optional — gp_probe_status failing still
 * yields the settled `gp_*` call the block must account for.
 *
 * Not in CI, same reason as E7: it needs a live `serve`, a port, and the whole
 * plugin host. It is a local/pre-release measurement.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import http from "node:http"

const MOCK_PORT = Number(process.env.E8_MOCK_PORT || 4313)
const SERVE_PORT = Number(process.env.E8_SERVE_PORT || 4314)

const scratch = mkdtempSync(path.join(tmpdir(), "gp-e8-compaction-"))
const home = path.join(scratch, "home")
const work = path.join(scratch, "work")
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })

let failures = 0
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}
const note = (label: string, detail: string) => console.log(`NOTE  ${label} — ${detail}`)

// The config the host boots with: a mock provider (bundled SDK, baseURL on
// localhost), and the glasspane permission allowed so the tool's own `ctx.ask`
// does not park the turn waiting for a human.
writeFileSync(
  path.join(work, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: {
        mock: {
          npm: "@ai-sdk/openai-compatible",
          name: "E8 mock",
          options: { baseURL: `http://127.0.0.1:${MOCK_PORT}/v1` },
          models: { spike: { name: "spike" } },
        },
      },
      model: "mock/spike",
      permission: { glasspane: "allow" },
    },
    null,
    2,
  ),
)

// ---- the mock model: request #1 asks for one gp_probe_status call, everything
// after that answers with text. Every body is appended to requests.jsonl, which
// is what the assertions read.
const requestLog = path.join(scratch, "requests.jsonl")
let requestCount = 0
let toolCallIssued = false

function sseChunk(res: http.ServerResponse, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/**
 * Only the turn that actually carries the GlassPane tools gets a tool call, and
 * only once: the host also calls the model for side work (session titles), and a
 * "first request wins" rule would spend the one tool call on a title.
 */
function wantsToolCall(parsed: Record<string, unknown>) {
  if (toolCallIssued) return false
  const tools = Array.isArray(parsed.tools) ? parsed.tools : []
  if (!tools.some((tool) => JSON.stringify(tool).includes("gp_probe_status"))) return false
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  if (messages.some((message) => (message as { role?: string }).role === "tool")) return false
  toolCallIssued = true
  return true
}


const mock = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ object: "list", data: [{ id: "spike", object: "model", owned_by: "glasspane" }] }))
    return
  }
  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    res.writeHead(404).end()
    return
  }
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(body || "{}")
    } catch {}
    requestCount += 1
    writeFileSync(
      requestLog,
      `${JSON.stringify({ n: requestCount, body: parsed })}\n`,
      { flag: "a" },
    )
    const first = wantsToolCall(parsed)
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const base = { id: "chatcmpl-e8", object: "chat.completion.chunk", created: 1, model: "spike" }
    sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })
    if (first) {
      sseChunk(res, {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_e8_1", type: "function", function: { name: "gp_probe_status", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      sseChunk(res, {
        ...base,
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null },
        ],
      })
      sseChunk(res, {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    } else {
      sseChunk(res, {
        ...base,
        choices: [{ index: 0, delta: { content: "E8-MOCK-REPLY" }, finish_reason: null }],
      })
      sseChunk(res, {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    }
    res.write("data: [DONE]\n\n")
    res.end()
  })
})
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve))
note("mock provider", `http://127.0.0.1:${MOCK_PORT}/v1 (logs ${requestLog})`)

// ---- the host, from this very tree (no dist needed): its internal plugin list
// is what carries M4, and it is not config-gated.
const serveEnv: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") serveEnv[key] = value
// The plugin host gates internal plugins on this upstream switch; E8 measures
// the plugins being present, so the switch must not be.
delete serveEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS
serveEnv.HOME = home
serveEnv.XDG_CONFIG_HOME = path.join(home, ".config")
serveEnv.XDG_DATA_HOME = path.join(home, ".local", "share")
serveEnv.XDG_STATE_HOME = path.join(home, ".local", "state")

const serve = Bun.spawn([process.execPath, "src/index.ts", "serve", "--port", String(SERVE_PORT)], {
  cwd: path.join(import.meta.dir, ".."),
  env: serveEnv,
  stdout: "pipe",
  stderr: "pipe",
})
const serveLog = path.join(scratch, "serve.log")
let logText = ""
async function pump(stream: ReadableStream<Uint8Array>): Promise<void> {
  // `for await` over a stream is Bun runtime behavior, not in this tsconfig's
  // lib — read through the reader so `tsgo --noEmit` stays at 0 errors.
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    logText += decoder.decode(value, { stream: true })
    writeFileSync(serveLog, logText)
  }
}
void pump(serve.stdout)
void pump(serve.stderr)

const headers = { "x-opencode-directory": work, "content-type": "application/json" }
const base = `http://127.0.0.1:${SERVE_PORT}`
const waitFor = async (label: string, probe: () => Promise<boolean>, attempts: number, waitMs: number) => {
  for (let i = 0; i < attempts; i++) {
    if (await probe().catch(() => false)) return true
    await Bun.sleep(waitMs)
  }
  console.error(`serve never became ready for ${label}; log tail:`)
  console.error(readFileSync(serveLog, "utf8").split("\n").slice(-15).join("\n"))
  return false
}

const healthy = await waitFor(
  "health",
  async () => (await fetch(`${base}/global/health`)).ok,
  60,
  1000,
)
if (!healthy) {
  console.error("dependencies: the forked opencode did not boot; nothing was measured.")
  serve.kill()
  mock.close()
  process.exit(2)
}
note("serve booted", `${base} (source tree, internal plugins on)`)

// 1. a real session, driven by the mock: turn 1 calls gp_probe_status, turn 2 ends.
const created = (await (await fetch(`${base}/session`, { method: "POST", headers, body: "{}" })).json()) as {
  id?: string
}
const sessionID = created.id
check("session created", typeof sessionID === "string" && sessionID.length > 0, sessionID ?? "no id returned")
if (!sessionID) {
  serve.kill()
  mock.close()
  process.exit(1)
}

await fetch(`${base}/session/${sessionID}/message`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: { providerID: "mock", modelID: "spike" },
    parts: [{ type: "text", text: "E8: call gp_probe_status once, then stop." }],
  }),
})

const readGpParts = async () => {
  const messages = (await (await fetch(`${base}/session/${sessionID}/message`, { headers })).json()) as Array<{
    parts?: Array<{ type?: string; tool?: string; state?: { status?: string; metadata?: Record<string, unknown> } }>
  }>
  return messages
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "tool" && part.tool?.startsWith("gp_"))
}
const settled = await waitFor(
  "a settled gp_* tool part",
  async () => {
    const parts = await readGpParts()
    return parts.length > 0 && parts.every((part) => part.state?.status === "completed" || part.state?.status === "error")
  },
  30,
  1000,
)
const gpParts = await readGpParts()
check(
  "the gp_* tool call is settled history",
  settled && gpParts.length === 1,
  gpParts.map((part) => `${part.tool}:${part.state?.status}`).join(", ") || "no gp_* part in the session",
)

// Bonus measurement, same session: M2 binds `tool.execute.after`, which until
// now was only verified statically. Its note lands in the part's metadata, so a
// real turn here settles the "does the host reach the hook" question — the
// skipped path (no evidence pack) is the one gp_probe_status can produce.
const decisionNote = gpParts[0]?.state?.metadata?.decisionLog as { status?: string; reason?: string } | undefined
check(
  "the M2 ledger hook was reached by the live host",
  decisionNote !== undefined,
  decisionNote ? `${decisionNote.status}: ${decisionNote.reason ?? ""}` : "no decisionLog note in the tool part's metadata",
)

// 2. compaction, through the host's own endpoint — this is what dispatches
// `experimental.session.compacting`.
const beforeSummary = requestCount
const summaryResponse = await fetch(`${base}/session/${sessionID}/summarize`, {
  method: "POST",
  headers,
  body: JSON.stringify({ providerID: "mock", modelID: "spike" }),
})
check("summarize accepted", summaryResponse.ok, `HTTP ${summaryResponse.status}`)

// 3. the assertion: the summarisation request carried the injected block. We
// wait for a request we have not seen before the summarize call, so the earlier
// turns (whose bodies are logged too) can never satisfy this by accident.
const sawBlock = await waitFor(
  "a post-summarize request carrying the M4 block",
  async () => {
    if (requestCount <= beforeSummary) return false
    const lines = readFileSync(requestLog, "utf8").trimEnd().split("\n").filter(Boolean)
    return lines.some((line) => {
      const entry = JSON.parse(line) as { n: number; body: unknown }
      return entry.n > beforeSummary && JSON.stringify(entry.body).includes("## GlassPane evidence anchors (M4)")
    })
  },
  60,
  1000,
)

const entries = readFileSync(requestLog, "utf8")
  .trimEnd()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { n: number; body: { messages?: Array<{ content?: unknown }> } })
const summarization = entries.find((entry) => entry.n > beforeSummary && JSON.stringify(entry.body).includes("## GlassPane evidence anchors (M4)"))
check("the compaction model request carries the M4 block", sawBlock)
if (summarization) {
  const text = JSON.stringify(summarization.body)
  check("the block numbers the gp_* calls in this session", text.includes("gp_* calls: 1"), text.slice(0, 200))
  check("the block states the absence of a decision record instead of staying silent", text.includes("decisions recorded: 0"))
  check("the block is a transcription, not a verdict", text.includes("does not re-judge"))
}
const leaked = entries.some((entry) => entry.n <= beforeSummary && JSON.stringify(entry.body).includes("## GlassPane evidence anchors (M4)"))
check("the block did not leak into the pre-compaction turns", !leaked)

serve.kill()
mock.close()
note("scratch", scratch)
if (failures > 0) {
  console.error(`${failures} E8 check(s) failed`)
  process.exit(1)
}
console.log("all E8 checks passed")


