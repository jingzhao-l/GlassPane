/**
 * 2026-10-28（CLI 契约 lane）—— 打印给人看的那几段文案：内部编号与"挪 $HOME"的补救。
 *
 * 缺陷 1（项目规则：`ITERATE.md:112`「用户可见文案（GUI/终端输出/README）里不出现内部 §引用与规格编号」）：
 * `usageText()`、`updateGuidanceText()`、`nextStepsText()` 里共有五处把规格段落号印到了屏幕上
 * （`见 P1 v1.2 §11.1`、`（规格 2026-09-27 §5）`、`规格 §1 八道校验`、`updater 按 §7 拒绝注册`、
 * `（P1 v1.2 §10.1 / §11.2）`）。读的人手上没有那份规格，段落号对他不是一个可执行的东西；
 * 而每一处都顺手把**真正 actionable 的那句话**换成了 plain 表述，flag 名与命令串保持逐字节不变。
 *
 * 缺陷 2：`installGuard()` 的两条 HOME 拒绝给的补救是让操作者给 `$HOME` 赋一个绝对路径。本产品读的是
 * **口令档案里的家目录**（`mcp-shell/src/update-state.ts` 的 `recordHome()`、`installer/glasspane.js`
 * 的 `stateRootOf`——今天刚按同一条改过），赋 `$HOME` 只挪得动这一条命令，挪不动 daemon 与面板那一份。
 * 现在两条都点名真正生效的开关：`--state-dir <path>`（updater 与 daemon 都收），以及被认的地方是
 * `GLASSPANE_STATE_DIR`（更新器与 `glasspane` 命令读它）。
 *
 * 缺陷 6（只记录，不改码）：用法文本里那一行写明同一类"用法错"在三支二进制里各自回几（2 / 2 / 64），
 * 措辞必须是"这是已知分歧的记录"。
 *
 * REVERSE MUTATION：
 *  · 把任意一处 § 引用放回文案 ⇒ 第 1 条红（数出来的段号不是 0）；
 *  · 把某处改写时顺手把 flag 名或命令串也改了 ⇒ 第 2 条红；
 *  · 把 `export HOME=` 那种补救放回 installGuard ⇒ 第 3 条红（两条分支各自都闸，且 `install-sh.test.mjs`
 *    的「install.sh: HOME 未设置 → 人话拒绝而不是 unbound variable，dry-run 仍是拒」同时红）；
 *  · 删掉跨二进制那一行 ⇒ 第 4 条红。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { quoteShellArg, installGuard, nextStepsText, updateGuidanceText, usageText } from '../cli.js'

const UPDATER_CLI = path.join('/install', 'root', 'updater', 'cli.js')

/** `updateGuidanceText` 的三种态 × CA 束的五态里有代表性的三种，一条都不留给"以后再说"。 */
function everyUpdateGuide() {
  const caOk = { status: 'ok', certs: 137, path: '/r/.glasspane/ca-roots.pem' }
  const caEmpty = { status: 'empty', certs: 0, path: '/r/.glasspane/ca-roots.pem' }
  return [
    updateGuidanceText(null),
    updateGuidanceText({
      state: 'registered', updaterCli: UPDATER_CLI, agentLabel: 'com.glasspane.update',
      schedule: '12:00', scheduleMeasured: true, stateRoot: '/r/.glasspane', caRoots: caOk,
    }),
    updateGuidanceText({
      state: 'registered', updaterCli: UPDATER_CLI, agentLabel: 'com.glasspane.update',
      schedule: '12:00', scheduleMeasured: false, stateRoot: '/r/.glasspane', caRoots: caEmpty,
    }),
    updateGuidanceText({
      state: 'registered', updaterCli: UPDATER_CLI, agentLabel: 'com.glasspane.update',
      schedule: '12:00', scheduleMeasured: true, stateRoot: '/r/.glasspane', caRoots: null,
    }),
    updateGuidanceText({ state: 'disabled', updaterCli: UPDATER_CLI, agentLabel: 'com.glasspane.update', reason: 'env' }),
    updateGuidanceText({ state: 'disabled', updaterCli: UPDATER_CLI, agentLabel: 'com.glasspane.update', reason: 'flag' }),
    updateGuidanceText({ state: 'missing', updaterCli: UPDATER_CLI, rootDir: '/install/root' }),
  ].flat()
}

test('缺陷1：打印给用户的三段文案里一个内部 §/规格段落号都没有（ITERATE.md:112）', () => {
  const surfaces = {
    usageText: usageText(),
    updateGuidance: everyUpdateGuide().join('\n'),
    nextStepsRegistered: nextStepsText({
      rootDir: '/install/root', socketPath: '/s.sock', guiOpened: true,
      daemon: { path: '/x/glasspaned', viaBundle: true }, settingsApp: '/Apps/GlassPane Daemon.app',
      update: { state: 'registered', updaterCli: UPDATER_CLI, agentLabel: 'com.glasspane.update', schedule: '12:00', scheduleMeasured: true, stateRoot: '/r/.glasspane', caRoots: { status: 'ok', certs: 1, path: '/p' } },
    }),
    nextStepsDisabled: nextStepsText({
      rootDir: '/install/root', socketPath: '/s.sock', guiOpened: false,
      daemon: { path: '/x/glasspaned', viaBundle: false },
      update: { state: 'disabled', updaterCli: UPDATER_CLI, agentLabel: 'com.glasspane.update', reason: 'env' },
    }),
    nextStepsBare: nextStepsText({ rootDir: '/install/root', socketPath: '/s.sock', guiOpened: false, daemonVerified: false, daemon: { path: null, viaBundle: false } }),
  }
  for (const [name, text] of Object.entries(surfaces)) {
    const hits = text.match(/§\s*[0-9]+(\.[0-9]+)?/g) ?? []
    assert.deepEqual(hits, [], `${name} 把规格段落号印到了屏幕上：${hits.join(', ')}\n——读的人手上没有那份规格，这一格要给的是一句人话加一条能跑的命令。`)
    assert.doesNotMatch(text, /P1 v1\.2|规格 2026-/, `${name} 还在引用内部规格编号`)
  }
})

test('缺陷1：改写只动散文——flag 名、命令串与"八道校验"这条事实逐字节还在', () => {
  const usage = usageText()
  for (const flag of ['--repo <目录>', '--no-prompt', '--no-daemon', '--replace-daemon', '--no-gui', '--no-app',
    '--no-launchd', '--no-auto-update', '--restore-launchd', '--skip-build', '--accept-unverified-signature',
    '--no-bootstrap', '-h, --help']) {
    assert.ok(usage.includes(flag), `用法里少了这一面旗：${flag}`)
  }
  const guide = everyUpdateGuide().join('\n')
  assert.match(guide, /八道校验/, '校验是八道这一条事实必须在（auto-update.test.mjs 也按它断言）')
  assert.ok(guide.includes(`node ${quoteShellArg(UPDATER_CLI)} enable`), '重开的那一条命令要能照抄')
  assert.ok(guide.includes(`node ${quoteShellArg(UPDATER_CLI)} disable`), '一键关的那一条命令要能照抄')
  assert.match(guide, /bootout com\.glasspane\.update/, '卸载口径仍然要点名同一个作业')
  const steps = nextStepsText({ rootDir: '/install/root', socketPath: '/s.sock', guiOpened: false, daemon: { path: '/x/glasspaned', viaBundle: false } })
  assert.match(steps, /授权勾选必须人工/, 'TCC 那条诚实边界不能被改写没了')
  assert.match(steps, /npm i -g glasspane-mcp/, '发布口径仍然在')
  assert.ok(steps.includes(`node ${quoteShellArg(path.join('/install/root', 'installer', 'cli.js'))} --restore-launchd`),
    '恢复命令仍然是真路径（引号形态按 quoteShellArg 派生）')
})

test('缺陷2：installGuard 的两条 HOME 拒绝点名真正生效的开关，不再叫用户挪 $HOME', () => {
  const branches = {
    'HOME 未设置': installGuard({ home: '', uid: 501 }),
    'HOME 是相对路径': installGuard({ home: path.join('.glasspane-home'), uid: 501 }),
  }
  for (const [label, guard] of Object.entries(branches)) {
    assert.equal(guard.ok, false, `${label}：这一条仍然必须是拒绝`)
    assert.match(guard.error, /--state-dir/, `${label}：补救要点名那面真生效的旗`)
    assert.match(guard.error, /GLASSPANE_STATE_DIR/, `${label}：被认的那个环境变量也要写出来`)
    assert.doesNotMatch(guard.error, /export HOME/, `${label}：又印回"给 $HOME 赋值"那句了——它改的变量没有一处在读状态根`)
    assert.match(guard.error, /口令档案/, `${label}：要说清状态根读的是哪一个家目录`)
  }
  // 「不要用那种形态起安装器」那一句只属于 HOME 未设置那一支（相对 HOME 那一支从前也没有它），
  // 而 install-sh.test.mjs 按"两条入口共用这一句"断言，所以在这里也钉一次，别靠那条测试兜。
  assert.match(branches['HOME 未设置'].error, /env -u HOME/, '起安装器的形态那一句要留着')
  assert.equal(installGuard({ home: '/Users/dev', uid: 501 }).ok, true, '对照：绝对 HOME 照旧放行')
})

test('缺陷6：用法文本记下跨二进制的用法错码（记录分歧，不是修它）', () => {
  const usage = usageText()
  assert.match(usage, /^ {2}2 {2}命令行参数错误/m, '本文件自己那一档先要还在')
  assert.match(usage, /updater\/cli\.js` 回 2/, '更新器那一支对同一类失败回几')
  assert.match(usage, /glasspaned` 回 64/, 'daemon 对同一类失败回 64')
  assert.match(usage, /已知分歧/, '措辞要说明这是记录，不是把码统一了（那些码是发出去的契约）')
})
