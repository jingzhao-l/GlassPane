# GlassPane ⇄ iterate 双向集成 · 实测状态 2026-10-25

> 这份文件只做一件事：把综述 §8.5 那张 R40 表**逐行**对着代码字节记一遍现状，并写明每一行
> "还只是陈述、没被量到"的那半。此前它没有被任何台账记着（`grep ④ specs/*.md docs/*.md` 零命中），
> 于是"五场景全落"这类说法只能靠聊天记录支撑。判据规则：只认文件字节与自己跑的读数，不认提交信息。
> 历史结论不改写（`specs/**` 是验收台账），本文件是新增的一份，日期即版本。

## 分支与发布状态

| 仓 | 分支 / 提交 | 发布 |
|---|---|---|
| iterate-skill | **已并 main 并推送**：`origin/main` = `829fda39`（本会话 7 笔：④ 配方+闸、③ 链路与读者、终端那扇门、语料 pin 追到 0.1.10） | 未取号（harness 侧 Python 包随 iterate-skill 发布线走；2.10.0 由发布线在 10-24 取走） |
| GlassPane（含 harness） | **已并 main，未推**：写入这一格时量到 main = `b1d5ac7e`、`origin/main` = `9acda519`、`ahead=18`；我的 7 笔是 `6e630b05`/`e4a312cc`/`7fb73921`/`b4c5b4cb`（分支内容）+ `c4556a9b`（合并）+ `4b44a33b`（金样）+ `e8a14300`（台账），其余 11 笔属发布线。读的时候先复量：`git -C /Volumes/Eng-Dev/GlassPane fetch origin && git -C /Volumes/Eng-Dev/GlassPane rev-list --count origin/main..main` | 未取号（harness 0.10.5 / 父仓 1.21.0 已由发布线落地，本批字节不在其中） |

推不推的判据不是保守：**GlassPane 本地 main 领先 origin 的那些笔里，多数属并行那条发布线**（写入这格
时是 11 比 7），替他们推出去等于代他们发布（`不可代推`是这条仓的既有纪律）。
`release-artifact` 那条"发布物 == 主干"的等式此刻仍红（见下），修它的下一步是 re-split + 取 0.10.6，
同样归发布线。

## 逐行现状

| # | 场景 | 状态 | 生产端 + 消费端 + 能红的闸（证据路径） | 还只是陈述、没量到的那半 |
|---|---|---|---|---|
| ① | invariant 失败 → 运行时重验 | **接通** | 触发点 `harness/iterate-harness/src/iterate_harness/tools/iterate_tools.py:503-504` 在拥有 session 的 loop 上 await；发送 `iterate/reverify_trigger.py`；逐 item 分类 `iterate/glasspane_reverification.py:relay_answer`；GP 侧就是既有 `gp_last_evidence`/`gp_diagnose`，无需新代码 | 重验=只读回看。引擎对"重跑配方步骤"永远回 `deferred`（这是它的既有纪律，不是本批修的） |
| ② | 第 N 维审查 → 压缩感知维度 | **接通（不对称已改成读数）** | iterate 侧写计划 `iterate/run_plan.py:write_run_plan` → `tools/iterate_tools.py:381`；压缩排序 `services/compact/__init__.py:_order_by_dimension_verdict`；fork 侧读计划 `packages/opencode/src/tool/glasspane/kernel.ts:readRunPlan(env, projectDirectory)`（显式 `GLASSPANE_RUN_PLAN` 或工程自己的 `.iterate/run-plan.json`）+ 丢弃排序 `src/plugin/glasspane-compaction.ts:selectAnchors` + 残余不对称的读数 `collectEvidenceAnchors.declaredWithoutAnchor`（块里打印）；面 A 槽 `mcp-shell/src/dimension.ts` + `tools.ts`/`http-gateway.ts` 两道门 | 只有出 `evidencePack` 的方法（`last_evidence`）能把声明维度带进锚点；其余四个工具上声明的维度到不了压缩——**根在 Swift 侧证据发射面**，本行现在给的是它的宽度读数而不是解释 |
| ③ | evidence 原生入决策日志、哈希链互通 | **接通（对面台账可被项目记为默认）** | 两侧 writer 对同一组 draft 输出**逐字节相同**（sha256 `eaa9dc7d…`）；样本双向钉住：`iterate-harness/tests/fixtures/glasspane_chain_ts_written.jsonl` ↔ `harness/…/packages/opencode/test/fixtures/glasspane-chain-python-written.jsonl`，各自被对方格式的读取器整链验通 + 篡改必红；跨账本读者 `iterate/glasspane_recipe.py:fix_proof`，路径由 `resolve_ledger`（`env` → `.iterate/glasspane-ledger.json` → 项目台账）给出，链接动作 `/iterate glasspane-ledger <绝对路径>` 或 `ih iterate glasspane-ledger`，钉 `genesisEntryId` ⇒ 被替换的链回 `LEDGER_LINK_E_STALE` | 默认路径仍是两个文件；链接把"读哪一本"变成一次项目动作而不是每次导出环境变量，但**一本都不合并**——合成本一本仍是产物线的设计决定 |
| ④ | 修复完成 → 挂 invariant 复核 → 通过才进重验 | **接通（闸有读者，两扇门）** | 配方交接 + 判定闸 `iterate/glasspane_recipe.py`（`RECIPE_E_*` / `RECIPE_GATE_E_*` 六条码），发布点每条路径带 `recipeStepGate`，且闸随那一轮的账本行落盘；读者两条：session 内 `/iterate gate` 与终端 `ih iterate gate`（两面措辞同源、退出码各自——由 `test_the_terminal_surface_and_the_slash_surface_answer_the_same_thing` 钉住）；`recipeSteps` 被写成**禁令**（`reverification_targets` 无该参数，签名也被断言钉住）；配方文档按 `glasspane.recipe/0.1-draft` 校验，语料 `tests/kernel_fixtures/recipe-config.ok-01.json` | 契约只在复核**失败**时生成请求（两份实现一致），所以"带权限的重验请求"按构造不存在 → 闸是**报与拦**，进程内没有东西强迫驱动配方的人；且两侧都没有配方执行器，闸答"能否推进"，不答"下一步是哪步"（进度指针须由动手修的一侧写进账本） |
| ⑤ | AE 判定按 provider 契约，两侧同一契约消费 | **接通** | 两侧注册 + 消费（fork `src/tool/glasspane/providers.ts`→`index.ts`；面 A `mcp-shell/src/providers.ts`→`tools.ts`/`http-gateway.ts`；Python `provider_registry.py`→`glasspane_reverification.py`）；跨侧对账 `harness/tools/provider-surface.mjs`（跑两侧真代码，三条规则 + 四发控制 `provider-surface-selftest.mjs`，已排在 `bun install` 之后） | 面 B 比面 A 多 `diagnose-pixel`/`diagnose-probed` 是正当不对称，但它是**记录**而非推导——新增单边方法时必须有人重记金样 |

## 这一轮把哪些"看起来完成"判成没完成

- **CI 排序**：`provider-surface --check` 与它的四发控制一度被放在 `Install the fork workspace` **之前**。
  干净检出里两侧 `providers.ts` 的 import 解析不到 `iterate-kernel`，尺子如实回答 exit 2「测不了」，
  于是那一步恒红——和 2026-10-16 kernel-pin 那次是同一个形状，修法也一样（挪到安装之后）。
  分支未推，CI 从没跑过这段，是复核读 `.github/workflows/ci.yml` 的步骤顺序抓出来的。
- **跑不到的拒绝分支**：`recipeStepGate` 一度只挂在 pass 分支，于是 `RECIPE_GATE_E_GATE` /
  `unmeasured` 那几条在生产上永远不会被算出来。现在闸在 `_prepare` 里一次算好、挂在每条会发布的路径上。
- **反了的语义**：第一版让失败请求带上配方步骤，读起来像 ④ 闭合，实际违反 ④ 自己要的那条
  （"复核没通过就别让对面重跑"）。改成禁令 + 两条用例钉住。
- **注释替代码说话**：`mcp-shell/src/dimension.ts` 声称测试比过 `kernel/schemas/*.schema.json`，实测没比；
  本页末段（`harness/glasspane-harness/docs/kernel-integration.md`）一度仍写"R40 还等内核的 API"。
  两处都改成了实测状态，且改的是代码/测试而不是把注释删掉换绿。
- **变异自己不会红**：P8 那一发锚点里写了 `\n`，在单引号里不是换行 → 变异没落地 → 那一发报了个
  "绿的失败"。现在电池对"锚点缺失/歧义"直接 exit 3 并让整发判负。

### 第十九次会话补记（同日）· 又判成"没完成"的五条，都是上一轮自己写的

- **`bun run typecheck` 在主干上是红的**，红在上一轮我新加的两条时间序断言里
  （`selection.shown.map(a => a.operationId.slice(-2))`，`operationId` 可选 ⇒ TS18048 ×2）。
  上一轮那句"闸全绿"不是假话也不是谎话，是**名单抄错了顺序**：fork CI 把四个包的 typecheck 排在
  `bun test` 前面，我只跑了后者。本轮起名单按 CI 的步骤顺序抄。
- **我写进 CI 的那一步把主干判红了**：`.github/workflows/ci.yml:398`（provider-surface 自测）的
  多行 `run:` 体缺 `set -euo pipefail`，1.21.0 给 `check-workflows` 补的三条新规则之一正是为此而设，
  于是 `GitHub Actions workflows compile` 这条 job 在 main 上红（run 40156814139 逐字指到那一行）。
  两条同时成立：我当时在本基线上跑 `check-workflows` 是 rc=0（规则还不存在），而分支从没推过、CI 从没
  跑过它。**"在我基线上绿"不等于"落到长过新规则的 main 上绿"**——这与 10-16 的 kernel-pin、
  10-23 的"判据不在本机"是同族。并行那条线随后落了更完整的一笔（`0e77af88`：补 `rc=0` 显式初始化 +
  "自测必须打印它自己的通过句"那条正向判据），已在 `5964aed6` 里合上，本会话那一行被它的版本取代。
- **`ih` 终端里根本没有那两扇门**：上一轮交付 ④ 的读者时只写了 session 内的 `/iterate gate`，
  真机敲 `ih iterate gate` 得到 `No such command 'gate'`——Typer 那面对 status/log/trend/agents 都配了
  孪生命令，我这两条没有。"有读者"这句因此只完成了一半。本轮补终端两条，并把两面共用的措辞收成
  一份（`format_recipe_error`、`render_link_success`、`link_ledger_now`），退出码按面分、句子按面同，
  由 `test_the_terminal_surface_and_the_slash_surface_answer_the_same_thing` 逐字钉住。
- **`from datetime import UTC` 是 3.11 的**，我把它同时写进了 `commands/iterate.py`（src）和一个
  测试文件；前者被 `tests/test_py310_compat.py` 当场抓住，后者**没有任何东西在抓**——那条闸只扫
  `src/`，而测试文件里的 3.11-only 名字在 3.10 上是收集期 ImportError，整文件 28 条用例会静默消失。
  本轮把闸扩到 `src/` + `tests/` 两个根（并给"整模块导入"补 guarded-import 豁免，因为
  `try: import tomllib / except ModuleNotFoundError: import tomli` 是本仓既有写法，误报会逼人删兜底），
  两条新控制各点名变红。
- **一条"本机红、CI 绿"的读数**：`patched-deps --check` 在本机报
  `@standard-community/standard-openapi@0.2.9 declared but absent from bun.lock` 退 1，而同一棵树在
  CI 上判 `△` 退 0——差异不在代码，在本机躺着 2026-09-25 那次安装留下的残骸目录，而锁里这个包**一个
  版本都没有**。这条不是本批引入的，也不该由本批修（判据把"在不在图里"数目录而不是问锁）；发布线随后
  从判据侧修对了（`c9c0807d`，新增 `lockedGraph()` 只认 `bun.lock` 的 `packages` 块 + 拒绝空清单），
  合并树上的读数是 `18/19 … 1 not in this graph` 退 **0**。本会话对它做的唯一一件事是别去动锁、
  别删声明、别放宽尺子。

## 实测读数（2026-10-25，本机）

- iterate 分支：`pytest tests` 3037 passed / 6 failed / 6 skipped——这 6 条在 `origin/main`
  干净工作树上同样红（`test_engine/test_query_engine.py::test_subagent_stop_hook…`、
  `test_tasks/test_manager.py` 三条、`test_tools/test_bash_tool.py`、`test_tools/test_integration_flows.py`），
  属本机环境而非本批引入；`ruff check src tests scripts` 0；`mypy src` 269 文件 0 问题；
  `scripts/check_kernel_fixtures.py`（离线与 registry 两模式）10 文件对 pin 逐字节一致；十发反向变异
  每发具名变红并按 sha 核回。
- GlassPane 分支：12 把尺子各自 rc=0（`fork-diff` 4640/6733 · 285 edited · 101 added · 1707 deleted、
  `tool-surface` 面 A 11422 LOC/22.10% 未动、面 B 10667/+138、`brand-surface` 9607/3317、
  `product-surface` 6527 一致/0 问题、`hook-liveness` 21 钩子无漂移、`kernel-pin` 0.1.10 + 26 文件、
  `kernel-conformance` 16 语料、`provider-surface` 及其四发控制、`rulers-selftest`、
  `check-kernel-corpus`/`check-version`(1.20.2)/`check-doc-links`/`check-workflows`）；
  fork 定点名单 204 pass / 0 fail；`mcp-shell` `node --test test/*.test.mjs` 621 pass / 0 fail。
- 端到端回显链第一次有真读数：registry 的 `glasspane-mcp@1.20.2`（隔离前缀）× 本机活 daemon × 真
  opID → 2 个 content item、`echoed_dimension="security"`、见证写入、矛盾声明
  `KERNEL_E_DIMENSION_CONTEST`。同一走查指本机全局那份（1.6.2）时报
  `GP_E_BAD_PARAMS … Unrecognized key(s) in object: 'dimension'`——旧壳不是不回显，是不接受这个入参。
- 第十九次补记（合并树 `c4556a9b` + 金样笔 `4b44a33b`，本机）：
  - iterate 侧（rebase 到 `origin/main` 之后复跑）`pytest tests` **3067 passed / 6 failed / 6 skipped**
    ——红的那 6 条与上一段同一组、指向的面本批未碰；`ruff check src tests scripts` 0；
    `mypy --strict src` 269 文件 0；`scripts/check_kernel_fixtures.py` 两模式各 10 份对上
    **0.1.10**（清单此前写 0.1.9，本轮先证字节没漂再追标签）；`tests/test_iterate/test_glasspane_ledger_link.py`
    28 条 + `tests/test_py310_compat.py` 7 条；十五发反向变异各点名变红并按 sha256 核回。
  - fork 侧：九份定点名单 **209 pass / 0 fail / 1074 expect**（`bun test --timeout 30000`），
    `bun run typecheck` rc=0（本轮第一件事是它原本是红的）；`fork-diff --check` rc=0
    `4640/6733 · 285 edited · 101 added · 1707 deleted`；`tool-surface` 面 B 重记到 **10779**
    （+42 全在 `glasspane-compaction.ts`），面 A 11422 / 22.09% 未动；`surface-semantics` 23 文件 0 命中；
    `brand-surface` 9607/3317；`product-surface` 6527/0；`kernel-pin` 0.1.10 + 26 契约文件；
    `kernel-conformance` 16 份语料；`provider-surface` 与其四发控制 rc=0（脏树上它拒绝开跑，rc=2 那次
    就是这个拒）；`check-version` 1.21.0；`check-doc-links` 32 份 / 238 条；`check-workflows` +
    `--self-test` 22 条各验其失败；`patched-deps` 在合并树上 **rc=0**（`18/19 … 1 not in this graph`）。
  - 端到端回显链**第一次跑在本机全局那份壳上**：`npm i -g glasspane-mcp@1.20.2 glasspane-install@1.20.2`
    之后（registry `latest` 就是 1.20.2，1.21.0 只打了 tag、npm 那格还没发），
    `/usr/local/bin/glasspane-mcp` × 本机活 daemon × 真 opID `op_01M35PAMYNNPJRNCCM6Q2C34XQ` →
    2 个 content item、`state=answered`、`echoed_dimension="security"`、见证 `{'op…': 'security'}`、
    同意 → None、矛盾 → `KERNEL_E_DIMENSION_CONTEST`。上一段记的"本机全局 1.6.2 拒收 `dimension` 入参"
    从此不再是本机状态。`glasspane-harness@0.9.0` 那一份全局**没动**：它不在回显链上，且发布线可能正在
    用它做真机走查。
  - 终端那两扇门的真机读数（隔离目录，链取真内核字节那份夹具）：链接后 `resolved from: link` +
    `chain: verified, 3 entries, 1 of them a passing outcome carrying an operation id` +
    `genesis pinned: dl_AAAA…`；`gate` 答"那是缺席，不是通过"；改过一个字段的链拒绝并**退 1**、
    点名 `LEDGER_LINK_E_LEDGER_CHAIN`、报断在第 2 行，`.iterate/` 零写入；链接文件 `0600`、父目录 `0700`。

## 交给发布线的下一步（本会话不执行的那两格已经做完，剩的是取号）

已执行（本会话）：

```bash
# iterate-skill：分支 ff 进 main 并推送 —— origin/main = 829fda39
git -C /Volumes/Eng-Dev/iterate-skill merge --ff-only it-bidi-20261024 && git -C /Volumes/Eng-Dev/iterate-skill push origin main
# GlassPane：分支以合并笔进 main（本地），金样随后在同一棵树上重记
git -C /Volumes/Eng-Dev/GlassPane merge --no-ff gp-bidi-20261024   # = c4556a9b，金样 = 4b44a33b
```

仍归发布线（不是"我没时间"，是**不该由这条会话做**）：

1. 推 GlassPane 的 main —— 本地领先 origin 的那一叠笔里多数是发布线自己的字节（写入这格时 18 笔中
   占 11），代推＝代发布。要不要连他们的一起推，由那条线自己决定；先复量
   `git -C /Volumes/Eng-Dev/GlassPane rev-list --count origin/main..main`。
2. `git subtree split --prefix=harness/glasspane-harness -b split/glasspane-harness` + 快进推送，
   再切 **harness 0.10.6** 补上"发布物 == 主干"。`release-artifact --check` 在合并树 `c4556a9b` 上
   量到的读数是 `0 agreement(s) / 2 problem(s)`（trunk `1be98d92` 对 v0.10.5 的 `dea2c83a`），
   并额外警告"发布物里有 85 行 / 5 个文件主干没有 ⇒ 今天重切会覆盖它们"；那之后主干又长了发布线的
   若干笔，数字只会更大，取号前须重跑一次再记。
3. 父仓的下一个号（1.21.x）由发布线按它自己的判据取。

`provider-surface` 那步 CI 根因的修复已由发布线落进 `5964aed6`，本会话那一行被更完整的版本取代，
两边不留两份结论。
