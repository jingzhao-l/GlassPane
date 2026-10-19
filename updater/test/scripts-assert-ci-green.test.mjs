/**
 * `scripts/assert-ci-green.mjs`：发布前那一句"这个 commit 的 CI 到底绿没绿"。
 *
 * WHY（真事故，不是假想）。2026-10-16 的 `v1.16.1`：tag 切在 `4c58e9c`，Release 非草稿、四件
 * 资产齐、签名可验，registry 两个包都读得到 `1.16.1`——而**同一棵树的 CI 是红的**（run
 * 38842800885，`updater/lib/mcp.js` 那条 `write EPIPE`）。链子上没有任何一环问这个问题：
 * `check-version` 只证明这份检出内部一致（main 的 HEAD 同样满足它），
 * "Refuse to publish a tree no tag vouches for" 只证明 HEAD 就是 tag 指着的那棵树。发布提示词里
 * "push → 等 CI 绿 → tag → dry → publish"那句顺序，此前完全靠人自觉，而人这一次没自觉。
 *
 * 夹具形状：`fixtures/ci-runs-*.json` 是真 `gh api repos/…/actions/workflows/ci.yml/runs` 的
 * 响应体（红的那份就是 38842800885 本身）。"跑坏了"与"还没跑完"与"没记录"三种出路各自有
 * 一条断言，因为它们的补救动作不同；把后两种读成"通过"是这个闸最可能被绕过去的方式。
 *
 * REVERSE MUTATIONS：
 *   · 把 `judgeCiGreen` 里"没有任何运行记录"那一支改成返回 `ok: true` → `一个记录都没有时说的是
 *     没有证据` 红（这是最要紧的一条：空响应最容易长成绿）。
 *   · 把排序的键从 `created_at` 换成 `id` 或干脆不排 → 两条"重跑"断言里至少一条红（旧的红记录
 *     会永远钉住这一版，或者反过来：新的红被旧的红盖住）。
 *   · 删掉 `if (String(latest?.status ?? '') !== 'completed')` 那一支 → 预算那条 CLI 断言红：
 *     pending 会带着 `conclusion: null` 落进"结论不是 success"以外的路径。
 *   · 把文件末尾的自执行判据放宽成 `if (process.argv[1])`（被 import 时也照跑）→ 整个测试文件
 *     死于退出码 1：import 就把 CLI 跑起来了，那条隔离断言红（实测）。
 *   · 把 `positiveInt(budgetRaw)` 换回 `Number(budgetRaw)` → `写坏的时间参数是拒绝，不是无限等待`
 *     红（NaN 会一路走到发请求、退 0）。这条是本轮写完这道闸之后自己复查出来的：判据本身对，
 *     参数没判，而 `Atomics.wait(…, NaN)` 不返回。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { judgeCiGreen } from '../../scripts/assert-ci-green.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'assert-ci-green.mjs')
const FIX = (name) => path.join(HERE, 'fixtures', name)
const read = (name) => JSON.parse(fs.readFileSync(FIX(name), 'utf8'))
const ASK = { workflow: 'ci.yml', sha: '4c58e9cb18677f913db2a4a00c218a2cf426e420' }

/** 真响应体（跑坏的那一条），下面几条判定全部围着它读。 */
const RED = read('ci-runs-failure.json')
const GREEN = read('ci-runs-success.json')
const PENDING = read('ci-runs-pending.json')
const RERUN = read('ci-runs-rerun.json')
const NONE = read('ci-runs-none.json')

/**
 * 只记录 argv、只回放一个 JSON 的 `gh` stub。它不实现 GitHub API——它回答的是"这一步到底用什么
 * 路径问了什么"这一个问题，所以断言落在 argv 与退出码上，不落进 GitHub 的语义。
 */
function stubGh(t, payloadFile, { status = 0, stderr = '' } = {}) {
  // 写在系统临时目录里，不写仓库：往仓库根放一个 `.stub-gh/` 的套件，跑完 `git status` 就不是空的，
  // 而收口条件要求它为空——这条坑本仓记过一次（CWD 相对路径写进仓库根）。
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `gp-cigreen-${t}-`))
  const dir = path.join(base, 'bin')
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(base, 'calls.log')
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    `if [ "$#" -gt 1 ]; then cat '${payloadFile}'; fi`,
    `printf '%s' ${JSON.stringify(stderr)} >&2`,
    `exit ${status}`,
    '',
  ].join('\n'), { mode: 0o755 })
  return {
    dir,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

/**
 * 用**相对**路径调用，因为 `.github/workflows/release.yml` 里就是这么写的（cwd 是仓库根，
 * `node scripts/assert-ci-green.mjs`）。这里顺带量到一件本来会被当成常识的事：Node 交给
 * `process.argv[1]` 的已经是**绝对且折叠过 `..` 的**路径——`node ../scripts/x.mjs`、
 * `node ./scripts/./x.mjs`、`node ../../scripts/x.mjs` 三种写法实测都回
 * `/Volumes/…/scripts/x.mjs`（2026-10-16，node v26.4.0）。所以文件末尾那个自执行判据写成
 * `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` 与"直接跟 import.meta.url 比"
 * 在这一版 Node 上等价，前者只是不把这件事押在实现细节上；相应地，"改成相对路径调用就能让那条
 * 判据的变异变红"是本测试一度声称却实测不成立的说法，已经删掉——没有牙的控制比没有控制更坏。
 */
const REL_SCRIPT = path.relative(REPO, SCRIPT)

function runCli({ args, env = {}, gh }) {
  const got = spawnSync(process.execPath, [REL_SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO,
    env: { ...process.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH ?? ''}`, ...env },
  })
  // `calls` 交回的是**读日志这个动作**，不是快照：stub 的 log 在 gh 退出后才完整，而且
  // cleanup 会把目录删掉——所以它必须在断言里现读，别在 helper 里提前读死。
  return { status: got.status, out: `${got.stdout ?? ''}${got.stderr ?? ''}`, calls: gh.calls }
}

/* ------------------------------------------------------------------ the judgement */

test('红的那一条被点名到 run、结论与 URL，而不是只说一句不绿', () => {
  const got = judgeCiGreen(RED, ASK)
  assert.equal(got.ok, false, JSON.stringify(got))
  assert.equal(got.pending, undefined, '跑坏了不是"再等等"——等不出绿来')
  assert.match(got.reason, /38842800885/, 'run id 要在话里，读者才能直接打开那一条')
  assert.match(got.reason, /failure/)
  assert.match(got.reason, /https:\/\/github\.com\/jingzhao-l\/GlassPane\/actions\/runs\/38842800885/, got.reason)
})

test('绿的响应体判成通过，并把是哪一条 run 绿的写出来', () => {
  const got = judgeCiGreen(GREEN, { workflow: 'ci.yml', sha: '6bb4f545bac7bdbe45be7e447efdbe67d8a80cde' })
  assert.equal(got.ok, true, got.reason)
  assert.match(got.reason, /success/, got.reason)
})

test('还没跑完说的是"再等"，不是"坏"', () => {
  const got = judgeCiGreen(PENDING, ASK)
  assert.equal(got.ok, false, JSON.stringify(got))
  assert.equal(got.pending, true, '这一条必须让调用方继续等，而不是把它记成一次失败')
  assert.match(got.reason, /还没跑完/, got.reason)
})

test('一个记录都没有时说的是没有证据，绝不是通过', () => {
  const got = judgeCiGreen(NONE, ASK)
  assert.equal(got.ok, false, '空 workflow_runs 落成绿＝这一步形同不存在')
  assert.equal(got.pending, undefined, JSON.stringify(got))
  assert.match(got.reason, /没有任何运行记录/, got.reason)
  assert.match(got.reason, /没跑过/, got.reason)
  assert.doesNotMatch(got.reason, /success/, got.reason)
})

test('重跑过的 commit 认最新那一条：新的绿盖得住旧的红', () => {
  const got = judgeCiGreen(RERUN, ASK)
  assert.equal(got.ok, true, `两条记录里 03:30 那一条才是这个 sha 的现状：${got.reason}`)
})

test('反过来，最新那条是红的就不能让旧绿盖住', () => {
  // 同一份夹具，把两条记录的 created_at 互换：判据必须是"按时间取最新"，
  // 而不是"数组第一条"或"id 大的那条"——GitHub 不保证返回顺序，id 也只是实现细节。
  // 深拷贝是必需的：夹具对象在几条断言之间共享，就地改时间会把上一条断言的判据也改了。
  const older = structuredClone(RERUN.workflow_runs[1])
  const newerSuccess = structuredClone(RERUN.workflow_runs[0])
  const flipped = { workflow_runs: [newerSuccess, older] }
  assert.equal(judgeCiGreen(flipped, ASK).ok, true, '夹具本身还能判绿')
  older.created_at = '2026-10-16T04:00:00Z'
  const got = judgeCiGreen({ workflow_runs: [newerSuccess, older] }, ASK)
  assert.equal(got.ok, false, '红的那一条排到时间最新时，必须判红')
  assert.match(got.reason, /failure/, got.reason)
})

/* ------------------------------------------------------------------ the wiring, end to end */

test('作为命令跑起来时问的是这个 sha 的 ci.yml，且红就退 1', () => {
  const gh = stubGh('cli-red', FIX('ci-runs-failure.json'))
  try {
    const ran = runCli({ args: ['--sha', ASK.sha, '--repository', 'jingzhao-l/GlassPane', '--workflow', 'ci.yml'], gh })
    const asked = ran.calls()
    assert.equal(asked.length, 1, JSON.stringify(asked))
    assert.match(asked[0], /^api repos\/jingzhao-l\/GlassPane\/actions\/workflows\/ci\.yml\/runs\?/, asked[0])
    assert.match(asked[0], new RegExp(`head_sha=${ASK.sha}`), '问的对象必须是这个 commit，不是别的 ref')
    assert.match(asked[0], /event=push/, asked[0])
    assert.equal(ran.status, 1, ran.out)
    assert.match(ran.out, /38842800885/, ran.out)
  } finally {
    gh.cleanup()
  }
})

test('CI 绿时这道闸退 0', () => {
  const gh = stubGh('cli-green', FIX('ci-runs-success.json'))
  try {
    const ran = runCli({ args: ['--sha', '6bb4f545bac7bdbe45be7e447efdbe67d8a80cde', '--repository', 'jingzhao-l/GlassPane'], gh })
    assert.equal(ran.status, 0, ran.out)
    assert.match(ran.out, /success/, ran.out)
  } finally {
    gh.cleanup()
  }
})

test('等满预算按未验证拒绝，不是放行', () => {
  const gh = stubGh('cli-pending', FIX('ci-runs-pending.json'))
  try {
    // 预算给 4s、轮询 1s：一次 `gh` 调用在这台机上量到 ~0.3s，所以这一条既能看见"反复问"，
    // 又不靠负载才能红（只红在负载下的计时断言是坏对照，本仓记过）。
    const ran = runCli({ args: ['--sha', ASK.sha, '--repository', 'jingzhao-l/GlassPane', '--budget', '4000', '--poll', '1000'], gh })
    assert.equal(ran.status, 1, ran.out)
    assert.match(ran.out, /预算/, ran.out)
    assert.match(ran.out, /未验证/, ran.out)
    assert.ok(ran.calls().length >= 2, `pending 就该反复问，实得 ${ran.calls().length} 次`)
  } finally {
    gh.cleanup()
  }
})

test('没有 sha 的时候不猜一个就发', () => {
  const gh = stubGh('cli-nosha', FIX('ci-runs-success.json'))
  try {
    const ran = runCli({ args: ['--repository', 'jingzhao-l/GlassPane'], env: { GITHUB_SHA: '' }, gh })
    assert.equal(ran.status, 1, ran.out)
    assert.match(ran.out, /没有 sha/, ran.out)
    assert.deepEqual(ran.calls(), [], '没有对象可问时连 API 都不该发出去')
  } finally {
    gh.cleanup()
  }
})

test('写坏的时间参数是拒绝，不是无限等待', () => {
  // 实测过的形状：`Number('20m')` 是 NaN，`elapsed >= NaN` 恒假（预算到不了），
  // 而 `Atomics.wait(view, 0, 0, NaN)` **永不返回**——那条探针在本机挂了两分钟不退出，只能杀掉。
  // 也就是说 `--budget 20m` 会把发布作业变成一台不出日志、不超时、也停不下来的机器。
  const gh = stubGh('cli-badbudget', FIX('ci-runs-success.json'))
  try {
    for (const bad of ['abc', '20m', '0', '-5']) {
      const ran = runCli({ args: ['--sha', ASK.sha, '--repository', 'jingzhao-l/GlassPane', '--budget', bad, '--poll', bad], gh })
      assert.equal(ran.status, 1, `--budget ${bad} 必须拒绝：${ran.out}`)
      assert.match(ran.out, /正整数毫秒/, ran.out)
    }
    assert.deepEqual(gh.calls(), [], '参数判掉之后不该再发 API 请求')
  } finally {
    gh.cleanup()
  }
})

test('API 问不到就说问不到，不把错误当成绿', () => {
  const gh = stubGh('cli-err', FIX('ci-runs-success.json'), { status: 1, stderr: 'gh: Not Found (HTTP 404)\n' })
  try {
    const ran = runCli({ args: ['--sha', ASK.sha, '--repository', 'jingzhao-l/GlassPane', '--workflow', 'nope.yml'], gh })
    assert.equal(ran.status, 1, ran.out)
    assert.match(ran.out, /404/, ran.out)
    assert.doesNotMatch(ran.out, /success/, ran.out)
  } finally {
    gh.cleanup()
  }
})

/* ------------------------------------------------------------------ the guard is wired up */

test('release.yml 两条发布通道都真的问了这个问题', () => {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')
  const lines = yml.split('\n')
  const jobStart = (name) => lines.findIndex((l) => l.startsWith(`  ${name}:`))
  const bounds = (name) => {
    const from = jobStart(name)
    assert.ok(from > -1, `release.yml 里没有 job ${name}——这道闸的落点变了，测试得跟着改`)
    const next = lines.findIndex((l, i) => i > from && /^ {2}\w[\w-]*:$/.test(l))
    return lines.slice(from, next < 0 ? lines.length : next)
  }
  for (const job of ['github-release', 'npm-publish']) {
    const body = bounds(job)
    const calls = body.filter((l) => l.includes('node scripts/assert-ci-green.mjs'))
    assert.equal(calls.length, 1, `${job} 应当恰好调一次这道闸，实得 ${calls.length}：`
      + '调 0 次＝发布链仍然不问 CI；调 2 次＝同一件事两份判据')
    assert.ok(body.some((l) => l.includes('--sha')), `${job} 的调用没有点名 --sha：那会去问事件的 sha 而不是被检出的这棵树`)
    assert.ok(body.some((l) => l.includes('--workflow ci.yml')), `${job} 没点名问哪条工作流`)
    assert.ok(body.some((l) => /^\s+actions: read\s*$/.test(l)), `${job} 的 permissions 没给 actions: read——API 会 403/404，而这一步必须失败而不是空过`)
    // runner 交给 step 的是 `GITHUB_TOKEN`，而 `gh` 认的是 `GH_TOKEN`。v1.16.2 的那次发布就是
    // 死在这里（run 38855034310：`gh api 回了 4：To use GitHub CLI in a GitHub Actions workflow,
    // set the GH_TOKEN environment variable`）——判据本身没问题，是这一步拿不到身份。写这条断言
    // 的时候它已经红过一次真实的发布了，所以这条不是预防性的装饰。
    assert.ok(body.some((l) => l.includes('GH_TOKEN: ${{ github.token }}')),
      `${job} 的 CI-green 步没声明 GH_TOKEN：gh 在 Actions 里读不到 runner 给的身份，`
      + '这一步会 4 号退出并把整版挡住（那是 fail-closed，不是放行，但每一版都会挡住）')
  }
  // 两个权限块都得是"整块替换"的形状：job 级 permissions 会顶掉工作流级那一整块，
  // 所以 contents/id-token 一条都不能少（这条文件里 f12b241 之后就一直有闸，见 check-workflows）。
  const npmBlock = bounds('npm-publish').join('\n')
  assert.match(npmBlock, /contents: read/, 'npm-publish 丢了 contents 就读不到 tag 校验那一步的 ls-remote')
  assert.match(npmBlock, /id-token: write/, 'npm-publish 丢了 id-token 就签不出 provenance')
})

/**
 * The self-execution guard must survive being handed a **symlink**.
 *
 * Node loads an ESM entry by its *real* path, so `import.meta.url` is the target file while
 * `process.argv[1]` is the link that was named. `path.resolve(argv[1]) === fileURLToPath(import.meta.url)`
 * (no realpath on either side) is therefore false, `main()` never runs, and the process exits **0 with no
 * output** — a发布步骤 that asks nothing and passes. Measured on this machine 2026-10-19:
 * `node scripts/assert-ci-green.mjs` → rc 1 + the refusal line; the same file reached through a symlink
 * → rc 0, zero bytes. The three npm/launchd-delivered entrypoints in this repo already realpath both
 * sides (`installer/cli.js`, `updater/cli.js`, `updater/agent-entry.js`); this gate is the same shape of
 * guard and had the same hole.
 */
test('通过符号链接调用时这道闸照样跑，退码与输出都在（realpath 两侧）', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-cigreen-link-'))
  const link = path.join(base, 'acg-link.mjs')
  const gh = stubGh('cli-link', FIX('ci-runs-failure.json'))
  try {
    fs.symlinkSync(SCRIPT, link)
    const got = spawnSync(process.execPath, [link, '--sha', ASK.sha, '--repository', 'jingzhao-l/GlassPane', '--workflow', 'ci.yml'], {
      encoding: 'utf8',
      cwd: REPO,
      env: { ...process.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH ?? ''}` },
    })
    const out = `${got.stdout ?? ''}${got.stderr ?? ''}`
    assert.notEqual(got.status, 0, `被符号链接调用时这道闸安静地退 0——它什么都没问：stdout=${JSON.stringify(got.stdout)} stderr=${JSON.stringify(got.stderr)}`)
    assert.ok(out.trim() !== '', '符号链接调用必须照样输出判决，否则发布步骤读到的是一段沉默')
    assert.equal(got.status, 1, out)
    assert.match(out, /38842800885/, out)
    assert.equal(gh.calls().length, 1, '通过链接调用也要真的问过那一次 API')
  } finally {
    gh.cleanup()
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('脚本被 import 时一行都不执行', async () => {
  // 这条文件自己的教训（见 memory 与 scripts/ 里的旧坑）：顶层自跑 + exit 的脚本被测试 import 时，
  // 会以"零条用例通过"的形状假绿。这里量的是反面：import 不产生任何输出、不改退出码。
  const got = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('file://' + SCRIPT).href)}); process.stdout.write("IMPORTED-OK")`],
    { encoding: 'utf8', cwd: REPO })
  assert.equal(got.status, 0, `${got.stdout}${got.stderr}`)
  assert.equal(got.stdout.trim(), 'IMPORTED-OK', got.stdout)
  assert.doesNotMatch(got.stderr, /预算|没有 sha|38842800885/, 'import 就把 CLI 跑起来了：这道闸会在任何 import 它的地方乱发 API 请求')
})
