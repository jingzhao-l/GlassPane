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
- **开发者工具**：~~无系统总开关~~（2026-09-19 真机核对修正——「隐私与安全性 > 开发者工具」
  面板存在且可勾选，LLDB attach 的授权就落在这里；旧版把它与 Apple Events 的 Automation
  面板混为一谈）。修正后仍成立的诚实边界是：**该权限的状态无公开查询接口**，UI 恒为
  unverifiable，不做假点亮。
- 拖拽源在二进制直跑（非 .app bundle）时只提供纯文本 "GlassPane"；落点同时接受 fileURL（.app bundle，读 Info.plist 可读名）与纯文本两种 provider，名称解析失败时缺省 GlassPane。

### 10.2 落点 → 面板映射（单一真源）

| 权限 | 系统面板深链（x-apple.systempreferences） | 说明 |
|---|---|---|
| 辅助功能 | `com.apple.preference.security?Privacy_Accessibility` | 开关 + 白名单 |
| 输入监控 | `com.apple.preference.security?Privacy_ListenEvent` | 首次打开开关需重启 app 生效（文案声明） |
| 屏幕录制 | `com.apple.preference.security?Privacy_ScreenCapture` | 三态可查 |
| 开发者工具 | `com.apple.preference.security?Privacy_DeveloperTools` | 真机核对修正：LLDB attach 的入口（`Privacy_Automation` 是 Apple Events，另一主体）；状态仍不可枚举 |

映射与文案集中在 `engine/Sources/GlassPaneEngine/PermissionStatus.swift → PermissionGuide`（纯函数，无系统 API 依赖，可单测）；`SettingsModel`（SwiftUI 壳）仅做编排（`handleDrop`、`pollPermissions`、`pendingGuide*` 状态）。

### 10.3 验收项

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P1-G1 | 面板深链映射单测 | `systemPaneURL(for:)` 四类返回既定的深链且互不重复；`instruction(for:droppedName:)` 含被拖入名、developerTools 文案声明"状态未验证不伪造"且无"变绿"暗示 | ✓ 已实现并单测通过（2026-09-19，`PermissionGuideTests` 10 用例；同日按 §11.5 真机核对把 developerTools 深链与文案从 Automation 改为开发者工具面板） |
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

| 4 | **同一个 bundle 身份，起法不同 → 自报读数不同**：由 `open`（责任链落在终端 app）
  起的 daemon 自报 `accessibility=granted / inputMonitoring=granted / screenRecording=notDetermined`；
  同一 bundle 由 `launchctl kickstart` 起的 daemon 自报 `accessibility=notDetermined /
  inputMonitoring=notDetermined / screenRecording=granted`（用户为「GlassPane Daemon」
  真实勾选的只有屏幕录制） | `hello` 对照（见 smoke.md） |

推论（据此设计）：`hello` 的自报只在 **daemon 的责任上下文是它自己**时才等于真实席位，
因此交付形态必须是 launchd/登录项拉起；终端或从 GUI 手动起 daemon 时，面板读数可能仍是
借来的（安装器文案须声明这一点）。权限列表要出现**带名字带图标**的可选条目，daemon 必须是"签名有效的
bundle 主可执行"；`identifier` 形态的 designated requirement（不含 cdhash）才能让授权
跨重编译存活——`codesign --force --sign - --identifier <id> -r='designated =>
identifier "<id>"'` 实测可通过 `--verify --strict`。

**该推论已于 2026-09-21 真机证实**（原为 P1-S8 的未完成半项）：把现网 daemon 换成
cdhash 已变（`f967598c… → 75812885…`）、identifier 与 DR 未变的 bundle 并 `kickstart` 重启，
三个已授权席位仍全部 `granted`；恢复原产物后再验一次读数不变。回归闸为
`engine/.rebuild_survival_smoke.py`（自备份、自恢复、空测自警；细节见 smoke.md 脚本 21 / 观察 22）。

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

### 11.4 授权生效的重启语义与席位重探

真机核对（同一 bundle 身份、两种上下文）：用户为「GlassPane Daemon」勾上辅助功能与输入
监控后，**运行中的实例仍报 `notDetermined`**，而同一身份的**新进程**报 `granted`——TCC
判定按进程缓存，面板因此不能把"没绿"直接解释成"没授权"。口径：

| 观测 | 判定 | 面板呈现 |
|---|---|---|
| daemon 自报 granted | 已生效 | 绿 |
| daemon 自报非 granted，重探（同身份新进程）granted | **待重启生效** | 保持未达成 + 注记「系统里已授权，重启 daemon 后生效」+「重启 daemon」按钮（`launchctl kickstart -k gui/<uid>/com.glasspane.daemon`，**只在用户点击时执行**——重启会中断正在进行的 act） |
| 两者都非 granted | 系统里确实没授权 | 未请求/已拒绝 + 申请引导 |
| 重探失败（脚本/任务不可用） | 不可知 | 保持旧读数，绝不假称待重启或已授权 |

重探实现：面板把 daemon 自报的 `binaryPath` 写进一次性 zsh 脚本，经 `launchctl submit`
执行（责任上下文是 daemon 自身，不继承面板 app），读回 `--permissions` 的 JSON 后清理
临时文件与任务标签。三类权限的引导文案统一声明"开启后需重启 daemon 生效"，不再承诺
"开启即变绿"。

### 11.5 输入监控：申请 ≠ 条目出现

真机核对：辅助功能申请后条目**直接出现**在列表里，输入监控则不会——用户只能手动把
`.app` 拖进列表才看得到条目。原因是登记该 client 的动作是**创建 event tap**（与 P4 §36
"tap 创建即权限如实探测"同源），`CGRequestListenEventAccess()` 只负责弹询问。故
`PermissionProbeSet.request(.inputMonitoring)` 在未授权时除发起询问外，还用
`ListenEventTapProbe` 尝试创建一个 `.listenOnly` 被动 tap（创建成功即销毁，不进 C33
数据面、不改写事件流），把条目登记出来；已授权时跳过，不做无谓的会话级监听。

### 11.6 开发者工具席位：无查询接口 ≠ 不可验证

`hello.permissions.developerTools` 仍为 `unverifiable`（TCC 无公开查询接口这一事实未变），
但卡片不得因此把"能不能调试"这件事甩回给用户猜。P6 §7 已把该判定机器化
（`DebugCapabilityProbe` → `glasspaned --check-developer-tools`，真实受限 lldb 探测，
launch/attach 各出三态）。本规格据此补一条**显式验证**通道，并守住两条边界：

| 边界 | 口径 |
|---|---|
| 由谁跑 | **必须**用 daemon 自报的 `binaryPath`、经 `launchctl submit` 一次性任务跑；面板自己 `xcrun lldb` 测的是面板 app 的能力（§11.1 结论 2 的继承陷阱） |
| 何时跑 | 只在用户点「验证调试能力」时。探测含真实冷启动（P6 F5 预算 120s×两侧），绝不进 1s 轮询、绝不写进实时席位字段 |
| 怎么显示 | 结论行带观测时刻与"非实时读数"声明；`granted=true` → 调试能力可用；任一侧 `denied` → 系统已拒绝；`timeout`/`spawnFailed` → 不可判定，**不折算成任何权限结论**（与 P6 同口径） |
| 解析失败 | 保持"未验证"并给错误行，不猜 |

### 11.7 渲染状态的可核验化

面板是 SwiftUI：`Text` 的内容不进 `AXTitle`（P6 §0 F6），截图又受屏幕录制席位限制，
所以"卡片到底绿没绿"不能只留给人眼。做法是给每张卡的**状态图标**一个专用无障碍标识
`PermissionGuide.statusIdentifier(kind:status:)`（形如 `gp-perm-input-monitoring-granted`），
待重启标记另用 `restartPendingIdentifier`。三条约束：不改四类权限图标既有的 identifier
（P1-C6 冒烟依赖它）；状态由"形状 + identifier"双表达，不依赖颜色（色盲可用）；标识串
由 engine 侧纯函数作唯一真源，面板与单测共用同一函数。

### 11.8 一次真实失效的复盘：`/usr/bin/launchctl` 不存在

用户报"点授权后系统设置里没有条目、只能手动把 .app 拖进去"。除了 §11.1 的主体/签名
两层原因，还有第三层：面板的申请、重探、验证、kickstart 全走
`Process("/usr/bin/launchctl")`，而 macOS 上它是 **`/bin/launchctl`**；`try? run()`
把抛错吞掉，于是"让 daemon 以自身身份发起申请"从未发生，用户只看到一个空列表。
两条并行工作线在同一晚各自独立命中这个根因（面板侧 `Launchctl.path` 候选解析，与本批
的"失败阶段可判读"），合并后取候选解析版：

| 项 | 落点 |
|---|---|
| 路径不许猜 | `Launchctl.path` 在 `/bin` → `/usr/bin` 中按 `isExecutableFile` 解析，并由 `testLaunchctlPathResolvesToRealBinary` 把住 |
| 失败必须分得清 | 一次性任务返回 `OneShotOutcome`（`text / writeFailed / spawnFailed / timedOut`）；四类失败各自编成标识 `gp-devtools-failed-{write\|spawn\|timeout\|unreadable}`，在途 `gp-devtools-pending`，结论 `gp-devtools-{granted\|denied\|unverifiable}` —— 8 个标识互不冒充（单测锁定）。此前"启动失败"和"超时"共用一个 nil，本批正是靠拆开它才在一次点击内定位到 spawn |
| 控件可被自动化定位 | `gp-guide-<kind>` / `gp-verify-developer-tools` / `gp-restart-daemon` / `gp-refresh`：SwiftUI 按钮标题不进 AXTitle，按标题 `act` 选不中元素 |
| 重探节流 | 席位重探由固定 4s 改指数退避至 60s（面板长期开着又未授权时不再狂起一次性任务），必备权限达成或重启后复位 |
| 文案面向用户 | 面板字符串不写规格编号、不写实现自辩；实现理由只留在本节与 §11.1 表 |

端到端复验（2026-09-20 23:2x，全程零人工）：`act` 按标识按下「验证调试能力」→ 一次性
任务以 daemon 自身身份实测 → 面板渲染结论 → `observe` 读到 `gp-devtools-granted`。

### 11.9 CI 曾经从未跑过（记录，已修复）

`.github/workflows/ci.yml` 的 mcp-shell 步骤名 `Install kernel (local file: dep)` 含裸
`": "` → 整份 workflow YAML 解析失败，**CI 一次都没真正跑过**（GitHub 上每个 run 都是
0s failure、无 job、无日志，跨分支与 main 一致）。审计批次已加引号修好，并把此前漏挂的
`engine/probe`（SPM 10 用例）、`bridge`（pytest 17 用例）与 §11.10 S15 的信号收尾闸
`.signal_smoke.py` 一起接进 job。本批合并后复核：YAML 可解析、5 个 job 齐全，且各 job
命令在本地逐条跑绿 —— engine 373 / probe 10 / bridge 17 / kernel 51 / mcp-shell 67 /
installer 40，加 `.c6_smoke.py` 与 `.signal_smoke.py` 两套真机冒烟。

**CI 第一次真跑又挖出三处潜伏缺陷（2026-09-21，均已修）**：CI 常年不跑，等于这三条
从未被任何闸门检查过——

| 缺陷 | 症状 | 修法 |
|---|---|---|
| `node --test "test/*.test.mjs"` 的 glob 带引号 | Node 20 不展开引号内的 glob → `Could not find .../test/*.test.mjs`；本地 Node 26 支持，故只在 CI 暴露（kernel/mcp-shell/installer 三处脚本同病） | 三处脚本改成不带引号，由 shell 展开；顺带把"能跑测试"的 Node 下限拉回 engines 声明的 18 |
| mcp-shell 的 TS 编译 | `Cannot find module '@iterate/kernel'` + 连带两条 `'error' is of type 'unknown'`（`KernelSchemaError` 因模块缺失退化成 any，`instanceof` 后仍收窄失败）——不是代码缺陷，是该 job 没先构建 `file:../kernel` 依赖 | job 内加 `Build kernel first` 步骤；根 workspace gate 因先 `npm run build` 不受影响 |
| bridge job | `No module named pytest` | 加 `python3 -m pip install --quiet pytest`（该套件除 stdlib 外无第三方依赖） |

**CI 第二次真跑又挖出第四处（2026-09-21，已修）**：上表三处修好后 CI 才第一次跑完全部
job，随即 mcp-shell 与根 workspace gate 同时报 3 个 `cancelledByParent`——
`Promise resolution is still pending but the event loop has already resolved`。根因是
`mcp-shell/src/engine-client.ts` 里请求超时定时器调了 `timer.unref()`（自 fa537b4 首个
mcp-shell 提交就在）：unref 的定时器不维持事件循环，当"等一个 daemon 回应"是进程里唯一
剩余工作时 Node 直接退出，**超时永远不交付**——调用方等到的是进程死亡，不是
`GP_E_ENGINE_UNREACHABLE` 与 remedy。这与本节 §11.8 的 launchctl 案同构：一条失败路径
静默无输出，比报错更难查。本地 Node 26 看不见它（测试运行器自己的 handle 仍把循环撑住），
只有 CI 的 Node 20 暴露——再次印证 §11.9 主结论：闸门没跑过的路径等于没有路径。

修法：删掉 `unref()`（定时器要么触发、要么被回应/关闭路径 `clearTimeout`，不会把进程多
留过 `timeoutMs`），并补一条**在裸进程里**验证的回归用例 `test/fixtures/timeout-loop.mjs`
（`spawnSync` 子进程，除该 Promise 外无任何 handle；缺陷复现时子进程 exit 13 且 stdout
为空，修后 exit 0 且打印 `REJECTED GP_E_ENGINE_UNREACHABLE`）。同文件内的旧超时用例保留
但不足以证明此病——它跑在测试运行器的循环里，正是本地假绿的原因。

### 11.10 验收项

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P1-S1 | 主体身份纯逻辑 | `PermissionSubject`：裸二进制 → `hasBundleIdentity=false`、`tccEntryName` 取文件名；bundle → 取 bundle 目录名；`wireValue` 省略 nil 字段；roundtrip 保真 | ✓ `PermissionSubjectTests`（2026-09-19） |
| P1-S2 | 席位快照与线上往返 | `PermissionProbeSet.snapshot()` 四类齐；`request(kind)` 只触发申请钩子、不触发面板跳转钩子，已授权时不重复弹；`hello` 带 `identity`+`permissions`，未注入钩子时整段省略；旧 daemon 无字段 → `subject=nil`/`permissions=[:]` | ✓ 同上（`DaemonProbe.parseHelloResponse` 向后兼容用例） |
| P1-S3 | 申请命令构造 | `daemonRequestCommand` 走 `Launchctl.path` 解析出的 launchctl submit（2026-09-20 真机勘误：本机只有 `/bin/launchctl`，硬编码 `/usr/bin` 曾使全部 launchd 动作静默失败，见 P6 §11 补录），label 前缀 `com.glasspane.guide.<kind>.` 且随 nonce 唯一；`--request-permission` 取值与 `cliValue` 一致；清理命令为 `launchctl remove` | ✓ 同上 |
| P1-S4 | 拖拽源选择 | bundle 身份 → `.bundleURL(daemon bundlePath)`；daemon 未上报/裸二进制 → `.plainText("GlassPane")` | ✓ 同上 |
| P1-S5 | 打包与签名 | 两个 bundle `codesign --verify --strict` 通过，DR 为 `designated => identifier "<id>"`（不含 cdhash），`Info.plist` 已绑定，`CFBundleIdentifier` 与签名 identifier 一致 | ✓ 2026-09-19 实测（debug 与 release 产物各一轮） |
| P1-S6 | 安装器接线 | `bundlePlan`/`daemonLaunchPath`/`settingsLaunchPath`/`installBundles`/`bundleLaunchArgs`/`pidsFromPs`/`terminatePids`/`waitForSocket` 纯函数用例全绿；`nextStepsText` 按形态给出真实条目名 | ✓ installer 37 用例（2026-09-19，原 21 + 新增 16） |
| P1-S7 | 端到端 | daemon 以 bundle 身份服务 socket，`hello` 自报 `entryName="GlassPane Daemon"`、`hasBundleIdentity=true`，未授权席位如实 `notDetermined` | ✓ 2026-09-19（留档 `engine/smoke.md`） |
| P1-S8 | 真机目视 | 系统设置「辅助功能/输入监控/屏幕录制」列表出现带图标的「GlassPane Daemon」，勾选后可点亮；授权跨 `swift build -c release` 重编译不丢 | ◐ 部分完成（2026-09-19 用户实测：辅助功能条目**自动出现且可勾选**；输入监控需手动拖入→由 S10 修掉；重编译回归待做） |
| P1-S9 | 席位重探 | `PermissionReprobe.script/submitCommand/parse/kindsNeedingRestart` 纯函数用例：带空格路径加引号、缺 subject 不猜、重探失败不假称待重启；重启命令为 `kickstart -k` 且仅由用户点击触发 | ✓ `PermissionSubjectTests`（2026-09-19，engine 全量 326 用例 0 失败） |
| P1-S10 | 输入监控条目登记 | `request(.inputMonitoring)` 在未授权时调用一次 tap 登记探针、已授权时跳过（注入式断言，不建真 tap） | ✓ 同上 |
| P1-S11 | 开发者工具入口修正 | 深链指向 `Privacy_DeveloperTools`，文案不再声称"无系统总开关"、仍声明"状态未验证不伪造" | ✓ `PermissionGuideTests` 2026-09-19 真机核对修正 |
| P1-S12 | 调试能力机器验证 | `PermissionReprobe.script(arguments:)` 可切 `--check-developer-tools`；`DeveloperToolsCapability.parse` 只认 `capability="developer-tools-debug"` 结构，缺字段即 nil；状态映射 ok→granted / denied→denied / timeout·spawnFailed→unverifiable；结论文案含"非实时读数" | ✓ `PermissionSubjectTests`（2026-09-19，engine 全量 358 用例 0 失败）；本机真探测回 `launch=ok / attach=spawnFailed / granted=true` |
| P1-S13 | 面板渲染机器核验 | 每张卡的状态以稳定 `identifier` 出现在 `observe` 树里（`PermissionGuide.statusIdentifier`）：必备三卡 `gp-perm-*-granted`，开发者工具卡 `gp-perm-developer-tools-unverifiable` | ✓ 2026-09-20 机器闭环（经产品自身通道 attach 面板 pid → `observe` 读到全部四条，不依赖截图与人工目视）；`screencapture` 仍受屏幕录制席位限制，见 smoke.md |
| P1-S15 | 信号收尾可用 | `glasspaned` 收到 SIGTERM/SIGINT 后自行退出（码 0）并 unlink engine/probe 两个 socket；回归闸 `engine/.signal_smoke.py` | ✓ 2026-09-20（修复前两案均 6s 不退出，修复后全过；`--replace-daemon` 不再需要 SIGKILL 兜底） |
| P1-S16 | 开机自启真生效 | 安装器收拢旧实例后由 launchd 接管（`kickstart -k`），`launchctl print` 为 `state = running` 且机面上只有一个 daemon；plist 已加载定义（`program`）与本次安装路径不一致时 `bootout` + `bootstrap` 重新注册 | ✓ 2026-09-20（`loadedLaunchdProgram`/`launchdNeedsReregister` 纯函数 + 真机接管复跑）；登录路径同轮实测：`bootout` → `bootstrap`（RunAtLoad 即登录时加载的同一入口）→ `state = running`，四项席位读数不变（授权跨完整重载保持）；随后 `kill -TERM` → `last exit code = 0`、`state = not running` 且 launchd **不复活**，与 `KeepAlive(SuccessfulExit=false)` 语义一致（修复前 TERM 完全无效，只能 KILL → 会被立刻重拉） |
| P1-S17 | remedy 与成因一致 | 通道存活类失败（`treeCaptureFailed` 预算/超时）不再把用户支去 `--grant-accessibility`，而是给出缩小范围动作 + 自查命令；窗口捕获失败指向屏幕录制席位并说明降级形态；错误码一律不动（码表冻结） | ✓ 2026-09-20（`EngineCore.map` 的 per-instance remedy，3 条单测：预算类 / 非预算类回落授权引导 / 屏幕录制类） |
| P1-S18 | 启动器路径可执行 | `Launchctl.path` 按 `/bin` → `/usr/bin` 依 `isExecutableFile` 解析（真机：`/usr/bin/launchctl` 不存在），面板的授权申请/重探/验证/kickstart 全部走它，单测把住 | ✓ 2026-09-20（`testLaunchctlPathResolvesToRealBinary`）；修前所有 launchd 动作静默失效，修后端到端跑通 |
| P1-S19 | 失败阶段可判读 | 一次性任务结局 `text / writeFailed / spawnFailed / timedOut`，面板据此给出 8 个互不冒充的标识（在途 1 + 失败 4 + 结论 3），失败文案一律落回"未验证" | ✓ 2026-09-20（`testCapabilityMarkersNeverImpersonateEachOther`；本批靠它一次点击定位到 spawn 失败） |
| P1-S20 | 面板文案面向用户 | UI 字符串不写规格编号、不写实现自辩；可操作控件带稳定 identifier 以便自动化定位 | ✓ 2026-09-20（`gp-guide-*`/`gp-verify-*`/`gp-restart-daemon`/`gp-refresh`；测试断言不含 §） |
| P1-S14 | 错误 remedy 可执行 | `assert_element` 缺信号上下文时仍回 `GP_E_NO_OPERATION`（码表与 P0 §3.3 语义不动），但 remedy 改为可执行的 "run act first"，消除自指循环 | ✓ 2026-09-20（走 `GPError` 的 per-instance remedy 通道） |
| P1-S21 | 请求超时必然交付 | `EngineJsonRpcClient.call` 的超时定时器不得 `unref()`；回归在**裸子进程**里跑（除该 Promise 外无 handle）：缺陷态 exit 13/无输出，修后 exit 0 + `REJECTED GP_E_ENGINE_UNREACHABLE` | ✓ 2026-09-21（CI 第二次真跑暴露；`mcp-shell/test/fixtures/timeout-loop.mjs`，本地 mcp-shell 71 用例全绿） |

---

## 12. 面板控制台化（v1.2 追加，2026-09-22）

### 12.1 为什么扩

§6.2 把面板定义为"权限 onboarding 一页"，这在 P1 批三时是完整的：那时 evidence 仅内存态、没有项目注册表、没有审批台账。到 2026-09-22，磁盘上已实测存在 **561 条证据档案**（`~/.glasspane/evidence/`）、**68 条项目注册项**（`projects.json`）、**38 条审批签名链记录**（`approvals.json`），全部只有 daemon CLI 读得到，**没有任何人类界面**。"让开发者回到桌面就能审计"（综述 §5.14 / PRD US-10）在 GUI 面上是缺的。

### 12.2 结构与不变量

| 面 | 内容 | 不变量 |
|---|---|---|
| 导航 | `NavigationSplitView`：首次使用（权限，默认落点）／日常审计（证据档案 · 项目 · 审批台账）；侧栏底部常驻 daemon 存活点 | 默认落点恒为权限页，**§10/§11 的全部既有断言不得回退**（P1-C6 冒烟逐条复跑） |
| 窗口标题 | 只在根设一次 `GlassPane 设置` | 各页**不得**再设 `navigationTitle`——实测会把窗口标题顶成页名，P1-C6 `FAIL window title missing`；页名改由页内 `PageTitleView` 表达 |
| 页签可驱动性 | 侧栏条目是显式 `Button`（非 `List(selection:)` 行） | SwiftUI 侧栏行在 AX 树里是 **AXStaticText**，`act` 按标识选不中也不能按动 → 页签必须 `gp-nav-<section>` 可 `act`（实测三条 `actConfirmed=true`） |
| 数据面 | `GlassPaneEngine/LocalArchive.swift`：档案扫描、摘要折算、筛选、测试残留判据、台账校验，全部纯函数 + 目录/读文件可注入 | 面板壳仍不做逻辑单测（§9.3）；**读侧逻辑一律下沉到 engine 库并在 CI 单测**（`LocalArchiveTests` 15 用例） |
| 协议面 | 只读已落盘文件 | **§6.5 冻结面不变**：不新增 socket 方法、不新增 MCP 工具、不碰 evidence/decision-log/recipe schema |
| 写入面 | 面板不写 `projects.json`；清理/删除只经 daemon 一次性 CLI（`--project-prune` / `--project-remove`），随后提示"重启后台服务才生效" | 运行中的 daemon 内存持有一份注册表，面板直接覆写会被它下一次写盘**静默冲掉**——静默失效正是 §11.8 复盘的那类缺陷 |
| 诚实呈现 | 目录缺失 / 目录为空 / 有文件解不开 三者分开；未测量通道（无屏幕录制时的像素）保持 nil 并写"未测量"；`daemon:auto` 记录显式标为"后台服务自批"并计数 | 与 README"拿不到数据就显示未验证，永远不会为了好看而点亮"同源 |

### 12.3 测试残留判据（双条件，宁漏勿误）

`bundleId == com.example.app` **且** `evidenceStoragePath` 落在系统临时目录（`NSTemporaryDirectory()` 及其 symlink 解析形、`/tmp/`、`/private/tmp/`）。实测命中当前全部 68 条；真项目即使误配同名 bundleId，只要证据不在临时目录就不会被自动清。删除前必须先 `--dry-run` 出清单、在面板确认表里逐条可见。

### 12.3.1 两条 CLI 的输出契约（2026-09-23 与代码对齐后补）

判据只有一份（`LocalArchive.isTestResidue`）：面板的预览表与 `--project-prune --dry-run` 用的是同一个函数，不存在两处各写一遍"什么算残留"。

| 命令 | 字段 | 退出码 |
|---|---|---|
| `--project-prune [--dry-run]` | `dryRun` `total`（修剪前条数）`matched`（命中）`pruned`（**真正落盘**条数）`prunedProjectIds` `failed` + `failures[]`（逐条原因）`remaining`（修剪后条数）`loadFailed` `requiresDaemonRestart` `projects[]`（命中明细） | 命中 5 条只删掉 3 条即为 **1**；`loadFailed` 为 1；其余为 0 |
| `--project-remove <id> [--dry-run]` | 实删：`removed` `projectId` `remaining` `requiresDaemonRestart`；`--dry-run`：`dryRun` `wouldRemove` `found` `remaining` `loadFailed` | 未知 id → 3；拒绝覆写损坏表 → 1；成功 → 0 |

`pruned` 取的是"写成功并有读回校验"的条数，不是命中条数——一次把 `pruned` 写成 `matched` 的修剪，等于在用户问"删了多少"时撒谎。`--dry-run` 对两条命令都成立：带它却不预览、直接真删，是面板"先看清单再动手"承诺的反面。

### 12.3.2 注册表写入的安全边界（同批补，与 A-1 事故同源）

* `ProjectRegistry(filePath:)` / `EvidenceStore(directory:)` **没有缺省路径**；活路径（`~/.glasspane/…`）只有 `live()` 一个入口，且只允许 `glasspaned` 引用。`EngineCore` 不再在缺省时自建活注册表。
* 读不回的 `projects.json` 一律**拒绝覆写**（`loadFailed` 锁不做自动解锁：自动重读会丢掉本次写入，照旧覆写会丢掉文件里的真条目，两个方向都是无声丢数据）。错误文案给出可执行补救（修文件 + `--restore-launchd` 或面板重启），不指向不存在的解锁接口。
* 每次写入 = 先写临时件 → 原子替换 → 清掉 `replaceItemAt` 留下的备份件 → **读回比对字节**；任何一步失败即抛错，且内存表保持不变（写失败不留幻影条目）。
* 没有注入档案的核心**拒绝**执行删档（`pruneEvidence`），不再回落到 `~/.glasspane/evidence/`——那是一条从单测就能不可逆清掉用户证据档案的路径。
* 以上四条各有一个回归用例，另有一道源码扫描闸（`ProjectRegistryIsolationTests`）：测试里出现活路径字样、或生产代码里活路径引用超出 daemon 入口，即红。

### 12.4 验收项

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P1-S22 | 控制台四页可用且旧断言不回退 | `.c6_smoke.py` 全绿（四卡 identifier + 跳转 AXButton + ≥12 AXStaticText + 折叠三角 + 窗口标题）；三张新页签 `act` by identifier 全部 `actConfirmed=true` | ✓ 2026-09-22 真机（隔离 socket `/tmp/gp_c6.sock`，未碰现网 daemon） |
| P1-S23 | 档案读侧逻辑可 CI 测 | `LocalArchiveTests`：缺目录≠空档案、解不开的文件按名列出、排序稳定、未测通道保持 nil、残留判据双条件、台账损坏不读成"空但健康" | ✓ 2026-09-22（`swift test` 390 通过 0 失败，基线 374） |
| P1-S24 | 面板文案不出现重复前缀与错位指代 | "缺少时："由视图单侧负责（`PermissionDescriptor` 归一）；安装器使用说明里的 UI 指代随改名同步 | ✓ 2026-09-22 |
