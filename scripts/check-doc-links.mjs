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
    .replace(/\s+/g, '-')
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
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
      continue
    }
    if (open) {
      // 带 info string 的开栏（```jsonc）也算开栏；闭合栏必须是同一种字符且不更短。
      fence = open[1]
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

/** 从 mcp-shell 源码里数出真实工具数（不依赖构建产物）。 */
function realToolCount(rootDir = ROOT) {
  const src = path.join(rootDir, 'mcp-shell', 'src', 'tools.ts')
  if (!fs.existsSync(src)) return null
  return (fs.readFileSync(src, 'utf8').match(/^\s*name:\s*"gp_[a-z_]+",/gm) ?? []).length
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

export function check({ rootDir = ROOT, docs = DOCS } = {}) {
  const problems = []
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
      const target = decodeURIComponent(rawTarget)
      if (rawTarget === undefined || rawTarget === '') {
        // 同文档锚点
        const set = anchors.get(doc) ?? new Set()
        if (!set.has(decodeURIComponent(rawAnchor))) {
          problems.push(`${doc}: 同文档锚点失效 → #${rawAnchor}`)
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
        if (set === null) {
          problems.push(`${doc}: 锚点目标读不到 → ${url}`)
        } else if (!set.has(decodeURIComponent(rawAnchor))) {
          problems.push(`${doc}: 跨文档锚点失效 → ${url}`)
        }
      }
    }
  }
  return { docs: present.length, links, external, tables: shape.tables, mdFiles: shape.files, problems }
}

/**
 * shell 残渣闸：文档正文里不许出现 heredoc 结束标记或裸露的 shell 命令行。
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
 * **围栏之外**生效——``` 里面的 shell 记录是文档的正常内容（这一页就有好几段），把围栏也扫进去
 * 是一道永远会误红的闸。
 *
 * "整行不含汉字"这一半不是凑数：判据第一版只看命令词，于是
 * `harness/glasspane-harness/SYNCLOG.md:684` 那句人话（"grep 会把这种管道输入当"二进制"而停止
 * 匹配。"）被判成了残渣——**一道新闸第一次运行就误红了一条别人的文档**。命令词后面接中文不是命令。
 */
const HEREDOC_TERMINATORS = new Set(['EOF', 'MSG', 'PY', 'SQL', 'OUT', 'YAML', 'JSON'])
const HAN = /[\p{Script=Han}]/u

export function shellResidue({ rootDir = ROOT, docs = DOCS } = {}) {
  const problems = []
  for (const doc of docs.filter((d) => fs.existsSync(path.join(rootDir, d)))) {
    const text = read(doc, rootDir)
    let fenced = false
    text.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('```')) { fenced = !fenced; return }
      if (fenced) return
      const trimmed = line.trim()
      if (HEREDOC_TERMINATORS.has(trimmed)) {
        problems.push(`${doc}:${i + 1} 正文里有一行恰好是 heredoc 结束标记（${trimmed}）——`
          + '这是 shell 追加脚本自己漏进正文的残渣，不是文档内容')
        return
      }
      const commandShaped = /^(echo|wc|printf|cat|sed|grep|ls|nohup|tar)\b/.test(trimmed)
        && !HAN.test(trimmed)
        && (/\$\(/.test(trimmed) || /^\w+\s+[-/]/.test(trimmed) || /^\w+\s+["']/.test(trimmed))
      if (commandShaped) {
        problems.push(`${doc}:${i + 1} 正文里出现裸露的 shell 命令行（${trimmed.slice(0, 60)}）——`
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
        + '改成两步：`curl -fsSL <url> -o /tmp/gp-install.sh && sh /tmp/gp-install.sh`')
    })
  }
  return problems
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
 */
const MD_SKIP_DIRS = new Set(['node_modules', '.build', '.git', '.external', '.swiftpm', 'DerivedData', 'dist'])
const MD_SKIP_ROOTS = ['harness/glasspane-harness/packages/']
const MD_MAX_DEPTH = 14
const CELL_PLACEHOLDER = '\u0001'

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
      if (MD_SKIP_ROOTS.some((r) => rel.startsWith(r))) continue
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
    let fenced = false
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; i += 1; continue }
      if (fenced || !mdRow(line)) { i += 1; continue }
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

if (invokedAsEntrypoint()) {
  const { docs, links, external, tables, mdFiles, problems } = check()
  process.stdout.write(`文档 ${docs} 份 | 仓库内链接 ${links} 条 | 外链 ${external} 条（不请求）| markdown 表格 ${tables} 张（扫 ${mdFiles} 份 markdown）\n`)
  if (problems.length === 0) {
    process.stdout.write('OK：无死链、无失效锚点、双语成对完整、可复算主张与真源一致、每张表格每行格数一致。\n')
    process.exit(0)
  }
  process.stderr.write(`发现 ${problems.length} 处问题：\n`)
  for (const p of problems) process.stderr.write(`  - ${p}\n`)
  process.exit(1)
}
