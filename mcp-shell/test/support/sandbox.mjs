/**
 * 测试专用沙箱根目录。
 *
 * 为什么要有这个文件：这些测试过去把夹具建在 `os.tmpdir()` 下，而在 macOS 上那是
 * 每用户私有目录（`/var/folders/…`），在 Linux CI 上是 world-writable 的 `/tmp`。
 * `projectSet` 的边界守卫把 `/tmp`、`/private/tmp`、`/private/var/tmp` 整棵子树列为
 * 保护区（见 src/project-registry.ts 的 PROTECTED_SUBTREES：指向共享暂存目录的证据
 * 人人可读可劫持），所以同一份测试在两个平台上结论相反——本地全绿、CI 全红，且
 * **CI 才是对的**。夹具因此必须落在"自己拥有、非共享暂存、非系统树"的位置。
 *
 * 这里同时做自我断言：一旦有人再把夹具指回受保护树或 world-writable 祖先，
 * 报错直接点名根因，而不是退化成"某个断言在某个平台上偶尔失败"。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_PATH_PROTECTION } from '../../dist/project-registry.js'

/** 沙箱基目录（包内、被 .gitignore 掉，不依赖任何 OS 暂存语义）。 */
const SANDBOX_BASE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.gp-test-sandbox',
)

/** 与被测守卫同一份判据：路径是否落在受保护树里（自身或其任一祖先）。 */
export function underProtectedTree(target) {
  const resolved = path.resolve(target)
  if (AGENT_PATH_PROTECTION.roots.includes(resolved)) return resolved
  for (const tree of AGENT_PATH_PROTECTION.subtrees) {
    if (resolved === tree || resolved.startsWith(`${tree}/`)) return tree
  }
  return null
}

/**
 * 建一个私有沙箱目录：mode 0700、祖先链不含受保护树、不属于 world-writable 目录。
 * @param {string} prefix 目录前缀（便于失败时一眼认出是哪个测试留下的）
 * @returns {{dir: string, dispose: () => void}}
 */
export function privateSandbox(prefix = 'gp-sandbox-') {
  fs.mkdirSync(SANDBOX_BASE, { recursive: true, mode: 0o700 })
  fs.chmodSync(SANDBOX_BASE, 0o700)
  const dir = fs.mkdtempSync(path.join(SANDBOX_BASE, prefix))
  fs.chmodSync(dir, 0o700)

  try {
    const guarded = underProtectedTree(dir)
    assert.equal(
      guarded,
      null,
      `测试沙箱 ${dir} 落在受保护树 ${guarded} 里：夹具不能用共享暂存目录（os.tmpdir() 在 Linux 上就是 /tmp）。`,
    )
    const stat = fs.statSync(dir)
    assert.equal(
      typeof process.getuid === 'function' ? stat.uid === process.getuid() : true,
      true,
      `测试沙箱 ${dir} 的 owner 不是当前 uid，会被 projectSet 的归属规则拒掉。`,
    )
    // 与守卫同一判据：只看**最近的现存祖先**（产品就是这么判的，见
    // src/project-registry.ts 的 nearestExistingAncestor + world-writable 检查），
    // 不是一路爬到根——仓库卷本身可能是 775，那与证据目录是否共享无关。
    const nearest = path.dirname(dir)
    for (const candidate of [dir, nearest]) {
      let st
      try { st = fs.statSync(candidate) } catch { continue }
      if ((st.mode & 0o022) !== 0) {
        throw new Error(
          `测试沙箱 ${candidate} 是 group/world-writable（mode ${(st.mode & 0o777).toString(8)}）：`
          + '任何同组用户都能在这里放文件或软链，projectSet 会拒——夹具必须建在私有 0700 目录下。',
        )
      }
      break
    }
  } catch (error) {
    // 自检失败也要把刚建的目录收掉，不给下一次运行留残骸。
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }

  return {
    dir,
    dispose() {
      fs.rmSync(dir, { recursive: true, force: true })
      try {
        if (fs.existsSync(SANDBOX_BASE) && fs.readdirSync(SANDBOX_BASE).length === 0) {
          fs.rmdirSync(SANDBOX_BASE)
        }
      } catch { /* 并发收尾时目录非空属正常 */ }
    },
  }
}
