# GlassPane 5.7 —— 项目综述文档

> 来源：ChatGLM 对话记录（https://chatglm.cn/share/FFb2jssD）
> 提取时间：2026-09-14
> 文档版本：v1.0（基于 GlassPane 5.6 综述复制迭代修订）
> 迭代时间：2026-09-14
> 前身：5.6（13 项审查修订 R19–R31）；5.5（18 项审查修订 R1–R18）
>
> **5.6 → 5.7：功能设计完善度补全 + iterate 生态共享内核集成（R32–R40），不改变架构形态与战略结论**

---

## 关于 Swift 与技术栈的确认

**需要用 Swift，且是刚性的**，但只用在"眼和手"这一层。你的直觉（agent 生态不是 Swift）是对的，而 GlassPane 恰恰不是 agent——它是系统层运行时验证工具，与 Xcode Instruments、Accessibility Inspector 同类，这一层本来就是 Swift/Objective-C 的领地。硬性绑定点：

1. **探针 SDK 必须进被测进程** ——被测 app 是 SwiftUI/AppKit，要在 handler 执行上下文插桩就必须能操作 Swift `TaskLocal`（跨 await 传播是 Swift 并发任务树语义）、扩展 `@Observable` 宏（展开后 get/set 都要经 ObservationRegistrar 注册，这正是 R4 改口"低开销"而非"零开销"的依据）、KVO 通知、`MTLCaptureManager`。其他语言无法触碰这些运行时。

2. **daemon 侧用 Swift 的收益**：与探针共享类型定义（evidence 格式、Z 矩阵），AX API 虽是 C API（Rust/Python 也能调，社区已有 macos-accessibility-client 等方案），但同语言可消除 FFI 边界。

3. **LLDB 桥的真实形态**：LLDB 官方脚本层就是 Python（SB API），这是 LLVM 长期设计，所以桥的落地形态是"Python 脚本 + SB API + local socket 回传 Swift daemon"——5.5 文档只写了"Plugin 形式"，这次修订补明确。

**MCP 面和 Harness 面的技术栈在 5.5 里确实没写死，这是一个真实缺口**（你的追问命中了）。事实是：MCP 是 JSON-RPC 协议、语言无关，官方 SDK 覆盖 TypeScript/Python/Java/Kotlin/C#/Go，唯独没有官方 Swift SDK。opencode 上游是 TypeScript 写的，fork 即被 TS 锁定。本次 5.6 修订将技术栈分层明确为：**Engine Core+探针=Swift（刚性）；MCP server 壳=TypeScript（推荐，社区 SDK 成熟，与 Claude Code/Cursor 生态对齐）；Harness 壳=TypeScript（fork 自带）；LLDB 桥=Python 脚本**。这与"共享内核铁律"（两工具面合计 <10% 代码量）不冲突，反而更严谨——TS 壳只做协议翻译，验证语义全部留在 Swift daemon。

---

## 0. 修订摘要

### 5.6 修订（R19–R31，保留）

| # | 修订 | 要点 |
|---|---|---|
| R19 | **技术栈总览新增** | 新增 §2.5：四层技术栈与语言边界明确化（Swift 刚性层 / TS 协议壳层 / Python 调试桥层） |
| R20 | AX 入口链路归因强度明示 | §5.3：因果链第一环（agent 调用点→AX 事件入口）声明为进程级插槽**软归属**，TaskLocal 强归因仅覆盖 handler 内后续 spawn 的 Task 树 |
| R21 | 并发归因污染防护 | §5.3：agent 操作与用户真实操作并发场景，新增"输入空闲检测+归因污染标注"，AX 会话锁扩展为"操作权互斥"；新增断言 **C33** |
| R22 | 可达性阈值修正 | §5.10：44×44pt（iOS 标准）修正为 **28×28pt**（macOS HIG 指针点击目标） |
| R23 | 无头 CI 能力边界修正 | §5.13：无登录窗口 runner 上 **AX 查询不可用**（AXUIElement 依赖 GUI 会话），该形态可用面修正为"build+静态断言+文件系统级断言" |
| R24 | 八分类增加 T9 | §5.3：新增"渐进性劣化"类（内存/句柄泄漏导致的缓慢退化），判定信号=主线程 ping+内存曲线斜率+句柄计数 |
| R25 | 档 1 恢复验收指标 | §5.7/P1：补档 1 恢复保真率与恢复时间硬指标；新增断言 **C34** |
| R26 | P-1 spike 增加真实 app 对照 | §10.1：operationID 覆盖率与五线索失效率两个 spike 各增加一个真实开源 SwiftUI 项目对照组 |
| R27 | 评审员一致性前置门槛 | §7.5：评审员间自身 kappa ≥0.6 为评模前置条件，防止评审员噪声误读为模型噪声 |
| R28 | Expert 训练数据规模推演 | §7.5：给出 12 月达标所需标注量级估算（~1500 张）与可行性论证 |
| R29 | 宏插桩构建期开销 spike | §10.1：Swift Macros 有 2x 构建时间膨胀的社区报告，P-1 增加插桩对目标 app 构建时间影响验证 |
| R30 | LLDB 桥形态明确 | §5.6：明确为 Python 脚本 + SB API + local socket（LLDB 官方脚本层即 Python） |
| R31 | CI 卖点边界对齐 | §5.13：金丝雀回归网在 CI 模拟器形态的验收基准明确化，"可进 CI"承诺按四形态分级表述 |

### 5.7 修订（R32–R40，新增）

| # | 修订 | 要点 |
|---|---|---|
| R32 | **iterate 生态共享内核纳入架构** | 新增 §8.5：@iterate/kernel 共享内核层（fork→kernel 单向依赖铁律、能进/进不了清单、Phase A–D 门控、双向集成场景）；§2.5/§8.2/C28 联动修订；fork 层融合结构性否决入 §16 存档 |
| R33 | **证据 schema 双语言契约** | JSON Schema 为唯一真源，Swift Codable 与 TS zod 双绑定 + roundtrip 契约测试；新增断言 **C35**——补上"evidence 产自 Swift daemon、kernel 消费在 TS"的跨语言契约缺口 |
| R34 | **C28 扩展为 kernel 消费者一致性测试** | 由 MCP 契约一致性扩展为四消费者矩阵（iterate-harness / iterate-plugin / iterate 第三个项目 / GlassPane Harness / GlassPane MCP 壳），失败三分类归因（kernel API / fork 适配胶水 / 上游） |
| R35 | **配方分发与版本管理** | §5.1 增补：三源分发（内置官方/项目自定义/导入）+ kernel 公共校验器 + 语义版本与迁移策略 |
| R36 | **开发者支持面新增** | 新增 §5.14：evidence 审查 UX、首次运行 onboarding 与权限引导（含输入监控等 TCC 权限清单与拒绝降级形态）、失败模式 agent 指引、多项目与资产库组织 |
| R37 | **评审员池对冲** | §7.5 增补：3 人池轮换、P1 后从早期用户招募、全异步审核队列、Go/No-Go 口径调整为"池内在册活跃 ≥2 名" |
| R38 | **P0 walking skeleton 原则** | §10.2 增补：P0 验收显式定义为最薄垂直切片（单通道×完整循环），防单人带宽下 P0 范围膨胀 |
| R39 | **文档自包含性声明** | 综述/PRD 分工：PRD v1.0 作为自包含产品规格派生自本综述；综述保留 5.5 存档引用谱系 |
| R40 | **双向集成场景清单** | §8.5：iterate↔GlassPane 双向语义级互通的产品级场景定义（invariant 触发重验、evidence 入决策日志、维度感知压缩、AE provider 契约、配方挂接复核） |

---

## 1. 项目概述

**一句话定位**：GlassPane 是给 AI Agent 的运行时验证引擎——一份 Swift Engine Core（眼和手），两个工具面（MCP 协议面 + fork opencode 的原生面）把判定性证据送进用户自配的大模型（脑），外加一个从校准闭环训练出来的审美专科专家。脑永远在用户侧，引擎和校准资产永远只有一份。

**核心价值**：补全 AI Agent 在 macOS 应用开发中的运行时验证闭环。Agent 已能完成"写码→静态审查→写静态测试"，但"构建→到达状态→交互→观察→诊断→修复→重验"的运行时半场要么依赖低效的截屏→视觉理解→坐标操作范式，要么根本缺失。GlassPane 补的是这一半场。

---

## 2. 版本演进

| 版本 | 里程碑 |
|---|---|
| 1.0–5.3 | （略，见 5.5 存档）双通道原型→治理补全→MCP 定位修订 |
| 5.4 | 双线战略版（共享内核+双工具面、fork opencode、微调对象改为 Aesthetic Expert） |
| 5.5 | 审查迭代版（operationID 机制修正、指标操作化、P-1 spike、CI/权限补全） |
| 5.6 | 技术栈明确化 + 工程可行性修复（技术栈分层、并发归因防护、macOS HIG 修正、无头 CI 边界、T9/档 1 验收补全） |
| **5.7** | **功能设计完善度 + iterate 生态共享内核集成（开发者支持面 §5.14、配方分发 R35、评审员池 R37、walking skeleton R38、自包含性 R39、kernel 层 §8.5/C35/C28 扩展）** |

**5.5 → 5.6 的变更性质**：全部为技术栈明确化与工程修复，无架构级变更。5.5 确认的三条架构铁律与战略结论原样保留。

**5.6 → 5.7 的变更性质**：功能设计完善度补全 + iterate 生态共享内核集成（新章 §8.5），无架构级变更；三条架构铁律与战略结论原样保留。Swift Engine Core 的"判定性验证逻辑 100% 位于 Swift"铁律在 kernel 集成下显式重申（§8.5 精确边界）。

---

## 2.5 技术栈总览与语言边界（5.6 新增）

GlassPane 是跨语言系统。**语言选择由被测对象与系统 API 决定，不由团队偏好决定**：

| 层 | 语言 | 刚性/选择 | 理由 |
|---|---|---|---|
| 探针 SDK（进被测进程） | **Swift**（+Objective-C runtime 交互） | **刚性** | 须操作 Swift `TaskLocal`（任务树内跨 await 传播是 Swift 并发语义）、扩展 `@Observable` 宏、KVC/willChangeValueForKey 通知、`MTLCaptureManager`；其他语言无法访问这些运行时 |
| Engine Core（Swift daemon） | **Swift** | 刚性（策略性） | 与探针共享类型定义（evidence 格式、Z 矩阵、保真度声明），消除 FFI 边界；AX API 为 C API，Swift 原生桥接 |
| LLDB 桥 | **Python**（SB API）+ local socket | **刚性** | LLDB 官方脚本层即 Python，这是 LLVM 的长期设计；C++ plugin 形态保留为后续优化选项 |
| 工具面 A：MCP Server 壳 | **TypeScript**（推荐） | 选择 | MCP 是 JSON-RPC 协议、语言无关；官方 SDK 覆盖 TS/Python/Java/Kotlin/C#/Go，无官方 Swift SDK。TS 壳仅做协议翻译（stdio/HTTP ↔ local socket），验证语义全部留在 Swift daemon，符合"薄适配层 <10%"铁律。备选：Swift 手写 MCP 消息层（消除进程跳转，列为 P3 优化项） |
| 工具面 B：Harness 壳 | **TypeScript** | 刚性（上游锁定） | fork 自 opencode（TS 项目），Patch 集五个薄模块全部为 TS；被上游技术栈锁定是 fork 税的一部分，由四约束控制 |
| Aesthetic Expert 训练管线 | **Python**（PyTorch/PEFT 生态） | 刚性（生态） | LoRA/多模态基座微调的工具链生态在 Python；训练数据（校准资产）以模型无关格式存储于 Engine Core 资产库，符合资产中立铁律 |
| 配方（recipe） | **声明式 YAML** | — | 无解释器（脑在外铁律），agent 载入即得工作流 |
| **共享内核 @iterate/kernel（消费侧）** | **TypeScript**（自研，iterate monorepo，npm 依赖） | 选择（战略，5.7 R32） | GlassPane 两个 TS 壳与 iterate 生态项目共同消费的语义内核（schema/审计链映射/事务原语/公共校验器），定位与门控见 §8.5。**npm 依赖不占 Patch 集名额，不计入壳代码量预算（以 fork 自有代码计）** |

**与"脑在外"铁律的关系**：TS 壳与 Python 训练管线均不承载验证推理——MCP 壳只翻译协议，训练管线只消费资产库的结构化标注向量。**判定性验证逻辑 100% 位于 Swift Engine Core**。

**与用户认知的对照**：agent 生态（Claude Code/Cursor/opencode）确实以 TS/Python 为主——这正是选择 TS 做 MCP 壳与 Harness 壳的原因；而系统层运行时工具（Instruments/Accessibility Inspector/调试器集成）历史上就是 Swift/ObjC 领地——这正是探针与 daemon 刚性用 Swift 的原因。GlassPane 横跨两层，故为跨语言架构。

**（5.7 R32）kernel 行与两条铁律的关系**：@iterate/kernel 是 TS 语义层（schema/审计链映射/编排原语），不承载验证推理——判定性逻辑仍在 Swift Engine Core；"TS 壳 <10%"铁律的计量口径为 fork 自有代码，kernel 作为依赖不计入。Swift 侧与 kernel 的对齐方式不是把 Swift 代码搬入 kernel，而是 **JSON Schema 契约 + Swift Codable 双绑定**（C35，见 §8.5）。

---

## 3. 系统定位与用户画像

（与 5.5 一致：macOS 应用开发者（SwiftUI/AppKit 为主），使用 AI Agent 全栈开发；问题本质=开发者能力（工具箱问题，可机器化）+ 用户感受（Oracle 问题，压缩不消灭）；四支柱不变。）

---

## 4. 核心架构：双线战略

### 4.1 架构总览

```
AI Agent 大模型（脑—永远是用户自配的模型）
Claude / GPT / 本地模型 / 任意 API
 │
┌───────┴────────────────────────────────────┐
│ 工具面 A: MCP 协议      工具面 B: Native 直连 │
│ （TS 壳，stdio/HTTP）   （fork opencode，TS） │
└───────┬────────────────────────────────────┘
 ▼
┌─────────────────────────────────────────────┐
│ GlassPane Engine Core（眼和手——只有一份）    │
│ 感知-行动核心 / LLDB 桥（Python+SB API）/ 探针 SDK │
│ 时间旅行 / 断言引擎 / Fuzzing / 资产库        │
└───────────────────┬─────────────────────────┘
 ▼ 单次结构化判定（传感器调用）
┌─────────────────────────────────────────────┐
│ Aesthetic Expert（审美专科—微调服务，Python 训练管线）│
└─────────────────────────────────────────────┘
```

### 4.2 三条架构铁律

（与 5.5 一致：共享内核/脑在外/资产中立。）

### 4.3 路线选择决策依据

（与 5.5 一致：MCP 为体、fork opencode 为用、微调对象改判。5.6 补充：fork opencode 的上游技术栈锁定为 TS，已纳入 §2.5 与 §8.2 说明。）

### 4.4 竞争时窗声明

（与 5.5 一致。）

---

## 5. 核心功能模块

### 5.1 MCP 工具契约（工具面 A）

（六类原语与配方体系与 5.5 一致。5.6 补充：MCP Server 壳实现语言为 TypeScript，仅做协议翻译，见 §2.5。）

**配方分发与版本管理（5.7 新增，R35）**：配方来源三通道——**内置官方配方**（随 GlassPane 版本发布，语义版本随引擎走）、**项目自定义配方**（被测 app repo 内 YAML，进版本控制，随项目迁移）、**导入配方**（文件/URL，导入时必须经 kernel 公共校验器校验，iterate.config.yaml 与 GlassPane recipe 共用同一校验逻辑，见 §8.5）。配方 schema 由 kernel 公共校验器统一校验；引擎大版本升级时旧配方经兼容性检查自动迁移，或显式拒绝并给出迁移提示——**agent 载入失败必须可自诊断（结构化错误码 + 可执行补救步骤），不允许静默半载入**。

### 5.2 感知-行动核心（黑盒通道）

（与 5.5 一致：AX 树紧凑序列化、五线索引加权、操作即 diff 协议、三级降级链、工作记忆外置、诚实边界。）

### 5.3 因果链与九分类诊断（5.6 修订）

**五路信号 + operationID 归因**：action → AX 事件 → handler 探针（#fileID:#line）→ state diff → 像素 diff

**operationID 机制（5.5 重写，5.6 归因强度明示）**：

- daemon 在 `act()` 时生成唯一 operationID；
- 经探针 SDK 的运行时上下文插槽写入被测进程：Swift concurrency 路径用 `TaskLocal`，闭包回调路径用进程级插槽（双写）；
- **归因强度链路声明（5.6 新增，R20）**：
    - **链路第 0 环（agent 调用点 → AX 事件入口）**：AX 事件经主线程 runloop 分发进入 app，与 agent 调用点不在同一 Task 树内，TaskLocal 无法跨越——**该环必然依赖进程级插槽，属软归属**；
    - **链路第 1+ 环（handler 内及其 spawn 的 Task 树）**：`TaskLocal` 传播命中 → **强归因**；
    - 异步回调（DispatchQueue/asyncAfter/Combine）脱离 TaskLocal 后插槽失效 → **弱归因**（时间窗启发式）；
    - evidence 包中每条归因显式标注强/弱等级。
- state diff 归因：时间窗 + 探针关联软归属；后台噪声用"变更模块是否在本次 opID 探针闭合集合内"过滤。

**并发归因污染防护（5.6 新增，R21）**：

- **问题**：agent 操作与用户真实操作并发时，进程级单值插槽互相覆盖，归因被污染；
- **机制**：AX 会话锁扩展为"操作权互斥"——daemon 在持有操作权期间监控 CGEvent 全局输入流，若检测到非 agent 来源的真实输入（键盘/鼠标），则：通知 agent 暂停（默认，避免竞态）；或 agent 选择继续但本次 opID 的全部归因降级为弱归因并在 evidence 包标注 `contaminated: true`；
- 断言 **C33（5.6 新增）**：并发场景下归因污染检出率 >95%，误杀率（用户无操作时误判污染）<5%。

**九分类诊断表（5.6 增加 T9，R24）**：

| 步骤 | 症状 | 进入条件 | handler | state | AX | 像素 | 判定 |
|---|---|---|---|---|---|---|---|
| T0 | 通道故障 | act 无回执/降级链全失败 | — | — | — | — | 引擎通道故障 |
| T1 | 崩溃 | ∅ | 崩溃帧 | 尽力快照 | 最后树 | 冻结帧 | 崩溃诊断 |
| T2 | 假死 | ping 超时 | — | — | — | — | 主线程阻塞 |
| T3 | 点击无反应 | LC/SA spec | ✗ | ✗ | ✗ | ✗ | 绑定丢失 |
| T4 | 跑了没效果 | spec | ✓ | ✗ | ✗ | ✗ | 逻辑 bug |
| T5 | 数据变界面没变 | spec | ✓ | ✓ | ✗ | ✗ | SwiftUI 依赖丢失 |
| T6 | 树变画面不变 | 内部不一致 | ✓ | ✓ | ✓ | ✗ | 渲染层 bug |
| T7 | UI 变了数据没变 | spec | ✓ | ✗ | ✓ | ✓/✗ | view-model 脱节 |
| T8 | 延迟反应 | LC | ✓延迟 | ✓延迟 | ✓延迟 | ✓延迟 | 异步时序 |
| **T9** | **渐进性劣化（5.6 新增）** | 长会话场景 | — | 内存曲线斜率持续为正 | 响应延迟漂移 | 帧率漂移 | **内存/句柄/资源泄漏**（主线程 ping+内存曲线斜率+句柄计数三信号联合判定；长会话/耐久测试场景卡自动启用） |

诊断报告四段：PATH / ANOMALY / EVIDENCE（含强/弱归因与污染标注）/ NEXT。

### 5.4 白盒探针 SDK（五级 Z 矩阵）

（与 5.5 一致：Z1 宏插桩低开销无反射、Z1b @State 直写不可插桩、Z2 Mirror、Z3 KVC、Z4.5 MTLCaptureManager、Z4 watchpoint 硬件限 4、Z5 纯 AX+像素。）

### 5.5 视觉正确性引擎（八类断言 + 四层 Oracle）

（可观测性映射表与四层 Oracle 与 5.5 一致。5.6 修正一处：可达性行的命中区域标准为 **28×28pt**，macOS HIG 指针点击目标标准，原文 44×44pt 为 iOS 标准误用。）

### 5.6 GUI 调试引擎

**LLDB 三模式 + 环境冻结**（与 5.5 一致：Capture/Interactive/Trace）。

**LLDB 桥形态（5.6 明确，R30）**：Engine Core（Swift daemon）↔ **LLDB Python 脚本层（SB API）** ↔ local socket 回传。桥的调试扩展以 Python 脚本实现（利用 LLDB 官方脚本接口），编译型 C++ plugin 形态列为后续优化选项（消除 Python 依赖，P3）。

**崩溃/假死管线**：与 5.5 一致。

### 5.7 状态时间旅行（5.6 补验收）

三档机制与 S1/S2/S3 保真度（与 5.5 一致）。**档 1 恢复验收指标（5.6 新增，R25）**：

- **档 1 恢复保真率** ≥95%（恢复后重放原操作序列，state diff 与快照前一致的比例）；
- **档 1 恢复时间**：小中型 app（≤500 状态节点）P95 <1s；大型 app（>500 节点）P95 <3s（原"<1s"为无分级的乐观承诺，5.6 分级化）；
- 断言 **C34（5.6 新增）**：档 1 恢复保真率 ≥95% 且分级恢复时间达标；未达标 → 高频循环默认档降为档 2（ffwd 重演），P1 门验收相应调整。

不可快照区（诚实边界）与 5.5 一致。

### 5.8 副作用观察器（双模式）+ 误操作注入

（与 5.5 一致：纯净/集成双模式、观察矩阵、误操作注入三级降级链约束。）

### 5.9 实际功能使用测试

（与 5.5 一致：场景卡、覆盖度模型、探针+Fuzzing。）

### 5.10 UX 对人类的正确性（5.6 修正）

六维可计算层（响应性/可达性/一致性/辅助功能/手势/状态反馈）与 UX 五层模型与 5.5 一致。

**修正（R22）**：可达性维度的命中区域标准由"44×44pt"修正为 **"28×28pt（macOS HIG 默认最小控件尺寸），关键交互 44pt 推荐"**。原文误用 iOS 触控标准，对以 AppKit/SwiftUI 为主的目标用户会系统性误报。

### 5.11 元认知引擎

（与 5.5 一致。）

### 5.12 性能熔断与降级开关

（与 5.5 一致：四级熔断、熔断级进 evidence 包。）

### 5.13 CI 形态与降级矩阵（5.6 修正）

| 形态 | 环境 | 可用性 | 限制 |
|---|---|---|---|
| 本机开发 | 用户 macOS 桌面 | 全功能 | 需辅助功能权限授予 |
| CI 模拟器 | GitHub Actions macOS runner + Simulator | AX 大部分可用；CGEvent 合成受限 | 无 Metal/VZ 快照；档 3 不可用 |
| CI 真机（自建 runner） | 物理 Mac 或 Apple Silicon VM | 全功能 | 需 TCC 预授权；runner 维护成本 |
| **CI 无头降级** | 无登录窗口的 runner | **build+静态断言+文件系统级断言**（5.6 修正） | **AX 查询不可用**——AXUIElement 依赖 GUI 会话（WindowServer），无头会话下 AX 树不存在；act/restore/视觉断言均不可用 |

**修正说明（R23）**：5.5 原文该形态"仅 AX 查询+build+静态断言"中的"AX 查询"技术上不成立，5.6 修正。无头形态需要 AX 能力时，唯一途径是升级到"CI 真机（自建 runner）"形态（物理 Mac 或带虚拟显示的 VM）。

**金丝雀 app 套件与 CI 卖点边界（R31）**："可进 CI"的准确表述为——CI 模拟器形态可承载**八分类中 T3–T7 的静态可判定子集 + 金丝雀回归网的确定性断言**；崩溃捕获（T1）在 CI 模拟器可用；T9 劣化需长会话，仅 CI 真机形态可承载。金丝雀 app 在 CI 模拟器形态的验收基准：八分类注入 bug 各 2–3 例的检出率 ≥80%（与 C2 断言联动）。

daemon 权限模型与 5.5 一致。

### 5.14 开发者支持面（5.7 新增，R36）

**evidence 审查 UX（开发者侧）**：agent 会话的可审计回放——每个 operationID 一张证据卡片（操作、AX 树 diff、state diff、像素 diff、归因强度、污染标注、熔断级）；支持按归因强度过滤（"仅看强归因"模式）；诊断报告四段（PATH/ANOMALY/EVIDENCE/NEXT）以时间线呈现。开发者离席后回归的第一屏 = 本会话失败断言汇总 + 需要人工裁决的 Oracle 队列项。Harness 面为原生 UI；MCP 面以导出格式（结构化 JSON/HTML 报告）承载同一内容。

**首次运行 onboarding 与权限引导**：权限清单及用途逐项声明（最小必要原则）——辅助功能（AX 读取/操作）、输入监控（C33 并发污染检测的 CGEvent 输入流监控）、屏幕录制（像素 diff 通道）、开发者工具（LLDB attach）。每项给出"拒绝后的降级形态"（如拒绝屏幕录制 → 像素断言降级、T6/T7 判定退化为 AX 树对比；拒绝输入监控 → C33 并发污染检测降级为纯操作权互斥）。内置样例配方 + 金丝雀 app 一键跑通首个验证循环。**分发与公证（Developer ID + notarization + 权限 onboarding）列入 P1 检查清单**。

**失败模式 agent 指引**：除诊断报告 NEXT 段外，基础设施类失败（T0 通道故障、权限被拒、探针安装失败、daemon 未运行）输出结构化错误码 + agent 可执行补救步骤（如"运行权限引导命令""重试降级通道"）——agent 无需理解 GlassPane 内部即可自愈。

**多项目与资产库组织**：项目注册表（每个被测 app 一条：bundle id、探针配置、配方集、基线库、校准资产引用）；资产库按项目隔离，Oracle 标签与基线不跨项目混用；项目级 evidence 存储位置可配置（默认 XDG 数据目录）。

---

## 6. Oracle 治理系统

（七标签体系、升级轨道、基线自动失效与三级人审队列——均与 5.5 一致。）

---

## 7. 审美先验校准引擎 + Aesthetic Expert

### 7.1–7.4

（问题定义、双通道校准资产、两条提取通道、部署形态——均与 5.5 一致。）

### 7.5 诚实边界与 C27 操作化（5.6 补强）

（5.5 既有内容保留：校准收敛有界、冷启动规模、无遥测独立开发者、Ø 裁决权不转移、C27 操作化定义。）

**评审员自身一致性前置门槛（5.6 新增，R27）**：双人独立人审开始产 gold label 前，**评审员间 kappa ≥0.6**（substantial 下限）为前置条件；不达标时先校准 rubric 再评模型——防止评审员噪声被误读为模型噪声，避免 C27 初始 kappa ≥0.45 的验收线在低质标注上虚耗。

**Expert 训练数据规模推演（5.6 新增，R28）**：

- **供给估算**：冷启动 200–400 张 + 每回归周期 ≤30 张 × 约 40 个回归周期（12 月）≈ **1400–1600 张**；
- **可行性对照**：LoRA 在小中型数据集上与全量微调效果相当，分类/抽取任务 200–500 条即可起效；审美偏好对齐属分布对齐任务，所需量级高于分类任务，1000–2000 张处于可行区间的中段；
- **风险声明**：若 12 月累计标注 <1000 张（人审 SLA 无法维持），C29' 开闸自动顺延——数据量不足时强行微调只会过拟合，宁可延迟不降质；
- **成本可见性**：人审量推演纳入 P0.5 启动前的 Go/No-Go 检查项（评审员 ≥2 名、每周投入 ≤15 分钟/人可持续 12 个月）。

**评审员池对冲（5.7 新增，R37）**：双人 12 个月持续投入是本方案最脆弱的外部依赖。对冲：①评审员池按 **3 人配置（2 活跃+1 备份）**，允许轮换不断档；②**P1 后从早期用户中招募**（金丝雀回归网使用者天然合格）；③审核队列**全异步**（每项 ≤5 分钟、可积压、周清），SLA 按池容量而非个人排程；④Go/No-Go 检查项口径调整为"**池内在册活跃 ≥2 名**"。

### 7.6–7.7

（C29' 防泄漏规程、双部署质量分叉治理——与 5.5 一致。）

---

## 8. 双线产品战略

### 8.1 产品矩阵

（与 5.5 一致。5.6 补充：产品矩阵中各产品实现语言标注——Engine Core=Swift，MCP Server=TS，Harness=TS，Aesthetic Expert 训练管线=Python，见 §2.5。）

### 8.2 Harness 线：fork opencode 的四约束

（与 5.5 一致：Patch 集纪律/内核铁律/双角色时机/契约测试纪律。5.6 补充：opencode 上游为 TypeScript 项目，fork 即被 TS 技术栈锁定——这是 fork 税的组成部分，五个薄模块全部以 TS 实现，通过 local socket 连接 Swift daemon；技术栈锁定已纳入 §2.5 总览。）

**kernel 依赖补注（5.7 新增，R32/R33）**：@iterate/kernel 以 **npm 依赖**进入 fork——由既有五薄模块在内部 import（绑定上游扩展点到 kernel API），**不新增 patch 模块、不占 Patch 集 5 模块名额**；"两工具面合计 <10% 代码量"铁律的计量口径为 **fork 自有代码**，依赖代码不计入。契约测试归因由此增强为三分类：kernel API 测试失败（内核坏）/ fork 适配测试失败（胶水坏）/ 上游契约测试失败（上游坏）——见 §8.5 与 C28 扩展（R34）。

### 8.3–8.4

（Native 面差异化能力、上线顺序——与 5.5 一致。）

### 8.5 iterate 生态共享内核集成（5.7 新增，R32/R40）

**需求**：GlassPane 与 iterate 生态（iterate-harness、iterate-plugin 及第三个项目）需要**代码级深度双向联动**。薄集成（CLI/文本边界）会真实丢失四样东西：类型/语义级集成（iterate 的 decision log 不理解 GlassPane evidence 包的 opID/归因等级/熔断级语义，invariant 引擎无法原生消费结构化判定）、跨特性优化（上下文压缩钩子无法感知审查维度上下文）、延迟（跨界一次进程启动+YAML 解析+JSON 序列化）、原子性（跨界操作无事务语义，三步独立进程中断后无联合回滚）。

**为什么不能在 fork 层融合（结构性否决，决策存档见 §16）**：

1. 两个 fork 上游不同（GlassPane Harness fork 自 opencode，iterate-harness fork 自 OpenHarness），内部 API（工具注册/session 管理/上下文流水线）是两套完全不同的代码——"搬特性"实为用另一套内部 API 重写一遍，此后每边改一次就要重写一次；这不是融合，是把双倍维护制度化；
2. 需要改造的恰是重叠区域（工具注册/上下文处理/session 层），两套 patch 在同一批文件上交错，每次上游 release 的合并冲突面随 divergence 增长——且在两个上游方向上同时复利；
3. 融合会把两个上游的完整变更流重新接回身上——fork 纪律已把每个 fork 的上游暴露面压缩到 5 个薄模块，融合等于放弃这一压缩；
4. 契约测试纪律失效——其前提是"失败原因可归因于上游"，融合后无法区分 opencode 上游破坏、OpenHarness 上游破坏、还是融合代码破坏，可归因性是契约测试的全部价值；
5. 故障隔离消失——两条产品线共享命运，对 P-1/P0 阶段、决策门未过的项目组合是不可接受的风险集中。

**解法：把融合上移一层——共享内核包 @iterate/kernel**：

```
┌─────────────────────────────────────────────────┐
│ Layer 2: 适配层（薄，各 fork/壳内）                    │
│  opencode fork 五薄模块      OpenHarness fork 适配   │
│  （把上游扩展点绑定到 kernel API）                     │
├─────────────────────────────────────────────────┤
│ Layer 1: 共享内核 @iterate/kernel（一份实现，N 消费者）★│
│  schema: config / invariants / evidence /            │
│          decision log / 维度系统                      │
│  引擎: invariant 求值 / 维度评分 / 收敛规则             │
│  契约: provider 注册 / AE 调用约定 / 审计映射           │
│        (opID ↔ decision log 单向哈希链)               │
│  事务: 跨界操作原语(判定失败→重验→回滚)                  │
├─────────────────────────────────────────────────┤
│ Layer 0: 上游 fork（保持薄，四约束/patch 纪律不变）      │
│  opencode fork（GlassPane Harness）                  │
│  OpenHarness fork（iterate-harness）                 │
│  Swift Engine Core（不在 kernel 内，经 local socket）  │
└─────────────────────────────────────────────────┘
```

**依赖方向铁律：fork/壳 → kernel，仅此一条边；kernel 永不依赖任何 fork**（否则耦合重新建立）。

**GlassPane 侧的精确边界（5.7 澄清）**：

- 消费者是两个 TS 面：Harness fork 的五薄模块内部 import kernel（不新增 patch 模块）；MCP 壳为净室 TS，直接依赖，无任何 patch 顾虑；
- **Swift Engine Core 不进 kernel**："判定性验证逻辑 100% 位于 Swift"铁律不变。kernel 只承载 TS 语义层；Swift 侧按 C35 契约输出/消费 evidence——**JSON Schema 为唯一真源，Swift Codable 与 TS zod 双绑定**（这是方案原文未覆盖的跨语言缺口：GlassPane 的 evidence 产自 Swift daemon，不是 TS 代码）；
- **事务原语分工**：kernel 事务 = 编排层协调原语（判定失败→触发重验→回滚的协调逻辑，两个 TS 面内为同进程库调用）；实际恢复执行仍是 Swift Engine 的档 1 restore / 档 2 ffwd。kernel 编排、Swift 执行。

**kernel 范围（能进/进不了）**：

- 能进（自研差异化代码）：invariant 求值引擎（ensure/commands/pre-post-check 编排）、维度定义与评分系统、decision log（含与 evidence 的审计链映射）、收敛规则（重审→修复→验证循环判定）、配置 schema 公共校验器（iterate.config.yaml ↔ GlassPane recipe）、轨迹导出格式与写入器、AE provider 注册契约、跨界事务原语；
- 进不了（上游私产，融合方案同样共享不了）：opencode 的 TUI/LSP/session 持久化/多模型路由、OpenHarness 的无头会话引擎内部、两边的 CLI/UX 渲染层。

**双向集成场景清单（5.7 R40，产品级定义）**：

| 方向 | 场景 | 语义通道 |
|---|---|---|
| iterate → GlassPane | invariant 判定失败 → 触发 GlassPane 运行时重验（spawn 验证任务） | kernel 事务原语（同进程库调用，无边界） |
| iterate → GlassPane | 第 N 维审查进行中 → GlassPane 上下文压缩钩子调用 kernel `dimensionContext()`，优先压缩无关维度历史 | kernel API 调用 |
| GlassPane → iterate | evidence 包（opID/归因等级/熔断级）原生写入 iterate decision log，opID↔decision 条目单向哈希链互通 | kernel `AuditChain` 类型，无 CLI 文本解析 |
| GlassPane → iterate | GlassPane 修复完成 → 配方下一步挂接 iterate invariant 复核，通过后才进入重验 | 配方编排 + kernel 收敛规则 |
| 双向 | AE 判定按 kernel provider 注册契约注册，两侧 harness 以同一契约消费 | kernel provider 注册契约 |

**分阶段落地（门控）**：

| 阶段 | 动作 | 门控 |
|---|---|---|
| **A（现在，与 P-1 并行）** | kernel 范围冻结（上表"能进"清单）+ npm workspaces monorepo + schema 先行（config/evidence/decision-log/维度系统的类型定义）——JSON Schema 真源 + Swift Codable/TS zod 双绑定，C35 测试就位；schema 状态=**草案** | 零风险，纯新代码，不动任何 fork |
| **B（GlassPane P1 出口后）** | 两个 TS 壳消费 kernel v0.1（invariants + decision log + 审计链映射）；C28 扩展的四消费者一致性测试就位 | MCP 契约稳定（C28）+ C35 达标 + **C2 spike 真实 app 数据回填完成（schema 由草案转冻结）** |
| **C（C29'/C30 决策门后）** | 视上游插件 API 成熟度，把 kernel 功能提取为 opencode plugin / OpenHarness plugin——"平台不 fork、生态靠 plugin"（VS Code/ESLint/Neovim 发行层验证过的路径） | 上游 API 稳定性评估 |
| **D（战略复盘）** | 若数据显示两 harness 的差异化价值 >70% 已 kernel 化，评估"一个上游 + N 个面"的合并 | 数据驱动，不预设 |

**负面效果对冲核对**：patch 集纪律完好（npm 依赖不占名额）✓；上游变更流仍被薄适配层隔离（kernel 与上游零接触）✓；契约测试可归因性增强（三分类：kernel / 胶水 / 上游，比融合前更清晰）✓；故障隔离（kernel 发版出问题，任一 harness 可钉旧 semver 独立回滚）✓。

---

## 9. Xcode 27 生态对位

（与 5.5 一致：互补而非重叠；护城河排序不变。）

---

## 10. 验证路径与里程碑

### 10.1 前置阶段 P-1：机制 Spike（5.6 增补）

| 假设 | 验证内容 | 通过标准 | 失败动作 |
|---|---|---|---|
| operationID 上下文插槽 | TaskLocal+插槽双写捕获率 | 强归因覆盖率 >80% | 回退纯时间窗归因，C2 目标下调 |
| **（5.6 R26）** | **对照组：≥1 个真实开源 SwiftUI 项目（非合成 app）同步实测** | 真实 app 强归因覆盖率 ≥ 合成 app 结果 −10pp | 差距 >10pp → C2 验收以真实 app 数据为准重新标定 |
| @State 不可观测路径占比 | 3 个真实 SwiftUI 项目直写 vs 投影比例 | 直写占比 <20% | 门 B 验收加入此约束 |
| MTLCaptureManager 语义映射 | 编程式捕获能否稳定提取 API 层语义 | 3 个 Metal 视图稳定映射 | Z4.5 降级为基线对比通道 |
| 五线索引失效率分布 | **（5.6 R26）合成 app + ≥1 个真实应用（含 Lazy 容器/动态内容）实测** | 失效率分布可接受 | C1 阈值下调或增加插桩覆盖率要求 |
| S1 副作用门控 | 恢复后 onAppear/初始化重跑抑制率 | >90% | 门控失败走档 2 |
| **宏插桩构建期开销（5.6 新增，R29）** | 探针宏对目标 app 构建时间的影响（社区已有 2x 膨胀报告） | 增量构建膨胀 <30%，全量膨胀 <50% | 超标 → 探针改为可选 build phase + 开发者 opt-in，C1 覆盖率承诺相应缩窄 |

P-1 产出：Go/No-Go 决策 + 修正后的断言阈值与降级路径。

### 10.2 里程碑表

（P0/P0.5/P1/P2/P3 主体与 5.5 一致，5.6 修订以下条目：）

- **P1 关键标准增加**：C34（档 1 恢复保真率 ≥95% 且分级恢复时间达标）；
- **P2 关键标准增加**：C33（并发归因污染检出率 >95%）、T9 检出验证（长会话泄漏注入检出）；
- **P0 增补**：评审员自身一致性校准会话（kappa ≥0.6 达标后人审校准会话启动）。

**5.7 增补条目**：

- **P0 walking skeleton 原则（5.7 新增，R38）**：P0 验收显式定义为**最薄垂直切片**——单一验证通道（建议 Z5 纯 AX+像素）× 一条完整循环（act → observe → 一条断言 → 一份 evidence 包 → 诊断报告骨架）。其余模块默认"P0 不实现、按里程碑后移"。此为确认性修订：若 5.5 的 P0 定义已满足此口径，本条不改变范围，仅把口径写死——防单人带宽下 P0 范围膨胀。
- **P1 检查清单增补（5.7 R36）**：分发与公证（Developer ID + notarization + 权限 onboarding 流）。
- **kernel Phase 映射（5.7 新增，R32）**：Phase A（schema 草案）与 P-1 并行、零 fork 改动，**不进入 P0/P1 关键路径**；Phase B（两壳消费 kernel v0.1）门控于 P1 出口 + C28/C35 达标；Phase C 门控于 C29'/C30 决策门后；Phase D 数据驱动。

### 10.3 决策门重试预算

（与 5.5 一致：门 A/B/C/D 各配一次重试与明确退出产物，门 D 无重试。）

---

## 11. 关键断言清单（C1–C35，按优先级排序）

**第一梯队（方案生死）**

- C27：审美校准一致率（含 5.6 前置门槛：评审员间 kappa ≥0.6）
- C29'：Aesthetic Expert 滚动 AB（含 5.6 数据量风险声明：<1000 张自动顺延）
- C7 ≈ C2：静态召回与 operationID 归因（强 >80%/弱 >60%，**验收以真实 app 数据为准**）
- C11/C12：观察优先级
- **C33（5.6 新增）**：并发归因污染检出率 >95%、误杀率 <5%
- **C34（5.6 新增）**：档 1 恢复保真率 ≥95% 且分级恢复时间 P95 达标

**第二梯队（工程地基）**

- C25/C23/C17/C21/C1/C13/C22/C9/C26（与 5.5 一致）
- **C1 增补（5.6 R29）**：宏插桩构建膨胀 <30%（增量）/<50%（全量），超标走 opt-in 路径
- **C35（5.7 新增，R33）**：kernel schema 双语言绑定 roundtrip 一致性——JSON Schema 真源，Swift Codable / TS zod 双绑定，跨界样本 roundtrip 通过率 100%；为 kernel v0.1 冻结与 Phase B 入口的前置条件
- **C28 扩展（5.7 R34）**：MCP 契约一致性测试扩展为 kernel API 四消费者一致性（iterate-harness / iterate-plugin / iterate 第三个项目 / GlassPane Harness / GlassPane MCP 壳），失败三分类归因（kernel API / fork 适配 / 上游）

**第三梯队（架构兑现）**

- C28/C30/C31/C32（与 5.5 一致；C28 按 5.7 R34 扩展，见第二梯队说明）

**第四梯队**：C3/C4/C5/C6/C8/C10/C14–C16/C18–C20/C24 等

---

## 12. 关键决策门与风险

### 12.1 四个方案级决策门

（与 5.5 一致。）

### 12.2 最可能的风险点

（5.5 八项保留，5.6 新增两项，5.7 新增两项：）

1. **宏插桩构建税（5.6 新增）**：探针宏可能导致目标 app 构建时间膨胀（社区报告最高 2x），动摇"开发期可插桩"的开发者体验前提。对冲：P-1 spike 前置验证 + opt-in 降级路径。

2. **并发归因污染（5.6 新增）**：agent 与用户真实操作并发是真实开发常态（开发者边手动点边让 agent 跑），进程级插槽互相覆盖会静默污染归因。对冲：操作权互斥 + 污染标注（C33），宁降级不静默错判。

3. **kernel 版本漂移（5.7 新增）**：多消费者 × kernel semver 的组合漂移——GlassPane 钉保守版本、iterate 侧快速跟进的策略若无常设检查会静默分叉。对冲：消费者兼容矩阵进 kernel CI（每消费者 × 每 semver 区间的契约测试）、semver 钉扎策略文档化、弃用窗口 ≥1 个次版本。

4. **schema 过早冻结（5.7 新增）**：Phase A 的 schema 若在 C2 spike（operationID 强归因真实 app 数据）回填前冻结，会把待验证假设固化成公共契约，此后每次修正都是跨生态 breaking change。对冲：schema 生命周期显式化——草案（Phase A）→ C2 回填修订 → v0.1 冻结（Phase B 入口）；冻结评审权在 GlassPane 侧证据语义 owner。

---

## 13. 终极完成态覆盖判定

（与 5.5 一致：四大支柱确定性判定、对等的最终定义、可实现性判定。）

---

## 14. 明确不解决的

（5.5 清单保留，5.6 增补一条，5.7 增补一条：）

- **agent 与用户手动操作并发时的强归因**（技术上无法两全——操作权互斥保归因纯净但牺牲并行，污染标注保并行但降归因强度；5.6 选择"可声明、可审计的降级"而非虚假的强归因【R21】）

- **上游原生能力的跨 harness 共享**（opencode 的 TUI/LSP/session 持久化、OpenHarness 的无头会话引擎内部——上游私产；kernel 层不触及，fork 融合方案同样共享不了【5.7 R32】）

系统性方案定义不变：~90% 确定性 + ~10% 明确路由。

---

## 15. 设计原则

（九条与 5.5 一致。第 9 条"先证伪最脆弱假设"在 5.6 由 P-1 spike 真实 app 对照（R26）进一步落实。）

---

## 16. 已收敛决策（存档）

（5.5 六项保留，5.6 新增两项，5.7 新增三项：）

| 决策 | 结论 | 原因 |
|---|---|---|
| MCP Server 壳用 Swift 手写协议层 | **否决（列为 P3 优化项）** | 官方无 Swift SDK，TS 生态 SDK 成熟；壳仅做协议翻译不承载语义，跨语言成本一次性且微小 |
| 无头 CI 承诺 AX 查询能力 | **废弃（5.5→5.6）** | AXUIElement 依赖 GUI 会话，无头形态 AX 树不存在，承诺不可实现；能力边界修正为 build+静态断言+文件系统断言 |
| 可达性阈值 44×44pt | **修正（5.5→5.6）** | iOS 触控标准误用于 macOS；macOS HIG 指针目标为 28×28pt |
| fork 层融合 GlassPane 与 iterate 生态 | **否决（5.7 R32）** | 两 fork 上游不同（opencode/OpenHarness），无共同代码基底；融合=双倍 patch 维护+契约测试可归因性摧毁+双上游变更流回流+故障隔离消失；结构性不可行（五条理由见 §8.5） |
| 融合的正确层级 | **共享内核包 @iterate/kernel（5.7 R32）** | 一份实现、双向输出、原子变更、故障隔离；npm 依赖不占 patch 名额；Phase A–D 门控见 §8.5 |
| GlassPane 消费 kernel 的形态 | **两个 TS 壳消费；Swift Engine Core 不进 kernel（5.7 R32/R33）** | 判定性逻辑 100% 留 Swift（既有铁律）；kernel 只承载 TS 语义层，Swift 侧以 JSON Schema 契约对齐（C35 双语言绑定）；事务原语 kernel=编排、Swift=执行 |

---

## 17. 核心论点（T1–T5）

（与 5.5 一致。T2"编译器而非解释器"在 5.6 获得技术栈侧支撑：TS 壳与 Python 管线均不承载验证推理，判定性逻辑 100% 位于 Swift Engine Core。5.7 补充：kernel 层延续同一论点——kernel 承载语义契约与编排原语，不承载验证推理。）

---

\*本文档为 GlassPane 5.6 技术栈明确化与工程修复版。5.5 的架构形态与战略结论经审查确认成立；5.6 的修订集中于技术栈分层明确化（§2.5 新增）、并发归因污染防护（C33）、macOS 平台标准修正（28×28pt、无头 CI 边界）、验收指标补全（T9/C34/评审员门槛/数据规模推演），以及 P-1 spike 的真实性强化（真实 app 对照、构建期开销验证）。\*

\*本文档为 GlassPane 5.7 功能设计完善度与 iterate 生态集成版。5.6 的架构形态、战略结论与 R19–R31 修订全部原样保留；5.7 的修订集中于：功能设计完善度（开发者支持面 §5.14、配方分发 R35、评审员池 R37、walking skeleton R38、自包含性 R39）与 iterate 生态共享内核集成（新章 §8.5、C35、C28 扩展 R34、§12.2 新增两项风险）。**PRD v1.0（specs/GlassPane_PRD_v1.0.md）自本版本派生，作为自包含产品规格单独维护【R39】**。\*

**给您的三点使用提示**：① 若需在本地维护此文档，直接复制以上 Markdown 即可渲染；② §2.5 技术栈总览是本次新增的核心章节，建议单独评审——尤其是"MCP 壳用 TS 而非 Swift"的决策，如果您的团队 Swift 熟练度远高于 TS，可以把这个选择反转（Swift 手写 MCP 消息层技术上完全可行，只是生态工具少）；③ 文档中的断言编号（C33/C34）已与里程碑表联动，后续迭代新增断言时记得同步 §10.2。

**5.7 使用提示**：§8.5 是本次新增的核心章节，建议与 §16 新增三行决策存档一起评审——其中唯一需要立即行动的条目是 **Phase A 的 kernel schema 草案启动决策**（与 P-1 并行、零风险）；C35/C28 扩展已与 §10.2 里程碑联动；综述中标注"（与 5.5 一致）"的章节以 5.5 存档为准，产品级需求全集见 PRD v1.0【R39】。
