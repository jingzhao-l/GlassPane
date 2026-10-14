/**
 * 安装器收尾的两句实话（2026-10-11 daily round）。
 *
 * 一：被 GPG 签名证明过的 tag，与真正拿去 `npm install`/`swift build` 的那棵树，从前可以是
 * 两种东西——`repoHasRef` 只回答"这个仓库里有没有这个 tag"，而 `install.sh` 自己就写着
 * "既有 clone 不会被自动切到 $REF"。于是树对不上时屏幕仍打绿字"发布 tag vX 签名验证通过"。
 * 二：`verified = Boolean(arrived && hello?.version)` 从不把 hello 报的版本与本轮构建产物比，
 * 旧实例占着 socket（那条"跳过启动"分支）时报的是上一版，安装器却说"实测校验通过…安装完成"并退 0。
 *
 * 夹具形状来自真过程：一棵真的 git 仓库（真 init/commit/tag/status），一个真的可执行 stub，
 * 它的 argv 面与 `glasspaned --version` 的实测行为一致（只认 `--version`，其余按
 * `unknown argument` + 64 拒绝）——不给不存在的能力作背书。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  builtDaemonVersion,
  install,
  installVerification,
  npmDepsCommand,
  tagVerifyGate,
  parseArgs,
  tagTreeAgreement,
  tagVerifyAgainstTree,
  tagVerifyDecision,
} from '../cli.js'

function makeTree() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-installer-tree-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'test')
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'release')
  git('-c', 'user.signingkey=', 'tag', '-a', '-m', 'v1.2.3', 'v1.2.3')
  return { root, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('树与被签的 tag 对得上时，绿字才许出现', () => {
  const tree = makeTree()
  try {
    const agree = tagTreeAgreement({ repoDir: tree.root, ref: 'v1.2.3' })
    assert.equal(agree.ok, true, JSON.stringify(agree))
    assert.equal(agree.same, true, `刚 checkout 到 tag 的树必须算作同一棵，实得 ${JSON.stringify(agree)}`)
    const pass = { action: 'pass', text: '发布 tag v1.2.3 GPG 签名验证通过' }
    const kept = tagVerifyAgainstTree({ verdict: pass, tree: agree, pinRef: 'v1.2.3', repoDir: tree.root })
    assert.equal(kept.action, 'pass', '对得上时不许把绿字也削掉——那会让这条闸只会拒绝')
    assert.equal(kept.text, pass.text)
  } finally {
    tree.cleanup()
  }
})

test('HEAD 走到 tag 之后，签名绿字必须降级成"签的不是本次要装的这棵树"', () => {
  const tree = makeTree()
  try {
    fs.writeFileSync(path.join(tree.root, 'new.swift'), 'after the tag\n')
    tree.git('add', '-A')
    tree.git('commit', '-q', '-m', 'later work')
    const agree = tagTreeAgreement({ repoDir: tree.root, ref: 'v1.2.3' })
    assert.equal(agree.same, false, JSON.stringify(agree))
    assert.notEqual(agree.head, agree.tagCommit, 'HEAD 已走在 tag 之后，两个 sha 必须不同')
    const downgraded = tagVerifyAgainstTree({
      verdict: { action: 'pass', text: '发布 tag v1.2.3 GPG 签名验证通过' },
      tree: agree,
      pinRef: 'v1.2.3',
      repoDir: tree.root,
    })
    assert.equal(downgraded.action, 'warn')
    assert.match(downgraded.text, /不是本次要装的这棵树/)
    assert.doesNotMatch(downgraded.text, /^发布 tag v1\.2\.3 GPG 签名验证通过$/, '那句绿字不得原样留下')
    assert.ok(downgraded.text.includes(String(agree.tagCommit).slice(0, 7)), '要说清 tag 签的是哪个 commit')
    assert.ok(downgraded.text.includes(String(agree.head).slice(0, 7)), '也要说清本次要装的是哪个 commit')
    assert.match(downgraded.text, /git -C .* checkout v1\.2\.3/, '下一步必须可执行')
  } finally {
    tree.cleanup()
  }
})

test('本地未提交的改动同样把绿字降级，并报出改动条数', () => {
  const tree = makeTree()
  try {
    fs.writeFileSync(path.join(tree.root, 'package.json'), '{"version":"local-edit-not-in-any-tag"}\n')
    const agree = tagTreeAgreement({ repoDir: tree.root, ref: 'v1.2.3' })
    assert.equal(agree.same, false)
    assert.equal(agree.changed, 1, JSON.stringify(agree))
    const downgraded = tagVerifyAgainstTree({
      verdict: { action: 'pass', text: '发布 tag v1.2.3 GPG 签名验证通过' },
      tree: agree,
      pinRef: 'v1.2.3',
      repoDir: tree.root,
    })
    assert.equal(downgraded.action, 'warn')
    assert.match(downgraded.text, /1 处未提交改动/)
  } finally {
    tree.cleanup()
  }
})

test('读不出 HEAD 或 tag commit 时不得放行绿字，签名验不过仍旧是拒装', () => {
  const tree = makeTree()
  try {
    const nowhere = tagTreeAgreement({ repoDir: tree.root, ref: 'v9.9.9-does-not-exist' })
    assert.equal(nowhere.ok, false)
    assert.equal(nowhere.same, false, '读不出来就不能算"对得上"')
    assert.equal(tagVerifyAgainstTree({
      verdict: { action: 'pass', text: 'green' },
      tree: nowhere,
      pinRef: 'v1.2.3',
      repoDir: tree.root,
    }).action, 'warn')

    // 对照：`invalid` 那一路是拒装，树对得上或对不上都不许把它软化。
    const refused = tagVerifyDecision({ sig: { status: 'invalid', detail: 'bad sig' }, pinRef: 'v1.2.3', repoDir: tree.root })
    assert.equal(refused.action, 'refuse')
    assert.equal(tagVerifyAgainstTree({ verdict: refused, tree: nowhere, pinRef: 'v1.2.3', repoDir: tree.root }).action, 'refuse')
  } finally {
    tree.cleanup()
  }
})

/** 与真 `glasspaned --version` 同面的 stub：只认 `--version`，其余 unknown argument + 64。 */
function makeDaemonStub({ version = null, exitWith = null }) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-installer-stub-'))
  const bin = path.join(dir, 'glasspaned')
  const body = version === null
    ? '#!/bin/sh\necho "usage: glasspaned [flags]" >&2\nexit 64\n'
    : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho "unknown argument: $1" >&2\nexit 64\n`
  fs.writeFileSync(bin, body, { mode: 0o755 })
  if (exitWith !== null) fs.chmodSync(bin, 0o644) // 不可执行的那一档
  return { bin, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('本轮构建产物的版本只从真 subprocess 读，读不出就是读不出', () => {
  const good = makeDaemonStub({ version: '1.2.3\n' })
  try {
    assert.equal(builtDaemonVersion({ daemonBin: good.bin }), '1.2.3')
  } finally {
    good.cleanup()
  }
  // 那一行不是版本号时不许编出一个：真 `--version` 的输出格式由 daemon 侧的
  // `DaemonVersionFlagTests` 钉住，这里只守住"解析不出就等于不知道"。
  const wordy = makeDaemonStub({ version: 'GlassPane daemon, built locally\n' })
  try {
    assert.equal(builtDaemonVersion({ daemonBin: wordy.bin }), null, '没有 x.y.z 那一行时不得凭空造一个版本')
  } finally {
    wordy.cleanup()
  }
  const noisy = makeDaemonStub({ version: null })
  try {
    assert.equal(builtDaemonVersion({ daemonBin: noisy.bin }), null, '非零退出不得编出一个版本')
  } finally {
    noisy.cleanup()
  }
  assert.equal(builtDaemonVersion({ daemonBin: path.join(noisy.dir, 'missing') }), null, '产物不在时报 null，不许抛')
})

test('应答 hello 的实例版本与本轮构建产物不一致时，"安装完成"与退出码 0 都不许出现', () => {
  const stale = installVerification({ arrived: true, helloVersion: '1.2.2', builtVersion: '1.2.3' })
  assert.equal(stale.verified, false, '旧实例在服务时，本轮构建从未被验证')
  assert.match(stale.note, /1\.2\.2/)
  assert.match(stale.note, /1\.2\.3/)
  assert.match(stale.note, /--replace-daemon/, '出路必须点名那条真存在的开关')

  const blind = installVerification({ arrived: true, helloVersion: '1.2.3', builtVersion: null })
  assert.equal(blind.verified, false, '读不出产物版本时不能替"是本轮构建"作保')

  const fresh = installVerification({ arrived: true, helloVersion: '1.2.3', builtVersion: '1.2.3' })
  assert.equal(fresh.verified, true, '对照：版本对得上且是本次启动的，校验就算通过')
  assert.equal(fresh.note, null)

  const preexisting = installVerification({
    arrived: true, helloVersion: '1.2.3', builtVersion: '1.2.3', servedByEarlierInstance: true,
  })
  assert.equal(preexisting.verified, true)
  assert.match(preexisting.note, /不能证明它是本轮构建/, '同版本号只说明同一版本，实例早于本次安装时这句必须说')

  assert.equal(installVerification({ arrived: false }).verified, false, 'socket 没等到仍旧不算')
})

/* ---------------------------------------------------------------------------
 * 拿去 `npm` 的那条命令行（2026-10-14 review）。`install()` 从前无条件跑
 * `npm install`，而同一仓库的 CI 根门（ci.yml install-gate 的 `npm ci`）、发布作业
 * （release.yml 的 `npm ci --no-audit --no-fund`）与 updater 的树守卫量的都是**提交过的
 * 那份 lockfile**——"CI 全绿的发布 tag"这句 attest 说的就是那棵依赖树。`npm install`
 * 会重新解析浮动传递依赖，于是装出来的 app 依赖树可以与被 attest 的那棵不是同一份，
 * 屏幕上却仍写着绿。夹具形状：一棵真目录 + 一个只记录 argv 然后**按失败退场**的 npm
 * （真 npm 装失败就是这个形状）；它不答任何"成功"的样子，所以这条测试能证的只有
 * "选的是哪条命令行"，证不了依赖真装上了。
 * ------------------------------------------------------------------------- */

/** 只记录 argv 就退 1 的 npm：没有安装能力、没有版本可答，与真实的失败面同形。 */
function makeRefusingNpmStub() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-npmstub-'))
  const log = path.join(dir, 'argv.log')
  fs.writeFileSync(path.join(dir, 'npm'),
    `#!/bin/sh\nprintf 'npm %s\\n' "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 })
  return { dir, log, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** 一棵"要被装"的树：真的 package.json，lockfile 按参数给不给。 */
function makeInstallTarget({ lockfile }) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-npmci-tree-'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"gp-fixture-tree","version":"1.14.1"}\n')
  if (lockfile) fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n')
  return dir
}

test('npmDepsCommand：有 lockfile = npm ci --no-audit --no-fund，没有才 npm install', () => {
  assert.deepEqual(npmDepsCommand({ hasLockfile: true }), ['ci', '--no-audit', '--no-fund'])
  assert.deepEqual(npmDepsCommand({ hasLockfile: false }), ['install'])
  assert.deepEqual(npmDepsCommand({}), ['install'], '判据缺省是"没有 lockfile"，不许凭空假定有一份')
})

test('真 install() 走到依赖那一步时，按树的 lockfile 形状选命令行（argv 由 stub 记录）', async () => {
  const stub = makeRefusingNpmStub()
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-npmci-home-'))
  const savedPath = process.env.PATH
  const savedHome = process.env.HOME
  // `run()` 是按进程 PATH 起 npm 的，所以这里必须临时换 PATH（并在 finally 里换回来）。
  process.env.PATH = `${stub.dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`
  process.env.HOME = home
  const seen = []
  try {
    for (const lockfile of [true, false]) {
      const tree = makeInstallTarget({ lockfile })
      const { options, error } = parseArgs(['--repo', tree, '--no-prompt', '--no-gui', '--no-app'])
      assert.equal(error, null, error)
      // 依赖装不动 → 安装必须**停下**（不是继续报绿）。
      await assert.rejects(
        () => install({ options, env: { HOME: home, GLASSPANE_REPO: tree }, uid: 501 }),
        /npm 失败，退出码 1/,
        `npm 那一步非零退出必须让 install() 抛（lockfile=${lockfile}）`,
      )
      const lines = fs.readFileSync(stub.log, 'utf8').trim().split('\n')
      assert.equal(lines.length, seen.length + 1, `每轮应只调用一次 npm，实得：${JSON.stringify(lines)}`)
      seen.push(lines[lines.length - 1])
      fs.rmSync(tree, { recursive: true, force: true })
    }
    assert.equal(seen[0], 'npm ci --no-audit --no-fund', `有 lockfile 的那棵树走的必须是 npm ci（与 CI/release 门同一份 lock），实得「${seen[0]}」`)
    assert.equal(seen[1], 'npm install', `没有 lockfile 的树才允许退回 npm install，实得「${seen[1]}」`)
    // 口令式反证：两棵树的命令行不是同一条——否则上面两条断言可以同时被一条硬编码满足。
    assert.notEqual(seen[0], seen[1])
  } finally {
    process.env.PATH = savedPath
    process.env.HOME = savedHome
    stub.cleanup()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('tagVerifyGate：一个不存在的 ref 不能冒充"验过签"', () => {
  // 从前这里是 `pinRef !== 'main' && repoHasRef(...)`：两个条件都不满足时整块静默跳过，
  // 安装照常完成，输出里没有一句"没验过"。
  const missing = tagVerifyGate({ pinRef: 'v9.9.9', hasRef: false })
  assert.equal(missing.action, 'skip', '--repo 指的本地树没有 tag 可验，不能因此打断受支持的安装路径')
  assert.match(missing.text, /未做 GPG 验签/, missing.text)
  assert.match(missing.text, /没有任何签名担保/, missing.text)

  const present = tagVerifyGate({ pinRef: 'v1.14.1', hasRef: true })
  assert.equal(present.action, 'verify', '存在就该去验，不该有任何解释文案')
  assert.equal(present.text, null)

  const branch = tagVerifyGate({ pinRef: 'main', hasRef: false })
  assert.equal(branch.action, 'skip', 'main 是显式声明的"分支头没有发布签名可验"')
  assert.match(branch.text, /GLASSPANE_REF=main/, branch.text)
  // 两条 skip 的话术必须不同：一个是"你指名要分支头"，一个是"你要的 tag 不在这棵树里"。
  assert.notEqual(branch.text, missing.text)
})

test('tagVerifyGate：形状不安全的 ref 是拒，不是跳过验签继续装', () => {
  // 这个值会被原样拼进 `git verify-tag` / `git rev-parse`。以 `-` 开头就是选项注入的入口，
  // 含空白则是 `ext::sh -c …` 那一类；`validateGitRef` 过去只守 clone 那一条路。
  for (const bad of ['--upload-pack=touch /tmp/pwned', 'v1.14.1 -c', '+v1.14.1', '']) {
    const gate = tagVerifyGate({ pinRef: bad, hasRef: true })
    assert.equal(gate.action, 'refuse', `${JSON.stringify(bad)} 必须被拒：${gate.text}`)
    assert.match(gate.text, /形状不安全|为空|含空白|以 "-" 开头|以 "\+" 开头/, gate.text)
  }
  // 对照：正常 tag 不能被这条判据误伤。
  assert.equal(tagVerifyGate({ pinRef: 'v1.14.1', hasRef: true }).action, 'verify')
  assert.equal(tagVerifyGate({ pinRef: 'refs/tags/v1.14.1', hasRef: true }).action, 'verify')
})
