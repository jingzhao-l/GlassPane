# GlassPane ⇄ iterate 双向集成 · 实测状态 2026-10-25

> 这份文件只做一件事：把综述 §8.5 那张 R40 表**逐行**对着代码字节记一遍现状，并写明每一行
> "还只是陈述、没被量到"的那半。此前它没有被任何台账记着（`grep ④ specs/*.md docs/*.md` 零命中），
> 于是"五场景全落"这类说法只能靠聊天记录支撑。判据规则：只认文件字节与自己跑的读数，不认提交信息。
> 历史结论不改写（`specs/**` 是验收台账），本文件是新增的一份，日期即版本。

## 分支与发布状态（第二十次会话末尾重量，2026-10-25）

| 仓 | 分支 / 提交 | 发布 |
|---|---|---|
| iterate-skill | **已推**：`main` == `origin/main` == `e3cb801f`（本会话在其上的笔：`80126520` 验收脚本、`e39a33bd` README、`832171b4` **2.11.0 取号**、`161f352e`/`67f904c5` 发布账与仪表、`52c79227` 复审修复、`e97f11ec` **2.11.1 取号**、`92101c17` 操作者验收、`fd8b1381` 第三次仪表、`e3cb801f` 第四次（把 pytest 从日志管道上摘下来）） | **2.11.1 三格齐**：独立仓 tag + GitHub Release（3 件资产、wheel 1,052,100 字节）+ PyPI + npm；三条通道的同一份 wheel 字节逐字相等（`cbfc86cc…`）。本机全局 `iterate-harness@2.11.1` |
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
    - **仍挂着的一格，且我给过的原因被自己逐条收回**：main CI 的 `Python tests (3.10/3.11)`。
      六次同死法（`40103418285`/`40167475388`/`40168346235`/`40171467085`/`40179763746`/
      `40182760503`），两条 matrix 每次**同一秒**结束、距起跑正好 45:00-45:01，日志从不上传。
      被量掉的解释依次是：`faulthandler_timeout=300 + exit_on_timeout`（只在**用例进行中**才 dump，
      带上照旧死）；收集期与 import 阻塞（`Collect the suite` **13 秒通过**）；太慢（本机空闲
      `pytest -q tests` = **115.59s / 3089 条**）；太吃内存（maximum resident set
      **286,605,312 字节 ≈ 273 MB** 对 7 GB runner）；自家 job 的 `timeout-minutes: 90`（没生效 ⇒
      刀不在本工作流里）。**第四次尝试改的是"输出别占着管道"（run 40187109237），它也没把机制定
      下来**：步骤 27 分钟仍报 `in_progress`，比自身 1200 s 上限晚 7 分钟。老实讲，这与两种状态都
      相容——(i) 有东西活过了信号（本套件五处以 `start_new_session=True` 起孩子），或 (ii) runner
      早已不报、API 在放陈旧状态直到 45 分钟那一刀（我提 cancel 之后 28 分钟它仍 `in_progress`，
      这条偏向 (ii)）。**外面没有任何可观测量能分开这两者**，而两者都把日志带走（取消后
      `runs/{id}/logs` 里仍然只有三条成功 job）。于是 flag 层面的理论到此用尽，这一格留下的不是
      第五个猜测，而是一件**能离开机器**的仪器：`actions/upload-artifact` + `if: always()` 把
      `pytest-ci.log` 传出来——它是这个 job 里唯一"输出比 runner 活得久"的通道，它的第一行就是至今
      没人拿到的那次观测。判据在 `tests/test_ci_workflow_shape.py`（9 条：`timeout`／重定向＋`cat`／
      `-v`／faulthandler 两个 ini／artifact 必须在且挂 `always()`），抽掉任一件红在该件上。
      **而 5 秒对照已经回答了“这把刀是不是刀”：run 40190097615 里 `Prove the ceiling is enforced…` 这一步 11:44:23→11:44:28 **5 秒 success**（`timeout 5 sleep 30` 如期回 124 且 <=10s）。所以这个 job 里的上限真的会落地，runner 活着且在上报。于是同一 run 里若 `Run test suite` 再次越过它自己的 1200 s 上限，剩下的解释就只有 (i)：真有东西活过了信号——而 artifact 会说出它等到了哪一行。**下一问：artifact 到手之后，名单停在哪一行。**
      **这一格落地前本版"CI 绿"不成立**；其余四格（tag／Release／PyPI／npm）成立。

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

## 第二十一次补记（同日，跨到 10-26 凌晨）· 挂起落成具名文件集；fork 那四处夸张改完并发布；CI 那一格的真实形状

### 分支与发布状态（本会话末尾重量）

| 仓 | 分支 / 提交 | 发布 |
|---|---|---|
| iterate-skill | `main` == `origin/main` == `ddcd2d87`（本会话在其上的笔：`3694472a`/`17d549cf`/`4d8e8969`/`f4b39ca8`/`ffe36c78`/`ddcd2d87`，全是 CI／判据／`pytest-timeout`／看门狗；并行线的 `1945f3fe`/`35950413` 等照旧不属于本会话） | **2.11.1 仍是 registry 上那一版**。独立仓 `jingzhao-l/iterate-harness` main == `0ab8fd73`，与主干 `harness/iterate-harness` 逐 blob 相等（626 条，`diff` 空）。**2.11.2 待取**：上一笔 `pyproject.toml` 的 dev 依赖进了 wheel 的 METADATA（实测 `Requires-Dist: pytest-timeout==2.4.0; extra == 'dev'`，7 条 extra 门控行），而 `.github/`／`scripts/`／`tests/` 实测不进 wheel（`unzip -l` 数到 0 条）⇒ 需要号的只有前者 |
| GlassPane（含 harness） | `main` == `origin/main` == `5f405534`（`d5389ce0` 四处文档改正、`99acc6ce` 棘轮重记、`ebc5fe98` 取号 0.11.1、`32ce4a93` fork-diff 金样、`5ab756f7`/`5f405534` 那条"重切必然换 SHA"的收回） | **harness 0.11.1 已发**：发布仓 main == `f324afa0`（= 主干 fork 树，推前先量 `split^{tree} == HEAD:harness/glasspane-harness`，且 `e96d92c6` 是其祖先 ⇒ 真快进）、tag `v0.11.1` 指向 `f324afa0`、Release 资产与 npm 三包的读数见本节末尾 |

### CI 那一格：现在能说的是"具名的挂起"，不能说的是"绿"

主干 CI 的 `Python tests` 从一整步变成 `python-version × bucket` 的 12 条腿，每桶约 520 条
（`scripts/split_suite.py` 按测试模块做 FFD，三道拒绝保证它是**精确划分**：pytest 自报的
`N tests collected` 必须等于解析到的 node id 数；每桶跑前重新收集并 `--expect-total` 对上计划数；
桶数多于模块数直接拒绝——空桶就是一条什么都不测的绿色 job）。本机等价性实测：单体
`3113 passed, 6 skipped in 123.69s`，六桶合起来同样的 3,106→3,113 passed + 6 skipped，
每桶 `--expect-total` rc=0。

跑出来的是：**10 条腿绿，2 条挂**（`Python tests (3.10 / bucket 06)` 与 `(3.11 / bucket 06)`）。
挂的那两条现在有三件确定的东西：

1. **具名文件集**：bucket 06 = 31 个模块，含 `tests/test_services/test_cron_scheduler.py`、
   `tests/test_swarm/test_subprocess_backend.py`、`tests/test_swarm/test_worktree.py`、
   `tests/test_tools/test_remote_trigger_tool.py`、`tests/test_ui/test_react_backend.py`、
   `tests/test_hooks/test_executor.py`、`tests/test_iterate/test_decision_log.py`、
   `tests/test_iterate/test_cross_surface_ledger.py`。本机因缺 docker/node 把这些路径整体跳过 ⇒
   **本机不可复现**。
2. **它不是慢**：同 run 里十条腿各约一分钟（含 checkout、uv sync、收集），artifact 日志末尾写着
   `520 passed in 9.86s` ⇒ "2 核共享 runner 上大概要 45 分钟"那句被直接证据推翻（本会话已收回）。
3. **步骤内部结束不了它**，五种仪器全部实测不能：`timeout --kill-after=60 1200`；把 pytest 从
   Actions 管道上摘下来（`> file`）；`setsid` 完全脱离 + 有界轮询 + `kill -9 -- -$pid` 打整个新会话组；
   `gh run cancel`；以及 `pytest-timeout` 的 240 s 逐条表。最后那条是新信息——那张表覆盖
   setup/call/teardown，**它从没响过**——当时我据此写"等待在最后一条之后"，这句已被本会话自己的
   记录器推翻：`diagnostics/40244447182-3.11-06` 里那份 `pytest-ci.log` 停在 `collecting ...`
   （605 字节，之后 11 分钟零字节）⇒ 范围收到**收集阶段**。这句按字面读：pytest 的进度行走 `\r` 覆写
   的文本缓冲，不满 8 KB 或不换行不落盘，所以它界定的是"可见输出停在哪"，不是"进程在哪"；
   能确认的是收集阶段没有条目可计时，所以两张逐条表不响是同一件事，而那把守护线程表给出的 dump
   才说得出到底是哪一种
   （session teardown 或解释器退出）。唯一能结束那两条腿的是 GitHub 的 job 超时，
   而它不上传 artifact、日志端点持续 HTTP 404（实测：`timeout-minutes: 30` 的 job 起于 13:58:00、
   cut 于 14:33:00 ＝ 30 分钟 + 约 5 分钟宽限；`artifacts.total_count` 恒 11）。
   同一天又量到一条把"runner 死了没上传"改写掉的对照：**已完成**的 job 日志取到 31,956 字节，
   进行中的腿回 HTTP 404 ⇒ **job 的日志只在 job 结束之后才存在**；一个永不结束的 step 意味着日志在
   任何地方都不存在，与缓冲无关。第六把表（`faulthandler.dump_traceback_later(420, exit=True)`，
   进程级、不绑用例、写在 conftest 里，带着自己 open 的 descriptor 与判据）已在 run 40209916121 上
   弦：**它也没能让那两条腿结束。** 该 run 的最终读数是 14 个 job 绿（plan / quality / typecheck /
   npm wrapper / 十条测试腿），2 个 cancelled（`bucket 06` 两条腿，约 16:29 由 GitHub 的 job 超时切掉，
   `artifacts.total_count` 仍是 11）。六把表都不响，剩下的解释只有两种且站在外面分不开：进程已被杀死
   而 runner 报不回这一步的结束；或者连 `SIGALRM` 都进不到那个等待里（主线程停在一段不返回 Python 的
   C 调用中）。**这两种都不是工作流能修的**——所以这一格到此为止，不再往里加仪器：它被写成
   品类 + 具名文件集 + 六次实测，不写成绿。

四道上限现在是嵌套的，且由判据钉住次序：**一条用例 240 s < 进程看门狗 420 s < 步骤预算 600 s
< job 上限 20 分钟**。这条次序本身就是量出来的教训：12 分钟那一档虽然"数字上大于 600 s"，
但前面 3.5 分钟的 setup 把余量吃光了，于是上限抢在预算之前落地，一次本来能判定的运行变成一次
不可判定的运行。

**所以本会话不写"CI 绿"。** 写的是：12 条里 10 条绿（覆盖 2,600 条用例）、挂的那两条已落成 31 个
具名模块、且已证明它不是慢、也不是任何步骤内机制能收的——这是一个 Linux 上的等待缺陷，
留在 harness 线上，不进双向集成的判定，也不冒充成绿。

### fork 树里那四处夸张：改完，并归号 0.11.1

台账留的"归下一次 harness 取号"那一格做完了（判据统一成"哪一侧在生产里跑、另一侧靠哪条测试或
哪条操作者命令背书"）：① "Behaviour parity: measured across two implementations" ⇒ 无人值守跑的是
一个实现（实测 `bun script/kernel-conformance.mjs` 自报 `16 fixture(s) through 1 implementation(s)`，
rc=0；Python 侧 `diff_kernel_implementations.py` 是操作者命令，本机实测 rc=2），并钉住
`contracts/kernel-conformance.json` 的 `"version": "0.1.9"` 是出处戳记不是判据；② ③ 行"两侧都能整链
验通对方那本"⇒ 生产读者只有回路这一侧，fork 的 `verifyLedger` 在 `src/` 零调用者；③ ④ 行补成
两扇门都读得到、通过轮也落账、契约拒绝零字节；④ `index.ts` 注释里 `Dispatcher.swift:156` ⇒
`:216`（`grep -rn evidencePack engine/Sources/` 今日唯一命中，在 `handleLastEvidence` 内）。
取号 0.11.1（patch）不是为了内容而是为了那条等式：`release-artifact` 只宽容 `SYNCLOG.md`/
`CHANGELOG.md` 落后，文档与注释不在那格子里，量到就是 `2 problem(s)`。

### 本轮新增的通用失效形状（都出自我自己写的东西）

1. **桩替我掩盖了一次真实失败。** `tests/test_ci_suite_step_program.py` 的 `ps` 桩把所有请求吞成
   exit 0，于是 runner 上 `ps --ww` 报 `unknown gnu long option`、`set -e` 把十条已绿的腿打红这件事，
   本机五条用例一条都没抓到。桩改成真转发（同样的 argv 交给 /bin/ps、同样的退出码还回去）之后，
   BSD 的 ps 当场回 `illegal option -- -`——同一缺陷的两种说法，本机就能红。
2. **仪器不能变成故障本身。** 那两处 `ps` 快照现在各带 `|| true`，且有判据（"必须两处、必须各自
   `|| true`、不得含长选项"）与变异（`M-W`／`M-X`）各一条。
3. **注释不能替代码说话（又一次）。** 探针判据第一版找的是 `"setsid "`，而这一步的注释与 echo 文案里
   也写着 setsid ⇒ 把启动命令换成 `timeout` 管道它照样绿。改成行首锚定 + `_commands_of()`
   （剥掉注释行再断言），变异 M-B 这才红。
4. **双引号里的反引号是命令替换。** 我那句本该解释"为什么拒绝"的 `echo "…`kill -9 -- -PID`…"`
   实测执行了 `kill`、`setsid`（无参，IndexError）与 `ps`。新增判据
   `test_no_run_body_carries_a_backtick_that_is_not_a_comment`，`$(…)` 是步骤体里唯一允许的写法。
5. **判据读的必须是值，不是值的打印形状。** 用 `re.search` 去 `str(dict)` 里匹配 `"600"` 匹配不到
   （Python 打字典用单引号），当场具名红了一次；改成读 `env["PYTEST_HARD_STOP"]`。
6. **测钩子要作用在钩子真的在作用域里的地方。** 看门狗的控制用例第一版把探针写在 tmp 目录，
   仓库的 `tests/conftest.py` 根本不在那次 pytest 的作用域内 ⇒ 假绿。改成把真 conftest 逐字节复制到
   探针旁边，测的才是那个钩子本身。
7. **别把 tree 的 SHA 喂给 commit 的判据。** 我先用 `git merge-base --is-ancestor 962b1430… <split>`
   失败就断言"重切不是快进"，而 `962b1430…` 是 `release-artifact` 打印的**发布仓 main 的 tree**；
   `git cat-file -t` 一测即明。推送实测是真快进，lease 是空操作；这段收回写在
   `harness/glasspane-harness/SYNCLOG.md` 与 `5f405534` 的消息里，不改写已经推出去的那笔。
8. **一个数字在不等式里成立，不代表它在墙钟上成立**（见上面 12 分钟 vs 600 s 那条）。

### 发布读数（0.11.1 五格与那条等式）

- tag `v0.11.1` → `f324afa0`；发布仓 main == `f324afa0`。推之前先量
  `test "$(git rev-parse <split>^{tree})" = "$(git rev-parse HEAD:harness/glasspane-harness)"`，
  并确认上一Head `e96d92c6` 是其祖先 ⇒ **真快进**（`--force-with-lease` 在真快进上是空操作；
  我一度把它当成必要，原因记在本节第 7 条失效形状里）。
- GitHub Release `v0.11.1`：非 draft，**6 件资产** —— darwin-arm64.zip 46,453,170 B、
  darwin-x64.zip 48,635,278 B、两份 `.asc` 各 833 B、`SHA256SUMS.txt` 204 B、其 `.asc` 833 B；
  逐件带 API `digest`（比对用 API，不在本机重算：这台机器重下发布物会被静默截断）。
- npm 三包 `glasspane-harness` / `-darwin-arm64` / `-darwin-x64`：`npm view … version` 各 = **0.11.1**
  （发布 run 40211293095 success；父仓那次 push 触发的 Release run 40210116533 也 success）。
- 等式的权威读数是 **CI 里那一步**：`harness rulers` lane（run 40212357161，sha `959bd423`）绿，
  其中 `The released artifact and the split branch are trunk's bytes` 与
  `The release-artifact anchor can still go red, for each reason separately` 各自 success。
  同一天本机三次跑 `release-artifact --check` 全是 rc=2 `CANNOT MEASURE`
  （`RPC failed; curl 28 … expected 'packfile'`）——"量不到"与"量到是绿的"是两种读数，都记在这儿。
- `fork-diff` 在发布之后又具名红过一次：`SYNCLOG.md: our own file moved (abb46a8e → 42c5008b)`，
  因为"收回重切必然换 SHA"那段是 tag 之后写的。按它自己的规矩在干净树上重记金样（`959bd423`）后 CI 转绿；
  搬运分支不需要再切——金样在 `harness/contracts/` 里，不在 fork 树内（重切实测仍是 `f324afa0`，
  `Everything up-to-date`）。

### 剩下没闭合的三格，写清不藏

1. **iterate-harness 主干 CI 的 `bucket 06`**：31 个具名模块在 ubuntu 上让 runner 结束不了那一步，
   六把表实测无效。这不是双向集成的语义缺陷，是 harness 自身测试套件的一个 Linux 等待缺陷；
   但它使"本版 CI 绿"不成立，所以那句话不写。下一步的可行路径只剩两条，都不在工作流里：
   在 Linux 上复现（本机没有 docker，实测），或者按模块二分并配一条**能把日志送出去**的通道
   （mid-step push，需要给 job 加 `contents: write`——那是一次新的权限面，本会话没有做）。
2. **iterate-harness 2.11.2 待取**：`pyproject.toml` 的 dev 依赖进 wheel 的 METADATA（实测
   `Requires-Dist: pytest-timeout==2.4.0; extra == 'dev'`），而已发布的 2.11.1 那份产物里没有它
   ⇒ 发布物与主干不一致，需要一个 patch 号。不在第 1 格落地前取它：带着已知红 lane 取号比等一格更糟。
3. **本机 daemon 仍是 1.6.2**（壳已 1.21.0）：能力对账会预告 `attach` 一类调用被 methodNotFound 答回；
   换 daemon 要重启正在被另一个会话使用的进程，没动。

## 第二十二次补记（2026-10-26 凌晨，跨夜收尾）· 挂起落成"一个模块＋一个信号对象"，CI 那一格真的绿了，2.11.2 因此能取

### 分支与发布状态（本会话末尾重量）

| 格 | 读数 | 量法 |
| --- | --- | --- |
| iterate-skill 主干 | `30b0aea3`（origin/main） | `git rev-parse origin/main`；本会话序列 `eacf3d39`（修复＋8 条用例）→ `e2bfef57`（台账修复）→ `af64d4e9`（取号）→ `b56db8d6`/`30b0aea3`（README、ci.yml 注释、RELEASE.md） |
| iterate-harness 发布仓 main | `544f851a` | 逐 blob 比对：subtree 628 个路径与发布仓 628 个路径**两侧逐字节相等、无单边文件** |
| tag | `v2.11.2` = tag 对象 `40522610` → commit `544f851a` | 先核 `git merge-base --is-ancestor` 可达，再打 tag（v0.8.0 那次的 403 教训） |
| GitHub Release | 非 draft，3 件资产；wheel digest `sha256:8fce4c49…` | `gh release view v2.11.2 --json assets` |
| PyPI | latest **2.11.2**，`8fce4c4914931205d94ced7d44ac961b13adbe4898b7a28c107a34bdd15ae048`，1,057,470 字节 | `curl pypi.org/pypi/iterate-harness/json` |
| npm | latest **2.11.2**，`dist.shasum` = `c63f3191e62710f3bae9574e4bb8a0a0e5df6ef1` ＝ `npm publish --dry-run` 打出的值 | publish 后约 8 分钟复量（第一次读还是 2.11.1，那句话保留不删） |
| CI | **`Python tests` 12/12 success**，`artifacts.total_count=13` | run 40252896348 与发布 head 上的 40255060841，各独立量一次 |
| glasspane-harness | 0.11.1（上一会话已发，本会话未动） | 父仓 `release-artifact` 等式绿 |

**本机 `ih`**：venv 里是 2.11.2（装的是本机 `uv build` 那份 wheel，其 sha256 与 PyPI/GitHub 两处 digest 逐字相等——
所以它等价于发布物）；npm 全局包装器 2.11.2；`version.stamp` 与包装器版本一度不一致，导致每次 `ih` 都重跑
bootstrap 并失败（用户配的 tuna 镜像还没索引 2.11.2，而带 `ALL_PROXY=socks5://` 的环境让 pip 直接报
"Missing dependencies for SOCKS support"，GitHub 两条候选又被 TLS 拦 ⇒ 三条全败 ⇒ 包装器**如实 fail-closed**，
这是该有的行为，不是我该绕过的）。修法是清掉代理变量、指官方索引重跑包装器自己的 postinstall，不手改 stamp。

### CI 那一格的终态，以及被它推翻的三句我自己写过的话

判据不是再加仪器，而是把可疑那一桶拆成"一个模块一条腿"：新增 `suite-bisect.yml`（只能手动派发，不进任何
判定，矩阵由 CI 自己的 plan 现算——手抄的名单会过期，见下面第 4 条形状）。run 40249882415 的读数：
**32 条腿里 31 条绿，唯一没结束的是 `tests/test_services/test_cron_scheduler.py`，它也是唯一没留下日志
artifact 的那条**。根因两处，都在 `src/iterate_harness/services/cron_scheduler.py`，都在本机做了对照实验：

1. `_kill_process_group()` 无条件 `os.killpg(os.getpgid(process.pid), SIGKILL)`，而 `test_timeout_job` 递给它
   的是 AsyncMock；实测 `AsyncMock().pid.__index__()` **返回 1**，于是 Linux 上这行是
   `kill(-1, SIGKILL)`——kill(2) 写明它是"发给调用者有权发给的每一个进程"，同 uid 的 `Runner.Worker`、步骤的
   shell、actions 的 node 全在射程内，且打中任意一个就返回 0，所以旧代码的 `except PermissionError`
   什么都接不到。本机（macOS）实测 `killpg(1, 0)` 回 EPERM ⇒ 被 catch 吞掉 ⇒ 同一行在两台机器上表现相反，
   这就是"只在 ubuntu 发生、两天里从没在我眼前炸过"的理由。
2. `read_pid()`/`stop_scheduler()` 只问"这个号活着吗"（`os.kill(pid, 0)`），从不问"是不是写凭证的那个进程"。
   本机对照实验（`/var/tmp/prove_pid_claim.py`）：把一个从没见过这个 daemon 的活 `sleep` 子进程写进 pid 文件
   ⇒ 修前 13.5 s 内 SIGTERM＋SIGKILL 把它打死（退出码 `-15`）、事后报"survived SIGKILL"（僵尸也答 signal 0）、
   pid 文件还在；而对**真** daemon 也返回 False，那 daemon 其实已退 0。修后：陌生进程 0.0 s 被拒且毫发无损、
   凭证被释放；真 daemon 0.2 s 停住并如实返回 True。

被推翻的三句（都是我自己写的）：
① **"等待在收集阶段"不成立**——同 run 的 per-bucket 收集步在完全相同的路径上 completed success
（23:23:04→23:23:12，8 秒）。而且这条事实在 10-25 早一段记录里已经写过一次（"同一 run 里 `Collect the suite`
13 秒通过"），我却又在 README 里把它反着写了一遍 ⇒ 错因不是笔误，是没读自己写过的记录。
② **"job 的日志只在 job 结束之后才存在"要说得更狠**：由服务端超时结束的那种结束**根本没有日志**——两条被
取消的 bucket-06 腿 `gh run view --log` 都回 `log not found`。所以超时那一刀不是最后的仪器，是证据的销毁。
③ **记录器 8 份快照里 `pytest-watchdog.log` 全部只有那句 armed（76/118 字节），没有一份带 dump** ⇒ 与
"进程是被杀而不是在等"一致；这也是"六把表都不响"的统一解释：它们都在被打死的那棵树里。

### 本轮新增的通用失效形状（五处，全都出自我自己写的东西）

1. **凭证要带出处，不能只带一个号。** pid 文件、锁文件、"我上次看到的 pid"这类状态，凡是后来会被用来
   **发信号**的，都必须写下"是谁写的"（这里是当时的 command line），否则读者只能选择盲目相信或永远拒绝。
   比对时还要挑一个两侧都稳的部分：本机实测解释器会在 exec 之后重写 `argv[0]`（同一进程先答
   `.venv/bin/python -c …`、随后答 framework 的真实路径），整行比对因此会拒掉一个从未变过的好凭证——
   第一版就是这么把 7 条原本绿的用例打红的。**取 argv 尾**是量出来的结论，不是设计偏好。
2. **夹具的形状会决定杀伤半径。** 桩"对任何参数都答话"这条老教训在信号层面同样成立：一个 mock 的
   `pid` 属性回 1，不是"返回一个假的 pid"，是"把组信号变成 `kill(-1)` 广播"。凡是把 pid/pgid 交给内核的
   代码，都要问"这个数字是不是一个可用整数、这个组是不是我造的"。新加的
   `TestKillProcessGroupOwnership` 三条（自己的组→打；共享调用者的组→不打；没有可用 pid→谁都不打）
   就是把这句话写成判据。
3. **改 CHANGELOG 时不许用"下一条标题"当锚点，且事后必须数。** `3676343e` 本意改一条 bullet 的措辞，
   diff 却是 +19/-50，连带删掉了**整个已发布的 `## [2.11.1]` 段落**（标题＋版本判断段＋7 条 bullet）与一条
   操作者验收 bullet。也就是说 2.11.1 四格都发了，而它的台账一度不存在。修复按父提交逐字节取回、只插入
   不重组，事后断言四条：插入文本与父提交相等、每个版本标题恰好一行（**按整行匹配**——bullet 里提到那个
   标题会让子串计数变成 2）、bullet 数不变、`--numstat` 删除列为 0。同形错误本仓写过一次，这次是第二次。
4. **"某一桶里有哪些模块"是一次 plan 的属性，不是仓的属性。** 同一棵树，本机 plan 的 bucket 06 与 CI plan 的
   bucket 06 都是 521 tests / 32 modules 但**名单不同**：逐条 import 的计数随环境变（缺不缺 docker/node/可选
   依赖），FFD 就重新分桶。⇒ 任何写进文档的"具名模块清单"都会过期；要拿名字就去读那一次 run 的 plan 日志。
   这也是那条诊断线的矩阵坚持由 plan 现算的原因。
5. **shell 的退出状态不能冒充内容的完整。** 同一夜两次：同步发布仓时一条被行连接符吃掉的 `cp` 让第一次
   推送"带上了修复却没带上判它的 8 条用例"（逐 blob 比对抓出来，之后每个 `cp` 单独 `cmp`）；诊断包装器时
   `ih --version 2>&1 | tail` 回 rc=0，而直接跑 `ih --version` 是 **rc=1**——`tail` 的状态又冒充了一次。
   另外 `$VAR:foo` 在 zsh 里会被当修饰符吃掉（`rec/311-06:pytest-ci.log` 少了 `:r`），复杂命令一律写脚本文件。

### 剩下没闭合的格子，写清不藏

1. **本机 daemon 仍是 1.6.2**（壳 1.21.0）：能力对账会预告 `attach` 一类调用被 methodNotFound 答回。换
   daemon 要重启正被另一个会话使用的进程，没动。
2. **本机 `ih` 的 bootstrap 依赖镜像索引**：tuna 收录 2.11.2 之前，任何"让包装器自己重装"的动作都会三条
   候选全败（而它 fail-closed 是对的）。这一格**已按产品自己的路走完**：清掉代理变量＋指官方索引重跑包装器
   的 postinstall，由它自己把 `version.stamp` 写成 2.11.2（读数在下面"交付读数"第 0 段）。只影响这台机器，
   不影响发布物。
3. **2.11.2 的交付证据已跑**：cron 真往返、陌生 pid 的重放、三条跨仓验收、两扇门的拒绝读数都在下面
   "交付读数"一节，全部打在 `/usr/local/bin/ih`（= 与 PyPI/GitHub 逐字相同的 2.11.2 运行时）上。

### 交付读数（全部跑在**发布物**上：`/usr/local/bin/ih` → `~/.iterate-harness-npm/venv`，`ih --version` = `iterate_harness 2.11.2`，rc 一律直接取不经管道）

本机升级是走产品自己的路走完的：先 `pip install --no-index` 装本机 `uv build` 那份 wheel（其 sha256 与
PyPI/GitHub 两处 digest 逐字相等，所以它等价于发布物），再用清掉代理变量＋官方索引重跑包装器的
postinstall，让**它自己**把 `version.stamp` 写成 `{"version":"2.11.2","pythonEnv":"","source":"iterate-harness==2.11.2"}`
——不手改 stamp。第一次 `npm install -g` 因 npm 的 allow-scripts 策略没跑 postinstall，stamp 一度停在
2.11.1，于是每次 `ih` 都重装并失败（三条候选：镜像未索引、GitHub 两条被 TLS 拦），包装器**如实拒绝安装**
而不是装个旧的——这条行为是对的，需要修的只是本机环境那半边。

0. **升级本身**：见上第 2 格。`ih --version` = `iterate_harness 2.11.2`，`command -v ih` =
   `/usr/local/bin/ih`，模块解析到 `~/.iterate-harness-npm/venv/lib/python3.11/site-packages/iterate_harness/`
   （不是任何源码树）——所以下面每一行都是发布物的读数。

1. **cron 一轮真往返**（隔离 `ITERATE_DATA_DIR`/`ITERATE_LOGS_DIR`，不碰用户自己的调度状态）：
   `status` → 未运行；`start` → `Scheduler started (pid=52063).`；pid 文件 205 字节，内容已是凭证
   `{"pid": 52063, "cmdline": "/Library/Frameworks/.../Python -c from iterate_harness.servi…"}`；
   `stop` → `Scheduler stopped.`、文件消失、`pgrep -f _run_daemon` 计数 0。
2. **缺陷本身在发布物上重放**：把一个从没见过这个 daemon 的活 `sleep` 子进程的 pid 以**旧版裸整数**格式写进
   pid 文件，`ih iterate cron stop` → rc=0、3.1 s、答 `Scheduler was not running.`；那个陌生进程
   `poll() is None`（**活着**）；陈旧凭证被释放。2.11.1 上同一句会把它 SIGTERM 打死（本机对照实验实测退出码 `-15`）。
3. **三条跨仓验收**（操作者命令，不在 CI 里）全 rc=0，在 `544f851a`（tag 内容）上：
   `check_run_plan_channel.py` 两侧同一份字节、同一顺序的 9 个 id、digest `rp_68049dadeff6c85c…42380e` 相等；
   `check_glasspane_channel.py` 打得开 `gp_last_evidence` 并取回真证据包（`operationId=op_01M35PAMYNNPJRNCCM6Q2C34XQ`、
   `attribution.level=soft`、`schemaVersion=glasspane.evidence/0.1`）；
   `check_glasspane_reverification.py` `sent 1 request, 2/2 answer(s) relayed`（1 条 evidence/diagnosis +
   1 条具名编码拒绝 `GP_E_NOT_ATTACHED` 带 remedy）。
4. **两扇门在空项目里的读数**（拒绝即接线证明，不伪造一次通过轮）：`ih iterate gate` rc=0 打
   `no recipe gate recorded yet … that is absence, not a pass`；`ih iterate glasspane-ledger <不是链的文件>`
   rc=1 打 `LEDGER_LINK_E_LEDGER_CHAIN … line 1 is not a valid entry: missing required entry field(s): [...]`
   带 remedy；路径不存在时打 `LEDGER_LINK_E_READ … this command never makes a ledger, it only vouches for one`。
5. 双向集成五场景的代码在 2.11.2 里**一行未动**（本批改的是 `cron_scheduler`、CI 形状与文档），所以
   ①②③④⑤ 的判定沿用 2.11.1 那次逐条复核的结论；上面 3、4 两栏是在新发布物上重跑的**接线**读数，
   不是新的语义变更证明。

## 第二十四次补记（2026-10-27，父仓更新系统那一轮的末尾）· 上面那格"本机 daemon 仍是 1.6.2"已经不成立

这一格是被**另一轮工作**顺带关掉的，不是在集成线上做的决定：父仓修更新系统那一轮在本机跑了
`updater apply`（读法与逐格数字在
[GlassPane_更新系统_2026-10-26_状态.md](./GlassPane_更新系统_2026-10-26_状态.md) 的"1.23.0 的发布读数"），
daemon 从 1.21.0 换到 1.23.0，与壳同版。所以本节下面四条是**新量**，不是沿用 10-26 的读数：

- 四条跨仓验收脚本在**当前装好的发布物**上重跑，四条 rc=0（Python 用的
  `~/.iterate-harness-npm/venv/bin/python`，即与 PyPI/GitHub 同一份 2.11.2 运行时）：
  `check_run_plan_channel.py` 两侧同一份字节、同一顺序 9 个 id、同一 digest；
  `check_glasspane_channel.py` 连得上并取回真证据包（`operationId=op_01M35PAMYNNPJRNCCM6Q2C34XQ`、
  `attribution.level=soft`、`schemaVersion=glasspane.evidence/0.1`）；
  `check_glasspane_reverification.py` `sent 1 request, 2/2 answer(s) relayed`（1 条 evidence/diagnosis +
  1 条具名编码拒绝 `GP_E_NOT_ATTACHED` 带 remedy）；
  `check_gate_answer_reader.py` "a passing round's ④ answer is recorded, and both doors read it"。
- **能力对账那一格从"会预告 methodNotFound"变成实测无话可说**：直接把发布物壳
  `/usr/local/bin/glasspane-mcp` 喂一次 `initialize`+`tools/list`，`tools/list` 数到 16 条工具，
  **stderr 0 行**——`describeCapabilityDrift` 只在两边不一致时才 print（一致时返回 null，
  `mcp-shell/src/engine-client.ts:1725` 那一支不 print），所以"stderr 空"就是"这一趟没有分叉可报"，
  不是"没跑"。这正是旧 daemon 1.6.2 配新壳时唯一会说的那句话，现在它不说了。
- 版本读数当场取（`--prefer-online`，`--version` 直取不经管道）：
  `ih --version` = `iterate_harness 2.11.2`、`glasspane-harness` npm = `0.12.1`、
  面 A `glasspane-mcp` = `1.23.0`、`iterate-kernel` = `0.1.10`、daemon 二进制自报 `glasspaned 1.23.0`。
- 上面"剩下没闭合的格子"第 1 条按此**关闭**；第 2 条（本机 `ih` 的 bootstrap 依赖镜像索引）与第 3 条
  （交付证据已跑）状态不变——前者只影响这台机器、且已按产品自己的路走完。

### 五场景的判定不因为这一轮而动，但边界照旧写在这里（不是"没做完"，是"按构造如此"）

①②③④⑤ 的代码在 2.11.2 一行未动，父仓这边改的是更新链，所以判定沿用 10-26 那次逐条复核。
每条"还只是陈述、没量到的那半"仍然成立，且它们不会被任何一次发布消掉：

1. ① 的重验是**只读回看**——引擎对"重跑配方步骤"永远回 `deferred`，这是它既有纪律。
2. ② 只有出 `evidencePack` 的方法能把声明维度带进锚点，其余四个工具上声明的维度到不了压缩；
   根在 **Swift 侧证据发射面**，本行现在给的是宽度读数而不是解释。
3. ③ 两本台账**不合成一本**（链接把"读哪一本"变成一次项目动作）——这是产物线的设计决定。
4. ④ 契约只在复核**失败**时生成请求，且两侧都没有配方执行器：闸答"能否推进"，不答"下一步是哪步"。
5. ⑤ 面 B 比面 A 多 `diagnose-pixel`/`diagnose-probed` 是正当不对称，但它是**记录**而非推导——
   新增单边方法时必须有人重记金样。
