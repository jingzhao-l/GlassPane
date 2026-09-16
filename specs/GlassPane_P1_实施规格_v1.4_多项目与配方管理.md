# GlassPane P1 实施规格 v1.4 — 多项目注册表 + 配方管理

- 契约真源角色：P1 第五子项目的实施契约（P1 首批–四批见 v1.0–v1.3，其全部验收项已达标且正文不变；本规格基于 v1.3 的章节结构与约束体系迭代，不删减既有内容，仅追加批次五范围）
- 版本：v1.4
- 日期：2026-09-16
- 关联决策：综述 §5.14 多项目与资产库组织（R36）、综述 §5.1 配方分发与版本管理（R35）、PRD FR-17 开发者支持面、PRD FR-01 配方体系

---

## 变更说明（相对 P1 v1.3 批次）

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
| P1-E1 | ProjectRegistry CRUD | 创建/读取/更新/删除全路径单测通过 | 待实施 |
| P1-E2 | 持久化 roundtrip | 写入文件→读回→字段相等；原子写入无中间态 | 待实施 |
| P1-E3 | 项目上限 | 第 129 个项目拒绝 GP_E_PROJECT_LIMIT | 待实施 |
| P1-E4 | 项目切换 | attach 时传 projectId 自动关联；bundleId 不匹配时 GP_E_BAD_PARAMS | 待实施 |
| P1-E5 | RecipeLoader 校验 | 合法 recipe-config 通过；非法字段/缺必填拒绝；空文件拒绝 | 待实施 |
| P1-E6 | CLI 命令 | --list-projects / --active-project / --recipe-validate 输出正确 | 待实施 |
| P1-E7 | MCP 工具 | gp_project_list/set/get 注册、校验、错误映射 | 待实施 |
| P1-E8 | 纯逻辑单测回归 | 新增用例全绿；既有用例不回归 | 待实施 |

---

## 8. 风险与边界（诚实声明）

1. **项目持久化为文件而非数据库**：单 JSON 文件足够（128 上限 + 纯文本元数据）；daemon 重启后自动加载；多 daemon 实例冲突通过文件锁预防（P0 已声明单客户端语义）。
2. **配方校验为本地 ajv 运行时**：需要 kernel 包的 ajv 依赖；engine 侧不内嵌 ajv（Swift），daemon CLI --recipe-validate 委托给 mcp-shell 校验路径或直接用 kernel 的 test 辅助工具（CI 层面）。实际 daemon 运行时不做配方校验（配方校验是开发期行为）。
3. **evidence 存储路径可配置但 P0 不落盘**：P0 evidence 仅内存态；项目级 evidenceStoragePath 为 P1 后续批次预留（当 evidence 落盘功能进入时启用）。当前配置值被接受但不生效，避免数据流中断。
