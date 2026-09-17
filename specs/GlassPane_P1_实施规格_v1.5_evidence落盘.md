# GlassPane P1 实施规格 v1.5 — evidence 持久化落盘（可回放审计档案）

- 契约真源角色：P1 第六子项目的实施契约（P1 首批–五批见 v1.0–v1.4，其全部验收项已达标且正文不变；本规格基于 v1.4 的章节结构与约束体系迭代，不删减既有内容，仅追加批次六范围——evidence 落盘持久化与重启后回放）
- 版本：v1.5
- 日期：2026-09-17
- 关联决策：综述 §5.14 evidence 审查 UX（R36）、PRD US-10（开发者回归审计）、P0 evidence 仅内存态（“最近条目仅内存”源头，本批启用项目级 `evidenceStoragePath` 落盘）、v1.3 evidence 审查 UX（渲染器读 evidence）、v1.4 §8.3 evidence 存储路径预留口子

---

## 变更说明（相对 P1 v1.4 批次）

前五批覆盖了 daemon 能力（SCK/快照/熔断/evidence审查）、开发者入口（CLI→GUI）与多项目工作流（注册表/配方）。本批次把 evidence 从“仅内存、重启即失”升级为**文件持久化、重启后可回放**的审计档案，落地 v1.4 §8.3 预留的 `evidenceStoragePath`：

- engine 新增 `EvidenceStore`（纯逻辑 + 文件持久化）：把每条 `EvidencePack` 原子写入项目级存储目录（每 operationId 一个 JSON 文件），并支持按 operationId 从磁盘读回——**重启 daemon 后仍可按 opId 回放历史 evidence**。
- `EngineCore` 的 `store`/`replace` 在写内存环形历史后同步落盘；`lastEvidence(operationId)` 内存未命中时回退查磁盘。
- 存储根目录取**当前活跃项目**（attach projectId 关联）的 `evidenceStoragePath`；未配置或未关联项目时回退默认目录 `~/.glasspane/evidence/`。
- 不改变 evidence schema、不改变 daemon 方法表（`last_evidence` 语义增强为“内存 + 磁盘两级查”，方法名与帧格式不变）；不改变 mcp-shell 工具面（`gp_last_evidence`/`gp_export_evidence` 自动受益，无需新工具）。

批次六范围要点：

- 落盘格式每文件一条 evidence（`{operationId}.json`），key-sorted 编码（与 ProjectRegistry 一致的 JSONEncoder `.sortedKeys`）、原子写（tmp + rename）。
- 读取两级：内存环形（最近 64）→ 磁盘（历史全量），`lastEvidence` 无 opId 时仍取内存最近（或磁盘按 mtime 最近）。
- 错误降级：磁盘写失败不阻断 act/assert 主流程（仅记录，证据仍在内存）；读盘失败 → `GP_E_NO_EVIDENCE` 原样，不因文件损坏整体崩溃。

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
