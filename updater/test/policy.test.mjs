/**
 * §6 row "major 不自动应用".
 *
 * REVERSE MUTATION: delete the `kind === 'major' && !hasConsent` branch in
 * `decideUpdate` (and the matching branch in `applyUpdate`) — `a major bump is
 * needs-consent and is never auto-applied` goes red, because the offer would
 * come back `available` with `autoApplyAllowed: true`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CONSENT_KINDS, decideSwapPermission, decideUpdate, foreignStateDir, stateDirFromArgs, stateDirReadings } from '../lib/policy.js'
import { CODES } from '../lib/codes.js'

test('a major bump is needs-consent and is never auto-applied', () => {
  const decision = decideUpdate({ currentVersion: '1.4.2', tag: 'v2.0.0' })
  assert.equal(decision.status, 'needs-consent')
  assert.equal(decision.code, CODES.consentRequired)
  assert.equal(decision.autoApplyAllowed, false)
  assert.equal(decision.kind, 'major')
  assert.match(decision.reason, /press "Install update"/)
})

test('a major with an explicit human consent becomes an ordinary offer', () => {
  const decision = decideUpdate({ currentVersion: '1.4.2', tag: 'v2.0.0', consents: ['major'] })
  assert.equal(decision.status, 'available')
  assert.equal(decision.autoApplyAllowed, true)
})

test('patch and minor bumps are the only automatic ones', () => {
  assert.deepEqual(
    pick(decideUpdate({ currentVersion: '1.4.2', tag: 'v1.4.3' }), ['status', 'autoApplyAllowed', 'kind']),
    { status: 'available', autoApplyAllowed: true, kind: 'patch' },
  )
  assert.deepEqual(
    pick(decideUpdate({ currentVersion: '1.4.2', tag: 'v1.5.0' }), ['status', 'autoApplyAllowed', 'kind']),
    { status: 'available', autoApplyAllowed: true, kind: 'minor' },
  )
})

test('equal is up-to-date, older is not an update at all', () => {
  assert.equal(decideUpdate({ currentVersion: '1.4.2', tag: 'v1.4.2' }).status, 'up-to-date')
  const older = decideUpdate({ currentVersion: '1.4.2', tag: 'v1.4.1' })
  assert.equal(older.status, 'up-to-date')
  assert.equal(older.autoApplyAllowed, false)
  assert.match(older.reason, /older/)
})

test('the user switch stops the automatic path but keeps the offer visible', () => {
  const decision = decideUpdate({ currentVersion: '1.4.2', tag: 'v1.4.3', autoApply: false })
  assert.equal(decision.status, 'available')
  assert.equal(decision.autoApplyAllowed, false)
  assert.match(decision.reason, /switched off/)
})

test('an unanswered probe defers the swap; it never reads as "dead, restart it"', () => {
  const decision = decideSwapPermission({
    probe: { answered: false, reason: 'the daemon did not answer within 5000ms' },
    jobArgs: [],
    ourStateRoot: '/tmp/gp-state',
  })
  assert.equal(decision.status, 'deferred')
  assert.equal(decision.code, CODES.busyOrUnreachable)
  assert.equal(decision.swapped, false)
})

test('a daemon writing somebody else\'s state root needs a human', () => {
  const decision = decideSwapPermission({
    probe: { answered: true },
    jobArgs: ['glasspaned', '--state-dir', '/Volumes/Other/.glasspane'],
    ourStateRoot: '/Users/dev/.glasspane',
  })
  assert.equal(decision.status, 'needs-consent')
  assert.equal(decision.code, CODES.nonDefaultStateDir)
  assert.match(decision.reason, /\/Volumes\/Other\/\.glasspane/)

  assert.equal(decideSwapPermission({ probe: { answered: true }, jobArgs: [], ourStateRoot: '/Users/dev/.glasspane' }).status, 'allowed')
  assert.equal(
    decideSwapPermission({
      probe: { answered: true },
      jobArgs: ['glasspaned', '--state-dir', '/Users/dev/.glasspane/'],
      ourStateRoot: '/Users/dev/.glasspane',
    }).status,
    'allowed',
    'naming the same root the tool was pointed at is not "foreign"',
  )
  assert.equal(
    decideSwapPermission({
      probe: { answered: true },
      jobArgs: ['--state-dir', '/elsewhere'],
      ourStateRoot: '/Users/dev/.glasspane',
      consented: [CONSENT_KINDS[1]],
    }).status,
    'allowed',
  )
})

test('both spellings of the state-root flag are read, and a missing value is not invented', () => {
  assert.equal(stateDirFromArgs(['glasspaned', '--state-dir', '/a/b']), '/a/b')
  assert.equal(stateDirFromArgs(['glasspaned', '--state-dir=/a/b']), '/a/b')
  assert.equal(stateDirFromArgs(['glasspaned', '--socket-path', '/x/y.sock']), null)
  assert.equal(stateDirFromArgs(['glasspaned', '--state-dir']), null, 'a flag with no value must not become the empty string')
  assert.equal(foreignStateDir({ jobArgs: ['--state-dir', '/a/b/'], ourStateRoot: '/a/b' }), null)

  // `--state-root` is not a hypothetical spelling: it is the one the daemon's own option uses
  // (`launchd.js` renders it into the job as `daemonFlag`), and it is what the update agent's
  // `launchctl print` output carried when it was captured from this machine on 2026-09-30. Reading
  // only `--state-dir` here meant a daemon started with `--state-root /somewhere/else` looked like a
  // job with *no* state flag, so §2's foreign-root gate — the one that exists to stop a swap against
  // somebody else's installation — had nothing to compare and let it through.
  assert.equal(stateDirFromArgs(['glasspaned', '--state-root', '/a/b']), '/a/b')
  assert.equal(stateDirFromArgs(['glasspaned', '--state-root=/a/b']), '/a/b')
  assert.equal(foreignStateDir({ jobArgs: ['--state-root', '/other/place'], ourStateRoot: '/a/b' }), '/other/place',
    '换个拼法写别人的状态根，这一道门照样要认出来')
  assert.deepEqual(stateDirReadings(['--state-dir', '/a', '--state-root', '/b']), ['/a', '/b'],
    '两种拼法都算数：同时出现就是"读不出这个作业写哪儿"')
  assert.equal(stateDirFromArgs(['glasspaned', '--state-root']), null, '同样的缺值规则')
})

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]))
}

/**
 * §2 那道门的输入必须是**全部** `--state-dir` 读数（lib/policy.js 里 `stateDirReadings` 的
 * 注释自己就写了："多于一个不同读数只能当 unknown"），而 `decideSwapPermission` 当时读的
 * 是 `stateDirFromArgs`（只看第一个）。真机形态：`launchctl print` 的 arguments block 里
 * `[--state-dir 我们的, --state-dir /other]` 会被判成"是我们的根"→ 放行 → 换掉别家 daemon
 * 正在用的 bundle。REVERSE MUTATION：把 `decideSwapPermission` 里那段 readings 判断删掉 ——
 * 下面第一条测试在两个不同根那一行变红（它会被 consent 放行）。
 */
test('a job naming two different state roots is never a swap, with consent or without', () => {
  const two = ['glasspaned', '--state-dir', '/Users/dev/.glasspane', '--state-dir', '/Volumes/Other']
  const withoutConsent = decideSwapPermission({ probe: { answered: true }, jobArgs: two, ourStateRoot: '/Users/dev/.glasspane' })
  assert.notEqual(withoutConsent.status, 'allowed', '两个根＝无从判断，不能当成"是我们的"')
  assert.equal(withoutConsent.swapped, false)
  assert.equal(withoutConsent.code, CODES.busyOrUnreachable)
  assert.match(withoutConsent.reason, /more than once/)
  assert.match(withoutConsent.reason, /\/Volumes\/Other/, '拒绝里要看得见那两个根')

  // consent 回答的是"要不要动别人的根"，它回答不了"哪个才是它的根"：带着旗标也不许放行。
  const withConsent = decideSwapPermission({
    probe: { answered: true },
    jobArgs: two,
    ourStateRoot: '/Users/dev/.glasspane',
    consented: [CONSENT_KINDS[1]],
  })
  assert.notEqual(withConsent.status, 'allowed', '--consent state-dir 不得把一个无从判断的作业放行')
  assert.equal(withConsent.swapped, false)
  assert.equal(
    withConsent.status,
    'unknown',
    '状态本身也必须不是 needs-consent：面板不该为它亮出"点头"按钮',
  )

  // 一个根、就是我们自己的 → allowed（含两种拼法与末尾斜杠）。
  assert.equal(
    decideSwapPermission({
      probe: { answered: true },
      jobArgs: ['glasspaned', '--state-dir', '/Users/dev/.glasspane/'],
      ourStateRoot: '/Users/dev/.glasspane',
    }).status,
    'allowed',
    '只有一个读数且等于本次要更新的状态根，就是正常作业',
  )
  // 一个根、是别人的 → 只有 needs-consent 这一条路，而且点头之后就放行。
  const foreignOnly = decideSwapPermission({
    probe: { answered: true },
    jobArgs: ['glasspaned', '--state-root', '/Volumes/Other'],
    ourStateRoot: '/Users/dev/.glasspane',
  })
  assert.equal(foreignOnly.status, 'needs-consent')
  assert.equal(foreignOnly.code, CODES.nonDefaultStateDir)
  assert.equal(
    decideSwapPermission({
      probe: { answered: true },
      jobArgs: ['glasspaned', '--state-root', '/Volumes/Other'],
      ourStateRoot: '/Users/dev/.glasspane',
      consented: [CONSENT_KINDS[1]],
    }).status,
    'allowed',
  )
  // 同一个值写两遍不是歧义（与 lib/launchd.js 的判据一致）。
  assert.equal(
    decideSwapPermission({
      probe: { answered: true },
      jobArgs: ['--state-dir', '/Users/dev/.glasspane', '--state-dir', '/Users/dev/.glasspane'],
      ourStateRoot: '/Users/dev/.glasspane',
    }).status,
    'allowed',
  )
})

/**
 * 拒绝必须带一个 agent 能直接执行的下一步。`unsigned-release` 那道门的句子点名了
 * `--consent unsigned-release`（见 test/signature.test.mjs 的同名断言），`--consent state-dir`
 * 也确实是 cli.js 里接了线的口令（`consented: consents`），但 state-dir 的拒绝原文只落在
 * "do it by hand" —— 一段散文不是一道控制。REVERSE MUTATION：把 reason 里那句命令删回
 * "do it by hand" → 本测试红。
 */
test('the state-dir refusal names the consent action a person can actually run', () => {
  const decision = decideSwapPermission({
    probe: { answered: true },
    jobArgs: ['glasspaned', '--state-dir', '/Volumes/Other'],
    ourStateRoot: '/Users/dev/.glasspane',
  })
  assert.equal(decision.status, 'needs-consent')
  assert.match(decision.reason, /--consent state-dir/, '和另外两道门一样，点名的就是本次缺的那个旗标')
  assert.match(decision.reason, /updater apply/, '旗标前面必须带上真正要跑的子命令')
  assert.ok(!/do it by hand\.$/.test(decision.reason), '不能停在一句"你手工来吧"的散文上')
})

