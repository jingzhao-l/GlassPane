# GlassPane 主仓 · 每日审查记录 2026-10-23

本轮为无人值守每日任务（真源 `tools/prompts/daily-glasspane-main.md`）。

开工实测（判据只用文件字节，不引任何文档里的数字）：

| 读数 | 值 |
|---|---|
| HEAD | `2d7b4596b6984b6917bdeb33107bc277e02ac903`（本地 main） |
| `git status --porcelain`（整树） | 一条：`?? engine/.panel_refusal_smoke.py` |
| `git rev-list --left-right --count origin/main...HEAD` | `0 20` —— **origin 侧 0 笔独有，本地 20 笔未推** |
| `git ls-remote --tags origin` 最新 | `v1.19.0`（远端无 `v1.20.0`） |
| `gh release list` | 最新 `GlassPane 1.19.0`（Latest） |
| `npm view glasspane-mcp version` / `glasspane-install version` | `1.19.0` / `1.19.0` |
| 根 `package.json` version | `1.20.0` |
| `df -k /Volumes/Eng-Dev` | 9 326 224 × 1024 B ≈ **8.9 GiB** 可用，高于 4 GiB 底线，未清理任何可再生物 |

快照（本轮唯一回滚点）：`/var/tmp/gp-daily-20261023/snapshot/worktree-now.tgz`（改动落盘前的整树，排除
`node_modules`/`.build`/`.external`/`harness`），`head-before.txt` = 开工 HEAD。

## 1. 上一轮没收口的活

上一轮（2026-10-22）把自己的 20 笔提交留在**本地** main 上就断了，其中含 `release: 1.20.0`（`c98fce5e`）：
tag、GitHub Release、npm 两格一个都没发生（见上表那四行实测）。按提示词第 2 步口径，这不是本轮的输入，
是本轮的待办——本轮把它推完、发完，并在发之前补上本轮审出的 4 条修复（版本号不动，仍 1.20.0；
判据与依据写在 `CHANGELOG.md` 的 `[1.20.0]` → 「2026-10-23 追加」那一格）。

那条未跟踪的 `engine/.panel_refusal_smoke.py` 是上轮为 `9402f52a`（面板不再 exec 后台服务自报的路径）
写的**真机闸草稿**：它从未被跑成过（第一次读 AX 树就 `TypeError` 崩，崩溃码与它自己的"断言失败"同一格）。
本轮修完它、在本机真机跑通、随代码提交，读数见 `engine/smoke.md` §本轮那一节。它属本线，不属"别人正在飞的批次"。

分支盘点与去向见本报告末「清理盘点」；判定一律用内容：`gp-dimslot`、`gp-sc5-rebased` 两条（含其 worktree）
实测是 `HEAD` 的祖先（`git merge-base --is-ancestor` 两支皆真，`git log HEAD..<b>` 为空）→ 已落地；
`gp-harness-sc5-fork-20261020`（3 笔）不属本线（`gp-harness-*`，harness 那条 10:30 的线），本轮不删。

## 2. 审查面（如实：这一轮窄于上轮）

按提示词第 1、2 步，先派六条只读泳道（引擎核心 / 面板与探针 / MCP 壳 / 更新器与安装器 / 门禁脚本与 CI 与桥 / 跨语言契约对账）。
**六条全部在交出结论之前撞上 subagent 工具用量上限**，`status=failed`、result 只有一句话，一条都没交回发现。
因此本轮的发现来自：

- 门禁基线复跑自己撞出来的两处红/跳（缺陷 77、78）——跑闸跑到红的地方就是缺陷现场；
- 主代理对高信任边界文件的逐行读（`updater/lib/signature.js` 全文 550 行 → 缺陷 79；`install.sh` 全文 296 行 → 无发现；
  `updater/lib/apply.js` 与 `source.js` 的摘要/落盘路径做了针对性 grep 复核 → 无发现）；
- 已知缺陷形状扫描（空 `catch`、Swift `try?`、`tar | grep -q`、workflow 里的 `|| true`、版本线之外的字面量）；
- 上轮遗留草稿的真机执行（缺陷 80）。

**没覆盖到、下一轮该覆盖的面**（本轮不冒充已审）：`engine/Sources/GlassPaneEngine/` 其余大文件的逐行审
（本轮只做了形状扫描与两处定点读）、`mcp-shell/src/http-gateway.ts` 与 `engine-client.ts` 的逐行审、
`updater/lib/apply.js`（2210 行）的逐行审、设置面板逐控件的"控件↔daemon 能力"对账（本轮只跑了拒绝路径那一条真机走查）。

## 3. 发现与修复（4 条，全部已修 + 有测试 + 已进 main + 随 1.20.0 发出）

台账正文在 `CHANGELOG.md` 的 `[1.20.0]` →「2026-10-23 追加」表（编号 77–80，接上轮 76 条往下排）。此处只记本轮的判据与实测：

- **77**（`updater/test/release-archive.test.mjs` 共用用户全局 npm 缓存）：红是本机复跑闸时自己撞出来的
  （`exit=1`，`AssertionError: npm error code EACCES … _cacache/index-v5/19/4f … 243 !== 0`）。
  定因用两次实测对照：整套件红、单跑这条绿（`node --test test/release-archive.test.mjs` 16/16），
  且 `find /Users/ethanlin/.npm -user root` 数出 6 条 root 属主目录——命中与否取决于并发顺序，
  这是"一条测试依赖用户缓存此刻恰好干净"的形状。修法与仓内已有的两处同法（不是我发明的第四种写法）。
- **78**（`commandAvailable()` 把探测超时说成"未找到"）：判据依赖的两个外部事实都用真进程钉住——
  `spawnSync('/bin/sleep', …, {timeout:300})` 报 `status:null` + `error.code:'ETIMEDOUT'`，
  不存在的命令报 `error.code:'ENOENT'`。跳过条款收紧为只认真缺席后，原先被跳过的正向分支在本机真的跑起来了
  （`installer` 套件 197/196/**1 跳** → **205/205/0 跳**）。
- **79**（gate 8 把"没跑完"判成 `invalid`）：根因用安装器自己的函数复现——
  `classifyTagVerify({status:null})` 回 `invalid`，`classifySignature` 照抄了这个词。
  新用例把这一事实钉成对照（"不许让读者以为签名被判过"）。
- **80**（真机冒烟草稿从未跑成）：五项缺陷逐条修，本机真机 **PASS**（面板拒掉自报路径、点名它、证据档案页仍停在
  「还没向后台服务问过」）。判据不再是抄来的名词，而是从渲染它的那一行 Swift 里读出来的。

反向破坏（本轮 7 发，每发都点名变红、按自带备份 + sha256 逐字核回）：

| 打在哪 | 具名变红的用例 | 核回 |
|---|---|---|
| `installer/cli.js` 超时也算缺席 | 探测超时不是"未找到"… / 第一次没答话、补一次答了＝可用… | `21d60bf468fb` |
| `installer/cli.js` 去掉宽预算补一次 | 第一次没答话、补一次答了＝可用… | 同上 |
| `installer/cli.js` 文案不分流 | 预检对"未能确认"说的是另一句话… / 接线… | 同上 |
| `installer/cli.js` 读数写成死 `[]` | 接线：探测没走完那一项必须记进 unverified | 同上 |
| `updater/lib/signature.js` 摘掉"没答话"那一档 | gpg 这一趟没跑完… / 接线：整条 gate… | `f15299998f2a` |
| 同上，只认 `undefined` 不认 `null` | 同上两条 | 同上 |
| 同上，detail 丢掉真跑出来的尾巴 | gpg 这一趟没跑完… | 同上 |

第四条（`M4`）第一版**没有打红**：`checkEnvironment()` 在本机这台健康机器上真值就是 `[]`，写死 `[]` 与它等价。
补了一条注入接缝（`probe`）的接线用例之后才成立——形状与上轮记过的"修复没有闸"是同一个，记在这里免得下一位再踩。

## 4. 决定与依据（无人值守下由本轮代决）

1. **不取新号，把修复压进 1.20.0 再发**。依据：1.20.0 从未进过任何发布物（上表那四行实测），
   把它拆成"先发 1.20.0 再发 1.20.1"会让一份从没被装过的号占掉两个版本位、并让 GitHub 上出现一次没有消费者的发布。
   回滚：`git revert` 本轮提交即回到上轮末尾；`v1.20.0` 若已发出则用 `git push origin :refs/tags/v1.20.0` 撤 tag（不删历史）。
2. **`checkEnvironment()` 多一条 `unverified` 读数**（对外导出的契约变化，属"契约是否升级"那一格）。
   依据：布尔只承载"可用/不可用"两档，而"没答话"与"没有"给人的下一步动作不同；不加读数就只能撒谎或加联合类型。
   `daily-20261022-preflight-claim.test.mjs` 那条"一个不多一个不少"的闸随之把 `unverified` 明确列为**读数**而非命令，
   并新增一条"读数里不得冒出非命令名"的断言——没有放宽它。回滚：撤 `installer/cli.js` 与那两个测试文件即可。
3. **"没答话"落在 `signature-tool-missing` 而不是 `invalid`**。依据：两档都不许自动通过；差别只在人说出来的理由与
   是否可由人带记录继续。把它留在 `invalid` 等于宣称"签名与键不符"，那是无证据的主张。回滚：撤 `updater/lib/signature.js` 那一档。
4. **面板真机走查补跑并记档**（`engine/.panel_refusal_smoke.py`）。依据：提示词写明真机项属"你能做就做完"，
   这台机器有登录 GUI 会话与已勾权限，实测确实读到了 AX 树（72 + 44 个元素）。
5. **不动 `harness/`、不动 `kernel/` 契约**。依据：本轮 4 条缺陷都长在本仓产品面，没有一条需要改跨语言契约；
   `harness/` 有 10:30 那条独立线。面 A 棘轮本轮无需重记（`--check` 读的是 `mcp-shell/src` 与 fork，两处都没动）。

## 5. 未观测项（只限物理边界）

- `npm stage approve`（需 owner 2FA）与 Apple 公证（需付费开发者账号）：见收口汇报的补救命令。公证仍是 owner 未启用决策，
  本轮不把它写成已完成。
