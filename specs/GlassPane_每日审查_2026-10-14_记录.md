# 每日审查记录 · 2026-10-14 · 主仓产品面（v1.15.0）

> 本文件是**新增的本轮记录**，不改写任何历史结论。历史台账（`GlassPane_Audit_2026-09-22_*`、
> `GlassPane_P5_*` 等）里被本轮推翻或落实的条目，在下面按"条目 → 本轮实测结局"列出，
> 原文一字未动。

## 1. 本轮量到的缺陷与处置（46 条，全部当轮修完）

| 组 | 条数 | 去处 |
| --- | --- | --- |
| 引擎判定/证据归属（`GlassPaneEngine`、`glasspaned`、探针） | 17 | 提交 `0b4efde`、`81b3c9e` |
| 设置面板（指错目录、冒充测量、藏控件、点了没反应） | 7 | 提交 `0b4efde`（面板侧半） |
| MCP 壳契约（假的能力漂移告警、被截断的处方、信号抢回包） | 7 | 提交 `d252f4f` |
| 安装/发布链（HOME、口令进 argv、npm ci、验签门、可预测临时路径、eval 拆词） | 8 | 提交 `21053d6` |
| 文档主张 vs 代码（含 `check-doc-links` 自身的 5 处盲区） | 11 | 提交 `2d6ef2f`、`350b1e6` |
| 安全（socket 祖先目录隔离） | 1 | 提交 `0b4efde` |

判据口径：每条都要有能红的对照，且"能红"由本轮亲自反向破坏验证——反向破坏的清单与结果写在
`CHANGELOG.md` 的 `[1.15.0]` 条目与各提交正文里。

## 2. 历史台账条目的本轮结局

| 台账条目 | 本轮实测结局 |
| --- | --- |
| `Audit_2026-09-22` B-17：`RestorePipeline.verifyStateDigest` 只被测试调用、活路径从不调用 | **已修**：接进 `RestorePipeline.validate` 第 6 条；被改写负载的探针产不出计划。接线时把 P5 那批用占位摘要 `dddd…` 的夹具正确地拒绝，夹具改为算真摘要，并新增具名篡改检出用例 |
| `Audit_2026-09-22` 行 D：`EngineLog` 把 ERROR 与 INFO 一起被 `--verbose` 管住 | **已修**：ERROR 恒发（发布形态恒为 quiet，处方"去看 daemon log"此前指向一条产品从不写入的流）；顺带把 `CGEventInputMonitor` 的"tap 重新武装成功"从 error 降回 info |
| P6 §8 H7 / `testWhatTheProbeReallyReportedSurvivesAnUndeliveredCommand`：到达的 state 帧一律是"它自己的测量" | **判据被推翻并改写**：`z2-mirror` 帧是一次*差值*，其"前值"来自 `op_begin`。窗口从未打开时它测的是上一个 act 的区间，把它记在本操作头上是错归因（还会升 `.strong`）。现在只撤 mirror 帧、KVO/宏帧照留，正反两条用例分别钉住 |
| `smoke.md` 记的"面板同屏显示两个状态根" | **已修**：`hello` 从本版报 `stateRoot`，面板页脚写"服务端的根 \<path\>"或"状态根未上报"（旧 daemon 不报时不替它填）；`ConsoleModel.displayedStateRoot` 从无读者变为被项目页文案读取。真机核对：隔离 `--state-dir` 的 hello 回包含该键；面板对旧 daemon（1.6.2）显示"状态根未上报" |
| `smoke.md` 第 6 行要求 `schemaVersion="glasspane.evidence/0.1-draft"` | **已修**：写入端发的是 `glasspane.evidence/0.1`，draft 仅读取端兼容；照旧流程跑必得一次假 FAIL |
| `daily/main-20261011` 那轮"开发者工具卡的拒绝优先于或值" | **半修已补全**：当时只改了权限卡，`--check-developer-tools` 的退出码仍读或值——同一份负载对 agent 回 0、对人是"被系统拒绝"。现在一面一判 |
| `glasspane-daemon-project-write-commands-missing`（GUI 控件必须指得到 daemon 真命令） | 本轮同一类又抓到四处：台账按钮开 home 默认目录、项目页开共用档案、清理入口被本地计数藏着、菜单「打开设置面板」只前置已存在的窗口。全部修完 |

## 3. 本轮我替 owner 做的决定（依据 + 回滚）

1. **取号 1.15.0（minor）**。依据：面板新增/恒显示的用户可见控制件、`hello` 与两个工具响应新增
   字段；退出码集合与 CLI 开关集合未变。回滚：`node scripts/set-version.mjs 1.14.1` +
   `git revert` 发布提交。
2. **`--prune-evidence` 读不到档案时由退 0 改为退 1**。依据：`--help` 对 1 的定义与
   `--list-projects`/`--project-prune` 对同一条件的既有判据。回滚：`git revert 0b4efde` 中该 hunk。
3. **无基线窗口只撤 `z2-mirror` 帧而不是整个 `stateDiff`**。依据：KVO/宏帧不依赖窗口命令，
   一刀切会把真证据丢掉（新增的反例用例就是为此存在）。
4. **`verifyStateDigest` 选择"接进活路径"而不是删除**。依据：P5 §6.3 与审计 B-17 都把它记为
   契约要求；删除等于抹掉一条已声明的防篡改面。代价如实记在下面第 6 条。
5. **安装器的"ref 找不到"从静默跳过改为 announce 而不是拒**。依据：`--repo <本地树>` 与
   `GLASSPANE_REF=main` 是文档在用的路径，拒会打断受支持的安装；但"没验签"必须说出来。
   形状不安全的 ref 才是拒（选项注入）。
6. **`harness/` 一行未改，唯一例外是棘轮金样 `harness/contracts/tool-surface.json` 的补记**。
   依据：面 A 因本轮 mcp-shell 的有意增长转红，政策允许的唯一 harness 动作是 `--record`；
   增长逐文件归因与"金样里 kernel 字段从 0.1.6 抄成 0.1.7 是 main 上已有事实"都写在那笔提交
   正文里。
7. **README 的两处 clone tag 升级为 `set-version` 位点**。依据：文档自己写着"请对着 install.sh 核"
   而没人核，实测漂移到 v1.11.0。副作用如实记录：本轮取号时 `check-doc-links` 立刻抓到
   SECURITY 的"当前版本线"行过期——这正是该闸应有的行为，也说明位点/主张进了同一条链。
8. **ITERATE.md 里写死的"位点个数"删掉**。依据：那个数字上一版写 9、实测 10、本轮 12，
   写死它本身就是每轮红一次的缺陷。

## 4. 本轮未观测项（只限物理边界）

- **`npm stage approve`**：需要 owner 的 2FA，agent 无法完成。若本版落到 staged publish，
  补救命令写在最终汇报最上方。
- **Apple 公证（Developer ID + notarytool）**：owner 未启用付费账号，仍是决策而非遗漏；
  本轮没有把它写成已完成。
- **面板「打开设置面板」菜单项的真机点击**：本轮以截屏 + AX attach 核对了面板渲染与
  "状态根未上报"读数，但 `MenuBarExtra` 菜单项本身没有被 AX `kAXPressAction` 按到——
  这台机器上正在跑的 daemon 是已安装的 1.6.2 bundle，它对本轮新构建的 bundle 读 AX 树时回
  `GP_E_AX_UNAVAILABLE`（kAXError -25200）。补上它需要的人工动作：把本轮产物装成
  `~/Applications/GlassPane.app` + `GlassPane Daemon.app` 并 `launchctl kickstart -k
  gui/$(id -u)/com.glasspane.daemon`，再按 `gp-*` 标识走一次 `kAXPressAction`；
  本轮没有替换 owner 机器上正在使用的安装与 launchd 作业（那是可被别人看见的共享状态变更）。

## 5. 补记（同日 v1.15.1）

上表"46 条"之外，收口前复核又清掉三条未落地项，并把一处**面板对未落盘追加亮绿灯**的诚实性缺陷
一并修掉，随 **v1.15.1** 发布（判据、反向破坏与版本判断见 `CHANGELOG.md` 的 `[1.15.1]`）：
台账"签名链完整"此前只读文件校验，而 `persistFailed` 出不了正在服务的 daemon 进程；
现在 `hello` 自报、探针读回、审批页标题与灯色同时读两半。

发布实测：Release `v1.15.1` draft=false、target=`94ad3ae`；归档本地 sha256
`f6065a70…180eb` 与 GitHub API 的 `assets[].digest` 逐字相同，608 entries，
`grep -cE "(^|/)harness/"` = 0；registry 两包 `--prefer-online` 与 `dist-tags.latest` 均为
`1.15.1`（`glasspane-install` 第一次查询报了一次瞬时错误，重查即中——是读副本延迟，不是没发出去）。
