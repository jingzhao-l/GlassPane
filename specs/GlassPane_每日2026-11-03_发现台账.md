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

## 2. 门禁逐字命令的读数

见下面【收口】第 4 条：一行一条命令、报的是实际计数，不是"全绿"两个字。

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

## 5. 收口

1. **main**：收口 HEAD `b9fa40b8`（本地与 `origin/main` 同一枚 sha，`git status --porcelain` 空）。
   本轮共 9 笔提交：`31f690c5`（上一轮没走完的 1.28.1 版本线）、`6e748acb`、`2a0f2135`、
   `bb339daf`、`4fc5f9db`、`38114dd0`、`6af80adf`、`bf5d39a1`（release: 1.29.0）、
   `36400447`、`264b9a77`、`1bc96173`、`b9fa40b8`。推送走 SSH remote：
   HTTPS token 被仓库规则拒（`GH013: refusing to allow an OAuth App to create or update
   workflow .github/workflows/ci.yml without workflow scope`，因为 #30 动了 workflows），
   按本仓既有的那条 remedy 换成 `git@github.com:jingzhao-l/GlassPane.git` 即通过。
2. **发布三线**：签名 tag `v1.29.0` → `b9fa40b8`（`git tag -v` 报"完好的签名"，
   key `0929EA31DF4F7429F63FC53189D88B1D043A1298`，与本仓内嵌公钥同一把）。
   GitHub Release `v1.29.0`：`isDraft=false`、`Latest`、`targetCommitish=b9fa40b8`、4 件资产
   （归档 + SUMS + 两份 `.asc`）。Release workflow run 41563835981 两个 job 分别 success/skipped。
   npm 两次 dispatch **都显式带 `--ref v1.29.0`**：dry=41564315045、publish=41564611390，
   `publish bare names with provenance` 都 success（trusted publisher 直发，没有 staged publish
   待批——所以 `npm stage approve` 这一格本轮不需要人工动作）。
   registry `--prefer-online`：`glasspane-mcp` latest=1.29.0、`glasspane-install` latest=1.29.0，
   两枚钉名 `@1.29.0` 各自回 1.29.0，版本列表尾部都是 `1.26.0,1.27.0,1.28.0,1.29.0`。
3. **端到端（跑的是发布归档的字节，不是本机重建）**：归档 `GlassPane-1.29.0.tar.gz` 4,888,678 字节 /
   795 条目，`make-release-archive.mjs --verify` rc=0（含"21 项声明的命令与 schema 都在"与
   "no entry under harness/"）；`tar -tzf | grep -cE "(^|/)harness/"` = 0；
   sha256 三处逐字相等（本机算的 == GitHub `assets[].digest` == `SHA256SUMS-1.29.0.txt` 那一行）；
   两份 `.asc` 用仓库内嵌公钥在隔离 `GNUPGHOME` 验签 rc=0；解包 → 树内 `npm pack` →
   装进干净前缀 → stdin 一条 MCP `initialize` 走两条路径（`dist/index.js` 与 `.bin/glasspane-mcp`
   软链）各回 171 字节、`serverInfo` 点名 `glasspane-mcp` / `1.29.0`；
   daemon 冒烟一律带 `--state-dir <临时根>`（绝不写 `GLASSPANE_STATE_DIR=… glasspaned`——
   那枚变量 daemon 不读，见发现 #15）。真机面板/权限读数在 `engine/smoke.md` 的 2026-11-03 那一节。
   一处如实的下载边界：`gh release download` 那一条在本机第一次跑时只取回了 SUMS 与 `.asc`，
   4.8 MB 的归档没落地（本机对 release-assets 的直连有代理限制，10-31 那条线也记过同一格），
   复跑一次取到了完整归档并按上面那串判据核过——不是"读不到就算过"。
4. **门禁逐字复跑的读数**（最终态 `b9fa40b8`，日志在
   `/var/tmp/glasspane-main-check-20261103/gates/`，19 条命令全部 rc=0）：
   `npm ci` rc=0；`npm run build` rc=0；`npm test --workspaces --if-present`
   mcp-shell 739/739、installer 320/320、updater 770/770，合计 1829 条，0 fail；
   `node scripts/check-version.mjs` OK（真源 1.29.0，20 个位点全 ✓）；
   `node scripts/check-doc-links.mjs` 32 份 / 内链 270 / 外链 44（不请求）/ 表格 463 张（扫 126 份 markdown）OK，
   `--self-test` 11 例（7 个变异必须抓 + 4 个合法形状必须静默）；
   `node scripts/check-workflows.mjs --self-test` 48 例（28 变异 + 20 静默）、`check-workflows` 5 份文件 clean；
   `swift build --package-path engine` rc=0；`swift test --package-path engine`
   XCTest 1577 条 / 5 skipped / 0 failures，同一次运行 Swift Testing 76 tests / 8 suites passed
   （本轮新增的那个套件是 10 条）；`swift test --package-path engine/probe` 58 / 1 skipped / 0 failures；
   `python3 -m pytest -q bridge` 201 passed / 1 skipped；`sh -n install.sh` rc=0；
   信号闸 `SIGNAL SMOKE OK`（SIGTERM/SIGINT 自退 0 且 socket 被 unlink，三次起停各自跑在点名状态根）；
   发布形态 `cd mcp-shell && npm run bundle && npm pack --dry-run` rc=0，产出 `glasspane-mcp-1.29.0.tgz`；
   五把尺子：tool-surface `no growth past the recorded baseline`（面 A 22.24% / 面 B 20.75% 仍是
   "金样本身就超 10%"的既有事实，基线在 `264b9a77` 单独一笔补记）、surface-semantics 无面开始自行
   判定证据语义、product-surface manifest/build/publish/installers/pipelines 一致、
   brand-surface 血缘 9632/9632 扫 3330 文件、kernel-corpus 与 pin 同为 `iterate-kernel@0.1.10`；
   CI run 41562931673（event=push，同一枚 sha）全 job success。
5. **反向验证（先证明闸能红，再决定改代码还是改基线）**：
   - 残渣闸：把 `fenceAfter` 换回布尔翻面 ⇒ 2 条具名红、12 条绿；把 ② 换回手抄词表 ⇒ 5 条具名红，
     含"真残渣删掉标记那一行之后仍必须被抓到"这一条本体。两次都 `diff -q` 无输出、
     sha256 `df136990…` 与备份一致、14/14 复绿。
   - `.worktrees` 忽略：删掉那条规则 ⇒ 3 条里 2 条具名红，而"非空转对照"那条**仍绿**（设计如此）。
   - 引号闸：`COMMAND_PREFIX` 改回旧名单 ⇒ `installer 的 git -C 出路不在扫描结果里` 那条空转对照红。
   - 数数的闸：`SWIFT_ISSUES` 那一支去掉 ⇒ "只有 Swift Testing 红"那条红（本轮第一次改就是被这条
     抓出来可选组写法读不到 issues，见 `1bc96173`）。
   - 棘轮：`--record` 只用于本轮自己的有意增长（+14 行壳 / +80 行 engine，逐行出处写在
     `264b9a77` 正文里），没有用它洗任何非本轮造成的红。
6. **本轮起的进程与临时件**：两条 pkill 之后 `pgrep -fl "release/GlassPane"` 与
   `pgrep -fl "state-dir <临时根>"` 均空命中（第一次就空）；上一轮遗留的
   `gpg-agent/scdaemon --homedir /var/tmp/glasspane-main-check-20261031/...` 按"kill 前非空、
   kill 后空命中"两次 pgrep 判决收掉（命中行 2 → 0）。工作树收口后 1 行（只有主树），
   `git branch -a` 7 行（本地只剩 main + 两个 remote 的引用）。
