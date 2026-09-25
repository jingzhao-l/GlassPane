# GlassPane P0 实施规格

> 文档版本：v1.0
> 依据：GlassPane 5.7 项目综述（R38 walking skeleton、R41–R45 实施级深化）+ GlassPane PRD v1.0（FR-01/03/04/05/17/18 P0 子集）
> 撰写时间：2026-09-14
> 性质：**实施契约真源**——实施中本规格需要变更时，先改规格再改代码，两者不得漂移
> 范围：P0 walking skeleton = 单通道（Z5 纯 AX+像素）× 完整循环（act → observe → 一条断言 → evidence 包 → 诊断报告骨架）+ onboarding 权限引导（命令行形态）+ 失败模式 agent 指引 + kernel Phase A schema 首发包

---

## 1. P0 验收标准（可测口径）

| # | 验收项 | 标准 |
|---|---|---|
| A1 | 完整循环 | 同一被测 app 上：attach → act → observe → assert_element → diagnose → last_evidence 全链路返回结构化结果，evidence 包含 opID/归因等级（soft）/熔断级/信号集 |
| A2 | 诊断分类器 | T0/T1/T2/T3/T6 五类 + INCONCLUSIVE + NO_ANOMALY 全分支单测覆盖（§7.1） |
| A3 | C35 双侧 roundtrip | engine（Swift）与 kernel（TS）测试套件对同一组真值 fixtures 独立 decode→encode→规范化比较通过（§7.2） |
| A4 | 协议边界 | 帧上限/坏 JSON/未知方法/参数校验失败全部返回结构化错误码（§3.4） |
| A5 | 纯逻辑单测 | 协议编解码、分类器、tree digest、pixel diff、evidence codec 在无 GUI 权限环境 100% 通过 |
| A6 | MCP 壳 | initialize 握手、tools/list（6 工具）、tools/call 转发与错误映射（GP_E → 工具级 isError）单测覆盖 |
| A7 | 真机冒烟（人工） | 辅助功能权限授予后，冒烟脚本对真实 app 完成 A1 循环（AX 适配层验收方式，CI 不承载） |

---

## 2. 仓库结构与工具链

```
GlassPane/
├── specs/                          # 设计文档（综述谱系 + PRD + 本规格）
├── engine/                         # Swift Engine Core（SwiftPM）
│   ├── Package.swift               # swift-tools-version 5.9, macOS 13+
│   ├── Sources/GlassPaneEngine/    # 库：协议编解码/evidence/分类器/通道
│   ├── Sources/glasspaned/         # 可执行：daemon 入口
│   └── Tests/GlassPaneEngineTests/ # XCTest
├── kernel/                         # @iterate/kernel（Phase A，暂宿，见 §5.4）
│   ├── package.json
│   ├── schemas/                    # JSON Schema 真源（.json）
│   ├── src/                         # zod 绑定 + 类型 + 错误
│   ├── fixtures/                   # C35 真值 fixtures（双侧共用）
│   └── test/                       # node:test
└── mcp-shell/                      # MCP stdio 壳（TypeScript）
    ├── package.json
    ├── src/
    └── test/
```

**工具链**：Swift 5.9+ 工具链（实测 6.3）；node ≥18（实测 26）；TypeScript 编译 target ES2022、module NodeNext。

**依赖与钉扎**（许可证准入：MIT/Apache-2.0/BSD）：

| 包 | 精确版本 | 用途 | 许可证 |
|---|---|---|---|
| zod | 3.25.76 | kernel TS 绑定 | MIT |
| ajv | 8.20.0 | JSON Schema 真值校验（draft 2020-12） | MIT |
| typescript | 5.9.3 | devDep，类型检查与编译 | Apache-2.0 |
| @types/node | 与 node 26 对应的已发布版本 | devDep，类型 | MIT |

- mcp-shell 运行时依赖：**仅 file:../kernel**（手写 stdio 协议层，5.8 R44 决策）。
- Swift 侧零第三方依赖（POSIX socket + ApplicationServices/CoreGraphics/Foundation）。

**.gitignore**：`.DS_Store`、`node_modules/`、`dist/`、`*.tsbuildinfo`、`.build/`。`package-lock.json` 与 `Package.resolved`（如产生）必须提交（钉扎纪律）。

---

## 3. Engine local socket 协议 v0

### 3.1 传输与帧

- 传输：Unix domain socket（SOCK_STREAM）；
- 默认路径：`$HOME/.glasspane/engine.sock`（可经 `--socket-path` 覆盖；父目录以 0700 创建，socket 文件以 0600 创建，绑定前删除旧文件）；
- 帧：**换行分隔 JSON**（每帧单个 `\n` 结尾；UTF-8）；
- 单帧上限：**4 MiB**（常量 `ENGINE_MAX_FRAME_BYTES`，超出 → `GP_E_PAYLOAD_TOO_LARGE`，连接保持）。

### 3.2 请求帧

```json
{"id": 1, "method": "attach", "params": {"bundleId": "com.example.app"}}
```

- `id`：整数，≥0（响应关联键；非法 → `GP_E_BAD_REQUEST`）；
- `method`：字符串，必须 ∈ 方法白名单（§3.3），否则 `GP_E_METHOD_NOT_FOUND`；
- `params`：JSON 对象，缺省为 `{}`；字段类型不符 → `GP_E_BAD_PARAMS`。

### 3.2.1 响应帧

每个请求帧恰好产生一个响应帧（通知不存在于本协议）：

```json
{"id": 1, "result": {"pid": 12345, "bundleId": "com.example.app", "appName": "Example"}}
{"id": 2, "error": {"code": "GP_E_NOT_ATTACHED", "message": "no app attached", "remedy": "call attach first"}}
```

- 成功：`{"id": <请求 id>, "result": <方法表定义的对象>}`；
- 失败：`{"id": <请求 id 或 null>, "error": {"code": "<GP_E_*>", "message": "<人类可读描述>", "remedy": "<agent 可执行补救指引，与 §3.4 表第三列一致>"}}`；
- `id` 为 null 仅发生在请求帧无法解析出合法 id 时（坏 JSON / id 非法）；
- 响应帧同样受 4 MiB 上限约束（超限时 result 序列化失败 → `GP_E_INTERNAL`，应提示缩小 maxDepth）。

### 3.3 方法表（P0 八方法）

| method | params | 成功 result | 失败错误码 |
|---|---|---|---|
| `hello` | `{}` | `{engine:"glasspaned", version, protocolVersion:"0", pid, capabilities:["act","observe","assert_element","diagnose"]}` | — |
| `attach` | `{bundleId?: string, pid?: integer}`（二选一） | `{pid, bundleId?, appName}` | GP_E_BAD_PARAMS / GP_E_APP_NOT_FOUND / GP_E_AX_UNAVAILABLE |
| `act` | `{selector: {role: string, title?: string, identifier?: string}, action: "press"\|"increment"\|"decrement"\|"showMenu"\|"confirm"\|"cancel"\|"pick", degrade?: boolean（P6 §11 ①：输入窗忙时受理并把污染如实记入 evidence，判定不放松）}` | `{operationId, actConfirmed, axChanged, pixelChanged, latencyMs, evidenceId}` | GP_E_NOT_ATTACHED / GP_E_BAD_PARAMS / GP_E_ACT_FAILED / GP_E_AX_UNAVAILABLE |
| `observe` | `{maxDepth?: integer(1–10, 默认 6), role?: string}` | `{axTree, nodeCount, digest, latencyMs}` | GP_E_NOT_ATTACHED / GP_E_BAD_PARAMS / GP_E_AX_UNAVAILABLE |
| `assert_element` | `{selector, property: "title"\|"value"\|"role"\|"enabled"\|"focused", expected: string\|boolean}` | `{passed, actual, operationId, evidenceId}` | GP_E_NOT_ATTACHED / GP_E_BAD_PARAMS / GP_E_ASSERT_TARGET_NOT_FOUND / GP_E_AX_UNAVAILABLE / GP_E_NO_OPERATION（无最近 op 可复用信号上下文；assert 证据的 signals 复用最近一次 act 的信号） |
| `diagnose` | `{operationId?: string(缺省=最近一次 act)}` | `{class, report: {path, anomaly, evidence, next}}` | GP_E_NOT_ATTACHED / GP_E_BAD_PARAMS / GP_E_NO_OPERATION |
| `last_evidence` | `{operationId?: string}` | `{evidencePack}`（完整 evidence 包 JSON） | GP_E_BAD_PARAMS / GP_E_NO_OPERATION |
| `shutdown` | `{}` | `{bye: true}`（随后 daemon 退出） | — |

**语义细则**：
- `act` 内部时序：存活检查 → AX ping → 捕获前置（树 digest + 窗口像素）→ 执行 AX action → 捕获后置 → 生成 opID → 组装 evidence 包（attribution=soft，Z5 无进程内探针；contaminated=false，C33 检测 P2 进入）→ 存为最近 evidence；
- 树 digest = 深度限制内紧凑序列化（键排序）的 SHA-256 前 16 字节 hex；
- `assert_element` 与 `diagnose` 复用最近 op 的信号上下文生成独立 evidence 条目（assertion 字段/诊断报告字段）。

### 3.4 GP_E 错误码表

| 错误码 | 含义 | agent 补救指引（失败模式指引，R36） |
|---|---|---|
| GP_E_BAD_REQUEST | 帧不是合法 JSON / id 非法 | 修正 JSON 后重发 |
| GP_E_PAYLOAD_TOO_LARGE | 单帧 >4 MiB | 缩小 maxDepth 或 selector 范围 |
| GP_E_METHOD_NOT_FOUND | 方法不在白名单 | 参见协议方法表 |
| GP_E_BAD_PARAMS | 参数缺失/类型不符/范围越界 | 按方法表修正参数 |
| GP_E_NOT_ATTACHED | 未 attach 即 act/observe/assert/diagnose | 先调用 attach |
| GP_E_APP_NOT_FOUND | bundleId/pid 未找到运行中 app | 确认 app 已启动 |
| GP_E_AX_UNAVAILABLE | AX 调用失败（典型=辅助功能权限未授予） | 运行 onboarding：`glasspaned --grant-accessibility`（打开系统设置辅助功能面板） |
| GP_E_ACT_FAILED | AX action 执行失败（元素无该 action/拒绝） | 换 action 或核对 selector |
| GP_E_ASSERT_TARGET_NOT_FOUND | 断言目标元素未找到 | 核对 selector 或先 observe |
| GP_E_NO_OPERATION | 无可诊断/可取的操作记录 | 先执行 act 或 assert_element |
| GP_E_INTERNAL | 引擎内部错误 | 查看 daemon 日志后重试 |

### 3.5 安全边界

- socket 权限 0600 + 父目录 0700（仅本用户可连）；
- 方法白名单 + 参数逐字段类型/范围校验（selector 长度 ≤512 字符，maxDepth 1–10）；
- 无遥测、无网络出口（daemon 仅本机 socket 监听）；
- daemon 日志输出到 stderr（`--verbose` 控制），不记录像素原始数据（仅 digest/metrics）。

---

## 4. evidence 包 schema v0.1-draft（C35 真源）

JSON Schema 真源：`kernel/schemas/evidence-pack.schema.json`（$id: `https://schemas.iterate.dev/evidence-pack-0.1.json`（2026-09-21 冻结定版））。生命周期：**draft**（Phase A）→ C2 spike 真实 app 数据回填修订 → **v0.1 冻结已执行（2026-09-21，Phase B 入口第 0 步；`glasspane.evidence/0.1`，读侧保留 draft 兼容，回填明细见 spike/results.md「Phase B 入口补数轮」）**。

### 4.1 字段表

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| schemaVersion | string | ✓ | const `"glasspane.evidence/0.1"`（冻结前历史值 `0.1-draft` 只读兼容） |
| operationId | string | ✓ | pattern `^op_[0-9A-HJKMNP-TV-Z]{26}$`（Crockford base32，时间戳前 10 位+随机 16 位） |
| createdAt | string | ✓ | ISO-8601 UTC（`yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`，pattern 校验） |
| attribution | object | ✓ | `{level: enum[soft,strong,weak], contaminated: boolean}`，两字段均必填 |
| circuitBreaker | object | ✓ | `{level: integer 0–3, reason?: string}`；level 必填。P0 语义：0 正常/1 单通道降级/2 act 失败通道存活/3 通道故障 |
| signals | object | ✓ | 见 4.2 |
| assertion | object \| null | — | `{kind: const "element_property", selector, property: enum[title,value,role,enabled,focused], expected, actual, passed: boolean}` |
| diagnosis | object \| null | — | `{class: enum[T0,T1,T2,T3,T4,T5,T6,T7,T8,T9,NO_ANOMALY,INCONCLUSIVE], report: {path, anomaly, evidence, next}}` |

### 4.2 signals（五路信号 + 辅助信号）

| 字段 | P0 | 类型 |
|---|---|---|
| act | 必填 | `{selector, action, actConfirmed: boolean}` |
| axEvent | 可选 | `{treeDigestBefore, treeDigestAfter, nodeCount, axChanged: boolean, latencyMs: number ≥0}` |
| handlerProbe | null | Z5 缺席（显式 null，诚实边界） |
| stateDiff | null | Z5 缺席 |
| pixelDiff | 可选 | `{changedPixelRatio: 0–1, bounds: {x,y,width,height}\|null, windowId: integer}` |
| responsiveness | 可选 | `{responsive: boolean, pingMs: number ≥0}` |
| crash | 可选 | `{processAliveBefore, processAliveAfter: boolean}` |

全 schema `additionalProperties: false`。

### 4.3 双语言绑定（C35）

- **真源**：JSON Schema（draft 2020-12）；
- **TS 绑定**：zod schema 镜像（`kernel/src/bindings.ts`），类型由 zod 推导导出；
- **Swift 绑定**：Codable 结构镜像（`engine/Sources/GlassPaneEngine/EvidencePack.swift`）；
- **一致性机制**：`kernel/fixtures/*.json` 为真值集——两侧测试套件各自执行 load → validate（ajv）→ decode → encode → canonical JSON（键排序、无空白）比较。任何字段变更必须双侧同步改 fixtures。

---

## 5. kernel Phase A 包规格

### 5.1 包标识

`@iterate/kernel`，version `0.1.0-draft.1`，`private: true`（暂不发布 registry；Phase B 迁入 iterate monorepo 后按其发布策略，5.8 R43）。

### 5.2 导出面（P0 首发）

```typescript
// schema 真源（JSON 对象与 $id）
EVIDENCE_PACK_SCHEMA_ID, EVIDENCE_PACK_JSON_SCHEMA
DECISION_LOG_ENTRY_SCHEMA_ID, DECISION_LOG_ENTRY_JSON_SCHEMA
RECIPE_CONFIG_SCHEMA_ID, RECIPE_CONFIG_JSON_SCHEMA
// zod 绑定与类型
EvidencePackSchema, EvidencePack, AttributionLevel, CircuitBreakerLevel
DecisionLogEntrySchema, DecisionLogEntry
RecipeConfigSchema, RecipeConfig
// 解析 API（zod，抛 KernelSchemaError）
parseEvidencePack(input: unknown): EvidencePack
parseDecisionLogEntry(input: unknown): DecisionLogEntry
parseRecipeConfig(input: unknown): RecipeConfig
// 错误
KernelSchemaError { code: "KERNEL_E_SCHEMA", issues: [{path, message}] }
```

### 5.3 附带 schema（Phase A 首发范围）

- `decision-log-entry.schema.json`：`{entryId: ^dl_[0-9A-HJKMNP-TV-Z]{26}$, sequence: integer ≥0, prevEntryHash: ^[0-9a-f]{64}$|^"$（创世条目空串）, operationId?（同 evidence pattern）, summary: string ≤2048, outcome: enum[pass,fail,blocked,inconclusive], createdAt}`——opID↔decision 单向哈希链的条目层契约（audit chain 映射的 Phase A 部分）；
- `recipe-config.schema.json`：`{schemaVersion: const "glasspane.recipe/0.1-draft", name: string ≤256, steps: array 1–64 of {kind: enum[act,observe,assert,diagnose], params: object}}`——配方/iterate.config.yaml 公共校验器的 P0 落点（R35/§8.5）。

### 5.4 宿置与迁移

暂宿 GlassPane 仓库 `kernel/`（R43）。mcp-shell 经 `file:../kernel` 消费（模拟未来 npm 依赖形态）。迁入 iterate monorepo 的触发条件：Phase B 两壳消费前；迁移保留 git 历史（filter-repo/subtree，届时按 iterate monorepo 结构选定）。

**迁移执行记录（2026-09-22，用户拍板：主仓库 + subtree）**：目标 = `jingzhao-l/iterate-skill` 主仓库顶层 `kernel/`，**主仓库自有目录，不是第四个 subtree 子仓库**——kernel 是生态契约层（两壳 + GlassPane 三方共费），挂任一消费者仓库都会让其余方跨仓依赖；harness/plugin 用独立子仓是因为它们各自独立演进发布，kernel 契约级低频变更不值得多养一仓；将来若需独立发 `@iterate/kernel` npm 包，再对主仓内 `kernel/` 做一次 subtree split 即可升格，历史不丢。方式 = `git subtree split --prefix=kernel`（6 笔史）→ iterate-skill 侧 `git subtree add`（不 squash，保历史）。**迁移后归属约定**：iterate-skill 为 kernel 唯一编辑入口（canonical）；GlassPane `kernel/` 降为镜像，经 `tools/sync-kernel.sh` 单向同步，提交信息固定 `sync(kernel): iterate-skill@<sha>` 保溯源；两侧 CI 各自继续跑自身测试面（C35 双绑定不因迁移放松）。

**镜像漂移事故与同步守卫（2026-09-25）**：迁移后第三天实测镜像**超前** canonical——09-22 至 09-24 之间 evidence schema 冻结（draft → v0.1）与 A-13 读侧兼容（`parseEvidencePackRead`、`LEGACY_EVIDENCE_SCHEMA_VERSION`）只写在镜像侧，从未回流。此时按 §5.4 的标准命令同步会删掉 4 个 fixture、回退 `src/parse.ts`/`src/index.ts`，打断 `mcp-shell/src/tools.ts` 的 import，且 `check-version.mjs` 15 位点必红。**处置**：(a) 内容回流 `iterate-skill`（本地提交 `d893045`，canonical `npm test` 59/59），归属方向恢复为 canonical ≥ 镜像；(b) `tools/sync-kernel.sh` 由裸 rsync 改为三道守卫，且**每条的拒绝分支都实测可执行、失败不落盘**：① 删除守卫（干跑列出会被删的 mirror-only 路径即 exit 1，remedy 先给"回流"再给 `--allow-deletions`）；② 消费者契约守卫（断言 `mcp-shell` 实际 import 的 4 个 `parse*` 导出存在于 canonical，缺则点名会断的消费者并拒绝）——**版本号不参与门禁**：canonical 保留自身发布节奏（当前 `0.1.0-draft.1`），镜像落地后由 `scripts/set-version.mjs` 统一压回本仓版本线，拿版本相等当闸会拒掉合法同步而保护不了任何东西；③ 后验自卷守卫（check-version + build + kernel/mcp-shell 两套件，红则 `git checkout -- kernel && git clean -fdq kernel` 并明确宣告已回滚）。**教训入档**：单向镜像同步的前提是"方向唯一"这句话有人检查；没有删除守卫时，它连续三天为假，而仓库里所有关于 kernel 归属的记载都仍然自称成立。

---

## 6. MCP 工具契约（P0 子集，工具面 A）

### 6.1 协议层（手写，R44）

- 传输：stdio（每行一个 JSON-RPC 2.0 消息，UTF-8，单帧上限 4 MiB）；
- MCP 版本：`2025-06-18`（initialize 应答回显客户端版本，不识别时回落本常量）；
- 实现方法：`initialize`（capabilities: `{tools: {listChanged: false}}`，serverInfo `{name:"glasspane-mcp", version:"0.1.0"}`）、`notifications/initialized`（通知，无应答）、`ping`（→ `{}`）、`tools/list`、`tools/call`；
- JSON-RPC 错误码：`-32700` parse error / `-32600` invalid request（含 batch、非对象帧）/ `-32601` method not found / `-32602` invalid params / `-32603` internal；
- 通知（无 `id`）不产生应答；带 `id` 的未知方法 → `-32601`。

### 6.2 工具表（六工具）

| 工具 | inputSchema 要点 | 成功返回（content[0].text = JSON） | 失败（isError: true） |
|---|---|---|---|
| gp_attach | `{bundleId?: string, pid?: number}` | attach result | GP_E_* 原码+补救指引文本 |
| gp_observe | `{maxDepth?: number, role?: string}` | observe result（axTree 按原样透传） | 同上 |
| gp_act | `{selector: {role, title?, identifier?}, action: enum, degrade?: boolean}` | act result | 同上 |
| gp_assert_element | `{selector, property: enum, expected}` | assert result | 同上 |
| gp_diagnose | `{operationId?: string}` | diagnose result | 同上 |
| gp_last_evidence | `{operationId?: string}` | evidence pack | 同上 |

- `tools/call` 的 `arguments` 先经 inputSchema 校验（zod，kernel 依赖复用），不符 → `isError: true` + `GP_E_BAD_PARAMS` 语义文本；
- engine 连接失败（socket 不存在/超时 10s）→ `isError: true`，文本含 `GP_E_ENGINE_UNREACHABLE` 与启动指引（`glasspaned --socket-path ...`）；
- 错误文本格式：`GP_E_XXX: message | remedy: <补救指引>`（agent 可解析前缀）。

### 6.3 与 kernel 的消费关系（Phase A 形态）

mcp-shell `file:../kernel` 依赖：工具入参校验复用 kernel zod（selector 结构）+ evidence 包透传时 `parseEvidencePack` 强校验（工具返回前失败即 isError）——**这是 kernel 首个真实消费者，为 Phase B 两壳消费先行验证包形态**（不改 mcp-shell 的协议语义）。

---

## 7. 测试与验收

### 7.1 纯逻辑单测矩阵（无 GUI 权限可跑，CI 兼容）

| 套件 | 覆盖 |
|---|---|
| kernel（node:test） | 三 schema 各 ≥1 正例 ajv+zod 双通过；负例（缺必填/非法枚举/多余属性/opId 模式破坏）双侧拒绝；roundtrip 规范化比较；决策链哈希格式；配方 steps 边界（0/1/64/65） |
| engine（XCTest） | 协议编解码（正例/坏 JSON/超帧/未知方法/负 id）；分类器全分支（T0/T1/T2/T3/T6/INCONCLUSIVE/NO_ANOMALY + 组合边界）；opID 格式/唯一性；tree digest 稳定性；pixel diff（合成位图：全同/象限差异/容差边界）；evidence Codable roundtrip vs kernel fixtures |
| mcp-shell（node:test） | initialize 握手；tools/list 数量与名称；tools/call 转发（fake engine transport）；GP_E → isError 映射；engine 不可达路径；坏 JSON → -32700；非对象帧 → -32600 |

### 7.2 C35 双侧 roundtrip 设计

fixtures 位于 `kernel/fixtures/`（`evidence-pack.ok-01.json`、`evidence-pack.ok-02.json`、`decision-log-entry.ok-01.json`、`recipe-config.ok-01.json`）：

- kernel 侧：fixture → ajv validate → zod parse → canonical stringify → 与 fixture canonical 形式比较；
- engine 侧：fixture → Codable decode → encode → canonical JSON（键排序）比较；
- 两侧共用同一真值集 ⇒ 跨语言 schema 一致性持续成立（CI 中两侧套件同时跑即构成完整 C35 断言；P0 达标口径=双侧 fixtures roundtrip 100% 通过）。

### 7.3 真机冒烟（A7，人工/自建 runner）

`engine/smoke.md` 流程：启动 daemon（verbose）→ 运行中 app attach → act(press) → observe → assert → diagnose → last_evidence 断言字段完整性。前置：系统设置授予 daemon 终端辅助功能权限。

---

## 8. 安全与边界（汇总）

1. 输入校验：协议层（§3.5）与工具层（§6.2）双层；selector 字符长度与结构受限；无路径/命令注入面（不存在文件路径参数）；
2. 权限最小化：P0 仅申请辅助功能（AX）；屏幕录制权限仅在像素捕获被启用时按需请求（拒绝 → pixelDiff 降级为 null，熔断级=1，T6 判定退化为 INCONCLUSIVE——R36 降级形态的 P0 落点）；
3. 本地数据：evidence 仅内存态保留最近条目（P0 不落盘，规避敏感数据明文存储问题）；日志不含像素原始数据；
4. 无遥测：daemon 与壳均无网络出口。

---

## 9. 降级与诚实边界（P0）

| 场景 | 行为 |
|---|---|
| handler/state 信号缺失（Z5） | evidence 中显式 null；T4/T5/T7/T8/T9 → INCONCLUSIVE（requires-probe-signals） |
| 屏幕录制权限拒绝 | pixelDiff=null + circuitBreaker.level=1；T3 判定仍可用（树+操作确认）；T6 退化 INCONCLUSIVE |
| AX 权限缺失 | GP_E_AX_UNAVAILABLE + 补救指引（§3.4） |
| 像素捕获 API 弃用（CGWindowListCreateImage） | P0 接受弃用警告（§16 决策）；SCK 迁移 P1 |
| 并发污染 | P0 无 CGEvent 监控（C33 属 P2），contaminated 恒为 false——schema 字段先行，语义随 P2 填充 |

---

## 10. 版本与迁移策略

- socket 协议：`protocolVersion: "0"`（hello 返回）；v0 内新增方法=非破坏；改既有方法签名=升 v1 并双版本期；
- schema：draft 阶段允许破坏性修订（fixtures 同步改）；v0.1 冻结后 semver（R42/§8.5）；
- mcp-shell serverInfo.version 从 0.1.0 起随 P0 交付物走。
