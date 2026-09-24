# GlassPane 全量审查与 UI 迭代记录 — 2026-09-22

- 性质：一次性全量代码审查 + 缺陷修复 + 设置面板控制台化（非实施契约，实施契约仍以 P0–P6 规格为准）
- 范围：`engine/`（Swift daemon + SwiftUI 面板）、`kernel/`、`mcp-shell/`、`bridge/`、`installer/`、`install.sh`，共 ~13.6k 行源码
- 基线（本轮开始前，全部实测）：`swift test` 374 通过（1 skip）／kernel 51／mcp-shell 71／bridge 17／installer 48
- 收尾（本轮结束后，全部实测）：`swift test` **390** 通过（1 skip，0 失败）／bridge **19**／installer **52**／kernel 51／mcp-shell 71

> **并行会话提示（如实声明）**：本轮执行期间，另一会话在同一工作副本上持续改动
> `kernel/`、`mcp-shell/src/tools.ts`、`engine/Sources/glasspaned/main.swift`、
> `engine/Sources/GlassPaneEngine/EvidenceModels.swift` 以及面板的
> `SettingsPanelView.swift` / `ConsoleTheme.swift`（git log 期间新增 34cd904 / 927805c / 0340e6a 三笔）。
> 因此：**本轮未提交任何改动**，且 TS/kernel 侧的 A 级发现**故意没有动手**（见 §4）。

---

## 1. 结论摘要

审查发现 **18 项 A 级**（真实缺陷或违反"未测量即不上报"的诚实底线）、**约 20 项 B 级**、若干 C/D 级。

本轮已修 **9 项 A 级 + 3 项 B 级**，全部带回归测试；其余按 §4 的清单如实留档，未修的没有一项是"没看见"。

三条最值得说的：

1. **设置面板此前只有一页权限引导**，而磁盘上已经躺着 561 条证据档案、68 条项目注册项、一整条审批签名链——没有任何人类界面。本轮把它做成四页控制台（§2）。
2. **每次跑 `swift test` 都在污染用户真实的 `~/.glasspane/projects.json`**：`EngineP1Batch6Tests` 用默认路径构造 `ProjectRegistry`，实测已累积 68 条 `com.example.app` 假项目；`maxProjects=128` 触顶后真实项目注册会直接 `GP_E_PROJECT_LIMIT`。已修源头并给出清理通道（§3.1）。
3. **审批闸是一条死闸**：高风险 `restore` 由 `daemon:auto` 自批并写进不可抵赖的签名链，且登记时机在动作**之前**——链上留下了"restore executed"而实际可能中途失败或根本没执行。已修登记时机与措辞（§3.2）；"人类审批入口"本身仍缺，需要新增 GUI↔daemon 交互面，属规格级决策（§4-B1）。

---

## 2. UI 迭代：从一页引导到四页控制台

### 2.1 改造前实测到的具体问题

| 问题 | 证据 |
|---|---|
| 无任何导航，全部内容堆在一页，窗口下半部大片空白 | 真机截图（900×592 窗口，内容约 700pt 单列） |
| 顶部"要拖的图标"是 `Image(systemName: "app")`，渲染成一个空框，看着像渲染坏了 | `SettingsPanelView` 原 237 行 |
| 每张卡三个地方重复说同一状态：徽标"已授权" + 绿色对勾 + 一个灰掉的"已授权"按钮 | 原 427–442 行 + 490 行 `.disabled(status == .granted)` |
| 已授权时点按钮是 no-op：`guide()` 里 `if granted { return }`，用户点"查看"没反应 | `SettingsModel.guide` 原 138 行 |
| daemon 状态是一坨 monospaced 键值裸 dump，长路径换行撑破卡片 | 原 `statusRow` 180–191 行 |
| "缺少时："前缀在四条文案里只写了 2 条，面板自己再加一次就变成"缺少时：缺少时：" | `PermissionStatus` 100/106/112/118 行 |
| 561 条证据 / 68 个项目 / 38 条审批记录完全无人可读 | `~/.glasspane/` 实测 |

### 2.2 现在的结构

```
NavigationSplitView
├ 侧栏  首次使用：权限（默认落点）
│       日常审计：证据档案 · 项目 · 审批台账   （各带条数徽标）
│       底部常驻：后台服务存活点 + glasspaned 版本 + 全局刷新
├ 权限   总览条（还差几项、差哪几项）→ 拖拽引导（真实 app 图标）→
│        引导横幅 → 四张权限卡 → 后台服务卡 → 不勾选会怎样
├ 证据   筛选（全部/未确认/有人同时操作/已降级/有诊断/断言未过）+ 搜索
│        左列表右详情；详情按通道分块：操作/界面结构/画面像素/归因/
│        性能熔断/断言/诊断/内部状态/进程存活/探针命中
├ 项目   注册表列表 + 残留识别 + 详情（ID/被测应用/证据条数/三类路径）
└ 审批   签名链校验横幅 + 逐条台账（风险/结论/主体/原因）
```

新增文件：`ConsoleRootView.swift`、`ConsoleModel.swift`、`ConsoleTheme.swift`、`EvidenceTabView.swift`、`ProjectsTabView.swift`、`ApprovalsTabView.swift`、`LocalArchive.swift`（engine 库内的纯读侧数据面）。

### 2.3 守住的契约（真机验证，不是纸面推断）

- **P1-C6 冒烟 `engine/.c6_smoke.py` 全绿**：四权限卡图标 identifier、每卡的跳转 AXButton + 文本行、≥12 个 AXStaticText（实测 38）、降级折叠 AXDisclosureTriangle、窗口标题 `GlassPane 设置`。
  - 中途真踩到一次：各页 `.navigationTitle` 把窗口标题顶成"权限"，冒烟 `FAIL window title missing`。已改为标题只在根设一次、页名走页内 `PageTitleView`。
- **§11.7 渲染状态可核验化不破**：`gp-perm-<kind>-<status>`、`gp-guide-<kind>`、`gp-verify-developer-tools`、`gp-restart-daemon`、`gp-refresh`、`gp-devtools-*` 全部保留，状态仍由"形状 + identifier"双表达。
- **新页签可被自动化驱动**：侧栏最初用 `List(selection:)`，其行在无障碍树里是 **AXStaticText**，`act` 按标识选不中也按不动——已改成显式 `Button`，实测 `gp-nav-evidence / gp-nav-projects / gp-nav-approvals` 三个 `act` 全部 `actConfirmed=true`，并据此截到三页真机图。
- **§6.5 冻结面未动**：不新增 socket 方法、不新增 MCP 工具、不碰 evidence/decision-log/recipe schema。控制台读的是已落盘文件（`~/.glasspane/evidence`、`projects.json`、`approvals.json`）。
- **文案面向用户**：面板字符串不含 §引用与实现自辩；规格编号只留在代码注释。

### 2.4 面板不直接写盘（重要设计约束）

运行中的 daemon 内存里持有一份注册表，面板直接覆写 `projects.json` 会被它下一次写盘**静默冲掉**。因此所有写入只有一条路径：面板 → daemon 一次性 CLI → 磁盘 → 面板提示"重启后台服务才生效"（复用既有 `restartDaemon()`，实测横幅 `gp-restart-after-prune`）。

---

## 3. 本轮已修（全部带回归测试）

### 3.1 Swift 引擎 / 面板

| # | 位置 | 问题 → 修法 | 测试 |
|---|---|---|---|
| A-1 | `EngineP1Batch6Tests.swift:170` | 测试用默认路径构造 `ProjectRegistry`，每次 `swift test` 往真实 `~/.glasspane/projects.json` 写假项目 → 注入临时路径 | ⚠ **本行只修了一个调用点，根因当时仍在**（2026-09-23 复核，见 §7）：`EngineCore` 缺省仍自建活注册表、`makeCore()` 的 `directory: nil` 仍解析到真实证据档案、`pruneEvidence` 无档案时仍回落到活目录去**删**。现已全部收口并加了源码扫描闸 |
| A-2 | `EngineCore.swift` attach | 项目未配 `evidenceStoragePath` 时不复位档案目录，证据继续落进**上一个项目**的档案（跨项目串写，审计归属失真）→ 每次 attach 都 `setDirectory(path ?? defaultDirectory)` | 既有 v1.5 用例回归通过；行为在注释中钉死 |
| A-3 | `EngineCore.swift` ffwd 收尾 | `try? currentTreeDigest()` 吞掉捕获失败，`target?.digest as Any` 把 nil 塞进响应 → JSONSerialization 抛错退化成不相干的 `GP_E_INTERNAL`，同时 `consistent:false` 宣称了未测结论 → 改 `try`，失败按原样上报 | 套件回归 |
| A-4 | `EngineCore.registerRestoreApproval` | 台账在动作**之前**写死 `"restore executed: …"`，而 ffwd 可中途失败、档 1 计划态根本没执行 → 登记时机移到结局确定之后，`reason` 由实际结局生成（`executed: ffwd 3/3` / `failed at step 2: ffwd` / `planned only: no execution surface (Z5)`） | 套件回归 |
| A-5 | `EngineCore` 计划态 | 硬编 `consistent: true`（未测量）——P5 §6.4 原文如此，与"拿不到就不点亮"冲突 → 保留字段（方法表冻结），补 `consistentBasis: "plan-only, state not re-measured"`，规格待随批修订 | 套件回归 |
| A-6 | `Classifier.swift` T1 | 只看 `processAliveAfter==false` 就判"崩在本次操作里"，attach 到已死进程（before 也是 false）同样命中 → 要求 `before==true && after==false` | 新增 `testAlreadyDeadProcessIsNotClaimedAsCrashDuringOperation` + `testProcessExitingDuringOperationRecordsT1`（给 `ScriptedChannel` 加 `aliveSequence` 才能造出真崩溃形态） |
| A-7 | `Classifier.swift` T3/T4/T5 | 屏幕录制未授予（`pixelDiff==nil`）时文案写"pixels all silent / neither AX tree nor pixels changed"——宣称了一个未测量的负例 → 新增 `pixelClause()`，未测时如实说 `pixels not measured`；归类判定保持保守不变 | 套件回归 |
| B-1 | `ProjectRegistry.swift` | `projects.json` 损坏时静默按空表加载，下一次 `create()` 直接覆写 → 全部注册项无声丢失（同仓 `ApprovalGate.loadFailed` 已是诚实口径，两处标准漂移）→ 加 `loadFailed` + 载入失败拒绝覆写（`GP_E_INTERNAL`）。⚠ 原写的"`recoverFromFailedLoad()` 显式解锁"是**无调用者的死接口**，且错误文案把它指向一条不存在的出路（幻影 remedy），2026-09-23 已删除该接口并把锁改为"只能靠重启进程解锁"（自动重读与本进程内存表二者必有一个被无声丢弃）；顺带把固定名 `.tmp` 改成唯一名，避免 daemon 与一次性 CLI 互踩中间文件 | 新增 3 条：损坏拒覆写且字节不动 / 锁不自解 / 写完读回且不留备份件 |
| B-2 | `PermissionStatus.swift` | "缺少时："前缀 4 条只写 2 条，面板再拼就重复；开发者工具文案里的"下方"按钮位置已不成立 → 文案归一（前缀由视图负责），措辞改"点「验证调试能力」" | `EngineP1Batch3` 文案非空断言 |
| B-3 | `SettingsModel.guide` | 已授权时 `return`，"查看"按钮点了没反应 → 真的打开对应系统面板并给如实横幅 | 真机 `act` 验证 |
| C-1 | `DaemonProbe` / `main.swift` / `SettingsModel` | 默认 socket 路径字面量三处各写一遍 → 收敛为 `DaemonProbe.defaultSocketPath` 单一真源 | 套件回归 |
| C-2 | `ApprovalGate` | `"daemon:auto"` 字面量在 EngineCore 与 4 处测试各抄一遍 → 新增 `ApprovalGate.autoApprover` | 套件回归 |

### 3.2 新增的 daemon 写入面

`glasspaned --project-prune [--dry-run]` 与 `glasspaned --project-remove <id>`：JSON 输出。残留判据是**双条件**（`bundleId == com.example.app` **且** 证据路径落在系统临时目录），实测命中当前 68 条、不会误伤手工注册的同名应用。

⚠ 2026-09-23 复核：这一面当时**不能算交付完成**——`pruned` 取的是命中数而不是真正写掉的条数、`registry.remove()` 的异常被 `try?` 咽掉、prune 的输出里没有 `remaining`、`--project-remove` 干脆无视 `--dry-run`（带着它直接真删）。现在字段与退出码见 P1 §12.3.1；命中 5 条只删 3 条即退 1。

### 3.3 安装器（`installer/cli.js`）

| # | 问题 → 修法 |
|---|---|
| A-8 | `startDetached` 把日志写到 `~/.glasspane/`，但全程从未创建该目录：全新机器首跑 `openSync` ENOENT → 报"安装失败"退出，而 bundle 已安置、plist 已落盘 = 半成品安装 → 函数自己 `mkdir -p` 日志父目录 |
| A-9 | `startDetached` 只返回 `child.pid`，spawn 失败是异步 error 事件 → 先打印 `PID undefined` 再抛未捕获异常 → 改 `async`，返回 `{ok, pid, error}`，等一个短窗口把 error 收进来 |
| A-10 | 尾部无条件 `printStep('安装完成。')`，且 `guiOpened=true` 不看 `open` 结果；`waitForSocket`/`socketHello` 早已实现却只在 `--restore-launchd` 用 → 收尾真跑一次 socket 到位 + hello 握手，通过才说"安装完成"，否则红字说明并给 `--restore-launchd`；`nextStepsText` 在未通过时把告警摆在最前 |
| 文案 | 「Daemon 状态 → 主体」在新面板里已改名 → 同步为「后台服务」卡里的程序名 |

测试：新增 4 条（未校验告警、面板未打开不谎称、启动器不存在要报错、日志目录自动创建）→ installer 48→52 全绿。

### 3.4 LLDB 桥（`bridge/glasspane_bridge.py`）

| # | 问题 → 修法 |
|---|---|
| A-11 | 退出码 `0 if status != "failed" else 1`：`no-process`、`eStateRunning`（预算内没停住）、`exited-before-stop` 都带**零线程**以 0 退出。开发者工具 TCC 被拒时 lldb 仍会跑完 `gp-capture` 回 `no-process`，下游于是收到"成功但什么都没有" → 新增纯函数 `capture_succeeded()`：状态白名单（`eStateStopped`/`eStateAttached`）**且** threads 非空才算成功 |
| A-12 | `subprocess.run(timeout=)` 超时只 kill 直接子进程，随后仍**无时限**地 `communicate()`；`debugserver` 是 lldb 的子进程且继承管道 → 可无限阻塞（注释"never a silent hang"不成立），且被 attach 的目标进程被孤儿化、常驻 SIGSTOP（用户的被测应用被冻死） → `start_new_session=True` + 到期 `os.killpg(SIGKILL)` + 有界二次读取，超时消息里如实写明目标不再被本桥持有 |

测试：新增 2 条钉住判定表（7 种失败形态 + 2 种成功形态）→ bridge 17→19 全绿。

---

## 4. 已定位、本轮**未修**（诚实清单）

### 4.1 TS 侧——因并行会话正在改同一批文件而主动避让

| # | 位置 | 问题 |
|---|---|---|
| **A-13** | `kernel/src/evidence-pack.ts` + `schemas/evidence-pack.schema.json` | 冻结 v0.1 后 kernel 只接受新 const，**读侧没有 legacy 兼容**，而 Swift 侧 `EvidenceModels.legacySchemaVersions` 明确放行 draft。实测磁盘上 **532/561 条是 `0.1-draft`**：daemon 经 `last_evidence` 磁盘回读原样带出 → `mcp-shell/tools.ts:531` 强校验抛 `GP_E_INTERNAL: engine and kernel schema drifted`——**把没测到的事说成两侧漂移**，同时用户的历史档案读不回来。修法：kernel 增 `parseEvidencePackRead()`（union 含 legacy，写侧仍 v0.1），shell 改调它，补 legacy fixture |
| **A-14** | `mcp-shell/src/project-registry.ts:48-50` | `evidenceStoragePath`/`recipeConfigPath` 只限长度，不校验绝对化/前缀/`..`。agent 可通过 `gp_project_set` 指定任意可写目录，daemon 随后往那儿写证据并按 v1.6/P5 保留策略**删除该目录内最旧/TTL 到期的 `*.json`** = 任意目录批量删档。P0 §8.1"不存在文件路径参数"的不变量已随 v1.4 失效 |
| **A-15** | `mcp-shell/src/project-registry.ts:65-74,143` | `loadProjects` 的 `catch { return [] }` 把"文件损坏"降级成"0 个项目"，紧接 `saveProjects` 全量覆写 → 一次 `gp_project_set` 静默清空全部注册项（与 §3.3 B-1 同病，Swift 侧已修，TS 侧未修） |
| **A-16** | `mcp-shell/src/engine-client.ts:92-96,166-170` | socket 只在启动时连一次，注释自称 lazy connect 实为立即连。daemon 重启/崩溃恢复（正是 `--restore-launchd` 存在的理由）后，本会话每条 `tools/call` 永久失败，而 remedy 仍写"run … then retry"——**幻影 remedy**，与 d4843c6 修过的同类 |
| B-4 | `engine-client.ts:122-128` | 成功响应走裸 `resolve` **不清 timer**，而 :119 注释断言"要么触发要么被响应路径清除"；timer 又刻意不 unref → 每次成功调用遗留一个最长 10s 的 ref 句柄 |
| B-5 | `mcp-shell/src/io.ts:71-73` | 超帧走 `failAll(GP_E_ENGINE_UNREACHABLE, "run --restore-launchd")`，与 P0 §3.1"超帧 → `GP_E_PAYLOAD_TOO_LARGE`，连接保持"相悖，且一个超帧把所有无关在途调用判死；缓冲本身无上限 |
| B-6 | `mcp-shell/src/index.ts:46-51,88,92-94` | `ReplyQueue.push` 无 `.catch`：任一 run 抛出即永久毒化 `tail`，之后所有回复静默不执行；`stdout.write` 返回值被忽略（无背压）、stdout 无 `error` 监听（客户端断管即崩）；stdio 超帧只写 stderr 不回包 → 客户端该请求永挂 |
| B-7 | `mcp-shell/src/tools.ts:58-60` | `AttachArgs` refine 用 `\|\|`（至少一个），而 inputSchema 用 `oneOf`、引擎要求恰好一个（`Dispatcher.swift:74-78`）→ 本地预校验可被绕过；缺 `{bundleId,pid}` 同传的回归用例 |
| B-8 | `tools.ts:642-653` | `gp_recent_reports` 串行 await 最多 20 次 `last_evidence`，每次 10s 超时且整个执行跑在 ReplyQueue 里 → 最坏 200s 全服务头阻塞 |
| B-9 | `mcp-shell/src/evidence-report.ts:190-192` | `doubleText` 用 JS `String()`，Swift 用 `%g`（6 位有效数字）→ 同一条 evidence 在 MCP 报告与面板报告里文字不一致，正是 §12.1 金样本要防的漂移；现有 fixture 全用恰好相同的数，零覆盖 |

### 4.2 Swift 侧未修

| # | 位置 | 问题 |
|---|---|---|
| A-17 | `ProbeSocketServer.swift:147-160` vs `:111-114` | `writeToClient` 取完 fd 就释放 `clientLock` 再 write，reader 线程 defer 里可并发 `close(clientFD)`；编号复用后探针命令会写进**无关 fd**（SIGPIPE 已 SIG_IGN → 静默错写） |
| A-18 | `ProbeSocketServer.swift:31` + `main.swift:630-677` | `engine.sock` 有 §11.1 单实例护栏，`probe.sock` 却无条件 `unlink+bind`：第二个 daemon 会**静默抢走** probe.sock（旧 daemon 仍服务 engine.sock）→ 归因面脑裂；且 `start()` 永不失败，catch 里的"Z5-only 降级"永不触发 |
| A-19 | `SCKCapturer.swift:107-126` | `tryWaitShareableContent` 丢弃 `wait(timeout:)` 返回值，超时后仍读 `box.value/box.thrown`，与未取消的 Task 并发读写（注释自称 thread-safe box，实为裸 var），并把超时误报成"returned no content" |
| A-20 | `SCKCapturer.swift:204-223` | `defer { stream.stopCapture }` 注册在 `awaitStreamStart` **之后**，start 超时抛错时 SCStream 已创建且永不停流（macOS 13 路径每次泄漏一个采集会话） |
| B-10 | `ParamValidation.swift:112,117` → `EvidenceStore.swift:322` | `operationId` 只查长度不查 `^op_…$` 就拼进路径（`lastEvidence` 磁盘回退），而 snapshotId 是正则校验的 → v1.5 §9.2"文件名仅由 opId 组成，无路径注入"在读侧不成立 |
| B-11 | `PermissionStatus.swift:349-359` | `script()` 把 daemon 自报的 `binaryPath` 不做转义拼进 zsh 脚本，含 `"` 即命令注入 |
| B-12 | `SocketServer.swift:110-125` | 单客户端无任何读/写超时：客户端半行不发 newline 即永久卡死 daemon（只能 SIGTERM） |
| B-13 | `Dispatcher.swift:176-188` | 序列化兜底帧把 `id` 写死 NSNull，丢掉真实请求 id → MCP 侧挂账 promise 永不 resolve |
| B-14 | `DegradationSignal.swift:226-228` | `abs(denominator) > ulpOfOne` 表达不了 v2.1 §18.2"x 跨度为 0 则斜率 nil"；x≈1.8e9 时灾难性抵消，短间隔 act 的斜率是纯噪声，可越过噪声地板**伪造 `degrading`+T9** |
| B-15 | `EngineCore.swift:61-66,248,284` | `channelFault(3)` 全仓从未被赋值，Classifier 的 T0 分支生产不可达：axUnavailable 直接抛错且不落 evidence，只有合成包"过"了 P0 §7.1/A2 |
| B-16 | `EngineCore.swift:353-372` | `captureBefore==nil` 一律标 `screen-recording-denied`，真因可能是"该 pid 无在屏窗口"或 SCK 超时 → 权限卡/T6 口径据此误诊 |
| B-17 | `RestorePipeline.swift:258` | `verifyStateDigest` 只被测试调用，`EngineCore.restore/validate` 从不调用 → P5 §6.3 的"防探针篡改"在活路径上是死代码 |
| B-18 | `EvidenceStore.swift:127-128,244-296` | 每次 write 全量 `contentsOfDirectory`（上限 1 万），开启 maxAgeDays 后还逐条 read+decode → 每次 act O(N) 文件 IO |
| B-19 | `DebugCapabilityProbe.swift:44-69` | 子进程退出后才 `readDataToEndOfFile`，输出超 64KB 写满管道使 lldb 阻塞，被误判 `.timeout`（把"能调试"报成"没结论"） |
| B-20 | `main.swift:562-598` | CLI 自己复制了一份 prune 目录解析而不调 `core.pruneEvidence`，两处已漂移（注入时钟 vs 墙钟；无 `--project` 时默认目录 vs 活跃 store 目录），违反 P5 §12.2 同口径 |
| C-3 | 死代码/漂移 | `ProbeInbox.swift:82 isStateCapable`（与 :210 私有版已分叉）、`SCKCapturer:339 denied()`、`DebugCapabilityProbe:144 trimmed()`、`EngineCore:1020 replace()` append 分支不可达且绕过 64 上限、`EngineCore:481` 的"会撒谎的兜底"（剪枝失败返回整树 digest 配剪枝后树）、`AXChannel:205` 实际产出 maxDepth+1 层、`main.swift:175` 帮助写 YAML 而 RecipeLoader 只吃 JSON、`idleRetryInterval=0.05` vs P2 §15.4 的 100ms |

### 4.3 bridge / installer 未修

| # | 位置 | 问题 |
|---|---|---|
| A-21 | `glasspane_bridge.py:549-550` | `cmd_queue` 完全忽略 `command`，规格 §6.5 要求的 `gp-queue arm` 不存在；`take_slot()`/`record_hit()` 生产路径零调用者，也没有槽释放回调 → FIFO 里的观察点永远不会装载，`snapshot().hits` 恒 `[]`——**"没采到"被呈现成"没命中"**，且 `add` 返回的 `"queued"` 是空头承诺 |
| A-22 | `glasspane_bridge.py:497-519` | `cmd_trace` 从不 `Continue()`，5 次采样读的是同一份冻结现场，只有 `at` 在变 → T2"逐 1s×5 采主线程栈"实为把 1 次测量当 5 次报，`timeline` 会被下游读成时间序列 |
| B-21 | `installer/cli.js:545` | `bootstrapFn(label, plistPath)` 少传 `desiredProgram` → `launchdNeedsReregister` 恒判"需重注册"，每次 `--restore-launchd` 都对健康作业 bootout+bootstrap（重启 daemon）；:521-523 写的"已加载且 granted → 无需动作"分支实际不可达 |
| B-22 | `installer/cli.js:455` | `status===5 \|\| /already/i.test(stderr)` 一律算成功，会把真实 bootstrap 失败洗成 `ok:true` |
| B-23 | `glasspane_bridge.py:116/132/339` | locals>16、threads>64、frames>64 **静默丢弃**，无 `truncated` 标记也不写 `errors[]`（§6.1 要求"空值显式，绝不省略"）；`watchpoints` 是 dict 而 §6.4 schema 写数组；`threads[].queue` 恒 `""` |
| B-24 | `glasspane_bridge.py:202-205` | `emit` 的 socket 无 `try/finally` 关闭、无 connect/send 超时：engine 不读时永久卡住回传 |
| C-4 | `installer/cli.js:97-98 + 611-622` | `confirm()` 与 `options.prompt` 生产路径零调用：`--no-prompt` 是空转开关，README 人工步骤②「确认安装」与 P4 §35.4(4)「交互终端仍逐步确认」**没有对应活代码**（`install.sh:59` 的 `[ -t 0 ]` 随之失去意义），文件头承诺的 onboarding 横幅也不存在——典型的"闸无触发路径" |
| C-5 | `mcp-shell/package.json:34` | `bundle` 里 `cp -R ../kernel/schemas schemas` 在目录已存在时递归出自嵌套副本（现仓库已有 `mcp-shell/schemas/schemas/*.json`），而 `src/` 无任何代码读它，`files` 却随包发布 |
| D | `EngineLog.swift:21` | quiet（无 `--verbose`）连 `log.error` 一起吞，"probe socket unavailable"/"fatal" 默认不可见 |

### 4.4 结构性缺口（需要规格级决策，不是 bug 修复）

**B1 审批闸没有人类入口。** `ApprovalGate.swift:12-16` 自己写明："当前协议没有人类审批交互（方法表冻结），所以只发生 `approve` 记录——daemon 自登记"。实测台账 38 条里高风险 `restore` 全是 `daemon:auto`。数据模型与链校验都已支持 `deny`（P5 §3.8 说这是给"未来加了审批 UI 的批次"预留的），面板也已经把这个事实**如实显示**成"后台服务自批"橙色徽标 + 计数。真正缺的是：GUI↔daemon 的一条审批交互面（新协议方法或一次性回连），以及"高风险操作在获批前挂起"的执行语义。这属新增批次范围。

**B2 测试隔离缺一道闸。** ✅ **2026-09-23 已交付**：`ProjectRegistryIsolationTests`。原建议只扫"无参构造"，而修完之后无参构造根本编译不过（缺省路径已删），所以闸改成三条：① `Tests/` 里出现任何解析到 `~/.glasspane` 的字样（`live()`、`defaultProjectsPath`、`NSHomeDirectory()`、`ApprovalGate.defaultPath`、`EvidenceStore.defaultDirectory`、无参 `LocalArchive.scanEvidence()`/`readApprovalLedger()`）即红；② 生产侧 `live()` 只允许出现在 `glasspaned` 入口，且 `EngineCore` 不得再引用活目录常量；③ 跨包的 `probe.sock` 默认值与 `DaemonProbe` 断言一致。扫描只看代码不看注释——否则第一个认真写事故复盘注释的人就会把闸关掉。

原建议里"与并行会话协调"这一条已不适用：该批测试改动落在另一棵工作副本的分支上，本树自成一版，合并时以本闸为准复核。

---

## 5. 验证记录（本轮实际跑过什么）

| 项 | 命令 | 结果 |
|---|---|---|
| Swift 全量 | `swift build` / `swift test` | Build complete；**390 通过，0 失败，1 跳过**（基线 374） |
| 真机面板冒烟 | `python3 .c6_smoke.py /tmp/gp_c6.sock <settings pid>` | **C6 SMOKE OK**（11 项断言全过；隔离 socket，未碰现网 daemon） |
| 新页签可驱动性 | daemon `attach` + `act` by identifier | `gp-nav-evidence/projects/approvals` 三条 `actConfirmed=true`，并各截真机图 |
| 侧栏标识普查 | daemon `observe maxDepth=10` | 262 节点，`gp-*` 标识 15 处齐备（含 4 张卡的状态 identifier） |
| 安装器 | `npm test`（installer） | **52 通过 / 0 失败**（基线 48） |
| 桥 | `python3 -m pytest -q` | **19 通过**（基线 17） |
| kernel / mcp-shell | `npm test` | 51 / 71 通过（本轮未改，属并行会话范围） |
| 注册表污染回归 | 跑完 `swift test` 后读 `projects.json` | 仍 68 条，**未新增**（修复前每次跑都会加） |

未验证 / 有边界：
- 清理 68 条残留的**真实删除**没有执行——按约定要先给人看清单。`--project-prune --dry-run` 与面板确认表已就位，面板截图里能看到"68 条注册项指向系统临时目录 + 清理"。
- A-13（draft 档案读不回）只做了**磁盘普查取证**（532 draft / 29 v0.1），没有实跑 `gp_last_evidence` 触发那条 `GP_E_INTERNAL`——它在 TS 侧，本轮避让并行会话。
- 桥的 A-11/A-12 靠纯函数与判定表钉住；带真实 lldb 的端到端复验受开发者工具席位限制（重启宿主后才能跑，见项目记忆）。

---

## 6. 建议的下一步顺序

1. 与并行会话合流后，先修 **A-13**（读侧 legacy 兼容）——它让 532 条历史档案当前不可读，且会把故障说成"两侧漂移"。
2. 接着 **A-14/A-15**（路径穿越 + 损坏即清空）——两个都是用户数据面。
3. 然后 **A-21/A-22**（桥的 queue arm 与 trace timeline）——"没采到"被呈现成"没命中"是诚实性问题。
4. **B1 审批入口** 立一个 P7 批次规格；面板侧的呈现（自批计数与徽标）本轮已完成。
5. 补 **B2 测试隔离闸**。 → 2026-09-23 已交付，见 §4.4 与 §7。

---

## 7. 2026-09-23 复核与二修（逐条回代码，不信 §3 与提交信息）

### 7.1 为什么要有这一节

§3 的"本轮已修（全部带回归测试）"经独立复核后**不成立**：18 条里有一条只修了调用点没修根因，两条的"测试"其实是既有测试通过，一条的接口是死代码，两条的字段清单与代码不符。触发这次复核的直接原因很硬——同日另一会话跑 `swift test` 覆掉了真实 `~/.glasspane/projects.json`（71 条 → 2 条合成条目，无快照不可恢复），而 §3 的 A-1 行当时写着"已修"。

### 7.2 复核后的判定与二修

| 原条目 | 复核结论 | 二修 |
|---|---|---|
| A-1 | **未修到根因**：`EngineCore` 缺省仍 `ProjectRegistry()`（活路径），约 24 个测试构造点静默绑定真实注册表；`EngineP1Batch6Tests.makeCore()` 的 `directory: nil` 把"无档案"用例做成了往 `~/.glasspane/evidence/` 写 | `ProjectRegistry.init(filePath:)` 与 `EvidenceStore.init(directory:)` 去掉缺省；活路径只经 `live()`，仅 `glasspaned` 入口引用；`EngineCore.projectRegistry` 缺省改为 **nil＝没有注册表**（问到就报错，不再回落实文件）；`makeCore(nil)` 语义修正为不挂档案 |
| A-2 | 修法本身留了同源漏洞：复位到 `EvidenceStore.defaultDirectory`＝家目录 | 复位目标改成"本实例构造时的目录"（`useDefaultDirectory()`） |
| A-6/A-7/B-2 | 成立（代码 + 文案均已核） | 无 |
| A-8 | **半修**：`mkdir` 在 `startDetached` 里，而默认路径是 launchd 先起（plist 的 `StandardOutPath` 就指向那个目录）→ 全新机器上第一个进不存在的目录的仍是 launchd | `ensureLogDir` 在路径确定后、写 plist 之前调用 |
| A-9 | **半修**：观测窗口之后的子进程退出收不到，仍回 `ok:true` + 一个已死 pid | 窗口后读 `exitCode/signalCode`；窗口 150→600ms；结论文案写明这是有界观测 |
| A-10 | **半修**：验证没过仍然 exit 0（`install.sh` 与 agent 看到的仍是成功）；`guiOpened` 仍只证明 `open` 起来了 | `installOutcome()` 纯函数决定退出码（0/1/2）；`nextStepsText` 里的 `<仓库目录>` 幻影 remedy 换成真实路径 |
| A-11 | **可能反成假红**：白名单比在 `str(process.GetState())` 上，而同文件别处按 int 比较枚举——若渲染不是那两个名字，真机每次采集都以 1 退出 | 判定不再经过枚举 `str()`：producer 端 `int(GetState())`→名字，父进程名对名；`PROCESS_STATE_NAMES` 补 `eStateAttached`（漏了它＝真机 attached 采集全部误判失败）；状态词表改成闭集（`eStateStoppedNot` 这类拼错的名字不再被当状态名放过去） |
| A-12 | 成立（`start_new_session` + `killpg` + 有界二次读，拒绝分支可达） | 顺带补 `emit` 的 socket 超时与 `try/finally` 关闭（B-24 的一部分） |
| B-1 | 方向对，但 `recoverFromFailedLoad()` **无调用者**、错误文案指向一条不存在的出路（幻影 remedy）；`encode` 失败仍 `return`（静默不落盘）；`replaceItemAt` 的备份件留在原地 | 删除该接口，锁明确"只能靠重启进程解锁"；编码/写入失败一律抛错；写完**读回比对字节**；备份件清掉；写入改为"先落盘成功再改内存"（失败不留幻影条目） |
| §3.2 写入面 | `pruned` 是命中数不是删除数、`remove()` 异常被 `try?` 咽掉、prune 无 `remaining`、`--project-remove` 无视 `--dry-run` | 全部改齐；`pruned + failed == matched` 不成立即退 1；面板回执改由 `LocalArchive.pruneResultMessage/removeResultMessage` 生成（纯函数 + 单测），`runDaemonCLI` 非 0 退出也交回 JSON |
| C-1 | **部分**：`DaemonProbe.defaultSocketPath` 建了、Swift 两处用了，但 `--help` 里仍是字面量；`probe.sock` 三处各写一遍 | 帮助文本插值真源；新增 `DaemonProbe.defaultProbeSocketPath`；跨包一致性由隔离闸断言 |
| C-2 | **部分**，且原写"4 处测试各抄一遍"与事实不符（HEAD 上是 1 个测试文件 5 处） | 断言改用常量 + 显式钉住常量的字面值（改它要过规格） |
| B2 | 当时未做 | 已交付 `ProjectRegistryIsolationTests`（三条闸，见 §4.4） |

### 7.3 本轮闸口复跑（2026-09-23，本机）

| 项 | 结果 |
|---|---|
| engine `swift build` / `swift test` | Build complete；**402 通过 / 0 失败 / 1 跳过**（跳过项为需要真 Finder 的采集用例，与本轮无关） |
| probe `swift test` | 10 / 0 |
| `.signal_smoke.py` | SIGNAL SMOKE OK（隔离 socket） |
| bridge | pytest **25 通过**；`python3 test_bridge.py` 同样 25（此前直跑只有 17） |
| installer | **59 通过 / 0 失败**（本轮前 52） |
| 根 workspace | `npm run build` exit 0；workspaces 测试 kernel/mcp-shell 全绿 |
| 真实用户状态 | `projects.json`/`approvals.json` sha256 与跑前一致，`evidence/` 仍 582 件——**套件不再触到活路径**（静态扫描 + 跑前后指纹双重确认） |

### 7.4 本轮未验证 / 边界

* `.c6_smoke.py`（真机面板 AX 冒烟）**未复跑**：它需要一个带辅助功能席位的 daemon 与被测面板进程，本轮改动没碰 SwiftUI 视图（只改了 `ConsoleModel` 的回执生成与 CLI 契约），但"没红"不能当成"验过"。合流后按 P1-S22 复跑。
* 桥的 `capture_succeeded` 在**真 lldb** 下的形态仍未实测（`str(SBEnum)` 到底渲染成什么）；本轮的修法是让判定不依赖这个问题的答案。要收口需要开发者工具席位（重启宿主后可跑）。
* `SettingsModel.swift:208` 有一条既有告警：`reprobeSeats(force:)` 的结果被丢弃。本轮未动。
* 与并行分支（`iterate/full-review-20260922`）在 `EngineCore.swift`/`ProjectRegistry.swift`/`Classifier.swift`/`DaemonProbe.swift`/`bridge`/`installer` 上是**两套独立实现**，合并时以两条闸（B2 隔离闸 + 桥的状态闭集）为准逐文件复核，不能只看哪边测试更多。
