/**
 * Guard for `scripts/check-workflows.mjs` rule 2b — "every `npm run <name>` a step
 * references must be a script that exists".
 *
 * This file exists because that rule was quietly checking *half* of what it claimed.
 * `RUN_SCRIPT` carries the `g` flag and lives at module scope, so `exec()` advances
 * `lastIndex` across calls; taking a single `exec()` per line therefore consumed one
 * match for the whole file and returned `null` on the alternating lines after it.
 * Measured directly: over
 * `["npm run build", "npm run bundle --workspace glasspane-mcp",`
 * ` "npm run test --if-present", "npm run build"]`
 * the four single-exec calls answered `["build", null, "test", null]`. Every other
 * `npm run` reference went unchecked — including `npm run bundle` at ci.yml:86 and
 * release.yml:92, so renaming that script kept the guard green while the release
 * build died. The sibling `READ_LITERAL` reset its `lastIndex`; this one did not.
 *
 * The workspace half is the second reason: once scanning reaches every match on a
 * line, `npm run bundle --workspace glasspane-mcp` (release.yml:92, run from the
 * repository root, where `bundle` does not exist) becomes visible — and asserting it
 * against the *root* manifest reports a defect CI runs green. Resolving the selector
 * is what makes the newly-reached reference checkable rather than merely reached.
 *
 * REVERSE MUTATION: replace the `while ((hit = RUN_SCRIPT.exec(ref.text)) !== null)`
 * loop with the old single `if ((hit = RUN_SCRIPT.exec(ref.text)) !== null)` —
 * `a second npm run reference on a later line is still checked` goes red, and
 * `node scripts/check-workflows.mjs --self-test` reports its 6th case as NOT caught.
 * Delete the `--workspace` branch of `scriptOwners` and
 * `a --workspace selector is resolved, not asserted against the root manifest` goes
 * red. Widen the `--if-present` tolerance to a plain absence and
 * `--if-present is tolerated, exactly as npm tolerates it` goes red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'check-workflows.mjs')

/**
 * A throwaway repository with its own copy of the script, so the assertions run
 * against a tree this test owns and never against the real workflows.
 */
function makeWorkflowTree({ rootScripts, workspaceScripts = {}, workspaces = ['ws'], extraFiles = {} } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-check-workflows-'))
  const write = (rel, body) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  write('scripts/check-workflows.mjs', fs.readFileSync(SCRIPT, 'utf8'))
  write(
    'package.json',
    `${JSON.stringify({ name: 'root', version: '1.0.0', workspaces, scripts: rootScripts }, null, 2)}\n`,
  )
  write(
    'ws/package.json',
    `${JSON.stringify({ name: 'gpws', version: '1.0.0', scripts: workspaceScripts }, null, 2)}\n`,
  )
  for (const [rel, body] of Object.entries(extraFiles)) write(rel, body)
  return { root, write }
}

// 夹具与真 workflow 同形：顶层必须声明 permissions——闸本身现在就要求这一点，
// 夹具不带它就会在每个用例里先红一条与断言无关的问题（那等于测试在自己的桩里翻车）。
const HEADER = `name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  build:
    name: build the thing
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`

/** Run the copied script against a synthetic ci.yml. */
function run({ root }, body) {
  const workflows = path.join(root, '.github', 'workflows')
  fs.mkdirSync(workflows, { recursive: true })
  fs.writeFileSync(path.join(workflows, 'ci.yml'), body)
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-workflows.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

test('a second `npm run` reference on a later line is still checked (the shared-lastIndex defect)', () => {
  // `present` exists at the root, `absent` does not, and they are two lines of the
  // same step. The old single-exec-per-line shape answered the first and went blind
  // on the second; this asserts the blind half is checked.
  const tree = makeWorkflowTree({ rootScripts: { present: 'true' } })
  const checked = run(
    tree,
    `${HEADER}      - name: two commands
        run: |
          npm run present
          npm run absent
`,
  )
  try {
    assert.equal(checked.status, 1, checked.output)
    assert.match(checked.output, /no "absent" script/, checked.output)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('a `run` reference in a step block after an earlier one is checked per line', () => {
  // Three lines, three references, only the middle one is broken. A rule that scans
  // alternately reports zero or two of these; this counts the exact one.
  const tree = makeWorkflowTree({ rootScripts: { a: 'true', c: 'true' } })
  const checked = run(
    tree,
    `${HEADER}      - name: three commands
        run: |
          npm run a
          npm run b
          npm run c
`,
  )
  try {
    assert.equal(checked.status, 1, checked.output)
    assert.match(checked.output, /no "b" script/, checked.output)
    assert.doesNotMatch(checked.output, /no "a" script|no "c" script/, checked.output)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('a --workspace selector is resolved to that workspace, not asserted against the root manifest', () => {
  // This is release.yml:92's shape: run from the repository root, where `bundle`
  // genuinely does not exist, naming a workspace that does have it. If the selector
  // is ignored the guard reports a defect CI runs green.
  const tree = makeWorkflowTree({ rootScripts: { build: 'true' }, workspaceScripts: { bundle: 'true' } })
  const green = run(
    tree,
    `${HEADER}      - name: ordered build
        run: |
          npm ci --no-audit
          npm run build
          npm run bundle --workspace gpws
`,
  )
  fs.rmSync(tree.root, { recursive: true, force: true })
  assert.equal(green.status, 0, green.output)

  // Same workflow, workspace missing the script: red, and it names the workspace
  // manifest it resolved to — not the root one.
  const brokenTree = makeWorkflowTree({ rootScripts: { build: 'true' }, workspaceScripts: {} })
  const red = run(
    brokenTree,
    `${HEADER}      - name: ordered build
        run: |
          npm ci --no-audit
          npm run build
          npm run bundle --workspace gpws
`,
  )
  try {
    assert.equal(red.status, 1, red.output)
    assert.match(red.output, /ws\/package\.json has no "bundle" script/, red.output)
  } finally {
    fs.rmSync(brokenTree.root, { recursive: true, force: true })
  }
})

test('--if-present is tolerated, exactly as npm tolerates it', () => {
  // ci.yml:124 is `npm run test --workspaces --if-present` from a root whose script
  // exists but whose workspaces do not all carry it. npm's flag means "do not fail
  // when it is missing", so a guard that fails it is asserting a defect that cannot
  // happen. Remove the tolerance and this goes red.
  const tree = makeWorkflowTree({ rootScripts: { test: 'true' }, workspaceScripts: {} })
  const checked = run(
    tree,
    `${HEADER}      - name: every workspace
        run: npm run test --workspaces --if-present
`,
  )
  try {
    assert.equal(checked.status, 0, checked.output)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('a bare name is a package.json script and a name followed by a path is not', () => {
  // The semantics the fix had to preserve: `bun run script/publish.ts` addresses a
  // file, and the file-existence rule owns that. Asserting it as a script would make
  // `script` a phantom package.json requirement.
  const tree = makeWorkflowTree({
    rootScripts: {},
    extraFiles: { 'ws/script/publish.ts': 'export {}\n' },
  })
  const checked = run(
    tree,
    `${HEADER}      - name: publish dry run
        working-directory: ws
        run: bun run script/publish.ts --dry-run
`,
  )
  fs.rmSync(tree.root, { recursive: true, force: true })
  assert.equal(checked.status, 0, checked.output)
})

/**
 * The create-release step must *judge* the publish, not print it.
 *
 * `gh release edit … --draft=false --latest` exiting 0 is not evidence the release is
 * outward-facing: a release left in draft keeps /releases/latest serving the PREVIOUS tag,
 * and `updater/lib/check.js` maps "the newest published release is older" to
 * `up-to-date` + exit 0 — so one silent draft stops every machine in the fleet from updating
 * while this very workflow runs green. The sibling fork already asserts this
 * (harness/glasspane-harness/.github/workflows/release.yml, `publish-release`:
 * `if [ "$state" != "false" ]; then ::error …; exit 1`).
 *
 * REVERSE MUTATION: delete the three read-back guards from release.yml's create-release step
 * body (leave the printing `gh release view` alone) — this test goes red on
 * `读回 isDraft 之后没有一句 exit 1`。放宽成"只检查 draft 一项"红在 latest 与 assets 两条。
 */
test('release.yml 的建 Release 步把 draft/latest/资产读回来并逐项判红，不是只打印', () => {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')
  const lines = yml.split('\n')
  const from = lines.findIndex((l) => l.trim() === '- name: Create or update the release')
  assert.ok(from > -1, 'release.yml 里没有 "Create or update the release" 这一步——落点变了，测试得跟着改')
  const next = lines.findIndex((l, i) => i > from && (/^      - name: /.test(l) || /^ {0,4}\S/.test(l)))
  const body = lines.slice(from, next < 0 ? lines.length : next)
  const text = body.join('\n')

  const editAt = body.findIndex((l) => l.includes('--draft=false') && l.includes('--latest'))
  assert.ok(editAt > -1, '这一步没有把发布取消草稿并钉成 latest 的那条命令：' + text.slice(0, 200))
  const afterEdit = body.slice(editAt + 1).join('\n')
  for (const field of ['isDraft', 'latest', 'assets']) {
    assert.match(afterEdit, new RegExp(`--json[^\\n]*${field}|${field}`), `编辑之后没有读回 ${field}`)
  }
  assert.ok(/exit 1/.test(afterEdit),
    '建 Release 那一步在 --draft=false 之后没有任何 exit 1：它把 draft/latest/资产打印完就继续绿')

  // 三条判决各自要有一句 ::error:: 点名失败对象（光 `exit 1` 不说哪一项，读者只能去猜）。
  const guards = [
    { name: 'draft', want: /::error::[^\n]*(draft|草稿)[^\n]*\n[^\n]*exit 1|draft[^\n]*\n[^\n]*::error::/i },
    { name: 'latest', want: /::error::[^\n]*latest[^\n]*\n[^\n]*exit 1/i },
    { name: 'assets', want: /::error::[^\n]*(asset|资产)[^\n]*\n[^\n]*exit 1/i },
  ]
  for (const { name, want } of guards) {
    const normalized = text.replace(/\\\n/g, ' ').replace(/\s*\n\s*/g, '\n')
    assert.ok(want.test(normalized), `${name} 的读回失败时没有一句点名它的 ::error:: + exit 1`)
  }
  assert.ok((afterEdit.match(/exit 1/g) ?? []).length >= 3,
    `读回之后的 exit 1 只有 ${(afterEdit.match(/exit 1/g) ?? []).length} 处，三件事（draft / latest / 非空资产）判不齐`)
})

test('check-workflows --self-test 的每一档都被证红过，报出的数就是它真的跑过的数', () => {
  // The self-test exists to prove each rule can go red; the count in its output line
  // 是 CI 读的那一行。原来这里钉死 "9 case(s)"——harness 那条线 2026-10-16 加了两档
  // （bare-SHA 的 `uses:`、缺 script 的那条）之后，这一条红在**计数**上而不是红在
  // "有案子被悄悄丢掉"上，那是另一种假绿：判据盯的是一个会随正常改动漂移的整数。
  // 现在盯关系：报出的数 == 真打出来的 `ok self-test:` 行数，且不少于已知的下限。
  const checked = spawnSync(process.execPath, [SCRIPT, '--self-test'], { cwd: REPO, encoding: 'utf8' })
  const output = `${checked.stdout}${checked.stderr}`
  assert.equal(checked.status, 0, output)
  const reported = /--self-test: (\d+) case\(s\) each verified to fail/.exec(output)
  assert.ok(reported, `self-test 没有报出它验证了几档：${output}`)
  const lines = (output.match(/^\s*ok self-test:/gm) ?? []).length
  assert.equal(Number(reported[1]), lines,
    `报出 ${reported[1]} 档却只打了 ${lines} 行 ok self-test：有一档没被验证就被算进数里`)
  assert.ok(Number(reported[1]) >= 9,
    `self-test 掉到 ${reported[1]} 档（已知至少 9 档）：某一档被从表里删掉了`)
  // 新增的那一档：顶层 permissions 缺失必须能被证红（这条规则的来路见 f12b241）。
  assert.match(output, /no top-level permissions block is caught/, output)
  assert.match(output, /shared-lastIndex defect\) is caught/, output)
  // The two halves of the same lesson, added when `release.yml`'s npm-publish job turned out
  // to have narrowed its own token to nothing: a job-level `permissions:` block replaces the
  // workflow-level one, and an `environment:` job running a retaggable action ref is arbitrary
  // code holding the signing key. Both must be provable red, not just written down.
  assert.match(output, /job-level permissions block that silently drops contents is caught/, output)
  assert.match(output, /environment job running a mutable action tag is caught/, output)
})
