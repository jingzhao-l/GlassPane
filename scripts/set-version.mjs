#!/usr/bin/env node
/**
 * 改版本线的唯一入口。
 *
 *   node scripts/set-version.mjs 1.2.0
 *
 * 三步：① 只读试算（任一位置异常就一行都不写）→ ② 改写全部派生位点 + 重生成
 * 三个 lockfile，失败则整批回滚快照 → ③ 用与 CI 同一套规则自证。
 *
 * 快照的范围 = ② 会碰到的全部文件：10 个声明位点，加上三个 package-lock.json 在
 * 重生成**之前**的文本。顺序是关键——快照若晚于重生成，回滚就只会把位点退回旧版本、
 * 把已经重生成的 lock 留在新版本上（见 ② 处注释）。
 *
 * `--no-lock`：跳过 lock 重生成，③ 的自证也随之只核对 10 个位点、不把 lock 算作
 * 漂移——否则这个旗标在任何 lock 陈旧的环境里都必然回滚，等于 advertised 了一个做不到的
 * 开关。结束时脚本会明说 lock 还是旧的、check-version 会因此红。
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

/**
 * lockfile 必须在**重生成之前**入快照，不是之后。
 *
 * 原先它们是在 `npm install --package-lock-only` 跑完之后才 `snapshot.set(...)`，
 * 于是快照里存的是**新版本**的 lock 文本。后果正好落在本文件开头那条"绝不留"的反面：
 * LOCK_DIRS 里任何一个靠后的目录失败时，回滚把 10 个声明位点恢复成旧版本，而已经重生成
 * 完的前几个 lock 停在快照里那份新版本上——npm 包版本回 1.7.0、它的 lock 留 1.7.1，
 * 就是"部分统一"本身。
 *
 * `null` 代表重生成前这个 lock 压根不存在；回滚时把它删掉，否则"回滚后版本线保持原样"
 * 这句话对一个新生成的文件就是假的。
 */
const lockRelOf = (dir) => path.posix.join(dir, 'package-lock.json')
if (!skipLock) {
  for (const rel of LOCK_DIRS.map(lockRelOf)) {
    const abs = path.join(ROOT, rel)
    snapshot.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null)
  }
}

function rollback(reason) {
  for (const [file, text] of snapshot) {
    const abs = path.join(ROOT, file)
    if (text === null) {
      fs.rmSync(abs, { force: true })
      continue
    }
    fs.writeFileSync(abs, text)
  }
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
      rollback(`lockfile 重生成失败（${lockRelOf(dir)}）`)
    }
    process.stdout.write(`lockfile 已同步：${lockRelOf(dir)}\n`)
  }
}

// --- ③ 自证 ----------------------------------------------------------------
// ③ 的口径必须跟 ② 一致。`--no-lock` 的意思就是"这一趟不碰 lock"，而原先这里无条件
// 调用 `drift(arg)`，lock 条目照样算漂移——于是带 `--no-lock` 且 lock 是旧版本时脚本
// 必然回滚、永远不可能成功：usage 里 advertised 的旗标其实做不到它说的事。选择保留并
// 修正旗标（而不是删掉它），因为"只改位点、先不动 lock"是发布前排查时真要用的一档。
// 跳过的只有 lock 条目；10 个声明位点仍然全查，仍然是一个都不许漂。
const remaining = drift(arg, { locks: !skipLock })
if (remaining.length > 0) {
  rollback(`改写后仍与 ${arg} 漂移：\n${remaining.map((r) => `  - ${r.kind} ${r.where}: ${r.actual} ≠ ${r.target}`).join('\n')}`)
}
process.stdout.write(`\n版本线已统一到 ${arg}，且按 check-version 规则自证通过。\n`)
if (skipLock) {
  // 自证没看 lock，不代表 lock 没问题——这行必须说出来，否则"通过"两个字会被读成
  // "CI 也会通过"，而 CI 跑的 check-version 是看 lock 的。
  process.stdout.write(`注意：--no-lock 跳过了 lockfile 重生成，三个 package-lock.json 仍是旧版本。\n`)
  process.stdout.write('      node scripts/check-version.mjs 会因 lock 条目报漂移；发布前必须去掉 --no-lock 重跑一次。\n')
}
process.stdout.write('下一步（发布属 owner 显式动作，本脚本不代做）：\n')
process.stdout.write(`  git add -A && git commit -m "release: ${arg}"\n`)
process.stdout.write(`  node scripts/check-version.mjs   # CI 同一规则，本地复跑\n`)
