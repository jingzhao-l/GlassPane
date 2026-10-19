/**
 * `scripts/check-doc-links.mjs` 的判据：每一条都要能证红，红要有名字。
 *
 * 这个文件守着四类判据，每一类都对应一轮真实发生过的缺陷：
 *   1) **工具数量**（`toolCountDrift`）——主仓文档手抄的 `gp_*` 数与 `mcp-shell/src/tools.ts`
 *      的真实数量对不上必须红；而同一把尺子量到 fork 自己的文档上会恒红（2026-10-13 那次），
 *      所以扫描集合必须能注入、两个方向都要测。
 *   2) **围栏内的行不是标题**（`headingsOf`）——从前逐行认 `^#{1,6}`，README 的 bash 片段里
 *      `# 1) One-liner` 被当成真标题：既造出 GitHub 上不存在的锚点（假绿），又把 `-1/-2`
 *      的去重编号顶歪（假红）。
 *   3) **可复算主张的双语一致性**（`claimDrift`）——从前"双语成对"只查对偶文件在不在，
 *      于是 README 写 `weak` 而 SECURITY 与引擎写 `soft`、两份 README 说 7 条 lane 而
 *      ci.yml 有 9 个 job，全绿过闸。这里补的是**只改一种语言那一侧**的形状。
 *   4) **正文里不许有 shell 残渣**（`shellResidue`，2026-10-16 本轮）——用 heredoc 往
 *      `engine/smoke.md` 追加时外层引号提前收尾，包装脚本自己的 `EOF` / `echo "appended: $(…)"`
 *      被当成正文提交，同一形状中招两次，而当时的这道闸全绿：它只看链接与主张。围栏要豁免、
 *      中文人话要豁免（第一版就误红过 harness 的一句话），两种豁免各有对照。
 *
 * 夹具写在临时根里，不动仓库任何一份真文档；最后一条用真仓库自证当下是绿的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { toolCountDrift, claimDrift, headingsOf, check, CLAIMS, shellResidue } from '../../scripts/check-doc-links.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 一个只有 tools.ts 与两份文档的假仓库；`toolCount` 决定源码侧真实数量。 */
function fakeRoot({ mainText, forkText, toolCount = 16 }) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-doc-links-'))
  fs.mkdirSync(path.join(root, 'mcp-shell', 'src'), { recursive: true })
  const names = Array.from({ length: toolCount }, (_, i) => `  name: "gp_tool_${String.fromCharCode(97 + i)}",`).join('\n')
  fs.writeFileSync(path.join(root, 'mcp-shell', 'src', 'tools.ts'), `const SPECS = [\n${names}\n];\n`)
  if (mainText) fs.writeFileSync(path.join(root, 'README.md'), mainText)
  if (forkText) {
    fs.mkdirSync(path.join(root, 'harness/glasspane-harness'), { recursive: true })
    fs.writeFileSync(path.join(root, 'harness/glasspane-harness/SYNCLOG.md'), forkText)
  }
  return root
}

const MAIN = ['README.md']
const BOTH = ['README.md', 'harness/glasspane-harness/SYNCLOG.md']

test('check-doc-links: 主仓文档抄错工具数 → 具名报错（这条判据的存在理由）', () => {
  const root = fakeRoot({ mainText: '本壳对外提供 15 个工具。\n', toolCount: 16 })
  const problems = toolCountDrift({ docs: MAIN, rootDir: root })
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /README\.md: 写了 15 个工具，代码里实际是 16 个/)
  // 报文必须给出原句，否则改文档的人不知道自己动的是哪一句（旧写法把 `${m[1]}`
  // 反斜杠转义留在了普通字符串里，读者看到的是一行模板残骸）。
  assert.match(problems[0], /原句 "15 个工具"/, problems[0])
  fs.rmSync(root, { recursive: true, force: true })
})

test('check-doc-links: 数量对得上时不报（对照，防止判据只会红）', () => {
  const root = fakeRoot({ mainText: '本壳对外提供 16 个工具。\n', toolCount: 16 })
  assert.deepEqual(toolCountDrift({ docs: MAIN, rootDir: root }), [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('check-doc-links: fork 文档里另一个 `gp_*` 数量不参与主仓口径（0.7.8 那次恒红的形状）', () => {
  // 主仓那句是对的，fork 那句写的是 opencode 的 tool id 数。若扫描集合退回成 DOCS（含 fork），
  // 这一条就会红——那正是本轮 main 上红着的状态。
  const root = fakeRoot({
    mainText: '本壳对外提供 16 个工具。\n',
    forkText: '声称工具不在它的函数表里——而 `/experimental/tool/ids` 实测 20 个 id 含全部 6 个 `gp_*`，\n',
    toolCount: 16,
  })
  assert.deepEqual(toolCountDrift({ docs: MAIN, rootDir: root }), [])
  // 对照：把 fork 文档塞回扫描集合，同一条句子必须报错——证明"不红"是刻意的作用域，
  // 不是判据坏掉了或者正则没命中。
  const wrong = toolCountDrift({ docs: BOTH, rootDir: root })
  assert.equal(wrong.length, 1, JSON.stringify(wrong))
  assert.match(wrong[0], /SYNCLOG\.md: 写了 6 个工具，代码里实际是 16 个/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('check-doc-links: 真仓库现在的状态是绿的，且真实数量确实来自 tools.ts（不依赖构建产物）', () => {
  assert.deepEqual(toolCountDrift(), [], 'main 上的文档口径不该红')
  const src = fs.readFileSync(path.join(REPO, 'mcp-shell', 'src', 'tools.ts'), 'utf8')
  const counted = (src.match(/^\s*name:\s*"gp_[a-z_]+",/gm) ?? []).length
  assert.ok(counted > 0, '数不出数量说明正则与工具表形状已漂移')
  assert.equal(toolCountDrift({ docs: ['README.md'], rootDir: REPO }).length, 0)
})

// ---------------------------------------------------------------------------
// 围栏：代码块里的 `#` 行不是标题
// ---------------------------------------------------------------------------

test('check-doc-links: 代码块里的 # 注释不生成锚点（README 的 bash 片段形状）', () => {
  const set = headingsOf([
    '## Install',
    '',
    '```bash',
    '# 1) One-liner',
    '# 2) Through npm',
    '```',
    '',
    '## Install',
    '',
  ].join('\n'))
  // 假锚点必须不存在：GitHub 渲染时这些行在 <pre> 里，压根不是标题。
  assert.ok(!set.has('1-one-liner'), JSON.stringify([...set]))
  assert.ok(!set.has('2-through-npm'), JSON.stringify([...set]))
  // 而去重编号必须由**真标题**占位：第二个 "Install" 拿到 `install-1`，不会被注释行挤走。
  assert.ok(set.has('install'), JSON.stringify([...set]))
  assert.ok(set.has('install-1'), JSON.stringify([...set]))
})

test('check-doc-links: 围栏关掉之后标题重新算数（防止判据只会屏蔽）', () => {
  const set = headingsOf('```jsonc\n{"a": 1}\n```\n\n## After the fence\n')
  assert.ok(set.has('after-the-fence'), JSON.stringify([...set]))
  // 波浪线围栏同样认；未闭合的围栏之后不再有标题（GitHub 就是这么渲染的）。
  assert.ok(headingsOf('~~~\n# inside tilde\n~~~\n\n## Tilde closed\n').has('tilde-closed'))
  assert.ok(!headingsOf('```\n# never closes\n# also not a heading\n').has('also-not-a-heading'))
})

// ---------------------------------------------------------------------------
// 跨文档锚点：目标没登记也要查
// ---------------------------------------------------------------------------

/** 一个两份文档 + 一份没登记的文档的假仓库（补齐 check() 需要的真源与对偶文件）。 */
function anchorRoot({ links }) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-anchor-'))
  const write = (rel, text) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  write('README.md', links.join('\n') + '\n')
  write('README.zh-CN.md', '对偶文件：锚点用例不考它的句子，只要求 `check()` 的双语成对判据不报噪音。\n')
  write('mcp-shell/src/tools.ts', 'const SPECS = [\n  name: "gp_x",\n];\n')
  write('kernel/schemas/evidence-pack.schema.json', JSON.stringify({ properties: { signals: { properties: { act: { properties: { action: { enum: ['press'] } } } } } } }))
  write('.github/workflows/ci.yml', 'name: CI\non:\n  push:\njobs:\n  only:\n')
  write('install.sh', 'GLASSPANE_RELEASE="v1.14.1"\n')
  write('package.json', JSON.stringify({ version: '1.14.1' }))
  write('docs/unregistered.md', '# Real Heading\n\n正文。\n\n## 中文标题\n')
  return root
}

test('check-doc-links: 指向未登记文档的锚点不再被静默跳过', () => {
  const good = anchorRoot({ links: ['[a](docs/unregistered.md#real-heading)', '[b](docs/unregistered.md#中文标题)'] })
  const bad = anchorRoot({ links: ['[a](docs/unregistered.md#real-headng)', '[b](docs/unregistered.md#中文标题)'] })
  // 夹具里没有 tools.ts / 对偶文件，所以只看锚点这一类报文（其余判据各有自己的用例）。
  const anchorProblems = (root) => check({ rootDir: root, docs: ['README.md'] }).problems.filter((p) => /锚点|路径/.test(p))
  // 旧写法是 `if (set && !set.has(...))`：set 取不到就整条跳过，所以坏锚点也是绿的。
  assert.deepEqual(anchorProblems(good), [])
  const problems = anchorProblems(bad)
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /跨文档锚点失效 → docs\/unregistered\.md#real-headng/)
  fs.rmSync(good, { recursive: true, force: true })
  fs.rmSync(bad, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 可复算主张：对真源核 + 对另一语言核
// ---------------------------------------------------------------------------

/** 真源齐备的假仓库：每个真源都是它在本仓的真实形状，只是数值由参数决定。 */
function claimRoot({ readme = '', readmeZh = '', toolCount = 16, lanes = 9, actions = 7, attribution = 'soft', tag = '1.14.1', line = '1.14', version = '1.14.1' } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-claims-'))
  const write = (rel, text) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  const names = Array.from({ length: toolCount }, (_, i) => `  name: "gp_tool_${String.fromCharCode(97 + i)}",`).join('\n')
  write('mcp-shell/src/tools.ts', `const SPECS = [\n${names}\n];\n`)
  // 真源就是引擎里那一行的形状：污染时 weak，否则才是默认值。
  write('engine/Sources/GlassPaneEngine/EngineCore.swift', `var attributionLevel: AttributionLevel = contaminated ? .weak : .${attribution}\n`)
  const actionNames = Array.from({ length: actions }, (_, i) => `action_${i}`)
  write('kernel/schemas/evidence-pack.schema.json', JSON.stringify({ properties: { signals: { properties: { act: { properties: { action: { enum: actionNames } } } } } } }))
  const jobLines = Array.from({ length: lanes }, (_, i) => `  job_${i}:`).join('\n')
  write('.github/workflows/ci.yml', `name: CI\non:\n  push:\njobs:\n${jobLines}\n  last: true\n`)
  write('install.sh', `GLASSPANE_RELEASE="v${tag}"\n`)
  write('package.json', JSON.stringify({ version }))
  if (readme) write('README.md', readme)
  if (readmeZh) write('README.zh-CN.md', readmeZh)
  const secTable = `| ${line}.x | ✅ current release line; security fixes ship here |\n`
  const secTableZh = `| ${line}.x | ✅ 当前版本线，安全修复在此发布 |\n`
  write('SECURITY.md', secTable)
  write('SECURITY.zh-CN.md', secTableZh)
  return root
}

test('check-doc-links: 文档写的归因默认值与引擎不符 → 具名红（本轮 README 写 weak、代码给 soft 的形状）', () => {
  const root = claimRoot({
    readme: '- **Attribution** — `weak` by default; `strong` when the probe confirms.\n',
    readmeZh: '- **归因** —— 默认 `weak`。\n',
    attribution: 'soft',
  })
  const problems = claimDrift({ docs: ['README.md', 'README.zh-CN.md'], rootDir: root })
  assert.equal(problems.length, 2, JSON.stringify(problems))
  assert.match(problems[0], /README\.md: 「归因默认值」写了 weak（归因默认等级），真源是 soft/)
  assert.match(problems[1], /README\.zh-CN\.md: 「归因默认值」写了 weak/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('check-doc-links: 只改一种语言的那一句 → 双语漂移具名红（从前这种编辑是绿的）', () => {
  // 英文侧改对了（soft = 真源），中文侧还写着 weak。真源核对只报中文那一行；
  // 双语核对把两侧的差异单独点名，逼着改动落回两份。
  const root = claimRoot({
    readme: '- **Attribution** — `soft` by default.\n',
    readmeZh: '- **归因** —— 默认 `weak`。\n',
    attribution: 'soft',
  })
  const problems = claimDrift({ docs: ['README.md', 'README.zh-CN.md'], rootDir: root })
  const parity = problems.filter((p) => p.startsWith('双语漂移「归因默认值」'))
  assert.equal(parity.length, 1, JSON.stringify(problems))
  assert.match(parity[0], /README\.md 写 soft，README\.zh-CN\.md 写 weak/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('check-doc-links: 通道数与工具数按真源核对（ci.yml 的 job 数、tools.ts 的条数）', () => {
  const root = claimRoot({
    readme: 'Two equivalent forms: ci.yml (7 lanes), and 15 MCP tools over stdio.\n',
    readmeZh: 'ci.yml（7 条 lane），另有 15 个 MCP 工具。\n',
    lanes: 9,
    toolCount: 16,
  })
  const problems = claimDrift({ docs: ['README.md', 'README.zh-CN.md'], rootDir: root })
  // 逐条主张先按登记表顺序（工具数在通道数之前）、再按文档顺序报，报文要一模一样可核对。
  assert.deepEqual(problems, [
    'README.md: 「对外工具数」写了 15（个工具），真源是 16 —— 原句 "15 MCP tools"',
    'README.zh-CN.md: 「对外工具数」写了 15（个工具），真源是 16 —— 原句 "15 个 MCP 工具"',
    'README.md: 「CI 通道数」写了 7（条 CI 通道），真源是 9 —— 原句 "7 lanes"',
    'README.zh-CN.md: 「CI 通道数」写了 7（条 CI 通道），真源是 9 —— 原句 "7 条 lane"',
  ], JSON.stringify(problems))
  fs.rmSync(root, { recursive: true, force: true })
})

test('check-doc-links: 拼写的数字也算主张（"Seven accessibility verbs" 那条盲区）', () => {
  const root = claimRoot({
    readme: '- **Seven accessibility verbs, not arbitrary input.** `gp_act` performs one of the 7 accessibility actions.\n',
    actions: 6,
  })
  const problems = claimDrift({ docs: ['README.md'], rootDir: root })
  assert.equal(problems.length, 2, JSON.stringify(problems))
  assert.match(problems[0], /「无障碍动作数」写了 7.*真源是 6 —— 原句 "Seven accessibility verbs"/)
  assert.match(problems[1], /原句 "7 accessibility actions"/)
  // 对照：真源也确实是 7 个动作时，拼写的与阿拉伯的两种写法都不报。
  const ok = claimRoot({ readme: '- Seven accessibility verbs, and the 7 accessibility actions.\n', actions: 7 })
  assert.deepEqual(claimDrift({ docs: ['README.md'], rootDir: ok }), [])
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(ok, { recursive: true, force: true })
})

test('check-doc-links: README 钉的 tag 与 install.sh 不一致 → 红；版本线不一致 → 红', () => {
  const tagRoot = claimRoot({ readme: 'git clone --branch v1.11.0 https://example.com/x.git\n', tag: '1.14.1' })
  const tagProblems = claimDrift({ docs: ['README.md'], rootDir: tagRoot })
  assert.equal(tagProblems.length, 1, JSON.stringify(tagProblems))
  assert.match(tagProblems[0], /「README 钉住的发布 tag」写了 1\.11\.0（钉住的 tag），真源是 1\.14\.1/)

  const lineRoot = claimRoot({ line: '1.1', version: '1.14.1' })
  const lineProblems = claimDrift({ docs: ['SECURITY.md', 'SECURITY.zh-CN.md'], rootDir: lineRoot })
  assert.equal(lineProblems.length, 2, JSON.stringify(lineProblems))
  assert.match(lineProblems[0], /SECURITY\.md: 「当前版本线」写了 1\.1（当前版本线），真源是 1\.14/)
  fs.rmSync(tagRoot, { recursive: true, force: true })
  fs.rmSync(lineRoot, { recursive: true, force: true })
})

test('check-doc-links: 真源读不到时不许静默放行（有主张却没人核对＝一条待办的洞）', () => {
  const root = claimRoot({ readme: 'ci.yml (9 lanes)\n' })
  fs.rmSync(path.join(root, '.github', 'workflows', 'ci.yml'))
  const problems = claimDrift({ docs: ['README.md'], rootDir: root })
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /「CI 通道数」.*真源读不到/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('check-doc-links: 真仓库现在每一条主张判据都是绿的（且判据确实认得到那些句子）', () => {
  assert.deepEqual(claimDrift(), [], 'main 上的可复算主张不该红')
  assert.deepEqual(check().problems, [], 'main 上的文档闸（死链/锚点/双语/主张）不该红')
  assert.ok(CLAIMS.length >= 6, '主张登记表被删空了——判据退化回只查文件存在性')
})

/* ------------------------------------------------------------------ shell 残渣闸（2026-10-16 本轮中招两次） */

/** 只放一份 `x.md` 的临时根：残渣判据的两条形状都靠它喂，不动仓库里的真文档。 */
function residueRoot(text) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-residue-'))
  fs.writeFileSync(path.join(root, 'x.md'), text)
  return root
}

test('shell 残渣闸：本轮真漏进正文的那两行必须被点名', () => {
  const root = residueRoot([
    '正文一句话。',
    "EOF",
    'echo "appended: $(wc -l < /Volumes/Eng-Dev/.worktrees/gp-daily-main-20261015/engine/smoke.md) lines total"',
    '',
  ].join('\n'))
  const problems = shellResidue({ rootDir: root, docs: ['x.md'] })
  assert.equal(problems.length, 2, JSON.stringify(problems))
  assert.match(problems[0], /x\.md:2.*heredoc 结束标记/)
  assert.match(problems[1], /x\.md:3.*裸露的 shell 命令行/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('shell 残渣闸：围栏里的 shell 记录不算残渣（那是文档的正常内容）', () => {
  const root = residueRoot([
    '跑这一串：',
    '```bash',
    'cat >> engine/smoke.md <<EOF',
    'wc -l engine/smoke.md',
    'EOF',
    '```',
    '正文继续。',
    '',
  ].join('\n'))
  assert.deepEqual(shellResidue({ rootDir: root, docs: ['x.md'] }), [],
    '把围栏也扫进去是一道永远误红的闸，最后一定会被放宽')
  fs.rmSync(root, { recursive: true, force: true })
})

test('shell 残渣闸：以命令词开头的中文人话不算残渣（两处真句子，其中一处是本轮自己写的）', () => {
  // 两行都是本仓文档里**真实存在**的句子，都以小写命令词开头：
  //   · `grep 会把这种管道输入当"二进制"而停止匹配。`——这道闸的第一版把它判成了残渣
  //     （harness/glasspane-harness/SYNCLOG.md:684，一条新闸首次运行就误红别人的文档）。第一版的
  //     错处是"行里任意位置有引号就算命令"；现在引号必须紧跟命令词，这一行因此靠**锚定**豁免。
  //   · `tar -tzf 复点：665 条，…`——本轮我自己写进 `engine/smoke.md` 的读数行，`tar` 后面真的是
  //     `-`，锚定帮不上忙，它靠的是"整行不含汉字"这一半。
  // 实测：去掉 HAN 那一半，这一条用例红（tar 那行被点名）；去掉引号锚定，另有用例红。
  // 也就是说两句各管一种豁免，缺哪个判据都有名字会响。
  const root = residueRoot([
    'grep 会把这种管道输入当"二进制"而停止匹配。',
    'tar -tzf 复点：665 条，(^|/)harness/ 命中 **0** 条。',
    '',
  ].join('\n'))
  assert.deepEqual(shellResidue({ rootDir: root, docs: ['x.md'] }), [],
    '"整行不含汉字"这一半判据的存在理由：命令词后面接中文不是命令')
  fs.rmSync(root, { recursive: true, force: true })
})

test('shell 残渣闸：wc -l <路径> 这种没有引号也没有 $() 的行照样抓到', () => {
  const root = residueRoot('wc -l /Volumes/Eng-Dev/GlassPane/engine/smoke.md\n')
  const problems = shellResidue({ rootDir: root, docs: ['x.md'] })
  assert.equal(problems.length, 1, JSON.stringify(problems))
  fs.rmSync(root, { recursive: true, force: true })
})

test('shell 残渣闸：接在主检查里，不是只住在一个可选函数里', () => {
  const root = residueRoot('EOF\n')
  const { problems } = check({ rootDir: root, docs: ['x.md'] })
  assert.ok(problems.some((p) => /heredoc 结束标记/.test(p)), JSON.stringify(problems))
  assert.deepEqual(shellResidue(), [], 'main 上的文档此刻不该有残渣')
})

/**
 * The self-execution guard must survive being handed a **symlink** (2026-10-19).
 *
 * Node loads an ESM entry by its real path, so through a link `process.argv[1]` (the link) and
 * `fileURLToPath(import.meta.url)` (the target) are different strings, the guard is false, and the
 * script exits **0 having printed nothing** — the silent-same-shape case: the CI step that runs this
 * gate would pass while never asking the question. Measured on this machine: direct → the two summary
 * lines; through `/var/tmp/.../cdl-link.mjs` → zero bytes, rc 0. The three npm/launchd-delivered
 * entrypoints here already realpath both sides (`installer/cli.js`, `updater/cli.js`,
 * `updater/agent-entry.js`); this guard is the same shape and had the same hole.
 */
test('通过符号链接调用这道文档闸时，它照样把结论打出来', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-cdlinks-link-'))
  const link = path.join(base, 'cdl-link.mjs')
  try {
    fs.symlinkSync(path.join(REPO, 'scripts', 'check-doc-links.mjs'), link)
    const direct = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-doc-links.mjs')], { encoding: 'utf8', cwd: REPO })
    const through = spawnSync(process.execPath, [link], { encoding: 'utf8', cwd: REPO })
    const out = `${through.stdout ?? ''}${through.stderr ?? ''}`
    assert.ok(out.trim() !== '', `符号链接调用这道闸一段沉默（rc=${through.status}），它什么都没检查就退场：stdout=${JSON.stringify(through.stdout)} stderr=${JSON.stringify(through.stderr)}`)
    assert.equal(through.status, direct.status, `通过链接与直接调用的判定必须一样：链接=${through.status} 直接=${direct.status}`)
    assert.match(out, /文档 \d+ 份/, out)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
