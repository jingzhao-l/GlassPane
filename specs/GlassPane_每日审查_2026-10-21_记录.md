# GlassPane 主仓 · 每日审查记录 2026-10-21

本轮为无人值守每日任务（`tools/prompts/daily-glasspane-main.md`）。开工 HEAD `1dfb2af1`（本地 == `origin/main`，
整树 `git status --porcelain` 为空），收口版本 `1.19.0`。工作树全程就在主仓本树（开工时无人占树）；
本轮自己的验证另用一枚隔离 worktree `/var/tmp/gp-engine-lane`（detach 在改动前的 HEAD，跑完即删）。
快照：`/var/tmp/gp-daily-20261021/snapshot/`（改前的 `mcp-shell`、`engine/Sources`、`harness/contracts`、
`CHANGELOG.md`、根 `package.json`/lock，30 MB）。

## 1. 上一轮没收口的活（判据只用文件字节）

上一轮（2026-10-20）把场景⑤的两半留在分支 `gp-sc5-fork`（tip `f32ef8dd`，本地同名 worktree 分支 `gp-019-pin`）：
三笔提交，`git log --oneline main..gp-019-pin` 逐笔点名。逐笔处置：

| 那笔 | 判定 | 判据与去向 |
|---|---|---|
| `9c1ede8f` 面 A（`mcp-shell/src/providers.ts` + `tools.ts` 消费者接缝 + 501 行测试） | **真未落地 → 本轮并入 main** | `git cherry-pick -n` 只与两份金样冲突；金样不手改，取 main 的那份后用 `node harness/tools/tool-surface.mjs --record` 重记（单独一笔 `chore(harness)`，正文写清 +484 行）。落地证明：`git show 45478350:mcp-shell/src/providers.ts \| diff -q - <(git show gp-019-pin:…)` 无差异，测试文件同样逐字节相同。`mcp-shell` 全测 552/0 当场复跑。 |
| `6bcbb18a` 面 B（fork 侧判定生产者注册） | **不由本轮并** | 并它必红主干 CI 的 `harness/tools/release-artifact.mjs --check`：该尺比较**已发布 tag 的树**与主干里的 `harness/glasspane-harness` 子树是否同一份字节，只容忍收口台账（实测读数：`△ artifact: v0.9.1 lags trunk by 135 line(s) of SYNCLOG.md`）。新代码进主干而不打新 harness tag，那一格必红；本轮被明令不改 harness 内容与版本。 |
| `f32ef8dd`（`registry-readiness.ts` + `verify-published.ts`） | 同上 | 全在 `harness/glasspane-harness/**`。 |

**移交不是遗留的做法**：分支改名 `gp-harness-sc5-fork-20261020` 并推送（tip SHA 与 `origin/gp-sc5-fork` 逐字相同，
一份不丢），删除旧远端分支与 worktree（`worktree remove` + `prune`，删前 `status --porcelain` 为空），
再把这一笔写进**那条线自己每轮会读的发现清单**——`tools/prompts/daily-glasspane-harness.md` §2，
与它从前点名 `gp-harness-orphan-20261010` 用的是同一条机制。判据是"那条线的清理第 1 步会盘 `gp-harness-*`"。

## 2. 本轮发现与处置

**发现 27 条，修复 27 条**（无"判定不属于本轮"这一格）。逐条的位置、失效模式与证据表在
`CHANGELOG.md` 的 `[1.19.0]` 条目里（那才是给人读的那一份）；这里只记判据层面的四件事：

1. **复核判为不是缺陷的一条**（不占 27 的名额）：`EngineCore` 计划态 restore 仍回
   `consistent: true`。规格 P5 §6.4 原文要求它、方法表冻结不可删、同一载荷带
   `consistentBasis: "plan-only, state not re-measured"`、`specs/GlassPane_Audit_2026-09-22` 的 A-5
   已把这一处置记在案，且全仓除两处实测分支外无人按它分叉。改它等于改冻结的响应形状并撤销一条已落档的判定。
2. **本轮自己写错过一次并被自己的用例打红**：`isSubmittableExecutable` 第一版用 `lstat` 量父目录，
   看到 `/tmp` 那枚符号链接的 0755（`& 0o022 == 0`），真实目标 1777 反而看不见——`/tmp` 里放下的一份
   文件被判成"本机拥有"。判据改成 `stat`（叶子仍用 `lstat`，那里要问的就是"是不是链接"）。
   记在这里是因为它正是本仓反复的形状：**护栏量错了对象，就会绿着放行它本该拒的东西**。
3. **两条旧断言的基准本身就是缺陷**，按新形状改写而不是放宽：`StateRootTests` 从前把
   `--state-dir /` 判成 `.named`（等于替"文件系统根是一个状态根"作背书）、`ProjectRegistryTests` 从前
   要求 remedy 里的状态根用**双**引号形态（双引号里 `$()` 照样展开）。两处改写都在提交正文里说明。
4. **泳道被 150 轮上限拦停两次**（面板与 mcp-shell 的修复泳道），交回来的树里有：一处编译错
   （`SchemaOverview` 删了字段没删调用点）、8 行 `@Test(...)` 丢了 `func` 签名、7 处把普通表达式
   当 `#expect` 的 Comment 传参、以及**产品已改对而测试自己错**的三组夹具（要求一段散文里出现
   反引号命令、把不存在于该档的 `--state-dir` 当作分支判据、用含反引号的路径做切片解析）。
   全部由主代理逐项复核后修完；教训与从前记过的一致：泳道的"green/文件清单"不可信，
   收口前必须自己复跑并读源码形状。

## 3. 版本与发布

`node scripts/set-version.mjs 1.19.0` 改写 12 处位点 + 两个 lock，`check-version.mjs` 自证。
minor 的判据对着 1.6.2 那四项实测：CLI 参数的接受条件变了（`--state-dir` 多一条归属规则）、
拒绝载荷的字段集合变了（写侧两条不再带计数）、桥的退出码新增一档 3。
发布链三条：tag → `--ref v1.19.0` dry → `--ref v1.19.0` publish，registry 两包按版本号点名复测。

## 4. 已知边界（不是缺陷，也不是遗留）

`/Volumes/Eng-Dev/iterate-skill/harness/iterate-harness/src/iterate_harness/mcp/client.py:179-192` 用
`"\n".join(parts)` 抹掉 MCP 回包的 item 边界，`iterate/glasspane_reverification.py:182` 的 `relay_answer`
对"帧 + 任意第二项"一律判 `unparseable`（单帧才 `answered`）。这条**早于本版成立**：`gp_diagnose` 从
1.18.0 起就回第二项（更新状态块），本轮面 A 又追加第三项（归属行），只是放大同一件事，不是新引入的断裂。
判据：`content[0]` 逐字节仍是 daemon 回包，所以任何按 item 读的客户端无恙；坏的是那个自己 join 的客户端。
**该由 iterate-skill 那条线修**（修在消费端：逐 item 取回 + 逐项分类，`_refusal_from_text` 只作用单项），
不在本轮范围：本轮的审查面是主仓产品面，跨线授权点名的是 canonical 内核。
