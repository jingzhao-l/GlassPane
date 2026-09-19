# GlassPane P1 实施规格 v1.1 — 快照/恢复原语 + 性能型熔断

- 契约真源角色：P1 第二子项目的实施契约（P1 首批 = SCK 迁移 + 屏幕录制权限 onboarding，见 `GlassPane_P1_实施规格_v1.0_SCK迁移.md`，其全部验收项已达标且正文不变；本规格基于 v1.0 的章节结构与约束体系迭代，不删减既有内容，仅追加批次二范围）
- 版本：v1.1-draft
- 日期：2026-09-16
- 关联决策：5.8 §5.1 工具子集（快照/恢复类原语 P1 进入）、§5.7 状态时间旅行（三档机制与档 1 恢复验收 C34）、§5.12 性能熔断（R41：性能型熔断 P1 进入）、§390（事务原语分工：kernel 编排、Swift 执行）、PRD US-04 / FR-08（状态时间旅行）

---

## 变更说明（相对 P1 v1.0 批次）

P1 首批（v1.0）只覆盖 SCK 迁移与权限 onboarding。本批次按综述 §5.1 的 P0 口径缺口补齐 **快照/恢复类原语**（P0 明确"P1 进入"），并按综述 §5.12 R41 落地 **性能型熔断**（操作耗时触发）。两者均保持既有通道契约与 evidence schema 不变：

- 快照/恢复不新增 evidence schema 字段（`circuitBreaker.reason` 已存在，直接复用）；不新增 kernel schema 文件（快照是测 app 状态的可观测基线，不属于 evidence 包）。
- 恢复执行遵循综述 §390 分工：kernel/编排层逻辑不动（P1 无 kernel 事务调用），恢复的**实际执行仍是 Swift Engine**（本批次实现档 2 ffwd 重演原语）；档 1 全量快照恢复依赖 Z5 白盒探针 SDK 进入，P1 诚实边界声明（见 §4 风险）。
- 性能熔断只改 EngineCore 的 evidence 组装判定与阈值常量，不触碰通道健康熔断（0–3 级）的既有语义，二者通过「取 max 但不降级通道故障级」的方式叠加。

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
| P1-B7 | 真机冒烟（可选，需 AX 权限） | 真机 attach 后 snapshot 返回真实 digest；restore ffwd 对可用动作成功重演 | ✓ 已完成（2026-09-19 真机冒烟：Notes 全链 attach→observe→act→snapshot 真实 digest→restore ffwd confirmed=1/total=1；restore 后审批台账落盘 + `--approval-verify` count=1 valid ✓，见 smoke.md） |

> 注：快照/恢复与性能熔断均为纯逻辑可测（fake channel + 注入 clock），无动系统权限即可跑 CI；真机冒烟照旧为可选人工项。

---

## 5. 风险与边界（诚实声明）

1. **档 1 全量快照恢复未进入**：依赖 Z5 白盒探针 SDK 的进程级状态导出/回滚能力（综述 §5.7 不可快照区、§390 分工），Z5 进入前的 P1 只能提供档 2 ffwd 原语与基线一致性度量；C34 验收入口随之后移。
2. **性能熔断为预算守护而非延迟治理**：10s 硬阈值只做 evidence 标记与升级，不主动取消/中断操作（AX 层已有 10s 树读取预算兜底）；若需"耗时超支自动中断"属后续性能治理批次。
3. **ffwd 重演依赖 act 可重放性**：steps 里任何不可重放动作（如仅一次性的 pick）按 `GP_E_RESTORE_STEP_FAILED` 降级，与 P0 §8 降级口径一致；`consistent` 为基线参照比对，不作为通过/失败断言。
4. **快照仅内存**：daemon 重启后快照丢失（与 evidence history 同生命周期），agent 需在会话内快照→restore 连续使用。