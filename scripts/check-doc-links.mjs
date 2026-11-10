#!/usr/bin/env node
/**
 * 对外文档的死链与锚点检查（CI 门禁 = 本文件，退出码即判定）。
 *
 * 面向陌生读者的文档一旦改名/拆分就会留死链，而这只有真去点才会发现——所以把
 * "点一遍"变成机器动作。检查四类目标：
 *   1) 仓库内相对路径（含 specs/ 的中文文件名，需 URL 解码后比对磁盘）；
 *   2) 同文档/跨文档的 #锚点（按 GitHub 的标题 slug 规则就地复算）；
 *   3) 语言镜像对偶文件是否存在（README.md ↔ README.zh-CN.md 等成对约定）；
 *   4) 抄在文档里的**可复算主张**（版本线、钉住的 tag、CI 通道数、工具数、
 *      无障碍动作数、归因默认值）——既对真源核，也对另一语言那一侧核。
 *
 * (4) 是 2026-10-14 那轮文档审查补进来的。此前这道闸只问"对偶文件在不在"，
 * 于是 README 写 `weak` 而 SECURITY 写 `soft`、README 钉 v1.11.0 而 install.sh 钉
 * v1.14.1、两份 README 说 7 条 lane 而 ci.yml 有 9 个 job，全都绿着过闸——漂移的
 * 从来不是文件存在性，是句子。
 *
 * 外部 http(s) 链接只统计数量，不请求（CI 网络抖动不该红掉文档检查）。
 *
 * (5) 是 2026-10-22 补的第五类：**形状禁令**——对外文档里以命令形状给出的安装行不许是
 * `curl … | sh` 那条被实测证明会谎报成功的管道（判据与它的两个豁免面见 `pipedInstallCommands`）。
 * 它和 (4) 一样是"句子对不对"而不是"文件在不在"，只是这一条没有真源可比，只有实测过的形状。
 *
 * (6) 是 2026-10-29 补的第六类：`curl … -o <落点>` 的那个子命令不许是 world-writable 目录里的
 * 固定名字（判据见 `installLandingAudit`）——第五类管的是"结论拿不拿得到"，这一类管的是"拿得到
 * 结论的那一步会不会把别人的文件覆写了"。
 *
 * `--self-test` 是 2026-10-29 补的：这道闸有三条判据（失效锚点的解码、`~~~` 围栏、安装落点）都是
 * 只在"坏形状出现的那一天"才知道自己存不存在的，而它们此前只能靠人记得去手测。现在每一条都有一个
 * 合成夹具档，红与静各打一遍（`check-workflows.mjs` 用的是同一个契约）。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

/** 参与检查的对外文档；新增公共文档时在这里登记。 */
// The product lives in a vendored subtree, and its docs (README pair, docs/ pages,
// CHANGELOG/SECURITY) are as link-worthy as the repository's own. Listing them here
// means a dead link in the *product* README is the same red as one in ours — the
// private-ization moved the front door, and a front door with a broken link is still a
// broken front door.
const FORK_DOCS = [
  'harness/glasspane-harness/README.md',
  'harness/glasspane-harness/README.zh-CN.md',
  'harness/glasspane-harness/CHANGELOG.md',
  'harness/glasspane-harness/SECURITY.md',
  'harness/glasspane-harness/FORK.md',
  'harness/glasspane-harness/SYNCLOG.md',
  'harness/glasspane-harness/docs/index.md',
  'harness/glasspane-harness/docs/install.md',
  'harness/glasspane-harness/docs/tools.md',
  'harness/glasspane-harness/docs/evidence.md',
  'harness/glasspane-harness/docs/migrate-from-opencode.md',
  'harness/glasspane-harness/docs/troubleshooting.md',
  // 2026-10-19 登记：这三份是产品文档，却从没进过任何登记集合——它们内部的链接、锚点
  // 和双语对偶此前完全不在这道闸的视野里，而 `docs/index.md` 与两份 README 都链向它们。
  'harness/glasspane-harness/docs/models-and-keys.md',
  'harness/glasspane-harness/docs/release.md',
  'harness/glasspane-harness/docs/kernel-integration.md',
  // 尺子层自己的文档。它写的每一个数都声称可复算（金样条数、血缘计数、断言条数），
  // 却既不在死链集合也不在主张集合里——2026-10-19 那批数字漂移就是这么绿着过的。
  'harness/README.md',
  'harness/glasspane-harness/.github/pull_request_template.md',
  'harness/glasspane-harness/.github/ISSUE_TEMPLATE/bug-report.yml',
  'harness/glasspane-harness/.github/ISSUE_TEMPLATE/feature-request.yml',
]

const MAIN_DOCS = [
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'SECURITY.zh-CN.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING.zh-CN.md',
  'CHANGELOG.md',
  'ITERATE.md',
  // 2026-10-14 登记。这份是真机验收的 procedure，读者照着它核对断言——它写错一个
  // schemaVersion 就是一条必然假红的步骤，而从前它不在任何闸的视野里。
  'engine/smoke.md',
  '.github/pull_request_template.md',
  // 2026-10-22 登记：npm 包的三门面。`installer/package.json` 与 `mcp-shell/package.json` 的
  // `files` 里就写着 `README.md`——它是 `npm view` 页面与 tarball 里唯一的那份说明，用户装之前
  // 读的就是它。此前这三份既不在死链集合也不在残渣集合里，等于" front door 上的链接没人点过"，
  // 与本文件 28-32 行写的登记原则正好相反。（`updater/README.md` 的包是 private、没有 `files`
  // 清单，它随仓库树而不是 tarball 交付——登记它是因为它是 `node updater/cli.js` 那一面的门面，
  // 不是因为它是发布物。）
  //
  // 双语对偶这一头不存在要求：`MIRROR_PAIRS` 是一份**显式**清单，成对判据只遍历它列出的那些对
  // （见下面 `for (const [a, b] of MIRROR_PAIRS)`），把一份英文独有的文档加进 `MAIN_DOCS` 不会
  // 给它变出一个 `.zh-CN.md` 的要求。这三份就是英文独有，`claimDrift` 的双语核对同理只在
  // `MIRROR_PAIRS` 上做——加进 `MAIN_DOCS` 也仍然不参与。
  'installer/README.md',
  'mcp-shell/README.md',
  'updater/README.md',
]

export const DOCS = [...MAIN_DOCS, ...FORK_DOCS]

/**
 * 本闸**看得见、但本仓不许修**的缺陷——每一条都必须带齐四样，缺一样就不许进这张表：
 *   ① `problem`：与 `problems.push(…)` 逐字同形的完整一行（不是模式，模式会连别人的缺陷一起豁免）；
 *   ② `measured`：判据本身怎么量的（写命令与读数，不写"据说"）；
 *   ③ `owner` + `handedTo`：收件人存在且会跑——本仓有一条被反复咬过的教训：把发现降级成
 *      "交给另一条线"而那头没人接，等于一条有纸面记录的无闸；
 *   ④ 它会**自己过期**：下一次这一条不再发生时，本闸反过来红，点名"把这条豁免删掉"。
 *      没有这一半，豁免清单只会随时间变宽。
 *
 * 2026-11-05 唯一一条的来历：`slug()` 改成与 GitHub 自己的 `github-slugger@2.0.0` 同答
 * （逐枚空格换 `-`、不合并；本机 `npm i github-slugger` 实跑 `"License & attribution" ->
 * license--attribution`）之后才露出来的。那一行在 fork 的门面文档里，而本仓对 `harness/`
 * 有两条同时成立的纪律：不改它的内容（10:30 那条线独立任务、独立取号），以及
 * `release-artifact` 钉着"已发布 fork tag 的树 == 主干子树"——动一个字节就要那条线重新发号。
 * 所以归口，不在本仓修，也不把判据放宽回去（合并空格那道旧规则会把这一处与另外 15 处
 * 真死链一起重新藏起来：`README.zh-CN.md` 里 15 条双语锚点就是这么被藏住的，本轮已逐条改对）。
 *
 * 2026-11-06：那唯一一条 `harness-readme-license-anchor` 已由收件人那条线改掉——fork 的
 * `README.md` 把标题写成 `## License and attribution`（与 zh-CN 侧的「许可与署名」同形），
 * 实跑 `github-slugger@2.0.0 slug("License and attribution") == "license-and-attribution"`，
 * 链接同批改为 `(#license-and-attribution)`。本表因此清空。清空不等于通道退役：四样判据照旧
 * 成立，进来的每一条仍要每轮打印成 `△`、逐字匹配、并在不再发生时反过来红。
 */
export const DEFERRED_FINDINGS = []

/** 成对文档：任一侧缺失即漂移（双语约定不能只留一条腿）。 */
const MIRROR_PAIRS = [
  ['README.md', 'README.zh-CN.md'],
  ['harness/glasspane-harness/README.md', 'harness/glasspane-harness/README.zh-CN.md'],
  ['SECURITY.md', 'SECURITY.zh-CN.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md'],
]

/** GitHub 的标题 slug：小写、去标点、空格转连字符（保留 CJK 与 - _）。 */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    // 逐枚空格换 '-'，不合并：GitHub 的 slugger 用 `/\s/g → '-'`，两枚连续空格在它那儿是 `--`。
    // 从前这里用 `\s+`，同一个标题在两边算出两个锚——那条锚点判定就再也不是它声称的那一件（2026-11-04 候选 J）。
    .replace(/\s/g, '-')
}

/**
 * 收集一个 md 文件里所有标题锚点（含 GitHub 对重名标题的 -1/-2 后缀）。
 *
 * **围栏内的行不是标题。** 从前这里逐行匹配 `^#{1,6}\s+`，于是 README 的 bash 片段里
 * `# 1) One-liner`、`# 2) Through npm` 这类注释行被当成真标题：既造出 `1-one-liner` 这种
 * GitHub 上根本不存在的锚点（链接到它=假绿），又把 `-1/-2` 的去重编号往后错位（真标题
 * 的第二份本来该叫 `install-1`，被假标题占了号，链接到它就变成假红）。GitHub 的
 * slug 只在渲染后的正文里算，围栏里的行从来不参与——这里跟着它走。
 */
export function headingsOf(text) {
  const seen = new Map()
  const out = new Set()
  let fence = null
  for (const line of text.split('\n')) {
    const wasOpen = fence !== null
    fence = fenceAfter(line, fence)
    if (wasOpen) continue
    if (fence !== null) {
      // 这一行开了栏（或还在栏里）：围栏里的行不参与 GitHub 的锚点，跟着它走。
      continue
    }
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!m) continue
    const title = m[2].replace(/\s+#+\s*$/, '')
    let base = slug(title)
    if (!base) continue
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.add(n === 0 ? base : `${base}-${n}`)
  }
  return out
}

function read(rel, rootDir = ROOT) {
  return fs.readFileSync(path.join(rootDir, rel), 'utf8')
}

/**
 * 百分号解码，但**不许它把整条闸带走**（S10-3，2026-10-29）。
 *
 * WHY。`decodeURIComponent` 对一个裸 `%`（散文里"50%"这种写法，或者手写的 `#funds-50%-covered`
 * 锚点）抛的是 URIError，而它被调在文档循环的正中间：一处编码问题让这道闸带着栈退出，
 * 剩下的文档、全部主张核对与全部表格形状那一轮**一条都没跑**——本仓的规矩是"一条拒该是
 * 一句话，不是一个栈"（2026-10-28 的 check-kernel-corpus `--record` 修复写的就是这条）。
 * 现在解码失败本身是一条具名问题，原始字符串继续参与能判的部分，其余文档照常过闸。
 */
function decodeRef(raw) {
  try {
    return { value: decodeURIComponent(raw), problem: null }
  } catch {
    return { value: raw, problem: '含裸 %（`%` 后面不是两位十六进制；要写成 %25）' }
  }
}

/**
 * 围栏行。``` 与 ~~~ 都算开栏，闭合栏必须是同一种字符且不更短，且闭合行不许带 info string。
 *
 * 这一个是**状态机**而不是布尔判据，因为它有三个读者（`headingsOf`、`shellResidue`、
 * `markdownTableProblems`），而布尔版本（旧的 `isFenceLine`：`/^\s*(?:```|~~~)/` 一行翻一次面）
 * 对其中两个读者是错的：它不记是哪一种字符开的、不记长度、也不管缩进，于是文档里任何一枚
 * 落单的围栏行——最常见的来源是**缩进 ≥4 空格的代码块里恰好有一行 ``` 开头**——会把之后的
 * 整篇读成"在围栏里"，那篇文档余下的行**一条都不再被判**。这不是假想的形状：本轮量到
 * `harness/glasspane-harness/SYNCLOG.md` 里就有缩进代码块，而 `headingsOf` 一直用的是
 * CommonMark 那一套（`^\s{0,3}` + 同种字符 + 不更短），两边从来不是同一个式子。
 * 注释里那句"三个读者共用一个式子"（S10-5 写的）因此是被否证的主张，本次一并改成真的。
 */
export const FENCE_MARKER = /^\s{0,3}(`{3,}|~{3,})(.*)$/

/**
 * @param line 一行正文
 * @param open 当前打开的围栏标记（null 表示不在围栏里）
 * @returns 下一状态：仍是标记串，或回到 null
 */
export function fenceAfter(line, open) {
  const m = FENCE_MARKER.exec(line)
  if (open === null) return m ? m[1] : null
  if (m && m[1][0] === open[0] && m[1].length >= open.length && m[2].trim() === '') return null
  return open
}

/**
 * 把一行的**正文**取出来：成对的行内代码段（`` `x` ``、`` ``x`` ``）剥掉，替换成一枚空格——
 * 不留空是因为粘起来会造出假形状（`` `tar -tzf` 与 `grep -c` `` 剥成空格后若不留位，就拼成
 * 一条"命令 + 竖线 + 命令"的管道，读起来像残渣）。
 *
 * **按行配对，不跨行传状态**：CommonMark 的行内代码可以跨软换行，于是"这一段里有一枚落单的
 * 反引号"（散文里当引号用、或写 ` 时忘了配对）会让跨行状态在**整段**里翻转——本轮实测踩到过：
 * `updater/README.md` 一段六行的项目符号里一处配对错位，把下一行的中文正文整段当成"在代码段里"
 * 剥掉，只剩 `NODE_EXTRA_CA_CERTS` 一枚，残渣闸于是报"正文里有一行恰好是一枚全大写标记"——
 * 一道为了消灭假绿而加的闸，自己造出一条假红。跨行状态还同时会**造出假绿**（真正贴进正文的
 * 语句被当成代码剥掉），所以这里退回按行配对：落单的反引号留在正文里，不翻转任何状态。
 */
export function proseOf(line) {
  return line.replace(/(`+)([\s\S]*?)\1/g, ' ').trim()
}

/** 从 mcp-shell 源码里数出真实工具数（不依赖构建产物）。 */
function realToolCount(rootDir = ROOT) {
  const src = path.join(rootDir, 'mcp-shell', 'src', 'tools.ts')
  if (!fs.existsSync(src)) return null
  return (fs.readFileSync(src, 'utf8').match(/^\s*name:\s*"gp_[a-z_]+",/gm) ?? []).length
}

/**
 * 接受 `dimension` 的工具数——两侧各数一遍，**只有两边相等才算真源**。
 *
 * 这句话在 README 里写的是"每一面各有 5 项，而且是同五项"，它有两半：数量，和对称。
 * 只数一侧的判据会把"不对称"读成一个数字，而不对称正是这条集成最不该悄悄发生的事。
 * 两边不等时返回 null，让上层报"真源读不到（形状已漂移）"——那不是"没量到"，是量到了不一致。
 */
function dimensionToolCount(rootDir = ROOT) {
  const shell = path.join(rootDir, 'mcp-shell', 'src', 'tools.ts')
  const fork = path.join(
    rootDir,
    'harness', 'glasspane-harness', 'packages', 'opencode', 'src', 'tool', 'glasspane', 'index.ts',
  )
  if (!fs.existsSync(shell) || !fs.existsSync(fork)) return null
  const shellCount = (fs.readFileSync(shell, 'utf8').match(/dimension:\s*OptionalDimensionSchema/g) ?? []).length
  const forkCount = (fs.readFileSync(fork, 'utf8').match(/^\s*dimension: DimensionArg,/gm) ?? []).length
  return shellCount === forkCount ? shellCount : null
}

/**
 * 扫描文档中"\d+ (MCP|个) tools/工具"式表述，与真实数量比对。
 * `docs`/`rootDir` 可注入，是为了让这条判据的两个方向都能被测试证红（见
 * `updater/test/scripts-check-doc-links.test.mjs`）：主仓写错数必须红，fork 文档里的
 * 另一个数不许红——后者若被并回扫描集合，main 会因为别人文档里一句真话而恒红。
 */
export function toolCountDrift({ docs = MAIN_DOCS, rootDir = ROOT } = {}) {
  const real = realToolCount(rootDir)
  if (real === null) return ['无法从 mcp-shell/src/tools.ts 数出工具数量']
  const out = []
  const pattern = /(\d+)\s*(?:MCP tools|`gp_\*` MCP tools|个 MCP 工具|个 `gp_\*`|个工具)/g
  // 只对主仓文档判这道口径：`realToolCount()` 数的是 `glasspane-mcp` 对外的 `gp_*` 工具，
  // 而 fork 自己那 6 个 `gp_*` 是 opencode 的 tool id（harness/…/SYNCLOG.md:107 那句
  // "`/experimental/tool/ids` 实测 20 个 id 含全部 6 个 `gp_*`" 说的就是它，而且那个数字是
  // 上游一次真实响应，不是抄来的主张）。把主仓的数量断言套到 fork 文档上，等于要求两份互不
  // 相干的 surfaces 报同一个数——2026-10-13 0.7.8 那笔文档提交进来之后，这道闸就是这样在
  // main 上恒红的，而红的原因不是任何人写错了数字。
  for (const doc of docs.filter((d) => fs.existsSync(path.join(rootDir, d)))) {
    const text = read(doc, rootDir)
    for (const m of text.matchAll(pattern)) {
      if (m[0].includes('gp_act') || m[0].includes('动词')) continue
      if (Number(m[1]) !== real) {
        out.push(`${doc}: 写了 ${m[1]} 个工具，代码里实际是 ${real} 个（原句 "${m[0]}"）`)
      }
    }
  }
  return out
}

/**
 * 真源侧的可复算量：每一个都是一行能跑的读取，不是注释里的"应该等于"。
 */

/** `.github/workflows/ci.yml` 里 `jobs:` 下的顶层 job 数（不含 `on:` 的 `push:`）。 */
function ciLaneCount(rootDir = ROOT) {
  const file = path.join(rootDir, '.github', 'workflows', 'ci.yml')
  if (!fs.existsSync(file)) return null
  let count = 0
  let inJobs = false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue }
    if (inJobs && /^[^\s#]/.test(line)) inJobs = false
    if (inJobs && /^ {2}\S[^:]*:\s*$/.test(line)) count += 1
  }
  return count
}

/** `gp_act` 能执行的无障碍动作数——真源是契约层那份**已发布并被 pin 的** JSON Schema
 * (`kernel/schemas/evidence-pack.schema.json` 的 `properties.signals.properties.act.properties.action.enum`，
 * 与 `contracts/kernel-pin.json` 逐文件核过字节)，不是文档里那句枚举，也不是 mcp-shell 里那份由它
 * 派生的输入 schema。读 TS 源码那一版跟着 `kernel/src` 一起退场了：仓里的镜像代码没有任何出处
 * 记录，而这份 schema 有。路径读不到、或读到的不是非空数组，一律返回 null——那条主张会报"读不出"，
 * 不许拿一个猜的数字当答案。 */
function actionCount(rootDir = ROOT) {
  const file = path.join(rootDir, 'kernel', 'schemas', 'evidence-pack.schema.json')
  if (!fs.existsSync(file)) return null
  try {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'))
    const values = schema?.properties?.signals?.properties?.act?.properties?.action?.enum
    if (!Array.isArray(values) || values.length === 0) return null
    return values.length
  } catch {
    return null
  }
}

/** `install.sh` 钉住的发布 tag（去掉前导 `v`）。 */
function installPinnedTag(rootDir = ROOT) {
  const file = path.join(rootDir, 'install.sh')
  if (!fs.existsSync(file)) return null
  const hits = [...fs.readFileSync(file, 'utf8').matchAll(/GLASSPANE_RELEASE="v([^"]+)"/g)]
  return hits.length === 1 ? hits[0][1] : null
}

/**
 * 预检真的去问主机的那几个命令。真源 = `installer/cli.js` 里那个数组字面量的长度，
 * 而不是文档里那句数量。
 *
 * 从前没有这一条读者，于是 `README.md` 写 "four of these rows"、`README.zh-CN.md` 写
 * "只实测这张表里的四项"，而那张表一共五行、代码探的是五项命令：三个数字各说各话，
 * 两份文档一起错也没人核（同一段里还紧跟着"这五项"，自相矛盾就在下一行）。
 * 数组读不到就返回 null，`claimDrift` 会把"有文档在写它却读不到真源"报出来。
 */
export function preflightProbedCommands(rootDir = ROOT) {
  const file = path.join(rootDir, 'installer', 'cli.js')
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const m = /export const PREFLIGHT_PROBED_COMMANDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(text)
  if (!m) return null
  return m[1]
    .split(',')
    .map((token) => token.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter(Boolean)
}

function preflightProbeCount(rootDir = ROOT) {
  return preflightProbedCommands(rootDir)?.length ?? null
}

/** 当前版本线（`major.minor`），真源 = 根 `package.json` 的 `version`。 */function currentLine(rootDir = ROOT) {
  const file = path.join(rootDir, 'package.json')
  if (!fs.existsSync(file)) return null
  const version = JSON.parse(fs.readFileSync(file, 'utf8')).version
  const m = /^(\d+)\.(\d+)\./.exec(version ?? '')
  return m ? `${m[1]}.${m[2]}` : null
}

/** 归因默认值：`contaminated ? .weak : .soft` 里的**否分支**才是没污染时的默认。 */
function attributionDefault(rootDir = ROOT) {
  const file = path.join(rootDir, 'engine', 'Sources', 'GlassPaneEngine', 'EngineCore.swift')
  if (!fs.existsSync(file)) return null
  const m = /contaminated\s*\?\s*\.(\w+)\s*:\s*\.(\w+)/.exec(fs.readFileSync(file, 'utf8'))
  return m ? m[2] : null
}

/** 数字写作式：`7`、`seven`、`七`、`二十七` 都归一成整数；读不懂返回 null。 */
const EN_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
}
const ZH_WORDS = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20,
}

function parseCount(token) {
  if (/^\d+$/.test(token)) return Number(token)
  const lower = token.toLowerCase()
  if (lower in EN_WORDS) return EN_WORDS[lower]
  if (token in ZH_WORDS) return ZH_WORDS[token]
  return null
}

/**
 * 抽取式里共用的"一个数量"记法：阿拉伯数字、英文单词、中文数字都算。
 *
 * **`one` 与 `一` 不在里面**，这是刻意的：中文的"一个无障碍动作"和英文的 "one accessibility
 * action" 绝大多数是冠词/量词用法（"执行其中一个动作"），不是计数主张。把它们当数抓，
 * 判据就会把一句正常的话报成"写了 1 个，真源是 7"——假红多了，真红就没人信了。
 * 真要写"只有 1 个"，写阿拉伯数字，那条一直抓得到。
 */
const NUMBER = '\\d+|[二三四五六七八九十][一二三四五六七八九十]{0,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty'
/** 反引号（Markdown 的行内代码）在正则字面量里不用转义，但在 new RegExp 的模板里要用变量带入。 */
const TICK = String.raw`\x60`

/**
 * 尺子层文档里的可复算量。真源全部是**另一份文件**，不是这句话本身：
 * 内核版本与随包语料条数读 fork 的出处清单，血缘两条读 brand-surface 的金样。
 * 这一族主张原先没有读者——`harness/README.md` 当时连扫描集合都不在，于是它写
 * `iterate-kernel@0.1.6`（真源 0.1.8）、"随包 24 个契约文件"（真源 26）、"225 条断言"
 * （尺子今天报 6351）、"当前 9,618 处 / 3,309 文件"（同一句上半段刚写完 9,646/3,312），
 * 四条全是绿的。`FORK.md` 那两句"依赖 `iterate-kernel@0.1.5`"也一样。
 */
function kernelPinManifest(rootDir = ROOT) {
  const file = path.join(rootDir, 'harness', 'glasspane-harness', 'contracts', 'kernel-pin.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
function kernelPinVersion(rootDir = ROOT) {
  return kernelPinManifest(rootDir)?.version ?? null
}
function kernelCorpusCount(rootDir = ROOT) {
  const corpus = kernelPinManifest(rootDir)?.corpus
  if (!corpus) return null
  return Array.isArray(corpus) ? corpus.length : Object.keys(corpus).length
}
function kernelConformanceStamp(rootDir = ROOT) {
  const file = path.join(rootDir, 'harness', 'glasspane-harness', 'contracts', 'kernel-conformance.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.kernel?.version ?? null
  } catch {
    return null
  }
}
function brandSurfaceGolden(rootDir = ROOT) {
  const file = path.join(rootDir, 'harness', 'contracts', 'brand-surface.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
function lineageOccurrences(rootDir = ROOT) {
  return brandSurfaceGolden(rootDir)?.lineage?.occurrences ?? null
}
function lineageFilesScanned(rootDir = ROOT) {
  return brandSurfaceGolden(rootDir)?.lineage?.filesScanned ?? null
}

/** `1,234` 这种带千分位的写法：`parseCount` 只认裸数字，这里先去分隔符。 */
const countToken = (token) => String(Number(String(token).replace(/[,\s]/g, '')))

/**
 * 可复算主张登记表。每条给：两侧的抽取式（`en` 用于 `*.md`，`zh` 用于 `*.zh-CN.md`）、
 * 真源读取 `truth(rootDir)`（返回 null = 读不到）、以及人话单位。抽取式一律带 `g`，
 * 命中即把原句一起报出来——改文档的人要能在报错里看见自己动的那一句。
 *
 * 抽取式刻意窄：宁可不抓，也不许把不相干的句子当成主张（限定词 `accessibility`/`无障碍`
 * 是必须的，"个工具"只在带 `MCP`/`gp_*` 时才认，中文的"条"只在带 lane/通道/泳道/job 时才认）。
 * 捕获组 #1 恒为"那个值"。
 *
 * `only`：这条主张认哪几份文件。同一个数字形状在两份文档里说的是两件事实——
 * `harness/README.md` 里那句 `git clone --branch v1.18.32` 钉的是**上游参照检出**，
 * 而"README 钉住的发布 tag"的真源是主仓 `install.sh` 里的产品发布号；把它套到尺子文档上
 * 就是一句真话被判红（0.7.8 那轮的恒红正是这个形状）。集合外的文件一律不扫。
 */
export const CLAIMS = [
  {
    id: '对外工具数',
    en: new RegExp(`(${NUMBER})\\s+(?:${TICK}gp_\\*${TICK}\\s+)?MCP tools`, 'gi'),
    zh: new RegExp(`(${NUMBER})\\s*个\\s*(?:MCP 工具|${TICK}gp_\\*${TICK})`, 'g'),
    unit: '个工具',
    truth: realToolCount,
  },
  {
    id: '接受 dimension 的工具数',
    // README 的那句话是"每一面各有 5 项工具接受可选的 `dimension`，而且是同五项"——数量与对称一起写。
    // 两个方向各自认自己的写法；真源是两份源码，不是这句句子。
    en: new RegExp(`(${NUMBER})\\s+${TICK}gp_\\*${TICK} tools take an optional ${TICK}dimension${TICK}`, 'gi'),
    zh: new RegExp(`每一面各有\\s*(${NUMBER})\\s*项工具接受可选的\\s*${TICK}dimension${TICK}`, 'g'),
    unit: '项接受 dimension 的工具',
    truth: dimensionToolCount,
    only: ['README.md', 'README.zh-CN.md'],
  },
  {
    id: 'CI 通道数',
    en: new RegExp(`(${NUMBER})\\s+(?:CI\\s+)?(?:lanes?|jobs?)\\b`, 'gi'),
    zh: new RegExp(`(${NUMBER})\\s*条\\s*(?:CI\\s*)?(?:lane|通道|泳道|job)`, 'g'),
    unit: '条 CI 通道',
    truth: ciLaneCount,
  },
  {
    id: '无障碍动作数',
    en: new RegExp(`(${NUMBER})\\s+accessibility\\s+(?:verbs?|actions?)\\b`, 'gi'),
    zh: new RegExp(`(${NUMBER})\\s*个\\s*无障碍\\s*(?:动词|动作)`, 'g'),
    unit: '个无障碍动作',
    truth: actionCount,
  },
  {
    id: '归因默认值',
    // 认三种真实出现过的写法：英文的 `${TICK}soft${TICK} by default`、中文的 `默认 ${TICK}soft${TICK}`、
    // 真机断言里的 `attribution.level="soft"`（`engine/smoke.md` 第 6 行就是第三种）。
    // **只认"等级词在 by default 之前"那一种语序**：这句后面常跟着"`strong` only when…"，
    // 若允许等级词跟在 by default 之后，那条正确的补充说明会被读成默认值，判据就假红了。
    en: new RegExp(`${TICK}?(weak|soft|strong)${TICK}?\\s+by default\\b|attribution\\.level="(weak|soft|strong)"`, 'gi'),
    zh: new RegExp(`默认\\s*${TICK}?(weak|soft|strong)${TICK}?`, 'g'),
    unit: '归因默认等级',
    truth: attributionDefault,
    norm: (token) => token,
  },
  {
    id: 'README 钉住的发布 tag',
    // 两种语言里这一行都是同一条英文命令，抽取式共用。
    en: /git clone --branch v?(\d+\.\d+\.\d+)/g,
    zh: /git clone --branch v?(\d+\.\d+\.\d+)/g,
    unit: '钉住的 tag',
    truth: installPinnedTag,
    norm: (token) => token,
    // 主仓 `install.sh` 钉的是**本产品**的发布号。尺子文档里那句
    // `git clone --branch v1.18.32` 钉的是**上游参照检出**——两个不同的事实同一个数字形状，
    // 套上去就是一句真话被判红（0.7.8 那轮的恒红正是这个形状）。
    only: ['README.md', 'README.zh-CN.md'],
  },
  {
    id: '当前版本线',
    en: /\|\s*(\d+\.\d+)\.x\s*\|[^|\n]*(?:current|security fixes)/gi,
    zh: /\|\s*(\d+\.\d+)\.x\s*\|[^|\n]*(?:当前|安全修复)/g,
    unit: '当前版本线',
    truth: currentLine,
    norm: (token) => token,
  },
  {
    id: '预检实测的命令数',
    // 认的是那一句里带粗体的数量；同一段落里还有一句"the commands it does probe"/"它确实探测的
    // 这五个命令"没带粗体，那是同一个事实的散文复述，不该被当成第二个可复算主张去钉。
    en: new RegExp(`\\bchecks \\*\\*(${NUMBER})\\s+commands?\\*\\*`, 'gi'),
    zh: new RegExp(`一共实测\\*\\*(${NUMBER})\\s*个命令\\*\\*`, 'g'),
    unit: '个预检命令',
    truth: preflightProbeCount,
    only: ['README.md', 'README.zh-CN.md'],
  },
  {
    id: '内核 pin 版本',
    en: /今天以 \*\*registry 依赖\*\* \x60iterate-kernel@(\d+\.\d+\.\d+)\x60/g,
    zh: /今天以 \*\*registry 依赖\*\* \x60iterate-kernel@(\d+\.\d+\.\d+)\x60/g,
    unit: 'iterate-kernel 版本',
    truth: kernelPinVersion,
    norm: (token) => token,
    only: ['harness/README.md'],
  },
  {
    id: '内核语料出处戳记',
    // 这一句过去引的是 `"version": "0.1.9"` / pin `0.1.10` 一对具体数字，用来说明"戳记不是判据"。
    // 那对数字早已不成立（字段真名是 kernel.version，2026-11-10 实测 0.1.12），而当时没有任何
    // 判据认得这句话，于是它带着两个过期版本号绿了很久。现在数字本身被钉住：真源取金样自己的
    // kernel.version，不是 pin —— 戳记允许落后于 pin，落后的说明由正文承担，数字不许说谎。
    en: /\x60kernel\.version\x60 provenance stamp of \x60(\d+\.\d+\.\d+)\x60/g,
    zh: /\x60kernel\.version\x60 provenance stamp of \x60(\d+\.\d+\.\d+)\x60/g,
    unit: '内核语料出处戳记',
    truth: kernelConformanceStamp,
    norm: (token) => token,
    only: ['harness/glasspane-harness/docs/kernel-integration.md'],
  },
  {
    id: '随包契约语料条数',
    en: /随包 (\d+) 个契约文件/g,
    zh: /随包 (\d+) 个契约文件/g,
    unit: '个契约文件',
    truth: kernelCorpusCount,
    only: ['harness/README.md'],
  },
  {
    id: '血缘处数',
    en: /本轮复记 ([\d,]+) 处/g,
    zh: /本轮复记 ([\d,]+) 处/g,
    unit: '处血缘',
    truth: lineageOccurrences,
    norm: countToken,
    only: ['harness/README.md'],
  },
  {
    id: '血缘扫描文件数',
    // 带 present 标记那一句。`harness/README.md` 同一行里还有一句"2026-10-16 复记 9,646 处 /
    // 3,312 文件"——那是**历史读数**，拿今天的真源去要求它等于要求历史改写自己（`CHANGELOG.md`
    // 不进这个集合是同一个理由）。上一版这里没有前置词，于是它判红的正是那句真话。
    en: /本轮复记 [\d,]+ 处 \/ ([\d,]+) 文件/g,
    zh: /本轮复记 [\d,]+ 处 \/ ([\d,]+) 文件/g,
    unit: '个被扫文件',
    truth: lineageFilesScanned,
    norm: countToken,
    only: ['harness/README.md'],
  },
]

/** 主张判据扫描的文档集合。**`CHANGELOG.md` 不在里面**：那是按版本落的账本，
 * 每一行记的都是"当时那一版量到的数"，拿今天的真源去要求它，等于要求历史改写自己。 */
const CLAIM_DOCS = [
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'SECURITY.zh-CN.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING.zh-CN.md',
  'ITERATE.md',
  'engine/smoke.md',
  'harness/README.md',
  // 这一页的可复算主张此前完全没有判据：它引用的一对内核版本号过期后照样绿（见「内核语料出处戳记」）。
  // 链接与锚点一直在扫它（FORK_DOCS），主张这一面却漏了——两个集合不是同一个。
  'harness/glasspane-harness/docs/kernel-integration.md',
]

const isZhDoc = (doc) => doc.endsWith('.zh-CN.md')

/** 从一条命中里取出"那个值"：捕获组 #1，没有就取 #2（`归因默认值` 那条有两个分支）。 */
function claimValue(claim, match) {
  const token = match[1] ?? match[2] ?? null
  if (token === null) return null
  if (claim.norm) return claim.norm(token)
  const n = parseCount(token)
  return n === null ? null : String(n)
}

/**
 * 可复算主张的双语一致性 + 对真源一致性。
 *
 * 两条判据各有各的失效面，都要：
 *   - **对真源**：README 写 `weak` 而引擎写 `.soft`，两份 README 一起错也照样是错；
 *   - **对另一语言**：只改一种语言的那一句（本轮 2/3/8 号的形状）——真源读得到时两条都红，
 *     真源读不到时（跨仓库、缺文件）这一条还站着。
 */
export function claimDrift({ docs = CLAIM_DOCS, rootDir = ROOT } = {}) {
  const out = []
  const found = new Map() // claim id → doc → [{value, raw}]
  for (const claim of CLAIMS) {
    const per = new Map()
    let truth = null
    try {
      truth = claim.truth ? String(claim.truth(rootDir)) : null
    } catch {
      truth = null
    }
    if (truth === 'null' || truth === 'undefined') truth = null
    for (const doc of docs.filter((d) => fs.existsSync(path.join(rootDir, d)) && (!claim.only || claim.only.includes(d)))) {
      const text = read(doc, rootDir)
      const pattern = isZhDoc(doc) ? claim.zh : claim.en
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
      const hits = []
      for (const m of text.matchAll(re)) {
        const value = claimValue(claim, m)
        if (value === null) continue
        hits.push({ value, raw: m[0].trim().replace(/\s+/g, ' ') })
      }
      if (hits.length) per.set(doc, hits)
      if (truth !== null) {
        for (const h of hits) {
          if (h.value !== truth) {
            out.push(`${doc}: 「${claim.id}」写了 ${h.value}（${claim.unit}），真源是 ${truth} —— 原句 "${h.raw}"`)
          }
        }
      }
    }
    found.set(claim.id, per)
    // 有主张却没有真源＝这道闸今天什么都没能核对。写出来，别让它变成"绿着但没人看"。
    if (truth === null && per.size > 0) {
      out.push(`「${claim.id}」有 ${per.size} 份文档在写它，但真源读不到（文件缺失或形状已漂移）——无法核对`)
    }
  }

  // 双语一致性：同一条主张在对偶文件里必须报同一个值。只在**两侧都写了**这条主张时比对，
  // 否则"另一种语言本来没这句"会变成噪音。
  for (const [a, b] of MIRROR_PAIRS) {
    if (!MAIN_DOCS.includes(a)) continue
    for (const claim of CLAIMS) {
      const per = found.get(claim.id)
      const left = per.get(a)
      const right = per.get(b)
      if (!left || !right) continue
      const values = (hits) => [...new Set(hits.map((h) => h.value))].sort()
      const lv = values(left)
      const rv = values(right)
      if (lv.join('/') !== rv.join('/')) {
        out.push(`双语漂移「${claim.id}」：${a} 写 ${lv.join('/')}，${b} 写 ${rv.join('/')}（原句 "${left[0].raw}" / "${right[0].raw}"）`)
      }
    }
  }
  return out
}

/**
 * 尺子层自己的出处指针必须指向树里真有的文件。
 *
 * WHY。这道闸走的是"对外文档"，`harness/contracts/*.json` 与 `harness/tools/*.mjs` 从来不在它
 * 的视野里——于是占比闸的 `limitSource` 指着 `specs/GlassPane_Design_Decisions.md`（该文件不存在，
 * 26 份 specs 里没有一个这么命名）一路绿到 2026-10-19。一条闸的"我按哪条律量的"是它的出处；
 * 出处指向空气，读的人就无从复核它量的是不是那条律。金样是机器可读的，这一条判据也必须是。
 *
 * 解析按三个根试：仓根、fork 根、指针所在文件自己的目录——`docs/release.md` 这种相对写法
 * 在 fork 树里是对的，拿仓根去判就是假红。
 */
export function rulerProvenance({ rootDir = ROOT } = {}) {
  const out = []
  const contractDir = path.join(rootDir, 'harness', 'contracts')
  const toolsDir = path.join(rootDir, 'harness', 'tools')
  if (!fs.existsSync(contractDir) && !fs.existsSync(toolsDir)) {
    return ['harness/contracts 与 harness/tools 都读不到——尺子出处的这道判据今天什么都没核（未观测，不是通过）']
  }
  const files = []
  for (const [dir, suffix] of [[contractDir, '.json'], [toolsDir, '.mjs']]) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir).sort()) if (f.endsWith(suffix)) files.push(path.relative(rootDir, path.join(dir, f)))
  }
  // Provenance is a *field*, not a substring hunt. The goldens also carry DATA: `fork-diff.json`
  // holds the `deleted` bucket, whose whole purpose is naming upstream `.md` files that are gone
  // from this tree. Matching those reported 222 "broken pointers" on the first run — the golden
  // answering correctly about upstream's deletions. So: walk the parsed JSON, and check only the
  // values under keys that state where a rule comes from. Code files are scanned in full, because
  // there the same path shapes only appear in comments and string constants.
  const PROVENANCE_KEYS = /^(limitsource|source|sourceoftruth|whyrule|why|provenance|docs|canonical|caliber|note|reason|rule|law)$/i
  const PATHISH = /(?:specs|harness|docs|engine|scripts|kernel|updater|bridge|installer|mcp-shell|packages)\/[\w./()-]*?\.(?:md|json)(?![\w-])/g
  const forkRoot = path.join(rootDir, 'harness', 'glasspane-harness')
  const missing = (target, fromRel) => {
    const candidates = [path.join(rootDir, target), path.join(forkRoot, target), path.join(path.dirname(path.join(rootDir, fromRel)), target)]
    return !candidates.some((c) => fs.existsSync(c))
  }
  const report = (rel, text) => {
    for (const m of text.matchAll(PATHISH)) {
      if (missing(m[0], rel)) out.push(`${rel}: 出处指向 ${m[0]}，三个根下都没有这个文件——被指着的那一侧无人校验它，而这条闸的"我按什么量的"从此无法复核`)
    }
  }
  const walkJson = (rel, node, keyName) => {
    if (typeof node === 'string') {
      if (keyName && PROVENANCE_KEYS.test(keyName)) report(rel, node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walkJson(rel, item, keyName)
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walkJson(rel, v, k)
    }
  }
  for (const rel of files) {
    const abs = path.join(rootDir, rel)
    let text
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      out.push(`${rel}: 登记在尺子层里却读不出来`)
      continue
    }
    if (rel.endsWith('.json')) {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        out.push(`${rel}: 金样不是合法 JSON，出处判据无法在它上运行（这不是通过）`)
        continue
      }
      walkJson(rel, parsed, null)
    } else {
      report(rel, text)
    }
  }
  return out
}

export function check({ rootDir = ROOT, docs = DOCS, deferredFindings = DEFERRED_FINDINGS } = {}) {
  const problems = []
  const advisories = []
  const deferredHit = new Set()
  const present = docs.filter((d) => fs.existsSync(path.join(rootDir, d)))
  // 登记过却不在磁盘上的文档是**问题**，不是"本轮不归它管"。从前各支各自 `existsSync` 过滤，
  // 于是把一份文档（或整个 MAIN_DOCS）改名/删掉，这条闸会打出 `文档 0 份 … OK` 并退 0——
  // 零条用例通过正是本仓已经栽过两次的那个形状。
  for (const doc of docs) {
    if (!fs.existsSync(path.join(rootDir, doc))) {
      problems.push(`${doc} 登记在 DOCS 里但磁盘上没有：恢复它，或把它从登记表里删掉；让它躲在 existsSync 过滤器后面，这条闸就退化成一份它不再检查任何东西的清单`)
    }
  }
  if (present.length === 0) {
    problems.push(`DOCS 的 ${docs.length} 份登记一份都不在磁盘上：这条闸什么都量不到，不许算通过`)
  }
  const anchors = new Map(present.map((d) => [d, headingsOf(read(d, rootDir))]))
  // 锚点缓存：登记过的文档用 `anchors`，没登记的按需再算一次（见下面跨文档那一支）。
  const anchorCache = new Map()

  // 文档里抄写的工具数量必须等于代码里的真实数量：README 用"15 个工具"这种说法
  // 是好意（读者不必自己数），但手抄数字必然漂移，所以让它可验证。
  problems.push(...toolCountDrift({ rootDir }))
  // shell 残渣：本轮被同一形状中招两次（见 `shellResidue` 的注释），所以它进主检查而不只是测试。
  problems.push(...shellResidue({ rootDir, docs }))
  // 安装渠道：对外给出的那条一键命令必须是拿得到退出码的那一种写法（判据见 `pipedInstallCommands`）。
  problems.push(...pipedInstallCommands({ rootDir }))
  // 落点：两步写法自己不许把脚本落在 world-writable 目录的一个固定名字上（判据见 `installLandingAudit`）。
  problems.push(...installLandingProblems({ rootDir }))
  advisories.push(...installLandingAdvisories({ rootDir }))
  // 可复算主张：对真源核一遍，再对另一语言核一遍。缺了这一步，"双语成对完整"只意味着
  // 文件都在，不意味着两份话说的是同一件事。
  problems.push(...claimDrift({ rootDir }))
  // 尺子层自己的出处指针。它不在"对外文档"集合里，所以从前坏了也没人看。
  problems.push(...rulerProvenance({ rootDir }))
  // markdown 表格形状（全仓 markdown，不只是 DOCS 登记表；判据见 `markdownTableProblems`）。
  const shape = markdownTableProblems({ rootDir })
  problems.push(...shape.problems)

  for (const [a, b] of MIRROR_PAIRS) {
    const ea = fs.existsSync(path.join(rootDir, a))
    const eb = fs.existsSync(path.join(rootDir, b))
    if (ea !== eb) problems.push(`${a} 与 ${b} 只有一侧存在（双语约定缺腿）`)
  }

  let links = 0
  let external = 0
  for (const doc of present) {
    const text = read(doc, rootDir)
    // 代码块里的相对路径**照旧检查**。从前这里算过一个 `codeFences` 集合，算完没人
    // 读——一个"声称豁免、其实没豁免"的计算比没有更坏，因为它让下一个人以为围栏内
    // 是安全的。安装片段里抄错的路径也是抄错的路径。
    for (const m of text.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g)) {
      const url = m[1]
      if (url.startsWith('mailto:')) continue
      if (/^https?:\/\//.test(url)) { external += 1; continue }
      links += 1
      const [rawTarget, rawAnchor] = url.split('#')
      // 解码失败是一句话，不是一个栈（见 `decodeRef`）。坏掉的那一条本轮不判存在性——
      // 拿一个解不开的字符串去比对磁盘或锚点集，报出来的红只会把读者的注意力从"这里有个裸 %"
      // 引到"这个文件不存在"上去。
      const decodedTarget = decodeRef(rawTarget)
      if (decodedTarget.problem) {
        problems.push(`${doc}: 链接目标${decodedTarget.problem} → ${url}（这条本轮不判存在性；其余链接、主张与表格照常核对）`)
        continue
      }
      const target = decodedTarget.value
      if (rawTarget === undefined || rawTarget === '') {
        // 同文档锚点
        const decodedAnchor = decodeRef(rawAnchor)
        if (decodedAnchor.problem) {
          problems.push(`${doc}: 同文档锚点${decodedAnchor.problem} → #${rawAnchor}（GitHub 会把它渲染成另一个 slug；要写 %25，或把标题改掉后重写锚点）`)
          continue
        }
        const set = anchors.get(doc) ?? new Set()
        if (!set.has(decodedAnchor.value)) {
          const problem = `${doc}: 同文档锚点失效 → #${rawAnchor}`
          const deferred = deferredFindings.find((d) => d.problem === problem)
          if (deferred) deferredHit.add(deferred.id)
          else problems.push(problem)
        }
        continue
      }
      const abs = path.join(rootDir, path.dirname(doc), target)
      if (!fs.existsSync(abs)) {
        problems.push(`${doc}: 相对路径不存在 → ${url}`)
        continue
      }
      if (rawAnchor && fs.statSync(abs).isFile() && abs.endsWith('.md')) {
        const rel = path.relative(rootDir, abs).split(path.sep).join('/')
        // **锚点存在与否一定要查到底，不能因为目标文档没登记就跳过。** 从前这里是
        // `const set = anchors.get(rel); if (set && ...)`：指向未登记文件（fork 的文档、
        // 临时新增的 md）的锚点被静默放过，等于"看不见的文件永远不会写错标题"。
        // 现在按需计算，读不到才算问题——跳过不是宽容，是把判据关掉。
        let set = anchors.get(rel)
        if (set === undefined) {
          if (!anchorCache.has(rel)) {
            try {
              anchorCache.set(rel, headingsOf(read(rel, rootDir)))
            } catch {
              anchorCache.set(rel, null)
            }
          }
          set = anchorCache.get(rel)
        }
        const decodedAnchor = decodeRef(rawAnchor)
        if (decodedAnchor.problem) {
          problems.push(`${doc}: 跨文档锚点${decodedAnchor.problem} → ${url}（这条本轮不判存在性）`)
        } else if (set === null) {
          problems.push(`${doc}: 锚点目标读不到 → ${url}`)
        } else if (!set.has(decodedAnchor.value)) {
          problems.push(`${doc}: 跨文档锚点失效 → ${url}`)
        }
      }
    }
  }
  // 归口条目要自己证明它还该在：这一次它对应的那一行**没有**再发生，说明那条线已经修好了，
  // 留着豁免就等于给一道已经不复存在的缺陷作掩护——下一次它换个人、换个文件复发时，没人记得它存在过。
  //
  // 但"没再发生"只在**真的看过那一份文件**时才算数。`check()` 的文档集合是注入的（各条测试都拿
  // 临时根跑，见 `updater/test/scripts-check-doc-links.test.mjs`），在一个不含 fork 门面的根里，
  // 那一行当然不会发生——那不能算"那条线修好了"，只能算"这一轮没看那份文件"。不这么分开的话，
  // 这条自过期检查会把每一个合成根的测试都判红（本轮第一次跑就撞上，正是那条既有测试拦住的）。
  const seenDocs = new Set(present);
  for (const d of deferredFindings) {
    const file = d.problem.split(':')[0];
    if (deferredHit.has(d.id)) {
      advisories.push(`归口待修 ${d.id}：${d.problem}｜判据 ${d.measured}｜归 ${d.owner}｜已于 ${d.openedOn} 交接给 ${d.handedTo}`)
      continue
    }
    if (!seenDocs.has(file)) continue // 这一轮没看过那一份文件，不作"已修"的结论
    problems.push(`归口条目 ${d.id} 这一轮没有再发生（它钉的是「${d.problem}」）：那条线大概已经修好了，`
      + `把这条豁免从 DEFERRED_FINDINGS 删掉——留着它，这道闸就在替一个已经不存在的问题作掩护`)
  }
  return { docs: present.length, links, external, tables: shape.tables, mdFiles: shape.files, problems, advisories }
}

/**
 * shell 残渣闸：文档正文里不许出现 heredoc 结束标记，也不许出现裸露的**语句形状**
 * （赋值/调用/片段续行/管道/命令替换——旧版只看一份手抄的命令词名单，本轮改成形状，见下面 ②）。
 *
 * WHY（本轮真事中招两次，2026-10-16）。用 `cat >> 文件 <<'EOF' … EOF` 往 `engine/smoke.md`
 * 追加时，外层 `/bin/bash -c '…'` 的单引号提前收尾，于是**包装脚本自己的那一行**被当成正文写进
 * 了被跟踪的文件——第一次留下了 `EOF` 与 `echo "appended: $(wc -l < …)"` 两行，第二次留下了
 * `EOF` 与 `wc -l …` 两行。两处都在 `git commit` 之后才发现，其中第一处已经进了 `v1.16.2` 那笔
 * 提交（那一版没有发布物，所以没有流进签名归档）。`check-doc-links` 当时全绿：死链、锚点、双语
 * 都对，因为它只看链接和主张，**没有任何一道闸看"正文里是不是混进了 shell"**。
 *
 * 判据只认两种形状，故意不做广义"像不像代码"的判断（广义规则会把人话误判成残渣，然后被要求放宽）：
 * ① 一行恰好是 heredoc 结束标记；② 一行是**命令形状**的 shell 行——小写命令词开头、整行不含汉字、
 * 且带着只有命令行才有的东西（`$(`、第二个词以 `-` 或 `/` 开头、或紧跟引号）。两者都只在
 * **围栏之外**生效——``` 与 `~~~` 里面的 shell 记录是文档的正常内容（这一页就有好几段），把围栏也扫进去
 * 是一道永远会误红的闸。开/闭判定与 `markdownTableProblems`、`headingsOf` 共用**同一个状态机**
 * （`fenceAfter`）：此前这里只认 ```，于是 `~~~` 围栏里的示例命令被误红，而误红文案教作者
 * "放进 ``` 围栏"——对已经在一个合法围栏里的行自相矛盾（S10-5，2026-10-29）。那一版修的是
 * "两种围栏字符都认"，没有修"布尔翻面"本身：注释当时写的是"三个读者共用 `isFenceLine`"，
 * 而 `headingsOf` 用的是另一套（CommonMark：缩进 ≤3、同种字符、闭合不更短）——**主张与代码不符**，
 * 本轮按 `fenceAfter` 把它变成真的（缺陷 #3）。
 *
 * ①的那份**名单**（`EOF/MSG/PY/SQL/OUT/YAML/JSON`）在 2026-10-31 被同一类事故否证：那一轮往
 * `engine/smoke.md` 追加读数时用的是 `<<'XEOF'`，`XEOF` 不在名单里 ⇒ 残渣连同后面的整块 node 脚本
 * 一路绿着进了 main 和 `v1.27.0` 的归档。手抄的词表就是这道闸的盲区（同一个形状在本仓第三次出现：
 * 名单永远少下一枚），所以判据改成形状——一行去掉空白后**恰好**是 `[A-Z][A-Z0-9_]{1,15}`，就当它是
 * 一枚 heredoc 标记。实测边界：现在扫的 32 份文档、以及全仓 125 份 markdown，围栏之外符合这个形状的
 * 行**只有那一条 `XEOF`**（也就是缺陷本身），零条误红；代价是正文里将来单独成行的大写词（`NOTE`、
 * `TODO` 之类）也要进围栏或改写，这一条写在这里而不是等谁被红了才发现。
 *
 * "整行不含汉字"这一半不是凑数：判据第一版只看命令词，于是
 * `harness/glasspane-harness/SYNCLOG.md:684` 那句人话（"grep 会把这种管道输入当"二进制"而停止
 * 匹配。"）被判成了残渣——**一道新闸第一次运行就误红了一条别人的文档**。命令词后面接中文不是命令。
 */
const HEREDOC_TERMINATOR = /^[A-Z][A-Z0-9_]{1,63}$/
const HAN = /[\p{Script=Han}]/u
/**
 * ①′：标记与下一条语句写在**同一行**（`EOF; git diff --numstat …`）。本轮把真残渣喂进判据量过：
 * 只认"独立成行"的那一版，遇到这种共享行就整块漏掉。①″：heredoc 的引入式（`<<'EOF'`）——引号
 * 包住的标记是脚本语法，不是散文。① 的宽度从 `{1,15}` 放到 `{1,63}`：`GLASSPANE_SMOKE_APPEND_END`
 * （24 字符）是一枚合法标记，旧宽度不抓它。首字符仍要求大写：全小写的"整行一个词"在人话里出现
 * 概率不为零，这一半是取舍，写在这里而不是等谁被红了才发现。
 */
const HEREDOC_TERMINATOR_INLINE = /^[A-Z][A-Za-z0-9_]{1,63}[ \t]*(?:;|&&|\|\|)/
const HEREDOC_INTRODUCER = /<<-?[ \t]*['"][A-Za-z_][A-Za-z0-9_]*['"]/
/**
 * ②：**"这是一条语句"的形状**，不是"第一个词是命令词"。
 *
 * 旧版 ② 是一份手抄词表（`echo|wc|printf|cat|sed|grep|ls|nohup|tar`）——正是这一版刚刚在 ① 上
 * 退掉的同一个形状（"名单永远少下一枚"，本仓第四次）。本轮实测：把 2026-10-31 漏进
 * `engine/smoke.md` 的那 9 行**删掉 `XEOF` 那一行**再喂进旧判据，报 **0 条**。剩下 8 行是
 * `node -e "`、`const fs=require("fs");`、`fs.writeFileSync(p, …);`、`console.log("appended");`、
 * `"; git diff --numstat …`——没有一条以名单上的词开头，也没有一条是"命令词 + 运算元"的形状。
 *
 * 按形状判的四类：赋值语句、调用语句、以闭引号/闭括号/分隔符开头的**片段延续**（被截断的表达式
 * 才这么起头，人话不），以及 `$()` / 管道 / `&&` 接命令这类强运算元。判的一律是剥掉行内代码段
 * 之后的正文；含汉字的行一律不判（第一版就是因为只看命令词误红了 SYNCLOG 那句人话）。
 * 围栏之外的缩进代码块（≥4 空格）同样不判——`harness/glasspane-harness/SYNCLOG.md:564` 那条
 * `curl -fsSL …` 就是缩进代码块，是合法的文档形状；把它判红等于误红一条本轮不许改的文件。
 */
/**
 * 赋值语句两种起头才算：JS 声明词开头，或等号右边是"值的写法"（引号、反引号、`$`、`[`、`{`、`(`）。
 * `rc=0（"no changes"…）`、`GLASSPANE_CA_REEXEC=1` 不算——等号右边是一个裸字面量时，那句是在
 * **讲值**，不是贴了一条语句（本轮实测：前者在 harness 线的 SYNCLOG:1268，后者在 updater/README:27，
 * 把任一条判红都要我去改一条不属于本轮的文档）。
 */
const STATEMENT_ASSIGN = /^(?:const|let|var)[ \t]+[A-Za-z_$][\w.$]*[ \t]*=[^=]|^[A-Za-z_$][\w.$]*[ \t]*=["'`$[(]/
const STATEMENT_CALL_HEAD = /^[A-Za-z_$][\w.$]*\s*[([]/
/** 语句的收口是 `);` ——只写到 `)` 的那一行是"提到了一个函数"，不是"贴了一条语句"。 */
const STATEMENT_CALL_TAIL = /[)\]]\s*;\s*$/
/** 被截断的字符串续行：闭引号后面**立刻**接 shell 运算符（`"; git diff …`）。 */
const FRAGMENT_HEAD = /^["']\s*[;|)&]/
/**
 * 管道形状：小写命令词开头、中间有**真运算元**（`-x`、`/path`、引号包住的值），再接 `| 另一条命令`。
 * 运算元那一半是必需的：`curl | bash` 是在**说这条管道**，不是贴了一条待执行的命令
 * （实测于 harness 线 SYNCLOG:3693，那条文件本轮不许改；旧版靠"第一个词在名单里"躲过了它）。
 */
const PIPELINE = /^[a-z][\w.+-]*(?:[ \t]+(?:-\S+|\/[^\s]*|["'][^\s]*["']))+[ \t]*[|][ \t]*[a-z][\w.+-]+/
/**
 * 命令替换：`wc -l "$(printf %s f)"`。要求 `$( ` 前面是行首、空白或引号——`gui/$(id -u)/…`
 * 那种**黏在路径里**的写法是在讲一个名字（本轮实测它在 specs 台账的一行里，那一行不许本轮改），
 * 不是贴了一条待执行的替换。
 */
const COMMAND_SUBST = /(?:^|[ \t["'`])\$\(/
/**
 * 调用开头：一个小写词紧跟一枚选项（`wc -l file`、`node -e "`、`ls -l "$(…)"`）。
 * 这是**动词无关**的形状——旧版靠手抄的九个命令词，名单永远少下一枚；这里不问动词，
 * 只问"第二个 token 是不是一枚选项"。两条实测边界：`curl | bash`（在讲这条管道，没有选项）
 * 与 `either the  -mapped spelling.`、`identifier "<id>"' --verify --strict`。
 * （散文里选项样式的词落在第三个以后的位置）都不算——把它们判红会误红 SECURITY.md 与一份
 * 本轮不许改动的 specs 台账，实测这两条正是被"选项必须紧跟动词"这一半挡掉的。
 */
const FLAGGED_INVOCATION = /^[a-z][\w.+-]{0,15}[ \t]+-{1,2}[A-Za-z]/

/**
 * 残渣闸的扫描集：登记的文档 **加上 specs/**。
 *
 * 旧版只扫登记的 32 份，而同一个文件里的 `markdownTableProblems` 走的是全仓 markdown——
 * 于是"往正文里贴脚本"这一习惯每轮真正落笔的地方（台账）反而不在闸下。本轮把它对齐：
 * specs/ 里的行内代码段与缩进代码块按同一套 CommonMark 判据剥掉之后，实测零误红
 * （`specs/GlassPane_每日审查_2026-10-14_记录.md:68` 那枚折行的 `gui/$(id -u)/…` 正是靠
 * 跨行的行内代码配对才不被读成残渣）。specs/ 的内容本轮不许改，所以这条对齐必须是零误红才成立。
 */
export const RESIDUE_DOCS = (() => {
  try {
    const specs = fs.readdirSync(path.join(ROOT, 'specs')).filter((f) => f.endsWith('.md')).sort()
    return [...DOCS, ...specs.map((f) => `specs/${f}`)]
  } catch {
    return [...DOCS]
  }
})()

export function shellResidue({ rootDir = ROOT, docs = RESIDUE_DOCS } = {}) {
  const problems = []
  for (const doc of docs.filter((d) => fs.existsSync(path.join(rootDir, d)))) {
    const text = read(doc, rootDir)
    let fence = null
    text.split('\n').forEach((line, i) => {
      const wasInFence = fence !== null
      fence = fenceAfter(line, fence)
      if (wasInFence) return
      // CommonMark 的缩进代码块：围栏之外、行首 ≥4 空格或制表符，那也是代码，不是正文。
      if (/^(?: {4}|\t)/.test(line)) return
      // markdown 表格的行由 `markdownTableProblems` 那道判据管，这里不重复判：表格单元里
      // 出现 `|`、`(`、`"` 都是合法形状，把它们读成残渣会让这道闸去误红每一份对比表。
      if (mdRow(line)) return
      if (line.trim() === '') return
      const body = proseOf(line)
      if (body === '') return
      if (HEREDOC_TERMINATOR.test(body)) {
        problems.push(`${doc}:${i + 1} 正文里有一行恰好是一枚全大写标记（${body}）——`
          + '这**通常**是 shell 追加脚本的 heredoc 结束标记漏进正文的残渣；如果它确实是正文'
          + '（某个常量名、某个代号），把它放进 ``` 围栏或改写成一句话，'
          + '让"这是一枚标记"与"这是散文"由渲染决定，而不是由形状猜')
        return
      }
      if (HEREDOC_TERMINATOR_INLINE.test(body)) {
        problems.push(`${doc}:${i + 1} 正文以全大写标记 ${body.slice(0, 24)} 起头并紧跟 shell 运算符——`
          + '这是 heredoc 标记与下一条语句写在同一行的残渣形状；要么放进 ``` 围栏，要么删掉那段脚本')
      }
      if (HEREDOC_INTRODUCER.test(body)) {
        problems.push(`${doc}:${i + 1} 正文里有 heredoc 引入式（<<'…'）——`
          + '那是追加脚本自己的语法，作为正文既不能执行也不能被读者当话；放进 ``` 围栏')
      }
      if (HAN.test(body)) return
      const statementShaped = STATEMENT_ASSIGN.test(body)
        || (STATEMENT_CALL_HEAD.test(body) && STATEMENT_CALL_TAIL.test(body))
        || (FRAGMENT_HEAD.test(body) && /[();|]/.test(body))
        || PIPELINE.test(body)
        || COMMAND_SUBST.test(body)
        || FLAGGED_INVOCATION.test(body)
      if (statementShaped) {
        problems.push(`${doc}:${i + 1} 正文里出现裸露的语句形状（${body.slice(0, 60)}）——`
          + '要么放进 ``` 围栏，要么写成 `反引号`；作为正文它既不能执行也不能被读者当话')
      }
    })
  }
  return problems
}

/**
 * 安装渠道闸：对外文档不许把 `curl … | sh` 这条管道当安装命令给出。
 *
 * WHY（2026-10-20 实测，`installer/test/daily-20261020.test.mjs` 第一条用例钉的就是它）。
 * 管道那一头的 `curl` 取不到脚本时（本机是 exit 7），`sh` 从 stdin 读到的是**空输入**，直接
 * EOF 退 0：一次什么都没装的运行对外报的是成功。`installer/cli.js` 的 `--help` 里写着这件事和
 * 分步写法，而**五份对外文档的正文里给的仍是那条管道**——读者不会去 `--help` 里找安装命令。
 * 对产品来说后果是具体的：读 `$?` 的正是不在场的 agent 与 CI，它们拿到的是 0。
 *
 * 判据只认**命令形状**的行：去掉缩进与行首反引号后以 `curl` 起头，且同一行里有 `| sh`/`| bash`。
 * 散文里提一句「`curl … | sh` 属于执行远端脚本」（SECURITY 两份就是这么写的）不是命令，不许红——
 * 把 prose 判成缺陷的下场是 prose 被删掉而命令原样留着，与本仓 `check-workflows.mjs` 对
 * `gh release view` 那条注释记的是同一件事。扫描集合是**发布安装命令的那五份**（`INSTALL_DOCS`），
 * 不是全部文档：`CHANGELOG.md` 里那些 `curl | sh` 是历史读数，拿今天的规矩要求历史等于要求它
 * 改写自己（`CLAIM_DOCS` 排除 CHANGELOG 是同一个理由）。
 */
const INSTALL_DOCS = [
  'README.md',
  'README.zh-CN.md',
  'installer/README.md',
  'mcp-shell/README.md',
  'updater/README.md',
]

const PIPED_INSTALL = /^[ \t`]*curl\b[^\n]*\|\s*(?:ba)?sh\b/

export function pipedInstallCommands({ rootDir = ROOT, docs = INSTALL_DOCS } = {}) {
  const problems = []
  for (const doc of docs) {
    const abs = path.join(rootDir, doc)
    if (!fs.existsSync(abs)) {
      // 门面文件本身读不到不是"这一判据通过"：登记了却不在，问题要说出口。
      problems.push(`${doc} 在 INSTALL_DOCS 里登记了却读不到——安装渠道的这道闸今天对它什么都没核（未观测，不是通过）`)
      continue
    }
    fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      if (!PIPED_INSTALL.test(line)) return
      problems.push(`${doc}:${i + 1} 把管道当成安装命令给出（${line.trim().slice(0, 100)}）——`
        + 'curl 自己失败时 `sh` 读到空输入直接 EOF 退 0，一次什么都没装的运行对外报成功。'
        + `改成两步，落点用一次性文件：\`${SAFE_INSTALL_ONE_LINER}\`。`
        + '落点为什么不能写 /tmp 里的固定名字，见 `installLandingAudit`。')
    })
  }
  return problems
}

/**
 * 第六类（2026-10-29，S10-7）：`curl … -o <落点>` 的落点不许是 world-writable 目录里的固定名字。
 *
 * WHY（这是形状问题，不是风格问题）。README 教的一键安装从前是
 * `curl -fsSL … -o /tmp/gp-install.sh && sh /tmp/gp-install.sh`。第五类修的是"这条管道拿不到结论"，
 * 两步写法本身却引入了另一件事：`/private/tmp` 的 mode 是 1777，sticky 只挡住"别人删你的文件"，
 * **不**挡住另一个账号抢先建 `/tmp/gp-install.sh -> ~/.bashrc` 这样的符号链接——`curl -o` 跟随它，
 * 并以受害者的 uid 截断覆写那个文件。也就是说：把脚本落进一个所有人可写、名字可预测的目录，
 * 等于任何同机账号在受害者点下回车之前都拿到了一次"覆写受害者可写文件"的原语。
 *
 * 本仓对同一个风险早就有规矩，只是没有一条闸把这条规矩推广到文档给出的那一行命令上：
 * `install.sh` 的临时文件走 `mktemp`；bridge 建 socket 用 `O_CREAT|O_EXCL|O_NOFOLLOW`；
 * `SocketDirectoryRule.leafSymlinkDefect` 明确拒绝跟随链接。这一条是同一判据的前门版本。
 *
 * 判据（`installLandingAudit`）只看两件事，故意不做广义的路径分类：
 * ① 落点是**字面路径**且落在 world-writable 目录（`/tmp`、`/private/tmp`、`/var/tmp`）里 → 红；
 * ② 落点是 `$VAR`/`${VAR}` 形状，但本行与前四行里看不到 `mktemp`、`$TMPDIR` 或 `$HOME` 的证据 → 红
 *    （"看着像变量"不是保护，写得出来源才是；文档里给出的那一行必须自证）。
 * 每用户私有目录（`$HOME/…`、`~/…`、`$TMPDIR/…`，macOS 的 TMPDIR 本来就是 0700）与 `mktemp`
 * 造出来的一次性名字一律放过——否则这道闸的唯一修法就是把安装说明整段删掉。
 *
 * 写域：本仓的文档/脚本分属几条泳道，所以 `INSTALL_LANDING_ENFORCED` 里的文件判红，
 * `INSTALL_LANDING_HANDOFF` 里的判据同样**测量并打印**（`△`，与 `check-workflows.mjs` 对 fork 子树
 * 同一手法），而不是悄悄不看。移交清单是临时的：那三份文件改成 mktemp 落点后，它们的 `△` 自己消失，
 * 届时应把它们并进 ENFORCED——一张只会变短的移交清单才是诚实的清单。
 */
const SAFE_INSTALL_ONE_LINER = 'GP="$(mktemp "${TMPDIR:-/tmp/}gp-install.XXXXXXXX")" && curl -fsSL <url> -o "$GP" && sh "$GP" && rm -f "$GP"'

/** 这道闸判红的文件集合（本泳道写得动、且今天已经全部合规）。 */
export const INSTALL_LANDING_ENFORCED = ['README.md', 'README.zh-CN.md', 'updater/README.md', 'install.sh',
  // 2026-10-29 收口：移交清单里那三份已由安装器泳道改成 mktemp 落点，按本文件上面的约定
  // "移交清单应当只会变短"并进判红集合——从此它们由这道闸直接判红，不再只是打印。
  'installer/README.md', 'mcp-shell/README.md', 'installer/cli.js']
/**
 * 今天仍然带着旧形状、但归另一条泳道写域的文件。它们的读数照样量出来、照样打印（`△`），
 * 只是不从这道闸判红——与 `check-workflows.mjs` 对 `harness/` 子树同一手法。
 * 移交清单应当只会变短：某一份改好之后它的 `△` 自己消失，届时应把它并进 ENFORCED。
 *
 * 剩下的两条都是 fork 那棵树里的门面文档，它们给出的也是同一条 `curl -o /tmp/…`：
 * 本线无权改 `harness/**`（那条线有 10:30 的独立任务），所以这里量出来并点名移交。
 */
export const INSTALL_LANDING_HANDOFF = ['harness/glasspane-harness/README.md', 'harness/glasspane-harness/README.zh-CN.md']

const CURL_OUTPUT_FLAG = new RegExp('(?:^|[^\\w-])curl\\b[^|&;]*?\\s(?:-o|--output)(?:=|\\s+)(?:"([^"]*)"|\'([^\']*)\'|([^\\s|&;)]+))')
const WORLD_WRITABLE = /^\/(?:tmp|private\/tmp|var\/tmp)\//
const LANDING_EVIDENCE = /mktemp|TMPDIR|\$\{?HOME\}?|~\//

function landingOf(line) {
  const m = CURL_OUTPUT_FLAG.exec(line)
  if (!m) return null
  return m[1] ?? m[2] ?? m[3] ?? null
}

/** 这一行的落点是否可证明来自一次性文件 / 每用户私有目录（回看四行是文档的多行写法）。 */
function landingReason({ lines, index, landing }) {
  if (WORLD_WRITABLE.test(landing)) {
    return `把安装脚本落到 world-writable 目录里的固定名字（${landing}）——/private/tmp 是 1777，sticky 挡不住别的账号先建一个同名符号链接，curl -o 会跟随它并以你的 uid 截断覆写目标文件`
  }
  if (/\$/.test(landing)) {
    const window = lines.slice(Math.max(0, index - 4), index + 1)
    if (LANDING_EVIDENCE.test(window.join('\n'))) return null
    // 变量本身不是保护，它的**来源**才是。`GP=/tmp/gp-install.sh` 然后 `-o "$GP"` 是同一个洞换了个
    // 写法，所以要就地解一次赋值；解不出来路（四行内既没有 mktemp 也没有私有目录）同样判红。
    const varName = landing.match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? null
    if (varName !== null) {
      const assign = new RegExp(`^\\s*(?:export\\s+)?${varName}=(?:"([^"]*)"|'([^']*)'|([^\\s|;&()]*))`)
      const hit = window.map((l) => assign.exec(l)).find((m) => m !== null)
      const resolved = hit ? (hit[1] ?? hit[2] ?? hit[3] ?? '') : ''
      if (WORLD_WRITABLE.test(resolved)) {
        return `把安装脚本落到 world-writable 目录里的固定名字（${landing} 在这里被赋成 ${resolved}）——/private/tmp 是 1777，sticky 挡不住别的账号先建一个同名符号链接，curl -o 会跟随它并以你的 uid 截断覆写目标文件`
      }
    }
    return `落点写成 ${landing}，但本行与前四行里看不出它来自 mktemp、$TMPDIR 或 $HOME——"像个变量"不是保护，写得出来源才是`
  }
  return null
}

export function installLandingAudit({ rootDir = ROOT, files = [...INSTALL_LANDING_ENFORCED, ...INSTALL_LANDING_HANDOFF] } = {}) {
  const unsafe = []
  const unreadable = []
  for (const rel of files) {
    const abs = path.join(rootDir, rel)
    if (!fs.existsSync(abs)) {
      unreadable.push(rel)
      continue
    }
    const lines = fs.readFileSync(abs, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const landing = landingOf(line)
      if (landing === null) return
      const reason = landingReason({ lines, index: i, landing })
      if (reason) unsafe.push({ file: rel, line: i + 1, landing, reason, text: line.trim().slice(0, 90) })
    })
  }
  return { unsafe, unreadable }
}

/** 判红的那一半：本泳道写得动的文件。 */
export function installLandingProblems({ rootDir = ROOT, files = INSTALL_LANDING_ENFORCED } = {}) {
  const out = []
  const audit = installLandingAudit({ rootDir, files })
  for (const entry of audit.unsafe) {
    out.push(`${entry.file}:${entry.line} ${entry.reason}。改成两步且落点自证：\`${SAFE_INSTALL_ONE_LINER}\`（本仓 install.sh 用 mktemp、bridge 用 O_CREAT|O_EXCL|O_NOFOLLOW、SocketDirectoryRule 拒绝跟随链接，对的是同一个风险）。原文：\`${entry.text}\``)
  }
  for (const rel of audit.unreadable) {
    out.push(`${rel} 在 INSTALL_LANDING_ENFORCED 里登记了却读不到——落点的这道闸今天对它什么都没核（未观测，不是通过）`)
  }
  return out
}

/** 打印而不判的那一半：别的泳道的写域，测到了就说出来。 */
export function installLandingAdvisories({ rootDir = ROOT, files = INSTALL_LANDING_HANDOFF } = {}) {
  const audit = installLandingAudit({ rootDir, files })
  const out = []
  for (const entry of audit.unsafe) {
    out.push(`${entry.file}:${entry.line} ${entry.reason}——那是另一条泳道的写域，移交而不是从这里判红（remedy 与 ENFORCED 侧同一条：${SAFE_INSTALL_ONE_LINER}）`)
  }
  for (const rel of audit.unreadable) {
    out.push(`${rel} 在 INSTALL_LANDING_HANDOFF 里登记了却读不到：移交清单需要对一下它是不改名了（改完请把这一项并进 ENFORCED）`)
  }
  return out
}

/**
 * markdown 表格形状：一张表里每一行的格数必须一样，且第二行必须是 `|---|` 那道分隔行。
 *
 * WHY（本轮在自己的台账里中招两处，回扫全仓又抓到 13 行）。某一格里写了个没转义的 `|`，
 * 源码看着是整齐的一行，**渲染出来**却被切成多一格——那一行的"处置"跑到别的列里去，而表格里的
 * 每个中文分句都还在，谁也不会觉得少了什么。死链、锚点、双语对偶、可复算主张四道判据对此全部
 * 无感：文档还是那份文档。中招的两条正是本轮台账自己（`launch == .ok || attach == .ok` 与
 * `… | sh -s -- --no-prompt`），说明写的人（包括本轮的我）需要的是机器提醒而不是记住它。
 *
 * 三条判据的取舍：
 * ① 围栏内不扫。``` 里的 ASCII 表是文档的正常内容（这一页就有），把它当表格判是一道会误红的闸，
 *    而误红的闸的下场是被放宽——那才是真的失去保护。
 * ② `\|` 先折成占位符再数格数，所以"转义过的竖线"既不算分隔符也不算缺陷。
 * ③ 分隔行与表头不齐也是问题：GFM 没有分隔行就不把这一段当表格渲染，读者看到的是一行裸竖线。
 *    扫描集合是**全部** markdown，除了派生目录与 vendored 的 fork 包树（见 `MD_SKIP_ROOTS`），
 *    不是 DOCS 登记表——登记表管的是"对外文档的链接与主张"，而表格形状在所有本仓自己的文档里
 *    都会坏给同一批读者看。`harness/glasspane-harness/packages/**` 是上游 fork 的产品源码树：
 *    那里的文档归那条线（它有 10:30 的独立任务与独立尺子），把它们扫进来，就等于让一次上游
 *    bump 能红在本仓的闸上——而那种红的唯一修法是放宽本闸。
 *
 *    2026-11-05 试过把这一条从 `packages/` 扩到整个 fork 体，量过之后**收回**：本闸的 `FORK_DOCS`
 *    登记表（见文件头）是有意登记 fork 门面文档的——"产品在私有化之后前门搬到了这里，前门上的
 *    死链一样是死链"。扩到整体会一边从表格统计里少掉 48 张真表（本机实量 470→422）、一边
 *    仍然报出那一处锚点，因为它走的是 `DOCS` 那条通道。归口写在下面 `DEFERRED_FINDINGS`，
 *    不在扫描集合上动手。
 *
 * `.worktrees` 与 `dist` 同族（2026-10-29 实测加入）：并行会话与每日任务会把隔离工作树开在
 * 仓库目录**里面**，那是同一棵树的多份未追踪拷贝。本机实量：`.worktrees/` 下开出 5 份之后，
 * 这道闸自己打印的扫描量从 122 份 markdown 涨到 1257 份、表格从 448 张涨到 3275 张——读的人
 * 以为是本仓的文档涨了十倍，而它数的是别人正在写的半成品。把一次未追踪的 scratch 状态算进
 * 判据，等于让这道闸对"仓库里有什么"失去可复现性：同一棵 main 的树，因为旁边有没有工作树而
 * 给出不同的读数。排除它不是放宽判据，是把它本来就不该数的东西还给磁盘快照。
 */
const MD_SKIP_DIRS = new Set(['node_modules', '.build', '.git', '.external', '.swiftpm', 'DerivedData', 'dist', '.worktrees'])
const MD_SKIP_ROOTS = ['harness/glasspane-harness/packages/']
const MD_MAX_DEPTH = 14
const CELL_PLACEHOLDER = '\u0001'

let skippedMarkdown = 0
function countMarkdownBeneath(dir) {
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (MD_SKIP_DIRS.has(e.name)) continue
      const abs = path.join(current, e.name)
      if (e.isDirectory()) stack.push(abs)
      else if (e.name.endsWith('.md')) n += 1
    }
  }
  return n
}

function markdownFilesUnder(rootDir) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > MD_MAX_DEPTH) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (MD_SKIP_DIRS.has(e.name)) continue
      const abs = path.join(dir, e.name)
      const rel = path.relative(rootDir, abs).split(path.sep).join('/')
      if (MD_SKIP_ROOTS.some((r) => rel.startsWith(r))) {
        // 跳过要**看得见**：静默少扫 N 份与"扫过了"在输出里长得一样，就是这道闸下一次
        // 被人当空跑的理由（本仓被"扫描集合说不清自己扫了什么"咬过不止一次）。
        if (e.isDirectory()) skippedMarkdown += countMarkdownBeneath(abs)
        continue
      }
      if (e.isDirectory()) walk(abs, depth + 1)
      else if (e.name.endsWith('.md')) out.push(abs)
    }
  }
  walk(rootDir, 0)
  return out.sort()
}

const mdRow = (line) => /^\s*\|.*\|\s*$/.test(line)
const mdSeparatorRow = (line) => /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(line)
const mdCells = (line) => line.replace(/\\\|/g, CELL_PLACEHOLDER).split('|').length - 2

export function markdownTableProblems({ rootDir = ROOT } = {}) {
  const problems = []
  const under = markdownFilesUnder(rootDir)
  let tables = 0
  for (const abs of under) {
    const rel = path.relative(rootDir, abs).split(path.sep).join('/')
    let text
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    // 与 `shellResidue`、`headingsOf` 共用同一个围栏状态机：布尔版 `isFenceLine` 一行翻一次面，
    // 一枚落单的（或缩进代码块里的）围栏行会把之后整篇读成"在栏内"，表格形状那一整轮就此空过。
    let fence = null
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      const wasInFence = fence !== null
      fence = fenceAfter(line, fence)
      if (wasInFence || !mdRow(line)) { i += 1; continue }
      const header = mdCells(line)
      const next = lines[i + 1] ?? ''
      if (!mdRow(next)) {
        // 孤行一段：只有它自己是 `|…|` 形状，没有第二行跟进——不是表格，不判。
        i += 1
        continue
      }
      if (!mdSeparatorRow(next)) {
        problems.push(`${rel}:${i + 2} 这一段看着像表格（连续两行竖线开头竖线结尾）却没有竖线分隔行：`
          + 'GFM 因此不把它渲染成表格，读者拿到的是一整行裸竖线')
        i += 1
        continue
      }
      tables += 1
      if (mdCells(next) !== header) {
        problems.push(`${rel}:${i + 2} 分隔行是 ${mdCells(next)} 格，表头是 ${header} 格：两者不齐时渲染按短的裁`)
      }
      let j = i + 2
      for (; j < lines.length && mdRow(lines[j]); j += 1) {
        if (mdCells(lines[j]) !== header) {
          problems.push(`${rel}:${j + 1} 这一行是 ${mdCells(lines[j])} 格而表头是 ${header} 格——`
            + '格内的竖线要写成 `\\|`，否则渲染时这一行被切到别的列里去')
        }
      }
      i = j
    }
    // 上一行是表格行、这一行以 `|` 开头却不以 `|` 结尾 = 被裁断的一行
    for (let k = 1; k < lines.length; k += 1) {
      if (/^\s*\|/.test(lines[k]) && !/\|\s*$/.test(lines[k]) && mdRow(lines[k - 1])) {
        problems.push(`${rel}:${k + 1} 这行以竖线开头却不以竖线结尾，而它上面就是表格行：这一格在渲染时不会闭合`)
      }
    }
  }
  return { problems, tables, files: under.length }
}

// 只有被当成命令直接执行时才跑 CLI。这段此前是无条件执行的：`import` 它的那条测试子进程
// 会在登记任何用例之前就被 `process.exit(0)` 带走，于是 `node --test` 报
// "tests 1 / pass 1"——一份写了 4 条用例的文件以零条用例的身份通过。lint 脚本必须可以
// 被安全 import（判据本身要能被单测注入），这条守卫是那道前提。
//
// **两侧都 realpath**，与 `updater/cli.js`、`installer/cli.js`、`updater/agent-entry.js` 那三个
// npm/launchd 交付的入口同一个规矩。node 按**真实路径**载入 ESM 入口，所以被符号链接调用时
// `process.argv[1]`（链接）与 `import.meta.dirname` 拼出来的那份（真实文件）永不相等：这道闸一段
// 沉默地退 0，检查根本没有发生。本机 2026-10-19 实测：直接跑打出两行结论，经
// `/var/tmp/gp-item4-20261019/cdl-link.mjs` 跑是 rc=0 加零输出。realpathSync 对不存在的路径会抛，
// 抛＝"不是被直接运行"，不是崩掉模块。
function invokedAsEntrypoint() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// 上面那段注释写的前提是"lint 脚本必须可以被安全 import"，而它此前只守住了最后那一格：
// `--self-test`、不认识参数、`--help` 三条出口照样在 **import** 时执行。实测（本机 2026-11-03）：
// 一份 import 本模块的测试文件，宿主 argv 带 `--self-test` 时打出的是这道闸的 11 档电池并退 0，
// 带 `--help` 时打出用法并退 0，带任意不认识参数时**退 2 把宿主整个带走**——三种情况下那份测试
// 自己的用例一条都没登记。用法只在被当作命令执行时才有效，所以四条出口共用同一个守卫。
const isEntrypoint = invokedAsEntrypoint()

if (isEntrypoint && process.argv.includes('--self-test')) {
  // 与 `check-workflows.mjs --self-test` 同一契约：每条判据各打一档坏形状（必须被点名）与一档
  // 合法形状（必须安静）。规则没见过红就等于没有规则；而"只会红"的规则明天的修法是删掉它。
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = fs
  const os = await import('node:os')
  const root = mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-doc-links-selftest-'))

  /** 写一份合成树：`files` 是 rel → 内容。 */
  const write = (files) => {
    for (const rel of Object.keys(files)) {
      const abs = path.join(root, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, files[rel])
    }
  }
  // 每一档从空树开始：上一档留下的 README.zh-CN.md / install.sh 会这一档的"登记却读不到"计数改掉，
  // 而那正是这道闸自己要判的东西——档位之间必须互不污染。
  const empty = () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
  }

  const cases = [
    {
      id: '锚点里的裸 % 把整条闸带栈带走（S10-3）',
      // 真实形状：散文里"50%"式的写法被抄进锚点。修复前 `decodeURIComponent('#funds-50%-covered')`
      // 抛 URIError，这道闸在文档循环中途退出，后面的主张核对与表格形状一条都没跑。
      files: { 'README.md': '# Funds\n\n[出资说明](#funds-50%-covered)\n' },
      run: (rootDir) => check({ rootDir, docs: ['README.md'] }).problems,
      expect: /同文档锚点含裸 %/,
    },
    {
      id: '写得对的锚点不因这条判据变红（S10-3 的对照）',
      files: { 'README.md': '# Funds\n\n[出资说明](#funds)\n' },
      run: (rootDir) => check({ rootDir, docs: ['README.md'] }).problems,
      absent: /含裸 %/,
    },
    {
      id: '~~~ 围栏里的示例命令是文档内容，不是残渣（S10-5）',
      // 同一个文件里 `headingsOf` 与 `markdownTableProblems` 都认两种围栏，只有残渣闸认 ```，
      // 于是这条合法写法被误红，而误红文案叫作者"放进 ``` 围栏"——对已经在 `~~~` 里的行自相矛盾。
      files: { 'README.md': '~~~bash\nwc -l "$(printf %s f)"\n~~~\n' },
      run: (rootDir) => shellResidue({ rootDir, docs: ['README.md'] }),
      absent: /裸露的语句形状/,
    },
    {
      id: '同一行搬到围栏之外必须是残渣（S10-5 的反向）',
      files: { 'README.md': '正文一行：\nwc -l "$(printf %s f)"\n' },
      run: (rootDir) => shellResidue({ rootDir, docs: ['README.md'] }),
      expect: /裸露的语句形状/,
    },
    {
      id: '①：正文里一枚独立的全大写标记必须红（旧版这道电池只测 ②，删掉 ① 那一支照样打印 8 case 退 0）',
      // 2026-10-31 那次事故的**正是这一支**：`XEOF` 落在正文里。电池里没有它的变异例，
      // 意味着把 `HEREDOC_TERMINATOR.test` 那一整块删掉，这道电池仍然全绿。
      files: { 'README.md': '正文一段。\nXEOF\nnode -e "\nconst fs=require("fs");\n' },
      run: (rootDir) => shellResidue({ rootDir, docs: ['README.md'] }),
      expect: /恰好是一枚全大写标记/,
    },
    {
      id: '①：夹在成对反引号里、或写在围栏里的大写词不许红（对照）',
      files: { 'README.md': '环境变量 `NODE_EXTRA_CA_CERTS` 与 `GLASSPANE_CA_REEXEC` 各管一件事。\n\n```\nXEOF\n```\n' },
      run: (rootDir) => shellResidue({ rootDir, docs: ['README.md'] }),
      absent: /恰好是一枚全大写标记/,
    },
    {
      id: '围栏：缩进代码块里的一枚 ``` 不许把整篇读成"在栏内"（旧布尔翻面的假绿形状）',
      files: { 'README.md': '段落：\n\n    ```\n\n' + 'fs.writeFileSync(p, "x");\n' },
      run: (rootDir) => shellResidue({ rootDir, docs: ['README.md'] }),
      expect: /裸露的语句形状/,
    },
    {
      id: '一键安装把落点交给 /tmp 里的固定名字（S10-7）',
      // 今天 README 的形状。/private/tmp 是 1777，sticky 不禁止另一个账号先建同名符号链接，
      // `curl -o` 跟随并以受害者的 uid 截断覆写。
      files: {
        'README.md': 'curl -fsSL https://example.com/install.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh\n',
      },
      run: (rootDir) => installLandingProblems({ rootDir, files: ['README.md'] }),
      expect: /world-writable 目录里的固定名字/,
    },
    {
      id: '落点来自 mktemp 的一键安装不许红（S10-7 的对照）',
      // 否则这道闸的唯一修法就是把安装说明整段删掉——那比漏洞更糟。
      files: {
        'README.md': 'GP="$(mktemp "${TMPDIR:-/tmp/}gp-install.XXXXXXXX")" && curl -fsSL https://example.com/install.sh -o "$GP" && sh "$GP" && rm -f "$GP"\n',
      },
      run: (rootDir) => installLandingProblems({ rootDir, files: ['README.md'] }),
      absent: /world-writable 目录里的固定名字/,
    },
    {
      id: '落点写成 $VAR 却看不出它从哪来（S10-7 的第二半）',
      // "看起来像变量"不是保护：`GP=/tmp/gp-install.sh` 然后 `-o "$GP"` 与写死的名字同一个洞。
      files: {
        'README.md': 'curl -fsSL https://example.com/install.sh -o "$GP_INSTALL_SH" && sh "$GP_INSTALL_SH"\n',
      },
      run: (rootDir) => installLandingProblems({ rootDir, files: ['README.md'] }),
      expect: /看不出它来自 mktemp/,
    },
    {
      id: '移交清单里的文件照样被测量，只是不从这道闸判红（△ 不是没看）',
      files: {
        'installer/cli.js': "  'curl -fsSL <install.sh> -o /tmp/gp-install.sh && sh /tmp/gp-install.sh',\n",
      },
      run: (rootDir) => installLandingAdvisories({ rootDir, files: ['installer/cli.js'] }),
      expect: /installer\/cli\.js:1 world-writable|installer\/cli\.js:1 把安装脚本落到/,
    },
  ]

  let failed = 0
  for (const c of cases) {
    empty()
    write(c.files)
    let answers
    let crashed = null
    try {
      answers = c.run(root)
    } catch (error) {
      crashed = `${error.constructor.name}: ${error.message}`
    }
    if (crashed !== null) {
      // 一条拒该是一句话，不是一个栈：判据自己抛 = 这一档没被测到，而且正是本条要修的缺陷。
      console.error(`  ✗ self-test: ${c.id} 让判据带着栈退出（${crashed}）——这不是红，这是闸没运行`)
      failed++
      continue
    }
    const hit = c.absent ? !answers.some((p) => c.absent.test(p)) : answers.some((p) => c.expect.test(p))
    if (hit) console.log(`  ok self-test: ${c.id} ${c.absent ? 'stays silent, as it must' : 'is caught'}`)
    else {
      console.error(
        c.absent
          ? `  ✗ self-test: ${c.id} was NOT silent — the rule fires where it has no object (${JSON.stringify(answers)})`
          : `  ✗ self-test: ${c.id} was NOT caught (${answers.length} answer(s): ${JSON.stringify(answers)})`,
      )
      failed++
    }
  }
  rmSync(root, { recursive: true, force: true })

  if (failed > 0) {
    console.error(`check-doc-links --self-test: ${failed} case(s) did not behave as declared.`)
    process.exit(1)
  }
  const caught = cases.filter((c) => !c.absent).length
  console.log(
    `check-doc-links --self-test: ${cases.length} case(s) each verified to fail — ${caught} mutation(s) that had to be caught, ${cases.length - caught} legal shape(s) that had to stay silent`,
  )
  process.exit(0)
}

const unknownArgs = isEntrypoint
  ? process.argv.slice(2).filter((a) => a !== '--self-test' && a !== '--help')
  : []
if (unknownArgs.length) {
  console.error(`check-doc-links: 不认识的参数 ${unknownArgs.join(', ')}——可用的只有 --self-test 与 --help`)
  console.error('（不认识参数却照常跑完，等于 CI 里写错一个 flag 名以后那道闸做的事没人知道；与 check-workflows.mjs 同一条规矩）')
  process.exit(2)
}
if (isEntrypoint && process.argv.includes('--help')) {
  console.log(`usage: node scripts/check-doc-links.mjs [--self-test | --help]

判的六类：仓库内相对链接可达 / 页内与跨文档锚点存在（含百分号解码，坏转义是一句话不是一个栈）/
双语对偶两条腿都在位 / 抄写的可复算主张等于真源 / 围栏外的 shell 残渣与 markdown 表格格数 /
对外给出的安装命令的形状（管道、以及 curl -o 的落点是不是 world-writable 目录里的固定名字）。

退出码：0 干净 · 1 有问题 · 2 用法错或登记表读不到。`);
  process.exit(0)
}

if (invokedAsEntrypoint()) {
  const { docs, links, external, tables, mdFiles, problems, advisories } = check()
  process.stdout.write(`文档 ${docs} 份 | 仓库内链接 ${links} 条 | 外链 ${external} 条（不请求）| markdown 表格 ${tables} 张（扫 ${mdFiles} 份 markdown，按 MD_SKIP_ROOTS 另跳过 ${skippedMarkdown} 份）\n`)
  // `△` ＝ 量到了、说出来了、但不从这道闸判红（那是另一条泳道的写域）。与 `check-workflows.mjs`
  // 对 `harness/` 子树同一符号、同一理由：范围限制要每轮都出现在读的人眼前，而不是写在注释里。
  for (const a of advisories ?? []) process.stdout.write(`  △ ${a}\n`)
  if (problems.length === 0) {
    process.stdout.write('OK：无死链、无失效锚点、双语成对完整、可复算主张与真源一致、每张表格每行格数一致、安装落点不是 world-writable 目录里的固定名字。\n')
    process.exit(0)
  }
  process.stderr.write(`发现 ${problems.length} 处问题：\n`)
  for (const p of problems) process.stderr.write(`  - ${p}\n`)
  process.exit(1)
}
