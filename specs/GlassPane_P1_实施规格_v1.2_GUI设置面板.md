# GlassPane P1 实施规格 v1.2 — GUI 设置面板（权限 onboarding）

- 契约真源角色：P1 第三子项目的实施契约（P1 首批 = SCK 迁移 + 屏幕录制权限 onboarding，见 `GlassPane_P1_实施规格_v1.0_SCK迁移.md`；批二 = 快照/恢复原语 + 性能型熔断，见 `GlassPane_P1_实施规格_v1.1_快照恢复与性能熔断.md`，其全部验收项已达标且正文不变；本规格基于 v1.1 的章节结构与约束体系迭代，不删减既有内容，仅追加批次三范围——GUI 设置面板）
- 版本：v1.2-draft
- 日期：2026-09-16
- 关联决策：P1 v1.0 §3.2 接入点（"GUI 设置面板属后续 P1 批次"）、综述 §5.14 首次运行 onboarding 与权限引导（R36）、综述 §5.13 无头 CI 能力边界、屏幕录制权限三态模型（P1 §3.1）、GP_E 错误码表（P0 §3.4）、MCP 协议 JSON-RPC（P0 R44）

---

## 变更说明（相对 P1 v1.1 批次）

P1 首批覆盖 SCK 迁移+屏幕录制权限 onboarding（CLI 形态），批二补齐快照/恢复与性能熔断。本批次按 P1 v1.0 §3.2 的声明落地 **GUI 设置面板**：把此前仅存在于 daemon CLI 的能力（`--grant-accessibility`、`--check-screen-permission`、`--guide-screen-permission`）与权限清单（辅助功能/输入监控/屏幕录制/开发者工具）收敛为一个 SwiftUI 设置面板，提供可视化权限状态、一键引导、拒绝降级形态说明与 daemon 运行状态探测。

批次三范围要点：

- GUI 面板不改变 socket 协议、不改变 evidence schema、不新增 MCP 工具（面板与 daemon 之间仍走既有方法，无新协议面）。
- 面板作为独立 SwiftUI app（`glasspane-settings`）存在，权限检测逻辑复用 engine 库内已有探针（`ScreenCapturePermissionProbe`）并新增同级探针（辅助功能/输入监控/开发者工具），全部可注入、可单测。
- daemon 状态以"只读探测"实现（不占用连接）：面板不发协议帧，仅检测 socket 文件存在性与 `hello` 一次性会话判断 daemon 存活/版本——不改变 SocketServer 单客户端语义。
- 面板纯 UI 壳，权限判定与状态模型全部下沉到 engine 库（可无 GUI 权限跑 CI 单测）；SwiftUI 壳本身不做逻辑单测（验收以编译通过 + 真机人工冒烟为准，见 §9 可测性口径）。

（批次一/二正文见下文 §1–§5，不变；批次三为新增 §6–§9。）

---

## 1. 快照/恢复原语（工具面 A 扩展：六工具 → 八工具）

### 1.1 定位

对应综述 §5.7 三档时间旅行的 P1 可落地子集与 PRD US-04「回到故障前状态」：

| 档位 | 语义 | P1 落地 |
|---|---|---|
| 档 1 | 全量快照恢复（进程级状态回滚） | **不实现（诚实边界）**：依赖 Z5 白盒探针 SDK（综述 §5.7 不可快照区），P1 无 Z5；在 `gp_restore` 中显式返回 `GP_E_RESTORE_UNSUPPORTED` 并附指引 |
| 档 2 | ffwd 重演（从快照基线重放操作序列到目标状态） | **本批次实现**：`gp_snapshot` 采集 AX 树基线 → `gp_restore {snapshotId, steps}` 重演步骤、逐步确认并生成 evidence |
| 档 3 | 不可用形态降级 | 既有 GP_E_* 失败码与降级语义覆盖（不新增） |

档 1 恢复的验收入口 C34（恢复保真率 ≥95%、分级恢复时间）随 Z5 后移至对应批次；本规格为 C34 提供 **ffwd 侧的基础度量**：`gp_restore` 返回重演步骤的逐条确认率与目标/基线 digest 一致性，供后续 Z5 批次接入。

### 1.2 engine 方法扩展（socket 协议 §3.3 方法表追加两方法）

| method | params | 成功 result | 失败错误码 |
|---|---|---|---|
| `snapshot` | `{maxDepth?: integer(1–10, 默认 6)}` | `{snapshotId, treeDigest, nodeCount, capturedAt, latencyMs}` | GP_E_NOT_ATTACHED / GP_E_BAD_PARAMS / GP_E_AX_UNAVAILABLE |
| `restore` | `{snapshotId: string, steps?: array(1–64) of {selector, action}}` | `{snapshotId, baselineTreeDigest, steps: [{selector, action, actConfirmed, operationId}], confirmed: integer, total: integer, targetDigest?, consistent: boolean}` | GP_E_NOT_ATTACHED / GP_E_BAD_PARAMS / GP_E_NO_SNAPSHOT / GP_E_RESTORE_UNSUPPORTED（档 1 形态）/ GP_E_RESTORE_STEP_FAILED / GP_E_AX_UNAVAILABLE |

**语义细则**：
- `snapshot` 内部时序：存活检查 → AX 树捕获（沿用 observe 的紧凑序列化 + digest 链路，depth = maxDepth）→ 分配 `snap_` 前缀快照 ID（Crockford base32，时间戳前 10 位+随机 16 位，与 opID 同生成器）→ 存入内存快照存储（环形，保留最近 8 个，`snapshotHistoryLimit = 8`）。
- `restore` 校验顺序：未 attach → `badParams`（snapshotId 非法 / steps 数组越界）→ `noSnapshot`（snapshotId 不存在或已淘汰）→ steps 为空 → 走「基线一致性检查」形态：仅比对当前 AX 树 digest 与快照基线 digest，返回 `consistent`，`confirmed=0`。
- `restore` 带 steps 时按**档 2 ffwd** 执行：逐条调用既有 act 管线（同一 settle/确认/evidence 组装路径），任一步 `actConfirmed == false` 立即停止并抛 `GP_E_RESTORE_STEP_FAILED`（错误消息含失败步索引与原因）；全部确认后捕获目标 AX 树 digest，`consistent = (targetDigest == baselineTreeDigest 时为 true，否则 false)`——重演后应回到基线之外的期望状态时，`consistent` 表达「操作结果是否符合基线参照」，如实透传不做断言（agent 自行判读）。

> **诚实边界**：`restore` 不接受"直接回滚到快照"的档 1 形态；调用方传档 1 语义参数（如 `mode: "restore_snapshot"`）时抛 `GP_E_RESTORE_UNSUPPORTED`，remedy 指引使用 ffwd 重演或等待 Z5 批次（综述 §390 / §5.7）。

### 1.3 错误码扩展（GP_E 表追加三码）

| 错误码 | 含义 | agent 补救指引 |
|---|---|---|
| GP_E_NO_SNAPSHOT | snapshotId 不存在/已淘汰（保留 8 个上限） | 重新执行 gp_snapshot 再 restore |
| GP_E_RESTORE_UNSUPPORTED | 请求了档 1 全量快照恢复（依赖 Z5，未进入） | 改用档 2 ffwd（传 steps）或暂缓恢复 |
| GP_E_RESTORE_STEP_FAILED | ffwd 重演中某步 act 未确认 | 查看返回的失败步索引与原因，修正步骤序列 |

### 1.4 MCP 工具扩展（工具表追加两工具）

| 工具 | inputSchema 要点 | 成功返回（content[0].text = JSON） | 失败（isError: true） |
|---|---|---|---|
| gp_snapshot | `{maxDepth?: integer 1–10}` | snapshot result | GP_E_* 原码+补救指引文本 |
| gp_restore | `{snapshotId: regex ^snap_[0-9A-HJKMNP-TV-Z]{26}$, steps?: array 1–64 of {selector, action}}` | restore result | 同上 |

- `steps[].selector`/`action` 复用 kernel zod（`SelectorSchema`/`ActionSchema`，与 gp_act 同一规则），本章不新增 schema；
- `tools/call` 参数先经 inputSchema 校验（zod），不符 → `isError + GP_E_BAD_PARAMS` 语义文本；
- 快照/恢复结果不透传 evidence 包，不走 `parseEvidencePack` 强校验（§6.3 的强校验仅针对 evidence 返回）。

### 1.5 快照存储

内存态（与 evidence history 同生命周期，不落盘——对齐 P0「最近条目仅内存」口径）：`Fast[String: AppStateSnapshot]`，环形淘汰最旧。`AppStateSnapshot = {snapshotId, treeDigest, nodeCount, capturedAt}`（不存整树，digest 足以承担基线比对；整树轴交 observe 承担，避免内存膨胀）。

---

## 2. 性能型熔断（综述 §5.12 R41）

### 2.1 语义

既有熔断 0–3 级绑定**通道健康度**；性能熔断绑定**操作耗时**：单次 act 全流程 wall-clock 超预算时，evidence 的 `circuitBreaker` 升级并记录原因，供诊断层区分"通道坏"与"通道慢"。两级判定独立，叠加规则：

- 性能熔断 **只上调级别**（`max(existing, degraded)`），永不把 `channelFault(3)`/`actFailedChannelAlive(2)` 降级；
- 性能熔断命中时设置 `reason = "performance-act-latency-over-budget: <latencyMs>ms > <budget>ms"`；若非性能熔断已有 reason，采用 `"performance|" + 原reason` 拼接语义（可解析前缀 `performance|`）；
- 仅对 **act** 生效（打点位置唯一：`EngineCore.act` 的 `latencyMs` 计算处）；observe/assert 不升级熔断（避免高频轮询误报）。

### 2.2 阈值常量（对齐既有预算纪律）

| 常量 | 值 | 依据 |
|---|---|---|
| `performanceLatencyBudgetMs` | 10_000 | 与 AXChannel `treeTimeoutSeconds`（10s 总墙钟预算）对齐；SCK 捕获 5s 预算内含于 10s 内 |
| `snapshotHistoryLimit` | 8 | 内存环形快照上限 |

### 2.3 evidence 影响

`latencyMs > performanceLatencyBudgetMs` 时：

- `circuitBreaker.level` = `max(原判定 level, 1)`（`degraded`）；
- `circuitBreaker.reason` 附性能原因（见 §2.1）；
- `signals.axEvent.latencyMs` 原样保留真实值（不伪造、不截断）。

**不改变**：`normal(0)` 判定条件、通道健康熔断的既有分支顺序（§3.3 语义细则）、evidence schema、（`additionalProperties: false` 下无新字段）。

---

## 3. 双语言联动与 schema 影响

| 关注面 | 影响 |
|---|---|
| evidence-pack schema | **无变更**（`circuitBreaker.reason` 复用；无新字段；`additionalProperties: false` 维持） |
| decision-log / recipe-config schema | 无变更 |
| kernel zod 绑定 | 无新增导出（复用 SelectorSchema/ActionSchema）；快照 ID pattern 仅 mcp-shell 工具层校验 |
| kernel fixtures | 无新增（无新 schema 类型）；既有 C35 双侧 roundtrip 不受影响 |
| Swift Codable | 无 evidence 结构变更；新增内存态快照结构不进 Codable |

---

## 4. 工具面与本批次验收

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P1-B1 | snapshot 原语 | `snapshot` 返回快照 ID（`snap_` 前缀）/digest/nodeCount/capturedAt/latencyMs；内存环形保留 8 个，超限淘汰最旧 | ✓ 已实现并单测通过（2026-09-16，`EngineP1Batch2Tests` 13 用例） |
| P1-B2 | restore ffwd | 带 steps 重演：逐条确认、任一失败抛 `GP_E_RESTORE_STEP_FAILED`（含步索引）；steps 为空走基线一致性比对 | ✓ 已实现并单测通过（2026-09-16） |
| P1-B3 | 档 1 诚实边界 | 请求档 1 形态抛 `GP_E_RESTORE_UNSUPPORTED`，remedy 指引 ffwd/等待 Z5 | ✓ 已实现并单测通过（2026-09-16） |
| P1-B4 | 性能熔断 | latency > 10s 阈值 → level 升为 ≥1 + reason 带 `performance-act-latency-over-budget`；`channelFault(3)` 不被降级；正常 latency 不升级 | ✓ 已实现并单测通过（2026-09-16） |
| P1-B5 | MCP 工具 | `gp_snapshot`/`gp_restore` 注册、inputSchema 校验（快照 ID pattern、steps 长度 1–64）、错误映射到 GP_E_* | ✓ 已实现并单测通过（2026-09-16，mcp-shell 36 用例全绿） |
| P1-B6 | 纯逻辑单测回归 | 新增加法逻辑单测（fake channel 注入）；既有 104 用例全绿 | ✓ 全量 117 用例全绿（2026-09-16，0 失败 1 opt-in 跳过） |
| P1-B7 | 真机冒烟（可选，需 AX 权限） | 真机 attach 后 snapshot 返回真实 digest；restore ffwd 对可用动作成功重演 | 待办（可选人工项） |

> 注：快照/恢复与性能熔断均为纯逻辑可测（fake channel + 注入 clock），无动系统权限即可跑 CI；真机冒烟照旧为可选人工项。

---

## 5. 风险与边界（诚实声明）

1. **档 1 全量快照恢复未进入**：依赖 Z5 白盒探针 SDK 的进程级状态导出/回滚能力（综述 §5.7 不可快照区、§390 分工），Z5 进入前的 P1 只能提供档 2 ffwd 原语与基线一致性度量；C34 验收入口随之后移。
2. **性能熔断为预算守护而非延迟治理**：10s 硬阈值只做 evidence 标记与升级，不主动取消/中断操作（AX 层已有 10s 树读取预算兜底）；若需"耗时超支自动中断"属后续性能治理批次。
3. **ffwd 重演依赖 act 可重放性**：steps 里任何不可重放动作（如仅一次性的 pick）按 `GP_E_RESTORE_STEP_FAILED` 降级，与 P0 §8 降级口径一致；`consistent` 为基线参照比对，不作为通过/失败断言。
4. **快照仅内存**：daemon 重启后快照丢失（与 evidence history 同生命周期），agent 需在会话内快照→restore 连续使用。

---

## 6. GUI 设置面板（工具面 B：权限 onboarding GUI）

### 6.1 定位

对应综述 §5.14 / PRD US-01「首次安装 → 权限引导」，P0/P1 此前仅提供 CLI 形态（`glasspaned --grant-accessibility` 等）。本批次补齐可视化形态，权限清单与拒绝降级形态与综述 §5.14 一致：

| 权限 | 用途声明 | 拒绝降级形态 | 检测方式 |
|---|---|---|---|
| 辅助功能 | AX 树读取与操作（observe/act 主通道） | 完全不可用：GP_E_AX_UNAVAILABLE，循环不可跑 | `AXIsProcessTrusted()` |
| 输入监控 | C33 并发污染检测的 CGEvent 输入流监控 | 降级为纯操作权互斥（含污染标注禁用） | `CGPreflightListenEventAccess()` |
| 屏幕录制 | 像素 diff 通道（T6/T7） | `pixelDiff=null` + `circuitBreaker.level=1`，T6 退化 INCONCLUSIVE | `ScreenCapturePermissionProbe`（P1 §3.1） |
| 开发者工具 | LLDB attach（Z1–Z4.5 通道） | 探针通道不可用（P1 默认不启用） | 无公开 TCC 查询 API，如实显示"未验证" |

> 诚实边界：开发者工具权限无公开查询 API（listening/developer-tools TCC 服务查询缺失），面板对它的状态显示为"未验证（无公开查询接口）"并附手动引导文本，不伪造 granted/denied 判定。

### 6.2 面板结构（SwiftUI 两个 Scene）

| Scene | 内容 |
|---|---|
| 主窗口 | 权限清单逐项卡片（图标/名称/用途/状态徽标/引导按钮）+ daemon 状态卡（socket 路径、存活、协议版本）+ 拒绝降级形态说明折叠区 |
| 菜单栏项（可选 Lifespan） | 打开主窗口 / 刷新状态 / 退出；保持"不抢占主窗口焦点"的轻量入口 |

- 状态徽标三态着色：`granted`（绿）、`denied`（红）、`notDetermined`（灰）；`unverifiable`（开发者工具专属，灰描边）。
- 引导按钮语义：`notDetermined` → 触发系统授权（`AXIsProcessTrustedWithOptions` / `CGRequestScreenCaptureAccess()` / `CGRequestListenEventAccess()`）并打开对应系统设置 pane；`denied` → 仅打开系统设置 pane（引导用户手动勾选）；`granted` → 按钮禁用并显示"已授权"。
- 面板不写任何配置项：所有状态为实时检测，无持久化（对齐"首次运行 onboarding 为演示引导而非配置中心"的口径）。

### 6.3 engine 库新增（可注入探针，纯逻辑可单测）

`engine/Sources/GlassPaneEngine/` 新增探针（复用既有 `ScreenCapturePermissionProbe`，P1 §3.1）：

- `AccessibilityPermissionProbe`：`isTrusted() -> Bool`（注入 `AXIsProcessTrusted`）、`promptAndOpenPane()`（注入式：触发系统授权 + 打开 `Privacy_Accessibility` pane，返回值不依赖 UI）。
- `InputMonitoringPermissionProbe`：`isGranted() -> Bool`（注入 `CGPreflightListenEventAccess`）、`requestAccess()`（注入 `CGRequestListenEventAccess`）。
- `DeveloperToolsPermissionProbe`：`availabilityText` 固定返回"未验证（无公开查询接口）" + `openPane()`（打开 `Privacy_DeveloperTools` pane）。
- `PermissionStatus` 枚举（`granted` / `denied` / `notDetermined` / `unverifiable`）+ 每项 `displayName`/`purposeText`/`degradationText`（静态文案，单一真源供 UI 消费）。
- `DaemonProbe`：`reachable(socketPath:) -> Bool`——仅检查 socket 文件存在（`FileManager.fileExists`）；`helloSummary(socketPath:) -> (version: String, pid: Int)?`——发起一次性 `hello` 帧（客户端只读收发，3s 超时，失败返回 nil）。不调用任何需 attach 的方法，不占用长连接。

> 设计取舍：`DaemonProbe` 直接与 daemon socket 打一次 `hello` 对话，而非经由 mcp-shell——面板面向本机 daemon 的开发者工具，保持最短链路且复用既有 JSON 帧协议（P0 §3.1）；mcp-shell 面仍服务 agent 会话。

### 6.4 开关与产物

- 新增 executable target `glasspane-settings`（依赖 `GlassPaneEngine`，`Sources/glasspane-settings`，SwiftUI，macOS 13+，与 daemon 同包）。`Package.swift` products 增列。
- 启动参数留空即打开主窗口；`--socket-path <path>` 覆盖 daemon socket 探测路径（默认与 daemon 一致：`~/.glasspane/engine.sock`）。

### 6.5 协议与 schema 影响

面板对 daemon 的唯一调用是 `hello`（已存在于方法表）与 socket 文件探测——**不新增方法、不新增错误码、不新增 MCP 工具、不触碰 evidence/decision-log/recipe-config schema**。Swift Codable 无新增。kernel zod 无新增导出（权限状态不进 kernel 域）。

---

## 7. 双语言联动与 schema 影响（本批次无 schema 变更）

| 关注面 | 影响 |
|---|---|
| evidence-pack schema | 无变更 |
| decision-log / recipe-config schema | 无变更 |
| kernel zod 绑定 | 无新增导出 |
| kernel fixtures | 无新增；既有 C35 双侧 roundtrip 不受影响 |
| Swift Codable | 无 evidence 变更；新增 SwiftUI app target 不进 Codable |

---

## 8. 可测性与验收

本批次遵循"纯逻辑可测优先、GUI 人工冒烟兜底"分区：

- **engine 库单测**（无 GUI 权限，CI 可跑）：四探针各注入 fake 闭包断言判定与不崩溃路径；`DaemonProbe` 用临时 socket 文件注入 hello 响应断言 (version, pid) 解析与超时/缺失路径；`PermissionStatus` 文案非空快照断言。
- **SwiftUI 壳验收**：`swift build` 编译通过（macOS 13+ 编译面）；真机人工冒烟（需 GUI 会话）逐项核对权限卡片与引导跳转——列可选人工项。
- **无头 CI 降级**：runner 无 GUI 会话时跳过 SwiftUI 壳运行验证，仅保证编译（综述 §5.13 口径）。

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P1-C1 | 探针注入可测 | 辅助功能/输入监控/屏幕录制/开发者工具四探针在注入 fake 下判定正确、无真实系统调用依赖（CI 可跑） | ✓ 已实现并单测通过（2026-09-16，`EngineP1Batch3Tests` 14 用例） |
| P1-C2 | PermissionStatus 单一真源 | 每权限 displayName/purposeText/degradationText 非空；状态枚举可序列化 | ✓ 已实现并单测通过（2026-09-16） |
| P1-C3 | DaemonProbe 探测 | socket 存在+hello 会话 → 返回 (version, pid)；socket 缺失 → reachable=false；无响应 → nil（3s 超时） | ✓ 已实现并单测通过 + 真机 hello 冒烟（2026-09-16，返回 glasspaned 0.1.0 pid） |
| P1-C4 | SwiftUI 壳编译 | `swift build`（含 glasspane-settings target）0 error；菜单栏项与主窗口骨架存在 | ✓ 编译通过（2026-09-16，`GlassPaneSettingsApp` 双 Scene 就位） |
| P1-C5 | 纯逻辑单测回归 | 新增探针/DaemonProbe 单测全绿；既有 117 用例全绿（0 失败） | ✓ 全量 131 用例全绿（2026-09-16，0 失败 1 opt-in 跳过） |
| P1-C6 | 真机冒烟（可选，需 GUI） | 面板显示四权限真实状态；按钮跳转系统 pane；daemon 卡显示存活/版本或"未运行" | ✓ 已完成（2026-09-19 真机冒烟：`.c6_smoke.py` 经 daemon AX 通道读取面板树，四权限卡图标 identifier/跳转 AXButton/28 文本节点/降级折叠区/窗口标题"GlassPane 设置"齐备 + attach by pid 验证；文本内容受 AX value 通道与方法表冻结限制，见 smoke.md 真机观察） |

---

## 9. 风险与边界（诚实声明）

1. **开发者工具权限无公开查询 API**：面板如实显示"未验证"，仅提供打开系统 pane 的引导；不伪造授权态（与屏幕录制三态的 CG 局限声明同源——CG 也是布尔模型，见 v1.0 §5.1）。
2. **DaemonProbe 为只读探测**：hello 会话一次性建立并于 3s 超时后关闭；不占用连接（SocketServer 单客户端语义不变），面板因此不以"常驻连接"呈现 daemon 状态——显示的是检测瞬间的快照，用户可手动刷新。
3. **SwiftUI 壳不做逻辑单测**：状态判定全在 engine 库探针层，壳仅渲染；因此 CI 无 GUI 会话也能保证逻辑正确（综述 §5.13）。
4. **面板不持久化配置**：权限状态实时检测，daemon 重启/授权状态变化后面板自动反映（刷新按钮 + 菜单栏项触发重查）；不做"记住上次状态"缓存，避免 TCC 状态漂移误导。

---

## 10. 拖拽引导（v1.2 追加，2026-09-19）

### 10.1 目标与诚实边界

在设置面板打开后直接呈现**拖拽引导**：窗口顶部一张可拖动的 GlassPane app 图标横幅，用户把图标拖到下方对应权限卡，面板即**精确打开该权限的系统设置面板深链**，并给出下一步文案；用户完成开关后，面板以 1s 轮询实测 TCC 状态，**授权即自动点亮**。

诚实边界（不可规避，仅声明与引导）：

- TCC 授权**只能由用户在系统设置里手动完成**，任何程序都不能替你勾选开关。拖拽的语义是"替你精确导航到正确面板"，不是"替你授权"。
- **开发者工具（Automation）无系统总开关**，由触发动作自动弹窗询问；UI 恒为 unverifiable，不做假点亮。
- 拖拽源在二进制直跑（非 .app bundle）时只提供纯文本 "GlassPane"；落点同时接受 fileURL（.app bundle，读 Info.plist 可读名）与纯文本两种 provider，名称解析失败时缺省 GlassPane。

### 10.2 落点 → 面板映射（单一真源）

| 权限 | 系统面板深链（x-apple.systempreferences） | 说明 |
|---|---|---|
| 辅助功能 | `com.apple.preference.security?Privacy_Accessibility` | 开关 + 白名单 |
| 输入监控 | `com.apple.preference.security?Privacy_ListenEvent` | 首次打开开关需重启 app 生效（文案声明） |
| 屏幕录制 | `com.apple.preference.security?Privacy_ScreenCapture` | 三态可查 |
| 开发者工具 | `com.apple.preference.security?Privacy_Automation` | 仅 Apple Events 的询问面板，不可枚举 |

映射与文案集中在 `engine/Sources/GlassPaneEngine/PermissionStatus.swift → PermissionGuide`（纯函数，无系统 API 依赖，可单测）；`SettingsModel`（SwiftUI 壳）仅做编排（`handleDrop`、`pollPermissions`、`pendingGuide*` 状态）。

### 10.3 验收项

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P1-G1 | 面板深链映射单测 | `systemPaneURL(for:)` 四类返回既定的深链且互不重复；`instruction(for:droppedName:)` 含被拖入名、developerTools 文案含"无系统总开关"且无"变绿"暗示 | ✓ 已实现并单测通过（2026-09-19，`PermissionGuideTests` 10 用例） |
| P1-G2 | 拖拽落点 | 顶部横幅可拖（.onDrag 纯文本 GlassPane）；四张权限卡整卡接受 fileURL 与 plainText，落点悬停高亮；落下即打开对应系统面板 + 展示引导横幅 | ✓ 已实现；真机人工冒烟见 smoke.md（自动模拟拖拽不可行，人工目视确认） |
| P1-G3 | 轮询自动点亮 | 面板 onAppear 起 1s 轮询 `pollPermissions()`，权限全部 granted/unverifiable 自停；中途撤销授权如实回退 | ✓ 已实现（AX trust / CG preflight 均为廉价本地查询，1s 不构成负担）；人工授权冒烟见 smoke.md |
| P1-G4 | 壳编译与回归 | `swift build` 0 error；engine 单测全绿（新增 10 用例，全量 294 用例 0 失败 1 opt-in 跳过） | ✓ 2026-09-19 |

### 10.4 与安装器联动

拖拽引导是 `npm` 一键安装流程（P4 §34）的最后一步：安装器编译完成后自动启动 daemon 并打开 glasspane-settings GUI，用户直接面对拖拽引导横幅，无需理解路径/命令细节。
---

## 11. 权限主体与产物身份（v1.2 追加，2026-09-19）

§10 的拖拽引导在真机上不成立：用户在系统设置的权限列表里**找不到 GlassPane 这一行**，
也无法用「+」手动添加。根因不在跳转，而在"谁在申请权限"与"以什么身份申请"。本节把
实测到的三条机制固化为规格，并据此重设权限卡的状态真源与申请路径。

### 11.1 TCC 主体机制（真机实测，非推测）

| # | 结论 | 实测方法 | 后果 |
|---|---|---|---|
| 1 | **席位按进程身份记账**，裸二进制的身份即其路径：`/Volumes/…/.build/release/glasspaned` 的输入监控席位在 launchd 上下文下为 `granted`，同内容副本放 `/tmp` 则为 `notDetermined` | `glasspaned --check-input-permission` 分别在原路径与副本路径执行 | 换路径/清 `.build` = 授权蒸发；同路径重编译不受影响 |
| 2 | **无 bundle 身份的进程会继承父 app 的判定**：同一未授权副本，从已授权终端启动报 `granted`，改由 `launchctl submit` 起（父=launchd）报 `notDetermined` | 同副本双上下文对照 | 终端里跑 `--guide-screen-permission` 会把席位记到终端头上；面板/CLI 显示的"已授权"可能是借来的 |
| 3 | **只 `cp` 不重签的 .app 不成立 TCC 客户端**：旧 `make-app.sh` 产物 `codesign --verify` 报 `code has no resources but signature indicates they must be present`，`Identifier=glasspane-settings ≠ CFBundleIdentifier`、`Info.plist=not bound` | `codesign -dvvv` / `--verify --strict` | 点授权后系统设置里什么都不出现；「+」选择器亦不认该 bundle |

推论（据此设计）：权限列表要出现**带名字带图标**的可选条目，daemon 必须是"签名有效的
bundle 主可执行"；`identifier` 形态的 designated requirement（不含 cdhash）才能让授权
跨重编译存活——`codesign --force --sign - --identifier <id> -r='designated =>
identifier "<id>"'` 实测可通过 `--verify --strict`。

### 11.2 状态真源与申请路径的重新分工

| 面 | v1.2 §6 原设计 | §11 修正 |
|---|---|---|
| 卡片状态 | 面板进程内调 `AXIsProcessTrusted()` / `CGPreflight*` | **daemon 自报**：`hello` 结果新增 `identity` + `permissions`（增量字段，不新增方法名、不动方法表白名单，§6.5 约束不破）；面板读不到即 `unverifiable` + 注记，绝不代测 |
| 申请动作 | 面板进程 `AXIsProcessTrustedWithOptions(prompt)` / `CGRequest*Access()` | **daemon 以自身身份发起**：面板执行 `launchctl submit -l com.glasspane.guide.<kind>.<nonce> -- <daemon 自报 binaryPath> --request-permission <kind>`（直接 spawn 会落回结论 2 的继承陷阱），5s 后 `launchctl remove` 清理 |
| 跳转 | 面板深链 | 不变（申请与跳转分离：daemon 只申请，面板只导航） |
| daemon 未运行 | 仍显示面板自己的状态 | 三张必备卡 `unverifiable` + `daemon 未运行…本卡不代替其状态`，轮询不停表 |

`PermissionKind.cliValue`（`accessibility` / `input-monitoring` / `screen-recording` /
`developer-tools`）是 daemon CLI 与面板之间的取值真源；新增探针一律注入式（无 TCC
环境可单测）。daemon 侧新增 `--permissions`（快照 JSON）、`--request-permission <kind>`
（不跳转、不等待、即起即停）、`--check-accessibility`（AX 仅两态，如实）。

### 11.3 产物身份与拖拽源

- `engine/scripts/make-app.sh` 产出**两个** bundle 并整包重签：`GlassPane.app`
  （`com.glasspane.settings`）与 `GlassPane Daemon.app`（`com.glasspane.daemon`，
  `LSUIElement`，daemon 主可执行）；签名自查失败即非零退出（坏签名的 bundle 只会让用户白跑一趟）。
- 安装器把两者安置到 `~/Applications`（可见、稳定、非隐藏目录——`.build` 里的产物
  「+」选择器看不到），launchd 与 GUI 启动一律走 bundle 内可执行；`--no-app` 显式回退
  裸二进制并在文案里如实说明"条目只显示文件名"。
- 拖拽源由 `PermissionGuide.dragSource(for:)` 决定：daemon 自报 bundle 身份 → 提供
  **daemon 真身 `.app` 的 fileURL**（可拖进系统设置列表，条目带图标）；否则退回纯文本
  导航。设置面板自己的 `.app` 不得作为拖拽源——那会授权错主体。
- 单实例护栏：`glasspaned` 启动时若 socket 已被活着的 daemon 服务则拒绝启动（exit 65，
  `--force-socket` 显式抢占、`--socket-path` 起并行实例）。多实例并存时"系统设置里看到的
  条目"与"实际服务实例"可能不是同一身份，正是本节要修的坑；安装器 `--replace-daemon`
  负责收拢旧实例（SIGTERM 未生效者 1s 后补 SIGKILL），并等 launchd 按新 plist 重拉后再决定
  是否手动启动，避免抢 socket 造成双身份。

### 11.4 验收项

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P1-S1 | 主体身份纯逻辑 | `PermissionSubject`：裸二进制 → `hasBundleIdentity=false`、`tccEntryName` 取文件名；bundle → 取 bundle 目录名；`wireValue` 省略 nil 字段；roundtrip 保真 | ✓ `PermissionSubjectTests`（2026-09-19） |
| P1-S2 | 席位快照与线上往返 | `PermissionProbeSet.snapshot()` 四类齐；`request(kind)` 只触发申请钩子、不触发面板跳转钩子，已授权时不重复弹；`hello` 带 `identity`+`permissions`，未注入钩子时整段省略；旧 daemon 无字段 → `subject=nil`/`permissions=[:]` | ✓ 同上（`DaemonProbe.parseHelloResponse` 向后兼容用例） |
| P1-S3 | 申请命令构造 | `daemonRequestCommand` 走 `/usr/bin/launchctl submit`，label 前缀 `com.glasspane.guide.<kind>.` 且随 nonce 唯一；`--request-permission` 取值与 `cliValue` 一致；清理命令为 `launchctl remove` | ✓ 同上 |
| P1-S4 | 拖拽源选择 | bundle 身份 → `.bundleURL(daemon bundlePath)`；daemon 未上报/裸二进制 → `.plainText("GlassPane")` | ✓ 同上 |
| P1-S5 | 打包与签名 | 两个 bundle `codesign --verify --strict` 通过，DR 为 `designated => identifier "<id>"`（不含 cdhash），`Info.plist` 已绑定，`CFBundleIdentifier` 与签名 identifier 一致 | ✓ 2026-09-19 实测（debug 与 release 产物各一轮） |
| P1-S6 | 安装器接线 | `bundlePlan`/`daemonLaunchPath`/`settingsLaunchPath`/`installBundles`/`bundleLaunchArgs`/`pidsFromPs`/`terminatePids`/`waitForSocket` 纯函数用例全绿；`nextStepsText` 按形态给出真实条目名 | ✓ installer 37 用例（2026-09-19，原 21 + 新增 16） |
| P1-S7 | 端到端 | daemon 以 bundle 身份服务 socket，`hello` 自报 `entryName="GlassPane Daemon"`、`hasBundleIdentity=true`，未授权席位如实 `notDetermined` | ✓ 2026-09-19（留档 `engine/smoke.md`） |
| P1-S8 | 真机目视 | 系统设置「辅助功能/输入监控/屏幕录制」列表出现带图标的「GlassPane Daemon」，勾选后面板 1s 内点亮；授权跨 `swift build -c release` 重编译不丢 | ⏳ 待人工勾选（新身份首次授权 + 重编译回归），见 smoke.md 待办 |
