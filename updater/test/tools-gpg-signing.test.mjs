/**
 * tools/gpg-signing.sh：签名口令不许出现在 gpg 的 argv 里。
 *
 * WHY（实测过的形状，不是理论）。argv 在同一台机器上是**任何本地账号**都能读的
 * （`ps -eww -o args`）。`.github/workflows/release.yml` 的签名步骤正是为这件事改成
 * `--passphrase-fd 0` 的，并且写明"本地实测：签名进行中 12 次采样全部读到"。本地工具
 * 从前仍旧是 `--passphrase "$pass"`（cmd_seed 与 cmd_verify_pass 两处）——CI 侧修好、
 * 本机侧继续漏，而 `verify-pass` 恰恰是用户反复试口令的那条命令。
 * 同一条 argv 面也顺手带出第二个缺陷：seed 从前把 gpg 的 stderr 写进写死的
 * `/tmp/.gpg-seed-err`（人人可预测、先到先得），再 `rm -f`。
 *
 * 夹具形状：**真脚本**（tools/gpg-signing.sh 本体）+ 只记录 argv/stdin 的 gpg、security
 * stub。stub 不实现任何 gpg 语义（它不解锁、不导出、不验口令），它只回答"这条命令是
 * 怎么被拼出来的"这一个问题——所以断言全部落在 argv/stdin 两个通道上，不落进口令对不对。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', '..', 'tools', 'gpg-signing.sh')
const SENTINEL = 'SentinelPass-9f3c'
// stub 的假 armored key：cmd_seed 的读回判据是这一行在不在，与真 key 无关。
const FAKE_ARMORED = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nfixture\n-----END PGP PRIVATE KEY BLOCK-----\n'

function makeSandbox() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-gpgsign-'))
  const bin = path.join(base, 'bin')
  const tmp = path.join(base, 'tmp')
  fs.mkdirSync(bin)
  fs.mkdirSync(tmp)
  const log = path.join(base, 'calls.log')
  // gpg stub：每次调用记一行 ARGV，再把 stdin 整段记进 STDIN 行。它**不**实现 gpg：
  // 导出那一条把假 armored key 打到 stdout（seed 的判据要读它），其余一律无输出。
  fs.writeFileSync(path.join(bin, 'gpg'), [
    '#!/bin/sh',
    `printf 'ARGV|gpg|%s\\n' "$*" >> '${log}'`,
    `printf 'STDIN|%s\\n' "$(cat)" >> '${log}'`,
    "for a in \"$@\"; do",
    '  if [ "$a" = "--export-secret-keys" ]; then',
    `    printf '%s' ${JSON.stringify(FAKE_ARMORED)}`,
    '    exit 0',
    '  fi',
    'done',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  // security stub：keychain 的读写面，同样只记录 argv。private-key 那条读回假 armored key。
  fs.writeFileSync(path.join(bin, 'security'), [
    '#!/bin/sh',
    `printf 'ARGV|security|%s\\n' "$*" >> '${log}'`,
    "account=''",
    "prev=''",
    'for a in "$@"; do',
    '  [ "$prev" = "-a" ] && account="$a"',
    '  prev="$a"',
    'done',
    "if [ \"$account\" = \"private-key\" ]; then printf '%s' " + JSON.stringify(FAKE_ARMORED) + ' | base64; fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  return {
    base,
    bin,
    tmp,
    log,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    argvOf: (program) => callsArgv(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', program),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

function callsArgv(text, program) {
  return text.split('\n').filter((line) => line.startsWith(`ARGV|${program}|`))
}

function runSigning(sandbox, args, { stdin, extraEnv = {} } = {}) {
  return spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      // PATH 只留 stub + node 的目录：真 gpg / 真 security 一律不许被碰到。
      PATH: `${sandbox.bin}:/usr/bin:/bin`,
      TMPDIR: sandbox.tmp,
      HOME: sandbox.base,
      GP_SIGNING_SERVICE: 'gpg-signing-test-fixture',
      ...extraEnv,
    },
    input: stdin,
  })
}

/** 断言主体：口令走 fd 0，不进 argv。 */
function assertPassphraseNotInArgv(sandbox, label) {
  const gpgArgv = sandbox.argvOf('gpg')
  assert.ok(gpgArgv.length >= 1, `${label}：stub gpg 至少被调用了一次，实得 ${JSON.stringify(sandbox.calls())}`)
  for (const line of gpgArgv) {
    assert.ok(!line.includes(SENTINEL), `${label}：口令进了 gpg 的 argv，任何本地账号都能从 ps 读到：${line}`)
    assert.ok(!/--passphrase(?!-fd)/.test(line), `${label}：仍在用 --passphrase <argv> 形态，而不是 --passphrase-fd：${line}`)
    assert.match(line, /--passphrase-fd 0/, `${label}：口令的通道必须是 --passphrase-fd 0：${line}`)
  }
  const stdinLines = sandbox.calls().filter((l) => l.startsWith('STDIN|'))
  assert.ok(
    stdinLines.some((l) => l.includes(SENTINEL)),
    `${label}：口令必须真的从 stdin（fd 0）喂进去，否则上面的 fd 只是装饰。实得：${JSON.stringify(stdinLines)}`,
  )
}

test('gpg-signing.sh: verify-pass 的口令不进 argv，走 --passphrase-fd 0', () => {
  const sandbox = makeSandbox()
  try {
    const r = runSigning(sandbox, ['verify-pass'], { stdin: `${SENTINEL}\n` })
    assert.equal(r.status, 0, r.stderr)
    assertPassphraseNotInArgv(sandbox, 'verify-pass')
  } finally {
    sandbox.cleanup()
  }
})

test('gpg-signing.sh: seed 的口令不进 argv，且不写可预测的 /tmp/.gpg-seed-err', () => {
  // 陷阱文件：可预测路径若还在用，seed 会把 gpg 的 stderr 写进来、再 rm 掉。
  // 这里只在该路径不存在时立trap，避免覆盖别的进程留下的东西。
  const predictable = '/tmp/.gpg-seed-err'
  const preexisting = fs.existsSync(predictable)
  if (!preexisting) fs.writeFileSync(predictable, 'SENTINEL-UNTOUCHED\n')
  const sandbox = makeSandbox()
  try {
    const r = runSigning(sandbox, ['seed'], { stdin: `${SENTINEL}\n` })
    assert.equal(r.status, 0, r.stderr)
    assertPassphraseNotInArgv(sandbox, 'seed')
    assert.match(r.stdout + r.stderr, /stored/, 'seed 走的是"存进 keychain"那一支，说明这条 argv 是真的')
    const content = fs.readFileSync(predictable, 'utf8')
    assert.equal(content, 'SENTINEL-UNTOUCHED\n', 'seed 竟然写了可预测的 /tmp/.gpg-seed-err')
    assert.equal(fs.readdirSync(sandbox.tmp).filter((n) => n.startsWith('gpg-seed-err')).length, 0,
      'mktemp 出来的错误文件必须被清掉（trap EXIT），别把 TMPDIR 越跑越满')
  } finally {
    if (!preexisting) fs.rmSync(predictable, { force: true })
    sandbox.cleanup()
  }
})

test('gpg-signing.sh: seed 失败那几支也不留错误文件，也不回到可预测路径', () => {
  const predictable = '/tmp/.gpg-seed-err'
  const preexisting = fs.existsSync(predictable)
  if (!preexisting) fs.writeFileSync(predictable, 'SENTINEL-UNTOUCHED\n')
  const sandbox = makeSandbox()
  // stub gpg 换成"什么都没导出、只把 gpg 的原话写进 stderr"的那一档：脚本走
  // "既没有 key 也没有消息"或"bad passphrase"那一支，exit 1。
  fs.writeFileSync(path.join(sandbox.bin, 'gpg'), [
    '#!/bin/sh',
    `printf 'ARGV|gpg|%s\\n' "$*" >> '${sandbox.log}'`,
    `printf 'STDIN|%s\\n' "$(cat)" >> '${sandbox.log}'`,
    "gpg: can't do this with a passphrase: 损坏的密码 >&2",
    'exit 2',
    '',
  ].join('\n'), { mode: 0o755 })
  try {
    const r = runSigning(sandbox, ['seed'], { stdin: `${SENTINEL}\n` })
    assert.equal(r.status, 1, `gpg 拒绝时 seed 必须非零退场：${r.stdout}${r.stderr}`)
    assertPassphraseNotInArgv(sandbox, 'seed(拒绝支)')
    assert.equal(fs.readFileSync(predictable, 'utf8'), 'SENTINEL-UNTOUCHED\n',
      '拒绝的那一支也不许写可预测路径')
    assert.equal(fs.readdirSync(sandbox.tmp).filter((n) => n.startsWith('gpg-seed-err')).length, 0,
      '拒绝退场时错误文件同样要被清掉')
  } finally {
    if (!preexisting) fs.rmSync(predictable, { force: true })
    sandbox.cleanup()
  }
})

test('gpg-signing.sh: 源码里不再有 --passphrase <argv> 形态与写死的 /tmp 错误文件', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(source, /--passphrase(?!-fd)[\s"]/, 'argv 形态的口令传递必须删干净')
  // 可预测路径只许留在**解释它的注释里**，不许出现在任何一行动词上。
  const liveUses = source
    .split('\n')
    .filter((line) => line.includes('/tmp/.gpg-seed-err') && !line.trim().startsWith('#'))
  assert.deepEqual(liveUses, [], `可预测的错误落点必须换成 mktemp 模板，实得：${JSON.stringify(liveUses)}`)
  assert.match(source, /mktemp "\$\{TMPDIR:-\/var\/tmp\}\/gpg-seed-err\.XXXXXX"/,
    'mktemp 必须是**模板**形态（带尾部 X、不带 -t）：BSD 与 GNU 对 -t 的处理不同，同一行会一边过一边报错')
})

/* ===========================================================================
 * 2026-10-22 两轮修复的守卫（缺陷 2 / 3 / 6）。
 *
 * 缺陷 2：本文件顶部是 `set -euo pipefail`，而从前有 11 处
 * `printf '%s' "$x" | grep -q …`。`grep -q` 首个命中就退场，还在写的 printf 随后死于
 * SIGPIPE，管道的状态于是成了 141 —— 同一个输入可以判绿也可以判红，取决于谁先跑到。
 * 这个坑本仓写过三次（ci.yml 两处注释、scripts/make-release-archive.mjs 的 verifyArchive
 * 注释），本文件是第四处，也是最后一处：判据全部换成 `case` / `[[ =~ $re ]]` /
 * `has_text` 这类**没有管道**的形状。
 * REVERSE MUTATION：把任意一条改回 `printf '%s' "$key" | grep -q 'BEGIN PGP …'` →
 * 「没有任何一条判据走管道」这条红。
 *
 * 缺陷 3：`gh api … 2>/dev/null || true` 把"gh 自己失败了"与"读回来是空的"压成同一个空串，
 * 于是没登录 / 404 / scope 不够 / environment 没建，全被报成「secret 不存在」，运维照着这句
 * 重建一份**本来就配对了的** secret，永远修不好。现在 `secret-verdict` 把分诊函数暴露出来，
 * 下面三条用例喂**假**的（退出码 / stdout / stderr）三样，零网络。
 * REVERSE MUTATION：把 `emit_secret_verdict` 的 failed 分支删掉（让它落回那句 missing）、
 * 或把 `2>/dev/null || true` 抄回 `read_scope_secrets` → 「failed 不许说 missing」与
 * 「必须引用 gh 的原话」两条一起红。
 *
 * 缺陷 6：TARGETS 里躺着一台构建机的 `/Volumes/…`，而这个文件随发布归档发出去。
 * REVERSE MUTATION：把那一行抄回字面量 → 「活代码里不许有构建机的绝对路径」这条红。
 * ========================================================================= */

/** 跑真脚本，返回 stdout+stderr 与退出码。 */
function runScript(args, { stdin, env = {} } = {}) {
  return spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `/usr/bin:/bin`,
      TMPDIR: os.tmpdir(),
      HOME: os.tmpdir(),
      GP_SIGNING_SERVICE: 'gpg-signing-test-fixture',
      ...env,
    },
    input: stdin,
  })
}

/** 只留代码行：注释行本来就在解释被换掉的那种形状（与 /tmp/.gpg-seed-err 那条同一口径）。 */
function liveCodeLines(source) {
  return source.split('\n').filter((line) => !line.trim().startsWith('#'))
}

test('gpg-signing.sh: 没有任何一条判据走 `| grep -q` 的管道（pipefail 会把判绿判成 141）', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8')
  assert.match(source, /^set -euo pipefail$/m,
    '本文件的 pipefail 必须还在——它被摘掉的话，下面这条闸就只是在量一具空壳')
  const offenders = liveCodeLines(source).filter((line) => /\|\s*grep\b[^\n|]*\s-q[xE]?\b/.test(line))
  assert.deepEqual(offenders, [],
    `这些行还在把判据交给 `
    + '`grep -q` 的管道（首个命中就退、写侧死于 SIGPIPE，pipefail 于是把判决变成时序问题）：'
    + JSON.stringify(offenders)
    + '；换成 case / [[ =~ $re ]] / has_text 的同义写法')
  // 反证：替换不是靠"把判据删掉"完成的——三条替身都必须在场。
  assert.match(source, /^has_text\(\)/m, '字面匹配的谓词 has_text 必须还在')
  assert.match(source, /^has_line\(\)/m, '整行匹配的谓词 has_line 必须还在（grep -qx 的同义）')
  assert.match(source, /\[\[ \$live =~ \$SILENT_SKIP_RE \]\]/, 'audit 的判据必须走变量化的 ERE（bash 3.2 与 4+ 同一答案）')
  assert.match(source, /^SILENT_SKIP_RE=/m, '那条 ERE 必须只有一处定义')
})

test('gpg-signing.sh: 活代码里不许有构建机的绝对路径（发布归档不是发布者的投递目录）', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8')
  const offenders = liveCodeLines(source).filter((line) => /\/(Users|Volumes|home)\/[A-Za-z0-9._-]{3,}/.test(line))
  assert.deepEqual(offenders, [],
    `TARGETS 之类的默认值不许写死某台机器的目录（这个文件随 GlassPane 的发布归档发给每台机器）：`
    + JSON.stringify(offenders)
    + '；本 checkout 用 REPO_ROOT 算，兄弟目录用 GP_SIGNING_DEV_BASE 指')
  assert.match(source, /^REPO_ROOT="\$\(cd -- "\$\(dirname -- "\$\{BASH_SOURCE\[0\]\}"\)\/\.\." && pwd -P\)"/m,
    'REPO_ROOT 必须由脚本自己的位置算出来（与 tools/release-signing-gate.sh:67 同一个算法）')
  assert.match(source, /GP_DEV_BASE="\$\{GP_SIGNING_DEV_BASE:-\$\(dirname -- "\$REPO_ROOT"\)\}"/,
    '兄弟 checkout 的父目录必须可被显式覆盖')
  // 诚实边界：脚本自己的 `selftest` 也有一条臂比 TARGETS 第一行与 REPO_ROOT，但在**那台被抄进
  // 字面量的机器**上两者恰好相等，那条臂量不到这件事（本机实测：把 /Volumes/… 抄回去，
  // selftest 仍 rc=0）。所以这条源码形状的断言才是承重的那一道，不是锦上添花。
})

/** 把三样罐头输出写成临时文件，喂给真脚本的 secret-verdict 分诊入口。 */
function verdictOf({ rc, names, gherr, want = 'GPG_PRIVATE_KEY', env = 'release', repo = 'GlassPane' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-gpg-verdict-'))
  try {
    fs.writeFileSync(path.join(dir, 'stdout'), names)
    fs.writeFileSync(path.join(dir, 'stderr'), gherr)
    const r = runScript(['secret-verdict', String(rc), want, path.join(dir, 'stdout'), path.join(dir, 'stderr'), repo, env])
    return { ...r, text: `${r.stdout}\n${r.stderr}` }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('分诊①：gh 非零退出 + 有原话 → 不许说 missing，必须引用 gh 的 stderr，退出码与"判红"分开', () => {
  const r = verdictOf({ rc: 1, names: 'GPG_PRIVATE_KEY\nGPG_PASSPHRASE\n', gherr: 'gh: Bad credentials (HTTP 401)\n' })
  assert.equal(r.status, 3, `gh 失败必须有**自己的**退出码（3＝读不到），实得 ${r.status}｜${r.text}`)
  assert.doesNotMatch(r.text, /missing/, `读取失败不许被报成「secret 不存在」——那正是运维照着重建正确 secret 的那句谎。实得：${r.text}`)
  assert.match(r.text, /无法判定/, r.text)
  assert.match(r.text, /Bad credentials \(HTTP 401\)/, 'gh 的原话必须一字不改地交给读者')
  // 两种可能必须**分开**点名，且给的是能当场跑的命令（不是"再试试"）。
  assert.match(r.text, /① gh 不能用/, r.text)
  assert.match(r.text, /② 要读的目标不存在/, r.text)
  assert.match(r.text, /gh auth status/, 'remedy 必须是一条真能跑的命令')
  assert.match(r.text, /gh auth refresh -s repo/, 'scope 不够那一种也要有对应的命令')
})

test('分诊②：gh 成功而列表为空 → 这才是「缺失」那句，且退出码不是 3', () => {
  const r = verdictOf({ rc: 0, names: '', gherr: '' })
  assert.equal(r.status, 0, `读到空列表是一条**判得出**的结论，不该用读不到的退出码：${r.status}｜${r.text}`)
  assert.match(r.text, /GPG_PRIVATE_KEY missing/, r.text)
  assert.match(r.text, /environment 'release'/, '缺失要说清缺的是哪一层（环境级与仓库级是两份 secret）')
  assert.match(r.text, /成功读到\*\*空\*\*列表|读到了一份列表，里面没有它/,
    '这句必须说明它是**从一次成功的读取**里得出的，而不是从"没读到"里猜的')
})

test('分诊③：gh 成功且名字在列 → ok；只含前缀的那一行不算命中（grep -qx 的同义）', () => {
  const hit = verdictOf({ rc: 0, names: 'OTHER\nGPG_PRIVATE_KEY\n', gherr: '' })
  assert.equal(hit.status, 0, hit.text)
  assert.match(hit.text, /^ {2}ok {4}GPG_PRIVATE_KEY/m, hit.text)
  assert.doesNotMatch(hit.text, /missing/, hit.text)

  const prefixOnly = verdictOf({ rc: 0, names: 'GPG_PRIVATE_KEY_BACKUP\n', gherr: '' })
  assert.equal(prefixOnly.status, 0, prefixOnly.text)
  assert.match(prefixOnly.text, /GPG_PRIVATE_KEY missing/,
    `整行才算命中：GPG_PRIVATE_KEY_BACKUP 不能替 GPG_PRIVATE_KEY 作背书。实得：${prefixOnly.text}`)

  const repoLevel = verdictOf({ rc: 1, names: '', gherr: 'gh: Not Found (HTTP 404)\n', env: '' })
  assert.equal(repoLevel.status, 3, repoLevel.text)
  assert.doesNotMatch(repoLevel.text, /missing/, `404 也**不等于**没有这个 secret（仓库改名也是 404）：${repoLevel.text}`)
  assert.match(repoLevel.text, /Not Found \(HTTP 404\)/, repoLevel.text)
  assert.doesNotMatch(repoLevel.text, /environment 'release'/, '仓库级那条判决不许挂上环境名')
})


/* ------------------------------------------------------------------ *
 * F4（2026-10-24）：`forget` —— 签名凭据的两半必须能被真正清掉，而且清没清要回头看一眼。
 *
 * 这条缺陷的形状是"有 seed/install，没有任何删除路径"：私钥 + 口令以 base64（编码，不是加密）
 * 常驻登录钥匙串，任何同用户进程调 `security find-generic-password -w` 都读得到（keychain 的 ACL
 * 认创建者二进制，不认调用者），拿到它的人能给所有用户的 updater 投毒。
 * 夹具是一个**有状态**的 security stub：条目是沙箱里的文件，delete 会真的把它删掉，find 按文件
 * 在不在回答。stub 不实现任何 keychain 语义——它只回答"这条命令之后，那个名字还在不在"。
 * ------------------------------------------------------------------ */

function makeKeychainSandbox({ deleteRc = 0, deleteActuallyRemoves = true, present = ['private-key', 'passphrase'] } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-keychain-'))
  const bin = path.join(base, 'bin')
  const store = path.join(base, 'store')
  fs.mkdirSync(bin)
  fs.mkdirSync(store)
  for (const account of present) {
    fs.writeFileSync(path.join(store, account), 'entry')
  }
  const log = path.join(base, 'calls.log')
  fs.writeFileSync(path.join(bin, 'security'), [
    '#!/bin/sh',
    `printf 'ARGV|security|%s\\n' "$*" >> '${log}'`,
    "account=''; prev=''; verb=''",
    'for a in "$@"; do',
    '  [ "$prev" = "-a" ] && account="$a"',
    '  case "$a" in find-generic-password|delete-generic-password) verb="$a" ;; esac',
    '  prev="$a"',
    'done',
    `entry="${store}/$account"`,
    'if [ "$verb" = "delete-generic-password" ]; then',
    `  if [ ${deleteRc} -ne 0 ]; then exit ${deleteRc}; fi`,
    `  ${deleteActuallyRemoves ? 'rm -f "$entry"' : 'true'}`,
    '  exit 0',
    'fi',
    '[ -f "$entry" ] || exit 44',
    `printf '%s' ${JSON.stringify(FAKE_ARMORED)} | base64`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  return {
    base, bin, log, store,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    remaining: () => fs.readdirSync(store).sort(),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

function runForget(sandbox, args = ['forget']) {
  return spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${sandbox.bin}:/usr/bin:/bin`,
      TMPDIR: sandbox.base,
      HOME: sandbox.base,
      GP_SIGNING_SERVICE: 'gpg-signing-test-fixture',
    },
  })
}

test('gpg-signing.sh forget: 两半都删，删完读回为空，退 0', () => {
  const sandbox = makeKeychainSandbox()
  try {
    const r = runForget(sandbox)
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    const deletes = sandbox.calls().filter((l) => l.includes('delete-generic-password'))
    assert.equal(deletes.length, 2, `两半各删一次，实得 ${JSON.stringify(deletes)}`)
    assert.ok(deletes.some((l) => /\bprivate-key\b/.test(l)), deletes.join('\n'))
    assert.ok(deletes.some((l) => /\bpassphrase\b/.test(l)), deletes.length)
    assert.deepEqual(sandbox.remaining(), [], '钥匙串里不该再有任何一半')
    assert.match(r.stdout, /neither half/, r.stdout)
  } finally {
    sandbox.cleanup()
  }
})

test('gpg-signing.sh forget: delete 回 0 而条目仍在 = 判红，不许说成清掉了', () => {
  // 读回判据的反例：`security delete` 成功返回但条目没走（锁/ACL/并发）。没有这一眼，
  // 这一条命令就只是"看起来删了"，而读者会据此认为凭据已经不驻留。
  const sandbox = makeKeychainSandbox({ deleteActuallyRemoves: false })
  try {
    const r = runForget(sandbox)
    assert.equal(r.status, 1, `条目还在却报了成功：${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout + r.stderr, /STILL in the keychain/, r.stdout)
    assert.equal(sandbox.remaining().length, 2, 'stub 的条目本来就不该被这次 delete 带走')
  } finally {
    sandbox.cleanup()
  }
})

test('gpg-signing.sh forget: delete 失败要说"它仍然读得到"，并给人工出路', () => {
  const sandbox = makeKeychainSandbox({ deleteRc: 1 })
  try {
    const r = runForget(sandbox)
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`)
    const text = `${r.stdout}\n${r.stderr}`
    // 折行不许影响判据：报文按 80 列排版，"Keychain Access" 会被拆到两行，判据读的是**说了什么**
    // 而不是它占第几行（换行处把断言钉死，等于给下一次排版改动埋一条假红）。
    const unwrapped = text.replace(/\s+/g, ' ')
    assert.match(unwrapped, /STILL readable by any process this user account runs/, text)
    assert.match(unwrapped, /Keychain Access/, `要给一条跑得到的下一步：${text}`)
    assert.equal(sandbox.remaining().length, 2, text)
  } finally {
    sandbox.cleanup()
  }
})

test('gpg-signing.sh forget: 条目本来就不在 = 如实说"没有可忘的"，退 0 且不假装删过', () => {
  const sandbox = makeKeychainSandbox({ present: [] })
  try {
    const r = runForget(sandbox)
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.deepEqual(sandbox.calls().filter((l) => l.includes('delete-generic-password')), [],
      '没有条目就不许发 delete')
    assert.match(r.stdout, /nothing to forget/, r.stdout)
  } finally {
    sandbox.cleanup()
  }
})

test('gpg-signing.sh: Usage 块与分发表里都有 forget（新增子命令不许没人说得出）', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8')
  const usage = source.split('\n').filter((l) => /^# +gpg-signing\.sh \w/.test(l)).map((l) => l.replace(/^# +/, ''))
  assert.ok(usage.some((l) => l.startsWith('gpg-signing.sh forget')), JSON.stringify(usage))
  assert.match(source, /^ {2}forget\) {3}shift; cmd_forget "\$@" ;;$/m, '分发表里这一条必须存在')
  // 这条断言不是形式主义：上一轮 discover 过 Usage 块由 awk 自己算，写死行号的那版**从来没打出过用法**。
  assert.ok(source.includes('cmd_forget()'), '实现必须存在')
})
