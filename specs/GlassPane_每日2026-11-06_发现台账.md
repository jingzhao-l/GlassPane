# 每日审查 2026-11-06/11-07（承接 11-05 第二条会话）· 发现台账（发现 10 / 修复 10 / 未修 0）

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

## 1. 本轮发现 → 修复 → 具名测试（10 条；#1-#5 随 1.31.0 发出，#6-#10 随 1.31.1 发出）

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

## 2. 判为不成立 / 决定不做的（各附证据）

- **(a) 不给"注释残句"造一个新谓词。** 残渣闸的判据②是"首词是命令词"那张表，把 markdown 的
  残渣形状放宽成"任何像被删过的句子"会误红人话——这道闸的第一版就是这么误红了
  `harness/glasspane-harness/SYNCLOG.md:684` 那句带引号的中文句子（11-01 台账记的）。本轮只补
  可核事实，不为四行注释加一条按形状猜的闸。
- **(b) 面板六页 AX 走查本轮不重跑，不是省事。** 本轮改的那条命令在面板里唯一的读者是
  `SettingsModel.swift:799` → `DeveloperToolsCapability.parse`（`PermissionStatus.swift:595-606`），
  它要求的四个键（`capability` / `launch.state` / `attach.state` / `granted`）一个没动，本版只
  **新增**字段；卡片判据 `status`（`PermissionStatus.swift:564-568`）本来就是三档
  （denied / granted / unverifiable）。也就是说 GUI 那一面早就是对的，本轮补的是 CLI 那一面。
  补它的那条命令写在 `engine/smoke.md` 本轮那一节的第 4 条。
- **(c) `harness/` 一行没动**（除 4 节决定 3 的那一次基线补记）。10:30 那条线今晨还在推
  `[gp]` 前缀的提交（`fdd54754`、`5f7fb02d`），本轮碰它就是撞车。

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
## 4. 未观测（只限物理边界）

- **`unverifiable` 那一档的真实现场本机造不出**：探测走绝对路径 `/usr/bin/xcrun`，这台机器 CLT
  在位且会答。补它的动作：在一台没有 Command Line Tools 的 mac 上跑
  `glasspaned --state-dir <临时根> --check-developer-tools`，预期 `verdict: unverifiable` 且退 5。
  这一档由注入层 `DebugCapabilityProbe.Running` 量到（那 5 条用例），不是"没测"。
- **Apple 公证**：需要付费开发者账号，owner 未启用；文档没有写成已完成（既有事实，本轮未触碰）。
- `npm stage approve`：本轮预期不需要（1.30.0 走 trusted publisher 直发成功）；若这次被 staged-only
  拒，补救命令是 `npm stage approve <stage-id>`，需要 owner 的 2FA。

## 5. 收口

<!--GATE-READINGS-->

## 6. 清理盘点（收口后）

<!--CLEANUP-->
