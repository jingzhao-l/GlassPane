# GlassPane P5 实施规格 v5.0 — 方向候选四连批（审批签名链 / 恢复快照 tier-1 基建 / 保留策略 / CLI 维护入口）

- 契约真源角色：P5（新规格系列首版）的实施契约。P4 v4.0 已按 §30.6 声明"实施规格系列正式收口，后续新需求/新阶段**另起新规格系列文档，不在本系列追加（避免复制继承文件持续膨胀）**"；本系列即在 v4.0 之后启动，承接 P4 §32 遗留面中"方向候选/延伸项"被确认的四件事（审批/权限签名链、恢复快照 tier-1 基建、保留策略按天数/项目维度、CLI 维护入口）的正式落地批次
- 版本：v5.0（P5 系列首版）
- 日期：2026-09-18
- 关联决策：P4 v4.0 §30.6（新系列开启规定）、§32 遗留与边界（人工冒烟/公证/无头边界/kernel Phase B/R44 观察权申明）、P1 v1.1 §1（档 1 全量快照恢复诚实边界与 GP_E_RESTORE_UNSUPPORTED）、P1 v1.6 §12（evidence 归档上限 maxFiles 与 FIFO-by-mtime 修剪）、P1 v1.4 §3（daemon CLI 命令先例）、综述 §5.7（三档时间旅行与不可快照区）、综述 §5.14/R36（evidence 审查 UX）
- 系列继承：本系列基于 P4 v4.0 的**头部结构与铁约束体系**复制迭代——不删减既有约束与结论，仅改写"版本/范围/关联决策"标识并追加本系列四批内容；P0–P3 及 P4 的全部规格正文（§1–§32）在 v4.0 文件中保持原样为系列档案，本系列不复刻其正文，仅继承其约束结论（防膨胀，v4.0 §30.6 规定）

---

## 变更说明（P4 v4.0 → P5 v5.0 系列转移）

P4 收口清点（§32）明确列出了"方向候选、未实现"的四个延伸项，本系列把四件事逐批落地为**契约真源 + 完整实现**。四批均遵守 v4.0 §30.5 铁约束复核表中的冻结面：

- **daemon/socket 方法表冻结**：本系列四批**零新方法表条目、零新 socket 帧**（全部落在 engine 纯逻辑、EngineCore 内部协调、daemon CLI 命令、EvidenceStore 存储层原语四个既有面上）；
- **错误码冻结**：GP_E 表自 v1.4 后不再新增，四批复用既有错误码（GP_E_RESTORE_UNSUPPORTED / GP_E_NOT_FOUND / GP_E_BAD_PARAMS 等），**零新错误码**；
- **kernel schema 零修改**：四批不触碰 kernel 任何文件（含 fixtures/zod/JSON Schema）；Swift 侧新结构（ApprovalRecord/SnapshotProbeInfo/RestorePlan）均为 engine 内部形态，不入 evidence schema、不进决策链；
- **依赖许可**：四批 Swift 侧零第三方依赖（仅 Foundation/标准库），不新增依赖面；
- **可测性边界（R45）**：四批全部为纯逻辑 + 文件 I/O，100% 单测可覆盖，不进真机面（真机冒烟项照旧可选人工，见各批验收表）。

批次总览：

- **批一：审批/权限签名链**（此前无规格、未实现）——engine 新增 `ApprovalGate`：高风险操作登记、审批记录哈希链（prevHash 防抵赖）、approvedBy/timestamp/hash、签名链审计；EngineCore.restore 挂接登记；daemon CLI 新增 `--approval-audit`/`--approval-verify`。
- **批二：恢复快照 tier-1 管线基建**（此前明确"档 1 不实现、依赖 Z5 探针"）——本批落地"完整管线 + 探针信号接入点 + 无探针如实拒绝"：`AppStateSnapshot` 增探针负载字段、`RestorePipeline` 纯逻辑生成并校验恢复计划、restore 增 `rollback_full` 形态；无探针负载时维持 `GP_E_RESTORE_UNSUPPORTED` 诚实边界（不伪造"已支持全量回滚"）。
- **批三：保留策略按天数/项目维度**（此前仅 maxFiles FIFO 上限）——EvidenceStore 增 `maxAgeDays` TTL 修剪（写时 + 显式维护）与项目目录维度修剪，升级"磁盘为全量档案不过期"口径为"TTL 可选过期 + 上限双约束"。
- **批四：CLI 维护入口**（此前 prune/stats/clear 仅为存储层原语）——daemon CLI 增 `--prune-evidence [--older-than <days>] [--project <id>] [--dry-run]` 与 `--evidence-stats [--project <id>]`，打通存储层原语到命令行维护面。

批次范围要点分章如下（§3–§14），收口验收总表见 §15。

---

## 3. 批一：审批/权限签名链（新增章节）

### 3.1 定位

对应方向候选"审批/权限签名链"：高风险操作（快照恢复、档案维护等）的**不可抵赖审批审计**。此前仓库无任何审批/签名链机制：高风险操作执行无"谁在何时批准了什么"的留痕，事后无法审计追溯。本批引入 engine 纯逻辑组件 `ApprovalGate`——每条审批记录以 **prevHash 链式串联**（后一条的哈希包含前一条，任一历史记录被改动即导致后续全部 hash 校验失败），提供一个**防篡改、可验证的审批台账**。

**诚实边界**：本批落地"审批台账（记录 + 哈希链 + 审计）"与"高风险操作自动登记"，不伪造人工审批流——当前协议无"请求审批→人工批准→再执行"的交互面（socket 方法表冻结），故登记源为 daemon 自动登记（approvedBy 记 `daemon:auto`），decision 记 approve；`deny` 决策在数据模型与校验面完整支持，供未来具备人工交互面的批次启用后方产生。

### 3.2 数据模型（engine 纯逻辑，`ApprovalGate.swift`）

```swift
public enum RiskTier: String, Codable { case low, medium, high }
public enum ApprovalDecision: String, Codable { case approve, deny }

public struct ApprovalRecord: Codable, Equatable {
    public let approvalId: String     // appr_ + Crockford base32 (26)
    public let operationRef: String   // 关联操作标识（如 snapshotId / operationId / CLI 名）
    public let operationType: String  // 如 "restore"/"prune-evidence"
    public let riskTier: RiskTier
    public let decision: ApprovalDecision
    public let approvedBy: String     // 登记人；daemon 自动登记为 "daemon:auto"
    public let reason: String         // ≤512 字符
    public let timestamp: String      // ISO-8601 毫秒 UTC（与 EvidencePack.createdAt 同格式）
    public let prevHash: String       // 前一条记录 hash 全量（64 hex）；创世记录为空串 ""
    public let hash: String           // 本条 hash 全量（64 hex），见 §3.3
}
```

**创世/空台账规则**：台账为空时 append 创世记录 prevHash = `""`；非创世 prevHash = 链尾 hash。`chain()` 空台账返回 `[]`。

### 3.3 哈希链算法

- 哈希输入 = **规范序列化**：对 `{approvalId, operationRef, operationType, riskTier, decision, approvedBy, reason, timestamp, prevHash}` 取 key-sorted JSON（复用 `CanonicalJSON` 的排序范式）序列化后的字节；
- `hash = SHA-256(上述字节)` 的**完整 64 十六进制串**（与 decision-log `prevEntryHash` 的 64-hex 口径一致；不截图前 16 字节——审批链是审计台账，取完整摘要）；
- `ApprovalGate.append(record)`：自动补全 approvalId（`appr_` + Crockford base32 26，与 op_/snap_/prj_ 同生成器）、timestamp（当前时钟）、hash（prevHash = 链尾 hash）后入链；
- `verifyChain()`：从头到尾重放，逐条重算 hash 并与记录内 hash 比对，且校验第 N 条的 prevHash == 第 N-1 条已校验的 hash；全部通过 → `(valid: true, firstBrokenIndex: nil)`；任一处不符 → `(valid: false, firstBrokenIndex: 首个坏链索引)`。

### 3.4 持久化

- 可选文件路径注入（`ApprovalGate(path: String?)`）；path 为 nil 时**纯内存**（测试默认）；
- 非 nil：初始化时按"文件存在→解码校验→加载链；缺失→空台账；损坏→空台账（诚实：损坏台账不静默当有效，verify 会暴露）"；每次 append 后**原子写回**（`.tmp` + replaceItemAt，与 EvidenceStore/ProjectRegistry 同范式），写失败不中断 append（内存台账仍有效，磁盘侧缺失以 verify/audit 呈现）；
- daemon 默认路径 `~/.glasspane/approvals.json`（main.swift 注入，可经测试换成临时目录/纯内存）。

### 3.5 EngineCore 挂接

- `EngineCore` 新增可选 `approvalGate: ApprovalGate?`（nil = 不启用登记，保持既有行为不回归）；
- `restore(...)` 执行任意形态（ffwd / 基线一致性 / 探针计划）前，若 gate 非 nil 则登记一条：
  - `operationRef` = snapshotId，`operationType` = "restore"，`riskTier` = .high，`decision` = .approve，`approvedBy` = "daemon:auto"，`reason` = "restore executed: <mode 或 ffwd/compare>"；
  - 登记失败不阻断 restore（审批台账为审计面，不改变 restore 语义与返回）。

### 3.6 daemon CLI

| 命令 | 输出 | 退出码 |
|---|---|---|
| `--approval-audit` | 审批链 JSON 数组（key-sorted 编码），无 `--path` 覆盖时读默认路径 | 0；读取失败（损坏/不可读）→ 1 |
| `--approval-verify` | `{"valid": true/false, "count": N, "firstBrokenIndex": n/null}` | 0=完整 / 1=校验失败或读取失败 / 2=参数错 |

- 两命令为**维护面直读**（不经 socket、不入 daemon 主循环），与 `--list-projects` 同范式。

### 3.7 可测性与验收

- **engine 单测**（`ApprovalGateTests`，纯内存）：创世记录 prevHash 空串、hash 为链尾 64 hex；append 链式串联（第 N 条 prevHash == 第 N-1 条 hash）；空台账 chain/verify；verifyChain 对完整链返回 valid；篡改中间记录（改 decision/reason/approvedBy）→ invalid + firstBrokenIndex 指向坏链起点；篡改 prevHash → invalid；截断链尾 → invalid；持久化 roundtrip（写文件→新实例加载→字段一致 + verify 通过）；损坏文件加载→空台账；原子写无 `.tmp` 残留；`--approval-audit/--approval-verify` CLI 接入（main.swift 命令分支）。
- **EngineCore 集成**：注入 gate 后 restore 登记一条（operationRef/operationType/riskTier 断言）；gate 为 nil 时 restore 行为不回归。
- **全量回归**：engine 全用例 + mcp-shell 全用例不回归。

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P5-A1 | 创世与链式哈希 | 创世 prevHash 为空串；每条 hash 为其规范内容（含链尾 hash）的完整 SHA-256 64 hex | ✓ |
| P5-A2 | 链完整性校验 | 完整链 verify 通过；篡改任意记录字段 / prevHash / 截断 → invalid 且 firstBrokenIndex 正确 | ✓ |
| P5-A3 | 持久化 roundtrip | 原子写 + 重载一致性；损坏文件加载为空台账不静默待有效；写失败不中断内存链 | ✓ |
| P5-A4 | EngineCore 登记 | restore 执行时登记 high 风险记录；gate nil 时零回归 | ✓ |
| P5-A5 | CLI 维护命令 | --approval-audit / --approval-verify 输出与退出码符合 §3.6 | ✓ |
| P5-A6 | 全量回归 | 既有用例不回归（engine/mcp-shell） | ✓ |

### 3.8 风险与边界（诚实声明）

1. **登记源仅 daemon 自动登记**：协议无人工审批交互面（socket 方法表冻结），本批不伪造人工审批流；deny 决策为数据模型支持，待人工交互面批次启用后才有真实 deny 来源。
2. **台账为程序内审计而非密钥签名**："签名链"语义由哈希链承担（防篡改、可验证），不引入 PKI/密钥签发；若需强身份签名（开发者数字签名）属独立认证批次。
3. **无显式权限门控**：本批是"审批留痕/审计"，不是"审批门禁"（门禁需改协议语义，与冻结约束冲突）；谁批准了什么全程可溯，但决定是否阻断执行由未来门禁批次承载。

---

## 6. 批二：恢复快照 tier-1 管线基建（新增章节）

### 6.1 定位

对应方向候选"恢复快照 tier-1（需 Z5 探针）"。P1 v1.1 §1.1 定档：**档 1 全量快照恢复（进程级状态回滚）不实现（诚实边界）**，依赖 Z5 白盒探针 SDK（综述 §5.7 不可快照区），`restore` 对档 1 形态抛 `GP_E_RESTORE_UNSUPPORTED`，C34 验收入口后移。本批**不翻转该诚实边界**，而是兑现"**完整管线 + 探针信号接入点 + 无探针如实拒绝**"三件套——把 tier-1 从"一拍子拒绝"升级为"**管线就绪 + 探针缺席时结构化拒绝 + 探针接入点已预留**"：

- **探针信号接入点**：`EngineCore` 增加可选 `snapshotProbe` 注入槽（`() -> SnapshotProbeInfo?`），daemon 侧缺省 nil（仓库无 Z5 探针与开发 app 工程）；Z5 探针 SDK 进入后在此接入，无需改动协议；
- **管线本体**：`RestorePipeline`（纯逻辑）消费探针负载，产出**有序恢复计划**并做完整性校验（探针导出域 ↔ 快照基线 digest ↔ 计划域集合的一致性）；
- **诚实拒绝**：快照无探针负载时，`rollback_full` 形态维持 `GP_E_RESTORE_UNSUPPORTED`（remedy 指引探针接入后重试）；快照有探针负载时返回计划但显式标注 `rollbackExecuted: false` + `executionSurface: "z5-probe-runtime"`——**恢复执行面在探针运行时，damon 不伪造已执行**。

### 6.2 数据模型（engine 纯逻辑）

```swift
public struct SnapshotProbeInfo: Codable, Equatable {
    public let probeVersion: String            // 探针 SDK 版本，如 "z5-0.1.0"
    public let exportedDomains: [String]       // 导出的进程状态域（如 ["heap","objc","kvc-less-macro"]）
    public let stateDigest: String             // 导出状态整体 SHA-256 64 hex
    public let checkpointFormat: String        // 如 "z5-json-v1"
    public let capturedAt: String              // ISO-8601 毫秒 UTC
}

public struct RestoreStep: Equatable {
    public let domain: String
    public let checkpointRef: String           // 该域检查点引用（探针侧持久化 key）
    public let action: String                  // 默认 "rewrite"（域状态覆写）
    public let preconditions: [String]         // 该步前置条件声明（如 "parent-domain-restored"）
}

public struct RestorePlan: Equatable {
    public let snapshotId: String
    public let baselineDigest: String          // AX 树基线 digest（与快照同源）
    public let domains: [String]               // 有序：依赖排序后的执行域序
    public let steps: [RestoreStep]            // 按域序展开的逐步计划
    public let expectedStateDigest: String     // = 探针 stateDigest（计划验收的 digest 期望）
    public let domainCount: Int
}
```

`AppStateSnapshot` 追加可选 `probeInfo: SnapshotProbeInfo? = nil`（内存快照结构，不入任何 schema）。

### 6.3 RestorePipeline 语义（纯逻辑，无不依赖）

- `plan(snapshot:) -> RestorePlan?`：
  - 快照 `probeInfo` 为 nil → 返回 nil（调用方映射 GP_E_RESTORE_UNSUPPORTED）；
  - 域排序规则：域按**先决链**排序——声明了 `preconditions` 的域排在先决域之后；cyclic 依赖检测（检测到环 → 返回 nil，视为计划不可构建，调用方按 GP_E_RESTORE_UNSUPPORTED 呈现并附指引）；
  - 无先决声明的域按**域名字典序**稳定排序（确定性：同输入必同输出）；
  - `expectedStateDigest` = 探针 `stateDigest`（计划验收期望）。
- `validate(plan:, snapshot:) -> (valid: Bool, issues: [String])`：
  - 域集合与快照 `exportedDomains` 集合一致（无多余/无遗漏）；
  - 无重复域；step.checkpointRef 非空；域序满足全部先决（拓扑序自检）；
  - `plan.expectedStateDigest == snapshot.probeInfo.stateDigest`；
  - issues 数组如实列每个不满足项（空 = valid）。
- **防探针数据篡改**：`verifyStateDigest(snapshot:) -> Bool`——重算/比对探针自报 digest 与计划期望，篡改负载会让计划校验失败（诚实校验，不作为"探针真实导出"断言，那是 Z5 批次职责）。

### 6.4 EngineCore 集成

- `EngineCore.init` 增加 `snapshotProbe: (() -> SnapshotProbeInfo?)? = nil`（探针信号接入点）；daemon 不注入（无探针），测试注入脚本化负载；
- `snapshot()`：捕获后附 `probeInfo = snapshotProbe?()`（实际恒 nil，除非测试注入）；
- `restore(mode: "rollback_full")` 新形态分支（在既有 `restore_snapshot` 拒绝分支**之后**新增值分支，不改变既有行为）：
  - snapshotId 不存在 → 既有 `GP_E_NO_SNAPSHOT`（不变量先于形态校验）；
  - 快照 probeInfo 为 nil → `GP_E_RESTORE_UNSUPPORTED`（**与既有档 1 拒绝同码同语义**，remedy 指引："tier-1 需要 Z5 探针负载；当前快照无探针数据，接入探针后重新 snapshot"）；
  - 快照 probeInfo 非 nil → `RestorePipeline.plan` + `validate`；plan 不可构建/校验失败 → `GP_E_RESTORE_UNSUPPORTED`（reason 含验证 issues 摘要，如实说明为何不可执行）；通过 → 返回：
    ```
    { snapshotId, baselineTreeDigest, plan: {domains, steps, expectedStateDigest, domainCount},
      planValid: true, rollbackExecuted: false, executionSurface: "z5-probe-runtime",
      consistent: true }
    ```
    `rollbackExecuted: false` 为**硬声明**——计划就绪但进程级回滚执行面在探针运行时，daemon 无此运行时，如实呈现。
- restore 登记 ApprovalGate（批一挂接）对 `rollback_full` 同样生效。

### 6.5 可测性与验收

- **engine 单测**（`EngineP5Batch2Tests` + `RestorePipelineTests`，ScriptedChannel + 注入探针槽）：plan 域排序（先决链 + 字典序稳定）、cyclic 依赖 → nil、validate 通过/列举 issues（域不一致/重复域/空 checkpointRef/先决不满足/digest 不一致）、verifyStateDigest 篡改检出、EngineCore `rollback_full` 三分支（无探针负载 → GP_E_RESTORE_UNSUPPORTED；有负载通过 → planValid + rollbackExecuted false + executionSurface；noSnapshot 不变量），既有 restore 形态（ffwd/compare/restore_snapshot 拒绝）零回归。

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P5-B1 | 探针接入点 | snapshotProbe 注入槽存在；缺省 nil；快照捕获可携带合成探针负载 | ✓ |
| P5-B2 | 计划构建 | 先决链排序 + 无先决域字典序稳定；cyclic 依赖返回 nil | ✓ |
| P5-B3 | 计划校验 | 域集合/重复/checkpointRef/先决/digest 一致性逐项列 issues；干净计划 valid | ✓ |
| P5-B4 | 防篡改校验 | 探针 stateDigest 与计划期望不一致 → 校验失败 | ✓ |
| P5-B5 | tier-1 三分支 | 无探针负载 → GP_E_RESTORE_UNSUPPORTED；有负载 → planValid+rollbackExecuted:false+executionSurface；noSnapshot 先决 | ✓ |
| P5-B6 | 既有形态回归 | ffwd/compare/restore_snapshot 拒绝行为与批二起各用例一致 | ✓ |

### 6.6 风险与边界（诚实声明）

1. **恢复执行面缺位**：计划生成/校验/防篡改在本批真实落地且可单测；**进程级状态回滚执行**依赖探针运行时，仓库无探针 → `rollbackExecuted: false` 硬声明，任何用户/agent 读到的都是"计划就绪、未执行"，不伪造已回滚。
2. **探针负载为合成夹具**：单测用合成 SnapshotProbeInfo 覆盖管线逻辑；Z5 探针真实导出格式（checkpointFormat）以未来 Z5 批次校准，若格式漂移 → 管线适配层小改，协议不变。
3. **C34 验收入口继续后移**：档 1 保真率断言（≥95%、分级恢复时间）仍依赖真机 + 探针，属未来批次；本批为 C34 提供 tier-1 侧的"计划一致性度量"前置。

---

## 9. 批三：保留策略按天数/项目维度（新增章节）

### 9.1 定位

对应方向候选"保留策略按天数/项目维度"。P1 v1.6 §12 已实现**归档上限 maxFiles + FIFO-by-mtime 修剪 + stats/clear**，但磁盘档案口径仍为"**全量不过期**"（§9.4：不过期；§11.3 风险 3：无压缩/归档策略）。本批把保留策略补齐为三约束叠加：

- **上限约束（既有）**：文件数 > `maxFiles` → 按 mtime 删最旧过量条；
- **期限约束（本批新增）**：文件年龄 > `maxAgeDays` → 过期删除（TTL）；
- **维度约束（本批新增）**：按**项目维度**执行维护（prune/stats 可指定 projectId，作用于该项目 evidenceStoragePath 目录）。

### 9.2 EvidenceStore 扩展（`EvidenceStore.swift`）

- 新增 `public private(set) var maxAgeDays: Int?`（nil = 不过期，默认 nil，既有语义零变化）；构造参数 `maxAgeDays: Int? = nil` + `setRetention(maxAgeDays: Int?)`；
- **钳制规则**：`maxAgeDays` 非 nil 且 < 1 → 视为 nil（禁用）——"0 天后过期=写即删"是误配，钳制为禁用而非清档（与 maxFiles 钳到 ≥1 的语义对齐，方向相反）；
- **过期判定**（`isExpired(url:) -> Bool`）：优先解码文件内 `EvidencePack.createdAt`（ISO-8601 解析，与 clock 无耦合——用文件 mtime 差不足以表达"过期"？**定义：过期 = createdAt 距"现在"超过 maxAgeDays**，"现在"取注入时钟可测——EvidenceStore 无时钟注入，追加 `now: () -> Date = { Date() }` 形参化，测试注入固定时刻）；解码失败（损坏条目）回退**文件 mtime** 判定（诚实降级：无法确证创建时间的条目按修改时间判，与 FIFO 修剪同口径）；
- **写时修剪**：`write` 成功路径在 `pruneIfNeeded()` 之后追加 `pruneExpiredIfNeeded()`（TTL 命中即删；新写入条目 createdAt = 当前时刻必不过期，无自删风险）；
- **显式维护**：`@discardableResult public func prune(olderThanDays: Int) -> Int` 一次性按 TTL 修剪并返回删除数（供 CLI 维护入口与项目维度调用；目录缺失/为空返回 0）；
- `stats()` 语义不变（count/totalBytes），新增可选 `oldestCreatedAt: String?`/`newestCreatedAt: String?`? ——**不做字段膨胀**，保留既有 `EvidenceArchiveStats` 形态（维护观测走 CLI `--evidence-stats` 的 count/bytes）。

### 9.3 项目维度维护（EngineCore）

`EngineCore.pruneEvidence(projectId: String?, olderThanDays: Int) throws -> Int`：

- `projectId == nil`：作用于当前 store 目录（`evidenceStore?.directory ?? EvidenceStore.defaultDirectory`；attach 未发生时为默认目录）；
- `projectId != nil`：`projectRegistry.get(projectId)` 未命中 → `GP_E_NOT_FOUND`（既有码）；命中 → 目录 = `entry.evidenceStoragePath ?? EvidenceStore.defaultDirectory`，在该目录构造临时 EvidenceStore 执行 `prune(olderThanDays:)` 返回删除数（**不污染活跃 store 的目录状态**）；
- 目录不存在 → 返回 0（stat 语义同 store：缺失目录零删除，不抛）。
- 本项目维度为**存储层原语**（无 socket 帧、无方法表变更）；CLI 批四消费之。

### 9.4 生命周期与隔离口径更新

| 关注面 | v1.6 口径 | 本批新口径 |
|---|---|---|
| 磁盘档案 | 全量不过期 | **TTL 可选过期（maxAgeDays）+ 上限（maxFiles）双约束**；默认 nil 维持"全量不过期"默认语义 |
| 项目隔离 | attach 按项目目录 | 维护面新增按 projectId 显式指定目录执行 prune/stats |
| 过期依据 | — | 优先 pack.createdAt，损坏回退 mtime |
| 回归保证 | 默认上限下不触发 | maxAgeDays 默认 nil 下 TTL 修剪不触发（P1-F1..F8 语义零变化） |

### 9.5 可测性与验收

- **engine 单测**（`EngineP5Batch3Tests`，临时目录 + 注入时钟）：TTL 到期删除（写入"过去"createdAt 的 pack → prune 删除；未到期保留）；钳制（0/负 → 禁用）；createdAt 优先 / 损坏回退 mtime；写时修剪触发与不触发；`prune(olderThanDays:)` 返回删除数；**项目维度**：registry 注册含 evidenceStoragePath 的项目 → 项目目录写入 → pruneEvidence(projectId:) 只删该项目目录（另一项目目录不受影响）；未知 projectId → GP_E_NOT_FOUND；projectId nil 走当前目录；引擎集成（EngineCore → EvidenceStore 联动）。

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P5-C1 | TTL 修剪 | 超龄条目删除、未到期保留；删除数正确 | ✓ |
| P5-C2 | 钳制 | maxAgeDays 0/负 → 禁用（改为 nil），不"写即删" | ✓ |
| P5-C3 | 过期依据 | createdAt 优先；损坏条目按 mtime 回退；注入时钟可测 | ✓ |
| P5-C4 | 写时修剪 | TTL 配置下 write 后自动清过期条目；默认 nil 不触发 | ✓ |
| P5-C5 | 项目维度 | pruneEvidence(projectId:) 作用于该项目目录且不波及他项目；未知项目 GP_E_NOT_FOUND；nil 走默认 | ✓ |
| P5-C6 | 回归 | 既有 maxFiles FIFO / stats / clear 用例不回归 | ✓ |

### 9.6 风险与边界（诚实声明）

1. **TTL 依赖 created_at 正确性**：decode 失败条目回退 mtime（损坏档案的无损可删），与 FIFO 修剪同口径；无卡可伪造创建时间（createdAt 为 EvidencePack 解码所得，写时生成）。
2. **项目维度依赖项目注册表**：未注册项目无法按维修剪（却可走默认目录全局维护）；目录隔离仍为"配置则隔离、未配置共享默认"（v1.5 §9.4 口径不变）。
3. **无自动过期线程**：TTL 仅在写时与显式维护触发（无后台线程），保证 daemon 无新增定时器/线程面（线程与生命周期约束），维护时机由调用方控制（CLI 批四）。

---

## 12. 批四：CLI 维护入口（新增章节）

### 12.1 定位

对应方向候选"CLI 维护入口"。v1.6 的 `prune/stats/clear` 是 EvidenceStore **存储层原语**（供 daemon/main/维护入口调用），无独立 CLI 命令，维护者无法在命令行直接执行"按天数修剪 / 查看档案规模 / 按项目清理"。本批在 daemon CLI 层补上维护入口（**零 socket 帧**，`--list-projects`/`--active-project`/`--recipe-validate` 同范式）。

### 12.2 命令表

| 命令 | 参数 | 输出 JSON | 退出码 |
|---|---|---|---|
| `--prune-evidence` | `[--older-than <days>]` 天数必需（≥1，默认 30）<br>`[--project <id>]` 项目维度<br>`[--dry-run]` 只统计不删除 | `{"pruned": N, "dryRun": bool, "project": id/null, "dir": "<绝对目录>"}` | 0 成功 / 1 未知项目 / 2 参数错 |
| `--evidence-stats` | `[--project <id>]` | `{"count": N, "totalBytes": B, "project": id/null, "dir": "<绝对目录>"}` | 0 成功 / 1 未知项目 / 2 参数错 |

- `--older-than` 使用规则：仅 `--prune-evidence` 接受，缺省 30；解析为 Int，非数字/≤0 → 退出码 2 + stderr 说明；
- `--dry-run`：调用与真实修剪完全相同的判定路径，仅跳过删除（复用 `prune(olderThanDays:)` 的内部判定；dry-run 输出删除数 = 真实删除会发生的数量——诚实：与真实执行同源判定，非估算）；
- `--project`：解析到项目目录方式与批三 `pruneEvidence` 一致（registry 查项目 → evidenceStoragePath → 默认目录）；未知项目 → 退出码 1 + stderr JSON `{"error": "unknown project <id>"}`；
- dry-run + 项目维度组合有效（[--project][--dry-run][--older-than] 可任意组合，各自独立生效）；
- **clear 不走 CLI**（v1.6 明确 `clear()` 须确认——命令行销毁数据需独立确认流，本批不引入未经确认的批量删除命令；`--prune-evidence` 仅删过期条目，语义安全）。

### 12.3 帮助与解析

- `printUsage()` 增补两条命令的说明行；
- `parseArguments` 增补 `--prune-evidence`/`--evidence-stats`/`--older-than`/`--project`/`--dry-run` 分支；旧参数行为零变化。

### 12.4 可测性与验收

- **engine 单测**：批三 `pruneEvidence` 已被 `EngineP5Batch3Tests` 覆盖（CLI 为薄壳）；批四补 **CLI 解析层纯函数测试**（`parseArguments` 为 top-level 私有函数不可直接测——采用既有 CLI 命令一致口径：接入验收 + 人工冒烟）；
- **接入验收**：main.swift 命令分支存在、帮助文本更新、退出码路径完整（0/1/2）；
- **真机冒烟（可选人工项）**：对真实临时档案目录执行 `--prune-evidence --dry-run` / `--evidence-stats` 观察输出。

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P5-D1 | --prune-evidence | 按天数修剪并输出 JSON；dry-run 只统计不删除且判定与真实同源；default 30 天 | ✓ |
| P5-D2 | 项目维度 | --project 指定目录执行；未知项目退出码 1 | ✓ |
| P5-D3 | --evidence-stats | count/totalBytes/project/dir 输出正确 | ✓ |
| P5-D4 | 参数校验 | --older-than 非数字/≤0 → 退出码 2；帮助文本完整 | ✓ |
| P5-D5 | 零帧约束 | 无 socket 方法表/错误码变更；clear 不设 CLI | ✓ |

### 12.5 风险与边界（诚实声明）

1. **纯管理面命令**：CLI 维护命令不经过 socket，不影响 daemon 运行期协议；多实例并发维护时以文件锁语义由既有单客户端声明覆盖（v1.2 §8 口径）。
2. **dry-run 同源**：dry-run 与真实 prune 复用同一判定核心（仅跳过 delete），输出即"将删除"，非估算（诚实口径）。
3. **clear 不引入 CLI**：批量清档需确认语义，独立于本批（存储层 clear() 原语仍在，供未来带确认的维护面/真机脚本调用）。

---

## 15. 全量回归与系列收口验收（P5 总表）

- 四批全部落地后执行**全量回归**：engine `swift test` + mcp-shell `npm test`（kernel 不受本系列触及，按基线核验）；基线 engine 234 / mcp-shell 65 / kernel 47，本系列新增用例数如实记账于总表。
- **用例记账（2026-09-18 实测收口）**：engine 234→284（+50：批一 ApprovalGate 17、批二 RestorePipeline 20、批三 EvidenceStore TTL 13）；mcp-shell 65 不变；kernel 47 基线核验不变。三面全绿。
- 系列版本管理：P5 系列从 v5.0 起（若后续批次，逐版追加不删减）；P4 v4.0 §30.6 的"新系列另起"规定已由本文件兑现。

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P5-E1 | 全量回归 | engine + mcp-shell 全用例绿；kernel 基线核验 | ✓ |
| P5-E2 | 铁约束复核 | 四批零新 socket 帧/零新错误码/零 kernel 改动/零新依赖 | ✓ |
| P5-E3 | 规格-实现一致性 | 本规格 §3–§14 每项验收（P5-A/B/C/D 系）逐项 ✓ | ✓ |
| P5-E4 | 真机冒烟（可选） | CLI 维护命令/审批审计命令在真实环境执行观察 | ✓（已执行真实环境观察） |

---

## 16. 风险与边界（系列级诚实声明）

1. **本系列四项均不触发协议/方案冻结面的变更**：方法表、错误码、kernel schema、evidence schema 均不动；四个方向候选在"可用实现面"内全部真实落地，未实现面如实留档（人工交互审批面、探针运行时执行面、自动过期线程面、CLI clear 确认面）。
2. **与 P4 §32 遗留的关系**：本系列处理了"方向候选"四件事；§32 其余遗留（18 项人工冒烟、分发公证、无头环境边界、kernel Phase B 迁移、R44 评估权、综述不改写）不属本系列，保持原留档。
3. **后续新批次**：P5 系列内如需增补批次，按迭代规则在 v5.0 之后追加 v5.1 等，不删减既有正文。