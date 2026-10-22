/**
 * 每条被 git 跟踪的 `*.test.mjs` 都必须被某个 workspace 的 test 脚本够得着。
 *
 * WHY（本轮实测到的形状，不是理论）。2026-10-16 审发布链时发现 `scripts/test/` 里躺着
 * 一条 4 个用例的套件（`tools-gpg-signing.test.mjs`，管的是"gpg 口令不许进 argv"那条
 * 安全修复），而**没有任何一条门禁跑过它**：根 `package.json` 的 `test` 是
 * `npm run build && npm run test --workspaces --if-present`，workspaces 只有
 * mcp-shell / installer / updater 三个目录（`kernel/` 的代码镜像与它一起于 2026-10-18 退场），`scripts/` 不是 workspace；全仓
 * grep `scripts/test` 命中 0 条（含 CI 的两个 yml）。于是那条签名口令的守卫自写下那天起
 * 就是死字——它不会红，哪怕 `tools/gpg-signing.sh` 重新把口令拼回 argv。
 * "写出来的测试"与"会被执行的测试"之间没有闸，就是这么个下场。
 *
 * 修法分两半，都在这一个文件里：① 那条套件移进 `updater/test/`（本仓 Node 测试的实际
 * 归处：`scripts/check-workflows.mjs`、`scripts/assert-test-count.mjs`、`tools/sync-kernel.sh`
 * 的测试都住在那儿，靠 `node --test test/*.test.mjs` 被执行）；② 下面这道闸把"没人跑"
 * 这个类别本身挡住。
 *
 * 判据用 glob，不看目录名猜测：`*` 不许跨越目录边界，所以 `test/*.test.mjs` 覆盖不到
 * `test/support/x.test.mjs`（mcp-shell 真有一个 `test/support/fake-daemon.mjs`，它不是
 * 测试；哪天有人往那儿放一条真的测试，它就必须被抓出来，而不是安静地不跑）。
 *
 * `harness/` 整条前缀不在本题范围内：那是另一条线（10:30 独立任务）的内容与门禁，本轮
 * 政策是不改它、也不替它判定；这一条例外写在报告里，而不是把判据放宽成"大概都跑了"。
 *
 * REVERSE MUTATIONS（三条都在本机实测过，2026-10-16）：
 *   · 把 glob 转换里的 `[^/]*` 改成 `.*`（星号能吃目录边界）→ 具名红：
 *     `glob 的星号跨不过目录…`。
 *   · 让 `uncovered()` 一律返回空 → 具名红两条：`落在 workspace 之外的测试被判成孤儿…` 与
 *     `没有 test 脚本的 workspace 里的测试也是孤儿`（这条闸不是只靠"今天是绿的"活着）。
 *   · 把 `scripts/` 加进 `OUT_OF_SCOPE_PREFIXES`（用豁免清单吞掉真孤儿）→ 具名红：
 *     `落在 workspace 之外的测试被判成孤儿，并点名到文件`。
 *   · 曾经还有第四条"删掉 `rel.startsWith(runner.prefix)`"，实测零红：glob 由 `<root>/<dir>/`
 *     起锚，那条前缀判断是同一件事的第二份写法。已经删了——留着它就是一条自称有闸的装饰。
 *
 * 2026-10-22 起这个文件还守第二半，因为「够得着」不等于「执行过」：上面那道闸证明某条 glob
 * 覆盖得到某个文件，它证明不了那个文件里的断言在 CI 真正用的那台 runner 上跑过。见文件后半段
 * `platformSkipsOf` / `CENSUS` 的注释与它自己的反向变异。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 另一条线的领地：它的测试归它的门禁管，本轮不在此处替它判定（见文件头）。 */
const OUT_OF_SCOPE_PREFIXES = ['harness/']

/**
 * 每个 workspace 的 `scripts.test` 里那些 `*.test.mjs` 形状的参数，就是"会被执行"的
 * 全集。从脚本原文里读，不写死目录名：workspace 哪天改 glob（比如收成 `test/unit/*.test.mjs`），
 * 这道闸跟着变，而不是继续按老目录放行。
 */
function runnersOf(root) {
  const workspaces = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces ?? []
  const runners = []
  for (const dir of workspaces) {
    const manifest = path.join(root, dir, 'package.json')
    if (!fs.existsSync(manifest)) continue
    const script = JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts?.test
    if (typeof script !== 'string') continue
    for (const token of script.split(/[\s&&|;]+/)) {
      if (!token.endsWith('.test.mjs') || !token.includes('*')) continue
      runners.push({ dir: path.join(root, dir), glob: path.resolve(root, dir, token), prefix: `${dir}/` })
    }
  }
  return runners
}

/** glob→正则：`*` 只吃一段路径，`?` 吃一个字符；边界越不过去。 */
function globToRegExp(glob) {
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${source}$`)
}

/** 返回"没有任何 runner 够得着"的文件（相对仓库根的路径）。 */
function uncovered({ tracked, runners }) {
  return tracked.filter((rel) => {
    if (OUT_OF_SCOPE_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false
    // 绝对路径只拼一次：glob 已经是 `<root>/<dir>/<token>`，再把 rel 拼到 `<root>/<dir>` 上
    // 会得到 `<root>/<dir>/<dir>/<rel>`，于是每一条测试文件都"没人跑"——那条假红比孤儿更难查。
    // "落在某个 workspace 目录里"这一半不另写判据：glob 由 `<root>/<dir>/` 起锚，目录外的路径
    // 匹配不上就是匹配不上（写了反而是一条永远不红的重复条件，2026-10-16 反向变异实测零红）。
    return !runners.some((runner) => globToRegExp(runner.glob).test(path.join(REPO, rel)))
  })
}

const RUNNERS = runnersOf(REPO)
const TRACKED = execFileSync('git', ['ls-files', '-z', '*.test.mjs'], { cwd: REPO })
  .toString('utf8').split('\0').filter(Boolean)

test('每条被跟踪的 .test.mjs 都落在某个 workspace 的 test glob 里', () => {
  assert.ok(TRACKED.length > 80, `git ls-files 只回条 ${TRACKED.length} 条测试文件——这道闸自己就先瞎了（glob 参数写错、`
    + '索引为空都会是这个形状，那时"没有孤儿"是空过出来的绿）')
  assert.ok(RUNNERS.length >= 3, `三个 workspace 至少该贡献 3 条 glob，实得 ${RUNNERS.length}：`
    + '读不到 runner 的时候这道闸一律"通过"，那就是把门禁改成了装饰')
  const orphans = uncovered({ tracked: TRACKED, runners: RUNNERS })
  assert.deepEqual(orphans, [], `这些测试写了但没有任何一条门禁会跑它们：${orphans.join(', ')}。`
    + '移进某个 workspace 的 test glob 里（本仓的实际归处是 updater/test/），别把它们留在没人读的地方')
})

test('落在 workspace 之外的测试被判成孤儿，并点名到文件', () => {
  // 2026-10-16 那条真事：`scripts/test/` 不是 workspace，所以里面 4 个用例从未执行。
  const orphans = uncovered({ tracked: ['scripts/test/tools-gpg-signing.test.mjs'], runners: RUNNERS })
  assert.deepEqual(orphans, ['scripts/test/tools-gpg-signing.test.mjs'],
    '这条负例不红就说明判据已经空转：目录外的文件必须被抓出来')
})

test('没有 test 脚本的 workspace 里的测试也是孤儿', () => {
  // 新增 workspace 只写 `build` 不写 `test` 是最容易溜过去的一种死法：文件在"某个 workspace
  // 里面"，看起来合规，而 `--if-present` 让它一行都不跑。
  const runners = [{ dir: path.join(REPO, 'brandnew'), glob: path.join(REPO, 'brandnew', 'test', '*.test.mjs'), prefix: 'brandnew/' }]
  const scriptless = runnersOf(REPO).filter((r) => r.dir !== path.join(REPO, 'brandnew'))
  assert.ok(uncovered({ tracked: ['brandnew/test/x.test.mjs'], runners: scriptless }).length === 1,
    '不属于任何 runner 的文件必须算孤儿')
  // 反过来：同一个文件在它自己的 workspace 有 glob 时不再算孤儿（判据是 glob，不是目录白名单）。
  assert.deepEqual(uncovered({ tracked: ['brandnew/test/x.test.mjs'], runners }), [],
    '有 runner 覆盖时不得误报——否则这道闸只会逼人把测试塞进 updater')
})

test('glob 的星号跨不过目录：test/support/ 里的测试没人跑要被抓住', () => {
  const runner = RUNNERS.find((r) => r.prefix === 'mcp-shell/')
  assert.ok(runner, '读不到 mcp-shell 的 runner，这条断言就没有对象')
  assert.ok(!globToRegExp(runner.glob).test(path.join(runner.dir, 'test', 'support', 'sneaky.test.mjs')),
    '`test/*.test.mjs` 一旦能吃子目录，放进 test/support/ 的测试就会被"算成已执行"，而 node --test 不会跑它')
  assert.ok(globToRegExp(runner.glob).test(path.join(runner.dir, 'test', 'sneaky.test.mjs')), '同一条 glob 得认它本来要认的形状')
  // 事实核对：mcp-shell 的 test/support/ 里确实只有夹具，没有测试——这条前提漂了也要能说。
  const support = path.join(REPO, 'mcp-shell', 'test', 'support')
  const supportTests = fs.existsSync(support) ? fs.readdirSync(support).filter((f) => f.endsWith('.test.mjs')) : []
  assert.deepEqual(supportTests, [], `mcp-shell/test/support/ 里出现了会被静默跳过的测试：${supportTests.join(', ')}`)
})

test('那条签名口令的套件现在真的会被跑（本文件的来路）', () => {
  const rel = 'updater/test/tools-gpg-signing.test.mjs'
  assert.ok(TRACKED.includes(rel), `${rel} 不在索引里：那条套件没被移动，只是被复制了一份到没人跑的地方`)
  assert.deepEqual(uncovered({ tracked: [rel], runners: RUNNERS }), [], '移进来之后仍没有 runner 够它＝白移')
  assert.equal(fs.existsSync(path.join(REPO, 'scripts', 'test')), false,
    '`scripts/test/` 还在：那儿是一条没有任何门禁读取的死目录，正是这条 finding 本体')
  // 移过来不等于会跑：跑它的那条 glob 必须真在这三个 workspace 的 test 脚本里。
  const updater = RUNNERS.find((r) => r.prefix === 'updater/')
  assert.ok(updater && globToRegExp(updater.glob).test(path.join(updater.dir, 'test', 'tools-gpg-signing.test.mjs')),
    'updater 的 test glob 不再覆盖这个文件名——下一次 `npm test` 就又没人跑它了')
})

/* ------------------------------------------------------------------ 平台条件跳过的普查（2026-10-22） */

/**
 * 「够得着」不等于「执行过」。上面那道闸证明一条 glob 覆盖得到某个文件；它证明不了那个文件里的
 * 断言在 CI 真正用的那台机器上**跑过**。本仓的实际形状是这种：守卫先比 `process.platform` 与
 * darwin 那个平台名不相等，紧接着那句 `t.skip` 的理由写的是 "plutil is the reader being satisfied
 * here"（这一族在 `updater/test/launchd.test.mjs` 与 `updater/test/cli-options.test.mjs` 里共 11 处；
 * 这里刻意不把守卫原文抄一遍——闸跑的是原文，注释里举一次例子就会被当成一处缺陷，本仓在
 * `EngineCore.swift` 的那两条位点上记过同一件事）。`installer/test/` 另有 6 处走的是安装器自己的
 * 环境预检（`preflightIssues` / `preflightBlocked` / 回话里的「环境预检未通过」）——两种写法守的都是
 * 只有 macOS 才有的东西（launchd、plutil、`/usr/bin/security`、Swift 工具链）。这份产品只在 macOS
 * 上交付，所以那些断言守着的是交付面本身；而 `ci.yml` 的两条 Node lane 都跑在 ubuntu-latest 上，
 * `t.skip` 计入"通过"，于是它们自写下起就是**绿着的没跑**。`ci.yml` 自己写着 OS-gated 的一步在错
 * 主机上"等于没跑"（`publish-gate-selftest` 那段），这条普查就是那句话的机器版本。
 *
 * 静态判不了"这一条今天到底跑没跑"（那要 runner），所以这里判的是**可判的那一半**，而且判到底：
 * ① 按文件数出平台条件跳过的处数（普查读不到任何一处就说明判据自己瞎了，那也算红）；
 * ② 要求 `ci.yml` 里存在一条 `runs-on` 是 macOS 的 job，其 `run:` 正文真的跑该文件所属 workspace
 *    的 test。这一半把"有一份带 darwin-only 检查的文件存在"与"有一条 job 会跑它"接成环。
 *
 * 读 `ci.yml` 用的是 `scripts/check-workflows.mjs --jobs` —— 与本文件其余部分同一个理由：判据要的
 * 是"CI 那份 job 表"，自己再写一套 YAML 正则就等于两把尺子互相作证。
 *
 * REVERSE MUTATION：删掉 `ci.yml` 的 `macos-node-gate` → `每一条平台条件跳过都有 macOS job 兜底` 红，
 * 报文点名 `glasspane-update` 与 `glasspane-install`。把那条 job 的 `runs-on` 改成 ubuntu → 同一条红。
 * 把 `runsWorkspace` 的选择器判据放宽成"文件里任何位置出现过 workspace 名" → `只出现在别的语境里
 * 不算跑过` 红。让 `census()` 一律返回空 → `普查读不到任何平台条件跳过＝判据自己先瞎了` 红。
 */
const PLATFORM_GUARD = /process\.platform\s*[!=]==\s*['"](?:darwin|linux|win32|freebsd|openbsd|sunos|aix|cygwin)['"]/
const PREFLIGHT_GUARD = /preflightIssues\(|preflightBlocked\(|环境预检未通过/
const SKIP_CALL = /\.skip\(/
/** 守卫与它那句 skip 之间允许隔几行（同一 test 体内的注释也算在内）。 */
const GUARD_WINDOW = 13

/** 某个文件里"守卫后面紧跟一条 skip"的处数与行号。注释行不扫：闸跑的是原文，注释里举一次例子
 * 就会被数成一处缺陷（`check-workflows.mjs` 对 `gh release view` 那条也是这个取舍——把 prose
 * 判成缺陷，下场是 prose 被删掉而守卫原样留着）。 */
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/
function platformSkipsOf(rel) {
  let lines
  try {
    lines = fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n')
  } catch {
    return []
  }
  const at = []
  lines.forEach((line, i) => {
    if (COMMENT.test(line)) return
    if (!PLATFORM_GUARD.test(line) && !PREFLIGHT_GUARD.test(line)) return
    if (!SKIP_CALL.test(lines.slice(i, Math.min(i + GUARD_WINDOW, lines.length)).join('\n'))) return
    at.push(i + 1)
  })
  return at
}

/** workspace 目录 → npm 包名（`--workspace` 的选择器用的是包名，本仓的 ci.yml 就是这么写的）。 */
function workspaceNames(root) {
  const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces ?? []
  const out = {}
  for (const dir of declared) {
    try {
      out[dir] = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')).name ?? dir
    } catch {
      out[dir] = dir
    }
  }
  return out
}

function jobsOfWorkflow(file) {
  const result = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-workflows.mjs'), '--jobs'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(result.status, 0, `check-workflows --jobs 退 ${result.status}：${result.stderr}`)
  return JSON.parse(result.stdout).filter((row) => row.workflow === file)
}

const runsWorkspace = (job, workspace) => {
  const body = job.runs.map((r) => r.text).join('\n')
  return /(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(body)
    && (new RegExp(`(?:--workspace|--ws|-w)\\s*=?\\s*["']?${workspace}\\b`).test(body) || /--workspaces\b/.test(body))
}

const WORKSPACE_NAMES = workspaceNames(REPO)
const CENSUS = TRACKED
  .filter((rel) => !OUT_OF_SCOPE_PREFIXES.some((p) => rel.startsWith(p)))
  .map((rel) => ({ rel, at: platformSkipsOf(rel), dir: rel.split('/')[0] }))
  .filter((row) => row.at.length > 0)

test('普查读得到平台条件跳过：判据自己没瞎（读不到就是这条闸的空转形态）', () => {
  const total = CENSUS.reduce((sum, row) => sum + row.at.length, 0)
  assert.ok(total >= 5,
    `只数出 ${total} 处平台条件跳过（本仓实测 17 处：launchd 一族 11 处 + 安装器预检一族 6 处）。`
    + '读不到不等于"没有这种断言了"，更可能是守卫换了写法——那时这道闸就不再守着任何东西。'
    + 'remedy：先看 PLATFORM_GUARD / PREFLIGHT_GUARD 还认不认得当下的写法，再改期望值。')
  for (const rel of ['updater/test/launchd.test.mjs', 'installer/test/install-honesty.test.mjs']) {
    assert.ok(CENSUS.some((row) => row.rel === rel),
      `${rel} 没进普查：它里面有 macOS-only 的 skip（本 finding 点名的两处），普查认不出它就是判据漏了`)
  }
})

test('每一条平台条件跳过都有 macOS job 兜底：所属 workspace 的 test 在 mac runner 上被真的跑一次', () => {
  const jobs = jobsOfWorkflow('ci.yml')
  const uncovered = []
  for (const row of CENSUS) {
    const workspace = WORKSPACE_NAMES[row.dir]
    assert.ok(workspace, `${row.rel} 住在 ${row.dir}/，而根 package.json 的 workspaces 里没有这个目录`)
    if (!jobs.some((job) => /macos/i.test(String(job.runsOn ?? '')) && runsWorkspace(job, workspace))) {
      uncovered.push(`${row.rel}（${row.at.length} 处，行 ${row.at.join(',')} → workspace ${workspace}）`)
    }
  }
  assert.deepEqual(uncovered, [],
    `这些文件里有只在 macOS 上执行的断言，而 ci.yml 没有任何一条 macOS job 跑它们所在 workspace 的 test：${uncovered.join('；')}。`
    + '它们在 ubuntu runner 上计入 skip、计入"通过"，从来没执行过。remedy：加一条 runs-on 为 macOS 的 job '
    + '跑 `npm test --workspace <name>`（不要给 ubuntu job 加 `if: runner.os == macOS`，那等于没跑）。')
})

test('反例：一个带 darwin-only skip 的新 workspace 没有 macOS job，必须被抓出来', () => {
  // 判据的两个方向都要能红（本文件其余用例同此规矩）。这里不碰仓库，只把"有一条 mac job 只跑了
  // glasspane-update"这一张 job 表喂给同一个判据：另一个 workspace 就成了缺口。
  const onlyUpdater = [{ name: 'mac-one', runsOn: 'macos-latest', runs: [{ text: 'npm test --workspace glasspane-update', line: 1, dir: '' }] }]
  const covered = (jobs, workspace) => jobs.some((job) => /macos/i.test(String(job.runsOn ?? '')) && runsWorkspace(job, workspace))
  assert.equal(covered(onlyUpdater, 'glasspane-update'), true, '这张表该 Cover 得住 updater')
  assert.equal(covered(onlyUpdater, 'glasspane-install'), false, '只跑了一个 workspace 的 job 不许被算成都跑了')
  assert.equal(covered([{ name: 'linux', runsOn: 'ubuntu-latest', runs: onlyUpdater[0].runs }], 'glasspane-update'), false,
    'runner 不是 macOS 时，同一条命令不许被当成"这些断言执行过"')
  // 选择器必须是选择器：名字出现在别的语境里（注释、别的命令）不算跑过。
  assert.equal(covered([{ name: 'x', runsOn: 'macos-latest', runs: [{ text: 'echo glasspane-update', line: 1, dir: '' }] }], 'glasspane-update'), false,
    '只出现在别的语境里不算跑过——否则这条闸会跟着 README 里的一个词一起变绿')
})

