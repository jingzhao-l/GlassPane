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
     级别上限放宽到 `.soft`；档案的 `contaminationBasis` 必须自陈「这是声明不是测量」，
     且 `circuitBreaker.reason` 仍保留 `input-contamination-not-monitored` / `-monitor-lost` 标签；
  3. 无人监视且无人声明 → 维持原口径（`true` + `.weak`）。
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
