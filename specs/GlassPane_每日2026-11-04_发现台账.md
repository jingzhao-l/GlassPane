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

---

## 本线第二条会话（11-03 17:20 起，11-04 收口）· 发现 7 / 修复 7 / 未修 0

这一节记的是**同一天里第二条跑这条提示词的会话**。它开工时读到的是 `main == origin/main == f751572b`、
版本线 1.29.0、整树 0 行 dirty（`git status --porcelain`），随后与第一条会话（以及 harness 那条线）
在**同一个检出**上并发跑了两天。它的 7 条发现全部已经落在 main 上——但不是由它自己推上去的：
它每发现一条，先去 main 里指一遍；指得到的，就**删掉自己那笔重复提交**，不留两份结论（下面有 SHA）。

| # | 档 | 缺陷（发现时指得到的行） | 现在 main 上的落地证据（我逐条读过的行） |
|---|---|---|---|
| 33 | P1 | 超时臂把手里已有的采丢弃掉：`run_child_captured` 留字节，`run_outer` 从不读 | `bridge/glasspane_bridge.py:1482` `delivered, _delivered_raw = extract_sentinel(completed.stdout, nonce=nonce)` |
| 34 | P1 | `_async_mode` 只问 `GetAsyncMode`，真 binding 只有 `GetAsync`（本机实测 `HAS_GetAsync=True HAS_GetAsyncMode=False`），恒答 `False` | `bridge/glasspane_bridge.py:2821` `for name in ("GetAsync", "GetAsyncMode"):` |
| 35 | P1 | `cmd_trace` 的 `finally` 把没读到的值 `SetAsync(False)` 写回——一次新写入冒充恢复 | `bridge/glasspane_bridge.py:2837`（`neither SBDebugger.GetAsync() nor GetAsyncMode(), so its value …` 进 `errors[]`）与 `:2910` 注释 |
| 36 | P1 | 无载荷臂不唤醒被 attach 停在 SIGSTOP 的目标，兄弟两臂都醒 | `bridge/glasspane_bridge.py:1536` `woke, wake_detail = resume_frozen_target(args.pid)`（同臂另有 `About the target:` 一句） |
| 37 | P2 | 哨兵对里是 JSON 而非对象时 `payload.setdefault` 以 traceback 离场（§6.2 被破） | `bridge/glasspane_bridge.py:1354`、`:1724`、`:1868` 三处 `if not isinstance(payload, dict):` |
| 38 | P1 | `cmd_capture` 没有兄弟 `run_capture_cli_b64` 那层守卫；一抛就留 traceback，外层读成"没有载荷"并把病因写成"去勾 Developer Tools" | `bridge/glasspane_bridge.py:2495` 起：`cmd_capture/cmd_trace/cmd_watch` 三臂统一走 `guarded_command(…)` |
| 39 | P2 | CLI 的 `interactive` 永远交付不了（batch 从不 surface `gp-queue` 写的命令结果），却交回 `not-determinable` 并把人支去 `GLASSPANE_REAL_LLDB=1` | `bridge/glasspane_bridge.py:3165` `'interactive' is not a CLI mode: … Do it inside the session instead: … command script import …` |

外加一条开发期闸的缺陷（本会话自己提交并被并行 lane 收进 main）：**闸脚本被 import 时接管宿主进程**
——`scripts/check-doc-links.mjs` / `scripts/check-workflows.mjs` 的 `--self-test`、`--help`、不认识参数
三条出口写在模块顶层，宿主 argv 带这些形状时那份 import 它的测试文件**一条用例都不登记就报绿**
（带不认识参数时退 2 把宿主带走）。守卫 `isEntrypoint` 现在 main 上：`scripts/check-workflows.mjs`
7 处、`scripts/check-doc-links.mjs` 4 处命中；测试 `updater/test/daily-20261103-gate-import-safety.test.mjs`
在 main 上存在（本机 `git cat-file -e origin/main:…` 答 PRESENT）。

### 我自己丢弃的两笔提交（重复，未推）

`9ab8ed27`（fix(bridge)：上面 #33–#39 的实现）与 `c50d39c6`（docs(release)：1.29.1 条目补桥那六条）
留在本机 detached HEAD 上、**没有推**。判据不是分支名也不是提交信息，是逐行内容：上表右列那七处
在 `origin/main:bridge/glasspane_bridge.py` 里逐条读到过，且他们的 `guarded_command` 抽象比我那一版
写得好（三臂共用一层，我那时候只补了两臂）。留着就是两份结论指同一件事，而两份会漂。
复查这两笔：`git -C /Volumes/Eng-Dev/GlassPane show 9ab8ed27 --stat`（worktree 收掉后按 SHA 仍可取，
直到 `git gc` 回收）。

### 一次作废的本地复跑，和它换成 CI 读数的地方

这一轮我在 bench（`.gp-daily-20261103`，detached 在 `98cd514b`）上逐字复跑 16 条门禁，跑到第 09 条起
被并发清理把 bench 的文件删掉：第 11 条 rc=4、第 12 与第 16 条 rc=127（`sh -n install.sh` 找不到文件）、
第 09/10 条是 clang module cache 与 `swift-syntax` 克隆失败的**基建红**，而不是用例红。
所以本会话不对那一批本地数字下结论；同一棵树（= `v1.29.1` 指的那一笔）的**实际计数取自 CI
run `41760813134`（completed / success）**：XCTest `Executed 1577 tests, with 6 tests skipped and 0 failures`、
Swift Testing `Test run with 76 tests in 8 suites`、probe 侧 `Executed 2 tests, with 2 tests skipped`、
pytest bridge `218 passed, 6 skipped`、`check-workflows: 5 workflow file(s) clean`、
`--self-test` 两侧各 `48 case(s)` / `11 case(s) each verified`、`OK：版本线一致（1.29.1）`、
`文档 32 份 | 仓库内链接 272 条`、`iterate-kernel@0.1.10，与 pin 同号`、`no growth past the recorded baseline`、
`SIGNAL SMOKE OK`。补测这条本地复跑的确切命令：
`cd /Volumes/Eng-Dev/GlassPane && for c in "npm ci" "npm run build" "npm test --workspaces --if-present"; do echo "== $c"; /bin/bash -c "$c" || exit 1; done && swift test --package-path engine`。

发布物这一头是本机自己量的，没有借 CI：`gh release view v1.29.1` → `isDraft=false`、
`targetCommitish=98cd514b…`、4 件资产；`SHA256SUMS-1.29.1.txt` 里那枚 sha256
`a223547cf885c63d631197182f02e48915620aadc14cebdb384837bb0438ec98` 与本机下载的归档**逐字相等**；
`node scripts/make-release-archive.mjs --verify` rc=0（807 entries、4946685 字节、
30 条声明命令与 schema 全在、`harness/` 与 `.iterate_decisions.md` 下 0 条）；
`tar -tzf | grep -cE "(^|/)harness/"` = 0；gpg `完好的签名`、密钥
`0929EA31DF4F7429F63FC53189D88B1D043A1298`，与 `updater/lib/signature.js:119`
`PINNED_PRIMARY_FINGERPRINT` 逐字相等。registry 两包 `--prefer-online` 都回 **1.29.1**。

### 本轮我替你做的决定（依据 / 回滚）

1. **不推我的 bridge 实现**（依据＝上表右列那七行；回滚＝`git cherry-pick 9ab8ed27 c50d39c6` 若你
   认为我那版更合适——我不建议，`guarded_command` 的覆盖面更大）。
2. **不取新号**：`v1.29.1` 已被并行 lane 取号、tag、发 GitHub Release、发 npm（registry 实测 1.29.1），
   而 `main` 之后的字节是它正在写的下一版，不属于本会话的发现（依据：`git tag --sort=-v:refname` 与
   `npm view … version --prefer-online` 当场读数；回滚：无需，我没有动版本线）。
3. **不重记棘轮**：`node harness/tools/tool-surface.mjs --check` 在我机器上那次红，红的是
   **别人未提交**的 `harness/glasspane-harness/packages/opencode/**`（+18 `registry-readiness.ts`、
   +4 `build.ts`），`--record` 会把不属于本轮的字节洗进金样；CI 在同一 tag 上读的是
   `no growth past the recorded baseline`（依据：`/var/tmp/glasspane-main-check/closing/14-…log` 与
   CI 日志；回滚：无需，我没写 harness）。
4. **不关 dependabot PR #25、不碰 `harness/`**：它改的是 `harness/glasspane-harness/packages/core`
   与 `packages/opencode` 的 glob/minimatch，属 10:30 那条线；那条线此刻仍在同一棵树上写
   `dependency-floors` 那把尺子（文件 mtime 17:28/17:33 为证）。

### 未观测（只限物理边界，附补它的那一条命令）

- **面板 AX 走查**：本会话没有任何面板字节落地（我的实现被丢弃、#33–#39 都在 `bridge/`），
  所以这一格不是"我该验而没验的东西"，但它仍是"1.29.1 的面板没被本会话量过"。补：
  `engine/.build/debug/glasspane-settings --state-dir <临时根>` 起来后按 `gp-*` 标识走
  `kAXPressAction`（本机无 pyobjc，需自写 Swift AX helper；口径见 `engine/smoke.md` 11-03 那一节）。
- 桥的 #33/#35/#38 三条在真 lldb 的**活会话**路径上仍未端到端量过（本机只有 `--batch` 可用，
  `GetAsync` 的名字是拿真 lldb 量的，而采样那一臂需要真 attach）。补：
  `GLASSPANE_REAL_LLDB=1 python3 -m pytest -q bridge -k trace`。
