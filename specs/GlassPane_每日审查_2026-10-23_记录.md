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

## 3. 发现与修复（7 条，全部已修 + 有测试 + 已进 main + 随 1.20.0 发出）

台账正文在 `CHANGELOG.md` 的 `[1.20.0]` →「2026-10-23 追加」表（编号 77–81，接上轮 76 条往下排）。此处只记本轮的判据与实测：

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
- **81**（上轮 `8f881f7a` 把平台闸提到预检之前，ubuntu 泳道因此红 7 条，而那 20 笔从没推上去、CI 从没看过一眼）：
  这一条既不是泳道报的也不是读代码读出来的——是**本轮把 main 推上去之后 CI 自己红的**。判据是
  `gh run view --log-failed` 里那 7 行 `not ok` 与同一句 stderr（`这个产品只支持 macOS（本机 platform 不是 darwin）…`）。
  修法保持"两支各有一条会红的断言"，两支的分工写在 `installer/test/failure-exit.test.mjs` 与
  `installer/test/review-2026-10-09.test.mjs` 的头注里；`finding4` 那条真正的安全主张（HOME 缺失不许把状态根
  拼成 `./.glasspane`）提到分流之前先量，任何平台都不白过。
  教训与提示词第 5 条同源：**发在本地 main 而没并进 origin 的活，等于没收口**——上一轮连"CI 会不会红"这一问都没发生过。
- **82**（`install.sh` 在 macOS 的 UTF-8 locale 下死在全角括号前）：本机两条对照实测——`LC_ALL=C` 打印
  完整那句拒绝，`LC_ALL=en_US.UTF-8` 只留下 `install.sh: line 228: CLONE_DIR\xef: unbound variable`。
  既有端到端全部经 `spawnSync` 起脚本、而 runner 的 node 环境没有 `LANG`/`LC_ALL`＝C locale，那条
  吸字节的代码路径从没被执行过；第一声红同样来自 CI（`macOS node suites`）。修法：交付面 shell 里
  `$NAME` 紧跟非 ASCII 的一律加括号（install.sh 6 处、`engine/scripts/make-app.sh` 1 处、
  `tools/gpg-signing.sh` 4 处），闸分静态（任何平台都能红、扫**所有**交付 shell）与行为
  （把 `uname` 桩成 Darwin，ubuntu 也走得到；要求那句拒绝连后半句一起到达）。
- **83**（Swift 那条"三臂同号"的第三臂读 `kernel/dist/…`，而 `git ls-files kernel/dist` 为空）：本机
  `swift test` 全绿、CI 的 `engine (Swift)` 红——它量的是只存在于开发机上的旧副本，既不在检出里也不在
  发布归档里。那条臂搬到 node 侧（读 `node_modules/iterate-kernel/dist/decision-log-entry.js`，CI 每个
  泳道跑测试前都 `npm ci`），Swift 留两臂且两边都是 tracked 字节；三臂合起来一条没少。

### 本轮由 CI（而不是本机）发现的那三条说明的事

上轮那 20 笔从没推上去，所以"CI 会不会红"这一问从未发生。本轮一推，`root workspace gate`（ubuntu）、
`macOS node suites`、`engine (Swift)` 三格各红一片，合计 12 条红。判据不在本机的缺陷有三族：
非 mac 平台才走得到的分支（81）、UTF-8 locale 才会执行的代码路径（82）、只在检出里存在的字节 vs 只在
开发机上存在的字节（83）。下一轮的审查面应当各留一条泳道盯一族，而不是等 CI 报——本轮的六条泳道
全部因工具用量上限没交回结论（见 §2），这三族于是全靠"推上去让 CI 说"才现形。

反向破坏（本轮 11 发，每发都点名变红、按自带备份 + sha256 逐字核回）：

| 打在哪 | 具名变红的用例 | 核回 |
|---|---|---|
| `installer/cli.js` 超时也算缺席 | 探测超时不是"未找到"… / 第一次没答话、补一次答了＝可用… | `21d60bf468fb` |
| `installer/cli.js` 去掉宽预算补一次 | 第一次没答话、补一次答了＝可用… | 同上 |
| `installer/cli.js` 文案不分流 | 预检对"未能确认"说的是另一句话… / 接线… | 同上 |
| `installer/cli.js` 读数写成死 `[]` | 接线：探测没走完那一项必须记进 unverified | 同上 |
| `updater/lib/signature.js` 摘掉"没答话"那一档 | gpg 这一趟没跑完… / 接线：整条 gate… | `f15299998f2a` |
| 同上，只认 `undefined` 不认 `null` | 同上两条 | 同上 |
| 同上，detail 丢掉真跑出来的尾巴 | gpg 这一趟没跑完… | 同上 |
| `install.sh` 把 `${CLONE_DIR}（` 改回 `$CLONE_DIR（` | 静态那条 + 行为"目标目录已存在那句必须完整到达" | `d5013cab59a4` |
| `engine/scripts/make-app.sh` 塞进同一形状 | 静态那条（证明扫的面不止 install.sh） | `8d1f33f97a3a` |
| 扫描器改成也吃 `$(…)` | 对照那条（合法写法不许天天判红）+ 静态那条 | `c09756e21bea` |
| `kernel/schemas` 的 `maxLength` 改成 2049 | 内核验证器执行的上限，就是被钉语料里写的那个上限 | `0602f0bf0f2f` |
| 发布副本那条指向一个不存在的文件 | 捆进发布物的那份 schema 也是同一个数 | `e2eeb858beb8` |

其中两发第一版**没有打红**，都是"修复没有闸"的同一个形状，记在这里免得下一位再踩：
①`checkEnvironment()` 那格——本机这台健康机器上真值就是 `[]`，写死 `[]` 与它等价，补了注入接缝
（`probe`）的接线用例才成立；②`install.sh` 那句拒绝的后半句——在修好的树上删掉断言不红，改成在
**产品文案**上动刀（删掉"（用 …重试）"那一子句）才把那条断言变成承重的。

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

## 5. 发布链实测（两条通道都是本轮跑的）

| 格 | 读数 |
|---|---|
| `origin/main` 收口 | 逐笔推送至 `015ce89a`（v1.20.0 的 target），其后为 1.20.1 的三笔 |
| tag | `v1.20.0`（签名注解 tag，`git tag -v` 报"完好的签名，来自 jingzhao-l (sign-github)"，密钥 `0929EA31DF4F7429F63FC53189D88B1D043A1298`）与 `v1.20.1` |
| CI | run `39936652909`（`015ce89a`）十格全绿——这是切 tag 前的判据（`release.yml` 的 github-release 作业自己要求同 commit 的 CI 绿） |
| GitHub Release | `isDraft=false`、`targetCommitish=015ce89a…`、资产 4 件：`GlassPane-1.20.0.tar.gz`(3 887 748 B) / `.asc` / `SHA256SUMS-1.20.0.txt` / `.asc` |
| 归档自证 | `node scripts/make-release-archive.mjs --verify` → `703 entries, 3887748 bytes, all 20 declared commands and schemas present, no entry under harness/ / .iterate_decisions.md`；`tar -tzf … \| grep -cE "(^\|/)harness/"` = **0**；顶层目录唯一 `GlassPane-1.20.0/` |
| 签名核（gate 8 那条路径本机走一遍） | 一次性键环导入 `installer/cli.js` 导出的那份键 → imported 含被钉指纹；两份 `.asc` 的 `VALIDSIG` 都是 `0929EA31…043A1298`，`--verify` 退 0；归档 sha256 `519c0d21286519cc…` 与**被签名的**那行摘要相等 |
| npm | `--ref v1.20.0 -f mode=dry` 绿（run 39938892749）→ `--ref v1.20.0 -f mode=publish` 绿（run 39939277862）；`npm view glasspane-mcp version` = `1.20.0`、`glasspane-install version` = `1.20.0`，`@1.20.0 --prefer-online` 逐字同号，`npm stage list` = No staged packages |
| 端到端（归档装成用户拿到的样子） | 归档解出 → `mcp-shell` 内 `npm pack`（自带 HOME + 自带 cache，本轮教训）得 320 565 B → `npm i -g --prefix` 干净前缀 → 两个 bin 都是符号链接 → **前面不放 node** 直接 exec + stdin 一帧 `initialize` → `{"serverInfo":{"name":"glasspane-mcp","version":"1.20.0"}}`；`installer` 那份同样装成 `glasspane-install`，`--help` 退 0、未知参数退 2 |
| daemon 真机 | `engine/.build/debug/glasspaned --state-dir <临时根> --permissions` 退 0，回 `accessibility/screenRecording/inputMonitoring = granted`、`developerTools = unverifiable`（按设计恒未验证），`subject.binaryPath` 点名是那枚裸二进制；真 `~/.glasspane` 未被写 |
| 面板真机 | `engine/.panel_refusal_smoke.py` 退 0（读数见 `engine/smoke.md` 本轮那一节） |

1.20.1 只带缺陷 84（一条测试对照的修法）。为什么不把它塞回 1.20.0：那三格已经落地，
唯一路径是移动 tag 重发，而 npm 不接受同版本重发——移动 tag 会让 registry 上的字节与被 tag
的树永久不对应，那是本仓记过名的事故形状。两个 npm 包的字节与 1.20.0 相同（`files` 白名单里
只有 `dist`/`schemas`/`LICENSE`/`README`，没有测试文件），这一点是实测白名单得出的。

### 一条不算缺陷、但要写下来的观察

`a successful apply retires the sibling generations…` 在同一次负载下红过一次，隔离复跑绿（49/49），
且同一 commit 上 CI 的两格都判绿。按提示词的口径（负载造成的计时假红→隔离复跑，不改判据不加超时）
它记为**负载红**，不占缺陷计数。它与 84 的区别是可测的：84 在零负载下也能红（两条 pattern 同跑即红），
它不能——这条判据本身就是"能不能重复出现"，不是"看着像不像负载"。

## 6. 未观测项（只限物理边界）

- `npm stage approve`（需 owner 2FA）与 Apple 公证（需付费开发者账号）：见收口汇报的补救命令。公证仍是 owner 未启用决策，
  本轮不把它写成已完成。
