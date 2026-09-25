#!/usr/bin/env node
/**
 * Offline "model" for the harness spike: an OpenAI-compatible endpoint that
 * always asks for one gp_probe_status tool call, then finishes. No credentials,
 * no network, no spend — and a *deterministic* tool-execution path, which is
 * what the contract test needs (a real model would sometimes not call the tool).
 */
import http from "node:http"

const PORT = Number(process.env.MOCK_PORT || 4310)
let toolCallIssued = false

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ object: "list", data: [{ id: "spike", object: "model", owned_by: "glasspane" }] }))
    return
  }
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body || "{}")
    } catch {}
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const toolName = "gp_probe_status"
    const sawToolResult = messages.some((m) => m.role === "tool" || (m.tool_calls && m.tool_calls.length))

    let choice
    if (!sawToolResult && !toolCallIssued) {
      toolCallIssued = true
      choice = {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_spike_1", type: "function", function: { name: toolName, arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }
    } else {
      choice = {
        index: 0,
        message: { role: "assistant", content: "SPIKE-DONE: the tool result came back through the harness." },
        finish_reason: "stop",
      }
    }
    console.log(`[mock] ${messages.length} msgs -> ${choice.finish_reason}`)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: "chatcmpl-spike",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "spike",
        choices: [choice],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    )
  })
})

server.listen(PORT, "127.0.0.1", () => console.log(`[mock] listening on http://127.0.0.1:${PORT}/v1`))
