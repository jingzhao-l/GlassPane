#!/usr/bin/env node
/**
 * 对外文档的死链与锚点检查（CI 门禁 = 本文件，退出码即判定）。
 *
 * 面向陌生读者的文档一旦改名/拆分就会留死链，而这只有真去点才会发现——所以把
 * "点一遍"变成机器动作。检查三类目标：
 *   1) 仓库内相对路径（含 specs/ 的中文文件名，需 URL 解码后比对磁盘）；
 *   2) 同文档/跨文档的 #锚点（按 GitHub 的标题 slug 规则就地复算）；
 *   3) 语言镜像对偶文件是否存在（README.md ↔ README.zh-CN.md 等成对约定）。
 *
 * 外部 http(s) 链接只统计数量，不请求（CI 网络抖动不该红掉文档检查）。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** 参与检查的对外文档；新增公共文档时在这里登记。 */
const DOCS = [
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'SECURITY.zh-CN.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING.zh-CN.md',
  'CHANGELOG.md',
  'ITERATE.md',
  '.github/pull_request_template.md',
]

/** 成对文档：任一侧缺失即漂移（双语约定不能只留一条腿）。 */
const MIRROR_PAIRS = [
  ['README.md', 'README.zh-CN.md'],
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

/** 收集一个 md 文件里所有标题锚点（含 GitHub 对重名标题的 -1/-2 后缀）。 */
function headingsOf(text) {
  const seen = new Map()
  const out = new Set()
  for (const line of text.split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!m) continue
    const title = m[2].replace(/\s+#+\s*$/, '')
    if (/^```/.test(title)) continue
    let base = slug(title)
    if (!base) continue
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.add(n === 0 ? base : `${base}-${n}`)
  }
  return out
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 从 mcp-shell 源码里数出真实工具数（不依赖构建产物）。 */
function realToolCount() {
  const src = path.join(ROOT, 'mcp-shell', 'src', 'tools.ts')
  if (!fs.existsSync(src)) return null
  return (fs.readFileSync(src, 'utf8').match(/^\s*name:\s*"gp_[a-z_]+",/gm) ?? []).length
}

/** 扫描文档中"\d+ (MCP|个) tools/工具"式表述，与真实数量比对。 */
function toolCountDrift() {
  const real = realToolCount()
  if (real === null) return ['无法从 mcp-shell/src/tools.ts 数出工具数量']
  const out = []
  const pattern = /(\d+)\s*(?:MCP tools|`gp_\*` MCP tools|个 MCP 工具|个 `gp_\*`|个工具)/g
  for (const doc of DOCS.filter((d) => fs.existsSync(path.join(ROOT, d)))) {
    const text = read(doc)
    for (const m of text.matchAll(pattern)) {
      if (m[0].includes('gp_act') || m[0].includes('动词')) continue
      if (Number(m[1]) !== real) {
        out.push(`${doc}: 写了 ${m[1]} 个工具，代码里实际是 ${real} 个（"\${m[1]} …"）`)
      }
    }
  }
  return out
}

export function check() {
  const problems = []
  const present = DOCS.filter((d) => fs.existsSync(path.join(ROOT, d)))
  const anchors = new Map(present.map((d) => [d, headingsOf(read(d))]))

  // 文档里抄写的工具数量必须等于代码里的真实数量：README 用"15 个工具"这种说法
  // 是好意（读者不必自己数），但手抄数字必然漂移，所以让它可验证。
  const countProblems = toolCountDrift()
  problems.push(...countProblems)

  for (const [a, b] of MIRROR_PAIRS) {
    const ea = fs.existsSync(path.join(ROOT, a))
    const eb = fs.existsSync(path.join(ROOT, b))
    if (ea !== eb) problems.push(`${a} 与 ${b} 只有一侧存在（双语约定缺腿）`)
  }

  let links = 0
  let external = 0
  for (const doc of present) {
    const text = read(doc)
    const codeFences = new Set()
    let inFence = false
    text.split('\n').forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
      if (inFence) codeFences.add(i)
    })
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
      const abs = path.join(ROOT, path.dirname(doc), target)
      if (!fs.existsSync(abs)) {
        problems.push(`${doc}: 相对路径不存在 → ${url}`)
        continue
      }
      if (rawAnchor && fs.statSync(abs).isFile() && abs.endsWith('.md')) {
        const rel = path.relative(ROOT, abs).split(path.sep).join('/')
        const set = anchors.get(rel)
        if (set && !set.has(decodeURIComponent(rawAnchor))) {
          problems.push(`${doc}: 跨文档锚点失效 → ${url}`)
        }
      }
    }
  }
  return { docs: present.length, links, external, problems }
}

const { docs, links, external, problems } = check()
process.stdout.write(`文档 ${docs} 份 | 仓库内链接 ${links} 条 | 外链 ${external} 条（不请求）\n`)
if (problems.length === 0) {
  process.stdout.write('OK：无死链、无失效锚点、双语成对完整。\n')
  process.exit(0)
}
process.stderr.write(`发现 ${problems.length} 处问题：\n`)
for (const p of problems) process.stderr.write(`  - ${p}\n`)
process.exit(1)
