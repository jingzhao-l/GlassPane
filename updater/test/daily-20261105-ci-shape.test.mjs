/**
 * 每日任务 2026-11-05 · 发布链上两处"看不见的那一半"。
 *
 * **一（测试计数的日志集是手抄的）**：`.github/workflows/ci.yml` 的 swift job 里，两条
 * `swift test … | tee /tmp/gp-*.log` 各写自己的目标文件名，而下一步
 * `node scripts/assert-test-count.mjs swift 1 <这些文件>` 的 argv 是**另抄的一份**。
 * `assert-test-count.mjs` 只对交给它的文件负责（它数不到自己没拿到的日志），所以第三条
 * `swift test | tee /tmp/gp-<新>.log` 一旦出现——或者有人把某枚 tee 摘掉——那一格用例就永远
 * 不进计数闸，而 CI 照样全绿。这是本仓第六次"名单永远少下一枚"，只不过这次抄的是同一条 job
 * 里两步之间的文件名。修法：把两侧绑成同一个集合，由这条闸读 ci.yml 自己核对。
 *
 * **二（委托出去的 shell 文件在 SIGPIPE 闸的扫描面外）**：`check-workflows.mjs` 的 2e 只扫
 * workflow 内联 run 体，`tools/*.sh`、`install.sh` 这类被 `bash tools/…` 委托出去的脚本它
 * 看不见。`tools/release-signing-gate.sh:171` 正是这么一处：`gpg --list-keys | awk '…exit'`
 * 在本脚本自己的 `set -euo pipefail` 下，awk 读到第一枚 fpr 就退出，gpg 被 SIGPIPE 打死退 141，
 * 整段在**它该打印 `::error::` 之前**结束——身份闸自伤，报不出它要报的那件事。本轮已改成
 * here-string/文件中转（没有写者就没有可被打断的管道），这里把判据接上。
 *
 * REVERSE：把 `assert-test-count.mjs` 那一步的某个文件名改掉或删掉 ⇒ 第一条红（两侧集合不等）；
 * 把 `keyring_primary_fpr` 改回 `gpg … | awk '…exit'` ⇒ 第二条红并点名那一行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CI = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')

/** 一条 job 的正文：从它的 `name:`/锚点起到下一个顶层 job 为止。 */
function jobBody(anchor) {
  const start = CI.indexOf(anchor)
  assert.ok(start >= 0, `ci.yml 里找不到锚点 ${anchor}——这条闸的对照物没了`)
  const rest = CI.slice(start)
  const next = rest.search(/\n {2}[a-z][\w-]*:\n/)
  return next > 0 ? rest.slice(0, next) : rest
}

test('swift job 里被 tee 出去的日志，与计数闸 argv 吃进去的日志，是同一个集合', () => {
  const body = jobBody('  swift:')
  const tee = [...body.matchAll(/tee\s+(\/[\w./-]+\.log)/g)].map((m) => m[1])
  const count = [...body.matchAll(/assert-test-count\.mjs\s+\S+\s+\d+\s+([^\n]+)/g)]
  assert.ok(tee.length >= 2, `这条 job 只找到 ${tee.length} 处 tee——扫描形状变了，闸在空转`)
  assert.equal(count.length, 1, `计数闸那一步应当只有一条命令，实到 ${count.length} 条`)
  const argv = count[0][1].trim().split(/\s+/).filter((a) => a.endsWith('.log'))
  assert.ok(argv.length >= 2, `计数闸没吃到日志文件（argv=${JSON.stringify(argv)}）——那它什么都数不到`)
  assert.deepEqual(
    [...new Set(argv)].sort(), [...new Set(tee)].sort(),
    'tee 出去的文件名与计数 argv 里的那些不一致：新增的一格 swift test 会跑出日志却永远不进计数闸，'
    + '被摘掉的一格则会让计数闸读一份不存在的文件',
  )
})

test('委托出去的 shell 文件里，提前退出的消费者不许站在管道上', () => {
  const targets = []
  for (const dir of ['tools', '.']) {
    for (const entry of fs.readdirSync(path.join(REPO, dir))) {
      const full = path.join(REPO, dir, entry)
      if (!fs.statSync(full).isFile()) continue
      if (dir === 'tools' ? entry.endsWith('.sh') : entry === 'install.sh') targets.push(full)
    }
  }
  assert.ok(targets.length >= 2, `只扫到 ${targets.length} 份委托脚本——这条闸在空转`)
  const offenders = []
  for (const file of targets) {
    const text = fs.readFileSync(file, 'utf8')
    if (!/set\s+-[euo\s]*pipefail/.test(text)) continue // 没有 pipefail 就没有 141 这一族
    const shapes = [/\|\s*awk\b[^\n]*\bexit\b/, /\|\s*grep\s+-q\b/, /\|\s*head\s+-n\s*\d/]
    text.split('\n').forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('#')) return
      if (shapes.some((s) => s.test(line))) offenders.push(`${path.relative(REPO, file)}:${i + 1}  ${t.slice(0, 78)}`)
    })
  }
  assert.deepEqual(offenders, [],
    `这些行把"读一份就退出的消费者"挂在管道上，而同一文件自己开了 pipefail：写者会被 SIGPIPE 打死，`
    + `整段在它该打印 ::error:: 之前就终止。` + offenders.join('\n'))
})

test('会咬人：把那一行放回去，上面那条判据就得红', async () => {
  const mod = await import('node:fs/promises')
  const file = path.join(REPO, 'tools', 'release-signing-gate.sh')
  const original = await mod.readFile(file, 'utf8')
  const probe = original.replace(
    'awk -F: \'$1=="fpr"{print $10; exit}\' < "${TMPDIR:-/tmp}/gp-keyring-$$.txt"',
    'gpg --homedir "$1" --batch --with-colons --list-keys | awk -F: \'$1=="fpr"{print $10; exit}\'',
  )
  assert.notEqual(probe, original, '变异没落地——这条对照证明不了第二条会红')
  const shapes = [/\|\s*awk\b[^\n]*\bexit\b/, /\|\s*grep\s+-q\b/, /\|\s*head\s+-n\s*\d/]
  const hit = probe.split('\n').some((l) => shapes.some((s) => s.test(l)))
  assert.ok(hit, '放回旧形状却没被抓到：那条闸是坏的')
})
