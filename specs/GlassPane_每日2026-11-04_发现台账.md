# 每日审查 2026-11-04 · 发现台账（复核确认并修复 24 条；泳道另交 14 条候选，本轮**未修**，逐条状态见第 5 节）

> 主仓 07:30 那条线（引擎 + MCP 壳 + 安装器 + 更新器 + 桥）。`harness/` 不在本轮范围（10:30 那条线）。
> 用法：本文件是本轮的**发现与处置**记录；按 `specs/**` 的规矩只新增、不改历史结论。

## 0. 开工时读到的状态（判据是文件字节）

- 开工 HEAD `71880044`（本地 main == `origin/main`）。整树 `git status --porcelain` 34 条，
  mtime 全在 2026-11-03 17:28–18:01 一个连续窗口内，分两批：
  - **本线未提交批（4 对）**：`scripts/assert-tag-ready.mjs` + 新测试、`scripts/make-release-archive.mjs`
    + `updater/test/release-archive.test.mjs`、`engine/**` 9 改 1 新（`DaemonInvocation.swift`）、
    `bridge/glasspane_bridge.py` + 新测试 `test_daily_20261103_bridge_payload_arms.py`。
  - **10:30 那条线的批**：`harness/**` 20 条 + `harness/tools/product-surface.mjs`。逐文件比对
    `harness/glasspane-harness/contracts/dependency-floors.json` 与 `.../script/dependency-floors.ts`
    两枚与 `gp-harness-advisory-20261103`（`dc05ec3e`，worktree `.worktrees/harness-advisory-20261103`
    干净）**同字节** ⇒ 那条线的活已提交在它自己的分支上，主树这一份是重复落盘。本轮按纪律不碰 `harness/`，
    保持原状并在汇报点名。
- **发布缺口**：main 上有 `release: 1.29.1` 提交，但 `git tag` 最新只到 `v1.29.0`、
  GitHub Release 列表无 `v1.29.1`、`npm view glasspane-mcp version` = 1.29.0、
  `npm view glasspane-install version` = 1.29.0 ⇒ 上一轮死在 push→tag 之间。本版号未对外发布过，
  因此本轮不另起号，把内容并进 1.29.1 并补记（理由写进 CHANGELOG）。
- 环境：`df -k /Volumes/Eng-Dev` 可用 10,771,692 KB ≈ 10.3 GiB（> 4 GiB 门槛，未触发清理）。
- 工作树：`.gp-daily-20261103`（detached，含 `bridge/glasspane_bridge.py` 一份与主树**不同**的改动，
  属上一轮）、`.worktrees/harness-advisory-20261103`（10:30 线）。
- 本轮第一个动作：`git worktree add /Volumes/Eng-Dev/.gp-daily-20261104 -b daily/main-20261104 main`，
  改动与提交都在那棵干净树上做——主树被 10:30 线的未提交批占着，而 `brand-surface`/`tool-surface`
  两把尺子会读到它（实测：主树里 `brand-surface` 因 `harness/…/setup-git-committer/action.yml`
  被他们删掉而回 `CANNOT MEASURE`、`tool-surface` 因他们的 `registry-readiness.ts +18` 而报面 B 增长，
  两笔都不是本轮造成的红）。

## 1. 发现与处置（24 条）

| # | 严重度 | 位置 | 失效模式 | 处置 | 提交 |
|---|---|---|---|---|---|
| 1 | P1 | `assert-tag-ready.mjs:165` | tip 判据读本地跟踪引用 ⇒ tag/Release/npm 钉在旧 sha | 现问 `git ls-remote`；3 条用例含正对照 | `d3523d20` |
| 2 | P1 | `make-release-archive.mjs:74-92` | `REQUIRED_IN_ARCHIVE` 只照抄 selfcheck 三行表，少 10 枚 ⇒ 归档装得上却装不上 | 改由两个读者推导；夹具补形状 + 拿文件必须拒 | `107adf68` |
| 3 | P1 | 桥 超时臂 | 丢弃已到手带 nonce 的完整采 | 先读字节再判；超时降为附注 | `2952fad3` |
| 4 | P1 | 桥 无载荷臂 | 不唤醒被 SIGSTOP 的目标（兄弟两臂都醒） | 三臂一致，唤醒判决与 remedy 单一出处 | `2952fad3` |
| 5 | P1 | 桥 `run_outer` | 载荷是 JSON 数组时 `setdefault` 抛 traceback | `deliverable_payload` + `merge_payload_notes` | `2952fad3` |
| 6 | P1 | 桥 `cmd_*` ×4 | 无守卫 ⇒ lldb 内留 traceback，外层写成"去勾 Developer Tools" | `guarded_command`/`emit_to_session`（单通道） | `2952fad3` |
| 7 | P2 | 桥 `cap_retained_output` | 上一轮实现了却没测（钳留上界） | 补 9 条：窗口/最右哨兵存活/开头诊断/上载荷 | `2952fad3` |
| 8 | P1 | 桥 `_arm_watchpoint` | 真绑定只有 int 重载 ⇒ 生产上每次武装失败 | 交裸整数 + 桩按真签名形状 | `2952fad3` |
| 9 | P1 | 桥 `_disarm_watchpoint` | 真绑定无 `Disable` ⇒ 槽位永不让出；桩背书假 API | 先 `SetEnabled(False)` 再 `Disable`，都没有则拒且留句柄 | `2952fad3` |
| 10 | P2 | 桥 状态名闭集 | 缺 `eStateStepping`（=7）；`eStateAttached` 本机不存在而注释替它背书 | 补名 + 向真绑定要名单的测试 | `2952fad3` |
| 11 | P1 | `DaemonInvocation.swift` | `Bundle.main` 在面板/xctest 里不是 daemon（三条红） | 只有真是 daemon 才自报，否则在册安装位 | `eb459957` |
| 12 | P2 | Swift 出路 3 处 | `node installer/cli.js --restore-launchd` 在代理 cwd 里不存在 | 改 `npx glasspane-install …` | `eb459957` |
| 13 | P2 | `HumanInterventionAuditTests` / `tools.test.mjs` | 新拼写下扫描器抓到 0 枚＝空跑 | 扫描形状两形都认 | `eb459957` |
| 14 | P1 | `mcp-shell/src/io.ts` | 逐段 `toString` ⇒ 屏幕文本被静默改写成 U+FFFD | 一条帧一次解码（18 切点实测） | `b9b63431` |
| 15 | P2 | `io.ts` 超限支 | 头部窗口未含当前段 + 该段字节没计入 | 一并修，两条 io 用例转绿 | `d938af90` |
| 16 | P2 | `http-gateway.ts` 2 条 501 + `stdio-session` USAGE | 印裸 `glasspaned`（127） | `daemonCliCommand` 一处出口；USAGE 改叙述 | `d938af90` |
| 17 | P1 | 引号判据（赋值位） | 汉字存在即跳过 ⇒ `GLASSPANE_INSTALL_DIR="$( )"` 整条在闸外 | 赋值位单独认 + 非空转对照 | `2f7ca4c8` |
| 18 | P1 | 引号判据（`git ls-remote`） | `git` 不在动词名单、远端名不算路径类 ⇒ 注入面看不见 | 精确补一枚 + 对照 | `2f7ca4c8` |
| 19 | P1 | `support/source.mjs` | 正则剥注释：文档里 `installer/*.js` 的 `/*` 吃掉 ~4.5 KB 真代码 | 词法走读 + 4 条自测 | `2f7ca4c8` |
| 20 | P1 | `installer/cli.js:2905` | 双引号里 `$( )` 展开（照抄即执行） | `quoteShellArg`；测试按 shell 词法判 | `471726cf` |
| 21 | P1 | `installer/cli.js:3084` | 远端名裸插值到参数位（`git remote` 可控） | 同上 + `argvTheReaderWouldHandGit` 类判据 | `471726cf` |
| 22 | P2 | `install.sh:418` | 打印 `'--depth 1'` 一枚参数（真 git unknown option，实测） | 按其自身注释保留两个词 + 3 条测 | `471726cf` |
| 23 | P2 | `daily-20261027` 断言 | 把双引号那一形钉成期望（钉的是缺陷） | 跟 `quoteShellArg` 语义 + 加"不许展开面" | `ee363bae` |
| 24 | P2 | 文档诚实性 4 条 | README「不会离开」自相矛盾；SECURITY「从不 spawn lldb」假 + 行号漂；`UpdateModel` 七道 vs eight gates；workflow 注释与闸实际范围不符 | 逐条改口（反向破坏：`swift` job 改回 `@v4` → 闸点名并 rc=1） | `ee363bae` |

## 2. 反向验证（先证明能红）

| 破坏处 | 结果 |
|---|---|
| `install.sh` 模板改回 `$(sh_quote "$_depth")` | `浅仓出路里的 --depth 与 1 抵达 git 时是两个词` 具名红；按 sha256 核回（`e43acd6b…` 两枚相同），复跑 rc=0 |
| 引号摘掉（两处：`cleanDirHint` / `remote.remote`） | `check-workflows`… 不，是 `remedy-shell-quoting` rc=1 并点名两枚 |
| 注释剥离器用回两条正则 | `支持 installer/*.js 写法的那条判据` 报 `inspected` 里没有 `git ls-remote`＝看见"看不见" |
| `DaemonInvocation` 改回恒用 `Bundle.main` | 3 条 XCTest 红（`swift test` rc=1） |
| `ci.yml` 一枚 action 改回 `@v4` | `check-workflows` rc=1：`job "swift" runs actions/checkout@v4 …` |
| `cap_retained_output` 只留 tail | `最右那对哨兵活下来` 与 `开头诊断活下来` 红 |
| `_arm_watchpoint` 交回 `SBAddress` | 新用例 `WatchAddress raised TypeError` 那支红（桩按真签名形状才测得到） |

## 3. 门禁逐字命令的读数

见 CHANGELOG 的 1.29.1 小节与本文件末尾【收口】第 4 条（收口态实际计数在跑完后填入汇报）。

## 4. 本轮我替你做了哪些决定

1. **不另起版本号，把 11-04 的内容并进 1.29.1。** 依据：v1.29.1 从未打过 tag、registry 读 1.29.0
   （实测两条），保留空号只会再造一次"1.28.1 那号从未成 tag"。回滚：`git revert <release 提交>`；
   已发布 tag 一律不动。
2. **改动落在隔离工作树 `.gp-daily-20261104`。** 依据：主树被 10:30 线的未提交批占着，
   实测两把尺子（`brand-surface`、`tool-surface`）会读到他们的字节，红不可归因。
   回滚：`git worktree remove`（收口时按【收口清理】做）。
3. **`.worktrees/harness-advisory-20261103` 与 `gp-harness-advisory-20261103` 本轮不删不并。**
   依据：内容属 10:30 那条线（`git log main..<b>` 有 1 笔 `dc05ec3e` 未进 main），纪律要求不碰
   `harness/`、不替别的线合并。判据：主树那 20 条 `harness/` 脏文件与其同字节。
4. **棘轮不重记面 B。** 主树里 `tool-surface` 报的面 B +20 是 10:30 线未提交的
   `registry-readiness.ts +18`/`build.ts +4`；本轮只在干净树里为本轮自己的 engine 增长重记
   （见 `chore(harness)` 提交），不用 `--record` 洗非本轮的红。
5. **桥的 `interactive` 在 CLI 侧当场拒**（上一轮实现、本轮补测）：批式 lldb 永远给不了活会话，
   `choices` 保留 `interactive` 不说谎。依据：模块确实有这一模式，缺的是会话。
6. **README/SECURITY 四处主张改口而不是加实测**：能指到代码位置的说法才留。

## 5. 未纳入本版的候选（14 条）——状态与判据

评审泳道还交回下列候选。**它们没有被本轮修掉**，也**没有被本轮否证**；我逐条给出处置与判据，
避免"下一轮再看"式的沉默：

| # | 位置（泳道原话） | 我的判断 | 为什么不在本版 |
|---|---|---|---|
| A | `EvidenceTabView.swift:465/476`、`ProjectsTabView.swift:236` 等禁用理由只在 `.help` | 未由我复核到代码位置 | 本轮后期我的改动可靠性下降，SwiftUI 多点改文案+重建+真机 AX 走查未做完 |
| B | CLI 三处"未注册 id"退码不一（1/3/1） | 未复核 | 会动退出码集合 ⇒ 按判据要升 minor，需你侧确认口径 |
| C | `UpdatePanelLogic.swift:510/519` `updaterPath` 未过引号 | 未复核 | 同 A（Swift 侧需重建） |
| D | `engine-client.ts:1189` 丢掉 `onLine` 的第二参数 `raw` | 未复核 | 触及 #16 提交后的门禁，未再跑全量 |
| E | `http-gateway.ts` zod issues 直接当 remedy | 未复核 | 同上 |
| F | `http-gateway.ts` 对 daemon remedy 跑 `forHttpCaller` 改写 | 未复核 | 同上 |
| G | `EngineCore.swift` 若干路径未过 `redactHome` | 未复核 | 同 A |
| H | `EvidenceStore` prune 顺带删 `.tmp-*` 不上账 | 未复核 | 判定语义改动，需 Swift 侧测试 |
| I | `AXChannel` depth 24 停止展开却回 nil ⇒ 写成确定负例 | 未复核 | 同上，且是产品核心诚实性 |
| J | `check-doc-links.mjs:111` slug 与 GitHub 锚不一致 | 未复核 | 改动会影响全仓锚点判定 |
| K | `installer/cli.js:1742` 用被验树自带公钥验签 | 未复核 | 涉及信任链，需单独一轮 |
| L | `updater/cli.js:276/360` 两同义旗标静默取一、`homeDir` 提前求值 | 未复核 | 更新器状态根是风险路径 |
| M | `ageRetention` 发布却零读者 | 未复核 | 要动面板与壳 |
| N | 若干注释/行号漂移 | 部分已修（#24） | 其余同上 |

补做它们的入口命令逐条同形：先在 `engine/`、`mcp-shell/`、`updater/`、`installer/` 里复现该形状
（写一条会红的测试），再决定改代码还是改文档。
