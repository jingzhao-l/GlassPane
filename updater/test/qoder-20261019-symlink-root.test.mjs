/**
 * 每一句"只写在自己状态根里"的承诺，此前都是**字面**比较（`path.resolve`），而同一个文件里就住着
 * `realWithin` / `sameRuntimePath`——它们存在的原因正是"一个符号链接分量会让字符串相等失效"。
 * 于是状态根本身是符号链接时（或 `<root>/update-staging` 是符号链接时），暂存写入、
 * `saveState`/`writePointer`、`discardStaging`/`retireStaleGenerations` 全部落在**链接指向的那个目录**
 * 里并在那里删除，而 `--state-dir` 看起来保护了它。真机形状就是：沙盒指向活的 `~/.glasspane`。
 *
 * 三条判据各自对应一层：
 *   1) `isWithin`/`resolveWithin` 比的是**已存在部分**的真实路径 —— 一个链接出去的分量要被拒；
 *   2) `writableRoots`/`ensurePrivateDir` 在入口拒绝"根自己是个符号链接"；
 *   3) `resolveStateRoot` 在入口拒绝"指的地方其实落在默认家目录根上"，除非带 `--consent state-dir`。
 *
 * REVERSE MUTATION：把 `writableRoots` 的 `assertPrivateRoot` 摘掉 → 第 1 条红在
 * `状态根是符号链接时每一次写都必须被拒`；把 `isWithin` 换回纯字面比较 → 第 2 条红在
 * `<root>/update-staging 是符号链接…`；删掉 `resolveStateRoot` 的那条入口判据 → 第 3 条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { runCommand, resolveStateRoot } from '../cli.js'
import { UpdaterError, ensurePrivateDir, isWithin, resolveWithin, writableRoots } from '../lib/fsutil.js'
import { discardStaging } from '../lib/staging.js'
import { CODES } from '../lib/codes.js'
import { emptyState, saveState } from '../lib/state.js'

const TMP = fs.realpathSync('/tmp')

function scratch(label) {
  return fs.mkdtempSync(path.join(TMP, `gpu-symroot-${label}-`))
}

/** A directory listing with each file's bytes folded in: "byte-identical" with a name. */
function fingerprint(dir) {
  const walk = (current, prefix = '') => fs.readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) return walk(full, rel)
      if (entry.isSymbolicLink()) return [`${rel} -> ${fs.readlinkSync(full)}`]
      return [`${rel} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`]
    })
  return walk(dir).join('\n')
}

test('状态根是一个指向别处的符号链接时，写与删都必须被拒，链接的那一头不许动', () => {
  const box = scratch('link-')
  const target = path.join(box, 'real-target')
  const link = path.join(box, 'sandbox')
  fs.mkdirSync(path.join(target, 'update-staging', '1.4.1'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(target, 'update-staging', '1.4.1', 'archive.tar.gz'), 'somebody elses staged bytes\n')
  fs.writeFileSync(path.join(target, 'keep-me.txt'), 'this directory is what the link points at\n')
  fs.symlinkSync(target, link, 'dir')
  try {
    const before = fingerprint(target)
    const refusals = []
    for (const [name, act] of [
      ['ensurePrivateDir', () => ensurePrivateDir(link)],
      ['writableRoots', () => writableRoots(link)],
      ['discardStaging', () => discardStaging({ stateRoot: link })],
      ['saveState', () => saveState(link, emptyState({ now: new Date() }))],
    ]) {
      let thrown = null
      try {
        act()
      } catch (error) {
        thrown = error
      }
      assert.ok(thrown instanceof UpdaterError, `${name} 在符号链接状态根上没有拒绝，实得：${JSON.stringify(thrown)}`)
      assert.equal(thrown.code, CODES.stagingEscape, `${name} 的拒绝必须落在同一个"越界"码上：${thrown.code}`)
      assert.match(thrown.message, /symbolic link|符号链接/, `${name} 的句子里要说出为什么：${thrown.message}`)
      refusals.push(name)
    }
    assert.deepEqual(refusals, ['ensurePrivateDir', 'writableRoots', 'discardStaging', 'saveState'], '四条路都要在入口拒绝')
    assert.equal(fingerprint(target), before, '链接指向的那个目录必须逐字节不变')
    assert.equal(fs.existsSync(path.join(target, 'update-state.json')), false, '状态文件不许落在链接指向的那一头')
    assert.equal(fs.existsSync(path.join(target, 'update-staging', '1.4.1', 'archive.tar.gz')), true, '一次拒绝不许把别人的暂存删掉')
  } finally {
    fs.rmSync(box, { recursive: true, force: true })
  }
})

test('根内一个符号链接分量同样越界：resolveWithin 比的是已存在部分的真实路径', () => {
  const box = scratch('inner-')
  const root = path.join(box, 'state')
  const elsewhere = path.join(box, 'elsewhere')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.mkdirSync(elsewhere, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(elsewhere, 'do-not-touch.txt'), 'outside the state root\n')
  // `<root>/update-staging` 是一个指向根外目录的链接：字面上 `root/update-staging/1.4.1` 在根内，
  // 真实路径在根外——而 `removeTreeWithin` 走的正是这条路（retireStaleGenerations 删的就是它）。
  fs.symlinkSync(elsewhere, path.join(root, 'update-staging'), 'dir')
  try {
    assert.equal(isWithin(root, root), true, '自己还在')
    assert.equal(isWithin(root, path.join(root, 'update-state.json')), true, '根内真的路径照常在')
    assert.equal(isWithin(root, path.join(root, 'update-staging')), false,
      '一个把出根的分量必须让 isWithin 说 false——这就是 realWithin 存在的原因')
    let thrown = null
    try {
      resolveWithin(root, path.join(root, 'update-staging', '1.4.1'), 'staging directory')
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof UpdaterError, 'resolveWithin 没有拒绝一条走得出去的链接')
    assert.equal(thrown.code, CODES.stagingEscape)
    assert.equal(fs.existsSync(path.join(elsewhere, 'do-not-touch.txt')), true, '拒绝之后根外一个字节都不动')
  } finally {
    fs.rmSync(box, { recursive: true, force: true })
  }
})

test('把 --state-dir 指到"其实就是活的默认根"上，必须带 --consent state-dir 才放行', async () => {
  const box = scratch('home-')
  const home = path.join(box, 'home')
  const live = path.join(home, '.glasspane')
  fs.mkdirSync(live, { recursive: true, mode: 0o700 })
  const link = path.join(box, 'sandbox')
  fs.symlinkSync(live, link, 'dir')
  const seen = []
  const deps = {
    homeDir: home,
    uid: '501',
    job: { unknown: true, reason: 'no daemon in this test' },
    readLocal: () => ({ ok: true, version: '1.4.0' }),
    registerAgent: () => ({ ok: true, verified: true, message: 'stub' }),
    unregisterAgent: () => ({ ok: true, message: 'stub' }),
    ensureAgentEntry: () => ({ ok: false, message: 'stub', path: null }),
    agentPlistPath: () => path.join(home, 'LaunchAgents', 'com.glasspane.update.plist'),
    readAgentSchedule: () => null,
    renderAgentPlist: () => '<plist/>',
    refreshCaBundle: () => ({ status: 'ok', certs: 1, path: null, exportedAt: 'now', detail: null }),
    usableCaBundle: () => ({ usable: false, certs: 0, reason: null }),
    runLaunchctl: () => ({ status: 3, stdout: '', stderr: 'No such process' }),
  }
  try {
    const plain = await runCommand({ command: 'disable', flags: { 'state-dir': link }, env: {}, deps })
    assert.equal(plain.ok, false, `一个指向默认家目录根的沙盒写法必须被问住：${JSON.stringify(plain).slice(0, 300)}`)
    assert.match(String(plain.message), /--consent state-dir/, '拒绝要给得出人能做的那一步')
    assert.equal(fs.existsSync(path.join(live, 'update-state.json')), false, '拒绝的那一次不许往活的根里写状态')
    const consented = await runCommand({ command: 'disable', flags: { 'state-dir': link, consents: ['state-dir'] }, env: {}, deps })
    assert.equal(consented.ok, true, `点了 --consent state-dir 就该放行：${JSON.stringify(consented).slice(0, 300)}`)
    // 点头之后落的是**真实那一份**：`lib/fsutil.js` 的 containment 判据现在拒绝把链接当根，
    // 所以入口必须把人说的"我就要动这一套装"翻译成那个真目录，而不是继续用链接名写——
    // 继续用链接名写就是把每条"只写在自己根里"的承诺交回一个不是根的名字，正是本条要消灭的形状。
    assert.equal(fs.existsSync(path.join(live, 'update-state.json')), true, '同意之后状态写进真实根')
    assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'update-state.json'), 'utf8')).disabled, true)
    seen.push(consented)
    // 直接把默认根写出来（不绕链接）是本工具一直允许的写法，不能被这条判据误伤。
    assert.equal(resolveStateRoot({ flags: { 'state-dir': live }, env: {}, homeDir: home }), live)
  } finally {
    fs.rmSync(box, { recursive: true, force: true })
  }
})
