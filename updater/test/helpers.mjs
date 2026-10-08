/**
 * Test fixtures that are *real*: a real `node:http` server on 127.0.0.1, a real
 * unix socket daemon, real tar.gz bytes, real `.app` directories, real child
 * processes. Nothing here stubs a parser or fakes a response object — the
 * judgements under test read bytes and exit codes that this file arranges for
 * them to read.
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import require$events from 'node:events'
import crypto from 'node:crypto'

import { packTarGz } from '../lib/tar.js'

export const TMP_PREFIX = '/tmp/gpu-test-'

export function tempDir(prefix = TMP_PREFIX) {
  return fs.mkdtempSync(prefix)
}

export function removeDir(dir) {
  if (dir && dir.startsWith(TMP_PREFIX)) fs.rmSync(dir, { recursive: true, force: true })
}

/** `<appsDir>/<name>/Contents/Info.plist` with a bundle version. */
export function makeFakeApp(appsDir, name, version, { marker = 'old' } = {}) {
  const root = path.join(appsDir, name)
  fs.mkdirSync(path.join(root, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string>\n</dict></plist>\n`,
  )
  fs.writeFileSync(path.join(root, 'Contents', 'MacOS', 'binary'), `${marker} binary for ${name} ${version}`)
  return root
}

/**
 * An executable that really prints `glasspaned <version>` — and, like the real
 * parser, refuses everything else with `unknown argument` and exit 64.
 *
 * It used to echo the version for **any** argument. That is how a fixture became
 * a co-conspirator: the daemon had no `--version` at all until 1.10.0, so the
 * second leg of `localVersion`'s "the two readings have to agree" was permanently
 * empty on every real machine, while the suite stayed green by asking a stub that
 * answered whatever it was handed.
 */
export function makeDaemonBinary(appsDir, version, name = 'GlassPane Daemon.app') {
  const exe = path.join(appsDir, name, 'Contents', 'MacOS', 'glasspaned')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(
    exe,
    '#!/bin/sh\n'
    + 'if [ "$1" = "--version" ]; then echo "glasspaned ' + version + '"; exit 0; fi\n'
    + 'echo "glasspaned: unknown argument: $1" >&2\n'
    + 'exit 64\n',
  )
  fs.chmodSync(exe, 0o755)
  return exe
}

/* ------------------------------------------------------------------ server */

/**
 * Start a real HTTP server on 127.0.0.1. `routes` maps a pathname to a handler
 * `(req, res, url) => void`. Every request is recorded in `requests`.
 */
export async function startServer(routes) {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    seen.push({ method: req.method, pathname: url.pathname, search: url.search, query: Object.fromEntries(url.searchParams) })
    const handler = routes[url.pathname]
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'Not Found', seen_path: url.pathname }))
      return
    }
    handler(req, res, url)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests: seen,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

export function jsonResponse(body, status = 200) {
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}

export function bytesResponse(bytes, { contentType = 'application/octet-stream' } = {}) {
  return (req, res) => {
    res.writeHead(200, { 'content-type': contentType, 'content-length': String(bytes.length) })
    res.end(Buffer.from(bytes))
  }
}

/* ------------------------------------------------------------- release data */

export const PINNED_PATH = '/repos/jingzhao-l/GlassPane'

/**
 * A release fixture: a real gzip'd tar of a GlassPane-shaped tree plus the
 * matching SUMS row. `mutate` lets a test break one of them without breaking
 * the other, which is exactly what the digest and asset gates must catch.
 */
export function buildRelease({ version, treeFiles, tarballBytes = null, sumsText = null }) {
  const tarball = tarballBytes ?? packTarGz(treeFiles ?? defaultTreeFiles(version))
  const digest = crypto.createHash('sha256').update(tarball).digest('hex')
  const tarballName = `GlassPane-${version}.tar.gz`
  const sumsName = `SHA256SUMS-${version}.txt`
  return {
    version,
    tarballName,
    sumsName,
    tarball,
    digest,
    sums: sumsText ?? `${digest}  ${tarballName}\n`,
    release: (urls) => ({
      tag_name: `v${version}`,
      target_commitish: urls.sha ?? 'a'.repeat(40),
      assets: urls.assets,
    }),
  }
}

/** The files the §1.6 self-check reads, at `version`, with a guard that passes. */
export function defaultTreeFiles(version, { guardExit = 0, guardMarker = null } = {}) {
  return [
    { name: `GlassPane-${version}/package.json`, content: JSON.stringify({ name: '@glasspane/monorepo', version }) },
    { name: `GlassPane-${version}/mcp-shell/package.json`, content: JSON.stringify({ name: 'glasspane-mcp', version }) },
    { name: `GlassPane-${version}/engine/Sources/GlassPaneEngine/EngineCore.swift`, content: `public let version = "${version}"\n` },
    {
      name: `GlassPane-${version}/scripts/check-version.mjs`,
      // `guardMarker` is the *execution marker* the ordering tests read: this file
      // is the only thing in the release that runs as a program, so "the marker is
      // on disk" means "staged content was executed", and "absent" means it was not.
      content: `#!/usr/bin/env node\n${guardMarker ? `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(guardMarker)}, 'guard ran\\n')\n` : ''}process.exit(${guardExit})\n`,
      mode: 0o755,
    },
  ]
}

/* ------------------------------------------------------------------ gpg layer */

/**
 * A `runGpg` stand-in for the four authorship states, because *whether this
 * machine has gpg installed* is not a fact any test may depend on: the suite has
 * to reddening on a policy mutation, not on somebody's Homebrew state. Exactly
 * like `fakeMcpPeer` below and the `runner` seam in `lib/selfcheck.js`, this
 * replaces **process selection only** — the argv it records, the files it was
 * handed, and the exit codes it answers with are what `lib/signature.js` decides
 * on, and `signature.test.mjs` has one test that drives the real binary instead.
 *
 * `outcome` picks the gpg answer; `verifiedPaths` records what `--verify` was
 * asked about, which is how the pairing "this .asc, those checksum bytes" is
 * pinned rather than assumed.
 */
export const FAKE_SIGNER_FPR = '0929EA31DF4F7429F63FC53189D88B1D043A1298'
export const FOREIGN_SIGNER_FPR = 'DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF12'

export function fakeGpg({
  outcome = 'verified',
  keyFingerprints = [FAKE_SIGNER_FPR],
  signerFingerprint = FAKE_SIGNER_FPR,
  importStatus = 0,
} = {}) {
  const calls = []
  const verified = []
  const runGpg = (args, ctx = {}) => {
    calls.push({ args, gnupgHome: ctx?.gnupgHome ?? null })
    const argv = Array.isArray(args) ? args : []
    if (outcome === 'unavailable') return { status: null, stdout: '', stderr: 'spawnSync gpg ENOENT' }
    if (argv[0] === '--version') return { status: 0, stdout: 'gpg (GnuPG) 2.5.0\n', stderr: '' }
    if (argv.includes('--import')) {
      return { status: importStatus, stdout: '', stderr: importStatus === 0 ? 'gpg: key imported\n' : 'gpg: import failed\n' }
    }
    if (argv.includes('--list-keys')) {
      return { status: 0, stdout: keyFingerprints.map((fpr) => `fpr:::::::::${fpr}:\n`).join(''), stderr: '' }
    }
    if (argv.includes('--verify')) {
      const at = argv.indexOf('--verify')
      const signedFile = argv[at + 2] ?? null
      verified.push({
        signatureFile: argv[at + 1] ?? null,
        signedFile,
        gnupgHome: ctx?.gnupgHome ?? null,
        // Read *at the moment of the call*: the verification directory is deleted
        // when the gate finishes, so a test that looks later would be asserting
        // nothing. This is what pins "gpg was handed the same bytes the digest
        // gate trusted" rather than merely "a file with the right name existed".
        signedBytes: signedFile && fs.existsSync(signedFile) ? fs.readFileSync(signedFile, 'utf8') : null,
      })
      if (outcome === 'verified') {
        return { status: 0, stdout: `[GNUPG:] GOODSIG ${signerFingerprint.slice(-16)} 4 2\n[GNUPG:] VALIDSIG ${signerFingerprint} 1790502228 0\n`, stderr: 'gpg: Good signature from "jingzhao-l (sign-github)"\n' }
      }
      if (outcome === 'foreign-key') {
        return { status: 0, stdout: `[GNUPG:] GOODSIG X 4 2\n[GNUPG:] VALIDSIG ${signerFingerprint} 1790502228 0\n`, stderr: 'gpg: Good signature from "somebody else"\n' }
      }
      if (outcome === 'empty-asc') return { status: 1, stdout: '[GNUPG:] NODATA 1\n', stderr: 'gpg: no signature found\n' }
      if (outcome === 'no-public-key') {
        return { status: 1, stdout: `[GNUPG:] NO_PUBKEY ${signerFingerprint.slice(-16)}\n`, stderr: "gpg: Can't check signature: No public key\n" }
      }
      if (outcome === 'no-validsig') return { status: 0, stdout: '[GNUPG:] GOODSIG X 4 2\n', stderr: 'gpg: Good signature from\n' }
      return { status: 1, stdout: '[GNUPG:] BADSIG 4 2 1\n', stderr: 'gpg: BAD signature from "jingzhao-l (sign-github)"\n' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { runGpg, calls, verified }
}

/* -------------------------------------------------------------- unix socket */

/**
 * A daemon-shaped unix socket server. `behaviour`:
 *   'answer'      reply with a result frame
 *   'silence'     accept, never reply
 *   'slow'        reply after `delayMs`
 *   'split'       reply in two writes (the reader must reassemble)
 *   'error'       reply with an error frame
 *   'wrong-id'    reply for another request id
 *   'garbage'     reply with bytes that are not JSON
 *   'close'       accept and hang up
 * It may also be a **function** returning one of those names, which is how the
 * idle-evidence tests express "answered the first probe, went silent during the
 * build" — a constant cannot express a daemon whose state changes.
 * `replies` records the frames the server received.
 */
export async function startSocketDaemon(socketPath, { behaviour = 'answer', version = '9.9.9', delayMs = 250 } = {}) {
  const replies = []
  const dropped = []
  const connections = []
  const mode = () => (typeof behaviour === 'function' ? String(behaviour()) : behaviour)
  const startMode = typeof behaviour === 'function' ? 'answer' : behaviour
  const server = net.createServer((socket) => {
    connections.push(socket)
    socket.on('error', (error) => dropped.push(String(error.code ?? error.message)))
    // A real daemon keeps running when a client hangs up mid-reply, and `handshakeVerify` *does* hang up:
    // it polls, so each budget expiry closes the socket, and the reply already in flight then writes to a
    // dead peer. Without this handler that EPIPE escapes as an unhandled socket error and the test fails
    // with `write EPIPE` from `respond()` — a verdict produced by the harness and the scheduler rather than
    // by the code under test (measured: red at load average 226, green in isolation on the same commit).
    // The codes are recorded rather than swallowed so a test that cares can assert on them.
    socket.on('data', (chunk) => {
      replies.push(chunk.toString('utf8').trim())
      const current = mode()
      const request = safeJson(chunk.toString('utf8'))
      const id = request?.id ?? 1
      const respond = (text) => {
        if (current === 'silence' || current === 'close') return
        if (current === 'error') socket.write(`${JSON.stringify({ id, error: { code: -32001, message: 'daemon busy' } })}\n`)
        else if (current === 'wrong-id') socket.write(`${JSON.stringify({ id: id + 1, result: { ok: true } })}\n`)
        else if (current === 'garbage') socket.write('not json\n')
        else if (current === 'split') {
          const line = `${JSON.stringify({ id, result: { version, permissions: { accessibility: 'granted' } } })}\n`
          socket.write(line.slice(0, 5))
          setTimeout(() => socket.write(line.slice(5)), 10)
        } else socket.write(`${JSON.stringify({ id, result: { version, permissions: { accessibility: 'granted' } } })}\n`)
      }
      if (current === 'slow') setTimeout(respond, delayMs)
      else if (current === 'close') socket.end()
      else respond()
    })
    if (startMode === 'silence') { /* hold the connection open, say nothing */ }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  if (['answer', 'split', 'slow', 'error', 'wrong-id', 'garbage'].includes(startMode)) {
    fs.chmodSync(socketPath, 0o600)
  }
  return {
    server,
    requests: replies,
    dropped,
    connections,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => {
        fs.rmSync(socketPath, { force: true })
        resolve()
      })
    }),
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text.trim().split('\n')[0])
  } catch {
    return null
  }
}

/** A socket path that fits in `sockaddr_un` (macOS caps it at ~104 bytes). */
export function shortSocketPath(dir, name = 'd.sock') {
  return path.join(dir, name)
}

export function tmpHome() {
  return tempDir(TMP_PREFIX)
}

export { crypto }


/**
 * An in-process MCP peer for `mcpToolsList`'s `spawnFn`.
 *
 * Why this exists: the same test run with a real `node` child needs 5.7–11.1 s just
 * to *boot* on a busy machine (measured 2026-09-27 with load average 223), so every
 * sub-second budget in `apply.test.mjs` became a measurement of scheduler pressure
 * rather than of the client's framing — a control that goes red only when somebody
 * else is compiling is not a control. The peer below speaks the same newline-
 * delimited JSON-RPC over real streams, so what stays under test is exactly the part
 * that matters: framing, reply matching, refusal handling, timeout handling. One
 * test in `apply.test.mjs` still boots the real fixture, because the pipe itself is
 * part of the contract; it is given minutes, not seconds.
 *
 * `mode` mirrors `test/fixtures/mcp-stub.mjs`: answer | silence | garbage |
 * bad-tools | refuse | slow (never answers, for the timeout branch).
 */
export function fakeMcpPeer(mode = 'answer') {
  return function spawnFn() {
    const child = new (require$events.EventEmitter)()
    const stdin = { writes: [], write(text) { this.writes.push(text); deliver(text) }, on() {}, once() {} }
    child.stdin = stdin
    child.stdout = new (require$events.EventEmitter)()
    child.stderr = new (require$events.EventEmitter)()
    child.kill = () => { child.killed = true }
    let buffer = ''
    const reply = (message) => {
      if (mode === 'silence' || mode === 'slow') return
      setImmediate(() => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n')))
    }
    const replyRaw = (text) => {
      setImmediate(() => child.stdout.emit('data', Buffer.from(`${text}\n`)))
    }
    function deliver(chunk) {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          if (mode === 'garbage') replyRaw('this is not json at all')
          continue
        }
        if (message.method === 'initialize') {
          if (mode === 'refuse') {
            reply({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'unsupported protocol version' } })
            continue
          }
          reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'glasspane-mcp', version: '1.4.1' } } })
          continue
        }
        if (message.method === 'tools/list') {
          if (mode === 'garbage') { replyRaw('this is not json at all'); continue }
          if (mode === 'bad-tools') { reply({ jsonrpc: '2.0', id: message.id, result: { tools: 'not-an-array' } }); continue }
          reply({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS_16 } })
        }
      }
    }
    return child
  }
}

const TOOLS_16 = Array.from({ length: 16 }, (_, i) => ({ name: `gp_tool_${i}`, description: 'x', inputSchema: { type: 'object' } }))
