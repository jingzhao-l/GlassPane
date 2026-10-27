/**
 * `glasspane` 这个命令入口（2026-10-26 由用户点名的第三条路：应用内更新失败时，人要有一条能直接
 * 敲的命令，而不是"去找到那个 checkout 再 node 它的 cli.js"）。
 *
 * 三条主张，每条都配一个能红的用例：
 *  · *读不到 ≠ 不在*：`unverified` 与 `absent` 分得开（`installer/cli.js` 的 PROBE_STATES 是同一条规矩，
 *    `updater/lib/launchd.js` 的 JOB_READS 也是）。合起来就是"这台机器没装"，而人看到的是假缺席。
 *  · *指针是唯一真源*：命令永远走 `update-install.json` 里那份更新器，绝不从 cwd 猜一份出来——
 *    猜出来的那份跑赢了在册的那份，就是"更新成功而机器没变"。
 *  · *不 sudo、不删东西*：补法只给命令名与目录（与 updater 的 remedy 同一口径，见
 *    updater/test/remedy-surface.test.mjs）。
 *
 * REVERSE MUTATION：把 npm 那一格从"逐包读版本"改成"npm 答了话就算 available" → 第 4 条红；
 * 把 check 结论为 up-to-date 时仍然往下走 apply → 第 6 条红在"只起了一次子进程"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DAEMON_JOB_LABEL,
  NPM_PACKAGES,
  READS,
  VERBS,
  VERB_ALIASES,
  doctorReadings,
  doctorReport,
  main,
  parseVerb,
  readInstallPointer,
  runUpdate,
  stateRootOf,
  usageText,
} from '../glasspane.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GLASSPANE_JS = path.join(HERE, '..', 'glasspane.js')

function scratch(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gp-${label}-`))
}

/** 一把记账的假 spawn：按 argv 里出现的关键词答话，答不了就是"这台机器上没这个能力"。 */
function fakeSpawn(table) {
  const calls = []
  return {
    calls,
    fn: (bin, args) => {
      const join = [bin, ...(args ?? [])].join(' ')
      calls.push(join)
      for (const [re, answer] of table) {
        if (re.test(join)) return typeof answer === 'function' ? answer(join) : answer
      }
      return { status: null, stdout: '', stderr: '', error: new Error(`没有这条的答案：${join}`) }
    },
  }
}

/**
 * `status --json` 的真实形状（本机 2026-10-26 量的）：顶层是 command/status/code/message/exitCode，
 * 状态文档整体在 `state` 里。测试按这个形状喂——按顶层读 `current` 的那版实现就是这么在真机上
 * 答出"装着=?"的。
 */
const updaterStatusJson = (over = {}) => ({
  command: 'status',
  ok: true,
  status: 'available',
  code: null,
  message: 'status=available current=1.20.0 latest=1.21.0',
  exitCode: 0,
  state: { current: '1.20.0', latest: '1.21.0', staged: { version: '1.21.0' }, lastCheckAt: '2026-10-26T00:00:00.000Z' },
  ...over,
})

/** npm 11 的 `ls -g --depth=0 --json` 是**美化过的多行**文档（本机量的），与 updater 的单行是一份形状差。 */
const npmJson = (deps) => JSON.stringify({ name: 'lib', dependencies: deps }, null, 2)

test('stateRootOf：GLASSPANE_STATE_DIR 优先，且说得出是谁给的', () => {
  const named = stateRootOf({ env: { GLASSPANE_STATE_DIR: '/tmp/别的家' }, homeDir: '/Users/x' })
  assert.equal(named.stateRoot, path.resolve('/tmp/别的家'))
  assert.equal(named.source, 'GLASSPANE_STATE_DIR')
  const home = stateRootOf({ env: {}, homeDir: '/Users/x' })
  assert.equal(home.stateRoot, '/Users/x/.glasspane')
  assert.match(home.source, /默认/)
  const blind = stateRootOf({ env: { HOME: '' }, homeDir: '' })
  // 读不到家目录时它答"读不到"，不答一个相对路径——那是 §4 那条"状态落进当前目录"的坑的形状。
  assert.equal(blind.stateRoot, null, JSON.stringify(blind))
})

test('readInstallPointer：四种形状四种说法，缺席与读不出不许混为一谈', () => {
  const root = scratch('pointer')
  const pointerPath = path.join(root, 'update-install.json')
  const cli = path.join(root, 'somewhere', 'updater', 'cli.js')
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(cli, '//')
  try {
    const absent = readInstallPointer({ stateRoot: root })
    assert.equal(absent.read, READS.absent, JSON.stringify(absent))
    assert.match(absent.reason, /不存在/, '没这个文件要说"不存在"')

    fs.writeFileSync(pointerPath, '{ 手改坏的')
    const broken = readInstallPointer({ stateRoot: root })
    assert.equal(broken.read, READS.unverified, JSON.stringify(broken))
    assert.match(broken.reason, /不是合法 JSON/, '文件在而读不出是另一件事：它的补救是重写指针，不是重装机')

    fs.writeFileSync(pointerPath, JSON.stringify({ updaterCli: '/nope/cli.js', installRoot: '/nope' }))
    const moved = readInstallPointer({ stateRoot: root, exists: () => false })
    assert.equal(moved.read, READS.absent, JSON.stringify(moved))
    assert.match(moved.reason, /被移动或删除/, '指针在而脚本不在：那份 checkout 没了，这是本轮用户报的形状之一')
    assert.match(moved.remedy, /重跑一次安装程序/, '要给做得动的下一步')

    fs.writeFileSync(pointerPath, JSON.stringify({ updaterCli: cli, installRoot: root }))
    const ok = readInstallPointer({ stateRoot: root })
    assert.equal(ok.read, READS.available, JSON.stringify(ok))
    assert.equal(ok.updaterCli, cli)
    assert.equal(ok.installRoot, root, '安装根要跟着交出来：doctor 与 update 都按它走')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('doctor：六格都在位时答 0，且逐格给的是读到的东西', () => {
  const root = scratch('doctor-ok')
  const pointerPath = path.join(root, 'update-install.json')
  const cli = path.join(root, 'tree', 'updater', 'cli.js')
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(cli, '//')
  fs.writeFileSync(pointerPath, JSON.stringify({ updaterCli: cli, installRoot: path.join(root, 'tree') }))
  fs.writeFileSync(path.join(root, 'engine.sock'), '')
  const npm = npmJson({ 'glasspane-mcp': { version: '1.21.0' }, 'glasspane-install': { version: '1.21.0' } })
  const spawner = fakeSpawn([
    [/updater\/cli\.js status/, { status: 0, stdout: JSON.stringify(updaterStatusJson()), stderr: '' }],
    [/launchctl print/, { status: 0, stdout: 'gui/501/com.glasspane.daemon = {\n\tstate = running\n}', stderr: '' }],
    [/^npm ls -g/, { status: 0, stdout: npm, stderr: '' }],
  ])
  try {
    const readings = doctorReadings({
      env: { GLASSPANE_STATE_DIR: root },
      spawn: spawner.fn,
      uid: '501',
      execPath: '/usr/local/bin/node',
    })
    assert.equal(readings.length, 6, JSON.stringify(readings.map((r) => r.name)))
    const report = doctorReport(readings)
    assert.equal(report.ok, true, report.text)
    assert.match(report.text, /装着=1\.20\.0/, `版本号要从更新器那一格淌出来：${report.text}`)
    assert.match(report.text, /glasspane-mcp=1\.21\.0/, report.text)
    assert.match(report.text, /在册作业装载着/, report.text)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('doctor：全局包缺一格要答"不在"，并给一行不带权限的补法', () => {
  const root = scratch('doctor-npm')
  const pointerPath = path.join(root, 'update-install.json')
  const cli = path.join(root, 'tree', 'updater', 'cli.js')
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(cli, '//')
  fs.writeFileSync(pointerPath, JSON.stringify({ updaterCli: cli, installRoot: path.join(root, 'tree') }))
  fs.writeFileSync(path.join(root, 'engine.sock'), '')
  const npm = npmJson({ 'glasspane-mcp': { version: '1.20.0' } })
  const spawner = fakeSpawn([
    [/updater\/cli\.js status/, { status: 0, stdout: JSON.stringify(updaterStatusJson({ status: 'applied', code: 'npm-not-refreshed' })), stderr: '' }],
    [/launchctl print/, { status: 0, stdout: 'gui/501/x = {\n\tstate = running\n}', stderr: '' }],
    [/^npm ls -g/, { status: 0, stdout: npm, stderr: '' }],
  ])
  try {
    const readings = doctorReadings({ env: { GLASSPANE_STATE_DIR: root }, spawn: spawner.fn, uid: '501' })
    const npmRow = readings.find((one) => one.name === '全局 npm 包')
    assert.equal(npmRow.read, READS.absent, JSON.stringify(npmRow))
    assert.match(npmRow.detail, /glasspane-install=没装/, npmRow.detail)
    assert.match(npmRow.remedy, /npm install -g glasspane-mcp@/, npmRow.remedy)
    assert.doesNotMatch(npmRow.remedy, /\bsudo\b/, '补法不许交出可照抄的升权命令')
    const statusRow = readings.find((one) => one.name === '更新器状态')
    assert.match(statusRow.detail, /装着=1\.20\.0/, `版本号只能从状态文档里取：${statusRow.detail}`)
    assert.match(statusRow.detail, /待装=1\.21\.0/, `待装那一份住在 state 文档里，不在顶层：${statusRow.detail}`)
    assert.match(statusRow.remedy, /npm-not-refreshed/, `状态里挂着的代号要能在 doctor 里看见：${statusRow.remedy}`)
    assert.equal(doctorReport(readings).ok, false, '有一格不在位时 doctor 必须答"不健康"')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('doctor：launchd 答"没这个作业"是缺席，答不了是不知道——两种说法不许互换', () => {
  const root = scratch('doctor-job')
  const pointerPath = path.join(root, 'update-install.json')
  const cli = path.join(root, 'tree', 'updater', 'cli.js')
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(cli, '//')
  fs.writeFileSync(pointerPath, JSON.stringify({ updaterCli: cli, installRoot: path.join(root, 'tree') }))
  const base = (jobAnswer) => doctorReadings({
    env: { GLASSPANE_STATE_DIR: root },
    exists: (p) => !p.endsWith('engine.sock'),
    spawn: fakeSpawn([
      [/updater\/cli\.js status/, { status: 0, stdout: JSON.stringify(updaterStatusJson()), stderr: '' }],
      [/launchctl print/, jobAnswer],
      [/^npm ls -g/, { status: 0, stdout: npmJson({}), stderr: '' }],
    ]).fn,
    uid: '501',
  }).find((one) => one.name === '定时代理')
  try {
    const gone = base({ status: 113, stdout: '', stderr: 'Could not find service' })
    assert.equal(gone.read, READS.absent, JSON.stringify(gone))
    assert.match(gone.remedy, /重跑安装程序/, gone.remedy)
    const mute = base({ status: null, stdout: '', stderr: '', error: new Error('Operation not permitted') })
    assert.equal(mute.read, READS.unverified, JSON.stringify(mute))
    assert.match(mute.detail, /Operation not permitted/, mute.detail)
    assert.doesNotMatch(mute.detail, /没有 gui\/501/, '答不了的时候不许顺手写出"launchd 说它没有"那句结论')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('update：检查说没得装就到此为止，绝不起那一次安装', async () => {
  const written = []
  const spawner = fakeSpawn([
    [/cli\.js check/, { status: 0, stdout: JSON.stringify({ status: 'up-to-date', message: 'installed 1.21.0 is the newest' }), stderr: '' }],
  ])
  const result = await runUpdate({
    execPath: '/usr/local/bin/node',
    updaterCli: '/tree/updater/cli.js',
    stateRoot: '/tmp/x',
    spawn: spawner.fn,
    write: (line) => written.push(line),
  })
  assert.equal(result.exitCode, 0, JSON.stringify(result))
  assert.equal(spawner.calls.length, 1, `检查说"最新"之后不许再起安装：${JSON.stringify(spawner.calls)}`)
  assert.ok(written.some((l) => /已经是最新/.test(l)), written.join('\n'))
})

test('update：装完之后把更新器自己的退出码原样带出来，包括部分成功那一档', async () => {
  const written = []
  const spawner = fakeSpawn([
    [/cli\.js check/, { status: 0, stdout: JSON.stringify({ status: 'available', message: 'staged 1.21.0' }), stderr: '' }],
    [/cli\.js apply/, {
      status: 0,
      stdout: JSON.stringify({ status: 'applied', code: 'npm-not-refreshed', message: 'updated 1.20.0 -> 1.21.0. the application updated, but the two global npm packages did not: …' }),
      stderr: '',
    }],
  ])
  const result = await runUpdate({
    execPath: '/usr/local/bin/node',
    updaterCli: '/tree/updater/cli.js',
    stateRoot: '/tmp/x',
    spawn: spawner.fn,
    write: (line) => written.push(line),
  })
  assert.equal(result.exitCode, 0, '机器确实换了 ⇒ 部分成功不是失败')
  assert.ok(written.some((l) => /代号：npm-not-refreshed/.test(l)), `那一格要留在屏幕上，不许被"成功"洗掉：${written.join('\n')}`)
  assert.equal(spawner.calls.length, 2)
})

test('update：更新器答非零时把这一步如实说成停住，不编一个"已安装"', async () => {
  const written = []
  const spawner = fakeSpawn([
    [/cli\.js check/, { status: 3, stdout: JSON.stringify({ status: 'deferred', code: 'busy-or-unreachable', message: 'daemon is busy' }), stderr: '' }],
    [/cli\.js apply/, { status: 0, stdout: JSON.stringify({ status: 'applied', message: '这绝不该发生' }), stderr: '' }],
  ])
  const result = await runUpdate({
    execPath: '/usr/local/bin/node',
    updaterCli: '/tree/updater/cli.js',
    stateRoot: '/tmp/x',
    spawn: spawner.fn,
    write: (line) => written.push(line),
  })
  assert.equal(result.exitCode, 3, JSON.stringify(result))
  assert.equal(spawner.calls.length, 1, `停在检查那一格就不该再走安装：${JSON.stringify(spawner.calls)}`)
  assert.ok(written.some((l) => /没有进入安装/.test(l)), written.join('\n'))
})

test('用法与命令表：未知命令退 2，help 里写清了退出码与"不 sudo"', () => {
  assert.equal(parseVerb(['nope']).error, '不认得命令「nope」')
  assert.equal(parseVerb([]).error, '没给命令')
  assert.equal(parseVerb(['doctor']).verb, 'doctor')
  const help = usageText()
  for (const verb of ['update', 'status', 'doctor', 'help']) assert.match(help, new RegExp(verb), `用法里必须列出 ${verb}`)
  assert.match(help, /不 sudo|不会给成可照抄执行的升权命令|需要人做的那一步/, help)
  assert.match(help, /退出码/, help)
})

test('`-h` 与 `--help` 就是 help：同产品的两条入口不许对同一种问法给两种答案', async () => {
  // 2026-10-27 用**发布物**量到的：`/usr/local/bin/glasspane --help` 回"不认得命令「--help」"并退 2,
  // 而 `glasspane-install --help` 打用法退 0。agent 的第一反应就是 `--help`,给它一个非零等于教它
  // "这条命令不能用"。别名是一张明面上的表（`VERB_ALIASES`），不是散在 if 里的手感。
  assert.deepEqual(Object.keys(VERB_ALIASES).sort(), ['--help', '-h'], JSON.stringify(VERB_ALIASES))
  for (const alias of Object.keys(VERB_ALIASES)) {
    assert.equal(parseVerb([alias]).verb, 'help', `${alias} 必须读到 help`)
    assert.equal(parseVerb([alias]).error, null, `${alias} 不许再报错`)
  }
  for (const alias of Object.keys(VERB_ALIASES)) {
    const lines = []
    const rc = await main({ argv: [alias], write: (l) => lines.push(l), fail: (l) => lines.push(l) })
    assert.equal(rc, 0, `${alias} 的退出码：${lines.join('\n')}`)
    assert.match(lines.join('\n'), /用法：glasspane <命令>/, `${alias} 要把这一页交出来`)
  }
  // 别名表不许悄悄扩大成"任何带横杠的都是 help"：未知选项仍然退 2，否则打错的命令会被读成帮助。
  assert.equal(parseVerb(['--version']).error, '不认得命令「--version」')
  assert.equal(parseVerb(['-hepl']).error, '不认得命令「-hepl」')
  assert.equal(VERBS.includes('help'), true, 'help 仍在命令表里：别名指的是它，不是第三种动作')
})

test('这一条命令真的会随包交付：bin 里两个名字，files 里有那个文件，且有可执行位', () => {
  // 这一条不是形式检查：v1.12.3 那次,`glasspane-install` 交付的 bin 是个符号链接,发出去的 19 个版本
  // 里那条命令对任何参数都回 0 字节 / 退 0——"包里有没有那个文件"这件事从没被量过。
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.bin).sort(), ['glasspane', 'glasspane-install'], JSON.stringify(manifest.bin))
  assert.equal(manifest.bin.glasspane, './glasspane.js')
  for (const entry of ['./glasspane.js', './cli.js']) {
    assert.ok(manifest.files.includes(entry.replace('./', '')), `files 里少了 ${entry}：npm 会发出一份没有这条命令的包`)
  }
  assert.match(fs.readFileSync(GLASSPANE_JS, 'utf8'), /^#!\/usr\/bin\/env node/, 'shebang 是第一行：npm 的 shim 靠它')
  /* c8 ignore next 2 */
  const mode = fs.statSync(GLASSPANE_JS).mode
  assert.notEqual(mode & 0o111, 0, '可执行位不在时，按文件路径直接调用会 Permission denied')
  assert.equal(NPM_PACKAGES.length, 2, '补法里点名的那两个包名，与本包 npm 上发的两个是一对')
  assert.equal(DAEMON_JOB_LABEL, 'com.glasspane.daemon')
})
