# 每日审查 2026-11-03 · 发现台账（32 条发现 / 32 条修复 / 未修 0）

> 用法：本文件是本轮的**发现与处置**记录。按 `specs/**` 的规矩只新增、不改历史结论。
> 主仓 07:30 那条线（引擎 + MCP 壳 + 安装器 + 更新器）。`harness/` 不在本轮范围（10:30 那条线）。

## 0. 开工时读到的状态（判据是文件字节，不是分支名）

- 开工 HEAD：`336fe35c`（本地 `main`）。`origin/main` = `f4df4693` ⇒ **本地比远端多 3 笔未推送**
  （`e6e43b54` 残渣闸判据形状化、`9c41a7ae` 删 smoke.md 残渣、`336fe35c` 台账收口节）。
- 整树 `git status --porcelain`：14 个 ` M` 文件 —— 逐字比对是 `node scripts/set-version.mjs 1.28.1`
  的位点输出 + 它的 CHANGELOG 条目。实测三线：`git tag --sort=-v:refname` 最新 `v1.28.0`、
  `npm view glasspane-mcp version` = 1.28.0、`npm view glasspane-install version` = 1.28.0。
  ⇒ **上一轮死在"提交并推送"之前**，收口定义 ①② 两格都没发生。这不是别人的在飞批次：
  改动内容与那三笔未推送提交描述的两条缺陷一一对应，且 CHANGELOG 那条 1.28.1 写的就是它们。
- 本轮第一个动作：把那批未提交改动原样落成一笔（`31f690c5`），不掺本轮任何改动；随后本轮的
  版本判断把版本线重新钉到 1.29.0（1.28.1 未发布过，内容并入，理由写在 CHANGELOG 那一节顶部）。
- 盘余量：`df -k /Volumes/Eng-Dev` 可用 19,677,684 KB ≈ 18.7 GiB（> 4 GiB 门槛，未触发清理）。
- 工作树：`.gp-ci-check`（detached at `f4df4693`，是 main 的祖先）、`.worktrees/harness-daily-20261101`
  （`gp-harness-daily-20261101`）、`.worktrees/harness-daily-20261102`（`gp-harness-daily-20261102`）。
  两条 harness 分支 `git rev-list --count main..<b>` 都是 **0**（不是 `git cherry`，squash 会误报）
  ⇒ 内容逐笔在 main 里；两个工作树 `status --porcelain` 都是空。归属：10:30 那条线建的。
- stash 三条（`wip-console-and-other-20260923` 等）都是历史轮的记录，本轮不动、不删（第 4 步的
  "快照分支是有条件的例外"同一判据：不是本轮的保险，就不该由本轮撤销）。

## 1. 发现与处置总表

| # | 严重度 | 位置 | 失效模式（一句话） | 处置 | 提交 |
|---|---|---|---|---|---|
| 1 | P2 | `.gitignore` + `scripts/check-doc-links.mjs:1074` | 文档闸把 `.worktrees` 当非仓库内容，git 没这条规则 ⇒ 收口硬条件"status 为空"不可满足 | 加 `/.worktrees/`；测试 3 条含非空转对照与"两面同答" | `6e748acb` |
| 2 | P2 | `check-doc-links.mjs:866` | ② 还是手抄词表：真残渣去掉标记行喂进去报 0 条 | 改成语句形状（赋值/调用/片段续行/管道+选项/命令替换）；同一输入现报 7 条 | `2a0f2135` |
| 3 | P2 | `check-doc-links.mjs:186` | 围栏是布尔翻面，与 `headingsOf` 的 CommonMark 两套；一枚缩进 ``` 让整篇尾部失去扫描（假绿），注释还写着"三个读者共用一个式子" | 统一 `fenceAfter` 状态机 + 接上缩进代码块；注释改为真的 | `2a0f2135` |
| 4 | P3 | `check-doc-links.mjs:848` | ① 宽度 `{1,15}` 放过 24 字符标记；只认独立成行放过 `EOF; git diff …` | `{1,63}` + 同行形状 + heredoc 引入式 | `2a0f2135` |
| 5 | P3 | `check-doc-links.mjs` self-test | 8 例里没有 ① 的变异例：删掉 ① 分支仍打印"8 case(s)"退 0 | 补 3 例（含合法大写词静默对照），8 → 11 | `2a0f2135` |
| 6 | P3 | `check-doc-links.mjs:851` | 残渣闸不扫 `specs/**`（表格闸扫）——每轮真往正文贴脚本的地方在闸外 | 扫描集接上 specs/（71 份，实测零误红） | `2a0f2135` |
| 7 | P3 | `check-doc-links.mjs:862` + `CONTRIBUTING.*` | 文案把猜测写成事实；docs lane 描述与 CI 实际跑的两条命令不符 | 改成"这**通常**是…"+ 双语补齐 | `2a0f2135` |
| 8 | P1 | `install.sh:352/375/418/420/440/452` | 打印给操作者照抄的命令里值裸插值或双引号插值 ⇒ 目录名里的 `$( )` 会被执行 | 六处走 `sh_quote` | `bb339daf` |
| 9 | P1 | `installer/cli.js:1616/1636/1637/1666/1710/2827/2895/3059` | 同一函数 24 行下用 `quoteShellArg`，出路里却用双引号——一处两套口径 | 八处走 `quoteShellArg` | `bb339daf` |
| 10 | P1 | `mcp-shell/test/remedy-shell-quoting.test.mjs:451` | 执行这条纪律的闸动词表里没有 `git`，也从不扫 `install.sh`/`make-app.sh` ⇒ 上面十四处天生看不见 | 动词改成形状（保留旧名单作下限）+ shell 侧扫描 + 两条空转对照 | `bb339daf` |
| 11 | P2 | `http-gateway.ts:367` vs `stdio-session.ts:185` | 网关不交 `identity`/`expectedDaemonMethods` ⇒ 版本与能力漂移只有 stdio 那一面报 | 交同一份清单；测试问两个门面的判据数量 | `4fc5f9db` |
| 12 | P3 | `dispatch.ts:157/161/175/232/252` | 五条协议错臂三条无 remedy，兄弟两臂有 | 五条全带 ``\| remedy:``，且点名的 method 必须真实存在 | `4fc5f9db` |
| 13 | P3 | `tools.ts:694/704-706` | 对外 schema 重抄 256/1024 字面量，其它界都来自常量 | 导出 registry 常量并共享（4 处） | `4fc5f9db` |
| 14 | P3 | `tools.ts:2478`、`project-registry.ts:1364/1371`、`http-gateway.ts` | remedy 印裸 `glasspaned --…`，而 `registryReaders` 的理由正是"裸名走不受控 PATH" | 15 处改安装位置绝对形态 | `4fc5f9db` |
| 15 | P3 | `update-state.ts:66/86`、`tools.ts:1766` | 壳读 `GLASSPANE_STATE_DIR`，daemon 从不读它，摘要还不点名读的是哪棵 | 变量驱动的根必须自报 + 给核对命令 | `4fc5f9db` |
| 16 | P3 | `io.ts:280` + `engine-client.ts:2009` | 先 `setEncoding("utf8")` 再算字节与摘要，而对外承诺"the exact bytes this transport received" | 读 `Buffer`、线字节带到 `onLine`；拿不到就改口说明 | `4fc5f9db` |
| 17 | P3 | `project-registry.ts:1702` | `Math.random()` 弱 id 兜底臂与 crypto 臂并存（`engines >= 18` 下永不达） | 删臂，改 `randomBytes`，与 operationId 同来源 | `4fc5f9db` |
| 18 | P2 | `main.swift:1704` vs `EvidenceStore.swift:123` | 一条事实两种拼写，字节已分叉；合并说明写着"删掉"却没删 | 删副本转读 `stats.ageRetention`；旧测试的基线跟着改到真实位置 | `38114dd0` |
| 19 | P2 | `EngineCore.swift:765` + `ownabilityDefect` 六处 | 绝对路径（含本机账号名）回显到线上，违反 `Dispatcher.swift:50-60` 自己立的规矩 | 新增 `redactHome`，七处过它 | `38114dd0` |
| 20 | P3 | `main.swift:1043` + `EvidenceStore.swift:242/576` | write/rename 之间被打断留下的 `.tmp-*` 过不了 `isEntryName`，"nothing will ever reclaim it" | 按 pid 存活判据回收，接进 `clear()`/`prune()` | `38114dd0` |
| 21 | P2 | `engine/smoke.md:1506` | 断言 `gp-refresh-daemon-stats` 不存在；它在 `EvidenceStatsView.swift:126` 自 2026-10-10 就在 | 源码存在性测试 + smoke.md 本轮节里更正（不改写历史行） | `38114dd0` |
| 22 | P3 | `UpdateModel.swift:416` | `terminate()` 不收尸不 join 不关句柄；兄弟 `ConsoleModel:1001` 已写明顺序 | 照兄弟那一支补全 | `38114dd0` |
| 23 | P3 | `EvidenceTabView.swift:183`、`ApprovalsTabView.swift:79` | 禁用理由与下一步只活在 `.help`（悬停才读得到） | 补 `accessibilityHint`，同一句话两处同源 | `38114dd0` |
| 24 | P1 | `installer/cli.js:1653` | 信任倒置：`unsigned` 只 warn 就继续，`unavailable` 硬拒；`SECURITY.md` 写的是要人批准 | `unsigned` 也要 `--accept-unverified-signature`（复用已有旗标，不新增参数） | `6af80adf` |
| 25 | P2 | `install.sh:749` vs `:418/420/451` | 平台闸那句"一个字节都不写"被它上面几行的 fetch/checkout 否证 | 动树那一步自己先问平台；断言 HEAD 与 `.git/objects` 字节 | `6af80adf` |
| 26 | P2 | `install.sh:2c` vs `installer/cli.js:234` | `--repo=<目录>` 连写不认识 ⇒ 先付一次 depth-1 clone 再退 2；两条入口只有这条写了盘 | 在付代价之前给同一个答案（退 2），不新增参数语义 | `6af80adf` |
| 27 | P2 | `engine/scripts/make-app.sh:173` | `set -eu` 下裸 `sips`：图标失败 = bundle 构建致命 = 更新器 staged build 永远过不去 | 守卫 + 降级文案（与同段 `iconutil` 同一规矩） | `6af80adf` |
| 28 | P3 | `make-app.sh:77/66-68/257-264` | 未知选项退 64（两处入口 2）；旗标吞旗标；两个 skip 都给时零产出退 0 | 退码对齐 2、`takes_value` 三处共用、零产出即失败 | `6af80adf` |
| 29 | P3 | `make-app.sh:92` | 开发机 conda 解释器路径进了产品脚本 | 删掉；要指定只走 `GLASSPANE_PYTHON` | `6af80adf` |
| 30 | P3 | `ci.yml`（10 job）、`harness-contract.yml`（2 job）、`check-workflows.mjs:653` | 按可变 tag 取第三方 action；钉 SHA 的判据只管 `environment:` job（自declared 盲区） | 三条 tag 用 `gh api` 量到 commit 后全钉；判据扩到每个 job；电池 46→48 | `6af80adf` |
| 31 | P3 | `scripts/assert-test-count.mjs:32/80` | failures 只从 XCTest 行取，Swift Testing 的 `with N issues` 不进账 ⇒ 只有那一半红时闸读成绿 | 吃进 issues 组；测试用本轮真日志，正反两面 | `6af80adf` |
| 32 | P3 | `mcp-shell/package.json` | `esbuild ^0.28.2` 是唯一剩下的范围依赖，且带 install-time 脚本、跑在发布 lane | 精确钉 `0.28.2`（= lockfile = 实装）。`packageManager` 见下面第 3 节 | `6af80adf` |

## 2. 门禁逐字复跑的读数

见下面【收口】第 4 条，一行一条命令，报的是实际计数不是"全绿"。

## 3. 本轮我替你做了哪些决定（依据 / 回滚）

1. **取号 1.29.0（minor），并把未发布的 1.28.1 并进本版。**
   依据：安装器对"发布 tag 没有可核验签名"这一档从放行改成要求显式同意，是一条用户可见的契约变化
   （原本能装成功的调用现在需要带旗标）；`make-app.sh` 的退出码语义也改了。四条 patch 判据里
   "退出码集合/用户可见行为"被动到 ⇒ 按 1.6.2 那条走 minor。1.28.1 从没打过 tag、registry 读
   1.28.0，因此不保留它单独一号。
   回滚：`git revert <release 提交>`；已发布的 tag 一律不动（本仓纪律）。
2. **先落地上一轮那批未提交改动，再开始本轮。**
   依据：它是本线自己的活（内容与三笔未推送提交一一对应），不是别人的在飞批次；混进本轮提交会让
   两条判断不可分别复查。回滚：`git revert 31f690c5`。
3. **残渣闸的 ② 改成形状而不是继续加词表。**
   依据：本仓同形状第四次咬人（SHELL_ONLY 名单、面 A keep-list、上一轮的 heredoc 名单），且
   "去掉名单只留形状"会误红 harness 线 SYNCLOG 与一份 specs 台账——所以名单保留作**下限**，
   形状作**新增覆盖**，并用"真语料零误红"那条测试把门槛钉住。
   回滚：`git revert 2a0f2135`。
4. **`unsigned` 用已有的 `--accept-unverified-signature` 而不是新增一枚同意旗标。**
   依据：那枚旗标自己的文案写着"只批'缺证明'"，而"没签名"就是缺证明；新增参数会动 CLI 参数集
   （把 patch 判据也一起动了），且不必要。回滚：`git revert 6af80adf` 里那一段。
5. **平台闸不挪位置，改成"动树那一步自己先问平台"。**
   依据：位置是 2026-10-22 的决定，`installer/test/daily-20261022-install-isolation.test.mjs:171`
   明写"平台闸必须排在源码定位之后、委托之前"。回滚：同上。
6. **动 `.github/workflows/**` 并把 `check-workflows` 的钉 SHA 判据扩到每个 job。**
   依据：可变 tag 在任何 lane 上都是"别人改过的代码"；三条引用的 commit 都由 `gh api` 现量，
   其中两条与本仓已有钉法逐字相同（不是新决定）。风险与缓解：CI 会立刻跑一遍，绿了才打 tag。
   回滚：`git revert 6af80adf`。
7. **`packageManager` 本轮不写。** 依据：CI 的 npm 由 `setup-node` 给，本机读不到确切版本，
   写一个没量过的数字正是"主张没有出处"。这条是**取值的出处问题**，不是"要不要钉"的悬案——
   补它的那条命令写在下面第 4 节。
8. **本轮不新增对外 `gp_*` 工具、不改发布平台矩阵、不改产品定位。**
   依据：32 条全部是既有形状的缺陷，修在所属层（Swift 判定层 / 壳 / 安装器 / 脚本 / 闸）。

## 4. 仍属未观测（只限物理边界）

- `npm stage approve`：需要 owner 的 2FA。触发条件与补救命令写在收口第 6 条。
- Apple 公证（Developer ID + notarytool）：需要付费账号，owner 未启用；文档没有把它写成已完成。
- `packageManager` 该钉的 npm 版本：取它的确切命令
  `gh run view <ci-run-id> --repo jingzhao-l/GlassPane --log | grep -i "npm"`（setup-node 那行）。
