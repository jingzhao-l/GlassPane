/**
 * §9: the root bundle node is handed on a machine whose TLS is intercepted.
 *
 * Why a whole file for a `security` invocation: the failure this exists for was
 * found by *running* `check` on a real machine, and every test in this suite up to
 * then drove a fake HTTP layer — so a job that could never reach GitHub while the
 * panel cheerfully reported "automatic update is on" passed 198 tests. The shapes
 * below are the ones that make that state impossible to reach: statuses that cannot
 * collapse into each other, a probe that must run in a **child** process (node reads
 * `NODE_EXTRA_CA_CERTS` at start, so setting it in-process proves nothing), and a
 * bundle that is only believed after it is read back.
 *
 * REVERSE MUTATION, one per row, each verified to redden the named test:
 *   · fold `probe-failed` into `ok`            → closed-vocabulary + probe tests
 *   · believe the export on `security`'s exit  → empty-bundle test
 *   · skip the read-back compare              → write-unverified test
 *   · delete the previous file when empty      → "keeps the previous bundle" test
 *   · probe in this process instead of a child → "child, not this process" test
 *   · put the PROBE_URL inside the `-e` script       → "url rides argv" test
 * `run` is always injected: nothing here touches a developer's keychain or network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  CA_BUNDLE_NAME,
  CA_ENV_VAR,
  CA_STATUSES,
  KEYCHAIN_SOURCES,
  caBundlePath,
  countCertificates,
  describeCa,
  exportCaBundle,
  probeWithBundle,
  usableBundle,
} from '../lib/ca-bundle.js'
import { CODES } from '../lib/codes.js'
import { DEFAULT_BASE } from '../lib/source.js'

const RELEASE_PATH = '/releases/latest'
import { modeOf } from '../lib/fsutil.js'
import { TMP_PREFIX, removeDir, tempDir } from './helpers.mjs'

/**
 * `caBundlePath` refuses a relative state root (a relative NODE_EXTRA_CA_CERTS in
 * a launchd job resolves against whatever directory the job starts in), so the
 * scratch directories here are made absolute the same way a caller would.
 */
function scratch(prefix) {
  // `${TMP_PREFIX}…` is not decoration: removeDir() refuses anything outside it, so
  // a bare prefix here would leave a scratch directory in the repository after every
  // run — which is exactly how a test suite quietly turns into uncommitted files.
  return path.resolve(tempDir(`${TMP_PREFIX}ca-${prefix}-`))
}

const PEM = (n) => Array.from({ length: n }, (_, i) => `-----BEGIN CERTIFICATE-----\nMIIB${i}FAKE\n-----END CERTIFICATE-----\n`).join('')
const PROBE_URL = 'https://api.github.com/repos/jingzhao-l/GlassPane/releases/latest'

/** Records every command asked of it and answers by command name. */
function fakeRun({ keychains = {}, nodeExit = 0, nodeStderr = '', nodeError = null, securityError = null } = {}) {
  const calls = []
  return {
    calls,
    run(command, args, options = {}) {
      calls.push({ command, args, options })
      if (command === 'security') {
        if (securityError) return { status: null, stdout: '', stderr: '', error: securityError }
        const out = keychains[command === 'security' ? args[args.length - 1] : command]
        if (out === undefined) return { status: 1, stdout: '', stderr: 'unable to open keychain' }
        return { status: 0, stdout: out, stderr: '' }
      }
      if (nodeError) return { status: null, stdout: '', stderr: '', error: nodeError }
      return { status: nodeExit, stdout: '', stderr: nodeStderr }
    },
  }
}

test('the bundle is exported from both keychains, written private, and believed only after it is read back', () => {
  const stateRoot = scratch('ca-ok-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(3), [KEYCHAIN_SOURCES[1]]: PEM(2) } })
    const record = exportCaBundle({ stateRoot, probeUrl: PROBE_URL, run: f.run })
    assert.equal(record.status, 'ok', JSON.stringify(record))
    assert.equal(record.certs, 5, 'both keychains contribute: the system roots and the administrator-installed one')
    assert.equal(record.path, caBundlePath(stateRoot))
    const written = fs.readFileSync(caBundlePath(stateRoot), 'utf8')
    assert.equal(countCertificates(written), 5)
    assert.equal(modeOf(caBundlePath(stateRoot)), 0o600, 'a root bundle is not secret, but this file is written by the same rule as every other state file')
  } finally {
    removeDir(stateRoot)
  }
})

test('a bundle that does not read back the same is write-unverified, not ok', () => {
  const stateRoot = scratch('ca-rb-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(4), [KEYCHAIN_SOURCES[1]]: '' } })
    const record = exportCaBundle({
      stateRoot,
      run: f.run,
      readFile: () => PEM(1), // the disk answers with something else than what was written
    })
    assert.equal(record.status, 'write-unverified')
    assert.match(record.detail, /read back 1 certificate\(s\) of the 4 written/)
    assert.ok(describeCa(record).remedy, 'a bundle nobody can read back must come with a next step, not just a shrug')
  } finally {
    removeDir(stateRoot)
  }
})

test('a failing write is a status, not a thrown error: an export is never a reason to refuse an update', () => {
  const stateRoot = scratch('ca-throw-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(1), [KEYCHAIN_SOURCES[1]]: '' } })
    const record = exportCaBundle({
      stateRoot,
      run: f.run,
      writeFile: () => {
        throw new Error('EACCES: permission denied')
      },
    })
    assert.equal(record.status, 'write-unverified')
    assert.match(record.detail, /EACCES/)
  } finally {
    removeDir(stateRoot)
  }
})

test('zero certificates exported keeps the bundle that already worked and says it produced nothing', () => {
  const stateRoot = scratch('ca-empty-')
  try {
    const previous = PEM(7)
    fs.writeFileSync(caBundlePath(stateRoot), previous, 'utf8')
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: '', [KEYCHAIN_SOURCES[1]]: '' } })
    const record = exportCaBundle({ stateRoot, run: f.run })
    assert.equal(record.status, 'empty', '"security ran" is not evidence any certificate came out of it')
    assert.equal(fs.readFileSync(caBundlePath(stateRoot), 'utf8'), previous, 'a bad export must not take away the bundle the agent is already using')
    assert.match(describeCa(record).summary, /is kept and still handed to the agent/)
  } finally {
    removeDir(stateRoot)
  }
})

test('a machine without the security tool is unavailable and gets a remedy it can actually run', () => {
  const stateRoot = scratch('ca-nowin-')
  try {
    const f = fakeRun({ securityError: Object.assign(new Error('spawn security ENOENT'), { code: 'ENOENT' }) })
    const record = exportCaBundle({ stateRoot, run: f.run })
    assert.equal(record.status, 'unavailable')
    assert.ok(!fs.existsSync(caBundlePath(stateRoot)))
    assert.match(describeCa(record).remedy, new RegExp(CA_ENV_VAR), 'the only fix left is pointing node at a bundle the operator trusts')
  } finally {
    removeDir(stateRoot)
  }
})

test('the probe runs a child node with the bundle in its environment, not this process with it set later', () => {
  const stateRoot = scratch('ca-probe-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(2), [KEYCHAIN_SOURCES[1]]: '' } })
    const record = exportCaBundle({ stateRoot, probeUrl: PROBE_URL, run: f.run, nodePath: '/usr/local/bin/node' })
    assert.equal(record.status, 'ok')
    const probe = f.calls.at(-1)
    assert.equal(probe.command, '/usr/local/bin/node', 'the probe is a node start-up, because that is the only moment node reads the variable')
    assert.equal(probe.options.env[CA_ENV_VAR], caBundlePath(stateRoot), 'the child gets the bundle the agent will get; setting it in this process would prove nothing')
    assert.ok(!('NODE_EXTRA_CA_CERTS' in process.env) || process.env.NODE_EXTRA_CA_CERTS !== caBundlePath(stateRoot))
  } finally {
    removeDir(stateRoot)
  }
})

test('the probe URL rides on argv, never inside the script the child evaluates', () => {
  const stateRoot = scratch('ca-argv-')
  try {
    const hostile = 'https://example.test/$(touch /tmp/pwned)"; rm -rf /'
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(1), [KEYCHAIN_SOURCES[1]]: '' } })
    exportCaBundle({ stateRoot, probeUrl: hostile, run: f.run })
    const probe = f.calls.at(-1)
    assert.equal(probe.args[probe.args.length - 1], hostile, 'the PROBE_URL is an argv slot the child reads with process.argv[1]')
    assert.ok(!probe.args[1].includes(hostile), 'a base PROBE_URL that carried a quote must not become code in the -e script')
  } finally {
    removeDir(stateRoot)
  }
})

test('a bundle that still cannot reach the endpoint is probe-failed, which is not the same sentence as ok', () => {
  const stateRoot = scratch('ca-dead-')
  try {
    const f = fakeRun({
      keychains: { [KEYCHAIN_SOURCES[0]]: PEM(9), [KEYCHAIN_SOURCES[1]]: PEM(1) },
      nodeExit: 21,
      nodeStderr: 'Error: unable to verify the first certificate\n',
    })
    const record = exportCaBundle({ stateRoot, probeUrl: PROBE_URL, run: f.run })
    assert.equal(record.status, 'probe-failed', 'certs on disk is not "the network path works"; this is the case where the exported bundle did not contain the intercepting root')
    assert.match(record.detail, /unable to verify the first certificate/, 'the child process\'s own reason is what lands in the record — the installer once wrote "TLS or DNS refused" for a bundle that answered 200 ninety seconds later')
    assert.match(describeCa(record).remedy, /add-trusted-cert/, 'the named fix is: that root is not in the two keychains this exports')
  } finally {
    removeDir(stateRoot)
  }
})

test('a probe that could not start is a failed probe, not a passed one', () => {
  const stateRoot = scratch('ca-nospan-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(1), [KEYCHAIN_SOURCES[1]]: '' }, nodeError: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) })
    const record = exportCaBundle({ stateRoot, probeUrl: PROBE_URL, run: f.run })
    assert.equal(record.status, 'probe-failed')
    assert.match(record.detail, /node could not be started/)
  } finally {
    removeDir(stateRoot)
  }
})

test('an endpoint that answers a non-2xx is not a failed bundle: TLS worked, the server decided', () => {
  const stateRoot = scratch('answered-')
  try {
    const f = fakeRun({
      keychains: { [KEYCHAIN_SOURCES[0]]: PEM(12), [KEYCHAIN_SOURCES[1]]: '' },
      nodeExit: 20,
      nodeStderr: 'HTTP 403 rate limited',
    })
    const record = exportCaBundle({ stateRoot, probeUrl: PROBE_URL, run: f.run })
    assert.equal(record.status, 'ok', '403 是端点自己的答复。把它写成 probe-failed，remedy 就会让人去改信任配置 —— 而那恰恰是这里最不该被动的东西')
    assert.match(record.detail, /TLS/, '仍然要说一句：束这条路验过了')
    assert.match(record.detail, /HTTP 403/, '以及端点到底答了什么')
    assert.equal(describeCa(record).remedy, null, 'ok 态不编造建议')
  } finally {
    removeDir(stateRoot)
  }
})

test('a transport failure with no reason from the child says so, instead of guessing one', () => {
  const stateRoot = scratch('silent-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(2), [KEYCHAIN_SOURCES[1]]: '' }, nodeExit: 21, nodeStderr: '' })
    const record = exportCaBundle({ stateRoot, probeUrl: PROBE_URL, run: f.run })
    assert.equal(record.status, 'probe-failed')
    assert.match(record.detail, /could not reach|refused|exited/, record.detail)
    assert.doesNotMatch(record.detail, /certificate/, '子进程没说"证书"，记录里就不许出现证书 —— 那正是安装那一次把 200 说成证书问题的来源')
  } finally {
    removeDir(stateRoot)
  }
})

test('the five statuses are the schema enum, and each one says something different', () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'schema', 'update-state.schema.json'), 'utf8'))
  const inSchema = schema.properties.caRoots.properties.status.enum
  assert.deepEqual([...CA_STATUSES].sort(), [...inSchema].sort(), 'ca-bundle.js and the state schema must not carry two lists of the same vocabulary')

  const seen = new Map()
  for (const status of CA_STATUSES) {
    const described = describeCa({ status, certs: 3, path: '/tmp/x/ca-roots.pem', exportedAt: 'now', detail: 'd' })
    assert.ok(described.summary && described.summary !== '', `${status} has to be sayable`)
    if (status !== 'ok') {
      assert.ok(described.remedy, `${status} must come with a next step; a refusal that names no action is not a remedy`)
    }
    assert.ok(!seen.has(described.summary), `${status}'s summary collides with ${seen.get(described.summary)}: two different failures told in the same words`)
    seen.set(described.summary, status)
  }
  assert.equal(CA_STATUSES.length, 5)
})

test('absent, empty and "not one this program knows" are three different sentences', () => {
  assert.match(describeCa(null).summary, /never exported/, 'a state file from before this existed reads as "not recorded", never as "fine"')
  assert.ok(describeCa(null).remedy)
  assert.match(describeCa({ status: 'fine', certs: 99, path: '/x', exportedAt: 'now' }).summary, /not one this program knows/)
  assert.equal(describeCa({ status: 'ok', certs: 163, path: '/x', exportedAt: 'now' }).remedy, null, 'the good state invents no advice')
})

test('usableBundle: a file exists, is empty, or is there — only the last one is handed to launchd', () => {
  const stateRoot = scratch('ca-use-')
  try {
    const target = caBundlePath(stateRoot)
    assert.deepEqual(usableBundle(target), { usable: false, certs: 0, reason: 'absent' })
    fs.writeFileSync(target, '', 'utf8')
    assert.equal(usableBundle(target).usable, false, 'a 0-byte NODE_EXTRA_CA_CERTS makes node fail at start-up: worse than no bundle')
    assert.equal(usableBundle(target).reason, 'empty')
    fs.writeFileSync(target, PEM(2), 'utf8')
    assert.deepEqual(usableBundle(target), { usable: true, certs: 2, reason: null })
  } finally {
    removeDir(stateRoot)
  }
})

test('a bundle is only ever written inside the state root it was given', () => {
  const stateRoot = scratch('ca-root-')
  try {
    assert.equal(caBundlePath(stateRoot), path.join(stateRoot, CA_BUNDLE_NAME))
    assert.throws(() => caBundlePath(''), (error) => error.code === CODES.homeRecordUnavailable, 'an unnamed state root must not become a bundle in the cwd')
    assert.throws(() => caBundlePath(null), (error) => error.code === CODES.homeRecordUnavailable)
    assert.throws(() => caBundlePath('.glasspane'), (error) => error.code === CODES.homeRecordUnavailable, 'a relative root becomes a different file depending on the directory launchd starts the job in')
  } finally {
    removeDir(stateRoot)
  }
})

/* --------------------------------------- §9.8 那个 PROBE_URL 本身（真机踩过 [object Object]） */

test('the probe URL is a real https URL built from the resolved base, not a stringified object', async () => {
  const { releaseProbeUrl } = await import('../cli.js')
  const url = releaseProbeUrl({})
  assert.equal(url, `${DEFAULT_BASE}${RELEASE_PATH}`, url)
  assert.doesNotMatch(url, /\[object Object\]/, 'resolveBase 返回的是对象；整块插进模板字符串就是这个形状')
  const parsed = new globalThis.URL(url)
  assert.equal(parsed.protocol, 'https:')
  assert.equal(parsed.host, 'api.github.com')
  assert.equal(parsed.pathname, '/repos/jingzhao-l/GlassPane/releases/latest')
  // 自建镜像/测试基址也要带上同一条路径（否则探测打到一个不存在的地方，又记成 probe-failed）。
  assert.equal(
    releaseProbeUrl({ GLASSPANE_UPDATE_BASE: 'https://mirror.example.test' }),
    'https://mirror.example.test/repos/jingzhao-l/GlassPane/releases/latest',
  )
})

/* --------------------------------- 真起子进程的探测（不联网：打到本机 127.0.0.1 的测试服务） */

test('the probe runs a REAL child node: the script parses, the URL rides argv[1], and the cause comes back', async () => {
  const { startServer } = await import('./helpers.mjs')
  // 只测"拒连"这一支，且这是刻意的：`probeWithBundle` 用的是 spawnSync，会阻塞本进程的
  // 事件循环，所以**在本进程里起的测试服务不可能应答它**（第一版就是这么写的，结果 30s 超时
  // 被读成"探测失败"）。200/404 两支的分支映射由上面注入 run 的用例负责；这里要证明的是
  // 那串 `-e` 脚本本身能跑、URL 真的走 argv、失败原因真由 node 自己报出来。
  const dead = await startServer({})
  const deadPort = dead.port
  await dead.close()
  const refused = probeWithBundle({ bundlePath: '/etc/protocols', url: `http://127.0.0.1:${deadPort}/x` })
  assert.equal(refused.kind, 'transport', JSON.stringify(refused))
  assert.match(refused.detail, /ECONNREFUSED|Connection refused|refused/i,
    '原因是子进程报的，不是我写死的一句猜测 —— 1.5.0 就是因为只有后者，一次 [object Object] 被记成了 TLS 事故')
  assert.notEqual(refused.detail, 'TLS or DNS refused the connection', '不许退回那句万能猜测')
})

/* ------------------------- node 对这个变量到底做什么（实测，不是文案里的假设） */

/**
 * 这一组是**测 node**，不是测我们的代码，因为整套 §9 的判断理由此前写在注释里而没人验过：
 * 1.5.1 之前的说法是"一份空束会让 node 在启动期报错，所以比不带这个键更糟"——那句话是编的。
 * 实测（本机 node v26.4.0）：空文件与空值都能正常启动、正常建 TLS 上下文；文件不存在时只往
 * stderr 打一行 `Warning: Ignoring extra certs`。所以判"0 张证书＝不可用"的真正理由是
 * **它什么都不加**：被拦截的机器上表现与没设一模一样，状态却会记成"束已导出"。
 *
 * 反过来说，这三条也是**能变红的控制**：node 哪天真的改成对空束硬失败，这里先红，
 * 那句理由也就重新变成真的——而不是靠注释流传。
 */
test('measured: node does NOT crash on an empty or missing NODE_EXTRA_CA_CERTS — the bundle is inert, not fatal', async () => {
  const { spawnSync } = await import('node:child_process')
  const { startServer } = await import('./helpers.mjs')
  const stateRoot = scratch('measured-')
  const dir = tempDir(`${TMP_PREFIX}ca-measured-out-`)
  try {
    fs.writeFileSync(path.join(stateRoot, CA_BUNDLE_NAME), '', { mode: 0o600 })
    const emptyBundle = path.join(stateRoot, CA_BUNDLE_NAME)
    const missingBundle = path.join(stateRoot, 'no-such-bundle.pem')

    const dead = await startServer({})
    const port = dead.port
    await dead.close()

    const script = 'const t=require("node:tls");t.connect({host:"127.0.0.1",port:Number(process.argv[1])},'
      + '()=>{process.stdout.write("CONNECTED");process.exit(3)},)'
      + '.on("error",e=>{process.stdout.write("CONTEXT-BUILT:"+String(e.code));process.exit(0)});'
      + 'setTimeout(()=>{process.stdout.write("HUNG");process.exit(4)},8000)'

    const run = (value) => spawnSync(process.execPath, ['-e', script, String(port)], {
      encoding: 'utf8',
      timeout: 20_000,
      env: value === undefined ? (() => { const e = { ...process.env }; delete e[CA_ENV_VAR]; return e })()
        : { ...process.env, [CA_ENV_VAR]: value },
    })

    for (const [label, value, expectWarning] of [
      ['empty file', emptyBundle, false],
      ['missing file', missingBundle, true],
      ['empty string value', '', false],
      ['unset', undefined, false],
    ]) {
      const res = run(value)
      const err = String(res.stderr ?? '')
      assert.equal(res.signal, null, `${label}: 子进程是被信号打死的（${String(res.signal)}），那不是"正常启动"`)
      assert.match(String(res.stdout ?? ''), /^CONTEXT-BUILT:/,
        `${label}: node 建起了 TLS 上下文并走到连接这一步。它若因为这份束在启动期硬失败，stdout 就不会是这句话`)
      assert.equal(res.status, 0, `${label}: node 带着这份${label}正常退出（不是非零）— stderr:\n${err}`)
      assert.doesNotMatch(err, /ERR_INVALID_ARG_VALUE|FATAL|Cannot find module/, `${label}: 出现了启动期错误：${err}`)
      if (expectWarning) {
        assert.match(err, /Ignoring extra certs/, '文件不存在时 node 会自己说一声——但我们不靠它说，usableBundle 按内容先拒')
      } else {
        assert.doesNotMatch(err, /Ignoring extra certs/,
          `${label} 不该让 node 抱怨：空文件读得动、空值等于没设，这正是"它静默什么都不加"的形状`)
      }
    }
  } finally {
    removeDir(stateRoot)
    removeDir(dir)
  }
})


/* ---------------------------- 文案里不许留模板占位符（人读不出该替换成什么） */

test('no user-visible CA sentence carries a <placeholder> or an internal variable name', () => {
  const shapes = [null, ...CA_STATUSES.map((status) => ({
    status, certs: status === 'ok' ? 163 : 0, path: '/Users/someone/.glasspane/ca-roots.pem', exportedAt: 'now', detail: 'x',
  })), { status: 'looks-fine', certs: 0, path: null, exportedAt: 'now', detail: null }]
  for (const record of shapes) {
    const { summary, remedy } = describeCa(record, { bundlePath: '/Users/someone/.glasspane/ca-roots.pem' })
    const text = `${summary} ${remedy ?? ''}`
    assert.doesNotMatch(text, /<[a-z\u4e00-\u9fff][^>]*>/i, `占位符留在了给人看的句子里：${text}`)
    // 反的是"尖括号模板"，不是"提到某个真存在的字段名"：
    // `updater status --json` 的 stateRoot 字段是人下一步要读的东西，写出来是线索不是黑话。
    if (record === null) {
      // 记录缺失时给的是"重跑安装器 / updater enable"，那条路要能落到具体文件上。
      assert.match(text, /ca-roots\.pem/, `没导出过的那句要点名要写哪个文件：${text}`)
      assert.match(text, /\/Users\/someone\/\.glasspane\/ca-roots\.pem/, '能拿到真路径就把真路径写进去')
    }
  }
})

test('the TLS remedy names a real path when we have one, and a real place to look when we do not', async () => {
  const { describeTransportFailure } = await import('../lib/source.js')
  const err = Object.assign(new Error('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'self-signed' } })
  const withPath = describeTransportFailure('https://api.github.com/x', err, { caBundlePath: '/Users/someone/.glasspane/ca-roots.pem' })
  assert.equal(withPath.tlsVerification, true)
  assert.match(withPath.details, /NODE_EXTRA_CA_CERTS=\/Users\/someone\/\.glasspane\/ca-roots\.pem/, '有路径就写路径')
  assert.doesNotMatch(withPath.details, /<[a-z][^>]*>/i, `命令里有尖括号模板就没法原样执行：${withPath.details}`)
  const without = describeTransportFailure('https://api.github.com/x', err, {})
  assert.doesNotMatch(`${without.message} ${without.details}`, /<[a-z][^>]*>/i, `没路径时也不能留模板：${without.details}`)
  assert.match(without.details, /ca-roots\.pem/, '总得说出那个文件叫什么')
})
