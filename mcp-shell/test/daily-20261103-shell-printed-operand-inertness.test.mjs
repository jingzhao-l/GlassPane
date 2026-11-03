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

test('真进程惰性：把打印出来的那条 GLASSPANE_INSTALL_DIR= 交给 bash，载荷不许执行', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-inert-'))
  // 目录名就是一枚载荷：反引号 + 空格，正是双引号挡不住的那两种东西。
  const marker = path.join(root, 'pwned-by-double-quote')
  const hostile = path.join(root, 'a `touch ' + marker + '`')
  try {
    fs.mkdirSync(path.join(hostile, 'engine'), { recursive: true })
    fs.mkdirSync(path.join(hostile, 'mcp-shell'), { recursive: true })
    fs.writeFileSync(path.join(hostile, 'engine', 'Package.swift'), '// fixture\n')
    fs.writeFileSync(path.join(hostile, 'mcp-shell', 'package.json'), '{}\n')
    fs.writeFileSync(path.join(hostile, 'dirty.txt'), 'uncommitted\n')
    const git = (args) => spawnSync('git', args, { cwd: hostile, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    git(['init', '-q', '.'])
    git(['add', 'engine/Package.swift', 'mcp-shell/package.json'])
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

    const run = spawnSync('/bin/sh', [path.join(REPO, 'install.sh')], {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, GLASSPANE_REPO: hostile, GLASSPANE_REF: 'v1.28.1', HOME: root },
      stdin: 'ignore', timeout: 120_000,
    })
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
    assert.ok(run.status !== 0, `脏树本就该拒装，实退 ${run.status}：${out.slice(0, 200)}`)
    assert.match(out, /未提交改动|不合判据/, `没有走到那三句归因，这条对照什么也没测：${out.slice(0, 200)}`)

    const line = out.split('\n').find((l) => l.includes('GLASSPANE_INSTALL_DIR='))
    if (line) {
      const value = line.slice(line.indexOf('GLASSPANE_INSTALL_DIR=') + 'GLASSPANE_INSTALL_DIR='.length).split(' ')[0]
      assert.match(value, /^'/, `打印出来给人照抄的赋值不是单引号惰性词：${value.slice(0, 60)}`)
      spawnSync('/bin/bash', ['-c', `export ${value} true`], { encoding: 'utf8' })
      assert.equal(fs.existsSync(marker), false, '照抄这一行会执行目录名里的载荷——惰性引号没生效')
    }
    assert.equal(fs.existsSync(marker), false, `光是跑 install.sh 就触发了目录名里的载荷：${marker}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
