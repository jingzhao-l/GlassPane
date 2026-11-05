# 每日审查 2026-11-05 · 发现台账（发现 15 / 修复 14 / 否证 1 / 未修 0；另收口上一轮未提交的 9 条候选）

> 主仓 07:30 那条线（引擎 + MCP 壳 + 安装器 + 更新器 + 桥）。`harness/` 不在本轮范围（10:30 那条线）。
> 本文件只新增，不改历史结论；里面每个数字都是当场跑一条命令量出来的，量法随条写明。

## 0. 开工时读到的状态（判据是文件字节）

- 开工 HEAD `84987aef`（本地 main == `origin/main`）。整树 `git status --porcelain` **25 条**
  （19 改 6 新），mtime 全落在 2026-11-04 16:27–16:47 一个连续窗口内。
- 那一批是什么：`specs/GlassPane_每日2026-11-04_发现台账.md` 第 5 节把候选 A–N 列成"未修候选"，
  而这 25 个文件恰好点名 A/C/D/H/I/J/L 那一族（三份新测试文件名带 `DailyRound20261104`，
  一份带 `daily-20261104-`，改的面在 `AXChannel/EvidenceStore/ProjectRegistry/glasspaned/main.swift`）。
  main 上没有任何一笔含这些字节 ⇒ **真没落地**，按提示词的口径这是本轮的待办而不是输入。
- 动手前第一件事：把 25 个文件与 `git diff` 快照到
  `/var/tmp/glasspane-main-check/20261105-priorbatch/`（`working-tree.diff` 的 sha256
  `7ccb3e9243c7bf8e81b4f274089bccffc3f4e32d0894bd6b872118711ac84de0`）——那是那一批字节的唯一回滚点。
- 环境：`df -k /Volumes/Eng-Dev` 开工时可用 22,532,140 KB ≈ 21.5 GiB（> 4 GiB 门槛）。
  跑完全部构建后是 16,964,828 KB ≈ 16.2 GiB。
- 工作树：`.worktrees/harness-advisory-20261103`（10:30 线，11-04 的台账已经把它判给那条线）与
  `.worktrees/harness-daily-20261104`（10:30 线在飞的活）。两条都不是本轮该清的，收口时原样留着。
- 本地分支：`backup-advisory-prerebase`、`gp-harness-advisory-20261103`、`gp-harness-daily-20261104`、
  `split/0.14.2` + `main`。前四条都属 10:30 那条线（含 `split/*` 搬运产物）；本轮一条都不删，
  判据见下面【收口清理】。
- 版本线：根 `package.json` = 1.29.1，`git tag` 最新 `v1.29.1`，registry 两包都读 **1.29.1**
  （`npm view glasspane-mcp version`、`npm view glasspane-install version` 实测）⇒ 三处一致，没有空号。

## 1. 上一轮那一批的复核实情：它自己带着两处"改过头 / 没做到"

复核不是走过场。两处都是拿真 shell 与真读容量出来的：

1. **候选 G 改过了头（P1）**。那一批把 `EngineCore.redactHome(...)` 也铺进了
   `RemedyCommand.quote(...)` 里面，于是出路句子印成 `chmod 700 '~/.glasspane'`。单引号里的 `~`
   不归 shell 展开。本机实测：`ls -ld '~/.glasspane'` 退 1 报 No such file or directory，
   同一条去掉引号退 0；`test -e '~'` 退 1、`test -e ~` 退 0。这一条对**每一个用默认状态根的装机**
   都失败，把 9 处命令位（`ProjectRegistry.swift` 的三个拒绝分支里）从"出路"变成了必然报错。
   本轮改回：散文折 `~`，命令位带真路径（与 `main.swift` 里 `--state-dir` 的既有约定同形），
   并由 `DailyRound20261105RemedyWordUsableTests` 用真 `/bin/bash` 把那条判据钉住。
2. **它要防的那件事没做到（P3）**。折主目录那一句写在 `ProjectRegistry.listing()` 的**兜底**里，
   而兜底只在 `unreadableReport == nil` 时走到；`loadFailed` 为真时 `unreadableReport` 恒不为 nil
   ⇒ 那是段跑不到的代码，真源那时原样把 `/Users/<账号>` 发进每一条拒绝。更细一层：
   `NSError.description` 把路径写在句子**中间**（`UserInfo={NSFilePath=/Users/…}`），
   `redactHome` 的 `hasPrefix` 够不着。修法：真源折 + 新增 `redactHomeWithin`/`described(_:)`
   折句子中间的出现在四处失败描述出口。
3. **候选 B 只改了一半**。实现改成 3 之后，`RegistryCliRefusalShapeTests` 里两条把旧号 1 钉成
   契约的断言当场红（本机 `swift test` 量到：`("3") is not equal to ("1")` × 2）。本轮改成新契约，
   并新增一条**跨命令同码**的闸：`--active-project` / `--project-remove` / `--evidence-stats` /
   `--prune-evidence --project` 四条对同一个未注册 id 必须同答 3，而表读不开那一档必须仍回 1。
4. **候选 D 只改了一半**（`ReconnectingSocketIo` 仍剪掉 `raw`），见 CHANGELOG 那条。
5. **候选 L 的夹具是空的**，因而藏住一条 P1（`??` 挡不住空串 → `--state-dir ""` 把真点名了根的
   那一枚遮住，回落到默认根）。换成真 `mkdtemp` 目录后当场红。
6. **候选 J 的夹具被一次落盘吃掉一枚空格**（`slug('安装 步骤')` 里其实是一个空格），
   改成 `' '.repeat(2)` 显式写出来。判据本身对了：用 GitHub 自己那一个 `github-slugger@2.0.0`
   实测（`"License & attribution" -> license--attribution`），于是闸如实报出 16 条**真死链**。

## 2. 本轮发现与处置（15 条，逐条有测试）

| # | 严重度 | 位置 | 失效模式（复核到的） | 修法 | 测试 |
|---|---|---|---|---|---|
| R-11 | P1 | `EvidenceStore.read` / `lastOnDisk` → `EngineCore` | 打不开／解不开／挂别人号都回 nil，`gp_last_evidence`/`diagnose` 念成 `GP_E_NO_EVIDENCE`；列不出目录念成"档案是空的" | `readFailure` 记理由；nil 且有理由抛 `GP_E_INTERNAL` + 出路；真缺席仍是 `noEvidence` | `testAnUnopenableEntryIsNotAnAbsentEntry`、`testACorruptEntryNamesItselfAsCorrupt`、`testAMisfiledEntryIsNotSilenceEither`、`testTheEngineRefusesToCallAFailedReadAnAbsence`、`testAnUnlistableArchiveIsNotReportedAsEmpty` |
| R-12 | P1 | `AXChannel.buildNode` + `observe` | 停在 `maxDepth` 那一档不留记号，空 `children` 被读成"没有子控件" | 回话带 `depthLimit`/`unexpandedAtDepthLimit`（从交回的树数） | `testNodesAtDepthCountsTheHorizon`、`testTheHorizonTravelsWithTheTree` |
| R-13 | P2 | `EngineCore.ownabilityDefect` | `.ownerAccountID` 缺席时 `?? -1` 既触发拒绝又印出 "owned by uid -1" | 读不出主人就说不出主人是谁 | `testNoOwnabilitySentencePrintsAFabricatedUid`（4 个真位置） |
| R-15 | P2 | `EvidenceStore.removeExpired` | 删除失败被 `(try? …) != nil` 吃掉：dry-run 10、真跑 7、`pruned: 7` 退 0 | `pruneFailures`/`pruneFailureTotal` + 载荷 `failed`/`failures` + 部分成功退 1；`clear()` 同半 | `testARefusedDeletionIsNamedNotSilent`、`testDryRunReportsNoFailuresBecauseItDeletesNothing` |
| R-10 | P3 | `ApprovalGate` | "文件不在"与"零条授权"逐字节相同 | 核验那一刻量的 `ledgerPresent` 随 `--approval-verify` 发出 | `testAbsentAndEmptyAreToldApart` |
| R-16 | P3 | `ProjectRegistry` | 上一轮的折主目录是死代码；账号名从错误描述里回来 | 真源折 + `redactHomeWithin`/`described` 四处出口 | `testTheUnreadableSentenceHasOneAuthorAndItFoldsHome`、`testDescribedFoldsHomeInsideTheSentence`、`testAPathOutsideHomeIsReportedVerbatim` |
| R-17 | P3 | `RecipeLoader` | `acceptedParamKeys[method] ?? []` 把表没covering念成"一个键都不读" | 与运行期同答（无规则即不判） | `testTheValidatorAndTheRuntimeAnswerTheSameWay`（逐 kind 两侧同答 + 表覆盖地板） |
| R-9 | P3 | `engine-client.ts` | `JSON.stringify(frame.error)` 原样进 stderr，与紧邻那句"正文不许写"矛盾 | 改用既有 `shortFieldValue` | `daily-20261105-reconnecting-transport-wire-bytes.test.mjs` 一侧覆盖 + 全量壳套 |
| R-4 | P3 | `io.ts` / `stdio-session.ts` | 注释声称"布尔没被丢掉、false 会被 gp_diagnose 读出来"，三样都不成立 | 分档写清：上限那一支计数、drain 那一支只报不记 | `daily-20261105-two-kinds-of-false.test.mjs`（2 条，含"不许记成丢"） |
| R-5 | P3 | 两份扫描型夹具 | 扫到空集合照样 `deepEqual([])` 绿 | 补条数地板，失败话术点名 | 同文件内，实测 `files()=16`、命令位 `=12`、schema `=8` |
| R-2 | P1 | `project-registry.ts` + `tools.ts` | 11 处 daemon 命令带空格没引号，照抄拿到 3 个词 | 整体双引号；闸补静态操作数那一面 | `remedy-shell-quoting.test.mjs` 新半面（去引号即点名 `src/project-registry.ts:315#1` 等） |
| R-1 | P1 | `installer/cli.js` | `verified` 只看退出码，不认钥匙；校验程序由被验的树选；分类靠会翻译的散文 | 钥匙必须对上钉死那枚；读不出即 `unavailable`；钉 locale 与 `gpg.program`/`gpg.format` | `daily-20261105-signature-key-id.test.mjs`（含真中文输出样本） |
| R-3 | P2 | `installer/cli.js` 四处文案 | 让用户 `git tag -v`，而那把钥匙在一次性环里、当场已删 | 四处共用 `isolatedVerifyCommand`，测试里真跑对 `v1.29.1` 回 0 | `daily-20261105-isolated-verify-remedy.test.mjs` |
| R-8 | P2 | `installer/cli.js` 三处 | `chmod`/`stat`/`openSync("a")` 跟叶子链接走，预置软链能让"已收成 0700"替另一棵树作保 | `leafSymlinkDefect()` 三处共用 + `O_NOFOLLOW` | `daily-20261105-state-root-symlink.test.mjs`（断言根外那棵树模式与内容一字未动） |
| R-18 | P1 | `updater/cli.js` `resolveStateRoot` | `??` 挡不住空串：`--state-dir ""` 遮住真点名了根的 `--state-root`，回落到默认根 `~/.glasspane`，绕过 `nonDefaultStateDir` 那道确认门 | 取第一个真给了非空值的；空白与没给同档 | `daily-20261104-slug-and-state-root-synonyms.test.mjs` 第三格（四档） |

**否证的一条**（复审说存在、回代码复核不成立）：`EngineCore.projectGet` / `pruneEvidence`
"会从读不开的表答 unknown projectId"。两条都先过 `requireRegistry()`，而它在 `loadFailed` 时已
拒绝（`EngineCore.swift:542-548` 那一支），`get()` 拿不到那一次读。故不修，也不列进未修。

**另一条不是缺陷的**：`http-gateway.ts` 对 daemon 的 remedy 跑 `forHttpCaller`（上一轮候选 F）。
读了实现与它依赖的 `FORWARDABLE_TOOLS`（那张表同时决定哪些路由存在），并核对既有三道闸
（`test/http-gateway.test.mjs:1082/1143/1236` 扫每一份响应体里不许残留 `gp_`），确认那是
"门面翻译"而不是"自行判定证据语义"：不给一条 404 的路线去指，改口成"这道门不暴露这个工具"。
候选 F 判**不成立**，判据是上面那三行闸的位置。

## 3. 门禁逐字命令的读数（1.30.0，全部 rc=0）

日志留在 `/var/tmp/glasspane-main-check/20261105/gates/`（每条一份完整日志，不 `tail` 之后下结论；
每条单独取 rc，不串 `&&`）。

| # | 命令（逐字） | 实际计数 |
|---|---|---|
| 01 | `npm ci` | rc=0 |
| 02 | `npm run build` | rc=0 |
| 03 | `npm test --workspaces --if-present` | mcp-shell 759 tests / 759 pass / 0 fail / 0 skipped；installer 348 / 345 pass / 0 fail / **3 skipped**；updater 809 / 809 / 0 / 0 |
| 04 | `node scripts/check-version.mjs` | rc=0，`OK：版本线一致（1.30.0）`（15 处派生位点 + 两枚 lock） |
| 05 | `node scripts/check-doc-links.mjs` | rc=0，`文档 32 份｜仓库内链接 274 条｜外链 44 条｜表格 470 张（扫 127 份 markdown，按 MD_SKIP_ROOTS 另跳过 69 份）` + 一行 `△` 归口 |
| 06 | `node scripts/check-workflows.mjs --self-test` | rc=0，48 case(s) each verified to fail（28 mutations caught / 20 legal shapes silent） |
| 07 | `node scripts/check-workflows.mjs` | rc=0，5 workflow file(s) clean |
| 08 | `swift build --package-path engine` | rc=0 |
| 09 | `swift test --package-path engine` | XCTest `Executed 1607 tests, with 5 tests skipped and 0 failures`；Swift Testing `Test run with 76 tests in 8 suites passed` |
| 10 | `swift test --package-path engine/probe` | XCTest `Executed 58 tests, with 1 test skipped and 0 failures`；Swift Testing `0 tests in 0 suites`（探针包没有 swift-testing 用例，这一格是空集不是绿） |
| 11 | `python3 -m pytest -q bridge` | `223 passed, 1 skipped in 10.39s` |
| 12 | `sh -n install.sh` | rc=0 |
| 13 | `cd engine && python3 .signal_smoke.py .build/debug/glasspaned` | `SIGNAL SMOKE OK`：SIGTERM/SIGINT 各自退出、码 0、两个 socket 文件 unlink（三次起停都在脚本点名的隔离根里） |
| 14 | `cd mcp-shell && npm run bundle && npm pack --dry-run` | `glasspane-mcp-1.30.0.tgz`，31 files，integrity `sha512-bY8TKtRQOT6WR…NlJlbnHISLkLg==` |
| 15 | `node harness/tools/tool-surface.mjs --check` | rc=0，`no growth past the recorded baseline`（面 A 13020 LOC / 分母 engine 67 files 33515 LOC，金样见 `chore(harness)` 那一笔） |

installer 那 3 个 skip 是 gpg/真发布 tag 那一族按既有 `commandAvailable` 口径跳过的（`--check` 与
`isolatedVerifyCommand` 的真跑那两条在直接 `node --test installer/test/` 时是跑的——本机 gpg 在，
实测 348/348 pass、0 skipped；在 `npm test --workspaces` 那一趟里 workspace 的 `test` 脚本参数不同，
计到 3 枚 skip。两条读数都记在这里，不挑好看的那一条）。

## 4. 真机读数（这台机器有登录会话，所以这些不是"标给别人"）

- `engine/.build/debug/glasspaned --state-dir <临时根> --permissions`：退 0，
  `{"accessibility":"granted","developer-tools":"unverifiable","input-monitoring":"granted","screen-recording":"granted"}`，
  `verdict: granted` 且 `verdictExcludes` 明写 developer-tools 不是这一条量的；stderr 那句
  note 明说 `--permissions` 不读状态、这个根没被 consulted。
- 面板（`.build/debug/glasspane-settings --state-dir <临时根>`）走 6 个页签，用自写的 Swift AX
  helper 读 AX 树：有 `AXIdentifier` 的控件 **88** 枚；读得出 `AXEnabled` 且为 false 的 **2** 枚，
  **每一枚都给了理由**（offenders 0）；`AXEnabled` 读不到的 **4** 枚单独报出，不折算成"可点"；
  `gp-daemon-age-retention` 在树上，那一行是
  `年龄闸读数（daemon）：not enforced by the daemon; --prune-evidence --older-than <days> is the only age path`。
- 面板读的是这台机器在跑的那枚 daemon，全程只读：`~/.glasspane/evidence` 条数走查前后各数一次
  **582 → 582**。
- 为了量到上面这些，修了两条一直坏着、没人跑的真机闸（详见 CHANGELOG 同名那节）。

## 5. 本轮我替你做了哪些决定（依据 / 回滚）

1. **取号 minor → 1.30.0**。依据：本仓 1.6.2 自己写下的判据里"patch 要求 CLI 载荷字段没动"，
   本版新增了三处载荷字段与一处面板可见行，另把同一个事实的退出码在两处统一。
   回滚：`git revert 881f4b9e`（release 那一笔）+ `node scripts/set-version.mjs 1.29.1`；tag 未打之前无对外影响。
2. **把上一轮那 25 个文件当成本轮待办，并按它原本的形状收口**（不另起一份实现）。
   依据：字节比对显示那正是台账里 A/C/D/H/I/J/L 那族，main 上无对应提交。
   回滚：快照在 `/var/tmp/glasspane-main-check/20261105-priorbatch/`，`git revert` 对应提交即可。
3. **候选 G 的命令位改回真路径，而不是把 `redactHome` 整个撤掉**。依据：真 shell 实测
   `'~'` 开不了；散文折主目录那条判据（11-03 #2）仍然成立。回滚：把那 9 处改回
   `RemedyCommand.quote(EngineCore.redactHome(x))` —— 但 `DailyRound20261105RemedyWordUsableTests`
   会立刻红，且那条命令在默认装机上跑不通。
4. **`harness/` 的一处失效锚点不动它，改成会自己过期的归口通道**。依据：提示词硬口径"不改 harness/
   内容或版本"，而 `release-artifact` 钉"已发布 fork tag == 主干子树"；同时提示词也禁止把发现
   留成"交给那条线"式的无主项。落地：`DEFERRED_FINDINGS`（逐字匹配、每轮打印、修好后反向红）
   + 把判据与两种修法写进 `tools/prompts/daily-glasspane-harness.md`。
   回滚：删掉 `DEFERRED_FINDINGS` 里那一条并把 `check-doc-links.mjs` 的 `deferredHit` 分档一并撤回
   （`git revert` 对应两笔即可）。
5. **面 A/分母的棘轮重记**。依据：+39/+281 全是本轮自己有意加的正确性字节，提交前整树干净。
   回滚：`git revert e73952cc`（金样那一笔），闸会重新红并点名同样那 6 个文件。
6. **`--prune-evidence` 部分成功改判退 1**。依据：与 `--project-remove` 的 `exit(gone ? 0 : 1)`、
   `--evidence-stats` 的 `listFailure` 同一条口径。回滚：`git revert` 该笔的 `main.swift` 那一处——
   但那样 dry-run 报 10、真跑删 7 又退 0 就回来了。
7. **`observe` 回话加两枚字段而不是给 `AxNode` 加字段**。依据：`AxNode` 的 Codable 形状被
   `TreeDigest.digest` 钉着，改它会改摘要口径（= 既有档案的摘要不再可复算）。
   回滚：删那两枚键（`unexpandedAtDepthLimit` 是纯派生读数，没有别的读者）。

## 6. 反向验证（先证明每条新闸能红，再谈修好的代码）

方法：把修复**逐条退回缺陷形状**（变异都写成能编译/能解析的形态），跑对应的具名用例，再按
备份恢复并用 `git status` 证明树回到提交态（备份在
`/var/tmp/glasspane-main-check/20261105/mut/`；恢复后 `git diff --stat` 只剩我自己那两份未提交的
改动）。每一行右边是"当场变红的具名用例"，不是"跑过了"。

| 破坏处（退回缺陷形状） | 具名变红 |
|---|---|
| `EvidenceStore.read` 的"打不开"那一支不再记 `readFailure`（改成 `_ = error`） | `testAnUnopenableEntryIsNotAnAbsentEntry`、`testTheEngineRefusesToCallAFailedReadAnAbsence` |
| `removeExpired` 把删除失败重新吃掉（只 log 不记数） | `testARefusedDeletionIsNamedNotSilent` |
| `--approval-verify` 的载荷里删掉 `ledgerPresent` 那一行 | `testAbsentAndEmptyAreToldApart` |
| `ownabilityDefect` 改回 `owner?.intValue ?? -1` | `testNoOwnabilitySentencePrintsAFabricatedUid` |
| `RecipeLoader` 改回 `acceptedParamKeys[method] ?? []`，并把 `.observe` 从表里删一枚（= 表不全时两门面分叉） | `testTheValidatorAndTheRuntimeAnswerTheSameWay` |
| `ProjectRegistry` 的出路命令位再包一次 `redactHome` | `testNoQuotedShellWordWrapsRedaction` |
| `http-gateway.ts` 把 `checked.issues` 裸着当 remedy | `daily-20261105-bad-params-both-doors` 的 ①（唯一作者）与 ③（不许裸 issues） |
| `ReconnectingSocketIo.connect()` 的转发改回只交 `line` | `daily-20261105-reconnecting-transport-wire-bytes`（生产链那一条） |
| `resolveStateRoot` 的取值改回 `dir ?? root ?? env…` | `daily-20261104-slug-and-state-root-synonyms` 第三格（空串遮住真根那一形） |
| 归口通道的过期反向红删掉（那条 `problems.push` 之前塞一句 `continue`） | `daily-20261105-deferred-findings` 的"③ 那一行不再发生时，闸反过来红" |
| `classifyTagVerify` 不再读签名钥匙（`signatureKeyIds(text)` 变成一枚空表） | `verified 的判据是"点名的钥匙"…`、`rc=0 + 别人的 key id = invalid…`、`那几趟 spawn 钉了 LC_ALL/LANG 与 gpg.program/gpg.format…`、`status-fd 那一形…` 四条具名红 |
| 面 A 棘轮本身 | `--record` 之前 `--check` rc=1 并逐枚点名 6 个文件与那个分母；`--record` 之后 rc=0 |

R-17 那条特别说明：单独把 `?? []` 放回去**不会**变红——表是全的，两个门面对四个 kind 仍然同答。
必须同时让表缺一枚（删 `.observe`），闸才点名 `observe` 那一 kind 红。这才说明这条修复真的在挡
"表不全时校验层替运行期编一句它没量过的断言"。只写"跑过了"不写这个，就是假装有反向证据。

恢复之后复跑：mcp-shell 那三份本轮新测试 = 7 tests / 7 pass / 0 fail；Swift 两份本轮新 suite
= 19 tests / 0 fail（全量读数见第 3 节 09 那一行）。

一次 CI-only 的红也照实记下：`daily-20261105-two-kinds-of-false` 第二条在 GitHub runner 上报
`Promise resolution is still pending but the event loop has already resolved`，本机因为旁边还有
句柄活着而过去了。根因在被测产品的正确设计里（writer 的看门狗计时器 `unref()`，一次 bounded
report 不该钉住进程），所以改的是夹具（`withLoopAlive` 自己留一环），判据一位没动。
