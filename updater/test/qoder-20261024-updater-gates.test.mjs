/**
 * 2026-10-24 无人值守 · updater 泳道的**真报文**闸（C5 / C6 / C7 / C10 / C11）。
 *
 * 为什么另起一份（不是把 lane 那份抄一遍）：同泳道的 `qoder-20261024-updater-lane.test.mjs`
 * 已经把四条各写成用例并且 10/10 绿，但它的夹具形状是**手打**的——归档出自本仓自己的
 * `packTarGz`、`Info.plist` 是模板字符串里的三行 XML、`run` 是对任何 argv 都回同一份读数的桩。
 * 这四条要拦的恰恰是"读数形状对不对"，所以这一份只认真产物：
 *
 *   · tar：`/usr/bin/tar`（本机 bsdtar 3.5.3，`--format pax`，`COPYFILE_DISABLE=1`）真跑出来的
 *     归档，含真 pax 扩展头（`path=`/`mtime=`/`ctime=`/`atime=`/xattr 记录）与真 link 条目
 *     （typeflag `2` 与 `1`，后者由盘上真硬链产出）。要造 `mode=` 记录时，只在真归档里追加那一条
 *     记录并重算长度前缀与头校验和，其余字节逐字不动。
 *   · launchd：`defaultRun` 驱动**真子进程**拿到的形状——自杀于 SIGTERM 的孩子（`status:null` +
 *     signal + 空 stderr）、ENOENT、真 `/bin/launchctl print` 报的 113 + "Could not find service"。
 *     "作业在跑"那一份正文是从真机截的（与 `launchd.test.mjs` 里 2026-09-30 逐字截取的那段同形）。
 *   · Info.plist：`/usr/bin/plutil -create xml1` + `-insert CFBundleShortVersionString -string`
 *     真写出来的字节（含 DOCTYPE 与 Tab 缩进），再用**默认** readFile（真 fs）读。
 *   · 桩：一律按 argv 分发；答不上的 argv 回一个真孩子真给过的"没答话"形状。一个对什么都答话的桩
 *     等于给不存在的能力作背书（本仓 `helpers.mjs` 的 `makeDaemonBinary` 注释记的就是这笔账）。
 *
 * 每条用例的 REVERSE 行写的是：把源文件哪一行改回去，这一条就红。
 * 不调真 launchctl 的写操作、不碰网络（C5 端到端那条把 fetch 也记了账）、不写 ~/.glasspane。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'

import * as LAUNCHD from '../lib/launchd.js'
import { AGENT_LABEL, DAEMON_JOB_LABEL } from '../lib/launchd.js'
import { CODES, EXIT } from '../lib/codes.js'
import { applyUpdate } from '../lib/apply.js'
import { ARCHIVE_FILE_NAME } from '../lib/staging.js'
import { UpdaterError, writableRoots } from '../lib/fsutil.js'
import { probeIdle } from '../lib/idle.js'
import { decideSwapPermission } from '../lib/policy.js'
import { extractTarGz, packTarGz, readTarGz } from '../lib/tar.js'
import { sha256Bytes } from '../lib/digest.js'
import { emptyState, loadState, nextState, saveState } from '../lib/state.js'
import { bundleVersionReading, localVersion, readBundleVersion } from '../lib/version.js'
import { SUBCOMMANDS, runCommand } from '../cli.js'
import { makeDaemonBinary, removeDir, shortSocketPath, startSocketDaemon, tempDir, TMP_PREFIX } from './helpers.mjs'
import { formatMode as installerFormatMode, parseArgs as parseInstallerArgs } from '../../installer/cli.js'

const BLOCK = 512
const HAS_PLUTIL = fs.existsSync('/usr/bin/plutil')
const HAS_TAR = fs.existsSync('/usr/bin/tar')
const HAS_LAUNCHCTL = fs.existsSync('/bin/launchctl')
const NOW = new Date('2026-10-24T09:00:00.000Z')

/* --------------------------------------------------------------- fixtures */

/** `/usr/bin/plutil` 真写的一份 Info.plist 的字节——不是模板字符串。 */
function realInfoPlistBytes(value, { binary = false } = {}) {
  const dir = fs.mkdtempSync(`${TMP_PREFIX}plist-`)
  const file = path.join(dir, 'Info.plist')
  const created = spawnSync('/usr/bin/plutil', ['-create', binary ? 'binary1' : 'xml1', file], { encoding: 'utf8' })
  assert.equal(created.status, 0, `plutil -create 都没成：${created.stderr}`)
  // 这一版 plutil 一次只认一条 `-insert`，所以逐个键来。
  for (const [key, value] of [
    ['CFBundleIdentifier', 'com.glasspane.daemon'],
    ['CFBundleName', 'GlassPane Daemon'],
    ['CFBundleExecutable', 'glasspaned'],
  ]) {
    const seeded = spawnSync('/usr/bin/plutil', ['-insert', key, '-string', value, file], { encoding: 'utf8' })
    assert.equal(seeded.status, 0, `plutil 种 ${key} 没成：${seeded.stderr}`)
  }
  const inserted = spawnSync('/usr/bin/plutil', ['-insert', 'CFBundleShortVersionString', '-string', String(value), file], { encoding: 'utf8' })
  assert.equal(inserted.status, 0, `plutil 写 CFBundleShortVersionString 没成：${inserted.stderr}`)
  const bytes = fs.readFileSync(file)
  fs.rmSync(dir, { recursive: true, force: true })
  return bytes
}

/** 一个真 .app：真 plist 字节 + 真 MacOS 目录，落在 appsDir 下。 */
function installRealApp(appsDir, name, value, { binary = false } = {}) {
  const root = path.join(appsDir, name)
  fs.mkdirSync(path.join(root, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(root, 'Contents', 'Info.plist'), realInfoPlistBytes(value, { binary }))
  fs.writeFileSync(path.join(root, 'Contents', 'MacOS', 'binary'), 'installed bytes')
  return root
}

/** `/usr/bin/tar` 真跑一次，返回归档字节（不是 packTarGz 那份自造字节）。 */
function realTar(cwd, members, { format = 'pax' } = {}) {
  const out = path.join(cwd, `out-${Math.random().toString(36).slice(2)}.tar`)
  const res = spawnSync('/usr/bin/tar', ['-cf', out, '--format', format, ...members], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const bytes = fs.existsSync(out) ? fs.readFileSync(out) : null
  fs.rmSync(out, { force: true })
  assert.equal(res.status, 0, `真 tar 没跑成：${res.stderr}`)
  assert.ok(bytes && bytes.length >= BLOCK * 2, '真 tar 产出是空的，这条夹具就没资格当基准')
  return bytes
}

const gz = (tarBytes) => zlib.gzipSync(Buffer.isBuffer(tarBytes) ? tarBytes : Buffer.from(tarBytes))

/** pax 记录 `<len> <key>=<value>\n`，`len` 数到自己且含末尾换行——长度是个不动点。 */
function paxRecord(key, value) {
  const body = `${key}=${value}\n`
  let len = body.length + 3
  for (;;) {
    const candidate = String(len).length + 1 + body.length
    if (candidate === len) return `${len} ${key}=${value}\n`
    len = candidate
  }
}

function recomputeHeader(block, size) {
  block.write(size.toString(8).padStart(11, '0') + '\0', 124)
  block.write('        ', 148)
  let sum = 0
  for (let i = 0; i < BLOCK; i += 1) sum += block[i]
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
}

/**
 * 在真归档里给 `memberName` 前面那条 pax 扩展头追加一条记录（其余字节逐字不动）。
 *
 * 本机 bsdtar 不把 `mode` 写进扩展头（它只在 ustar 字段里放模式），而 POSIX pax 定义了这个关键字，
 * `git archive`/`star`/Go 的 `archive/tar` 都会写。所以这一条是"真归档 + 真记录框"，不是想象出来的字节。
 */
function withPaxRecord(tarBytes, memberName, record) {
  const tar = Buffer.from(tarBytes)
  let offset = 0
  let pending = null
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK)
    if (block.every((byte) => byte === 0)) { offset += BLOCK; continue }
    const size = Number.parseInt(block.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*/, '').trim() || '0', 8)
    const typeFlag = String.fromCharCode(block[156] || 0x30)
    const name = block.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*/, '')
    if (typeFlag === 'x') {
      pending = { headerStart: offset, size }
    } else {
      if (pending && name === memberName) {
        const payloadStart = pending.headerStart + BLOCK
        const old = tar.subarray(payloadStart, payloadStart + pending.size).toString('utf8')
        const next = Buffer.from(old + record, 'utf8')
        assert.ok(next.length <= BLOCK, '真归档这一条扩展头所在的 512 块装不下追加的记录')
        next.copy(tar, payloadStart)
        tar.fill(0, payloadStart + next.length, payloadStart + BLOCK)
        recomputeHeader(tar.subarray(pending.headerStart, pending.headerStart + BLOCK), next.length)
        return tar
      }
      pending = null
    }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  throw new Error(`真归档里没找到 ${JSON.stringify(memberName)} 前面的 pax 扩展头`)
}

/** 真 `stat -f %Lp` 的读数——拒绝里那个数要能和它对上。 */
function statLp(file) {
  const res = spawnSync('/usr/bin/stat', ['-f', '%Lp', file], { encoding: 'utf8' })
  assert.equal(res.status, 0, `真 stat 没跑成：${res.stderr}`)
  return res.stdout.trim()
}

/**
 * `defaultRun` 从**真孩子**拿到的"没答话"读数：一个在写下任何东西之前就把自己杀掉的 sh。
 * 桩答不上的 argv 就回这一份——它是本机实测形状，不是手写的乐观值。
 */
const REAL_NO_ANSWER = LAUNCHD.defaultRun('/bin/sh', ['-c', 'kill -TERM $$'])

/** 按 argv 分发的 launchctl 桩：只答被真问到的那一条。 */
function launchctlStub({ uid, label, reply, calls = [] }) {
  const run = (bin, args) => {
    calls.push([bin, ...args])
    if (bin === 'id' && args.length === 1 && args[0] === '-u') {
      return { status: 0, answered: true, stdout: `${uid}\n`, stderr: '', error: null, signal: null }
    }
    if (bin === 'launchctl' && args[0] === 'print' && args[1] === `gui/${uid}/${label}`) return reply
    return REAL_NO_ANSWER
  }
  return { run, calls }
}

/** 真机截的 `launchctl print` 正文（`launchd.test.mjs` 那段同形：参数一行一个、不加引号、Tab 缩进）。 */
const PRINT_DAEMON = [
  `gui/501/${DAEMON_JOB_LABEL} = {`,
  '\tactive count = 1',
  '\tpath = /Users/dev/Library/LaunchAgents/com.glasspane.daemon.plist',
  '\ttype = LaunchAgent',
  '\tstate = running',
  '\tprogram = /Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned',
  '\targuments = {',
  '\t\t/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned',
  '\t\t--socket-path',
  '\t\t/Users/dev/.glasspane/engine.sock',
  '\t}',
  '\tstdout path = /Users/dev/.glasspane/daemon.log',
  '}',
].join('\n')

/* ------------------------------------------------------------------ C5 */

test('C5 plutil 真写的 Info.plist：读得出的读出来，读不出的回 null，一条都不抛', (t) => {
  if (!HAS_PLUTIL) return t.skip('这一条读的是 /usr/bin/plutil 真写出的字节')
  // REVERSE: `lib/version.js:112-115` 的 `PLAIN_SEMVER_RE.exec(raw)` 换回
  // `return parsePlainVersion(match[1]).version` → 下面 `1.20`/`1.20.1-beta`/空串三次 doesNotThrow
  // 全红（throw 逃到读数层），`state === 'unreadable'` 也红。
  const dir = tempDir(`${TMP_PREFIX}c5-plutil-`)
  try {
    const good = installRealApp(dir, 'GlassPane Daemon.app', '1.20.1')
    assert.equal(readBundleVersion(good), '1.20.1', '真 plist 的默认读法（真 fs，不注入）必须取到版本')
    assert.equal(bundleVersionReading(good).state, 'ok')

    for (const value of ['1.20', '1.20.1-beta', '', 'unreleased']) {
      const app = installRealApp(dir, `Half-${value.replace(/[^\w.]/g, '_')}.app`, value)
      assert.doesNotThrow(() => readBundleVersion(app), `半装的机器不该把整条命令炸掉（${JSON.stringify(value)}）`)
      const reading = bundleVersionReading(app)
      assert.equal(reading.value, null, `${JSON.stringify(value)} 不是读数：${JSON.stringify(reading)}`)
      assert.equal(reading.state, 'unreadable', `${JSON.stringify(value)} 该记成"present but unreadable"：${JSON.stringify(reading)}`)
      assert.equal(reading.raw, String(value).trim())
    }

    // 键不在（真 binary plist：这份正则读不到，但它**不该**被说成"读出来是坏的"）。
    const binaryApp = installRealApp(dir, 'Binary.app', '1.20.1', { binary: true })
    const binaryReading = bundleVersionReading(binaryApp)
    assert.equal(binaryReading.state, 'no-key', JSON.stringify(binaryReading))
    assert.equal(binaryReading.value, null)
  } finally {
    removeDir(dir)
  }
})

test('C5 真半装机走 runCommand("check")：拒绝是数据、退 3、并且进状态文件（面板读的那一份）', async (t) => {
  if (!HAS_PLUTIL) return t.skip('这一条读的是 /usr/bin/plutil 真写出的字节')
  // REVERSE: `cli.js:418` 的 `const local = readLocal()` 换回 `merged.readLocal()`，再把
  // `lib/version.js:112` 换回 `parsePlainVersion(match[1]).version` → 这条以 throw 结束，
  // 断不到 outcome，更断不到 `state.lastError`。
  const dir = tempDir(`${TMP_PREFIX}c5-machine-`)
  const sink = { lines: [], write(line) { this.lines.push(line); return true } }
  const fetchCalls = []
  try {
    const appsDir = path.join(dir, 'Applications')
    const stateRoot = path.join(dir, '.glasspane')
    fs.mkdirSync(stateRoot, { recursive: true })
    installRealApp(appsDir, 'GlassPane Daemon.app', '1.20')
    installRealApp(appsDir, 'GlassPane.app', '1.20.1')
    const daemonBin = makeDaemonBinary(appsDir, '1.20.1')

    const verdict = localVersion({
      appsDir,
      daemonExecutable: daemonBin,
      settingsAppName: 'GlassPane.app',
      daemonAppName: 'GlassPane Daemon.app',
    })
    assert.equal(verdict.ok, false)
    assert.match(verdict.message, /GlassPane Daemon\.app reports "1\.20"/, verdict.message)
    assert.match(verdict.message, /installer/i, verdict.message)

    const outcome = await runCommand({
      command: 'check',
      flags: { 'state-dir': stateRoot, 'apps-dir': appsDir, json: true },
      env: {},
      stderr: sink,
      deps: {
        homeDir: dir,
        // 本地这道门没答话之前，这一轮不该碰网络：碰了就红（这条 fetch 会把句子换成网络句子）。
        fetchJson: (...args) => { fetchCalls.push(args); throw new Error('runCommand 在本地读数之前就取了网络') },
        fetchBytes: (...args) => { fetchCalls.push(args); throw new Error('runCommand 在本地读数之前就取了网络') },
      },
    })
    assert.equal(fetchCalls.length, 0, '半装的机器上一条 fetch 都不许发出去')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.exitCode, EXIT.REFUSED)
    assert.equal(outcome.code, CODES.versionMismatchLocal)
    const { state } = loadState(stateRoot)
    assert.ok(state?.lastError, `拒绝没写进状态，面板与 gp_diagnose 就读不到理由：${JSON.stringify(state)}`)
    assert.match(state.lastError.message, /reports "1\.20"/, state.lastError.message)
    assert.match(state.lastError.message, /installer/i, state.lastError.message)
  } finally {
    removeDir(dir)
  }
})

test('C5 第二个读数者抛出来/答成空：runCommand 仍旧只回一条 refusal，并把这句写进状态文件', async () => {
  // REVERSE: `cli.js:418` 的 `const local = readLocal()` 换回 `merged.readLocal()` → 两条子用例都
  // 以 throw 结束（这一条就是"那个没有 try 的缝"）；把 `cli.js:369` 的
  // `if (!reading || typeof reading !== "object")` 放宽成 `if (reading && typeof reading !== "object")`
  // → "答成空"那一半红（undefined 被当成了一个读数，runCheck 随后拿它当版本）。
  for (const shape of ['throws', 'nothing']) {
    const dir = tempDir(`${TMP_PREFIX}c5-second-reader-${shape}-`)
    const sink = { lines: [], write(line) { this.lines.push(line); return true } }
    try {
      const stateRoot = path.join(dir, '.glasspane')
      fs.mkdirSync(stateRoot, { recursive: true })
      const outcome = await runCommand({
        command: 'check',
        flags: { 'state-dir': stateRoot, json: true },
        env: {},
        stderr: sink,
        deps: {
          homeDir: dir,
          readLocal: shape === 'throws'
            ? () => { throw new UpdaterError(CODES.versionMismatchLocal, 'the installer pointer file names 1.20 and the bundle names nothing') }
            : () => undefined,
          fetchJson: () => { throw new Error('读数者没答话之前不许取网络') },
          fetchBytes: () => { throw new Error('读数者没答话之前不许取网络') },
        },
      })
      assert.equal(outcome.ok, false, `${shape}: 读数失败必须是数据，不是崩溃`)
      assert.equal(outcome.exitCode, EXIT.REFUSED, JSON.stringify(outcome))
      assert.equal(outcome.code, CODES.versionMismatchLocal, JSON.stringify(outcome))
      const { state } = loadState(stateRoot)
      assert.ok(state?.lastError, `${shape}: 拒绝没落进状态，面板与 gp_diagnose 读不到理由`)
      if (shape === 'throws') assert.match(state.lastError.message, /installer pointer file names 1\.20/, state.lastError.message)
      else assert.match(state.lastError.message, /came back as nothing at all/, state.lastError.message)
      assert.match(state.lastError.message, /installer|updater check/i, `拒绝要给下一步：${state.lastError.message}`)
      assert.ok(sink.lines.join('\n').includes(state.lastError.message.slice(0, 40)), 'stderr 上那句和落盘那句是同一句')
    } finally {
      removeDir(dir)
    }
  }
})

/* ------------------------------------------------------------------ C6 */

test('C6 真孩子的三种形状：defaultRun 说"没答话"就是没答话，不折成退出码', () => {
  // REVERSE: `lib/launchd.js:232` 的 `answered: status !== null` 换回旧 `status: res.status ?? 1`
  // 那一档（并把 226 行的 `typeof res?.status === 'number' ? res.status : null` 写成 `res.status ?? 1`）
  // → 前两条断言红：SIGTERM 与 ENOENT 的孩子都被报成退出码 1。
  assert.equal(REAL_NO_ANSWER.status, null, JSON.stringify(REAL_NO_ANSWER))
  assert.equal(REAL_NO_ANSWER.answered, false, '真被信号打死的孩子没答话：' + JSON.stringify(REAL_NO_ANSWER))
  assert.equal(REAL_NO_ANSWER.signal, 'SIGTERM')

  const enoent = LAUNCHD.defaultRun('/nonexistent-dir/launchctl', ['print', 'gui/501/x'])
  assert.equal(enoent.answered, false, JSON.stringify(enoent))
  assert.match(enoent.stderr, /ENOENT/, `stderr 空档里必须留住 error 原话：${JSON.stringify(enoent)}`)

  const answered = LAUNCHD.defaultRun('/bin/sh', ['-c', 'echo out; echo err >&2; exit 113'])
  assert.equal(answered.answered, true, JSON.stringify(answered))
  assert.equal(answered.status, 113)
  assert.equal(answered.stdout.trim(), 'out')
  assert.equal(answered.stderr.trim(), 'err')
  assert.equal(answered.error, null, '答了话的孩子不该有 error')

  const ok = LAUNCHD.defaultRun('/usr/bin/true', [])
  assert.equal(ok.answered, true)
  assert.equal(ok.status, 0)
})

test('C6 真 launchctl 报 113 + "Could not find service" = absent；真 SIGTERM 孩子 = unverified，两种都不是"作业未加载"那句', (t) => {
  if (!HAS_LAUNCHCTL) return t.skip('这一条读的是本机 /bin/launchctl 的真回答')
  const uid = String(LAUNCHD.defaultRun('id', ['-u']).stdout).trim()
  if (!/^\d+$/.test(uid)) return t.skip('这台机器上 `id -u` 没给出数字，取不到域')
  const label = 'com.glasspane.qoder20261024-absent-probe'
  const real = LAUNCHD.defaultRun('/bin/launchctl', ['print', `gui/${uid}/${label}`])
  if (real.answered !== true) return t.skip(`launchctl 在这台机器上没答话：${JSON.stringify(real)}`)

  // REVERSE: `lib/launchd.js:293` 的 `const absent = …` 写成 `const absent = false`，或把 282/296 行
  // 的 `read: JOB_READS.unverified/absent` 抹掉 → 下面按真 stderr 分档的两条断言红；
  // 把 `launchctlSaysNoSuchService` 的正则删掉 → absent 那一条红。
  const { run, calls } = launchctlStub({ uid, label, reply: real })
  const job = LAUNCHD.readRunningJob({ uid, label, run })
  assert.deepEqual(calls, [['launchctl', 'print', `gui/${uid}/${label}`]], '只许问这一条 argv')
  assert.notEqual(job.read, LAUNCHD.JOB_READS.available, JSON.stringify(job))
  assert.notEqual(job.loaded, true, '没读到的东西不许报成在跑')
  if (/could not find service/i.test(real.stderr)) {
    assert.equal(job.read, LAUNCHD.JOB_READS.absent, `launchd 自己说没这个服务：${JSON.stringify(job)}`)
    assert.equal(job.loaded, false)
    assert.ok(job.reason.includes(real.stderr.trim().slice(0, 30)), `拒绝里要有机器的原话：${job.reason}`)
    assert.match(job.reason, /--restore-launchd|GlassPane installer/, `absent 要给得出下一步：${job.reason}`)
  } else {
    assert.equal(job.read, LAUNCHD.JOB_READS.unverified, JSON.stringify(job))
    assert.match(job.reason, /not an answer this tool can read|did not observe|was \*\*not\*\* observed/i, job.reason)
  }

  const wrongDomain = launchctlStub({ uid: '502', label: DAEMON_JOB_LABEL, reply: real })
  const blind = LAUNCHD.readRunningJob({ uid, label: DAEMON_JOB_LABEL, run: wrongDomain.run })
  assert.equal(blind.read, LAUNCHD.JOB_READS.unverified, '问错了域 = 这一问没人答，不是"作业没加载"')
  assert.deepEqual(wrongDomain.calls, [['launchctl', 'print', `gui/${uid}/${DAEMON_JOB_LABEL}`]], '问的必须是本机的域')
  assert.doesNotMatch(blind.reason, /is not loaded/, `把未观测写成未加载：${blind.reason}`)
  assert.match(blind.reason, /did not answer/, blind.reason)
  assert.match(blind.reason, /launchctl print gui\/\$\(id -u\)\/com\.glasspane\.daemon/, `未答话的拒绝要给一条真能跑的动作：${blind.reason}`)

  // 同一条拒绝里那句"下一步"必须点名**被问的那个作业**。这一支从前把 `com.glasspane.daemon`
  // 写死在文案里，而上面一句用的是 `${label}`：问的是别的作业时，给出的命令读的是另一个作业
  // ——照做的人以为自己核对过了，其实一眼没看到被问的那一个。
  // REVERSE: 把 `lib/launchd.js` 那句换回写死的 `com.glasspane.daemon`，下面两条红。
  const otherLabel = 'com.glasspane.updater-agent'
  const silent = LAUNCHD.readRunningJob({
    uid: '501',
    label: otherLabel,
    run: () => ({ answered: false, status: null, stdout: '', stderr: '', error: null, signal: null }),
  })
  assert.equal(silent.read, LAUNCHD.JOB_READS.unverified, JSON.stringify(silent))
  assert.ok(silent.reason.includes(otherLabel), `未答话的下一步要点名被问的作业：${silent.reason}`)
  assert.doesNotMatch(silent.reason, /gui\/\$\(id -u\)\/com\.glasspane\.daemon/, `不许把人支去读另一个作业：${silent.reason}`)
})

test('C6 只有被问到的那条 argv 才答话：读回来的作业认得出程序与状态，问错了域就什么都读不到', () => {
  // REVERSE: 把 `lib/launchd.js` 里可读回的 `read: JOB_READS.available`（成功那一支）删掉，
  // 下面 `job.read === available` 红；把 `parseArgumentsBlock` 的调用换成 `args = []`，
  // `job.args` 那一条红。
  const reply = { status: 0, answered: true, stdout: PRINT_DAEMON, stderr: '', error: null, signal: null }
  const daemon = launchctlStub({ uid: '501', label: DAEMON_JOB_LABEL, reply })
  const job = LAUNCHD.readRunningJob({ uid: '501', run: daemon.run })
  assert.equal(job.ok, true, job.reason)
  assert.equal(job.read, LAUNCHD.JOB_READS.available, JSON.stringify(job))
  assert.equal(job.loaded, true)
  assert.equal(job.program, '/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned')
  assert.equal(job.jobState, 'running')
  assert.deepEqual(job.args.slice(-2), ['--socket-path', '/Users/dev/.glasspane/engine.sock'])

  // 桩只被教会答**另一个作业**（每日代理那一条）：问 daemon 作业它就是没答话。
  const stale = launchctlStub({ uid: '501', label: AGENT_LABEL, reply })
  const wrong = LAUNCHD.readRunningJob({ uid: '501', label: DAEMON_JOB_LABEL, run: stale.run })
  assert.equal(wrong.read, LAUNCHD.JOB_READS.unverified, '桩答不上这一问就必须是 unverified，不是"未加载"')
  assert.deepEqual(stale.calls, [['launchctl', 'print', `gui/501/${DAEMON_JOB_LABEL}`]])
})

/* ------------------------------------------------------------------ C11 */

test('C11 拒绝里那个数与真 stat -f %Lp 一字不差；chmod 真留住时走成功那一支', (t) => {
  if (!fs.existsSync('/usr/bin/stat')) return t.skip('这一条拿真 stat 的读数当基准')
  // REVERSE: `lib/launchd.js:505` 的 `${formatMode(mode)}` 换回 `${(mode & 0o777).toString(8)}`，
  // 并把 211 行的 `padStart(3, '0')` 去掉 → 0o040 那一档红（旧写法给 "40"，机器给 "040"），
  // 那句 `still 0644` 也红。
  const dir = tempDir(`${TMP_PREFIX}c11-`)
  try {
    for (const mode of [0o644, 0o600, 0o040, 0o755, 0o777]) {
      const file = path.join(dir, `f-${mode.toString(8)}`)
      fs.writeFileSync(file, 'x')
      fs.chmodSync(file, mode)
      const machine = statLp(file)
      assert.equal(LAUNCHD.formatMode(fs.statSync(file).mode), `0${machine.padStart(3, '0')}`,
        `拒绝里的读数要和 stat -f %Lp 对得上（0o${mode.toString(8)}）`)
      assert.match(LAUNCHD.formatMode(mode), /^0[0-7]{3}$/, `固定宽度：${LAUNCHD.formatMode(mode)}`)
      assert.equal(Number.parseInt(LAUNCHD.formatMode(mode), 8), mode & 0o777)
      assert.equal(LAUNCHD.formatMode(mode), installerFormatMode(mode), `两套读数（0o${mode.toString(8)}）`)
    }

    // 一份真 0644 的文件，chmod 不留住（= 这条分支存在的全部理由：不持权限位的卷）。
    const loose = path.join(dir, 'update.log')
    fs.writeFileSync(loose, '', { mode: 0o644 })
    const refused = LAUNCHD.preparePrivateLogFile(loose, { chmod: () => {} })
    assert.equal(refused.ok, false, JSON.stringify(refused))
    const quoted = /still (\d{4}) after chmod/.exec(refused.error)
    assert.ok(quoted, `拒绝必须点名那个数：${refused.error}`)
    assert.equal(quoted[1], `0${statLp(loose).padStart(3, '0')}`, '句子里那个数就是机器自己报的数')

    // 真卷上 chmod 留得住 → 成功那一支，同样用真读数收口。
    const tight = path.join(dir, 'real.log')
    fs.writeFileSync(tight, '', { mode: 0o644 })
    const prepared = LAUNCHD.preparePrivateLogFile(tight)
    assert.equal(prepared.ok, true, prepared.error)
    assert.equal(statLp(tight), '600', '真 chmod(0600) 之后 stat 该报 600')
  } finally {
    removeDir(dir)
  }
})

/* ------------------------------------------------------------------ C7 */

test('C7 真 unix socket 上"连上不答话"：句子只带量到的那两个数，且点名的补救命令真存在', async () => {
  // REVERSE: `lib/idle.js:122` 的 reason 换回旧句 `…within ${timeoutMs}ms, so something is queued in front of it`
  // → doesNotMatch(/so something is queued/) 红，且 /--restore-launchd/ 那条（旧句没有任何下一步）红。
  const dir = tempDir(`${TMP_PREFIX}c7-`)
  const probeMs = 750
  try {
    const socketPath = shortSocketPath(dir, 'silent.sock')
    const daemon = await startSocketDaemon(socketPath, { behaviour: 'silence' })
    try {
      const verdict = await probeIdle({ socketPath, timeoutMs: probeMs })
      assert.equal(verdict.answered, false)
      assert.equal(verdict.mayRestart, false, '未答话永远不是"可以重启"')
      assert.match(verdict.reason, new RegExp(`within ${probeMs}ms`), verdict.reason)
      assert.ok(verdict.reason.includes(socketPath), `量到的那个 socket 名要在句子里：${verdict.reason}`)
      assert.doesNotMatch(verdict.reason, /so something is queued/, '未量到的归因不许写成结论')
      assert.match(verdict.reason, /cannot tell apart/, verdict.reason)
      assert.match(verdict.reason, /launchctl print gui\/\$\(id -u\)\/com\.glasspane\.daemon/, verdict.reason)
      assert.match(verdict.reason, /--restore-launchd/, verdict.reason)
      assert.deepEqual(daemon.requests.length, 1, '请求确实送到了监听者手里')

      // 拒绝点名的补救命令必须真存在，否则这就是给不存在的能力作背书。
      const installer = parseInstallerArgs(['--restore-launchd'])
      assert.equal(installer.error, null, 'installer 认不认这个旗标')
      assert.equal(installer.options.restoreLaunchd, true)
      assert.ok(SUBCOMMANDS.includes('status'), '"updater status --json" 得是真命令')
      const escalation = [/\bsudo\b/, /--no-verify|--insecure/, /\b(chmod|chown)\s+-[a-zA-Z]*R\b/, /\b(curl|wget)[^|\n]*\|\s*(\/bin\/)?(ba)?sh\b/]
      for (const re of escalation) assert.doesNotMatch(verdict.reason, re, '补救不许是可照着执行的升权命令')
    } finally {
      await daemon.close()
    }
  } finally {
    removeDir(dir)
  }
})

test('C7 三种探活失败各说各的：没答话 / 没人听 / 提前关，句子不许共用一副骨架', async () => {
  // REVERSE: 把 `lib/idle.js:101`（`nothing is listening at …`）或 148 行（`closed before answering`）
  // 换回 122 行那条超时句 → 这三条对照红：一个只有"时间到了"才成立的说法被安在两件事上。
  const dir = tempDir(`${TMP_PREFIX}c7-contrast-`)
  try {
    const absentSocket = shortSocketPath(dir, 'nobody.sock')
    assert.equal(fs.existsSync(absentSocket), false, '夹具前提：这个名字上没有监听者')
    const absent = await probeIdle({ socketPath: absentSocket, timeoutMs: 200 })
    assert.equal(absent.answered, false)
    assert.match(absent.reason, /nothing is listening at/, absent.reason)
    assert.doesNotMatch(absent.reason, /within 200ms/, '没人听不是"等超时"')
    assert.equal(absent.mayRestart, false)

    const closing = shortSocketPath(dir, 'closing.sock')
    const daemon = await startSocketDaemon(closing, { behaviour: 'close' })
    let closed
    try {
      closed = await probeIdle({ socketPath: closing, timeoutMs: 5_000 })
    } finally {
      await daemon.close()
    }
    assert.equal(closed.answered, false)
    assert.match(closed.reason, /closed before answering/, closed.reason)
    assert.doesNotMatch(closed.reason, /within 5000ms/, '对上了话又关掉，不是没答话')
    assert.equal(closed.mayRestart, false)

    const answeredSocket = shortSocketPath(dir, 'answering.sock')
    const live = await startSocketDaemon(answeredSocket, { behaviour: 'answer' })
    let idle
    try {
      idle = await probeIdle({ socketPath: answeredSocket, timeoutMs: 200 })
    } finally {
      await live.close()
    }
    assert.equal(idle.answered, true, JSON.stringify(idle))
    assert.equal(idle.mayRestart, true)
  } finally {
    removeDir(dir)
  }
})

test('C7 deferred 那句经过真 apply 落进状态文件；三道门里这一道从此也带得上手的命令', async () => {
  // REVERSE: `lib/policy.js:107` 的 `reason: probe?.reason ?? '…'` 兜底句换回旧的
  // `'the daemon did not answer the idle probe'`，并把 `lib/idle.js:122` 换回旧句 →
  // 这里 /--restore-launchd/ 与 `lastError.message` 两条一起红。
  const dir = tempDir(`${TMP_PREFIX}c7-apply-`)
  try {
    const stateRoot = dir
    const appsDir = path.join(dir, 'Applications')
    fs.mkdirSync(appsDir, { recursive: true })
    const stagingDir = path.join(writableRoots(stateRoot).staging, '1.20.2')
    const treePath = path.join(stagingDir, 'tree')
    fs.mkdirSync(treePath, { recursive: true, mode: 0o700 })
    const treeFiles = [{ name: 'package.json', content: JSON.stringify({ version: '1.20.2' }) }]
    for (const file of treeFiles) fs.writeFileSync(path.join(treePath, file.name), file.content)
    // 归档字节不是这条用例判的东西（`verifyStagedBytes` 在探活门之后），probeIdle 才是。
    const archive = packTarGz(treeFiles)
    fs.writeFileSync(path.join(stagingDir, ARCHIVE_FILE_NAME), archive)
    saveState(stateRoot, nextState(emptyState({ now: NOW }), {
      status: 'staged',
      code: null,
      current: '1.20.1',
      latest: '1.20.2',
      lastCheckAt: NOW.toISOString(),
      staged: { version: '1.20.2', dir: stagingDir, digest: sha256Bytes(archive), at: NOW.toISOString() },
    }, { now: NOW }), { now: NOW })

    const socketPath = shortSocketPath(dir, 'wedged.sock')
    const daemon = await startSocketDaemon(socketPath, { behaviour: 'silence' })
    let result
    try {
      result = await applyUpdate({
        stateRoot,
        appsDir,
        now: NOW,
        trigger: 'manual',
        currentVersion: '1.20.1',
        socketPath,
        probe: { socketPath, timeoutMs: 200 },
        job: { unknown: false, loaded: true, args: ['/x/glasspaned', '--state-dir', stateRoot] },
      })
    } finally {
      await daemon.close()
    }
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.status, 'deferred')
    assert.equal(result.code, CODES.busyOrUnreachable)
    assert.match(result.message, /within 200ms/, result.message)
    assert.match(result.message, /--restore-launchd/, result.message)
    const { state } = loadState(stateRoot)
    assert.equal(state.lastError.message, result.message, '面板 print 的就是 lastError，闸门那句话必须原样落盘')
    assert.equal(state.lastError.code, CODES.busyOrUnreachable)
    assert.equal(result.rollback.performed, false, 'deferred 不该动过任何东西')
    assert.deepEqual(fs.readdirSync(appsDir), [], '一个 bundle 都不该被换过')
    assert.ok(fs.existsSync(path.join(treePath, 'package.json')), 'staged 树还在原地')
  } finally {
    removeDir(dir)
  }
})

test('C7 桩没带 reason 时，policy 那道门的兜底句也必须带命令、也不许编归因', () => {
  // REVERSE: `lib/policy.js:107-113` 换回 `reason: probe?.reason ?? 'the daemon did not answer the idle probe'`
  // → /cannot be distinguished|all look identical/ 与 /--restore-launchd/ 两条红。
  const decision = decideSwapPermission({
    probe: { answered: false, reason: null },
    jobArgs: ['/x/glasspaned', '--state-dir', '/Users/dev/.glasspane'],
    ourStateRoot: '/Users/dev/.glasspane',
  })
  assert.equal(decision.status, 'deferred')
  assert.doesNotMatch(decision.reason, /so something is queued/, decision.reason)
  assert.match(decision.reason, /look identical|cannot be told apart|all look the same/i, `未量到的归因要写成并列可能：${decision.reason}`)
  assert.match(decision.reason, /launchctl print|--restore-launchd|updater status/, `这道门从前什么都没给：${decision.reason}`)
  assert.equal(decision.swapped, false)
})

/* ------------------------------------------------------------------ C10 */

test('C10 真 bsdtar 的 pax 归档：扩展头不吃成员模式、link 落成字节、长路径不带控制字符', (t) => {
  if (!HAS_TAR) return t.skip('这一条读的是 /usr/bin/tar 真产出的归档')
  // REVERSE: `lib/tar.js:139` 的 `.replace(/\n$/, '')` 去掉 → 长名那一条红（名字带着尾随换行交到 fs 手里）；
  // 把 228-244 行的 link 分支换成"不支持即拒" → `early.png` 那两条红。
  const src = tempDir(`${TMP_PREFIX}c10-real-`)
  try {
    const longRel = path.join('GlassPane-1.4.0', 'very', 'long', 'path', 'that', 'goes', 'past',
      'one-hundred-bytes-in-total-because-bsdtar-only-writes-a-pax-path-record-when-the-name-does-not-fit.txt')
    const base = path.join(src, 'GlassPane-1.4.0')
    fs.mkdirSync(path.join(base, 'sub'), { recursive: true })
    fs.mkdirSync(path.join(src, longRel.split('/').slice(0, -1).join('/')), { recursive: true })
    fs.writeFileSync(path.join(src, longRel), 'LONGNAME')
    fs.writeFileSync(path.join(base, 'apple-touch-icon.png'), 'PNGBYTES')
    fs.chmodSync(path.join(base, 'apple-touch-icon.png'), 0o644)
    fs.writeFileSync(path.join(base, 'run.sh'), '#!/bin/sh\necho hi\n')
    fs.chmodSync(path.join(base, 'run.sh'), 0o755)
    fs.symlinkSync('../apple-touch-icon.png', path.join(base, 'sub', 'early.png'))
    const tar = realTar(src, ['GlassPane-1.4.0'])

    const entries = readTarGz(gz(tar))
    const names = entries.map((e) => e.name)
    assert.equal(names.filter((n) => n.includes('PaxHeader')).length, 0,
      `pax 扩展头是元数据不是文件：${JSON.stringify(names.filter((n) => n.includes('PaxHeader')))}`)
    for (const name of names) assert.doesNotMatch(name, /[\x00-\x1f]/, `名字里不许有控制字符：${JSON.stringify(name)}`)
    const long = entries.find((e) => e.name.endsWith('does-not-fit.txt'))
    assert.ok(long, `真归档用 pax 的 path= 记的长名要读得回来：${JSON.stringify(names)}`)
    assert.equal(long.bytes.toString('utf8'), 'LONGNAME')

    const dest = path.join(src, 'out')
    fs.mkdirSync(dest)
    const result = extractTarGz(gz(tar), path.join(dest, 'tree'), { allowedRoot: src })
    const tree = path.join(dest, 'tree')
    assert.equal(fs.existsSync(path.join(tree, 'GlassPane-1.4.0', 'PaxHeader')), false, '元数据不许变成文件落盘')
    assert.equal(fs.statSync(path.join(tree, 'GlassPane-1.4.0/run.sh')).mode & 0o777, 0o755,
      '真 pax 头里的 mtime/ctime/xattr 记录不许动成员模式')
    assert.equal(fs.statSync(path.join(tree, 'GlassPane-1.4.0/apple-touch-icon.png')).mode & 0o777, 0o644)
    const linkPath = path.join(tree, 'GlassPane-1.4.0/sub/early.png')
    assert.equal(fs.lstatSync(linkPath).isFile(), true, 'link 要落成字节，不许留任何间接')
    assert.equal(fs.readFileSync(linkPath, 'utf8'), 'PNGBYTES')
    assert.equal(fs.statSync(linkPath).mode & 0o777, 0o644, '落的是**目标**的模式，不是 link 那份 0777')
    assert.equal(fs.readFileSync(path.join(tree, long.name), 'utf8'), 'LONGNAME')
    assert.ok(result.written.length >= 4, JSON.stringify(result.written))
  } finally {
    removeDir(src)
  }
})

test('C10 真归档里补一条 pax mode= 记录：它覆盖成员头，setuid 与组/其他写位仍然剥掉', (t) => {
  if (!HAS_TAR) return t.skip('这一条改的是 /usr/bin/tar 真产出的归档')
  // REVERSE: 删掉 `lib/tar.js:219` 那行（`pendingMode` 恒为 null 的旧死分支）→ `mode 0755` 两条红
  // （成员头说的是 0644）；把 `lib/tar.js:157` 的 `/^[0-7]{1,7}$/` 放宽成 `/^[0-9]{1,7}$/` →
  // `mode=9999` 那一条红（不再拒，静默回退成成员模式）。
  const src = tempDir(`${TMP_PREFIX}c10-pax-`)
  try {
    fs.mkdirSync(path.join(src, 'GlassPane-1.4.0/sub'), { recursive: true })
    const member = path.join(src, 'GlassPane-1.4.0/sub/icon.png')
    fs.writeFileSync(member, 'BYTES')
    fs.chmodSync(member, 0o644)
    const tar = realTar(src, ['GlassPane-1.4.0/sub/icon.png'])
    assert.equal(readTarGz(gz(tar)).find((e) => e.name.endsWith('icon.png')).mode, 0o644, '夹具前提：成员头说的是 0644')

    const declared = gz(withPaxRecord(tar, 'GlassPane-1.4.0/sub/icon.png', paxRecord('mode', '0755')))
    const entry = readTarGz(declared).find((e) => e.name.endsWith('icon.png'))
    assert.equal(entry.mode & 0o777, 0o755, `pax 声明的 mode 被丢了（pendingMode 死分支）：${JSON.stringify(entry)}`)
    const dest = path.join(src, 'out')
    fs.mkdirSync(dest)
    extractTarGz(declared, path.join(dest, 'tree'), { allowedRoot: src })
    assert.equal(fs.statSync(path.join(dest, 'tree/GlassPane-1.4.0/sub/icon.png')).mode & 0o777, 0o755)

    const setuid = gz(withPaxRecord(tar, 'GlassPane-1.4.0/sub/icon.png', paxRecord('mode', '4777')))
    const dest2 = path.join(src, 'out2')
    fs.mkdirSync(dest2)
    extractTarGz(setuid, path.join(dest2, 'tree'), { allowedRoot: src })
    const landed = fs.statSync(path.join(dest2, 'tree/GlassPane-1.4.0/sub/icon.png')).mode & 0o7777
    assert.equal(landed & 0o7000, 0, `setuid/setgid/sticky 不许由档案说了算：0o${landed.toString(8)}`)
    assert.equal(landed & 0o022, 0, `组/其他写位不许由档案说了算：0o${landed.toString(8)}`)

    for (const garbage of ['9999', '0x1ff', '', '7 7 7']) {
      const bogus = gz(withPaxRecord(tar, 'GlassPane-1.4.0/sub/icon.png', paxRecord('mode', garbage)))
      const dest3 = path.join(src, `out-${garbage.replace(/\W/g, '_')}`)
      fs.mkdirSync(dest3)
      const error = captureTh(() => extractTarGz(bogus, path.join(dest3, 'tree'), { allowedRoot: src }))
      assert.ok(error, `非八进制的 pax mode 不许静默回退成成员模式：${JSON.stringify(garbage)}`)
      assert.equal(error.code, CODES.archiveUnreadable, `夹具形状不是真八进制：${error.message}`)
      assert.match(error.message, /mode=/, error.message)
      assert.match(error.message, /updater check/, '拒了要给下一步')
      assert.equal(fs.existsSync(path.join(dest3, 'tree')), false, '拒收的那一份一个字都不该写')
    }
  } finally {
    removeDir(src)
  }
})

test('C10 同一路径先 file 后 link：两份真归档拼成一条流，必须拒、且一个字节都不写', (t) => {
  if (!HAS_TAR) return t.skip('这一条拼的是 /usr/bin/tar 真产出的两份归档')
  // REVERSE: `lib/tar.js:344` 的 `if (byTarget.has(target))` 换回旧守卫
  // `if (byTarget.has(target) && entry.type !== 'link')` → 这一条以"没报错"红，
  // 而且第二遍把 link 目标的字节盖在 file 那份上（正是这句话承诺要拦的事）。
  const root = tempDir(`${TMP_PREFIX}c10-dup-`)
  try {
    fs.mkdirSync(path.join(root, 'A/GlassPane-1.4.0/sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'A/GlassPane-1.4.0/apple-touch-icon.png'), 'PNGBYTES')
    fs.writeFileSync(path.join(root, 'A/GlassPane-1.4.0/sub/icon.png'), 'FIRST')
    fs.mkdirSync(path.join(root, 'B/GlassPane-1.4.0/sub'), { recursive: true })
    fs.symlinkSync('../apple-touch-icon.png', path.join(root, 'B/GlassPane-1.4.0/sub/icon.png'))
    fs.mkdirSync(path.join(root, 'C/GlassPane-1.4.0/sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'C/GlassPane-1.4.0/apple-orig.png'), 'PNGBYTES')
    fs.linkSync(path.join(root, 'C/GlassPane-1.4.0/apple-orig.png'), path.join(root, 'C/GlassPane-1.4.0/sub/icon.png'))

    const tarA = realTar(path.join(root, 'A'), ['GlassPane-1.4.0/apple-touch-icon.png', 'GlassPane-1.4.0/sub/icon.png'])
    const tarB = realTar(path.join(root, 'B'), ['GlassPane-1.4.0/sub/icon.png'])
    // 同一次 tar 里两个名字共用一个 inode → 后一个是真 typeflag `1` 硬链条目。
    const tarC = realTar(path.join(root, 'C'), ['GlassPane-1.4.0/apple-orig.png', 'GlassPane-1.4.0/sub/icon.png'])
    assert.deepEqual(
      readTarGz(gz(tarC)).map((e) => [e.name, e.type]),
      [['GlassPane-1.4.0/apple-orig.png', 'file'], ['GlassPane-1.4.0/sub/icon.png', 'link']],
      '夹具自证：C 那份里 icon.png 真是硬链条目，不是又一个普通文件',
    )

    const fileThenLink = gz(Buffer.concat([tarA, tarB]))
    const seen = readTarGz(fileThenLink)
    const at = seen.filter((e) => e.name === 'GlassPane-1.4.0/sub/icon.png')
    assert.equal(at.length, 2, `夹具自证：这一条流里真的有两份同路径（${JSON.stringify(seen.map((e) => [e.name, e.type]))}）`)
    assert.deepEqual(at.map((e) => e.type), ['file', 'link'], '第一份是 file、第二份是 link')
    const dest = path.join(root, 'dest')
    fs.mkdirSync(dest)
    const error = captureTh(() => extractTarGz(fileThenLink, path.join(dest, 'tree'), { allowedRoot: root }))
    assert.ok(error, '同一路径先 file 后 link 不报错就是漏（第二份盖掉第一份的字节）')
    assert.equal(error.code, CODES.archiveEntryUnsafe, error.message)
    assert.match(error.message, /two entries/, error.message)
    assert.match(error.message, /a file and a link/, error.message)
    assert.equal(fs.existsSync(path.join(dest, 'tree')), false, '第一遍就拒，staging 里一个字节都不该写')

    const linkThenLink = gz(Buffer.concat([tarB, tarB]))
    const dest2 = path.join(root, 'dest2')
    fs.mkdirSync(dest2)
    const second = captureTh(() => extractTarGz(linkThenLink, path.join(dest2, 'tree'), { allowedRoot: root }))
    assert.ok(second, '两条 link 指向同一路径同样是第二份盖第一份')
    assert.equal(second.code, CODES.archiveEntryUnsafe, second.message)
    assert.match(second.message, /a link and a link/, second.message)

    const fileThenHardLink = gz(Buffer.concat([tarA, tarC]))
    const dest3 = path.join(root, 'dest3')
    fs.mkdirSync(dest3)
    const third = captureTh(() => extractTarGz(fileThenHardLink, path.join(dest3, 'tree'), { allowedRoot: root }))
    assert.ok(third, `真硬链条目（typeflag 1）也算一份：${JSON.stringify(third)}`)
    assert.match(third.message, /a file and a link/, third.message)

    // B 单独成档时 link 的目标不在这条流里 → 必须按"目标不在档案里"拒，而不是按重复项拒：
    // 新守卫不能把这条真句子抢走（真 file+link 一起 extract 的正常形状在上一条用例里已经走通）。
    const orphanLink = gz(tarB)
    const alone = captureTh(() => {
      const d = path.join(root, 'dest4')
      fs.mkdirSync(d)
      return extractTarGz(orphanLink, path.join(d, 'tree'), { allowedRoot: root })
    })
    assert.ok(alone, JSON.stringify(alone))
    assert.notEqual(alone.code, CODES.archiveEntryUnsafe, `这是"目标不在档案里"，不是重复项：${alone.message}`)
    assert.equal(alone.code, CODES.archiveEntryUnsupported, alone.message)
  } finally {
    removeDir(root)
  }
})

function captureTh(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}
