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

const HEADER = `name: CI
on:
  push:
    branches: [main]
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

test('check-workflows --self-test verifies six cases, including the lastIndex one', () => {
  // The self-test exists to prove each rule can go red; the count in its output line
  // is what CI reads. A case silently dropped from the list would still exit 0.
  const checked = spawnSync(process.execPath, [SCRIPT, '--self-test'], { cwd: REPO, encoding: 'utf8' })
  const output = `${checked.stdout}${checked.stderr}`
  assert.equal(checked.status, 0, output)
  assert.match(output, /--self-test: 6 case\(s\) each verified to fail/, output)
  assert.match(output, /shared-lastIndex defect\) is caught/, output)
})
