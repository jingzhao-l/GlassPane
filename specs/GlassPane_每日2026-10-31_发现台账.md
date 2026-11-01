# 每日审查台账 · 2026-10-31（07:30 那条线，跨到 11-01 收口）

真源提示词：`tools/prompts/daily-glasspane-main.md`。范围＝主仓产品面（`engine/`、`mcp-shell/`、
`installer/`、`updater/`、`bridge/`、`scripts/`、`.github/workflows/`、`install.sh`、根与 workspace
的 `package.json`/lock、对外文档）；`harness/` 不审查不修改（10:30 那条线）。

## 开工状态与上一轮未收口的活

- 开工 HEAD `25815222`（版本线 1.26.0，tag `v1.26.0`，registry 两包 `1.26.0`），树里有三处在飞批次：
  1. 主树未提交：`mcp-shell/src/engine-client.ts`、`src/http-gateway.ts`、`test/dispatch.test.mjs`、
     `test/support/fake-daemon.mjs` + 两个未追踪测试。**判定＝真未落地**（`HOME_DEFAULT_SOCKET_TEXT`
     全仓零定义 ⇒ `tsc` TS2304，壳编不出来；`git log --all -S` 查无此符号）。
  2. `/private/var/tmp/gp-wt-sw1`（分支 `daily/main-20261030-sw1`，4 笔）与 `/private/var/tmp/gp-wt-sw2`
     （2 笔）。**判定＝已落地/被取代**：逐文件 `git diff main <b> -- <它改的那些路径>` 全部空输出
     （提交已进 main 的 `4099e484`/`6f28c491`/`2a6e019f`/`86f68527`/`2cd731cd`/`efccdb3a`）；两个工作树里
     未提交的 3 个文件经逐字节比对是 main 的**旧**版本（缺 `--check-*` 退出码句子、`.unverifiable`
     断言未改），即反向变异留下的现场，不是未落地的活。sw2 那个未追踪测试与 main 里的同名文件逐字节
     相同。
  3. 另线（不碰）：`.worktrees/harness-daily-20261029`、`/Volumes/Eng-Dev/.gp-harness-live-20261030`
     （`live/gp-h-20261030`，harness 线在飞的现场）。
- 基线（逐字命令，干净 worktree 放在**非受保护树**——第一次放 `/private/var/tmp` 被夹具自己的
  "沙箱不许落在共享暂存目录"判据拒掉，量出 85 条假红，移到 `/Volumes/Eng-Dev` 后重测）：
  壳 `node --test mcp-shell/test/*.test.mjs` 704 tests / 699 pass / **5 fail**；
  安装器 306 / 301 / **5 fail**；updater 735 / 735 / 0。

## 本轮发现 → 修复 → 具名测试（发现 31 条，修复 31 条，未修项 0；#25-#26 由本机套件抓到，#27-#29 由 CI 的 lane 现形——#27/#29 在 ubuntu、#28 在 macOS，本机都走不到那一档；#30-#31 在收口取证时发现，晚于 `v1.27.0` 那枚 tag，随 `v1.28.1` 发出）

| # | 发现（触发输入 → 错误行为） | 修在哪 | 具名测试 | 反向破坏 |
|---|---|---|---|---|
| 1 | `--state-dir X` 后 `trustSocket` 里 `$HOME/.glasspane/engine.sock` 被逐字拼两次 → "默认路径只有一个出口"红（3!==1） | `engine-client.ts` `homeDefaultSocketPath()` | `the two lookups are each spelled in exactly one source file` | 恢复内联拼法 ⇒ 该条红 |
| 2 | 上一轮留下的 `HOME_DEFAULT_SOCKET_TEXT` 未定义 ⇒ `npm run build` 失败，整套壳测的是旧 dist | 同上（删符号，改用真接缝） | `tsc` 本身 + `remedy-shell-quoting` | 编不出来就是红 |
| 3 | `where = quoteShellArg` 别名让 5 处参数位对引号闸隐身（扫描按名字放行） | `engine-client.ts` 直接写 `quoteShellArg(...)` | `every interpolated value inside a command-shaped literal …` | 保留别名 ⇒ 该条点名 5 处 |
| 4 | `installer/cli.js` 的 `dir`/`q` 用 `JSON.stringify`＝双引号，`df -h "/tmp/x\`;touch …"` 照抄即执行 | `bundlePlacementFailureText` 四处就地走引号助手 | 新 `installer/test/shell-quoting.test.mjs`（表 + 会咬人 + 真生产者） | 改回 `JSON.stringify` ⇒ 双引号档红 |
| 5 | `GP_E_SOCKET_TRUST`（壳自用码）落 `default:` 被答成 422 | `http-gateway.ts` 归 503 族 | `a code the daemon does not declare is never answered as the caller's bad request` | 删 case ⇒ 该条红 |
| 6 | 协议层选例子调 `spec.validate`，缺它的 spec 在**请求中途**抛 `TypeError` 并原样上线 | `dispatch.ts` 构造期具名拒绝（含 `engineMethod`） | `a spec without a callable validate is refused at construction, not mid-request` | 去掉断言 ⇒ 该条红 |
| 7 | 兜底 catch 把 `String(error)` 拼进 stdio 帧（HTTP 半边 `wireCause` 剥掉）＝半修 | `dispatch.ts` 细节进 stderr、帧留类型 + remedy | `a fault inside the shell is answered wire-safe…` | 还原 ⇒ 该条红 |
| 8 | 同一批里 `shellFaultRemedy` 收的是**工具名**而它按引擎方法分支 ⇒ `gp_act` 的故障说"sending this tool again is a real option: do that once" | `callTargetName` 换 `spec.engineMethod` | `a fault on a gp_act frame is answered about the ENGINE method…` | 改成 `spec.name` ⇒ 该条红，消息里出现邀请重发原话 |
| 9 | `Unknown tool: ${name}` / `Method not found: ${request.method}` 无界复述外来文本（4 MB + ESC） | `echoForeign()`（界长 + `escapeTerminalControl`） | `a protocol refusal echoes caller text bounded and control-neutralised` | 去掉壳 ⇒ 该条红 |
| 10 | `tools.ts` 四支 `GP_E_INTERNAL` 手臂把 `internal shell error: ${String(error)}` 放进 agent 会转述的结果 | `internalFaultAccount` / `reportInternalFault`（一个身体） | 新 `daily-20261031-internal-fault-wire-safe.test.mjs`（行为 + 静态 + 会咬人 + 句子只有一份） | 还原一支 ⇒ 2 条红 |
| 11 | 探针夹具缺 `probeListener`，且缺键判据只硬点名三把 | `fake-daemon.mjs` + 判据改从 Swift 派生 | `the fixture's probe_status reply is the daemon's probe_status key set` | 删夹具里的键 ⇒ 该条红 |
| 12 | 同一 `if let inbox` 块里 `ringEvictedEventsTotal` / `durationOverflowFramesTotal` 从不进夹具（2026-10-22 加的读数 e2e 永不可见） | 同上 | 同一条（派生要求全部条件键） | 删一把 ⇒ 该条点名 |
| 13 | `requiresDaemonRestart` 恒 `true`，`tools.ts:2433` 当判别器读；daemon 侧同一字段是算的 | `daemonRestartPending()` 三态 | `projectSet result states…`（true/false/null 三格）+ 工具面 null | 让它恒 true ⇒ 三格里两格红 |
| 14 | `update-state` 判(0600 常规文件)与读分三步 ⇒ 期间可被换成链接/别的文件 | `openOwnerOnlyForRead`（`O_NOFOLLOW` + `fstat` + 同 fd 读） | 新 `daily-20261031-update-state-read-shape.test.mjs` 的链接/目录两格 | 退回三步 ⇒ 链接那格读回了指着的内容 |
| 15 | 同一文件的 `current`/`latest`/`lastError.message`/`runtime.detail` 无界不转义上线；大小不设限 | `foreignValue` + `UPDATE_STATE_MAX_BYTES` | 同上（bounds + size + foreignValue 表） | 去掉 `foreignValue` ⇒ 两格红 |
| 16 | 重连后 `stateRoot`/`version` 不清零 ⇒ 报上一个 daemon 的自报值、按它决定往哪儿写盘 | `engine-client.ts` open 时复位（泳道提交） | `daily-20261031-hello-self-report.test.mjs` | 去掉复位 ⇒ 该条红 |
| 17 | 迟到回复的出路承诺"正文会写进 stderr"，而 sink 明确不写正文 | 句子改抄网关真写的形状（`50c2f4f5`） | `daily-20261031-late-reply-route-shape.test.mjs` | 改回旧句 ⇒ 该条红 |
| 18 | `SHELL_ONLY` 手抄清单漏 `GP_E_SOCKET_TRUST`，而 `errors.ts` 宣称全覆盖 | 派生集合相等判据 | `SHELL_ONLY 是一份派生集合的抄件，抄漏了就红` | 从名单删一项 ⇒ 该条红 |
| 19 | `--help` 第三档在两处手抄，与代码无钉 | `engine-client.test.mjs` 补路径段比对 | `the two lookups are each spelled in exactly one source file` 的第二半 | 改 help 里的路径段 ⇒ 该条红 |
| 20 | `updater/**` + `tools.ts` 70 处裸 `updater <verb>`（本机无该可执行文件，照抄 127；面板早已改真路径） | `updater/lib/invocation.js` 唯一出口 + 逐处改写 | `updater/test/remedy-command-invocable.test.mjs`（扫描 + 会咬人 + 分词 + 存在性/127 前提） | 任一处改回裸名 ⇒ 扫描那条红并点名 |
| 21 | `ownershipRefusal` 拼 `--apps-dir "<路径>"`（双引号仍展开） | 参数进 `updaterCommand(...)` | 同上 + `daily-20261022-updater` 的 argv 半边（升级成 shellWords 逐词） | 退回双引号 ⇒ 分词那条红 |
| 22 | `agent-entry.js` 被 launchd 指向独立拷贝，加 import 会让在册作业 ERR_MODULE_NOT_FOUND | 该支不印照抄命令（指针坏掉时无真路径可点名） | `agent-entry.test.mjs` 的 dirlink 两格（本项就是被它抓出来的） | 恢复 import ⇒ 该格红 |
| 23 | 文档里"工具契约三处镜像（kernel schema / daemon / mcp-shell）"与 PR 模板同句：`kernel/schemas` 实测不发布工具清单，且它是被钉语料（手改必被同步闸判红） | `CONTRIBUTING` 双语 / `ITERATE.md` / PR 模板 / `iterate.config.yaml` 改成两张真表 + 数据契约半边 | `check-doc-links`（可复算主张与真源一致） | 主张与实测不符时由该闸红 |
| 24 | `engine/smoke.md` 说 `--check-input-permission` 三态，探针实发两态（真机实测 granted）；lane-d 在表格单元里写裸 `\|` 把 3 格切成 4 格 | 两态改述 + 历史读数标注所属版本 + 竖线转义 | `DaemonPermissionVocabularyTests`（usage 取值表 ↔ 探针可发射值双向）+ `check-doc-links` 的表格格数判据 | 未转义 ⇒ 文档闸红（本仓真红过一次，见 `be4ab124`） |
| 25 | `StateRoot.tightenPermissions` 对**证据目录**只判 `chmod()!=0`，在忽略权限位的卷上 rc 0 而模式没粘 → 收尾打印"permissions tightened to owner-only"（一句本运行没做到的收紧，而这一行是给面板与 agent 当证据读的） | `tightenDirectory`：chmod 后回读 `st_mode`，不符就落进既有 notes 通道；两个目录站点共用它 | `DailyRound20261031LaneDPermissionTighteningTests`（6 条，含"控制那一档能红"的正对照） | 去掉回读 ⇒ "chmod 被接受但模式没粘"那一格红 |
| 26 | `test/support/fake-daemon.mjs` 常驻 `server.on("error", () => { throw })` 与 `listen` 上的 `once("error", reject)` 并存：路径不可用时抛进 uncaught，端到端崩成进程退出而不是一个具名判决 | 具名拒绝 + 运行中错误由 `stop()` 报出 | `the stand-in fails the way a daemon fails: a named rejection, not an uncaught throw` | 退回 `throw` ⇒ 该条拿不到 reject |
| 27 | **CI 现形（ubuntu lane）**：`--no-such-flag` 在 Linux 上 install.sh 回 1（平台句）、cli.js 回 2（参数句）；`--repo <非仓库目录>` 反向分叉。本机（darwin）永远走不到那一档 | 入口次序抽成 `entryDecision`：`--repo` 用法错 → 显式位判据（与主机无关）→ `--help` → 平台 → 未知参数 | `入口次序整表：非 darwin 那一档在两种主机上都是同一个答案`（7 串 × 2 平台） | 把平台判据挪到判据之前并去掉守卫 ⇒ 该行点名 `在 linux 上判成 platform`（实测红→恢复绿） |
| 28 | **CI 现形（macOS lane）**：`install.sh` 的 `sh_quote` 用 `case` 字符类判惰性，runner 的 en_US.UTF-8 下把 `é` 读成字母 → 印裸 `é`，而 `quoteShellArg` 印 `'é'`；两入口对同一值两种引号形状（Linux 上反倒一致） | 分类改按字节（`LC_ALL=C` 的 grep 判据），与 JS 表逐值同判 | `install.sh 的 sh_quote 与 installer/cli.js 的 quoteShellArg 逐值同判`（13 值 + `eval set --` 回读必须是 `$#=1` 逐字节等值） | 还原 `case` 那一支 ⇒ 在 UTF-8 locale 下 `é` 那一格红（本轮实测在 macOS runner 上就是它先红的） |
| 29 | **CI 现形（ubuntu lane，是 #27 那次收口的另一半）**：次序定成"平台判据先于未知参数"之后，三条**交付形状**闸（`daily-20261022-delivered-shape` 的 arg-error、`failure-exit` 的端到端 arg-error 与符号链接 bin）仍把"未知参数 ⇒ 2"当跨主机承诺写死 ⇒ ubuntu 的 `install-gate` 红 3 条，而本机 314/314 全绿看不见。根因与 #27 同族：一条按主机分岔的判据被当成普适契约钉进测试 | 三条各按平台分两支（沿用 `failure-exit` 里 2026-10-23 定下的纪律：按平台问哪一支该跑；既不把 darwin 那一支硬塞给 ubuntu，也不放宽成"1 或 2 都算过"）。非 darwin 那一支的句子从 `platformRefusal()` 取真源并断言其中**不含**"参数错误"；两支之外的共同不变量＝stdout 零字节、stderr 有字节且末字节是换行、绝不是"0 字节 + 退 0"（那 19 个版本的签名）。这一档次序同时写进 `installer/cli.js` 的 usage 页与 `install.sh` 的退出码那一格 | 改名后的那三条 + `入口次序整表：非 darwin 那一档在两种主机上都是同一个答案` + `非 macOS 上两入口的**码**仍然同答` | 把 `entryDecision` 里 usage-error 那一支挪回平台判据之前，再用 `NODE_OPTIONS` 注入一枚把 `process.platform` 定成 linux 的桩跑本机 ⇒ 四条具名红（交付形状那条、端到端 arg-error、整表、码同答）；恢复用 `/bin/cp` 备份 + `diff -q`（sha256 `41605e40…` 两侧逐字节相等）。**边界如实记下**：符号链接 bin 那一支本机证不了——`runInstalled` 的 env 是刻意最小的（只有 PATH/HOME/NO_COLOR），桩进不了那个子进程，它在桩下恒红是模拟的产物而不是产品缺陷；那一支的真验证落在 CI 的 ubuntu 格（本轮红的那三条就是它） |
| 30 | **收口取证时发现的、我自己造的那一条**：那 9 行的字节自己写着来历：**那次追加用的命令文本**（一块以 `node -e "` 开头、读 `smoke-record.md` 再 `writeFileSync("engine/smoke.md")` 的脚本，末尾还跟着几句 shell，heredoc 标记是 `XEOF`）被当成正文写进了被跟踪的文件。哪一层引号先收尾没有现场留下，这一行只陈述留下来的字节，不补一个我没量过的机制。它随 `82ef1416` 进了 main，也进了 `v1.27.0` 与 `v1.28.0` 两份签名归档，而 `check-doc-links` 一路绿（见 #31）。取证时我逐文件读尾巴才发现 | 删到第 1541 行（正文最后一句），文件以换行收尾；`git diff --numstat` 为 0 插入 / 9 删除，其余 1541 行一字未动（备份 `/var/tmp/glasspane-main-check-20261031/smoke-backup.md`） | 残渣闸本身（`updater/test/scripts-check-doc-links.test.mjs` 那 35 条里的两条：真仓库此刻零残渣 + 名单外那枚标记也要抓） | 把备份 `cp` 回去复跑 `node scripts/check-doc-links.mjs` ⇒ rc=1 且点名 `engine/smoke.md:1542 正文里有一行恰好是一枚全大写标记（XEOF）`（实测）；恢复后 rc=0，sha256 `3443a907…` |
| 31 | **#30 之所以能一路绿的根因**：残渣闸判据①是一份手抄的名字名单（`EOF/MSG/PY/SQL/OUT/YAML/JSON`），`XEOF` 不在里面；判据②的命令词也是手抄的（`echo\|wc\|printf\|cat\|sed\|grep\|ls\|nohup\|tar`），漏进去的那块是 `node -e "` 开头，两个名单都接不住。**同一形状在本仓第三次出现**（`SHELL_ONLY`、`tool-surface` 的 keep-list 都是这样红的），所以这不是"再补一个名字"的事 | 判据①改成形状：一行去掉空白后恰好是 `[A-Z][A-Z0-9_]{1,15}` 就算一枚 heredoc 标记；判据②不动（它的豁免形状由另两条用例钉着，见其注释），但边界如实记在下面那一节 | `shell 残渣闸：不在旧名单里的那枚标记（XEOF）也要抓到——名单形状改为形状判据`（2 条点名 + 围栏里那枚必须不红） | 把形状判据换回那份名单（同一文件、两处）⇒ 这条具名用例红（35 条里唯一的一条红，实测 `34 pass / 1 fail`）；`/bin/cp` 恢复后 `diff -q` 无输出、sha256 `99ba157f…` 两侧相等、35/35 复绿 |

覆盖面不足的领域（本轮补了其中 7 项，其余留给后续）：remedy 的"命令名是否真在 PATH 上"（本轮成闸）、
双入口 argv 全矩阵（本轮 9 格）、跨连接状态生命周期（本轮 1 格）、可选/inbox-gated 键的增删即红
（本轮改派生）、`chmod` 返回 0 而模式不粘的卷（本机造不出目录级现场，留接缝 + 具名用例，见
`DailyRound20261031LaneDPermissionTighteningTests` 的 `apply` 注入）、按主机分岔的判据写成普适承诺
（本轮 3 条改成两支，见 #29）、**残渣闸判据②那份手抄的命令词**（`echo|wc|printf|cat|sed|grep|ls|nohup|tar`，
`node -e "` 这一族不在里面；本轮只把①从名单改成形状，②仍是名单）。②没跟着改的理由写在它的注释里：
英文文档本来就靠"首词是命令词"这一半豁免，把词表放宽成"像命令"会误红人话——本轮已经被这样的
判据误红过一次（`harness/glasspane-harness/SYNCLOG.md:684`）。补它的确切做法：给②也加一条"整行是
一段被泄漏的脚本"的形状判据（例如含 `fs.writeFileSync(` 且不在围栏里），并在 125 份 markdown 上
先量零误红再进闸，而不是直接放宽。

## 判为不成立 / 不改的（各附证据）

- `GP_E_AX_UNAVAILABLE` / `GP_E_PROBE_UNAVAILABLE` 被答成 422：这是本仓**已文档化并双向测过**的分族
  （daemon 亲口答过的请求不进 5xx；`http-gateway.test.mjs:913` 正面钉着，`httpStatusForEngineCode`
  上方注释写明分族依据是"谁答的"而不是"谁坏"）。改它＝改对外契约，不属于缺陷处置。
- `glasspane --help` 退码、`needs-consent` 三道门给不出动作：代码与文案已各自给到真路径（面板
  `UpdatePanelLogic.swift:510/519`、CLI `policy.js`/`signature.js`/`check.js`），本轮把裸名换成
  `updaterCommand(...)` 后动作全部可执行。
- `DebugCapabilityProbe.ProcessRunner` 不 `waitUntilExit`：唯一生产调用点是 `main.swift:1213` 那支
  一次性 CLI（跑完即 exit），本机实测连跑 3 次 `--check-developer-tools` 后系统僵尸进程数从 2 变 0，
  没有可复现的累积；无本机可红的对照 ⇒ 不改（不改的理由也记在这里，不算"已在案"）。
- `--state-dir` 与 `--permissions` 同给时的警告与零写入：实测为真（note 说"reads no state"，目录里
  没有新东西），行为正确。

## 版本与发布判断

- 不另取号：1.27.0 由同日另一条会话写进版本线但 **tag/npm 两格都没发生**，本轮修复并进该号，
  CHANGELOG 在同一节里补记（新增 55 行、删 0 行）。
- minor 依据沿用 1.6.2 那条：本轮又动了退出码/参数语义（双入口 2）、对外报文（`requiresDaemonRestart`
  取值域、`GP_E_SOCKET_TRUST` 的 HTTP 状态）与出路文案（70 处），四条里三条被触碰。
- 面 A 基线：本轮有意增长（`tools.ts`/`engine-client.ts` 各 +45 等），单独一笔
  `chore(harness): 面 A 基线补记`，判据未放宽；面 A 22.19% / 面 B 20.80% 仍是"金样本身就超 10%"的
  既有事实。

## 真机与端到端读数

见下面【收口】那一节的 4-6 条，与 `engine/smoke.md` 的 2026-10-31 那一节（面板 31 个 `gp-*` 标识、
`kAXPressAction` 按得动且真换页、daemon 隔离根自报三席 granted）。

## 收口

1. **main**：本轮最后一笔 `3ddd6031`（`fix(installer)` #29 那三条判据），CI run 41228271824
   （event=push，十格）全 success。签名 tag `v1.27.0`（gpg `0929EA31DF4F7429F63FC53189D88B1D043A1298`，
   `git tag -v` 报"完好的签名"）指向它。
2. **发布三线**：GitHub Release `v1.27.0` 非草稿、`--latest`、target=`3ddd6031`、4 件资产；
   归档 4,812,704 字节 / 787 条目 / 21 条声明的命令与 schema 全在 / `grep -cE "(^|/)harness/"` 命中 **0**；
   本机 sha256 `88fd5c5e…663c4` == API `assets[].digest` == `SHA256SUMS-1.27.0.txt` 那一行（三处逐字相等），
   两份 `.asc` 用仓库内嵌公钥在隔离 `GNUPGHOME` 验签 rc=0。npm 两次 dispatch 都显式带 `--ref v1.27.0`
   （dry=41231290749、publish=41231339141，两个 job 的每一条前置判据步骤都 success），
   registry `--prefer-online` 下 `glasspane-mcp` 与 `glasspane-install` 的 latest 与钉名读数都 = 1.27.0。
3. **端到端**（跑的是发布归档，不是本机重建）：解包 → 树内 `npm pack` rc=0 → 装进干净前缀 rc=0 →
   `node_modules/.bin/glasspane-mcp` 是符号链接 → stdin 一条 MCP `initialize` 两条路径
   （`dist/index.js` 与那条 bin 软链）各回 171 字节、`serverInfo` 点名 `glasspane-mcp` / `1.27.0`。
4. **取号的后半程**：`edbee85e → 0c9e12a0（release: 1.28.0）→ f4df4693` 由同日另一条会话完成，
   `v1.28.0`（→ `0c9e12a0`）的 Release 与 npm 两包也都实测到位。**#30 与 #31 是在这两者之后才发现的**
   （取证时逐文件读尾巴），已发布的 tag 一律不动，所以这两条随 `1.28.1` 发出——patch 的理由是四条判据
   一条都没碰（状态文件字段、退出码集合、CLI 旗标、npm `bin` 声明），改的只有一份文档正文与一把闸的形状。
5. **一条我自己的读数差错（不改产品，只记账）**：`e2e.sh` 把 GitHub 的 `assets[].digest` 当 base64 解码，
   打印出一条假的 `match=no`；`sign-verify.sh` 改成逐字比形状 `sha256:<hex>` 之后同一条字节读出
   `local==api: yes` 与 `local==sums: yes`。被改的是脚本，不是判据。
6. **门禁逐字复跑的读数**（干净树 `3ddd6031`，日志在 `/var/tmp/glasspane-main-check-20261031/final-3ddd6031/`）：
   `npm ci`/`npm run build`/`npm test --workspaces --if-present` rc=0，三包分别 728/314/746 全 pass、0 fail、0 skipped；
   `check-version` OK（1.27.0，20 个位点）；`check-doc-links` 32 份 / 内链 270 / 外链 44 / 表格 459（扫 125 份 md）；
   `check-workflows --self-test` 46 条（27 个变异必须抓 + 19 个合法形状必须静默）、`check-workflows` 5 份文件 clean；
   `check-kernel-corpus` 26 份镜像逐文件核过、pin 与捆的版本同为 `iterate-kernel@0.1.10`；
   `swift build` rc=0；`swift test --package-path engine` 1577 XCTest / 5 skipped / 0 failures，
   同一次运行里 Swift Testing 66 tests / 7 suites passed；`swift test --package-path engine/probe` 58 / 1 skipped / 0 failures；
   `python3 -m pytest -q bridge` 201 passed / 1 skipped；`sh -n install.sh` rc=0；
   五把尺子：tool-surface 无新增（面 A 22.19% 是"金样本身超 10%"的既有事实）、surface-semantics 23 文件 0 命中、
   product-surface 6587 处一致 / 0 问题、brand-surface 血缘 9632/9632 扫 3330 文件、fork-diff 4637/6746 逐字节相同
   （288 改 / 114 增 / 1707 删）与在册分叉一致、hook-liveness 两把钩子离线核过绑定位；
   信号闸 `SIGNAL SMOKE OK`（SIGTERM/SIGINT 自退 0 且 socket 被 unlink，三次起停各自跑在点名状态根）；
   发布形态 `npm run bundle` + `npm pack --dry-run` rc=0，产出 `glasspane-mcp-1.27.0.tgz`。

