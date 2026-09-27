#!/usr/bin/env node
/**
 * Test fixture: a minimal MCP server that speaks newline-delimited JSON-RPC on
 * stdio, used by `apply.test.mjs` to exercise `lib/mcp.js` for real. It is not a
 * mock of the thing under test — the client's framing, reply matching and
 * timeout are what is being verified; this is only the peer it talks to.
 *
 *   node mcp-stub.mjs answer    -> normal initialize + tools/list replies
 *   node mcp-stub.mjs silence   -> accepts, never replies
 *   node mcp-stub.mjs garbage   -> emits a non-JSON line
 *   node mcp-stub.mjs bad-tools -> a well-formed frame whose tools field is not
 *                                  a tool list
 *   node mcp-stub.mjs refuse    -> answers initialize with a JSON-RPC error
 */
import process from 'node:process'

const mode = process.argv[2] ?? 'answer'
const write = (message) => process.stdout.write(JSON.stringify(message) + '\n')
/**
 * Bytes that are *not* a JSON frame. `write()` cannot produce these: it runs
 * everything through `JSON.stringify`, so `write('this is not json at all')`
 * lands on the wire as a quoted JSON string and a strict NDJSON reader parses it
 * happily. 'garbage' means "emits a non-JSON line" (header above), so the
 * garbage frames go out raw.
 */
const writeRaw = (text) => process.stdout.write(`${text}\n`)

const TOOLS = Array.from({ length: 16 }, (_, i) => ({ name: `gp_tool_${i}`, description: 'x', inputSchema: { type: 'object' } }))

if (mode === 'silence') {
  // Read forever, say nothing.
  process.stdin.resume()
} else {
  let buffer = ''
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        if (mode === 'garbage') writeRaw('this is not json at all')
        continue
      }
      if (message.method === 'initialize') {
        if (mode === 'refuse') {
          write({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'unsupported protocol version' } })
          continue
        }
        write({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'glasspane-mcp', version: '1.4.1' } },
        })
        continue
      }
      if (message.method === 'tools/list') {
        if (mode === 'garbage') {
          writeRaw('this is not json at all')
          continue
        }
        if (mode === 'bad-tools') {
          write({ jsonrpc: '2.0', id: message.id, result: { tools: 'not-an-array' } })
          continue
        }
        write({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
