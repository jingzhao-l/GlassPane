/**
 * qoder-20261024-version-corpus.test.mjs — `scripts/` 这一层的两条缺陷（D2 + C12），HEAD 61153ffd。
 *
 * D2 `scripts/check-kernel-corpus.mjs` 的"对照已安装包"那条腿。它从前只探
 * `harness/glasspane-harness/node_modules`，而跑这条闸的那一条 CI job（`install-gate`）做的是
 * **仓库根**的 `npm ci`：根 lock 里明写着 `packages["node_modules/iterate-kernel"].version = 0.1.9`
 * (= pin 同号)，CI 一定有、脚本从来不看。于是那条腿在 CI 上必然打"未观测"并 exit 0——一条永远
 * 不出声的绿闸；而即使找到了，版本不符也只是 console.log。现在根 `node_modules/iterate-kernel`
 * 是第一候选，且：一份都没装 = 2，装了但不同号 = 1，同号了还要**逐文件** sha256 对 pin 核，
 * 不一致就点名哪个文件（1）。逃生口 `GLASSPANE_KERNEL_CORPUS_ALLOW_SKIP=1` 只豁免"本机没有可比
 * 的东西"，永远不豁免对不上的字节，且写进 `--help`。
 *
 * C12 `scripts/set-version.mjs` 允许 prerelease，而更新器只认三段。`version-sites.mjs` 的
 * `SEMVER_RE` 带一条可选的 `-prerelease` 尾巴，`updater/lib/version.js` 的 `TAG_RE` 与
 * `updater/lib/selfcheck.js` 的 `requirePlainVersion`、`scripts/assert-tag-ready.mjs` 的
 * `tagShapeOk` 都不带。用 prerelease 取号会把 15 个位点写满、让所有闸全绿，而按它打的 tag 会让
 * 每台装了 updater 的机器永久 `tag-unparseable`。现在取号那一步在读位点之前就拒。
 *
 * REVERSE MUTATIONS（每条点名它红在什么地方）：
 *   · 把候选表改回"只有 harness 产品那两位" → `CI 的形状…第一候选` 红（根那份读不到 → 退 2）。
 *   · 把"没装 = 红"改回 `console.log('未观测') + 落到 exit 0` → `一份都没装必须红` 红。
 *   · 把开关的默认值反过来（不设也放行）→ 同一条红；把开关能豁免的范围放大到字节分歧 →
 *     `开关不豁免对不上的字节` 红。
 *   · 把版本不符那格改回只 console.log → `装了但不是 pin 那一版` 红。
 *   · 删掉逐文件比对 → `逐文件点名` 红；把候选选择改成"第一份存在的就用" →
 *     `同号那份才算数` 红；把 --help 里的开关名删掉 → `usage 说清开关` 红。
 *   · 去掉 prerelease 那一拒 → `prerelease 在取号就被拒` 与 `判据只有一份` 同时红；
 *     把这一拒放宽成"什么号都拒"（例如写死 fail）→ `三段号照旧走得通` 红；
 *     把判据换成第二条正则而形状抄错 → `逐样本对齐 tagShapeOk` 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SITES } from '../../scripts/version-sites.mjs'
import { tagShapeOk } from '../../scripts/assert-tag-ready.mjs'
import { PLAIN_SEMVER_RE, TAG_RE, parseTag } from '../../updater/lib/version.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const CORPUS_SCRIPT = path.join(REPO, 'scripts', 'check-kernel-corpus.mjs')
const SET_VERSION_SCRIPT = path.join(REPO, 'scripts', 'set-version.mjs')
const ALLOW_SKIP_ENV = 'GLASSPANE_KERNEL_CORPUS_ALLOW_SKIP'

/** The three dirs the gate probes, in the order it must probe them. */
const ROOT_CAND = 'node_modules/iterate-kernel'
const PRODUCT_CAND = 'harness/glasspane-harness/node_modules/iterate-kernel'
const OPENCODE_CAND = 'harness/glasspane-harness/packages/opencode/node_modules/iterate-kernel'

const PIN_VERSION = '0.1.9'
/** The published corpus, as the pin records it. Two files are enough to make "点名哪个文件" speak. */
const CANONICAL = {
  'fixtures/a.json': '{"a":1}\n',
  'schemas/b.json': '{"b":2}\n',
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function scratchDir(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix))
}

/**
 * A synthetic repository for `check-kernel-corpus.mjs`: a pin, the mirror under `kernel/`, a
 * `mcp-shell` manifest declaring the pinned version, and whichever install dirs the case names.
 * The script resolves its own root from `scripts/../`, so copying it in is all the injection needed.
 */
function makeCorpusTree({ pinVersion = PIN_VERSION, installs = [], mirror = {}, mcpShell = pinVersion } = {}) {
  const root = scratchDir('gp-kernel-corpus-')
  const write = (rel, body) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  write('scripts/check-kernel-corpus.mjs', fs.readFileSync(CORPUS_SCRIPT, 'utf8'))
  const corpus = Object.entries(CANONICAL).map(([file, body]) => ({ file, sha256: sha256(body) }))
  write('harness/glasspane-harness/contracts/kernel-pin.json', `${JSON.stringify({ version: pinVersion, corpus }, null, 2)}\n`)
  for (const [file, body] of Object.entries({ ...CANONICAL, ...mirror })) write(`kernel/${file}`, body)
  write('mcp-shell/package.json', `${JSON.stringify({ name: 'glasspane-mcp', version: '1.0.0', devDependencies: { 'iterate-kernel': mcpShell } }, null, 2)}\n`)
  for (const install of installs) {
    write(`${install.dir}/package.json`, `${JSON.stringify({ name: 'iterate-kernel', version: install.version }, null, 2)}\n`)
    for (const [file, body] of Object.entries({ ...CANONICAL, ...(install.files ?? {}) })) write(`${install.dir}/${file}`, body)
  }
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
  return { root, write, read, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function runCorpus({ root }, args = [], env = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-kernel-corpus.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('CI 的形状：仓库根 node_modules/iterate-kernel 是第一候选，那条腿真的被逐文件核过', () => {
  // This is the shape `.github/workflows/ci.yml`'s install-gate produces: `npm ci` at the root,
  // no bun install in the harness product. The old probe looked at neither and printed 未观测 + exit 0.
  const tree = makeCorpusTree({ installs: [{ dir: ROOT_CAND, version: PIN_VERSION }] })
  try {
    const run = runCorpus(tree)
    assert.equal(run.status, 0, run.out)
    assert.match(run.stdout, /逐文件核过 2 份/, `同号也必须真比字节，不比就等于没比：${run.out}`)
    assert.match(run.stdout, new RegExp(ROOT_CAND.replace(/[/]/g, '\\/')), `要报出读的是哪一份：${run.out}`)
    assert.doesNotMatch(run.out, /未观测/, '一条没测的腿不许被写成"未观测"然后放行')
    assert.doesNotMatch(run.out, /SKIP/, '有可比的东西时不该出现跳过话术')
  } finally {
    tree.cleanup()
  }
})

test('一份都没装 = 红（exit 2），不再是"未观测"加 exit 0', () => {
  const tree = makeCorpusTree({ installs: [] })
  try {
    const run = runCorpus(tree)
    assert.equal(run.status, 2, `没装东西是"没测到"，不是"通过"。实到 ${run.status}：${run.out}`)
    assert.match(run.stderr, /GLASSPANE_KERNEL_CORPUS_ALLOW_SKIP/, '红话要说清唯一的逃生口叫什么：' + run.stderr)
    assert.match(run.stderr, /npm ci/, 'remedy 要给出现在就能执行的那一条：' + run.stderr)
    assert.match(run.stderr, /node_modules\/iterate-kernel/, '要说出该去哪儿装：' + run.stderr)
  } finally {
    tree.cleanup()
  }
})

test(`开关 ${ALLOW_SKIP_ENV}=1 才放行，而且它只豁免"没有可比的东西"`, () => {
  const bare = makeCorpusTree({ installs: [] })
  try {
    const run = runCorpus(bare, [], { [ALLOW_SKIP_ENV]: '1' })
    assert.equal(run.status, 0, run.out)
    assert.match(run.stdout, new RegExp(`SKIP（${ALLOW_SKIP_ENV}=1`), '跳过要说自己是显式要求的：' + run.stdout)
    assert.match(run.stdout, /CI 里设它等于把这条闸关掉/, '开关的后果要说出来：' + run.stdout)
  } finally {
    bare.cleanup()
  }
  // 对照：同版本的包里一个文件被换过 → 开关不能救它（否则这条腿又能被盖成绿色基线）。
  const tampered = makeCorpusTree({ installs: [{ dir: ROOT_CAND, version: PIN_VERSION, files: { 'fixtures/a.json': '{"a":999}\n' } }] })
  try {
    const run = runCorpus(tampered, [], { [ALLOW_SKIP_ENV]: '1' })
    assert.equal(run.status, 1, `对不上的字节被开关放行了：${run.out}`)
    assert.match(run.stderr, /fixtures\/a\.json/, '红话要点名是哪个文件：' + run.stderr)
  } finally {
    tampered.cleanup()
  }
})

test('装了但不是 pin 那一版 = 分歧（红 1，且报出两边的版本号）', () => {
  const tree = makeCorpusTree({ installs: [{ dir: ROOT_CAND, version: '0.2.0' }] })
  try {
    const run = runCorpus(tree)
    assert.equal(run.status, 1, `安装态落后/超前于 pin 是一句分歧，不是一行 console.log：${run.out}`)
    assert.match(run.stderr, /0\.2\.0/, '要报出读到的是哪一版：' + run.stderr)
    assert.match(run.stderr, /0\.1\.9/, '要报出 pin 记的是哪一版：' + run.stderr)
    // 开关不冒充这条分歧的解药：它在这里同样拒（这条机器的说法是"装了别的版本"，不是"没装"）。
    const skipped = runCorpus(tree, [], { [ALLOW_SKIP_ENV]: '1' })
    assert.equal(skipped.status, 0, `显式要求跳过时它得真的跳过并自报：${skipped.out}`)
    assert.match(skipped.stdout, /SKIP/, skipped.stdout)
  } finally {
    tree.cleanup()
  }
})

test('候选里的选择判据是"与 pin 同号"，不是"第一个存在的目录"', () => {
  // 根装的是旧版（一台没跑 npm ci 的维护机），harness 产品里那一份才是 pin 记的字节。
  const tree = makeCorpusTree({
    installs: [
      { dir: ROOT_CAND, version: '0.1.8' },
      { dir: PRODUCT_CAND, version: PIN_VERSION },
    ],
  })
  try {
    const run = runCorpus(tree)
    assert.equal(run.status, 0, `同号的那份被跳过了：${run.out}`)
    assert.match(run.stdout, new RegExp(PRODUCT_CAND.replace(/\//g, '\\/')), `要报出真正核的是哪一份：${run.stdout}`)
    assert.match(run.stdout, /逐文件核过 2 份/, run.stdout)
  } finally {
    tree.cleanup()
  }
  // 三个候选位都各自成立（bun 装在 opencode 包下的那位是老形状，不能因为加了根候选就丢掉）。
  const legacy = makeCorpusTree({ installs: [{ dir: OPENCODE_CAND, version: PIN_VERSION }] })
  try {
    const run = runCorpus(legacy)
    assert.equal(run.status, 0, run.out)
    assert.match(run.stdout, new RegExp(OPENCODE_CAND.replace(/\//g, '\\/')), run.stdout)
  } finally {
    legacy.cleanup()
  }
})

test('同号包里一个语料文件的字节不对 → 红并点名是哪个文件', () => {
  const tree = makeCorpusTree({ installs: [{ dir: ROOT_CAND, version: PIN_VERSION, files: { 'schemas/b.json': '{"b":999}\n' } }] })
  try {
    const run = runCorpus(tree)
    assert.equal(run.status, 1, `pin 记的字节与装到的字节不一致还是绿的话，这条腿就白加：${run.out}`)
    assert.match(run.stderr, /schemas\/b\.json/, `要点名文件：${run.stderr}`)
    assert.doesNotMatch(run.stderr, /fixtures\/a\.json/, '没坏的文件不该被一起报出来（报错了下次就没人信这条报文）')
  } finally {
    tree.cleanup()
  }
  // 同号包**少了**一个语料文件，同样是红并且点名（registry 发出来的包与 pin 不同一份契约）。
  const short = makeCorpusTree({ installs: [{ dir: ROOT_CAND, version: PIN_VERSION }] })
  try {
    fs.rmSync(path.join(short.root, ROOT_CAND, 'schemas', 'b.json'))
    const run = runCorpus(short)
    assert.equal(run.status, 1, run.out)
    assert.match(run.stderr, /schemas\/b\.json/, run.stderr)
    assert.match(run.stderr, /does not/, '要说清是"包里没有这个文件"而不是"哈希不同"：' + run.stderr)
  } finally {
    short.cleanup()
  }
})

test('--help 把三条腿、退出码和开关名说清，且没有 pin 也能答（不写盘）', () => {
  const root = scratchDir('gp-kernel-corpus-help-')
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.copyFileSync(CORPUS_SCRIPT, path.join(root, 'scripts', 'check-kernel-corpus.mjs'))
    for (const flag of ['--help', '-h']) {
      const run = runCorpus({ root }, [flag])
      assert.equal(run.status, 0, `${flag} 的 usage 不该被当成一次检查：${run.out}`)
      assert.match(run.stdout, new RegExp(ALLOW_SKIP_ENV), `${flag} 必须说出那个逃生口叫什么`)
      assert.match(run.stdout, /node_modules\/iterate-kernel/, `${flag} 要列出候选位：${run.stdout}`)
      assert.match(run.stdout, /2 = nothing installed|2 = cannot measure/, `${flag} 要说清退出码：${run.stdout}`)
    }
    assert.deepEqual(fs.readdirSync(root), ['scripts'], 'usage 一步不该写任何东西')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('--record 的取字节来源也跟着这条候选表（根那份同号的才算源）', () => {
  const tree = makeCorpusTree({
    installs: [{ dir: ROOT_CAND, version: PIN_VERSION }],
    mirror: { 'fixtures/a.json': '{"a":"two-weeks-old"}\n' },
  })
  try {
    const run = runCorpus(tree, ['--record'])
    assert.equal(run.status, 0, run.out)
    assert.equal(tree.read('kernel/fixtures/a.json'), CANONICAL['fixtures/a.json'], '陈旧镜像没有被刷新：' + run.out)
    assert.match(run.stdout, new RegExp(ROOT_CAND.replace(/\//g, '\\/')), `刷新要说出源在哪：${run.stdout}`)
    // 刷完再检查一次：那条"逐文件核过"的腿必须自己接得住自己的产物。
    const after = runCorpus(tree)
    assert.equal(after.status, 0, after.out)
  } finally {
    tree.cleanup()
  }
  const nothing = makeCorpusTree({ installs: [] })
  try {
    const run = runCorpus(nothing, ['--record'])
    assert.equal(run.status, 2, `没装包还想 record 就是把手上的字节洗成"应有的样子"：${run.out}`)
    assert.match(run.stderr, /npm ci/, run.stderr)
  } finally {
    nothing.cleanup()
  }
})

test('真树今天的状态：这条腿在真实仓库里是可测的，且它真的出声了', () => {
  // CI 的 install-gate 跑之前做的事就是 `npm ci`，根 lock 里明写着
  // `packages["node_modules/iterate-kernel"].version`，所以这条断言在两条会跑本套件（glasspane-update）
  // 的 job 上都成立。换机器的话先 `npm ci`——这条闸自己的 remedy 说的就是这句话。
  const lockEntry = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8')).packages?.[ROOT_CAND]
  assert.ok(lockEntry?.version, `根 lock 里没有 ${ROOT_CAND}：这条腿的第一候选不成立了，去看 lock 布局而不是放宽这条闸`)
  const run = spawnSync(process.execPath, [CORPUS_SCRIPT], { cwd: REPO, encoding: 'utf8' })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  assert.match(run.stdout, /逐文件核过 \d+ 份/, `真树上这条腿又变成不出声的了：${run.stdout}`)
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /未观测|SKIP/, run.stdout)
  assert.ok(run.stdout.includes(lockEntry.version), `报文里该出现装到的那一版（${lockEntry.version}）：${run.stdout}`)
})

// ---- C12 -------------------------------------------------------------------
/** The declared sites spelled for a scratch tree (shapes copied from production, not invented). */
const SITE_TEMPLATES = {
  'package.json': (v) => `${JSON.stringify({ name: 'glasspane', version: v, private: true }, null, 2)}\n`,
  'mcp-shell/package.json': (v) => `${JSON.stringify({ name: 'glasspane-mcp', version: v }, null, 2)}\n`,
  'installer/package.json': (v) => `${JSON.stringify({ name: 'glasspane-install', version: v }, null, 2)}\n`,
  'updater/package.json': (v) => `${JSON.stringify({ name: 'glasspane-update', version: v, private: true }, null, 2)}\n`,
  'mcp-shell/src/dispatch.ts': (v) => `export const SERVER_INFO = { name: "glasspane-mcp", version: "${v}" }\n`,
  'engine/Sources/GlassPaneEngine/EngineCore.swift': (v) => `public static let buildVersion = "${v}"\n    public let version = "${v}"\n`,
  'engine/scripts/make-app.sh': (v) => `#!/bin/sh\ncat <<XML\n<key>CFBundleShortVersionString</key>\n        <string>${v}</string>\n<key>CFBundleVersion</key>\n        <string>${v}</string>\nXML\n`,
  'install.sh': (v) => `#!/bin/sh\nGLASSPANE_RELEASE="v${v}"\n`,
  'installer/cli.js': (v) => `export const RELEASE_VERSION = '${v}'\n`,
  'README.md': (v) => `git clone --branch v${v} https://github.com/jingzhao-l/GlassPane.git && cd GlassPane\n`,
  'README.zh-CN.md': (v) => `git clone --branch v${v} https://github.com/jingzhao-l/GlassPane.git && cd GlassPane\n`,
  'SECURITY.md': (v) => `| ${v.split('.').slice(0, 2).join('.')}.x | ✅ current release line; security fixes ship here. |\n`,
  'SECURITY.zh-CN.md': (v) => `| ${v.split('.').slice(0, 2).join('.')}.x | ✅ 当前版本线，安全修复在此发布。|\n`,
}

/**
 * A scratch tree holding the scripts. `withSites: false` deliberately has **no site files at all**:
 * a version refused for its shape must never get as far as reading a site, and a tree with nothing to
 * read makes that visible (any run that proceeded would answer 位点异常 instead).
 */
function makeVersionScratch({ withSites = false, from = '1.0.0' } = {}) {
  const root = scratchDir('gp-set-version-shape-')
  const write = (rel, body) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  for (const name of ['set-version.mjs', 'version-sites.mjs', 'check-version.mjs']) {
    write(`scripts/${name}`, fs.readFileSync(path.join(REPO, 'scripts', name), 'utf8'))
  }
  if (withSites) {
    for (const [rel, template] of Object.entries(SITE_TEMPLATES)) write(rel, template(from))
    write('package-lock.json', `${JSON.stringify({ name: 'glasspane', version: from, lockfileVersion: 3, packages: { '': { version: from } } }, null, 2)}\n`)
  }
  return { root, write, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function runSetVersion({ root }, args) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'set-version.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    // No npm on PATH: a run that reaches the lock step would fail loudly, and a shape refusal must
    // never reach it anyway — the absence of the binary is itself the assertion.
    env: { ...process.env, PATH: path.join(root, 'bin') },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** "The run refused this version for its shape, before touching anything." */
const refusedByShape = (run) => /不是合法 semver|prerelease 尾巴/.test(run.out)

test('prerelease 在取号那一步就被拒，且拒在读位点之前——一个字节都没写', () => {
  for (const bad of ['1.21.0-beta.1', '1.21.0-alpha', '1.21.0-0', '1.2.3-rc.1.2+build.9', '2.0.0-next.20261024']) {
    const tree = makeVersionScratch()
    try {
      const run = runSetVersion(tree, [bad])
      assert.equal(run.status, 1, `${bad} 竟然过了：${run.out}`)
      assert.ok(refusedByShape(run), `${bad} 没被形状判据拒掉：${run.out}`)
      assert.doesNotMatch(run.out, /位点异常/, `拒之前就去读位点了：${bad} → ${run.out}`)
      assert.doesNotMatch(run.out, /位点改写完成/, `${bad} 真的开始写了：${run.out}`)
      assert.deepEqual(fs.readdirSync(tree.root), ['scripts'], '被拒的一趟不该写下任何位点文件')
    } finally {
      tree.cleanup()
    }
  }
})

test('拒的话要说清这是可解析性判据，并给出确切下一步', () => {
  const tree = makeVersionScratch()
  try {
    const run = runSetVersion(tree, ['1.21.0-beta.1'])
    assert.match(run.stderr, /tag-unparseable/, '要说清后果是更新器解不出 tag，不是"不喜欢这种写法"：' + run.stderr)
    assert.match(run.stderr, /updater\/lib\/version\.js/, '要点名是哪个读者只认三段：' + run.stderr)
    assert.match(run.stderr, /assert-tag-ready/, '打 tag 那一步的判据也要一起点名：' + run.stderr)
    assert.match(run.stderr, /三段/, '下一步要给的是确切的形状，不是一句"换个号"：' + run.stderr)
    assert.match(run.stderr, /set-version\.mjs 1\.21\.0/, `要把可直接粘贴的下一条命令打出来：${run.stderr}`)
    assert.match(run.stderr, new RegExp(`${SITES.length} 个位点`), '位点个数由 SITES 自己数出来，文案不写死数字：' + run.stderr)
  } finally {
    tree.cleanup()
  }
})

test('三段号照旧走得通——这一拒不是把取号整个关掉', () => {
  const tree = makeVersionScratch({ withSites: true })
  try {
    const run = runSetVersion(tree, ['1.21.0', '--no-lock'])
    assert.equal(run.status, 0, run.out)
    for (const rel of Object.keys(SITE_TEMPLATES)) {
      const want = SITES.find((site) => site.file === rel)?.line ? '1.21' : '1.21.0'
      assert.ok(tree.read(rel).includes(want), `${rel} 没写到 ${want}：${tree.read(rel)}`)
    }
    assert.match(run.stdout, /版本线已统一到 1\.21\.0/, run.stdout)
  } finally {
    tree.cleanup()
  }
  // 夹具完备性：位点表加了一格而这里没给模板，上面那条会红在"读不到"，这里先点名。
  const missing = [...new Set(SITES.map((s) => s.file))].filter((f) => !Object.hasOwn(SITE_TEMPLATES, f))
  assert.deepEqual(missing, [], `SITES 里有位点没有 scratch 模板：${missing.join(', ')}`)
})

test('三段判据只有一份：它对每个样本都等于 tagShapeOk，也等于更新器自己的 TAG_RE', () => {
  const samples = ['1.2.3', '10.20.30', '0.0.0', '1.21.0', '1.2', '1', '1.2.3.4', 'abc', 'v1.2.3',
    '1.2.3-beta.1', '1.2.3-alpha', '1.2.3-0', '1.2.3-', '1.2.3+build', '1.2.3_beta']
  const disagreements = []
  for (const sample of samples) {
    const tree = makeVersionScratch()
    try {
      const accepted = !refusedByShape(runSetVersion(tree, [sample]))
      if (accepted !== tagShapeOk(sample)) {
        disagreements.push(`${sample}: set-version 收下=${accepted}，assert-tag-ready 的 tagShapeOk=${tagShapeOk(sample)}`)
      }
      // 更新器解析 tag 的那条正则才是这条线的硬读者；这些样本上它与 tagShapeOk 同判
      // （两者的已知差别只在"前导零"，那一样本不在这里，归它自己的所有者）。
      const updaterOk = TAG_RE.test(`v${sample}`)
      if (accepted !== updaterOk) {
        disagreements.push(`${sample}: set-version 收下=${accepted}，updater 的 TAG_RE=${updaterOk}`)
      }
    } finally {
      tree.cleanup()
    }
  }
  assert.deepEqual(disagreements, [], `取号与发布闸对"三段号"的读法分叉了（分叉就是"取号全绿、发布后更新链停摆"）：\n  ${disagreements.join('\n  ')}`)
  // 反方向也要出声：样本表里若一条"被收下的 prerelease"都没有，上面那条对照就是空转。
  const acceptedSamples = samples.filter((s) => tagShapeOk(s))
  assert.ok(acceptedSamples.length >= 3 && acceptedSamples.length < samples.length,
    `样本表把两侧都覆盖到了吗：收下的是 ${JSON.stringify(acceptedSamples)}`)
})

test('后果不是文案编的：更新器今天就会把 v1.21.0-beta.1 判成 tag-unparseable', () => {
  assert.equal(PLAIN_SEMVER_RE.test('1.21.0-beta.1'), false, 'updater 的 plain 判据变了？那 C12 的前提要重写')
  assert.throws(() => parseTag('v1.21.0-beta.1'), (error) => {
    assert.equal(error.code, 'tag-unparseable', `prerelease tag 在更新器里不是这句话：${error.code} / ${error.message}`)
    return true
  })
  assert.equal(parseTag('v1.21.0').version, '1.21.0', '三段号在更新器里读得出来——这条拒没有误伤正常路径')
})

test('usage 说的是三段号，不是"随便一条 semver"', () => {
  const tree = makeVersionScratch()
  try {
    const run = runSetVersion(tree, ['--help'])
    assert.equal(run.status, 0, run.out)
    assert.match(run.stdout, /<X\.Y\.Z>/, `用法该给出被接受的形状：${run.stdout}`)
    assert.match(run.stdout, /prerelease/, '不写清 prerelease 会被拒，人就会在取号失败处再猜一次：' + run.stdout)
    const noArg = runSetVersion(tree, [])
    assert.equal(noArg.status, 1, '没有参数不是"打印完就算过"')
    assert.match(noArg.stdout, /<X\.Y\.Z>/, noArg.stdout)
  } finally {
    tree.cleanup()
  }
})
