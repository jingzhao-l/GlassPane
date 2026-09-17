# GlassPane P3 实施规格 v3.2 — LLDB 桥形态评估

- 契约真源角色：P3 第三批次的实施契约（P3 一批为 v3.0 C28/C35 三方消费者一致性、批二为 v3.1 Swift 手写 MCP 消息层评估；P2 全套 v2.0–v2.1、P1 全套 v1.0–v1.6 验收项已达标且正文保留不变；本规格基于 v3.1 的章节结构与约束体系迭代，不删减既有内容，仅追加批次三范围——LLDB 桥形态评估/决策：编译型 C++ plugin vs Python 维持管线的选项复审，落地结论为维持 Python 脚本 + SB API 现状并定义触发重估条件）
- 版本：v3.2
- 日期：2026-09-18
- 关联决策：综述 §5.6 **R30**（"LLDB 桥形态明确：Python 脚本 + SB API + local socket，编译型 C++ plugin 形态列为后续优化选项"）、综述 §2.5 技术栈表 LLDB 桥行（Python + SB API + local socket 为**刚性**；C++ plugin 形态保留为后续优化选项）、综述"关于 Swift 与技术栈的确认"第 21 行（"LLDB 官方脚本层就是 Python（SB API），这是 LLVM 长期设计"）、P1 v1.3 权限表 developerTools 行（LLDB attach，Z1–Z4.5 探针通道，P1 默认不启用该通道）

---

## 变更说明（相对 P1 v1.6 批次）

v1.6 收尾了 P1 全部批次（七批）后，P2（能力扩展）将综述中 P2 关键标准逐个落地。首个 P2 批次兑现 **C33 并发归因污染防护**（综述 §10.2：P2 关键标准增加 C33、T9）。

综述 §5.3 定义的问题与机制：

- **问题**：agent 操作与用户真实操作并发时，进程级单值插槽互相覆盖，归因被污染——开发者"边手动点边让 agent 跑"是真实开发常态；
- **机制**：AX 会话锁扩展为"**操作权互斥**"——daemon 在持有操作权期间监控 CGEvent 全局输入流，若检测到非 agent 来源的真实输入（键盘/鼠标），则：① 通知 agent 暂停（默认，避免竞态）；② 或 agent 选择继续但本次 opID 的全部归因降级为弱归因并在 evidence 包标注 `contaminated: true`；
- **断言 C33**：并发场景下归因污染检出率 >95%，误杀率（用户无操作时误判污染）<5%。

本批在 engine 侧落地该机制的**判定性核心**（纯逻辑、可单测）：输入事件源抽象、操作权互斥与空闲检测、污染判定与标注。具体：

- engine 新增 `InputEventSource` 协议（事件序列抽象，时间戳 + 来源类别）+ `ScriptedInputEventSource`（测试注入的脚本化事件源，可精确构造"并行用户输入"场景）；真实 CGEvent 输入流适配器按综述归入运行时权限面（需输入监控 TCC 权限，真机冒烟验收——与 AX 适配层同口径，见 §16.5）。
- engine 新增 `AttributionGuard`（纯逻辑）：**操作权互斥**（daemon 发起 act 前置获取操作权，释放前禁止他人 act）、**输入空闲检测**（操作权获取前要求最近窗口内无真实输入——输入空闲才算"可独占操作"）、**污染判定**（持有操作权期间，检测到非 agent 来源输入事件 → 本次归因污染）。
- `AttributionGuard` 输出的裁决 `wasContaminated` 直接进 evidence 包：归因降级为 `weak` + `contaminated: true`（reviewed 面语义：宁降级不静默错判）。
- `EngineCore.act()` 集成：act 前置 `guard.acquireOperationRight()`（含输入空闲检测），act 完成后释放；扫描窗口内真实输入事件 → 污染裁决写入 evidence attribution。
- **可测性边界（5.8 R45）**：判定逻辑 100% 单测（脚本化事件源）；CGEvent 监控适配层真机冒烟（§16.5）。
- 铁约束：**不新增 daemon/socket 帧**（操作权互斥为 EngineCore 内部协调，不做协议帧；无新方法）、**不改变 evidence schema**（`Attribution` 已有 `level`/`contaminated` 字段，本批只是正确使用之）、**不新增错误码**、不改变 mcp-shell 工具面（C33 的"通知 agent 暂停"以 evidence 归因降级 + `contaminated` 标注承载，MCP 工具无需新语义）。
- 验收口径：C33 数值断言在**单元测试层用合成场景集**统计（检出率 = 污染场景中被标污染的比例；误杀率 = 纯净场景中被误标污染的比例），阈值 ≥95% / <5%。

批次一范围要点：

- `InputEventSource`：`nextEvent() -> InputEvent?` 事件流抽象，`InputEvent` 含 `timestamp`/`source`（`.agent`/`.human`）；脚本源按队列回放。
- `AttributionGuard`：可注入时钟与事件源；`acquireOperationRight()` 做输入空闲检测（空闲窗口可配置，默认 500ms）并返回获取结果；持有期间 `monitorInput()` 扫描输入；`releaseOperationRight()` 返回 `(contaminated: Bool, humanEvents: [InputEvent])`。
- 污染判定规则：操作权持有期间出现任何 `.human` 源事件 → `contaminated = true`（归因降级 weak）；无 `.human` 事件 → 保持原归因强度（soft）。
- 空闲检测规则：若最近空闲窗口内存在 `.human` 事件 → 操作权获取被推迟/拒绝（`idleNotMet`），由 daemon 侧等待后重试（本批 EngineCore 默认策略：重试至空闲，给定时限后如实以错误呈现——不静默继续导致污染）。
- `EngineCore.act()`：集成 guard（构造注入，缺省为"无 guard = 不启用 C33"，保持既有行为不回归）。

## 批二变更说明（P2 v2.0 → v2.1）

v2.1 承接 v2.0（C33）之后的第二个 P2 批次，兑现 **T9 渐进退化检测**（综述 §5.3 九分类诊断表 T9/R24、§10.2 P2 关键标准"T9 检出验证（长会话泄漏注入检出）"）。

- **问题**：长会话/耐久测试中的资源泄漏（内存/句柄）与主线程延迟不是突发故障，而是一条缓慢正斜率曲线——P1 v1.1 性能熔断只按单次 act 墙钟预算裁剪峰值，捕捉不到"每次慢一点、长期持续"的渐进劣化；
- **机制（三信号联合判定）**：engine 每完成一次 act 记录一个退化样本（主线程 AX ping 延迟 + 目标进程常驻内存 + 句柄/文件描述符计数，后两者经 `proc_pidinfo` 实测，无需 TCC 权限）；`DegradationTracker` 在滑动窗口内对三个信号分别做最小二乘线性回归求斜率；"任一步进正斜率超过噪声地板"计为一个上倾信号；**≥2 个上倾信号 → `degrading`（联合判定，T9 检出）**、恰好 1 个 → `watch`（早期预警）、0 个 → `healthy`；长会话（窗口跨度 ≥ 阈值，默认 300s）自动启用并在裁决中标 `longSession: true`；
- **evidence 面（零 schema 变更）**：`degrading` 裁决把本轮 act 的熔断级别**只升不降**地提升到 `.degraded`，reason 以 `degradation|` 前缀承载信号驱动与长会话标记（与 v1.1 `performance|` 前缀同范式）；`Classifier` 依此把该 evidence 判为 **T9**（九分类诊断表的渐进性劣化类），开发者走既有 `diagnose` 工具面即可读到；
- **可测性边界（5.8 R45）**：判定逻辑 100% 单测（脚本化样本序列）；`ProcessMetricsProbe` 为进程指标适配层，真实进程用 proc_pidinfo 自探测验证（getpid 自验常驻内存/句柄 > 0、死亡进程返回 nil），engine 集成用注入的脚本探针；
- **铁约束**：不新增 daemon/socket 帧与 engine 协议方法表（T9 为 EngineCore 内部协调 + evidence 标注，与 C33 同口径）、不修改 kernel schema、不新增错误码、不改变 mcp-shell 工具面；
- **验收口径**：泄漏注入检出（两信号正向漂移序列 → degrading + evidence 熔断升级 + 归类 T9）与无症状零误报（平坦/单信号/样本不足 → 不升级）双面断言。

批次二范围要点：

- `DegradationTracker`（纯逻辑）：滑动窗口（默认 64 样本）、逐信号最小二乘斜率、噪声地板、联合裁决（≥2 信号上倾 → degrading）、长会话标记、`reset()`。
- `ProcessMetricsProbe`（运行时适配层，可注入）：`proc_pidinfo` 读目标进程常驻内存（PROC_PIDTASKINFO）与句柄数（PROC_PIDLISTFDS）；读取失败返回 nil（信号诚实缺失）。
- `EngineCore.act()` 集成：样本采集（ping 仅在 responsive 时计入，避免超时尖峰污染漂移曲线）→ 记录 → 联合裁决 → 熔断级别与 reason 升级（只升不降）。
- `Classifier`：reason 前缀 `degradation|` → 诊断类 T9。

## 批一变更说明（P2 v2.1 → P3 v3.0）

v3.0 是 P3（工程收口面）的第一个批次，兑现综述 C28/C35 的**跨语言契约闭环**。P2 两批（C33/T9）把 engine 的判定性能力补齐后，本批回补契约层缺口：Swift 产 evidence、kernel 消费在 TS、MCP 壳是运行时的真实消费者——三者必须对**同一组真值 fixtures** 达成一致，否则"Swift↔TS 漂移"会在运行期以 GP_E_INTERNAL 呈现（tools.ts 早已把该错误映射为"assertion C35"）。

- **现状盘点（诚实）**：kernel 侧 `test/roundtrip.test.mjs` 已对 4 份 fixtures（evidence-pack.ok-01/02、decision-log-entry.ok-01、recipe-config.ok-01）做 ajv+zod+canonical 比对（C35 TS 侧 ✅）；engine 侧 `EvidenceRoundtripTests.swift` 仅覆盖 2 份 evidence-pack fixtures——**decision-log 在 Swift 无 Codable 绑定（C35 Swift 侧缺口）**；mcp-shell 的 `parseEvidenceFrame`（运行时消费者胶水，tools.ts）强校验 engine 的 last_evidence 帧，但**没有以真值 fixtures 驱动的消费者一致性测试**；
- **机制（三点回环）**：① kernel API 层——4 份 fixtures 经 kernel `parseEvidencePack`/`parseDecisionLogEntry`/`parseRecipeConfig` 解析后，以 mcp-shell `canonicalJson` 规范化并与 fixture canonical 比对；② 消费者胶水层——2 份 evidence fixtures 走 `gp_last_evidence` 端到端（FakeLineIo 注入真实 engine 帧），断言工具输出内容与 fixture canonical 包装形态一致；③ 失败三分类归因（R34）——fixtures 读取失败 → `fixture-upstream`（夹具漂移）、kernel parse 拒绝 → `kernel-api`（schema/zod 回归）、parse 通过但消费者工具拒绝/漂移 → `consumer-glue`（mcp-shell 适配回归），每项断言失败携带归因名便于立即定位；
- **engine 侧补 DecisionLogEntry Swift Codable**（本批唯一的"新能力"事实缺口）：镜像 `kernel/schemas/decision-log-entry.schema.json` 的字段与不变量（entryId `dl_` 模式、sequence ≥0、prevEntryHash 64 位 hex 或空串、operationId 可选 `op_` 模式、summary ≤2048、outcome 枚举 pass/fail/blocked/inconclusive、createdAt ISO-8601 毫秒），与 EvidencePack 同范式（decodeAndValidate + validateInvariants + jsonData）；recipe-config 维持 TS-only 绑定（取舍的诚实声明见 §23——Swift 侧消费路径是 v1.4 YAML RecipeLoader，无 JSON 跨语言样本，不臆造绑定）；
- **铁约束**：不修改 kernel schema 与 kernel 任何文件（fixtures/zod/JSON Schema 全部不动）、不新增 daemon/socket 帧、不改变既存 evidence schema、不新增错误码、不改变 mcp-shell 工具面（新增的仅是测试文件与 engine 内绑定）；
- **验收口径**：C28/C35 在本仓库的落地形态以 mcp-shell `consumer-consistency` 套件 + engine `EvidenceRoundtripTests` 扩展为基准（验收面：4 fixtures × kernel API + 2 × 消费者端到端 + 归因断言 + decision-log 双侧 roundtrip 全绿）。

批次一范围要点：

- mcp-shell 新增 `test/consumer-consistency.test.mjs`：从 `kernel/fixtures` 读取同一组真值（4 份），三层路径回环；每项失败携带三分类归因。
- engine 新增 `DecisionLogEntry`/`DecisionOutcome` Codable（EvidenceModels.swift，同一文件聚合，不新增文件）；`EvidenceRoundtripTests.swift` 增补 decision-log fixture roundtrip + 不变量拒绝用例（坏 entryId/坏 prevEntryHash/负 sequence/非法 outcome/坏 createdAt/缺失必填/超长 summary）。
- 双侧都在 CI 既有通道跑（engine=swift test；mcp-shell=npm build + node --test），无新通道。

## 批二变更说明（P3 v3.0 → v3.1）

v3.1 兑现综述 §16 决策行"**MCP Server 壳用 Swift 手写协议层 —— 否决（列为 P3 优化项）**"的 P3 复审义务。综述把该选项的复审定在 P3（正是本批）；P1 评审回顾了 R44（MCP 壳零运行时依赖）未翻转。本批以**代码库实测事实**重跑该决策，结论与 §16 原判保持同向：**维持 TS 壳现状，正式关闭该优化项**——不是由于"懒得动"，而是因为"壳的性质已变"：P0 设计时壳是纯协议翻译（6 工具），P1/P2 后工具面扩至 13 个且壳接入了 kernel 消费者/报告渲染/项目注册表/审计会话多重语义（§24 逐项列出实测数据）。这恰恰否定了原决策中"壳仅做协议翻译不承载语义"的前提——若此刻迁 Swift，等于推翻后盾，把 kernel 消费者矩阵中"GlassPane MCP 壳"这一列搬进 Swift（与 R34/§8.5 冲突），并重写 1702 行 TS（§24 实测）。

- **评估范围**：仅复审"Swift 手写 MCP 消息层替代 TS mcp-shell"一条；R44 的"官方 TS SDK 评估"不在本批（工具面扩张已达 13，若未来换 SDK 属另一决策）；
- **评估方法**：实测 mcp-shell 规模与语义承载 + 与综述原判依据逐条对照 + 进程跳转成本量化口径 + 触发重估条件的显式定义（防"无限期搁置"）；
- **结论（本批正式落地）**：维持 TS 壳；Swift 手写 MCP 消息层维持否决；新增三条触发重估条件（官方 Swift SDK 就绪 / MCP 传输标准演进而 TS SDK 落后 / 实测跳转瓶颈）——任一成立即重新开项并出具新评估批次；
- **落地形态**：本批为**评估/决策批次，零代码变更**（规格-only）；验收以评估完整性 + 与综述 §16 判一致性 + 条件定义完备性为准（§25）。

## 批三变更说明（P3 v3.1 → v3.2）

v3.2 兑现综述 §5.6 的 P3 复审义务：综述 R30 明确 LLDB 桥落地形态为"**Python 脚本 + SB API + local socket 回传 Swift daemon**"，同时把"**编译型 C++ plugin 形态（消除 Python 依赖）**"标注为后续优化选项、复审时点定在 P3（正是本批）。本批以**代码库实测现状**重跑该形态决策，结论与综述原判同向：**维持 Python 脚本 + SB API 形态**；C++ plugin 维持"后续优化选项"定性但**不因 P3 时点到达而自动激活**——与 v3.1 批二同范式，把"到点就翻"改为"条件成立才翻"。

- **评估范围**：仅复审"LLDB 桥实现形态：编译型 C++ plugin vs Python 维持管线"一条；探针 SDK / debugserver / socket 协议帧等其他面不在本批；
- **评估方法**：实测仓库中 LLDB 桥的落地程度（代码/规格两侧）+ 与综述原判（R30 + 第 21 行"LLVM 长期设计"）逐条对照 + 形态切换的成本收益量化口径 + 触发重估条件的显式定义（防"P3 未兑现即挂起"）；
- **结论（本批正式落地）**：维持 Python 脚本 + SB API；C++ plugin 不激活；新增三条触发重估条件（官方脚本层翻转 / 交付形态强约束 / 实测采集瓶颈）——任一成立即重新开项并出具新评估批次；
- **落地形态**：本批为**评估/决策批次，零代码变更**（规格-only）；验收以评估完整性 + 与综述 §5.6 判一致性 + 条件定义完备性为准（§28）。

---

## 1. 项目注册表

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

> **版本结构说明（v1.6 → v2.0）**：v2.0 在 v1.6 的 §1–§14 之后追加 P2 批一范围 §15–§17（并发归因污染防护：设计、可测性与验收、风险），v1.6 正文 §1–§14 逐字保留不变。v1.6 §3 所述"不改变 daemon 方法表（不新增 socket 帧）"约定继续成立——本批操作权互斥为 EngineCore 内部协调，无协议帧面变化。

---

## 15. 并发归因污染防护（P2 批一新增）

### 15.1 定位

对应综述 §5.3 并发归因污染防护（R21）/ C33 / §5.14 输入监控权限。此前 evidence 的归因强度恒为 `soft` 且 `contaminated=false`——当用户真实操作与 agent 操作并发时，进程级插槽的归因会被静默污染（综述明确这是"真实开发常态"：开发者边手动点边让 agent 跑）。本批把"污染检测与标注"做成引擎的**判定性核心**，让 evidence 如实呈现"本次归因是否可信"，宁降级不静默错判（综述 §14 钦定对冲）。

### 15.2 engine 新增：InputEventSource

```swift
/// 输入事件源抽象：daemon 在持有操作权期间轮询的全局输入流。
public protocol InputEventSource: AnyObject {
    /// 取下一个尚未消费的输入事件；无事件时返回 nil（非阻塞轮询语义）。
    func nextEvent() -> InputEvent?
}

public struct InputEvent: Codable, Equatable {
    public let timestamp: Double      // epoch seconds，可注入时钟
    public let source: InputSource    // .agent / .human

    public init(timestamp: Double, source: InputSource) {
        self.timestamp = timestamp
        self.source = source
    }
}

public enum InputSource: String, Codable {
    case agent  // AX 合成事件（agent 自身操作）
    case human  // CGEvent 全局捕获的真实用户输入（键盘/鼠标）
}
```

事件序列语义：`nextEvent()` 单调消费。脚本化测试源 `ScriptedInputEventSource` 按预置队列回放（含时间戳与来源精确构造的"并行用户输入"场景）。

### 15.3 engine 新增：AttributionGuard（操作权互斥 + 空闲检测 + 污染判定）

```swift
public enum OperationRightAcquisition: Equatable {
    case acquired
    case idleNotMet   // 空闲窗口内仍有真实输入，不能独占操作
}

public struct OperationRightVerdict: Equatable {
    public let contaminated: Bool      // 持有期间检测到 .human 事件
    public let humanEvents: [InputEvent] // 持有的证据（进报告/日志，不垄断 evidence）
}

/// 纯逻辑：输入空闲检测 + 操作权互斥 + 污染判定。可注入时钟与事件源，无 AX 依赖。
public final class AttributionGuard {
    public init(
        inputSource: InputEventSource,
        clock: @escaping () -> Date = { Date() },
        idleWindowSeconds: Double = AttributionGuard.defaultIdleWindowSeconds
    )

    /// 输入空闲检测：最近 idleWindow 秒内无 .human 事件才返回 .acquired。
    public func acquireOperationRight() -> OperationRightAcquisition
    /// 持有操作权后轮询输入流，收集期间的全部输入事件。
    public func monitorInput()
    /// 结束持有并裁决：本次操作是否被真实用户输入污染。
    public func releaseOperationRight() -> OperationRightVerdict
}
```

- hood advance 语义：`acquireOperationRight()` 失败（`.idleNotMet`）= 输入不空闲，daemon 应等待重试；`EngineCore` 默认重试直至空闲，重试超时后如实以 `GP_E_BUSY_INPUT` 错误呈现（见 §15.4，本批新增错误码）。
- 污染判定规则：持有期间（acquire 成功 → monitorInput 扫描 → release 之间）出现任何 `.human` 事件 → `contaminated=true`；否则 `contaminated=false`。
- 互斥语义：`AttributionGuard` 之上由 EngineCore 串行化 act——同一 EngineCore 实例内 act 天然串行（SocketServer 单连接语义），guard 负责"与全局真实输入的互斥"（用户输入是独占窗口的天然反对者）。

### 15.4 EngineCore 挂接与错误码

- `EngineCore.init` 增参 `attributionGuard: AttributionGuard? = nil`（nil = 不启用 C33，保持 v1.6 行为零回归）。
- `act()` 前置：若 `attributionGuard != nil` → `acquireOperationRight()`；`.idleNotMet` 时内部重试（`idleRetryCount` 默认 5 次 × `idleRetryInterval` 默认 100ms）；重试耗尽 → `GP_E_BUSY_INPUT`（不静默继续导致污染）。
- act 执行后：`monitorInput()` → `releaseOperationRight()` → 裁决 `contaminated` 写入 evidence attribution：污染时 `level = .weak, contaminated = true`；纯净时保持 `level = .soft, contaminated = false`（与既有语义一致）。
- **新增错误码**（与规格 §5 错误码表同模式；综述 §3 GP_E 表扩展口径允许 P2 能力承载新错误——`GP_E_BUSY_INPUT` 为能力错误面，非内部实现细节）：

| 错误码 | 含义 | agent 补救指引 |
|---|---|---|
| GP_E_BUSY_INPUT | 输入空闲窗口内持续有真实用户输入，操作权无法获取 | 暂停 agent，等用户停止操作后再 act；或改用 degrade 模式（agent 选择继续时归因降级 weak + contaminated 标注） |

### 15.5 与 reviewed 面的关系（无冲突）

| 面 | 关系 |
|---|---|
| evidence schema | 不改——`Attribution.level/contaminated` 已存在，本批首次真实落地 `weak + contaminated=true` 组合 |
| daemon 方法表 | 不新增帧（guard 为 EngineCore 构造注入 + act 内集成） |
| mcp-shell 工具面 | 不改语义；evidence 透传后 agent 可读 `attribution.contaminated` 自行决策（继续/暂停） |
| 既有 act 行为 | `attributionGuard == nil` 时完全等同 v1.6 |

---

## 16. 可测性与验收

### 16.1 单测（无 AX 依赖，`EngineP2Batch1Tests`）

- `ScriptedInputEventSource`：队列回放、事件消费单调、空队列返回 nil。
- `AttributionGuard.acquireOperationRight()`：
  - 空闲窗口内无 `.human` 事件 → `.acquired`；
  - 空闲窗口内有 `.human` 事件 → `.idleNotMet`（不获取操作权）。
- `AttributionGuard` 污染判定：
  - 持有期间无输入 / 仅 `.agent` 事件 → `contaminated = false`；
  - 持有期间任意 `.human` 事件 → `contaminated = true`（事件时间窗 = acquire→release 之间）。
- `EngineCore.act()` 集成（ScriptedChannel + ScriptedInputEventSource 双注入）：
  - 无 guard → evidence `contaminated=false, level=soft`（零回归）；
  - guard + 纯净输入 → 同上（不误杀）；
  - guard + 并行 `.human` 事件 → evidence `contaminated=true, level=weak`；
  - guard + 持续不空闲 → 重试耗尽 → `GP_E_BUSY_INPUT` 抛出，无 evidence 落盘。
- **C33 合成场景统计**（明确断言口径）：构造 100 个合成操作场景（60 污染 / 40 纯净），断言检出率 ≥95%（污染场景中被标污染 ≥57/60）、误杀率 <5%（纯净场景中被误标 ≤1/40）。场景生成采用确定性伪随机（固定种子），用例可复现。

### 16.2 真机冒烟（可选，需 TCC 输入监控权限）

- CGEvent 全局输入监控适配层（`CGEventInputMonitor`，运行时文件）：真实用户按键/移动鼠标 → 冒烟脚本断言归因被污染。无自动化（与 AX 适配层同口径，R45）。

### 16.3 验收表

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P2-A1 | 事件源抽象 | ScriptedInputEventSource 队列回放与单调消费单测通过 | ✓ 已实现并单测通过（2026-09-17，`EngineP2Batch1Tests` 3 用例） |
| P2-A2 | 输入空闲检测 | 空闲窗口无 human 事件→acquired；有→idleNotMet | ✓ 已实现并单测通过（2026-09-17，空闲窗口/已持有/边界含端点用例） |
| P2-A3 | 污染判定 | 持有期间 human 事件→contaminated=true；无/仅 agent→false | ✓ 已实现并单测通过（2026-09-17，含 monitor 与 release 间到达事件） |
| P2-A4 | act 集成零回归 | 无 guard 时 evidence 与 v1.6 一致（soft/false） | ✓ 已实现并单测通过（2026-09-17，`testActWithoutGuardKeepsPodv16Semantics`） |
| P2-A5 | act 污染标注 | 并行 human 事件→evidence weak+contaminated=true | ✓ 已实现并单测通过（2026-09-17） |
| P2-A6 | 忙碌错误 | 重试耗尽→GP_E_BUSY_INPUT，无 evidence 落盘 | ✓ 已实现并单测通过（2026-09-17，含重试后恢复为 acquired 用例） |
| P2-A7 | C33 数值口径 | 合成场景检出率 ≥95%、误杀率 <5% | ✓ 已实现并单测通过（2026-09-17，固定种子 0xC33 合成套件，检出率 100%、误杀率 0%） |
| P2-A8 | 全量回归 | engine + mcp-shell 全用例不回归 | ✓ 回归通过（2026-09-17：engine 204 用例 0 失败 1 跳过；mcp-shell 56 用例全绿） |

---

## 17. 风险与边界（诚实声明）

1. **输入空闲窗口为启发式**：默认 500ms 空闲窗口无法保证"用户一定不会在窗口后动手"——它只是把污染概率压到 C33 口径内（合成场景验证），非硬保证；短窗口减延迟、长窗口降误杀，参数可配置。
2. **CGEvent 监控需输入监控 TCC 权限**：用户拒绝 → C33 降级为纯操作权互斥（无输入流证据，污染不可判定），与综述 §5.14 "拒绝输入监控 → C33 并发污染检测降级为纯操作权互斥"一致——本批该降级路径为：guard 不注入（daemon 不启用 C33 检测），如实降级。
3. **归因是软/弱强度而非强**：本批不改归因强度模型（Z5 通道软归因为既有事实），只保证"污染被如实标出"；强归因链路（TaskLocal）仍属探针 SDK（P1+ 通道），不在本批。
4. **合成场景非真实输入分布**：单元测试的检出率/误杀率基于构造场景集，真机输入分布可能不同——C33 数值口径以合成场景基准验收，真机冒烟补充观测，正式 C33 现场验收在真机冒烟完成后以实测数据回填。

---

## 18. 渐进退化检测（T9，批二新增）

### 18.1 退化样本

```swift
public struct DegradationSample: Equatable {
    public let timestamp: Double    // epoch 秒（可注入时钟）
    public let pingMs: Double?      // 主线程 AX ping 延迟（仅 responsive 时计入）
    public let memoryBytes: Int64?  // 目标进程常驻内存（proc_pidinfo）
    public let handleCount: Int?    // 目标进程句柄/文件描述符数（proc_pidinfo）
}
```

- 字段可选 = **信号诚实缺失**：探针读不到内存/句柄（进程退出、权限异常）时置 nil，该信号不参与回归统计，不产假斜率；
- ping 仅在 `ResponsivenessSignal.responsive == true` 时计入：AX 超时是一次性 2000ms 尖峰而非漂移，纳入会污染主线程漂移曲线（super-timeout 与 drift 是两个故障面——前者走 v1.1 T2 路径，后者才是 T9）。

### 18.2 DegradationTracker 判定（纯逻辑）

- 滑动窗口：默认保留最近 **64** 个样本（FIFO 修剪，与 evidence 环形历史同范式）；
- 逐信号最小二乘线性回归：以（x = timestamp, y = 信号值）拟合，斜率单位分别为 ms/s、bytes/s、fds/s；样本 <2 或 x 跨度为 0 → 斜率 nil（不足统计）;
- 噪声地板（具名常量，可注入覆盖）：ping 0.5 ms/s、内存 512 bytes/s、句柄 0.05 fds/s——斜率低于地板的缓慢波动视为 jitter 不计入（防误报）；
- **上倾信号**：斜率 ≥ 地板（正值持续向上）的信号；**联合裁决**：上倾信号数 ≥2 → `degrading`（三信号联合判定，T9 检出）；恰好 1 个 → `watch`（早期预警）；0 个 → `healthy`；样本不足最低统计数（默认 ≥6 或 ≥2，可注入）→ `healthy`（数据不足不妄判）；
- **长会话**：窗口跨度（末样本时间戳 − 首样本时间戳）≥ 阈值（默认 300s）→ `verdict.longSession = true`（综述"长会话/耐久测试场景卡自动启用"），随裁决输出但不改变 tier 本身；
- `reset()`：清空窗口——attach 切换到不同 app 时调用（退化轨迹按被测会话隔离，与 evidence 历史清空语义一致）。

```swift
public struct DegradationVerdict: Equatable {
    public let tier: DegradationTier          // .healthy / .watch / .degrading
    public let pingSlopeMsPerSec: Double?     // 各信号斜率（供审计/报告）
    public let memorySlopeBytesPerSec: Double?
    public let handleSlopePerSec: Double?
    public let sampleCount: Int
    public let elapsedSeconds: Double
    public let longSession: Bool
    public let drivers: [String]              // 上倾信号名：ping/memory/handles
}
```

### 18.3 引擎集成（EngineCore.act()）

- 构造注入 `degradationTracker`（缺省 nil = 不启用，保持 v2.0 行为不回归）；daemon（glasspaned）传入 `DegradationTracker()` + `ProcessMetricsProbe()` 默认启用（T9 无 TCC 依赖，与 C33 的默认关闭不同）；
- 每次 act 收尾采集样本：`timestamp = clock()`、`pingMs = responsive ? pingMs : nil`、内存/句柄经探针按 `attachedApp.pid` 读取 → 记录进 tracker；
- 取联合裁决，若 `tier == .degrading`：**只升不降**把本轮 evidence 熔断级别提升到 `.degraded`，reason 改写为 `degradation|` + 上倾信号列表 + `longSession=…`（与 v1.1 `performance|` 前缀同范式；已存在的更高通道熔断级别不受影响）；
- `attach()` 切换到不同 app 时 `tracker.reset()`。

### 18.4 Classifier T9 归类

`Classifier.classify` 在 act 确认后的判别序列中新增规则：`circuitBreaker.reason` 以 `degradation|` 前缀开头 → 诊断类 **T9**（渐进性劣化），路径沿用 evidence 摘要，anomaly 指向"≥2 信号持续正斜率（内存/句柄/主线程延迟泄漏）"。该规则排在无 anomaly 分支之前、`T3/T6` 分支之前——防"渐进劣化被误读为死点击/渲染层 bug"。

---

## 19. 可测性与验收

### 19.1 单测（无 AX 依赖，`EngineP2Batch2Tests`）

- `DegradationTracker` 纯逻辑（脚本化样本序列，注入阈值小值加速判定）：
  - 平坦序列 → `healthy`、drivers 空；
  - 单信号正斜率（仅内存）→ `watch`；
  - 双信号正斜率（内存 + ping）→ `degrading`，drivers 含两者；
  - 句柄 + 内存双正 → `degrading`；
  - 样本不足（低于最低统计数）→ `healthy`；
  - 窗口修剪：超过 64 样本只保留最近 64，verdict 基于窗口内数据；
  - `longSession`：跨度 ≥ 阈值 → true；
  - 信号缺失：内存/句柄为 nil 时最多 `watch`，永不 `degrading`；
  - `reset()` 清空窗口。
- `ProcessMetricsProbe`：当前测试进程（getpid）自探测 → 常驻内存 > 0 且句柄数 > 0；对不存在的 pid → 内存/句柄均 nil（诚实缺失）。
- `EngineCore.act()` 集成（ScriptedChannel + 脚本探针双注入）：
  - 无 tracker → 与 v2.0 完全一致（零回归）；
  - 平坦序列多轮 act → 熔断级别不升级、reason 无 `degradation|` 前缀（零误报）；
  - 上升 ping + 上升内存序列 → 达到统计数后 evidence 熔断升级 `.degraded` + `degradation|` 前缀；
  - 仅 ping 上升（探针 nil）→ 至多 `watch`，evidence 不升级（缺失信号不妄判）；
  - `attach` 切换 app → tracker 窗口重置。
- `Classifier`：构造 reason = `degradation|…` 且 actConfirmed 的包 → `DiagnosisClass.t9`；reason 无前缀 → 不判 T9。

### 19.2 真机冒烟（可选）

- daemon 长跑对同一金丝雀 app 持续 act，注入内存泄漏的对照组 → `gp_recent_reports`/`last_evidence` 可见 `.degraded` + `degradation|` reason 的 evidence，`gp_diagnose` 输出类 T9（与 C33 冒烟同口径：真机补充观测，正式 T9 现场验收以实测数据回填）。

### 19.3 验收表

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P2-B1 | 纯逻辑联合裁决 | 平坦→healthy、单信号→watch、双信号→degrading | ✓ 已实现并单测通过（2026-09-17，`EngineP2Batch2Tests`：平坦/单信号内存/内存+ping 双信号/内存+句柄双信号） |
| P2-B2 | 数据不足与缺失诚实性 | 样本不足→healthy；信号 nil 永不 degrading | ✓ 已实现并单测通过（2026-09-17，不足 6 样本→healthy；仅 ping 上升→至多 watch 永不到 degrading） |
| P2-B3 | 窗口与生命周期 | 64 上限 FIFO 修剪；reset 清空；longSession 标记 | ✓ 已实现并单测通过（2026-09-17，70→64 修剪、reset→0、320s 跨度标记） |
| P2-B4 | 探针真实读取 | getpid 自探测内存/句柄均 > 0；死亡 pid → nil | ✓ 已实现并单测通过（2026-09-17，getpid 自验；不存在的 pid 双信号均 nil——LISTFDS 尺寸探针不校验 pid，改为以 TASKINFO 存在性联动，防"死进程冒充零句柄"） |
| P2-B5 | act 集成零回归 | 无 tracker 时与 v2.0 一致；平坦序列不升级 | ✓ 已实现并单测通过（2026-09-17，无 tracker→normal 无前缀；平坦双轮 act→不升级） |
| P2-B6 | act 联合升级 | 双信号漂移 → evidence `.degraded` + `degradation|` reason | ✓ 已实现并单测通过（2026-09-17，ping 2→5 + 内存 1K→5K→第二轮 evidence 升级 .degraded，reason 含 memory+ping） |
| P2-B7 | Classifier T9 | degradation 前缀包 → 诊断类 T9 | ✓ 已实现并单测通过（2026-09-17，前缀包→T9；无前缀不判 T9；unconfirmed 保持 INCONCLUSIVE） |
| P2-B8 | 全量回归 | engine + mcp-shell 全用例不回归 | ✓ 回归通过（2026-09-17：engine 223 用例 0 失败 1 跳过；mcp-shell 56 用例全绿） |

### 19.4 与既有面联动

| 关注面 | 影响 |
|---|---|
| daemon socket 方法表 | 无变更（T9 为 EngineCore 内部协调 + evidence 标注） |
| evidence-pack schema | 无变更（复用 `circuitBreaker.level/reason` 与 `DiagnosisClass.t9` 既有字段） |
| 错误码 | 无新增 |
| kernel zod 绑定 / fixtures | 无变更 |
| mcp-shell 工具面 | 无变更（`gp_recent_reports`/`gp_last_evidence`/`gp_diagnose` 已可读 T9 结果） |

---

## 20. 风险与边界（诚实声明）

1. **回归斜率是启发式**：最小二乘斜率对窗口内病态数值（钩刺性尖峰、进程重启导致的驻留内存跳变）敏感——本批以噪声地板 + 联合≥2 信号双保险压制单信号误报；真实泄漏曲线更平滑（True Positive 面），短时尖峰更可能出现在单信号（误报面已隔离为 watch）。
2. **内存/句柄的进程语义**：resident_size 是 RSS 采样，与 GC/内存映射变化有抖动；句柄数含常规 fd。T9 判定的是"长期持续正斜率"而非瞬时值——单测以固定序列验证趋势判定，真机曲线受系统抖动影响，正式验收以真实泄漏注入对照（综述 §10.2"长会话泄漏注入检出"）为准。
3. **ping 仅 responsive 计入**：AX 超时（responsive=false）样本不含 ping，若超时常态化（T2 面），T9 曲线不会因此虚高——但也意味着"超时型劣化"不被 T9 捕获（由 T2 面处理），两故障面分工明确。
4. **探针读取无 TCC 依赖但受进程可见性限制**：macOS 下目标进程属同一用户即可读 proc_pidinfo；跨用户/特权进程读取失败 → 信号 nil → 退化到至多 watch，如实降级。
5. **升级只升不降**：degrading 裁决把 evidence 升 `.degraded`；后续恢复不再自动降级（与 v1.1 性能熔断口径一致）——避免抖动的级别回摆造成诊断抖动；真正恢复后新 act 的 evidence 自然回落，历史包保持升级态。

---

## 21. 三方消费者一致性（C28/C35，P3 批一新增）

### 21.1 定位

对应综述 **R33/C35**（证据 schema 双语言契约：JSON Schema 唯一真源 + Swift Codable 与 TS zod 双绑定 + roundtrip 契约测试）与 **R34/C28 扩展**（MCP 契约一致性测试扩展为 kernel 消费者一致性、失败三分类归因：kernel API / fork 适配胶水 / 上游）。§8.5 将"两个 TS 壳消费 kernel v0.1"与"四消费者一致性测试就位"列为 **Phase B 入口门控**，"P1 出口 + C28/C35 达标"是前置条件——本批在该门控的**本仓库可落地面**上把 C28/C35 补成完整闭环。

r34 的"四消费者矩阵"在 iterate monorepo 的形态（harness / plugin / 第三个项目）不属于本仓库范围（Phase B 宿主迁移后由 monorepo 侧实现，综述 R43）；本仓库作为 kernel Phase A 宿置地，兑现矩阵中**全部本站消费者**：kernel API 本身（TS 测试面）、Swift Codable（engine 生产/消费面）、GlassPane MCP 壳（mcp-shell 运行时胶水面）。

### 21.2 现状盘点（本批起点的事实基线）

| 面 | 现状 | 缺口 |
|---|---|---|
| kernel TS 侧 C35 | `test/roundtrip.test.mjs` 对 4 份 fixtures（evidence-pack ok-01/02、decision-log-entry ok-01、recipe-config ok-01）做 ajv+zod+canonical 三层比对 | 无 |
| engine Swift 侧 C35 | `EvidenceRoundtripTests.swift` 对 2 份 evidence-pack fixtures 做 decodeAndValidate + canonicalJSON 比对 | **decision-log 无 Swift Codable，双侧不齐** |
| mcp-shell 消费者胶水 | `parseEvidenceFrame`（tools.ts）经 kernel `parseEvidencePack` 强校验 last_evidence 帧，漂移映射 `GP_E_INTERNAL` + "assertion C35" remedy | **无真值 fixtures 驱动的消费者一致性测试** |
| fixtures 真值集 | `kernel/fixtures/` 4 份，唯一真源 | 无 |

### 21.3 本批落地动作

**① engine 新增 DecisionLogEntry Swift 绑定**（C35 Swift 侧缺口补平）

镜像 `kernel/schemas/decision-log-entry.schema.json`（zod 镜像同源），进 `EvidenceModels.swift` 同一文件聚合，与 EvidencePack 同范式：

```swift
public enum DecisionOutcome: String, Codable {
    case pass, fail, blocked, inconclusive
}

public struct DecisionLogEntry: Codable, Equatable {
    public static let summaryMaxLength = 2048
    public let entryId: String      // ^dl_[0-9A-HJKMNP-TV-Z]{26}$
    public let sequence: Int        // ≥ 0
    public let prevEntryHash: String // ^([0-9a-f]{64})?$（创世条目为空串）
    public let operationId: String?  // 可选，^op_[0-9A-HJKMNP-TV-Z]{26}$
    public let summary: String      // ≤ 2048
    public let outcome: DecisionOutcome
    public let createdAt: String    // ISO-8601 毫秒 UTC
}
```

- 必填字段由非 Optional 属性承担（缺失 → DecodingError.keyNotFound，如实抛出）；`outcome` 由 raw-value 枚举承担枚举约束；`operationId` Optional 在编码时**省略不写 null**（与 zod `optional()` 语义一致，区别于 evidence 的显式 null）。
- `validateInvariants()` 补 Codable 表达不了的模式/极值约束：entryId 模式、sequence ≥ 0、prevEntryHash 模式、operationId 模式（present 时）、summary 长度、createdAt 模式——失败抛 `DecisionLogEntryError`（与 `EvidencePackError` 同范式）。
- `decodeAndValidate(_ data:)` + `jsonData()`（复用 `EvidencePack.encoder` 的 `.sortedKeys` + `.withoutEscapingSlashes` 编码器）与 EvidencePack 完全对称。

**② engine C35 测试扩展**（`EvidenceRoundtripTests.swift` 增补，镜像 TS 侧 roundtrip）

- decision-log-entry.ok-01 roundtrip：decodeAndValidate → jsonData → `canonicalJSON` 与 fixture canonical 相等；再编码值再解码值相等；
- fixture 形态断言（entryId `dl_`、sequence 0、prevEntryHash 空串、operationId 存在、outcome pass、createdAt 毫秒）；
- 不变量拒绝用例：坏 entryId / 坏 prevEntryHash / 负 sequence / 非法 outcome / 坏 operationId / 坏 createdAt / 缺失必填字段 / summary 超 2048——各自抛对应错误，不崩不静默；
- recipe-config **不做** Swift 绑定（§23 风险 2 诚实声明：Swift 消费路径为 v1.4 YAML RecipeLoader，无跨语言 JSON 样本，绑定即臆造）。

**③ mcp-shell 消费者一致性测试**（新增 `test/consumer-consistency.test.mjs`，不改工具面）

从 `kernel/fixtures` 直读同一组真值（`../../kernel/fixtures/`），三层路径回环：

- **kernel-api 层**：4 份 fixtures 依次经 `parseEvidencePack`/`parseDecisionLogEntry`/`parseRecipeConfig`，以 mcp-shell 自有 `canonicalJson` 规范化并与 fixture canonical 比对——kernel zod 绑定与 mcp-shell 独立 canonical 实现的第三重交叉；
- **consumer-glue 层**：2 份 evidence fixtures 走 `gp_last_evidence` 端到端（FakeLineIo 注入 `{evidencePack: fixture}` 帧 → executeTool），断言 `isError = false` 且输出文本 === `canonicalJson({ evidencePack: fixture })`；
- **归因层**：kernel parse 拒绝（例：`operationId: "bad"`）→ `kernel-api` 归因且错误文本含 "assertion C35" remedy；帧级结构破坏（例：`evidencePack: "not-an-object"`）→ `consumer-glue` 归因 `GP_E_INTERNAL`；fixtures 缺失/损坏 → `fixture-upstream` 归因（读取抛错路径）。每个断言失败以归因名标识，违规立即定位（R34）。

### 21.4 与既有面联动

| 关注面 | 影响 |
|---|---|
| kernel schema / zod / fixtures | **零改动**（真值集为只读真源） |
| evidence-pack schema | 无变更 |
| daemon socket 方法表 | 无变更 |
| 错误码 | 无新增 |
| mcp-shell 工具面 | 无变更（新增仅测试文件；`parseEvidenceFrame` 既有行为被 fixtures 反向钉死） |
| CI 通道 | 无新增（engine=swift test / kernel=npm test / mcp-shell=npm build+test 既有通道覆盖） |

---

## 22. 可测性与验收

### 22.1 单测清单

- **engine**（`EvidenceRoundtripTests.swift` 增补，无 AX 依赖，fixtures 经 KernelFixtures 读 kernel 真值集）：
  - decision-log ok-01 canonical roundtrip；再编码值相等；fixture 形态（entryId/sequence/prevEntryHash/outcome/createdAt）；
  - 拒绝面：坏 entryId（`DecisionLogEntryError.badEntryId`）、坏 prevEntryHash（`.badPrevEntryHash`）、sequence = -1（`.badSequence`）、outcome = "maybe"（DecodingError，枚举不可译）、坏 operationId（`.badOperationId`）、createdAt 非法（`.badCreatedAt`）、缺失必填 prevEntryHash（keyNotFound）、summary 2049（`.summaryTooLong`）。
- **mcp-shell**（`consumer-consistency.test.mjs` 新增，`node --test` 既有通道）：
  - kernel-api 层 4 fixtures 逐一 canonical 回环；
  - consumer-glue 层 2 evidence fixtures `gp_last_evidence` 端到端；
  - 归因层：kernel-api 拒绝（C35 remedy 文本）、consumer-glue 帧破坏（GP_E_INTERNAL）、fixture-upstream 缺失文件（ENOENT 冒泡即上游归因）。
- 双侧全量回归：engine 全用例 + mcp-shell 全用例 + kernel 全用例（kernel 本批零改动，仅回归确认）。

### 22.2 验收表

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P3-A1 | kernel-api 四 fixture 回环 | 4 份 fixtures 经 kernel parse → mcp-shell canonicalJson → 与 fixture canonical 相等 | ✓ 已实现并单测通过（2026-09-17，`consumer-consistency.test.mjs`） |
| P3-A2 | consumer-glue 端到端 | 2 份 evidence fixtures 走 gp_last_evidence 工具路径 isError=false 且规范形一致 | ✓ 已实现并单测通过（2026-09-17，FakeLineIo 注入真值帧） |
| P3-A3 | 失败三分类归因 | kernel-api / consumer-glue / fixture-upstream 三类断言各自归因正确 | ✓ 已实现并单测通过（2026-09-17，C35 remedy 文本 + GP_E_INTERNAL + ENOENT） |
| P3-A4 | DecisionLogEntry roundtrip | Swift Codable decode→encode canonical 与 fixture 相等；再编码值相等 | ✓ 已实现并单测通过（2026-09-17，`EvidenceRoundtripTests`） |
| P3-A5 | DecisionLogEntry 不变量拒绝 | 坏 entryId/prevEntryHash/operationId/sequence/outcome/createdAt/缺失必填/超长 summary 全部拒绝不崩 | ✓ 已实现并单测通过（2026-09-17，8 拒绝用例） |
| P3-A6 | recipe-config 维持 TS-only | 不新增 Swift 绑定；TS 侧 ajv+zod roundtrip 继续全绿 | ✓ 已核实并写入 §23 风险 2（TS 侧回归通过） |
| P3-A7 | 全量回归 | engine + mcp-shell + kernel 全用例不回归 | ✓ 回归通过（2026-09-17：engine 234 用例 0 失败 1 跳过〔223+11〕；mcp-shell 65 用例全绿〔56+9〕；kernel 47 用例全绿〔零改动〕） |

---

## 23. 风险与边界（诚实声明）

1. **本仓库只承载本站消费者**：四消费者矩阵中的 iterate-harness / iterate-plugin / 第三个项目在 monorepo Phase B 落地（R43 迁移后），本批不越界模拟它们的消费路径——mcp-shell 的 `consumer-consistency` 只钉本站消费者，矩阵其余列的验收由 Phase B 门控承接，杜绝"为别的仓库写测试"的伪闭环。
2. **recipe-config 维持 TS-only 是刻意取舍而非实现欠账**：Swift 侧唯一消费入口是 v1.4 `RecipeLoader`（YAML → 校验），不存在 recipe-config JSON 的跨语言样本——为它写 Swift Codable 绑定没有任何真值可用，属于"无生产者的绑定"（伪实现红线）。若 Phase B 出现 Swift 侧 JSON 消费者，再补绑定 + 双侧 fixtures。
3. **decision-log 绑定面向未来消费者**：当前 Swift engine 尚无决策链的生产者（审计链在 Phase B 由两 TS 壳消费 kernel 时具成）；本批的绑定是"契约层先就位"——以 fixtures 真值 pin 住 Swift 与 TS 对同一 schema 的解释，等到消费者出现时无漂移成本。若 schema 冻结前字段演进，双侧 fixtures 同步修改（draft 纪律，综述 5.8 使用提示 ③ 同口径）。
4. **字符长度语义的跨语言差值**：Swift `String.count`（Unicode 标量簇）与 zod `maxLength`（UTF-16 code units）对非 BMP 字符计数不同——decision-log summary 超长判定在极边缘场景可能差一个字符；当前 fixtures 均为 ASCII，契约以 fixtures 为准，差值如实声明不静默归一。
5. **消费者测试读的是文件而非包内资源**：`consumer-consistency.test.mjs` 经相对路径读 `kernel/fixtures`，要求仓库布局保持（workspace 迁移 Phase B 时随 R43 一并调整）；若未来 mcp-shell 单独发布（现为 private），测试随源码走，读路径不变即可。

> **版本结构说明（v2.1 → v3.0）**：v3.0 在 v2.1 的 §1–§20 之后追加 P3 批一范围 §21–§23（三方消费者一致性：设计、验收、风险），v2.1 正文 §1–§20 逐字保留不变。v2.1 头部"契约真源角色"所述"P3 及后续见 v3.0+"由本文件兑现。

---

## 24. Swift 手写 MCP 消息层评估（P3 批二新增）

### 24.1 复审对象与原始决策

复审对象：以 Swift 手写 MCP 消息层替代 TS mcp-shell，让 daemon 直接对 agent 讲 MCP（消除"agent ↔ mcp-shell(TS, stdio) ↔ daemon(Swift, local socket)"中的 TS 进程一跳）。

综述 §16 原始决策（547 行，原文照录）：

> MCP Server 壳用 Swift 手写协议层 —— **否决（列为 P3 优化项）** —— 官方无 Swift SDK，TS 生态 SDK 成熟；壳仅做协议翻译不承载语义，跨语言成本一次性且微小

原始否决的两条依据：① 官方无 Swift SDK；② 壳仅做协议翻译不承载语义。P3 复审义务即在此：逐条对照代码库现状。

### 24.2 实测事实（2026-09-18，wc -l 实测）

| 事实 | 实测值 | 与原始否决依据的关系 |
|---|---|---|
| mcp-shell TS 总量 | 10 文件 1702 行（tools.ts 691 / evidence-report.ts 191 / project-registry.ts 175 / dispatch.ts 166 / engine-client.ts 151 / index.ts 113 / io.ts 99 / audit-session.ts 66 / canonical.ts 22 / errors.ts 28） | 若迁 Swift 全量重写 |
| 工具面 | P0 6 工具 → 现 13 工具（v1.4 + project_list/set/get；含 report 双格式） | 协议翻译面已扩张 >2 倍 |
| 语义承载 | ① kernel 消费者：`parseEvidenceFrame`→`parseEvidencePack` 强校验（C35 闭环，v3.0 批一刚用真值 fixtures 钉死）；② 报告渲染：evidence-report.ts HTML/Markdown 双格式；③ 项目注册表：project-registry.ts 持久化 JSON；④ 审计会话：audit-session.ts 操作轨迹 | **否定"壳仅做协议翻译不承载语义"的前提** |
| kernel 侧规模 | kernel/src 401 行（schema 真源 + zod 镜像） | Swift 侧无法复用 zod，只能靠 C35 双绑定间接对齐 |
| 进程形态 | mcp-shell 为 MCP 标准 stdio server（长驻进程）；与 daemon 经本地 socket JSON-RPC（engine 协议 v0 + P1 扩展方法表） | 跳转成本 = 一个常驻 Node 进程 + 每次调用一次本地 JSON-RPC 往返 |

### 24.3 权衡与结论

| 维度 | Swift 手写 MCP 层 | 维持 TS 壳（本批选择） |
|---|---|---|
| 消除跳转收益 | 省一个 Node 常驻进程 + 每调用一次本地往返翻译 | 该开销为 MCP 标准形态自带的本地进程间成本；无实测瓶颈（未见性能回归项指向 mcp-shell） |
| 重写成本 | 1702 行 TS 全量移植 + 13 工具契约/错误映射/渲染器/注册表/审计会话逐一 Swift 重写（一次性且非微小——已远超"跨语言成本一次性且微小"的原始估计） | 0（现状） |
| kernel 消费者（C35） | Swift 侧重写 parse 并移除 TS 消费者——kernel 四消费者矩阵中的"GlassPane MCP 壳"列消失，与 R34/§8.5 冲突；v3.0 刚建立的消费者一致性闭环失去一侧 | 保留运行时真实消费者，v3.0 闭环持续有效 |
| MCP 生态 | 官方无 Swift SDK（原判仍成立），协议演进（streamable-http 等）需手写跟进 | TS SDK 生态成熟（原判仍成立） |
| 既有测试资产 | mcp-shell 65 用例（含 v3.0 9 例消费者一致性）作废重写 | 全量保留 |
| "TS 壳 <10%"铁律 | 不适用——该计量口径为 fork 自有代码，mcp-shell 为净室 TS 不计入 | 不影响 |

**结论**：维持 TS 壳为 GlassPane MCP 消费者，Swift 手写 MCP 消息层维持否决并**正式关闭**该优化项（从"列为 P3 优化项"变为"已评估关闭"）。原始依据①（无 Swift SDK）依旧成立；依据②（壳不承载语义）已被 P1–P3 的事实推翻，但推翻的方向是**TS 壳变得更重要**（kernel 消费者 + 报告面 + 注册表），而非更该移除——消除跳转的收益不抵其重写成本与消费者矩阵破坏。

### 24.4 触发重估条件（防"关闭即永冻"，显式守卫）

以下任一条件成立时，重新开项并出具新评估批次（沿用本批评估方法）：

1. **官方 Swift MCP SDK 就绪**：出现官方维护的 Swift MCP SDK 且覆盖 stdio + 工具声明/校验能力——重估"手写协议层"改为"SDK 封装层"成本；
2. **MCP 传输标准演进而 TS SDK 落后**：MCP 传输升级（如 streamable-http / 双向流）成为主流且 mcp-shell 依赖的 TS 生态跟进滞后，导致 agent 侧兼容性受损；
3. **实测跳转瓶颈**：profiling 出现可归因于 mcp-shell 进程/翻译的实测性能或资源瓶颈（如超大 tool list 刷新的启动延迟、长会话内存曲线异常）——以 5.8 R45 的可测性口径做对照实验，禁止凭主观"感觉卡"开项。

### 24.5 与既有面联动

| 关注面 | 影响 |
|---|---|
| mcp-shell 工具面 / 协议层 | 无变更（评估批次） |
| kernel / schema / fixtures | 无变更 |
| daemon socket 方法表 | 无变更 |
| 综述 §16 决策行 | 维持"否决"结论不变；本评估作为复审记录以本规格为准（综述 5.8 为快照不改写，P4 里程碑一致性检查时如需回写按迭代规则处理） |
| R44（零依赖手写 stdio 层） | 维持；"官方 TS SDK 在工具面扩张时重新评估"的观察点随本批记录在案（工具面已达 13，评估权留给专项批次，不在本批夹带） |

---

## 25. 可测性与验收

- 本批为评估/决策批次：交付物为评审事实 + 决策 + 守卫条件，无代码变更，无新增测试用例；既有 engine 234 / mcp-shell 65 / kernel 47 用例为回归基线（本批零改动，无需重跑，P3-A7 基线沿用）。
- 验收口径：评估完整性（§24.2 实测数据逐项呈现）、决策一致性（与综述 §16 判同向、结论显式）、守卫完备性（§24.4 三条件可判真/伪，非泛泛之词）。

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P3-B1 | 原始依据逐条对照 | 否决依据①（无 Swift SDK）、②（壳不承载语义）均对照现状给出结论 | ✓ 已完成（2026-09-18，§24.2/24.3；依据②被事实推翻，方向为"TS 壳更重要"） |
| P3-B2 | 决策落地显式 | 维持 TS 壳 / 关闭优化项，结论白纸黑字入档 | ✓ 已完成（2026-09-18，§24.3 结论段；综述 §16 原判同向不冲突） |
| P3-B3 | 触发重估条件定义 | 三条件可判真/伪（SDK 就绪 / 传输演进 / 实测瓶颈） | ✓ 已完成（2026-09-18，§24.4；含"禁止凭主观开项"的守卫） |
| P3-B4 | 零回归确认 | 本批零代码变更；既有基线（engine 234 / mcp-shell 65 / kernel 47）无回归面 | ✓ 已完成（2026-09-18，规格-only 批次，无文件入库外的代码变更） |

---

## 26. 风险与边界（诚实声明）

1. **评估本身的时效性**：本评估是对 2026-09-18 代码库快照的判定，若未来工具面继续大幅扩张（如 >20 工具）或 MCP 生态剧变，结论可能翻转——翻转入口已显式定义为 §24.4 三守卫条件，不在此透支。
2. **"关闭优化项"不等于"永不考虑"**：本批关闭的是"当前动手实施"这个动作，不是"这个问题不存在"——跳转开销真实存在，只是量级不值得支付重写成本；守卫条件就是为它复苏留的闸门。
3. **未对 TS SDK 切换做评估**：R44 说"官方 TS SDK 在工具面扩张时重新评估"，本批明确把该条拆出（夹带会模糊本批单一决策）——若换 SDK 属独立决策批次，评估权保留。
4. **综述不改写**：综述 5.8 为历史快照，§16 决策行保持原状；本评估的权威记录在 v3.1 规格——这是"实施契约真源在规格、综述只做索引"的既有分工（综述 5.8 使用提示 ①）。若 P4 里程碑一致性检查判定需回写综述，按迭代规则另起综述版本，不在规格中擅自改动。

> **版本结构说明（v3.0 → v3.1）**：v3.1 在 v3.0 的 §1–§23 之后追加 P3 批二范围 §24–§26（Swift 手写 MCP 消息层评估：评估、验收、风险），v3.0 正文 §1–§23 逐字保留不变。综述 §16 决策行"否决（列为 P3 优化项）"由本批兑现复审义务并关闭。

---

## 27. LLDB 桥形态评估（P3 批三新增）

### 27.1 复审对象与原始决策

复审对象：LLDB 桥实现形态二选一——(a) **Python 脚本 + SB API + local socket 回传 Swift daemon**（综述 R30 明确的落地形态，刚性标注）；(b) **编译型 C++ plugin**（LLDB 官方支持的插件形态，综述标注"消除 Python 依赖"）。

综述 §5.6 GUI 调试引擎 R30 全句（原文照录）：

> **LLDB 桥形态（5.6 明确，R30）**：Engine Core（Swift daemon）↔ **LLDB Python 脚本层（SB API）** ↔ local socket 回传。桥的调试扩展以 Python 脚本实现（利用 LLDB 官方脚本接口），编译型 C++ plugin 形态列为后续优化选项（消除 Python 依赖，P3）。

辅证原文（综述"关于 Swift 与技术栈的确认"第 21 行，照录）：

> **LLDB 桥的真实形态**：LLDB 官方脚本层就是 Python（SB API），这是 LLVM 长期设计，所以桥的落地形态是"Python 脚本 + SB API + local socket 回传 Swift daemon"——5.5 文档只写了"Plugin 形式"，这次修订补明确。

综述 §2.5 技术栈表 LLDB 桥行（照录）："LLDB 官方脚本层即 Python，这是 LLVM 的长期设计；C++ plugin 形态保留为后续优化选项"——且该行语言边界标注为**刚性**。

原始表述的关键结构：落地形态=Python（刚性）；C++ plugin=优化选项，复审时点 **P3**。P3 复审义务即在此。本批落地的附加价值：P1 v1.3 权限表已把 developerTools（LLDB attach，Z1–Z4.5 通道）标为"P1 默认不启用"，**桥本身尚未有实现代码**——现在正是"定形先于实现"的最佳时点（在写任何桥代码前定形态，避免返工）。

### 27.2 实测事实（2026-09-18，Grep + wc 实测）

| 事实 | 实测值 | 与形态决策的关系 |
|---|---|---|
| LLDB 桥代码落地程度 | engine 仅 [PermissionStatus.swift](engine/Sources/GlassPaneEngine/PermissionStatus.swift) 第 57–62 行一处权限描述（developerTools："LLDB attach（Z1–Z4.5 探针通道）"，降级文本"探针通道不可用（P1 默认不启用该通道）"）；仓库 grep `lldb\|SBDebugger\|SBAPI` 无其他命中——**Python 桥脚本 0 行、C++ plugin 0 行** | 桥未实现——本批是"定形"而非"迁移"，两种形态都不欠既有代码债；评估不受历史包袱干扰 |
| 规格侧定位 | 综述 §5.6 R30 明确 Python + SB API + local socket；P1 v1.3 权限表 developerTools 行"LLDB attach，P1 默认不启用、TCC 无公开查询 API 如实显示未验证" | 桥归运行时权限面（真机冒烟验收口径，与 AX/CGEvent 同，5.8 R45）——判定性部分入 engine，桥适配层不进单测通道 |
| LLDB 官方脚本层 | Python（SB API）为 LLVM 长期设计的一等脚本接口；LLDB 进程内嵌 Python 运行时 | "消除 Python 依赖"的真实对象是 LLDB **内建能力**（随 Xcode 分发），不是用户侧安装负担——原优化标注的高估面 |
| 桥的调用形态 | LLDB 三模式（Capture/Interactive/Trace）+ 崩溃/假死管线；职责=采集寄存器/调用栈/变量的判定性证据经 local socket 回传 daemon | 低频、非热点路径；与 v3.1 复审的 MCP 跳转（每次工具调用一次往返）不同，无高频往返诉求——性能权重低 |

### 27.3 权衡与结论

| 维度 | 编译型 C++ plugin（优化选项） | Python 脚本 + SB API（本批维持） |
|---|---|---|
| 官方性 | 官方支持的插件形态，但 LLDB 的长期设计是把 Python 作为脚本层（LLVM 决策）；C++ 面向重扩展场景 | LLDB 官方脚本接口即 Python（SB API），文档/示例最全，长期维护承诺明确（原判基点稳固） |
| 编译 / ABI | 需链接 liblldb 与 Xcode 工具链头文件；Xcode 大版本更新存在 ABI/头文件漂移风险；无 GUI 的 CI runner 无法编译此类插件做验证 | 无编译步骤；脚本由 LLDB 内嵌 Python 运行时直接执行，跨 Xcode 版本向后兼容良好 |
| "消除 Python 依赖"真实收益 | 消除的是 LLDB 内建能力（非用户安装负担）；实际收益=去掉"脚本宿主"概念，非成本项移除 | Python 随 LLDB 分发，零安装、零版本管理；"依赖"本已内建 |
| 维护 / 迭代 | 每次修改需重编译 + 重新 load plugin；daemon 联动调试反馈慢 | 改脚本即生效，可在 LLDB 会话内热迭代；与 daemon 侧 Swift 的联动可 live 调（桥协议调试期效率最高） |
| 性能 | SB API C++ 直调，零解释开销 | 每次调用有 Python 解释开销（毫秒级）——桥为低频证据采集（三模式+崩溃管线），非热点路径，开销无关紧要 |
| 仓库现状 | 0 行既有代码；激活=从零搭建 C++ 构建面（含各 Xcode 版本维护成本） | 0 行既有代码；维持=维持设计承诺，不产生增量负担 |

**结论**：维持 Python 脚本 + SB API 形态（综述 R30 原判同向）；C++ plugin 维持"后续优化选项"定性，但本批显式落地：**"P3"并非自动激活时点**。理由：① 官方性基点（LLVM 长期设计）稳固，无翻转迹象；② 桥尚未实现，"维持 Python"零迁移成本，而"现在就选 C++"等于把未编写的桥直接压在最重维护的形态上（编译面 + ABI 漂移 + 无 CI 可测）；③ 桥与 daemon 的联动调优最需要脚本热迭代；④ 性能收益在无瓶颈实测前属于"优化债务前移"。经典表述：维持更轻的实现承诺，把重形态留给真正的触发条件。

### 27.4 触发重估条件（防"P3 未兑现即挂起"，显式守卫）

以下任一条件成立时，重新开项并出具新评估批次（沿用本批评估方法）：

1. **官方脚本层翻转**：LLDB 官方停止维护/废弃 Python 脚本层或 SB API（当前零迹象，LLVM 长期设计；若 Xcode 未来推出自研交互式调试协议并取代脚本层则成立）；
2. **交付形态强约束**：产品交付以"单一二进制、无脚本文件"为硬性验收（如要求无脚本分发、或拆包/审计审查把 Python 脚本列入障碍清单），Python 脚本形态成为准入障碍；
3. **实测采集瓶颈**：桥进入实现批次后的 profiling 表明 SB API 往返或 Python 解释开销成为证据采集热点瓶颈——以对照实验口径认定，禁止凭"感觉慢"开项（桥为低频路径，预期不成立）。

### 27.5 与既有面联动

| 关注面 | 影响 |
|---|---|
| LLDB 桥实现（未落地） | 维持 Python + SB API + local socket 设计承诺；后续实现批次照此定形（严禁跨批本批结论） |
| 探针 SDK / debugserver / socket 协议帧 | 无变更（本批仅形态决策，不触及协议） |
| 权限面（P1 v1.3 developerTools） | 无变更；桥归真机冒烟验收面，判定性核心入 engine 单测通道 |
| 综述 §5.6 / §2.5 | 维持"Python 刚性、C++ 后续优化选项"原判不变；本评估作为复审记录以本规格为准（综述 5.8 为快照不改写，P4 里程碑一致性检查时如需回写按迭代规则处理） |
| 与 v3.1 批二的同构性 | 同为"综述标注 P3 复审"的评估批次：TS 壳（协议翻译面）与 LLDB 桥（脚本层）两个"消除依赖"型优化项的守卫条件结构同构（官方性 / 形态约束 / 实测瓶颈），P4 收尾可统一跟踪 |

---

## 28. 可测性与验收

- 本批为评估/决策批次：交付物为评审事实 + 决策 + 守卫条件，无代码变更，无新增测试用例；既有 engine 234 / mcp-shell 65 / kernel 47 用例为回归基线（本批零改动，无需重跑，P3-A7 基线沿用）。
- 验收口径：评估完整性（§27.2 实测事实逐项呈现——特别是"Python 0 行 / C++ 0 行"的现状盘点与"LLDB 内嵌 Python"的高估面修正）、决策一致性（与综述 §5.6 R30 判同向、结论显式）、守卫完备性（§27.4 三条件可判真/伪，非泛泛之词）。

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P3-C1 | 原始决策原文照录 + 仓库现状盘点 | 综述 R30 全句 + 第 21 行辅证原文照录；代码/规格两侧落地程度如实列出（桥代码 0 行，仅权限描述落地） | ✓ 已完成（2026-09-18，§27.1/27.2） |
| P3-C2 | 权衡表逐维对照 | C++ plugin 与 Python 维持六维对照均给出结论（官方性 / 编译 ABI / Python 依赖面 / 维护迭代 / 性能 / 仓库现状） | ✓ 已完成（2026-09-18，§27.3） |
| P3-C3 | 决策落地显式 | 维持 Python SB API / C++ plugin 不自动激活，结论白纸黑字入档；与综述 §5.6 原判方向不冲突 | ✓ 已完成（2026-09-18，§27.3 结论段；"P3 非激活时点"显式声明） |
| P3-C4 | 触发重估条件定义 | 三条件可判真/伪（官方翻转 / 交付强约束 / 实测瓶颈）；含"禁止凭主观开项"的守卫 | ✓ 已完成（2026-09-18，§27.4） |
| P3-C5 | 零回归确认 | 本批零代码变更；既有基线（engine 234 / mcp-shell 65 / kernel 47）无回归面 | ✓ 已完成（2026-09-18，规格-only 批次，无文件入库外的代码变更） |

---

## 29. 风险与边界（诚实声明）

1. **本批定形的是"设计承诺"而非"已迁移资产"**：桥尚未实现（0 行代码），本批管理的是"后续实现批次照此形态开工"的承诺，不产生任何既有代码的可逆性风险；若实现期间 LLVM/Xcode 生态剧变，翻转入口已显式定义为 §27.4 三守卫条件，不在此透支。
2. **"维持 Python"不是"Python 优先教条"**：维持理由是官方性 + 热迭代 + 交换成本最小，不是 Python 本身更好；若未来实测证明 SB API 高频往返成为瓶颈（守卫 3），C++ 形态仍可换——本批只管理"当前是否动手"，不押注"永不需要"。
3. **未评估 LLDB 深层集成的其他维度**：debugserver 替换、表达式求值前端（Swift REPL / expression formatter 定制）等其他桥内话题不在本批范围，属后续实现批次议题——夹带会模糊本批单一决策，评估权保留给对应批次。
4. **综述不改写**：综述 5.8 为历史快照，§5.6/§2.5 决策行保持原状；本评估的权威记录在 v3.2 规格——这是"实施契约真源在规格、综述只做索引"的既有分工（综述 5.8 使用提示 ①）。若 P4 里程碑一致性检查判定需回写综述，按迭代规则另起综述版本，不在规格中擅自改动。

> **版本结构说明（v3.1 → v3.2）**：v3.2 在 v3.1 的 §1–§26 之后追加 P3 批三范围 §27–§29（LLDB 桥形态评估：评估、验收、风险），v3.1 正文 §1–§26 逐字保留不变。综述 §5.6"编译型 C++ plugin 形态列为后续优化选项（消除 Python 依赖，P3）"由本批兑现复审义务：维持 Python 脚本 + SB API 形态，C++ plugin 不因 P3 自动激活，三条触发重估条件入档（§27.4）。
