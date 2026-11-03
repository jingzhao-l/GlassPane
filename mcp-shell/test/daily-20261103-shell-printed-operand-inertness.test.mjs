/**
 * install.sh / make-app.sh 打印出来的"照着跑"命令，参数位上的值必须是惰性词。
 *
 * 这条纪律本仓已经写过三次（2026-10-30：`installer/cli.js` 十二条 `node "${tree.cli}" …`；
 * 2026-10-31 P2：`install.sh` 的 dry-run 委托行三个值过 `sh_quote`；2026-11-03 本轮：
 * 同一份纪律的**其余半边**从没进过闸）。双引号不是惰性——它照样展开 `$( )` 与反引号，所以
 * 一句"下一步：git -C "$(那目录)" tag -v v1.2.3"里，目录名是一段可执行代码，而它来自
 * `GLASSPANE_REPO` / `$PWD` / 既有 clone 三个位置，全部是调用方给的。
 *
 * 本轮量到的六处（`install.sh`）：
 *   352 `git -C "${_dir}" rev-parse --show-toplevel`（双引号包不住反引号）
 *   375 `GLASSPANE_INSTALL_DIR="${_dir}-…"`（同一枚值，建议用户照抄的那一条）
 *   418 `git -C "${_dir}" fetch --tags ${_depth:+$_depth }"${_remote}" "${_ref}"`
 *   420 `git ls-remote "${_remote}" "${_ref}"`
 *   440 `git clone --branch ${_ref} ${REPO_URL}`（连引号都没有）
 *   452 `git checkout --detach ${_tag}`
 *
 * 判据是**位置**而不是动词名单：名单本仓已经错过三次（残渣闸那份、面 A 那份、以及上面这一份），
 * 而 `mcp-shell/test/remedy-shell-quoting.test.mjs` 正是栽在名单少了 `git` 这一枚。这里不问
 * "是不是 git/chmod/curl"，只问"一个小写词后面紧跟一枚选项，再后面是洞"——那就是参数位。
 *
 * 三条测试互相咬：源码扫描（1）、扫描集不空转（2）、真进程惰性（3，真跑 install.sh、
 * 真把打印出来的那条赋值交给 bash）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const SHELL_FILES = ['install.sh', 'engine/scripts/make-app.sh']

/**
 * 参数位上的洞：`<小写动词> … -选项 … ${VAR}`。动词与洞之间必须出现过一枚选项（`-x`、`--xx`、
 * `/路径`），否则"下一步：确认 ${_dir} 是一棵仓库"这种**句子里**的插值会被算成缺陷——那不是
 * 照抄的命令，给它要求引号是一件不可能的事（`say "  ${_dir} 原地不动"` 同理）。
 */
const OPERAND_HOLE = /[a-z][a-z0-9_.+-]{1,15}(?:[ \t]+[^\s]+)*[ \t]+(?:-{1,2}[A-Za-z][\w-]*|\/[^\s]*)[ \t]+?"?\$\{[A-Za-z_][A-Za-z0-9_]*\}?"?$/

function shellSayLines(source) {
  // 只看真的会打印出去的那一层：`say "…"` 与 `echo "…"`（含续行）。
  return source.split('\n').filter((l) => /^\s*(say|echo|printf)\s+"/.test(l))
}

test('install.sh / make-app.sh 打印的命令里，参数位上的变量必须过 sh_quote', () => {
  const offenders = []
  const inspected = []
  for (const rel of SHELL_FILES) {
    const source = fs.readFileSync(path.join(REPO, rel), 'utf8')
    shellSayLines(source).forEach((line, i) => {
      // `$(sh_quote "$X")` 与 `$(sh_quote "…$(…)…")` 是惰性写法；把整段打印文本按洞逐个切。
      const stripped = line.replace(/\$\(sh_quote\s+"[^"]*"(?:\s*\|\s*tr[^)]*)?"[^"]*"\)/g, '<<Q>>')
        .replace(/\$\(sh_quote\s+"[^"]*"\)/g, '<<Q>>')
      for (const m of stripped.matchAll(/(\S[^\n]{0,120}?\$\{[A-Za-z_][A-Za-z0-9_]*\})/g)) {
        const window = m[1]
        if (!OPERAND_HOLE.test(window)) continue
        offenders.push(`${rel}: 打印文本里参数位有裸变量：${window.slice(-70)}`)
      }
      if (/<<Q>>/.test(stripped) || /\$\{/.test(stripped)) inspected.push(`${rel}:${i}`)
    })
  }
  assert.deepEqual(offenders, [], `这些照抄的命令参数位不是惰性词：\n${offenders.join('\n')}`)
  assert.ok(inspected.length >= 6, `扫描集只看见 ${inspected.length} 处打印位——这条闸在空转：${inspected.join(', ')}`)
})

test('本轮修掉的六处命令位，必须仍在扫描集的视野里（否则改名/搬走就悄悄退役了这道闸）', () => {
  const source = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8')
  const printed = shellSayLines(source).join('\n')
  for (const needle of [
    'rev-parse --show-toplevel',
    'GLASSPANE_INSTALL_DIR=',
    'fetch --tags',
    'git ls-remote',
    'git clone --branch',
    'git checkout --detach',
  ]) {
    assert.ok(printed.includes(needle), `打印行里找不到 ${needle}——那一支被搬走时请把这条对照一起搬，不要删掉`)
    assert.ok(new RegExp(`\$\\(sh_quote\\s+"[^\n]*$`).test(source) || printed.includes(`$(sh_quote`),
      `install.sh 的 sh_quote 用法消失了：${needle}`)
  }
  const quoted = (printed.match(/\$\(sh_quote/g) ?? []).length
  assert.ok(quoted >= 6, `打印行里 sh_quote 只有 ${quoted} 处，六处参数位不可能都惰性`)
})

test('真进程惰性：打印出来的那两句照抄进 bash，目录名里的载荷不许执行', () => {
  // 夹具走的是 installer/test/daily-20261029-installer-lane7.test.mjs 里那条**已经很快**的路：
  // 真本地源仓 + 真 clone + 一个远端不存在的 ref ⇒ 走到 418/420 那两句打印。前一版这里给的是
  // 一个不存在的 file:// 源，install.sh 于是真去试了 clone，一条测试跑了 106 秒——那是负载夹具，
  // 不是对照。
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-inert-'))
  const marker = path.join(root, 'pwned-by-double-quote')
  const spaced = path.join(root, 'a $(touch ' + marker + ')')
  const git = (cwd, args) => spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  try {
    const binDir = path.join(root, 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'uname'), '#!/bin/sh\n[ "$1" = "-s" ] && echo Darwin || echo Darwin\n', { mode: 0o755 })
    const src = path.join(root, 'src')
    fs.mkdirSync(path.join(src, 'engine'), { recursive: true })
    fs.mkdirSync(path.join(src, 'mcp-shell'), { recursive: true })
    fs.writeFileSync(path.join(src, 'engine', 'Package.swift'), '// swift-tools-version:5.10\n')
    fs.writeFileSync(path.join(src, 'mcp-shell', 'package.json'), '{}\n')
    git(src, ['init', '-q', '.'])
    git(src, ['add', '-A'])
    git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'old'])
    git(src, ['tag', 'v0.0.1-old'])
    const cloneArgs = ['clone', '--quiet', '--branch', 'v0.0.1-old', '--single-branch', `file://${src}`, spaced]
    assert.equal(git(root, cloneArgs).status, 0, '夹具：clone 到那枚带载荷的目录名必须成功')

    const run = spawnSync('/bin/sh', [path.join(REPO, 'install.sh')], {
      // cwd 不能是主仓那一棵：install.sh 先在当前目录定位仓库，那样 GLASSPANE_INSTALL_DIR
      // 根本轮不到（本轮实测：cwd=主仓时它答"在当前目录定位到仓库"，那两句打印一句都没走）。
      cwd: root, encoding: 'utf8', stdin: 'ignore', timeout: 90_000,
      env: {
        ...process.env,
        // CI 的三条 lane 里有 ubuntu：这一支测的是"走到那两句打印"，平台闸必须先按 macOS 答。
        // 桩 `uname` 是本仓既有夹具的做法（installer/test 里 makeShFixture/stubBin 同一形），
        // 不是新发明的一种口径。本机（Darwin）带着这个桩也照样成立，两个环境同判据。
        PATH: `${binDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        GLASSPANE_REPO: '',
        GLASSPANE_INSTALL_DIR: spaced,
        GLASSPANE_REF: 'nosuchtag',
        GLASSPANE_REPO_URL: `file://${src}`,
        HOME: root,
      },
    })
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
    assert.match(out, /先 fetch 它|没有 nosuchtag 这个引用/, `前提：这一趟要走到那两句打印：${out.slice(0, 300)}`)
    assert.equal(fs.existsSync(marker), false, '光是跑 install.sh 就触发了目录名里的载荷')

    const printed = out.split('\n').filter((l) => /git -C /.test(l))
    assert.ok(printed.length >= 1, `没打印出任何 git -C 那一句：${out.slice(0, 300)}`)
    for (const line of printed) {
      assert.ok(line.includes(`git -C '${spaced}'`), `参数位不是惰性词（双引号包不住 $()）：${line.trim().slice(0, 160)}`)
      assert.ok(!line.includes(`git -C "${spaced}"`), `又回到双引号那一形：${line.trim().slice(0, 160)}`)
    }
    // 真把这一行交给 bash：只应报"找不到那枚 tag"，不应造出载荷文件。
    const command = printed[0].slice(printed[0].indexOf('git -C'))
    spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(fs.existsSync(marker), false, `把打印出来的那一行照抄进终端会执行目录名里的载荷：${command.slice(0, 120)}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
