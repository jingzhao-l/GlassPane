#!/usr/bin/env node
/**
 * 改版本线的唯一入口。
 *
 *   node scripts/set-version.mjs 1.2.0
 *
 * 三步：① 只读试算（任一位置异常就一行都不写）→ ② 改写全部派生位点 + 重生成
 * 三个 lockfile，失败则整批回滚快照 → ③ 用与 CI 同一套规则自证。
 *
 * 为什么要原子回滚："部分统一"比"改不动"危险得多——npm 包版本、daemon 自报版本
 * 与 install.sh 钉的发布 tag 一旦各自漂移，用户装到的和仓库里的就对不上了。
 *
 * 故意不做的事：不建 git tag、不建 GitHub Release、不 npm publish——那些是发布
 * 动作，由 owner 显式触发（tag/Release 资产走 release.yml；npm 走 CI provenance）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ROOT, SEMVER_RE, SITES, applySite, drift, siteValue } from './version-sites.mjs'

/** lock 重生成要跑的目录：根（workspaces）+ 两个自带独立 lock 的子包。 */
const LOCK_DIRS = ['.', 'kernel', 'mcp-shell']

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const arg = process.argv[2]
if (!arg || arg === '--help' || arg === '-h') {
  process.stdout.write(`用法: node ${path.relative(process.cwd(), import.meta.filename)} <semver> [--no-lock]\n`)
  process.exit(arg ? 0 : 1)
}
if (!SEMVER_RE.test(arg)) fail(`版本号不是合法 semver：${arg}`)
const skipLock = process.argv.slice(3).includes('--no-lock')

// --- ① 只读试算 -------------------------------------------------------------
const problems = []
for (const site of SITES) {
  if (siteValue(site) === null) {
    problems.push(`位点异常：${site.id} (${site.file}) —— 未命中或命中多次`)
  }
}
if (problems.length > 0) {
  fail(`${problems.join('\n')}\n中断，未改动任何文件。`)
}

// --- ② 改写 + 快照回滚 ------------------------------------------------------
const snapshot = new Map()
for (const site of SITES) snapshot.set(site.file, fs.readFileSync(path.join(ROOT, site.file), 'utf8'))

function rollback(reason) {
  for (const [file, text] of snapshot) fs.writeFileSync(path.join(ROOT, file), text)
  fail(`${reason}\n已回滚 ${snapshot.size} 个文件，版本线保持原样。`)
}

for (const site of SITES) {
  const result = applySite(site, arg)
  if (!result.ok) rollback(`位点改写失败：${result.message}`)
}
process.stdout.write(`位点改写完成（${SITES.length} 处）→ ${arg}\n`)

if (!skipLock) {
  for (const dir of LOCK_DIRS) {
    const args = dir === '.'
      ? ['install', '--package-lock-only', '--workspaces', '--include-workspace-root', '--no-audit', '--no-fund']
      : ['install', '--package-lock-only', '--no-workspaces', '--no-audit', '--no-fund']
    const result = spawnSync('npm', args, { cwd: path.join(ROOT, dir), encoding: 'utf8' })
    if (result.status !== 0) {
      process.stderr.write(`${(result.stderr ?? '') + (result.stdout ?? '')}\n`)
      rollback(`lockfile 重生成失败（${dir}/package-lock.json）`)
    }
    // lock 文件也纳入快照，回滚时一并恢复
    if (!snapshot.has(`${dir}/package-lock.json`)) {
      snapshot.set(`${dir}/package-lock.json`, fs.readFileSync(path.join(ROOT, dir, 'package-lock.json'), 'utf8'))
    }
    process.stdout.write(`lockfile 已同步：${dir}/package-lock.json\n`)
  }
}

// --- ③ 自证 ----------------------------------------------------------------
const remaining = drift(arg)
if (remaining.length > 0) {
  rollback(`改写后仍与 ${arg} 漂移：\n${remaining.map((r) => `  - ${r.kind} ${r.where}: ${r.actual} ≠ ${r.target}`).join('\n')}`)
}
process.stdout.write(`\n版本线已统一到 ${arg}，且按 check-version 规则自证通过。\n`)
process.stdout.write('下一步（发布属 owner 显式动作，本脚本不代做）：\n')
process.stdout.write(`  git add -A && git commit -m "release: ${arg}"\n`)
process.stdout.write(`  node scripts/check-version.mjs   # CI 同一规则，本地复跑\n`)
