#!/usr/bin/env node
/**
 * 版本线漂移检查（CI 门禁 = 本文件，退出码即判定）。
 *
 *   node scripts/check-version.mjs            # 以根 package.json 为真源
 *   node scripts/check-version.mjs 1.1.0      # 断言真源本身等于该值
 *
 * 同时打印整条版本线的当前值，便于发布时一眼核对"要发的是哪个号"。
 */
import process from 'node:process'
import { LOCKFILES, SEMVER_RE, SITES, drift, lockVersions, siteValue, truthVersion } from './version-sites.mjs'

const want = process.argv[2]
if (want && !SEMVER_RE.test(want)) {
  process.stderr.write(`参数不是合法 semver：${want}\n`)
  process.exit(2)
}

const target = want ?? truthVersion()
process.stdout.write(`版本线真源（根 package.json）= ${truthVersion()}\n\n`)
for (const site of SITES) {
  const value = siteValue(site)
  const mark = value === null ? 'x' : value === target ? '✓' : '≠'
  process.stdout.write(`  ${mark} ${site.id.padEnd(28)} ${String(value).padEnd(14)} ${site.file}\n`)
}
for (const lock of LOCKFILES) {
  for (const entry of lockVersions(lock)) {
    const mark = entry.actual === target ? '✓' : '≠'
    process.stdout.write(`  ${mark} lock ${entry.key.padEnd(24)} ${String(entry.actual).padEnd(14)} ${lock.file}\n`)
  }
}

const rows = drift(want ?? null)
if (rows.length === 0) {
  process.stdout.write(`\nOK：版本线一致（${target}）。\n`)
  process.exit(0)
}
process.stderr.write(`\n版本线漂移 ${rows.length} 处（真源 ${target}）：\n`)
for (const row of rows) process.stderr.write(`  - ${row.kind} ${row.where}: ${row.actual} ≠ ${row.target}\n`)
process.stderr.write('\n修复：node scripts/set-version.mjs <version>（唯一入口，勿手改单个 package.json）\n')
process.exit(1)
