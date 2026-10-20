/**
 * install.sh 从 1.18.0 起在 clone 之前拒非 macOS 的主机（README 两份都写着 "macOS 14+"，
 * 而那笔 clone 是这台机器白付的最大一笔）。CI 的 install-gate 那一格跑在 ubuntu 上，它测的是
 * install.sh 的**决策**（分支、形状闸、归因、透传），不是"这台机器能不能装 GlassPane"——
 * 所以这一格在导入时给子进程 PATH 前置一枚报 Darwin 的 `uname`，让那些判据继续被真的跑到。
 *
 * 平台闸自己由 `daily-20261020.test.mjs` 钉：它反过来用一枚 Linux 的 `uname` 桩，在两件事上
 * 各自有断言——真跑必须在 clone 之前退 1 且 clone 目录仍是空的，dry-run 必须既把 clone 计划
 * 打出来、又说明"真跑会停在平台闸"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

let stubDir = null

export function ensureDarwinHost() {
  if (stubDir !== null) return
  // 判据是**子进程会看到的** `uname -s`，不是 node 自己的 `process.platform`：install.sh 问的是
  // 前者，而本机上跑"假如是 Linux"的对照时，PATH 里已经有一枚报 Linux 的桩——按 platform 判会
  // 直接放行，于是这格在 CI 上测的和在本地测的不是同一件事。
  let kernel = ''
  try {
    kernel = spawnSync('uname', ['-s'], { encoding: 'utf8' }).stdout?.trim() ?? ''
  } catch {
    kernel = ''
  }
  if (kernel === 'Darwin') return
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-darwin-host-'))
  fs.writeFileSync(path.join(stubDir, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 })
  process.env.PATH = `${stubDir}:${process.env.PATH}`
  process.on('exit', () => {
    if (stubDir !== null) fs.rmSync(stubDir, { recursive: true, force: true })
  })
}

ensureDarwinHost()
