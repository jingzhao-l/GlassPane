# GlassPane 主仓 · 2026-10-27 每日任务收口台账

> 本文是本轮（项目 1：引擎 + MCP 壳 + 安装器 + 更新器 + LLDB 桥）的**新增**台账，
> 不改写 `specs/` 里任何历史结论。发版号 1.24.0；判据与逐条证据在 `CHANGELOG.md` 的
> `[1.24.0]` 一节，本文只记"本轮量到了什么、哪些说法从此不再成立"。

## 1. 开工时的工作树事实

- 开工 HEAD：`569307f0`（main == origin/main，`git status --porcelain` 为 0 行）。
- `df -k /Volumes/Eng-Dev`：可用 22 079 684 个 1024-block（约 21 GiB），无需清理。
- 上一轮没收口的活：**没有**。`git worktree list` 只有主树一条；本地分支只有
  `main` 与 subtree 搬运分支 `split/glasspane-harness`；远端只有 `origin/main` 与
  harness 线自己的 `harness/main`。版本线、tag、npm 三处在开工时互相一致（1.23.0），
  `node scripts/check-version.mjs` 开工即绿。

## 2. 本轮基线（改任何代码之前，逐字命令跑出来的数）

| 门禁 | 基线读数 |
| --- | --- |
| `npm test --workspaces --if-present` | mcp-shell 652 / installer 241 / updater 688，全 pass、0 fail |
| `swift test --package-path engine` | Executed 1424 tests, 4 skipped, 0 failures |
| `swift test --package-path engine/probe` | Executed 51 tests, 1 skipped, 0 failures |
| `python3 -m pytest -q bridge` | 152 passed, 1 skipped |
| `node scripts/check-workflows.mjs --self-test` | 22 case(s)（15 变异 + 7 合法形状） |
| `node scripts/check-workflows.mjs` | 5 workflow file(s) clean |
| `node scripts/check-doc-links.mjs` | 文档 32 份 / 仓库内链接 270 条 / 外链 44 条 / 表格 443 张 |
| `node harness/tools/tool-surface.mjs --check` | 面 A 16 文件 11973 LOC（22.02%）、面 B 229 文件（21.61%）、无增长 |

## 3. 本轮发现与终态（只允许一种终态：已修 + 有测试 + 已进 main）

审查面按五个泳道跑（Swift 引擎与 daemon / MCP 壳 / 安装器与更新器与 install.sh /
桥与 CI 脚本 / 面板 UX），另加一条安全信任边界泳道。发现的缺陷全部落成本轮的提交：

- `fix(installer)`：入口守卫（C1）
- `fix(installer)`：源码定位与每日时刻（C2、C3、C4、C5、C6）
- `fix(engine)`：快照身份、迟到出处、时长收口、bounds 认源（A1、A2、A3、A4、A5）
- `fix(scripts)`：一行式管道的可见性（D1）
- `fix(shell)`：body 时间上限、dimension 回音、代号家族（B1、B2、B3）
- `fix(bridge)`：可信通道、可观测预算、parse 处拒绝、会拒绝的桩（D3、D4、D5、D7）
- `fix(engine)`：统计卡的重试按钮、宽限期丢失、尺寸未测（E1、A6、A7c）

**被调查后判定"不是缺陷"或"不跟着改"的，全部留了判据而不是留了沉默**：

| 报告的说法 | 本轮的核对结论 |
| --- | --- |
| A3 的一半："beginWindow 之后抛出会漏一个开着的窗口" | 没有任何读者：`eventsEvictedDuringWindow` 只回 `Window.eventsEvicted`（开与不开都是这个字段的有无），`statusJSON` 不读窗口表，FIFO 淘汰按条数算、关不关都占一格。补 `defer` 是加一条测不到的分支，遂撤销该改动并在此记录。 |
| F1：`engine.sock` 对 TCC 那一组方法不做 peer 鉴权 | `SECURITY.md:432` 把"同用户即全权"写成设计意图；加代码签名校验是产品面变更，不是本轮的缺陷处置。 |
| F2：`assertion.actual` 在 schema 里没有 `maxLength` | 断言的实测值是证据本体，加长度上限会**伪造**被比较的值；冻结 schema 是 `oneOf [object, null]` 那类取舍的同一族。判为非缺陷，附此理由。 |
| F5：remedy 里让人 `launchctl kickstart -k` 重启 daemon | 注册表变更确实要重启才生效，那句话是可执行的、也是必要的；"会打断在飞的 act"由 `PermissionStatus` 那道人工门承担，不是 remedy 的责任。 |
| D6：`run_capture_cli` 的预算在同步 `LaunchSimple` 下管不住活着的 target（泳道标为 unconfirmed）| 需要 `GLASSPANE_REAL_LLDB=1` 的真机 lldb 才能确认；本机没跑，按未观测处理（见汇报第 ⑦ 项），不当作已修也不当作待办隐瞒。 |

## 4. 本轮改动的"承诺"影响面（为什么是 minor）

`glasspaned --evidence-stats` 在"有条目问不出尺寸"时从 exit 0 改答 exit 1；`diagnose` 回包新增
`operationId`；HTTP `POST /v1/tools/<name>` 回包新增 `dimension`（声明过时）与新代号
`GP_HTTP_BODY_UNREAD`（body 没读完时）；`updater enable --json` 回包新增 `agentSchedule`；
installer 的注册摘要新增 `scheduleMeasured`；面板证据页那颗按钮的名字与动作都变了。
npm 两个包的 `bin` 声明没动，但任一项都足以否掉 patch。

## 5. 棘轮与金样

面 A（`mcp-shell/src`）与分母（`engine`）都因本轮的有意增长而变红，按纪律走
`node harness/tools/tool-surface.mjs --record` 单独一条 `chore(harness)` 提交，正文点名长了多少、
为什么；`surface-semantics` 没有红（判定仍在 Swift：壳只把内核代号收进 message，不合成结论）。
`harness/` 的内容与版本一律不动。

## 6. 收口时的门禁复跑数（与第 2 节逐项对照）

见本轮最终汇报第 ③ 项；数字由命令当场量出，不沿用第 2 节的基线。
