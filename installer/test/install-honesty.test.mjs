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
  installVerification,
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
