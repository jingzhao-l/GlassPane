/**
 * §9.10：证书类失败后的那一次重导 + 重跑。
 *
 * 这一条存在的原因是真实机器上的一个**永久**状态：束只在 `enable` 与 `apply` 后刷新，
 * 而 TLS 失败永远走不到 `apply`。机器后来装了新代理 ⇒ 每天定时检查都在第 1 道门上失败，
 * 面板读起来像"没有可用更新"。所以恢复动作不能等人想起点什么。
 *
 * 三条边界同时是三条测试：调用方已经给了 `NODE_EXTRA_CA_CERTS` 就不介入（方向归他）；
 * 只重跑一次（标记位）；导不出可用的束就不重跑，但**必须留痕**（否则这台机器的失败只剩一句猜测）。
 *
 * REVERSE MUTATION（每条都已实测转红，恢复后全绿）：
 *   · 删掉标记位判断 → 循环守卫那条红（并会真的套娃起子进程）
 *   · `status !== 'ok'` 放宽成"有记录就重跑" → 空束那条红
 *   · `child.status ?? 0` → 信号杀死子进程那条红（每日作业会"成功"）
 *   · 把 `tlsVerification` 换成匹配 outcome.message → 非 TLS 那条红（403/限流被当成证书问题去动信任）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CA_ENV_VAR } from '../lib/ca-bundle.js'
import { EXIT } from '../lib/codes.js'
import { REEXEC_MARKER, main, recoverFromTlsFailure } from '../cli.js'
import { makeFetcher } from '../lib/source.js'
import { TMP_PREFIX, removeDir, tempDir } from './helpers.mjs'
import fs from 'node:fs'

const GOOD = { status: 'ok', certs: 163, path: '/var/st/ca-roots.pem', exportedAt: 'now', detail: null }

function harness({ refresh = () => GOOD, child = { status: 0 } } = {}) {
  const spawned = []
  const records = []
  let refreshCalls = 0
  const api = {
    spawned,
    records,
    refreshCalls: () => refreshCalls,
    // `recoverFromTlsFailure` 的形参名与 CLI deps 的键名是两个面：这里同时给出，
    // 免得测试与实现各叫一个名字，接错线时全绿。
    deps: {
      refresh: () => {
        refreshCalls += 1
        return refresh()
      },
      refreshCaBundle: () => {
        refreshCalls += 1
        return refresh()
      },
      spawnChild: (args, env) => {
        spawned.push({ args, env })
        return child
      },
      onRecord: (record) => records.push(record),
    },
  }
  return api
}

const tlsOutcome = { ok: false, status: 'check-failed', code: 'release-unreachable', message: 'GET https://api.github.com/… failed: fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)', tlsVerification: true }

test('a certificate failure re-exports the bundle and hands the retry the exact same argv', () => {
  const h = harness({ child: { status: EXIT.OK } })
  const code = recoverFromTlsFailure({
    outcome: tlsOutcome,
    argv: ['check', '--state-dir', '/var/st', '--json'],
    env: {},
    ...h.deps,
  })
  assert.equal(code, EXIT.OK, '子进程已经替父进程把 stdout 与退出码演完')
  assert.equal(h.spawned.length, 1, '只重跑一次')
  assert.deepEqual(h.spawned[0].args, ['check', '--state-dir', '/var/st', '--json'], '重跑必须是同一条命令：丢一个参数就变成另一件事')
  assert.equal(h.spawned[0].env[CA_ENV_VAR], GOOD.path)
  assert.equal(h.spawned[0].env[REEXEC_MARKER], '1', '不带防循环标记的重跑是递归')
  assert.deepEqual(h.records.map((r) => r.status), ['ok'])
})

test('the marker in the environment stops the recursion, and nothing is re-exported on the second pass', () => {
  const h = harness()
  const code = recoverFromTlsFailure({ outcome: tlsOutcome, argv: ['check'], env: { [REEXEC_MARKER]: '1' }, ...h.deps })
  assert.equal(code, null, '第二次只许如实报出原因，不再往上叠一层子进程')
  assert.equal(h.refreshCalls(), 0, '连导出都不该再做一次：这一次运行已经证明束帮不上忙')
  assert.deepEqual(h.spawned, [])
})

test('an operator-supplied NODE_EXTRA_CA_CERTS is not overridden', () => {
  const h = harness()
  const code = recoverFromTlsFailure({ outcome: tlsOutcome, argv: ['check'], env: { [CA_ENV_VAR]: '/mine/roots.pem' }, ...h.deps })
  assert.equal(code, null)
  assert.equal(h.refreshCalls(), 0, '人已经指定了信任从哪来，方向归他，工具不代他改')
  assert.match(tlsOutcome.message, /UNABLE_TO_VERIFY/, '原始拒绝仍然照常返回（这里断言的是那条消息没有被"恢复成功"覆盖掉）')
})

test('a non-certificate failure gets no bundle retry at all', () => {
  for (const outcome of [
    { ...tlsOutcome, tlsVerification: false, message: 'GET … failed: connect ECONNREFUSED (ECONNREFUSED)' },
    { ...tlsOutcome, tlsVerification: false, message: 'GET … answered 403 Forbidden' },
  ]) {
    const h = harness()
    assert.equal(recoverFromTlsFailure({ outcome, argv: ['check'], env: {}, ...h.deps }), null)
    assert.equal(h.refreshCalls(), 0, '限流、拒连、DNS 都不是信任问题：动配置的只会把人支到错的地方')
    assert.deepEqual(h.spawned, [])
  }
})

test('an export that produced nothing still records its state and does not pretend a retry happened', () => {
  for (const record of [
    { status: 'empty', certs: 0, path: null, exportedAt: 'now', detail: 'both keychains empty' },
    { status: 'unavailable', certs: 0, path: null, exportedAt: 'now', detail: 'no security tool' },
    { status: 'write-unverified', certs: 9, path: '/var/st/ca-roots.pem', exportedAt: 'now', detail: 'read back differs' },
  ]) {
    const h = harness({ refresh: () => record })
    const code = recoverFromTlsFailure({ outcome: tlsOutcome, argv: ['check'], env: {}, ...h.deps })
    assert.equal(code, null, `${record.status} 不是"重跑一次看看"的理由`)
    assert.deepEqual(h.spawned, [])
    assert.deepEqual(h.records.map((r) => r.status), [record.status], '失败要留在状态里，面板才有得说')
  }
})

test('a retry killed by a signal never answers 0', () => {
  for (const child of [{ status: null, signal: 'SIGKILL' }, { error: new Error('spawn node ENOENT') }, undefined]) {
    const code = recoverFromTlsFailure({ outcome: tlsOutcome, argv: ['check'], env: {}, ...harness({ child: child ?? { status: null } }).deps })
    assert.equal(code, EXIT.REFUSED, '一个"看起来完成了每日检查"的 0 会把这次事故抹掉')
  }
})

test('the child exit code is forwarded verbatim (it is the contract)', () => {
  for (const expected of [EXIT.OK, EXIT.USAGE, EXIT.REFUSED, 4, 5]) {
    const code = recoverFromTlsFailure({ outcome: tlsOutcome, argv: ['apply', '--auto'], env: {}, ...harness({ child: { status: expected } }).deps })
    assert.equal(code, expected)
  }
})

test('a refused connection, run through the real fetcher, must not arm the recovery', async () => {
  const stdout = { writes: [], write(s) { this.writes.push(s) } }
  const stderr = { writes: [], write(s) { this.writes.push(s) } }
  const h = harness()
  const root = tempDir(`${TMP_PREFIX}tls-conn-`)
  const code = await main({
    argv: ['check', '--json'],
    env: { GLASSPANE_STATE_DIR: root },
    stdout,
    stderr,
    deps: {
      // 同一条真实链路，只是失败原因换成"连不上"：这不是信任问题，一次重导都不该发生。
      fetchJson: makeFetcher(async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
        })
      }),
      readLocal: () => ({ ok: true, version: '1.0.0', readings: ['stub'] }),
      refreshCaBundle: h.deps.refreshCaBundle,
      spawnChild: h.deps.spawnChild,
      onRecord: h.deps.onRecord,
      homeDir: root,
    },
  })
  assert.equal(code, EXIT.REFUSED)
  assert.equal(h.refreshCalls(), 0, '限流/拒连触发重导＝每次网络抖动都改一次这台机器的信任配置')
  assert.deepEqual(h.spawned, [], '更不许偷偷再起一个子进程')
  assert.equal(h.records.length, 0)
  removeDir(root)
})

test('main() is what performs the recovery, not runCommand: the installer library caller never spawns a CLI', async () => {
  const stdout = { writes: [], write(s) { this.writes.push(s) } }
  const stderr = { writes: [], write(s) { this.writes.push(s) } }
  const h = harness({ child: { status: EXIT.REFUSED } })
  const root = tempDir(`${TMP_PREFIX}tls-main-`)
  const code = await main({
    argv: ['check', '--json'],
    env: { GLASSPANE_STATE_DIR: root },
    stdout,
    stderr,
    deps: {
      // 真实的 makeFetcher 包一个"证书类失败"的 fetch：tlsVerification 必须由 source.js 判定、
      // 由 check.js 带上、再由 main() 读。我手写这个标记的那条测试只能证明我自己。
      fetchJson: makeFetcher(async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
        })
      }),
      readLocal: () => ({ ok: true, version: '1.0.0', readings: ['stub'] }),
      refreshCaBundle: h.deps.refreshCaBundle,
      spawnChild: h.deps.spawnChild,
      homeDir: root,
    },
  })
  assert.equal(code, EXIT.REFUSED, '恢复的结果就是退出码来源')
  assert.equal(h.spawned.length, 1, '走的是 main()，不是 runCommand()')
  assert.equal(stdout.writes.length, 0, `父进程一个字都不许多写：--json 那一行只属于子进程，实写：${JSON.stringify(stdout.writes)}`)
  assert.equal(fs.existsSync(`${root}/ca-roots.pem`), false, '导出被桩成了内存里的记录：这条测试不许真的往盘上写束')
  assert.ok(fs.existsSync(`${root}/update-state.json`), '重导的结论必须落了盘，面板才有得说')
  const written = JSON.parse(fs.readFileSync(`${root}/update-state.json`, 'utf8'))
  assert.equal(written.caRoots.status, 'ok', '写进状态的是这次重导的结果')
  removeDir(root)
})
