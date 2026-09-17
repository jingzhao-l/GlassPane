# GlassPane P1 实施规格 v1.6 — evidence 归档生命周期（限量修剪与统计维护）

- 契约真源角色：P1 第七子项目的实施契约（P1 首批–六批见 v1.0–v1.5，其全部验收项已达标且正文不变；本规格基于 v1.5 的章节结构与约束体系迭代，不删减既有内容，仅追加批次七范围——evidence 归档生命周期：上限修剪、统计与按需清空）
- 版本：v1.6
- 日期：2026-09-17
- 关联决策：综述 §5.14 evidence 审查 UX（R36）、PRD US-10（开发者回归审计）、v1.5 §11.3 风险声明（“磁盘为追加式档案不过期…无压缩/归档策略，属后续数据生命周期批次”，本批落地该预告）、v1.5 §9.4 生命周期表中“磁盘为全量档案，不过期”口径（本批为磁盘档案引入有序删除 + 维护观测）

---

## 变更说明（相对 P1 v1.5 批次）

v1.5 把 evidence 落为磁盘档案后，明确声明了**磁盘为追加式、无压缩/归档策略、无上限持续累积**（v1.5 §11.3 风险 3），并将其列为后续数据生命周期批次。本批（批七）正是兑现该预告：把磁盘档案从“只增不减的审计全量”升级为**有界、可观测、可维护的归档生命周期**：

- `EvidenceStore` 新增**归档上限** `maxFiles`：写盘后若 `{operationId}.json` 文件数超过上限，按文件修改时间（mtime）**删除最旧的过量条目**（FIFO-by-mtime 修剪），让活跃档案持续保持在界内。默认上限足够大（10000），不影响既有“审计全量优先”的默认语义；需要更紧凑的保留策略时可在构造时配置。
- 新增 **`stats()`**：返回 `{count, totalBytes}` 归档实时统计，供观测脚本/维护面核对档案规模与磁盘占用——补齐 v1.5 “绑定 mtime 观测/大数据量导出同源”的观测缺口。
- 新增 **`clear()`**：按需一键清空当前归档目录（删除全部 `.json` 条目，返回删除数量），为“重置/搬家/越权清理”提供显式入口；空目录/缺失目录容错返回 0。
- 以上三者均为**纯 FileManager 逻辑 + ActiveDirectory 语义**，不依赖 AX；**写时修剪在 `write` 内部透明触发**，`EngineCore` 零改动即可自动获得“活跃项目档案有界”。
- 不改变 evidence schema、不改变 daemon 方法表（**不新增 daemon/socket 帧**——修剪/统计/清空为 `EvidenceStore` 存储层原语，供 daemon/main 与维护入口调用，P0 不新增 socket 方法）、不新增错误码（全部为存储层 `Bool`/退避语义，无协议错误面）、不改变 mcp-shell 工具面（批七不涉及 shell 工具语义）。

批次七范围要点：

- 上限修剪：写盘成功后统计目录内 `.json` 条目，超过 `maxFiles` 时按 mtime 升序删除最旧 `超过数` 条；每写一条的存在性断言不变（新条目必在），修剪不回溯不删除刚写入的条目。
- 统计：`stats()` 列出目录内 `.json` 条目数 + 各 `fileSize` 求和；目录缺失/为空返回 0/0，不抛。
- 清空：`clear()` 删除目录内全部 `.json` 条目并返回数量；文件删除失败跳过（best-effort）；未创建过目录 / 空目录返回 0。
- 回归保证：默认上限下批六 P1-F1..F8 语义不回归（批六用例单目录写入 ≤3 条，远低于默认上限，修剪不触发）。

---

## 1. 项目注册表

前四批覆盖了 daemon 能力（SCK/快照/熔断/evidence审查）与开发者入口（CLI→GUI）。本批次补齐多项目工作流的缺失环节：**项目注册表**（每个被测 app 的元数据管理）与**配方管理**（配方配置加载、校验、按项目隔离）。

- engine 新增 `ProjectRegistry`（纯逻辑 + 文件持久化）：项目注册、查询、切换、删除；项目级 evidence 存储路径可配置。
- engine 新增 `RecipeManager`（纯逻辑）：加载 YAML 配方、经 kernel recipe-config schema 校验、按项目隔离配方集。
- daemon CLI 新增 `--list-projects` / `--active-project <id>` / `--recipe-validate <path>` 命令。
- mcp-shell 新增 `gp_project_list` / `gp_project_set` / `gp_project_get` 三工具。
- 不改变 socket 协议方法表（项目管理仅 CLI/MCP 层面；daemon 运行时以 activeProject 上下文关联）。

---

## 1. 项目注册表

### 1.1 数据模型

```swift
public struct ProjectEntry: Codable, Equatable {
    public let projectId: String          // prj_ + Crockford base32 (26)
    public var displayName: String        // ≤256 chars
    public var bundleId: String?          // 与 pid 二选一
    public var pid: Int32?                // 与 bundleId 二选一
    public var recipeConfigPath: String?  // 配方文件路径（可选）
    public var calibrationAssetsPath: String? // 校准资产路径（可选）
    public var evidenceStoragePath: String?   // evidence 存储路径（可选，默认 XDG）
    public var createdAt: String          // ISO-8601
}
```

项目 ID 格式 `prj_` + Crockford base32 26 位（与 op_/snap_ 同生成器）。

### 1.2 注册表持久化

- 文件路径：`~/.glasspane/projects.json`（可通过 `--config-path` 覆盖 daemon 根目录）
- 格式：JSON 数组，key-sorted 编码，`[ProjectEntry]`
- 原子写入：先写 `.tmp` 再 rename（防中途崩溃）
- 注册表大小上限：128 个项目（超过 → `GP_E_PROJECT_LIMIT`）

### 1.3 项目切换

`EngineCore` 新增 `activeProjectId: String?` 属性；`attach` 时如果传入 `projectId`，自动关联到对应项目条目（校验 bundleId/pid 一致）。

---

## 2. 配方管理

### 2.1 配方加载

engine 新增 `RecipeLoader`：读取 YAML → 解析为字典 → 经 kernel recipe-config.schema.json 校验（ajv）→ 返回结构化结果。

P0 daemon 侧不直接消费 YAML 配方（daemon 只接收 act/observe 等原子操作），但需要**校验配方文件合法性**以支持 onboarding 与项目注册。

### 2.2 配方校验命令

`glasspaned --recipe-validate <path>` → 输出校验结果（valid/invalid + errors 数组）。

---

## 3. CLI 扩展

| 命令 | 输出 | 退出码 |
|---|---|---|
| `--list-projects` | JSON 数组，每个项目条目 | 0 |
| `--active-project <id>` | 设置活跃项目，输出确认 | 0 |
| `--recipe-validate <path>` | 校验结果 JSON | 0=valid, 1=invalid, 2=error |

---

## 4. MCP 工具扩展（mcp-shell，八工具 → 十一工具）

| 工具 | inputSchema | 成功返回 | 失败 |
|---|---|---|---|
| gp_project_list | `{}` | `{projects: [...]}` | — |
| gp_project_set | `{projectId?: string, displayName: string, bundleId?: string, pid?: number, recipeConfigPath?: string}` | `{project: {...}}` | GP_E_BAD_PARAMS / GP_E_PROJECT_LIMIT / GP_E_NOT_FOUND |
| gp_project_get | `{projectId: string}` | `{project: {...}}` | GP_E_NOT_FOUND |

- `gp_project_set` 无 `projectId` 时创建新项目（自动生成 ID）；有 `projectId` 时更新已有条目。
- `gp_project_get` 不存在 → `GP_E_NOT_FOUND`。

---

## 5. 错误码扩展（GP_E 表追加两码）

| 错误码 | 含义 | agent 补救指引 |
|---|---|---|
| GP_E_PROJECT_LIMIT | 项目数达到上限（128） | 删除不需要的项目后重试 |
| GP_E_NOT_FOUND | 项目 ID 不存在 | 检查 projectId，或用 gp_project_list 查看可用项目 |

---

## 6. 双语言联动与 schema 影响

| 关注面 | 影响 |
|---|---|
| evidence-pack schema | 无变更 |
| decision-log / recipe-config schema | 无变更 |
| kernel zod 绑定 | 无新增导出 |
| kernel fixtures | 无新增 |
| Swift Codable | 新增 ProjectEntry（非 evidence 相关），不进证据链 |

---

## 7. 可测性与验收

- **engine 单测**：ProjectRegistry CRUD（增/删/查/改）+ 持久化 roundtrip（写文件→读回→字段一致）+ 128 上限拒绝；RecipeLoader 校验（合法 YAML 通过、非法字段拒绝、空文件拒绝）；项目切换（attach 关联 activeProject）
- **mcp-shell 单测**：三工具注册/转发/校验/错误映射
- **真机冒烟（可选）**：CLI --list-projects / --active-project / --recipe-validate 端到端

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P1-E1 | ProjectRegistry CRUD | 创建/读取/更新/删除全路径单测通过 | ✓ 已实现并单测通过（2026-09-17，`ProjectRegistryTests`） |
| P1-E2 | 持久化 roundtrip | 写入文件→读回→字段相等；原子写入无中间态 | ✓ 已实现并单测通过（2026-09-17） |
| P1-E3 | 项目上限 | 第 129 个项目拒绝 GP_E_PROJECT_LIMIT | ✓ 已实现并单测通过（2026-09-17，`ProjectRegistryTests` 上限用例） |
| P1-E4 | 项目切换 | attach 时传 projectId 自动关联；bundleId 不匹配时 GP_E_BAD_PARAMS | ✓ 已实现并单测通过（2026-09-17） |
| P1-E5 | RecipeLoader 校验 | 合法 recipe-config 通过；非法字段/缺必填拒绝；空文件拒绝 | ✓ 已实现并单测通过（2026-09-17，`RecipeLoaderTests` 6 用例） |
| P1-E6 | CLI 命令 | --list-projects / --active-project / --recipe-validate 输出正确 | ✓ 已实现并接入 daemon CLI（2026-09-17，`glasspaned/main.swift`） |
| P1-E7 | MCP 工具 | gp_project_list/set/get 注册、校验、错误映射 | ✓ 已实现并单测通过（2026-09-17，mcp-shell 工具用例） |
| P1-E8 | 纯逻辑单测回归 | 新增用例全绿；既有用例不回归 | ✓ 全量 engine 162 用例全绿（2026-09-17，0 失败 1 opt-in 跳过）+ mcp-shell 56 用例全绿 |

---

## 8. 风险与边界（诚实声明）

1. **项目持久化为文件而非数据库**：单 JSON 文件足够（128 上限 + 纯文本元数据）；daemon 重启后自动加载；多 daemon 实例冲突通过文件锁预防（P0 已声明单客户端语义）。
2. **配方校验为本地 ajv 运行时**：需要 kernel 包的 ajv 依赖；engine 侧不内嵌 ajv（Swift），daemon CLI --recipe-validate 委托给 mcp-shell 校验路径或直接用 kernel 的 test 辅助工具（CI 层面）。实际 daemon 运行时不做配方校验（配方校验是开发期行为）。
3. **evidence 存储路径可配置但 P0 不落盘**：P0 evidence 仅内存态；项目级 evidenceStoragePath 为 P1 后续批次预留（当 evidence 落盘功能进入时启用）。当前配置值被接受但不生效，避免数据流中断。

> **版本结构说明（v1.4 → v1.5）**：v1.5 在 v1.4 的 §1–§8 之后追加批六范围 **§9–§11**（证据落盘、验收、风险），v1.4 正文 §1–§8 逐字保留不变。§8.3 所述的 `evidenceStoragePath` 预留口子在本批正式启用（不再“接受但不生效”）。

---

## 9. evidence 持久化落盘（批量六新增）

### 9.1 定位

对应综述 §5.14 / PRD US-10「开发者回到桌面 → 按 operationId 证据卡片回放会话」。此前 evidence 仅存于 daemon 内存环形历史（P0“最近条目仅内存”），daemon 重启即丢失；v1.3 的审查工具（`gp_recent_reports` 等）在会话内跟踪 operationId，但跨进程重启无法回放。本批把 evidence 落地为**持久审计档案**，重启后仍可按订单历史回放。

### 9.2 engine 新增：EvidenceStore

`engine/Sources/GlassPaneEngine/EvidenceStore.swift`（纯逻辑 + 文件持久化，无 AX 依赖，可注入临时目录单测）：

- 存放目录解析优先级：`activeProject.evidenceStoragePath` → 默认 `~/.glasspane/evidence/`。
- 落盘格式：每 operationId 一个文件 `<dir>/<operationId>.json`，内容为 key-sorted 编码的完整 EvidencePack（`EvidencePack.encoder`，`.sortedKeys`）。文件名仅由 Crockford base32 opId 组成，天然文件系统安全，无路径注入。
- 原子写：`<file>.tmp` 写入 → `replaceItemAt` rename（与 ProjectRegistry.save 同范式）；rename 失败回退直接写，单测以结果正确为准。
- 读回：`read(operationId:) -> EvidencePack?` 读 `<dir>/<operationId>.json` 并 JSONDecoder 解码；文件缺失/损坏返回 nil（不抛，由调用方映射 `GP_E_NO_EVIDENCE`）。
- `lastOnDisk() -> String?`：若无内存最近项，按目录内文件 mtime 取最近一条 opId（用于 `lastEvidence` 无参数时回退）。
- 磁盘目录不存在时首次写自动 `createDirectory(withIntermediateDirectories:)`。

### 9.3 EngineCore 挂接

- `store(_:)`/`replace(_:)`：写内存环形历史后调用 `evidenceStore.write(pack)`；写失败**不抛出**、不阻断 act/assert 主流程（证据仍在内存），仅以 `lastEvidence` 磁盘侧缺失呈现（诚实降级）。
- `lastEvidence(operationId:)`：内存未命中 → `evidenceStore.read(operationId)` → 仍 nil → `GP_E_NO_EVIDENCE`。
- `lastEvidence()`（无参）：内存 `latestPack()` → 缺失 → `evidenceStore.lastOnDisk()` decode 该条 → 仍无 → `GP_E_NO_EVIDENCE`。
- `attach(projectId:)` 关联活跃项目后，`evidenceStore` 按该项目 `evidenceStoragePath` 定位（每次写/读时解析当前活跃项目目录，无需重启）。
- 不改变方法表、不新增错误码（复用 `GP_E_NO_EVIDENCE`）、不改变 evidence schema。

### 9.4 生命周期与隔离

| 关注面 | 行为 |
|---|---|
| 内存环形 | 维持 64 上限不变；磁盘为全量档案，不过期 |
| attach 换 app | 与既有语义一致清空内存历史；磁盘档案保留（按 opId 仍可回放） |
| 目录隔离 | 不同项目配置不同 `evidenceStoragePath` 时隔离；未配置共享默认目录（文档声明，不作强隔离） |
| 重启 | 磁盘档案保留，`lastEvidence(opId)` 可直接回放 |

### 9.5 与 reviewed 面的关系（无冲突）

| 面 | 关系 |
|---|---|
| v1.4 §8.3 | 预留口子正式启用，“接受且生效” |
| 内存 history / lastEvidence | 语义增强为“内存 + 磁盘两级查”，方法名与帧格式不变 |
| mcp-shell gp_last_evidence / gp_export_evidence | 自动受益，无需改动即可回放重启前证据 |

---

## 10. 可测性与验收

- **engine 单测**（`EvidenceStoreTests`，注入临时目录）：roundtrip 写→读一致；原子写后无 `.tmp` 残留；`read` 缺失返回 nil；损坏文件返回 nil 不崩；目录自动创建；`lastOnDisk` 取最近 mtime。
- **EngineCore 集成**（`EngineP1Batch6Tests`，ScriptedChannel + 临时目录注入 EvidenceStore）：store/replace 后磁盘存在对应文件；`lastEvidence(opId)` 重启回放（新 EngineCore 实例 + 同一目录）；无参数 `lastEvidence` 内存优先、磁盘回退；attach(projectId) 关联后落盘到项目目录。
- **全量回归**：engine 全用例 + mcp-shell 全用例不回归。

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P1-F1 | EvidenceStore roundtrip | 写 evidence → 磁盘文件存在 → 读回字段相等；key-sorted；无 `.tmp` 残留 | ✓ 已实现并单测通过（2026-09-17，`EngineP1Batch6Tests` roundtrip 用例） |
| P1-F2 | 读缺失/损坏容错 | 文件缺失/损坏 → `read` 返回 nil 不崩，调用方映射 GP_E_NO_EVIDENCE | ✓ 已实现并单测通过（2026-09-17，缺失/corrupt 两用例） |
| P1-F3 | 目录自动创建 | 写入时目标目录不存在 → 自动创建成功 | ✓ 已实现并单测通过（2026-09-17，嵌套目录用例） |
| P1-F4 | 重启回放 | 内存清空/新 EngineCore 实例 + 同一目录 → `lastEvidence(opId)` 仍可取到 | ✓ 已实现并单测通过（2026-09-17，replay 用例） |
| P1-F5 | 内存优先 | 无参 `lastEvidence` 内存有项时取内存；内存空时磁盘按最近 mtime 回退 | ✓ 已实现并单测通过（2026-09-17，memory-first + no-param fallback 用例） |
| P1-F6 | 项目目录关联 | attach(projectId) 且项目配置 evidenceStoragePath → 落盘到该项目目录 | ✓ 已实现并单测通过（2026-09-17，project dir 用例） |
| P1-F7 | 写失败不阻断 | 落盘失败不抛出、act/assert 仍成功（内存证据可用） | ✓ 已实现并单测通过（2026-09-17，faulty-dir 用例 + persist 不抛设计） |
| P1-F8 | 全量回归 | 新增用例全绿；既有 engine + mcp-shell 用例不回归 | ✓ 全量 engine 175 用例全绿（2026-09-17，0 失败 1 opt-in 跳过）+ mcp-shell 全绿 |

---

## 11. 风险与边界（诚实声明）

1. **默认目录共享不隔离**：未配置 `evidenceStoragePath` 的项目共享 `~/.glasspane/evidence/`，跨项目 opId 全域唯一（Crockford 生成器），可回放但语义上混用；需要按项目强隔离时配置独立目录即可。
2. **写失败降级为内存**：磁盘故障不阻断主流程——证据可能在 daemon 重启后丢失；这是“主循环优先”的刻意取舍，非静默吞错（文档声明 + 缺失以 GP_E_NO_EVIDENCE 如实呈现）。
3. **磁盘为追加式档案不过期**：与内存环形（64）不同，磁盘文件持续累积；无压缩/归档策略，属后续数据生命周期批次（与 gp_recent_reports 大数据量导出同源）。
4. **文件损坏以 nil 呈现**：单条 evidence 文件损坏不影响其余条目，也不崩溃 daemon；用 `GP_E_NO_EVIDENCE` 如实暴露该条目不可读。

> **版本结构说明（v1.5 → v1.6）**：v1.6 在 v1.5 的 §1–§11 之后追加批七范围 **§12–§14**（归档生命周期、验收、风险），v1.5 正文 §1–§11 逐字保留不变。v1.5 §11.3 风险 3 所称“磁盘……无压缩/归档策略，属后续数据生命周期批次”——该预告由本批 §12 兑现：磁盘档案引入有序限量修剪（`maxFiles`），并为既有“全量不过期”默认语义补上观测（`stats`）与维护（`clear`）原语。默认上限取值使批六 P1-F1..F8 的“全量回放”语义仍成立（详见 §12.4）。

---

## 12. evidence 归档生命周期（批量七新增）

### 12.1 定位

承接 v1.5 §11.3 风险 3 的预告。v1.5 落地磁盘档案后，默认语义为“磁盘为追加式、全量不过期、持续累积”，缺少两层能力：**有界性**（长期运行/大量 act 使磁盘文件无限增长，与 `gp_recent_reports` 大数据量导出、磁盘占用观测均同源）与**维护面**（查看归档规模、按需清空）。本批在 `EvidenceStore` 存储层补齐归档生命周期三原语，激活既有“全量审计”路径变为**默认有界回收、可观测可维护**。

设计取舍：全部为**存储层原语 + 纯 FileManager 逻辑**，写时修剪透明内嵌于 `write`，**不加 daemon/socket 帧、不改 schema、不加错误码** —— 生命周期是存储内部策略，而非协议面能力。

### 12.2 归档上限与写时修剪

`EvidenceStore` 新增构造参数 `maxFiles: Int?`（默认 `EvidenceStore.defaultMaxFiles = 10000`）：

- `write(pack)` 成功落盘后调用内部 `pruneIfNeeded()`：列出当前目录内 `{operationId}.json` 条目，若**条目数 > maxFiles**，按文件 mtime 升序（最旧优先）删除 `条目数 - maxFiles` 条，仅删旧、**不删除刚写入的新条目**。
- 修剪为 best-effort：单个文件删除失败跳过，不中断其余删除；返回实际删除条数。
- `maxFiles <= 0` 视为非法（构造时钳制到至少 1），避免“一次修剪全部”的意外破坏语义。
- 默认上限下，批六 P1-F1..F8 语义不回归（批六用例单目录写入 ≤3 条，远低于 10000，修剪不触发，“全量回放”仍成立）。

### 12.3 统计与清空

- **`func stats() -> EvidenceArchiveStats`**：返回 `{count: Int, totalBytes: Int}`——列出目录内 `.json` 条目数与各 `fileSize` 之和。目录缺失/为空返回 0/0，不抛。
- **`func clear() -> Int`**：删除当前目录内全部 `.json` 条目，返回实际删除数量；文件删除失败跳过（best-effort）；目录未创建/为空返回 0。
- 二者均作用于**当前活跃目录**（与 `read`/`write`/`lastOnDisk` 相同的 `directory`，随 `setDirectory`/attach 项目路由切换），观测与清理的是当前项目档案，不影响其他项目目录。

### 12.4 生命周期与既有语义的关系

| 关注面 | 行为 | 与 v1.5 关系 |
|---|---|---|
| 默认上限 | 10000，写时按 mtime 修剪最旧 | 默认“全量先于回收”，批六 F 验收仍成立 |
| 内存环形 | 维持 64 上限不变，不受本批影响 | 保持 v1.5 §9.4 |
| 目录隔离 | 统计/清空作用于当前活跃目录 | 保持 v1.5 §9.4 |
| 重启 | 磁盘档案保留；修剪/统计/清空均为即时落盘操作 | 保持 v1.5 §9.4 + 本批新增 |
| daemon 方法表 | 不新增帧；EngineCore 零改动透明受益 | 保持 v1.5/方法表冻结 |
| mcp-shell | 不新增工具、不改语义 | 保持 v1.5 |

### 12.5 与 reviewed 面的关系（无冲突）

| 面 | 关系 |
|---|---|
| v1.5 §11.3 风险 3 | 本批兑现预告：提供默认有界回收 + 观测（stats）+ 维护（clear） |
| v1.5 §9.4 生命周期表“磁盘为全量档案，不过期” | 口径更新为“默认全量优先，支持配置上限修剪”；正文不删改，由 §12 追加新口径 |
| EvidenceStore roundtrip/read/lastOnDisk | 未改动；仅新增 maxFiles 构造默认参数 + 修剪内部钩子 + stats/clear |

---

## 13. 可测性与验收

- **engine 单测**（`EngineP1Batch7Tests`，注入临时目录，无 AX 依赖）：
  - 超过上限 → 写后按 mtime 删最旧，最新条目保留，条目数回到 `maxFiles`；
  - 未超上限 → 不删除任何条目（stables 保序）；
  - `stats()` → 空目录 0/0；写入后 count/totalBytes>0 且随写增；
  - `clear()` → 删除全部 `.json` 返回数量；再调用返回 0；空目录返回 0；
  - `maxFiles` 钳制：`0/负数` 被钳制到至少 1，不一次删光（写入即删自身的破坏语义不发生）；
  - 无 store 注入（内存态）EngineCore 回归：批六 P1-F8 语义不回归。
- **全量回归**：engine 全用例（基线 175 → 批七后 >175）+ mcp-shell 全用例（56，批七不改 shell，预期不回归）。

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P1-G1 | 上限修剪 | 目录内条目 > maxFiles 时，写后按 mtime 删最旧、最新保留、条目数回落到 maxFiles | ✓ 已实现并单测通过（2026-09-17，`EngineP1Batch7Tests` 上限修剪用例） |
| P1-G2 | 未超上限不删 | 条目数 ≤ maxFiles 时，写后不删除任何条目、保序 | ✓ 已实现并单测通过（2026-09-17，at-cap 用例） |
| P1-G3 | 统计 count/totalBytes | 空目录返回 0/0；写后 count 与 totalBytes 随写增长且 >0 | ✓ 已实现并单测通过（2026-09-17，stats 空/增长用例） |
| P1-G4 | 按需清空 clear | 删除全部 `.json` 并返回数量；再清空返回 0；空/缺失目录返回 0 | ✓ 已实现并单测通过（2026-09-17，clear 幂等/缺失目录用例） |
| P1-G5 | 上限钳制 | maxFiles≤0 被钳制到 1，避免“一次删光全部” | ✓ 已实现并单测通过（2026-09-17，clamp + 微容量保留最新用例） |
| P1-G6 | 内存态回归 | 默认上限下批六 F 验收不回归（EngineCore 不用 store 仍内存可用） | ✓ 已实现并单测通过（2026-09-17，no-store in-memory 回归用例） |
| P1-G7 | 全量回归 | 新增用例全绿；既有 engine + mcp-shell 用例不回归 | ✓ 全量 engine 186 用例全绿（2026-09-17，批七新增 11，0 失败 1 opt-in 跳过）+ mcp-shell 56 用例全绿 |

---

## 14. 风险与边界（诚实声明）

1. **修剪为 best-effort、按 mtime 近似**：删除单条失败会跳过，极端情况可能使目录暂超上限；mtime 在同一目录批量写入时可能不够精细（同一秒内），但默认 10000 上限容忍秒级误差。以“有界回收”为契约，而非逐字节精确。
2. **默认上限不构成隐私/合规上限**：10000 仅是磁盘占用回收阈值，不做内容价值判断；需要按 retention 天数/项目筛查等策略属于后续批次（本批只提供原语）。
3. **`clear()` 为破坏性操作**：删除当前活跃目录的全部 `.json` 条目，不可恢复；调用方（daemon/main/维护入口）须在确认后再触发，本批未将 clear 暴露为无人值守的自动策略。
4. **统计含瞬时偏差**：`stats()` 在对目录快照时取 size，并发写入/修剪期间读数可能略偏；作为观测基线足够，不作为计费/严格审计依据。
