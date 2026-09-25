# GlassPane Harness 线：opencode fork 调研与方案 v0.1

- 日期：2026-09-24
- 性质：**调研与方案文档**，不是实施规格。实施规格系列的 P7 编号按 2026-09-22 审计 §6-4 的既有约定留给"B1 审批入口"批次，本文不占用；fork 若进入实施，另立《GlassPane H1 实施规格》。
- 决策前提：用户 2026-09-24 裁决"**走 fork**"（而非 Phase C 的 plugin 化路线）。本文给出的是"fork 到底要花多少钱、五薄模块落在哪、门控现在算什么状态"。
- 口径：上游事实一律标注来源与核实方式；凡未实跑的项写"未验证"，不沿用任何提交信息或规格里的 ✓ 作为证据。

---

## 1. 结论摘要

1. **kernel Phase B 的门控：四条里三条达成，第四条按项目自己的口径不成立**。达成的是 C35、C2 spike 真实 app 数据回填、本站 C28；不成立的是"两个 TS 壳消费 kernel v0.1"这个**动作的前置**——kernel 今天只有 schema + parser，**没有 invariants、没有 decision log writer、没有审计链映射**（§8.5 Phase B 要消费的三样东西一件都不在内核里），而 decision-log schema 本身仍是 `0.1-draft`。继续 Phase B 的正确动作不是在 GlassPane 仓库补 kernel 功能（canonical 归属在 iterate-skill），而是**先把第二个壳建起来**——它同时解掉两个死结：C28 四消费者矩阵缺的那一列，和 decision-log schema 缺的那个真实生产者。
2. **fork 比预想的便宜，但"便宜"不改变形态**：五项能力实测四项零 patch、只有"证据卡片渲染进会话流"必须改上游代码。**用户 2026-09-24 裁决：做产品级定制 fork**（形态见 §7.5），本文早先"五薄模块改成 npm 插件包 + 单文件 opt-in patch"的建议作废——"能外挂"不等于"该外挂"，GlassPane 的 harness 要 own the surface，像 `iterate-harness` 那样。零 patch 的实测结果因此降级为一条信息：它告诉我们哪些定制即便做了也**不会**与上游打架。
3. **代价从"patch 面积"移到了三处别的地方**：① 上游正在并行重写 v2 插件系统，我们挂的是它公开说将来要换掉的 v1 形状；② **失效方式是静默的**——本次在 `v1.18.32` 全树实测确认 `Hooks["permission.ask"]` **只有声明、零触发点**（权限服务对 plugin host 零引用），而上游仓内文档却把它写在"Hook surface"里；③ 上游无 semver 政策、无弃用文档、每周 1–2 次发布，"失败即冻结升级"这条纪律**必须我们自己建机制**，因为 iterate 侧的同名纪律实测只存在于纸面（§6.2）。
4. **kernel 的 npm 依赖形态：本文早先说"Phase B 第 0 号动作是发布 kernel"，那是我把战略读成了待办，已订正**。事实链是：`npm view @iterate/kernel` 实测 **404**、包体 `private: true`、无 license 字段——但**"现在不单独发布"是仓库已作出的决定**，不是待决项：P6 §13（2026-09-21 用户口令的执行记录）写明"kernel 不单独发布（iterate monorepo 迁移前随 mcp-shell 捆绑内联——`file:` 依赖出包即失联，`prepublishOnly` 强制 bundle）"，P4 §33.2 第 1 条又写明"mcp-shell/kernel 的 registry 发布不作为独立动作执行……kernel 的发布跟随 iterate monorepo 策略，先单独发布再改是双向 breaking change"。综述 §5.7/§5.8 R32 的"以 npm 依赖进入 fork"讲的是**战略与计量口径**（npm 依赖不占 patch 名额、不计入壳代码量），不是"先去 registry 发一个包"。所以 M3 的正确解法就是仓内已有 12 天先例的那一条：**带溯源的 vendored 镜像 + `file:` 本地依赖**（等 monorepo 真把它发上 registry，一行换回 semver 依赖）。把"发布"当未决项挂回用户名下，等于凭空造一个假前置——见 §9-3 的订正。
5. 三条与开工直接相关的既有事实（本次实测，全部新发现）：**"<10% 代码量"铁律在工具面 A 上已不成立（17.8%）且仓库内无人量它**（09-25 已配棘轮闸，见 §3-1）；**mcp-shell 与 daemon 双写同一个 `~/.glasspane/projects.json`**（审计里 B-1/A-15 就是同一缺陷的两个副本）；**文档里的标准 kernel 同步命令会把 A-13 的修复删掉**——`tools/sync-kernel.sh` 已加三道守卫并实测拒绝（§10）。

---

## 2. kernel Phase B 门控核验（2026-09-24 本机实跑）

门禁全部由本次会话亲自执行，HEAD = `1997bc5`（= origin/main，版本线 1.1.1，`iterate/full-review-20260922` 已合入）。

| Lane | 命令 | 实测结果 |
|---|---|---|
| engine build | `swift build`（engine/） | Build complete! (18.83s)，**exit 0**；1 条告警：`main.swift:836` `tightenPermissions(log:)` 返回值未用 |
| engine test | `swift test`（engine/） | **Executed 604 tests, with 1 test skipped and 0 failures** |
| probe test | `swift test`（engine/probe） | **Executed 24 tests, 0 failures** |
| kernel | `npm test`（kernel/） | **59 tests / 59 pass / 0 fail** |
| mcp-shell | `npm test` | **167 / 167 pass / 0 fail** |
| installer | `npm test` | **70 / 70 pass / 0 fail** |
| bridge | `python3 -m pytest -q` | **58 passed** |
| 版本线 | `node scripts/check-version.mjs` | OK：15 个位点全部 1.1.1 |
| 污染 | `git status --porcelain` + `~/.glasspane` 快照 diff | 仓库 0 变更；`projects.json`/`approvals.json` sha256 与跑前一致，`evidence/` 仍 582 件 |

> 冻结时点（2026-09-21，P6 §12）记录的基线是 engine 374 / kernel 51 / mcp-shell 71 / installer 48 / probe 10、bridge 25。三日内增至 engine 604 / kernel 59 / mcp-shell 167 / installer 70 / bridge 58 —— 增量来自 iterate 复审合流与审计二修。

### 2.1 门控四条逐条判定

| 门控条件（综述 §8.5 Phase B 行） | 判定 | 证据（回代码，非规格） |
|---|---|---|
| **C35 达标** | **✓ 成立** | 双侧 roundtrip 在本次实跑全绿；三份 schema 齐（`kernel/schemas/`），Swift 侧 `EvidenceModels.swift` + `LocalArchive.swift:79` 读侧 legacy 集合 `["glasspane.evidence/0.1-draft"]`，TS 侧 `parseEvidencePackRead()` 且 `mcp-shell/src/tools.ts:729` 实际调用它，fixture `evidence-pack.ok-04-legacy-draft.json` 钉住 |
| **C2 spike 真实 app 数据回填 → schema draft 转冻结** | **✓ 部分成立，且偏差如实** | `spike/h1-retest-result.json`：真实 app 强归因 **24/24 = 100%**（z2-mirror 通道），handler lane `hitCount=1、level=strong` 已真实命中；evidence schema 已冻结（`kernel/schemas/evidence-pack.schema.json` `$id …/evidence-pack-0.1.json`，zod `EVIDENCE_SCHEMA_VERSION = "glasspane.evidence/0.1"`）。**偏差**：冻结只覆盖 evidence-pack 一份，`decision-log-entry` 与 `recipe-config` 两份 `$id` 仍是 `-0.1-draft`（已核实），而 Phase B 要消费的恰恰是 decision log |
| **MCP 契约稳定（C28）** | **✓ 本站成立 / 完整口径未成立** | 本站三消费者（kernel API、Swift Codable、mcp-shell 胶水）一致性套件绿，失败三分类归因在测试内。但 R34 的完整 C28 = **四消费者矩阵**（iterate-harness / iterate-plugin / 第三个项目 / GlassPane Harness / GlassPane MCP 壳），其中"GlassPane Harness"这一列**就是尚未存在的 fork**；P3 §710 已如实声明本仓库不越界模拟其余列 |
| **GlassPane P1 出口** | **⚠ 规格判定 ✓，两项如实挂账** | P4 §30.3 判"P1 ✓ 一致"，18 项真机冒烟 §33.1 已落实；2026-09-22 审计 §6 的排队项经复核**已基本闭环**：A-13 读侧 legacy ✓、A-14 路径穿越 ✓（`project-registry.ts:523-536` 绝对化/`..`/解析后位置三重拒判）、A-15 损坏即清空 ✓（同文件 :281/:287/:336 抛错）、A-21 桥 `gp-queue arm` ✓（`glasspane_bridge.py:1482`）、A-22 `cmd_trace` Continue ✓。**未闭环两项**：① 分发公证——P4 §32-2 归为发布期事项，实际卡在需要用户 Apple Developer Program（$99/年），决策单已写（P6 §13）；② **B1 审批入口仍未立 P7 规格**，代码侧只有 `approvedBy: daemon:auto` 的自动记账（`EngineCore.swift:1728`），没有真正的审批请求/授予入口 |

### 2.2 门控的真正硬缺口（本次新确认）

`kernel/src/index.ts` 的导出面实测为：3 份 JSON Schema + 对应 zod 镜像 + 4 个 `parse*` + `KernelSchemaError`，共 **573 行**。**没有** invariant 求值引擎、维度系统、decision log 写入器、审计链（opID↔decision 单向哈希链）、收敛规则、事务原语。

按 5.8 §8.5 Phase A 补充条（R416 行）的原文，这些"属 iterate 侧迭代节奏，随迁移进入"。所以：

- **在 GlassPane 仓库写它们 = 违反 canonical 归属**（kernel 的 canonical 已是 iterate-skill，本仓库是镜像，见项目记忆 2026-09-22）；
- **不写它们 = Phase B 的"两壳消费 v0.1（invariants + decision log + 审计链映射）"无从执行**。

死结的解法与用户的裁决恰好重合：**fork 先动**。第二个壳一旦存在，(a) C28 缺的那一列有了真消费者，(b) decision-log schema 有了第一个真实生产者，才谈得上冻结，(c) kernel 的功能补齐回到 iterate-skill 的正常节奏里，不再需要谁越界。

---

## 3. 现状基线测量（fork 开工前必须定的口径）

| 层 | 实测 LOC（src，不含测试） | 占比 |
|---|---|---|
| Swift Engine（`engine/Sources`，含 daemon + 设置面板 GUI） | **17,197** | 82.2% |
| 工具面 A `mcp-shell/src` | **3,719** | 17.8% |
| `@iterate/kernel/src` | 573 | （npm 依赖，按口径不计入工具面） |

> 本表是 2026-09-24 开工日的快照，数字按当时树计。合流 `origin/main`（f16f8c8）后同一把尺子
> 复算：engine 18,335、面 A 3,859（新口径下 **16.98%**）、fork 面 B 539（2.37%）——本表的
> 历史价值在"口径与结论"，当前值以 `harness/contracts/tool-surface.json` 为准（机器读的那份
> 才不会说谎）。

两条由此产生的、直接约束 fork 的事实：

1. **"<10% 代码量"铁律（三条架构铁律之一）在工具面 A 上已不成立**：3,719 / (17,197+3,719) = **17.8%**。而且这不是计量分歧——mcp-shell 里最大的两块是 `tools.ts`(1003) + `project-registry.ts`(778) + `engine-client.ts`(698)，后两块里确实有真逻辑，不是纯协议翻译。**仓库内没有任何自动化检查在量这个比例**，所以它是无声漂移的。fork 之前必须二选一：要么把铁律改写成可测口径并配闸（例如"工具面不得自行判定任何证据语义"这类可 grep 的约束 + LOC 比例告警），要么正式修订铁律数值。不处理就开工，等于给同一个失败模式加第二个实例。
   **✅ 已选并落地（2026-09-25，`harness/tools/tool-surface.mjs` + `contracts/tool-surface.json`，接进 `ci.yml` 的 `tool-surface` job）**：选"配闸"，**不改数值**——把 10% 改成 20% 只会让第二次无声漂移变得合法，而这条律要防的从来不是某个数字，是"没人知道工具面长厚了"。闸的形态是**棘轮**：基线记在当前实测值，任一工具面的 LOC 超过基线即红，出路是同批 `--record` 并在提交里说明为什么长。**口径变更要写明**：分母从"engine + A"改成"engine + A + B"（fork 现在是第二个工具面，铁律问的是"占代码量"，不是"占引擎量"），因此 A 读作 **17.33%** 而不是 17.78%；分子、行数算法（`wc -l` 语义）与 §3 表格完全一致。B 当前 **539 行 / 2.51%**，逐文件可查（`preflight.sh` 83、`glasspane/daemon.ts` 171、`glasspane/index.ts` 276、`registry.ts` 的 `+9`）。**负例已实测**：A +3 行红、B +20 行红、给已列入 `edited` 的 `registry.ts` 再加 3 行也红（证明 `+N` 是照参照克隆重算的）、删 `fork-diff.json`（＝归因不能）也红。**一条边界如实挂账**：CI 没有参照克隆，所以那里量不到的是"上游字节变了多少"这一维（`tool-surface` 离线时把 vendored 文件的行数降级为上次记录并打印 `NOT re-measured`）；**"我们这一侧改了什么"在 CI 里是抓得住的**——同一批给 `fork-diff` 金样加了 fork 侧内容哈希钉，无克隆也能核对（实测 1 秒，已进 `install-gate`）。这条是过程中发现的盲区当场关掉的：加哈希钉之前，给已在改动名单里的 `registry.ts` 塞 3 行，`fork-diff --check` 与占比闸都各以不同理由看不见/只看见行数，名单却"没变"。可 grep 的那半个铁律（"工具面不得自行判定证据语义"）**已于 M4 批落地**（`harness/tools/surface-semantics.mjs` + 棘轮金样，首次基线 0 命中、三条反向因果已验），见 §9-6。
2. **mcp-shell 与 daemon 双写同一个 `~/.glasspane/projects.json`**（TS：`project-registry.ts:105` 直接 `homedir()/.glasspane/projects.json`；Swift：`ProjectRegistry.swift:23` 同一文件），两边各自实现了"损坏拒覆写/唯一临时文件名/读回比对"这套逻辑——2026-09-22 审计里 B-1（Swift 侧）与 A-15（TS 侧）是**同一个缺陷的两个副本**，修了两次。fork 的五薄模块绝不能带第三份这种复制。这条要在方案里落成硬约束（写进 §patch 纪律），并在契约测试里体现：工具面对同一份状态文件的写路径只能有一个。

---

## 4. 上游事实（opencode @ `v1.18.32`）

参考检出：`/Volumes/Eng-Dev/.upstream/opencode-1.18.32`（142 MB，仓库外只读参照，本节 grep 结论以此为准）。09-25 起两份参照**合一**：`hook-liveness` 与 `fork-diff` 都读仓内 gitignore 的 `.external/opencode`（同一 tag 下两份参照对 20 个钩子的判定逐字一致，实测后合并；两个"上游"各说各话正是这条线要防的失效）。

### 4.1 身份、许可与节奏（本次用 `gh api` 复核）

| 项 | 实测 | 核实方式与含义 |
|---|---|---|
| 仓库 | **`anomalyco/opencode`** —— `sst/opencode` 已 301 重定向；`sst` org 简介改为"我们搬到 anomalyco" | `gh api repos/sst/opencode` → `full_name=anomalyco/opencode`。**订正一处我自己在本文早期版本写下的错话**：核对后确认 PRD 与综述**从未写过 `sst/` 这个 org 名**（PRD §1.3 只写"opencode fork"）。真正的问题不是"指称过期"，而是**规格里根本没有钉过上游坐标**——没有 repo、没有 tag、没有许可证。本文 §4 与 `harness/upstream.json` 是第一次把它钉下来。 |
| 许可证 | **MIT** | 同一查询 `.license.spdx_id=MIT` → 通过宽松许可准入闸（MIT/Apache-2.0/BSD），无 AGPL 异常 |
| 规模/活跃度 | stars 209,793；默认分支 `dev`（不是 main） | 同一查询 |
| 最近发布 | v1.18.32（09-21）、.31（09-14）、.30（09-09）、.29（09-04） | `gh api releases?per_page=4` → **约每周 1–2 次、patch 位递增**，这就是 fork 的 rebase 时钟 |
| 版本治理 | 查不到 semver 政策、查不到弃用文档；`@opencode-ai/plugin` 与应用锁步、在 patch release 里 bump；release notes 只有 bugfix | 调研方读 npm registry 与 release 正文。**含义：契约测试必须行为驱动，不能 notes 驱动** |
| 同名项目 | Go 版 `opencode-ai/opencode` 已归档；`charmbracelet/crush` 是另一项目，无血缘证据 | 调研方核实，本次未复查（二手） |
| 形态 | Bun workspaces + `catalog:`，`packages/*` 32 个，纯 TS/Solid，**仓库内无 Go** | 参考检出 |

### 4.2 引擎侧真实落点（本次逐行读 `v1.18.32`）

| 关注点 | 真实路径 |
|---|---|
| 会话/agent 循环 | `packages/opencode/src/session/{session,prompt,processor,llm,tools,system,overflow}.ts` |
| 工具注册表 | `packages/opencode/src/tool/registry.ts`（455 行）；插件工具在 :199-203 `custom.push(fromPlugin(id, def))`，**保留原 id**，`gp_*` 不会被改名 |
| 权限/审批 | `packages/opencode/src/permission/{index,arity,evaluate}.ts`；ask 发起点 `session/processor.ts:372`；TUI 应答 `packages/tui/src/routes/session/permission.tsx:168` |
| 消息部件渲染（TUI） | `packages/tui/src/routes/session/index.tsx`（2,670 行）：`toolDisplays` 硬编码集 :2626、`toolDisplay()` :2643、`GenericTool` :1798 |
| 上下文压缩 | `packages/opencode/src/session/compaction.ts`（608 行）：hook 点 :374、`messages.transform` :379 |
| MCP 客户端 | `packages/opencode/src/mcp/{index,catalog,auth}.ts`；工具命名 `<server>_<tool>`（`catalog.ts:119`），注册 `session/tools.ts:390` |
| 插件宿主 | `packages/opencode/src/plugin/index.ts`：`trigger()` :284-298、事件扇出 :259 |
| 插件 API 类型 | `packages/plugin/src/index.ts`（335 行，`Hooks` 声明 20 个成员；npm 插件引用形态 :71 `plugin?: Array<string \| [string, PluginOptions]>`）；TUI 插件 API `packages/plugin/src/tui.ts`（634 行） |

## 5. 五薄模块：能落哪、要不要 patch

**先改一个口径**：§8.2 说的"五薄模块"不等于"五个 patch 模块"。实测五项能力里 **四项零 patch**，唯一需要 patch 的是 (a) 的 in-stream 形态，而它有零 patch 退路。

daemon 侧可依赖的契约（本次实读，五个模块的对接面就是这 **12 个方法**）：`hello / attach / act / observe / assert_element / diagnose / last_evidence / snapshot / restore / audit_ui / probe_status / shutdown`（`Dispatcher.swift` 的 `switch request.method`，计数取自 origin/main `7ccc835`；我在 1.1.1 基点 `1997bc5` 上第一次读到的只有 11 个，`audit_ui` 是这期间别的会话合进去的）。错误帧恒为 `{code, message, remedy}` 三字段，MCP 层映射为 **15 个 `gp_*` 工具**（同基点 14 个）。**这两个数字会被别人改：**任何引用它们的实现都要在被引用时重新数一遍，不要抄本文。

| # | 能力 | 上游落点 | 需 patch? | 证据（`v1.18.32`） |
|---|---|---|---|---|
| M1 | `gp_*` 工具注册 + 结构化结果 | `Hooks.tool` map → `registry.ts:199-203`；`ToolResult={title,output,metadata,attachments}` | **零** | id 原样保留（本次实测）；`metadata` 随 ToolPart 带下去（`index.tsx:1721`，调研方）。**约束**：模型只看 `output`（string，经 `truncate.output`），所以 `{code,message,remedy}` 必须在 `output` 里可读呈现，不能只塞 `metadata`——这条正好和"remedy 必须可执行"的既有铁律对上 |
| M2 | evidence/审计事件采集 → 写 kernel decision log | **已落地**：内部插件 `src/plugin/glasspane-decision-log.ts`（绑 `tool.execute.after`；`plugin/index.ts` 的 `internalPlugins` 末尾注册）+ 绑定层 `src/tool/glasspane/kernel.ts` | 不占额外名额（一个 vendored 文件的 2 个 hunk：import + 数组项） | 触发点实测：`session/tools.ts:121-129` 把**同一个 output 对象**交给 hook，hook 之后才 persist。写作全部走内核（`appendDecisionLogEntry`，链 `sequence==i` / `prevEntryHash==sha256(canonical(entry i-1))`），outcome/summary 用 `decisionOutcomeFromEvidence` **转录**引擎字段——判定仍在 Swift。运行时证据：`script/glasspane-e7-ledger.ts` 用**引擎自己归档的包**（`~/.glasspane/evidence/op_*.json`，582 件）跑通"记录→接链→损坏拒写"。**运行时已验（M4 批补）**：E8（`script/glasspane-e8-compaction.ts`，真宿主 + mock provider，无凭据无花费）证明真实会话里宿主**走到了**这个 hook（skip 分支的 note 落进了 part metadata）；真会话里 `logged` 分支的写入仍需一次证据成包的真轮次 |
| M3 | `@iterate/kernel` 进 fork | **已落地**：`packages/opencode/vendor/kernel/{src,schemas,fixtures}`（23 文件 / 68,020 字节）+ 唯一入口 `src/tool/glasspane/kernel.ts`；同步走 `tools/sync-kernel.sh --target=fork`，完整性由新尺子 `harness/tools/kernel-vendor.mjs` + 金样 `harness/contracts/kernel-vendor.json` 钉 | 不占 patch 名额：`tool-surface` 按溯源清单把它的 1,150 行算作**依赖**而不是我们的工具面（并打印这条排除） | **不需要发布**（P6 §13 早已决定 kernel 不单独发布；本文早先"发 npm 是第 0 号动作"已订正）。两条实测出来的约束：① 它必须在 `packages/opencode` 之内——顶层 `packages/kernel` 解析不到 zod（bun 的依赖挂在各包自己的 node_modules），而给它加 package.json 就要重跑 fork 的 `bun install`；② **同一份源码在两个 zod 大版本下运行**（canonical 钉 3.25.76，fork catalog 4.1.8），fork 的 `tsgo --noEmit` 当场抓出一处前向不兼容（`z.record` 单参在 zod 4 里必填键类型），修在内核而不是绕在 fork |
| M4 | 维度感知压缩钩子 | `Hooks["experimental.session.compacting"]`，触发点 `compaction.ts:374`；`output.context: string[]` 追加 / `output.prompt` 替换 | **零（已落地）** | 入参只有 `{sessionID}` → 需自行用 `client` 拉 messages（M4 批照做：内部插件 `src/plugin/glasspane-compaction.ts`）。**维度半如实挂账**：本 pin 的内核没有 `dimensionContext`（导出面实测，维度系统属 iterate 侧节奏），M4 不发明维度，改为把引擎/内核已写下的**证据锚点**（opID/outcome/台账序号与哈希）转录进压缩上下文，缺席以算术呈现；固定点 16 条 + E8 运行时全绿。该文件附近上游自述"非稳定 plugin 契约，可能改或消失" |
| M5 | evidence 审查 UX（会话流内） | `packages/tui/src/routes/session/index.tsx` 的 `toolDisplay()` :2643 | **需 patch**（in-stream）/ **零**（slot） | 本次实测：`toolDisplays` 是 14 个名字的硬编码集，集外一律走 `GenericTool`(:1798) 的纯 `<text>` 截断渲染；对 `packages/{tui,session-ui,plugin}/src` grep `registerToolRenderer\|toolRenderers\|renderRegistry` → **零命中**（无渲染器注册表）。零 patch 退路 = TUI plugin 的 `slots.register`/`route.register`，先例是第一方特性 `packages/tui/src/feature-plugins/system/diff-viewer.tsx`——正是一个"结构化证据查看器放在 slot 里" |

### 5.0 运行时复核（2026-09-24，`harness/spike/`，pin `v1.18.32`）

上面这张表原来是**读码结论**。现在其中三行有了一手运行时证据（不需要模型、不需要凭据）：

- **M1 成立**：`opencode serve` + `GET /experimental/tool/ids` 返回 `…,"apply_patch","gp_probe_status"` —— 原样、无命名空间前缀。**对接坑一个**：实例级路由必须带 `?directory=`，不带会一直挂着（不是 404，是挂）。
- **M2 成立**：插件的 `event` 钩子在真实会话生命周期里被调用，拿到的是 `{id: "evt_…", type: "session.created", properties: {sessionID, info…}}` —— 审计链要的 `event.id` 与 `sessionID` 都在场。
- **M3 成立（装载面）**：`plugin: ["./plugin.ts"]` 形态被装载，`config` 钩子回调里可见 `plugin_origins[{spec, source, scope:"local"}]`。npm 形态仍未验（kernel 还没发布，§7）。
- **工具体能真取证据**：`hooks.tool.gp_probe_status.execute()` 在 Bun 下经 local socket 拿到本机 daemon 的 `hello`+`probe_status`，返回 `{title, output, metadata}`。由此定下一条硬约束：**模型只能看到 `output`**，所以 `GP_E_*` 与补救必须写进 `output` 文本，`metadata` 只是给 UI 的——这条已并入 §5 M1 行。
- **§5.1 得到运行时旁证**：`--mini --demo --prompt "/permission"` 真的把权限卡画了出来（`△ Permission required / Allow once / Allow always / Reject`），而插件被访问的钩子里**没有** `permission.ask`。边界照实说：`--demo` 合成事件、不经 `Permission` 服务，所以这是旁证；决定性证据仍是 §5.1 那三条静态事实。
- **仍未运行时确认**（截至 M4/M5 批，2026-09-25）：M4 的**钩子派发与注入**已由 E8 在真宿主里确认（mock provider，不需要真模型；真模型轮次下的压缩质量仍未验）、M5 的 in-stream 形态（需 TUI 与被改的渲染路径）、`truncate.output` 对大证据包的行为、`attachments` 有无渲染出口。

> 这一轮还留下一条纪律教训：E5 的断言第一版**是假绿**——插件装载了就放行，而那次权限卡根本没出现。现在判定前置"必须看到被测量物出现过"。详见 `harness/spike/README.md`。

### 5.1 一条必须写进规格的坏消息：`permission.ask` 是死钩子


本次在 `v1.18.32` **全树** grep 精确字面量 `"permission.ask"`：

```
./packages/plugin/src/index.ts:261:  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>
```

**全树仅此一处＝只有声明，没有任何触发点。** 宿主只会 fire 有人以字面量传进 `trigger(name, …)` 的名字（`plugin/index.ts:284-298`：`hook[name]?.(input, output)`）；权限服务 `permission/index.ts`（223 行）对 plugin host **零引用**；`processor.ts:372` 的 `permission.ask({...})` 是**服务自己的方法**，不是 hook。所以：

- 模块 (b) 的会话级权限引导**不能挂 `permission.ask`**，必须走 `Hooks.event` 收 `permission.asked`/`permission.replied`（事件类型定义 `packages/schema/src/v1/permission.ts:61`）+ 用 `client.permission.reply` 应答 —— TUI 自己就是这么做的（`permission.tsx:168`）；
- 上游仓内文档 `packages/core/src/plugin/skill/customize-opencode.md:354` 把 `permission.ask` 列进"Hook surface"，**那句是错的**，我们的方案不得引用它；
- 这是"静默契约死亡"的实例：类型合法、编译通过、永不触发。挂它实现的权限引导会**看起来正常地完全不工作**。

### 5.2 另外两处静默陷阱（本次实测确认存在）

- `session/tools.ts:388` `if (flags.experimentalCodeMode) return tools` —— 开了 code mode 就**跳过逐工具注册**，M1 的 `gp_*` 会以另一种形态出现或消失；契约测试必须覆盖两种 flag 形态。
- 插件工具与内建工具同名时的优先级是数组顺序副作用（`all()` = `[...builtin, ...custom]`，`registry.ts:258` 附近），**未见于文档**。

## 6. Patch 队列机制与契约测试三分类

### 6.1 机制

- **pin `v1.18.32` 作 fork base**，M5 用 `git format-patch` / `git am` 的单文件 series，且默认不启用（§8 风险 3）；
- **不用 submodule**（破坏上游 `catalog:` workspace 解析）；**不用 overlay 全量拷贝**（制造第二真源，正是 §3 的 `projects.json` 双写与 §6.2 iterate 前例的失败模式）；
- 三分类（R34）落地形态：
  1. **kernel API 坏** → kernel 自身 roundtrip 套件（已在，本次 59 绿）；
  2. **fork/插件适配胶水坏 + 上游换地板** → **已建**（本文档原稿写的是"必须自建"，现已成立）：`harness/tools/hook-liveness.mjs` + 金样 `harness/contracts/hook-liveness.json` + 坐标 `harness/upstream.json`。它把 `Hooks` 声明逐条回引擎源码找派发位点，分 live / structural / dead 三态；在 pin 的 `v1.18.32` 上实测 **20 声明 = 14 live + 5 structural + 1 dead（`permission.ask`）**。四个模式（`--check` / `--probe` / `--offline` / `--record`）的通过**与拒绝**都已实测，包括"伪写金样即红""金样缺失即拒""基准混用即拒"三条因果验证；详见 `harness/README.md`。
     第二件套**已补齐**（M4 批）：M1 `test/tool/glasspane-surface.test.ts`、M2 `test/plugin/glasspane-decision-log.test.ts`、M3 `test/tool/glasspane-kernel.test.ts`、M4 `test/plugin/glasspane-compaction.test.ts`、M5 `packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx`——每个模块的行为不变量都有对应固定点（合计 57 条 glasspane 固定点全绿），外加 E7（决策链对真 daemon）/ E8（压缩钩子对真宿主）两个运行时脚本。
  3. **上游坏 → 冻结升级** → 已在 `.github/workflows/harness-contract.yml`：每周（+ 手动 + `harness/**` 变更时）解析上游最新 release，下载该 tag，跑 `--probe`；漂移即红并指名"冻结，不要在本仓打补丁绕过"。PR CI 只跑 `--offline`（142 MB 上游不该进每个 PR），且离线模式**大声声明"上游未在此观测"**而不是静默通过。
- release notes 不作依据（§4.1：只有 bugfix 口径）。
- 上游参照检出**不入仓**（仓外只读，见 `harness/upstream.json.checkout`）。理由写在 `harness/README.md`：vendored 副本正是 iterate 侧那条 fork 悄悄变成第二代码库的路径（§6.2）。

### 6.2 iterate 侧前例的真实状态（照抄会踩空，本次逐条核实）

`iterate-skill/harness/iterate-harness` **不是薄 patch fork，而是 vendored 全量就地改**：与上游 `.external/OpenHarness` 对比，194 个共享文件里只有 50 个字节一致、**144 个有真实内容改动**，另删 20 个上游文件、加 8 个自有文件；且包名从 `openharness` 改成 `iterate_harness` 使每一行 import 都不同——**对上游 rebase 在结构上已不可能**。其设计文档 `DESIGN-iterate-harness.md:461` 承诺的"8 处定点修改"与树不符；`:497` 承诺的 `upstream` remote 与定期 fetch **不存在**（无该 remote）；"失败即冻结升级"的闸**任何地方都没有**；`@iterate/kernel` 在 iterate-harness 里出现 **0 次**（两侧都 `private: true`，从未发布）——即"kernel 以 npm 依赖进入 fork"这条约定今天**只存在于 GlassPane 综述 §8.2:343 的纸上**。

可迁移的只有两条：(a) fork 作为 monorepo 子目录 + `git subtree split` 发布到独立仓；(b) 以 diff 面命名的固定点测试文件形态（`tests/test_iterate/test_kernel_integration.py`）。其余不能当成已验证纪律引用。

## 7. 与 kernel Phase B 的耦合：顺序反了会卡死

Phase B 原文动作 = "两个 TS 壳消费 kernel v0.1（invariants + decision log + 审计链映射）"。本次实测四个事实决定推进顺序：

1. **kernel 里没有那些东西**：`kernel/src` 573 行，导出面只有 3 份 schema + zod 镜像 + 4 个 `parse*` + `KernelSchemaError`；对 `src/`+`schemas/` grep `invariant|dimension|transaction` **零命中**。无 invariant 引擎、无 decision log 写入器、无审计链、无维度系统、无事务原语。
2. **kernel 不在 registry 上，而且这是决定不是缺陷**：`npm view @iterate/kernel` → 404；`private: true` 且无 license 字段。既有决策（P6 §13 / P4 §33.2）= 不单独发布，随壳 bundle 内联，发布跟随 iterate monorepo 策略。⇒ M3 用**带溯源的 vendored 镜像 + `file:` 依赖**（mcp-shell 的既有先例），不等多余的外部动作。本文早期版本把这条写成"Phase B 第 0 号动作＝发 npm"，是假前置，已订正（§1-4、§9-3）。
3. **canonical 落后于镜像**：`iterate-skill/kernel` 停在 `0.1.0-draft.1`（5 fixtures），GlassPane 镜像是 `1.1.1`（9 fixtures，含冻结与读侧兼容）。`diff -rq` 实测差异仅在 `evidence-pack.ts`/`parse.ts`/`index.ts`/`evidence-pack.test.mjs` + 4 个 mirror-only fixture，**镜像是严格超集 → A-13 的修复从未回流**。
4. **文档里那条标准同步命令会当场把第 3 条炸掉**：`tools/sync-kernel.sh` 原本是裸 `rsync -a --delete`。实测会删 `fixtures/evidence-pack.ok-04-legacy-draft.json` 等 4 件、回退 `parse.ts`/`index.ts`，从而打断 `mcp-shell/src/tools.ts:729` 对 `parseEvidencePackRead` 的引用，并让版本线门禁必红。**已加三道守卫并验证**（§10；守卫 ② 的形态在 09-25 改过，见下）。
5. **守卫 ② 第一版写错了断言对象**（2026-09-25 自我订正）：我最初拿"canonical 版本 == 根版本"当放行条件，看上去严谨，实际是**拿一个不该由镜像决定的量当闸**——版本号归 canonical 的发布节奏管，而 GlassPane 侧所有位点由 `scripts/set-version.mjs` 统一压成一条线。拒掉一次合法同步（`0.1.0-draft.1 != 1.1.1`）既不保护任何东西，还会把唯一出路变成"先给 canonical 改版本号"，即为了让尺子变绿去改被测量物。改为**语义闸**：逐个断言消费者实际 import 的导出（`parseEvidencePack`/`parseEvidencePackRead`/`parseDecisionLogEntry`/`parseRecipeConfig`）在 canonical 的 `src/index.ts` 里存在，缺则拒绝并点名会断的消费者；拷贝后用 `set-version.mjs` 把镜像版本号重新压回本仓线。

建议顺序（每步单独可验收）：

1. 镜像→canonical **回流**（4 文件 + 4 fixture + 版本号），使 canonical ≥ 镜像；**✅ 已执行（2026-09-25，`iterate-skill` 本地提交 `d893045`，8 files / 426 insertions，canonical 侧 `npm test` 59/59）**。版本号按上面第 5 条的裁决**不跟随**：canonical 保留自身的 `0.1.0-draft.1` 发布节奏，镜像落地后由 `set-version.mjs` 压回 1.1.1。回流后 `tools/sync-kernel.sh` 的真实同步（非 dry-run）在两条工作树上分别验证：worktree 第一次后验闸红（`tsc: command not found`，环境缺件不是内容问题）并**如实回滚**（`git diff kernel/` 归零、版本仍 1.1.1）——那次之后补装依赖重跑，两条树**都全绿**（`mirror @ d893045`、`post-sync gates green`、跑完 `git status -- kernel` 空：镜像内容已等于 canonical，守卫放行合法同步而不制造假改动）。
2. canonical 侧补 **decision log 写入器 + 审计链映射**，并给它第一个真实生产者——那个生产者就是插件侧的 M2，故 2 与 5 互为前置，插件骨架先行；**✅ 两半都完成（2026-09-25）**：写入器与链在 canonical（`iterate-skill` 分支 `kernel/decision-log-chain`，`f40fd87` 写入器+链、`15df8d5` evidence→outcome 转录、`bb80f97` 一处 zod 前向兼容修复；canonical 测试 90/90），第一个真实生产者是 fork 侧 M2 插件（`tool.execute.after` → `appendDecisionLogEntry`）。链的语义是可外部复算的：`line_i == canonicalJson(entry_i)`、`prevEntryHash == sha256(line_{i-1})`、创世为空串，所以 `sed -n '2p' ledger | sha256sum` 就能验，不必相信写它的那段代码——fork 侧的固定点测试正是这么断言的（`openssl` 与 `node:crypto` 双路）。**schema 仍不冻结**：`decision-log-entry` 还是 0.1-draft；按 §12.2 风险 4 的对冲口径，它随真实生产者的**第一段稳定使用**转正，而不是随我写完就转。
3. **kernel 进 fork 的形态 = 带溯源的 vendored 镜像**（订正：原文这条写的是"去 private + 定 license + 发 npm"，那是把已决事项当未决项挂回用户名下）。落法：canonical（`iterate-skill/kernel`）经守卫脚本同步成 fork 内的镜像目录，`packages/opencode` 以 `file:` 依赖消费——与 `mcp-shell` 的既有先例同构（P6 §13：`file:` 出包即失联，故发布时 bundle 内联）。溯源清单进金样，`tool-surface` 把镜像目录算作**依赖**而不是"我们写的行"；将来 iterate monorepo 真把它发布成 npm 包时，换回 semver 依赖是一行的事。**是否发布仍归 monorepo 决策，但它是 M3 的可选升级，不是前置。**
4. `decision-log-entry` schema 随第一个真实生产者由 draft 转冻结（与综述 §12.2 风险 4 的既定对冲口径一致，不再无端领先）；
5. 立 fork：M1–M4 进 npm 插件包（零 patch），M5 以 opt-in patch series 进 fork，配 §6.1 三分类闸与上游 release 触发。

### 7.5 fork 形态：产品级定制（2026-09-24 用户裁决，覆盖本文早先的"薄 patch"建议）

裁决原文：**把本项目的 harness 产品做成类似 `iterate-harness` 那样的私有化定制改造 harness，而不是仅仅只做补丁。** 本文 §1/§5/§8 里"四项零 patch、fork 只承载一个 opt-in patch、逻辑全放 npm 包"的建议**作废**——那是把"省 fork 税"放在了产品目标之前。形态改为：

- fork 是一个**独立产品仓库**（`/Volumes/Eng-Dev/glasspane-harness`，base = 上游 `v1.18.32`，保留 `upstream` remote 以便逐文件同步），可以改上游任何文件、可以改品牌与默认行为、可以加自己的包与命令；
- 产品层集中在 `packages/glasspane/`（新包），上游 32 个包的**路径与包名不动**——这不是 fork 税的节约，是为了让"我们改了什么"始终可枚举（改名会让 diff 变成全树噪音，iterate 侧正是这样失去可见性的）；
- 五条薄模块 M1–M5 全部作为**产品能力**存在于 fork 内（不再区分"零 patch / 有 patch"）：M1 `gp_*` 工具面、M2 evidence 采集与审计链、M3 kernel 绑定、M4 维度感知压缩、M5 会话流内 evidence 渲染。

**仍然成立的两条不变量**（与 fork 形态无关，是产品定义的一部分）：

1. **判定性验证逻辑 100% 留在 Swift**（三条架构铁律之一）。fork 里可以有 UI、可以有编排、可以有语义层，但"这次变化是不是这次操作造成的"这类判定只能由 daemon 给出，fork 只做绑定与呈现。
2. **分叉必须可测量**。`iterate-harness` 的真实教训**不是**"改了 144 个文件"，而是"文档写 8 处定点、树里 144 处、且没有任何机器检查发现这件事"（§6.2）。所以 fork 自带 diff-surface 工具：逐文件列出与 base tag 的差异、行数统计、与金样比对，漂移即红。定制多少都不是问题，**不知道定制了多少才是问题**。

**契约测试纪律随之改写**：产品 fork 放弃了"失败必可归因于上游"这一条（我们主动改地板，归因天然混合）。替代形态是每次同步上游时跑三件事——① diff-surface 复算（我们的改动面在新 base 上还成立吗）；② 固定点测试（M1–M5 各自的行为不变量，含 §5.1 那类死钩子的运行时探针）；③ 冲突清单入 `SYNCLOG.md`。hook-liveness 闸（§6.1）保留且更吃香：它现在是**我们自己的绑定层**是否还挂在活扩展点上的检查，不只是上游漂移检查。

**同步策略**：不 rebase 历史、不 merge 上游分支。`git fetch upstream --tags` → 在临时分支上把新 tag 当成"另一个 base"重放我们的**提交集合**（fork 侧提交一律以 `[gp]` 前缀标注，`git log upstream/<新tag>..HEAD` 即完整定制清单）→ 跑上面三件事 → 记录。这样"我们改了什么"永远是可枚举的集合，而不是散在树里的既成事实。

## 8. 风险与对冲

| 风险 | 证据 | 对冲 |
|---|---|---|
| **地板正在换**：上游 v2 插件系统并行重写（`packages/plugin/src/v2/{effect,promise}`；`PLAN.md` 自陈"是实现计划不是当前 API 文档"，其目标之一"内外部插件使用同一公共 API"＝承认现在不是）；`compaction.ts` 附近自述非稳定 | 参考检出目录实存 + 调研方读 | M1–M4 放 npm 包而非 fork：地板换了只重跑契约测试，不动 patch；pin tag，只在 `v1.19.x`/`v2` 插件边界重评 base |
| **静默死亡而非响亮失败**：死钩子（§5.1）、code-mode 短路、数组顺序优先级、仓内文档写错 | 本次全树 grep 实测 | hook-liveness 测试作**必跑闸**（唯一能抓这类问题的机制）；不依赖 release notes |
| **唯一 patch 目标不稳**：`routes/session/index.tsx` 2,670 行（本次实测行数）、3 个月 15 次提交，上游有激进重排版的 `AGENTS.md` 风格规约 | 行数本次实测；churn 二手 | ~~"默认走 slot、patch ≤120 行"~~（已被 §7.5 裁决作废）。改后的对冲：M5 就在 fork 里改这个文件，但**改动面进 diff-surface 金样**，同步上游时若该文件被上游重排，冲突会显式出现在 `SYNCLOG.md` 而不是被静默覆盖 |
| **`<10%` 铁律已破且无人量**：工具面 A 实测 17.33%（§3，新口径） | 本次 LOC 实测 | ✅ 已配棘轮闸（`harness/tools/tool-surface.mjs`，进 CI `tool-surface` job，负例实测可红）；数值不改，越限状态如实记在金样里，闸只挡"没被记录的增长" |
| **状态双写**：`projects.json` 已有 TS/Swift 两份实现（§3） | 本次实测两侧路径 | 五模块硬约束"不得新增对 daemon 状态文件的旁路写"，并把"写路径唯一"做成契约测试断言 |
| **fork 退化成第二代码库**（iterate 侧已付过这笔钱，§6.2） | 本次实测 144 文件漂移，且其设计文档写"8 处定点" | ~~"只允许 series 形态"~~（§7.5 裁决作废：产品 fork 允许自由改）。真正的对冲是**可测量**：diff-surface 工具 + 金样 + `[gp]` 提交前缀清单 + 每次同步的冲突入 `SYNCLOG.md`。放弃的是"对上游 rebase 的能力"，这项代价已在 §7.5 明码写出，不允许再靠文档粉饰 |
| **MCP 零 fork 通路已存在，会稀释 fork 的必要性**：opencode 原生消费外部 MCP（`glasspane-mcp` 直接可用），只是渲染走 `GenericTool` 很丑 | 调研方读 `mcp/index.ts` + `registry.ts:286` | 把 fork 的价值锚在 (a)/(d)/(e) 三件 MCP 做不到的事上；若 (c) 最终与 MCP 通路等价，就从 fork 范围删掉，不为叙事保留代码 |

## 9. 裁决记录（原"待用户裁决"）

用户 2026-09-25 指令："什么待决，你来决定。" 逐条收口如下；**只剩第 3 条仍归用户**，因为它是本清单里唯一不可逆、且我的既有约束明确划为需点头的动作（发布）。

1. **上游坐标写不写回 PRD/综述** —— 决定：**不写**。真源是 `harness/upstream.json`（机器读、闸用它），PRD/综述按 P4 §32-6 的"综述不改写"规则保持原样，改由本方案文档承担坐标说明职责。理由：把 tag/版本号抄进散文文档正是 iterate 侧失去可见性的起点——散文里的数字不会变红，`upstream.json` 与金样会。
2. **"五薄模块"口径** —— 已被 §7.5 的用户裁决覆盖（产品级 fork，不再区分零 patch / 有 patch）。M1 已按此落地。
3. **kernel 发布**（去 `private` + 选 license + 发 npm）—— 订正：**这一条本来就不归本仓决，也不是 M3 的前置**。仓库早在 2026-09-21 就记过决定：kernel **不单独发布**，随壳 bundle 内联（P6 §13），registry 发布跟随 iterate monorepo 策略（P4 §33.2 第 1 条）。我把它当成"待用户点头的不可逆动作"挂出来，等于**伪造了一个前置**——这是本次第二条"把既成决定当待决项"的自错（第一条见 §1-4 的坐标订正）。M3 因此按 §7 第 3 条的 vendored 镜像直接落地；monorepo 哪天真发出去了，换回 semver 依赖是一行事。
4. **`<10%` 铁律** —— 决定：**配棘轮闸，不改数值**（实现与负例见 §3-1）。§3 那半个"可 grep 的约束"（工具面不得自行判定证据语义）**未实现**，转为下面的开工项，不再挂在"待裁决"里冒充已决。
5. **先做 spike 再决定 M5 默认档** —— spike 已做（§5.0，E1/E2/E5/E6 全在 pin 的树与真实 daemon 上跑过）。**M5 目标面定为 TUI**：实测根据只有两条——`toolDisplays` 是 14 个名字的硬编码集、集外一律走 `GenericTool` 的纯文本截断（§5 表 M5 行），且对 `packages/{tui,session-ui,plugin}/src` grep 渲染器注册表**零命中**。这条决定**不包含**任何"桌面/web 面不重要"的判断：那三个包会不会取代 TUI 仍是 §10 挂账的未验证项，真模型轮次一跑就要回头复核；若届时 `packages/app` 成为主面，M5 的目标文件随之移动，改的是位置不是契约。
6. **新的开工项（原 §9 没有，从 §3-1 派生）**：把"工具面不得自行判定证据语义"做成可 grep 的闸（例如禁止 `mcp-shell/src` 与 fork 的 `tool/glasspane/` 出现阈值比较、像素比对、`pass/fail` 判定字面量），配基线金样。当前状态＝**✅ 已做**（2026-09-25 M4 批）：`harness/tools/surface-semantics.mjs` + `contracts/surface-semantics.json`（棘轮式），进 `ci.yml` 的 `tool-surface` job 与根 `package.json` 的 `contracts:semantics`；三条规则（阈值比较 / pass-fail 三元-相等合成 / 证据字段比较，`!== undefined` 在场检查豁免），首次基线 **0 命中 / 15 文件**——两个工具面今天都不判证据语义；三条反向因果实测变红后还原转绿。**校准教训入账**：第一版规则把本仓 `status: "failed"` 与 `pixelDiff !== undefined` 判成命中（基线一度 6 命中），按"按主语判合成 / 在场检查豁免"收窄后回到 0——先校准规则再记基线，否则金样记的是规则的噪声。

7. **私有化：发行面改品牌、内部血缘名保留、产品面只发 CLI+TUI、npm + 一键下载基建**（2026-09-25 用户指令："harness 是 glasspane 独有，原有品牌徽标应改，模仿 iterate 生态基于 openharness fork 的私有化与定制；还包括 npm 打包与一键下载"）。产品面范围提问超时，按推荐项执行并**按决定落案**（用户随后确认"什么产品面，其他全部修掉"）：① **产品面 = CLI + TUI**（含无头 `serve`/`run`），上游 Web UI / 桌面 app / SaaS console 不发布、源码留树做血缘、Web UI 嵌入改 `--embed-web-ui` 显式开启（可回滚，默认开关与运行时降级都在）；② **改发行面不改内部标识**（`@opencode-ai/*`、`OPENCODE_*`、协议名刻意保留为血缘，由品牌棘轮按基线计数——理由同 iterate：全树洗名会让 `fork-diff` 变成全树噪音、毁掉同步能力，而用户看不出任何品牌差别）；③ 真源 = fork 根 `product.json`（发行名/bins/平台包模板/版本线 `0.1.0` 独立产品线/安装入口/12 目标矩阵/产品面边界），三道新闸分工作：`product-surface` 量**一致**（86 条，无基线）、`brand-surface` 量**是产品**（0 命中基线 + 18,796 处血缘计数只许减）、`surface-semantics` 量**不判**（§9-6）；④ 打包 = npm（`glasspane-harness` + `glasspane-harness-<平台>`，CI 直发被拒则落 npm stage 待 owner 兑现，与主仓 release.yml 同原则）+ `scripts/install.sh`/`install.ps1` 一键（npm 优先、release 资产兜底）；⑤ **外部动作已在 2026-09-25 执行完毕**（用户"其他全部修掉"授权，本机 gh/npm 均以 jingzhao-l 认证）：split 远端仓 `jingzhao-l/glasspane-harness` 建成并推送（split tree 哈希与子树逐字相等），npm 首发 **v0.1.0**（12 个平台包 + wrapper），两条安装通道端到端实测通过（`npm i -g` / `bun add -g` → `--version` 均 0.1.0）。仍需 owner 后续配置的两项：npm **Trusted Publisher**（下一次 CI 发布要走 OIDC + staged 兜底）与 release lane 的 runner 资产构建。

## 10. 本次做了什么、还有什么没验

**仓库内改动（两批，都可回滚）**：① `tools/sync-kernel.sh` 加三道守卫 —— ① 删除守卫（rsync 干跑列出会被删的 mirror-only 文件即拒绝，remedy 点名"回流"与 `--allow-deletions` 两条出路）；② **消费者契约守卫**（逐个断言 `mcp-shell` 实际 import 的导出在 canonical `src/index.ts` 存在，缺则拒绝并点名会断的消费者；同步后由 `set-version.mjs` 把镜像版本压回本仓线。初版这里是"版本线相等才放行"，已按 §7 第 5 条订正——那条闸拒的是合法工作，保护的东西另有其人）；③ **同步后自验不过即回滚**（跑 check-version + build + kernel/mcp-shell 两套件，红则 `git checkout -- kernel && git clean -fdq kernel` 并声明已回滚）。实测三条都成立：对真实 canonical 跑 `--dry-run` 与真实调用**均 exit 1，且 `git status -- kernel` 零变更**（拒绝分支可执行、失败不写盘）；用"与镜像等价的合成 canonical"跑 `--dry-run` **通过**（守卫不是永假拒绝）。09-25 改守卫 ② 后又重验了三条路径：抽掉 `parseEvidencePackRead` 的假 canonical → 拒绝并输出 `Consumers that would break: mcp-shell/src/tools.ts`；后验闸红 → 回滚且 `kernel/` 零 diff；真实 canonical → 全绿。**回流本身**（§7 顺序第 1 步）也在 09-25 落地为 `iterate-skill d893045`，跨仓提交不再挂账。② **新开 `harness/` 目录**承载工具面 B 的仓库侧资产：`upstream.json`（上游坐标真源）、`tools/hook-liveness.mjs`（契约闸，`--check/--probe/--offline/--record` 四模式）、`contracts/hook-liveness.json`（金样）、`README.md`；并接进 `.github/workflows/harness-contract.yml`（每周解析上游最新 release → 下载该 tag → `--probe`，漂移即红＝冻结升级；手动输入的 tag 先钳成 `vMAJOR.MINOR.PATCH` 形状再用）、`ci.yml` 的 `install-gate`（离线自洽）、根 `package.json` 三个 `contracts:harness*` 脚本。因果验证跑在 `harness/` 的**临时副本**上（不污染仓库）：绿路径通过；把金样伪写成"`permission.ask` 是活的"→ `--check` 与 `--probe` 双双 exit 1；金样缺失 → exit 2 并指名 `--record`；`--record` 重跑结果与仓内金样**逐字节相同**（可复现，不依赖时间序）。`mcp-shell/`、`engine/`、`kernel/` 的代码与 schema **一行未改**；daemon socket 方法表未扩、无新错误码。

**§9 收口批次（2026-09-25）**：`harness/tools/tool-surface.mjs` + `contracts/tool-surface.json`（工具面占比棘轮，口径与负例见 §3-1）进 `ci.yml` 新 job `tool-surface`，根 `package.json` 加 `contracts:surface`；`harness/README.md` 重写（fork 已进仓，早期"上游代码不进仓"那一节连同 `.upstream/` 的旧位置一起作废，改为 `.external/opencode` + subtree split 形态，并把三把尺子各自的事故模型与负例清单写全）。§9 从"待用户裁决"改为**裁决记录**。⚠ 该批的 §9-3 当时写成"kernel 发布仍归用户"，**次日即被用户问倒**：仓库在 2026-09-21 就记了"kernel 不单独发布"（P6 §13）＋"registry 发布跟随 iterate monorepo 策略"（P4 §33.2），我把既成决定当成了待决项，凭空造出一个前置。现已按 §1-4/§5 M3 行/§7 第 3 条/§9-3 四处订正，M3 的落地形态改为带溯源的 vendored 镜像 + `file:` 依赖（同 mcp-shell 先例）。教训：**收口"待决项"时必须先 grep 既有执行记录**，否则文档会把已修过的东西再挂一遍。

**M3+M2 批次（2026-09-25，Phase B 的内核侧与生产者侧同批闭环）**：canonical 内核长出 decision log 写入器与审计链（`iterate-skill` 分支 `kernel/decision-log-chain`：`f40fd87` / `15df8d5` / `bb80f97`，canonical 90/90），镜像经守卫脚本跟到 `kernel/`（本仓 `sync(kernel): repo@bb80f97`）与 fork 的 `vendor/kernel/`（新尺子 `kernel-vendor` + 溯源金样）。fork 侧新增：绑定层 `tool/glasspane/kernel.ts`、内部插件 `plugin/glasspane-decision-log.ts`（`plugin/index.ts` 2 个 hunk）、固定点测试 35 条、运行时脚本 `script/glasspane-e7-ledger.ts`；`bun test` 35/35、`tsgo --noEmit` 0 错、`serve` 起来 6 个 `gp_*` 工具在注册表且插件装载无错。改动面 `fork-diff`：`6630 identical / 2 edited / 33 added / 0 deleted`（其中 23 added 是 vendored 内核）。占比账：engine 18,335 / A 3,859（16.60%）/ B 1,058（4.55%），排除项（测试 467 行、vendored 1,150 行）打印并进金样。

**本批发现的产品缺陷（不在本线修，只登记）**：正在跑的 daemon 对 `gp_last_evidence` 无论带不带 `operationId` 都回 `GP_E_NO_EVIDENCE`，而 `~/.glasspane/evidence/` 里有 **582 个档案**（539 个 `0.1-draft` + 43 个 `0.1`；取的最新那个 `pixelDiff.bounds` 为 `null`，内核读侧完全接受）。也就是**引擎写下的档案它自己回放不出来**——`resolvedPack`（`EngineCore.swift:1924-1940`）明明写了落盘兜底，说明这台 daemon 的 store 指向与写入端不一致（`glasspaned` 的 `--state-dir`/项目档案目录选择逻辑，`main.swift:746-784`）。这是 engine 侧的活，本线只做两件事：E7 把它打成 `NOTE FINDING`（可复现脚本在仓内），以及**决策链不依赖 daemon 的内存历史**（改吃落盘字节），否则 M2 的运行时会静默地一条都不记。

**同一批被自己抓出来的四个错**（每条都补了能变红的控制，详表在 `harness/README.md` 与 fork 的 `SYNCLOG.md`）：守卫① 的参数化把 `rsync -an` 写成 `-n`，删除检测静默失效；`tool-surface --record` 会在归因失败时给一个从没量过的数定基线；排除测试的正则匹配了空串导致"所有文件都是测试"；以及回滚用 `git clean` 在首次 vendoring 时删掉了自己刚写的 23 个文件（触发它的只是 `bun: command not found`）。前三个属于"闸看着在跑其实不跑"，第四个属于"闸比它防的故障更具破坏性"——两类都在这条线上反复出现过，所以每次都补了反向控制而不是只改代码。

**M4+M5 批次（2026-09-25，五薄模块收口）**：**M4 落地**（§5 M4 行从"零 patch、未验"变成有实现有证据）——内部插件 `src/plugin/glasspane-compaction.ts` 绑 `experimental.session.compacting`，用 `client.session.messages` 拉会话，只把引擎/内核已写下的证据锚点（opID/outcome/台账序号与哈希）转录进压缩上下文；**维度系统在本 pin 的内核里不存在**（导出面实测；维度系统按 Phase A 首发范围属 iterate 侧节奏），所以"优先压缩无关维度历史"那半如实挂账、不发明维度，缺席以 `calls vs decisions recorded` 的算术呈现。**E8 运行时脚本**（`script/glasspane-e8-compaction.ts`）用 mock provider + 本树 `serve` + 真实会话 + `POST /session/:id/summarize`，在 **provider 边界**断言"做摘要的那个请求带着注入块"，全绿；同一会话顺带结掉 M2 的一条挂账（宿主确实走到 `tool.execute.after`，skip 分支的 note 落进 part metadata）。**M1 固定点补齐**（此前 M1 只有运行时证据，违反 §7.5"每个模块都要有行为不变量"）：`test/tool/glasspane-surface.test.ts` 6 条，glasspane 固定点合计 **57/57**。**§9-6 开工项落地**：`harness/tools/surface-semantics.mjs` + 棘轮金样（首次基线 0 命中 / 15 文件，三条反向因果实测变红），§3 的口径至此完整。**自伤两处**：`daemon.ts` 先连后挂监听器导致死 socket 的 `'error'` 在监听前发出时 Promise reject（改为先挂监听器再 `connect`，因果 5/5 复跑验证）；`ci.yml` 的 `kernel-vendor` step 曾被复制成两份（`check-workflows.mjs` 查 job 键不查 step，已去重）。**账**：`fork-diff` 6628/6669 identical、4 edited、37 added；`tool-surface` 面 B 1,251→1,867 行（7.76%，仍 <10%）。**未跑/未验**：真模型轮次（`ctx.ask` 权限卡观感、`truncate.output` 对大 evidence 包的真截断、M4 在真模型下的压缩质量、真 TUI 会话里 M5 的观感）；整包 `bun run build` 未重跑；fork opencode 包**全量** `bun test` 的 51 条失败经 `git stash -u` 对照证明**与 M5 基点逐条相同**（全在上游 CLI 子进程 / grep / tui thread 面，与本批无关，照实挂账）。


**私有化批次 D（2026-09-25，项目目录改名 + 全量测试真因）**：项目级 `.opencode/` → **`.glasspane-harness/`**（9 处：v1/v2 两套解析器、v1 循环与 TUI 扫描的目录名过滤器、plugins/agents/plans/themes/tui.json 四个写路径、plans 权限两条并列、mcp 候选与 v1/v2 两份 customize 提示词在 C′ 已做）。**同层共存谁赢是实测的**：`mergeDeep(target, source)` 用 remeda 实跑确认"后者覆盖前者"，所以解析器目标顺序写成"遗留在前、产品在后"——反过来会让遗留目录静默压过产品自己的配置。新增固定点 `test/config/project-config-dirs.test.ts` 6 条（3 条行为：只有遗留/只有产品/两者同层时产品在后；3 条结构：三处目录名过滤器接受产品名），**反向控制已验**（顺序写反 → 同层用例变红）。**"51 条上游全量测试失败"的真因查清了**：① 头号根因是本机 TLS 拦截——测试运行期从 GitHub 下载 ripgrep，带上钥匙串 CA 束（`NODE_EXTRA_CA_CERTS`，与 A 批 build 同一个坑）后 grep/glob/acp 全绿；② 剩下的子进程类（run/serve/mcp-add/help-snapshots/httpapi-file/tui-thread）**隔离跑全过**（10.6s/条），批量并行时撞 30s 默认超时——不是代码缺陷，是本机负载下的超时；串行 + 120s 超时的复跑结果见 SYNCLOG。教训入账：**"全量红"先分环境与代码两类，再谈修**——上一次是把 51 条当成"上游旧账"挂着的，实际上其中一半当场可解。

（身份/许可/stars/默认分支/最近 4 个 release 日期）；`raw.githubusercontent.com @ v1.18.32` 逐行读 8 个关键文件；v1.18.32 tarball **全树 grep**（死钩子结论、renderer registry 缺失、`experimentalCodeMode` 短路、各文件行数）。

**私有化批次 A/B/C（2026-09-25，产品身份 → 安装器 → 品牌闸）**：A 批把产品改名 `glasspane-harness` 并换掉会替别人干活的三条路径（publish 推 ghcr/AUR/anomalyco homebrew tap、curl 自升级执行 `opencode.ai/install`、console 部署基建），B 批建一键安装器与 `product-surface` 一致性闸（86 条，反向因果五条 + 两条校准负例），C 批建 `brand-surface` 品牌棘轮（0 命中基线 + 血缘计数）与三条剩余固定点（超尺寸帧在带失败、`maxDepth` 1–10 由 schema 强制、code-mode 旗标不藏工具面——固定点 **57 → 60**）。**账**：`fork-diff` 6539/6675 identical、36 edited、43 added、**57 deleted**（上游 26 工作流 + 20 locale README 等，逐类记账在 SYNCLOG）；`tool-surface` 面 B 1,867 → 2,098 行（8.64%）。**同时结掉一个含糊挂账**：TUI `attachments` 渲染出口——现有六个 gp_* 工具今天没有任何一个产出 attachment（grep 为零），"没有出口"还不是缺口，capture 类工具落地那天才成立（届时这条重新变真）。**未跑/挂账**：整套安装流程未端到端跑（npm 上还没有这个包、远端仓不存在——外部动作）；musl/baseline 目标已随首发本地构建并发布到 npm（CI lane 仍只跑 5 个原生目标）；项目级 `.opencode/` 目录 20 处解析点未改名（必须带遗留回退，下一批开工项，现状照实计入血缘基线）；code-mode 固定点是结构性的（真跑 `ToolRegistry.tools()` 需整套服务图，未搭）；真模型/真 TUI 观感、51 条上游全量测试失败（旧挂账，与本线无关）照旧。

**未验证（如实挂账）**：

- **opencode 本体已运行过**（`serve` 与 `--mini --demo`，pin `v1.18.32`，见 §5.0），但**没有跑过真模型轮次**。因此仍未定：`truncate.output` 对大 evidence 包的实际截断行为（C 批已把**传输层**那一半变成固定点：>4 MiB 帧在带内回 `GP_E_PAYLOAD_TOO_LARGE` + remedy；宿主截断那一半仍待真轮次）、`attachments` 在 TUI 是否有渲染处（C 批核实：现有 gp_* 工具零 attachment，今天不是缺口）、TUI（非 mini）是否存在我没找到的自定义 ToolPart 渲染路径、`packages/app`/`session-ui`/`desktop` 是否会取代 TUI 成为主面（那会移动 M5 的目标文件）、以及 `chat.params`/`chat.headers`/`tool.execute.*`/`experimental.session.compacting` 在真轮次里的派发形状（静态有站点，运行时未观测）。
- 权限路径的运行时证据只到"旁证"级：`--demo` 合成事件、不经 `Permission` 服务（§5.0 边界）。
- hook 与触发点的对应只做了静态字面量匹配；`Hooks` 里 `config`/`auth`/`provider`/`tool`/`dispose` 属初始化成员而非 trigger，不计入死钩子判定。
- 上游是否愿意把 M5 收编为第一方特性（收了 patch 就消失）：`CONTRIBUTING.md` 未见相关口径。
- churn（15 commits/3mo）、Go 版归档、`crush` 无血缘等结论属调研方二手，本次未独立复算。
- 真机三项沿用 2026-09-22 审计 §7.4：`.c6_smoke.py` 未复跑；桥 `capture_succeeded` 真 lldb 形态未实测（需开发者工具席位）；`SettingsModel.swift:208` 告警未动（本次 build 另见 `main.swift:836` 同类一条）。
- Z4.5 正产物三态（需一次性开 Graphics Inspector 重跑 `run_spikes2.py`）。
- C27/C29'（审美校准、AE 滚动 AB）同属生死断言梯队，本次未查进度。
