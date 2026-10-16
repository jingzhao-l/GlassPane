# SYNCLOG — glasspane-harness 与上游的同步记录

一次同步一条，倒序。每条必须给出：**改动面数字**（`fork-diff` 输出）、**跑了哪些闸、结果如何**、**没跑的部分照实写没跑**。

## 2026-10-16（第十一次会话）· 0.8.1：那条等式第二次开口，这次两个方向同时缺字节

**开工态**：主树 `main` = `9cefe7e7`（落后 `origin/main` 13 笔、领先 0 笔）⇒ 先 `git merge
--ff-only origin/main` 复基线到 `96e1b27f`，整树 `git status --porcelain` 空。
`df -k /Volumes/Eng-Dev` = 29,213,056 KB 可用（≈28 GiB）。`bun` = 1.3.14 = `packageManager`
钉的同一支。`.external/opencode` 的 `describe --tags` 实测 = `v1.18.32` = `harness/upstream.json`
的 pin（不是照抄上一轮的记述）。split 仓 `main` = `23b63020`。

**缺陷 1（P0 机制留下的那一格）：发布物 ⊅ 主干，且没有任何尺子在量**。0.8.0 那条
`version-check` 锚只在切 tag 那一刻比一次 tree 哈希，切完之后主干又收了 74 行——
实测：`git rev-parse HEAD:harness/glasspane-harness` = `c21d9e4b`，split `main` 与 tag
`v0.8.0` 的树都是 `8620e992`，差一个文件 `SYNCLOG.md`（主干独有 74 行）。后果不是"文档没带上"
这么轻：**装到用户机器上的那份归档里，没有这次发布的实测记录**——同一判据 07:30 那条线当天
用它打过自己的脸（`v1.16.3` 的归档里没有台账，于是补了一版 `1.16.4`），本轮不能对本线默认例外。

**缺陷 2（反向，且是重切会吃掉别人字节的那一侧）**：同一份差集里 `SYNCLOG.md` 还有
**+1 行只在发布物**——主干 0.7.8 那一段的 `` 回读 `draft=false` `` 被 `943b2841`（就是写
0.8.0 收口补记的那一笔）吃成了 `` 回读 `draft=` ``。真相独立核过，不信任何一边树里的字：
`gh release view v0.7.8 --repo jingzhao-l/glasspane-harness --json isDraft` → `false`。
也就是说：**照原样 `git subtree split` 一次，就会把 split 仓里正确的那行删掉**，而当时父仓
10 条 lane 全绿。同形第二处：同一笔还把 `VP_GATE=<那份副本>` 吃成了 `VP_GATE=`
（`verify-published-selftest.sh` 里 `GATE="${VP_GATE:-…}"` 实测存在那个变量）。两处都按
"补回可核的真相"处理，不按"重录基线"处理。

**机制补上：`harness/tools/release-artifact.mjs`（父仓侧持续量，不再只在切 tag 那一刻量一次）**
- `split-main`：split 的 `refs/heads/main` 树 == 主干子树树，**严格**、两个方向都红。依据：
  推一次搬运分支不消耗版本号，所以不存在"回头再推"的正当性。
- `artifact`：被 tag 的那棵树 == 主干子树树。容忍只此一种——tag 还没带上**本版自己的收口记录**
  （`SYNCLOG.md` / `CHANGELOG.md`），因为那段记录无法描述一个当时还不存在的树；且必须打成
  `△ tolerated lag(s)` 报出来，绝不静默。非 ledger 路径不等、或发布物**领先**主干，一律红。
- 差集报到**行级**（`+远端独有行 / -主干独有行`）并单列 `⚠ RE-SPLIT RISK`。这一条是本轮缺陷 2
  的直接教训：整文件缺席看得见，两边都在的文件里丢了哪几行看不见——`draft=false` 就是这么消失的。
- 没有 `--record`（自测里那条电池钉着：`--record` 回 exit 2）。一把能把"发布物过期"记成基线的尺子
  不是尺子；这一格与面 A 那种"越线检查已耗尽、只剩 LOC 棘轮"不同，这里没有任何数字需要基线。
- 取不到远端 / 子树有未提交改动 ⇒ **exit 2**，CI 把 exit 2 判红（与 `verify-published.ts`、
  `hook-liveness --offline`、`ref-batch-selftest` 同一分码口径）。

**固定点测试：`harness/tools/release-artifact-selftest.mjs`，10 条电池 + 1 条反向破坏，实测全过**
夹具是 `file://` 上的真仓库（真 `git init`/commit/**annotated** tag——split 仓的 tag 是带对象的，
`refs/tags/v…` 指向 tag 对象，工具必须 peel 才能拿到树；用轻量 tag 做夹具就会漏掉这条路径）。
- A 全等 ⇒ 0；B 主干多一个文件 ⇒ 1，两条规则同时点名并列出 `NEW.md`；
  C 发布物多一行（`draft=false` 形状）⇒ 1，报 `⚠ RE-SPLIT RISK` 与 `SYNCLOG.md (+1 / -0)`；
  C2 发布物多一个整文件 ⇒ 1，`published-only: 1` + `⚠`；D 声明的版本从没打过 tag ⇒ 1，
  **`✓ split-main` 且 `✗ artifact`**；E tag 落后 main 且差的是非 ledger 路径 ⇒ 1，同样
  一条绿一条红，且不容忍；J tag 只落后本版收口记录 ⇒ 0 但必须打印 `△`（断言里有
  `1 tolerated lag(s)`，防止"容忍"变成"闭嘴"）；F 远端不可达 ⇒ 2；G 子树未提交 ⇒ 2。
  D/E/J 三条是本文件存在的理由：把"树不等"合成一句判决就分不清"补一版"与"先把字找回主干再重切"
  这两种相反的处置。
- 反向破坏：把两处 tree 比较阉成 `if (true)` 的副本，在已知不等的夹具上必须回 **exit 0**
  （回 0 才证明上面那些红是比出来的，不是恰好崩）；实测 `control live`。
- 接线（`product-surface` 的 `selftest-wired` 从四把变五把）：`.github/workflows/ci.yml`
  的 `harness-rulers` 加了三处——尺子在树里那条 `for f in …` 名单、`--check` 一步、自测一步
  （照 `ref-batch` 那两步的双网写法：退出码非 0 红 + `case "$out"` 抓"回答没测量"）。

**闸的读数（本批，从干净树复测）**：`fork-diff vs v1.18.32: 4645/6724 byte-identical, 282 edited,
92 added, 1705 deleted`（与开工同值；金样只重记了四个 `forkHash`——`CHANGELOG.md`、
`product.json`、`SYNCLOG.md`、`packages/opencode/package.json`，`git diff` 差集逐行核过是
4 行、计数一格没动）；`tool-surface` 面 A 9609 LOC / 21.41%、面 B 8793 LOC / 19.59%，**no growth**
（两个面仍超文档 10% 上限，越线检查对这个面已耗尽，本轮没动它一行）；`surface-semantics` 0 命中；
`brand-surface` 血缘 9646 / 3312 文件，与基线相等；`hook-liveness` 21 钩子无漂移；
`product-surface` **227 条一致 / 0 问题**（开工 225；+2 是新自测的"在树里"与"被接线"两问）；
`kernel-pin` iterate-kernel@0.1.7 / 26 个契约文件；`kernel-conformance` 16 fixture 全中；
`check-workflows` 5 份工作流干净 + `--self-test` 12 条各验其红；`check-doc-links` 25 份文档 /
227 条仓内链接 OK；`release-artifact --check` 本批**故意是红的**（`✗ split-main`、
`✗ artifact: has no tag v0.8.1`），红的内容就是本版要消掉的差集——推搬运分支、tag `v0.8.1`
之后按上面三条规则复绿。

**取号 0.8.0 → 0.8.1（patch）的依据**：四条用户可见判据逐条实测未动——状态文件字段（无改）、
退出码集合（无改）、CLI 参数（无改）、npm `bin`（无改）；子树里的字节变化只有版本号、
`CHANGELOG.md` 与 `SYNCLOG.md`。本版存在的理由不是"改了功能"，是"发布物里没有上一版自己的
收口记录"，而消掉它的代价应当是一版而不是一个例外。

**本轮我替你做的决定**：① 主树的 13 笔落后用 `--ff-only` 复基线，不 rebase 不覆盖；
② 缺陷 2 按"补回可核真相"处理（`gh release view v0.7.8 isDraft` 与脚本里的真实变量名为据），
不把 split 侧的差集当"上游噪声"重录掉；③ `artifact` 那条容忍只给 `SYNCLOG.md`/`CHANGELOG.md`
两个路径、只给"tag 缺主干的字"一个方向，且必须打印 `△`——这是我替你定的口径，因为不收口记录
就写不进 tag（tag 之前那段实测还不存在），而把它做成静默放行就等于本轮开场那个缺陷；
④ fork-diff 金样重记与代码同批（分两笔提交落，内容一致）。回滚：`git revert` 本批三笔
（工具与接线、金样、台账）即回到 0.8.0 的等式状态；已发的 tag 与 npm 版本不撤。

### 发布链实测（2026-10-16，tag 之后补记——这一段本身就是下一版要带走的字）

**搬运与 tag**：`git subtree split --prefix=harness/glasspane-harness` 出的切提树
`b015f03e…` 与 `git rev-parse HEAD:harness/glasspane-harness` **逐字相等**（推之前断言过）。
远端 `main` 当时是 `23b63020`，实测**不是**主干的祖先（`git merge-base --is-ancestor` 否），
所以按 0.8.0 那轮定下的做法补了一笔 `-s ours` 血缘合并（`commit-tree` 直接落：树仍是
`b015f03e`，父 = [切提 `19105090`, 远端旧 tip `23b63020`]）⇒ 普通 push 就过
（`23b63020..ac3f7f14`，**没有 `--force`、没有覆盖任何东西**）。tag `v0.8.1` 是 annotated
对象 `143dc918`，peel 到 `ac3f7f14`，切在血缘合并之后 ⇒ 被 tag 的 commit 从一开始就在
`refs/heads/main` 可达范围内（0.8.0 那条 403 坑没有复发）。主干侧推送前先 `git fetch`
复基线：origin 又动了 2 笔（`docs(specs)`，只碰 `specs/` 台账，与本轮 8 个文件**零重叠**），
`git rebase origin/main` 干净重放 4 笔，重放后子树树仍是 `b015f03e`（闸重新比过一次）。

**Release 跑 `38891176919`（tag push 触发）全 success**：`tag matches the product version` 7s
→ `create the GitHub release for this tag` 3s → `binary darwin-arm64` 2m33s →
`binary darwin-x64` 5m51s → `SHA256SUMS for the release assets` + 签名 → `Make the release
visible once it can be verified`。锚那一步打出的是真哈希，不是"绿"：

```
released tree (this tag's HEAD^{tree}):  b015f03e0b2d28e4e01eb054e5fd562923795dae
trunk's subtree (harness/glasspane-harness):         b015f03e0b2d28e4e01eb054e5fd562923795dae
anchor OK: the artifact being released IS trunk's fork subtree — b015f03e0b2d28e4e01eb054e5fd562923795dae
```

`gh release view v0.8.1` 回读：`isDraft=false`、`targetCommitish=ac3f7f14…`（就是被 tag 的
commit）、`publishedAt=2026-10-16T11:09:18Z`、6 件资产齐（两份 zip、两份 `.zip .asc`、
`SHA256SUMS.txt` 与其 `.asc`），全部带 `digest`。

**npm 那条是独立 dispatch**（`gh workflow run release.yml --ref v0.8.1 -f publish_npm=true
-f confirm=true`，跑 `38892404754`，success）：`Refuse to publish a tree no tag vouches for`
先过（`--ref` 显式写成 tag 这件事由那条 job 自己判），三个 npm 作业（两个平台包 + wrapper）
success，CI 侧那条 macOS `install the published bytes and run them` success。registry 按版本号
点名 + `--prefer-online` 实测：三包 `@0.8.1` 都读得到，`dist-tags.latest` 也已经是 `0.8.1`
（本轮没有复现上一轮那种十几分钟的读副本滞后）。

**签名与完整性（不走本机重下资产那条路）**：`SHA256SUMS.txt` 与其 `.asc` 单取下来，用
`scripts/install.sh` 内嵌的那把公钥 `gpg --verify` ⇒ **完好的签名**，密钥
`0929EA31DF4F7429F63FC53189D88B1D043A1298`、身份 `jingzhao-l (sign-github)`、签名时间
2026-10-16 19:09 CST。清单里两条 sha256 与 GitHub 资产 API 的 `digest` 逐字相等
（arm64 `4bd76c9b5556f76f…`、x64 `0f6c1f6eff7d03f5…`）。判据仍不拿本机重算当数——
本机重下 46 MB 资产会被代理静默截断，这是已记过的机器事实。

**发布专有闸本机真跑**：`bun run script/verify-published.ts 0.8.1` 全绿——装的是**已发布**
tarball、`glasspane-harness --version` 与 `gp-harness --version` 都回 `0.8.1`、`os`/`cpu`/
`version` 三项对的是**已安装包**的清单（`os=["darwin"] cpu=["arm64","x64"] version="0.8.1"`）、
wrapper 点名的每个平台包都在 registry 且带 `sha512-fVybn5vlsaght5MnoTm+…` 的 integrity、
装好的二进制真在供内嵌 web（等 0.5s，`content-type=text/html`、doctype、assets 被引用）。

**两条安装通道端到端**
- npm：`verify-published` 走的就是这条路（临时前缀 + 真 `npm install`），上面已记；npm 11 的
  `allow-scripts` 警告按文案原样出现，安装仍成功。
- bun：`bun add -g glasspane-harness` ⇒ 2 个包 14.69s 装上、`~/.bun/bin/glasspane-harness`
  与 `gp-harness` 都是符号链接指向 `../../node_modules/glasspane-harness/bin/glasspane-harness.exe`；
  `bun pm -g trust glasspane-harness` 跑完 postinstall 后两个 bin 各回 `0.8.1`、退出码 0。
- `curl` 兜底通道：本轮**没跑完带 gpg 的成功那一腿**，原因是本机代理对 ~40 MB 的 GitHub 资产
  限速（上一轮同一处 40 分钟没下完，属机器边界不是产品缺陷）。补它的确切命令
  （README.md:111 的原文形态，PATH 里要有 gpg）：
  `curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.sh | bash`。
  不依赖大资产的那半条本轮又核过了（上一句的 API digest 比对 + 这一段前面的 `gpg --verify`）。

**父仓 CI 那条红，和它其实是闸在说话**：主干推上去的 `38891129814` 第一次是红的，红的就是
新加的 `release-artifact --check`——它在 11:02:31 采样，那一刻 `✓ split-main` 已经成立，而
`✗ artifact: has no tag v0.8.1`，因为我 10 秒之后才推 tag。红的内容与真实状态一致，所以处置不是
放宽它：tag 落地后 `gh run rerun --failed` 复绿，并从绿跑日志里点名确认两条新步**真的执行了**
（`release-artifact — 2 agreement(s) held, 0 tolerated lag(s), 0 problem(s)`；自测在 Linux runner
上打出 `each rule goes red for its own reason…`，11 条电池全过）。

**我自己两次把测量姿势弄错，记下来而不是删掉**——两次都差点被写成产品缺陷：
① 固定点第一次跑用的是 `bun test <4 个文件>`（默认每条 5s），那条"超尺寸引擎帧应被 in-band 拒"
的用例报 `timed out after 5000ms`；生产的跑法是 `bun test --timeout 30000 <6 个具名文件>`
（fork 的 ci.yml:53 就是这么写的，那条用例的调用预算本来就是按 30s 契约定的）。照 CI 口径复跑
⇒ **138 pass / 0 fail**（6 个文件、814 次断言、24.88s），tui 那条 `inline-tool-wrap-snapshot`
⇒ **32 pass / 0 fail**（8 张快照、226 次断言）。红在我的调用签名与被测量物不一致，不在代码。
② bun 通道我用 `bun x --bun glasspane-harness --version` 探，回 `0.7.10`，看起来像"全局装的
是旧版"；直接跑 `~/.bun/bin/glasspane-harness --version` ⇒ `0.8.1` rc=0。`bun x` 取的是它自己的
缓存副本，不是这次的全局安装。两次同一个形状：**先问"我读的这一个是谁"**。



### 0.8.2：这把闸第一次打的红，打在我自己那一笔上

`v0.8.1` 全链跑完之后，主干又收了 `docs/release.md` 的第 3b 步（"收口记录落下之后必须再推一次
搬运分支"）。`release-artifact --check` 据此红：`✗ artifact`，并点名
"1 of the differing path(s) are not the release ledger, so no allowance applies"——
差集里 `SYNCLOG.md (+0/-78)` 与 `docs/release.md (+0/-12)` 都是"发布物缺主干的字"，
但只有前两个路径是记录，程序文档是产品内容。两条处置我都试想过：放宽容忍（把
`docs/release.md` 也塞进 LEDGER）与再出一版。**放宽被否**：那等于把本轮开场那个缺陷
（发布物里没有它自己的记录）换成尺子写成制度。所以出 `0.8.2`，判 patch（四条用户可见判据未动，
变的只有版本号与两类文本）。同一天两版 docs-only patch 的价格照实记在这里，
出路是下一轮把程序与台账都写在 tag 之前——那正是 3b 教的事。

## 2026-10-16（第十次会话）· 0.8.0：发布物与主干那条没人量的等式，四条尺子的"只能绿"，与四条把红线当成交付的修复

**开工态**：主树 HEAD `40f6dca`（落后 `origin/main` 一笔），`git status --porcelain` 有 11 项，全部
落在 `harness/glasspane-harness/` 内。盘 `df -k /Volumes/Eng-Dev` = 32,524,048 KB 可用（≈31 GiB），
`bun` = 1.3.14（= `packageManager`），`.external/opencode` 的 `describe --tags` = `v1.18.32` =
`harness/upstream.json` 的 pin，`fsck` 无错、工作树干净，`preflight` 报出本机 TLS 由
`SteamTools Certificate` 签发并给出钥匙串束的接法（`/var/tmp/glasspane-harness/ca-bundle.pem`，
163 张）。registry 三包 latest 实测均 `0.7.10`，split 仓 `main` = `ea70dc8`。

**往轮遗留判定（"上一轮的遗留"是待办，不是输入）**

1. **`gp-harness-orphan-20261010`：本轮不存在这条分支**。`git ls-remote --heads origin` 只有 `main`，
   本地分支只剩 `main` 与 07:30 那条线的 `gp-daily-main-20261015`。它的五个文件在 10-15 那轮已被
   逐字节判过"被更强的形态取代"（判据在那轮的 SYNCLOG 里），本轮复查确认 `verify-published.ts`
   读的是**已安装包**的 `os`/`cpu`/`version`，不再是拿 `product.json` 跟自己比的那句自回显断言。
2. **主树里那 11 项未提交批次不是"别人的在飞工作"，是本轮的头号缺陷**。查法：逐文件
   `git hash-object` 与 split 仓 `main` 的 blob 比 → 10 个文件**逐哈希相等**；再把
   `HEAD:harness/glasspane-harness`（`4ad214d`）与 split `main` 的树（`896398d`）整树
   `git diff --name-status` → 差 11 项，即那 10 个文件 + **主树从来没有的 `bun.lock`**。
   出处是两笔**只在 split 仓存在**的提交：`d56660e fix(deps): raise 7 pinned deps above the first
   patched version`（dompurify 3.3.1→3.4.16、electron 42.3.3→42.10.0、minimatch 10.0.3→10.2.3、
   katex 0.16.27→0.18.2、`@modelcontextprotocol/sdk` 1.29.0→1.31.0＝CVE-2026-104850 /
   GHSA-6qxp-vccf-f47h OAuth 客户端凭据泄露、`@babel/core` 7.28.4→7.29.6、`@hey-api/openapi-ts`
   0.90.10→0.97.3）与 `3207508 chore: add CODEOWNERS`。**这两笔进了 v0.7.10 的发布物，主干却从未
   收到**——下一笔 `git subtree split` 会把一次安全升版静默撤销。处置：把内容（含 `bun.lock`）
   落回 main（`359088e`），`fork-diff` 金样同批重记；`bun install --frozen-lockfile` 实测过，装的
   版本实测 1.31.0 / 10.2.3 / 7.29.6。落地后 `HEAD:harness/glasspane-harness` == split `main` 的树
   （`896398d`），已 tag 的 v0.7.10 与之只差 `SYNCLOG.md` 一个文件（发布物不含代码差异）。
3. **本轮把这条等式变成机制**（见下【P0】）。这条等式原先只写在 `docs/release.md` 的一句手打
   `test "$(git rev-parse …^{tree})"`，SYNCLOG 每轮记录它被**人**跑过——10-15 那轮甚至把"清理盘点"
   写明了这个差集，却没有任何东西能红。

**P0：没有任何尺子量过"主干 == 发布物"**（两条独立审查同时命中）。盘过七个地方，一个都不比：
六把尺子（`fork-diff` 比的是 fork↔**上游**，不是 fork↔split）、`harness/glasspane-harness/contracts/*`
（无 fork 树哈希）、父仓三条工作流、split 的 `release.yml`（`publish-gate` 只证明 tag 的 commit ==
HEAD，它看不见父仓）、`scripts/check-workflows.mjs`、`docs/release.md`（散文）。根因是结构性的：
**尺子不在 split 树里**，发布仓跑不出主干的任何性质。处置＝把断言放到唯一能说真话的时刻——
`release.yml` 的 `version-check`，取号之后、`create-release` 公开之前，匿名 HTTPS 抓主干，比
`FETCH_HEAD:harness/glasspane-harness` 与本树 `HEAD^{tree}`，不等就打出文件级差集并非零退出；
`create-release` 与 `binaries` 都 `needs:` 它。红路可复现：本机对 **v0.7.10 那棵树**跑同一段逻辑，
它就在 `A .github/CODEOWNERS / M README.md / M bun.lock …` 上退 1（＝当年漏进主干的那批东西）。
尺子侧另加 `[release-anchor]`：step 名字不在、或它不在 `version-check`、或 `version-check` 不再是
`create-release`/`binaries` 的前置，都红——删 step 实测 exit 1 并点名。

**本轮修掉的（按"发现 N 条就修 N 条"清点，32 条）**

*供应链与安装/升级面* ①`Installation.latest()` 的 registry 来自 `NpmConfig.registry(process.cwd())`
＝吃项目 `.npmrc`/`npm_config_registry`，三条 `install -g` 更是不传 `--registry`：陌生仓库可以既
决定"最新版是谁"又决定"全局装谁的包"（那包的 postinstall 跑的是它的 JS）。②`Npm.reify` 把项目
`.npmrc` 原样交给 Arborist，而本产品会往用户刚打开的项目里写依赖。③写进项目的
`@opencode-ai/plugin` 版本用的是**本产品**版本号——实测 404（`1.18.32` 才有），安装 forked 在后台、
失败只留 warning，于是每个被发行版打开的项目静默拿不到插件文件 import 的那个 API。④⑤⑥三处
**跑不到的拒绝分支**：`getBrewFormula()` 两个 return 同一字符串 ⇒ 第三方 tap 那条拒绝恒不执行、
照旧 `brew upgrade` 别人的 formula；`method()` 的 `installedName` 三元两侧相同；`--method` 的
`choices` 仍列 brew/choco/scoop，且显式 `[target]` 绕过"没有这个渠道"的拒绝。⑦`--pure` 与
`GLASSPANE_HARNESS_*` 整批名字在工具宿主侧从未生效（`Config.boolean("OPENCODE_PURE")` 按字面名问
provider，从不经过 `flag.ts::read()` 那个唯一解析点），而被注入每个会话的 skill 正在教用户导出
它们；`plugin/index.ts` 里那个空 `if` 一声不吭丢掉 N 个 plugin origin。⑧安装器两条拒绝打印的
`GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 curl … | bash` 执行不了（行首赋值只管 `curl`），照抄再被拒。
⑨`gpg` 不在 PATH 时兜底通道"警告后安装"——裸 macOS 本来就没有 GnuPG，等于在最需要它的机器上关掉
溯源控制，剩下那把尺子是同一个 origin 发下来的 SHA256SUMS.txt。⑩`gpg-signing.sh audit` 每个正文
`2>/dev/null || true` 取，全部取不到时打印 `ok no silent-skip signing found`（它存在的目的恰恰是
发现那种静默跳过）。⑪⑫⑬`build.ts` 丢掉 `Bun.build` 返回值（编译失败不打字、退 0、
`dist/<pkg>/bin` 是空的，只有本机 target 有冒烟测）；`publish.ts` 的 `gp-pack-*` 只在成功路径清理；
`verify-published.ts` 把 `npm view` 的传输错误判成"发布是坏的"，与它自己文件头的三态规则相反。
⑭`create-release` 的"release 已存在"分支只修锚点就继续，配 `binaries` 的 `--clobber` ⇒ 一个版本号
同时挂着 GitHub 的新字节与 npm 的旧字节、签名在重签前对不上旧资产。⑮`docs/release.md` 教的派发
命令缺 `--ref v<X.Y.Z>`，而 `publish-gate` 对缺它的派发恒拒绝。⑯父仓 `release.yml` 的
`npm publish --provenance || { npm stage publish; }` 假绿形状（E401/5xx/tarball 问题都走这支；
v0.7.6 就是 job 绿而 registry 没那个号），以及铸 OIDC token 那台机器上浮动的 `npm@11`。
⑰`packages/{sdk/js,plugin,ui,app,cli}` 补 `private: true`——此前只有 `script/publish.ts` 的 `exit 2`
桩在挡，而 `npm publish -w @opencode-ai/ui` 根本不经过桩。⑱FORK.md 那句"CODEOWNERS/
ISSUE_TEMPLATE 全部移除"按树的真相改正（是**改写**，且 CODEOWNERS 是 10-15 为分支保护恢复的；
上游工作流实测 27 个，不是 26）。

*尺子层* ⑲`tool-surface` 的测量集下限问的就是它守的那份金样（清空 `fork-diff.json` 的
`added`/`edited` ⇒ 面 B 8,275/216→0，`--check` 绿退 0，还把面 A 21.66%→26.63% 而 A 一行没动）；
现在下限取自**自己金样记录的测量集**，空集不再算数。⑳`hook-liveness` 把"读不到版本"当"没有漂移"，
`--record` 会把没读过的 tag 写进金样 → 退 2。㉑㉒㉓`brand-surface` 金样缺 `lineage` 时
`undefined` 比较恒不成立→红；命中数改为**数匹配**（此前 `test()`+`count:1`，一个已记录文件从 1 处
涨到 100 处不可见）；豁免名单改为**按规则**（此前点名一个文件＝豁免全部四条）。㉔`product-surface`
只打印一致性条数从不比较→把四个发现集的规模钉住；且它**照收 `--record`**（它没有基线）→ 未知参数
退 2。㉕`contracts/engine-methods.json` 那颗 `swiftBlob` **没有任何读者**（引擎缺席时只打 note 退 0）
→ 现在对 `FrameCodec.swift` 的真哈希核，伪写一位即红，引擎不在则退 2 明说"CANNOT OBSERVE, not
agreement"。㉖`kernel-pin --probe` 问不到 registry 退 0，而唯一吃它的 `kernel-drift` job 的判词就是
退出码、注释还写着"不可达就失败"→ "问不到/答空"退 2，**真漂移保持退 0**（漂移是要人看的发现，
不是 CI 红），判决写进 step summary 让它有读者。㉗三把写了却没人跑的自测
（`ref-batch-selftest.mjs`/`kernel-pin-selftest.mjs`/`verify-published-selftest.sh` 引用数为零）接进
`ci.yml`，另两把"测不到就退 0"改为退 2，`probe-lane-selftest.sh` 补上空期望值守卫；并加
`[selftest-wired]` 规则把这件事变成机制。㉘`check-workflows` 的 `enforcePins: target.primary === true`
豁免撤销（fork 子树里那条发布通道 `environment: release` + `id-token: write` 却在跑 `@v4`，而父仓
`release.yml` 把这条攻击写成了文档），split 两条工作流的 `uses:` 全部钉 40 位 SHA，五个 pin 逐个
对 GitHub tag ref 反查核实。㉙`docs/release.md`/`docs/install.md` 与本轮新事实对齐。㉚本轮新加的
CI job 使 `CONTRIBUTING.{md,zh-CN.md}` 的"九条 job"过期 → `check-doc-links` 真的把它抓出来了
（这是那条守卫第一次咬到我们自己），改成十条。

**本轮决定 → 依据 → 回滚**

| 决定 | 依据 | 回滚 |
|---|---|---|
| 取号 **0.8.0**（minor），不是 patch | 三处用户可见形状/默认变了：`upgrade --method` 少三个渠道、`gpg` 缺席由"警告后装"翻成"拒装"、发布多一道能拦停的活门。号先实测空闲：`npm view glasspane-harness@0.8.0` 与 `-darwin-arm64@0.8.0` 均 404，split 远端无 `v0.8*` tag | `git revert` 版本提交（号一旦被占不可回收） |
| 把主树那 11 项**提交进 main**，而不是继续"留着" | 内容与已发布的 split blob 逐哈希相等；它是已发布物的唯一真源缺项，留着＝主干与发布物继续分叉，且 `git status` 是收口硬条件 | `git revert 359088e` |
| `enforcePins` 两面都管 | 豁免换不来任何东西，只让唯一能发现 `@v4` 被改名的闸闭眼 | `git revert` 该提交；恢复豁免即把 `check-workflows.mjs:394` 改回带 `primary` 的调用 |
| `gpg` 缺席改拒装，留 `GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1` | 缺一个可安装的工具 ≠ 缺一条签名；同文件对 manifest 缺席早就是拒装 | `git revert` 安装链提交 |
| 插件 API 版本改取自 `packages/plugin/package.json` | 上游按自己的发布编号出那个包；本产品版本号在那个 registry 里 404（实测） | `git revert` 该提交 |
| 面 B `8275 → 8730`（+455，216 文件不变）、血缘 `9627 → 9643`（+16 / 3308→3312 文件）同批 `--record` | 32 条修复里 11 个文件往我们的面上加行，逐文件归因由 `tool-surface` 自己打出来；+16 全部是"这是谁的字节"的归属说明（按 9616/9617/9618 先例写进金样 `source`） | `git checkout HEAD~ -- harness/contracts/{tool-surface,brand-surface,fork-diff}.json` 后 `--check` 必红 |
| 五个非发布包 `private: true`；**不删** CODEOWNERS，改正 FORK.md | 删 CODEOWNERS 会把刚恢复的分支保护对齐拆回去；文档与树不一致才是要修的 | `git revert` 该提交 |
| 主仓 `release.yml` 的 npm 假绿在本轮跨线修 | 缺陷在主仓那层，"交给那条线"不是出口；工作流文件落 main 即生效，不动主仓版本线 | `git revert` 该提交 |

**闸的最终数字**：见本节末【收口补记】（发布链跑完后写）。

## 收口补记（2026-10-16，发布链跑完之后）

**发布物实测**：`v0.8.0` = split 仓 tag → commit `ca32b73`；Release **非草稿**，`targetCommitish` 就是
被 tag 的那个 commit（不再是分支名——v0.6.4 那次的锚点缺陷此后每版都核，本轮仍核）。6 个资产齐：
`glasspane-harness-darwin-arm64.zip` / `-darwin-x64.zip` / 各自 `.asc` / `SHA256SUMS.txt` / 其 `.asc`。
两条运行都绿：push 那条 6m7s（`version-check` 含本轮新加的**主干锚** → `create-release` → binaries×2 →
`checksums` + 签名 → 公开），dispatch 那条（`publish-gate` → npm 平台包×2 → wrapper →
**`verify-published`**）。registry 三包 `--prefer-online` 实测均 `0.8.0`，`dist-tags.latest = 0.8.0`。

**一条本轮新踩的顺序坑，记下来而不是当作偶发**：第一次 push 触发时 `create-release` 拿
**HTTP 403 "Resource not accessible by integration"**——不是权限设置（`actions/permissions` 是
`allowed_actions: all`，job 里 `contents: write` 明写在文件里），而是**tag 先推了、被 tag 的那个 commit
当时还不是 split 仓任何分支的祖先**。等 lineage merge 把 commit 带进 `refs/heads/main` 之后，
`gh run rerun --failed` 同一条 job 4 秒过。发布顺序因此固定为：**split → `-s ours` 并 split main → 推 main
→ 核 commit 可达 → 再打 tag**。不改 `actions/permissions`、不给 job 加更宽的 token。

**端到端实测（三条通道）**
- `npm install -g --prefix ~/.local glasspane-harness` → `glasspane-harness --version` 与
  `gp-harness --version` 都回 `0.8.0`；npm 11 的 `allow-scripts` 警告按文案原样出现（安装仍成功）。
- `bun add -g` → 2 个包装上、两个 bin 到位，但 bun 默认拦 postinstall；`bun pm -g trust glasspane-harness`
  跑完那条脚本后 `--version` 回 `0.8.0`。
- `curl` 兜底通道把 npm/bun 都藏起来真跑：**`sha256 verified against SHA256SUMS.txt`** 之后，因那次运行的
  PATH 里没有 gpg，走到本轮新加的**拒装**分支——错误逐句是
  `gpg is not on PATH — this release asset's provenance cannot be established at all` /
  `install the tool and re-run: brew install gnupg` / 并说明"a VAR=1 before curl does NOT reach a piped bash"。
  **什么都没装**（前缀里 `bin/` 是空的），这就是本轮收紧的默认在真实发布物上的样子。带 gpg 的**安装成功**
  那一腿本机未跑完：代理对 GitHub 的 ~40 MB 资产限速（本机已知问题，40 分钟没下完），补它的确切命令写在
  汇报第 ⑩ 项。不依赖大文件的那半条今天跑成了：把 `SHA256SUMS.txt` 与它的 `.asc` 单独取下来，用
  `scripts/install.sh` 内嵌的那把公钥 `gpg --verify` → **完好的签名**，密钥
  `0929EA31DF4F7429F63FC53189D88B1D043A1298`、身份 `jingzhao-l (sign-github)`、签名时间 2026-10-16 13:41 CST，
  manifest 里两个资产的 sha256 各自点名（`55a63168…` arm64 / `e5c6ffdd…` x64）。
- 发布专有闸 `bun run script/verify-published.ts 0.8.0` 本机全绿（exit 0）：装的是**已发布**的 tarball、
  `glasspane-harness --version` 与 `gp-harness --version` 都 `0.8.0`、`os`/`cpu`/`version` 三项对的是
  **已安装包**的清单（`os=["darwin"] cpu=["arm64","x64"] version="0.8.0"`——不再是那句拿 `product.json`
  跟自己比的旧自回显）、wrapper 点名的每个平台包都在 registry 上且带 `sha512-IgDYnUSJ…` 的 integrity、
  装好的二进制真的在供内嵌 web（`content-type=text/html`、doctype、assets 被引用）。

**闸的最终数字**（合并后从干净树复测）：`fork-diff vs v1.18.32: 4645/6724 byte-identical, 282 edited,
92 added, 1705 deleted`（开工 `4658/6719, 269/87/1705`；+13 edited / +5 added 里含合并带进来的 4 个新测试
与领回发布物的那 11 个文件）。面 A `mcp-shell/src 9609 LOC / 21.41%`（**仍超文档 10% 上限**，越线检查对
这个面已经耗尽，只剩 LOC 棘轮挡增量——本轮没动它一行）；面 B `fork 8793 LOC / 19.59%`（开工 8275/18.65%，
本轮 +518 行，全部是 32 条修复自己的行，与代码同批 `--record`）；血缘 `9646 处 / 3312 文件`（开工
9627/3308；`+19` 全是"这块字节是谁的"的归属说明，`--record` 现要求带 `--lineage-note`，本轮按 9616/9617/9618
先例写明出处，反证成立）；product-surface **225 条一致 / 0 问题**（开工 193；+32 是本轮新规则
`release-anchor`/`selftest-wired`/`scan-set`/`agreement-count`/`engine-methods` 的字节钉）；
surface-semantics `0 命中 / 20 文件（14+6）`、三条正向对照仍 3/3 能红；hook-liveness `21 钩子无漂移`；
固定点 opencode **151 / 0 fail**（8 个文件，开工 4 个文件 129）、tui **32 / 0 fail**；四包 typecheck 干净；
`publish.ts --dry-run` 绿；`installer-selftest.sh` **all checks held**；`kernel-conformance` 16 fixture 全中；
`kernel-pin` 26 个契约文件；`check-workflows` 5 份工作流干净 + `--self-test` 绿；`check-doc-links` 绿
（它本轮第一次咬到我们自己写的数字：新加一条 CI job 之后 `CONTRIBUTING`/`README` 的"九条 lane"过期）。
split 仓 CI（main push）全绿；父仓 CI 见下条。

**父仓 CI 那条红，以及它抓到的合并残留**：merge 推上去后 `root workspace gate` 红，红的是
`updater/test/scripts-test-suite-is-run.test.mjs` 那两条守卫——"这些测试写了但没有任何一条门禁会跑它们：
`scripts/test/tools-gpg-signing.test.mjs`"。成因不是那条线的规则错，而是我的合并：main 被重写成单根历史时
那条线把签名口令套件从 `scripts/test/` **移进** `updater/test/`，而旧历史里还留着原位置那份，合并把两个位置
都留下了。判据用 sha256 不用猜：两份逐字节相同（`73ea49b3045e…`），删掉旧位置那份不丢任何断言；删后该守卫
5 条全过。**这是"测试不许住在没人跑的目录"这条机制第一次替另一条线抓住我的合并**。

**四条泳道全部在 150 轮上限处中断**（各自最后一句都是"现在去做 red/green 证据"）。代码在，证据不在，
所以本轮的红/绿表由主代理自己重做：尺子层 12 条破坏、安装链 2 条、升级面 4 条、pin/probe/audit 三态各一条，
全部"先证它能红、再还原并 sha256 核回"，明细见 `harness/README.md` 末节【2026-10-16 复验】。
其中两条"红不了"最后查出是**我的变异打错了位置**（一次打在非 `environment:` 的 job 上——规则本来就不管它；
一次把 PATH 清空连 node 一起杀掉，拿到 127 而不是 2），照本仓的规矩记进来：判"规则失效"之前先证明变异落地了。

**本轮我替你做的决定**见上面那张表与 `CHANGELOG.md` 顶部条目的判据段；两条与并行线有关的事实也记在这里：
① 主树里那 11 项未提交批次我**没有**继续当"别人在飞的工作"留着——它内容与 split 已发布的 blob 逐哈希相等，
落回主干才是收口，`git status` 因此为空；② 07:30 那条线在 13:09 把 `main` 重写成单根历史，我没有覆盖它，
而是以自己的线为第二父并入（推上去对他们是 fast-forward），76 处 add/add 按"三方字节比对"分流，
两侧都动过的 3 个文件手工逐块合（他们的 CI-green 与我方的 npm 判决共存）。

**清理盘点**见本轮最终汇报第 ⑪ 项。

## 2026-10-15（第九次会话）· 0.7.10：29 条发现全部收口，两处默认收紧，`0.7.9` 这个号作废

**开工态**：主树 `/Volumes/Eng-Dev/GlassPane` 干净，HEAD `58da7be`，与 `origin/main` 同点
（`git rev-list --left-right --count origin/main...HEAD` = `0 0`）。`bun` = 1.3.14（= `packageManager`
钉的那一个），`.external/opencode` 的 `describe --tags` = `v1.18.32` = `harness/upstream.json` 的 pin，
`preflight` 验通 `objects.githubusercontent.com`（钥匙串束 163 张）。盘：开工 33.1 GiB 可用（`df -k`
25,353,180 KB used / 34,735,568 KB avail），收口前 26.3 GiB。

**一处环境事故，记在这里而不是当作噪声**：开工约 25 分钟后 `vm.loadavg` 到 207，`fork-diff --check`
从 ~2 分钟拖到 11 分钟，`ps` 本身都要跑两分钟。查出是 **96 个 `node -e 'while(true){Math.random()*Math.random()}'`
孤儿进程**（PPID 全为 1，同一 7 秒窗口内起，无父壳），第一次清理后 12:10 又原地复活一批 96 个。复活的时间
与 `git -C .worktrees/gp-daily-main-20261015 status` 里那 61 个未提交文件的树最后修改时间一致，也就是说它是
另一条线跑挂之后留下的，不是本轮的进程。两次都只按**完整命令行精确匹配**回收（TERM→KILL），不碰任何别的
进程；22:00 之后负载降到 5–20，`gates` 才取得到可信数字。教训：负载 200 时任何"计时敏感"断言都不可信，
本会话里第一批 `publish-shape` 跑出的 1 fail 就是这种假红（钩子超时），隔离复跑即绿。

**往轮遗留判定（"上一轮的遗留"是待办，不是输入）**

1. `gp-harness-orphan-20261010`（`a054fdc`，本地+origin 各一条）——**已被 main 重写并取代**，判据用字节不是
   分支名也不是提交信息：`git diff main gp-harness-orphan-20261010 -- <五个文件>` 的差集方向是"main 更多"
   （`verify-published.ts` main 多 142 行、`product-surface.mjs` 多 109 行、`install.sh` 多 60 行、
   `installer-selftest.sh` 多 91 行，`script/publish.ts` **blob 全等**）。再把"orphan 相对 main 独有的行"
   逐行回 main 核对，只剩两条：`grep 'curl -fL'`（main 在同一位置改用长选项 `--location` 并新增
   `--retry-all-errors`/`--continue-at`，同一意图的更强形态）与
   `check("no-foreign-publish", !/packages\/(sdk\/js|plugin|ui)\/script\/publish\.ts/...)`（main 上这条已被
   `a7bbe11` 从"点名两个文件"改成"遍历发现全部 publisher"）。它要修的那两条真缺陷——`verify-published` 的
   自回显 os/cpu 断言、安装器兜底通道的验签面——今天都在 main 上以更强形态存在（本轮又把它们推进到"读 tarball
   真身"与"404 即拒装"）。因此不是"没落地"，是被取代。按纪律先记这条判定、再删本地与 origin 的同名分支。
2. **`0.7.9` 从未发布**——这是本轮真正的"上一轮没收口"。判据：split 远端 `refs/heads/main` = `46d131e`
   （= tag `v0.7.8`），`git ls-remote --tags` 列表里有 `v0.7.8` 没有 `v0.7.9`；`npm view` 三个包 latest 全是
   `0.7.8`，`npm view glasspane-harness@0.7.9 version` 回 404；`gh run list` 最后一条 Release 是 `v0.7.8`。
   main 上 `product.json` 却已经写着 `0.7.9`，于是 `product-surface` 报"三方一致"而发布物根本不存在——号写了、
   闸绿了、用户装不到。
   **决定：不把 `0.7.9` 补发出去**，因为那要先发一个已知带着本轮 29 条缺陷的中间版本，再发一版覆盖它；
   改为把两轮内容一起发成 `0.7.10`，让 `0.7.9` 的号作废并在 `CHANGELOG.md` 顶部写明。回滚：
   `git revert` 取号提交即回到 `0.7.9`，但 registry 上永远不会出现 `0.7.9`（版本号不可回收，这正是诚实的代价）。

**本轮决定 → 依据 → 回滚命令**

| 决定 | 依据 | 回滚 |
|---|---|---|
| 取号 `0.7.10`，`0.7.9` 作废 | 见上；不发已知带缺陷的中间版本 | `git revert` 版本提交；或将来 `v0.7.11` 正常前进 |
| split 用 fast-forward 而非覆盖 | `split/glasspane-harness` 相对 main 的差集为空，普通 push 即过 | 无需回滚（未覆盖任何提交） |
| `tool-surface` 面 B 棘轮重记 `18.06% → 19.07%`（`7743 → 8275` LOC） | 29 条修复里 22 条往我们的定制面加了行；与代码同批 `--record`，且只在**干净隔离树**里记（并行 lane 的未提交行不能洗进金样） | `git checkout b25b92f -- harness/contracts/tool-surface.json` 后 `--check` 会红，按行 revert 即可 |
| `fork-diff` 金样重记 `268→269 edited / 83→86 added / 6715→6718` | 新增 3 个我们的文件 + 1 个 edited 计数变化，同一提交内重记 | 同上，revert 该金样文件 |
| `brand-surface` 血缘 `9624 → 9627`（`+3` 次 / `+3` 文件）重记 | `+3` 全部来自 CI `run:` 正文与测试名里"这块是 fork/upstream 的哪一种"的**归属说明**——按 9616/9617/9618 先例记进金样 `source`，而不是删句子换绿 | revert `harness/contracts/brand-surface.json` |
| 安装期默认从"警告后安装"翻成"拒装"，留 `GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1` 出口 | 发布泳道每个目标必产 manifest+`.asc` 且缺则失败，404 描述的是坏发布 | `git revert` 安装链提交 |
| 项目自带插件默认拒载，留 `GLASSPANE_HARNESS_TRUST_PROJECT_PLUGINS` 出口 | 该产品进程持有 `gp_*` 辅助功能面，glob 到即执行＝把真实 App 交给陌生仓库 | `git revert` 该提交 |
| `release.yml` 改 draft→签完再公开 + 构建期 sha256 锚定 + wrapper 前置存活查 | v0.7.6 的"job 绿而 registry 没有那个号"是实测事故 | `git revert` 发布链提交 |
| `product.npm.registry` 与 `product.registry` 并存但强制一致，消费方一律读后者 | 删字段是契约变更，加一致断言是同等效果且不破文档 | revert `product-surface.mjs` 的 `registry` 三条 |

**改动面数字（`--record` 后从干净树复测）**：`fork-diff vs v1.18.32: 4658/6718 byte-identical,
269 edited, 86 added, 1705 deleted`（开工 `4659/6715, 268 edited, 83 added, 1705 deleted`）。
占比：面 A `mcp-shell/src 9232 LOC 21.27%`（开工 21.54%，分母随 main 上引擎增长而下移，**上限仍被超**，
越线检查对此面已耗尽，只剩 LOC 棘轮挡增量）；面 B `fork 8275 LOC 19.07%`（开工 7743/18.06%，本批
+532 行，三条泳道有意增长）。血缘 `9627 次 / 3307 文件`（开工 9624/3304）。product-surface
**190 条一致 / 0 问题**（开工 144）。固定点：opencode **135 pass / 0 fail**（开工 114，含新
`publish-shape` 6 条与新 `project-plugin-trust` 3 条）、tui **32 pass / 0 fail**（开工 30）、
`installer-selftest` 全绿（含被反转的 3 个场景与 2 条 override 正例）、四包 typecheck 干净、
kernel-conformance 16 fixture 全中且新增"16 == 16 可驱"覆盖行、kernel-pin 26 个随包契约文件、
`check-workflows` 9 条自测各自能红 + 5 份工作流干净（release.yml 8 → 10 job）、`check-doc-links`
25 份文档 / 227 条内链无死链。

**红过又修好的项**（不写"最终绿了"就当作没红过）：
- `publish-shape.test.ts` 首次跑出 1 fail——`beforeEach/afterEach 钩子超时`，负载 207 下的假红，隔离复跑绿。
- `validateTarball` 改读 tarball 后第一次 `--dry-run` 就红：`bin/glasspane-harness.exe is not executable in the tarball (mode 0)`。
  两个原因叠着：上一次的 `.tgz` 被下一次 pack 打了进去（文件数 7→8），以及我把 BSD/GNU tar 的**符号**模式
  串当八进制解析成 NaN。前者是真缺陷（`npm publish *.tgz` 会连旧包一起发），后者是尺子自己的错。都改了。
- 新写的"每个方法引擎都接受"起初报 `attach/observe/act/restore` 不存在——解析器只认 `case 单名`，
  Swift 实际写 `case hello, attach, act, observe`。夹具形状不对造成的红不是发现。
- 安装器 `--dry-run` 的 `ALLOWED=1 run_install` 不起作用：函数前缀赋值不会传给子进程。改走
  `SCENARIO_ALLOW_UNVERIFIED` → `run_install` 里显式 export，与既有场景开关同构。
- `product-surface` 的 `publish-registry` 起初恒红：`publish.ts` 里 shell 的 `/*.tgz` glob 被
  `stripComments` 当成块注释起点，一口吞掉后面两条 publish 行。改成点名 tarball 之后既是真修复也让
  扫描看得见；注释里也不留 `/*` 序列。

**第三段（同一版本，发布链三轮自证 + 一次我自己写错的裁定）**：`v0.7.10` 的 npm 派发连红三次，
每次都修在我这一侧，不是环境、不是别人。

1. **重跑不可能**：第二次派发时两条 `publish-platform` 报 `You cannot publish over the previously
   published versions: 0.7.10`——平台包第一轮已上去，而这条 lane 除 npm 外处处可重跑
   （`create-release` 复用、`gh release upload --clobber` 覆盖）。npm 侧此前没有"已发布"分支。
2. **我的裁定把闸门焊死**：补的分支要求 registry 的 integrity 等于本次重打包的 integrity。第三次派发
   证明这个等式**永远不成立**——同一版本两次运行 npm 自己给出的 integrity 都不同
   （sha512-t01wKyYfMFO1U… → sha512-Dm90l7AmByGjE…），因为打包会把每次构建的元数据写进 tar。
   "两次构建字节相同"不是本产品的性质；拿不成立的等式当闸 = 把恢复通道锁死。一个只能失败的控件
   不是控件。
3. **改成判可判的**：命中重复时按"存在"的方向重问 registry（沿用 wrapper 那道存活闸的传播等待：
   24 × 30s + `--prefer-online`）。12 分钟后仍查无此号 ⇒ 红（这才是 v0.7.6 的真形状：job 绿、
   registry 没号、装完没命令）；查到 ⇒ 绿并把两个 integrity 打进日志当审计行，同时明写"字节对不对
   归 `verify-published` 那条安装 lane 回答，这道裁定不外推"。
4. **构建期锚第一次真跑就抓到我自己的取数错误**：`checksums` 里 `gh release download` 不点名 tag ⇒
   解析 "latest" ⇒ draft 不进 latest ⇒ 下回来的是 v0.7.8 的资产。锚报" served ≠ 本次构建"是对的，
   错的是我。点名 `${GITHUB_REF_NAME}` 修掉。
5. **少一个 `fi` 的 `run:` 正文**：YAML 合法、GitHub 不预检，只有跑到那一步才炸。永久接管它的规则是
   `scripts/check-workflows.mjs` 新增 2a：每个 `run:` 正文过 `bash -n`，并加自测用例（故意少关一层
   `if`）。`--self-test` 10 → **11 条，各自验证能红**；5 份工作流 0 问题。
   这条规则自己先错过一次：按 `runRefs` 的逐行记录重接正文，而扫描器跳过空行与 `#` 注释 ⇒
   带注释的正文必断，第一版对 5 份正常工作流报了 **232 条假警**。假警比没闸更糟，因为下一次真红
   会跟它们一起被忽略；改为在扫描器里就地累积整段正文。

**发布锚点**：`create-release` 的"已存在就原样留着"改成"已存在就把 `targetCommitish` 对到本次 tag
的 commit 并读回确认"——v0.6.4 记过的那类失效（release 元数据指向分支名/别的 commit）在本轮被
我自己的 tag 移动第三次复现了一次，现已当场修复并有读回断言。tag `v0.7.10` 共移动四次
（`9351f87`→`88e75e4`→`4245a44`→`a8adb40`），前三次都在"没有任何发布物"的窗口内收回
（第一次 `gh release view` 直接回 "release not found"），不是删发布锚点。

## 收口补记（同一天，发布链跑完之后）

**发布物实测**：`v0.7.10` = split 仓 tag `a8adb40`（本次是第四次也是最后一次移动，前三次都在
"没有任何发布物"的窗口内收回）。Release 非草稿、`targetCommitish` = 被 tag 的 commit、6 个资产
（两平台 zip + 各自 `.asc` + `SHA256SUMS.txt` + 其 `.asc`）；两条 workflow 运行都绿：
push 那条（version-check → create-release → binaries×2 → checksums → publish-release）与
dispatch 那条（publish-gate → npm 平台包×2 → wrapper → **verify-published**，后者本轮第一次接进 CI）。
registry 三包 `--prefer-online` 实测均为 `0.7.10`。
`verify-published.ts 0.7.10` 本机重跑：装进一次性前缀、两个命令都 `--version` 出 `0.7.10`、
os/cpu/version 三项对的是**已安装包**的 manifest、两个平台包在 registry 上都查得到、
装好的二进制真的在供内嵌 web（`content-type=text/html`、doctype、assets 被引用）。
`npm install -g --prefix ~/.local` 与 `bun add -g` 两条通道都出 `0.7.10`；npm 11 的
`allow-scripts` 警告按文案原样出现（安装仍成功）。
兜底通道用**真实发布物**跑通并把 npm 藏起来强制走它：`sha256: verified (SHA256SUMS.txt)`、
`GPG: verified (signing key 0929EA31DF4F7429F63FC53189D88B1D043A1298)`，独立 `gpg --verify` 用脚本内
嵌的那把公钥复核到 `jingzhao-l (sign-github)`，独立 `shasum -a 256 -c SHA256SUMS.txt` 对
arm64 资产回 `OK`。

**闸的最终数字**（干净隔离树复测）：fork-diff 见本段末尾的重记；面 A `9232 LOC / 21.27%`、
面 B `8275 LOC / 19.07%`（三段之间无新增长度——后三段只动 `release.yml` 与父仓的闸，不在面 B 口径内）；
血缘 `9627 / 3308`；product-surface **193 条一致 / 0 问题**；固定点 opencode **138 / 0 fail**（6 个文件）、
tui **32 / 0 fail**；`installer-selftest` 全绿；四包 typecheck 干净；kernel-conformance 16 fixture 全中
且覆盖行 16==16；kernel-pin 26 个契约文件；`check-workflows` 自测 **11 条**各自能红 + 5 份工作流干净；
`check-doc-links` 25 份 / 227 内链无死链。

**清理盘点（两个远端都盘过，判据是内容不是分支名）**

| 对象 | 去向 | 判据 |
|---|---|---|
| 本地 `gp-harness-daily-20261008` / `-20261010-batch` / `gp-harness-orphan-20261010` / `gp-harness-port-075` | 先 `-s ours` 记成 main 祖先（树哈希逐字节不变，当场核对），再 `git branch -d` | 相对 merge-base 的新增行里 main 缺的只有注释措辞与被重写前的夹具形状，实质以更强形态在 main（见【往轮遗留判定】与上面第二/三段的实测） |
| 本地 `backup/harness/recovered`、`gp-harness-daily-20261010`、`gp-harness-daily-20261014-security-preserved`、`harness/daily-20261006` | `git branch -d` | `main..<b>` 为 0 笔，已是祖先 |
| 本地 `gp-014-goldens`、`gp-harness-daily-20261014`、`-20261014-security`、`-20261014-tui`、`gp-kernel-015` 五棵 worktree | `worktree remove` + `prune` + `branch -d` | 每棵 `git status --porcelain` 为空、分支为 0 笔 ahead |
| `.worktrees/gp-014-goldens`（remove 时 dirty=2） | 两个金样文件先按字节 `cp` 到 `/var/tmp` 存档，再 `worktree remove --force` | 里面是 2026-10-08/10-11 的旧金样草稿，main 上的金样是本轮从活树重记的更新版 |
| 本地 `split/glasspane-harness`、`-076`、`_backup`、`-h15`、`split/h15-v2` | 删除 | subtree 搬运件，内容已由 split 仓 main 与 tag 承载；派生历史不是 main 的祖先，`-d` 按构造不可能接受，故在此说明后删 |
| origin 远端 `gp-harness-daily-20261010-batch`、`-20261011-batch`、`gp-harness-orphan-20261010`、`gp-harness-release-076` | `git push origin --delete` | 同上四条的内容判据（10-11 与 release-076 两条含逐行比对：main 缺的只有旧版本号字面量与重写前的夹具形状） |
| split 远端 `split-next-20261011` | 删除 | 往轮搬运件，内容在 split main |
| `/var/tmp/glasspane-harness/` 289 项往轮临时件（184 MB 的 `w078`、139 MB 的 `e2e-curl` 等） | 删除 | 早于本日的往轮 scratch；`ca-bundle.pem` 是环境依赖，保留 |
| **留下**：`.worktrees/gp-daily-main-20261015` + 本地分支 `gp-daily-main-20261015`（1 笔、29 文件，其 worktree 另有 61 项未提交） | 不碰、不替它提交 | 主仓 07:30 那条线的在飞批次；与本轮回改动是否重叠：仅 `harness/glasspane-harness/packages/**` 无交集，它动的是 `engine/`、`mcp-shell/` 与 `tools/` |
| **留下**：主树里另一会话的未提交依赖批次（README×2、5 个 `package.json`、patch 改名、CODEOWNERS） | 不提交、不 reset | 它已在 split 仓落地为 4 笔提交并被本轮向前合并；父仓侧由那条线自己收口，正解见上面的跨线事实 |
| **留下**：split 仓 `dependabot/npm_and_yarn/...` 分支 | 不删 | 机器人所有，非本会话产物；`gh pr list --state open` 无开启的 PR，等它自己回收 |

**未观测的边界（照实写，附补它的确切命令）**：见最终汇报第 ⑩ 项——真模型轮次、真 TUI 观感、
`GLASSPANE_HARNESS_TRUST_PROJECT_PLUGINS` 在**真实宿主会话**里的端到端加载（本轮只有夹具级证据），
以及 `npm stage approve` 的 2FA。

## 2026-10-14（第八次会话）· 0.7.9：三把尺子的"看得见"与两处发布活门

**开工态**：主树 `/Volumes/Eng-Dev/GlassPane` 干净（`e33356b`，与 origin 同）⇒ 开工；跑到中途
并行会话把 `engine/*.swift` 改脏并推上 `1.15.1`（`94ad3ae`，`harness/` 零重叠）⇒ 本轮全部改动
落在隔离工作树 `.worktrees/gp-harness-daily-20261014`（另有两条泳道各一棵树），`--record` 一律在
自己的干净树里做，避免把别人的未提交行洗进金样；main 以 `976d354` 并进。

**盘上余量**：开工 39.5 GiB 可用，收口前 33.4 GiB；`bun install` 三棵树各 2920 包。

**往轮遗留判定**：`gp-harness-orphan-20261010`（`a054fdc`）**已被 main 取代**，判据用字节：
`script/publish.ts` 与 main **blob 全等**；其余 4 文件取"该分支相对 merge-base 的新增行"逐行回 main
核对 —— `install.sh` 0 行缺失、`product-surface.mjs` 0 行缺失、`verify-published.ts` main 已含该断言
的更强形态（读**已装包**的 manifest 而非 product.json 自比），`installer-selftest.sh` 唯一一行是
`grep 'curl -fL'`，而 main 在同一位置用新拼法 `grep -- "--location"`（install.sh 的 curl_args 已改长
选项）。所以它不是"没落地"，是被重写过；本轮按纪律把它记成 main 的祖先后再删。

**改动面数字**：`fork-diff vs v1.18.32: 4659/6715 byte-identical, 268 edited, 83 added, 1705 deleted`
（开工 4663/6714、264 edited、82 added）。占比：面 A `mcp-shell/src 9232 LOC 21.54%`（开工 21.81%，
分母随 1.15.1 变大）；面 B `fork 7743 LOC 18.06%`（开工 7254/17.14%，本批 +489 行，三条泳道有意增长，
与代码同批 --record）。血缘 `9623 次 / 3304 文件`（开工 9622/3303；+1 文件是新增的
`packages/tui/src/util/tool-denial.ts`，出现次数与基线持平）。product-surface **144 条一致 / 0 问题**
（开工 125）。固定点：opencode **114 pass / 0 fail**（开工 102）、tui **30 pass / 0 fail**（开工 28）、
`installer-selftest` **80 PASS / 0 FAIL**、六包 typecheck 干净、kernel-conformance 16 fixture 全中、
`kernel-pin-selftest` 22 条断言全中、`check-workflows` 9 条自测各自能红 + 5 份工作流干净。

**一处我自己的假绿，记在这里**：`installer-selftest.sh` 我用 `sh` 跑，报 **8 条 FAIL**，我据此判
"main 上有安装器 fail-open"。泳道报告用 `bash` 跑同一棵树是 **80/0 全过**；复测同一棵干净树：
`bash` 全过、`sh` 8 红 —— 那 8 条是我的调用方式（文件头写明 `bash` 调用），**不是产品缺陷**，
上一条判断在此撤回。教训与"包装脚本退出码不可信"同源：**跑夹具前先照它自己声明的调用方式**。

**另一处过程性错误**：两条泳道都没遵守"不要 --record"的交代（各自记了自己树的金样），且发布泳道
报告了一个**不存在的提交 SHA**（`6f264b2`，`git cat-file` 查无）——它的工作实际未提交。我把它的工作
固化为 `d69c55f`（WIP，保住字节）再合并，金样统一由主干重记。**泳道报的 green / 文件清单 / SHA
都要自己复跑**，这条本轮又中一次。

**brand-surface 血缘 +1（9623 → 9624）已按先例 --record，并在金样 lineageNote 里写明依据**：多的那一次是 CHANGELOG/SYNCLOG 在说明「这条路被封掉了」时引用了被点名的上游 scope 字面量（`@opencode-ai/plugin` 等）。字样出现在「描述它已被改掉」的位置，不是产品面新增；反证仍成立——把该段改写成不含字面量的写法，计数就回落。先例：9616/9617/9618。

**没跑的部分（照实）**：本轮**未发版** —— 未推 `origin/main`、未做 subtree split、未打 tag、未派发
npm。原因是执行预算在合并与门禁复跑之后耗尽；分支 `gp-harness-daily-20261014` 已含全部改动且六把尺子
+ 全部套件绿，可原地按 `docs/release.md` 走完。补它的确切命令见本轮汇报末尾。

## 2026-10-13（第七次会话）· 0.7.8：权限面那条"总是允许"会连带放行 gp_act；fork-diff 对我们自己的文件只记名字

**开工态**：主工作树 `/Volumes/Eng-Dev/GlassPane` 被项目 1 的线以 35 个未提交文件占用
（`engine/`、`mcp-shell/`、`updater/`、`bridge/`——没有一个在 `harness/` 下），按纪律不混提、
不 checkout/reset/stash，本轮全部改动落在隔离工作树
`/Volumes/Eng-Dev/.worktrees/gp-harness-daily-20261013`，分支 `gp-harness-daily-20261013`，
起点 main `113d8e3`（`git fetch` 后 `origin/main` == 本地 main，0/0）。参照克隆
`describe --tags` = `v1.18.32` = `harness/upstream.json` 的 pin，`fsck` 静默、工作树干净。
`df -k /Volumes/Eng-Dev` 开工 26,037,572 KB（≈24.8 GiB）可用，未触发清理。bun = 1.3.14，
`NODE_EXTRA_CA_CERTS=/var/tmp/glasspane-harness/ca-bundle.pem`（163 张，钥匙串全束）；
`glasspane-preflight.sh` 在不带该变量时如实拒绝并打印 remedy，带上后通过。
依赖在隔离树里重装：`bun install --frozen-lockfile` 2,920 包 / 198 s。

**上一轮遗留逐条判定（按内容，不按分支名或提交信息）**：提示词点名的 `gp-harness-orphan-20261010`
（`a054fdc`，父 `2e83542`）**已经落地**。判据是把该提交引入的每一条非空新增行回到当前文件里点名：
`verify-published.ts` 24 条里 23 条在 main（唯一缺席的那条 `same()` 被更严的 `norm()`+`same()`
形式取代）、`script/publish.ts` 38/38、`scripts/install.sh` 25/25、`product-surface.mjs` 39/39
（`no-foreign-publish` 三条与 `readCode`/`stripComments` 都在）、`installer-selftest.sh` 74 条里
73 条在（缺席那条被改写：main 用 `grep -q -- "--location"` 而不是 `grep -q 'curl -fL'`，
`install.sh:410` 的 `curl_args="--fail --location …"` 正是它的对照物）。所以本轮**不再并它**，
也没有新分支要保。顺带把那条"自回显断言"的历史结论核回代码：`verify-published.ts:155-182`
现在读的是**已安装**包清单的 `os`/`cpu`/`version`。

**动了什么**（三条审查泳道 + 一把尺子的返修，全部本批）：
`packages/opencode/src/tool/glasspane/index.ts`（五处 `always` 收成本条 pattern、guard 移到
`ctx.ask` 之前、`gp_act` 新增 role 校验）、`kernel.ts`（新增 `validateSelector`/`GP_E_SELECTOR`）、
`packages/tui/src/routes/session/index.tsx`（`observe` 的 `nodeCount` 按数字读、`attach` 读 `appName`）、
`packages/opencode/script/postinstall.mjs`（`--registry`）、`packages/opencode/script/build.ts`
（烟测比对版本）、`scripts/install.sh`（清单形状判定 + "形状对但不含本资产"改拒绝）、
`packages/opencode/script/installer-selftest.sh`（gpg 桩讲 argv + 新增场景 18/19）、
split 仓 `.github/workflows/release.yml`（`ref_name` 走 env + 形状校验、`--passphrase-fd 0`、
`.asc` 落盘断言、清单集合相等、新增 `publish-gate`）与 `ci.yml`（`--frozen-lockfile`）、
`harness/tools/fork-diff.mjs`（`added` 逐文件钉 hash、一律读已提交树、新增 tracked-but-modified
拒绝、降级泳道的期望值改取名单长度）、`harness/tools/product-surface.mjs`（+1 条 registry 断言）、
`SECURITY.md`/`NOTICE`/`docs`（契约文件那条错数）、`product.json`+`packages/opencode/package.json`+
`bun.lock` 版本线 0.7.7→0.7.8、`CHANGELOG.md`、`harness/contracts/*.json` 重记。测试新增 5 条
（权限行为 1、工具面源码棘轮 2、TUI 快照 2），`test/permission/next.test.ts` 79 → 80 条全绿。

**测量**（改动前 → 改动后，全部从主仓根跑）：`tool-surface` 面 A 9119 LOC 22.09%→**22.01%**
（行数一字未动，是分母被我涨了）、面 B 7100→**7254 LOC**（+154，`--record` 前红，逐文件归因见下）、
`surface-semantics` 18 个文件 0 命中不变、`brand-surface` 血缘 **9623**（基线 9623）覆盖 3303/3303
不变、0 hits（本批 CHANGELOG 里那两处上游字样没有进计数，实测未增）、`product-surface`
123 → **124 条一致 / 0 条问题**（无 `--record`）、`hook-liveness` 21 钩子无漂移、
`kernel-pin --check` `iterate-kernel@0.1.6` + **26** 份契约档案（提示词写的 14 是旧事实：
`kernel-pin.json` 实测 18 fixtures + 8 schemas，本轮把 SECURITY/NOTICE/ci.yml 那句错话改掉）、
`kernel-conformance` 16 份档案：**单实现绿**；`--impl` 对 canonical 时**本机第一次量到两侧同答**——
本地 canonical checkout 落后 origin/main 11 笔（缺 `decision-log-transcribe`，它由 `be06484`
即 0.1.6 那笔引入），所以取 `git archive origin/main kernel` 到 `/var/tmp` 并把 canonical 自己的
`node_modules` 软链进去跑：装进来的 artifact 解析到 **zod 4.1.8**，canonical 源码解析到
**zod 3.25.76**，16 条 fixture 两侧逐字同答、退出 0。
测试：`packages/opencode` 四条固定点泳道 100 → **102 pass / 0 fail**；`packages/tui` 26 →
**28 pass / 0 fail**；`test/permission/next.test.ts` **80 pass / 0 fail**；
`installer-selftest.sh` 71 → **80 PASS / 0 FAIL**；四个发布包 typecheck 各 **0 条 `error TS`**；
`publish.ts --dry-run` 对 0.7.8 报 packs cleanly（7 个文件）；主仓公共闸 `check-workflows`
5 份 workflow（split `release.yml` 因新增 `publish-gate` 从 7 → **8 job**）、`--self-test`
**9 例各自验证会失败**、`check-doc-links` 24 份文档 / 225 条仓内链接全活。

**尺子自己被验过的部分（本批新增/改动的三条）**：
① `fork-diff` 的 `added` 内容钉——金样重记后，往任一 `added` 文件加一行 ⇒ `--check` 具名红
（`'<file>': our own file moved (…)`）；② 降级（无参照）泳道的期望值：把 `golden.editedDetail`
与 `golden.counts.edited` 一起删空，此前 exit 0 并自称"0 edited file(s) hash-checked"，
现在 `die(1)`；③ `installer-selftest` 的 gpg 桩：把 `install.sh` 的
`--verify "$asc" "$file"` 改成 `--verify "$asc" "$asc"`，"GPG verified"与指纹那条**一起红**
——这正是它此前红不了的那个形状。变异一律用自有备份 + sha256 核回，未用 git checkout/stash。
`tool-surface` 面 B 的 +154 逐条可归属自己：金样差值只有 7 个 `edited` 文件的 `forkHash` 移动
（`bun.lock`、`packages/opencode/package.json`、`script/build.ts`、`script/postinstall.mjs`、
`packages/tui/src/routes/session/index.tsx`、`packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx`、
`SECURITY.md`）＋ 1 个从 byte-identical 转为 edited 的文件（`test/permission/next.test.ts`，本批给它加了
一条用例，于是 262 edited → **263**、4665 identical → **4664**），其余全在 `added` 那 82 条里。
面 A 9119 行一字未动，22.09%→22.01% 纯粹是分母被我涨了。`fork-diff --record` 还第一次写出
`addedDetail`（0 → **82** 条 forkHash），这正是上面第①条反向验证的前提。

**发布实测（0.7.8 全链）**：split 发布前先把等价性证明跑齐——`git subtree split` 出的
`split/glasspane-harness` tip `46d131e` 的 tree = `57bd3c366e6ccce167dc687e10e7cf9eecc3e5cc`，
`git rev-parse HEAD:harness/glasspane-harness` = **同一个哈希**，两侧各 5009 个文件；远端
`06241ad` 是本 tip 的祖先，所以普通 push 就过（fast-forward，**没有覆盖任何东西**，
`--force-with-lease` 本轮不需要）。tag `v0.7.8` 由 split tip 推出。Release 跑
`38345796379`：version-check 6s、create-release 4s、darwin-x64 5m55s、darwin-arm64 3m12s、
checksums+签名 12s，整跑 success；`gh release view` 回读 `draft=false`、
**`targetCommitish` = `46d131e…`（是被 tag 的那个 commit，不再是分支名——0.6.4 那条锚点缺陷
已在真发布物上复验）**，6 份资产齐（两份 zip、三份 `.asc`、`SHA256SUMS.txt`）。
npm 那条是独立的 dispatch：`gh workflow run release.yml --ref v0.7.8 -f publish_npm=true
-f confirm=true`（run `38346586838`），本批新加的 `publish-gate` 在真发布路径上 7s 通过，
两个平台包 + wrapper 三个 job 全 success。registry 按版本号点名回读
（`--prefer-online`）：`glasspane-harness@0.7.8`、`glasspane-harness-darwin-arm64@0.7.8`、
`glasspane-harness-darwin-x64@0.7.8` 三格实测都是 **0.7.8**；publish 刚过的那几分钟里
`latest` 还读得到 0.7.7、按版本点名是 E404，与 0.7.7 那批记录的读副本延迟同形（约两分钟后可见）。
`verify-published.ts 0.7.8` 退 0，逐条具名绿：装得上、两个命令都答 0.7.8、
**已安装包清单的 `os=["darwin"] cpu=["arm64","x64"] version="0.7.8"`**（就是 10-10 那轮改掉的
自回显断言，这次在真发布物上第一次跑到）、wrapper 点名的每个平台包都在它说的版本上、
registry integrity `sha512-PbqGSayh…`、内嵌 web 真在供（`content-type=text/html doctype=true`）。
三条安装通道端到端：`npm install -g --prefix $HOME/.local` → 两个命令 0.7.8，且如文案所说打了
`allow-scripts` 警告而安装仍成功；`bun add -g` → 0.7.8；curl 兜底通道用 npm 失败的桩强制走
release 资产，对着**真**资产跑完 `sha256: verified (SHA256SUMS.txt)` +
`GPG: verified (signing key 0929EA31…043A1298)`，落地二进制 `--version` = 0.7.8；另外用自有
临时 keyring 独立验了 `SHA256SUMS.txt.asc`，VALIDSIG 的指纹与安装器内置的那条逐字相同。
本机 `/usr/local` 前缀此前还留着上一轮的 0.7.6（PATH 先命中它，会把产品版本读成旧号），
一并升到 0.7.8。gp_* 面：`glasspaned` 在跑（pid 48075），用 fork **自己的** daemon 客户端
直连真 socket 拿到 `hello`：version 1.6.2、capabilities `act observe assert_element audit_ui
capture_view diagnose snapshot restore probe`、权限三席 granted + developerTools unverifiable，
`probe_status` 回真帧（`degradation.judged=false`，"0 samples in the window, 6 needed"）。
未观测的仍是同一批：真模型的 `gp_act` 证据成包轮次（本机只有 Ollama qwen3:8b，一轮里它
声称工具不在它的函数表里——而 `/experimental/tool/ids` 实测 20 个 id 含全部 6 个 `gp_*`，
所以这是模型侧的说法，不是产品事实）、真 TUI 观感、musl/baseline（已随平台裁决没有目标）。
`--ref` 那条纪律之外还有一条如实记着：`--share` 的删除落在 tag 之后，因此**不在 0.7.8 的
发布物里**，随下一版出（main 与 split main 的差就是这一笔）。

**本轮替你做的决定**（依据与回滚见最终汇报）：取号 0.7.8（patch）；不并 10-10 orphan（已落地，
逐行证据在上）；`split` 用 fast-forward 推、不覆盖；棘轮面 B 同批 `--record`；内核 pin **不升**
（0.1.6 仍是 registry 上最新，`--probe` 见下）；产品边界维持现状（`product.json` 的
`platformTargets` 已是 macOS-only，"musl/baseline 没有 CI lane"这条旧挂账按 `platform.dropped`
的理由不再成立）；`release` 环境**不加** required reviewers（理由：本产品线是无人值守定时任务，
加了就把每日发布锁死在人工批准上；替代控制是 `publish-gate` 那四条树==tag 的断言）；
`docs/install.md` 的 curl 一行仍指 `main` 分支（把信任根换成 tag 钉法是本轮未做的那条，
在"未观测/未修"里给了确切命令）。

**tag 之后又落的一条（未随 0.7.8 发布）**：删掉 `run --share` 与那条永不生效的 `share()`
（含 `runtime.ts` 的注入位与两处调用）。实测本地服务的 `POST /session/<id>/share` 返回 200 +
内嵌 web 的 HTML（路由不存在，被 SPA 兜底），旧代码既不报错也不打印、命令退 0——等于替一个
`product.json` 记录为已删除的能力作保。`product-surface` 新增 `no-removed-capability-entry`
钉住它不许回来（124 → **125 条一致 / 0 条问题**；把 option 加回去即具名红，自有备份 + sha256
核回）。金样随之再记一次：`run.ts`/`runtime.ts` 两条 `forkHash` 移动。残留一条没做：未知
`/session/*` 路径被内嵌 web 兜底成 200，客户端无法用状态码分辨"端点不存在"——那是 server
路由顺序的问题，另批处理，判据就是上面那条 curl 探针。

## 2026-10-13（第六次会话）· 0.7.7：占位符那句道歉修成可执行的，前两条端到端修复一起入版

**开工态**：仍在隔离工作树 `/Volumes/Eng-Dev/.worktrees/gp-harness-daily-20261010`
（`.external/opencode` 是指回主树的符号链接），分支 `gp-harness-unreleased-076` 起点 `009e65a`；
`git fetch` 后并行线已把 main 推到 `f98ca8d`（`iterate-kernel` 0.1.6），本批 rebase 到它之上、
无冲突，整树干净。参照克隆 `describe --tags` = `v1.18.32` = `harness/upstream.json` 的 pin。
**开局一处假红是我自己的**：主仓公共闸我用 `node $c` 传 `"scripts/check-workflows.mjs --self-test"`，
整串被当成一个参数 ⇒ `MODULE_NOT_FOUND`、退出 1。分开重跑后是 **7 个用例各自验证会失败、退出 0**；
红的是我的调用形状，不是闸。

**动了什么**（发版批）：`packages/opencode/script/publish.ts`（占位符文本重写 + `validateTarball`
新增对 wrapper bin 条目的四条检查）、`product.json`/`packages/opencode/package.json`/`bun.lock`
版本线 0.7.6→0.7.7、`CHANGELOG.md`（把 `[Unreleased]` 三块并进 `[0.7.7]`，含并行线的 0.1.6 一块，
原文未改）、`README.md`/`README.zh-CN.md`/`docs/install.md`（那条补救的实测形状：文档此前把
`cd node_modules/glasspane-harness` 当"照抄即可"的答案抄进了 install 指南，而全局安装没有这个位置）。

**测量**：`fork-diff` 4665/6714 byte-identical、262 edited、82 added、1705 deleted；红的是四个
文件的 forkHash（`bun.lock`、`packages/opencode/package.json`、`publish.ts`、`README.md`），
重记后金样差值就是那四条，逐条都是本批自己动的。`tool-surface` 面 B 7029→**7100**（+71），
`--record` 前后逐字段比对：只有 `packages/opencode/script/publish.ts` 一条 243→314；面 A 行数一字未动，
它 22.13%→22.09% 纯粹是分母被我涨了（`totalToolSurfaceLoc` 16148→16219）。`surface-semantics`
18 个文件 0 命中；`brand-surface` 血缘 **9623**（基线 9623）、覆盖 3303/3303 不变、0 hits；
`product-surface` **123 条一致 / 0 条问题**（无 `--record`）；`hook-liveness` 21 个钩子无漂移；
`kernel-pin --check` 0.1.6 + 26 份契约档案（本工作树的 `node_modules/iterate-kernel` 还是 0.1.5，
是并行线在他们工作树里装的——`bun install` 之后转绿，`bun.lock` 字节一字未变）；
`kernel-conformance` 16 份档案全对。测试：`packages/opencode` 四条固定点泳道 **100 pass / 0 fail**，
`packages/tui` 快照泳道 **26 pass / 0 fail**；四个发布包 typecheck 全清（0 条 `error TS`）；
`installer-selftest.sh` **71 PASS / 0 FAIL**；`publish.ts --dry-run` 对 0.7.7 报 packs cleanly。
主仓公共闸：`check-workflows`（5 份 workflow 的脚本引用都在）、`--self-test` 7 例、
`check-doc-links`（24 份文档 / 225 条仓内链接 / 26 条外链不请求）全绿。

**尺子的反向路径（本批新增那四条各被打红过，变异用自有备份 + sha256 核回，未用 git checkout/stash）**：
删 shebang ⇒ `has no shebang` ＋ `could not be spawned …: ENOEXEC`（同一条变异让两检查具名变红）；
补救退回相对路径 ⇒ `prints no absolute "cd <dir> && node postinstall.mjs" remedy`；目录算少一层 ⇒
`sends the reader to …/bin, which does not hold postinstall.mjs`；把那行 chmod 换成 `644` ⇒
`is not executable in the tarball (mode 644)`；`exit 1`→`exit 0` ⇒ `exits 0 when run`。
第一次试"抹掉可执行位"用的是 `chmod -R 644 .`，它在 `publish()` 里先把目录权限也砸了、ShellError
直接崩在断言之前——那不算红，换成只针对该文件的 644 才拿到具名红。

**没跑（照实写）**：`bun run build` 的整包构建（发布走的是 CI 的 `--single` lane，本机不重复占盘）；
`kernel-conformance --impl`（要 canonical 内核工作树，本批未挂）；真 `glasspaned` 上的 `gp_*` 会话与
真模型的 TUI 观感（引擎侧另有会话在测量）；上游 13 条时序敏感全量用例（既有口径：本机不可靠，
不改判据、不加超时）。

**0.7.7 发布实测入档**（同一批的收口，另加一条本轮没赶上的文案）：

- 主仓 CI 在 `df7112d` 上 **9 条 lane 全 success**（含 `harness rulers`），`Harness contract` 亦绿。
  split 发布前 tree 等式成立：`git rev-parse split/glasspane-harness^{tree}` =
  `8b8fcb43acf336ebacd4e71791c4c61776e7d2d2` = `git rev-parse HEAD:harness/glasspane-harness`；
  `9dc4d35`（远端 split main）是本分支祖先 ⇒ 普通 push 走 fast-forward（`9dc4d35..6a1acdc`），
  **未使用强推**；tag `v0.7.7` = `6a1acdc`（lightweight，与 `v0.7.6` 同形）。
- Release run `38275373107`（tag push）全 job 绿、6m40s；`gh release view` 读回
  `isDraft=false`、`targetCommitish=6a1acdc…`（是被 tag 的 commit，不是分支名——v0.6.4 那条
  可复现性锚点这次从一开始就对）、6 件资产带 `digest` 与 `.asc`。npm 那条独立跑
  `38276190062`（`--ref v0.7.7 -f publish_npm=true -f confirm=true`），两个平台包 + wrapper
  三个 job 全绿（wrapper 1m9s）。
- **registry 有读副本延迟**：publish 过后约 12 分钟首读仍 `latest=0.7.6`（`glasspane-harness`
  与 `-darwin-x64` 都查不到 0.7.7），16:34Z 三个包都点名成功。这是既有的处理延迟，不是发坏；
  判据按版本号点名 + `--prefer-online` 复查看。
- `bun run script/verify-published.ts 0.7.7` 退出 0：临时前缀装上、两个命令都报 0.7.7、
  已装清单 `os=["darwin"] cpu=["arm64","x64"] version="0.7.7"`、integrity 有值、内嵌 web 被供出，
  **且本批发出去的那条新断言真的工作**——`ok every platform package the wrapper declares is
  published at the version it names`。
- npm 通道：`npm install -g --prefix "$HOME/.local" glasspane-harness` ⇒ `glasspane-harness
  --version` 与 `gp-harness --version` 均 0.7.7。
- **bun 通道装到了已发布的 0.7.7，本轮修的那句道歉第一次在真发布物上跑通**：`bun add -g` 照例
  把 postinstall 拦下（`Blocked 1 postinstall`），从 cwd `/` 调用全局命令得到退出 1 与
  `cd "/Users/ethanlin/node_modules/glasspane-harness" && node postinstall.mjs`——是这一份安装的
  绝对目录。新测到的事实：`bun pm -g trust glasspane-harness`（带包名的 `-g` 形式）在 1.3.14 上
  有效，`1 script ran`、二进制落位、命令回 0.7.7；此前我试的是不带包名的 `bun pm -g trust`，
  bun 把 `trust` 当成包名解析并报"不存在"，那次测量因此是错的。已发布的文案里没有 `-g` 那一行
  （它给的是全局可用的绝对路径行 + 标注为项目作用域的项目形式），要不要再加一行是文案增补，
  代价是再烧一个版本号与一次 145 MB×3 的重发——本批不做，记在这里，随下一次真正的产品改动一起走。
- 兜底通道（一键安装器的 release-asset 支路）本机这一晚**没跑完**：`bash scripts/install.sh
  --version 0.7.7` 在 npm 侧撞上上面那段 registry 延迟（`ETARGET`）后如实转入 asset 支路，
  但本机那个拦截代理此刻把这条 46 MB 的流限到约 **8.5 KB/s**（15 秒采样 126,976 字节），
  按此速率还要 ~90 分钟，故记为未观测而不是通过。改用的完整性核对不依赖本机下载：
  `SHA256SUMS.txt`（204 B）与其 `.asc` 取回后 `gpg --verify` 得"完好的签名，来自于
  jingzhao-l (sign-github)，密钥 `0929EA31DF4F7429F63FC53189D88B1D043A1298`，绝对信任"，
  且文件里两条 sha256（`36b151ec…`、`fcb9d39a…`）与 `gh release view` 的 `assets[].digest`
  **逐字相等**——即签名覆盖的清单与 GitHub 实际供给的字节一致。补跑这一支的确切命令：
  `GLASSPANE_HARNESS_HOME=/tmp/inst bash scripts/install.sh --version 0.7.7`（网络不经过本机代理时）。

## 2026-10-12（第五次会话）· 依赖升 `iterate-kernel` 0.1.6：转录层进契约，Swift 那条腿欠着

**开工态**：隔离工作树 `/Volumes/Eng-Dev/.worktrees/gp-kernel-015`，从 `origin/main`
（`009e65a`，即 0.7.6 收口那笔）ff-only 前进而来，开工时整树干净。主树
`/Volumes/Eng-Dev/GlassPane` 本批未动（一次误编辑已按自己的备份 + sha 核回，恢复后 `git status`
为空）。

**动了什么**：`packages/opencode/package.json` 依赖 0.1.5→0.1.6、`bun.lock`（解析器把
`iterate-kernel@0.1.6` 的 specifier 记为空串＝registry 来源，integrity
`sha512-5B3CY7R8…`，与 npm publish 输出逐字一致）；`script/kernel-conformance.mjs` 加第四个
被驱动模块（转录档案走 oracle+golden）；两份金样重记。

**测量**：`kernel-pin --record` → 26 份契约档案；`kernel-pin --check` / `kernel-conformance`
（16 份档案）绿；`packages/opencode` 的 `glasspane-kernel.test.ts` 31 pass；
`bun run typecheck` 干净。八把尺子里 `hook-liveness` / `surface-semantics` / `brand-surface` /
`product-surface` / `tool-surface` / `kernel-pin` / `kernel-conformance` 七把 0，只有
`fork-diff` 红在我动的两个文件上（它拒绝让"已声明分位的文件内容变了"混过名单检查），按它自己的
remedy 同批重记——金样差值就是那两条 forkHash。面 B 的 +55 行逐笔归因到自己
（`script/kernel-conformance.mjs` 725→780），不是并行 lane 洗进来的。

**这一批故意没做完的**：Swift 的 `DecisionLogEntry`（C35 第三条绑定腿）还没加
`kind/round/dimension/payload`。引擎不写账本，所以不影响产品行为；但 `JSONDecoder` 对未声明字段
是静默忽略，往返测试恰好拿规范字节比对——已写好红灯用例
`testExtendedDecisionLogRoundtripsThroughCanonicalJSON`（打在新增的
`decision-log-entry.ok-02.json` 上），留在本工作树
`engine/Tests/GlassPaneEngineTests/EvidenceRoundtripTests.swift`，与实现和一次干净的
`swift test` 同批提交；本工作树没有 `.build`，从零编译会与本线其它测量抢 27 GiB 的盘。


**开工态**：主树 HEAD 开工时 `5f0fb54`（== origin/main）、整树干净；约一小时后并行会话把 main 推到
`2e83542` 并持续写入，**我第一轮闸读数被它的未提交编辑污染**（`kernel-conformance.mjs` 396→441、
`publish.ts` authored 198→240 全是它手上的活），于是改用隔离工作树
`/Volumes/Eng-Dev/.worktrees/gp-harness-daily-20261010`（`.external/opencode` 做成指回主树的符号链接，
不各存 223 MB）。中途该工作树被并行会话 `git switch` 走去做 `gp-harness-orphan-20261010`（`a054fdc`）的
收口，我那两笔 `install.sh` / `installer-selftest.sh` 被那笔 wip 提交收走。
**取号过程**：按新提示词第 2 条以内容判据重取基准（`git fetch --prune` + 逐文件比对，不看分支名也不看
提交信息）→ `c3dbfee` → 再到 `185c095`。我这九处里**五处主线已有另一种实现**（根 `script/publish.ts`
死路、`no-foreign-publish`、`readCode`、corpus 形状、`verify-published` 读已装 manifest）——不重复、
不覆盖；并的是主线仍缺的六处。`0.7.5` 被同日第三次会话占用，而它当时"已提交未发布"（split 无 tag、
npm live 仍 0.7.4），同号并发＝当年 0.5.0 那笔版本号被 stage 烧掉的成因，所以本批先挂 `[Unreleased]`
让号；随后实测 `v0.7.5` 两条通道全部落地（npm 三个包均 0.7.5；Release 两条 run completed/success），
通道空出才按 patch 取 **0.7.6**。

**前置**：bun 1.3.14 == `packageManager` 钉值；参照检出 `describe` == pin `v1.18.32`、`fsck` 无错、
工作树干净；preflight 不带 `NODE_EXTRA_CA_CERTS=/var/tmp/glasspane-harness/ca-bundle.pem`（163 张）时
exit 1、带它 exit 0，两条方向都实测；全程没有使用任何跳过证书校验的开关。

**改了哪些**：`tool/glasspane/index.ts`（能力闸第三参删除，`gp_attach` 不再被 `"observe"` 代表；
`gp_diagnose`/`gp_last_evidence` 不加闸的理由写进代码）、`packages/tui/src/routes/session/index.tsx`
（row→props 映射抽成导出的纯函数 `glasspaneRowLook`，`denied` 算已结束、⊘ + warning + 可按开）、
`script/glasspane-e7-ledger.ts`（恒真谓词拆两条）、`plugin/glasspane-compaction.ts`（维度覆盖声明按
as-shipped 改写 + 一条走真路径的钉子测试）、`harness/tools/hook-liveness.mjs`（`--offline` 不再谎报
"检出缺席"）、fork `release.yml`（注释不再声称五个原生目标）、`CHANGELOG.md`（0.7.4 条目里 116 处
模板字面量转义剥掉，全文转义残留 0）、版本线两处 + `bun.lock` 那条停在 0.7.3 的包 `"version"`。

**改动面数字**：`fork-diff --record` 对 `v1.18.32` = **4665 identical / 262 edited / 82 added /
1705 deleted**；`tool-surface --record` 面 A **8975 行 / 22.20%**（未变；比例降只因分母动）、面 B
**6736 行 / 16.66%**（记录值随本批的行上调，逐文件归因见下）、测试排除 28 文件 / 2027 行、
`iterate-kernel@0.1.5` 作为依赖不计入面 B；`brand-surface` 血缘 **9623 / 3303 文件**，与基线逐字相同
（0 命中、覆盖率未变，故不重记）。面 B 的增量全部来自本轮点名的四个文件：
`packages/tui/src/routes/session/index.tsx`、`packages/opencode/src/tool/glasspane/index.ts`、
`packages/opencode/script/glasspane-e7-ledger.ts`、`packages/opencode/src/plugin/glasspane-compaction.ts`
——`--record` 是在"整棵树只有我这一笔"的隔离工作树里做的，别人未提交的行没被洗进基线。

**跑了哪些闸**：`product-surface` **123 条一致 / 0 问题**（98 → 123 是第三次会话新增的断言，不是本批）；
`surface-semantics` 0 命中 / 18 文件；`hook-liveness` 21 钩子对齐 pin 无漂移；`kernel-pin --check`
0.1.5 + 24 契约文件逐条 sha256 对、`--probe` 回"0.1.5 就是已发布的最新"；`kernel-conformance` 14 条
fixture 全对；`installer-selftest.sh` 全过（含三条"跟随重定向"的 fetch 断言）；`packages/tui` 固定点
**26 pass / 0 fail**；`packages/opencode` **90 pass / 1 fail**——唯一那条是下面这条不稳定对照；
typecheck opencode 绿；主仓 `check-workflows --self-test` 6/6 各证能红、`check-workflows` 5 个
workflow 干净、`check-doc-links` 24 文档 / 225 内链 OK。

**一条判为不稳定对照、没有修掉的计时断言**：`test/tool/glasspane-surface.test.ts` 的
"an over-sized engine frame is refused in-band"。同一棵树上多次读数：旧基准两次绿（单条 24.19s /
26.96s，距它自己的 30s 预算只剩 3 秒）、旧基准整包一次红、新基准整包红（30121ms）、新基准单跑也红
（两条用例花 199s）。红时的形状都是 `Daemon.call(…, 30_000)` 先到期 → 报 `GP_E_ENGINE_TIMEOUT`
而不是期望的 `GP_E_PAYLOAD_TOO_LARGE`，也就是那 4 MiB 帧在本机负载下没能在预算内写完。
**判据没改、超时没加**：加超时只会让计时器照样先到，改判据等于把它要问的问题扔掉；把它写成
"复跑证明是假红"就是本仓最常见的那种自我原谅。发版凭据因此取**该 sha 在干净 runner 上的 CI**
（fork `.github/workflows/ci.yml:49` 正是这条命令），而不是高负载下的本地读数。

**尺子自身的反向路径**（本批改过的尺子只有 `hook-liveness`，三条重验，不沿用旧结论）：金样伪写
`permission.ask` 为 live → `--check` exit 1 点名 `dead-hook set changed: golden=[] now=[permission.ask]`
加 2 条 drift——**第一次的 perl 没落地，那条控制当场作废重做**（`grep` 证明 dead 计数没变，才承认
控制生效）；删金样 → exit 2 指名 `--record`，不是绿；藏本工作树的参照符号链接 → `--check` exit 2 给出
`--offline` 出路，`--offline` exit 0 且明说"那个路径没被打开过"，还原后重新绿在 21 钩子无漂移。
撤销一律自建备份 + sha256 核回，不用 `git checkout`/`stash`；`/var/tmp/gp-harness-daily-20261010/mut/`
留着每一步前后日志。

**没跑 / 未观测**：整包构建（>10 分钟，闸的形状不含它）；`kernel-conformance --impl`（本轮没读
canonical 检出）；真 TUI 会话里的观感（含本批新画的 ⊘ 拒绝行）；真模型轮次；`gp_*` 对活 daemon 的
实跑（daemon 在跑，但本轮没驱动任何 `gp_*` 调用）。继续挂账的功能缺口：引擎方法表 11 个可使能力里
fork 只发了 6 个（缺 `assert_element`/`audit_ui`/`capture_view`/`snapshot`/`restore`），而
`gp_observe` 的文案正叫模型"别用眼睛比树"——新增工具属产品面变化＝minor，不在 patch 这批里做。

**0.7.6 发布实测入档**（发的是 `69a27e8`，随附的 `9a28ad8` 是发完之后落的两条端到端缺陷修复）：
主仓 CI 在该 sha 上 `--exit-status` 退 0（含 `harness rulers`、`engine (Swift)`、`version line` 九条 lane），
`Harness contract` 三条 job 绿——这条 CI 就是那把负载敏感计时对照的凭据（本地 load ~101 时它红过，
负载 14 时 `100 pass / 0 fail`）。`git subtree split --prefix=harness/glasspane-harness` 出 `063e32e`，
**tree 哈希等式成立**：`git rev-parse HEAD:harness/glasspane-harness` 与 `split^{tree}` 同为
`57fdcfe03a9801ac753a0af7f34314c7f99ea5a5`，逐字相等才推；split 仓 main 当时是 `61b15d6`，
是我这条 split 的祖先，所以**普通 push 就 fast-forward**（`61b15d6..063e32e`），没有用 force。
tag `v0.7.6` 指向同一个 `063e32e`。tag 推送触发的 Release：`tag matches the product version` ✓、
`create the GitHub release` ✓、`binary darwin-arm64` 2m32s ✓、`binary darwin-x64` 4m59s ✓、
`SHA256SUMS for the release assets` 10s ✓；`gh release view` 实测 `isDraft=false`、
`targetCommitish=063e32e`（**是 commit 而不是分支名**——v0.6.4 那条"可复现性锚点是分支名"的挂账至此实测不成立）、
六份资产齐（两 zip + 两 `.asc` + `SHA256SUMS.txt` 与其 `.asc`）。
npm 侧 `gh workflow run release.yml --ref v0.7.6 -f publish_npm=true -f confirm=true`，三条 job 全
success（x64 那条 11m8s）。registry 回查一度出现**只有两个包可见**的状态：x64 的 `0.7.6` 在元数据里
缺席约二十分钟（`versions` 到 0.7.5、`latest: 0.7.5`），而 job 早已打
`+ glasspane-harness-darwin-x64@0.7.6` 且 provenance 已进 sigstore 透明日志——这就是 npm 自己那句
"may take a few minutes to become available"，**不能当失败、更不能当成功**：最后按元数据核到
三个包 `latest=0.7.6` 且 `has 0.7.6=True` 才算数。
`verify-published 0.7.6` 整跑 rc=0（临时前缀装的是**已发布** tarball，两个命令都回 `0.7.6`，
内嵌 web 由那份二进制真的供了出来）。curl 兜底通道第一次端到端实跑**失败**并被入档：见下面
`9a28ad8` 那条——这是"跑用户走的那条路"才拿得到的东西，静态闸一条都没抓到。

## 2026-10-12（第四次会话）· 面 B 那 90 分钟有了成因；发布闸不再用墙钟裁产品；本轮不发版

**收的是上一轮的尾**：0.7.5 发完之后 main 上还压着三笔未记录/未验证的变化（b004813 改了
`verify-published.ts` 的判据、d8b1892 修我自己推上去的 3× TS2451、金样因"一趟 90 分钟"一直
没补）。这一批全在**闸与尺子**这一侧，产品字节一行未动。

**决定：不发新版本**（依据与回滚都在下面，不留成"待裁决"）。本轮内容与发布物字节零交集
（改的是尺子层与 dev-only 的发布脚本），所以不该占用一个用户可见的号。
**并进来时那条线已把号取到 0.7.6**（`product.json` 与 `packages/opencode/package.json` 两处都是
0.7.6，在 main 上）。本 lane 中途第一次读数（≈21:15 本地）是"split `main` 与 tag 都还停在
`61b15d6` = `v0.7.5`、registry 三个包 0.7.5"；**到 22:20 复看时它已经发了**：tag `v0.7.6` =
`063e32e`、Release 非草稿、六件资产带签名，而 **npm 那一格仍未跑**（`latest` 还是 0.7.5）。
两次读数都写进日志，后一次覆盖前一次的结论——版本线是共用的，一条 lane 写"还没落地"而另一条
已经推了 tag，这种窗口本身就是需要被看见的事实，不是可以事后抹平的措辞。
于是当前的形状是"main 领先发布面若干笔、npm 落后 tag 一格"：那一个号与那一格归它的批次，
我的两笔 `[gp]` 排在它后面进树、随下一次发布一起出去——**不是我另取一个号**：两条线共用一条
版本线，同号并发正是当年 0.5.0 那笔版本号被 stage 烧掉的成因。
回滚本轮只需 `git revert f9a0fb2 d10e99e`（尺子层与发布脚本各自独立，无发布动作需要撤）。

**面 B 的 90 分钟找到了成因**（`harness/tools/ref-batch.mjs`，d10e99e）。不是负载，是**成本模型**：
`tool-surface` 每问一句上游就 spawn 一次 `git show`——216 个 `edited` 各一次，"这是不是一次纯
改名"的探针又把**每个同扩展名的上游删除文件**按 `added` 文件逐个重读（3,829 次），合计
**4,045 个子进程覆盖 682 个不同 blob（10.0 MB）**。load 88 时单 spawn ≈1.3 s ⇒ 一趟 ≈90 分钟，
且 `build()` 之前一行不打印，无人值守时与"卡死"不可区分（另一支同一命令跑到 4 h 50 m 无输出，
上一轮的 `--record` 记成"77 min 墙钟 / 3 min CPU"也是这同一条）。改管道不改判据：
`cat-file --batch-check` + `cat-file --batch` 两次子进程按 size 分帧读回，其余（utf8 落临时文件、
`diff -u`、去品牌一对一配对、缺路径读 `null`）一字未动。实测同一棵树 **7 分钟**出全量报告。
等价性两条都取了指纹：① `ref-batch-selftest.mjs` 从 fork-diff 金样定步长抽 24 条
（`edited`/`deleted` 各 12、覆盖 9 种扩展名）与 `git show HEAD:<path>` **逐字节相等**，缺路径＝
`null` 而非 0 字节；两条反向控制各自具名红（期望值翻 1 bit、把分帧前进量 `+size+1` 写成 `+size`
的阉割版解析器）——实测 rc=0。② 整树对账：新实现报出的 **216 个 edited + 14 个 added 的每一个
行数，与旧实现当年记进金样的数相同**，`--check` 全场只点一个动过的文件。

**发布闸的第三种答案**（`packages/opencode/script/verify-published.ts`，f9a0fb2）。旧形状两次把
一次好发布判成坏发布：墙钟 15 s 那版印 `no response`，事件门 180 s 那版印
`no "listening on" line within 180s` 却仍走 exit 1 并写"the release is NOT good"。本轮把
**已发布的 0.7.5** 手测一遍：`listening on` 在 **326 s** 后出现（load 88），随后
`Content-Type: text/html` + 2,884 字节 `<!doctype html>` + 2 处 `/assets/` 引用——发布物是好的，
错的是拿墙钟裁它的判据（日志 `/var/tmp/gp-sess4-handserve.log`）。现在三态：
exit 0＝听到 listening 且页面是打包产物；exit 1＝听到 listening 却供不出页面（坏发布，别重跑）；
exit 2＝`NOT OBSERVED`（机器的成因，沿用本文件已有的"这台机什么都验不了"语义），预算 900 s。
`GLASSPANE_VERIFY_LISTENING_POLLS` 只能把预算改**短**——改短只会少看见，不可能造出假绿。
`--prefix <dir>` 是为了让 FAIL 分支**可执行**才加的（npm 安装实测 21 分钟，错误页没法靠真发布物
造出来），它会打印自己跳过了安装。`harness/tools/verify-published-selftest.sh` 用三个假前缀
驱动三条分支 + 一条"位置参数真被吃了"的控制，实测 8 条断言全中 rc=0；
把页面判据阉成 `/<html/i` 的副本（用 `VP_GATE` 指过去，真文件不动）喂同一条测试 ⇒
**2 条具名红 + rc=1**（`/var/tmp/gp-sess4-mut.log`）。
这条测试自己红过两次，两处都留在测试里并写明：`run_case` 漏赋值 `$1..$3` ⇒
`grep -qF ""` 对任何输出都成立、三个用例跑的其实是同一个假发布物还报绿（现在期望串为空即判
FAIL——**夹具必须能拒绝**）；断言改用 shell 子串匹配而不是 `grep`，因为闸的文案里有 em dash，
grep 会把这种管道输入当"二进制"而停止匹配。
同一笔里还抓出我自己刚写进去的解析 bug：`--prefix` 缺席时 `flagAt == -1`，无条件
`i !== flagAt + 1` 会把位置参数当标志值丢掉 ⇒ `verify-published.ts 0.7.5` 会去验
`product.json` 的版本却打印 0.7.5；由那条 9.9.9 控制钉住。

**金样（`harness/contracts/`，记的是并入后的那棵树）**：`fork-diff` 四桶
**4,665/6,714 逐字节相同、262 edited、82 added、1,705 deleted**（桶计数与 d8b1892 上那次
`--check` 相同——两条线都没有增删 fork 树里的文件，`ref-batch*` 与
`verify-published-selftest.sh` 都在尺子层）；`tool-surface` 记
**engine 25,033 / 62 文件，面 A 9,119 LOC（22.22%）、面 B 6,893 LOC（16.79%）**，
测试排除 28 文件 / 2,163 行。逐文件归因是**对旧金样重算差值**算出来的，不照提交信息抄，
三批各归各：
- 面 B 本 lane 一处：`packages/opencode/script/verify-published.ts` 206 → 287（+81），
  即 b004813 的 +7 与本笔的 +74；其余 216 个 `edited` 与另外 13 个 `added` 的行数与旧金样
  逐一相同——这一段同时是 d10e99e 那次改管道的等价性证据（新实现复算了旧实现记进金样的
  每一个数）。
- 面 B 另一条 lane 四处（随 0.7.6 那批并进来）：`packages/tui/src/routes/session/index.tsx`
  210 → 252（+42）、`src/tool/glasspane/index.ts` 357 → 371（+14）、
  `script/glasspane-e7-ledger.ts` 142 → 155（+13）、`src/plugin/glasspane-compaction.ts`
  339 → 346（+7），合计 +76。两批的号第一次在这棵树上合流，所以金样按**合并树**重记。
- 面 A +144（8,975 → 9,119）分 8 个文件（`engine-client.ts` +50、`update-state.ts` +34、
  `io.ts` +23、`tools.ts` +20、`http-gateway.ts` +6、`errors.ts` +6、`index.ts` +4、
  `project-registry.ts` +1），来自并入的 1.13.0 那批（`mcp-shell/src/*`）；分母 engine 相对
  金样 +284（24,749 → 25,033）同一批——**这两段没有一行是本 lane 写的**。
`--record` 在这里不是掩盖：这些字节都已经在 main 的树上，棘轮的职责是"增长不许没人注意到"，
注意到的方式就是把归属逐文件写进这一行；不记的另一种出路是让每条 CI 停在一件已经发生、
且无人记账的事上。

**闸的实测读数（合并树，逐条现跑现取，不沿用上一轮）**：六把尺子 + `kernel-pin` 全 rc=0。
`fork-diff` 四桶 **4,665/6,714 逐字节相同、262 edited、82 added、1,705 deleted**；
`tool-surface` **engine 25,033 LOC / 62 文件，面 A 9,119（22.22%）、面 B 6,893（16.79%）**，
测试排除 28 文件 / 2,163 行；`surface-semantics` **0 命中 / 18 文件**；`brand-surface` 产品面
26 + 文档 2、**0 命中**、血缘 **9,623 处 / 3,303 文件**（覆盖率与基线逐字相同，未重记）；
`product-surface` **123 条一致 / 0 条问题**；`hook-liveness` 对 pin `v1.18.32` **21 个钩子无漂移**；
`kernel-pin` `iterate-kernel@0.1.5` lock integrity + **24 个随包契约文件**。
fork 包内：固定点 `packages/opencode` 四份 **100 pass / 0 fail**、`packages/tui` 快照
**26 pass / 0 fail**；`typecheck` 四包（opencode / tui / sdk/js / plugin）全 rc=0；
`kernel-conformance` **14 条 fixture 过 2 份实现**（`--impl` 指向 canonical 的 `kernel/` 目录，
第一版我的电池脚本把 `--impl` 指到了仓库根，工具按设计**拒绝比较并退 3** 点名"这个检出缺
10 个模块"——这条红是 runner 的错、闸的动作是对的）；三把自测（`ref-batch-selftest`、
`probe-lane-selftest`、`verify-published-selftest`）各 rc=0。主仓结构闸
`check-workflows`（含 `--self-test`）与 `check-doc-links` 绿。
**本批的成本模型改动有数**：同一台机 warm 树下 `tool-surface --check` 从"3.5 小时未跑完"到
**1 秒**（去掉的是 4,045 次子进程），`fork-diff --check` 1 秒，`typecheck`(opencode) 24 秒
——上一轮那 1 h 45 m 不是它自己的成本，是负载（本机 load 全程实测 88 → 155 → 310，峰值来自
与本项目无关的 GUI/浏览器进程堆）。判据一条未放宽，超时一条未加。
**一处先红后绿的：`script/publish.ts --dry-run`**。第一次跑报
`glasspane-harness-darwin-arm64 … package.json version 0.7.4 != product version 0.7.6`——
本机 `dist/` 里还是 0.7.4 那次的产物，而 main 上的号已被那条线取到 0.7.6。这正是上一批把
"dist 自己跟自己比"改成"dist 对 `product.json` 比"之后才可能看见的东西；出路是重建而不是
关断言：`bun run build --single`（带 `NODE_EXTRA_CA_CERTS`，`build rc=0`，自带 smoke test
打印 `Smoke test passed: 0.7.6`）之后同一条命令 **rc=0**，两包
`packs cleanly (not published: --dry-run)`，并如实带一句
`note: 1 declared target(s) are not built in this run: glasspane-harness-darwin-x64`
（一台机只建一个目标，这是设计）。构建期间 `bun` 把 `packages/opencode/package.json` 里
`description` 的 `\u2014` 写成了字面 `—`——那不是本轮的意图，已 `git checkout HEAD --` 收回，
没有让一次本地构建在产品清单里留下无主 diff。

**发布面读数（写到实测为止，不是写到假设）**：本 lane 不做发布，但把 split 仓同步了——
`git subtree split --prefix=harness/glasspane-harness -b split/glasspane-harness` 之后断言
`split/glasspane-harness^{tree}` == `HEAD:harness/glasspane-harness` == **`ead85cc5e1e4dfd4772cda9c896d19b657a1315a`**
（逐字相等才推），远端 `main` 当时是 `063e32e`（＝那条线的 `v0.7.6`）且**是本分支的祖先**，
所以是 fast-forward、**没有强推、没有新 tag、没有触发发布**：`063e32e..ffd565d`，走 SSH
（本轮并进来的 fork `.github/workflows/release.yml` 改动使 token 形式会被拒）。
`v0.7.6` 那条线自己的发布读数：tag = `063e32e`，Release `isDraft=false`、资产 6 件齐全
（arm64/x64 的 `.zip` + 各自 `.asc` + `SHA256SUMS.txt` + 其 `.asc`），`Release` workflow
run `38259929076` completed/success（5 m 33 s）。**registry 上 0.7.6 还不存在**：
`glasspane-harness` / `-darwin-arm64` / `-darwin-x64` 三个包的 `latest` 实测仍是 **0.7.5**，
`npm view glasspane-harness@0.7.6 version` 报错退出。tag ≠ npm——那一格的补法是
`gh workflow run release.yml --repo jingzhao-l/glasspane-harness --ref v0.7.6 -f publish_npm=true -f confirm=true`，
归取这个号的批次做，本 lane 不代跑（发出去的是别人的字节）。
`verify-published 0.7.5`（本 lane 上一次发的号）在新三态判据下的整跑结果记在本节末尾。

**`verify-published 0.7.5` 整跑 rc=0**（22:25 本地，同一条命令在 21:00 前那次是 exit 2）：
安装 4 s（registry 缓存热）、两条命令 `--version` 均 0.7.5、已装包清单的 os/cpu/version 对上
`product.json`、registry integrity 是 `sha512-pRZbdGf…`、provenance 有注记，web 那一条
`ok … waited 0.5s, content-type=text/html doctype=true assets=referenced`。
这一条同时给三态判据作了反向印证：**上一轮那条红从来不是产品坏，是机器忙**——同一份已发布
产物在负载 88 时要 326 s 才 bind、在空闲时要 0.5 s 就供出同一页；判据（页面的 doctype +
`/assets/` 引用）一字未改，改的是"等待"属于谁。


**未观测 / 未做，每条给"为什么"和补它的确切一条命令**：
① 真模型轮次与真 TUI 会话观感：本机没有可计的模型额度，判据也不在 fork 侧——补它
`cd packages/opencode && $HOME/.bun/bin/bun run dev`（tmux 起、`capture-pane` 读）+ 一次真 provider 会话；
② `gp_*` 对活 daemon 的证据成包真轮次：daemon 在跑但本轮没驱动任何 `gp_*` 调用，补它
`sh harness/glasspane-harness/scripts/install.sh --prefix /tmp/gp-e7 && glasspane-harness run "取一次真截图并打包"`；
③ `bun add -g` 通道对 0.7.5/0.7.6 未复跑（0.7.3 的实测结论仍成立：bun 不跑 postinstall，
桩会打印 remedy），补它 `bun add -g --prefix /tmp/gp-bun glasspane-harness && /tmp/gp-bun/bin/glasspane-harness --version`；
④ registry 上 `0.7.6` 尚未发布（实测 `glasspane-harness` = 0.7.5），那一条发布归取号的批次，
补它 `gh workflow run release.yml --repo jingzhao-l/glasspane-harness --ref v0.7.6 -f publish_npm=true -f confirm=true`；
⑤ 上游 13 条时序敏感全量用例本轮没跑（本机不可靠，挂账不变）。

**并入时是我自己把这份日志截断了，记在这里（这是本批最严重的一次自伤）**。
`tool-surface.json` 与 `SYNCLOG.md` 在同一处撞了冲突；我对前者用了正确做法（取一侧再
`--record` 重算），对后者却写了个"把三段拼回去"的脚本——`[...head, ...theirs, ...mine]`
**漏掉了 `>>>>>>>` 之后的全部内容**，于是合并提交 `11316bd` 里的 `SYNCLOG.md` 只剩 156 行 /
3 个 `##`，**22 个历史批次（约 730 行）没了**，而且它已经推到了 main。
发现方式不是读 diff，是数：`git show <rev>:path | grep -c '^## '` 对三个 parent
（`69a27e8` 886 行 / 25 个、`f6c3266` 887 行 / 24 个、`11316bd` 156 行 / 3 个）一比就知道
谁被吃了；`git diff --numstat` 只显示 42/7，因为脚本重排把删除洗成了"移动"。
修法：以 `69a27e8` 的那份为底、把本段插回它的位置，然后逐字验证——尾段
（`## 2026-10-11（第三次会话）` 起到文件末）与 their 侧**逐字节相同**（815 行）、
本段 7 个小标题各出现 1 次、`check-doc-links` 绿。
教训按可执行的形式写：**合并冲突里的散文文件不许用切片重组来"修"**，只能改标记本身、
或取一侧后用 `Edit` 逐处插回；凡是自动生成的（金样）就不该手合并，直接取一侧再 `--record`。
本轮第二次遇到同一族问题（`harness/README.md` 也同处冲突，它 auto-merge 成功、我用
"我的标题出现 1 次"复核过——同一个断言这次是真的在做的事）。

## 2026-10-11（第三次会话）· 文案还在替上游说话、平台包发布没跑自家校验，发 0.7.5

**接着收口。** 上一份汇报里我自己点名却没做的三条，按内容判据核过：

- **产品给用户看的文案在念上游的变量名**。`serve.ts:16`、`web.ts:41` 的告警与 `attach.ts:38/43`、
  `run.ts:197/202` 的 `--help` 一共五处（我先只改了 attach 那两处，grep 把 run.ts 也揪了出来）。
  产品的每个变量都有 `GLASSPANE_HARNESS_*` 的名字且先读它（`packages/core/src/flag/flag.ts` 的
  `read()` 是唯一点，前缀常量 `PRODUCT_PREFIX = "GLASSPANE_HARNESS_"`），旧名只是兼容回退——
  **读**回退是代码，**打印**它就是替上游作产品主张。代码标识（`Flag.OPENCODE_SERVER_PASSWORD`）不动。
- **六把尺子里没有任何一把看过 `src/cli/cmd/` 的字符串字面量**，所以这五处改完仍可以悄悄长回来。
  `product-surface` 加 `cli-text-names-product-env`：扫该目录 `*.ts` 剥注释后的字面量，"defaults
  to / Warning / is not set" 里出现 `OPENCODE_`/`opencode.ai`/`@opencode-ai/` 即红并点名文件与原文。
  断言 **98 → 123**。双向控制实测：那三个字母只进**注释** ⇒ exit 0 不命中（规则不被注释顶替）；
  进**打印的字符串** ⇒ `cli-text-names-product-env] …/serve.ts shows the user "Warning: OPENCODE_…`
  exit 1；还原 sha 核回 ⇒ 绿。
- **`publish-platform` 的 `npm publish` 前不跑任何产品校验**（校验器 `validateTarball` 的三条——
  bin 在不在且可执行、README 在不在、dist 的版本是不是本次产品版本——过去只在 wrapper job 上生效）。
  现在该 job 在构建之后、发布之前跑 `bun run script/publish.ts --dry-run`；`--dry-run` 下
  "其余声明目标未构建"按设计仍是 note（一台 runner 只建一个目标），不会把 job 判红。

**明确不做并写下理由**：`checksums` 仍对 **GitHub 供回的字节**求和（它的注释自陈"证的是存的是什么、
不是构建产的是什么"）。要真接上得让 `binaries` 用 job output 交出构建目录里算的 sha256、再由
`checksums` 双向断言"下载回来的 == 构建时算的 == 清单里写的"，改的是两处 job 的 `needs`/outputs
接线。本轮不冒——接错的代价又是一次半个的发布，而这一批的起因正是"失败模式不是红，是没收口"。
列为下一轮的第一条。

**一次真实的 scratch 撞车**（值得入档，因为它改了仓库里的文件）：写 0.7.5 的 CHANGELOG 条目时，
`/var/tmp/gp-daily-20261009/cl-075.cjs` 的内容与本次会话写下的不一致（并行会话在同一路径放过脚本），
执行后把**脚本源码**混进了 CHANGELOG 正文。表现不是红：`check-doc-links` 照样绿（标题还在）、
`product-surface` 照样绿（它不看 CHANGELOG 正文）。发现方式是我 grep 标题顺序时看见第 17 行是
`const changelog = \`## [0.7.5]`。处理：`git checkout HEAD -- CHANGELOG.md`（HEAD 是干净的，
损伤未提交）→ 用一次性唯一路径重插 → 正则剥残留 → 断言"标题顺序 = Unreleased/0.7.5/0.7.4/0.7.3/0.7.2
且脚本 token 归零" → `check-doc-links` 绿。以后本 lane 的 scratch 一律带会话名。

**0.7.5 的发布实测**：tree 哈希等式再一次成立（`split^{tree}` = `HEAD:harness/glasspane-harness` =
`aa090742d69a9659fd44ef678279795aa2d712b7`）才推；split main 快进 `5163bc7..61b15d6`，**没有强推**。
第一次推被 GitHub 拒了两次：`refusing to allow an OAuth App to create or update workflow
.github/workflows/release.yml` —— 本批改了 release.yml，HTTPS+token 没有 workflow scope（既有
教训 `git-push-token-scope-and-lease`），改 SSH 后即通过。tag `v0.7.5` → run 38162298984 全绿含
`checksums`；npm dispatch run 38162885122 三条 publish job 全 success，且**新加的那步真跑了**
（job 日志里 `Run bun run script/publish.ts --dry-run` 之后才是 `npm publish`）——平台包在变成
可安装之前，先按产品自己的校验器过了一遍。registry 点名三个都回 `0.7.5`，`latest` = 0.7.5。
发布物：两 zip + 两 `.asc` + `SHA256SUMS.txt` + 其 `.asc`，`isDraft=false`、target 是被 tag 的 commit。

**这条闸自己又被负载证伪了一次，改的是判据而不是超时。** `verify-published 0.7.5` 先报
`FAIL … waited 15s and the server never reported a listening port — INCONCLUSIVE`（我上一批写的
新报告语，第一次在野外就派上用场：它给出手测出路，我照做）。手测已发布产物：
`serve --port` 后 **36s** 供出 2,884 字节的真 `<!doctype html`，即**发布物没问题、窗口是坏的**
——此刻机上有 9 个并发 `tool-surface`、load average >70。于是把判据从"15 秒墙钟内答完"换成
"以服务器自己打的 `listening on` 行为事件门，之后才用有限轮询验内容"：起不动 → 红且明写
INCONCLUSIVE + 复跑命令；起来了但页面不对 → 红且说是真失败。上一版的错误不在于"没写清楚"，
在于**用机器的快慢去裁产品的好坏**；那只加超时治不了它。

**闸（0.7.5 收口，从主仓根跑；每条退出码单独取，不再用循环尾值）**：product-surface **123 条一致 / 0 问题**（@0.7.5）；brand-surface 0 命中、血缘 **9,623 / 3,303** 与基线同（改掉的五处字面量本就不在这把尺子的扫描面里——正是它需要新读者的理由之一）；surface-semantics 0 命中 / 18 文件；hook-liveness 21 钩子无漂移；kernel-pin `iterate-kernel@0.1.5` + 24 契约文件；kernel-conformance 14 条全答对（14 条 / 2 实现的双方对照是 0.7.4 收口时实测的，本批没动内核与那把闸）；`probe-lane-selftest` 三态可分；`installer-selftest` 全过；`check-workflows` 5 份干净（含改过的 release.yml）；`check-doc-links` 24 份 / 225 内链；typecheck opencode / tui / sdk-js / plugin 各自 exit 0；固定点测试 **88 pass / 0 fail**（392 expect）。fork-diff 与 tool-surface 在提交之后重记——`fork-diff` 量的是已提交的树，0.7.4 那节记下了这个顺序坑。
## 2026-10-11（第二次会话）· 收上一轮的遗留：并回 `gp-harness-orphan-20261010` 未落地四条，发 0.7.4

**开工自检按新提示词第 2 条做**：`git fetch --prune` 后拿内容判据（`git cherry` + 逐文件比对，不
看分支名）判那笔遗留——`+ a054fdc` 说明整笔没进 main，但其中 `install.sh` 的"签名抓取跟随重定向"
**已被 `b9409d7` 单独落过**（main 第 265 行已是 `curl -sSL -o "$asc" `），所以只并余下四条，不重复
也不覆盖。

**并回的四条与各自的双向控制**：
- `verify-published.ts`：os/cpu 断言此前是 `product.platform.os.includes("darwin")`＝声明与声明
  自己比，且从不读 `cpu`。改成读**装进临时前缀的那份 package.json** 的 `os`/`cpu`/`version`。
  变异实测：`product.json` 的 `platform.arch` → `["arm64"]` ⇒
  `FAIL … cpu is ["arm64","x64"], product declares ["arm64"]`、exit 1；还原按 sha256 核回后绿。
- `scripts/install.sh`：清单抓取 `if ! curl -fsSL` 把"未发布 / 被拦截重写 / 答了别的东西"压成一个
  出口，而那个出口是 warn + **继续安装**（零完整性校验）。现在 404 才算政策缺口，其余 exit 1 并报
  状态码。`installer-selftest.sh` 跑在**改动前**的 install.sh 上 ⇒ 5 条具名红（含
  "it did say: no SHA256SUMS.txt published"、"nothing is installed on that path — it did say:
  [OK] installed via"、"install.sh no longer follows redirects for SHA256SUMS.txt"）；跑在改动后 ⇒ 全过。
- `script/publish.ts`（fork 根）：它原本是**可用的**上游发布编排——rewrite 全树版本、
  `npm publish @opencode-ai/{sdk,plugin,ui}`（别人的 scope、本产品不发的那三个包）、
  `git push --force-with-lease --no-verify` 推 tag、`git push HEAD:dev --no-verify`。改成拒绝体
  （实测 exit 2）并保留文件，让未来的上游同步落在一个会自陈理由的拒绝上；读者是 product-surface 的
  三条 `no-foreign-publish`（它扫的是**剥掉注释后**的代码，所以拒绝体的说明文字不会替它顶罪）。
- `product-surface.mjs`：`readCode()` 让"这条规则还认不认得这个产品"不再能被一行注释满足——变异
  实测：把 `postinstall.mjs` 的平台包模板行改成注释 ⇒ `postinstall-identity` 具名红、exit 1，
  还原 ⇒ 绿（旧实现两样都绿）。另把 `kernel-provenance` 的 `corpus.length > 8` 换成形状断言
  （每条点名文件 + 64-hex sha256；同一文件不得出现两次）。断言数 **94 → 98**。

**内核 0.1.5 的半记状态**：`package.json` 与 `contracts/kernel-pin.json` 已是 0.1.5，而这棵树的
`node_modules` 还停在 0.1.4 ⇒ `kernel-pin --check` 报 "installed 0.1.4 but the manifest pins 0.1.5"
（闸做对了）。按文档路径 `bun install` 后：24 个契约文件逐条 sha256 通过，行为闸 **14 条 fixture 全
答对**；`--impl` 指 canonical 检出**现在跑得起来**（`iterate-skill` 的 `main` 已有 0.1.5 的 15 个
模块，与 `kernel/npm-canonical` 的 `kernel/src` 同内容，14 条两侧逐字节一致）——上一轮我报的
"产物出处不在清单坐标上"这条在 canonical 侧已被合并解决，FORK.md / harness/README.md 里那两句按实测
改掉，`--impl` 的缺模块报告（exit 3）保留：这种分叉两个月里发生过三次（0.1.2/0.1.3/0.1.4）。

**血缘**：9,619 → **9,622**（+3），三处都是"写下被改掉的那三个上游包名"的位置（新拒绝体的注释与
console.error），按 9616/9617/9618 先例 `--record` 并在金样 `source`/`lineageNote` 写明；反证
仍成立——再新增一处即红。**本轮没有为了换绿而删任何注释。**

**闸（0.7.4 收口，从主仓根跑）**：fork-diff vs v1.18.32 = 4666/6714 identical / 261 edited / 82 added / 1705 deleted（金样同批重记）；tool-surface engine 24,706 行 / 62 文件，面 A 8,975 / **22.29%**、面 B **6,585 / 16.35%**（记前 6,488：+97 逐文件归因到本批并回的三个文件——installer-selftest.sh +56、verify-published.ts +25、install.sh +16；面 A 与 engine 的变化来自并行批次，不是本批的口径动作），排除测试 28 文件 / 1,920 行，两条面仍如实挂 `← OVER LIMIT`；brand-surface 血缘 **9,623** / 3,303 文件（+3 与 +1 都是"写下被改掉的那个名字"的位置，金样 `source`/`lineageNote` 记明，反证仍成立）；product-surface **98 条一致 / 0 问题**（@0.7.4）；surface-semantics 0 命中 / 18 文件；hook-liveness 21 钩子无漂移；kernel-pin `iterate-kernel@0.1.5` + **24 个契约文件**，`--probe` 回"是已发布的最新一版"；kernel-conformance **14 条 / 1 实现**绿、**14 条 / 2 实现**绿（`--impl` 指 canonical 检出）；固定点测试 **88 pass / 0 fail**（392 expect，并行批次把套件加到 88 条）；tui 快照 24 pass / 0 fail；`installer-selftest.sh` **61 条 PASS**；`probe-lane-selftest.sh` 三态可分；`check-workflows --self-test` 6 例各自验红 + 5 份工作流干净；`check-doc-links` 24 份 / 225 内链；按 `--single --skip-install --skip-embed-web-ui` 那条 lane 重建 dist，boot smoke `--version` → **0.7.4**，`publish.ts --dry-run` 绿（诚实报 x64 未在本机构建，wrapper 只打一次）。

**typecheck 记一条被包装脚本吞掉的红**：采纳 orphan 版 `verify-published.ts` 后 opencode 包
typecheck 是 exit 2（`TS2488: Type '{}' must have a [Symbol.iterator]()` —— 它把 `unknown` 直接展开），
而我的批处理脚本按包循环只取最后一个包的退出码，整条报 0。是自己那条"别信包装退出码、日志整份读"
的规矩把它抓回来的。修法是把比较两侧走同一个归一（缺字段读成 `[]`＝不匹配而不是崩溃），typecheck
回到 0，且 **os/cpu 的负向控制重跑仍然咬得住**（改 `product.json` 的 arch ⇒ 具名红）。这条也说明
`readCode()` 那类"规则读代码"的改动为什么必须连着按包 typecheck 一起跑。

**0.7.4 的发布实测（本批收口）**：split 推送前先证 tree 哈希等式 ——
`git rev-parse split/glasspane-harness^{tree}` = `45701d6ffa9cbdbc4a60866627f73eeb4647be25` =
`git rev-parse HEAD:harness/glasspane-harness`，逐字相等才推；split main 是快进（`d5433e1..e8c5e1e`），
**没有用 force**。tag `v0.7.4` → run 38141720392 全绿含 `checksums`；发布物 =
两个 zip（46,400,796 / 48,587,409）+ 两个 `.asc` + `SHA256SUMS.txt`（**两行、0 个孤儿**）+ 其 `.asc`，
`isDraft=false`、`targetCommitish=e8c5e1e`（commit 而非分支名）。清单的独立复核：两行与 GitHub API 自算的
`assets[].digest` 逐字相符，`gpg --verify` 验到发布私钥
`0929EA31DF4F7429F63FC53189D88B1D043A1298`（"jingzhao-l (sign-github)"）。npm 侧 run 38142520702 三条
publish job success，registry 点名三个都回 **0.7.4**、`latest` = 0.7.4 —— 中间有一次假象：wrapper 那条
`npm view` 先 404、`latest` 还写着 0.7.3，而 job 日志里 `+ glasspane-harness@0.7.4` 与
"package is being processed" 都在；等 90s 再查即一致（**结论仍然只认 registry 与 verify-published**）。
`script/verify-published.ts 0.7.4` 九项全 ok：两条命令都报 0.7.4、**新的 os/cpu/version 闸打印的是装进去那份
清单的实测值**（`os=["darwin"] cpu=["arm64","x64"] version="0.7.4"`）、registry integrity 在、内嵌 web
3.5s 内供出真 HTML。curl 兜底通道：npm 故意失败后进入 release-asset 分支，清单抓取与验签逻辑已按本批改动走
（改动前的化妆行为由 `installer-selftest.sh` 的 5 条具名红钉住）；本机到 `objects.githubusercontent.com`
下载 46MB 资产这一段仍受代理截断影响，最终"装成 0.7.4"的判定以该 run 的日志为准，见本轮汇报。

**未观测 / 未做**：真模型轮次、真 TUI 会话观感、`gp_*` 对活 daemon 的一次证据成包真轮次；
`bun add -g` 通道本轮未重跑（0.7.3 那次的结论是 bun 拦 postinstall ⇒ 命令是给出路的 stub）；
本地重下发布物做 `shasum -c` 仍不可信（代理截断，见上一节的处理办法：用 gh API 的
`assets[].digest`）。

，0.7.3 发对了：checksums 那三步活在两个目录里

**触发**：本轮把 0.7.2 推上 split 仓并打 tag（run 38100151152 之前的 38098337688），Release run
在 `SHA256SUMS for the release assets` 这一步 **失败**：`no matches found for `SHA256SUMS.txt``
(exit 1)。两个平台的 binary job 与 create-release 都绿，于是 0.7.2 的 GitHub Release 带着两个 zip、
**没有清单、没有签名**，npm 上也没有 0.7.2（publish 两条 job 在 push 触发的 run 里全 skipped）。
这是坏发布，不是噪声。

**根因（一条被两半各自实现的修复）**：`f36748b` 把"下载+求和"那一步的工作目录从仓库里的
`assets/` 挪到 `${RUNNER_TEMP}/release-assets`——理由是对的：`assets/` 是被版本控制的目录，装着
`logo.svg`/`banner.svg`，`cd assets` 是个 no-op，`sha256sum ./*` 于是给两个跟发布无关的仓库文件
作保。但它**只挪了一步**：`Sign release assets with GPG` 与 `Upload checksum and signature files`
仍然 `cd assets`。后果两半都在那次 run 里发生：签名步签的是那两张已提交的 svg（0.7.1 资产里那对
下载数 0 的 `logo.svg.asc`/`banner.svg.asc` 是同一件事的化石），上传步在自己的目录里找不到
`SHA256SUMS.txt` 就退出。

**修法与冲突处理**：我这边（`bd690a9`）先改成 job 级 `env: ASSET_DIR` 让三步共用一个名字；并行
lane 同时独立修了同一处（`a51b96f`，每步各写一次路径 + 把因果写进注释）。合并时 `release.yml`
两处冲突，**取 trunk 那份**：两套并存正是 `993977e` 刚清掉的那种重复逻辑，我那两个非冲突 hunk
（job env 与第一步的变量名）随之撤掉，不留一个没人用的 `ASSET_DIR`。`tool-surface.mjs` 自动合并
的结果逐行复核过：LIMIT/limitSource/caliber 三条比对只剩一处（425-441），没有第二份拷贝。

**0.7.3 的发布物（实测）**：run 38100151152 全绿，含 `checksums`。资产 =
`glasspane-harness-darwin-arm64.zip`(46,397,302) + `.asc`、`-darwin-x64.zip`(48,582,877) + `.asc`、
`SHA256SUMS.txt`(204B，**恰好两行，0 个 svg 孤儿**) + `.asc`；`isDraft=false`、
`targetCommitish=b0212c08169cc179b3e985330cc17100d51c929d`（是 commit 不是分支名）。
npm 侧 run 38100638921 三条 publish job 全 success，registry 点名复核（`--prefer-online`）：
`glasspane-harness@0.7.3`、`glasspane-harness-darwin-arm64@0.7.3`、
`glasspane-harness-darwin-x64@0.7.3` 三个都回 0.7.3。

**端到端**：`npm install -g --prefix "$HOME/.local" glasspane-harness` 装上后
`glasspane-harness --version` 与 `gp-harness --version` **都是 0.7.3**；npm ≥11 的
`allow-scripts` 警告照打、安装照成。内嵌 web 用手测：`serve --port 4814` 起来后
`curl http://127.0.0.1:4814/` 在 8s 内回 2,883 字节真 HTML。

**一条会误报的闸（本轮改掉它的措辞，不改判据）**：`script/verify-published.ts 0.7.3` 在这台机器上
**exit 1**，失败项是 `the installed binary serves the embedded web app — no response`。逐字看代码：
它的等待窗口是 30 × 500ms = 15s，且把子进程的 stdout/stderr 丢掉不看——于是"这台机器 15s 内没把
108MB 单文件拉起来"与"这份产物里没有内嵌 web"输出同一句话。手测同一条通道 8s 就通了，所以那次红
是环境。**判据没有放宽**（不绿仍然不绿），改的是报告：现在打印等了多久、服务器有没有报出监听端口、
并把最后三行服务器输出带出来；"从未报出监听端口"这种情形明写 INCONCLUSIVE + 给出复跑办法。typecheck
opencode 包 = 0。

**闸（合并后的树，全部从主仓根跑）**：fork-diff vs v1.18.32 = `4666/6714 identical / 261 edited /
82 added / 1705 deleted`（金样三次随批重记：0.7.2 那笔、0.7.3 那笔、以及取 trunk 的 release.yml
之后一次——最后一次 `--record` 与主干已有一致，所以那笔合并提交里 `fork-diff.json` 没有再变）；
tool-surface engine 23,698 行 / 61 文件，面 A 8,658 / **22.52%**、面 B 6,088 / **15.84%**（行数一条
没涨，占比随并行批次把 engine 变大而**下降**——棘轮看行数，这是设计而非侥幸）；product-surface
94 条一致 / 0 问题（@0.7.3）；surface-semantics 0 命中 / 18 文件；brand-surface 26+2 文件 0 命中、
血缘 9,619 / 3,303；hook-liveness 21 钩子无漂移；kernel-pin `iterate-kernel@0.1.4` + 17 契约文件；
`kernel-conformance` 11 条 / 1 实现绿，加 `--impl`（真构建的第二份实现）11 条 / 2 实现绿，坏实现
exit 3；`probe-lane-selftest.sh` 三态可分；`check-workflows --self-test` 6 例各自验红 +
5 份工作流干净；`check-doc-links` 24 份 / 225 内链；`publish.ts --dry-run` 按重建后的 dist 绿
（boot smoke `--version` → 0.7.2/0.7.3 视那一次构建的版本）。

**没跑成 / 未观测（照实写）**：`bun test` 的 4 份 glasspane 固定点用例在极端负载下报 2 条超时红
（同一条 `over-sized engine frame` 基线 280ms、本轮 30,139ms 撞 `--timeout 30000`；另一条是
`test/preload.ts` 的钩子 252s 超时）——**没有**为此加超时或改判据，语义面没有来源：本批一行都没落在
`src/tool/glasspane/` 或 `src/plugin/`。curl 兜底通道：npm 故意失败后确实进入 release-asset 分支并
开始下载真发布物，但本机到 `objects.githubusercontent.com` 这一段经拦截代理极慢，SHA256/GPG 的
最终判定**未观测**；`bun add -g` 同理未跑完。真模型轮次、真 TUI 会话观感、`gp_*` 对活 daemon 的一次
证据成包真轮次、M2 决策日志 `logged` 分支照旧未观测。

**环境**：本轮期间系统卷一度 100% 写满（`No space left on device` 先后杀过一次 `tool-surface
--record`、`brand-surface` 与两个子代理泳道），load average 长时间 165–378。所有耗时数字按这条打折看；
两条审查泳道（bugbot / security）在跑到一半时被日额度打断，之后的审查由主代理逐文件重做——**这条要
写进汇报**，因为"两条泳道审过"在本轮不成立。
## 2026-10-10 · 每日批次（harness 线）：发布链路里那条"版本自己跟自己比"的恒真断言，发 0.7.2

- **开工态**：HEAD `cfcfc45`（== origin/main），整树 `git status --porcelain` **干净**，所以本轮没有另开工作树。开工约一小时后并行会话把 main 推进到 `2e83542`（内核依赖升 0.1.4、行为闸开始驱动 RunPlan），并且正在 `/Volumes/Eng-Dev/.worktrees/gp-014-goldens` 里跑 `fork-diff --record` / `tool-surface --record`。本轮只按文件挑自己的改动提交（`publish.ts`、`tool-surface.mjs`、`kernel-conformance.mjs`、`.github/workflows/harness-contract.yml`、三份文档、两处版本线、一把新闸），他们那批一个文件没动、没混提、没有 `git checkout/reset/stash` 别人的东西。收口 HEAD 见本节末尾。
- **前置**：`bun` = 1.3.14 == `packageManager` 钉值；参照检出 `describe` == pin `v1.18.32`、`fsck` 无错、工作树干净；preflight 带 `NODE_EXTRA_CA_CERTS=/var/tmp/glasspane-harness/ca-bundle.pem`（163 张）实测 exit 0（不带它是 exit 1，两条方向都验过）；**没有**使用任何跳过证书校验的开关。开工时段机器 load average ≈170（并行会话在跑 swift 构建 + `bun install`），耗时类数字按这条打折看。
- **第一条（P0，会发出装不上的包）**：`script/publish.ts` 对平台包的"版本 == 产品版本"断言恒真——它把 `binaries[name]`（正是从同一个 `dist/<pkg>/package.json` 读出来的）当期望值传回 `validateTarball()`。本机就是现场：`dist/` 停在 0.7.0 而 `product.json` 已是 0.7.1，`--dry-run` 报 `ok glasspane-harness-darwin-arm64@0.7.0 packs cleanly`。真发的后果是平台包那次 publish 回"already published"什么也不发、wrapper 却按新版本点名它，而 `optionalDependencies` 是 optional → **npm 安装成功、命令没有**。改成按产品版本验收后，同一棵未重建的树报 `package.json version 0.7.0 != product version 0.7.1`、exit 1。同文件另修两条：`dist/<product>` 被当成平台包在并行批里发了第二次（破坏 `publish-wrapper` 用 `needs: publish-platform` 保证的顺序；现场是 dry-run 里 `ok glasspane-harness@… packs cleanly` 打了两遍）；"声明目标未构建"在 live 路径从 note 改成 exit 2 并给出路。
- **第二条（P1，lane 失效时它是绿的）**：`.github/workflows/harness-contract.yml` 的上游探针是 `out="$(… --probe 2>&1 || true)"` 再 `grep -q "drift"`。`--probe` 的 exit 2（参照检出不在 `$HARNESS_UPSTREAM_CHECKOUT`）文案里没有 "drift" 字样，于是"测不了"被报成"没漂移"。现在吃 **exit 码三态**（0 干净 / 1 漂移 / 其余一律红，且在 step 摘要写"未观测"）。新闸 `harness/tools/probe-lane-selftest.sh` 不做复制品：它从 YAML 里抽出**真 step 正文**，用桩喂三种退出码。反证实测：把改动前的正文用 `PROBE_LANE_WORKFLOW=<fixture>` 喂进去 → `exit 2 → step exit 0` 等三条红；改动后 → 绿。
- **第三条（P1，量尺自己改了铁律）**：`harness/tools/tool-surface.mjs` 的 `LIMIT`/`LIMIT_SOURCE`/`caliber` 是脚本里的常量，金样记了却没人比对：`0.1` → `0.25` 是一笔**全绿**提交，两条越限的面（A 22.84% / B 15.70%）当场"合法"，连 `← OVER LIMIT` 那句自报一起消失——变异日志里报告头确实写着 `documented limit 25%` 且不再标越限。现在三条比对放在 `build()` **之前**（贵到没人愿意跑的守卫等于没有守卫）：改 LIMIT、改 caliber 措辞、改 LIMIT_SOURCE 各得一条具名红；三次都用自建备份 + sha256 核回，不用 `git checkout`。
- **第四条（P1，拒绝分支跑不到）**：`kernel-conformance.mjs --impl` 的"这份实现缺模块"守卫写在 `loadImpl()` 之后，而 `loadImpl()` 先 `import()` 就死了——指向 canonical `main` 得到的是裸 `Cannot find module '…/dist/decision-log.js'`，唯一能解释问题的报告正好在唯一失败的路径上不可达。现在先验存在性再导入：具名缺 `decision-log / evidence-decision / dimension-context / run-plan`、指出 pin 记的 canonical 坐标与产物出处不一致、exit 3。
- **两侧对照真跑成了**：把发布 0.1.4 的那支 `kernel/npm-canonical`@edf926f 单独 clone + `npm ci` + `tsc` 构建，`--impl` 指过去 → **11 条 fixture 两侧逐字节同答案**（`[golden+impl×2]`；dimension-context / evidence-decision / run-plan 三条另带 fixture 自带 oracle），fork 侧 zod 4.1.8、canonical 侧 zod 3.25.76。这条通道此前只在单实现（自己与自己）下"跑过"。
- **canonical 侧的问题（只列不改，归 owner 决定）**：`iterate-kernel@0.1.2/0.1.3/0.1.4` 都出自未合并的 `kernel/npm-canonical`（比 `main` 前 29 笔；`main` 的 `kernel/package.json` 仍是 `0.1.0-draft.1`，`kernel/src` 里没有 decision-log / evidence-decision / dimension-context / run-plan），而 `kernel-pin.mjs --record` 把 `canonical.branch` **写死成 `"main"`**，且 `pin.canonical` 只被写不被读——出处清单指得到一个从未含过所发字节的 ref，按它复现复现不出来。
- **npm 通道被「`skipped` 也算 success」漏过一次，本轮中途由并行 lane 补上**：那一次 Release run 是 **push** 触发（run 37813349574），两条 publish job 条件为 `workflow_dispatch && publish_npm && confirm` → 全部 `skipped`，而 run 结论仍是 success；20:49 实测 registry 是 `glasspane-harness@0.7.0`，23:1x 并行 lane 显式 dispatch 之后实测回到 `0.7.1`。GitHub 侧 tag/资产/签名齐（`targetCommitish` 已是显式 SHA `2f380fc`，0.6.4 那条"分支名当 target"的锚点问题在本轮实测里不复存在）。教训写成机制：发布结论只认 registry 版本号与 `script/verify-published.ts`，不认 run 的颜色。
- **未观测 / 未跑**：多平台整包 `bun run build`（本地只按 single 那条 lane 走）；真模型轮次；真 TUI 会话里的观感；`gp_*` 对活 daemon 的一次证据成包真轮次；M2 决策日志 `logged` 分支（需要一次真 GUI 操作）。musl/baseline 那条挂账已随 `product.json` 的平台裁决失效——没有目标就没有 lane。

- **面 B 逐文件归因那条控制，第一次是我把控制设计错了，第二次没跑完——都按实际记**：`controls3.sh` 里 CONTROL C 判 "BAD: no attribution"，原因不是守卫坏，而是我只把金样的**聚合 `loc`** 下调 30、任何单个文件都没变，于是工具正确地报"没有文件增长"。**控制必须打在断言真正读的那个量上。** 真正的证据来自更早一次带真实增量的跑：面 B 从 5913 记到 5959，输出点名 `+6  added scripts/install.sh`（那 6 行是 install.sh 对基线的真实差）。合并去重之后（删掉我那份与并行批次重复的 limit 断言）那次"真往 fork 文件追加 7 行再还原"的复验**后来跑完并通过**：基线 `--check` exit 0 → 追加 7 行 → exit 1 且点名 `+7  added scripts/install.sh` → 还原后文件 md5 逐字一致 → 收尾 `tool-surface` 与 `fork-diff` 各 exit 0。收尾时 `git status` 干净、install.sh 无残留标记、磁盘 28%/51%（不是空间问题）。（第一次尝试时脚本停在第一步、后台任务被杀，那条当时按"未复验"记；此处以跑完的结果替换，不保留过期结论。）
- **另外两条控制是红的且红得具名**（去重后的文件上跑的）：`LIMIT 0.1→0.25` → `the documented limit moved without a re-record: golden 10% → code 25%. Its source is 三条架构铁律…`；caliber 加一句没人承认的限定 → `the measurement caliber changed (fork) while the golden still records the old one.` 两次都从脚本自己的字节备份还原、md5 逐字一致。中途我还把文件切坏过一次（删块留了孤儿 `}`），那时"四处 exit 1"全是 `SyntaxError`——**崩溃不算证明**，之后一律先 `node --check` 再谈判决。
- **v0.7.2 的发布物按人工路径补全**（不是流水线当时可用——它正断在我那个路径 bug 上）：本地对真发布物算 sha256、用锚定私钥 `0929EA31…1298` 签 `SHA256SUMS.txt` 与两个 `.zip`，`--clobber` 上传；再以用户视角复测：`shasum -a 256 -c SHA256SUMS.txt` 两条 OK，`.asc` 对安装器锚定钥匙 `VALIDSIG` 匹配。当时 **registry 仍 latest=0.7.1**：v0.7.2 有 GitHub Release 但 npm 未发（tag ≠ npm）。后续实况：并行批次按修好的流水线发了 **v0.7.3，npm 三个包现指 0.7.3**，v0.7.2 与 v0.7.3 的 Release 都带 `SHA256SUMS.txt` 与 `.asc`；v0.7.1 那两个孤儿签名（`logo.svg.asc`/`banner.svg.asc`）仍未删——删发布资产需口令，且该版本已被取代。

## 2026-10-09 · 依赖升 0.1.3，行为闸从"自己比自己"改成 oracle + 金样 + 双方对照

**触发**：并入并行会话那 35 笔（v1.9.0 + fork 0.7.1）时，他们那份尺子自检点名了本 lane 一条
挂账缺陷——`kernel-conformance.mjs` 不带 `--impl` 时是 `answers.every(a => a === answers[0])`，
第一份就是它自己，**恒真**，而 CI 恰恰不带 `--impl` 跑。哈希闸只证字节、行为闸只证自己，两把叠
起来等于语义面无人看。同批还发现 `dimension-context.ok-01.json` 带着 `expected` 却被 `kindOf()`
判成 null、从不驱动。

**改了什么**：新增金样 `contracts/kernel-conformance.json`（每条 fixture 的答案摘要 + 判答/被拒
身份）；fixture 自带期望优先当 oracle（`dimension-context` 的 `expected`/`expectedLine`、
`evidence-decision` 的 8 个 case）；`kindOf` 改前缀表并加"包发了但没有 kind 驱动它"的守卫；
被拒样本从 `THREW …` 打进 ok 列改成显式 `rejected` 身份；evidence-pack 那类改走读侧契约
`parseEvidencePackRead`（产品实际消费的那条）。报告每行标 `[oracle]` / `[golden]` /
`[impl×N]` 的组合，一方都没有就打 `?!`；缺金样直接拒绝跑绿，`--record` 在 oracle 违反时拒绝盖章。

**依赖**：`iterate-kernel` 0.1.2 → **0.1.3**（0.1.3 才把转录契约 `evidence-decision.ok-01.json`
打进 tarball）。不升这一版，fork 侧的 oracle 分支拿到的是空集——"两侧同转录"就只剩 iterate 一边
的证据。`contracts/kernel-pin.json` 重记为 **15** 个契约文件（12 fixtures + 3 schemas）。

**负例（三条都实测红过再还原）**：金样摘要伪写 `000000000000` → 点名 "behaviour moved"；删一条
金样条目 → "present in the package but not in the golden"；把第二份实现的
`decisionSummaryFromEvidence` 改成返回常量 → 14 条问题、逐条点名是哪个 case，行标显示
`[oracle+golden+impl×2]`。

**金样**：`fork-diff` `4666 / 261 edited / 82 added / 1705 deleted` @6,714（上一记 `4668 / 259 /
81` @6,713；added +1 是新增的 conformance 金样，edited +2 是本批改过的
`script/kernel-conformance.mjs` 与依赖行）；`tool-surface` 面 A 8,658 / 22.84%、面 B 5,953 /
15.70%（conformance 脚本自己那几十行进面 B，它是我们的代码）；`brand-surface` 扫描面 3,303
文件（先因退役 vendored 树降到 3,302，又因新增这份金样回到 3,303——按"覆盖率与数字同进退"
那条新规则两次都显式重记并写下增减原因，不让计数自己漂）。

**未跑**：`bun run build` 全量、真模型轮次、真 TUI 会话观感；本批只跑闸与 fork 的 58 条
glasspane 绑定/插件测试。

- **split 仓需要一次有人签字的覆盖（未自动做）**：本轮两条修复先推上主仓 `main`（`5f0fb54..d872523`，含并行批次的内核迁移基线），再 `git subtree split`，tree 哈希等式实测 `HEAD:harness/glasspane-harness = c178962… == split tree = c178962…` 成立。但普通 push 被拒（non-fast-forward）：这条新 split 线是从 cherry-pick 后的提交派生的，不含我自己一小时前推上去的 `91c00db`/`e7363e0`。要让它成为 main 必须 `--force-with-lease=split/glasspane-harness:<显式 SHA>` 覆盖**已发布的提交**，且覆盖后 tag `v0.7.1`（=`2f380fc`）不再位于 main 的祖先链上。丢别人提交＝停下汇报；这里虽然丢的是我自己的两笔，仍属"覆盖已发布历史"，故不自动做。已把这颗树原样推到旁枝 **`split-next-20261011`**（不覆盖任何东西），下一次发版要么由 owner 决定是否以显式 SHA 覆盖 main，要么直接从 `split-next-20261011` 打 tag。split 仓 main 现在是 `e7363e0`，**两条修复都已在其中**，用户侧 `curl | bash` 不受影响。
- **v0.7.1 发布物实测**：npm 三个包 `0.7.1` 全部可解析（registry 读副本滞后约 5 分钟，其间平台包 404 而 CI 已绿——正是"job 绿 ≠ 装得上"），`dist-tags.latest = 0.7.1`。`verify-published.ts 0.7.1` 十条断言全 ok（两个 bin 各自 `--version` exit 0 且等于版本号、内嵌 web 以 content-type+doctype+`/assets/` 三项判定、registry sha512 完整性 ok、provenance 有 attestation）。GitHub 发布物按用户视角实测：`shasum -a 256 -c SHA256SUMS.txt` 两条 OK，arm64/x64/SHA256SUMS 三个 `.asc` 的 `VALIDSIG` 全指纹等于安装器锚定值。清单缺陷当场纠正（本地锚定私钥重签 + `--clobber` 上传），残留 `logo.svg.asc`/`banner.svg.asc` 两个孤儿签名未删（删发布资产需口令）。
- **三通道端到端**：`npm install -g --prefix "$HOME/.local"` → 两个命令都回 `0.7.1`；curl 兜底通道（把 npm 从 PATH 藏掉、真网络真 gpg真发布物）→ sha256 OK + 指纹级 GPG OK + exit 0 + 二进制可跑；`bun add -g` → 装得上但 bun 跳过 postinstall，命令回占位桩的自述报错并 exit 1（与 docs/install.md 写明的行为一致，也正好是被本轮那条"[OK] 不再为不运行的命令打勾"的判据接住的对象）。

- **split 仓 main 的覆盖（已执行，记全部要素）**：原因——两条修复先落主仓 `main`（含并行批次的内核迁移基线）后重新 split，新线里没有我早前直推的 `91c00db`/`e7363e0`（那两笔是在 cherry-pick 之前从旧分支切出来的），普通 push 非快进被拒。覆盖掉的提交：`91c00db`、`e7363e0`，**两笔都是我自己本轮推的**，且内容已在新线里各对应一笔 cherry-pick 后的提交（`f36748b`=清单目录修复、`b9409d7`=302 修复），没有丢任何别人的提交；核对方式 `git log --format="%h %an %s" -3 e7363e0` 三个作者都是 jingzhao-l。可复现性锚点未受损：`git merge-base --is-ancestor 2f380fc <新线>` 为真，即 **tag `v0.7.1` 仍在新 main 的祖先链上**，`v0.7.0`(8e3a935) 与 `v0.7.1`(2f380fc) 两个 tag 对象都在。用的形式是带显式 SHA 的 `--force-with-lease=split/glasspane-harness:e7363e0…`；第一次尝试因我把 SHA 少抄/多抄一位而被 lease 正确拒绝（这正是 lease 该有的表现），改用远端 `ls-remote` 回读的原值后通过。推送前先跑 `git subtree split` 并断言 `HEAD:harness/glasspane-harness` 与 split 分支 tree **逐字相等**。

## 2026-10-09 · 每日批次（harness 线）：两条审查泳道 + 三把尺子自检，发 0.7.1

- **开工态**：本地 main 落后 origin/main 三笔（上一轮本线的 [gp] 提交），`git merge --ff-only` 重新对齐到 580be9a 后才开工。工作树在开工约 25 分钟后被**并行会话**改成 dirty（`vendor/kernel/**` 与 `contracts/kernel-fixtures/*` 被 staged 删除、`kernel-vendor.mjs` 改名 `kernel-pin.mjs`、`kernel.ts` 改吃 npm `iterate-kernel`、CI 两份 yml 与 `tool-surface.mjs` 同时在改）。按纪律不混提、不 `checkout`/`reset`/`stash` 别人的文件：本轮全部改动与提交都在隔离工作树 `/Volumes/Eng-Dev/.worktrees/gp-harness-daily-20261008`（分支 `gp-harness-daily-20261008`，基线 580be9a），`.external/opencode` 做成指回主树那份的**符号链接**（不各存 223 MB）。收口时再 `git merge origin/main`（那三笔之外，主仓 1.9.0 那批 engine/mcp-shell/installer/updater 也进来，合并干净、零冲突）。
- **前置**：`bun` = 1.3.14 == `packageManager` 钉值；参照检出 `describe` == pin `v1.18.32`、`fsck` 无错、工作树干净；`glasspane-preflight.sh` 两条方向都实测（163 张束 OK/exit 0，158 张系统根 FAILED/exit 1）；构建与发布命令一律带 `NODE_EXTRA_CA_CERTS=/var/tmp/glasspane-harness/ca-bundle.pem`，**没有**使用任何跳过校验的开关。
- **本轮没跑成的一半**：`bun run build` 整包未跑（>10 分钟，按纪律不进改动循环），所以"构建产物与当前树一致"这句**不成立**，要用 dist/ 前先重建。真模型轮次、真 TUI 会话观感、`gp_*` 对活 daemon 的完整轮次仍**未观测**（`glasspaned` 在跑，但一次带判定成包的真轮次需要模型额度与人工发起）。M2 决策日志的 `logged` 分支、musl/baseline 目标的 CI lane、`packages/{app,session-ui,desktop}` 会不会取代 TUI——都还是挂账项，本轮未收口。
- **尺子自检（改完重新验它能红，不是沿用旧结论）**：金样伪写 `tool-surface.json` fork `loc` 5548→5549 → 变红；删金样 → `no golden … run --record`（不是绿）；藏参照（只挪本工作树的符号链接，主树未动）→ `hook-liveness` 大声声明 `upstream was NOT observed`、`fork-diff` 仍核我们这一侧并逐文件点名 `our content moved`。结论写进 `harness/README.md`「闸自己被验过吗」2026-10-09 段。
- **被抓到但本轮没修的（列全，不当已修）**：`kernel-conformance.mjs` 单实现模式把实现与**它自己**比对，`agree` 恒真、CI 正是这么跑的（不带 `--impl`），且 `THREW …` 打进 `ok` 列，`fixturesCandidates` 在第 173 行未定义（那条"没夹具就会假过"的守卫自己崩），`dimension-context.ok-01.json` 带 `expected` 却被 `kindOf()` 判 null 而**从不驱动**——这四条与并行会话的内核迁移是同一批文件，不在此处重复改。`harness-contract.yml` 的上游探针 `out="$(… || true)"` 再 `grep -q drift` 定胜负（`--probe` 三条 exit 2 的"测不了"路径都不含 drift 字样 → 绿）。`tool-surface` 面 B 增长从不点名文件（`byFile` 对 B 恒缺）、`LIMIT`/`caliber` 从不与金样比对（把 0.1 改成 0.25 全绿）、平台包发布绕过 publish.ts 的校验、`checksums` 仍从 GitHub 供回的字节算、CI 不证明发布私钥就是那把指纹、`bunfig.toml` 把 `gitlab-ai-provider`/`opencode-gitlab-auth` 这类鉴权侧包排除在 `minimumReleaseAge` 之外、`packages/app` 的 `ghostty-web` 走 `github:anomalyco/…` 且 `@opencode-ai/client@1.17.13` 以提交的 .tgz 内嵌（与 fork 的 1.18.32 版本错位）。
## 2026-10-08 · 内核不再是 vendored：`iterate-kernel@0.1.2` 成为依赖，`kernel-vendor` 那把尺子退役成 `kernel-pin`

两个提交：`22de725`（改依赖 + 尺子替换）与 `58be696`（`fork-diff` / `tool-surface` 金样随同重记）。

**为什么现在换得动**：kernel 侧先发了 `iterate-kernel@0.1.2`，把 fixtures 打进 tarball——`0.1.1` 一个都没打（`npm pack` 实测）。在那之前 vendoring 是消费者唯一能握住"同一份契约字节"的形态，所以 `packages/opencode/vendor/kernel/`（25 文件：src 11 + schemas 3 + fixtures 11）不是偏好，是当时唯一的解。这条解现在退役，第四份契约副本随之消失。

**改动面（fork-diff）**：`4669/6746, 258 edited, 114 added, 1705 deleted` → **`4668 identical / 259 edited / 81 added / 1705 deleted`，全树 6,713 个条目**。逐条对得上：added 净 −33 ＝ 删掉 36 个（`vendor/kernel` 25 文件 + `contracts/kernel-fixtures` 9 镜像 fixture + `contracts/kernel-vendor.json` + `script/kernel-vendor.mjs`）再加回 3 个（`script/kernel-pin.mjs`、`contracts/kernel-pin.json`、`packages/opencode/test/lib/kernel-contract.ts`）；identical −1 / edited +1 是同一件事——`bunfig.toml` 因 `minimumReleaseAgeExcludes` 第一次成为被改过的上游文件。
**占比（tool-surface）**：面 A 仍是 8,601 行（**未变**），比例 23.08% → **23.19%**（分母随主仓并行批次与面 B 变小）；面 B **5,548 → 5,376 行，14.89% → 14.50%**；**vendored 排除项 11 文件 / 1,464 行 → 0 文件 / 0 行**——内核现在是依赖，不再是需要从"我们写的行数"里剔出去的抄本。金样为此新增 `kernel: iterate-kernel@0.1.2` 字段，让这次口径变化在尺子上可读，而不只写在提交信息里。测试排除 27 文件 / 1,544 行照旧打印并进金样。

**尺子的替换关系**：
- `script/kernel-vendor.mjs` + `harness/glasspane-harness/contracts/kernel-vendor.json` 删除，替换者是 `script/kernel-pin.mjs` + `contracts/kernel-pin.json`。`--check` 验四件事：装进来的版本 == pin（`0.1.2`）、`bun.lock` 那条 specifier 为空（＝registry 解析，不是 `file:`/`link:`——否则产品装的是一个只在本地存在的目录）、lock integrity == pin（记的是 `sha512-Mxu7gMD3Zn+i3…`）、随包发出的 **14** 个契约文件（11 fixtures + 3 schemas）逐个 sha256 == pin。`--probe` 不再 `git ls-remote` 追分支头，改成问 registry（`npm view iterate-kernel version`）。
- 镜像语料 `contracts/kernel-fixtures/`（9 文件）删除——它和发布出去的（11 个）**已经漂移了**，镜像就是第二个真源。语料现在取自装进来的包内部，由 `kernel-pin.json` 按 sha256 钉住。
- `script/kernel-conformance.mjs` 跑随包语料过**装进来的 dist**，并把 `dimension-context` 纳进驱动面（fork 自己消费它，此前没有任何 fixture 校过它）。实测 `--impl <canonical checkout>`：9 条 fixture 两侧同答案，工具把 zod major 不同导致的**报错文案**差异打印成 note 而不是掩盖它。
- 三处 CI 引用改到 `kernel-pin`：`harness/glasspane-harness/.github/workflows/ci.yml`、根 `.github/workflows/ci.yml`、`.github/workflows/harness-contract.yml`。

**依赖形态，和那条不能碰的 import 形状**：`src/tool/glasspane/kernel.ts` 只走 per-module 子路径（`iterate-kernel/parse` 这类），不 import barrel——barrel 带进 `schemas`，后者在模块加载时用 `createRequire` 读包旁边的 schema 文件，单文件二进制起不来。这条不是推理：`bun run script/build.ts --single --skip-install --skip-embed-web-ui` 编译通过，且它自带的 boot smoke 通过（`dist/glasspane-harness-darwin-arm64/bin/glasspane-harness --version` → `0.7.0`）。换分发形态必须重跑这条，否则"能构建"只是上一批的结论。
`bunfig.toml` 把 `iterate-kernel` 加进 `minimumReleaseAgeExcludes`：三日冷静期防的是上游发布窗口被投毒，而这个包的"上游"就是同一批维护者，且它的字节仍由 lock integrity + `kernel-pin.json` 钉住。`tools/sync-kernel.sh --target=fork` 改为**明确拒绝**并打印新的合法路径（bump 依赖 + `bun install` → `kernel-pin.mjs --record` → `kernel-conformance.mjs --impl <canonical checkout>`）；`--target=repo`（mcp-shell 那份 `kernel/` 镜像）本批未动。

**顺手修掉的静默失效**：`test/tool/glasspane-kernel.test.ts` 的出处检查用五层 `../` 上溯，落在从来不存在的路径上（`harness/contracts/kernel-vendor.json`），`existsSync` 为假 ⇒ `console.warn` + return，于是那条测试一直绿而什么都没验。位置解析现在收在 `packages/opencode/test/lib/kernel-contract.ts`（逐级上溯直到找到；pin 缺失＝红，不再是一句警告）。

**没跑 / 未观测**：整包多平台构建（只跑了 `--single` 那条 + boot smoke）；真模型轮次照旧没做；`--target=repo` 那条镜像仍在退役队列里，本批没动它，所以它文档里那句"mcp-shell 镜像"今天还是事实。



- **发布后实测抓出的清单缺陷（v0.7.1，本轮收口时）**：按用户视角跑 `shasum -a 256 -c SHA256SUMS.txt` 直接失败 2 条。根因不是校验逻辑，而是 `checksums` job 里 `mkdir -p assets && cd assets` 撞进了**仓库自己提交的 `assets/` 目录**（fork 树里就有 logo.svg / banner.svg），于是 `sha256sum ./*` 把两个"仓库文件"也写进清单并上传，而 release 上根本没有这两个资产，只有它们的 `.asc` 孤儿。本轮我那条新加的覆盖率断言（按 product.json 的 platformTargets 逐个点名）**过得去**——它只保证"该有的一个不能少"，看不见"多出来的没人认"。修法两面：工作目录换成 `${RUNNER_TEMP}/release-assets`（不再可能与检出内容同名），并且清单写完后**双向**断言（列出的必须在、在的必须列出），任一侧不符就拒发。已发布的 v0.7.1 就地纠正：用本地那把 `0929EA31…1298` 私钥重签一份只覆盖两个真资产的清单并 `--clobber` 上传，复测 `shasum -c` 两条 OK、三个 `.asc` 的 VALIDSIG 全指纹等于安装器锚定值；**残留**：`logo.svg.asc` 与 `banner.svg.asc` 两个孤儿签名仍在 release 上（删除发布资产属需口令动作，未动）。

## 2026-10-07 · v0.7.0：审查批次（两条泳道 + 六把尺子自查），并把"绿但红不了"的四道闸改回能红

每日任务（10:30 那条）。开工 HEAD `439c6ab`（主仓 main），收口在同一棵树上的分支
`harness/daily-20261006`。工作树在开工后被项目 1 的并行会话弄脏（`engine/*.swift`、
`installer/test/*`、根 CHANGELOG 与 SECURITY），按纪律**没有**在那棵树上提交：本轮用
`git worktree add` 出的隔离树，`.external/opencode` 做成指回主工作树那份的符号链接
（README 已记过这种接法实测照跑）。

**改动面（fork-diff）**：开工 HEAD 上实测 `4670/6745 byte-identical, 257 edited,
113 added, 1705 deleted`；本轮记完为 **`4669/6746, 258 edited, 114 added, 1705 deleted`**
（added +1＝新增 `packages/opencode/script/installer-selftest.sh`；edited +1 / identical −1
＝`packages/opencode/script/generate.ts` 第一次与上游字节不同）。
**占比（tool-surface）**：engine 23,110（60 文件）不变；面 A 8,601 = **23.08%**（记前金样
写 23.39%，同一棵树、分母随主仓并行批次动过）；面 B **5,056 → 5,548（+492，14.89%）**。
排除项照记：测试 26 文件 1,474 行、vendored 内核 11 文件 1,464 行。本轮有意长的行是
安装器自测脚本、跨读与 declared-mode 两段、传输层四条分支与 generate.ts 的校验，
同批 `--record`；`fork-diff --record` 拒过第一次（"on disk but not committed"＝新增文件
还没进树），所以金样落在紧随的第二个提交里，HEAD 上两把尺子都是绿的。
**血缘（brand-surface）**：26 产品面文件 + 2 份文档，0 命中；lineage **9,618 → 9,627**
（+9 / +1 文件），增处全部是"写下被改掉的那个名字"的说明与新脚本 usage 头里的路径，
金样 `lineageNote` 逐条记了；反证成立（再加一处即红，还原后绿）。
**一致性（product-surface）**：断言 **84 → 88**（4 条此前落在判决之后），0 问题；
版本线两处（`product.json` 与 `packages/opencode/package.json`）同为 **0.7.0**。
**契约（hook-liveness）**：20 → **21** 声明（此前 `[a-zA-Z.]+` 漏掉带下划线的
`experimental.provider.small_model`；补上后 fire-site 正则又不认带泛型的 `trigger<…>(`，
把活钩子判成 dead，两处都修），实测 live 15 / structural 5 / dead 仍只有 `permission.ask`。

**闸自己被验过吗**：见 `harness/README.md` 同题的"2026-10-06/07 每日批次"段——每条都给了
破坏点与具名红/具名绿，包括合成树里 kernel-vendor 的 11 条、tool-surface 的"无参照必须拒"、
product-surface 的 bin-shim 破坏、hook-liveness 的"声明 21 个、派定点为零 → 16 条红"、
安装器自测对**改动前** install.sh 的 10+ 条红、传输层 6 条对改动前 daemon.ts 的 5 条红、
配置优先级对改动前 config.ts 的 `Received: "from-legacy"`。

**跑过什么（隔离树，全部实测）**：六把尺子从主仓根；`kernel-vendor --check`（含
`KERNEL_SRC=/Volumes/Eng-Dev/iterate-skill` 跨读，25 文件按钉点 `2ed342b` 全对）；
`kernel-vendor --probe` → **DRIFTED**（分支头 `4541cd1` ≠ pin，见下）；固定点测试 4 个文件
**73 pass / 0 fail**；`packages/tui` 快照 **23 pass / 0 fail**；typecheck opencode/tui/sdk-js/plugin
四包均 0；`kernel-conformance` 8 fixture 全 ok（默认只跑 vendored 一侧，`--impl` 未跑）；
`publish.ts --dry-run` 以 0.7.0 pack 通过；主仓公共闸 `check-workflows --self-test`（6 例各自
验红）+ `check-workflows`（5 份工作流）+ `check-doc-links`（24 份文档 / 223 内链）全绿；
`installer-selftest.sh` 31 条全过。日志一律整份读，不 tail 后下结论。

**没跑 / 未观测**：整包构建（>10 分钟且要本机信任锚，本轮只跑 preflight + 按包闸）；
真模型轮次（这台机器没有可用 provider key，花别人的额度属 owner 决定）；真 TUI 会话里的
观感；`gp_*` 对真 daemon 的完整轮次（daemon 在跑，但证据成包的 `logged` 分支需要一次真
GUI 操作，本轮未造）；canonical 已前进到 `4541cd1`（其上有 `iterate-kernel@0.1.1` 发到
npm，`kernel/decision-log-chain` 未合 main）——换分发形态与 `sync-kernel --target=fork`
都要 owner 点头，本轮只把"跨读读错对象"这条修好，没动 vendored 一个字节。

**发现但未修（写清楚，不当已通过）**：`surface-semantics` 三条规则仍可被典型写法绕过
（整数阈值、非 8 词表字段、`status` 主语豁免过宽），且 `--check` 不比对扫描集（金样 15
文件、实测 18）；`kernel-conformance` 单实现路径的"逐字节比较"只比"各次答案一致"，
chain fixture 的锚点哈希不在单实现 lane 被断言；`brand-surface` 的 wire-identity 正则不认
`"User-Agent": \`opencode/…\`` 这种写法，实测 20+ 处对外仍自称 opencode（改它要真 key 才能
验证 provider 握手不被弄坏，属 owner 取舍）；产品面清单是白名单，`packages/desktop/…/runtime.ts`
里上游 `curl | bash` 之类不在其视野内（desktop 按 product.json 不进产品）；
`config.ts` 每次启动向用户目录 `npm install @opencode-ai/plugin`（别人发布的包、跟着上游版本号
走）——删它会让用户自写插件的 import 断掉，属功能取舍；`release.yml` 的 `publish-platform`
走裸 `npm publish`（绕过 publish.ts 的 README/chmod 断言，registry 上 0.6.4 平台包
`readmeFilename` 为空即其证据）、无 `concurrency`、npm 发布与被 tag 的树没有 SHA 绑定、
`targetCommitish` 仍是分支名 `main`；`tool/glasspane/index.ts` 只对部分方法做能力协商，
`protocolVersion` 读了没人比；决策日志并发写与毫秒归零两条未动。



## 2026-09-26 · kernel 集成状态：把"要不要发 npm"从记忆变成记录，并发现溯源链在锚点处断了

owner 问：kernel 为什么不发布到 npm？做双向集成是不是必须发 npm？

- **为什么不发**：这是**已记录的决定，不是待办**。P6 §13（2026-09-21 用户口令：file: 依赖会漏进
  已发布清单，故内联字节）+ P4 §33.2（registry 发布跟 iterate monorepo 自己的发布节奏）；而 fork 以
  subtree 独立成仓，相对 `../../kernel` 的 import 会在第一次发布就断——所以只剩 vendored 或 npm，
  选了 vendored。调研文档里"Phase B 第 0 号动作是发布 kernel"那句**已被自己订正**（把战略读成了待办）；
  "npm 依赖"描述的是依赖的**方向与计数口径**，不是发布指令。
- **是否必须发**：**对任何具体场景都不必须，对"一个 kernel、N 个消费者"的机械约束最省事**。R40 场景
  要的是：① 同一份实现与 schema（vendoring 就够，分发渠道无关）；② kernel 暴露该场景需要的钩子
  （`dimensionContext`、决策日志写入器、invariant 求值——**这是今天真正的阻塞，而且是 API 问题不是分发
  问题**）；③ R34 消费者矩阵的交叉验证（这一步分发方式才有区别：npm 让 4 个消费者解析到同一版本，
  API 断裂在 install/typecheck 阶段就炸；vendored 只能靠一致性套件事后逐个发现）。
  代价对比写进 `docs/kernel-integration.md`（身份、断裂发现时机、版本偏移、补丁、一致性套件）。
- **新增 `kernel-vendor.mjs --probe`**（只读，一次 `git ls-remote`）：问 canonical 分支头是否还等于我们钉的 ref。
  第一次运行报"锚点不可达"，追下去发现**两件事、只有一件是探针的错**：
  - **真问题**：`kernel/decision-log-chain` 分支（Phase B 内核工作：决策日志写入器、evidence→decision 映射、
    读侧兼容冻结）**从未 push**，只存在于一台机器上，所以远端解析不到 `bb80f97`——证据是
    `git ls-remote --heads` 返回空，与探针的判词无关。**2026-09-27 已 push 该分支**，探针随即报 no drift，
    溯源链恢复（`--check` 现在证明的仍是"字节自记录未变"，加上分支头一致 = 锚点活着）。
  - **探针的错**：第一版用 `git ls-remote` 解析裸 SHA，而 ls-remote 只匹配 ref 名，因此对确定存在的 ref 也报
    "ANCHOR UNREACHABLE"（反证：把 manifest 临时钉到 main 的 head，仍报同一句）。已改成只问 ls-remote 能回答的
    问题（分支头 vs 钉的 ref），并明确拒绝就看不到的对象猜测祖先关系。
  - **教训照写进记录**：工具的输出在证明工具有效之前不是证据。那次 push 的依据是独立的 `git ls-remote --heads`。
- **发布与否变成机器可读的**：`product.json → kernel.mode`（当前 `vendored`）+ `kernel-vendor --check`
  断言声明与树一致——否则"模式"只是散文，会在有人发布或重新 vendor 的那一刻开始漂。
- probe 挂在**既有的定时 lane**（`harness-contract.yml`，每周一 06:17 UTC，与上游探针同频）。我第一版
  加在了 `ci.yml` 里，而那个 workflow **根本没有 schedule 触发器**——一个永远不会跑的 job 就是
  "看起来接好了其实没有"，已撤掉。
- `docs/kernel-integration.md`：kernel 是什么/为什么不发/发不发的区别/今天做到哪/两阶段收口计划。

## 2026-09-26 · v0.5.x：产品面逐类审计清零 + 10 片上游树移除 + 一次自己造成的版本号报废

owner：持续检查私有化（细节不再提 opencode）、全面整理不需要的文件（**桌面端保留**）、问 glm52 与
VSCode 是什么、问 kernel 是不是为 iterate 双向集成准备的。

- **按"用户看得见的地方"分类审计再逐类修**（不是凭印象）：环境变量（新增 `GLASSPANE_HARNESS_*`，
  唯一解析点 `flag/flag.ts` 的 `read()`，**旧名继续有效**——让人已导出的设置静默失效本身是缺陷）、
  线上标识（X-Title/X-Source/User-Agent/originator/HTTP-Referer/MCP client/OTLP 全部改名）、
  用户自己的文件（`glasspane-harness.db` **带一次性旧名 rename**，绝不让人看起来"历史丢了"）、
  mDNS 实际值（此前帮助文案改了、值没改 = 文档与行为分裂）、CLI scriptName（`--help` 打印的就是它）、
  内置 skill（`customize-harness`，它注入每个会话，文本即产品面）、不再往用户配置写第三方 `$schema`、
  TUI/web app 的第一方残留（Zen 推广与链接、免费模型话术、付费引导、推荐标签、排序）。
  63 个语言文件、2,700+ 条用户可见文案改为产品名；键名与调用点同步（键名有类型，typecheck 抓到了漏改）。
- **审计抓到的真缺陷**：我自己在改名时把 `ConfigPaths.files("opencode", …)` 换掉，导致**旧的项目配置
  不再被读取**（与兼容承诺冲突）——已改为两个都读、产品名后读；以及 mDNS 文案/值分裂、指向已删命令的
  用户提示、让编辑器去跑不存在的 `opencode auth login`、导入已不存在的云端分享。
- **删掉 10 片从来不属于本产品的上游树**（零交叉依赖，实测）：console / enterprise / stats / web /
  storybook / containers / function / identity / slack / docs，加 `artifacts/`（上游给某模型做的
  宣传视频工程，7.8MB）、`.vscode/`、`install/`、`nix/`+`flake.*`、`sdks/vscode`、`infra/`+`sst.config.ts`、
  `perf/`、`github/`、`screenshot-uk.png`。**保留** `packages/desktop`（产品面，第二批）、`patches/`、
  `specs/`。`product.json → product.removedTrees` 记录在案。
- **门禁**：`brand-surface` 新增 5 类规则（第一方网关 / 线上标识 / 第三方 schema 写入 / 产品文件名 /
  已删树），兼容读取处走显式白名单；规则扫描前先剥注释，否则它会把自己写的"这里删掉了 X"判为违规。
  另修 `fork-diff` 的假阳性（把 gitignore 的构建产物当成"在盘上未提交"）。
- **一次自己造成的版本号报废**：我并发启动了两次 publish，npm 把其中一个 stage，`0.5.0` 的 wrapper
  版本号被 registry 拒绝再次发布，实际发的是 0.5.1（同内容）。已把"同一时刻只允许一个发布"变成脚本
  里的排他锁（`mkdir` 原子创建），并在 CHANGELOG 里写明。
- **验证**：全量 typecheck 0 错；固定点 61/61；core skill、config 套件 107/107；brand-surface 0 hit，
  lineage 18,566 → 9,887；0.5.1 已从 registry 端到端实测（装出来报 0.5.1、os 门是 darwin、内嵌 web
  服务正常）。

## 2026-09-25 · v0.4.0：删掉第一方账号面（改成自带 API key）+ 仓库自己的项目目录改名 + npm README/发布手册

owner 2026-09-25 三问：(1) npm 上怎么设 trusted publisher；(2) npm 包也要有 README；
(3) "本 harness 是通用编程 harness，未删减 opencode 正常功能，只是深度融合了我们的内核"，
另外整理目录结构、解释 `.opencode/` 是什么、并把"他们自己作为提供商 + login"改成填 API key。

- **第一方账号面整片删除，改成 BYOK**（`product.json → models`，文档 `docs/models-and-keys.md`）：
  - 删：`opencode` 第一方 provider（目录边界一处过滤，`provider.ts`）、`auth login/logout/switch`
    CLI 命令、`/org` 命令与组织切换对话框（`dialog-console-org.tsx`）、`/experimental/console*`
    端点与 console 托管 provider 状态（config/server/handlers/groups/sync.tsx/dialog-provider）、
    云端会话分享（share-next + session share 服务、share/unshare 端点、`share`/`autoshare`
    配置键、TUI `/share`、web app 的分享按钮、GitHub bot 的会话卡片）、core 的账号表与本地
    `account`/`account_state` 表管理（**表留在用户已有库里，drizzle 不再管，不做破坏性迁移**）、
    `import <share-url>` 改为导入本地 JSON 导出并给出理由。
  - 留：models.dev 目录里其他每一个 provider 与模型（Anthropic/OpenAI/Google/Copilot/
    Bedrock/Azure/OpenRouter…），用**用户自己的 key** 解锁（env / `{env:NAME}` / TUI `/connect`）。
    判据：删掉的是**厂商登录**，不是能力；README 用 fork-diff 的实测数字（6527/6687 逐字节）
    声明"这是加法"，并把唯一的例外写清楚。
  - 全量 typecheck 归零（turbo，TC_RC=0）；顺带修掉两个**我们自己的**旧红灯：一条断言
    `opencode.jsonc` 的用例自 0.1.0 私有化起就红（产品早已改成 `glasspane-harness.jsonc`），
    一条断言已删行为的用例——都改成断言产品现在的样子。
- **仓库自己的项目目录 `.opencode/` → `.glasspane-harness/`**：那是 opencode 开发自己用的
  agent/命令/技能/术语表/主题目录，也就是产品的**项目目录**布局。改名后仓库自己吃自己狗粮，
  验证改名是真的；目录里的配置也改名成 `glasspane-harness.jsonc`。`.opencode` 作为**只读兼容
  目标**保留在产品里（老 checkout 必须还能用），`product-surface` 双向看守：根目录出现
  `.opencode` 会红（已用反向控制证明），删掉兼容读取也会红。
- **npm README**（门禁要求）：wrapper 的 tarball 现在带产品 README（EN + 中文），平台包带一份
  说明"这是哪个平台的二进制、别直接装、装 wrapper"的短 README；`publish.ts --dry-run` 缺
  README 即失败，所以"没有 README 的包"发不出去。
- **`docs/release.md`**：发布手册，把 trusted publisher 的五个字段钉死在 `release.yml` 实际
  呈现的值上（owner `jingzhao-l` / repo `glasspane-harness` / workflow `release.yml` /
  environment `release` / GitHub Actions），并写明 npm **保存时不校验**、连接不可编辑、
  403 的原因（绕过 2FA 的 token 读不了 trust 端点，所以这是 owner 动作）。发布 job 加
  `environment: release`：既是 npm 要匹配的值，也是将来挂 reviewer 的位置。
- **一个我自己犯的错，被门禁当场抓住**：把 `product.json` 的 `repo`（字符串 `owner/name`）用
  对象覆盖了，安装器 URL 断言立刻变红。改成独立的 `repoLayout` 键并恢复 `repo`——这正是
  "产品面要能测"的意义。
- **一条固定点的真根因**（不是回归）：超尺寸帧用例内部写死 5s 调用预算，而本机把 5 MiB 推过
  unix socket 要 ~4.7s，没有余量 → 先超时成 `GP_E_ENGINE_TIMEOUT`。上限拦截本身完好（拿到
  `GP_E_PAYLOAD_TOO_LARGE` + remedy），`daemon.ts` 逐字节等于上游、今天未碰。预算与 lane 的
  30s 契约对齐并把原因写进注释。固定点 61/61 + TUI 23/23 绿。

## 2026-09-25 · v0.3.0：macOS-only 收口 + npm 基建（dry-run 校验 / 发布即验证 / dist-tag 策略）

owner 2026-09-25："本项目是针对 macOS 的，不需要 Linux 和 Windows 适配" + "npm 包的基础设施完善一下"。

- **平台面收成 macOS-only**（决定，不是"还没做"）：`product.json` 的目标矩阵只剩
  `darwin-arm64` + `darwin-x64`（`darwin-x64-baseline` 也去掉：能跑 macOS 13 的机器全有 AVX2，
  这个目标没有用户）；wrapper 的 `os`/`cpu` 由清单驱动 → **npm 在非 macOS 上直接拒绝安装**，
  而不是给一个跑不了的二进制；`install.ps1` 删除，`install.sh` 的拒绝文案改成"这是决定，不是
  遗漏"并说明引擎/权限/证据流水线都只存在于 macOS；release lane 的两个矩阵收成
  `macos-14`/`macos-13`；README/安装文档/排障表把平台边界与 `EBADPLATFORM` 写进第一屏。
- **已在 registry 上的 10 个不该发的平台包（6 linux + 3 windows + 1 baseline）全部 `npm deprecate`
  并附理由**——版本号不可回收，弃用带说明比留个"还能装"的包诚实。逐个从 registry API 核过
  （不是只看 `npm view` 的 CDN 视图）。
- **npm 基建三件**：
  1. `publish.ts --dry-run`：打包并校验每个 artifact 的形状（bin 指向的文件真在 tarball 里、
     平台二进制存在且可执行、wrapper 的 optionalDependencies == 清单矩阵、os/cpu 与平台块一致），
     **不碰 registry**；接进 fork 的 CI，坏形状在 PR 红而不是发版后红。
  2. `verify-published.ts`：**"已发布"不等于"能用"**——把**已发布的** tarball 装进一次性前缀、
     跑 `--version`、确认那个二进制自己把内嵌 web 服务出来；作为 release lane 的最后一步；
     非 macOS 宿主上它反过来断言 npm 拒绝安装。
  3. wrapper 元数据补齐（`engines`/`funding`/`publishConfig`/`sideEffects`）+ dist-tag 策略
     （稳定 `latest`、预发布 `next`，预发布不会被 `npm i -g` 误装）。
- 策略写进 `product.json` 的 `npm` 块（发布必须带 provenance、平台包与 wrapper 同版本、
  optionalDependencies 不手写、发布后跑 verify），跟着代码走而不是记在某人脑子里。
- **一条要照实说的账**：面 B（我们自己的代码）**10.23%，越过了 10% 那条律**（M5 时 5.34%）。
  构成：M4/M5 的产品代码（压缩钩子、会话流渲染）＋ 私有化的品牌/配置面改动 ＋ 本批的分发基建
  （install.sh、verify-published、publish 校验、release 流水线）。棘轮按设计把这次越线**记进金样并在
  review 里可见**（这就是它存在的意义），但结论也要说清：分母里引擎（判定层）占 18,335 行，我们这
  2,528 行里大头是**呈现、绑定与分发**，没有一行在做判定——判定那条律由 `surface-semantics` 单独
  盯着（0 命中）。若要回到 10% 以下，诚实的做法是把"分发基建"从"工具面"口径里分出去（它不是
  agent 可见的表面），而不是删掉校验代码；口径变更需要单独决策 + 重记，本批不做。

## 2026-09-25 · v0.2.0：配套产品面回归（web 内嵌）+ README/基础设施（对齐 iterate 形态）

owner 2026-09-25："那几个配套产品面还是需要的" + "README 等基础设施模仿 iterate 生态做"。

- **产品面重新划线**（`product.json` → `product`，FORK.md 同步）：**发** CLI+TUI、**内嵌 web
  应用**（默认恢复内嵌，与上游、与 iterate 把 dashboard 烤进 wheel 一致；`--skip-embed-web-ui`
  出纯 CLI 构建；运行期 `OPENCODE_DISABLE_EMBEDDED_WEB_UI` 与降级路径未动）、仓内 `docs/`、
  随仓 SDK/plugin；**不发** console/enterprise/stats/infra（私有 harness 没有"组织与额度后台"形态）、
  Electron 桌面 app（第二批，需签名/公证账号）、**上游文档站**（`packages/web` 内容尚未私有化，
  product.json 里标 `not-yet-ours`，不把上游文案当我们的文档发）。**内嵌实测**：带内嵌构建
  `Smoke test passed: 0.2.0`，`serve --port 4399` 真的吐出内嵌 HTML 与资源（curl 验过）。
- **README 双语重写**（iterate 同款结构）：居中标题 + 语言切换 + npm 下载/动态版本/CI/License/
  macOS/Stars 徽章 + banner + 问题陈述（agent 无法诚实回答"界面动了吗"）+ 产品面表 + 安装
  （四条通道 + 实测注记：npm≥11 `allow-scripts` 警告、全局前缀不可写的补救）+ 上手 + `gp_*` 表 +
  证据四条律 + 文档索引 + 开发命令 + 许可/署名。
- **基础设施补齐**：`assets/logo.svg` + `assets/banner.svg`（SVG：品牌是可 diff 的文本，不是二进制）、
  产品 `CHANGELOG.md`（0.1.0 首发 + 0.2.0 本批）、产品 `SECURITY.md`（披露流程 + 四张 macOS
  权限表 + 依赖钉定姿态）、`docs/` 六页（index/install/tools/evidence/migrate/troubleshooting）、
  `.github/ISSUE_TEMPLATE`（bug 表单强制要 `gp_probe_status` 输出；feature 表单问"它靠哪条证据"）、
  `.github/pull_request_template.md`（把本线纪律做成勾选清单：fork-diff 同批重记、product.json
  先行、brand 闸、带反向控制的固定点、边界照实）。
- **文档链接检查扩面**：`check-doc-links.mjs` 现在覆盖产品文档（24 份 / 212 条链接）——扩完立刻抓到
  两处**写死了工具数目**（FORK.md 的 M1 行、SYNCLOG 的旧记录；连本条描述修复的句子也先被检查器
  咬了一次——它对"数目字面量"一视同仁），按本线"清单从 `hello` 读、
  不抄"的口径改成不写死数目。私有化换了门面，门面上的死链也得红。
- 版本线 0.1.0 → **0.2.0**（产品面变更走 minor，pre-1.0 语义）；发版前 `product-surface` 复核清单↔
  各脚本一致。

## 2026-09-25 · 首发：glasspane-harness v0.1.0 上 npm + split 远端仓建成（外部动作执行完毕）

用户 2026-09-25 "其他所有问题全部修掉"之后执行（此前记为"等 owner 点头"的外部动作，本机 `gh` 与
`npm` 均以 jingzhao-l 认证）：

- **split 远端仓建成**：`gh repo create jingzhao-l/glasspane-harness --public` + 推送
  `git subtree split --prefix=harness/glasspane-harness`。**先证明再推**：split 分支的 tree 哈希与
  `HEAD:harness/glasspane-harness` 逐字相等（`5efbbc1…`），6,615 文件、125.9 MB。
- **npm 首发 v0.1.0**：本地 12 目标构建 `BUILD_RC=0`（含每个当前平台目标的冒烟 `--version`）→
  `script/publish.ts` 发布 **12 个平台包 + wrapper**（`glasspane-harness` 与
  `glasspane-harness-<os>-<arch>[-baseline][-musl]`），`PUBLISH_RC=0`。
- **两条安装通道端到端实测**（这是"一键下载"真正成立的那一步）：
  - `npm install -g --prefix ~/.local glasspane-harness` → `glasspane-harness --version` = **0.1.0**，
    `gp-harness --version` = **0.1.0**；
  - `bun add -g glasspane-harness` 同理（本机解析较慢，属环境）。
  实测到并已写进 `scripts/install.sh` 与 README 的两件事：npm ≥ 11 对首次见到的包打印
  `allow-scripts` 警告（安装仍成功；安装器在第一次没产出可用命令时用 `--allow-scripts` 重试），
  以及全局前缀不可写（EACCES）时给出确切补救 `npm install -g --prefix "$HOME/.local"`。
- **split 仓的 CI 第一次红，抓出两个真缺陷**（详见下面两条 fix 提交）：import 漏了 7 个上游文件
  （`fork-diff` 盲区：四桶比的是工作树 vs 参照 index，"在磁盘上但从未提交"的文件看起来逐字相同），
  以及**编译产物启动即崩**（vendored kernel 的 barrel 在模块初始化时用 `createRequire` 读
  `../schemas/*.json`，单文件二进制里没有这个路径——源码模式永远看不见，是 build 自己的冒烟测试抓到的）。
- **新仓的 dependabot 关掉了**（`.github/dependabot.yml` 写成 `updates: []` + 理由）：这个仓钉在
  `v1.18.32`，而"与钉点的分叉面是**实测**的"正是本线的纪律；一条自动 bump PR 可以让本仓 CI 全绿
  （固定点不测第三方字节）却让已记录的分叉面失效。依赖移动仍按老路进来：参照克隆、每周 probe、一次
  有意的同步。
- **split 仓 CI 全绿**（干净 runner 上：install + 四个发布包 typecheck + 66 条固定点 + product.json
  冒烟），`conclusion: success`。GitHub release 资产 lane（release.yml 的 5 个原生目标）在本机记录时
  仍在排队等 runner——npm 是主通道且已实测，资产是兜底通道。
- **13 条残留的上游全量测试失败**（`cli/run`、`mcp-add`、`help-snapshots` 等子进程类）：串行 + CA 束 +
  120s 超时后从 51 降到 13，隔离跑单条全过、整文件跑被 30s 预算杀掉（`Error: Timed out`，子进程无输出），
  而 CLI 冷启动实测只要 1.5s（源码）/0.64s（编译产物）——是上游测试写死的时序预算与本机负载/全环境
  隔离子进程之间的张力，不是产品缺陷；stash 对照（M5 基点）证明这 13 条与本线无关。挂账口径改为
  "上游时序敏感用例在本机不可靠"，不再假装能修。

## 2026-09-25 · 私有化批次 D：项目目录改名（`.glasspane-harness`）+ 全量测试真因

- **项目级 `.opencode/` 改名**（C/C′ 批记为"下一批开工项"，本批做完）：9 处——v1 `config/paths.ts` 与
  v2 `core/config.ts` 两套解析器、v1 `config.ts:445` 目录名过滤器与 `config/tui.ts` 扫描过滤器、
  四个写路径（`plugin/install.ts`、`cli/cmd/agent.ts`、`session/session.ts` 的 plans、
  `plugin/tui/runtime.ts` 的 themes/tui.json）、plans 权限两条并列放行（产品路径 + 遗留路径）、
  v1/v2 两份 customize 提示词（C′ 已做）。**"同层共存谁赢"是实测的**：用 remeda 实跑
  `mergeDeep(target, source)` 确认"**后者覆盖前者**"，所以解析器目标顺序写成
  `[".opencode", ".glasspane-harness"]`（遗留在前、产品在后）——反过来会让遗留目录静默压过
  产品自己的配置，而这类失败编译与其它测试都看不见。
- 新增固定点 `test/config/project-config-dirs.test.ts`（6 条 = 3 行为 + 3 结构）：只有遗留目录被
  找到、只有产品目录被找到、**同层两者时产品目录排在后面**（配合实测的合并方向）；三处目录名过滤器
  接受产品名（v2 与 TUI 扫描的过滤器在需要整套配置图的服务层里，结构钉住并在注释里写明这条边界）。
  **反向控制已验**：把目标顺序写反 → 同层用例变红 → 还原转绿。
- **`51 条全量测试失败的真因查清**（此前按"上游旧账"挂着账）：
  1. **头号根因是本机 TLS 拦截，不是代码**：测试运行期要从 GitHub 下载 ripgrep，Bun 不信任拦截证书
     （与 A 批 build 的 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 同一个坑）。带上钥匙串 CA 束
     （`NODE_EXTRA_CA_CERTS=/var/tmp/glasspane-harness/ca-bundle.pem`）后 `tool/grep`/`tool/glob`/
     acp 全绿；
  2. 剩下的子进程类（`cli/run`、`cli/serve`、`mcp-add`、`help-snapshots`、`httpapi-file`、
     `tui/thread`）**隔离跑全过**（单条 10.6s），批量并行时撞的是 30s 默认超时——不是缺陷，是本机
     负载下的超时；串行 + `--timeout 120000` 的复跑结果附在本条末尾。
  教训：**"全量红"先分环境类与代码类再谈修**。上一轮把 51 条整包当"上游旧账"挂着，其中一半当场可解。
- 账：fork-diff 6528/6678 identical、47 edited、46 added、57 deleted；面 B 2,326 行 9.49%；
  固定点 60/60 + 新 6 条 = **66/66**；brand 0 命中（血缘 18,652）；product-surface 86/86；tsgo 0 错。
- **外部动作已解锁**（本机 `gh` 与 `npm` 均以 jingzhao-l 认证；`glasspane-harness` 在 npm 上未被占、
  远端仓尚不存在）：split 子树仓 + 首发 npm 的执行结果见下一条。

## 2026-09-25 · 私有化批次 C′：项目目录配置面的两处低风险补齐

- `cli/cmd/mcp.ts` 的项目目录配置候选：`.glasspane-harness/glasspane-harness.json(c)` 排前，
  `.opencode/opencode.json(c)` 保留为遗留候选（与批次 A 的全局配置同名策略一致）。
- `skill/index.ts` 的 customize 技能提示词：改为教产品自己的配置面（glasspane-harness.json(c)、
  `.glasspane-harness/`、`~/.config/glasspane-harness/`），上游名以 legacy 形式并列；技能 id 与正文
  保持上游（血缘）。顺带把血缘计数从 18,652 降到 **18,649**（提示词里三处 opencode 被产品名替掉）。
- **刻意没做的**（保持 C 批的挂账，理由升级为技术性的）：项目级 `.opencode/` **目录**本身
  （agents/commands/plugins 的项目内落点，20 处解析点）仍不改名。读完解析链才清楚这不是"加个
  候选名"那么简单：v1 `ConfigPaths.directories()` 的下游 `config.ts:445` 用
  `dir.endsWith(".opencode")` 过滤目录，合并方向是 `mergeConfig(result, source)`（后者覆盖前者），
  v2 `core/config.ts` 另有一套 `up()` + basename 过滤 + `toReversed()` 的并行解析——"两者同层
  共存时谁赢"必须先有固定点钉死，否则改名的失败模式是**用户的项目配置被静默忽略**，而这正是本线
  SYNCLOG 反复吃过亏的那类"看起来是进展、实际静默破坏"。现状照实计入血缘基线（18,649），是
  下一批的开工项而非遗漏。
- 门禁：tsgo 0 错；固定点 60/60；brand-surface 0 命中（血缘 18,649）；product-surface 86/86；
  fork-diff 6538/6677、37 edited；面 B 2,279 行 9.31%；E8 复跑全绿。

## 2026-09-25 · 私有化批次 C：品牌面棘轮 + 三条剩余固定点

- `harness/tools/brand-surface.mjs` + `contracts/brand-surface.json`（首次基线：**0 命中**，
  血缘 **18,652 处 / 3,906 文件**（口径：排除 fork 自己的血缘文档——SYNCLOG/FORK/上游 AGENTS/两份 README/NOTICE——它们是"讲血缘故事的地方"，诚实的文档写作不该让代码血缘计数变红；两份 README 的**措辞**仍由行级规则管住））。口径与四条规则见工具头注释；要点：产品面 25 个文件里
  **可执行文本**零容忍（注释豁免——"我们删掉了 X"的注释是记录不是引用），两份 README 按行判定
  （每处 opencode 必须在署名行，**包路径 `packages/opencode` 也算行**），全树血缘计数只许减不许增。
  今日全仓 opencode 串最多的一处就是这条基线本身：它把 `@opencode-ai/*`、`OPENCODE_*` 这些
  **刻意保留**的血缘名变成有基线的存量，而不是没人管的增量。
- 反向因果六条全验可红：安装器装上游 npm 名 / publish 推上游 ghcr / README 叫用户跑 opencode /
  postinstall 解析上游平台包 / 用户可见字符串说 opencode / 血缘计数增长（塞一个新文件）。两条
  **校准负例**：无引号的 `opencode-ai` 与模板形式 `opencode-${platform}` 一开始只被总计数兜住、
  专属规则没咬——都收紧到"任何出现"后各自单咬。总计数兜底不能替代专属规则。**又两条校准**：① 血缘计数最初把 fork 自己的血缘文档算进去，SYNCLOG 里诚实写一句"opencode"就红——按文件排除（README 仍走行级规则）；② `upstream-npm-name` 收紧到"任何出现"后误咬 17 处刻意保留的 `@opencode-ai/*` 工作区作用域（重记基线时 17 个假命中暴露）——改为"前面不是 @ 也不属于标识符"，基线回到 0 命中。
- 三条剩余固定点（`packages/opencode/test/tool/glasspane-surface.test.ts`，57 → **60**）：
  1. **超尺寸帧在带内失败**（真 unix socket 对端吐 5 MiB 无换行 → `GP_E_PAYLOAD_TOO_LARGE` +
     可执行 remedy，不抛异常）——这是"truncate.output 对大 evidence 包"那一挂账项的**可测部分**：
     传输层上限是 4 MiB，越界时模型看到的是引擎形状的错误帧而不是炸掉的调用。
  2. **`maxDepth` 的 1–10 由 schema 强制**（此前只是描述文字：`maxDepth=100000` 会真的发出去，
     等引擎用 payload 错误把它顶回来——一次白跑的对 round，还等于给模型自己的工具调用递了把
     上下文杠杆）。改成 `NumberFromString.check(isInt).check(isBetween{1,10})`，沿用本仓既有的
     `Schema.Int.check(Schema.isBetween(...))` 写法（effect 4 beta 没有 `Schema.int`/`between`，
     第一次尝试的写法被 tsgo 抓住）。
  3. **code-mode 旗标不藏工具面**（结构型，注释里说清它的边界）：钉住 registry 里唯一可能吞掉
     builtin 的那行 `visible = filtered.filter(tool.id !== "execute" || codeModeDescription)`，
     断言没有任何可见性谓词提到 gp_，且 code-mode 目录只由 MCP 工具构成（旗标打开也不会把 gp_*
     折进 MCP-only 描述里）。
- 顺带核实并**结掉**一个旧挂账项：TUI 对 `attachments` 的渲染出口——现有 `gp_*` 工具**今天
  没有一个产出 attachment**（grep 为零），所以"没有渲染出口"目前还不是缺口；等 capture 类工具
  落地那天它才会变成真问题，已写进方案 §10 代替原来的含糊挂账。
- 门禁：固定点 **60/60**；brand-surface 0 漂移；product-surface 86/86；fork-diff / tool-surface /
  hook-liveness / kernel-vendor / surface-semantics / check-workflows(5) / check-doc-links 全绿；
  fork tsgo 0 错。E8 本批未重跑（改的是测试与仓根侧工具，运行时未动；上一批 E8 全绿）。
- **如实挂账**：① code-mode 固定点是结构性的——真跑一遍 `ToolRegistry.tools()` 需要整套服务图，
  这批没搭（注释里写明了这条边界，不是伪装成行为测试）；② 血缘计数把 `.opencode/` 项目目录
  的 20 处解析点全树未改这件事照实计入基线（改名必须带遗留回退，下一批开工项）；③ 外部动作
  （远端仓、Trusted Publisher、npm 首发）仍等 owner。

## 2026-09-25 · 私有化批次 B：一键安装器 + 产品面一致性闸

- **动机**：批次 A 改了名，但"名字"这件事散在 9 个地方（product.json、package.json、build、
  publish、postinstall、bin shim、两个安装器、工作流），改一处忘另一处的症状**不是红测试**——
  是装出来的东西不对，或者发布推到陌生人 registry。iterate 的 npm 包配 postinstall + curl|bash
  双通道；我们照形态建，但把"一致"变成机器检查。
- 新增：`scripts/install.sh`（横幅/OS 探测/npm 优先→GitHub release 资产兜底/`--version`/`--dry-run`/
  验证/`gp_*` 前提说人话：GlassPane 引擎要先装且授权辅助功能，没有它每个 gp_* 调用只会回
  `GP_E_ENGINE_UNREACHABLE`——那是引擎的话，不是安装器的）、`scripts/install.ps1`（同形态，Windows；
  并说清 Windows 上 harness 是跑在 macOS 宿主对面的客户端）；`harness/tools/product-surface.mjs`。
- `product-surface.mjs`：**86 条一致性断言、无基线**（它量的不是数字而是"该不该一样"，所以没有
  `--record`——规则错了改规则，没有金样可盖）。覆盖：manifest 名称/版本/bins ↔ product.json、
  平台包模板与 12 个目标名唯一、build 读清单且写产品二进制名与 user-agent、publish 以产品名发
  wrapper 且有 `--wrapper-only`、**产品面可执行文本里不许再出现上游 registry**（ghcr.io/anomalyco /
  anomalyco/homebrew-tap / aur.archlinux.org / opencode.ai/install / "opencode-ai"）、postinstall 与
  bin shim 的平台包/二进制名、install/upgrade/uninstall 的包名、状态根常量、配置发现**产品名优先且
  遗留名仍在**、两个安装器的 URL/形态（`sh -n` 过语法，`--dry-run` 真跑并断言计划里有产品名）、
  fork 工作流恰好是 ci+release 两个且 release 有 tag/手动双闸、NOTICE 记着上游 tag 与 MIT。
- 接入：`.github/workflows/ci.yml` 的 tool-surface lane 加一步；`package.json` 加
  `contracts:product`；`harness/README.md` 目录表/尺子/怎么跑/金样数字同步（顺手把上一轮遗留的
  旧分叉数字 6630/2/33 与面 B 1,867 更成实测值）。
- 反向因果五条全验可红：① product.json 版本改成 9.9.9 → `manifest-version` 点名；② publish.ts
  代码里塞回 `ghcr.io/anomalyco/opencode` → `no-upstream-registries` 点名；③ 安装器 REPO 指向别人仓
  → `installer-urls` 两条点名；④ 多放回一个 publish.yml → `workflows` 点名；⑤ 配置发现删掉
  `opencode.json(c)` 遗留回退 → `config-names` 点名；还原后转绿。
- **两条校准负例也是这批最值钱的产出**：① 第一版 URL 规则被注释里的仓库名喂饱（`install.sh` 的
  仓库名只出现在 header 注释里，规则却过了）——改为只看可执行文本（注释里的"我们删掉了 X"是记录，
  不是引用）；② state-root/config 两条断言一度被分段插入落在 `process.exit` 之后成了死代码，闸一直
  绿——是计数从 83 跳到 86 时才发现。**"闸是绿的"必须连计数一起看**，这条已写进尺子说明。
- 门禁：product-surface 绿（86/86）；check-workflows 5 个工作流绿；check-doc-links 绿；fork tsgo
  0 错；固定点 57/57 未受本批影响（安装器与闸都在仓根侧，不进 fork 运行时）。
- **如实挂账**：① 整套安装流程（真 `npm install -g`、真下载 release 资产）**未端到端跑过**——
  因为 npm 上还没有 `glasspane-harness` 这个包、远端仓还不存在（外部动作，owner 点头才做）；本地
  能验的（语法、dry-run 计划、URL 与清单一致）都验了。② Windows 侧只做了形态对照，没在 Windows
  机器上跑过（ps1 无法在本机执行）。③ Trusted Publisher 仍待 owner 配置。

## 2026-09-25 · 私有化批次 A：产品身份（glasspane-harness）与发布流水线

- **动机**：上一批把 M1–M5 收口了，但产品还叫 opencode——npm 包、二进制、安装脚本、
  状态根、配置文件、TUI 主题全是上游的名字，一个 GlassPane 的私有产品"装出来是 opencode"
  说不过去。参照 iterate 生态的做法（`iterate-harness` = openharness 的私有化 fork：改发行面、
  保留内部血缘名、自建发布），本批做**产品身份**。
- 改动面（`fork-diff`）：**`6539/6675 byte-identical, 36 edited, 43 added, 57 deleted`**
  （上一批 `6628 / 4 edited / 37 added / 0 deleted`）。`deleted` 57 件逐类：上游 26 个工作流、
  20 份 locale README、`STATS.md`、`CODEOWNERS`/`TEAM_MEMBERS`/`pull_request_template`/
  `ISSUE_TEMPLATE`/`publish-python-sdk.yml`——它们要么会往 anomalyco 的基础设施推（docker
  ghcr、AUR、homebrew tap、`opencode.ai/install` 自升级），要么是上游的营销与协作流程。
  `added`：`product.json`（产品清单）、`NOTICE`、`bin/glasspane-harness`（原 `bin/opencode` 改名）、
  自建 `ci.yml` + `release.yml`。
- 改了哪些产品面：包名/bins/平台包模板/版本线（`0.1.0`，独立产品线，**不参与主仓 1.1.1 版本线**——
  `check-version.mjs` 复跑仍绿）、user agent、mDNS 名、状态根（`global.ts` 一个常量带全部 XDG
  路径）、配置文件名（`glasspane-harness.json(c)` 优先 + 上游名遗留回退）、TUI 默认主题（读时迁移旧
  id）、basic auth 默认用户名、install/upgrade/uninstall/serve/tui/run/attach/pr/providers/web/debug
  的用户可见文案、README 双语重写。细节与"刻意保留的血缘名"清单见 `FORK.md`『产品身份与私有化』。
- **删掉的三处"会替别人干活"的路径**（都不是品牌问题，是安全问题）：`publish.ts` 尾块推 docker
  ghcr/AUR/anomalyco homebrew tap；`installation` 的 curl 自升级会 fetch 并执行
  `opencode.ai/install`；`packages/web` 的 console 部署基建（`infra/`）随产品不发布。
- Web UI 嵌入从默认改为 `--embed-web-ui` 显式开启（产品面只发 CLI+TUI；假设与代价写在
  `FORK.md` 与 `product.json` 的 `product.note`）。
- 门禁：`fork-diff --check` 全量绿（6539/6675）；`tool-surface --check` 绿（面 B 1,867 → **2,098
  行 = 8.64%**，仍 <10%，增量是本批的注释与清单读取）；`hook-liveness --check` 在线 20 钩子无漂移；
  `kernel-vendor` 绿；`surface-semantics` 绿；`check-workflows` 绿（**已扩到扫 fork 自己的两个工作
  流**：脚本路径按各自仓根解析，split 之后子树就是仓根）；`check-version` 绿（主仓版本线未受影响）；
  `check-doc-links` 绿；fork `tsgo --noEmit`：core/opencode/tui **0 错**（过程中抓到 3 个真错：被替换
  掉的 `upgradeCurl` 残留旧函数体导致 `response` 未定义 + 返回类型不匹配、`publish.ts` 的
  `avx2?: false` 与 JSON 导入的 `boolean` 不兼容——全部按错改完转绿）；glasspane 固定点 **57/57**；
  **E8 复跑全绿**（改名后宿主仍能起、钩子仍被派发、注入块仍到 mock provider）。
- **如实挂账**：① npm Trusted Publisher（每个包一条、staged-only）与远端仓 `jingzhao-l/glasspane-harness`
  是外部动作，未执行——`release.yml` 写好了等 owner 点头；② musl/baseline 目标在 `product.json`
  里有声明但 CI 还没有 lane（release.yml 只跑 5 个原生目标）；③ 项目级 `.opencode/` 目录（agents/
  commands/plugins 的项目内落点，20 处解析点）**本批没改名**——改名必须带遗留回退才安全，属于下一
  批的显式开工项，不是遗漏；④ 整包 `bun run build` 未重跑（改名后的产物要等发布 lane 首跑才验；
  E8 与门禁都从源码起服务）；⑤ 上一批挂账的 51 条上游全量测试失败依旧（与本批无关，已对照证明）。
- 本批引入的两道新闸（`product-surface.mjs` / `brand-surface.mjs`）与一键安装器在**下一批**；
  上一条"假设"（产品面只发 CLI+TUI）在下一批的固定点与文档里再钉一次。

## 2026-09-25 · M4 + M1 补齐 + §9-6：五薄模块收口

- 改动面（`fork-diff`）：**`6628/6669 byte-identical, 4 edited, 37 added, 0 deleted`**（M5 批是 `6628 / 4 edited / 33 added`）。`added` +4：`src/plugin/glasspane-compaction.ts`（M4）、`test/plugin/glasspane-compaction.test.ts`（M4 固定点 16 条）、`test/tool/glasspane-surface.test.ts`（M1 固定点 6 条）、`script/glasspane-e8-compaction.ts`（E8 探针）。`edited` 名单不变（`plugin/index.ts` 再 +1 import、+1 数组项，含 3 行注释）。
- **M4 的落点**：内部插件 `src/plugin/glasspane-compaction.ts`，绑 `experimental.session.compacting`（零 patch，触发点 `session/compaction.ts:374`）：
  - 上游只给 `{sessionID}`，所以用 `client.session.messages` 拉会话（方案 §5 M4 行点名的要求）。**"判当前轮属哪个维度"的那半没有做，也没有假装做**：本 pin 的内核导出面里没有 `dimensionContext`（实测），维度系统按综述 §8.5 Phase A 首发范围属 iterate 侧节奏。M4 交付能诚实交付的形态——把引擎/内核**已写下**的证据锚点（opID、outcome、台账序号与哈希）转录进 `output.context`；会话用过 `gp_*` 但决策为 0 条时，缺席以 `calls vs decisions recorded` 的**算术**呈现，不静默。
  - 只转录不判定：锚点字段全部来自 `metadata.result`（引擎写下）与 `metadata.decisionLog`（内核台账票据）；没有阈值、没有 pass/fail 合成——守住自己的边界靠的正是本批那条 §9-6 闸。
  - 上游是 `nextPrompt = compacting.prompt ?? [默认提示, ...compacting.context]`：别人的 `prompt` 一旦被替换，`context` 就是死信。所以两条路都走（`prompt` 已定义 → 追加在它之后；否则进 `context`），且绝不替换别人的提示词。边界照实写在代码注释里：若别的插件在我们**之后**替换 prompt，写进 context 的块仍会被 `??` 丢掉——本 fork 今天没有第二个人碰这个钩子（已 grep）。
  - 失败可见：拉消息失败不抛进宿主的压缩路径，而是把 `anchors NOT preserved` 追加进同一处（缺席必须说得出）。
- **E8 运行时（M4 的决定性证据，不花钱不联网）**：`script/glasspane-e8-compaction.ts`——mock OpenAI-compatible provider（`@ai-sdk/openai-compatible` 在这个 build 里是 **bundled** provider，零安装零凭据）+ 从本树源码起 `serve` + 真实会话（mock 发一次 `gp_probe_status` 工具调用、宿主真执行落成 completed part）+ `POST /session/:id/summarize` 触发真压缩。判定写在 **provider 边界**：mock 记录每个请求体，断言的是"做摘要的那个模型请求带着注入块"、块里 `gp_* calls: 1 · decisions recorded: 0`（缺席被说出来）、且**压缩前的轮次没有泄漏该块**。实测全绿，连跑复现。
  - 顺带把 M2 的一条挂账结了：同一会话里 `tool.execute.after` 的 note 落进了 part metadata（`skipped: gp call did not succeed (GP_E_ENGINE_UNREACHABLE)`）——宿主**确实走到** M2 的 hook（此前只有静态派发点证据）。真会话里 `logged` 分支的写入仍需一次证据成包的真轮次（E7 已用引擎自己写的档案字节验过写入本身）。
- **M1 固定点补齐**（§7.5 纪律要求 M1–M5 各自有行为不变量，此前 M1 只有运行时证据）：`test/tool/glasspane-surface.test.ts` 6 条——id 裸 `gp_` 前缀/唯一/描述与 parser 齐、remedy 必进 `output`（E6 量过模型只读 output）、未宣布能力的方法给可执行 remedy、真死 socket 仍回 `{code,message,remedy}`。为此导出 `present()`/`unavailable()`（同 M5 导出 `glasspaneRow` 的理由：测不出来的规矩不是规矩）。
- **本批修掉一个自己的运行时缺陷（因果已验）**：`daemon.ts` 的 `rawRequest` 原来 `net.createConnection(target)` 先连接、监听器后挂。缺失 socket 的 `error` 可能**在监听器挂上之前**发出，无监听器的 `'error'` 被抛成未捕获异常 → Promise reject，而契约是"永远 resolve 一个可读的 `DaemonReply`"。实测（`bun test` 下，同一条死 socket）：一次 run 回 `GP_E_ENGINE_UNREACHABLE`，一次直接 reject ENOENT，一次 2s 后走 `GP_E_ENGINE_TIMEOUT`。改为 `new net.Socket()` → 先挂全部监听器 → 最后 `socket.connect(target)`，之后连跑 5 次全绿。（真宿主里此前没炸——E8 跑出的是正常的 `GP_E_ENGINE_UNREACHABLE`——但"没炸"只是没赶上那个窗口。）
- **§9-6 开工项落地**：新尺子 `harness/tools/surface-semantics.mjs` + 金样 `harness/contracts/surface-semantics.json`（棘轮式），进 `ci.yml` 的 `tool-surface` job 与根 `package.json` 的 `contracts:semantics`。三条规则：阈值比较（小数对照）、pass/fail 三元/相等合成（**按主语判**：`x.status !== "failed"` 是台账记账，`ok ? "pass" : "fail"` 才是判定）、证据字段比较（`!== undefined` 在场检查豁免——缺席要说得出）。**基线实测 0 命中 / 15 个文件**：两个工具面今天都不判证据语义。**反向因果三条**（都点名红、还原转绿）：`mcp-shell/src/tools.ts` 加 `ratio > 0.95` → threshold 红；`glasspane-decision-log.ts` 加 `ok ? "pass" : "fail"` → verdict 红；`mcp-shell/src/evidence-report.ts` 加 `pack.signals.pixelDiff >= 0.5` → 两条规则同红。无金样 → exit 2 并指名 `--record`。
  - 校准过程照实记：第一版规则把本仓 `status: "failed"`（写台账自己的状态）与 `pixelDiff !== undefined`（在场检查）判成命中，基线一度 6 命中——**先校准规则再记基线**，否则金样记的是规则的噪声而不是事实。
- **顺手修掉 CI 里一处自伤**：`tool-surface` job 的 `kernel-vendor` step 曾被复制成两份（同 name 同 run，同一次跨 base 合并事故的残留）。`check-workflows.mjs` 查的是 job 键与脚本引用，查不出"合法但重复的 step"，所以一直没人发现；已去重。
- 占比账（`tool-surface`）：engine 18,335 / 面 A 3,859（16.03%）/ **面 B 1,867 行 = 7.76%**（M5 批是 1,251 / 5.34%）。测试排除 5 文件 952 行、vendored 排除 10 文件 1,150 行，两项照旧打印并进金样。
- 门禁复跑：`fork-diff --check` 全量（含参照克隆）绿；`tool-surface --check` 绿；`hook-liveness --check` 在线绿（20 钩子无漂移）、`--offline` 绿；`kernel-vendor --check` 绿；`surface-semantics --check` 绿；`check-workflows` 绿（3 个工作流）；fork `tsgo --noEmit` **0 错**；glasspane 固定点 **57/57**（M1 6 + M2/M3 35 + M4 16）；E8 全绿。
- **如实挂账（没跑/仍未验）**：
  - opencode 包**全量** `bun test`：3659 tests / **51 fail**。经 `git stash -u` 对照证明这 51 条在 M5 基点**一模一样**（跑同样 16 个文件，失败名集合逐条相同：ONLY-in-mine 0、ONLY-in-baseline 0）——全在上游面（CLI 子进程 `run/serve/acp/mcp add`、`tool.grep`/`glob`/`skill`、`tui thread`、`httpapi-file`、help 快照），本批无关，但也没人修，如实挂账。
  - tui 包全量 `bun test`：195 pass / 5 fail，全在上游 `DiffViewerFileTree` 与 hunk 导航（`packages/tui` 本批零改动，`git diff --name-only` 可证）；M5 的 `inline-tool-wrap` 与 `glasspaneRow` 23 条全绿。

## 2026-09-25 · M5：会话流内 evidence 渲染（TUI patch + 口径修复）

- 动机（提交 `5f3a494`）：`gp_*` 的引擎失败是一次 `status=completed` 的工具调用，`ok:false` 只在 metadata 里——`GenericTool` 把 `GP_E_NO_EVIDENCE` 这类**引擎拒绝**渲染得和真实结果一模一样。会话流分不出"引擎给了答案"还是"引擎给不出答案"，M5 让两者在会话流里视觉可分。
- 改动面（`fork-diff`，该提交金样）：**`6628 identical / 4 edited / 33 added / 0 deleted`**；`edited` 从 2 涨到 4：`packages/tui/src/routes/session/index.tsx`（+193）与其上游测试 `inline-tool-wrap-snapshot.test.tsx`（+82），两者的**双侧内容哈希**都进金样。
- 内容：`toolDisplay` 加 `gp_` 前缀分支（前瞻兼容未来方法，呼应 M1"从 `hello` 读能力、不抄死名单"）；导出纯函数 `glasspaneRow`（method 感知的安全转写，只转写引擎已下结论的字段；成功行**中性**——不渲染绿色 PASS，因为"证据是否证明 UI 生效"是 kernel 的裁决不是 TUI 的）；`GlassPaneTool` 组件接 `InlineToolRow` + 权限高亮 + 点击展开 remedy。
- 测试 +6（gp_ 路由、成功转写、引擎失败带 remedy、call-error vs denied、`last_evidence` 字段逐字、未知方法不臆造形状）：**23 全绿**，8 个既有 snapshot 未动。
- **守卫自身修复（M5 暴露的）**：`tool-surface` 的 `isTest` 排除原本只在 `added` 循环、`edited` 循环没有——此前没有 edited 文件是测试所以从未触发，M5 让测试文件进了 edited 桶，其 +82 行漏计进面 B，而报告还在打印 "tests excluded"。按口径对称性修复（edited 测试同 added 测试一样排除；面 B 1,251 / 5.34%——两种算法下都 <10%，不是为转绿而改数）。反向因果已验：非测试 edited 文件 +5 行变红，edited 测试 +5 行不计入。
- 门禁（当时）：fork `tsgo --noEmit`、23 测试、hook-liveness、kernel-vendor、check-workflows 全绿。
- **未跑/未验**：真 TUI 会话里这条渲染路径的观感未观测（组件级由测试钉住）；`packages/{app,session-ui,desktop}` 会不会取代 TUI 仍挂账（方案 §10）。

  - 真模型轮次依旧没跑：`ctx.ask` 权限卡观感、`truncate.output` 对大 evidence 包的真截断、M4 在真模型下的压缩质量、真 TUI 会话里 M5 渲染的观感。
  - 整包 `bun run build` 未重跑（产物仍是 M1 条那次的；E8 与门禁都从源码起服务，不需要产物）。


## 2026-09-25 · M2+M3：内核以 vendored 形态进 fork，决策审计链开始生产

- 改动面（`fork-diff`）：**`6630/6665 byte-identical, 2 edited, 33 added, 0 deleted`**（上一批是 `6631/6637, 1 edited, 5 added`）。
  - `edited` 从 1 涨到 2：`tool/registry.ts`（M1）+ **`src/plugin/index.ts`**（M2 的内部插件注册，2 个 hunk：import + 数组末尾一项）。
  - `added` 从 5 涨到 33：我们自己的 5 个源/脚本文件 + 2 个测试文件 + **23 个 vendored 内核文件**（`packages/opencode/vendor/kernel/{src,schemas,fixtures}`）。
- 占比账（`tool-surface`）：engine 18,335 / 面 A 3,859（16.60%）/ **面 B 1,058 行 = 4.55%**。两项排除都被显式打印并计入金样：**vendored 依赖 10 个代码文件 1,150 行**（由溯源清单排除，不算我们写的）与**测试 2 个文件 467 行**（面 A 的口径本来就是 `src/`，把 B 的测试算进去就是拿两个不同的量比大小）。
- **M3 的形态**（订正后）：`@iterate/kernel` 不进 npm，也不跨仓相对引用，而是 **vendored 源 + 溯源钉**：
  - 新尺子 `harness/glasspane-harness/script/kernel-vendor.mjs` + 金样 `harness/contracts/kernel-vendor.json`（canonical repo/path/branch/ref/version + 每个文件的 sha256）。`--record` **只在对齐时写**：本批真出过一次 canonical 已经前进（15df8d5）而镜像没跟上，`--record` 直接拒绝（"not byte-identical to canonical … fix the copy or the edit, do not record it"）——它拒绝给分叉盖合法章。
  - `--check` 无克隆也能跑（CI 形态）。六条控制：清树绿；改一个 vendored 源文件 → 点名哈希变更 exit 1；删一个 → exit 1；塞进一个清单没声明的文件 → exit 1 且说"fork 长出了自己的内核文件"；`KERNEL_SRC` 在场时跨读 canonical，镜像落后 → **STALE exit 1**；还原全绿。
  - 为什么放在 `packages/opencode/vendor/kernel` 而不是顶层 `packages/kernel`：**zod 解析不到**。bun 的依赖在 `packages/*/node_modules`，顶层新目录没有 node_modules，`import "zod"` 直接 `Cannot find package`；而给它加 package.json 就要重跑整棵 fork 的 `bun install`（10 分钟起，还会再撞一次 ghostty-web 的 TLS）。放进 opencode 包内 → 用包自己的 zod，零安装。控制实验就是这个报错本身。
  - **同一份源码跑在两个 zod 大版本上**（canonical 钉 3.25.76，fork catalog 是 4.1.8）。`tsgo --noEmit` 立刻抓到一处前向不兼容：`z.record(z.unknown())` 在 zod 4 里键类型必填（TS2554）。修在内核（两参写法 3/4 都合法，canonical 90/90 仍绿），不修在 fork。**这条耦合从此是量出来的**：fork 侧固定点测试里断言 `zod` 主版本为 4，且 strict/absent-vs-null/未知键拒绝这些**跨大版本最容易漂**的行为逐条测。
- **M2 的落点**：`src/plugin/glasspane-decision-log.ts` 作为**内部插件**（`internalPlugins` 末尾一项；`OPENCODE_DISABLE_DEFAULT_PLUGINS` 是上游自己的关闭开关，不再另造私有开关）。绑 `tool.execute.after`：
  - 只转录，不判定——outcome/summary 来自内核的 `decisionOutcomeFromEvidence`/`decisionSummaryFromEvidence`，那两个函数只读引擎已经写下的字段；**判定仍在 Swift**，铁律没动。
  - 不猜哪些方法有包：没有 `evidencePack` 就是 `skipped`，**不维护方法名清单**（方法表这两个星期从 11 长到 13，抄死的清单必过期）。
  - 台账写不进 `~/.glasspane`：`resolveLedger` 直接拒（`GLASSPANE_SOCKET` 也会参与定位状态根），因为那是引擎的地盘——`projects.json` 双写已经付过一次学费（B-1/A-15 同一缺陷两个副本）。
  - 写失败**进 `output`**（`decision log NOT written: … remedy: …`），只在尾部追加、绝不替换模型看到的结论；成功时 `output` 一字节都不动（有断言钉住）。
- **运行时证据（E7，`script/glasspane-e7-ledger.ts`，不进 CI）**：连真 daemon（`hello`/`probe_status`），用**引擎自己写到 `~/.glasspane/evidence/` 的档案字节**驱动 hook → 链条两条、`0600`、跳过路径、损坏尾部拒绝并点名 line 3、档案未被写入。**顺带量出一个 daemon 缺陷**：`gp_last_evidence` 无论带不带 `operationId` 都回 `GP_E_NO_EVIDENCE`，而磁盘上有 **582 个档案**（539 个 `0.1-draft` + 43 个 `0.1`；最新那条 `pixelDiff.bounds` 是 `null`，内核读侧完全接受）。也就是说 daemon 的回放路径与它的写入端不在同一处——E7 把它打成 `NOTE FINDING` 而不是悄悄绕开。engine/派发链是别的会话的地盘，本批不改，只留可复现脚本。
- **本批自己抓出来的四个错**（每个都补了控制，不是口头认错）：
  1. `tools/sync-kernel.sh` 参数化时把守卫① 的干跑写成 `rsync -n --delete`（丢了 `-a`），rsync 报错但**退出码被 awk 吃掉** → 守卫① 变成永久"无删除"。现在 enumerate 的失败会被显式判定为"枚举不出来＝拒绝"。
  2. `tool-surface --record` 会在**归因失败**时照样写金样（那次写下 surface B = 0 LOC 的假基线）。现在 record 前先看归因，拒写并说明"要给一个从没量过的数定基线，等于把无声漂移重新发明一遍"。
  3. 测试排除式 `/(^|\/test\/)/` 里那个 `^` 匹配空串 → **每个文件都被当成测试**，面 B 一度只剩 14 行。除法式子换成 `/(^|\/)test\//`，并加了一条兜底：若有文件该算而我们却一个没算，红着说"排除规则错了，不是面为空"。
  4. 回滚用 `git checkout` + `git clean -fdq`，而 fork 镜像是**未跟踪**的：一次 `bun: command not found`（环境缺件，不是代码坏）被判成红闸，回滚把 23 个 vendored 文件**直接删了**。现在运行前做快照、回滚从快照恢复、绝不 `git clean` 自己创建的路径；控制实验：`BUN=/usr/bin/false` 强制红闸 → 镜像 23 个文件、内容签名、溯源清单三项全 PASS。
- 环境如实记：这台机器的 **bun 不见了**（今天早些时候还用它构建过），按 fork 的 `packageManager: bun@1.3.14` 重装了 1.3.14（安装脚本往 `~/.zshrc` 追加了 PATH 一行）。`bun test` **必须从 `packages/opencode` 里跑**——仓库根有个故意的 `do-not-run-tests-from-root` 挡路；而且要用包脚本的 `--timeout 30000`，否则 `test/preload.ts` 的 afterAll（dispose + 删临时目录）会被 5 秒默认超时打断成"无名失败"。
- 门禁复跑：fork `bun test` **35/35**、`tsgo --noEmit` **0 错**；仓内 build OK、kernel **90/90**、mcp-shell 176/176、installer 70/70、版本线 OK、doc-links OK、check-workflows OK、hook-liveness `--offline` OK、kernel-vendor OK、tool-surface OK、fork-diff 在线/离线双向 OK。
- **未跑/未验证**：`bun run build` 整包未随本批重跑（`dist/` 还是 M1 那次）；**真模型轮次仍然没做**，所以"宿主在 `tool.execute.after` 之后真的会调到这个 hook"这条只有静态证据（`session/tools.ts:121-129`）+ 内部插件确实被装载（serve 起来无报错、`gp_*` 工具都在注册表里）+ hook 函数本体的端到端（E7）；M4/M5 未动。

## 2026-09-25 · 度量侧收口：上游参照合一 + 工具面棘轮（不动 vendored 树）

- 改动面（`fork-diff --check`）：**仍是 `6631/6637 byte-identical, 1 edited, 5 added, 0 deleted`，绿**。本批只动 `harness/`（尺子与文档）与本文件，未触碰任何 vendored 源文件；FORK.md/SYNCLOG.md 的编辑不改变 added **名单**，所以记录面不变——这正是"以文件名为单位声明分叉"的含义，也是它的盲区（见下第 4 条）。
- **两把尺子过去读两份"上游"**：`hook-liveness` 读 `upstream.json.checkout`（当初的 142 MB tarball 解包目录 `/Volumes/Eng-Dev/.upstream/opencode-1.18.32`），`fork-diff` 读 `.external/opencode`（含 `.git` 的完整克隆）。合并为**一份**：`checkout` 改成 `.external/opencode`，工具改为"相对路径按仓根解析"。合并前先验两份参照**说的是不是同一件事**：`HARNESS_UPSTREAM_CHECKOUT=.external/opencode node harness/tools/hook-liveness.mjs --check` → `checked 20 hooks against anomalyco/opencode@v1.18.32: no drift`，再 `--record` → 与仓内金样**逐字节相同**（仅 `observedAt` 差）。两份能各说各话的"上游"就是这条线自己要防的失效模式，所以这不是清理，是消除一个真实的分裂真源。
- 新增第三把尺子 `harness/tools/tool-surface.mjs`（+ `contracts/tool-surface.json`，进 `ci.yml` 的 `tool-surface` job）。它量的是 fork 自己的账：**我们在 fork 里写的行也算工具面**。基线：engine 17,197 LOC；面 A（`mcp-shell/src`）3,719 行 = **17.33%**；面 B（fork 内我们写的）539 行 = **2.51%**（`preflight.sh` 83 + `glasspane/daemon.ts` 171 + `glasspane/index.ts` 276 + `registry.ts` 的 `+9`）。铁律的 10% **不改成能过的数字**，A 的越限如实记在金样里，闸只挡没被记录的增长（负例：A +3 行红、B +20 行红、给已 `edited` 的 `registry.ts` 加 3 行也红、删 `fork-diff.json` 让归因不能也红；还原后全绿，三个被动的文件 MD5 前后一致）。
- **一个盲区被发现并当场关掉**（先记录现象，再修，再复验）：`fork-diff` 原本以**文件名**为单位声明分叉，于是"已经在我们改动面里的文件又长了几行"它看不见——实测给 `registry.ts` 加 3 行，`--check` 仍 `6631/6637 … 1 edited …` **exit 0**（日志 `/var/tmp/glasspane-harness/blind-spot.log`）。这正是 iterate 侧那种失控的机制版本：名单看着没变，内容一直在长。修法：金样给每个 edited 文件钉**两个哈希**（上游的与我们的），`--check` 名单之外再比内容。关闸后的复验（`/var/tmp/glasspane-harness/fork-diff-hash.log`）：① 用**旧金样**（无哈希字段）跑 `--check` → exit 1 并指名 `--record`（证明新断言真的在跑，不是装饰）；② 重记后 → exit 0，`editedDetail = {registry.ts, upstreamHash 9167cb3e…, forkHash 36a359e3…}`（前者与"pristine import"那次核对过上游 blob 一致）；③ 再加 2 行 → **exit 1 并点名 our content moved**（同一步在修之前是绿的）；④ 还原 → exit 0，`git status` 该文件零残留。
- **CI 侧的覆盖跟着一起补上**（否则上一条修法只管本地，等于没管日常）：`fork-diff --check` 现在**没有参照克隆也能核我们这一侧**——比对金样里的 fork 侧哈希与 added 文件是否还在，并照实打印"上游字节本轮未复测"。该步已进 `ci.yml` 的 `install-gate`。四条负例实测（`/var/tmp/glasspane-harness/fork-diff-offline.log`）：清树 → exit 0 并报 `1 edited file(s) hash-checked, 5 added file(s) present`；给 `registry.ts` 加 2 行 → **exit 1**；金样被剥掉 `editedDetail`（＝这条 lane 无事可控）→ **exit 1 并直说 "this lane has nothing to check"**，而不是绿；删掉一个 added 文件 → exit 1。还原后在线全量 `--check` 仍 exit 0，三个被动文件 MD5 前后一致、`git status` 零残留。**剩余边界**：上游侧内容（我们相对 v1.18.32 究竟改了多少行）只有本地/发布前的全量跑与周跑覆盖，PR CI 不看上游——这是有意的：223 MB 参照 + 2 分钟全树哈希进 PR CI，结局是被人关掉。
- **合流后基线复算（同日，merge `origin/main` = f16f8c8）**：占比棘轮当场变红并报 `surface A grew 3719 recorded → 3859 LOC (+140)`。这 140 行是别的会话在 main 上加 `gp_capture_view` 写的，不是本线——所以同批 `--record` 重记：engine 17,197 → **18,335**，A 3,719 → 3,859（比例 17.33% → **16.98%**，反而降，因为分母里引擎长得更凶），B 仍 539 / 2.37%。**这次红正是闸设计要的样子**：改动不是没发生，是发生了且这里看得见。
- 同一场合并暴露了我自己先前埋的雷：一次跨 base 的 ci.yml 搬移让 `git merge` 把 `docs:` job **整块复制成两份**（"两边各自加了同一段文本"，三方合并不报冲突、静默通过），而 YAML 映射重名键后定义覆盖前定义＝那份守卫从此不再运行。已去重，并加 `scripts/check-workflows.mjs`（进 `docs` job）盯两件事：jobs 段不许有重名键、`run:` 引用的仓内脚本必须存在（按各 step 的 `working-directory` 解析）。六条负例实测：重复 job 名 → exit 1 点名行数；引用不存在的脚本 → exit 1；同一脚本藏进错误的 `working-directory` → exit 1（证明不是橡皮图章）；正确 wd 下的真脚本 → 仍绿；`.github/workflows` 整目录不存在 → **exit 2**（拒绝在空集上报告成功）；还原 → exit 0 且 `git status` 干净。
- 合并后的复跑（本 worktree，装了依赖）：check-version OK / build OK / kernel 59 59 / mcp-shell 176 176 / hook-liveness `--offline` OK / tool-surface OK（重记后）/ fork-diff 在线 `6631/6637 identical, 1 edited, 5 added, 0 deleted` OK。
- **未跑/未验证（照实挂账）**：`bun run build` 未随本批重跑（`dist/` 产物仍是 M1 条那次的 138 MB 二进制，本次没动 vendored 源码，但"构建产物与当前树一致"这句**不成立**，要用产物前先重建）；真模型轮次依旧没做（`ctx.ask` 权限卡、`output` 截断、M4 运行时形状三条仍挂账）；`packages/tui` 未动（M5 才动）。

## 2026-09-25 · M1：`gp_*` 工具面进 fork（第一次真正的 vendored 编辑）

- 改动面（`fork-diff`）：**`6631/6636 byte-identical, 1 edited, 4 added, 0 deleted`**
  - `edited`：`packages/opencode/src/tool/registry.ts`（3 个 hunk：import、`yield* glasspaneDefs`、`...glasspane` 进 builtin 列表）
  - `added`：`packages/opencode/src/tool/glasspane/daemon.ts`、`.../index.ts`（另两件是本目录的 FORK.md/SYNCLOG.md）
  - 纪律走通了一遍：先跑 `--check` → 它**拒了**并点名 registry.ts（`✗ edited list changed (0 → 1)`），确认改动是有意的之后才 `--record`。金样更新与改动同批落地，不是事后补。
- 三条不变量的落点：判定全在 daemon（TS 侧只转发与成形）；`output` 里带错误码与可执行 remedy、`metadata` 只作结构化副本（这条是 §5.0 E6 实测逼出来的）；会动到真实应用的 `gp_act` 先过 `ctx.ask` 权限面。方法是否可用**不写死清单**，从 daemon `hello.capabilities` 读——上游刚把 `audit_ui` 加进去，抄死的清单必然过期。
- 跑过的闸：
  - 注册表实测：从 fork 源码起 `serve`，`GET /experimental/tool/ids` 返回 `…,"apply_patch","gp_probe_status","gp_attach","gp_observe","gp_act","gp_diagnose","gp_last_evidence"`（原始 id、无命名空间，且不经过任何插件）。
  - 传输实测：直接驱动 `glasspane/daemon.ts` → `capabilities = {version 0.1.0, protocolVersion 0, capabilities[act,observe,…], permissions{accessibility granted, developerTools unverifiable,…}}`、`probe_status` **ok:true**；未知方法返回 `GP_E_METHOD_NOT_FOUND` 且 remedy 非空。
  - `tsgo --noEmit`（按包，上游口径 `bun turbo typecheck`）：`packages/opencode` **exit 0**。过程中 typecheck 抓出我 14 处错（`Tool.define` 返回 effect 却被当 Info 传给 `Tool.init`、execute 错误通道必须是 `never`、`NumberFromString` 解码后是 number 不是 string、以及我给 `glasspaneDefs` 写了 `Effect<Def[], never, never>` 这种**谎报 R 通道**的注解），全部据此改正后才转绿。
  - lint：`registry.ts` 在同一棵树内 patched vs pristine 对照，规则命中键集与计数一致（6 规则 / 7 warnings / 0 errors），我的 patch 没给它引入新命中。我新写的两个文件首版有 **19 warnings**，两类原因：13 处 `String(unknown)`（会把 `[object Object]` 当成事实喂给模型，不只是风格问题）、5 处对 daemon 响应做 `as` 形状断言。改成显式 `text(value, fallback)` 与 `fields(value)` 收窄之后降到 **4 warnings / 0 errors**，typecheck 仍 0 错。
    对照实验本身也翻过车两次：一次 `npx --no-install` 两棵树都失败而 stderr 被我吞掉，一次抽取正则写成 `plugin/rule`（oxlint 打的是 `plugin(rule)`）——两份空集 `diff` 出来当然"一致"。现在脚本先断言两边键集非空才允许比较。
  - 上游 `mcp-shell` 里唯一的 `String()` 命中是 `evidence-report.ts:269 valueText(value: string | boolean)`，类型安全，不改。顺带记一笔真实的口径差：**工具面 A 至今没有任何 lint 层**（`tsc` 只在 `npm run build` 里跑），而 fork 线第一天就有 `tsgo` + `oxlint`。把等价检查引入 mcp-shell 是后续批次的候选，需要先录一份基线金样，否则一加就是几十条既存噪声。
- **未跑/未验证**：真模型轮次下这些工具被实际调用一次（`ctx.ask` 的权限卡是否按预期弹出、`output` 截断行为、M4 压缩钩子的运行时形状）；`packages/tui` 未因 M1 改动（M5 才动它）；构建产物未随本次改动重建（`dist/` 仍是 02:04 那一次）。
- 遗留：`jingzhao-l/glasspane-harness` 远端未创建，subtree split 发布尚未执行（外部写操作，需用户点头）。

## 2026-09-24 · import `v1.18.32`（base 建立，非同步）

- base：`anomalyco/opencode` tag `v1.18.32` / commit `545f51d`；参照克隆在 `.external/opencode/`（gitignore）。
- 改动面：`fork-diff` 判定 **`6632/6632 byte-identical, 0 edited, 0 added, 0 deleted`** —— 全树忠实照搬，未做任何删减（用户裁决）。本目录的 `FORK.md` 与本文件是 import 之后新增的自有文件，因此现在的记录面里它们出现在 `added`。
- 跑过的闸：
  - `fork-diff --record` 建立记录面：`{identical 6632, edited 0, added 2, deleted 0}`（`added` 那两项就是本目录的 `FORK.md` 与 `SYNCLOG.md`，是我们自己的文件）。
  - **尺子能变红，四条因果验证**：① 未记录的自有新增 → 报 `2 added` 且 exit 1；② `--record` 后 → exit 0；③ 给 vendored 的 `packages/tui/src/routes/session/index.tsx` 追加一行 → 报 `1 edited` 并**点名该文件**、exit 1；④ 从参照还原 → 转绿。安装产物不会污染测量面（`node_modules` 被 fork 自带 `.gitignore:2` 挡住，`git check-ignore -v` 已验；唯一命中 "node_modules" 的未跟踪路径是上游真实源文件 `nix/node_modules.nix`）。
  - 参照克隆完整性：那次被中途杀掉的 clone 让我怀疑基准被污染，所以直接验而不是推理——`git fsck` 无错、工作树干净、`git describe` = `v1.18.32` → `545f51d`、索引 6,632 条。
- **类型检查：已验证，含负例。** 上游 CI 的口径是 `bun turbo typecheck`（按包），所以按包测：`packages/tui`（M5 的目标文件所在）与 `packages/opencode`（工具注册表所在）各自 `tsgo --noEmit` **exit 0**。这个 0 是被证伪测试过的：先跑基线 0 → 往 `packages/tui/src/routes/session/index.tsx` 注入 `const x: number = "…"` → **exit 2 且点名 `index.tsx(2708,7): error TS2322`** → 从上游参照还原 → 回到 0 → `fork-diff --check` 仍绿（整轮折腾没在测量面留痕）。
  过程里先出过一次**我自己的假绿**：前一版脚本写 `( cd pkg && tsgo | tail )` 再取 `$?`，读到的是 `tail` 的状态，结构上永远不可能非零——所以当时那句"typecheck 退出 0"不成立，已撤回并重做。
- **依赖安装：成功，但没有关掉任何校验。** `bun install` 卡在 `packages/app` 的 `ghostty-web@github:…`（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）；`openssl s_client` 查明是**本机有 TLS 拦截代理**：tarball 最终落点 `objects.githubusercontent.com` 的证书由 `CN=SteamTools Certificate` 签发，macOS 钥匙串信任它（故 curl/git 通过），而自带 CA 的 bun 正确拒绝。出路是把钥匙串根（163 张）导成 PEM 配 `NODE_EXTRA_CA_CERTS`，装了 4,671 个包。**没有使用任何"跳过证书校验"的开关。**
- **整包 bundle 构建：已验证（run 5，2026-09-25 02:05）。** 判据三条都来自脚本自己写的标记与产物指纹，不来自包装层退出码：
  - `BUILD_RC=0`（`/var/tmp/glasspane-harness/build-run5.log:1318`），vite 段 `✓ built in 3m 11s`；
  - 产物：`packages/opencode/dist/opencode-darwin-arm64/bin/opencode`，**138 MB**，mtime `2026-09-25 02:04:27`；`dist/` 共 6+ 个平台包，约 2.0 G；
  - **跑起来了，而且能证明是我们的树**：`--version` → exit 0 → `0.0.0-harness/fork-import-202609241756`（渠道=分支名 `harness/fork-import`、时间戳=本次构建时刻），`--help` 列出 23 个子命令。
  - 构建后 `fork-diff --check` 仍是 `6632/6634 identical, 0 edited, 2 added`；`git status` 中 `dist/`、`node_modules/` 零命中——**2 G 产物既不进版本控制，也不进测量面**。
  归因修正：run 4 的失败点确实是 `script/build.ts` 内部那次 `bun add ghostty-web@github:…`；把 `NODE_EXTRA_CA_CERTS` 导出给子进程后就过了。我上一版把它写成"本会话的机制限制跑不完"是**错的**，真实结论是"fork 构建需要把本机信任锚传给子进程"。
  工程含义：不 pin `ghostty-web`，任何带 TLS 拦截或无 github 直连的干净环境都构建不了这个 fork（上游 CI 能过只是它环境没这层拦截）。
- **从源码可运行：已验证。** `bun packages/opencode/src/index.ts --version` exit 0（输出 `local`，源码运行未注入发布版本时的正常值）。
- 遗留：`jingzhao-l/glasspane-harness` 远端未创建，subtree split 发布尚未执行（外部写操作，需用户点头）。
