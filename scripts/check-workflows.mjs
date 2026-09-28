#!/usr/bin/env node
/**
 * 工作流"解析期就死"检查（CI 门禁 = 本文件，退出码即判定）。
 *
 *   node scripts/check-workflows.mjs
 *   node scripts/check-workflows.mjs --self-test   # 跑守卫自己的对照表
 *
 * 为什么需要它：GitHub 加载不了的工作流不会留下任何 job 日志——文件在解析阶段整体
 * 作废，之后每一次 ref 匹配只生成一个 0 步、无日志、名为文件路径的红色 run。c3797d4
 * 就栽在这：step 级写了 `if: ${{ secrets.GPG_PRIVATE_KEY != '' }}`，而 `secrets` 不是
 * step if 的合法 context，于是 Release 链从 2026-09-27 起再也没法跑，而 main 上连着
 * 六次 push 都"只是多了个看不懂的红灯"，没有任何一处把它指到那一行。
 *
 * 这里只认两类可静态判定的确定形状，不做通用 YAML 求值：
 *   1) 非法 context：`if` / `runs-on` / `uses` / `environment` 里引用 `secrets.`
 *      （`env:` 与 `with:` 是合法位置，不报。）
 *   2) 同一层映射里的重复键：会静默覆盖或直接报错，merge 手抄整块时最容易造出来。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const WORKFLOWS_DIR = '.github/workflows'
// GitHub 在这些位置不提供 secrets context（jobs.*.env / steps.*.env / with 里才给）。
const NO_SECRETS_KEYS = new Set(['if', 'runs-on', 'uses', 'environment'])
const KEY_LINE = /^([ \t]*)(-[ \t]+)?([A-Za-z0-9_.-]+):(?:[ \t](.*))?$/
const BLOCK_SCALAR = /^[|>][+-]?\d*\s*(?:#.*)?$/

/** 去掉行尾注释，引号内的 `#` 不算注释起始。 */
function stripComment(value) {
  let quote = null
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trimEnd()
  }
  return value
}

/** 扫描一个工作流文件，返回 findings 数组（每项 {line, why}）。 */
export function scanWorkflow(text) {
  const findings = []
  // frame = {indent, keys:Map<key, 首次出现的行号>}；栈自外向内记录当前映射层。
  const stack = []
  // blockAt = 该 block scalar 所属键的缩进：比它深的行全是字符串内容，不参与结构判定。
  let blockAt = null

  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const lineNo = index + 1

    if (blockAt !== null) {
      const indent = raw.match(/^[ \t]*/)[0].length
      if (raw.trim() === '' || indent > blockAt) continue
      blockAt = null
    }

    if (raw.trim() === '' || /^[ \t]*#/.test(raw)) continue

    const match = KEY_LINE.exec(raw)
    if (!match) continue // 序列标量（`- v*`）、续行等：不是键行。

    const [, indentText, dash, key, rawValue] = match
    const value = stripComment(rawValue ?? '')
    const indent = indentText.length

    if (NO_SECRETS_KEYS.has(key) && /(^|[^A-Za-z0-9_.])secrets\s*\./.test(value)) {
      findings.push({
        line: lineNo,
        why: `\`${key}:\` 里引用了 secrets context —— GitHub 解析整个工作流时报 ` +
          `“Unrecognized named-value: 'secrets'”，工作流从此不产生任何 job。` +
          `要按 secret 存在与否分支：先把判定写进前一个 step 的 $GITHUB_OUTPUT，再用 steps.<id>.outputs 门控。`
      })
    }

    const contentIndent = dash ? indent + dash.length : indent
    // 序列项（带 `- `）自己就是一层新映射：同缩进的兄弟项必须先出栈，键集才不会被
    // 上一步的 env/run/if 串成同一层。映射键（无 `- `）只在更深的层出栈。
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const pop = dash ? top.indent >= contentIndent : top.indent > contentIndent
      if (!pop) break
      stack.pop()
    }
    let frame = stack[stack.length - 1]
    if (!frame || frame.indent !== contentIndent) {
      frame = { indent: contentIndent, keys: new Map() }
      stack.push(frame)
    }
    const seen = frame.keys.get(key)
    if (seen !== undefined) {
      findings.push({
        line: lineNo,
        why: `同一层映射里重复的键 \`${key}:\`（首次出现在第 ${seen} 行）—— YAML 取后者，` +
          `前一块（含 triggers/env/steps）静默失效，merge 时整块手抄最容易出现这种形状。`
      })
    } else {
      frame.keys.set(key, lineNo)
    }

    if (BLOCK_SCALAR.test(value)) blockAt = indent
  }
  return findings
}

function workflowFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /\.(ya?ml)$/.test(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => join(dir, name))
}

/**
 * 守卫自己的对照表：每条都指定"该报几处"。合法形状那几行是这条闸能留下来的前提——
 * 一个把注释或 run 正文当缺陷的扫描器，下一个人会为了绿灯把注释删掉，闸就静默没了。
 */
const SELF_TESTS = [
  { name: 'step 级 if 引用 secrets', yaml: "jobs:\n  a:\n    steps:\n      - name: S\n        if: ${{ secrets.K != '' }}\n        run: x\n", expect: 1 },
  { name: 'job 级 if 引用 secrets', yaml: "jobs:\n  a:\n    if: ${{ secrets.K != '' }}\n    steps: []\n", expect: 1 },
  { name: 'environment 引用 secrets', yaml: "jobs:\n  a:\n    environment: ${{ secrets.E }}\n    steps: []\n", expect: 1 },
  { name: 'env 里引用 secrets（合法位置）', yaml: "jobs:\n  a:\n    steps:\n      - name: S\n        env:\n          K: ${{ secrets.K }}\n        run: x\n", expect: 0 },
  { name: 'with 里引用 secrets（合法位置）', yaml: "jobs:\n  a:\n    steps:\n      - uses: a/b@v1\n        with:\n          token: ${{ secrets.T }}\n", expect: 0 },
  { name: 'steps.*.outputs 门控（本次修复的形状）', yaml: "jobs:\n  a:\n    steps:\n      - id: g\n        run: x\n      - name: S\n        if: ${{ steps.g.outputs.present == 'true' }}\n        run: y\n", expect: 0 },
  { name: '顶层 on: 重复（merge 手抄整块）', yaml: "name: R\non:\n  push:\n    tags: v*\non:\n  workflow_dispatch:\n", expect: 1 },
  { name: '同层键重复', yaml: "jobs:\n  a:\n    steps:\n      - name: S\n        env:\n          K: 1\n          K: 2\n        run: x\n", expect: 1 },
  { name: 'run 正文里的同名行（字符串内容，合法）', yaml: "jobs:\n  a:\n    steps:\n      - name: S\n        run: |\n          FRUIT=apple\n          FRUIT=pear\n          echo \"x: 1\"\n          echo \"x: 2\"\n", expect: 0 },
  { name: '注释里的 secrets（不得当真）', yaml: "jobs:\n  a:\n    steps:\n      - name: S\n        # if: ${{ secrets.K != '' }}\n        run: x\n", expect: 0 },
  { name: 'if 值后面的行尾注释（不得当真）', yaml: "jobs:\n  a:\n    steps:\n      - name: S\n        if: ${{ github.ref != '' }} # secrets 不可用\n        run: x\n", expect: 0 },
]

function selfTest() {
  let bad = 0
  for (const testCase of SELF_TESTS) {
    const got = scanWorkflow(testCase.yaml).length
    const ok = got === testCase.expect
    if (!ok) bad += 1
    process.stdout.write(`${ok ? '✓' : '≠'} ${testCase.name}: 期望报 ${testCase.expect} 处，实报 ${got} 处\n`)
  }
  if (bad > 0) process.stderr.write(`\n守卫自身失真：${bad}/${SELF_TESTS.length} 条对照不符 —— 它现在既会漏报也会误报。\n`)
  return bad === 0
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest() ? 0 : 1

  const files = workflowFiles(WORKFLOWS_DIR)
  if (files.length === 0) {
    process.stderr.write(`找不到工作流目录 ${WORKFLOWS_DIR}——门禁无对象可查，判为不可用\n`)
    return 2
  }

  let broken = 0
  for (const file of files) {
    const findings = scanWorkflow(readFileSync(file, 'utf8'))
    process.stdout.write(`${relative(process.cwd(), file)}: ${findings.length === 0 ? 'OK' : `${findings.length} 处`}\n`)
    for (const finding of findings) {
      broken += 1
      process.stderr.write(`  ${finding.line}: ${finding.why}\n`)
    }
  }

  if (broken > 0) {
    process.stderr.write(`\n工作流不可编译：${broken} 处。后果不是"少一步"而是整条工作流 0 job、无日志。\n`)
    return 1
  }
  process.stdout.write(`\nOK：${files.length} 个工作流文件通过可编译性检查。\n`)
  return 0
}

// 只在作为命令执行时扫描仓库；被 import（对照表、别的脚本）时保持零副作用。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
