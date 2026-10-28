/**
 * 2026-10-28（lane A）—— `glasspane.js` 的状态根必须读**口令档案**，不是 `$HOME`。
 *
 * 缺陷形状：`stateRootOf()` 的第二级从前是 `$HOME`（再退一步 `os.homedir()`,那是同一个变量的另一张读法）。
 * 而这条产品的每一条入口读的都是档案那一份：面板 `NSHomeDirectory()`、daemon 的 `StateRoot.homeDefault()`、
 * 更新器的 `recordHomeDir()`（`updater/cli.js`：'this process has no password-database record, so the state
 * root cannot be named; pass --state-dir'）、`mcp-shell/src/update-state.ts` 的 `recordHome()`。两者一分为二
 * 时这台机器上是四个错：doctor 对着一台装好的机器说指针不存在、`gp_diagnose` 点另一个文件、
 * `runUpdate()` 把 `--state-dir <错根>` 交给真更新器（写进一个没有读者的根）、屏幕上那句补救
 * （`export HOME=…`）把裂缝制度化。
 *
 * 修法：`GLASSPANE_STATE_DIR` → 口令档案；档案读不到就 `stateRoot: null`（拒绝，不回退）。读不出根的每一格
 * 答 `unverified`（沿用本文件的 `READS`），`runUpdate`/`main` 在拿到根之前一个子进程都不起。
 * 注入口是 `readRecord`（默认 `os.userInfo()`），与文件里既有的 `env`、`homeDir` 同一种形状——没有依赖注入框架。
 *
 * REVERSE MUTATION（用例与红点的对应）：
 *  · 让 `stateRootOf` 重新优先 `env.HOME` ⇒ 第 1 条红（两处断言），第 2 条与第 6 条同时红——
 *    这两条是 CONTROL：HOME 被换成一个空目录时,健康装机在它们眼里仍然是健康的；
 *  · 把 null 根那两格写成 `absent` ⇒ 第 4 条红；
 *  · 把补法换回 `export HOME=` ⇒ 第 5 条红，且第 4 条（doctor 两行）与第 6 条（main 的 fail 行）跟着红；
 *  · 让 `runUpdate` 在 stateRoot 为 null 时照常 spawn ⇒ 第 6 条红在"一次进程都没起"，并红在参数表里出现字符串 `null`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  READS,
  STATE_ROOT_REMEDY,
  doctorReadings,
  doctorReport,
  main,
  readInstallPointer,
  runUpdate,
  stateRootOf,
} from '../glasspane.js'

/** 一个真的不存在的路径：`$HOME` 被重定向到别处时它就是那个"别处"。 */
const BOGUS_HOME = '/var/tmp/gp-daily-20261028-laneA-没有这个家'
/** 口令档案给出的那个家（测试里由 `readRecord` 交出去）。 */
const RECORD_HOME = '/Users/口令档案里的人'
const RECORD_ROOT = path.join(RECORD_HOME, '.glasspane')

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix))
}

/** 一台"装好了"的机器：档案家目录下有指针，指针指着一个真的 cli.js。 */
function installedTree() {
  const home = tempRoot('gp-record-home-')
  const stateRoot = path.join(home, '.glasspane')
  const cli = path.join(home, 'tree', 'updater', 'cli.js')
  fs.mkdirSync(stateRoot, { recursive: true })
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(cli, '//')
  fs.writeFileSync(path.join(stateRoot, 'update-install.json'), JSON.stringify({ updaterCli: cli, installRoot: path.join(home, 'tree') }))
  fs.writeFileSync(path.join(stateRoot, 'engine.sock'), '')
  return { home, stateRoot, cli }
}

const updaterStatusJson = () => ({
  command: 'status',
  ok: true,
  status: 'available',
  code: null,
  message: 'status=available current=1.20.0 latest=1.21.0',
  exitCode: 0,
  state: { current: '1.20.0', latest: '1.21.0', staged: null },
})

/** 记账的假 spawn：记下每一次 argv，答得出的一律答"在位"。 */
function allAnsweringSpawn() {
  const calls = []
  const fn = (bin, args) => {
    const join = [bin, ...(args ?? [])].join(' ')
    calls.push(join)
    if (/^npm ls -g/.test(join)) {
      return { status: 0, stdout: JSON.stringify({ name: 'lib', dependencies: { 'glasspane-mcp': { version: '1.21.0' }, 'glasspane-install': { version: '1.21.0' } } }), stderr: '' }
    }
    if (/launchctl print/.test(join)) return { status: 0, stdout: 'gui/501/com.glasspane.daemon = {\n\tstate = running\n}', stderr: '' }
    if (/updater\/cli\.js status/.test(join)) return { status: 0, stdout: JSON.stringify(updaterStatusJson()), stderr: '' }
    return { status: null, stdout: '', stderr: '', error: new Error(`不该起这一进程：${join}`) }
  }
  return { calls, fn }
}

const row = (readings, name) => readings.find((one) => one.name === name)
/** 这一格印出去的两行（detail + remedy），断言只许针对**印出去的字**。 */
const printed = (one) => `${one.detail ?? ''} ${one.remedy ?? ''}`

test('a) 状态根读的是口令档案：$HOME 被重定向也不改答案（CONTROL：改回优先 env.HOME 这一条就红）', () => {
  assert.ok(!fs.existsSync(BOGUS_HOME), '前提：$HOME 指向的那个目录必须不存在，否则下面的断言是在比两条路径而不是比谁被读')
  const record = stateRootOf({ env: { HOME: BOGUS_HOME }, readRecord: () => RECORD_HOME })
  assert.equal(record.stateRoot, RECORD_ROOT, `状态根要落在档案那一份上，实为 ${JSON.stringify(record)}`)
  assert.match(record.source, /默认/, '仍然要说得出是谁给的')
  assert.doesNotMatch(record.source, /<HOME>/, '标签不许再写 <HOME>：那读起来像在说 $HOME')
  assert.ok(!record.stateRoot.includes(BOGUS_HOME), '被重定向的 $HOME 不得出现在答案里')
  // 只有 `os.homedir()`（即 $HOME 的另一张读法）可用时也照样不作数。
  assert.equal(stateRootOf({ env: { HOME: BOGUS_HOME }, readRecord: () => null }).stateRoot, null)
  // 同一个进程里改 HOME 不改变结论：这条是反向 CONTROL——它红在"$HOME 又说了算"那一版实现上。
  const a = stateRootOf({ env: { HOME: '/Users/甲公司给的' }, readRecord: () => RECORD_HOME })
  const b = stateRootOf({ env: { HOME: '/Users/乙公司给的' }, readRecord: () => RECORD_HOME })
  assert.equal(a.stateRoot, b.stateRoot, '$HOME 的两份值不该得出两份状态根')
  assert.equal(b.stateRoot, RECORD_ROOT)
  // 调用方已经把档案读出来了就可以直接交进来（`homeDir` 的原有形状保持不变）。
  assert.equal(stateRootOf({ env: { HOME: BOGUS_HOME }, homeDir: '/Users/丙' }).stateRoot, path.join('/Users/丙', '.glasspane'))
})

test('b) GLASSPANE_STATE_DIR 仍然赢过 $HOME 与口令档案两者', () => {
  const named = stateRootOf({ env: { GLASSPANE_STATE_DIR: '/tmp/状态根-点名', HOME: BOGUS_HOME }, readRecord: () => RECORD_HOME })
  assert.equal(named.stateRoot, path.resolve('/tmp/状态根-点名'), JSON.stringify(named))
  assert.equal(named.source, 'GLASSPANE_STATE_DIR')
  const blank = stateRootOf({ env: { GLASSPANE_STATE_DIR: '   ', HOME: BOGUS_HOME }, readRecord: () => RECORD_HOME })
  assert.equal(blank.stateRoot, RECORD_ROOT, '空白的那一面旗等于没给，此时仍回到档案而不是 $HOME')
})

test('a 续) doctor 对着一台装好的机器：$HOME 是空目录时指针仍算在场（CONTROL）', () => {
  const tree = installedTree()
  const spawner = allAnsweringSpawn()
  try {
    const readings = doctorReadings({
      // 没有 GLASSPANE_STATE_DIR：这一格能落点，只可能来自档案。
      env: { HOME: path.join(BOGUS_HOME, '更深一层') },
      readRecord: () => tree.home,
      spawn: spawner.fn,
      uid: '501',
      execPath: '/usr/local/bin/node',
    })
    assert.equal(readings.length, 6, JSON.stringify(readings.map((one) => one.name)))
    assert.equal(row(readings, '状态根').read, READS.available, JSON.stringify(row(readings, '状态根')))
    assert.ok(row(readings, '状态根').detail.startsWith(`${tree.stateRoot}（`), `落点必须是档案家目录下那一份：${row(readings, '状态根').detail}`)
    assert.doesNotMatch(row(readings, '状态根').detail, /更深一层/, `被重定向的 $HOME 不得出现在落点里：${row(readings, '状态根').detail}`)
    assert.equal(row(readings, '安装指针').read, READS.available, JSON.stringify(row(readings, '安装指针')))
    assert.equal(row(readings, '引擎 socket').read, READS.available, JSON.stringify(row(readings, '引擎 socket')))
    assert.ok(spawner.calls.every((c) => c.includes(`--state-dir ${tree.stateRoot}`) || /^npm ls -g/.test(c) || /launchctl print/.test(c)),
      `更新器那一问要指着档案的根问：${JSON.stringify(spawner.calls)}`)
    assert.equal(doctorReport(readings).ok, true, doctorReport(readings).text)
  } finally {
    fs.rmSync(tree.home, { recursive: true, force: true })
  }
})

test('c) 档案读不到 = 拒绝：stateRoot 为 null、说得出为什么，且 doctor 答未验证而不是缺席', () => {
  const blind = stateRootOf({ env: { HOME: '/Users/somebody-else' }, readRecord: () => null })
  assert.equal(blind.stateRoot, null, JSON.stringify(blind))
  assert.match(blind.source, /口令档案/, `拒绝要说出拒的是哪一读：${blind.source}`)
  assert.doesNotMatch(blind.source, /HOME 未设置/, '不再把原因写成"$HOME 没设"：那不是这一读失败的事')
  // 档案答了个空的 homedir 与答不出是同义（`os.userInfo()` 也可能给空串）。
  assert.equal(stateRootOf({ env: {}, readRecord: () => '   ' }).stateRoot, null)
  // `homeDir: ''` 的原有语义保持不变：调用方明说"没有根"。
  assert.equal(stateRootOf({ env: {}, homeDir: '' }).stateRoot, null)

  const spawner = allAnsweringSpawn()
  const readings = doctorReadings({ env: { HOME: '/Users/somebody-else' }, readRecord: () => null, spawn: spawner.fn, uid: '501' })
  const root = row(readings, '状态根')
  const pointer = row(readings, '安装指针')
  assert.equal(root.read, READS.unverified, JSON.stringify(root))
  assert.match(printed(root), /未验证/, printed(root))
  assert.equal(pointer.read, READS.unverified, `根读不出时指针不许说"缺席"：${JSON.stringify(pointer)}`)
  assert.match(printed(pointer), /未验证/, printed(pointer))
  assert.doesNotMatch(pointer.detail, /不存在|不在盘上/, `没查过盘就不许写"不存在"：${pointer.detail}`)
  assert.match(pointer.detail, /不是"这台机器没装"/, pointer.detail)
  assert.equal(row(readings, '更新器状态').read, READS.unverified, JSON.stringify(row(readings, '更新器状态')))
  assert.match(row(readings, '引擎 socket').detail, /没问过盘|无从得出/, row(readings, '引擎 socket').detail)
  assert.doesNotMatch(row(readings, '引擎 socket').detail, /不在：/, 'socket 一格也不许在没看盘时说它不在')
  assert.equal(doctorReport(readings).ok, false, doctorReport(readings).text)
  assert.match(doctorReport(readings).text, /\(unverified\)/, doctorReport(readings).text)
  assert.ok(spawner.calls.every((c) => !/--state-dir/.test(c)), `根没读出来时不许把 --state-dir 交出去：${JSON.stringify(spawner.calls)}`)

  // readInstallPointer 自己那一层早就答 unverified，这一条把它的口径钉住，防止有人把它折回 absent。
  const none = readInstallPointer({ stateRoot: null })
  assert.equal(none.read, READS.unverified, JSON.stringify(none))
})

test('d) 印出去的下一步给的是 --state-dir，不是 export HOME', () => {
  assert.match(STATE_ROOT_REMEDY, /--state-dir/, STATE_ROOT_REMEDY)
  assert.doesNotMatch(STATE_ROOT_REMEDY, /export HOME/, '那条改的是一个没有一处在读的变量')
  assert.doesNotMatch(STATE_ROOT_REMEDY, /\bsudo\b/, '下一步只给工具名与目录，不给可照抄的升权命令')
  const spawner = allAnsweringSpawn()
  const blind = doctorReadings({ env: {}, readRecord: () => null, spawn: spawner.fn, uid: '501' })
  const remedies = blind.filter((one) => one.remedy).map((one) => one.remedy)
  assert.ok(remedies.length > 0, '根读不出时屏幕上必须给得出下一步')
  for (const text of remedies) assert.doesNotMatch(text, /export HOME/, text)
  assert.match(row(blind, '状态根').remedy, /--state-dir/, row(blind, '状态根').remedy)
  assert.match(row(blind, '安装指针').remedy, /--state-dir/, row(blind, '安装指针').remedy)
  // 健康的那台机器上，任何一格也不许再把 HOME 当作补救。
  const tree = installedTree()
  try {
    const ok = doctorReadings({ env: { GLASSPANE_STATE_DIR: tree.stateRoot }, spawn: allAnsweringSpawn().fn, uid: '501' })
    for (const one of ok.filter((r) => r.remedy)) assert.doesNotMatch(one.remedy, /export HOME/, one.remedy)
  } finally {
    fs.rmSync(tree.home, { recursive: true, force: true })
  }
})

test('c 续) 拿不到根就不动手：runUpdate 与 main 一次子进程都不起，也不交 --state-dir null', async () => {
  const written = []
  const spawner = allAnsweringSpawn()
  const refused = await runUpdate({
    execPath: '/usr/local/bin/node',
    updaterCli: '/tree/updater/cli.js',
    stateRoot: null,
    spawn: spawner.fn,
    write: (line) => written.push(line),
  })
  assert.equal(refused.exitCode, 3, JSON.stringify(refused))
  assert.equal(refused.stage, 'state-root', JSON.stringify(refused))
  assert.equal(spawner.calls.length, 0, `一次都不该起：${JSON.stringify(spawner.calls)}`)
  assert.match(written.join('\n'), /一次子进程都没起/, written.join('\n'))
  assert.match(written.join('\n'), /--state-dir/, `拒绝也要给做得动的下一步：${written.join('\n')}`)
  assert.doesNotMatch(written.join('\n'), /export HOME/, written.join('\n'))
  // 空的与 undefined 同义：`--state-dir undefined` 会变成字面量 "undefined" 那一份目录。
  for (const bad of [undefined, '', '   ']) {
    const s2 = allAnsweringSpawn()
    const r = await runUpdate({ updaterCli: '/t/cli.js', stateRoot: bad, spawn: s2.fn, write: () => {} })
    assert.equal(s2.calls.length, 0, JSON.stringify(s2.calls))
    assert.equal(r.exitCode, 3, JSON.stringify(r))
  }

  // 端到端：档案读不到 + $HOME 指着别处时，`glasspane update` 退 3、零子进程、给的是 --state-dir 那句。
  for (const verb of ['update', 'status']) {
    const out = []
    const s = allAnsweringSpawn()
    const rc = await main({
      argv: [verb],
      env: { HOME: '/Users/somebody-else' },
      readRecord: () => null,
      spawn: s.fn,
      write: (line) => out.push(line),
      fail: (line) => out.push(line),
    })
    assert.equal(rc, 3, `${verb}：${out.join('\n')}`)
    assert.equal(s.calls.length, 0, `${verb} 不该起任何进程：${JSON.stringify(s.calls)}`)
    assert.doesNotMatch(out.join('\n'), /不存在/, `${verb} 不许把没问过的东西说成缺席：${out.join('\n')}`)
    assert.match(out.join('\n'), /--state-dir/, out.join('\n'))
    assert.doesNotMatch(out.join('\n'), /export HOME/, out.join('\n'))
  }

  // doctor 在这一读失败时仍然出六格、仍然退 3（它只读，拒绝的是"下结论"而不是"开口"）。
  const lines = []
  const s = allAnsweringSpawn()
  const rc = await main({ argv: ['doctor'], env: { HOME: '/Users/somebody-else' }, readRecord: () => null, spawn: s.fn, write: (l) => lines.push(l), fail: (l) => lines.push(l) })
  assert.equal(rc, 3, lines.join('\n'))
  assert.equal(lines.length, 1, JSON.stringify(lines))
  for (const name of ['状态根', '安装指针', '更新器状态', '定时代理', '引擎 socket', '全局 npm 包']) {
    assert.ok(lines[0].includes(name), `doctor 六格都要出来，缺 ${name}：${lines[0]}`)
  }
  assert.match(lines[0], /未验证/, lines[0])
})
