/**
 * 版本线真源定义（scripts/set-version.mjs 与 scripts/check-version.mjs 共用）。
 *
 * 口径（2026-09-22 拍板）：**全仓库统一版本线**——同一个数字同时是根 workspace、
 * 两个 npm 包（glasspane-mcp / glasspane-install）、kernel、MCP initialize 自报、
 * Swift daemon hello 自报、.app bundle 版本，以及 install.sh / installer 钉住的
 * 发布 tag。真源 = 根 `package.json` 的 `version`；其余都是派生位点，由脚本改写。
 *
 * 每个位点的正则统一为三组：`$1` 前缀包装、`$2` 版本值、`$3` 收尾包装，且必须
 * **恰好命中一次**：命中 0 次说明位点被改名或删除（静默漏改比报错危险），命中
 * 多次说明正则太宽（会改到别人的字面量）。两种都直接失败，不留"部分统一"的中间态。
 *
 * 注意：schema 版本（`glasspane.evidence/0.1-draft` 这类 `$id` 与
 * `legacySchemaVersions`）**不属于**发布版本线——那是数据契约版本，随 iterate
 * kernel 的节奏单独演进，故不入本表。
 */
import fs from 'node:fs'
import path from 'node:path'

/** npm semver（可带 `- prerelease`）。 */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 仓库根（本文件位于 `<root>/scripts/`）。 */
export const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * 派生位点表：`regex` 必须给出三个捕获组（前缀 / 版本值 / 收尾）。
 * @type {{ id: string, file: string, regex: RegExp, hint: string }[]}
 */
export const SITES = [
  {
    id: 'root package.json（真源）',
    file: 'package.json',
    regex: /("version":\s*")([^"]+)(")/,
    hint: '版本线真源',
  },
  {
    id: 'glasspane-mcp',
    file: 'mcp-shell/package.json',
    regex: /("version":\s*")([^"]+)(")/,
    hint: 'npm 包版本',
  },
  {
    id: 'glasspane-install',
    file: 'installer/package.json',
    regex: /("version":\s*")([^"]+)(")/,
    hint: 'npm 包版本',
  },
  {
    id: '@iterate/kernel',
    file: 'kernel/package.json',
    regex: /("version":\s*")([^"]+)(")/,
    hint: '不单独发布，随 mcp-shell 捆绑内联',
    // 已知将来变化：kernel 正被迁成 iterate-skill 主仓的 canonical + 本仓镜像
    // （分支 kernel-migration，未合 main）。若那条落地，kernel 的版本归 iterate
    // 节奏，应从本表删掉这一位点——届时守卫会因镜像回写而报漂移，属预期信号。
  },
  {
    id: 'MCP serverInfo.version',
    file: 'mcp-shell/src/dispatch.ts',
    regex: /(SERVER_INFO = \{ name: "glasspane-mcp", version: ")([^"]+)(")/,
    hint: 'MCP 客户端看到的服务器版本',
  },
  {
    id: 'daemon hello version',
    file: 'engine/Sources/GlassPaneEngine/EngineCore.swift',
    regex: /(public let version = ")([^"]+)(")/,
    hint: 'glasspaned 自报版本（设置面板与证据包同源）',
  },
  {
    id: 'CFBundleShortVersionString',
    file: 'engine/scripts/make-app.sh',
    regex: /(<key>CFBundleShortVersionString<\/key>\s*\n\s*<string>)([^<]+)(<\/string>)/,
    hint: '.app bundle 版本（系统设置/关于框显示）',
  },
  {
    id: 'install.sh 钉 ref',
    file: 'install.sh',
    regex: /(GLASSPANE_RELEASE="v)([^"]+)(")/,
    hint: '一键安装 clone 的发布 tag（可复现性锚点）',
  },
  {
    id: 'installer 钉 ref',
    file: 'installer/cli.js',
    regex: /(export const RELEASE_VERSION = ')([^']+)(')/,
    hint: 'npx 引导 clone 的发布 tag',
  },
]

/** lockfile 里必须与版本线一致的 workspace 条目（`npm ci` 与 manifest 失配面）。 */
export const LOCKFILES = [
  { file: 'package-lock.json', keys: ['', 'kernel', 'mcp-shell', 'installer'] },
  { file: 'kernel/package-lock.json', keys: [''] },
  { file: 'mcp-shell/package-lock.json', keys: [''] },
]

function withGlobal(re) {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
}

function read(site) {
  const abs = path.join(ROOT, site.file)
  if (!fs.existsSync(abs)) return { text: null, hits: -1 }
  const text = fs.readFileSync(abs, 'utf8')
  return { text, hits: [...text.matchAll(withGlobal(site.regex))] }
}

/** 位点当前值；文件缺失、未命中或多命中都返回 null（调用方按漂移处理）。 */
export function siteValue(site) {
  const { text, hits } = read(site)
  if (text === null || !Array.isArray(hits) || hits.length !== 1) return null
  return hits[0][2]
}

/** 位点命中次数：-1 = 文件缺失，0 = 未命中，>1 = 正则太宽。 */
export function siteHitCount(site) {
  const { hits } = read(site)
  return typeof hits === 'number' ? hits : hits.length
}

/** 改写单个位点。返回 { ok, message }，绝不静默半改。 */
export function applySite(site, version) {
  const abs = path.join(ROOT, site.file)
  const { text, hits } = read(site)
  if (text === null) return { ok: false, message: `文件缺失：${site.file}` }
  if (typeof hits === 'number') return { ok: false, message: `位点未命中：${site.file}（正则与现状不符）` }
  if (hits.length === 0) return { ok: false, message: `位点未命中：${site.file}（正则与现状不符）` }
  if (hits.length > 1) return { ok: false, message: `位点在 ${site.file} 命中 ${hits.length} 次（正则太宽）` }
  if (hits[0][2] === version) return { ok: true, message: `${site.file} 已是 ${version}`, unchanged: true }
  const next = text.replace(site.regex, `$1${version}$3`)
  if (next === text) return { ok: false, message: `替换后内容无变化：${site.file}（正则异常）` }
  fs.writeFileSync(abs, next)
  return { ok: true, message: `${site.file} → ${version}` }
}

/** lockfile 中与版本线相关条目的当前 version（link/file: 条目无 version，跳过）。 */
export function lockVersions(lock) {
  const abs = path.join(ROOT, lock.file)
  if (!fs.existsSync(abs)) return [{ key: '(整档)', actual: null, missing: true }]
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'))
  const out = []
  for (const key of lock.keys) {
    const entry = data.packages?.[key]
    if (!entry) {
      out.push({ key: key === '' ? '(root)' : key, actual: null, missing: true })
      continue
    }
    if (entry.link || !entry.version) continue
    out.push({ key: key === '' ? '(root)' : key, actual: entry.version, missing: false })
  }
  return out
}

/** 真源版本（根 package.json 的 version）。 */
export function truthVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
}

/**
 * 全量核对：返回漂移列表（空数组 = 版本线一致）。
 * @param {string|null} want 期望版本；null 时取真源
 */
export function drift(want = null) {
  const target = want ?? truthVersion()
  const rows = []
  for (const site of SITES) {
    const actual = siteValue(site)
    if (actual === null) {
      rows.push({ kind: '位点', where: `${site.id} (${site.file})`, actual: '未命中/文件缺失', target })
    } else if (actual !== target) {
      rows.push({ kind: '位点', where: `${site.id} (${site.file})`, actual, target })
    }
  }
  for (const lock of LOCKFILES) {
    for (const entry of lockVersions(lock)) {
      if (entry.actual !== target) {
        rows.push({ kind: 'lock', where: `${lock.file} → ${entry.key}`, actual: String(entry.actual), target })
      }
    }
  }
  return rows
}
