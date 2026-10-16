/**
 * 旧 updater 读者能不能解析**我们要发的那棵树**（2026-10-15 本轮，P1）。
 *
 * 失效模式：`updater/lib/selfcheck.js` 从 1.10.0 起两种写法都认（先 static 再 instance），
 * 这是**向前**兼容。反方向没人管：一台装着 1.10.0 之前 runtime 的机器，它的自检还是 1.6.2
 * 那份，只拿 `/public let version = "([^"]+)"/` 找版本。而 1.10.0 把那一行改成了
 * `public let version = EngineCore.buildVersion`（转读，不带字面量），于是旧读者对每一份新树
 * 都抛 `version-line-broken`。本机实测就是这台机器：
 *   ~/.glasspane/update-state.json → status=check-failed, code=version-line-broken,
 *   lastError="engine/Sources/GlassPaneEngine/EngineCore.swift in the staged tree has no
 *   `public let version` constant"，history 里 2026-10-11T13:14:47 起如此；
 *   指针 update-install.json 仍钉着 runtime/1.6.2 那份 CLI——也就是说**每日作业和面板的
 *   "立即检查"跑的都是那份读不懂新树的代码**，自动更新从此不会再工作，而屏幕上那句还把原因
 *   推给发布物的字节。
 *
 * 为什么需要一个"旧读者"的夹具而不是改新代码：能改旧代码的只有旧版本，而旧版本已经发出去了。
 * 唯一能让这批机器自愈的办法，就是让**我们要发的树**继续带着旧读者解析得出的那一行。
 *
 * 来源（不是本文件编出来的形状）：正则取自本机
 * `~/.glasspane/runtime/1.6.2/updater/lib/selfcheck.js:55`（sha256 前缀 18e949ca0b2f206b），
 * 站点表里那一行 `engine/Sources/GlassPaneEngine/EngineCore.swift` 同文件 :30。
 *
 * 反向变异：把 `EngineCore.swift` 里那行 `public let version = "x.y.z"` 改回转读
 * （`= EngineCore.buildVersion`）→ 第 1 条红（旧读者抛 version-line-broken）；
 * 把 static 与 instance 两个字面量写成不同号 → 第 3 条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENGINE_CORE = path.join('engine', 'Sources', 'GlassPaneEngine', 'EngineCore.swift')

class LegacyUpdaterError extends Error {}

/** 1.6.2 那份 `siteVersion` 的非 JSON 分支，逐字搬过来（见文件头的出处）。 */
function legacySiteVersion(text, file) {
  const match = /public let version = "([^"]+)"/.exec(text)
  if (!match) {
    throw new LegacyUpdaterError(`${file} in the staged tree has no \`public let version\` constant`)
  }
  const plain = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(match[1]).trim())
  if (!plain) {
    throw new LegacyUpdaterError(`${file} in the staged tree reports version ${JSON.stringify(match[1])}, which is not a released x.y.z`)
  }
  return plain[0]
}

/** 现版读者（对照用）：先 static 再 instance。 */
function currentSiteVersion(text) {
  const authoritative = /public static let buildVersion = "([^"]+)"/.exec(text)
  const match = authoritative ?? /public let version = "([^"]+)"/.exec(text)
  return match ? match[1] : null
}

function engineCoreText() {
  return fs.readFileSync(path.join(REPO, ENGINE_CORE), 'utf8')
}

test('装着 1.10.0 之前 updater 的机器，能把自己要升级到的那棵树读出一个版本号', () => {
  const read = legacySiteVersion(engineCoreText(), ENGINE_CORE)
  const line = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version
  assert.equal(read, line, `旧读者读出 ${read}，版本线是 ${line}：这批机器会停在 version-line-broken`)
})

test('对照：只留 static 的那种写法，旧读者读不出来（这条不是永远绿的）', () => {
  // 1.10.0~1.15.1 的实际形状。没有这一条负例，上面那条可能只是因为文件里恰好有个引号串而过。
  const staticOnly = engineCoreText().replace(
    /^([ \t]*)public let version = "[^"]*"/m,
    '$1public let version = EngineCore.buildVersion',
  )
  assert.notEqual(staticOnly, engineCoreText(), '夹具没起作用：那一行不是预期的形状')
  assert.throws(
    () => legacySiteVersion(staticOnly, ENGINE_CORE),
    /no `public let version` constant/,
    '转读写法本该让旧读者拒——它不拒就说明这个对照是空的',
  )
  assert.equal(currentSiteVersion(staticOnly), currentSiteVersion(engineCoreText()),
    '现版读者两种写法都认，所以它测不到这件事')
})

test('两处字面量必须同号：旧读者与新读者不许各说一个版本', () => {
  const text = engineCoreText()
  const legacy = legacySiteVersion(text, ENGINE_CORE)
  const authoritative = currentSiteVersion(text)
  assert.equal(legacy, authoritative, `兼容位 ${legacy} 与权威位 ${authoritative} 漂了`)
  // 位点表两个都在，否则下一次 set-version 只改一处，漂移就是这么来的。
  // 核的是**正则那一行**而不是子串：表里的注释也提到这两种形状，按子串断言就等于在断言注释。
  const table = fs.readFileSync(path.join(REPO, 'scripts', 'version-sites.mjs'), 'utf8')
  assert.ok(table.includes('public static let buildVersion = ")'), '权威位点不在表里')
  assert.ok(table.includes('public let version = ")'), '兼容位点不在表里：set-version 会把它留在旧号上')
})
