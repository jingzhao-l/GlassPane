# GlassPane ⇄ iterate 双向集成 · 实测状态 2026-10-25

> 这份文件只做一件事：把综述 §8.5 那张 R40 表**逐行**对着代码字节记一遍现状，并写明每一行
> "还只是陈述、没被量到"的那半。此前它没有被任何台账记着（`grep ④ specs/*.md docs/*.md` 零命中），
> 于是"五场景全落"这类说法只能靠聊天记录支撑。判据规则：只认文件字节与自己跑的读数，不认提交信息。
> 历史结论不改写（`specs/**` 是验收台账），本文件是新增的一份，日期即版本。

## 分支与发布状态

| 仓 | 分支 / 提交 | 发布 |
|---|---|---|
| iterate-skill | `it-bidi-20261024`，4 笔，`behind=0` | 未取号（2.10.0 由发布线在 10-24 取走） |
| GlassPane（含 harness） | `gp-bidi-20261024`，10 笔，`behind=0` | 未取号（harness 0.10.5 / 父仓 1.20.2 均已由发布线落地，本批字节不在其中） |

两条分支都在隔离工作树上完成、**未推 main**：另一条会话此刻正在版本线上跑，
`harness/tools/release-artifact.mjs` 要求"发布物 == 主干"，把新代码并进主干而不取号那把尺子必红。
合并与取号归版本线（命令见文末）。

## 逐行现状

| # | 场景 | 状态 | 生产端 + 消费端 + 能红的闸（证据路径） | 还只是陈述、没量到的那半 |
|---|---|---|---|---|
| ① | invariant 失败 → 运行时重验 | **接通** | 触发点 `harness/iterate-harness/src/iterate_harness/tools/iterate_tools.py:503-504` 在拥有 session 的 loop 上 await；发送 `iterate/reverify_trigger.py`；逐 item 分类 `iterate/glasspane_reverification.py:relay_answer`；GP 侧就是既有 `gp_last_evidence`/`gp_diagnose`，无需新代码 | 重验=只读回看。引擎对"重跑配方步骤"永远回 `deferred`（这是它的既有纪律，不是本批修的） |
| ② | 第 N 维审查 → 压缩感知维度 | **接通（不对称已写明）** | iterate 侧写计划 `iterate/run_plan.py:write_run_plan` → `tools/iterate_tools.py:381`；压缩排序 `services/compact/__init__.py:_order_by_dimension_verdict`；fork 侧读计划 `packages/opencode/src/tool/glasspane/kernel.ts:readRunPlan(env, projectDirectory)`（显式 `GLASSPANE_RUN_PLAN` 或工程自己的 `.iterate/run-plan.json`）+ 丢弃排序 `src/plugin/glasspane-compaction.ts:selectAnchors`；面 A 槽 `mcp-shell/src/dimension.ts` + `tools.ts`/`http-gateway.ts` 两道门 | 只有出 `evidencePack` 的方法（`last_evidence`）能把声明维度带进锚点；其余四个工具上声明的维度到不了压缩——要收它得动 Swift 侧证据发射面 |
| ③ | evidence 原生入决策日志、哈希链互通 | **接通（两本账仍分居）** | 两侧 writer 对同一组 draft 输出**逐字节相同**（sha256 `eaa9dc7d…`）；样本双向钉住：`iterate-harness/tests/fixtures/glasspane_chain_ts_written.jsonl` ↔ `harness/…/packages/opencode/test/fixtures/glasspane-chain-python-written.jsonl`，各自被对方格式的读取器整链验通 + 篡改必红；跨账本读者 `iterate/glasspane_recipe.py:fix_proof` | 默认路径仍是两个文件（fork `~/.local/share/glasspane-harness/decisions.jsonl` vs 项目 `.iterate/decision-log.jsonl`）；合成本一本要人显式交 `GLASSPANE_DECISION_LOG` |
| ④ | 修复完成 → 挂 invariant 复核 → 通过才进重验 | **接通（形状与综述不同，见右）** | 配方交接 + 判定闸 `iterate/glasspane_recipe.py`（`RECIPE_E_*` / `RECIPE_GATE_E_*` 六条码），发布点每条路径带 `recipeStepGate`；`recipeSteps` 被写成**禁令**（`reverification_targets` 无该参数，签名也被断言钉住）；配方文档按 `glasspane.recipe/0.1-draft` 校验，语料 `tests/kernel_fixtures/recipe-config.ok-01.json` | 契约只在复核**失败**时生成请求（两份实现一致），所以"带权限的重验请求"按构造不存在 → 闸是**报与拦**，进程内没有东西强迫驱动配方的人；且两侧都没有配方执行器，闸答"能否推进"，不答"下一步是哪步"（进度指针须由动手修的一侧写进账本） |
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

## 交给版本线的两条命令（本会话不执行）

```bash
# iterate 侧
git -C /Volumes/Eng-Dev/iterate-skill fetch . it-bidi-20261024 && \
  git -C /Volumes/Eng-Dev/iterate-skill merge --ff-only FETCH_HEAD   # 非 ff 时按 patch+sha 核回法 rebase
# GlassPane / harness 侧
git -C /Volumes/Eng-Dev/GlassPane fetch . gp-bidi-20261024 && \
  git -C /Volumes/Eng-Dev/GlassPane merge --ff-only FETCH_HEAD
```

合完之后 `release-artifact` 会要求一次取号（主干又长了字节），这是设计如此，不是缺陷。
