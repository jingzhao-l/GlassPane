/**
 * §3.5 的最后一道：`apply` 在动手之前必须**重新量一遍**暂存的那份归档。
 *
 * 存在的理由是一起真实的时序缺口：`check` 把归档落盘并按它取摘要，`apply` 却只问
 * "这棵树在不在、形状对不对"（`stagedTreePresent`），然后就在**这棵树**上跑
 * `swift build` 与 `npm pack` + `npm install -g`。同用户任意进程只要在这两步之间往
 * `~/.glasspane` 的暂存目录里写一个文件，它自己的源码就会被编译进 daemon 那份二进制、
 * 由 launchd 带着辅助功能与录屏席位启动。`state.staged.digest` 里那个数字一直是现成的，
 * 只是没人拿它去重新测。
 *
 * 夹具按本仓规矩来：真的 tar.gz 字节（`packTarGz`）、真的暂存目录（`prepareStaging` +
 * `writeArchive` + `extractInto`）、真的文件改动——不是编出来的形状。
 *
 * REVERSE MUTATION：删掉 `applyUpdate` 里 `verifyStagedBytes(...)` 那一步（或把它改成
 * 只比 `stagedTreePresent`）——下面"暂存树被动过就不许构建"那几条一起红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { manifestTree, verifyStagedBytes } from '../lib/apply.js'
import { extractInto, prepareStaging, writeArchive } from '../lib/staging.js'
import { writableRoots } from '../lib/fsutil.js'
import { TMP_PREFIX, buildRelease, removeDir, tempDir } from './helpers.mjs'

/**
 * 一台机器上"刚 check 完、还没 apply"的暂存现场：归档字节、解出来的发布树、以及
 * 状态文件里那份 `staged` 记录（digest/dir/version/rootPath）全都如实填好。
 */
function stageRelease({ version = '9.9.9', treeFiles } = {}) {
  const stateRoot = tempDir(`${TMP_PREFIX}rehash-`)
  const roots = writableRoots(stateRoot)
  const staged = prepareStaging({ stateRoot, version })
  const release = buildRelease({ version, treeFiles })
  writeArchive(staged.archivePath, release.tarball, { stagingRoot: roots.staging })
  const extracted = extractInto({
    treePath: staged.treePath,
    stagingRoot: roots.staging,
    bytes: release.tarball,
  })
  const rootPath = path.join(extracted.treePath, `GlassPane-${version}`)
  return {
    stateRoot,
    version,
    release,
    archivePath: staged.archivePath,
    rootPath,
    staged: {
      dir: staged.dir,
      version,
      digest: release.digest,
      rootPath,
    },
  }
}

test('an untouched staged release re-measures to the digest the state recorded', async () => {
  const f = stageRelease()
  try {
    const out = await verifyStagedBytes({
      stateRoot: f.stateRoot,
      staged: f.staged,
      rootPath: f.rootPath,
    })
    assert.equal(out.ok, true, `一份没人碰过的暂存发布不该被拒：${out.reason}`)
    assert.equal(out.digest, f.release.digest, '回读的摘要必须就是状态里那个数字')
  } finally {
    removeDir(f.stateRoot)
  }
})

test('a file rewritten inside the staged tree after check is refused, by name', async () => {
  const f = stageRelease()
  try {
    // 攻击形态：摘要还是那个摘要（归档没动），动的是解出来的树——`apply` 构建的正是这棵树。
    const target = path.join(f.rootPath, 'engine', 'Sources', 'GlassPaneEngine', 'EngineCore.swift')
    fs.writeFileSync(target, 'public let version = "9.9.9"\n// planted by same-user code after check\n')
    const out = await verifyStagedBytes({
      stateRoot: f.stateRoot,
      staged: f.staged,
      rootPath: f.rootPath,
    })
    assert.equal(out.ok, false, '暂存树被改写后不许照构建')
    assert.match(out.reason, /does not match the tree inside the archive/, out.reason)
    assert.ok(
      out.details?.differences?.some((d) => String(d).includes('EngineCore.swift')),
      `拒绝必须点名是哪个文件变了，只说"不一样"等于让人自己去 diff：${JSON.stringify(out.details)}`,
    )
  } finally {
    removeDir(f.stateRoot)
  }
})

test('a file added inside the staged tree is refused, not silently built', async () => {
  const f = stageRelease()
  try {
    fs.writeFileSync(path.join(f.rootPath, 'mcp-shell', 'extra.js'), 'export const planted = 1\n')
    const out = await verifyStagedBytes({ stateRoot: f.stateRoot, staged: f.staged, rootPath: f.rootPath })
    assert.equal(out.ok, false, '树上多一个文件也是被动过')
    assert.match(out.reason, /extra\.js/, `多出来的文件要能在拒绝里看见：${out.reason}`)
  } finally {
    removeDir(f.stateRoot)
  }
})

test('replaced archive bytes are refused by digest before anything is unpacked', async () => {
  const f = stageRelease()
  try {
    // 另一条攻击路径：整份归档换掉，形状仍然对——这时只有摘要能说话。
    const other = buildRelease({
      version: f.version,
      treeFiles: [{ name: `GlassPane-${f.version}/package.json`, content: '{"swallowed":true}' }],
    })
    fs.writeFileSync(f.archivePath, other.tarball)
    const out = await verifyStagedBytes({ stateRoot: f.stateRoot, staged: f.staged, rootPath: f.rootPath })
    assert.equal(out.ok, false, '摘要对不上就是没交付')
    assert.match(out.reason, /now digests [0-9a-f]{64}/, `拒绝要拿出实测的那个摘要：${out.reason}`)
    assert.match(out.reason, /are not the bytes that were published/, out.reason)
  } finally {
    removeDir(f.stateRoot)
  }
})

test('a staged archive that vanished is refused instead of trusted by shape alone', async () => {
  const f = stageRelease()
  try {
    fs.rmSync(f.archivePath)
    const out = await verifyStagedBytes({ stateRoot: f.stateRoot, staged: f.staged, rootPath: f.rootPath })
    assert.equal(out.ok, false, '归档没了就等于没有任何东西可以证明这棵树')
    assert.match(out.reason, /is no longer on disk/, out.reason)
  } finally {
    removeDir(f.stateRoot)
  }
})

test('a recorded digest that is not a sha256 refuses rather than comparing to nothing', async () => {
  const f = stageRelease()
  try {
    for (const bad of ['', null, 'nope', 'Z'.repeat(64), 'a'.repeat(63)]) {
      const out = await verifyStagedBytes({
        stateRoot: f.stateRoot,
        staged: { ...f.staged, digest: bad },
        rootPath: f.rootPath,
      })
      assert.equal(out.ok, false, `状态里写着 ${JSON.stringify(bad)}，不该有东西被构建`)
      assert.match(out.reason, /not a sha256/, out.reason)
    }
  } finally {
    removeDir(f.stateRoot)
  }
})

test('the re-measure leaves no scratch tree behind in staging', async () => {
  const f = stageRelease()
  try {
    await verifyStagedBytes({ stateRoot: f.stateRoot, staged: f.staged, rootPath: f.rootPath })
    const inside = fs.readdirSync(writableRoots(f.stateRoot).staging).filter((n) => n.includes('apply-verify-'))
    assert.deepEqual(inside, [], `暂存根里不许留下 apply-verify-* ：${inside}`)
    const insideStagedDir = fs.readdirSync(f.staged.dir).filter((n) => n.includes('apply-verify-'))
    assert.deepEqual(insideStagedDir, [], `暂存目录里也不许留下临时解包目录：${insideStagedDir}`)
  } finally {
    removeDir(f.stateRoot)
  }
})

test('manifestTree really reads the bytes on disk (the comparison has to be able to differ)', () => {
  const f = stageRelease()
  try {
    const before = manifestTree(f.rootPath)
    assert.ok(Object.keys(before).length > 0, '空的清单比较等于没有比较')
    fs.writeFileSync(path.join(f.rootPath, 'package.json'), '{"version":"planted"}\n')
    const after = manifestTree(f.rootPath)
    assert.notEqual(before['package.json'].sha256, after['package.json'].sha256, '同一棵树改完还测出同一个摘要，闸就是装饰')
  } finally {
    removeDir(f.stateRoot)
  }
})
