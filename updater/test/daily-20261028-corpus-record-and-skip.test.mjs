/**
 * daily-20261028-corpus-record-and-skip.test.mjs — `scripts/check-kernel-corpus.mjs` 的两条缺陷
 * （D1 + D2），2026-10-28。
 *
 * D1 `--record` 的 prune 撞上一个非普通文件就炸。prune 那一圈对每个"没被 pin 点名"的条目跑
 * `rmSync(join(dir, name), { force: true })`，而 `force: true` 只吞 ENOENT：`kernel/fixtures/` 或
 * `kernel/schemas/` 下多一个**目录**就抛 `ERR_FS_EISDIR`——并且抛的那一刻，上面那圈 copy 已经写完了，
 * 于是留下"半份镜像 + 一句 stack trace"。修法是先探测、后写盘：prune 计划在任何一次写入之前算完，
 * 撞上非普通文件就点名路径与类型、拒掉且一个字节都不写。**不是**改成递归删——把 pin 从没描述过的一棵
 * 目录树悄悄抹掉，比拒掉更坏。
 *
 * D2 那条逃生口把"装了但不是 pin 那一版"也一起豁免了。`pinnedInstall === null` 在两种情形下都成立：
 * 一份安装都没有（`candidates.length === 0`），以及有安装但没一个带 pin 记的那一版；代码先判
 * `GLASSPANE_KERNEL_CORPUS_ALLOW_SKIP=1` 就在两种情形里都放行——而这份文件自己那条非跳过的分支把第二种
 * 情形叫做 "a stale install is a disagreement, not a skip"，文件头的注释也把开关限定在"本机没有可比的东西"。
 * 判据现在只看 `candidates.length === 0`：开关只在真的一份都没有时说话，装了别的版本照旧红 1，
 * 用的就是原来那句分歧的话。
 *
 * 夹具形状沿用 `updater/test/qoder-20261024-version-corpus.test.mjs` 的那一套（合成仓库 + 注入 pin +
 * 子进程驱动脚本），只在两处加了它没有的东西：镜像里多一个目录／符号链接，以及开关与陈旧安装的组合。
 *
 * REVERSE MUTATION（点名它红在什么地方；把 scripts/check-kernel-corpus.mjs 换回修之前的那一版即可全部复现）：
 *   · prune 圈换回 `rmSync(..., { force: true })` 而不先探测 ⇒ `撞上目录要拒` 红（返回 1 但带
 *     `ERR_FS_EISDIR` 的 stack trace，`fixtures/a.json` 已被写盘，目录还在）；
 *   · 探测放了但不写回 prune（或反过来对目录也递归删） ⇒ `普通文件的 prune 照旧` 与 `拒之前一个字节都不写`
 *     同时红；
 *   · 把 D2 的判据换回 `if (process.env[ALLOW_SKIP_ENV] === '1')` 打头 ⇒ `开关 + 陈旧安装 = 红` 红
 *     （退 0 并打印 SKIP）；把它整个反向到"开关也不放行零安装" ⇒ `开关 + 一份都没有 = 跳过` 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const CORPUS_SCRIPT = path.join(REPO, 'scripts', 'check-kernel-corpus.mjs')
const ALLOW_SKIP_ENV = 'GLASSPANE_KERNEL_CORPUS_ALLOW_SKIP'
const ROOT_CAND = 'node_modules/iterate-kernel'

const PIN_VERSION = '0.1.9'
const CANONICAL = {
  'fixtures/a.json': '{"a":1}\n',
  'schemas/b.json': '{"b":2}\n',
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/**
 * The SKIP *line*, not the substring: the remedy for a stale install quotes the switch's own name
 * (`…_ALLOW_SKIP=1 exists only for a machine with no install at all`), which is exactly the sentence
 * that must be there — so matching bare `SKIP` would call a correct refusal a skip.
 */
const SKIP_LINE = /installed-package leg: SKIP/

/**
 * The synthetic repository the sibling corpus test uses: a pin, the mirror under `kernel/`, a shell
 * manifest declaring the pinned version, and whichever install dirs the case names. The script
 * resolves its own root from `scripts/../`, so copying it in is all the injection needed — every
 * directory here is under `os.tmpdir()`, never under the real `kernel/`.
 */
function makeCorpusTree({ pinVersion = PIN_VERSION, installs = [], mirror = {}, mcpShell = pinVersion } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-kernel-corpus-daily-'))
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
  const exists = (rel) => fs.existsSync(path.join(root, rel))
  return { root, write, read, exists, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function runCorpus({ root }, args = [], env = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-kernel-corpus.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/* ------------------------------------------------------------------ *
 * D1 — --record 的 prune 撞上非普通文件
 * ------------------------------------------------------------------ */

test('D1 --record 碰上镜像里一个未 pin 的目录：拒、退非零、且一个字节都不写', () => {
  const tree = makeCorpusTree({
    installs: [{ dir: ROOT_CAND, version: PIN_VERSION }],
    // 一份陈旧的镜像：拒之前它不许被刷新，否则就是"写了一半再说谎"。
    mirror: { 'fixtures/a.json': '{"a":"two-weeks-old"}\n' },
  })
  try {
    fs.mkdirSync(path.join(tree.root, 'kernel/fixtures/stray-dir'), { recursive: true })
    fs.writeFileSync(path.join(tree.root, 'kernel/fixtures/stray-dir/inner.json'), '{"nested":true}\n')

    const run = runCorpus(tree, ['--record'])
    assert.notEqual(run.status, 0, `一个未 pin 的目录被安静地放过了：${run.out}`)
    assert.equal(run.status, 1, `镜像形状与 pin 对不上是分歧（与 check 模式同一格），实到 ${run.status}：${run.out}`)
    // 点名是哪个路径、是什么东西。
    assert.match(run.stderr, /fixtures\/stray-dir/, `拒的话要点名路径：${run.stderr}`)
    assert.match(run.stderr, /directory/, `要说清它是什么：${run.stderr}`)
    // 缺陷本体：不许是 stack trace，也不许是 ERR_FS_EISDIR 那种"读者自己猜"。
    assert.doesNotMatch(run.out, /ERR_FS_EISDIR/, `又把 errno 抛给了读者而不是答了一句：${run.out}`)
    assert.doesNotMatch(run.out, /at .*check-kernel-corpus\.mjs:\d+/, `一条拒该是一句话，不是一个栈：\n${run.out}`)
    // "detect first, then write" 的直接证据：陈旧的那份没被动。
    assert.equal(tree.read('kernel/fixtures/a.json'), '{"a":"two-weeks-old"}\n',
      '拒之前已经拷过盘了——这正是本条缺陷留下的半份镜像')
    assert.equal(tree.read('kernel/schemas/b.json'), CANONICAL['schemas/b.json'], '没坏的文件也不该被重写')
    // 不许递归删：那棵树不是这条命令的证据。
    assert.ok(tree.exists('kernel/fixtures/stray-dir/inner.json'), `把 pin 没描述过的目录删了：${run.stderr}`)
    assert.match(run.stderr, /--record refused|refused/i, `报文要说清这是一次拒绝：${run.stderr}`)
  } finally {
    tree.cleanup()
  }
})

test('D1 schemas 那一侧同样拒；符号链接也不是普通文件', () => {
  const tree = makeCorpusTree({ installs: [{ dir: ROOT_CAND, version: PIN_VERSION }] })
  try {
    fs.mkdirSync(path.join(tree.root, 'kernel/schemas/nested'), { recursive: true })
    // 一个指向包外字节的链接：pin 对它指向什么一无所知，所以剪掉它就是跟一次没读过的声明较劲。
    fs.symlinkSync(path.join(tree.root, ROOT_CAND, 'fixtures', 'a.json'), path.join(tree.root, 'kernel/schemas/link.json'))

    const run = runCorpus(tree, ['--record'])
    assert.notEqual(run.status, 0, run.out)
    assert.match(run.stderr, /schemas\/nested/, run.stderr)
    assert.match(run.stderr, /schemas\/link\.json/, run.stderr)
    assert.match(run.stderr, /symbolic link/, `符号链接要说清是哪一类：${run.stderr}`)
    assert.ok(tree.exists('kernel/schemas/link.json'), '链接本身要被留着，交给读者判断')
  } finally {
    tree.cleanup()
  }
})

test('D1 反方向：镜像里一个未 pin 的**普通文件**照旧被剪掉，record 成功', () => {
  // 这条是对"修好了但把功能关了"的防守：非普通文件才拒，文件照旧 prune（check 模式把多余文件判红）。
  const tree = makeCorpusTree({
    installs: [{ dir: ROOT_CAND, version: PIN_VERSION }],
    mirror: { 'fixtures/extra-not-pinned.json': '{"left":over"}\n', 'fixtures/a.json': '{"a":"old"}\n' },
  })
  try {
    const run = runCorpus(tree, ['--record'])
    assert.equal(run.status, 0, run.out)
    assert.equal(tree.read('kernel/fixtures/a.json'), CANONICAL['fixtures/a.json'], '陈旧镜像没被刷新：' + run.out)
    assert.ok(!tree.exists('kernel/fixtures/extra-not-pinned.json'), '未 pin 的文件该被剪掉')
    assert.match(run.stdout, /pruned 1 unpinned file\(s\): fixtures\/extra-not-pinned\.json/, run.stdout)
    const after = runCorpus(tree)
    assert.equal(after.status, 0, after.out)
  } finally {
    tree.cleanup()
  }
})

test('D1 干净镜像的 --record 不因为这套探测而多说一句、少写一笔', () => {
  const tree = makeCorpusTree({
    installs: [{ dir: ROOT_CAND, version: PIN_VERSION }],
    mirror: { 'fixtures/a.json': '{"a":"stale"}\n' },
  })
  try {
    const run = runCorpus(tree, ['--record'])
    assert.equal(run.status, 0, run.out)
    assert.match(run.stdout, /no unpinned extras to prune/, run.stdout)
    assert.doesNotMatch(run.out, /refused/, `没有异常却报拒绝：${run.out}`)
    assert.equal(tree.read('kernel/fixtures/a.json'), CANONICAL['fixtures/a.json'], run.out)
  } finally {
    tree.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * D2 — 开关不许豁免陈旧安装
 * ------------------------------------------------------------------ */

test('D2 半边一：开关 + 一份都没有 = SKIP，退 0 并自报', () => {
  const tree = makeCorpusTree({ installs: [] })
  try {
    const run = runCorpus(tree, [], { [ALLOW_SKIP_ENV]: '1' })
    assert.equal(run.status, 0, `本机没有可比的东西时开关该真的放行：${run.out}`)
    assert.match(run.stdout, new RegExp(`SKIP（${ALLOW_SKIP_ENV}=1`), run.stdout)
    assert.match(run.stdout, /CI 里设它等于把这条闸关掉/, run.stdout)
    assert.doesNotMatch(run.out, /is not the version the pin records/, '没有安装却报分歧，就是把话说不符：' + run.out)
  } finally {
    tree.cleanup()
  }
})

test('D2 半边二：开关 + 装了但不是 pin 那一版 = 红 1，用的就是原来那句分歧的话', () => {
  const tree = makeCorpusTree({ installs: [{ dir: ROOT_CAND, version: '0.2.0' }] })
  try {
    const without = runCorpus(tree)
    assert.equal(without.status, 1, `陈旧安装本来就是红：${without.out}`)
    assert.match(without.stderr, /is not the version the pin records/, without.stderr)

    const withFlag = runCorpus(tree, [], { [ALLOW_SKIP_ENV]: '1' })
    assert.equal(withFlag.status, 1, `开关豁免了一次测出来的分歧：${withFlag.out}`)
    // 必须是同一句分歧的话，不是被换成了别的拒词。
    assert.match(withFlag.stderr, /is not the version the pin records/, withFlag.stderr)
    assert.match(withFlag.stderr, /0\.2\.0/, '要报出读到的是哪一版：' + withFlag.stderr)
    assert.match(withFlag.stderr, /0\.1\.9/, '要报出 pin 记的是哪一版：' + withFlag.stderr)
    assert.match(withFlag.stderr, /a stale install is a disagreement, not a skip/, withFlag.stderr)
    assert.doesNotMatch(withFlag.out, SKIP_LINE, `陈旧安装被写成"跳过"就是把红洗成话术：${withFlag.out}`)
    // 三个候选位里任意一个装了别的版本都算分歧，不只是仓库根那一位。
    const legacy = makeCorpusTree({ installs: [{ dir: 'harness/glasspane-harness/node_modules/iterate-kernel', version: '0.2.0' }] })
    try {
      const legacyRun = runCorpus(legacy, [], { [ALLOW_SKIP_ENV]: '1' })
      assert.equal(legacyRun.status, 1, legacyRun.out)
      assert.doesNotMatch(legacyRun.out, SKIP_LINE, legacyRun.out)
    } finally {
      legacy.cleanup()
    }
  } finally {
    tree.cleanup()
  }
})

test('D2 开关也救不了半份安装：候选目录存在、里面是陈旧的那一版', () => {
  // 一台跑过 npm ci 后来又升过/降过的机器，形状就是"候选里读到了东西，但不是 pin 那一版"。
  const tree = makeCorpusTree({
    installs: [
      { dir: ROOT_CAND, version: '0.1.8' },
      { dir: 'harness/glasspane-harness/packages/opencode/node_modules/iterate-kernel', version: '0.2.0' },
    ],
  })
  try {
    const run = runCorpus(tree, [], { [ALLOW_SKIP_ENV]: '1' })
    assert.equal(run.status, 1, run.out)
    assert.match(run.stderr, /0\.1\.8/, run.stderr)
    assert.match(run.stderr, /0\.2\.0/, run.stderr)
    assert.doesNotMatch(run.out, SKIP_LINE, run.out)
  } finally {
    tree.cleanup()
  }
})

test('D2 --help 与文件头的说法和代码现在一致：开关不豁免陈旧安装', () => {
  const tree = makeCorpusTree({ installs: [{ dir: ROOT_CAND, version: '0.2.0' }] })
  try {
    const help = runCorpus(tree, ['--help'])
    assert.equal(help.status, 0, help.out)
    assert.match(help.stdout, new RegExp(ALLOW_SKIP_ENV), help.stdout)
    assert.match(help.stdout, /NO install|没有 install|no install/i, `usage 要说清它只豁免哪一种：${help.stdout}`)
    assert.match(help.stdout, /version|stale|different/i, 'usage 要说明装了别的版本不在豁免之列：' + help.stdout)
  } finally {
    tree.cleanup()
  }
})

// 2026-10-28 主代理补：泳道 C 点名未修的第三格——**pinned** 目标位本身是个目录。
// 上面那一族判据只管"未 pin 的多余项"，而拷贝循环里 `writeFileSync` 撞上同名目录时会以
// ERR_FS_EISDIR 死在中途：前面的条目已经写进去了，镜像就此半新半旧，而读者只看到一个栈。
test('D3 pinned 目标位是个目录：同样先探测后写入，拒时一个字节都不动', () => {
  const tree = makeCorpusTree({
    installs: [{ dir: ROOT_CAND, version: PIN_VERSION }],
    mirror: { 'fixtures/a.json': '{"a":"two-weeks-old"}\n' },
  })
  try {
    fs.rmSync(path.join(tree.root, 'kernel/fixtures/a.json'))
    fs.mkdirSync(path.join(tree.root, 'kernel/fixtures/a.json'), { recursive: true })

    const run = runCorpus(tree, ['--record'])
    assert.equal(run.status, 1, `pinned 目标位是个目录却被放过了：${run.out}`)
    assert.match(run.stderr, /fixtures\/a\.json/, `拒的话要点名是哪一条：${run.stderr}`)
    assert.match(run.stderr, /directory/, `要说清它是什么：${run.stderr}`)
    assert.doesNotMatch(run.out, /ERR_FS_EISDIR/, `errno 不该替一句话：${run.out}`)
    assert.doesNotMatch(run.out, /at .*check-kernel-corpus\.mjs:\d+/, `一条拒该是一句话不是一个栈：\n${run.out}`)
    // detect-then-write 的直接证据：另一条本来写得成的也没被写——半新半旧的镜像就是本缺陷。
    assert.equal(tree.read('kernel/schemas/b.json'), CANONICAL['schemas/b.json'],
      '这一条本来写得成，但它一起被拒才说明是"先探测后写入"')
    assert.ok(tree.exists('kernel/fixtures/a.json'), '不许顺手删掉一个本命令没描述过的东西')
  } finally {
    tree.cleanup()
  }
})
