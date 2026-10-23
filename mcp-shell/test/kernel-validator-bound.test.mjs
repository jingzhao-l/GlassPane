/**
 * 2026-10-23（缺陷 83）——内核验证器里那个 summary 上限，必须与随包交付的那份契约是同一个数。
 *
 * WHY（这条从前住在 Swift 里，而它在那儿永远量不到）。`DailyRound20261022VerdictTests`
 * 的 `testTheSummaryConstantIsTheSameNumberOnAllThreeSides` 第三臂读的是
 * `kernel/dist/decision-log-entry.js`——**那个路径没有被 git 追踪**（`git ls-files kernel/dist` 空，
 * 它是 2026-10-18 内核代码镜像退场后留在本机的一份旧副本）。后果实测：本仓 `swift test` 全绿，
 * CI 的 `engine (Swift)` 那一格红——CI 的检出里根本没有那些字节。一条量"发布出去的契约"的闸，
 * 读的必须是**发布出去的字节**：这个包里真正交付的内核是 `node_modules/iterate-kernel`
 * （由 `mcp-shell/package.json` 的精确版本声明钉住，`check-kernel-corpus.mjs` 的 shell 那一臂再核一次同号），
 * 而它住在 node 那一侧。所以这一臂搬到 node 测试里：CI 的每一个泳道都在跑测试之前 `npm ci`，
 * 而 Swift 那一格不装 node 依赖（`ci.yml` 的 swift job 里没有 npm 步骤——这也是它量不到的原因）。
 *
 * Swift 那一侧仍留着两臂（`kernel/schemas` 的 maxLength 与 `DecisionLogEntry.summaryMaxLength`），
 * 两边都是 tracked 字节；三臂合起来一条都没少，只是各按各的字节住在各自的泳道里。
 *
 * REVERSE MUTATION（每条点自己的名，本机实测）：
 *  · 把 `kernel/schemas/decision-log-entry.schema.json` 的 `summary.maxLength` 改成 2049 →
 *    「schema 与验证器是同一个数」红，而它报的是那两个具体的数（不是"读不到"）。
 *  · 把内核那份 `dist/decision-log-entry.js` 的常量从 2048 改成别的（或整个删掉这条读法）→
 *    同一条红；"读不到"这一支另有它的断言，不许把缺失当成通过。
 *  · 删掉 `mcp-shell/schemas` 里那份捆进发布物的副本 → 「捆进发布物的 schema 也是同一个数」红：
 *    那才是用户装到机器上的那份契约，`kernel/schemas` 只是被钉的语料。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, '..', '..')

/**
 * `mcp-shell/package.json` 声明的那一份内核——不是"机器上随便哪一份"。
 *
 * 按路径找而不是 `require.resolve('iterate-kernel/package.json')`：那份包的 `exports` 表没有
 * 暴露 `./package.json`（本机实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`），而这条闸要读的正是
 * `package.json` 与 `dist/**` 这些**没有对外声明**的文件——它量的是"发布物里有什么字节"，
 * 不是"能不能 import 到它"。npm 会把 workspace 的依赖提到根的 `node_modules`，两处都认。
 */
function installedKernelRoot() {
  const candidates = [
    path.join(REPO, 'node_modules', 'iterate-kernel'),
    path.join(REPO, 'mcp-shell', 'node_modules', 'iterate-kernel'),
  ]
  const found = candidates.filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
  assert.ok(found.length > 0,
    `这份检出里没有装好的 iterate-kernel（找过 ${candidates.join(' / ')}）——CI 每个泳道都在跑测试前 npm ci，`
    + '少了它这条闸量不到发布字节，红比"跳过"诚实')
  return found[0]
}

function readKernelValidatorConstant() {
  const file = path.join(installedKernelRoot(), 'dist', 'decision-log-entry.js')
  assert.ok(fs.existsSync(file), `装好的内核里没有 ${file}——这条闸读的是发布字节，缺席就是红，不是跳过`)
  const text = fs.readFileSync(file, 'utf8')
  const match = /export const SUMMARY_MAX_LENGTH = ([0-9]+);/.exec(text)
  assert.ok(match, `${file} 里读不到 ` + '`export const SUMMARY_MAX_LENGTH = <n>;`'
    + '——内核换了写法（或换掉了这个常量），Swift 与 schema 这两臂于是没有人核对了')
  return Number(match[1])
}

function schemaBound(file) {
  const root = JSON.parse(fs.readFileSync(file, 'utf8'))
  const summary = root?.properties?.summary
  assert.ok(summary && typeof summary.maxLength === 'number',
    `${file} 里没有 properties.summary.maxLength：契约换了形状，判据要跟着改而不是安静地比一个 undefined`)
  return summary.maxLength
}

test('前提：这份检出里真装着一份由 mcp-shell 精确声明的内核', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'mcp-shell', 'package.json'), 'utf8'))
  const declared = manifest.dependencies?.['iterate-kernel'] ?? manifest.devDependencies?.['iterate-kernel']
  assert.ok(declared, 'mcp-shell 不再声明 iterate-kernel——那这条闸的量法整个要重写')
  const installedVersion = JSON.parse(fs.readFileSync(path.join(installedKernelRoot(), 'package.json'), 'utf8')).version
  assert.equal(declared, installedVersion,
    `声明的是 ${declared}，装上的却是 ${installedVersion}：这条闸量到的字节不是发布物要捆的那一份`)
})

test('内核验证器执行的上限，就是被钉语料里写的那个上限', () => {
  const validator = readKernelValidatorConstant()
  const corpus = schemaBound(path.join(REPO, 'kernel', 'schemas', 'decision-log-entry.schema.json'))
  assert.equal(validator, corpus,
    `内核的 SUMMARY_MAX_LENGTH=${validator}，而 kernel/schemas 的 summary.maxLength=${corpus}`
    + '——同一个字段两个上限，Swift 侧收的那一条与内核拒的那一条就不是同一件事')
})

test('发布副本那一臂住在 `published-artifact.test.mjs`，这里不留一条量不到的断言', () => {
  // 本来这条闸还有一条"读 `mcp-shell/schemas/decision-log-entry.schema.json`"。搬走的原因是它
  // 与缺陷 83 同族：`mcp-shell/schemas` 是 `npm run bundle` 里 `bundle-kernel-schemas.mjs` 写的
  // **构建产物**，`git ls-files mcp-shell/schemas` 为空（本机实测），而 `npm test` 只跑
  // `npm run build`（tsc）——在这条闸的常驻泳道里那个目录根本不存在。留下来就是"只在某台机器上
  // 存在的字节被当成发布契约核对"，红与绿都不说明发布物。
  // 现在由 `published-artifact.test.mjs` 的「the packed artifact carries…」在**真 tarball**里读它：
  // 那条泳道跑过 `npm run bundle` + `npm pack`，量的是发出去的那份字节。这一条只钉住这个分工，
  // 免得下一位把断言又搬回来、在另一个泳道里造出一条永远量不到的臂。
  const bundled = path.join(REPO, 'mcp-shell', 'schemas', 'decision-log-entry.schema.json')
  const coveredElsewhere = fs.readFileSync(path.join(HERE, 'published-artifact.test.mjs'), 'utf8')
  assert.match(coveredElsewhere, /package\/schemas\/decision-log-entry\.schema\.json/,
    '捆进发布物那份 schema 的 maxLength 必须有人核对——它不在这里，也不许没有别人管')
  if (fs.existsSync(bundled)) {
    // 本机跑过 bundle 时顺手核一次：同一份内容的两个视图不许互相矛盾。
    assert.equal(schemaBound(bundled), readKernelValidatorConstant(),
      `${bundled} 与装好的内核验证器不同号（本机这份构建产物是陈的就得在这里现形）`)
  }
})

test('单位之争：zod 的 max 量 UTF-16 码元，所以内核那个数必须是偶数（Swift 的 emoji 夹具靠这条前提）', () => {
  const validator = readKernelValidatorConstant()
  assert.equal(validator % 2, 0, `SUMMARY_MAX_LENGTH=${validator} 不是偶数：`
    + '引擎侧的夹具按"一个 emoji = 2 个 UTF-16 码元"构造恰好在线/越界的两串，奇数会让那两条断言各说各话')
})
