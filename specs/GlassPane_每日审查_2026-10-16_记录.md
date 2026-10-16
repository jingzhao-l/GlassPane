# 每日审查记录 · 2026-10-16 · 主仓产品面（v1.16.0 → v1.16.3）

本轮是真源文件 `tools/prompts/daily-glasspane-main.md` 的无人值守每日任务。台账只新增不改历史
结论：这一节记录当日实测到的缺陷、发布链的实际状态、替 owner 做的决定与回滚方式，以及未观测项。
**同日出了三版**（1.16.0、1.16.1、1.16.3），中间那个 `v1.16.2` 是有解释的空号——见 §2。

## 1. 本轮量到的缺陷与处置（终态一律为"已修 + 有测试 + 已进 main + 随本版发出"）

| 组 | 条数 | 去处（判据所在，不用提交号——见 §4 的 rebase 说明） |
| --- | --- | --- |
| daemon 一次性 CLI（注册表读不开被说成"没注册"、编码失败回 `[]` 退 0、`--evidence-stats` 退出码、ffwd 复原伪造空 `operationId`、探针管道排空与分类次序、`--recipe-validate` 伪造 `valid`） | 6 | `engine/Sources/glasspaned/main.swift`、`GlassPaneEngine/DebugCapabilityProbe.swift` + `engine/Tests/` 各条具名用例 |
| 引擎判定与写侧持久化（`gp_act` 接受空 `selector.title` 与证据包 schema 相矛盾、fsync 落盘缺失） | 2 | `ParamValidation.swift`、新增 `DurableFileWrite.swift`，EvidenceStore/ApprovalGate/ProjectRegistry 三路接入 |
| 设置面板状态根（daemon 报的根没接回本页、四条一次性 CLI 各走各的根、GLASSPANE_STATE_DIR 那条处方指向一个 daemon 不读的变量、清理/删除在"根没被上报"时不拒绝） | 4 | `glasspane-settings/ConsoleModel.swift` + `ConsoleRootView.swift` + `Tests/GlassPaneEngineTests/ConsoleDaemonStateRootTests.swift` |
| MCP 壳（trail 来源注释没人读、退出相邻写共用一个 writer、空 socket 覆盖被当"没给"、发布物形状/库入口缺失、`projects.json` 写侧不耐久） | 5 | `mcp-shell/src/{audit-session,io,dispatch,index,stdio-session,project-registry}.ts` + `mcp-shell/test/{trail-provenance-surface,exit-adjacent-writes,socket-override-blank,published-artifact,project-registry-durability}.test.mjs` |
| 安装器（`install.sh` 的 ref 闸与 installer 不一致、clone 前不查 Node、三处 `id -u` 探针读不到 stdout 就当 0、拒绝替换 bundle 时仍宣称"本轮构建产物"） | 4 | `install.sh`、`installer/cli.js`、`installer/test/declined-bundle-verification.test.mjs` |
| 更新器（候选路径/子进程环境没有把 node 递下去、launchd plist 的 PATH、`.part` 令牌复用、丢弃失败不出声、归档读取的死分支、历史时间戳来源、`removeTreeWithin` 用递归 rm 把 EACCES 报成 ENOTEMPTY、**`mcpToolsList` 三处 `child.stdin.write` 无错误路由 ⇒ EPIPE 以 uncaughtException 打死常驻进程**） | 8 | `updater/lib/{apply,staging,mcp,fsutil,binaries,launchd,check,signature}.js` + `updater/test/child-spawn-environment.test.mjs`（EPIPE 两条 + 坏管道夹具） |
| kernel 镜像同步（`sync-kernel.sh --target=repo` 把镜像的 manifest 洗成 canonical 那份：包名/private/版本/依赖全被覆盖，且门禁当时看不出来） | 1 | `tools/sync-kernel.sh` + `updater/test/tools-sync-kernel.test.mjs`（真跑一次同步的沙箱 + 缺依赖必须拒绝且零写入） |
| 发布链（**没有任何一环问"被 tag 的那棵树跑过测试吗"** ⇒ `v1.16.1` 三格齐而 CI 红；CI-green 那两步在 Actions 里拿不到 `gh` 的身份 ⇒ `v1.16.2` 整版挡死） | 2 | 新增 `scripts/assert-ci-green.mjs`（14 条测试 + 真 API 夹具 + 两条真调用实测）、`.github/workflows/release.yml` 两步各带 `env: GH_TOKEN`，接线核对那条测试同时判 `actions: read` 与 `GH_TOKEN` |
| "写了但没人跑"的测试（`scripts/test/tools-gpg-signing.test.mjs` 4 条管 GPG 口令不进 argv 的安全守卫，自写下从未被任何门禁执行：根 `test` 只跑 workspaces，`scripts/` 不是 workspace，全仓 grep `scripts/test` 命中 0） | 1 | 套件移入 `updater/test/`（第一次跑就 4/4 绿），并新增 `updater/test/scripts-test-suite-is-run.test.mjs`：每条被跟踪的 `*.test.mjs` 必须落进某 workspace 的 test glob（5 条，三组反向撤销各自具名红） |
| 测试自己的坏对照（argv 记录器把"半条记录"当一次完整调用 ⇒ 既能假红也能假绿；滴流夹具的第一块等 2ms 定时器 ⇒ 只在负载下红；并发测试文件共用沙箱基目录而 `dispose()` 把它 rmdir ⇒ CI 报 `ENOENT mkdtemp`；信号自检的现场等待 5s 不够 ⇒ 把夹具没到位说成判据问题） | 4 | `ConsoleDaemonStateRootTests.swift`（新增按帧边界算账 + 一条不起进程的现场用例）、`updater/test/source.test.mjs`、`mcp-shell/test/support/sandbox.mjs` + 新 `mcp-shell/test/sandbox-helper.test.mjs`（5 条）、`engine/.signal_smoke.py` |
| 文档卫生（用 heredoc 追加真机记录时，包装脚本自己的 `EOF` / `echo "appended: $(wc -l <…)"` 被当成正文提交，同一形状中招两次，而 `check-doc-links` 全绿——它没有一判看正文里是否混进 shell） | 1（含 2 次实例） | 新增 `shellResidue()` 判据（只认 heredoc 结束标记与命令形状行，``` 围栏内一律豁免），5 条用例 + 四组反向撤销；两条残渣已从 `engine/smoke.md` 清除 |
| 棘轮/闸的自述与实测不符（本轮写在文件头的"反向变异清单"里有两条声称能红、实测零红：一条是重复的目录前缀判断，一条是"argv[1] 相对路径会让自执行判据永假"——实测 Node 交给 argv[1] 的已是绝对且折叠过的路径） | 2 | 两条连同对应冗余代码一起删除，注释改为写明实测结果；这一类教训进 `feedback-controls-must-be-able-to-fail` |

合计 **40 条**（含文档与测试自身的缺陷）。每一组的判据都在表里点名；没有一条留在"已知未修/
待补实现/下一轮再看"那种中间态。

## 2. 发布链当日实际走到哪一格（实测，不信任何文档里的数字）

| 版本 | tag | GitHub Release | npm（两个裸名包） | 备注 |
| --- | --- | --- | --- | --- |
| 1.16.0 | `v1.16.0` | 非草稿、四件资产齐 | 两包 `latest=1.16.0` 当时齐 | tag 切早了：随后 main 又落了 4 笔（壳里的 attribution 比较挪回引擎 + 三条测试平台前提） |
| 1.16.1 | `v1.16.1` → `4c58e9cb` | 非草稿、target 对、四件资产 + `.asc` 验得过 | 两包都读得到 `1.16.1`（发布后读副本滞后十几分钟才看得见，日志里 `+ glasspane-mcp@1.16.1` 确实在） | **同一 sha 的 CI 是红的**（run 38842800885，updater 那条 EPIPE）。发布物 = 被 tag 的树，但那棵树没被验证过 |
| **1.16.2** | `v1.16.2` → `6d53d2aa` | **没有** | **没有** | 新装的 CI-green 那一步自己把整版挡住：`gh` 在 Actions 里读 `GH_TOKEN`，runner 注入的是 `GITHUB_TOKEN`（run 38855034310）。方向是 fail-closed，所以没发出过未验证的字节。政策不删不移 tag ⇒ 留成空号 |
| 1.16.3 | `v1.16.3` → `cb1463bb` | 非草稿、publishedAt 07:27:19Z、target == tag commit、四件资产 | 两包 `@1.16.3` 与 `dist-tags.latest` 都等于 1.16.3（`--prefer-online` 实测）；两条 provenance 进了 sigstore（logIndex 3275715621 / 3275730672）；`npm stage list` 为空 | 发布凭据 = 该 sha 的 CI（run 38866240249 success）。归档自证：`--verify` 过，签名的 `SHA256SUMS-1.16.3.txt` 里那条 sha256 与 GitHub 资产 API digest 一致，`.asc` 用发布私钥验为"完好的签名（绝对）" |

**本地重算与 CI 资产字节不同**（本机 Node 26 + 最后一次 build 未重跑 bundle，归档里 `mcp-shell/dist`
的输入就不是一回事）。所以归档完整性一律走 **API digest + 签名链**，不拿本地重算当判据。

## 3. CI 的两条红，处置不同

- run 38862162240（sha `27cba9de`）：mcp-shell 段 `ENOENT … mkdtemp '.gp-test-sandbox/…'`。**真缺陷**
  ——并发测试文件共用基目录，`dispose()` 把它 rmdir 掉。已修，反向撤销具名变红两条，不依赖负载。
- run 38863836563（sha `ac32b2dd`）：installer 的 `install-honesty.test.mjs` 整文件报
  `Unable to deserialize cloned data due to invalid or unsupported version`，栈全在
  `node:internal/test_runner/runner`。按"红先隔离复跑再判"对同一 sha 重跑那一个 run ⇒ 该 job 转绿、
  整条 run success。记为 Node 20 runner 的 flake，**没有**为了让它绿而改任何判据。

## 4. 本轮替 owner 做的决定（依据 + 回滚）

1. **取号：1.16.0 走 minor，1.16.1/1.16.2(空)/1.16.3 走 patch。** 依据：patch 四条判据（状态文件字段 /
   退出码集合 / CLI 参数 / npm `bin`）逐条实测未动；minor 那一版动了用户可见行为（daemon 上报状态根、
   一次性 CLI 的拒绝形状、面板文案）。回滚：版本号不可"退发"，要回到旧行为就
   `git revert <对应修复提交>` 后另出一版；registry 上已发的号不撤。
2. **`v1.16.2` 留成空号而不是移 tag。** 依据：tag 是 `install.sh`/updater 的复现锚点，移动已发布 tag
   会让 npm 侧与 Release 资产指向不同字节，且政策写明不删不移。回滚：无需回滚；要消除歧义只能继续
   往前发版（已做，1.16.3）。
3. **CI-green 闸落在 `release.yml` 两条通道，并把 `actions: read`/`GH_TOKEN` 写进判据。** 依据：
   `v1.16.1` 那次的根因是链子上没人问 CI；`v1.16.2` 那次证明这一步必须失败而不是空过。
   回滚：`git revert` 该笔（工作流文件改动要走 SSH remote 推送）。
4. **棘轮（`harness/tools/tool-surface.mjs --check`）本轮两次 `--record`，都只为本轮自己的有意增长。**
   依据：面 A 增长来自新增引擎侧判定/写侧耐久化，与代码同批；未使用 `--record` 掩盖 surface-semantics
   的红，而是把那次比较挪回引擎那一侧。回滚：`git revert` 金样那笔即可回到旧基线。
5. **kernel 镜像重同步到 canonical（02699de / 0.1.7），不动 canonical 的脏工作树。** 依据：镜像落后
   会让 Swift 的 C35 腿对之后的契约全盲；canonical 归 iterate-skill 主仓，本轮用临时 worktree 读取。
   回滚：`bash tools/sync-kernel.sh --target=repo` 以旧 canonical 重跑，或 `git revert` 那笔同步。
6. **风险区文件动过（`engine/Sources/GlassPaneEngine/`、`glasspaned/main.swift`、
   `mcp-shell/src/tools.ts`、`.github/workflows/{release,ci}.yml`、`scripts/version-sites.mjs`）。**
   依据：缺陷就在那一层，跨层修就是半修；每处的判据见 §1 表内列出的文件。回滚：逐笔 `git revert`。
7. **并行会话正在飞的批次一律没动。** 主工作区 `main` 上另有 harness 线未提交的批次与它推上去的
   0.8.0 那一轮；本轮三笔修复因此被 rebase 到合并后的 main 上（**旧 hash 不再存在**，所以这份台账
   与 CHANGELOG 都不按提交号指代它们）。回滚：不涉及。
8. **`--force-with-lease` 全程没用过。** 每次推送后核 ahead/behind；被挡的两次都是 `git rebase` 解决，
   没有覆盖任何远端内容。

## 5. 本轮未观测项（只限物理边界）

| 项 | 为什么本机跑不了 | 补上它的确切动作 |
| --- | --- | --- |
| `npm stage approve`（若哪天 trusted publisher 改回 staged-only） | 需要 owner 的 2FA | 本轮**没走到**这一分支（两包均直发成功，`npm stage list` 为空）。将来出现时：`npm stage list` 取 stage-id → `npm stage approve <stage-id> --provenance` |
| Apple 公证（`.app` 的 notaryTool 票据） | 需要付费开发者账号 | `xcrun notarytool submit GlassPane-<ver>.tar.gz …` 需要账号；本轮发布物不含公证，面板与 daemon 走本机自签构建 |
| 面板跨根采纳（daemon 报来的根 ≠ 面板算的根）那条端到端 | 需要一个**非默认根**的常驻 daemon；本机只有默认 `~/.glasspane` 的在跑实例，起第二个会去动真档案 | 人工：`glasspaned --state-dir <临时根>` 起一个非默认根实例，再在面板项目页看页脚是否写"服务端的根 \<path\>"。判据与假绿形状都写在 `ConsoleDaemonStateRootTests` 与 `engine/smoke.md` §4 的"未观测"那一行 |

## 6. 这份台账自己在哪一棵树里

`v1.16.3` 的 tag 切在本文件写入**之前**（tag → `cb1463bb`，签名归档由那次 tag push 的
Release run 38867271592 产出）。所以 `GlassPane-1.16.3.tar.gz` 里**没有这份文件**——它随下一版
发出。这一条写在这里而不是省掉，是因为"发布物等于被 tag 的树"这条判据本轮已经用它打过两次脸
（1.16.1 与 1.16.2），不能到自己这里就默认例外。代码、测试与工作流改动全在被 tag 的那棵树里；
离树的只有这份记录与本节。
| 真机无障碍/屏幕录制类交互（`gp_act` 在真实 app 上的点击） | 需要登录 GUI 会话与已勾权限；本轮权限读数确认为 accessibility/screenRecording/inputMonitoring 均 granted，但真机 act 走的是另一条验收（`engine/.p4i4_smoke.py` 已跑，退 0） | 无需人工：已跑。仅"面板跨根采纳"一项留作上表第三行 |
