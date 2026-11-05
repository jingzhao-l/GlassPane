/**
 * 2026-11-05（lane：安装器验签必须点名钥匙）—— P1。
 *
 * 缺陷：`classifyTagVerify` 的判据是 `status === 0`，而 `GLASSPANE_SIGNING_KEY_ID` 从
 * `installer/cli.js` 导出之后**没有任何一处判据读回它**（本机 grep 确认）。它的文档注释还写着
 * "退出码 0 = 用已导入的发布公钥验签通过"——代码没有强制过这件事。gpg 的退出码只说明
 * "有一把钥匙把这枚签名验过了"，它是哪一把写在 stderr 的 `using RSA key <指纹>` 那一行里。
 * 于是一把别人的钥匙（同名 tag、中间人换掉公钥后的新钥匙）签出的 tag 在这里读成
 * "GPG 签名验证通过"，屏幕上那行绿字替没锚过的字节作保。
 *
 * 失败模式（三条，都要有读数）：
 *  · rc=0 + 非钉死的 key id → `invalid`（硬拒，detail 同时点名观察到的与钉死的两枚指纹）；
 *  · rc=0 + 读不出任何 key id → `unavailable`（这道检查没给出结论，fail closed 进既有那一档，
 *    只有 `--accept-unverified-signature` 才放行，且放行话仍写"没有验签结论"）；
 *  · 判据依赖英文措辞，而那几趟 spawn 从前不钉 `LC_ALL`：同一枚健康的 tag 在中文 locale 的
 *    机器上回 `gpg: 使用 RSA 密钥 …`（本机实测），读不出措辞 → 落在上面那一档。现在 spawn
 *    钉 `LC_ALL=C LANG=C`，并用 `-c gpg.program=gpg -c gpg.format=openpgp` 压住
 *    被验那棵树自己的 `.git/config`（否则仓库能决定"校验器"是什么程序）。
 *
 * REVERSE MUTATION（下面的编号就是本文件里 test() 的出现顺序；红点是本机逐条跑出来的）：
 *  · M1 把 `classifyTagVerify` 退回"status===0 就 verified" ⇒ 第 2、3、4、7、8、9 条红，
 *    `cli.test.mjs` 的三条 classifyTagVerify 一起红；
 *  · M2 把 verified 的 detail 改回不含指纹的那句 ⇒ 第 2、7 条红；
 *  · M3 把 `verifyEnv` 里的 `LC_ALL/LANG` 摘掉 ⇒ 第 5 条红（记下来的 env 里没有它），
 *    在这台中文 locale 的机器上第 7 条也红（真那一趟读不出措辞）；
 *  · M4 把 `-c gpg.program=gpg -c gpg.format=openpgp` 摘掉 ⇒ 第 5 条红（argv 里少了那两枚旗标）；
 *  · M5 让 `keyIdMatchesPinned` 永远回真 ⇒ 第 3、9 条红，`cli.test.mjs` 的 foreign 那一条也红；
 *  · 把 `GLASSPANE_SIGNING_KEY_ID` 改成别的 40 位十六进制 ⇒ 第 6 条红（真 gpg 从内置公钥
 *    重推出的指纹与它对不上），第 1、2、3、4、7、8、9 条一起红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  GLASSPANE_SIGNING_KEY_ID,
  GLASSPANE_SIGNING_PUBLIC_KEY,
  RELEASE_VERSION,
  classifyTagVerify,
  commandAvailable,
  normalizePinnedKeyId,
  repoHasRef,
  signatureKeyIds,
  tagVerifyDecision,
  verifyCloneTagGpg,
} from '../cli.js'
import {
  BAD_SIG_STDERR,
  FOREIGN_KEY_ID,
  FOREIGN_SIG_STDERR_C_LOCALE,
  GOOD_SIG_STDERR_C_LOCALE,
  GOOD_SIG_STDERR_ZH_LOCALE,
  PINNED_KEY_ID,
  statusFdLines,
} from './support/gpg-verify-fixtures.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RELEASE_REF = `v${RELEASE_VERSION}`
/** 这台机器上跑这两条命令是否可能（夹具的 skip 口径与 cli.test.mjs 的 `commandAvailable('gpg')` 一致）。 */
const REAL_GPG_AND_GIT = commandAvailable('gpg') && commandAvailable('git')
const REAL_TAG_PRESENT = REAL_GPG_AND_GIT && repoHasRef(REPO, RELEASE_REF)

test('夹具前提：钉死指纹的常量与夹具里的期望值是同一枚（两处漂移就红）', () => {
  assert.equal(GLASSPANE_SIGNING_KEY_ID, PINNED_KEY_ID)
  assert.equal(normalizePinnedKeyId(GLASSPANE_SIGNING_KEY_ID), PINNED_KEY_ID, '锚点必须是一枚 40 位指纹')
})

test('verified 的判据是"点名的钥匙"，detail 里必须出现那一把指纹（旧文案只说"出自发布者私钥"）', () => {
  const res = classifyTagVerify({ status: 0, stdout: '', stderr: GOOD_SIG_STDERR_C_LOCALE })
  assert.equal(res.status, 'verified', res.detail)
  assert.match(res.detail, new RegExp(PINNED_KEY_ID), 'detail 要说出比的是哪一把：' + res.detail)
  // 绿字那一行本身也要说得出指纹：从前只有"发布 tag v1.29.1 GPG 签名验证通过"，
  // 读者看完仍然不知道验的是哪把钥匙。
  const pass = tagVerifyDecision({ sig: res, pinRef: 'v1.29.1', repoDir: '/repo' })
  assert.equal(pass.action, 'pass')
  assert.match(pass.text, new RegExp(PINNED_KEY_ID), pass.text)
})

test('rc=0 + 别人的 key id = invalid，且两个指纹都点名（detail 之外还要落成硬拒）', () => {
  const res = classifyTagVerify({ status: 0, stdout: '', stderr: FOREIGN_SIG_STDERR_C_LOCALE })
  assert.equal(res.status, 'invalid', '一把别人的好钥匙验通过，不等于发布者签过：' + res.detail)
  assert.match(res.detail, new RegExp(FOREIGN_KEY_ID), res.detail)
  assert.match(res.detail, new RegExp(PINNED_KEY_ID), res.detail)

  const verdict = tagVerifyDecision({ sig: res, pinRef: 'v1.29.1', repoDir: '/repo', acceptUnverified: true })
  assert.equal(verdict.action, 'refuse', 'invalid 是任何同意都不覆盖的那一档')
  assert.ok(!verdict.text.includes('--accept-unverified-signature'), verdict.text)
})

test('rc=0 而读不出 key id = unavailable（fail closed，不许由默认放行）', () => {
  for (const sample of [
    { stdout: '', stderr: '' },
    { stdout: 'Good signature', stderr: '' }, // 旧夹具那种"生产里不存在"的字节
    { stdout: '', stderr: GOOD_SIG_STDERR_ZH_LOCALE }, // 没钉 locale 时这台机器答的话
  ]) {
    const res = classifyTagVerify({ status: 0, ...sample })
    assert.equal(res.status, 'unavailable', JSON.stringify(sample) + ' 不该被读成通过：' + res.detail)
    assert.deepEqual(res.keyIds, [])
    const verdict = tagVerifyDecision({ sig: res, pinRef: 'v1.29.1', repoDir: '/repo' })
    assert.equal(verdict.action, 'refuse', '读不出钥匙 = 这道检查没给结论，默认拒装')
    const waived = tagVerifyDecision({ sig: res, pinRef: 'v1.29.1', repoDir: '/repo', acceptUnverified: true })
    assert.equal(waived.action, 'warn', '出路只有那一枚显式旗标')
    assert.match(waived.text, /没有验签结论/, waived.text)
  }
  // 非零失败不在这条的路上：签名对不上仍是 invalid（判据没被这次改动放宽）。
  assert.equal(classifyTagVerify({ status: 1, stderr: BAD_SIG_STDERR }).status, 'invalid')
})

/** 记录 spawn 调用（含 env）的替身：判据的"钉了什么"只能从**发出去的 argv 与环境**上读，
 *  从屏幕文案上读不到。 */
function recordingDouble({ verifyStatus = 0, verifyStdout = '', verifyStderr = GOOD_SIG_STDERR_C_LOCALE } = {}) {
  const calls = []
  const spawn = (cmd, args, options = {}) => {
    calls.push({ cmd, args: args.map(String), env: options.env ?? null })
    if (cmd === 'gpg' && args[0] === '--version') return { status: 0, stdout: 'gpg (GnuPG) 2.5.24\n', stderr: '' }
    if (cmd === 'gpg' && args.includes('--import')) return { status: 0, stdout: '', stderr: '' }
    if (cmd === 'git' && args.includes('rev-parse')) return { status: 0, stdout: 'deadbeef\n', stderr: '' }
    if (cmd === 'git' && args.includes('verify-tag')) {
      return { status: verifyStatus, stdout: verifyStdout, stderr: verifyStderr }
    }
    throw new Error(`替身没有准备过这条命令：${cmd} ${args.join(' ')}`)
  }
  return { spawn, calls }
}

function tempHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gp-${label}-`))
}

test('那几趟 spawn 钉了 LC_ALL/LANG 与 gpg.program/gpg.format，钥匙环仍是一次性的', () => {
  const home = tempHome('pin-env')
  try {
    const double = recordingDouble({})
    const sig = verifyCloneTagGpg({ repoDir: '/Users/dev/glasspane', ref: 'v1.29.1', tmpDir: home, spawn: double.spawn })
    assert.equal(sig.status, 'verified', JSON.stringify(sig))
    const verify = double.calls.find((call) => call.cmd === 'git' && call.args.includes('verify-tag'))
    assert.ok(verify, '判据的前提：真发过一次 verify-tag')
    // 判据读的是英文措辞，locale 就必须钉死（不钉 = 让操作系统的语言决定这道检查出不出结论）。
    assert.equal(verify.env.LC_ALL, 'C', 'verify-tag 那趟要钉 LC_ALL')
    assert.equal(verify.env.LANG, 'C', 'verify-tag 那趟要钉 LANG')
    assert.equal(verify.env.GNUPGHOME, home, '钥匙环仍是一次性目录，不是用户的 ~/.gnupg')
    const i = verify.args.indexOf('-c')
    assert.ok(verify.args.includes('gpg.program=gpg'), '校验程序不许由被验的那棵树自选：' + verify.args.join(' '))
    assert.ok(verify.args.includes('gpg.format=openpgp'), '签名格式同理：' + verify.args.join(' '))
    assert.ok(i > -1 && i < verify.args.indexOf('verify-tag'), '两枚 -c 都在子命令之前才是 git 的全局旗标')
    // 导入那一趟同样钉 locale：它读不读输出无关，一致性关系到"同一把钥匙在哪台机器上都是同一把"。
    const imp = double.calls.find((call) => call.cmd === 'gpg' && call.args.includes('--import'))
    assert.equal(imp.env.LC_ALL, 'C')
    assert.equal(imp.env.GNUPGHOME, home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/** 内置公钥导进一次性钥匙环后用 `--with-colons` 读回主指纹（与
 *  `updater/test/review-2026-10-09.test.mjs` 同一条判据，装在 installer 这一侧）：
 *  判据现在**吃**这一枚常量，所以它必须是内置那块 armored 公钥本身，不是某处抄来的十六进制。 */
test('钉死的 key id 由内置 armored 公钥重新推出（gpg 不在就 skip）', {
  skip: commandAvailable('gpg') ? false : 'gpg 不可用',
}, () => {
  const home = tempHome('anchor-fpr')
  try {
    const keyPath = path.join(home, 'publish-key.asc')
    fs.writeFileSync(keyPath, GLASSPANE_SIGNING_PUBLIC_KEY, 'utf8')
    const env = { ...process.env, GNUPGHOME: home, LC_ALL: 'C', LANG: 'C' }
    const imp = spawnSync('gpg', ['--homedir', home, '--batch', '--import', keyPath], { encoding: 'utf8', env })
    assert.equal(imp.status, 0, imp.stderr)
    const listed = spawnSync('gpg', ['--homedir', home, '--batch', '--with-colons', '--list-keys'], { encoding: 'utf8', env })
    assert.equal(listed.status, 0, listed.stderr)
    const fingerprints = String(listed.stdout).split('\n')
      .filter((line) => line.startsWith('fpr:'))
      .map((line) => line.split(':').filter((f) => f !== '').pop())
    assert.ok(fingerprints.includes(PINNED_KEY_ID), `内置公钥报的是 ${fingerprints.join(', ')}，判据钉的却是 ${PINNED_KEY_ID}`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/** 真 gpg + 真 tag：这台机器上把 v1.29.1 验一遍，判据必须读出 `verified` 并且 detail 点名指纹。
 *  这一条是"判据读的确实是生产字节"的那一半——前面的桩再像生产也是桩。 */
test('真 gpg 验真 tag：verified 走到底（钉了 locale 的那一串）', {
  skip: REAL_TAG_PRESENT ? false : `需要 gpg + git，且这棵树里有 ${RELEASE_REF}`,
}, () => {
  const sig = verifyCloneTagGpg({ repoDir: REPO, ref: RELEASE_REF })
  assert.equal(sig.status, 'verified', JSON.stringify(sig))
  assert.match(sig.detail, new RegExp(PINNED_KEY_ID), sig.detail)
  assert.deepEqual(sig.keyIds, [PINNED_KEY_ID], '真那一趟读出的钥匙集合：' + JSON.stringify(sig.keyIds))
  assert.equal(tagVerifyDecision({ sig, pinRef: RELEASE_REF, repoDir: REPO }).action, 'pass')
})

/** locale 的那一半：同一条命令**不钉** locale 在这台机器上答什么，判据就得跟着什么倒。
 *  英文 locale 的开发机/CI 上这一条自动 skip——它测的是"译文会让判据读不出措辞"这件事，
 *  而这件事只在真的会答译文的机器上可观测。 */
test('不钉 locale 的真那一趟读不出措辞（这就是 LC_ALL=C 那一刀存在的理由）', {
  skip: REAL_TAG_PRESENT ? false : `需要 gpg + git，且这棵树里有 ${RELEASE_REF}`,
}, () => {
  const home = tempHome('locale-pin')
  try {
    const keyPath = path.join(home, 'publish-key.asc')
    fs.writeFileSync(keyPath, GLASSPANE_SIGNING_PUBLIC_KEY, 'utf8')
    assert.equal(spawnSync('gpg', ['--homedir', home, '--batch', '--import', keyPath], {
      encoding: 'utf8', env: { ...process.env, GNUPGHOME: home },
    }).status, 0)
    // 与 verifyCloneTagGpg 只差一件事：没有 LC_ALL/LANG。
    const unpinned = spawnSync('git', ['-C', REPO, '-c', 'gpg.program=gpg', '-c', 'gpg.format=openpgp', 'verify-tag', RELEASE_REF], {
      encoding: 'utf8',
      env: { ...process.env, GNUPGHOME: home },
    })
    assert.equal(unpinned.status, 0, unpinned.stderr)
    const unpinnedIds = signatureKeyIds(`${unpinned.stdout}\n${unpinned.stderr}`)
    const pinnedRun = spawnSync('git', ['-C', REPO, '-c', 'gpg.program=gpg', '-c', 'gpg.format=openpgp', 'verify-tag', RELEASE_REF], {
      encoding: 'utf8',
      env: { ...process.env, GNUPGHOME: home, LC_ALL: 'C', LANG: 'C' },
    })
    assert.deepEqual(signatureKeyIds(`${pinnedRun.stdout}\n${pinnedRun.stderr}`), [PINNED_KEY_ID],
      '钉了 locale 的那一趟应当稳定读出指纹')
    if (unpinnedIds.length === 0) {
      // 这台机器答译文：判据读不出钥匙 → unavailable（fail closed），而不是"退出码 0 就算过"。
      assert.equal(classifyTagVerify({ status: unpinned.status, stdout: unpinned.stdout, stderr: unpinned.stderr }).status, 'unavailable')
    } else {
      // 机器本来就答英文：这一条的读数只是"两趟一致"，locale 那一刀由上面那条 env 断言与
      // 第 4 条的中文夹具承担。
      assert.deepEqual(unpinnedIds, [PINNED_KEY_ID])
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('status-fd 那一形（updater 的分离签名）与 tag 那一形共用同一条判据', () => {
  assert.deepEqual(signatureKeyIds(statusFdLines(PINNED_KEY_ID)), [PINNED_KEY_ID])
  // VALIDSIG 第九个字段是**主钥匙**：子钥匙签名时两者不同，判据只取第一个字段（与
  // updater/lib/signature.js 的 validSigFingerprint 同一口径），不因为"ring 里有主钥匙"就放行。
  const subkey = `[GNUPG:] VALIDSIG ${FOREIGN_KEY_ID} 2026-11-04 1793780432 0 4 0 1 8 00 ${PINNED_KEY_ID}\n`
  assert.deepEqual(signatureKeyIds(subkey), [FOREIGN_KEY_ID])
  assert.equal(classifyTagVerify({ status: 0, stdout: subkey, stderr: '' }).status, 'invalid')
  assert.equal(classifyTagVerify({ status: 0, stdout: statusFdLines(FOREIGN_KEY_ID), stderr: '' }).status, 'invalid')
})
