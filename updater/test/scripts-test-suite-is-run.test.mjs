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
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
