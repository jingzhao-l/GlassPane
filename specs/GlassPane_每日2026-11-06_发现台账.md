# 每日审查 2026-11-06/11-07（承接 11-05 第二条会话）· 发现台账（发现 11 / 修复 11 / 未修 0）

> 真源提示词：`tools/prompts/daily-glasspane-main.md`。范围＝主仓产品面；`harness/` 不审查不修改
> （10:30 那条线），例外只有 `tool-surface.mjs --record` 这一次基线补记（见第 4 节决定 3）。

## 0. 开工时读到的状态（判据是文件字节）

- 本会话是 11-02 07:30 那条线的续跑，中途被多次挂起；每次醒来都重新锁基线，读数如下。
- 11-03 那条会话把本会话 11-02/11-03 留下的未提交批次（`set-version 1.28.1` 那 14 个文件 +
  三笔未推提交）落成 `31f690c5` 并入 **1.29.0**；11-05 那条会话把本会话 11-04 那批 25 个文件的
  候选 A/C/D/H/I/J/L 收进 **1.30.0**，并复核出那批自己的两处"改过头/没做到"（见它的台账第 1 节）。
  所以**上一轮的遗留不是本轮的输入，本轮也没留新的遗留**：本轮起点 = `origin/main` 已发到 1.30.0。
- 开工 HEAD（本轮最后一次醒来）`5f7fb02d`；版本线 1.30.0；registry 两包实测 `1.30.0`；
  `git status --porcelain` 在我动手前是 0 行；`df -k /Volumes/Eng-Dev` 可用 16.2 GB（> 4 GiB 门槛）。
- 在飞现场（不碰、不代提交）：`.worktrees/harness-close-20261105`（分支 `gp-harness-close-20261105`）、
  `.worktrees/harness-daily-20261104`、`.worktrees/harness-daily-20261105`，以及三条历史 stash。
  归属判据：分支名前缀 `gp-harness-*` + 提交前缀 `[gp]` 都是 10:30 那条线的形制，本轮一行没动。
- 本轮把 7 笔提交 rebase 到 `origin/main` 时，git 自动跳过其中 3 笔——它们的补丁已以另一枚 SHA
  （`ce3b16a2`/`ff617f9f`/`f9d458ab`）在远端 main 上；判据是 `git rebase` 的 skip 与
  `git log origin/main..main` 只剩 4 笔，不是提交信息。

## 1. 本轮发现 → 修复 → 具名测试（11 条；#1-#5 随 1.31.0 发出，#6-#11 随 1.31.1 发出）

| # | 发现（触发输入 → 错误行为） | 修在哪 | 具名测试 | 反向破坏 |
|---|---|---|---|---|
| 1 | `--check-developer-tools` 的 payload 只有一个 `granted` 布尔，而它**两件不同的事**都回 false（系统明确拒绝 `.denied` / 这一趟压根没量到 `.timeout`+`.spawnFailed`）；`main.swift:1222` 的 `granted ? 0 : 1` 把两件事折成同一个号，note 还写着"granted=false 的唯一人工步骤是系统设置勾选"——给一次没发生的测量指派一个人工步骤 | `DebugCapabilityProbe.swift` 新增 `Snapshot.verdict`（`granted\|denied\|unverifiable`，词表沿用面板那一卡与 `DaemonPermissionVocabularyTests` 已在用的三个词，不另造第四个）、`nextStep` 随档位走、`verdictStates` 两臂各自点名；`main.swift` 退出码 0/1/**5**，`--help` 的 EXIT CODES 补 5 | `DailyRound20261105DeveloperToolsVerdictTests`（5 条：三档各答各的、unverifiable 不是 denial、下一步指 `xcrun --find lldb`/`xcode-select --install` 而不是勾选、两臂状态点名、码分三档且 5 有文档） | 把第三档折回 `.denied` ⇒ `testTheThreeArmsAnswerWithThreeWords`、`testAnUnrunProbeIsNotADenial`、`testTheUnmeasuredStepNamesTheToolchain` **三条具名红**；`/bin/cp` 恢复后 `diff -q` 无输出、sha256 `cb00a255…` 两侧相等 |
| 2 | "出路不许把 daemon 写成裸名"这条纪律读的是一份**手抄的四个文件名**（`daily-20261103-shell-side-parity.test.mjs:92`），同目录的 `http-gateway.ts` 从未被扫过，`installer/`/`updater/`/`engine/Sources/` 三面根本不在视野里 ⇒ 实测余 5 处 `glasspaned --…` 在装机引导文案里；`command -v glasspaned` 本机无输出、无包声明该 `bin`，照抄即 127 | 扫描集改为目录遍历 + 用法提纲的**结构化豁免且行数可打印可失败**；`installer/cli.js` 那 5 处改为"命名程序而不是给一条跑不动的命令"；老闸的名单换成 `readdirSync` | `daily-20261105-bare-daemon-command-scan.test.mjs`（3 条：真树 0 处、同一句话搬进代码段即被抓、老闸不许退回手抄名单），非空转下限＝文件数 ≥40 且豁免行数 ≥10 | 我自己的第一版把引号列进"前置排除字符"，结果**夹具里那一行没被抓**——正是这类空转的形状；去掉引号排除后第二条转红再修绿。真树 15 处命中里 10 处在 `printUsage()` 的提纲内（结构化豁免，不是点名文件） |
| 3 | `tools/release-signing-gate.sh:171` 的 `gpg --list-keys \| awk '…exit'` 站在本脚本自己的 `set -euo pipefail` 上：awk 读到第一枚指纹就退 ⇒ gpg 被 SIGPIPE 打死退 141，整段**在它该打印 `::error::` 之前**终止。`check-workflows.mjs` 的 2e 为这件事建过闸，但它只扫 workflow 内联 run 体，`bash tools/…` 委托出去的文件在它视野外 | 先落盘再 `awk … < 文件`（没有写者就没有可被打断的管道）；判据铺到委托脚本 | `daily-20261105-ci-shape.test.mjs` 第 2 条（扫 `tools/*.sh` + `install.sh` 的 `awk …exit` / `grep -q` / `head -n` 三种形状，只在该文件自己声明 pipefail 时算）+ 第 3 条"把旧形状放回去必须被抓" | 第 3 条本身就是这条闸的变异对照：`assert.notEqual(probe, original)` 先证明变异落地，再断言被抓 |
| 4 | 同一条 swift job 里两处 `swift test … \| tee /tmp/gp-*.log` 各写目标，下一步 `assert-test-count.mjs swift 1 <文件…>` 的 argv 是**另抄的一份**；计数闸只对交给它的文件负责 ⇒ 新增一格 `tee` 或摘掉一枚，那格用例永远不进计数闸而 CI 照绿 | 新闸读 ci.yml 自己核对两侧集合相等 | `daily-20261105-ci-shape.test.mjs` 第 1 条（下限：tee ≥2、argv ≥2，缺一即判空转） | 把 argv 里任一枚文件名改掉即红（集合不等）；把整步删掉则 argv 条数 ≠1 先红 |
| 5 | `.github/workflows/ci.yml:632-641` 留着三处**没有主语也没有对象**的残句（"本文件 32 行那两条都是 ）"、"从前这里钉死 ，"、"而 / 要的就是 ci.yml 在被 tag 那笔 sha 上 success"）+ 一处被吞掉反引号的 `../../../product.json`。字节由 `6126650b` 那次写入留下；下一轮读它的人是发布操作者，而他据以判断的恰好是被吃掉的那两个名词 | 按可核事实改写（第 32 行那条 `runs-on:`、GitHub 已排定 2026-11-02 退役的 macOS 14 镜像、`scripts/assert-tag-ready.mjs` 才是那句"要 success"的主语、补回反引号） | 本轮不为它新增谓词（见第 2 节 a）；改写由 `check-workflows.mjs`（结构）+ `check-doc-links.mjs`（表格/残渣）复跑证明没有把工作流改坏 | 复跑而非变异：这两条闸对本文件的改动若失真，rc 非 0；实测 rc=0 |
| 6 | 交给读者（和判据）的那句 **git 原话由操作系统的语言决定**。本机中文 locale 实测：`install.sh` 对不存在的分支回 `致命错误：远程分支 nope-nope 在上游 origin 未找到`、`advanceExistingClone` 回 `致命错误：无法找到远程引用 nosuchbranch`，而 `clone_failure_text` 那一句是**把 stderr 原话转述给读者**的；契约与本仓自己在 `verifyEnv` 里写下的理由（判据读英文措辞 ⇒ 必须钉 locale）都假定一份字节。CI 的 runner 是英文 locale，所以这两格在 CI 永远绿、只在非英文机器上红——本机第一次跑就撞上了（我没有把它当"环境问题"记过去：`LC_ALL=C` 那一半产品本来就该钉，且第二枚根因是桩吃掉了环境，见右列） | 一枚环境四处共用 `gitLocalePinnedEnv()`（`verifyEnv` 也从它取，不留两种拼写）+ `install.sh` 两趟 clone 前缀 `LC_ALL=C LANG=C`；两枚夹具跟改：`spawnGit` 从前**丢掉第三个实参**（被测传的 env 到不了 git ⇒ 只在本机恰好英文时才绿），`install-sh.test.mjs` 的参照 clone 继承环境而产品一侧已钉 ⇒ 两边不同契约的比较测不到东西 | `installer/test/daily-20261107-git-locale-pinned.test.mjs` 3 条，其中第一条是**反空转对照**：先用同一枚中文 locale 跑裸 `git` 证明这台机器的 git 真会说中文——不说中文则后两条什么都没测，那条对照直接红并写明该换机器还是改契约 | 摘掉 install.sh 两趟与 cli.js 两处的钉 ⇒ **4 条具名红**（`advanceExistingClone: 远端没有那个引用时交出 git 的原话，且一次都不切`、`install.sh: clone 失败交出 git 的原话，那句归因与 cli.js 的 cloneFailureText 逐字同` + 新文件第 2、3 条）；恢复用 `/bin/cp` 备份 + `diff -q`（第一次恢复拿的是**修补前**的备份，install.sh 的钉因此丢了——重新落上并逐字节复核，教训记在第 3 节决定 6）⇒ 45/45 复绿 |
| 7 | 发布提交漏 add 一枚位点，而**没有任何一道闸在 tag 之前读 commit 自己的字节**：`set-version 1.31.1` 改 15 份、`release:` 只 add 14 份 ⇒ 被推上去的 commit 里 `RELEASE_VERSION` 仍是 `1.31.0`，本机 `check-version` 照绿（它量工作树），CI 读 commit 因此三条 job 红（version line、root workspace gate 的两入口逐字节对照、macOS node suites）。这不是 CI 的错：tag 一旦签下去，"发布物==主干==位点表"里没人知道少改了一枚 | `5796ca31` 补被漏的那一枚位点；`609d9bfa` 给 `assert-tag-ready.mjs` 加 `committedSiteDrift(version, textOf)`（逐枚位点取 `git show HEAD:<file>`；缺失/命中数≠1/值≠本版都算漂移，`line:true` 按 `expectedFor` 折算段，lock 的每个非 link 条目各自比）与 `judgeTagReady` 的 `siteDrift` 输入，非空即拒签 | `updater/test/daily-20261107-tag-commit-sites.test.mjs` 前 3 条（真 HEAD 自证、段位点按段比、四种漂移各自点名且干净字节不报） | 把 `committedSiteDrift` 短路成 `return []` ⇒ "四种漂移各自点名"具名红（3 pass / 1 fail），恢复 `diff -q` 无输出 |
| 8 | **#7 那道闸自己"修在跑不到的路径上"**：接线测试缺失——把 `facts` 里的 `siteDrift` 整个摘掉，`main()` 不再调用它，而当时 7 条用例全绿 | 加一条按行为倒的接线对照：临时仓库里 tip 与 CI 两档都成立、只有位点档不成立（HEAD 里没有位点表），`main()` 必须以"位点不自洽"拒绝 | 同上第 4 条「接线：main() 真的把 commit 的位点读进判定——其它两档都放行时它仍拒绝」 | 实测：再次摘掉接线 ⇒ 这条具名红（4 pass / 1 fail）；恢复 5/5 复绿。这条就是它自己存在的理由 |
| 9 | #6 的钉只覆盖了两趟 git spawn，`installer/cli.js` 里另有 **5 趟**（`rev-parse --show-toplevel`、两处 `rev-parse --verify`、`status --porcelain`、tag 探测）仍不钉 locale——半修：A 面钉了，B 面把 stderr 交给操作系统语言 | 5 趟全部走同一枚 `gitLocalePinnedEnv()`（`verifyEnv` 也从它取，一份事实一个出处） | `installer/test/daily-20261107-git-locale-pinned.test.mjs`「结构：cli.js 里每一趟 git spawn 都带着钉过的环境」——清单由源码扫出来（不点名行号），下限 ≥8 趟，`verifyEnv(…)` 作为委托拼写算合法 | 这条对照**自己就是被抓出来的过程**：结构腿第一版直接报 `这趟 git 没收到 LC_ALL=C：{"args":["-C","/tmp/whatever","rev-parse","--show-toplevel"]}`，据此补齐 5 处；把任一处退回不钉 ⇒ 该条点名红 |
| 10 | 我第一版 #6 的测试在 CI 上不可判：①行为腿要求"本机 git 会说中文"，英文 runner 上那条反空转对照按设计红（CI not ok 219）；②`install.sh` 的 clone 支在非 macOS 上根本走不到（平台闸排在动树之前）⇒ CI not ok 221 | 拆成两腿：结构腿（任何机器都跑，扫源码 + 记录型假 spawn 接住 options）永远可判；行为腿在造不出另一语言/非 darwin 时**具名 skip 并写明缺什么与补它的那条命令**（先例：#29 的"按平台问哪一支该跑"） | 同文件 5 条（2 结构 + 2 行为 + 1 计数下限）；结构腿的安装器侧「每一趟真 clone 都带钉，且 clone 执行点总数就是那个数」把 `pinned == executing` 钉死 | 本机 54/54（0 skipped，中文可用）；CI 那一侧的判据是结构腿必须自己活着——把任一 clone 前的 `LC_ALL=C LANG=C ` 去掉 ⇒ `pinned.length != executing.length` 红 |
| 11 | 那把"什么都没测就不许算通过"的反空转对照，自己成了它要抓的那个形状：`testConcurrentStoreAndReadNeverTearsTheCore` 末尾两条守卫（`observed` 与 `readIds` 不许为空）在 load 20+ 的机器上红——120 次 act 的在途窗口只有几微秒，读者线程抢不到，`readIds` 就空。产品没撕引用，是这条计时断言**只在负载下才红**（本仓记过账的坏对照形状） | 改窗口，不改判据也不加超时：`ScriptedChannel.onPerformAction` 在 act 在途期间持住 2ms——用的正是 `testStoredCoreIsTheOneTheWaiterReads` 本来就在读的同一枚接缝；三条不变量（读到的是被写进去过的那一个核心／号是真跑过的号／形状完整）一字未动 | `DailyRound20261030Swift1ShutdownWaiterRaceTests` 6 条，`vm.loadavg` 22.57 下连跑两次各 6 tests / 0 failures（本轮开工时同一条在负载下是红的） | 把 `DaemonCoreHolder.inFlightOperationId()` 短路成恒 nil ⇒ **2 条具名红**（`testStoredCoreIsTheOneTheWaiterReads` :119 与这条并发用例 :198 那一格）；`/bin/cp` 恢复后 `diff -q` 无输出 |

## 2. 判为不成立 / 决定不做的（各附证据）

- **(a) 不给"注释残句"造一个新谓词。** 残渣闸的判据②是"首词是命令词"那张表，把 markdown 的
  残渣形状放宽成"任何像被删过的句子"会误红人话——这道闸的第一版就是这么误红了
  `harness/glasspane-harness/SYNCLOG.md:684` 那句带引号的中文句子（11-01 台账记的）。本轮只补
  可核事实，不为四行注释加一条按形状猜的闸。
- **(b) 面板六页 AX 走查：本轮改为"只走这一张卡"，并且走完了**（先前这里写的是"本轮不重跑"，
  后来在发布物上做了，结论以实测为准）。字节层面的理由仍然成立——本轮改的那条命令在面板里唯一的
  读者是 `engine/Sources/glasspane-settings/SettingsModel.swift:799` → `DeveloperToolsCapability.parse`
  （`engine/Sources/GlassPaneEngine/PermissionStatus.swift:596-606`），
  它要求的四个键（`capability` / `launch.state` / `attach.state` / `granted`）一个没动，本版只
  **新增**字段；卡片判据 `status` 吃的三档词表（`PermissionStatus.swift:18-21` 的
  `granted` / `denied` / `unverifiable`）本来就是三档，#1 只是把 CLI 那一面补齐到同一个词表。
  但"字节没动"只证明"不会坏"，不证明"新档位真到了 GUI"。所以补的是窄走查：被测对象是**发布
  归档 `GlassPane-1.31.0.tar.gz` 解开后自己构建的** `glasspane-settings` 与 `glasspaned`（不是工作树），
  读数在第 5 节 c 段。全六页走查（88 枚控件、4 枚读不到 `AXEnabled`）是 11-05 那一轮的账，本轮没重做，
  因为本轮没有任何一处改动落在其余五页的读路径上。
- **(c) `harness/` 一行没动**（除 3 节决定 3 的那一次基线补记 `dc4c5f45`）。判据是字节不是前缀：
  本轮这一半的 9 笔（`24949936`、`266a2f75`、`5796ca31`、`609d9bfa`、`b609f0a9`、`f6f1cf88`、
  `1af85031`、`2555aebc`、`75bb8c48`）逐笔 `git show --stat` 读过，路径集合里没有一条以 `harness/` 开头。
  10:30 那条线同期在推 `[gp]` 前缀的提交（`e82b6e4b`、`3a5d7cc8`、`4615aafc` 等），本轮碰它就是撞车。
- **(d) 不替那条线提交它工作树里的旧稿；但它的后果本轮量出来了，收件人也点名了。**
  清理盘点时发现 `.worktrees/harness-daily-20261105` 有一处**落在父仓**的未提交改动：
  `scripts/check-doc-links.mjs`。它与 main 的同名文件 `diff --no-index` 只差一行——
  `export const DEFERRED_FINDINGS = []` 少了 `export`（其余字节逐字相同）。那一行不是装饰：
  `updater/test/daily-20261105-deferred-findings.test.mjs:36` 正是 `import { check, DOCS, DEFERRED_FINDINGS }`，
  第 120 行还 `assert.deepEqual(DEFERRED_FINDINGS, [])`。两腿实测（变异落在 main 上、用自带备份核回）：
  - 腿 A（main 字节）：`node --test updater/test/daily-20261105-deferred-findings.test.mjs` ⇒ rc=0，5 tests / 5 pass / 0 fail。
  - 腿 B（把那一处 `export ` 摘掉，`grep -n` 证明落地，`diff -q` 证明与那条线的缓冲区**逐字节相同**）：
    同一条命令 ⇒ rc=1，`SyntaxError: The requested module … does not provide an export named 'DEFERRED_FINDINGS'`，
    读数 `tests 1 / pass 0 / fail 1`——那 5 条具名用例一条都没跑起来。
  - 对照（证明这不是"变异把文件改坏了"那种假红）：同一份字节 `node --check` ⇒ rc=0（它是合法 JS），
    `node scripts/check-doc-links.mjs` ⇒ rc=0（**拥有这个文件的那道闸自己看不见这个缺陷**）。
    红的是跨 workspace 的导出契约，不是语法。
  - 恢复：`node …/mutate.mjs restore` 后 `diff -q` 无输出、sha256 回到
    `418a1c7969749f943e26ad4c09f24d187dbe0309419586fb5c7001be1a0c7103`（与变异前备份逐字相等），
    腿 A 复跑 5/5，`git status --porcelain` 只剩本台账一条。
  **结论与判据**：main 侧不成立——正确字节（`export` + 同批测试）已由那条线自己的 `1ef2338f` 落在 main，
  本轮没有产品字节可改；成立的是他们工作树里那份**被 main 取代的旧稿**，若原样提交就会让上面那枚具名
  测试文件整体加载失败。该由 10:30 那条线自己收（判据就是腿 B 那条命令），本轮按清理规则第 3 步的
  例外保持原状、不替别人提交。**收件人存在且会跑**：`npm test --workspaces --if-present` 覆盖 updater，
  CI 的 `root workspace gate (installer + all workspaces)` 这一 job 在 `75bb8c48` 上实测 success，
  所以这不是"交接给一个不存在的闸"。与本轮改动的重叠判断：本轮 9 笔一条也没动这个文件，无重叠。

## 3. 本轮我替你做了哪些决定（依据 / 回滚）

1. **取号 1.31.0（minor）**。依据：1.6.2 那条判据里被触碰的是"退出码语义"（新增一档 5）与
   "载荷字段"（`verdict`/`verdictStates`/`next`）。老读码方不受影响（非零仍读作"这一席没成"），
   但不按 patch 报，免得低估一次契约变化。
   回滚：`git revert 272332fb` + `node scripts/set-version.mjs 1.30.0`；已发布 tag 一律不动。
2. **新档用 `unverifiable` 而不是我起初写的 `unmeasured`**。依据：面板那一卡
   （`DeveloperToolsCapability.status`）与 `DaemonPermissionVocabularyTests` 钉的三个词已经是
   `granted|denied|unverifiable`，同一件事不该有第四种拼写——这正是 11-03 #18 记过的形状。
   回滚：把 `SeatVerdict.unverifiable` 改名会同时红 `DailyRound20261105DeveloperToolsVerdictTests`
   的三条。
3. **`tool-surface --record` 补记基线，单独一笔 `chore(harness)`**。依据：红是**我自己**的有意
   增长造成的（引擎分母 33515 → 33575，`--check` 在提交前就红，`--record` 在源码未提交时拒绝执行
   ——两句都是闸在起作用）；壳的 LOC 与文件数一字未动。回滚：`git revert dc4c5f45`（rebase 前 SHA），
   恢复后 `--check` 会重新红在那一行。
4. **不动在飞的 harness 工作树与 stash**。依据：清理规则里"不是本轮的保险就不该由本轮撤销"，
   且那三条 stash 早于本轮多个会话。
5. **退出码 5 不复用 2 或 3**。依据：2 已定义为"取值旗标给了这条命令用不了的值"，3 本周刚被
   `--active-project`/`--project-remove`/`--prune-evidence` 统一成"未注册 id"；复用会把刚收拢的
   一档又搅浑。

6. **恢复现场必须拿"修补后"的备份**。本轮做反向破坏时 `/bin/cp` 的恢复源是修补**前**的快照，
   install.sh 的 locale 钉因此被抹掉；靠"恢复后再跑一次具名用例"（45/45 之前先出现 2/3 红）才发现，
   重新落上后 `grep -c` 与 `sh -n` 各量一次。依据：`diff -q` 只证明"与备份一致"，不证明"与修好的那份一致"。
   回滚：不涉及产品。
7. **没替 10:30 那条线重记 `tool-surface` 金样，也没为绕开它动 `assert-tag-ready` 的判据**。
   依据：`harness rulers` 在 `3a5d7cc8` 上红的那一条是 `surface B (fork, ours) grew: 14021 recorded
   → 14032 LOC (+11)`，挪的是 `harness/glasspane-harness/script/kernel-conformance.mjs`——他们
   `e82b6e4b` 自己的有意增长；提示词允许的 `--record` 只覆盖"本次 `mcp-shell/src` 或 `engine` 的
   有意增长"，替别人记就是本仓点名禁止的"洗掉非本轮造成的红"。放宽 tag 闸同理：那道闸钉的就是
   "发布物==主干==CI 在那枚 sha 上真绿"。落地：等它自己记（`4615aafc` 确实是那条线自己补的），
   本轮其余 14 条门禁全在 `75bb8c48` 复跑过。回滚：不涉及产品字节。
8. **真机项做窄的一圈，不做全六页**。依据：本轮唯一进 GUI 的事实是 #1 新增的三个键，读者只有
   `DeveloperToolsCapability.parse` 一处（见第 2 节 b 的重新实测引用）；全六页 88 枚控件那一圈是
   11-05 的账，本轮没有改动落在其余五页读路径上。代价写清楚：其余五页本版**未观测**，
   补法＝`engine/smoke.md` 里那条 `gp-ax-walk` 换成不带 `grep` 的整树走查（同一枚辅助器，
   11-05 用过），发布物解出后 `swift build --package-path engine` 起 `glasspane-settings --state-dir <临时根>`。
   回滚：不涉及产品字节。

## 4. 未观测（只限物理边界）


- **`unverifiable` 那一档的真实现场本机造不出**：探测走绝对路径 `/usr/bin/xcrun`，这台机器 CLT
  在位且会答。补它的动作：在一台没有 Command Line Tools 的 mac 上跑
  `glasspaned --state-dir <临时根> --check-developer-tools`，预期 `verdict: unverifiable` 且退 5。
  这一档由注入层 `DebugCapabilityProbe.Running` 量到（那 5 条用例），不是"没测"。
- **Apple 公证**：需要付费开发者账号，owner 未启用；文档没有写成已完成（既有事实，本轮未触碰）。
- **`npm stage list` 本机枚举不了**：实测 `npm stage list` ⇒ `npm error code E401 … your authentication
  token seems to be invalid`（本机 npm 未登录；发布走 CI 的 OIDC trusted publisher，不需要本机凭据）。
  注意那条命令的管道退出码是 `head` 的 0，**不是判决**，判决取 npm 自己打的 E401。
  本轮能证的一半已证：11-07 那次 `mode=publish`（run `42352260708`）两包各答
  `published and confirmed on the registry`，走的是直发分支而不是 `npm stage publish` 分支
  （后者会打 `::error::… 是 staged 而不是 published` 并 exit 1），且 registry 两包都读 1.31.0。
  补上剩下那一半的确切动作：owner 跑 `npm login` 后 `npm stage list`；若有待批项，
  `npm stage approve <stage-id>` 需要 owner 的 2FA——这是本轮两件物理上做不到的人工动作之一。

## 5. 收口

### a. 门禁逐字命令复跑（本机，跑在 `2555aebc` 的树工作状态下）

跑完之后主干又前进两笔（`e82b6e4b`、`3a5d7cc8`、`4615aafc` 三笔 `[gp]`，全在 `harness/` 内）与我这一笔
台账（`75bb8c48`，只动 `CHANGELOG.md` 与本文件）。判据不是提交信息而是字节：
`git diff --stat 2555aebc..75bb8c48 -- engine mcp-shell updater installer scripts bridge install.sh`
输出为空——被测面一字未动，所以上表不需要为重跑而重跑；`check-doc-links` 与
`node harness/tools/tool-surface.mjs --check` 在 `75bb8c48` 上另跑过，各 rc=0（表格数从 479 张
变 480 张就是这一笔台账加的那张）。本笔（第 2 节 (d)、第 5 节 e、第 6 节）写完后再跑一次
`node scripts/check-doc-links.mjs` ⇒ rc=0，表格 **482** 张（多的两张就是 e 段与第 6 节那两张），
`node scripts/check-version.mjs` ⇒ rc=0，20 个位点全为 1.31.1。

| 命令（逐字） | rc | 实际计数 |
|---|---|---|
| `npm ci` | 0 | `added … packages`，两条 `install-scripts` 提示（esbuild/sharp 的 postinstall 未自动跑，`npm run bundle` 随后实测能跑＝二进制在位，本轮没有把它读成缺陷） |
| `npm run build` | 0 | 根 + `glasspane-mcp`（tsc）+ 其余 workspace 全过 |
| `npm test --workspaces --if-present` | 0 | 壳 762 tests / 762 pass / 0 fail；安装器 353 tests / 350 pass / 3 skipped / 0 fail；更新器 818 tests / 818 pass / 0 fail——合计 1933，红 0 |
| `node scripts/check-version.mjs` | 0 | `OK：版本线一致（1.31.1）` |
| `node scripts/check-doc-links.mjs` | 0 | 文档 32 份／仓库内链接 274 条／外链 44 条／markdown 表 479 张（扫 129 份，按 `MD_SKIP_ROOTS` 另跳 69 份） |
| `node scripts/check-workflows.mjs --self-test` | 0 | 48 条各自验证为会失败：28 个必须被抓的变异 + 20 个必须保持沉默的合法形状 |
| `node scripts/check-workflows.mjs` | 0 | 5 份工作流文件干净 |
| `swift build --package-path engine` | 0 | `Build complete! (1.47s)`（增量） |
| `swift test --package-path engine` | 0 | XCTest 1612 executed / 1607 passed / 5 skipped / 0 failures；Swift Testing 76 tests in 8 suites passed——合计 1688，红 0 |
| `swift test --package-path engine/probe` | 0 | XCTest 58 executed / 1 skipped / 0 failures；Swift Testing 0 tests（该包按设计没有 swift-testing 用例，这句是读数不是推断） |
| `python3 -m pytest -q bridge` | 0 | 223 passed, 1 skipped in 17.31s |
| `sh -n install.sh` | 0 | 无输出 |
| `cd engine && python3 .signal_smoke.py .build/debug/glasspaned` | 0 | `SIGNAL SMOKE OK：SIGTERM / SIGINT 均自行退出（码 0）且 socket 文件被 unlink`（三次起停各自跑在点名的隔离状态根里） |
| `cd mcp-shell && npm run bundle && npm pack --dry-run` | 0 | 包 `glasspane-mcp-1.31.1.tgz`，31 个文件，369.1 kB，shasum `badd00e8a9b86912b376405644e3fc39a5f93894` |

`swift test` 那 5 枚 skipped 是按设计的 opt-in 真机项（`--filter` 点名可跑），本轮没为了让它绿而删断言；
负载那一格（#11）在 `vm.loadavg` 22.57 下另跑过一次对照，见第 1 节第 11 行。

### b. 反向验证（本轮新做的，全部具名变红后字节核回）

- #11：`DaemonCoreHolder.inFlightOperationId()` 短路成恒 nil ⇒ 2 条具名红；恢复 `diff -q` 无输出。
- #7/#8：`committedSiteDrift` 短路成 `return []` ⇒ "四种漂移各自点名"红（3 pass / 1 fail）；
  再把 `facts` 里的接线摘掉 ⇒ 第 4 条「main() 真的把 commit 的位点读进判定」红（4 pass / 1 fail）。
- #10：把 `install.sh` 任一 clone 前的 `LC_ALL=C LANG=C ` 摘掉 ⇒ 结构腿按
  `pinned.length != executing.length` 点名红（这一条在英文 runner 上同样能红，正是拆两腿的理由）。
- 教训一条（先前在这里写过"恢复用 `diff -q` 证明字节一致"就完了）：`diff -q` 只证明"与备份一致"，
  不证明"与修好的那份一致"——本轮第一次恢复拿的是修补**前**的快照，install.sh 的钉因此丢了。

### c. 真机读数（全部跑在**发布归档**解出的字节上，不是工作树）

被测对象：`GlassPane-1.31.0.tar.gz`（4 件资产里的那件，本地 sha256 `0cd2bd26…47a5a1` 与
GitHub `assets[].digest` 逐字相等）解到 `/var/tmp/…/e2e/tree/GlassPane-1.31.0`，再
`swift build --package-path engine -c debug`（`Build complete! (249.51s)`）。

- `glasspaned --state-dir <隔离根> --permissions` ⇒ 退 0，
  `verdict: granted`，`permissions` 三席 granted 且 `developer-tools: unverifiable`，
  `verdictExcludes` 明写那一席由 `--check-developer-tools` 回答、`judgedByThisCommand: false`；
  stderr 那句 note 明写这一趟没读状态、`--state-dir` 那个根没被 consulted。
- `glasspaned --state-dir <隔离根> --check-developer-tools` ⇒ 退 **1**（不是 5），
  `verdict: denied`、`launch.state`/`attach.state` 双 `denied`，`next` 指向系统设置里那一席并
  按真路径 quote 了这枚二进制。这一条把 #1 的三档判决在真 hardware 上答成了 **denied** 那一档；
  `unverifiable` 那一档本机造不出场（见第 4 节），仍然只由注入层的用例量到。
- 面板窄走查（`gp-ax-walk`，按 `gp-*` 标识）：同一隔离根起 daemon 后
  `glasspane-settings --state-dir <同一根>` 读到 31 枚 `gp-*` 标识，其中
  `gp-perm-{accessibility,input-monitoring,screen-recording}-granted` +
  `gp-perm-developer-tools-unverifiable`（daemon 自报那一枚，未被覆盖、未被代测）。
  按 `gp-verify-developer-tools` ⇒ `err=0`，在途新增 `gp-devtools-pending` 且该按钮
  `AXEnabled=0`；探测跑完新增 `gp-devtools-denied` 与 `gp-perm-developer-tools-measured-denied`
  （合计 36 枚标识）。GUI 读到的 `denied` 与 CLI 同字节实测的 `verdict: denied` 是同一件事，
  两个来源两个标识——这正是 10-21 那节 C6 冒烟会被骗的那个形状。
- 收尾进程核对：这两个 pid（53178 daemon／53295 面板）`kill` 之后 `pgrep -fl gp-1310-panel`
  两次各空命中；在跑的真 daemon（`~/Applications/GlassPane Daemon.app`，pid 40549）一行没动。

### d. 端到端（发布归档 → 干净前缀 → MCP）

- 解归档 → 树内 `npm pack`：`glasspane-mcp-1.31.0.tgz`（369 094 字节）与
  `glasspane-install-1.31.0.tgz`（107 691 字节）两枚都产得出来。
- 装进干净前缀（`npm install --prefix <空目录>`）：`added 4 packages`，`node_modules/.bin/` 里
  `glasspane-mcp`、`glasspane-http`、`glasspane-install`、`glasspane` 四枚符号链接在位。
- stdin 打一条 `initialize`（三条腿）：
  ① 直接喂 `node_modules/glasspane-mcp/dist/index.js` ⇒ `serverInfo.name = glasspane-mcp`、
  `version = 1.31.0`、`protocolVersion = 2024-11-05`；
  ② 喂 `node_modules/.bin/glasspane-mcp` 那枚符号链接 ⇒ 同一条回包，且 `realpath` 落在 ①那个文件
  （1.12.3 那枚"bin 是符号链接就 0 字节退 0"的 P0 在发布物上实测已不复现）；
  ③ 直接执行 `.bin/glasspane-mcp`（用户那种跑法）⇒ stdout 一条完整回包、stderr 0 字节。
- 安装器两枚入口经符号链接跑：`glasspane-install --help` ⇒ 退 0、stdout 6599 字节、stderr 0 字节；
  `glasspane --help` ⇒ 退 0、757 字节；`glasspane-install --version`（不存在的旗标）⇒ 退 2 且
  把用法打出来，不是 0 字节。

### e. 发布三线与 CI（本版）

**1.31.0（#1–#5 的载体）三线齐，全部实测：**

| 线 | 实测值 |
|---|---|
| tag | `v1.31.0` → `dc4c5f45995c4e6084045d20f69fb4bed80d36ed`（`git rev-list -n1`） |
| Release | `isDraft=false`、`targetCommitish=dc4c5f45…`、4 件资产；归档 `GlassPane-1.31.0.tar.gz` 5 059 240 字节，本机 `shasum -a 256` = `0cd2bd26…47a5a1` 与 API `assets[].digest` 逐字相等；两枚 `.asc` 各 833 字节在架 |
| 归档自证 | `node scripts/make-release-archive.mjs --verify <archive> 1.31.0` ⇒ rc=0，`826 entries, 5059240 bytes, all 30 declared commands and schemas present, no entry under harness/`；另数 `tar -tzf … \| grep -cE "(^\|/)harness/"` ⇒ **0** |
| CI（被 tag 那笔） | `ci.yml` run `42129160148` @ `dc4c5f45` ⇒ completed **success** |
| release.yml | push run `42130249795` ⇒ success（归档 job）；`--ref v1.31.0 -f mode=dry` run `42130614125` ⇒ success（日志第 288 行自报 `mode=dry`，不写 registry）；`--ref v1.31.0 -f mode=publish` run `42352260708`（本轮 11-07 07:40Z 派发）⇒ success，两包各答 `published and confirmed on the registry`，provenance logIndex `3732591487` / `3732629425` |
| registry | `npm view glasspane-mcp version --prefer-online` ⇒ `1.31.0`；`npm view glasspane-install version --prefer-online` ⇒ `1.31.0` |

**1.31.1（#6–#11 的载体）修复已进 main，tag 这一格被别的线的等式按住——如实记为未发出：**

- 版本线：`node scripts/check-version.mjs` ⇒ `OK：版本线一致（1.31.1）`；`release: 1.31.1` = `266a2f75`，
  漏掉的那枚位点由 `5796ca31` 补上（#9）。收口 HEAD = `75bb8c48`，`origin/main` 同 sha。
- 三线实测：`git tag -l v1.31.1` ⇒ 空；`gh release view v1.31.1` ⇒ `release not found`；
  `npm view glasspane-mcp@1.31.1 version --prefer-online` ⇒ `E404 No match found for version 1.31.1`。
  **没有把任何一格写成已完成。**
- 为什么没打 tag（判据在代码里，不是我的偏好）：`scripts/assert-tag-ready.mjs` 的 `judgeTagReady`
  要求 `ci.yml` 在该 sha 的 `event=push` 通道最新一条 `completed && success`。实测 run `42360652081`
  @ `75bb8c48` ⇒ completed **failure**，10 个 job 里 **9 success / 1 failure**，唯一红的是
  `harness rulers (divergence, surfaces, branding, kernel provenance)`；该 job 里唯一红的步骤是
  `release-artifact`。同一形状在 `2555aebc`／`3a5d7cc8`／`4615aafc` 三笔上各红一次（runs
  `42358961701`／`42360028118`／`42360563775`），红的都不是本轮产品面。
- `release-artifact` 的本机读数（`node harness/tools/release-artifact.mjs --check` ⇒ rc=1）：
  `0 agreement(s) held, 0 tolerated lag(s), 2 problem(s) [trunk 653e2ce1…]`；
  `split-main` 与 `artifact`（已发布 `v0.14.4`）两侧都是 `b5ce0a94…`，与主干子树 `653e2ce1…` 不等；
  差异 2 个路径，均在 fork 本体内且**都不是台账**：`contracts/kernel-conformance.json`
  （+1 已发布侧独有行 / −1 主干独有行）、`script/kernel-conformance.mjs`（+0 / −11）；
  工具自己打了 `⚠ RE-SPLIT RISK`：已发布字节里有 1 行是主干今天没有的，直接 split 会覆盖它。
- 等待不是出路（实测，不是推断）：轮询 8 次，21:56:54 → 22:09:57 每次 rc=1，其间每次
  `git fetch origin --prune` 后 `origin/main` 恒为 `75bb8c48`；22:11 再跑一次仍 rc=1、主干仍同一 sha。
  该轮询进程已停，停后 `pgrep -fl "release-artifact|assert-tag-ready|ra-poll"` **两次各空命中**。

**结论（按提示词第 109 行要求给出，不只列发现）：这一条该由 10:30 那条 harness 线修，判据有三条。**
① 两个差异路径都在 `harness/glasspane-harness/` 内且非台账，`release-artifact` 的豁免只给
`SYNCLOG.md`/`CHANGELOG.md`，所以没有 allowance 可用；② 造成缺口的是那条线自己的 `e82b6e4b`
（在 `v0.14.4` 打完之后改了 fork 侧），工具给的原话 remedy 就是「reconcile trunk → `git subtree split`
→ fast-forward push → cut the next patch」；③ 提示词第 45/46 行与本轮任务口令都明确禁止本线改
`harness/` 内容或版本，第 46 行还写明「只有 owner 明确授权你碰的时候」才许动——本轮没有这份授权。
因此本轮**没有** `--record` 洗掉非本轮造成的红（那 +11 行是 `4615aafc` 自己记的），
**没有**放宽 `assert-tag-ready`，**没有**移动任何已发布 tag。

owner 侧补上它的确切动作（按序，全部在那条线的授权范围内）：

```
# 1. 先把已发布侧独有的那 1 行落回主干（否则 split 会覆盖它）
node harness/tools/release-artifact.mjs --check          # 读它列出的 published-only 行
# 2. 主干追平后重切并快进推 split 仓 main
git subtree split --prefix=harness/glasspane-harness -b split/glasspane-harness
git push harness split/glasspane-harness:main            # 必须快进；不是快进就停下核对
# 3. 取下一个 harness 号（0.14.5），只改 product.json + packages/opencode/package.json
#    不要用 scripts/set-version.mjs（那是父仓统一器，会抹掉父仓版本线）
# 4. 打 tag → Release → npm，再回父仓核等式
node harness/tools/release-artifact.mjs --check          # 期望 rc=0
# 5. 等式绿了之后本线的 1.31.1 才发得动（下面这四步是本线的，届时可直接跑）
node scripts/assert-tag-ready.mjs 1.31.1
git tag -s v1.31.1 -m "1.31.1" && git push origin v1.31.1
gh workflow run release.yml --repo jingzhao-l/GlassPane --ref v1.31.1 -f mode=dry
gh workflow run release.yml --repo jingzhao-l/GlassPane --ref v1.31.1 -f mode=publish
```


## 6. 清理盘点（收口后）

九步逐条做过，读数如下。**收口后计数**：`git worktree list` **6 行**、`git branch -a` **17 条**
（本地 13 + 远端 4，其中 2 条是 `HEAD ->` 符号引用）、tag **98 枚**（一枚未删）、stash **3 条**（一条未动）。
`git worktree prune` ⇒ rc=0，行数仍 6；`.worktrees/` 下 5 个目录与注册表一一对应，**无已 remove 的残留**。

| 对象 | 处置 | 去向与判据 |
|---|---|---|
| 本轮我建的 worktree / 分支 | **0 个** | 本轮 9 笔全部直接落在 `main` 并推 `origin/main`，没开工作台分支，所以没有可删的 |
| `.worktrees/harness-close-20261105`（分支 `gp-harness-runner-label-20261107`，tip `75bb8c48`） | 留 | 别的线（10:30 harness）；`status --porcelain` **0 行**＝干净但仍是那条线的活跃工作台，不替别人 remove |
| `.worktrees/harness-integrate-20261107`（tip `f1e650d5`） | 留 | 同上，`status --porcelain` **0 行** |
| `.worktrees/harness-daily-20261104`（tip `09ec93d7`） | 留 | **别人正在飞的未提交批次：12 个文件**，全在 `harness/glasspane-harness/` 内（CHANGELOG/README 两侧/bun.lock/product.json/install.sh 与 5 枚测试） |
| `.worktrees/harness-daily-20261105`（tip `2ff18a90`） | 留 | **在飞未提交批次：6 个文件**，5 个在 fork 内 + 1 个父仓 `scripts/check-doc-links.mjs`；那一处已按第 2 节 (d) 两腿量过并给出结论 |
| `.worktrees/harness-daily-20261106`（tip `3923264d`） | 留 | **在飞未提交批次：30 个文件**（24 改 + 6 新增），29 个在 fork 内 + `harness/tools/product-surface.mjs`；全在本轮禁动范围 |
| 本地 `gp-harness-*` 7 条、`split/0.14.2`／`0.14.2b`／`0.14.3`／`0.14.4` 4 条 | 留 | 前 7 条是那条线的活跃分支（其中 5 条正被 worktree  checkout，`git branch -d` 会拒）；`split/*` 按第 2 步不参与落地判定，其内容由 tag 与 split 仓承载 |
| 本地 `backup-advisory-prerebase` | 留 | 第 4 步的快照例外，读数不含糊：tip `eb660bb2`（2026-11-04 16:25，`[gp] chore(harness): fork-diff 跟一笔——台账改的是 SYNCLOG.md 自己的字节`），`git log --oneline main..backup-advisory-prerebase` ⇒ **4 笔不在 main**（`eb660bb2`/`70f8381a`/`49ee831a`/`dc05ec3e`，全是 `[gp]`）＝那条线 rebase 前的保险。本轮没有任何证据说明这 4 笔的内容已被 main 取代（要证就得逐路径 `git diff main <b>`，而那是 `harness/` 内的字节，本轮禁动），也不是本轮造的 ⇒ **不删** |
| 远端 `origin/main`、`harness/main`（+2 符号引用） | 留 | 发布锚点；远端没有本轮建的分支，所以 `git push origin --delete` 一次也没执行 |
| 98 枚 tag、3 条 stash | 留 | 第 7 步：tag 是 `install.sh`/updater 钉的发布锚点，一枚不许删；3 条 stash 分别记着 `wip-console-and-other-20260923`、并行会话 21:59 的 bridge 中间稿、P6+TCC 合并前副本，全部早于本轮多个会话 |
| `/var/tmp/glasspane-main-check{,-20261103,-20261105,-20261107}` | **删** | 本线往轮与本轮的快照/日志/归档（17M + 7.8M + 4.1M + 214M）；删前 `ps -eo …` 与 `pgrep -fl` 各一次空命中＝无进程在用；读数已全部写进第 5 节 |
| `/var/tmp/gp-1310-panel`、`gp-1310-smoke-state`、`gp-e2e-1107-a`、`gp-e2e-1107-b` | **删** | 本轮真机与 e2e 的隔离状态根；里面只剩 `daemon.out`/`panel.out`/`panel.pid`，`ps -p 53178,53295` 空＝两枚进程早已退出，无 socket 残留 |
| `/var/tmp/gp space-BaRkIc` | **删** | `updater/test/cli.test.mjs:98` 的 mktemp 遗留（11-06 07:23，里面只有 `updater` 一份拷贝）；该测试第 109 行本来就在 `finally` 里 `rmSync`，所以这是**一次被中断的套件跑**留下的，不是代码缺陷 |
| `/var/tmp/glasspane-harness`、`/var/tmp/gp1107`、`/var/tmp/gp-vp-selftest-*.log` | 留 | 那条线的 scratch：`gp1107` 里是 `changelog-0143.md`/`1106-batch.patch`（0.14.x 是他们的版本线），`gp-vp-selftest-*` 钉的是 `0_14_2`；`glasspane-harness` 的 mtime 是 **22:14**＝本轮收口时仍在被写 |
| `/var/tmp/glasspane-lane-backups` | 留 | 11-03 的 `install.sh.orig`/`installer-selftest.sh.orig`/`product.json.orig`＋`mine/`＝回滚保险，归属不明且不是本轮造的，按第 4/7 步不动 |
| `CHANGELOG.md` 的 `[Unreleased]` | 已空 | 逐字读过：只有一段声明"空"的说明，没有未归号条目；1.31.1 的六件事都在 `## [1.31.1] — 2026-11-07` 下 |
| 开放 PR / 悬挂 draft Release | **各 0** | `gh pr list --state open` ⇒ `[]`；`gh release list --limit 30` 里 `isDraft==true` 的筛选 ⇒ `[]` |
| npm 待批 staged publish | 本轮那两包**没有**；全量枚举未观测 | 判据见第 4 节那一条（本机 E401；publish run 走的是直发分支并已回 registry 核实） |
| CI 最新一条 | **failure（如实记）** | run `42360652081` @ `75bb8c48`：9 job success / 1 failure，唯一红是 `harness rulers` 里的 `release-artifact`，归属与 remedy 见第 5 节 e 段。**没有为了让这一格变绿而放宽任何判据** |
| 本轮自起的后台进程 | **全部已退出** | 轮询任务 `bdr2bzzc9` 已 stop；停后 `pgrep -fl "release-artifact\|assert-tag-ready\|ra-poll"` **两次各空命中**，`ps -p 2873,2876` 也空；`pgrep -fl "node .*glasspane-main-check"` 空 |
| 归属不明 / 别的会话的长命进程 | **不动，点名** | ① pid 40549 `~/Applications/GlassPane Daemon.app/…/glasspaned --socket-path ~/.glasspane/engine.sock`（ppid 1，已跑 4h46m）＝owner 装好的真 daemon，本轮真机走查用的是隔离根，没碰它；② pid 78587 `/Volumes/Eng-Dev/Zynthara AI/vm/.venv/bin/python -m pytest tests/ -q`＝另一个仓的套件；③ pid 85496 由 **Trae CN**（另一个 IDE，`TERM_PROGRAM=vscode`/`TRAE_BRAND_NAME=Trae CN`）起的 `swift build --build-tests` 于 `/private/tmp/zynthara-regression-base/host`＝既不是本会话后代也不是本仓路径。三者都按第 8 步"归属不明一律不动"保留 |
