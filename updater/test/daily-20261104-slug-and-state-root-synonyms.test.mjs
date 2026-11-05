/**
 * 每日任务 2026-11-04（同日第二条会话）· 候选 J 与候选 L。
 *
 * **J**：`scripts/check-doc-links.mjs` 的 `slug()` 从前用 `/\s+/g → '-'` 把连续空白**合并**成一枚
 * 连字符，而 GitHub 的 slugger 用 `/\s/g → '-'`——逐枚替换。两枚连续空格的标题因此在两边算出
 * 两个锚：`## 安装 步骤` 在 GitHub 是 `#安装--步骤`，这道闸却算成 `#安装-步骤`。锚点判定是这道闸
 * 的核心主张，判据与它声称的那一件不是同一件事时，绿不说明任何东西。
 *
 * **L**：`updater/cli.js` 的 `resolveStateRoot` 从前写 `flags['state-dir'] ?? flags['state-root'] ?? …`。
 * 两枚都是**在册同义词**（`--state-root` 是那一份 launchd plist 用的拼写，见 `updater/lib/idle.js`），
 * 于是"同时给出、且两个值不一样"这一档被 `??` 静默取了一枚——而状态根是所有落点相对的那一棵，
 * 读错根的下一步就是往另一套档案里写。现在要么一致、要么带码拒绝，且拒绝时一个字节都不动。
 *
 * REVERSE：把 `slug()` 改回 `\s+` ⇒ 第一条红；把冲突那一支删掉 ⇒ 第二条读成一个根而不拒。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { slug } from '../../scripts/check-doc-links.mjs'
import { resolveStateRoot } from '../../updater/cli.js'
import { CODES } from '../../updater/lib/codes.js'

test('slug 与 GitHub 的 slugger 对连续空白同答（逐枚换，不合并）', () => {
  // 两枚空格写成 `' '.repeat(2)` 而不是打两个空格：这份文件是上一轮经 shell 落盘的，
  // 那两个相邻空格在途中被吃掉了一枚（本机实测：`slug('安装 步骤')` 拿到单空格那一形，
  // 断言却按双空格写）。判据要能被读出来它测的是哪一枚字符，夹具本身不能靠看不见的空白。
  const two = ' '.repeat(2)
  const three = ' '.repeat(3)
  assert.equal(slug(`安装${two}步骤`), '安装--步骤', '两枚空格在 GitHub 那里是两枚连字符')
  assert.equal(slug(`A${two}B`), 'a--b', '同一形状的英文一格：合并过就与线上锚不一致')
  assert.equal(slug(`Daily${two}round${three}2026-11-04`), 'daily--round---2026-11-04')
  // 其余判据不许被我这一改带走：先 trim 再去标点、CJK 保留，这些口径逐条复量。
  // 同样的，凡依赖"看得见的两枚空格"的都写成 repeat()，不让夹具再被一次落盘吃掉空白。
  assert.equal(slug(`${two}Trimmed${two}Heading Here${two}`), 'trimmed--heading-here')
  assert.equal(slug('带 `代码` 的标题'), '带-代码-的标题')
  assert.equal(slug('单空格不变'), '单空格不变')
  assert.equal(slug('Mixed Case 与 123 数字'), 'mixed-case-与-123-数字')
})

test('两枚同义旗标给出两个不同的根时，当场带码拒绝', () => {
  const env = {}
  assert.throws(
    () => resolveStateRoot({ flags: { 'state-dir': '/tmp/root-a', 'state-root': '/tmp/root-b' }, env }),
    (error) => {
      assert.equal(error.code, CODES.stateRootConflict, `拒绝必须点名这一档：${error.code}`)
      assert.match(error.message, /--state-dir \/tmp\/root-a and --state-root \/tmp\/root-b/)
      assert.match(error.message, /Nothing was read or written/, '拒绝要说清这一趟没动过任何东西')
      assert.match(error.message, /one flag|same path/, '并给出做得动的下一步')
      assert.deepEqual(error.details, { stateDir: '/tmp/root-a', stateRoot: '/tmp/root-b' })
      return true
    },
  )
})

test('一致的同义旗标与单旗标照旧通过——拒的不是同义词本身', () => {
  // 夹具形状要来自真的调用：`resolveStateRoot` 走的是 `canonicalPath`（realpath），一个不存在
  // 的名字在它那里不是"这一趟要动的根"。上一轮这份文件写的是 `/tmp/root-a` 那种根本不存在的路径，
  // 于是三条断言比的其实都是同一枚回落默认根的读数——绿的是一条没在量的对照（本机实测：
  // 返回 `/Users/ethanlin/.glasspane`）。这里改成真的临时目录，两两一致才叫一致。
  const env = {}
  const a = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-root-a-'))
  const b = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-root-b-'))
  try {
    const both = resolveStateRoot({ flags: { 'state-dir': a, 'state-root': a }, env })
    const one = resolveStateRoot({ flags: { 'state-root': a }, env })
    const other = resolveStateRoot({ flags: { 'state-dir': a }, env })
    assert.equal(both, one)
    assert.equal(one, other)
    assert.equal(one, canonicalForCompare(a), `认下来的根就是被点名的那一棵：${one} vs ${a}`)
    // 两枚旗标指向两棵**都真实存在**的树时才是候选 L 那一档，这里顺手把正例也钉住。
    assert.throws(() => resolveStateRoot({ flags: { 'state-dir': a, 'state-root': b }, env }),
      (error) => error.code === CODES.stateRootConflict)
    // 空值那一档：`--state-dir ""` 不是"给了两个不同的根"，但它也**不许把另一枚旗标吃掉**。
    // 上一轮这一格写的是"`''` 维持原样"，而它当时的夹具是不存在的路径——两边都回落到默认根，
    // 于是这条对照是空的。换成真目录之后量出的是 P1：`--state-dir "" --state-root <真另一棵>`
    // 回的是默认根 `~/.glasspane`（`??` 挡不住空串），那一趟以为在动另一棵树，写的却是这台
    // 机器正在用的那一棵，连需要人来确认的那道 `nonDefaultStateDir` 门都没经过。
    assert.equal(
      resolveStateRoot({ flags: { 'state-dir': '', 'state-root': a }, env }),
      canonicalForCompare(a),
      '空的那一枚不许遮住真点名了根的那一枚',
    )
    assert.equal(
      resolveStateRoot({ flags: { 'state-dir': '   ', 'state-root': a }, env }),
      resolveStateRoot({ flags: { 'state-root': a }, env }),
      '只有空白符的旗标与没给同一档',
    )
    // 两枚都空/没给 → 默认根（这一档从前就是如此，别被上面那一条带跑）。
    assert.equal(
      resolveStateRoot({ flags: { 'state-dir': '' }, env }),
      resolveStateRoot({ flags: {}, env }),
    )
  } finally {
    fs.rmSync(a, { recursive: true, force: true })
    fs.rmSync(b, { recursive: true, force: true })
  }
})

function canonicalForCompare(p) {
  try { return fs.realpathSync(p) } catch { return p }
}
