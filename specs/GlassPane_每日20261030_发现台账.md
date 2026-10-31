# 每日审查 2026-10-30（收口跨到 11-01）· 发现台账

工作树开工状态：`main` = `41f5917f`，`origin/main` = `a65c86f3`（本地落后 11 笔，逐笔查过全是
`[gp] … harness …` 那一格的产物，非本线待办），`git status --porcelain` 只有 `?? .worktrees/`
（10:30 那条线的在飞工作树 `.worktrees/harness-daily-20261029`，`status` 为空、HEAD 恰为
`a65c86f3`，不属本线写域，全程未碰）。盘余量开工实测 `df -k /Volumes/Eng-Dev` = 43,040,824 KB
（≈41 GiB），远高于 4 GiB 门槛；全程未出现 ENOSPC。

上一轮未收口的活：`git branch -r --list "origin/daily/main-*"` 为空、本地只有 `main` 与
`split/glasspane-harness`（后者是 subtree 搬运产物，由 tag 与 split 仓承载，不参与"是否落地"的判定）。
所以本线没有"往轮遗留未落地"这一格。

## 审查手段

`review-bugbot` / `review-security` 规定的子代理类型（`bugbot` / `security-review`）在本机不存在
（沿用 2026-10-29 台账记录的同一处置：按 skill 自身的"调用形状错了就改正后重试一次"条款，改用等价的
代码审查/安全审查子代理，分片跑同一份简报）。本轮 6 个分片：mcp-shell+installer+updater 正确性、
engine Swift（证据语义/socket/信号/CLI/面板）、探针与面板+脚本+workflows、三处工具面镜像一致性、
信任边界安全、UX 与功能缺口。8 条泳道（含两条 Swift 实现泳道）全部由主代理逐条回代码复核——
**泳道说的一律不算数**。

本轮新出现的边界（如实记）：两条 Swift 实现泳道与两条接续泳道先后被平台的 credit 上限中断
（`You've reached your credit usage limit`），其中两条在 harness/ 路径上被作用域守卫拦停。
它们留下的分支与未提交批次由主代理接手：`daily/main-20261030-sw1`（4 笔）、
`daily/main-20261030-sw2`（2 笔）已并入主线；两棵树里未提交的 F1 修复、F3 用法文案、B4 收尸与
其测试由主代理自己实现/收尾（B4 的 `ConsoleModel` 修改与 `S3` 反向变异都在主代理手里做完）。

## 基线读数（改代码之前，逐字命令）

| 门禁 | 实测 |
|---|---|
| `npm ci`（仓库根） | added 10 packages, audited 14, 0 vulnerabilities, rc 0 |
| `npm run build` | rc 0（`tsc -p tsconfig.json`） |
| `npm test --workspaces --if-present` | mcp-shell 683/683/0；installer 296（整批并跑时 1 条 C7 红，隔离复跑 296/296 绿 ⇒ 负载假红，判据未动）；updater 729/729/0（隔离复跑） |
| `node scripts/check-version.mjs` | 20 个位点全 `1.26.0`，rc 0 |
| `node scripts/check-doc-links.mjs` | 文档 32 份 / 仓内链接 270 / 外链 44 / markdown 表格 452（扫 123 份），rc 0（2 条 `△` 在 harness 写域） |
| `node scripts/check-workflows.mjs --self-test` | 35 例：21 条变异被抓、14 条合法形状沉默，rc 0 |
| `node scripts/check-workflows.mjs` | 5 个 workflow 文件 clean，rc 0 |
| `node scripts/check-kernel-corpus.mjs` | 26 份语料 == pin `iterate-kernel@0.1.10`，三条腿（mirror/pin/已安装包、mcp-shell）同号 |
| `swift build --package-path engine` | rc 0 |
| `swift test --package-path engine` | `Executed 1530 tests, with 3 tests skipped and 0 failures` |
| `swift test --package-path engine/probe` | `Executed 58 tests, with 1 test skipped and 0 failures` |
| `python3 -m pytest -q bridge` | 185 passed, 1 skipped |
| `sh -n install.sh` | rc 0 |
| 信号闸 `python3 .signal_smoke.py .build/debug/glasspaned` | SIGNAL SMOKE OK（SIGTERM/SIGINT 各自退 0 且 socket unlink） |
| 发布形态 `npm run bundle && npm pack --dry-run` | 31 个文件、shasum `be4105a5…`、8 份 schema 抄自 0.1.10 |
| `node harness/tools/tool-surface.mjs --check` | 面 A 12325 LOC / 21.60%（金样相等，无增长）；面 B 12040 / 21.10%，rc 0 |

## 本轮审出并已修完的缺陷（24 条，逐条有具名测试；一条在收口过程中新增）

编号规则：`A*`=mcp-shell，`B*`=engine Swift，`C*`=闸/发布链，`D*`=工具面一致性（判见下一节），
`E*`=信任边界，`F*`=UX/CLI/文档。每条的触发输入、失效模式、修法与覆盖用例的详述在 CHANGELOG 的
`[1.27.0]` 条目里，这里是清单。

| # | 层 | 一句话失效模式 | 覆盖它的具名用例 |
|---|---|---|---|
| A1 | mcp-shell | `tools/call` 形状拒绝的出路点名一个本壳必拒的工具（`gp_attach` + `{}`） | `daily-20261030-remedy-shape` 前两条（后者在发布物上复现过） |
| A2 | mcp-shell | 发布的 `.d.ts` import 一个只列在 devDependencies 的包 ⇒ 消费者 TS2307 | `daily-20261030-write-and-read-shapes` 末条 |
| A3 | mcp-shell | 出路让代理问 `--permissions` 要 state root，而那一支不印根 | `daily-20261030-remedy-shape` 后三条（含跨语言那条） |
| A4 | mcp-shell | D6 真机冒烟 import 被 `npm run bundle` 删掉的模块 ⇒ 文档里那一步是死的 | `daily-20261030-documented-smoke` 两条 |
| A5 | installer | 12 处把别人给的路径用双引号包着印成可照抄命令（`$(` 在双引号里照常展开） | `remedy-shell-quoting` 的源码半边（扫描集加 `installer/*.js` + vacuity） |
| A6 | installer | `--help` 的退出码表只解释 1 的三分之一 | `daily-20261030-entry-parity` 末条 |
| B1 | daemon | 归档的 handler/state 清单静默截断，报告又拿截断后的长度算 `+N more` | `DailyRound20261030SW2TruncationHonestyTests` |
| B2 | daemon | 收尾 waiter 线程与主线程赛跑同一个裸 `EngineCore?` 引用 | `DailyRound20261030Swift1ShutdownWaiterRaceTests` + `DailyRound20261028UsageAndHonestyTests` 源形状条 |
| B3 | daemon | `probe_status` 的空表把"这一面不存在"说成"这个 app 没接探针" | `DailyRound20261030SW2ProbeListenerTests` |
| B4 | 面板 | 一次性 CLI 超时后不收尸（僵尸 + 半修剪的注册表 + 两条 reader 挂着） | `DailyRound20261030SW2CLIReapTests` |
| C1 | 闸 | `check-doc-links --self-test` 有电池但 CI 从不跑它 | `daily-20261030-gate-wiring` 前两条 |
| C2 | 闸 | `△` 句声称"交给那棵树自己的闸"，实测那棵树没有这两条判据 | `daily-20261030-gate-wiring` 第三条 |
| C3 | 发布链 | `scripts/assert-tag-ready.mjs` 没有任何调用点（其判据在 CI 里由 `assert-ci-green` 承担） | 处置见「替 owner 做的决定」第 4 条；本轮由发布线实跑并记读数 |
| C4 | 闸 | 单行 `run:` 只审 `|`，不审 `&&`/`||`/`;` | `check-workflows --self-test` 新增两例（37 例） |
| E1 | mcp-shell | 壳对 socket 路径无身份判据（同 uid 植一个监听者即可让代理把假回包当引擎的话） | `daily-20261030-socket-trust` 11 条（含端到端 `heardFromWire==0`） |
| E2 | daemon | `.`/`..` 拼写绕过"这个根永不 chmod"的字符串比较 ⇒ 家目录被 0700 | `DailyRound20261030Swift1PathShapeTests` |
| E3 | mcp-shell | 注册表临时文件用 `"w"` 打开（跟随符号链接），而 daemon 三个写者都 O_EXCL/NOFOLLOW | `daily-20261030-write-and-read-shapes` 前两条 |
| E4 | mcp-shell | `update-state` 用 `statSync` 判模式与文件类型 ⇒ 链接目标被当本机事实 | 同上第三条（真符号链接） |
| F1 | daemon | 两席把 `hasRequestedThisRun`（每进程）当历史用 ⇒ 上次被拒说成"未请求" | `DailyRound20261030Swift1PermissionHonestyTests` + `ScreenCapturePermissionTests` 两支 |
| F2 | install.sh | `--repo --help` 两条入口两个码；修完第一版又量出 `--repo --no-prompt --help` 分叉（0 vs 2），第二版把闸挪到 usage 之前 | `daily-20261030-entry-parity` 前两条 |
| F3 | daemon | 三枚 `--check-*` 恒退 0 而 `--help` 不为它们说明"码不等于判决" | `DailyRound20261030Swift1CheckFlagExitHonestyTests` 两条 |
| F4 | 文档 | 环境变量表缺 15 条真被人读的旋钮（其中两条是 remedy 原话里让代理去设的） | `daily-20261030-env-docs` 两条（双向） |
| +1 | mcp-shell | 我自己的引号改动引出 5 条 installer 断言跟不上；其中 `quotedPaths()` 会退化成空集、三条"不许印 open"会恒真 | `bundle-apps.test.mjs` 的判据改为按 `quoteShellArg` 派生 + 负向判据换成三形态 |
| +2 | mcp-shell | 并行那条线（10-31 07:30）把我留下的另外 5 条回归修掉了（`0fb7ce04`…`af85a938`）；本文件据实记账，不重复劳动 | 见「并行运行与交接」 |

（发现 24 条 = 修复 24 条；"未修项"这一格为空。）

## 查过之后判定**不是缺陷**的（记下，免得下一轮又当新发现去"修"）

1. `harness/contracts/engine-methods.json` 这个路径不存在（我的简报写错了）。真源在
   `harness/glasspane-harness/contracts/engine-methods.json`，它钉的 `FrameCodec.swift` blob
   `git hash-object` = `ef48916061ad7c1b7160146872c062b8e747dea6`，与记录逐字相等——本轮没有动
   `FrameCodec.swift`，所以那把尺子没有红。**约束仍然成立**：任何对该文件的改动（含改注释）都会红
   `harness/tools/product-surface.mjs`（`ci.yml:301`），要动就得同批重记那份契约，而那属 10:30 那条线。
2. `mcp-shell/src/engine-client.ts` 的 `shutdown: 15_000` 一行"壳从不发送的方法也有 deadline"。
   实测 daemon 的 `EngineMethod.unadvertisedMethodWireNames`（`FrameCodec.swift:103`）**确实**应答
   `shutdown`，而 `hello.capabilities` 故意不广告它——这张表按 daemon 方法面完备，不是按壳的发送面。
   删它等于让将来的转发行人少一个上界。判非缺陷。
3. `ENGINE_PROTOCOL_VERSION = "0"` 不在 `scripts/version-sites.mjs`。它是**协议**版本，不是产品版本线，
   且有另一条跨语言钉（`shell-2026-defects.test.mjs` 重读 Swift 字面量）。判非缺陷。
4. `kernel/schemas` 里 5 份语料（convergence-round-state / invariant-report / reverification-request /
   run-plan / decision-log-entry）的 8 个字段在本仓零读者。实测它们的消费者在**别的仓**：
   `grep -rIl <name> /Volumes/Eng-Dev/iterate-skill/kernel | wc -l` 分别 4 / 20 / 4 / 19 / 26，
   字段级 `openFindings` kernel 6、`maxRounds` kernel 6、`durationMs` kernel 5 + fork 10。
   内核是跨三仓共享的契约，被钉语料不是本仓的第二真源——加消费者=范围扩张。判非缺陷。
   同一条判据也覆盖"档案按龄到期无配置路径"（`--evidence-stats` 已如实报 not enforced）与
   "面板无探针在线投影"（面板是人用的设置面，壳侧有 `gp_probe_status`）。

## 并行运行与交接（这一轮真实发生的事，不粉饰）

- 我把 12 笔提交推上 `origin/main`（`25815222`）之后，**同一个主工作树**被另一条线继续使用：
  它把我在主树里未提交的 5 处回归修复提交为 `0fb7ce04`/`774506ea`/`424a4686`/`2f73f96d`
  （10-31 08:08–08:10）并推上 main，随后自己又修了两条协议层问题（`c916eafc`、`af85a938`）。
  它的提交信息描述的是**我改的东西**，而实现与我略有分歧（例如我改测试夹具，它把
  `ToolSpec` 改成构造期就拒缺 `validate`）——两条路都收敛到同一判据，我按 main 的现状重跑并只补
  它没对齐的那一格（installer 的断言）。
- 它在 `c857de84` 里明确把**面 A 棘轮的 199 行**移交回本线（理由：那把尺子要的是"增长与造成它的那批
  代码同批提交"）。本线照它所说 `--record`，单独一笔 `chore(harness)`，正文写清是谁写的哪一段。
- 该线仍在飞、未提交的批次（`updater/lib/*` 17 改 2 新，含 `updater/lib/launchd.js` 一处
  `\\`` 语法错让 `installer/test/log-modes.test.mjs` 加载失败）：本线**未碰、未提交、未回退**，
  收尾树建在卷内独立路径重跑全部闸。它与本线改动是否重叠：`updater/*` 本线只在 `updater/test/`
  新加了两个文件（不冲突），`mcp-shell/src/tools.ts` 上它的在飞改动**叠在我已推的提交之上**——
  本线因此不再改 tools.ts。
- 另有 `.gp-lane-{a,b,c,d,e,f}-20261031`、`.gp-harness-live-20261030`、`.gp-main-baseline-20261031`
  六+一个工作树与 `fix/20261031-lane-*` 分支：不是本线建的，收口清理不动它们，只在汇报里点名。

## 替 owner 做的决定（依据 → 回滚命令）

1. **取号 `1.27.0`（minor）**。依据：上面那四条判据（退出码集合 / 对外报文与词表 / CLI 参数面文档 /
   npm 包依赖面）至少各破一条 patch 前提；`v1.26.0` 之后没有任何 tag，`npm view` 两包实测 1.26.0，
   远端 tag 实测无 `v1.27.*`。回滚：`git reset --hard <release 前一笔>`（本地）+ 已推的话
   `git push --force-with-lease=main:<旧 sha> origin <旧 sha>:refs/heads/main`；tag/Release/npm 的
   撤法见台账末节（tag 不删）。
2. **面 A 棘轮 `--record`**。依据：增长全部来自本线（10-30）与 10-31 那条线的 `mcp-shell/src` 有意
   修复；10:30 那条线已在 `c857de84` 里把它那 7 笔逐文件数过、声明一行都不是它写的并移交回本线；
   `--record` 前有逐文件归因（不是整树一把记）。回滚：`git checkout <前一笔> -- harness/contracts/tool-surface.json`
   （该文件属 10:30 写域，本线只按提示词授权的"面 A 基线补记"这一条动它）。
3. **`PermissionStatus.notDetermined` / `ScreenCapturePermissionState.notDetermined` 保留不删**。
   依据：那是发出去的 CLI 词表与 `--help` 取值表（`testRawValuesAreStable` 钉着），删它是改契约；
   本轮改的是"谁还能产出它"，实测已无探针产出。回滚：不需要（没有代码路径依赖它被产出）。
4. **`assert-tag-ready.mjs` 由发布线在打 tag 前实跑，不装 git hook**。依据：CI 侧真正拦不可逆的那道是
   `release.yml` 第一步 `assert-ci-green`（实测 `release.yml:101` 与 `:471` 两处），所以"顺序被执行"
   是有收件人的；把 pre-push hook 装进每个人本机需要一次 install 时副作用（扩面且 CI 不可复现），
   本轮判不做，改为**本线实跑该脚本并把读数记进台账**。回滚：无需。
5. **不动 harness/ 任何内容或版本**（10:30 那条线独立发布），面 A 金样是提示词明确授权的唯一例外。

## 未观测（只收物理边界那一类）

（收口时补：npm stage approve 若被 staged-only 拒；Apple 公证；面板真机走查若本机无登录会话。
本机有 GUI 会话，面板与 `--permissions`、`--state-dir` 三格本轮做完并记在 `engine/smoke.md`。）

## 反向变异表与收口清理盘点

见本文件末尾两节（门禁复跑后回填）。

## 反向变异表（每一发：把那一处逐字改回坏写法 → 具名用例变红 → `cp` 恢复 + `shasum -a 256` 核回）

| # | 打回的写法 | 变红的具名用例 / 判据 | 结果 |
|---|---|---|---|
| M1 | `connect()` 里去掉 `this.trust(...)` | `daily-20261030-socket-trust` → "refuses an untrusted socket BEFORE writing" | 红（具名）|
| M2 | 形状补救退回读 schema 的 `required` | `daily-20261030-remedy-shape` → "the shape remedy is not the params refusal…" | 红（具名）|
| M4 | 注册表 flags 退回 `"w"` | `daily-20261030-write-and-read-shapes` → "opens exclusively…" | 红（具名）|
| M5 | `update-state` 退回 `statSync` | 同文件 → "refuses a symlink planted at the state file"（2 行断言） | 红（具名）|
| M6 | `iterate-kernel` 退回 devDependencies | 同文件 → "declared as a runtime dependency" | 红（具名）|
| M7 | 一处 installer 命令位退回双引号 | `remedy-shell-quoting` → 源码半边点名 `installer/cli.js: "cliPath"` | **第一发 rc=0（闸是盲的）→ 记为本轮新发现并修闸（`79b09c92`）→ 复打同一发：红（具名）** |
| M8 | 关掉链式单行判据 | `daily-20261030-gate-wiring` → "the workflow gate's self-test counts every declared case, including the chained one-liner" | 红（具名；`--self-test` 那 37 例里的那一发也当场 NOT caught）|
| M9 | 移交句改回"交给那棵树自己的闸" | 同文件 → "no-receiver advisories say so…" | 红（具名）|
| M10 | 从 ci.yml 摘掉 `check-doc-links --self-test` | 同文件 → "CI runs the doc-links battery…" | 红（具名）|
| M11 | README 删掉一行旋钮 | `daily-20261030-env-docs` → "documented, in both languages" | 红（具名）|
| M12 | `install.sh` 的旗标形状闸失配 | `daily-20261030-entry-parity` → "两条一键入口对同一串 argv 给同一个退出码…"（连带另两条一起红）| 红（具名）|
| S1b | 输入监控席位退回 `hasRequestedThisRun ? unverifiable : notDetermined` | `DailyRound20261030Swift1PermissionHonestyTests`（2 条）| 红（具名）|
| S3 | 面板超时分支逐字改回 `terminate(); return nil` | `DailyRound20261030SW2CLIReapTests.testATimedOutOneShotIsReapedAndDoesNotLeakItsReadHandles`（句柄 3 → 5）| 红（具名）。**记一条诚实边界**：只删 `waitUntilExit()` 而保留 `closeFile()` 的那一发**不红**——Foundation 的 `Process` 在对象释放时会收尸，所以"僵尸"这一半从外面不可观测；这一支能观测的是两条 reader 的句柄归还。台账把这一点写死，免得下一轮把"僵尸"当成已证结论 |
| S4 | `probeListener` 恒答 `live` | `DailyRound20261030SW2ProbeListenerTests`（5 条，含"缺席一侧要把话说全"）| 红（具名）|
| S5 | `.`/`..` 判据退回恒不拒 | `DailyRound20261030Swift1PathShapeTests`（23 条断言，含机械那条：`home/proj/..` 把 home 从 0493 改成 0448）| 红（具名）|

（`git status --porcelain` 在电池结束后为空：每一发都 `cp` 恢复并 `shasum` 核回，全程没有用过 `checkout`/`stash`。）

## 收口读数

- 收口 HEAD 与 tag 见 CHANGELOG `[1.27.0]`；Release 非草稿、target 钉在收口 commit、归档 `grep -cE "(^|/)harness/"` = 0。
- 门禁终值（收口树上逐字复跑）：`npm test --workspaces --if-present` = mcp-shell 710/710/0、installer 306/306/0、updater 735/735/0；
  `swift test --package-path engine` = `Executed 1574 tests, with 3 tests skipped and 0 failures`（基线 1530，+44）；
  `swift test --package-path engine/probe` = `Executed 58 tests, with 1 test skipped and 0 failures`；
  `python3 -m pytest -q bridge` = 185 passed, 1 skipped；信号闸 OK；`sh -n install.sh` rc 0；
  `check-workflows --self-test` = 37 例（22 变异 + 15 沉默）；`check-doc-links --self-test` = 8 例（5+3）；
  `check-kernel-corpus` = 26 份 == `iterate-kernel@0.1.10`；`tool-surface --check` = 面 A 12627/21.88%、面 B 12040/20.86%，"no growth past the recorded baseline"。
