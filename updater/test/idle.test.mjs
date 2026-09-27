/**
 * §6 row "忙时不换版" — the judgement the whole swap rests on, exercised against
 * a real unix socket (`node:net` server on 127.0.0.1's filesystem namespace),
 * not a stub.
 *
 * REVERSE MUTATION: treat a probe timeout as idle (`idle: true` when the reply
 * never arrives, i.e. "no answer means the daemon is dead-but-idle, go ahead and
 * kickstart it") — `a daemon that never answers is busy, not idle` and
 * `a reply that arrives after the deadline does not unlock the swap` go red,
 * and every `mayRestart === false` assertion with them.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { judgeProbeReply, probeFrame, probeIdle, resolveEngineSocket } from '../lib/idle.js'
import { CODES } from '../lib/codes.js'
import { removeDir, shortSocketPath, startSocketDaemon, tempDir, TMP_PREFIX } from './helpers.mjs'

const dir = tempDir(`${TMP_PREFIX}idle-`)

test('the probe frame is the NDJSON form the daemon reads', () => {
  assert.equal(probeFrame(1), '{"id":1,"method":"probe_status"}\n')
})

test('an answered probe is the only thing that means idle', async () => {
  const socketPath = shortSocketPath(dir, 'a.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  try {
    const verdict = await probeIdle({ socketPath })
    assert.equal(verdict.answered, true, verdict.reason)
    assert.equal(verdict.idle, true)
    assert.equal(verdict.mayRestart, true)
    assert.equal(verdict.frame.result.version, '1.4.0')
    // The server saw the real bytes of the request, not a stubbed call.
    assert.deepEqual(JSON.parse(daemon.requests[0]), { id: 1, method: 'probe_status' })
  } finally {
    await daemon.close()
  }
})

test('a daemon that never answers is busy, not idle', async () => {
  const socketPath = shortSocketPath(dir, 'b.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'silence' })
  try {
    const verdict = await probeIdle({ socketPath, timeoutMs: 250 })
    assert.equal(verdict.answered, false)
    assert.equal(verdict.idle, false)
    assert.equal(verdict.code, CODES.busyOrUnreachable)
    assert.match(verdict.reason, /did not answer/)
    // The whole point: an unanswered probe must never read as "restart it".
    assert.equal(verdict.mayRestart, false)
    assert.ok(daemon.requests.length === 1, 'the request really was delivered to the listener')
  } finally {
    await daemon.close()
  }
})

test('a reply that arrives after the deadline does not unlock the swap', async () => {
  const socketPath = shortSocketPath(dir, 'c.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'slow', delayMs: 600 })
  try {
    const verdict = await probeIdle({ socketPath, timeoutMs: 120 })
    assert.equal(verdict.idle, false)
    assert.equal(verdict.mayRestart, false)
    assert.ok(verdict.elapsedMs < 600, 'the verdict came back on the deadline, not on the reply')
  } finally {
    await daemon.close()
  }
})

test('a reply split across two reads is still one frame', async () => {
  const socketPath = shortSocketPath(dir, 'd.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'split' })
  try {
    const verdict = await probeIdle({ socketPath, timeoutMs: 1_000 })
    assert.equal(verdict.answered, true, verdict.reason)
    assert.equal(verdict.idle, true)
  } finally {
    await daemon.close()
  }
})

test('an error frame, a foreign id, and non-JSON bytes all answer "not idle"', async () => {
  for (const behaviour of ['error', 'wrong-id', 'garbage']) {
    const socketPath = shortSocketPath(dir, `${behaviour}.sock`)
    const daemon = await startSocketDaemon(socketPath, { behaviour })
    try {
      const verdict = await probeIdle({ socketPath, timeoutMs: 500 })
      assert.equal(verdict.idle, false, `${behaviour} must not read as idle`)
      assert.equal(verdict.mayRestart, false)
      assert.equal(verdict.code, CODES.busyOrUnreachable)
    } finally {
      await daemon.close()
    }
  }
})

test('a socket file with no listener is "cannot tell", never "dead, restart"', async () => {
  const socketPath = shortSocketPath(dir, 'stale.sock')
  // A plain file at that path: `existsSync` says yes, the connect says no.
  fs.writeFileSync(socketPath, 'stale socket file from a previous run\n')
  const verdict = await probeIdle({ socketPath, timeoutMs: 500 })
  assert.equal(verdict.idle, false)
  assert.equal(verdict.mayRestart, false)
  assert.match(verdict.reason, /failed|closed|refused|not/)
  fs.rmSync(socketPath, { force: true })

  const missing = await probeIdle({ socketPath: path.join(dir, 'nothing.sock') })
  assert.equal(missing.idle, false)
  assert.equal(missing.mayRestart, false)
  assert.match(missing.reason, /nothing is listening/)
})

test('no socket configured is a refusal to swap', async () => {
  const verdict = await probeIdle({ socketPath: null })
  assert.equal(verdict.idle, false)
  assert.equal(verdict.mayRestart, false)
  assert.equal(verdict.code, CODES.busyOrUnreachable)
})

test('the reply judge keeps its two failure modes distinguishable', () => {
  assert.equal(judgeProbeReply('{"id":1,"result":{"ok":true}}', { id: 1 }).answered, true)
  assert.equal(judgeProbeReply('{"id":2,"result":{"ok":true}}', { id: 1 }).answered, false)
  assert.equal(judgeProbeReply('', { id: 1 }).answered, false)
  assert.equal(judgeProbeReply('null', { id: 1 }).answered, false)
  assert.equal(judgeProbeReply('{"id":1}', { id: 1 }).answered, false, 'neither result nor error proves nothing')
})

test('which socket to probe is resolved the way the daemon resolves it', () => {
  assert.equal(
    resolveEngineSocket({ env: { GLASSPANE_ENGINE_SOCK: '/tmp/explicit.sock' }, stateRoot: '/root' }),
    '/tmp/explicit.sock',
  )
  assert.equal(
    resolveEngineSocket({ env: {}, jobArgs: ['glasspaned', '--socket-path', '/tmp/from-job.sock'], stateRoot: '/root' }),
    '/tmp/from-job.sock',
  )
  assert.equal(
    resolveEngineSocket({ env: {}, jobArgs: ['--socket-path=/tmp/eq.sock'] }),
    '/tmp/eq.sock',
  )
  assert.equal(
    resolveEngineSocket({ env: {}, jobArgs: ['--state-dir', '/named/root'], stateRoot: null }),
    path.join('/named/root', 'daemon.sock'),
    'a named state root serves daemon.sock, per StateRoot.engineSocketPath',
  )
  assert.equal(
    resolveEngineSocket({ env: {}, jobArgs: [], stateRoot: '/named/root' }),
    path.join('/named/root', 'daemon.sock'),
  )
  assert.equal(
    resolveEngineSocket({ env: {}, jobArgs: [], stateRoot: null, homeDir: '/Users/dev' }),
    path.join('/Users/dev', '.glasspane', 'engine.sock'),
    'nothing named: the historic home-derived default keeps the engine.sock name',
  )
  assert.equal(resolveEngineSocket({ env: {}, jobArgs: [], stateRoot: null, homeDir: null }), null)
})

after(() => {
  removeDir(dir)
})
