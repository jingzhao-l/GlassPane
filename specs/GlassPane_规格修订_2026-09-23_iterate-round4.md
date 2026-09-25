# 规格修订记录 — 2026-09-23（iterate round 4）

业主口径：「你来，全修掉」——原先列为「需用户裁决」的规格冲突由本轮逐条定夺并落地。
本文件是**规格侧的单一变更面**：每条给出规格原文位置、改成什么、为什么，以及兑现它的代码/测试锚点。
逐字改写风险高（同一措辞散落在多份规格的正文、验收表与实施记录里），故对影响面大的条目先落本记录、
再在下次规格整版时并入正文；已直接改正文的条目只有 P5 四处（见文末）。

排序按「不改规格就会有人把代码改回去」的紧迫度。

---

## 1. P2 v2.0 §17.2 —— 污染的第三种输入：操作员声明

- **原文口径**：未测量输入流（无 tap / tap 中途失效）→ 一律 `contaminated: true` + `.weak`。
- **改为**：三类输入，判决按优先级 **测量 > 声明 > 未知**：
  1. 监视器抓到人类输入 → `contaminated: true`，`.weak`（不变，且**任何声明都不得覆盖它**）；
  2. 窗口无人监视 **且**操作员声明本机无人值守（`glasspaned --unattended-window`）→ `contaminated: false`，
     级别上限放宽到 `.soft`；act 响应的 `contaminationBasis` 必须自陈「这是声明不是测量」，
     且 `circuitBreaker.reason` 仍保留 `input-contamination-not-monitored` / `-monitor-lost` 标签；
  3. 无人监视且无人声明 → 维持原口径（`true` + `.weak`）。
     〔2026-09-24 两处更正：① 上面第 2 条写作"档案的 `contaminationBasis` 自陈"不成立 ——
     冻结的 evidence schema 是 `additionalProperties: false` 且**没有** `contaminationBasis` 字段，
     这句话只在 **act 响应**里成立。档案侧可读出的声明证据因此是三件：`attribution.contaminated == false`
     + `circuitBreaker.reason` 仍带 `not-monitored` 标签（监视器缺失这一事实不被抹掉）+ 守护进程启动日志与
     其命令行参数；规格不得把"读档案就知道有人声明过"当成已交付能力。
     ② 第 3 条的"未测量 ⇒ true+.weak"对**守护进程**成立，但对"既无监视器又无人给出原因"的内嵌引擎
     （测试/嵌入方）不成立：那种情形答案是 `false` + `.soft`，只有 basis 句子说明它不是观测。
     这条不对称刻意保留 —— 凭空造一个"原因"就是把未测量写成结论；守护进程不可达该分支这一事实由
     `EngineCoreTests.testDaemonAlwaysStatesAReasonWhenNoMonitorRuns` 钉住（文本闸，理由见其注释）。〕
- **为什么**：第 2 类缺失时，`--no-c33` 启动的守护进程**永远**产不出 `.strong`（P6 §2.3 的
  soft→strong 升级以「未污染」为前提）。仓库唯一的端到端探针闸 `engine/.p6_smoke.py` 正是断言一个
  `.strong` 金丝雀，于是在任何无输入监控席位的机器上必红——「永久红闸」与本轮 A-08 修掉的那条同形。
  声明而不是默认放宽，是为了让「没人敲键盘」这句话可归责、可在档案里被读出来。
- **锚点**：`EngineCore.declaresUnattendedWindow`；`EngineCoreTests.testDeclaredUnattendedWindowReplacesTheInferenceNotTheRecord`、
  `…NeverOverridesAnObservedHumanInput`、`testUndeclaredEngineKeepsTheConservativeVerdict`；
  `.p6_smoke.py` 断言 2 条（`strong 来自声明而非测量`、`声明不洗白缺失的监视器`）。实测：`level=strong`。

## 2. P5 §9.3 —— 两处 `?? EvidenceStore.defaultDirectory` 回落取消（已直接改正文）

见文末「已改正文」。附带口径：`glasspaned` 现以 `--state-dir` 命名状态根，
`StateRoot` 是 `evidence/`、`projects.json`、`approvals.json`、`probe.sock` 的**唯一**拼写处；
未命名时回落 home 默认并向 stderr 写一行说明（因为 `NSHomeDirectory()` 不读 `HOME`，
「把 HOME 指进沙箱」不是隔离）。规格中「daemon 参数表」不受冻结约束（冻结面是 socket 方法表/错误码/帧格式）。

## 3. P0 §3.3 / §6.2 —— 超时码与 act 响应字段

- **超时**：原文「engine 连接失败（socket 不存在/超时 10s）→ 文本含 `GP_E_ENGINE_UNREACHABLE`」拆成两支：
  传输/找不到 socket → `GP_E_ENGINE_UNREACHABLE`；**已连接但未按时回答** → `GP_E_ENGINE_TIMEOUT`
  （shell 侧码，daemon 词表无对位项；不可重放方法 `act`/`restore` 的 remedy 明令不得重发，只许轮询 `gp_probe_status`）。
  常量已收进 `mcp-shell/src/errors.ts`（与其余 shell 码同源），P1 v1.2 §P1-S21 的期望串随之为
  `REJECTED GP_E_ENGINE_TIMEOUT`。
- **act 响应字段**：`axChanged` / `pixelChanged` 由「无条件字段」改为「**仅在该通道实测到时出现**」，
  与冻结 evidence schema 对 `signals.axEvent` 的「缺席即未测量」编码同规则。
  把未测量写成 `false` 会让 agent 把「没采到」读成「没变化」。
- **锚点**：`errors.ts`、`engine-client.ts:onDeadline/slowEngineRemedy`、`EngineCore` 的 R1-03 注释与
  `mcp-shell/test/engine-client.test.mjs`（5 处字面断言）、`EngineCoreTests`（缺席编码）。

## 4. P0 §6.2 工具表 —— 承认第 14 个工具 `gp_probe_status`

规格各处（P0 §6.2(6)、P1 v1.3(2)、§10.3(2)、v1.4(3)）合计 13 个工具，全仓规格 grep 不到
`gp_probe_status` 这个名字，而它早已是 agent 可调、且被 `slowEngineRemedy` 指定为唯一诊断入口的活路径。
裁决：**规格补入该工具**（不是删代码——删掉等于夺走 agent 判断「探针在不在」的唯一手段）。
其响应新增/明确的键一并入文：`disconnections`（总数）、`recentDisconnections`
（`{pid, appName, disconnectReason, disconnectedAt, drops}`，只含已断开且未重连的注册）、
`unmapableStateFrames`（守护进程侧总数）、每行可选 `stateFramesUnmappedSource` /
`droppedEvents` / `droppedWrites` / `rejectedKeys`。
**探针自报的三个计数遵循「缺席 ≠ 0」**：未上报即不写该键；`0` 是测量结果。
`probes` 保持「活注册」语义（A-10：断开过的探针不会出现在其中，也没有 `connected:false` 这种行）。
- **锚点**：`tools.ts` 的 `gp_probe_status` 描述文本；`ProbeWire.swift`（hello 解码）；
  `ProbeInbox.statusJSON()`；`EngineCore.probeStatus()`；`ProbeCounterTests`；
  `mcp-shell/test/tools.test.mjs`（trail-scoped 工具名固定集）。

## 5. P1 v1.4 §2 / RecipeLoader —— 统一到冻结契约（代码已改，规格无需改）

规格一直写的是 kernel 形状（`specs/…P0 v1.0:209`、`…P1 v1.4:58` 要求 daemon 按
`kernel/schemas/recipe-config.schema.json` 校验），是**实现**偏离了规格（整数 `schemaVersion` +
`{selector, action}`），且其测试绿在「字面量抄实现」上。本轮把 `RecipeLoader` 改为镜像契约，
并让 Swift 侧吃同一份 `kernel/fixtures/recipe-config.ok-01.json`（新的跨语言真值检查）。
`--recipe-validate` 帮助文本原称支持 YAML，实为 JSON-only，已改。空 `name` 仍判合法：zod 侧
`z.string().max(256)` 无下限，daemon 自造更严规则会重新造成「两侧无交集」。

## 6. 裸字面量 `screen-recording-denied`（三处）

P1 v1.0 §2 实施记录项 3、P2 v2.1 §19.2、P4 v4.0 §33.1 观察 3 仍写
`circuitBreaker.reason="screen-recording-denied"` 全等形状；A-02 之后该字段是
`"标签: 原文"` 且整串由 `"; "` 分段（另有 `performance|` / `degradation|` 前缀段）。
正确读法：**按段匹配**，段等于标签或以 `"标签:"` 开头才算该席位缺失；裸子串会把别的段里
出现同名文本读成席位缺失。实现锚点：`EngineCore.pixelCaptureFailureLabel` 与
`.p6_smoke.py:breaker_reason_has_label()`。
注：冻结 golden `kernel/fixtures/evidence-pack.ok-02.json` 内的字面量**不改**（跨语言真值集，改了等于伪造历史档案）。

## 7. 审计在档记录的位置纠正（R7-00 口径）

`specs/GlassPane_Audit_2026-09-22*.md` 的 §2/§3/§5 叙述（含「本轮已修」清单与四页控制台）描述的是
分支 `fix/console-panel-audit-recheck`（@408ee34）上的工作副本内容，**不在** `origin/main`。
在 main 上逐条复核会得出「在档已修 = HEAD 已修」的错误结论——本轮 reviewer 与另一会话的复审都撞上过。
该文档应在开头加一行落点说明（本条即为该项变更的登记；文档本身属另一会话产出，未在本轮改写）。

## 8. 存量权限（R5-04 的存量半）—— 就地收紧，不新增承诺

`SECURITY.md`、README、P0 §3.5、P6 §2.1 已把「目录 0700、socket/文件 0600」当作既存事实声明，
但 `createDirectory(attributes:)` 只作用于**新建**目录、`Data.write(.atomic)` 按 umask 建文件，
所以先于该规则存在的 `~/.glasspane`、`projects.json`、`approvals.json`、`op_*.json` 实际是 0755/0644。
裁决：守护进程启动时对本状态根做一次收紧（能改的改、改不了的**逐条点名**），三个写入者在落盘时把
自己的文件改到 0600；`--state-dir` 落在 home 之外时不再豁免（旧实现「记一条日志然后照写」，
恰是最需要隔离的形态在跳过隔离）。
「跨用户不在威胁模型内」讲的是连接与攻击面，不豁免文件模式声明——保留 0644 与自家文档矛盾。
- **锚点**：`StateRoot.isolateFile/tightenPermissions`、`EvidenceStore.write`、`ProjectRegistry.save`、
  `ApprovalGate.persist`、`SocketServer.prepareSocketDirectory`、`StatePermissionTests`（含
  「非档案条目文件不被触碰」「目录不是常规文件要如实报告」两半）。

---

## 已直接改正文的条目（P5，四处）

1. §9.3 `projectId == nil` 分支：回落默认目录 → 未注入档案即拒绝（附修订理由与 `noStoreArchiveRefusal` 锚点）。
2. §9.3 `projectId != nil` 分支：`evidenceStoragePath ?? 默认` → 缺失/不合法即拒绝（`noArchiveRefusal`）。
3. §3.7 单测清单：「截断链尾 → invalid」改为「纯尾切不可检；截断后追加 → invalid」。
4. P5-A2 验收行：同上，并写入 `count` + `tailHash` 的比较式检测与「锚点文件不算修复」的理由。

## 仍未收口（本轮不承诺）

- P6 §5.4(3) 冻结形状表尚未逐格并入第 4 条新增键（本文件为过渡记录）。
- 路径校验的 Swift 半边（`given` 判定、三字段全校验、ownership/世界可写兜底）——TS 半边已并严，
  跨语言清单由 `mcp-shell/test/path-consistency.test.mjs` 钉住；Swift 侧输入级实现留下一轮。
- `--no-c33` 与 `--unattended-window` 的组合是否应有一条规格级「禁止在生产 launchd 配置里同时出现」的
  部署约束（声明是能力，不是默认）。

---

# 追加（2026-09-24，round 5 独立复审之后）

第 4 轮 diff 的独立全新视角复审报 14 条，本批闭合其中与"未测量当结论 / 守卫只说不做"同族的：

## 已闭合（含本文件的第 5 处正文改动）

5. **P5 §3.6 `--approval-verify` 输出表**已并入 `tailHash`/`loadFailed`/`persistFailed`/`ledgerPath`/`stateRoot`
   与退出码口径（旧表会让 P5-A5"输出符合 §3.6"必判失败）。
- **共享临时目录的匹配语义**：`EngineCore.resolvedStoragePathDefect` 过去对
  `/tmp`、`/private/tmp`、`/private/var/tmp` 做**精确等于**匹配，MCP shell 做**子树**匹配 ⇒
  `/private/tmp/x` 两侧裁决仍不同（第 4 轮只统一了名单）。现改为子树匹配，理由文案指名是哪一条树；
  输入级期望钉在 `EngineCoreTests.testStoredPathRulesMatchTheOnesTheShellEnforcesAtWriteTime`
  （新增 `/private/tmp/x`、`/tmp/anything/in/here`、`/private/var/tmp/a`、`/usr/share/x`）。
- **探针数值字段的布尔**：`{"droppedWrites": false}` 曾被 `as? NSNumber` 桥成 `0`，
  `{"pid": true}` 曾被桥成 `pid == 1`（等于让一帧坏数据注册到别人的进程上）。
  `ProbeWire.scalar` 统一按 CoreFoundation 类型 ID 否决布尔，`counter`/`pid`/`line`/`durationNs` 全走它；
  钉在 `ProbeCounterTests.testBooleanHelloCountersAreUnreportedNotReadAsZeroOrOne`、
  `testBooleanPidIsMalformedRatherThanProcessOne`。
- **`StateRoot.isolateFile` 不再把"读不到"当"已私有"**：`attributesOfItem` 失败此前返回 `nil`（＝无缺陷）。
  现区分"文件不存在"（无东西可隔离）与"文件存在但属性读不出"（隔离不可证明 ⇒ 拒绝）。
  先用 `fileExists` 短路是错的：父目录不可搜索时它也答"不存在"，正好把要防的那种失败抹平。
- **证据档案的声明半径**：条目名被**目录**占据时 `replaceItemAt` 会连目录内容一并摧毁，
  与 `EvidenceStore` 自陈的"只碰自己写的 op_*.json"相反。现为发布前判据拒绝，
  钉在 `StatePermissionTests.testEntryNameHeldByADirectoryIsRefusedAndLeftIntact`
  （含反向用例：重写自己的条目仍然允许，守卫不能退化成"永不写"）。
- **落盘失败的可见性**：`ApprovalGate.persistFailed` + `--approval-verify` 载荷（见上表），
  `EvidenceStore.write` 的两条路径（rename / fallback）与 `ProjectRegistry.save` 在权限判据不过时
  **拒绝并回报**，不再"记一条日志然后照写"。
- **`--state-dir` 的收紧时机**：状态根解析与 `tightenPermissions` 移到 engine.sock 单实例判定之后
  —— 一个注定以 65 退出的第二实例不得改动正在服务的实例的状态根模式。
- **`.p6_smoke.py` 的 UI 回写检查**（R4-01）：谓词从"无 identifier 的 AXImage"改为
  `identifier == "count-marker-row"`，并按 `assert_element{value}` 增加数值断言（`count: 4 → count: 0`）。
  收窄同时堵掉一条**假绿**通路（旧谓词把系统菜单徽标算进差值）。实测：`delta=4 before=4 after=0`、
  `P6 SMOKE OK`；反向变异（把 identifier 换成不存在的值）复现 `before=0` ⇒ 该断言的承重件被证明。

## 仍开放（不承诺，逐条点名）

- **R4-02**：`.p6_smoke.py`/`.t9_smoke.py` 仍不校验 demo 二进制是否为**当前构建**；实测见过
  `caps=['z1']`（缺 z3/checkpoint）⇒ 端到端闸可能静默测旧 SDK。修法方向：demo 自报能力集与
  SDK 源码声明的能力常量比对，不符即 NOT RUN(2)。
- **长度单位只对齐了一半**：Swift 侧 `RecipeLoader` 已改按 **Unicode 码点**（与 ajv 的 `maxLength` 等价，
  含代理对），但 zod 侧 `.max()` 按 **UTF-16 码元** ⇒ 256 个 emoji 在 Swift/schema 侧过、zod 侧不过。
  彻底统一要改 `kernel/src/recipe-config.ts`（镜像面，canonical 在 iterate-skill 主仓），
  本批只在 `RecipeLoaderTests.testAstralNameFollowsTheSchemaAndStillDivergesFromZod` 里把分歧写成可执行期望。
  同类 `String.count` 上限还在 `ParamValidation.swift` 与 `EvidenceModels.swift`（后者 P3/P4 §740 已自认差值）。
- **默认 socket 路径的两种"home"**：TS 用 `os.homedir()`（读 `$HOME`），Swift 用 `NSHomeDirectory()`
  （不读）；shell 侧已在定义处与 `--help` 里如实标注为"本进程的猜测"并给出两条 agent 可自行执行的出路
  （`launchctl print …` 读回、`--socket-path`/`GLASSPANE_ENGINE_SOCK`）。`installer/cli.js` 仍以
  `process.env.HOME` 拼 `--socket-path`，属同一族的安装期风险，未动。
- 路径校验的 Swift 半边：ownership/世界可写兜底**已于 ba07b66 落地**（`EngineCore.ownabilityDefect`，
  2026-09-25 round 6 又把它对"读不到的祖先目录"补成显式缺陷而非缺席，R6-05），两侧匹配语义也统一为子树
  （`path-consistency.test.mjs` 末尾那条 `the daemon matches protected storage as subtrees…` 现在钉的是语义，
  文件头那段"只比名单不比语义"的自陈已按它自己写的删除条件改写）。
  **仍未收口**：`given` 双查与 `recipeConfigPath`/`calibrationAssetsPath` 的内容级校验——Swift 侧只看名字。
- **P6 §5(3) 已并入**（2026-09-25 round 6）：`probe_status` 的权威键表现在写在 P6 §5 第 3 条里，
  含缺席规则与 `degradation` 全部键；本修订记录 §4 只留变更事实，键表以 P6 为准。
  **仍未收口**：`--no-c33` 与 `--unattended-window` 是否需要一条部署约束。

---

# 追加二（2026-09-25，round 5）：T9 的采样面与 watch 层可见性（R5-06 裁决落地）

业主口径延续"你来，全修掉"。原登记项"只读型 agent 永远看不到退化告警、单维度泄漏永不告警"
按以下裁决落地，**不**通过放宽升级阈值实现：

1. **采样面**：`DegradationTracker.record` 过去只在 `act` 路径被调用，于是 observe/diagnose
   型集成跑几小时也不会产生一个样本。采样量的是**被 attach 进程**（RSS/fd），与"是否点击"
   无关，因此 `observe` 现在同样记一个样本（`pingMs` 保持 nil —— observe 不付一次响应性
   往返的代价，nil 是诚实的缺席，不是从别的操作借来的数）。
2. **watch 层可见**：升级仍要求 `drivers >= 2`（两信号同向才判退化，避免把合法缓存增长当泄漏，
   这条判据是刻意的，不改）。改的是**沉默**：`gp_probe_status` 现在发布
   `degradation = {tier, samples, longSession, drivers?}`，于是"内存单向上倾、句柄没跟、
   tier=watch"成为可被读到的事实，而不是与"健康"长得一模一样的缺席。未接线 tracker 的实例
   **不带该键**（无面 ≠ 健康，与 `disconnections` 同一口径）。
3. **测试**：`DegradationSurfaceTests` 三例钉住"每次 observe 恰一个样本""drivers 必须点名
   单个上倾通道""无 tracker ⇒ 键不存在"。`ClassifierTests` 的文件头此前自称 full-branch
   coverage 而全文件从未出现 `stateDiff` —— 该声称只对实际被跑过的分支成立，已改实。

顺带在同一段代码里发现并修掉一条**"缺席不陈述"**（R5-07，编译器警告暴露）：
`Classifier.evidenceLine` 用 `if let stateDiff` 把 `stateDiffSummary(pack)` 挡在外面，
而后者内部才有 `stateDiff=unavailable` 分支 —— 于是没测到时整段从诊断证据里消失，
而两行之上的像素通道是明说 `pixelDiff=unavailable` 的。现改为无条件调用并补两例
（缺席必须说得出、测到时的完整形状 `source=…, changed=false, keys=[count]` 要钉住）。
`axEvent`/`handlerProbe`/`responsiveness` 三处仍是"未测即不提"的旧形状，**未一并改**：
那是报告文本格式的变更面，需要连 `smoke.md` 与面板渲染一起复核，登记为 R5-08。
