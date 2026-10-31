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

## 本轮发现 → 修复 → 具名测试（发现 24 条，修复 24 条，未修项 0）

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

覆盖面不足的领域（本轮补了其中 6 项，其余留给后续）：remedy 的"命令名是否真在 PATH 上"（本轮成闸）、
双入口 argv 全矩阵（本轮 9 格）、跨连接状态生命周期（本轮 1 格）、可选/inbox-gated 键的增删即红
（本轮改派生）、`chmod` 返回 0 而模式不粘的卷（本机造不出目录级现场，留接缝 + 具名用例，见
`DailyRound20261031LaneDPermissionTighteningTests` 的 `apply` 注入）。

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

见本文件末尾【收口】小节与 `engine/smoke.md` 的 2026-10-31 记录。
