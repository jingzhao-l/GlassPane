# GlassPane ⇄ iterate 双向集成 · 实测状态 2026-10-25

> 这份文件只做一件事：把综述 §8.5 那张 R40 表**逐行**对着代码字节记一遍现状，并写明每一行
> "还只是陈述、没被量到"的那半。此前它没有被任何台账记着（`grep ④ specs/*.md docs/*.md` 零命中），
> 于是"五场景全落"这类说法只能靠聊天记录支撑。判据规则：只认文件字节与自己跑的读数，不认提交信息。
> 历史结论不改写（`specs/**` 是验收台账），本文件是新增的一份，日期即版本。

## 分支与发布状态（第二十次会话末尾重量，2026-10-25）

| 仓 | 分支 / 提交 | 发布 |
|---|---|---|
| iterate-skill | **已推**：`main` == `origin/main` == `fd8b1381`（本会话在其上的笔：`80126520` 验收脚本、`e39a33bd` README、`832171b4` **2.11.0 取号**、`161f352e`/`67f904c5` 发布账与仪表、`52c79227` 复审修复、`e97f11ec` **2.11.1 取号**、`92101c17` 操作者验收、`fd8b1381` 第三次仪表） | **2.11.1 三格齐**：独立仓 tag + GitHub Release（3 件资产、wheel 1,052,100 字节）+ PyPI + npm；三条通道的同一份 wheel 字节逐字相等（`cbfc86cc…`）。本机全局 `iterate-harness@2.11.1` |
| GlassPane（含 harness） | **已推**：`main` == `origin/main` == `ad2e3306`（README 改写 `6894c8c9` + 台账 `3af5dd2b`/`ee5e1b67`/`f91d8d5e`/`ad2e3306`）；fork 树本会话**一个字节未动**（`git diff --stat -- harness/` 空） | harness **0.11.0**、父仓 **1.21.0** 均在 registry（`npm view glasspane-harness version` = 0.11.0、`glasspane-mcp` = 1.21.0）。`release-artifact --check` **rc=0**：`✓ split-main == 主干树（962b1430…）` + `△ artifact 仅落后 31 行 SYNCLOG（发布自己那一笔），非台账差异 0 处` |

推不推的判据不是保守，但**它的结论本会话变了**：先前那格写"本地领先 origin 的 18 笔里 11 笔属发布线，
代推＝代发布"，而这次发布线自己已经把主干推平（`0 0`），我这边只剩自己的 README/台账笔。
所以判据仍然是同一条——**先复量再决定**，别把上一次的读数当今天的：
`git -C /Volumes/Eng-Dev/GlassPane fetch origin && git -C /Volumes/Eng-Dev/GlassPane rev-list --left-right --count origin/main...main`。
`release-artifact` 那条等式此刻为 `0 problem(s)`；记一笔过程中的真实抖动：第一次跑因网络
（`RPC failed; curl 28 … expected 'packfile'`）报 **CANNOT MEASURE**，复跑两次才拿到上面的 rc=0——
"量不到"与"量到是绿的"是两种读数，别把前者当后者。

## 逐行现状

| # | 场景 | 状态 | 生产端 + 消费端 + 能红的闸（证据路径） | 还只是陈述、没量到的那半 |
|---|---|---|---|---|
| ① | invariant 失败 → 运行时重验 | **接通** | 触发点 `harness/iterate-harness/src/iterate_harness/tools/iterate_tools.py:503-504` 在拥有 session 的 loop 上 await；发送 `iterate/reverify_trigger.py`；逐 item 分类 `iterate/glasspane_reverification.py:relay_answer`；GP 侧就是既有 `gp_last_evidence`/`gp_diagnose`，无需新代码 | 重验=只读回看。引擎对"重跑配方步骤"永远回 `deferred`（这是它的既有纪律，不是本批修的） |
| ② | 第 N 维审查 → 压缩感知维度 | **接通（不对称已改成读数）** | iterate 侧写计划 `iterate/run_plan.py:write_run_plan` → `tools/iterate_tools.py:381`；压缩排序 `services/compact/__init__.py:_order_by_dimension_verdict`；fork 侧读计划 `packages/opencode/src/tool/glasspane/kernel.ts:readRunPlan(env, projectDirectory)`（显式 `GLASSPANE_RUN_PLAN` 或工程自己的 `.iterate/run-plan.json`）+ 丢弃排序 `src/plugin/glasspane-compaction.ts:selectAnchors` + 残余不对称的读数 `collectEvidenceAnchors.declaredWithoutAnchor`（块里打印）；面 A 槽 `mcp-shell/src/dimension.ts` + `tools.ts`/`http-gateway.ts` 两道门 | 只有出 `evidencePack` 的方法（`last_evidence`）能把声明维度带进锚点；其余四个工具上声明的维度到不了压缩——**根在 Swift 侧证据发射面**，本行现在给的是它的宽度读数而不是解释 |
| ③ | evidence 原生入决策日志、哈希链互通 | **接通（对面台账可被项目记为默认）** | 两侧 writer 对同一组 draft 输出**逐字节相同**（sha256 `eaa9dc7d…`）；样本双向钉住：`iterate-harness/tests/fixtures/glasspane_chain_ts_written.jsonl` ↔ `harness/…/packages/opencode/test/fixtures/glasspane-chain-python-written.jsonl`，各自被对方格式的读取器整链验通 + 篡改必红；跨账本读者 `iterate/glasspane_recipe.py:fix_proof`，路径由 `resolve_ledger`（`env` → `.iterate/glasspane-ledger.json` → 项目台账）给出，链接动作 `/iterate glasspane-ledger <绝对路径>` 或 `ih iterate glasspane-ledger`，钉 `genesisEntryId` ⇒ 被替换的链回 `LEDGER_LINK_E_STALE` | 默认路径仍是两个文件；链接把"读哪一本"变成一次项目动作而不是每次导出环境变量，但**一本都不合并**——合成本一本仍是产物线的设计决定 |
| ④ | 修复完成 → 挂 invariant 复核 → 通过才进重验 | **接通（闸有读者，两扇门都读得到通过轮的答案）** | 配方交接 + 判定闸 `iterate/glasspane_recipe.py`（`RECIPE_E_*` / `RECIPE_GATE_E_*` 六条码），发布点每条路径带 `recipeStepGate`；**答案落账覆盖两支**——发出去的那一轮，与判定通过、因此什么都没发的轮次（2.11.1 的 `record_gate_without_send`，`kind: recipe-gate`），而契约拒绝一支照旧零字节（Requirement C）；读者两条：session 内 `/iterate gate` 与终端 `ih iterate gate`（两面措辞同源、退出码各自——由 `test_the_terminal_surface_and_the_slash_surface_answer_the_same_thing` 钉住），另有操作者验收 `scripts/check_gate_answer_reader.py` 在**装好的那份**上把两扇门各问一次；`recipeSteps` 被写成**禁令**（`reverification_targets` 无该参数，签名也被断言钉住）；配方文档按 `glasspane.recipe/0.1-draft` 校验，语料 `tests/kernel_fixtures/recipe-config.ok-01.json` | 契约只在复核**失败**时生成请求（两份实现一致），所以"带权限的重验请求"按构造不存在 → 闸是**报与拦**，进程内没有东西强迫驱动配方的人；且两侧都没有配方执行器，闸答"能否推进"，不答"下一步是哪步"（进度指针须由动手修的一侧写进账本） |
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
  - 第二十次的**交付读数（2.11.1，本机，退出码一律取命令自身）**：
    - 五格位置：主仓 `52c79227`（修复＋文案＋两把闸）→ `e97f11ec`（取号）已推 `origin/main`；独立仓
      `3a336a9a` 已推，同步前后逐文件 blob 比对 **621 个路径两侧逐字节相等、无单边文件**；tag `v2.11.1`
      = `3a336a9a`（tag 对象 `29b2cc2c…`）；Release 非 draft、3 件资产，wheel **1,052,100 字节**；
      PyPI latest=**2.11.1**；npm `iterate-harness@2.11.1` 9 文件 / 75,697 unpacked /
      `dist.shasum 6507222cf2c3ef6043d01d10b2a45655c7f398b1`。
    - **三条通道的同一份字节第一次互相对上**：PyPI `urls[0].digests.sha256` == GitHub `assets[].digest`
      == 本机 `curl` 下来那份的 `shasum -a 256` ==
      `cbfc86ccfac52dbdaf04ba2e4e4b3a89109954fbb42b576d3f3405c24f009944`（尺寸同为 1,052,100）。以往只信
      API digest 是因为本机重下会被截断；这次三者逐字相等，所以这条可以记成等式而不是近似。
    - 发布前本地闸：`pytest tests` **3077 passed / 6 failed / 6 skipped / 4m20s**，那 6 条是已知的本机
      环境恒红组；同一棵树在 load 71-93 下先 **12 failed / 36m27s** 后 **7 failed**，多出来的那些
      **单跑全绿**（`2 passed in 8.38s`）——负载假红按"隔离复跑＋逐条具名"分类，不改判据也不掩盖。
      `ruff` 0；`mypy src` 269 文件 0；`check_kernel_fixtures.py` 10 份对上 `0.1.10`；npm 包装器
      **89 passed / 0 fail**；`tsc --noEmit` 0。
    - **交付形状跑在发布出去的那份上，不是仓库树**：`ih --version` = `iterate_harness 2.11.1`；一轮真
      通过的项目 → `InvariantReport(passed=True, checks_run=1, violations=[])` → `spawned=False` +
      `reason='the invariant report passed…'` → 账本里 **1 行 `kind: recipe-gate`** → `ih iterate gate`
      读回 `round 1: recipe gate — not allowed` / `invariant verdict: pass` /
      `refused: RECIPE_E_NOT_ASKED` 带 remedy 原文。**这就是本轮那个 P0 的对照**：同一句问话在 2.11.0
      上只能回 "no recipe gate recorded yet"。同一本账再从链接侧读一次：
      `chain: verified, 1 entries, 0 of them a passing outcome carrying an operation id`——既证明新行在
      链里且验得过，也证明它不算修复证据。
    - 跨仓三条实测在这份交付物上各再跑一遍，全 rc=0：`check_run_plan_channel.py`（env / project 两条通道
      各自 `source` 正确、9 维度、digest `rp_68049dadeff6c85c…2380e` 两侧相等）、
      `check_glasspane_channel.py`（16 个 `gp_*` 工具经产品自己的 `McpClientManager` 可见）、
      `check_glasspane_reverification.py`（`failing=2 of 3` → `iv_4dc9d87d…` → **2/2 回包正确分类**：
      1 条 evidence/diagnosis + 1 条码具名拒绝 `GP_E_NOT_ATTACHED`）。
    - 本机环境两条新事实：tuna 镜像**还没收录 2.11.1**（那句 `from versions:` 的末端是 2.11.0），官方索引
      解析得动但这条代理只有 ~17 kB/s，撞上包装器 15 分钟 bootstrap 上限——它如实打
      "bootstrap timed out… check your network access to the index and retry"，没有静默装旧的；收口把
      **digest 对上的**本地 wheel 装进包装器 venv，`ih` 随后报
      `iterate-harness 2.11.1 was installed by another process; reusing it.`（那正是并发守卫该有的读数）。
    - **仍挂着的一格，且我先前给的原因被自己收回**：main CI 的 `Python tests (3.10/3.11)`。
      第二次仪表（独立 `--collect-only` 一步 + `-v` + job 级 `timeout-minutes: 90`）在 run
      40179763746 上给出的读数是：`Collect the suite` **13 秒通过**（收集期与 import 阻塞被排除），
      `Run test suite` 09:13:44 → **09:58:45 = 45 分 01 秒**，两条 matrix 同一秒，日志照旧
      `log not found`。于是"通道沉默触发失联"这句也站不住——`-v` 期间通道不沉默。本机再量两条把
      剩下两条容易的解释排掉：空闲 `pytest -q tests` = **115.59s**（3089 条收集），
      `/usr/bin/time -l` 的 maximum resident set = **286,605,312 字节 ≈ 273 MB**（7 GB 的 runner，
      OOM 讲不通）；而 `timeout-minutes: 90` 写在自家 job 上却没生效 ⇒ 那把刀不在本工作流里。
      第三次仪表是一根**会自己结束、因而会留下日志**的硬停（`timeout --kill-after=60 1200` 包 `-v`），
      三种可能读数各对应下一步（summary 在末尾＝卡在进程退出；名单断在中途＝某条具名用例在 ubuntu
      上等；仍 45:00 整断＝上限在外面，按目录拆步）。判据与禁忌写进 step 注释，并由新加的
      `tests/test_ci_workflow_shape.py`（8 条，四条反向变异各点名变红）钉住"这一步还带着哪三件探针"。
      **这一格落地前，本版"CI 绿"不成立**；其余四格成立。

## 第二十次补记（同日）· 两条 README 由"读代码的人"复审，判出四句假、两句半真

复审的做法：两条全新眼界泳道，各自**只读代码**，把两边 README 的集成小节逐句对着实现核。它们抓到的
东西不是错别字，而是"能力被写成已经在跑"。逐条判决（判据都是文件:行号，不是提交信息）：

1. **"每次 `gp_*` 调用都回一个证据包" — 被代码否证。** `["evidencePack":` 的出口全仓一处：
   `engine/Sources/GlassPaneEngine/Dispatcher.swift:216`（`handleLastEvidence`）；其余方法在
   `packages/opencode/src/plugin/glasspane-decision-log.ts:90-100` 一律 `skipped`。同节第四条自己
   就写着"引擎只给 `gp_last_evidence` 附证据包"——**同一节内自相矛盾**，中英两版都是。
2. **接受 `dimension` 的五项写错了一半 — 被代码否证。** 两面其实是同一批
   `gp_act`/`gp_observe`/`gp_diagnose`/`gp_last_evidence`/`gp_attach`（fork `index.ts` 的五个
   `dimension: DimensionArg` 落在 236/277/319/366/415，对应 Attach/Observe/Act/Diagnose/LastEvidence；
   壳侧 `tools.ts` 的五个 `OptionalDimensionSchema` 落在 238/255/278/291/297，同一批）。原文把第五项
   写成"fork 的 `gp_probe_status` 与 MCP 层的 `gp_attach`"——`gp_probe_status` **两面都刻意不带**：
   fork `index.ts:216-218` 的注释直说"没有证据帧就不会有可计的决定，没人读的参数是工具面开始撒谎的
   方式"，壳侧 `tools.ts:314` 是 `ProbeStatusArgs = z.strictObject({})`。
3. **"引擎按调用把声明回显回去" — 被代码否证。** `dimension` 在出网前就被剥掉
   （`mcp-shell/src/dimension.ts:95-98` 的 `engineBody`，fork `index.ts:63` 同形），回显那行是**壳或
   fork 自己追加的 content item**（`tools.ts:1751-1759`）。写成"引擎回显"＝给一个不存在的能力作背书。
4. **"回路只问那五个只读工具" — 夸大。** 五个是**允许清单**（`glasspane_reverification.py:50`，
   `glasspane_host_transport.py:133` 强制），而 `plan_calls` 真正构造的是每操作一条 `gp_last_evidence`
   加一条 `gp_diagnose`（`:178-179`）；其余三项在这一半没有生产者。
5. **"两侧都能整链验通对方那本" — 只对一半。** Python→GlassPane 方向在生产里跑（
   `glasspane_recipe.py:633-675` 先验链再落笔、`fix_proof:838` 消费）；反方向 fork 的
   `verifyLedger`（`kernel.ts:636`）**在 `src/` 里没有调用者**，只在测试与一条离线脚本里被驱动。
6. **"这些格式都不是两份手抄的副本／两份实现漂开就会在闸上变红" — 夸大。** Python 半是手写实现 +
   一份按 sha256 钉住的 vendored 语料（`tests/kernel_fixtures/manifest.json` 原话"deliberately NOT
   generated from the kernel: they are a copy pinned by sha256"）；字节漂移有闸，**"对没写进语料的案子
   还一致吗"没有闸**：那是 `scripts/diff_kernel_implementations.py`，操作者命令、不在 CI 里。
   本机跑它回 **exit 2**（找不到已构建的 `iterate-kernel` dist，候选路径全落空）——这句本轮实测过。
7. **`kernel-conformance` 的"两个实现"读数。** 不带 `--impl` 时它打
   `16 fixture(s) through 1 implementation(s)`（本机 rc=0 实测）；两侧比对要靠人把 canonical checkout
   喂进 `--impl`。同理 `contracts/kernel-conformance.json` 头部写 `0.1.9` 而 pin 是 `0.1.10`——那是
   **出处戳记不是判据**（判据是逐条 digest），文档必须这样写才不会读成版本冲突。

处置：第 1-7 条全部改写成实测形状（GlassPane README 双语 + 本仓父 README 双语 +
`iterate-harness` README 双语 + `harness/iterate-harness/CHANGELOG.md`），fork 树一个字节未动
（`git diff --stat -- harness/` 空），所以不需要重切发布物。三条新闸落进去，各带自己的控制：
- `scripts/check-doc-links.mjs` 新增可复算主张"接受 dimension 的工具数"，真源是**两份源码**，
  两面不等时返回"真源读不到"而不是拿一侧当结论；四条新用例分别证红（数量写错／两侧不等／
  改回旧句／判据空转），`node --test updater/test/scripts-check-doc-links.test.mjs` **33 passed / 0 fail**。
- `tests/test_iterate/test_iterate_slash_surface.py`：README 那份 16 项清单与 handler 的分支条件
  逐字相等，两个入口各跑一次真 handler（裸命令＝status，不认识的子命令＝清单）。
- `test_every_name_the_lazy_export_map_advertises_actually_resolves`：逐条 import `_EXPORTS` 指向的
  模块并要求符号存在。它**当场抓出两条我自己留下的死名**（`MAX_REQUESTED_RECIPE_STEPS` 改名后没跟、
  `recipe_steps_not_requested` 实现已删而表与 `__all__` 没跟），两者实测 `AttributeError`。

第 5 条的读者缺口之外，还有一条同族的 P0 被这次复审挖出来并**改的是代码不是文案**：④ 的闸每条分支都
算，但只有"发出去了"那一支落账，而两扇门读的是台账——通过轮的答案随轮次蒸发，`ih iterate gate` 对
跑过十轮通过的项目永远回"no recipe gate recorded yet"。修法与判据见 `iterate-harness` 2.11.1 的
`record_gate_without_send`（契约拒绝分支照旧零字节，Requirement C 有测试钉着；这行也不是修复证据，
缺 `fix_proof` 要的两样，用例把形状钉住）。

## 交给发布线的下一步（本会话不执行的那两格已经做完，剩的是取号）

已执行（本会话）：

```bash
# iterate-skill：分支 ff 进 main 并推送 —— origin/main = 829fda39
git -C /Volumes/Eng-Dev/iterate-skill merge --ff-only it-bidi-20261024 && git -C /Volumes/Eng-Dev/iterate-skill push origin main
# GlassPane：分支以合并笔进 main（本地），金样随后在同一棵树上重记
git -C /Volumes/Eng-Dev/GlassPane merge --no-ff gp-bidi-20261024   # = c4556a9b，金样 = 4b44a33b
```

上面那三条"仍归发布线"的，到第二十次补记时**已被发布线做掉**，读数如下（不是推测，是当场跑的）：

1. GlassPane `main` 已推：`git rev-list --left-right --count origin/main...main` = `0 0`，
   `main` == `origin/main` == `6894c8c9`（本轮 README 改写那一笔）。
2. harness 线取号到了 **0.11.0**，`node harness/tools/release-artifact.mjs --check` 退出 0：
   `1 agreement(s) held, 1 tolerated lag(s), 0 problem(s)`，`split-main` 等于主干的
   `harness/glasspane-harness` 树（`962b1430…`），唯一的 `△` 是 v0.11.0 落后主干 **31 行、1 个文件，
   且那个文件就是 SYNCLOG.md 本身**（发布那一笔不可能描述还没切 tag 的树），下一个 tag 会带上它。
3. 父仓的号取到了 **v1.21.0**（tag/Release/npm 三格由发布线落）。本轮父仓又长了
   README/判据那两笔，`[Unreleased]` 已按"本节不空了 + 复量命令是哪两条"改写，
   下一次取号归发布线判断。
4. **iterate-harness 这一侧的取号本会话自己发了**（用户 2026-10-25 授权到发版）：
   ②③④ 的代码在 2.11.0 里，复审挖出的那条"闸答没有读者"的修复与四句文案改正在 **2.11.1**。
   五格读数见下一节。
5. **留在 fork 树里的四处夸张/stale，本会话没有动它**（动它就要求重切发布物，而 `release-artifact`
   只容忍 SYNCLOG 那一格台账差）：`harness/glasspane-harness/docs/kernel-integration.md` 的
   "Behaviour parity: measured across two implementations" 只在有人传 `--impl` 时成立——不带它时
   `bun script/kernel-conformance.mjs` 自己打的是 `16 fixture(s) through 1 implementation(s)`
   （本机 rc=0 实测）；同页第 255 行 "each harness **now verifies** the chain the *other* one wrote"
   与本轮 README 判过的那句同形——生产里的读者只有回路这一侧（fork 的 `verifyLedger` 在 `src/` 里
   零调用者，只有测试与一条离线脚本驱动它）；第 256 行 "the answer is written into that round's
   ledger line and `/iterate gate` reads it back" 到 2.11.1 才为真，且它只写了 session 那一扇门。
   另一处 stale 引用在 fork 的源码注释里（`packages/opencode/src/tool/glasspane/index.ts` 写
   "one emitter, `Dispatcher.swift:156`"，而 `grep -rn evidencePack engine/Sources/` 今天全仓唯一一条
   命中是 `Dispatcher.swift:216`——`:156` 那行站着的是 `handleAct`）。
   **下一笔 harness 取号时把这四处一起改**，改法是把"两侧都量过／都能读"写成"哪一侧在生产里跑、
   另一侧靠哪条测试或哪条操作者命令背书"。父仓 README 与 `iterate-harness` README 里对应的句子本轮
   已按这个口径改过，不留两份结论。

`provider-surface` 那步 CI 根因的修复已由发布线落进 `5964aed6`，本会话那一行被更完整的版本取代，
两边不留两份结论。
