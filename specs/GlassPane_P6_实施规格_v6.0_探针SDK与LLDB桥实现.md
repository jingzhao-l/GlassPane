# GlassPane P6 实施规格 v6.0 探针 SDK（Z1–Z4.5）与 LLDB 桥实现批次

- 契约真源角色：P6 第一批次的实施契约（P1 全套 v1.0–v1.6、P2 v2.0–v2.1、P3 v3.0–v3.2、P4 v4.0、P5 v5.0 验收项已达标且正文保留不变；本规格**不修改任何既有批次结论**，兑现 v3.2 §27"桥实现批次照此定形，严禁跨批本批结论"之约，并补齐 P4 §33.3 与 v3.2 §27.9 列出的实现前空白）。本批次的直接使命：**把所有剩余门控点的开启条件落地**——探针 SDK Z1–Z4.5、LLDB 桥实现、T4/T5/T7/T8 与强归因接线、档 1（C34）探针负载与执行面、P-1/C2 spike 全量实测、evidence schema 由 draft 走向可冻结状态。
- 版本：v6.0
- 日期：2026-09-19
- 关联决策：综述 §5.4（Z 矩阵一行式，本批补齐实施契约）、综述 §5.6 R30 / §2.5 表（LLDB 桥 = Python + SB API + local socket，**刚性**）、综述 R26（spike 真实开源 app 对照组）、综述 R41（engine 协议帧格式与安全边界惯例）、PRD FR-05（探针 SDK）/FR-03（归因）/§4 P-1 表（六项假设 + R29 宏膨胀行）、P3 v3.2 §27（形态定形）、P5 v5.0 §6（snapshotProbe 注入槽与 rollback_full 计划面——本批提供其等待的探针负载与执行面）、P1 v1.3 §6.1（developerTools 权限无公开查询 API 的诚实口径）
- 历史铁约束的显式例外声明：评估批次惯用"不新增 socket 帧 / 不新增错误码 / 不改变 evidence schema"。本批为**实现批次**，探针门控的开启条件必然包含：新 daemon 方法 `probe_status`、新错误码 `GP_E_PROBE_UNAVAILABLE`、`signals.handlerProbe` / `signals.stateDiff` 由强制 null 转 `null | 对象`。按 C35 规则（5.8 R42），上述 schema 变更**必须双侧 fixtures 同步**，本批同步 kernel JSON Schema / zod / Swift Codable 三点并新增带值 fixture。除此之外，既有八方法语义、既有错误码、既有帧格式零变更。

---

## §0 本批实测事实（2026-09-19，先于契约登记）

| # | 事实 | 实测方式 | 对契约的关系 |
|---|---|---|---|
| F1 | `task_for_pid(自身启动的同用户子进程)` 返回 5（拒绝） | /tmp/swift 探针程序直调 | attach 现成进程面在本机当前权限形态下**不可用**——桥的"attach 已运行进程"验收不伪造，转 §7.5 权限挂账 |
| F2 | `xcrun lldb --batch -o "process attach --pid …"` → "Not allowed to attach to process" | 真机复跑 | 同上；与 F1 同族（TCC 开发者工具 / 调试权限门控，P1 v1.3 §6.1"无公开查询 API"口径维持） |
| F3 | lldb 内嵌 Python 的 `import lldb; lldb.SBDebugger` 可用 | `--batch -o script` | SB API 通道成立，桥语言边界（刚性 Python）零障碍 |
| F4 | swift-syntax 发布含 603.0.x 标签（与 Swift 6.3.3 工具链匹配），github 可达 | git ls-remote --tags | Z1 宏（ExpressionMacro 插件）可实现；构建膨胀按 C1 阈值实测 |
| F5 | `lldb --batch` 冷启动在本机 >5min（首跑 debugserver 相关，含 crash 场景 launch 控制） | 后台计时实验 | 桥冒烟必须异步/长超时设计，CI 口径记录冷启动惩罚 |
| F6 | SwiftUI `Text` 内容经 **AXValue** 暴露，而 observe/digest 树只取 role/title/identifier——纯文本改写不翻转树 digest | probe-demo 真机 dump（2026-09-19） | "UI 变了"的 canary 必须用**结构变化**表达（节点增删），demo 改用 Image 计数行；此为 Z5 树通道的固有可见性边界，写入 §8 H5 失效率样本口径 |
| F7 | app-wide AX 树含系统 Apple 菜单（App Store"3项更新"类徽标），其自发跳变让全树 digest 偶发噪声翻转 axChanged | 两次连续 observe 直测不等 | 分类语义以单测为准确定；真机 canary 断言按"重试 ≤4 次 + 明示噪声口径"设计（.p6_smoke.py run_canary），不掩盖也不假过 |
| F8 | act 管线全窗（perform→settle→双树捕获→双像素捕获→drain）实测 latency ≈ 463ms（171 节点树） | T8 金丝雀首版 0.4s 延迟落进窗内被真判成 T5 的定位实验 | T8 金丝雀延迟改 1.2s（> 最坏窗、< 2s 迟到宽限）；"延迟反应"阈值语义以窗口闭合时刻为准，非固定毫秒数 |

> F1/F2/F5/F8 是实施期真机校准的输入；§7.5 冒烟结论以最终实验回填为准。

---

## §1 Z 矩阵实施契约（补齐仓库内缺失的逐级正文）

综述 §5.4 只有一行式（"与 5.5 一致"，5.5 存档不在仓库）。本批以**实施契约**补齐（不改写一行式，仅展开）：

| 级 | 名称 | 本批落地形态 | 开销/反射 | 诚实边界 |
|---|---|---|---|---|
| Z1 | 宏插桩 | `#gpHandler(<expr>)` freestanding ExpressionMacro（swift-syntax 603.x）：展开为 `GPHooks.instrument(fileID:#fileID, line:#line) { <expr> }`，记录 handler 进入/退出与耗时；由目标 app 在按钮 action / onChange 闭包处标注。**opt-in 修正（§8 H7 实测）**：宏在小型 app 冷全量 +720%/增量 +102%（swift-syntax 插件构建主导 + 展开编译），超 C1 预算 → 宏默认不启用；同级手动形态 `GP.recordHandler()` / `GP.recordState(key:before:after:)` 承担 Z1 显式插桩语义（同为作者标注、证据强度同级，wire source 保持 "z1-macro" 道） | 手动形态运行时一次 lock + O(1)；宏形态另有插件构建成本 | 构建膨胀实测超阈（C1 失败动作兑现：可选 build phase + opt-in）；H7 数据见 spike/results.md |
| Z1b | @State 直写不可插桩 | 不实现（刚性边界照录）：`@State` 投影 setter 直写不经用户代码，宏无法观测；SDK 提供注册面而非自动面 | — | 占比实测为 spike H3（直写 <20% 才有全局可插桩承诺），门 B 验收加入此约束 |
| Z2 | Mirror | `GP.registerMirrorRoot(label:_:)`：daemon 命令触发时对注册根做有界 Mirror 遍历（深度 ≤8、节点 ≤4000），产出 `key → 值字符串` 表；用于 state diff 采集与 checkpoint 导出 | 仅导出时反射，act 热路径零反射 | Mirror 只读——恢复需 Z3 或显式注册 setter（§6.4） |
| Z3 | KVC | `GP.registerKVCObject(_:keys:)`：NSObject 模型经 `observeValueForKeyPath` 出 state 事件（willChange 语义），恢复经 `setValue:forKey:` | KVO 转发开销，O(键数) | 仅 NSObject/KVC-compatible 键；Swift-only 存储不可用 |
| Z4 | watchpoint | LLDB 桥面（§7）：`gp-watch add <addr|expr>` 经 SB API 设硬件观察点；arm64 硬件槽限 4，超额入 FIFO 队列（深度 ≤64），命中回传含槽/队列状态 | 调试期开销，非交付态 | 硬件槽耗尽时拒绝而非软件模拟（不做假 watchpoint） |
| Z4.5 | MTLCaptureManager | `GP.beginMetalCapture(destinationURL:) / endMetalCapture()`：`MTLCaptureDescriptor`（captureObject=默认设备，destination=.gpuTraceDocument，outputURL 落 tmp）经 `MTLCaptureManager.startCapture(with:)` 编程式捕获，产物路径以 capture 帧回传 | 仅显式调用时 | 设备不支持/无 Metal 时返回结构化失败帧，不伪造产物（macOS 上 makeCaptureScope 系 API 不存在，实施期校正为描述符形态——§0 精神：以真机 SDK 为准） |
| Z5 | 纯 AX+像素 | 已在 P0 全量交付，零变更 | — | — |

探针安装失败的结构化错误面：daemon 侧新错误码 `GP_E_PROBE_UNAVAILABLE`（§5.4），消息含目标 pid 与缺失 capability；remedy 给 agent 可执行步骤（综述 §13"失败模式 agent 指引"对"探针安装失败"的点名要求，本批为仓库内首次落地）。

---

## §2 探针 ↔ daemon 链路契约（本批首次定义；此前全部规格未定形）

历史批次只规定了探针**必须进被测进程**（综述 §2.1"其他语言无法触碰这些运行时"）与双写插槽归因（综述 R4），从未定义进程间链路。本批定形：

### 2.1 传输与身份
- Unix domain socket：`~/.glasspane/probe.sock`（daemon 侧 `--probe-socket-path` 可覆盖；SDK 侧 `GLASSPANE_PROBE_SOCK` 环境变量可覆盖）。
- 帧格式沿用 engine.sock v0 惯例（R41）：换行分隔 UTF-8 JSON、单帧 ≤4 MiB（超限断连并记日志）、无通知承诺（探针事件为流式上报，不是一问一答）。
- 安全边界与 engine.sock 同源：父目录 0700、socket 文件 0600；同用户本机连接，无加密（威胁模型：本机同权限进程；跨用户/网络不在范围，如实声明）。
- 方向：被测进程内探针为 **client**（主动连接 + 断线重连，退避 1s×3）；daemon 为 server。daemon 不下发任意命令，命令面白名单仅：`op_begin` / `op_end` / `checkpoint_export` / `checkpoint_restore` / `capture_begin` / `capture_end`。

### 2.2 帧表

探针 → daemon：

| t | 载荷 | 语义 |
|---|---|---|
| hello | pid, bundleId?, appName, probeVersion, capabilities[]（"z1","z2","z3","checkpoint","z4.5"） | 注册；重复 hello 视为重连，替换旧连接 |
| handler | file, line, ts, durationNs? | Z1 事件（进入即发一条 ts 无时长；退出补 duration 由 daemon 侧按 file/line 聚合，SDK 只在 >1ms 时上报带时长帧，防热点刷屏） |
| state | key, before, after, source("z1-macro"/"z2-mirror"/"z3-kvc"), ts | 状态变更事件；before/after 为规范化字符串（≤1 KiB 截断） |
| checkpoint | domains:{domain:{key:value}} 或 error | checkpoint_export 的应答（含 sha256：探针计算，口径 §5.5） |
| capture | path? / error? | Z4.5 结果 |
| result | ok, error? | 对 restore/capture_end 等命令的通用应答 |

daemon → 探针：`op_begin {}` / `op_end {}` / `checkpoint_export {domains}` / `checkpoint_restore {domains}` / `capture_begin {maxDurationMs}` / `capture_end {}`。

### 2.3 归因时序模型（"双写插槽"的进程间形态）
- 探针事件**不自带 opId**；daemon 以 act 窗口 `[t0, t1]`（t0=performAction 前、t1=settle 后采集位）对事件按 wall-clock 区间归属——同一挂钟域，无需时钟同步；窗口独占性由 C33 操作权互斥担保（P2 v2.0 已闭环，§36）。
- op_begin/op_end 通知探针开窗/闭窗：**op_end 兼作 Z2 基线差分触发点**（探针在命令处理内同步出 diff 事件），daemon 在 op_end 后以 `probeEndDrainSeconds = 0.06s` 排空窗再闭合（`endWindow`），覆盖回环投递竞速；探针在场的事件流本身不需要该等待（Z3 KVO 实时推）。
- 迟到归属：op_end 后 ≤2s 宽限窗内的 handler 事件计入该 op 的 `lateCount`（探针不区分同/异 file:line——"延迟反应"的定义就是操作后迟到的信号；act 由 dispatcher 串行化，无歧义归属）。异步续体在窗口内落地的不算迟到（真机校准见 §0 F8）。
- 归因升级：窗口内存在 ≥1 条探针事件（**handler 命中或 state 变更任一**——state-only 覆盖 SwiftUI `$binding` 框架内写这条 Z1b 真实路径：作者无法标注、但状态变更本身同窗可归因，§8 H1/H3 实施期定形）且 actConfirmed 且未污染 → `attribution.level = strong`（本仓库首次出现 strong；C2 强归因覆盖率 = strong pack / 有探针的 pack）。污染 → weak、无探针 → soft，既有语义零变更。

---

## §3 evidence schema 转真值（0.1-draft 期内修订）

### 3.1 形状
- `signals.handlerProbe`: `null | { probeVersion: string, hitCount: int≥0, handlers: [{file: string, line: int}]（≤32，首见序）, lateCount: int≥0 }`
- `signals.stateDiff`: `null | { source: "z1-macro"|"z2-mirror"|"z3-kvc", changed: bool, entries: [{key,before,after}]（≤64，键升序）}`
- 必填键位不变（handlerProbe/stateDiff 仍必存在，只是允许对象）；**stateDiff 在场规则**（实施修正，随 H7）：探针声明 z2/z3 通道 **或** 本窗口真实上报过 state 事件（手动 `GP.recordState`，source=z1-macro）才产出对象；"无通道且无事件"维持诚实 null，绝不把静默当 changed=false。`schemaVersion` 保持 `"glasspane.evidence/0.1-draft"` 不动——draft 期修订合法；**冻结（→ "glasspane.evidence/0.1"）是 §9 门表中的 Phase B 入口动作**，前置 = 本批 P6 全验收 + spike H1–H7 回填完成。
- 三点同步：kernel JSON Schema、kernel zod（`z.null() → z.union([...])`）、Swift Codable（`JSONNull → ProbeSignalsUnion`）；fixtures：ok-01/ok-02（null 形态）必须仍全绿，新增 ok-03（带值形态）；Swift 镜像 roundtrip 测试对 ok-03 运行。

### 3.2 分类器接入（插入点：T9 分支后、T3/T6 前——探针信号在场时优先，缺场时既有 INCONCLUSIVE 一条不放宽）

| 类 | 进入条件（探针在场） | 报告要点 |
|---|---|---|
| T8 | hitCount(窗口内)=0 ∧ stateDiff.changed=false ∧ lateCount>0 | 异步时序：信号在窗口后迟到（附 lateCount） |
| T4 | hitCount>0 ∧ stateDiff.changed=false ∧ axChanged=false ∧ pixelChanged=false | 逻辑 bug：handler 跑了（file:line 列表），state/AX/像素皆静 |
| T5 | hitCount>0 ∧ stateDiff.changed=true ∧ axChanged=false ∧ pixel 不变 | SwiftUI 依赖丢失：state 变了界面没变（Z1b 候选根因提示） |
| T7 | hitCount>0 ∧ stateDiff.changed=false ∧ (axChanged=true ∨ pixelChanged=true) | view-model 脱节：UI 变了 state 没变 |
| 不判定（INCONCLUSIVE） | hitCount>0 ∧ stateDiff=null（探针无状态通道）∧ AX/像素皆静 | 诚实缺口：handler 确实跑了，但无 Z2/Z3 通道时 T4-vs-无异常不可判；黑盒 T3（"死点击"）与探针证词矛盾，禁止采用；remedy 指向注册状态通道 |

刻意**不**新增的放宽：axChanged=true 而像素通道缺席时维持 P0 的 INCONCLUSIVE（探针能证 handler/state，但排除不了 T6 渲染层缺陷——"树对屏错"恰好发生在探针不可见的那一环）。真机冒烟据此把 NO_ANOMALY 金丝雀在屏幕录制未授予环境下的预期落点记为 INCONCLUSIVE（.p6_smoke.py pixel_denied 分支，如实标注非假过）。

无探针在场时上述判定**不做**（延续 5.8 R45"requires-probe-signals"），T3/T6/NO_ANOMALY 路径逐字不变。

---

## §4 探针 SDK 包结构（新建 `engine/probe/`，独立 SPM 包）

- 独立包理由：swift-syntax 只进探针包，**不进 daemon 构建图**（glasspaned/installer 构建时长零膨胀）；被测 app（含 spike 的开源 app）按 path 或 git 依赖此包。
- 目标：`GlassPaneProbe`（运行时：连接、事件环、Mirror/KVC/checkpoint、Metal capture）+ `GPProbeMacros`（swift-syntax 插件）+ 再导出产品 `GlassPaneProbe`（含宏声明）+ 可执行 `probe-demo`（合成 SwiftUI 对照 app：4 个按钮分别触发 T3/T4/T5/T7 与 T8 金丝雀、可 checkpoint 的注册模型、可选 Metal 视图）+ 测试目标。
- 引擎侧不依赖此包：daemon 的 `ProbeInbox` 独立解析 wire JSON（帧形状以 §2.2 表为真源，双端各持单测 + §8 真机冒烟校验漂移）。

## §5 daemon 集成

1. 新文件（GlassPaneEngine）：`ProbeWire.swift`（帧编解码 + 命令构造，纯函数）、`ProbeInbox.swift`（连接表 + 每连接事件环 ≤512 + 窗口归属 + lateCount，纯逻辑可单测）、`ProbeSocketServer.swift`（NDJSON 监听，结构对齐 SocketServer）。
2. EngineCore 新增可选注入 `probeInbox:`；`act()` 在有连接探针时：op_begin → 采集窗口 → op_end → 构造 `handlerProbe/stateDiff` 真值 + strong 归因（§2.3/§3）；无连接 → 逐字节维持现状（null + soft）。
3. 新方法 `probe_status`（方法表白名单追加）：`{probes:[{pid,bundleId,appName,probeVersion,capabilities,connectedAt,eventsSeen}], attachedHasProbe:bool}`；`hello.capabilities` 追加 `"probe"`。
4. 新错误码 `GP_E_PROBE_UNAVAILABLE`：remedy "在目标 app 集成 GlassPaneProbe（GP.start()）并确认其运行；探针在场是 T4/T5/T7/T8 判定的前提，缺场时诊断维持 INCONCLUSIVE——勿猜测"。`probe_status` 之外不强制探针（所有既有方法零破坏）。
5. 档 1 接线（P5 §6 预留槽的兑现）：
   - `snapshot()`：attached 探针含 "checkpoint" capability → 下发 checkpoint_export → 得 `{domains:{…}}` → `SnapshotProbeInfo(probeVersion, exportedDomains=keys.sorted, stateDigest=<对 domain 表 canonical JSON 的 sha256（探针侧计算，daemon 侧复核同式）>, checkpointFormat:"gpz1-json-v1", capturedAt)`；无探针 → 现状（probeInfo=nil，rollback_full 如实拒绝）。
   - `restore(mode:"rollback_full")`：plan/validate 复用 P5 §6 不动；新增执行段——`checkpointFormat=="gpz1-json-v1"` 时下发 checkpoint_restore（携带快照内 domain 表）→ 探针经注册 setter/KVC 写回 → 探针重算 digest 回传 → 响应 `{rollbackExecuted:true, executionSurface:"gp-probe", postStateDigest, consistent:postStateDigest==expectedStateDigest}`；含不可写域 → 拒绝并在 message 列出域名单（不伪造保真）。P5 既有 scripted-探针单测（envelope 占位哈希口径）保持通过：占位口径仅对非 gpz1 格式生效。
   - C34 验收面：恢复保真率与分级 P95 时长在 §8 spike/冒烟中以真值负载实测（档 1 语义从"计划面"进入"执行面"）。

## §6 LLDB 桥（`bridge/glasspane_bridge.py`——目录/文件名为本批次首次定形）

1. 形态（刚性继承 R30）：Python + SB API，运行于 `xcrun lldb` 内嵌解释器（F3 实测成立）；零第三方依赖；经 `command script import` 注册 `gp-capture / gp-trace / gp-watch / gp-queue` 命令。
2. **回传通道兑现 R30 的 "local socket 回传"**：`--send-sock <path>` 时把结果 JSON 以单帧写入指定 unix socket（连接失败 → stderr + 退出码非 0）；缺省写 stdout JSON。daemon/冒烟脚本消费形态是部署面选择，桥不内置（自动拉起受 §0 F1/F2 权限门控）。
3. 三模式行为定义（本批补齐，此前仓库内只有名字）：
   - **Capture**：launch 或 attach → 停住后采全部线程 backtrace（帧 ≤64）+ 顶帧寄存器 + 顶帧局部变量（深度 ≤2、单值 ≤256 B 截断）→ 结果 JSON（schema 见 §6.1）。
   - **Trace**：stop-hook 逐停追加 `bt all` 摘要到事件数组，退出时整体回传（崩溃/假死管线 T1"崩溃帧 + 冻结帧记录"的采集器；T2 假死 = 对目标 pid 逐 1s×5 采主线程栈）。
   - **Interactive**：不接管 REPL，仅命令注册 + `gp-queue` 输出 Z4 watchpoint 槽/队列状态（人用形态）。
4. §6.1 结果 JSON：`{mode, target:{pid|exe}, status, stopReason, threads:[{id,name,frames:[{idx,module,addr,file,line,function,locals:[{name,value,truncated}]}]}], registers:{name:hex}, crash:{signal,description}, watchpoints:[{addr,hwSlot,queued,hitCount}], errors:[]}`。
5. Z4 排队策略：硬件槽 4；`gp-watch add` 满槽入 FIFO（≤64），`gp-queue arm` 将队首调入空槽；槽耗尽时 `watch location` 失败如实入 `errors[]`。
6. 可测性归位（v3.2 口径）：JSON 组装/截断/队列策略为**纯函数**，进 `bridge/test_bridge.py`（unittest，python3 直跑，不需调试权限）；采集执行面归真机冒烟（§7.5）。

## §7 权限与门控事实（developerTools 面）

### 7.1 attach 面（本批实测，§0 F1/F2）：现成进程 attach 被拒——TCC 开发者工具授权是用户动作（P1 v1.3"无公开查询 API"维持，面板继续显示"未验证"，不猜）。
### 7.2 launch 控制面（lldb 以调试器身份启动新进程）：结论以本批后台实验回填 §7.5（F5）。
### 7.3 探针通道与桥通道解耦：探针事件流不需要调试权限（SDK 在进程内自报），因此 **T4/T5/T7/T8 与档 1 不被 developerTools 门控**——这是把"探针 gate"从"权限 gate"里解放出来的关键切分；仅 Z4 watchpoint（硬件观察点）在桥的调试权限后面。
### 7.4 daemon 不自动 spawn lldb：桥作为独立 CLI/脚本资产交付；自动拉起形态列入下一批次候选（前置 = §7.1 用户授权 + 崩溃现场常驻需求成立），本批不做不装。
### 7.5 冒烟结果（实施回填，2026-09-19）
- **通过**：`xcrun lldb --batch -o "command script import bridge/glasspane_bridge.py" -o "gp-queue"` → 四命令注册成功、gp-queue 输出 §6.1 形态 JSON（本机真机）；`test_bridge.py` 17 用例全绿（队列/截断/sentinel/argv/socket 回传）。
- **挂账（如实，不假过）**：capture/trace 的**执行面**——attach 现成进程被拒（F2）、`--batch run` launch 控制在当前会话上下文 >5min 无输出挂死（F5 复测）；桥的 CLI 路径对此给出**结构化失败**（timeout → status=failed + 授权指引），不再挂死。解锁条件 = 用户侧环境排查：系统设置 > 隐私与安全性 > 开发者工具授予调用方，或已授权的 Terminal 会话内复跑（`python3 bridge/glasspane_bridge.py capture --exe <crashcanary>` 一条命令即可验证）。

## §8 P-1/C2 spike 落地（六项假设 + R29 全量首次实测）

对照组（R26 刚性）：真实开源 SwiftUI macOS 项目（SPM 可构建、本机 CLT/Xcode 26.6 工具链可达；选定时记录 URL/pin）。补丁形态：本地叠加 GlassPaneProbe 依赖 + 最小 `#gpHandler` 标注，补丁文件入库 `spike/patches/`（不上传上游），测量脚本 `spike/run_spike.py`。

| # | 假设（综述 §10.1 行号） | 本批实测口径 | 通过线 |
|---|---|---|---|
| H1 | operationID 插槽双写捕获率（>80%） | 真实 app N≥20 次 act：strong pack 占比；合成 app 同序列对照 | 真实 ≥ 合成 −10pp 且 >80% |
| H2 | （对照行并入 H1 样本） | 同上双组差值直报 | ≤10pp |
| H3 | @State 直写占比 <20% | 真实 app 内 `@State` 字段：有显式 setter 副作用/注册 vs 纯投影直写 | <20%（不足项目数则如实按 1–2 个真实项目报，不造假样本） |
| H4 | MTLCaptureManager 语义映射（3 个 Metal 视图） | 真实 app 无 Metal 视图时以 probe-demo 三场景替代并**标注"合成对照，非真实口径"**（真实缺口不掩盖） | 3 场景稳定出 .gputrace |
| H5 | 五线索引失效率分布 | 金丝雀：T3/T4/T5/T7/T8 各 ≥2 例真机跑，检出率 + 误判矩阵 | 各类检出 ≥80%（对齐 C2 口径），失效率分布表入库 |
| H6 | S1 副作用门控（onAppear/初始化重跑抑制 >90%） | restore 前后 UI 信号（axChanged/pixelChanged）计数：期望 ≤10% 出现重放型变化 | >90% |
| H7 | 宏构建膨胀（C1：增量 <30% / 全量 <50%） | 同一 app 两分支（有/无 #gpHandler 全量标注）swift build 计时 ×3 取中位 | 达标；超标 → opt-in build phase 决议记录 |

产出：`spike/results.md` 结果表 + Go/No-Go + 修正后阈值 → **schema 冻结条件评估**（§9）。

## §9 门控状态表（本批对"所有门控点开启条件"的逐项交代）

| 门控点 | 开启条件 | 本批后状态 |
|---|---|---|
| 探针 SDK Z1–Z4.5（C2/C34/T4–T8 的上游） | 实现 + 单测 + 真机冒烟 | 本批交付（P6-A…E） |
| LLDB 桥实现 | 新规格批次 + 定形继承 | 本批（P6-D，capture/trace/watchpoint 队列；attach 冒烟受 §7.1 用户授权，launch 面按 §7.5 实验回填） |
| C34（档 1）| 探针快照负载 + 执行面 + 保真率/时长实测 | 本批（P6-E…F） |
| C2 spike | Z1 在场 + 真实开源 app | 本批（P6-F 全表） |
| evidence schema 冻结（Phase B 入口） | C2 回填修订 + 双侧测试绿 | 条件就绪判定记录于 §8 产出（冻结动作本身在 Phase B，发布仍属用户授权——维持"暂不发布"决定不变更） |
| C28 四消费者矩阵 | iterate 生态其余消费者存在 | **不属本批**：消费者在外部 iterate monorepo，非本仓库可代实现（如实挂账） |
| npm publish / 公证 / push / TCC 授权点击 | 用户授权与人工动作 | 不属本批（维持既有决定） |

## §10 验收项

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| P6-A | 探针 SDK 单测 | GPHooks 事件环、Mirror 有界遍历（深度/节点上限生效）、KVC 观测、checkpoint 导出/写回 roundtrip、重连退避、宏展开等价（表达式求值一次且结果透传） | ✓ 2026-09-19（engine/probe 10 用例；含宏展开 fileID:line 定位、evicted/setter-missing 两路诚实拒绝） |
| P6-B | daemon 侧单测 | ProbeWire 帧编解码、ProbeInbox 窗口归属/lateCount、probe_status、GP_E_PROBE_UNAVAILABLE remedy、分类器 T4/T5/T7/T8 四分支 + strong 升档 + 无探针零回归 | ✓ 2026-09-19（EngineP6ProbeTests 27 用例；含篡改 digest 拒绝、档 1 分歧一致=false、双关窗防重、state-only 升 strong） |
| P6-C | schema 双侧同步 | kernel zod + JSON Schema + Swift Codable 三点一致；ok-01/02 仍绿、ok-03 带值 fixture 双语言 roundtrip 100%（C35 通道） | ✓ 2026-09-19（kernel 51、mcp-shell 67、engine roundtrip 列表含 ok-03；三条新负例守 shape） |
| P6-D | 桥测试 | test_bridge.py 纯函数全绿（JSON 组装/截断/FIFO 队列）；SB API 冒烟按 §7.5 实验结论 | ✓ 纯函数 17/17 + lldb 内 import/命令注册/gp-queue JSON 真机 ✓；capture 执行面挂账 §7.5（权限/环境，非代码缺口） |
| P6-E | 真机冒烟（合成对照 app） | probe-demo：act→last_evidence 带 handlerProbe/stateDiff 真值 + attribution=strong；五类金丝雀（T3/T4/T5/T7/T8）各检出一次；checkpoint export→snapshot→rollback_full 执行面回传 rollbackExecuted=true + consistent=true | ✓ 2026-09-19（`engine/.p6_smoke.py` P6 SMOKE OK：strong/真值信号/T3..T8 全中、lateCount=1 落盘、档 1 执行面 consistent=true；NO_ANOMALY 金丝雀在屏幕录制未授予环境按 §3.2 落 INCONCLUSIVE，脚本如实分支） |
| P6-F | spike 全表 | §8 H1–H7 实数据入 spike/results.md，含无法达成项的如实边界（如 H4 合成替代标注） | ✓ 2026-09-19（FineTune 真 app 注入编译+探针注册通；H3 严 17.4%✓；H7 超阈→C1 opt-in 落地；H4 降基线通道；H1 真实比率挂 Phase B 复测配方已给；schema 冻结评估=仅剩该项，维持 draft 不冻结） |
| P6-G | 全量回归 | engine 既有 294+新增 0 失败；kernel/mcp-shell/installer 全绿；C33/T9 冒烟脚本对 §36 守护形态零回归 | ✓ 2026-09-19（worktree 隔离基线 **321 用例 0 失败** 1 opt-in 跳过 =294 基线+27 新增；kernel 51/mcp-shell 67/bridge 17/probe 10 全绿；.p6_smoke.py 对 worktree 二进制复跑 P6 SMOKE OK 零回归；installer 面由并行会话持有、不属本批变更面） |
