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
