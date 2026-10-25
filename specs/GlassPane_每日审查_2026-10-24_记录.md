# 每日审查记录 · 2026-10-24（GlassPane 主仓，v1.21.0 这一轮）

> 只新增本轮记录，不改写任何历史结论。开工 HEAD=`61153ffd`（= 当时的 `origin/main`），
> 收口 HEAD 见 `CHANGELOG.md` 的 1.21.0 条目与本文件末尾。

## 0. 开工状态

| 项 | 实测 |
|---|---|
| 整树 `git status --porcelain` | 开工 0 行（工作树干净）；`main` 落后 `origin/main` **20 笔**（全是 harness 线 0.10.1/0.10.2 那一批），`git merge --ff-only origin/main` 追平，追平后 HEAD=`61153ffd` |
| `df -k /Volumes/Eng-Dev` | 开工 **1.44 GiB** 可用（APFS 容器 99.7% 已用，只有 1.5 GB 未分配）——低于 4 GiB 阈值，先清可再生物：`engine/probe/.build`(815M)、`~/.npm/_cacache`(1.4G)、`~/.npm/_npx`(804M) → 复测 **4.5 GiB**，本轮全程未再跌破 2 GiB |
| 环境坑（本轮新增一条） | 清 `~/.npm/_cacache` 时撞上往轮 `sudo npm` 留下的 **6 个 root 属主条目**：`npm ci` 因此报 `ENOENT … _cacache/content-v2/…` 并退 1，`npm cache clean --force` 报 EACCES（要 sudo chown）。同父目录内的改名重定向被粘位（`/var/tmp` sticky）拦下；最终把 `index-v5/19`、`content-v2/sha512/f0` **就地改名隔离**（`_quarantine-19`、`_quarantine-f0`，可逆、原件未动）后 `npm ci` 退 0 |
| 版本线实测 | 根 `package.json` = 1.20.1；`git tag --sort=-v:refname` 顶到 `v1.20.1`；`npm view glasspane-mcp version` / `glasspane-install version` 都回 **1.20.1**——三格齐，无漂移。`v1.21.0` 与 registry 上同号都**不存在**（本轮取号前实测） |
| 上一轮未收口的活 | ①`gp-mcp-sdk`（worktree `.worktrees/gp-deps`）与 `origin/main` 同一枚 sha、树干净 ⇒ 已落地；②`gp-harness-sc5-fork-20261020`（本地+远端）：三笔提交按**逐行内容**判——451/228 行全在 main，710 行里 632 行"缺失"全是金样/README 台账行与注释重排，源码面 main 是**严格超集**（`providers.ts` 450→527 行、无一项 branch-only 导出）⇒ 被取代，删除；③`split/glasspane-harness` 是 subtree 搬运分支，不参与该判定；④`origin/dependabot/…` 是外部机器人的，留 |
| 别人正在飞的批次 | 无（开工工作树 0 行）。并行风险来自 harness 线 10:30 那条任务与另一条每日任务写同一棵 `main`；本轮的处置是**先提交后推送**、推送前重新 `git fetch` 并核 ahead/behind |

## 1. 审查怎么做的

`review-bugbot` 的 `bugbot` 子代理类型在本会话不可用（`Unknown agent type: 'bugbot'`，可用类型只有 general-purpose/Explore/Plan 与三个示例），按 skill 自己的兜底路径改派等价泳道：5 条只读审查泳道（Swift 引擎语义层 / daemon CLI+面板 / mcp-shell / installer+updater+install.sh+scripts / bridge+workflow+kernel 语料）与 1 条安全信任边界泳道，加 1 条用户体验与功能缺口泳道。修复阶段派 5 条实现泳道，**六条泳道里有五条撞到 150 轮上限**（mcp-shell、engine、cli/panel、release/bridge、installer/updater——全部在"代码写完、测试没写完"处中断），由主代理接管：逐条读 diff、补测试、跑门禁、做反向变异。

这就是本轮最贵的一课，记在这里：**泳道必须小到能在 150 轮内跑完"代码+测试+红证"，否则它的产物不是交付而是半成品**。上一轮已记过同一条（`Sub-agent 150-turn cap`），这轮又犯，说明拆得还是不够小。

## 2. 审出并修完的缺陷（发现 53 条，修复 53 条；另有 2 条本轮新增的持续量闸）

编号 = 提交里可追的判据位置。"测试"列是用例文件名（都在本轮同一批提交里）。

### 引擎语义/存储层（`Qoder20261024EngineStorageTests.swift`，18 条用例）

| # | 位置 | 失效模式 | 修在哪 |
|---|---|---|---|
| 1 | `GlassPaneEngine/ProjectRegistry.swift:520`（配 `:459`、`Registry` 调用方 catch） | 发布后"最终名不够私密"那条拒绝抛错，调用方把**内存表倒回去**而盘上已是新表、`loadedIdentity` 已推进 ⇒ 下一次成功写静默删掉那条真落过盘的注册 | 按"这一趟是否已发布"决定回滚；通用 catch 那句"盘上未变"按 `renamed` 拆成两种如实成文 |
| 2 | `ParamValidation.swift:227-244` | `NSRegularExpression` 的 `$` 也匹配"结尾换行之前"，`op_…\n` 过校验并被拿去拼证据文件名（`Dispatcher.swift:210-212` 自己写明） | 与 `EvidenceStore.isEntryName` 同源：先等长再匹配 |
| 3 | `EvidenceModels.swift:562-581,735-746` | 同一形状在读回/台账侧的第二处 | 同一判据（等长 + 全串） |
| 4 | `ProjectRegistry.swift:172,229`、`ApprovalGate.swift:218` | 512/256 上限数的是 Unicode 字素簇，而壳的 `z.string().max` 与发布的 `maxLength` 按 **UTF-16 码元**数 ⇒ 256 个组合序列在 daemon 算 256、在壳算 512，daemon 是松的那一个，收下后写进 projects.json，壳下次读表整条拒 | 统一走 `ParamValidation.length` |
| 5 | `EvidenceStore.swift:447-471` + `DurableFileWrite.swift:46-51` | 非持久化失败（ENOSPC/EDQUOT）走兜底分支时不清 `<op>.json.tmp-*`，那名字过不了 `isEntryName`，clear/prune/stats 全跳过 ⇒ 磁盘满时逐次堆积 | 兜底也撤临时件 |
| 6 | 同处通用 catch | 兜底成功时主失败原因一个字没留（不可审计） | log 主因 |
| 7 | `ProtocolErrors.swift:90-93` × `EngineCore.swift:1652-1659` | `diagnose`/`last_evidence` 的默认 remedy 让人"先跑 act 或 assert_element"——`assert_element` 与 `diagnose` 自己就要求已有 pack，照做是死循环 | 两支各给跑得动的一步 |
| 8 | `SCKCapturer.swift:855-860,756-759` | SCStream 以 `didStopWithError` 结束时 error 被丢、结局折进 `.timedOut`，已知成因说成计时抖动 | 新增 `.stopped(error:)` 一支，与"三种结局不折叠"对齐 |
| 9 | `InputEventSource.swift:43-47` | 默认 `peekAvailable` 回空＝"没有已知输入"，空闲闸对未实现者静默失效，而证据 basis 仍写"整个窗口都被看守过" | 乐观缺省不再能 produce 那句主张 |
| 10 | `FrameCodec.swift:151` | 拼错方法名时那句"the methods it does answer are …"漏了它真实现的 `shutdown`（`Dispatcher.swift:94` 会执行） | 措辞与实现对齐；capabilities 不塞运维方法 |
| 11 | `RecipeLoader.swift` + `Dispatcher.swift:117-129` | 校验只判形状，不看每步 params 是否属于该方法真读的键集：面板内置模板那种 `observe` 带 `selector/action` 的配方"合法却谁都跑不了"过闸；`assert`（契约词汇）与 `assert_element`（线名）两套表没人承接 | params 由 `Dispatcher.acceptedParamKeys` **派生**判（不手抄）；`assert`→`EngineMethod.assertElement` 的映射与"本构建无执行器"写成 notes（不进 errors，不判掉冻结契约接受的文件） |
| 12 | `ParamValidation.swift:120-158,307-333` | 顶层 `requireOnlyKnownKeys` 早已修，`selector`/`steps[i]` 里嵌套的未知键仍被忽略——语料 `additionalProperties:false`、壳 strictObject，daemon 收 | 嵌套复用同一判定 |

### daemon CLI 与面板（`Qoder20261024CliAndPanelTests.swift` 31 条 + `Qoder20261024PanelHonestyTests.swift` 14 条）

| # | 位置 | 失效模式 | 修在哪 |
|---|---|---|---|
| 13 | `glasspaned/main.swift:152,156` vs `:482-488` | `--request-permission` 缺值/未知 kind 走 `.errorCode(…,64)`：一行 stderr、不打 usage，而 `--help` 的 64 段承诺整块 usage，同路由另外五处都打。实测 rc=64/stdout 0 字节 | 改走 `.error` |
| 14 | `main.swift:129-275 + :802-811` | 一次性子命令 + 服务形态修饰旗同现时**整枚静默吞掉**且退 0（实测 `--state-dir R --list-projects --older-than 7` rc=0、零提示）。socket 面早有 `acceptedParamKeys` 对照 | `OneShotFlagScope` 点名拒绝；`--state-dir`/`--verbose` 不罚但要说"这一趟没读到它" |
| 15 | `main.swift:216,236`(码 2) vs `:208,222,245`(码 64) | 同一失败类（取值旗标少给值）两套码，读 rc 的人无法预判 | 缺值统一 64 + usage；"值给了但用不了"仍 2 |
| 16 | `main.swift:866-869` + `DaemonPermissionSnapshot.swift` + `PermissionStatus.swift` | `--permissions` 出 camelCase 键而 `--request-permission` 只吃 kebab；无 `next`、无判决；**无论四个席位读到什么都退 0** | 出键改用 `kind.cliValue`（与那条命令同源）、每个未 granted 席位带现成命令 + pane URL + recheck、退出码只说测得到的三席；`developer-tools` 如实排除在判决外（TCC 不回答查询） |
| 17 | `glasspane-settings/SettingsModel.swift:1050-1076` | `launchctl submit` 是 `try? process.run()`：不等、不读码 ⇒ "标签已存在/作业被拒"只能靠"输出文件一直空"发现，dev-tools 那趟等满 260s 报 `.timedOut`，把实测到的**拒绝**说成超时，下一步还是个不会改变答案的重试 | 走带退出码的通道，新增 `.submitRefused` 一支与如实文案 |
| 18 | `glasspane-settings/ConsoleModel.swift:281-291` | 面板把 `hello` 里**无鉴权可读**的 `stateRoot` 直接当自己写入的根；TS 侧对同一个值早有闸，Swift 侧判据也早已存在（`StateRootArgument.rejection(for:)`），只是采纳点没采纳 | 采纳前过闸、拒时保留上一个根、把这一拒写上屏幕并拦住三条写入动作 |
| 19 | `glasspane-settings/UpdateModel.swift:96` | 同一件事的第二个采纳点 | 同一判据（不重抄），措辞与 18 同源 |
| 20 | `UpdatePanelLogic.swift:553-562` | needs-consent 的 `non-default-state-dir` 那一档只把人支去 `updater … status`，而更新器早备了一条真跑得完的 `apply --state-dir … --consent state-dir` | 原样转述那条命令（不代签不代跑），并说清按下这枚不会发生任何事 |
| 21 | `UpdateTabView.swift:242` × `updater/lib/policy.js:70` | 中文界面那枚按钮写「安装更新」，英文 remedy 让人按 "Install update"——读者对不上号 | 标题/AX 标识/那句指认同源于一个常量（改界面侧，不动对外 remedy 契约） |
| 22 | `RecipesTabView.swift:114,153,161,223-227,390,422,439` | 「校验通过」只说"daemon 校验通过"，不提这份构建没有任何一层执行配方；两个内置模板的 params 与方法真读的键不符 | 结论改成"形状合法"+ 直说无执行入口；模板按 `Dispatcher` 真读的键重写 |

### MCP 壳（`qoder-20261024-shell-{registry-gates,transport-identity,advice-fanout}.test.mjs`）

| # | 位置 | 失效模式 | 修在哪 |
|---|---|---|---|
| 23 | `mcp-shell/src/project-registry.ts:429-433` | `GLASSPANE_PROJECTS_FILE` 原样返回，绕过 `stateRootRefusal`/`refuseCandidate`；紧随的 `saveProjects` 会对它点名的目录 `mkdirSync(0700)`+`tightenMode` 并写进注册表，而 `rootDiscriminator()` 还教 agent 去设它 | env 值也过同一组路径闸；唯一放行的是 daemon 默认根 `<home>/.glasspane` |
| 24 | `engine-client.ts:1606-1625` | `verifyIdentity` 把 `hello.stateRoot` 的赋值放在两条协议判据**之后**（那两支都 return）⇒ 报了根、协议号不合的 daemon 让 `reportedStateRoot` 停在 null，project 工具改写家目录默认根，回包还宣称"this daemon's hello reported no stateRoot" | 先存后判，与 `version` 同规格；测试驱动真 handshake（`io.onOpen`）而不是壳自己发的 `call("hello")` |
| 25 | `tools.ts:2822-2839` | `recent_reports` 用 `ids.length`（含被拒未发的 id）宣称"the N operations this shell asked about: each was answered GP_E_NO_EVIDENCE"，`rejected` 在这一支消失 ⇒ 把没测过的写成 daemon 的答复 | 分母改用真发出去的条数 + 挂上 rejected 注记 |
| 26 | `tools.ts:2972-2979` × `http-gateway.ts:1322` | 超限建议对 `snapshot` 说 "retry with a smaller maxDepth"（＝命令重发），而 timeout 那路与 `NOT_NARROWABLE_BY_RETRY` 都认定它重发不安全（第二份基线挤掉调用方早先拿到的） | 判据收回 `payloadOverflowArm` 一处，两面转录 |
| 27 | `tools.ts:2263-2279,2342-2347` | `tightenMode` 落不住 / EIO 时 remedy 由**码**派生成"文件坏了去 repair or restore"，同一帧的 message 自己写着"这不是对文件内容的判决" | `ProjectRegistryError` 带自己的 remedy，壳只转录；强制覆盖在这一支被明确**禁止** |
| 28 | `http-gateway.ts:792-808` | 聚合读里后面的 id 硬失败/形状不合时直接 return，**已渲染的 pack 全丢**只答一条错误，而本文件承诺"never dropped from it"、MCP 半边早已改成"部分报告 + 失败注记" | 两面合成同一个构造（`failed`/`notFetched` + 报告内注记） |
| 29 | `engine-client.ts:693-711`（触发 `:1741-1787`） | 懒连接上连接从未建立、帧只进了本地队列，teardown 却答"this request had already left this shell when its transport died"——对本壳没发生的事断言事实，还禁掉了唯一安全的重发 | 区分"没连上"与"连上后死掉" |
| 30 | `engine-client.ts:842-843,1092` | `Pending.params` 注释称它是"narrow this 的唯一诚实依据"，全仓无一处读它（判据已搬去 `tools.engineWithPayloadAdvice`）；留着还把 act 的 selector/restore 的 64 步数组延命到迟到回复窗口 | 删字段 |

### 安装器与更新器（`installer/test/qoder-20261024-installer-lane`、`updater/test/qoder-20261024-{updater-lane,updater-gates}`）

| # | 位置 | 失效模式 | 修在哪 |
|---|---|---|---|
| 31 | `installer/cli.js:1069`（配 `:2575-2599`） | `--restore-launchd`（正是交给 agent 的"daemon 不可达"补救命令）不传 `allowBootout`，默认 true ⇒ 不问一句就 bootout 已加载作业、打断正在跑的 act；同一个动作在 `install()` 里是三道确认门之一 | 先按"不许 bootout"只读问一次，需要卸才问人；拒绝时磁盘与 launchd 都不动，回话给三条不同下一步 |
| 32 | `installer/cli.js:1857`（另 `:1616`、`:2515`） | 文案仍写"install.sh 在 stdin 非 TTY 时已自动补 `--no-prompt`"，而 install.sh 早已不代答（有闸钉着）；注释引用已删的 `SILENT` | 改对 + 加闸 |
| 33 | `installer/cli.js:717-718` | `installBundles` 先删旧目标再 copy，`cpSync` 中途失败就是"旧的没了、新的是半棵"，报错只有 errno | 落到 `.tmp-` → 旧的一份**改名**让位 → rename 就位 → 最后删备份 |
| 34 | `updater/cli.js:383,410` + `updater/lib/version.js:94` | `readBundleVersion` 用会 throw 的 `parsePlainVersion` 且 `readLocal()` 无 try ⇒ 半装/手改的 Info.plist 抛到兜底：只打 stderr、退 3、**不写状态**，面板与 `gp_diagnose` 永远看不到理由（文件头契约明写 "Never throws: refusals are data"） | 读不出回 null（与缺席同格）/ 包成 refusal 并照常落状态 |
| 35 | `updater/lib/launchd.js:183-189` | `status ?? 1` 把"没答话"折成退出码、stderr 空串时丢掉 error 消息 ⇒ `readRunningJob` 报 "the daemon job is not loaded"（未观测写成否定观察） | 三档 available/absent/unverified |
| 36 | `updater/lib/launchd.js:406`（与 `:284` 一句文案） | 权限读数 `(mode & 0o777).toString(8)` 少前导零（installer 侧 `formatMode()` 专为"拒绝里的数要能和 ls -l 对上"而存在）；同函数那句"下一步"把 label 写死成 `com.glasspane.daemon`，问别的作业时把人支去读另一个作业 | 同源八进制格式化 + label 由参数给，逐值对表与"点名被问作业"都有闸 |
| 37 | `updater/lib/idle.js:110-115` → `policy.js:98-105` → `apply.js:1460` | 探活 5s 无应答的理由句写死 "so something is queued in front of it"（未量到的归因），且这条 deferred 拒绝没有下一步（其余三道门都带 `updater …` 命令） | 并列可能 + 点名 socket/超时 + 给真跑得动的动作 |
| 38 | `updater/lib/tar.js:161,187-189,301` | ① `pendingMode` 恒 null 的死分支（读起来像已支持 pax mode）；② 重复项守卫放过"同一路径先 file 后 link"，反而覆盖 file 的字节，与自己那句注释相反 | 真解析并应用 `mode=`（非八进制即拒）；link 计入重复判定 |
| 39 | `install.sh:22-23` vs `:218-219` | 头部承诺"两个覆盖位的形状闸在 dry-run 里照跑"，实际只在要 clone 那一支跑（实测 `GLASSPANE_REF='+bad'` rc=0） | 两道闸提到定位分支之前 + located-repo 的 dry-run 用例 |

### 发布链、尺子、桥、签名（`updater/test/qoder-20261024-{rel-tag-ready-sha,rel-release-chain-gates,release-chain,version-corpus}`、`bridge/test_bridge.py`）

| # | 位置 | 失效模式 | 修在哪 |
|---|---|---|---|
| 40 | `scripts/assert-tag-ready.mjs:129-133` | 取 CI 记录时 workflow 名写死 `ci.yml`（`--workflow` 只进文案），且不带 `head_sha=`/`event=push`，而复用的 `judgeCiGreen` 从不比 `run.head_sha` ⇒ "在 <headSha> 上绿了"可能引的是别的 commit / 别的触发通道的记录 | `ciRunsApiPath` + `runsForSha` 与 `assert-ci-green.mjs` 同形 |
| 41 | `.github/workflows/release.yml:325-351,426-443` | `npm-publish` 只问"树等于 tag"与"该 sha 的 CI 绿"，**没有任何一环问这个 tag 的 GitHub Release 在不在/对外不对外**。两条通道故意不串（加 `needs` 会永久锁死），于是 registry 有包而 `releases/latest` 服务上一版——本文件自己写明 updater 会读成 up-to-date，每台机器静默不再更新 | publish 前读回 `isDraft`/`assets`/`targetCommitish`，四条各自红；dry 不查 |
| 42 | 三份 workflow 共 14 个 job | 一条 `timeout-minutes` 都没有（默认 6 小时） | 逐 job 补（按历史实测耗时放大 5–8 倍） |
| 43 | `scripts/check-workflows.mjs` | 抓不住 (a) 缺 `timeout-minutes`、(b) run 正文缺 `set -euo pipefail`（2a 只做 `bash -n`，闸门松它看不见；`harness-contract.yml` 那步真的少了）、(c) 调 `gh` 却没在**本步**配 `env.GH_TOKEN`（兄弟步不算——v1.16.2 那一格的形状） | 三条规则 + 每条在 `--self-test` 里有变异与合法反例（现 22 档：15 必须抓、7 必须沉默） |
| 44 | `scripts/check-kernel-corpus.mjs:55-61,168-177` | "对照已安装包"那一腿只看 `harness/glasspane-harness/node_modules`，CI 里必然落空 ⇒ 打一句"未观测"**exit 0**；找到了、版本不符也只 `console.log`。同树 `harness-contract.yml` 立的规矩是"测不了必须红" | 根 `node_modules/iterate-kernel` 为第一候选；一份都没装=2、不同号=1、同号才逐文件 sha256 核；逃生口只豁免"没有可比的东西" |
| 45 | `scripts/set-version.mjs` × `updater/lib/version.js` `TAG_RE` × `selfcheck.js:82` | `SEMVER_RE` 允许 prerelease，取号全绿；可一旦用 `1.21.0-beta.1` 打 tag，所有装了 updater 的机器**永久 `tag-unparseable`** | 取号处早拒（等价性由测试逐样本对 `tagShapeOk`/`TAG_RE` 钉住，不新抄正则） |
| 46 | `bridge/glasspane_bridge.py:758`（消费点 `:966`） | `GPBRIDGE_BUDGET=abc` ⇒ `float()` 在 try 外抛 ValueError：traceback + 退 1，`--out`/`--send-sock` 零字节，违背本文件 §6.2"失败也以 JSON 离场"（实测复现） | `capture_budget_s` 钳进 `[30, timeout]`、非数回落默认并在 errors 点名原值 |
| 47 | `bridge/glasspane_bridge.py:1640-1648` | `_disarm_watchpoint` 在 `Disable()` 成功前就 pop 句柄：失败时 SBWatchpoint 失联、槽位没让出而账本已 release 并把队头 arm 进同一个槽 | 只在成功时 pop |
| 48 | `bridge/glasspane_bridge.py:888-910,942-959` | `communicate()` 抛**非** TimeoutExpired 异常时 `finally` 不 `killpg`——而同一文件整段论证的就是"只杀直接子进程会把目标留在 SIGSTOP" | killpg 挪进幂等清理路径 |
| 49 | `bridge/glasspane_bridge.py:923-926,951-956,995-1000` | 超时整组 SIGKILL 后被 attach 的用户应用仍冻着（全仓此前没有一处 `SIGCONT`），输出却断言"no longer held by this bridge"：一次谎 | 补 SIGCONT 并用 `ps` 读回，读不回就说读不回 |
| 50 | `bridge/glasspane_bridge.py:1373-1377` | remedy 指挥 agent `cp '%s' /tmp/glasspane_bridge.py` 再跑那个**固定名**（世界可写、可预测，别人先占就是跑别人的字节，还是在有调试特权的进程里），四处 `'%s'` 插值没引用 | 落点 0700 的 `mktemp -d` 新名 + `shlex.quote`；shell 词形有闸 |
| 51 | `tools/gpg-signing.sh:225-232,290-291` | 有 seed/install 却**没有任何删除路径**：私钥 + 口令以 base64（编码不是加密）常驻登录钥匙串，任何同用户进程 `security find-generic-password -w` 都读得到（ACL 认创建者二进制不认调用者）；拿到 = 能给所有用户的 updater 投毒 | 新增 `forget`：两半都删、删完读回确认，delete 失败与"回 0 却还在"都判红并给人工出路；本轮不执行（发布链的本地签名还要它） |
| 52 | `updater/test/scripts-check-workflows.test.mjs` 的 HEADER 夹具 | 43 那三条新规则一落地，这份合成 fixture 就红在"与本用例无关的形状"上（缺 `timeout-minutes` / 缺 `set -euo pipefail`）——REL 泳道把它写成"HAND-OFF 给下一条泳道"，那是中间态 | 本轮自己补：fixture 加那两行并写明"缺行该红的地方在闸自己的变异档与 rel-gates 里" |
| 53 | `engine/Tests/GlassPaneEngineTests/AXWindowLookupTests.swift:104-147` | **开工基线上唯一那条红**：候选集用 `activationPolicy == .regular` 划，而本机此刻唯一的常规应用在屏窗口是 TRAE 的一枚 60×60 悬浮球（CG 层 101、AX 子角色 `AXDialog`）——产品正确地拒掉它，控制却把正确行为报成"像素通道又死了" | 候选集改由 **Accessibility** 划（`AXStandardWindow`，最小化不算），无辅助功能席位时跳过并点名缺哪把席位；断言本体一字未放宽 |

### 本轮新增的两条持续量（不是缺陷，是把已成立的事实钉住）

| # | 位置 | 内容 |
|---|---|---|
| G1 | `mcp-shell/test/qoder-20261024-array-bounds.test.mjs` | `npm audit` 报 zod <4.6.6 high（GHSA-mrhx-c7xc-m3w5，`iterate-kernel` 经 zod 承一条）。该告警的前提是"一份**无上界**的数组 schema 收到大数组"；本版不升 zod 4（内核 0.1.9 的 `.d.ts` 是 zod 3 形状，升它是跨仓契约升级，不为这条告警）。实测本仓对外只有一条 `z.array(...).min(1).max(64)`、被钉语料每个数组都声明 `maxItems` ⇒ 够不着。于是把这两件事各立一条闸，两条都当场用探针文件证过红 |
| G2 | `mcp-shell/test/qoder-20261024-contract-divergence.test.mjs` | 语料对 `signals.assertion.expected` 放行任意长，而 daemon 与壳都判 512（`actual` 不算——它不是入参，本轮实测纠正了审查泳道的笼统说法）。收紧语料要动内核发布物与 harness 那条 pin 链（`harness/` 归 10:30 那条线），本层把差值钉成**具名清单**：多一条红、少一条也红，逼记录跟着现实改 |

## 3. 本轮我替你做的决定（含依据与回滚）

| 决定 | 依据 | 回滚 |
|---|---|---|
| 取号 **minor → 1.21.0** | 本仓 1.6.2 那条自写判据：patch 要求"状态文件字段、退出码集合、CLI 参数、npm `bin` 声明"都没动。本轮动了 CLI 参数（新增一次性形态的旗标拒绝）、退出码分配（2→64、`--permissions` 开始按席位回 1）、`--permissions` 输出键形状 ⇒ minor | `git revert` 发布那笔（未推送前 `git reset --soft`），号让给下一轮、**不覆盖已发出去的 tag** |
| `--permissions` 的判决**不含** developer-tools | TCC 对该项不回答任何查询，恒 `unverifiable` 是设计；把它折进退出码会让每台正常机器长期红 | 见 `PermissionSeatReport.measuredKinds/unmeasuredKinds`，改回只需把那一席并入 measured 并同步 `--help` |
| 面板那两处 remedy/文案改在**面板侧**（#21、#20） | `policy.js`/`apply.js` 的英文那句是对外契约（`updater/test/policy.test.mjs` 钉着），且是别的泳道在读的文件；把界面改成英文违反产品纪律 | 若 owner 更愿意改 remedy，只需把 `updaterEnglishButtonName` 那层去掉并同步测试 |
| zod 不升 4、改为立形状闸（G1） | 升 zod 4 要动 canonical 内核（`.d.ts` 是 zod 3 形状）与 harness 的 pin 链，本轮不许动 `harness/`；而该告警的前提（无上界数组）在本产品不成立 | `npm audit` 重跑即可复核；若 owner 决定升，改动在 canonical + 三处同号 |
| 语料 `expected` 的上限差值**不**在本轮收紧（G2） | 收紧它要发内核新版并重钉 harness/`kernel-pin`/`kernel-conformance`，属另一条线；本层把它做成会一直叫的闸 | 内核收紧后 G2 自己变红，按提示删那一行 |
| `harness/contracts/tool-surface.json` 与 `harness/glasspane-harness/contracts/engine-methods.json` 重记 | 前者是本轮面 A +551 行的有意增长（棘轮按授权重记，单独一笔 `chore(harness)`，红过才算它还在工作）；后者是 `product-surface` 明确要求的"从 enum 重推 contract（方法与 blob），绝不为凑数手改" —— `FrameCodec.swift` 那句措辞改了字面，blob 必须跟着走，13 条方法一项没动 | 两笔各自 `git revert`；金样退回旧字节后 `--check` 会重新红（这正是要的效果） |
| 三条只读审查泳道 + 五条实现泳道的拆法，五条实现泳道全撞 150 轮 | 见 §1 的教训；主代理接管补齐测试与验证 | 不涉代码 |
| `/var/tmp/glasspane-main-check/` 被整目录删掉这件事（含本轮快照与门禁日志） | 不在仓内任何代码里（grep 无命中），是并行清理把自己的 scratch 前缀连根清了 | 已改用带日期且**不是**前缀族的名字（`gp20261024RoundBackup` 等），并在 §5 记下教训 |

## 4. 未观测（只限物理边界）

| 项 | 为什么本机做不到 | 补它的确切一条命令 |
|---|---|---|
| `npm stage approve` | 需要 owner 的 2FA（trusted publisher 直发若被 staged-only 拒） | `npm stage list` → `npm stage approve <stage-id>`（包名 `glasspane-mcp` / `glasspane-install`，版本 1.21.0） |
| Apple 公证（Developer ID + notarytool） | owner 未启用付费账号，仍是既定决策而非本轮动作 | 有账号后：`xcrun notarytool submit <bundle>.zip --keychain-profile <p> --wait` |
| 撤销一次真 TCC 席位来跑 `--guide-screen-permission` 的拒绝支 | 系统侧没有无副作用的撤销命令，本产品也不许编造 remedy | 在系统设置里取消"屏幕录制"勾选后跑 `glasspaned --guide-screen-permission; echo $?`，期望 1 且打印 "still not granted"，再勾回来 |
| 在 macOS 13 上跑两个 bundle | 本机 26.7，无 13 的机器或镜像 | 在 13.x 机器上 `open "GlassPane Daemon.app"` 看 LaunchServices 是否按 `LSMinimumSystemVersion=14.0` 拒绝 |

## 5. 本轮的过程教训（写给下一轮，不写给用户）

1. **`mkdir -p "$B" x > "$LOG"` 是个坑**：重定向先于 `mkdir` 求值，目录还不存在时整条命令直接失败，后面的备份、日志、恢复全部落空——本轮第一版反向变异脚本因此把三处变异**留在了树上且没有备份**。出路不是"更小心"，是顺序：`mkdir -p "$B"` 单独一行，再 `LOG="$B/log.txt"`。变异前必须先证明备份存在（`[ -f "$bak" ] || exit 1`）。这三处变异事后逐条与 `git show HEAD:<file>` 的 sha256 核回，`git status` 归零后才继续。
2. 上一轮已经记过"泳道会在代码写完、证据没做处被 150 轮切断"。这轮**六条里断了五条**，说明拆得仍不够小：正确的单元是"一处缺陷 + 它的测试 + 它的红证"，不是一条泳道十条缺陷。
3. 共享 scratch 前缀会被别人的清理连根拔掉。本轮之后：快照目录名带日期与轮次、不用 `glasspane-*` 前缀族，日志每轮新建。
