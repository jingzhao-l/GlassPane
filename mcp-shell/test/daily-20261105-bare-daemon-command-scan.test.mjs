/**
 * 每日任务 2026-11-05 · 裸 daemon 命令的扫描集必须**推出来**，不是抄一份名单。
 *
 * 缺陷（本仓第六次同一形状）。`mcp-shell/test/daily-20261103-shell-side-parity.test.mjs:92`
 * 那把闸读的是 `["project-registry.ts", "tools.ts", "update-state.ts", "engine-client.ts"]`
 * ——四个手抄的文件名，全在 `mcp-shell/src` 里。`http-gateway.ts` 就在同一只目录下，因此这条
 * "出路不许印裸名"的纪律从来没有扫到过它；`installer/`、`updater/`、`engine/Sources/` 三面更
 * 是从未被这条规则看过。本轮实测：名单外还剩 5 处 `glasspaned --…` 在装机引导文案里
 * （`installer/cli.js` 的 2775/2915/2932/3451/3562），已全部改写；`glasspaned` 不在 PATH 上
 * （实测 `command -v glasspaned` 无输出，且没有任何包声明这个 `bin`），照抄就是 127。
 *
 * 这一条把扫描集换成**目录遍历**，并把唯一合理的豁免——daemon 自己的用法提纲
 * （`main.swift` 里 `printUsage()` 那一段 `let usage = """ … """`，它是在**命名**命令而不是
 * 交给读者执行）——做成可数的：豁免吃掉了多少行必须打出来，行数掉到 0 就说明提纲搬家了、
 * 豁免还在，那时这条闸自己变空转。
 *
 * REVERSE：把任一被改写的站点改回 `glasspaned --state-dir <路径>` ⇒ 第一条红并点名那一处；
 * 把夹具里那枚 `X --permissions` 从用法段搬进代码段 ⇒ 第二条红（豁免不再是白名单）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 扫描集：由目录与后缀推出，不点名文件。 */
const SCAN_TARGETS = [
  { dir: path.join(REPO, 'mcp-shell', 'src'), ext: '.ts' },
  { dir: path.join(REPO, 'engine', 'Sources'), ext: '.swift', recursive: true },
  { dir: path.join(REPO, 'installer'), ext: '.js' },
  { dir: path.join(REPO, 'updater'), ext: '.js', recursive: true },
  { dir: path.join(REPO, 'scripts'), ext: '.mjs' },
  { dir: path.join(REPO, 'tools'), ext: '.sh' },
]
const SKIP_DIRS = new Set(['node_modules', 'dist', '.build', 'test', 'Tests', 'schemas', 'fixtures'])

function* walk(dir, recursive) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (recursive) yield* walk(path.join(dir, entry.name), recursive)
      continue
    }
    yield path.join(dir, entry.name)
  }
}

/** 注释行不算：本仓要把"旧写法为什么错"留在原地解释，判据扫到解释就会逼人删证据。 */
function isCodeLine(line) {
  const t = line.trim()
  return !(t.startsWith('//') || t.startsWith('///') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#'))
}

/**
 * daemon 用法提纲那一段（只在 `glasspaned/main.swift`）。返回被豁免的行号区间，
 * 让"豁免有多大"本身成为一个可打印、可失败的数。
 */
function usageExemption(file, lines) {
  if (!file.endsWith(path.join('glasspaned', 'main.swift'))) return { range: null, counted: 0 }
  const open = lines.findIndex((l) => /^\s*let usage = ("""|#""")/.test(l))
  if (open < 0) return { range: null, counted: 0 }
  const close = lines.findIndex((l, i) => i > open && /^\s*"""\s*$/.test(l))
  if (close < 0) return { range: null, counted: 0 }
  return { range: [open + 1, close - 1], counted: close - open - 1 }
}

// 前置字符只排"构成另一个标识符/路径/旗标"的那几类。引号与反引号**不算**排除项：
// remedy 正是以 `"`…glasspaned --x`…"` 的形状把命令交给读者的，把它们排除掉就等于把
// 这一族站点整体放行（本轮第一次跑就是这么漏掉夹具里那一行的）。
const BARE = /(?:^|[^A-Za-z0-9/.$-])glasspaned --/

function scanFiles(files, read) {
  const offenders = []
  let exemptLines = 0
  for (const file of files) {
    const lines = read(file).split('\n')
    const { range, counted } = usageExemption(file, lines)
    exemptLines += counted
    lines.forEach((line, i) => {
      if (range && i >= range[0] && i <= range[1]) return
      if (!isCodeLine(line)) return
      if (BARE.test(line)) offenders.push(`${file}:${i + 1}`)
    })
  }
  return { offenders, exemptLines }
}

function sourceFiles() {
  const out = []
  for (const target of SCAN_TARGETS) {
    if (!fs.existsSync(target.dir)) continue
    for (const file of walk(target.dir, target.recursive)) {
      if (file.endsWith(target.ext)) out.push(file)
    }
  }
  const installSh = path.join(REPO, 'install.sh')
  if (fs.existsSync(installSh)) out.push(installSh)
  return out.sort()
}

test('真树上的裸 daemon 命令：一处都不许留（扫描集由目录遍历推出）', () => {
  const files = sourceFiles()
  assert.ok(files.length >= 40, `扫描集只剩 ${files.length} 份文件——它在空转，而不是在守规矩`)
  const { offenders, exemptLines } = scanFiles(files, (f) => fs.readFileSync(f, 'utf8'))
  assert.deepEqual(offenders, [], `这些出路印的是读者跑不动的裸命令：${offenders.join(', ')}`)
  assert.ok(exemptLines >= 10,
    `用法提纲那一段只豁免了 ${exemptLines} 行——搬走了却仍写着豁免，这条闸就是空转`)
})

test('豁免只给用法提纲：同一句话搬进代码段就要被抓', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-bare-scan-'))
  try {
    const dir = path.join(root, 'glasspaned')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'main.swift')
    fs.writeFileSync(file, [
      'private func printUsage() {',
      '    let usage = """',
      '    USAGE:',
      '        glasspaned --permissions',
      '        glasspaned --version',
      '    """',
      '}',
      'func remedy() -> String {',
      '    return "re-read with `glasspaned --permissions`"',
      '}',
      '',
    ].join('\n'))
    const inside = scanFiles([file], (f) => fs.readFileSync(f, 'utf8'))
    assert.deepEqual(inside.offenders, [`${file}:9`],
      '只有第 9 行（交给读者执行的那一句）该被抓，用法段里的两行不该：' + inside.offenders.join(', '))

    // 反向的一格：把提纲整个搬走，豁免就无处可用，段里的命令必须全被抓到。
    const noUsage = path.join(root, 'no-usage.swift')
    fs.writeFileSync(noUsage, 'func r() -> String { "glasspaned --permissions" }\n')
    const moved = scanFiles([noUsage], (f) => fs.readFileSync(f, 'utf8'))
    assert.deepEqual(moved.offenders, [`${noUsage}:1`], '搬出用法段就是一次裸命令，豁免不许跟着走')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('把纪律交给手抄名单的那条老闸，自己也得用遍历出来的集合', () => {
  const parity = fs.readFileSync(
    path.join(REPO, 'mcp-shell', 'test', 'daily-20261103-shell-side-parity.test.mjs'), 'utf8')
  assert.doesNotMatch(
    parity, /const files = \["project-registry\.ts"/,
    '那条闸又回到了手抄的四个文件名——它漏掉的正是本轮那 5 处站点')
  assert.match(parity, /readdirSync/, '它必须从目录读集合，而不是从名单')
})
