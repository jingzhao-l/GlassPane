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
 * REVERSE MUTATIONS（每条都点名它红在什么地方）：
 *   · 删掉 `ci.yml` 的 `macos-node-gate` → `ci.yml 里有一条 macOS job…` 红，报文点名两个 workspace。
 *   · 把那条 job 改成 `runs-on: ubuntu-latest` → 同一条红（ runner 换了就不是那条 job 了）。
 *   · 把两条 ubuntu Node lane 或它们的 `assert-test-count` 腿删掉 → `这条修法不是删腿` 红。
 *   · 从 `SITES` 删掉 SECURITY 那两位 → `每一格活版本线都被位点登记着` 红，报文点名 SECURITY.md。
 *   · 把任一处安装命令改回管道 → `安装渠道闸…` 红并带 file:line。
 *   · 让 `pipedInstallCommands` 无条件返回 `[]` → 它的合成反例红（"判据空转"那条）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SITES, siteHitCount } from '../../scripts/version-sites.mjs'
import { DOCS, check, pipedInstallCommands } from '../../scripts/check-doc-links.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHECK_WORKFLOWS = path.join(REPO, 'scripts', 'check-workflows.mjs')

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

test('安装渠道闸在真树上是绿的，且那四份门面文档给的是分步写法（curl … | sh 不再是被给出的命令）', () => {
  assert.deepEqual(pipedInstallCommands(), [], '对外文档还在把管道当安装命令给出')
  for (const rel of COMMAND_DOCS) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8')
    assert.match(text, /-o \/tmp\/gp-install\.sh && sh \/tmp\/gp-install\.sh/,
      `${rel} 没有那条能拿到真实退出码的两步写法：它现在给出的安装命令是哪一个？`)
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
    assert.match(problems[0], /-o \/tmp\/gp-install\.sh/, '它还得说出该改成哪一种写法')

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

