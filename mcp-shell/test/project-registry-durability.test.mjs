/**
 * `gp_project_set` 落盘的顺序闸（2026-10-16）。
 *
 * 缺陷形状：这一层是 projects.json 的**生产写者之一**（另外两个是 daemon 的一次性 CLI
 * 与设置面板转过去的那条），而它原来只做 `writeFileSync(tmp)` + `renameSync`。rename 是
 * 原子的，但它原子的是**目录项**，不是字节：断电之后 `projects.json` 可以在 inode 还挂在
 * 缓冲写回队列里的时候就被发布出去，而 `gp_project_set` 已经回了"已保存"。Swift 那三份
 * 存储本轮已经改成 open→write→fsync(fd)→close→rename→sync 目录
 * （engine/Sources/GlassPaneEngine/DurableFileWrite.swift）；只改那一半就是半修——面板/CLI
 * 读到的承诺与这一层写下的承诺不是同一个。
 *
 * 反向变异：
 * · 把 `fs.fsyncSync(fd)` 删掉（回到 writeFileSync 直接改名）→ 第 1 条红（顺序里没有 fsync）。
 * · 把 fsync 的失败往外抛而不走"这次写没成"的拒绝路径 → 第 2 条红。
 * · 让 `syncDirectory` 在 EIO 时也吞掉 → 第 3 条红。
 * 每条都用真文件、真 rename、真注入 errno；桩不会替一个不存在的保证背书。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  PROJECTS_FILE_ENV,
  ProjectRegistryError,
  projectSet,
} from '../dist/project-registry.js'
import { privateSandbox } from './support/sandbox.mjs'

const BASE = { bundleId: 'com.example.durability', displayName: 'durability' }

function useRegistryFile(sandboxDir) {
  const filePath = path.join(sandboxDir, 'projects.json')
  const previous = process.env[PROJECTS_FILE_ENV]
  process.env[PROJECTS_FILE_ENV] = filePath
  return { filePath, restore: () => (previous === undefined ? delete process.env[PROJECTS_FILE_ENV] : (process.env[PROJECTS_FILE_ENV] = previous)) }
}

/** 记录 fsync / rename 的真实调用顺序，跑完原样还回去。 */
function recordOrder({ fsyncFailsWith, dirFailsWith } = {}) {
  const order = []
  const originalFsync = fs.fsyncSync
  const originalRename = fs.renameSync
  const originalOpen = fs.openSync
  const originalClose = fs.closeSync
  let dirFsyncAttempts = 0
  fs.openSync = (...args) => {
    // 目录那一次 open 是 rename 之后的 sync 目录项；记下来供第 3 条判据。
    if (typeof args[0] === 'string' && !args[0].includes('.tmp-')) order.push(`open:${path.basename(args[0])}`)
    return originalOpen(...args)
  }
  fs.fsyncSync = (fd) => {
    order.push('fsync')
    if (fsyncFailsWith) {
      if (dirFailsWith && dirFsyncAttempts >= 1) throw dirFailsWith
      throw fsyncFailsWith
    }
    if (dirFsyncAttempts >= 1 && dirFailsWith) throw dirFailsWith
    dirFsyncAttempts += 1
    return originalFsync(fd)
  }
  fs.renameSync = (from, to) => {
    order.push('rename')
    return originalRename(from, to)
  }
  fs.closeSync = (fd) => originalClose(fd)
  return {
    order,
    restore: () => {
      fs.fsyncSync = originalFsync
      fs.renameSync = originalRename
      fs.openSync = originalOpen
      fs.closeSync = originalClose
    },
  }
}

test('projects.json 的字节先落盘，再发布那个路径名', () => {
  const sandbox = privateSandbox('gp-registry-durable-')
  const reg = useRegistryFile(sandbox.dir)
  const spy = recordOrder()
  try {
    projectSet({ ...BASE })
    const fsyncAt = spy.order.indexOf('fsync')
    const renameAt = spy.order.indexOf('rename')
    assert.ok(fsyncAt >= 0, `一次注册写完居然没有 fsync 过任何 fd：${spy.order.join(',')}`)
    assert.ok(renameAt >= 0, `没有 rename：${spy.order.join(',')}`)
    assert.ok(fsyncAt < renameAt, `fsync 必须在 rename 之前——否则"已保存"说的是一个还没落盘的字节序列：${spy.order.join(',')}`)
    // 目录项也要 sync：不然被 sync 的只是文件内容，路径名这一条仍然可能只在内存里。
    assert.ok(spy.order.lastIndexOf('fsync') > renameAt, `rename 之后没有 sync 目录：${spy.order.join(',')}`)
    const written = JSON.parse(fs.readFileSync(reg.filePath, 'utf8'))
    assert.equal(written[0].bundleId, BASE.bundleId, '落盘的应当就是这一次注册的那条')
    assert.deepEqual([...fs.readdirSync(sandbox.dir).filter((n) => n.includes('.tmp-'))], [],
                    '成功路径不留临时文件')
  } finally {
    spy.restore()
    reg.restore()
    fs.rmSync(sandbox.dir, { recursive: true, force: true })
  }
})

test('fsync 失败 = 这次写没成，不是"已保存"', () => {
  const sandbox = privateSandbox('gp-registry-fsync-fail-')
  const reg = useRegistryFile(sandbox.dir)
  const eio = Object.assign(new Error('simulated EIO'), { code: 'EIO' })
  const spy = recordOrder({ fsyncFailsWith: eio })
  try {
    assert.throws(
      () => projectSet({ ...BASE }),
      (error) => error instanceof ProjectRegistryError,
      'fd 同步失败却回"已保存"，就是这一条缺陷的正面',
    )
    assert.equal(fs.existsSync(reg.filePath), false, `同步失败之后仍把 projects.json 发布出来了：${fs.existsSync(reg.filePath)}`)
    assert.deepEqual([...fs.readdirSync(sandbox.dir).filter((n) => n.includes('.tmp-'))], [],
                    '半途而废的临时文件必须清掉，不许留在别人要读的目录里')
  } finally {
    spy.restore()
    reg.restore()
    fs.rmSync(sandbox.dir, { recursive: true, force: true })
  }
})

test('控制：目录 sync 成功时照旧落盘；不支持目录 sync 的卷不因此拒绝一次成功的写', () => {
  const sandbox = privateSandbox('gp-registry-dirsync-')
  const reg = useRegistryFile(sandbox.dir)
  try {
    const ok = projectSet({ ...BASE })
    assert.ok(ok, '对照组：不带任何注入时这一次写是成功的')
  } finally {
    reg.restore()
    fs.rmSync(sandbox.dir, { recursive: true, force: true })
  }

  // 第二种卷：目录项 sync 报"这里不支持"（EINVAL/ENOTSUP）。字节已经落盘，
  // 把这种卷判成"没保存"就是拿一个测不出来的东西去拒一次正常的写。
  const sandbox2 = privateSandbox('gp-registry-dirsync-unsupported-')
  const reg2 = useRegistryFile(sandbox2.dir)
  const originalFsync = fs.fsyncSync
  let calls = 0
  fs.fsyncSync = (fd) => {
    calls += 1
    if (calls >= 2) {
      throw Object.assign(new Error('not supported'), { code: 'EINVAL' })
    }
    return originalFsync(fd)
  }
  try {
    projectSet({ ...BASE, displayName: 'on a volume without directory sync' })
    assert.equal(JSON.parse(fs.readFileSync(reg2.filePath, 'utf8'))[0].displayName,
                 'on a volume without directory sync',
                 '文件级的 fsync 成功了，路径也发布了——这一条写是成了的')
  } finally {
    fs.fsyncSync = originalFsync
    reg2.restore()
    fs.rmSync(sandbox2.dir, { recursive: true, force: true })
  }

  // 而同一个位置报 EIO 就必须拒（第 3 条反向变异点）。
  const sandbox3 = privateSandbox('gp-registry-dirsync-eio-')
  const reg3 = useRegistryFile(sandbox3.dir)
  let calls3 = 0
  fs.fsyncSync = (fd) => {
    calls3 += 1
    if (calls3 >= 2) throw Object.assign(new Error('real I/O error'), { code: 'EIO' })
    return originalFsync(fd)
  }
  try {
    assert.throws(() => projectSet({ ...BASE, displayName: 'eio after rename' }),
                  (error) => error instanceof ProjectRegistryError,
                  '目录 sync 报 EIO 还回"已保存"，说的是同一件没发生的保证')
  } finally {
    fs.fsyncSync = originalFsync
    reg3.restore()
    fs.rmSync(sandbox3.dir, { recursive: true, force: true })
  }
})
