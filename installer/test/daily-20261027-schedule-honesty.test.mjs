/**
 * 2026-10-27（finding C4）—— 安装日志里那句"每日 X 点"必须是**读回来的**，不是常量。
 *
 * 缺陷形状：`installer/cli.js` 从前把 `launchd.DEFAULT_HOUR:DEFAULT_MINUTE` 那两个常量直接拼进
 * summary.schedule，并在两处对读者说话（注册那一行的 say、nextSteps 的第 6 条）。而 `updater enable`
 * **故意保住**在册时刻（updater/cli.js:583：`asked.hour ?? standing?.hour ?? DEFAULT_HOUR`），
 * 注释写得很清楚："taking the constant here would move a machine installed with `--hour 3` to midday"。
 * 于是这台机器装过 `enable --hour 3` 再重装：作业还在 3:00 跑，安装日志与读者拿到的却是
 * "每日 12:00"。面板与 gp_diagnose 的读者信的就是这一句 —— 一个默认值冒充了一次实测。
 *
 * 修法：updater 把从**在册作业**读回来的 interval 作为结构化字段 `agentSchedule` 交出来
 * （`registerAgent` 早就在 message 里拼过同一个数，launchd.js:1017），installer 只许用它说话；
 * 读不回来就说读不回来，并显式带上 `scheduleMeasured: false`。
 *
 * 夹具形状来自真 `launchctl print`（`updater/test/launchd.test.mjs` 的 printJobBody 是同一条抄录），
 * 而**打印内容由盘上那份 plist 反推**（args 与 StartCalendarInterval 都是），不在桩里另写一份数字——
 * 否则测的就是桩而不是那条链。装机前那棵"在册 3:20"的 plist 是真的先写在临时 HOME 里，
 * 让 `enable` 的保住逻辑自己去读它。
 *
 * REVERSE MUTATION（本机实测，两条各自点名的红）：
 *  · 删掉 launchd.js 成功那一支的 `schedule: heldSchedule ?? null` ⇒ 第 1 条红在 `3:20`（installer
 *    拿不到落点，落到"默认值"那一支）；
 *  · 把 installer 的 `schedule` 换回常量 ⇒ 第 1 条同时红在 say 里出现 `12:00`；
 *  · 把 measured 在无读数时也报成真 ⇒ 第 2 条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerAutoUpdate, updateGuidanceText } from '../cli.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..')
const UPDATER_CLI = path.join(REPO_ROOT, 'updater', 'cli.js')
const AGENT_LABEL = 'com.glasspane.update'
const NOW = new Date('2026-10-27T04:00:00.000Z')
const CA_RECORD = { status: 'ok', certs: 163, path: null, exportedAt: '2026-10-27T09:00:00.000Z', detail: null }
const CA_DEPS = {
  updaterDeps: {
    refreshCaBundle: () => CA_RECORD,
    usableCaBundle: () => ({ usable: true, certs: CA_RECORD.certs, reason: null }),
  },
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix))
}

const PLIST_READER = 'import plistlib,json,sys\n'
  + 'with open(sys.argv[1], "rb") as handle:\n'
  + '    d = plistlib.load(handle)\n'
  + '    cal = d.get("StartCalendarInterval") or {}\n'
  + '    print(json.dumps({"args": d.get("ProgramArguments") or [],\n'
  + '        "schedule": ({"Hour": cal["Hour"], "Minute": cal["Minute"]} if "Hour" in cal and "Minute" in cal else None)}))\n'

/** 读盘上那份 plist 的参数与日历触发器（plistlib 比 launchd 严，读不动就是没注册成）。 */
function readPlistJob(plistPath) {
  if (!fs.existsSync(plistPath)) return null
  const got = spawnSync('python3', ['-c', PLIST_READER, plistPath], { encoding: 'utf8' })
  assert.equal(got.status, 0, `plistlib 读不动这份 plist：${got.stderr}`)
  return JSON.parse(got.stdout)
}

/** 一份 `launchctl print` 的正文，数字全部来自盘上那份 plist。 */
function printBody({ target, args, schedule }) {
  const label = String(target).split('/').pop()
  const lines = [
    `${target} = {`,
    '\tactive count = 1',
    '\ttype = LaunchAgent',
    '\tstate = not running',
    '',
    '\targuments = {',
    ...args.map((arg) => `\t\t${arg}`),
    '\t}',
    '',
  ]
  if (schedule) {
    lines.push(
      '\tevent triggers = {',
      `\t\t${label}.268435474 => {`,
      '\t\t\tkeepalive = 0',
      `\t\t\tservice = ${label}`,
      '\t\t\tstream = com.apple.launchd.calendarinterval',
      '\t\t\tdescriptor = {',
      `\t\t\t\t"Minute" => ${schedule.Minute}`,
      `\t\t\t\t"Hour" => ${schedule.Hour}`,
      '\t\t\t}',
      '\t\t}',
      '\t}',
      '',
    )
  }
  lines.push('}')
  return lines.join('\n')
}

/**
 * 注入的 launchctl。`hideSchedule` 用来造"那份书答不出钟点"的另一半：launchd 确实会
 * 在作业没有日历触发器时不打那一段（本机 2026-10-26 见过盘上读不出而作业读得出的反面）。
 */
function fakeLaunchctl({ home, hideSchedule = false }) {
  const calls = []
  const run = (bin, args) => {
    calls.push([bin, ...args])
    if (bin === 'id') return { status: 0, stdout: '501\n', stderr: '' }
    if (args[0] === 'bootout') return { status: 3, stdout: '', stderr: 'Could not find service' }
    if (args[0] === 'print') {
      const target = String(args.find((a) => String(a).startsWith('gui/')) ?? `gui/501/${AGENT_LABEL}`)
      const label = String(target).split('/').pop()
      const job = readPlistJob(path.join(home, 'Library', 'LaunchAgents', `${label}.plist`))
      if (job === null) return { status: 3, stdout: '', stderr: 'Could not find service' }
      return {
        status: 0,
        stderr: '',
        stdout: printBody({ target, args: job.args, schedule: hideSchedule ? null : job.schedule }),
      }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { calls, run }
}

/** 先在临时 HOME 里立一份"这台机器当年被人选了 3:20"的作业定义，让保住逻辑自己去读它。 */
function seedStandingJob({ home, hour, minute, entryPath }) {
  const dir = path.join(home, 'Library', 'LaunchAgents')
  fs.mkdirSync(dir, { recursive: true })
  const plist = path.join(dir, `${AGENT_LABEL}.plist`)
  const written = spawnSync('python3', ['-c',
    'import plistlib,sys,json\n'
    + 'with open(sys.argv[1], "wb") as handle:\n'
    + '    plistlib.dump(json.loads(sys.argv[2]), handle)\n',
    plist,
    JSON.stringify({
      Label: AGENT_LABEL,
      ProgramArguments: ['/bin/sh', '-c', '"$0" "$1" check "$2" "$3" --json', '/usr/local/bin/node', entryPath],
      StartCalendarInterval: { Hour: hour, Minute: minute },
      RunAtLoad: false,
    }),
  ], { encoding: 'utf8' })
  assert.equal(written.status, 0, written.stderr)
  return plist
}

test('在册作业跑在 3:20 时，安装日志那一句必须说 3:20——不许把默认常量当成这台机器的时刻', async () => {
  const home = tempDir('gp-sched-held-')
  const lines = []
  try {
    const entryPath = path.join(home, '.glasspane', 'runtime', 'agent-entry.js')
    const plist = seedStandingJob({ home, hour: 3, minute: 20, entryPath })
    const ctl = fakeLaunchctl({ home })
    const result = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: REPO_ROOT,
      env: { HOME: home },
      homeDir: home,
      uid: '501',
      runLaunchctl: ctl.run,
      now: NOW,
      say: (line) => lines.push(line),
    })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.registered, true)
    // 前提要能问出来：盘上那份定义真的还是 3:20（保住逻辑自己读的），而不是用例替它写的。
    assert.deepEqual(readPlistJob(plist).schedule, { Hour: 3, Minute: 20 }, '夹具前提：注册的这一份仍跑在 3:20')
    assert.equal(result.schedule, '3:20', `读回来的必须是在册那个数：${JSON.stringify(result.schedule)}`)
    assert.equal(result.scheduleMeasured, true, '这一个数是量出来的，得能这么回答')
    const said = lines.join('\n')
    assert.match(said, /3:20/, `那一句要说 3:20：${said}`)
    assert.doesNotMatch(said, /12:00/, `默认常量不许出现在这台机器的说法里：${said}`)
    const guidance = updateGuidanceText({ ...result, updaterCli: UPDATER_CLI }).join('\n')
    assert.match(guidance, /每日 3:20 跑/, guidance)
    assert.doesNotMatch(guidance, /不是实测/, `读到了就别再说"不是实测"：${guidance}`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('在册作业答不出钟点时说"默认值、不是实测"——不许悄悄换成 12:00 就完事', async () => {
  const home = tempDir('gp-sched-blind-')
  const lines = []
  try {
    // 作业本身注册成功，但那份书里读不出日历触发器（`hideSchedule`）——这一趟确实不知道挂在几点。
    const ctl = fakeLaunchctl({ home, hideSchedule: true })
    const result = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: REPO_ROOT,
      env: { HOME: home },
      homeDir: home,
      uid: '501',
      runLaunchctl: ctl.run,
      now: NOW,
      say: (line) => lines.push(line),
    })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.scheduleMeasured, false, '没读回来就不能报成量过')
    assert.equal(result.schedule, '12:00', '读不回来时给的是默认档，作为"如果不改会是多少"')
    const said = lines.join('\n')
    assert.match(said, /没能从在册作业读回实际时刻/, `要说清这一句的来源：${said}`)
    const guidance = updateGuidanceText({ ...result, updaterCli: UPDATER_CLI }).join('\n')
    assert.match(guidance, /这一句不是实测/, guidance)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('updater 的 enable 必须把在册 interval 作为数据交出来（不是只缝在 message 里）', () => {
  // 这一条盯的是接缝：installer 拿不到的话，它就只能回到"拼常量"那一种写法。
  const src = fs.readFileSync(UPDATER_CLI, 'utf8')
  assert.match(src, /agentSchedule: disable \? null : \(agent\.schedule \?\? null\)/,
    'enable 的回包要把在册 interval 单独成字段，null 表示"没读回来"')
  const launchdSrc = fs.readFileSync(path.join(REPO_ROOT, 'updater', 'lib', 'launchd.js'), 'utf8')
  const scheduleArms = launchdSrc.match(/schedule: (?:heldSchedule \?\? null|null),/g) ?? []
  assert.ok(scheduleArms.length >= 2,
    `registerAgent 的"读到"与"没读到"两支都要交出这个字段（拿到 ${scheduleArms.length} 个就说明有一支还在用散文糊弄）：${JSON.stringify(scheduleArms)}`)
})
