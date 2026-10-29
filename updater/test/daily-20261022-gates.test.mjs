/**
 * daily-20261022-gates.test.mjs — 2026-10-22 那轮门禁/文档缺陷的**闸**，四条各一道，每条都能证红。
 *
 * 这一族缺陷的共同形状不是"写错了"，是**没人问**：
 *
 * · #1 十几个断言在 CI 真正用的那台主机上 `t.skip`（`plutil is the reader being satisfied here`
 *   那一族）。它们守的是这份只在 macOS 上交付的产品本身，而 `ci.yml` 自己就写着 OS-gated 的一步
 *   在错的主机上"等于没跑"。修法是加一条真的 macOS job，不是给 ubuntu job 加 `if:`。
 * · #2 `SECURITY.md` / `SECURITY.zh-CN.md` 的受影响版本表里那一格 `| 1.19.x |` 是一条**活**主张，
 *   而 `scripts/version-sites.mjs` 不知道它——`set-version` 推不动它，`check-doc-links` 的
 *   「当前版本线」主张就每发一版红一次，红的原因是"没人改"而不是"有人写错"。
 * · #3 npm 包的三份 README（门面）不在文档闸的登记集合里。
 * · #4 五份对外文档给的安装命令是 `curl … | sh`，而本仓**实测**过这条管道会在 curl 自己失败时
 *   退 0（`installer/test/daily-20261020.test.mjs` 第一条用例钉的就是那个 rc=0）。
 *
 * 2026-10-29（泳道 10）在这一族里补了五道，形状与上面四条同一类——**没人问**：
 *
 * · S10-7 #4 的分步写法把落点交给了 `/tmp` 里的一个固定名字。`/private/tmp` 是 1777，sticky 只
 *   挡住别人删你的文件，不挡住他先建一个 `/tmp/gp-install.sh -> ~/.bashrc`；`curl -o` 跟随符号链接
 *   并以你的 uid 截断覆写目标（本机实测：预先占住那个名字的符号链接之后，受害者文件的内容变成了
 *   下载物的内容）。这一族里那份名句当时钉的正是**那个路径名**，于是"脆弱落点"被写成契约——
 *   现在钉的是判据：两步写法 + 落点说得出来源（mktemp / $TMPDIR / $HOME）。
 * · S10-3 `check-doc-links` 对链接与锚点做 `decodeURIComponent` 而没有保护：散文里"50%"这类写法
 *   进了锚点就抛 URIError，整条闸在文档循环中途带栈退掉，后面的文档、主张核对与表格形状本轮
 *   一条都没跑——违反本仓"一条拒该是一句话，不是一个栈"。
 * · S10-5 残渣闸的围栏状态机只认 ```，而同一个文件里 `headingsOf` 与 `markdownTableProblems`
 *   两种都认：`~~~` 围栏里的示例命令被误红，而误红文案教的"放进 ``` 围栏"对那一行自相矛盾。
 * · S10-4 `check-kernel-corpus` 的 check 分支对被 pin 名字落在**目录**上的形状直接 `readFileSync`
 *   ⇒ ERR_FS_EISDIR 的栈（`--record` 那两条腿 2026-10-28 已经改成 detect-then-refuse，这一支漏了）。
 *
 * REVERSE MUTATIONS（每条都点名它红在什么地方）：
 *   · 删掉 `ci.yml` 的 `macos-node-gate` → `ci.yml 里有一条 macOS job…` 红，报文点名两个 workspace。
 *   · 把那条 job 改成 `runs-on: ubuntu-latest` → 同一条红（ runner 换了就不是那条 job 了）。
 *   · 把两条 ubuntu Node lane 或它们的 `assert-test-count` 腿删掉 → `这条修法不是删腿` 红。
 *   · 从 `SITES` 删掉 SECURITY 那两位 → `每一格活版本线都被位点登记着` 红，报文点名 SECURITY.md。
 *   · 把任一处安装命令改回管道 → `安装渠道闸…` 红并带 file:line。
 *   · 让 `pipedInstallCommands` 无条件返回 `[]` → 它的合成反例红（"判据空转"那条）。
 *   · 把 README 那行落点改回 `-o /tmp/gp-install.sh` → `安装渠道闸…` 那一条的 mktemp 断言红
 *     （`GP_INSTALL_SH="$(mktemp` 那一句没了），且 `node scripts/check-doc-links.mjs` 在
 *     INSTALL_LANDING_ENFORCED 上具名红。
 *   · 把 `installLandingProblems` 改成永远返回 `[]` → `落点闸三个方向…` 的合成反例红。
 *   · 把 `decodeRef` 换回裸的 `decodeURIComponent` → `锚点里的裸 %…` 红，而且是**抛**而不是断言失败
 *     （这正是本条要修的形状），所以那一支同时证明"后面的文档没被核对"。
 *   · 把 `isFenceLine` 换回 `line.trim().startsWith('```')` → `~~~ 围栏…` 的第一支红（误红）。
 *   · 把 check 分支里那次 `nonRegularKind()` 探测删掉 → `kernel-corpus 闸…` 红：报文里出现
 *     `at … check-kernel-corpus.mjs:NN` 的栈，且目录之后那份文件的字节漂移不再被报出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SITES, siteHitCount } from '../../scripts/version-sites.mjs'
import {
  DOCS,
  check,
  pipedInstallCommands,
  shellResidue,
  installLandingAudit,
  installLandingProblems,
  installLandingAdvisories,
  INSTALL_LANDING_ENFORCED,
  INSTALL_LANDING_HANDOFF,
} from '../../scripts/check-doc-links.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHECK_WORKFLOWS = path.join(REPO, 'scripts', 'check-workflows.mjs')
const CHECK_KERNEL_CORPUS = path.join(REPO, 'scripts', 'check-kernel-corpus.mjs')
const sha256Of = (text) => createHash('sha256').update(text).digest('hex')

/**
 * 用 `scripts/check-workflows.mjs` 自己的读法问 ci.yml：有哪些 job、各自 `runs-on` 什么、
 * `run:` 正文写了什么。这个文件**不**再写第二套 YAML 正则——两把各写各的尺子 agreeing
 * 只是因为它们是两把同一形状的错误尺子，那正是本仓反复抓的假绿。
 */
function jobsOf(workflow = 'ci.yml') {
  const result = spawnSync(process.execPath, [CHECK_WORKFLOWS, '--jobs'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(result.status, 0, `check-workflows --jobs 退 ${result.status}：${result.stderr}`)
  const rows = JSON.parse(result.stdout)
  assert.ok(Array.isArray(rows) && rows.length > 0, `--jobs 答了个空集：${result.stdout.slice(0, 200)}`)
  return rows.filter((row) => row.workflow === workflow)
}

/** 这条 job 的 `run:` 正文合起来（块状 body 是按行进 `runs` 的，见 walkWorkflow）。 */
const bodyOf = (job) => job.runs.map((r) => r.text).join('\n')

const isMacRunner = (job) => /macos/i.test(String(job.runsOn ?? ''))

/** 这条 job 是否跑 `<workspace>` 这个 workspace 的 test 脚本。 */
function runsWorkspace(job, workspace) {
  const body = bodyOf(job)
  const testCmd = /(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(body)
  const selector = new RegExp(`(?:--workspace|--ws|-w)\\s*=?\\s*["']?${workspace}\\b`).test(body)
  const allWorkspaces = /--workspaces\b/.test(body)
  return testCmd && (selector || allWorkspaces)
}

test('ci.yml 里有一条 macOS job 真的跑 glasspane-update 与 glasspane-install 两套 Node 用例', () => {
  const jobs = jobsOf('ci.yml')
  const wanted = ['glasspane-update', 'glasspane-install']
  const missing = wanted.filter((ws) => !jobs.some((job) => isMacRunner(job) && runsWorkspace(job, ws)))
  assert.deepEqual(missing, [], `这两个 workspace 的 Node 套件没有任何一条 macOS job 会跑：${missing.join(', ')}。`
    + '它们里面的断言在非 macOS 主机上当场 t.skip（launchd/plutil 那一族），而这份产品只在 macOS 上交付——'
    + '没有这条 job，那些断言就是"写着、绿着、从没执行"。remedy：在 .github/workflows/ci.yml 里加一条 '
    + 'runs-on 为 macOS 的 job，跑 `npm test --workspace <name>`；不要给 ubuntu job 加 `if: runner.os == \'macOS\'`，'
    + '那一步在那台机器上等于没跑（ci.yml 的 publish-gate-selftest 那段注释写的就是这条规矩）。')
  // 报文要说得出是哪条 job 担的这个活，否则删掉它的人只知道"少了点什么"。
  for (const ws of wanted) {
    const carrier = jobs.filter((job) => isMacRunner(job) && runsWorkspace(job, ws))
    assert.ok(carrier.length >= 1, `${ws} 没有任何 macOS job 跑它`)
    assert.ok(carrier.every((job) => job.name), `点名不了 job：${JSON.stringify(carrier.map((j) => j.line))}`)
  }
})

test('这条 macOS job 跑的是真命令而不是 `if:` 过的步骤，且两条 ubuntu Node lane 还在（本修法不是删腿）', () => {
  const jobs = jobsOf('ci.yml')
  const mac = jobs.filter((job) => isMacRunner(job) && runsWorkspace(job, 'glasspane-update'))
  // 先要有一 job 才有"它不是 if 过的"可判：少了这一句，下面那个 for 在空表上恒绿——
  // 一个只对非空集合说话的判据，就是本仓反复抓的那种装饰。
  assert.ok(mac.length >= 1, '没有任何 macOS job 跑 glasspane-update 的 Node 套件（上一条测试点名的就是这件事）')
  for (const job of mac) {
    assert.ok(!/\bif:\s*\$\{\{\s*runner\.os/.test(bodyOf(job)),
      `${job.name} 用 if/runner.os 自己又跳过了一轮：那条写法等于没跑`)
  }
  // ubuntu 那两条 lane 的既有职责一件不许少：install-gate 的 `npm test --workspace
  // glasspane-install` 与它的 `npm run test --workspaces --if-present`（`assert-test-count`
  // 腿住在 Swift job 里，这里核的是"Node 套件在 ubuntu 上仍然被跑"这件事本身）。
  const ubuntu = jobs.filter((job) => /ubuntu/i.test(String(job.runsOn ?? '')))
  assert.ok(ubuntu.some((job) => runsWorkspace(job, 'glasspane-install')),
    'ubuntu 那一侧的 glasspane-install 套件被删了：macOS job 是补洞，不是搬家')
  assert.ok(ubuntu.some((job) => /--workspaces/.test(bodyOf(job))),
    'ubuntu 那侧跑全部 workspace 的那一步没了：那条 lane 同时也是 lockfile/根布局的守卫')
  const swift = jobs.find((job) => job.name === 'swift')
  assert.ok(swift && /assert-test-count\.mjs/.test(bodyOf(swift)),
    'Swift 那条 job 的测试计数腿被删了——它是"一条用例都没跑不许算绿"的唯一读者')
})

test('--jobs 这个读法本身认得出 runner 与 run 正文：合成一棵没有 macOS job 的树必须读不到（判据不是自回显）', () => {
  // 上一条测试的全部力气都落在 `check-workflows --jobs` 给的 `runsOn` / `runs` 上。它若把
  // `runs-on` 读成 null、或把 `run:` 块正文丢掉，那条测试就会**恒红**（更糟是恒绿）。所以这里
  // 拿两棵合成树各打一次：一棵 ubuntu-only，一棵 macOS + 真正的 workspace 选择器。
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-jobs-loader-'))
  const writeWorkflow = (body) => {
    const dir = path.join(root, '.github', 'workflows')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'ci.yml'), body)
  }
  const read = () => {
    const copy = path.join(root, 'scripts', 'check-workflows.mjs')
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.copyFileSync(CHECK_WORKFLOWS, copy)
    const result = spawnSync(process.execPath, [copy, '--jobs'], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    return JSON.parse(result.stdout).filter((r) => r.workflow === 'ci.yml')
  }
  const HEADER = 'name: CI\non:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n'
  try {
    writeWorkflow(`${HEADER}  node:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test --workspace glasspane-update\n`)
    const linux = read()
    assert.equal(linux.length, 1, JSON.stringify(linux.map((j) => j.name)))
    assert.equal(linux[0].runsOn, 'ubuntu-latest', 'runs-on 没读到：那条 macOS 判据就成了恒红')
    assert.match(linux[0].runs.map((r) => r.text).join('\n'), /npm test --workspace glasspane-update/, 'run 正文没读到')
    assert.equal(linux.filter((j) => isMacRunner(j)).length, 0, 'ubuntu 树不该有 macOS job')

    writeWorkflow(`${HEADER}  mac:\n    runs-on: macos-latest\n    steps:\n      - run: |\n          npm ci\n          npm test --workspace glasspane-update\n`)
    const darwin = read()
    assert.equal(darwin.filter((j) => isMacRunner(j) && runsWorkspace(j, 'glasspane-update')).length, 1,
      '同一把尺子读不到那棵该有的树——上一条测试的绿是空的')
    assert.ok(!runsWorkspace(darwin[0], 'glasspane-install'), '选择器被当成"全都跑了"：那条判据就再也分不出少跑了谁')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 「活版本线表格格」普查：文档里凡是一个 `| X.Y.x |` 格、同一行还写着"这一线是当前发布线/
 * 安全修复在此发布"，它就是**今天**的话，必须有一个 `line` 位点推着它走。
 *
 * 判据写成可注入的函数，是因为两个方向都要能被证红（本仓规矩：只测正方向的判据等于没判据）。
 */
const LIVE_ROW = /\|\s*(\d+\.\d+)\.x\s*\|[^|\n]*(?:current release line|当前版本线|security fixes|安全修复)/i
function uncoveredVersionRows({ files, sites = SITES }) {
  const out = []
  for (const rel of files) {
    const abs = path.join(REPO, rel)
    if (!fs.existsSync(abs)) {
      out.push(`${rel}: 普查清单里登记了却读不到这个文件（未观测，不是通过）`)
      continue
    }
    const lines = fs.readFileSync(abs, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const m = LIVE_ROW.exec(line)
      if (!m) return
      const covered = sites.some((site) => site.file === rel && site.line === true && siteHitCount(site) === 1)
      if (!covered) {
        out.push(`${rel}:${i + 1} 有一格活版本线（${m[1]}.x）而 scripts/version-sites.mjs 里没有指向它的 line 位点：`
          + 'set-version 推不动它，下一次发版就要靠一个人记得改这两份文件——红的原因会是"忘了改"而不是"写错了"')
      }
    })
  }
  return out
}

const VERSION_TABLE_DOCS = ['SECURITY.md', 'SECURITY.zh-CN.md', 'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md', 'ITERATE.md']

test('每一格 `| X.Y.x |` 形状的活版本线都被一个位点登记着（第三格冒出来也逃不掉）', () => {
  assert.deepEqual(uncoveredVersionRows({ files: VERSION_TABLE_DOCS }), [],
    '对外文档里有一条活的版本线主张没有位点覆盖')
  // 位点侧同样要双向：SECURITY 那两位若被删掉，上面的普查必须抓到（上面已证），而这里证的是
  // 它们**确实是 line 位点**——普通位点写的是完整 semver，把它加到 `1.19.x` 那一格上，
  // set-version 会写出 `1.20.0.x`：一个渲染成垃圾的"修好"。
  for (const rel of ['SECURITY.md', 'SECURITY.zh-CN.md']) {
    const site = SITES.find((s) => s.file === rel && s.line === true)
    assert.ok(site, `${rel} 没有带 line: true 的版本线位点`)
    assert.equal(siteHitCount(site), 1, `${rel} 的位点正则命中 ${siteHitCount(site)} 次：0 次是漏，>1 是会改到别人的格子`)
  }
  // 反例（判据不是空转）：合成一份带活格子的文档，没有位点指向它 → 必须报，且报出文件与行。
  const fake = 'definitely-not-a-real-doc-SECURITY.md'
  const found = uncoveredVersionRows({ files: [fake], sites: [] })
  assert.equal(found.length, 1, `合成反例没被抓到：${JSON.stringify(found)}`)
  assert.match(found[0], /definitely-not-a-real-doc-SECURITY\.md: 普查清单里登记了却读不到/, found[0])
})

/** 发布安装命令的那四份文档（`updater/README.md` 不给安装命令，它只在 INSTALL_DOCS 里被闸守着）。 */
const COMMAND_DOCS = ['README.md', 'README.zh-CN.md', 'installer/README.md', 'mcp-shell/README.md']

/**
 * 这一族断言钉的是**判据**，不是某个路径名。
 *
 * 从前它钉的是 `-o /tmp/gp-install.sh && sh /tmp/gp-install.sh` 这个字符串本身，于是"分步写法"
 * 与"落在同机任意账号都能预先占住的固定名字上"被一起写成了契约——修掉后半段的那一刻，红的是
 * 这条本来想保住前门的名句（S10-7，2026-10-29）。现在这里只问两件事：给出的是不是分步写法
 * （拿得到真实退出码的那种），以及落点是不是由 `mktemp`/每用户私有目录造出来的。
 */
test('安装渠道闸在真树上是绿的，且那四份门面文档给的是分步写法（curl … | sh 不再是被给出的命令）', () => {
  assert.deepEqual(pipedInstallCommands(), [], '对外文档还在把管道当安装命令给出')
  for (const rel of COMMAND_DOCS) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8')
    assert.match(text, /curl\b[^\n]*-o \S+[^\n]*&&[^\n]*\bsh\b/,
      `${rel} 没有那条能拿到真实退出码的两步写法：它现在给出的安装命令是哪一个？`)
  }
  // 落点这一半分两层，两层都要有人看：本泳道写得动的文件判红，移交清单里的照样量出来并打印。
  assert.deepEqual(installLandingProblems(), [], '这道闸判得到的文件里还有 world-writable 目录的固定落点')
  for (const rel of ['README.md', 'README.zh-CN.md']) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8')
    assert.match(text, /GP_INSTALL_SH="\$\(mktemp/, `${rel} 里没有 mktemp 那一句：两步写法的落点必须自己说得出来源`)
    assert.match(text, /-o "\$GP_INSTALL_SH" && sh "\$GP_INSTALL_SH"/, `${rel} 的落点不再是那个一次性文件——这一行现在落在哪里？`)
  }
  // 移交清单不许变成"没人看的那一份"：任何一条不安全的落点，要么在 ENFORCED 里已经判红，
  // 要么在 HANDOFF 里被点名。第三条路（不安全 + 无人宣布）才是这道闸真正的洞。
  const audit = installLandingAudit({ rootDir: REPO })
  for (const entry of audit.unsafe) {
    assert.ok(INSTALL_LANDING_HANDOFF.includes(entry.file),
      `${entry.file}:${entry.line} 有一条 world-writable 固定落点，却既不在判红的集合里也不在移交清单里：改 mktemp，或把它并进 INSTALL_LANDING_ENFORCED`)
  }
  for (const rel of INSTALL_LANDING_HANDOFF) {
    assert.ok(!INSTALL_LANDING_ENFORCED.includes(rel), `${rel} 同时在 ENFORCED 与 HANDOFF 里：一份文件不能既由本泳道判红又由别人判红`)
  }
})

test('安装渠道闸两个方向都咬得住：命令形状红、散文不红、没有 curl 的行不红', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-piped-'))
  const write = (rel, body) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  try {
    write('README.md', [
      '```bash',
      'curl -fsSL https://example.com/install.sh | sh',
      '```',
      '',
      'The one-command install’s `curl … | sh` is "execute a remote script" — read it first.',
      'git clone https://example.com/install.sh',
      '',
    ].join('\n'))
    const problems = pipedInstallCommands({ rootDir: root, docs: ['README.md'] })
    assert.equal(problems.length, 1, JSON.stringify(problems))
    assert.match(problems[0], /^README\.md:2 把管道当成安装命令给出/, `报文要给出行号与该行原文：${problems[0]}`)
    // 报文要说得出**怎么改**，而改法不能再是那个 /tmp 名字（那正是 S10-7 要修的落点）。
    assert.match(problems[0], /mktemp/, `补救那句要给出一次性落点的写法：${problems[0]}`)
    assert.doesNotMatch(problems[0], /-o \/tmp\/gp-install\.sh/, '补救文案自己不许再教一遍固定落点：' + problems[0])

    // 对照①：分步写法不红（否则这道闸只会逼人删掉安装说明）。
    write('README.md', 'curl -fsSL https://example.com/install.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh\n')
    assert.deepEqual(pipedInstallCommands({ rootDir: root, docs: ['README.md'] }), [],
      '两步写法被判成管道：这道闸会立刻被放宽')

    // 对照②：登记了却不在磁盘上——不许静默当成"这一份没问题"。
    const missing = pipedInstallCommands({ rootDir: root, docs: ['nope/README.md'] })
    assert.equal(missing.length, 1, JSON.stringify(missing))
    assert.match(missing[0], /未观测，不是通过/, missing[0])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 落点闸（S10-7）：`curl … -o <落点>` 的那一步必须是 mktemp/私有目录给的。
 *
 * 三个方向都要能证红，因为这条判据的两个失败面相反：
 * ① 把同机任意账号可预先占住的路径放过去 → 前门自己递出覆写原语；
 * ② 把合法的一次性落点也判红 → 这道闸的唯一修法变成删掉安装说明（本仓对"会误红的闸"的下场
 *    写在残渣闸的注释里：它被放宽，然后失去保护）。
 */
test('落点闸三个方向都咬得住：固定 /tmp 红、mktemp 静、看不出来路的 $VAR 红', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-landing-'))
  const write = (body) => fs.writeFileSync(path.join(root, 'README.md'), body)
  try {
    write('curl -fsSL https://example.com/install.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh\n')
    const fixed = installLandingProblems({ rootDir: root, files: ['README.md'] })
    assert.equal(fixed.length, 1, JSON.stringify(fixed))
    assert.match(fixed[0], /^README\.md:1 把安装脚本落到 world-writable 目录里的固定名字/, fixed[0])
    assert.match(fixed[0], /1777|符号链接/, `报文要说清为什么这是个洞，而不只是"换个写法"：${fixed[0]}`)
    assert.match(fixed[0], /mktemp/, fixed[0])

    // 对照①：真树那份写法必须安静（README.md:154 就是这么写的）。
    write('GP_INSTALL_SH="$(mktemp "${TMPDIR:-/tmp/}gp-install.XXXXXXXX")" && curl -fsSL https://example.com/install.sh -o "$GP_INSTALL_SH" && sh "$GP_INSTALL_SH" && rm -f "$GP_INSTALL_SH"\n')
    assert.deepEqual(installLandingProblems({ rootDir: root, files: ['README.md'] }), [],
      'mktemp 落点被判成固定名字：这道闸会把安装说明逼没')

    // 对照②：`$HOME` 那一支也安静——每用户私有目录正是这条判据给的出路之一。
    write('curl -fsSL https://example.com/install.sh -o "$HOME/.cache/gp-install.sh" && sh "$HOME/.cache/gp-install.sh"\n')
    assert.deepEqual(installLandingProblems({ rootDir: root, files: ['README.md'] }), [],
      '每用户私有目录被判成 world-writable：这条判据就只剩"别写安装命令"一个修法了')

    // 反例：形似变量、实为固定路径。`GP=/tmp/gp-install.sh` 与写死的名字是同一个洞。
    write('GP=/tmp/gp-install.sh\ncurl -fsSL https://example.com/install.sh -o "$GP" && sh "$GP"\n')
    const disguised = installLandingProblems({ rootDir: root, files: ['README.md'] })
    assert.equal(disguised.length, 1, JSON.stringify(disguised))
    assert.match(disguised[0], /固定名字/, `一个赋值成 /tmp 的变量要按固定落点判：${disguised[0]}`)

    // 反例：变量没有任何来源证据（本行与前四行都没有 mktemp / $TMPDIR / $HOME）。
    write('curl -fsSL https://example.com/install.sh -o "$GP_INSTALL_SH" && sh "$GP_INSTALL_SH"\n')
    const noSource = installLandingProblems({ rootDir: root, files: ['README.md'] })
    assert.equal(noSource.length, 1, JSON.stringify(noSource))
    assert.match(noSource[0], /看不出它来自 mktemp/, noSource[0])

    // 移交侧：同一行在 HANDOFF 里必须是"打印而不判红"，且仍然被量到。
    fs.mkdirSync(path.join(root, 'installer'), { recursive: true })
    fs.writeFileSync(path.join(root, 'installer', 'README.md'),
      'curl -fsSL https://example.com/install.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh\n')
    const advised = installLandingAdvisories({ rootDir: root, files: ['installer/README.md'] })
    assert.equal(advised.length, 1, JSON.stringify(advised))
    assert.match(advised[0], /移交/, advised[0])
    assert.deepEqual(installLandingProblems({ rootDir: root, files: ['README-nothing.md'] }),
      ['README-nothing.md 在 INSTALL_LANDING_ENFORCED 里登记了却读不到——落点的这道闸今天对它什么都没核（未观测，不是通过）'],
      '登记了却读不到的文件不许当成"这一份没问题"')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('npm 包的三份门面 README 在文档闸的登记集合里（门面坏了就是前门坏了）', () => {
  for (const rel of ['installer/README.md', 'mcp-shell/README.md', 'updater/README.md']) {
    assert.ok(DOCS.includes(rel), `${rel} 不在 DOCS 里：它的死链、锚点与 shell 残渣今天无人点过`)
    assert.ok(fs.existsSync(path.join(REPO, rel)), `${rel} 登记了却不在树里`)
  }
  // `installer/` 与 `mcp-shell/` 的 `files` 清单里就写着 README.md——它是 tarball 里唯一的说明。
  const shipped = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')).files ?? []
  assert.ok(shipped('installer/package.json').includes('README.md'), 'installer 的 tarball 不再带 README：登记的理由变了')
  assert.ok(shipped('mcp-shell/package.json').includes('README.md'), 'mcp-shell 的 tarball 不再带 README：登记的理由变了')
})

test('文档闸的登记集合不因加入英文独有的门面文件而变出双语对偶要求', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-mirror-'))
  const write = (rel, body) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  try {
    write('README.md', '# x\n')
    write('README.zh-CN.md', '# x\n')
    write('SECURITY.md', '# x\n')
    write('SECURITY.zh-CN.md', '# x\n')
    write('CONTRIBUTING.md', '# x\n')
    write('CONTRIBUTING.zh-CN.md', '# x\n')
    write('CHANGELOG.md', '# x\n')
    write('ITERATE.md', '# x\n')
    write('engine/smoke.md', '# x\n')
    write('.github/pull_request_template.md', '# x\n')
    write('installer/README.md', 'curl -fsSL https://example.com/i.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh\n')
    write('mcp-shell/README.md', '# x\n')
    write('updater/README.md', '# x\n')
    const { problems } = check({ rootDir: root, docs: ['installer/README.md'] })
    assert.deepEqual(problems.filter((p) => /双语|对偶|缺腿/.test(p)), [],
      `把英文独有的门面加进登记集合，就给它变出了一个不存在的 .zh-CN.md 要求：${JSON.stringify(problems)}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// MARK: - 一条拒该是一句话，不是一个栈（S10-3 / S10-4 / S10-5，2026-10-29）

/**
 * S10-3：链接或锚点里一个裸 `%`（散文里"50%"这一类写法被抄进锚点）从前让
 * `decodeURIComponent` 抛 URIError，整条文档闸在文档循环中途带着栈退出——**后面的文档、
 * 全部可复算主张核对、全部表格形状那一轮一条都没跑**。修好之后这里钉的是两件事：
 * ① 那个坏转义自己是一句具名红；② 它后面那一份文档的缺陷照样被报出来（判据没有中途退场）。
 */
test('文档闸：锚点里的裸 % 是一句具名红，而不是把后面的核对一起带走的一个栈', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-percent-'))
  const write = (rel, body) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  try {
    // 第一份：锚点里一个裸 %（旧版本在这里抛 URIError，第二份根本没被读到）。
    write('README.md', '# Funds\n\n[出资说明](#funds-50%-covered)\n')
    // 第二份：一条真死链。它必须还在答案里——那是"闸跑完了整轮"的证据，不是判据自己的话。
    write('SECURITY.md', '[指引](specs/这一份文件不存在.md)\n')
    write('SECURITY.zh-CN.md', '# x\n')
    write('README.zh-CN.md', '# x\n')
    const res = check({ rootDir: root, docs: ['README.md', 'SECURITY.md'] })
    const escapes = res.problems.filter((p) => /含裸 %/.test(p))
    assert.equal(escapes.length, 1, JSON.stringify(res.problems))
    assert.match(escapes[0], /^README\.md: 同文档锚点含裸 %/, `报文要说清是哪份文件、哪种引用：${escapes[0]}`)
    assert.match(escapes[0], /%25/, `要说得出怎么办：${escapes[0]}`)
    const dead = res.problems.filter((p) => /相对路径不存在/.test(p))
    assert.equal(dead.length, 1, `坏转义之后的文档没被核对——闸中途退场了：${JSON.stringify(res.problems)}`)
    assert.match(dead[0], /SECURITY\.md: 相对路径不存在/, dead[0])
    // 跨文档那一支走的是第二个 decodeURIComponent，同样要安全解码。
    write('README.md', '# Funds\n\n[另一页](SECURITY.md#funds-50%-covered)\n')
    const cross = check({ rootDir: root, docs: ['README.md', 'SECURITY.md'] }).problems.filter((p) => /含裸 %/.test(p))
    assert.equal(cross.length, 1, JSON.stringify(cross))
    assert.match(cross[0], /跨文档锚点含裸 %/, cross[0])
    // 对照：写得对的锚点不许因为这条判据变红。
    write('README.md', '# Funds\n\n[出资说明](#funds)\n')
    assert.deepEqual(check({ rootDir: root, docs: ['README.md', 'SECURITY.md'] }).problems.filter((p) => /含裸 %/.test(p)), [],
      '合法的锚点被判成坏转义：这道闸会逼人把引用整段删掉')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * S10-5：残渣闸的围栏状态机只认 ```，而同一个文件里 `headingsOf` 与 `markdownTableProblems`
 * 两种都认 ⇒ 用 `~~~` 包住的示例命令被误红，而误红的补救（"放进 ``` 围栏"）对已经在一个
 * 合法围栏里的行自相矛盾。三个读者现在共用 `isFenceLine` 这一个判据。
 */
test('文档闸：~~~ 围栏里的示例命令不是残渣，搬到围栏之外必须立刻是', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-tilde-'))
  const write = (body) => fs.writeFileSync(path.join(root, 'README.md'), body)
  try {
    write('示例：\n\n~~~bash\nwc -l "$(printf %s f)"\n~~~\n')
    assert.deepEqual(shellResidue({ rootDir: root, docs: ['README.md'] }), [],
      '~~~ 围栏里的 shell 记录被残渣闸误红：这条判据与同文件另外两个读者口径不一致')
    // 反证：同一行搬到围栏之外必须红，否则上面那句"安静"只是因为判据根本没跑。
    write('正文一行：\nwc -l "$(printf %s f)"\n')
    const outside = shellResidue({ rootDir: root, docs: ['README.md'] })
    assert.equal(outside.length, 1, JSON.stringify(outside))
    assert.match(outside[0], /裸露的 shell 命令行/, outside[0])
    // 闭栏之后重新计数：`~~~` 关掉围栏，下一段正文里的裸露命令要能被看见。
    write('~~~bash\nwc -l "$(printf %s f)"\n~~~\nls -l "$(printf %s f)"\n')
    const afterClose = shellResidue({ rootDir: root, docs: ['README.md'] })
    assert.equal(afterClose.length, 1, JSON.stringify(afterClose))
    assert.match(afterClose[0], /README\.md:4/, `围栏关掉之后要从第 4 行重新计数：${afterClose[0]}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * S10-4：`check-kernel-corpus.mjs` 的 check 分支对一个"被 pin 点名、却落在目录上"的名字直接
 * `readFileSync` ⇒ ERR_FS_EISDIR 的栈，于是它后面那些语料文件、已安装包那条腿与 mcp-shell 那条腿
 * 本轮全没跑。`--record` 那两条腿 2026-10-28 已经改成"detect-then-write，一条拒是一句话"，
 * 这一支是那次修复漏下的另一半。判据复用文件里现成的 `nonRegularKind()`。
 */
test('kernel-corpus 闸：pinned 名字落在目录上是一句具名 drift，而不是 ERR_FS_EISDIR 的栈', () => {
  const CANONICAL = { 'fixtures/a.json': '{"a":1}\n', 'schemas/b.json': '{"b":2}\n' }
  const build = ({ asDirectory, alsoDrift = false }) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-corpus-eisdir-'))
    const write = (rel, body) => {
      const abs = path.join(root, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, body)
    }
    write('scripts/check-kernel-corpus.mjs', fs.readFileSync(CHECK_KERNEL_CORPUS, 'utf8'))
    const corpus = Object.entries(CANONICAL).map(([file, body]) => ({ file, sha256: sha256Of(body) }))
    write('harness/glasspane-harness/contracts/kernel-pin.json', `${JSON.stringify({ version: '0.1.9', corpus }, null, 2)}\n`)
    for (const [file, body] of Object.entries(CANONICAL)) {
      if (asDirectory && file === 'fixtures/a.json') {
        // 被 pin 点名的是字节；这里在那个路径上放一个**目录**。
        fs.mkdirSync(path.join(root, 'kernel', file, 'nested'), { recursive: true })
        continue
      }
      // 镜像里的另一份文件对不上 pin（也有的话），判据必须把它和目录那一支一起报出来。
      write(`kernel/${file}`, alsoDrift && file === 'schemas/b.json' ? '{"b":999}\n' : body)
    }
    write('mcp-shell/package.json', `${JSON.stringify({ name: 'glasspane-mcp', version: '1.0.0', devDependencies: { 'iterate-kernel': '0.1.9' } }, null, 2)}\n`)
    for (const [file, body] of Object.entries(CANONICAL)) write(`node_modules/iterate-kernel/${file}`, body)
    write('node_modules/iterate-kernel/package.json', `${JSON.stringify({ name: 'iterate-kernel', version: '0.1.9' }, null, 2)}\n`)
    return root
  }
  const runGate = (root) => spawnSync(process.execPath, [path.join(root, 'scripts', 'check-kernel-corpus.mjs')], {
    cwd: root, encoding: 'utf8',
  })
  // 对照：一棵干净的树必须退 0，否则下面那句"具名红"只是因为恒红。
  const clean = build({ asDirectory: false })
  try {
    const ok = runGate(clean)
    assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`)
  } finally {
    fs.rmSync(clean, { recursive: true, force: true })
  }
  const broken = build({ asDirectory: true })
  try {
    const dead = runGate(broken)
    const merged = `${dead.stdout}${dead.stderr}`
    assert.notEqual(dead.status, 0, '目录顶替了 pinned 的字节却报绿：这道闸就是在谎报')
    assert.match(merged, /fixtures\/a\.json: the pin describes bytes here, but this path is a directory/,
      `一条拒要说清是哪一份、是什么：${merged}`)
    // 这一句才是本条缺陷的本体：栈里出现脚本自己的行号 = 闸中途崩死，后面的腿一条没跑。
    // 本机实测的旧形状正是 `at sha256 (…/check-kernel-corpus.mjs:88:38)` 这一帧加上
    // `Error: EISDIR: illegal operation on a directory, read`（反向变异 D4 复现过）。
    assert.doesNotMatch(merged, /at .*check-kernel-corpus\.mjs:\d+/, `闸带着栈退出了（这就是 S10-4 的形状）：${merged}`)
    assert.doesNotMatch(merged, /EISDIR/, merged)
    // 具名拒不是退场：镜像里其余文件与 shell 那条腿的读数仍要在答案里。
    assert.match(merged, /1 problem\(s\) against the pin/, merged)
    const twoBad = build({ asDirectory: true, alsoDrift: true })
    try {
      const both = spawnSync(process.execPath, [path.join(twoBad, 'scripts', 'check-kernel-corpus.mjs')], { cwd: twoBad, encoding: 'utf8' })
      const text = `${both.stdout}${both.stderr}`
      assert.match(text, /schemas\/b\.json: mirror/, `目录那一支之后的字节漂移必须照样报出来：${text}`)
      assert.doesNotMatch(text, /at .*check-kernel-corpus\.mjs:\d+/, text)
    } finally {
      fs.rmSync(twoBad, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(broken, { recursive: true, force: true })
  }
})

