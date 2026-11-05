/**
 * 2026-11-05（lane：状态根的叶子是一枚链接时，"owner-only 已验证"说的是别人那棵树）—— P2。
 *
 * 缺陷：`installer/cli.js` 三处都对着**叶子**动作：
 *  · `ensureLogDir` —— `mkdirSync(dir,{recursive:true})` + `chmodSync(dir,0700)` + `statSync(dir)`；
 *  · `openPrivateLog` —— `fs.openSync(file,'a')` + `fchmodSync(fd,0600)`；
 *  · `writePrivatePlist` —— `writeFileSync(file,{mode:0600})` + `chmodSync(file,0600)` + `statSync(file)`。
 * `stat`/`chmod` 跟随符号链接，`openSync` 默认也跟随。于是**预先摆好的**
 * `~/.glasspane -> /某处的一棵树`（或 `installer-daemon.log -> 别人的文件`、
 * `com.glasspane.daemon.plist -> 别人的文件`）会让这三处：
 *  1) 把 chmod 落在根**之外**的那棵树上（安装器改了它不该改的字节/权限），
 *  2) 然后把读回来的模式当作"owner-only 已验证"打进结论——那句话证明的是别人的目录，
 *     而真正的 `~/.glasspane`（一个链接名）里 socket、审批记录、证据线索照旧世界可读。
 *
 * 判据抄本仓已有的两处同族闸，抄的是**判定**：
 *  · `engine/Sources/GlassPaneEngine/StateRoot.swift` 的 `leafSymlinkDefect`（约 143 行）——
 *    `lstat` 只看 `S_IFLNK`，拒绝里明写 "Nothing was chmod-ed here"；
 *  · `updater/lib/fsutil.js` 的 `assertPrivateRoot`（约 111-125 行）——链接指向谁就点名谁，
 *    并说 "nothing was written and nothing was removed"；
 *  · `bridge/glasspane_bridge.py` 的 `_secure_out_write`（约 1055 行）——打开时用 `O_NOFOLLOW`，
 *    让内核而不是判据来守这条线。
 *
 * REVERSE MUTATION（用例 ↔ 红点）：
 *  · 把 `ensureLogDir` 里的 `leafSymlinkDefect` 摘掉 ⇒ 第 1 条同时红在两处：根外那棵树的模式
 *    被改成 0700（"改了它不该改的"），以及拒绝句里那句"没有 chmod"不见了；
 *  · 把 `openPrivateLog` 的 `O_NOFOLLOW` 摘掉 ⇒ 第 2 条红（根外那份文件被 chmod 成 0600）；
 *  · 把 `writePrivatePlist` 的判定挪到 write **之后** ⇒ 第 3 条红（根外那份文件内容已被覆盖）；
 *  · 把判定改成"任何叶子都拒" ⇒ 第 4、5、6 条红（真目录/真文件的 0700/0600 是做得到也测得到的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DAEMON_LOG_NAME,
  SOCKET_DIR_NAME,
  STATE_DIR_MODE,
  STATE_FILE_MODE,
  ensureLogDir,
  leafSymlinkDefect,
  openPrivateLog,
  privateLogFlags,
  startDetached,
  writePrivatePlist,
} from '../cli.js'

const modeOf = (target) => fs.statSync(target).mode & 0o777
const textOf = (target) => fs.readFileSync(target, 'utf8')

/** 一个"根外的真目录"：链接指向它，而它不属于本轮要建的状态根。
 *  测试断言的是**它的字节与模式在拒绝之后一字未动**，不是断言某句文案出现过。 */
function outsideTree(label, { as = 'dir', contents = 'pre-existing bytes\n', mode = 0o755 } = {}) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), `gp-outside-${label}-`))
  fs.chmodSync(outer, 0o755)
  if (as === 'dir') {
    const target = path.join(outer, SOCKET_DIR_NAME)
    fs.mkdirSync(target, { mode: 0o755 })
    fs.chmodSync(target, mode)
    fs.writeFileSync(path.join(target, 'keep-me.txt'), contents)
    return { outer, target, modeBefore: mode, contentsBefore: null }
  }
  const target = path.join(outer, 'victim')
  fs.writeFileSync(target, contents)
  fs.chmodSync(target, mode)
  return { outer, target, modeBefore: mode, contentsBefore: contents }
}

function linkInto(target) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-linkhome-'))
  const link = path.join(home, SOCKET_DIR_NAME)
  fs.symlinkSync(target, link, 'dir')
  return { home, link, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

function fileLinkInto(target, leafName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-linkleaf-'))
  const link = path.join(dir, leafName)
  fs.symlinkSync(target, link, 'file')
  return { dir, link, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('夹具：这台机器存得住权限位（不然下面每一条都是空转）', () => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mode-probe-'))
  try {
    const file = path.join(probe, 'p')
    fs.writeFileSync(file, 'x')
    fs.chmodSync(file, 0o600)
    assert.equal(modeOf(file), 0o600, '这台机器的卷不存权限位：本文件的断言在这里没有读数')
    assert.ok(fs.constants.O_NOFOLLOW, 'macOS 上 node 一定导出 O_NOFOLLOW，打开这一层是判据的一部分')
    assert.ok(privateLogFlags() & fs.constants.O_NOFOLLOW, 'openPrivateLog 的默认旗标里必须带着 O_NOFOLLOW')
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
})

test('ensureLogDir：~/.glasspane 是一枚链接时拒到底，根外那棵树的模式一字不动', () => {
  const outside = outsideTree('logdir')
  const home = linkInto(outside.target)
  try {
    assert.equal(modeOf(outside.target), 0o755, '前置：根外那棵树现在是别人可读的')
    const result = ensureLogDir(path.join(home.link, DAEMON_LOG_NAME))
    assert.equal(result.ok, false, '链接指向的树不是这一轮该 chmod 的对象：' + JSON.stringify(result))
    assert.equal(modeOf(outside.target), 0o755,
      `根外那棵树被改成了 ${modeOf(outside.target).toString(8)}：拒绝之前先动手了`)
    assert.match(result.error, /符号链接/, result.error)
    assert.match(result.error, /没有 chmod/, '拒绝要说清没做的那几件事：' + result.error)
    assert.match(result.error, /没有 mkdir/, result.error)
    assert.ok(result.error.includes(outside.target), '要点名链接指向的是哪儿：' + result.error)
  } finally {
    home.cleanup()
    fs.rmSync(outside.outer, { recursive: true, force: true })
  }
})

test('openPrivateLog：日志叶子是链接时不打开也不 chmod，根外那份文件原样', () => {
  const outside = outsideTree('logleaf', { as: 'file', mode: 0o644, contents: 'audit trail of someone else\n' })
  const leaf = fileLinkInto(outside.target, DAEMON_LOG_NAME)
  try {
    const result = openPrivateLog(leaf.link)
    assert.equal(result.ok, false, '一份指向别处的 daemon 日志不是"已经 0600"：' + JSON.stringify(result))
    assert.equal(result.fd, null, '拒绝之后不许留下一个开着的 fd')
    assert.equal(modeOf(outside.target), 0o644,
      `根外那份文件被 fchmod 成了 ${modeOf(outside.target).toString(8)}`)
    assert.equal(textOf(outside.target), outside.contentsBefore, '内容也被写过')
    assert.match(result.error, /符号链接/, result.error)
    assert.match(result.error, /没有 chmod/, result.error)
    assert.match(result.error, /没有追加/, result.error)
  } finally {
    leaf.cleanup()
    fs.rmSync(outside.outer, { recursive: true, force: true })
  }
})

test('writePrivatePlist：plist 叶子是链接时一个字节都不写，根外那份内容原样', () => {
  const outside = outsideTree('plist', { as: 'file', mode: 0o644, contents: '<plist>someone elses launchagent</plist>\n' })
  const leaf = fileLinkInto(outside.target, 'com.glasspane.daemon.plist')
  try {
    const result = writePrivatePlist(leaf.link, '<plist><new>this run</new></plist>')
    assert.equal(result.ok, false, 'LaunchAgent 不许写在链接上：' + JSON.stringify(result))
    assert.equal(textOf(outside.target), outside.contentsBefore, '根外那份文件被覆盖了')
    assert.equal(modeOf(outside.target), 0o644, '根外那份文件的模式被改过')
    assert.match(result.error, /符号链接/, result.error)
    assert.match(result.error, /没有写过这份 plist/, result.error)
    assert.match(result.error, /没有 chmod/, result.error)
  } finally {
    leaf.cleanup()
    fs.rmSync(outside.outer, { recursive: true, force: true })
  }
})

test('startDetached：兜底那一支也不追链接，且子进程一次都没起', async () => {
  const outside = outsideTree('detach')
  const home = linkInto(outside.target)
  const marker = path.join(outside.target, 'should-not-exist')
  try {
    const started = await startDetached('/bin/sh', ['-c', `touch ${marker}`], path.join(home.link, DAEMON_LOG_NAME), { settleMs: 50 })
    assert.equal(started.ok, false, JSON.stringify(started))
    assert.equal(started.pid, null)
    assert.match(started.error, /符号链接/, started.error)
    assert.equal(fs.existsSync(marker), false, '拒绝必须发生在 spawn 之前')
    assert.equal(modeOf(outside.target), 0o755, '根外那棵树的模式被动过')
  } finally {
    home.cleanup()
    fs.rmSync(outside.outer, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 对照组 */

test('对照（真目录/真文件那一支仍然做得到）：链接这件事不是"永远拒"的借口', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-realhome-'))
  const logPath = path.join(home, SOCKET_DIR_NAME, DAEMON_LOG_NAME)
  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.glasspane.daemon.plist')
  try {
    // plist 的父目录由 install() 那边建；这里按 LaunchAgents 的形状先摆好，
    // `writePrivatePlist` 只管"叶子不是链接 + 写完读回模式"这两件事。
    fs.mkdirSync(path.dirname(plist), { recursive: true })
    const dir = ensureLogDir(logPath)
    assert.equal(dir.ok, true, dir.error ?? '')
    assert.equal(fs.statSync(dir.dir).mode & 0o777, STATE_DIR_MODE, '真目录还是要收成 0700')

    const opened = openPrivateLog(logPath)
    assert.equal(opened.ok, true, opened.error ?? '')
    fs.writeSync(opened.fd, 'x\n')
    fs.closeSync(opened.fd)
    assert.equal(modeOf(logPath), STATE_FILE_MODE)

    const written = writePrivatePlist(plist, '<plist>ok</plist>')
    assert.equal(written.ok, true, written.error ?? '')
    assert.equal(modeOf(plist), STATE_FILE_MODE)

    const detached = await startDetached('/usr/bin/true', [], logPath, { settleMs: 60 })
    assert.equal(detached.ok, true, detached.error ?? '')
    assert.equal(leafSymlinkDefect(dir.dir), null, '真实目录在判据那里必须是"没有缺陷"')
    assert.equal(leafSymlinkDefect(path.join(home, '从来没建过的那个东西')), null,
      '还没建的叶子不是缺陷——这一趟就是来建它的')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
