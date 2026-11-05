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

import { slug } from '../../scripts/check-doc-links.mjs'
import { resolveStateRoot } from '../../updater/cli.js'
import { CODES } from '../../updater/lib/codes.js'

test('slug 与 GitHub 的 slugger 对连续空白同答（逐枚换，不合并）', () => {
  assert.equal(slug('安装 步骤'), '安装--步骤', '两枚空格在 GitHub 那里是两枚连字符')
  assert.equal(slug('A  B'), 'a--b', '同一形状的英文一格：合并过就与线上锚不一致')
  assert.equal(slug('Daily  round   2026-11-04'), 'daily--round---2026-11-04')
  // 其余判据不许被我这一改带走：先 trim 再去标点、CJK 保留，这些口径逐条复量。
  assert.equal(slug('  Trimmed  Heading Here  '), 'trimmed--heading-here')
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
  const env = {}
  const both = resolveStateRoot({ flags: { 'state-dir': '/tmp/root-a', 'state-root': '/tmp/root-a' }, env })
  const one = resolveStateRoot({ flags: { 'state-root': '/tmp/root-a' }, env })
  const other = resolveStateRoot({ flags: { 'state-dir': '/tmp/root-a' }, env })
  assert.equal(both, one)
  assert.equal(one, other)
  // 空值那一档维持原样：`--state-dir ""` 不是"给了两个不同的根"。
  assert.equal(
    resolveStateRoot({ flags: { 'state-dir': '', 'state-root': '/tmp/root-a' }, env }),
    resolveStateRoot({ flags: { 'state-root': '/tmp/root-a' }, env }),
  )
})
