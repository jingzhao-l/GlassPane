# 每日审查 2026-11-09 · 发现台账（发现 4 / 修复 2 / 否证 2 / 未修 0）

> 真源提示词：`tools/prompts/daily-glasspane-main.md`。范围＝主仓产品面；`harness/` 不审查不改版本
> （只按纪律为 tool-surface 补记基线，单独一条 `chore(harness)` 提交）。本轮发 **1.31.2**（patch）。

## 0. 开工时读到的状态（判据是文件字节，不是分支名/提交信息）

- 开工 HEAD `88b659ca`，`git status --porcelain` 空（0 条）——上一轮 11-08 已完整收口。
- `git fetch origin --prune` 后：无 `origin/daily/main-*`、无 `daily/*` 本地分支，本线无未落地遗留。
- 两个 worktree 都属 10:30 那条 harness 线（`.worktrees/harness-daily-20261106` 带 1 个未提交文件、
  `.worktrees/harness-integrate-20261107` 干净），分支前缀 `gp-harness-*`——**不是本线遗留，不碰、不代提交**。
- 版本线三方实测一致（开工即 1.31.1）：仓库 `check-version` 20 位点全 1.31.1、`git tag -l` 最高 `v1.31.1`、
  `npm view glasspane-mcp/glasspane-install version` 均 1.31.1 ⇒ 1.31.1 已完整发布，本轮另取号。
- 开工环境：`df -k /Volumes/Eng-Dev` 可用仅 **1.4 GiB**（< 4 GiB 门槛）⇒ 清 `engine/.build`（673 MB）
  腾到 2.2 GiB 再开工；npm cache 属 root 需 sudo，未清（构建 + 重装复跑都成功，未触发 ENOSPC）。

## 1. 本轮发现 → 处置（4 条：2 修 / 2 否证）

本轮用 **3 个并行只读审查代理**（正确性 / 安全信任边界 / UX+能力缺口），**每条主张都回文件字节复核**
——高危结论几乎全部被否证，与 11-08 那轮同一形状。

| # | 发现（代理报的） | 复核 → 处置 | 证据 |
|---|---|---|---|
| 1 | UX：两枚忙碌态变灰按钮缺 `.accessibilityHint` | **成立（P2），已修** | 本机量 17 处 `.disabled(`，修复前仅 `SettingsPanelView`"验证调试能力"、`RecipesTabView`"校验"两枚裸着，其余 15 处都带 hint ⇒ 违反产品既有约定。补各自忙碌/可用两种措辞的 hint |
| 2 | 正确性：`engine-client.ts:513` 注释把 kernel schema 说成工具表"第三真源" | **成立（P2），已修** | `grep gp_ kernel/schemas/` 零命中（工具表随 `iterate-kernel` 进 npm 包）。改注释为"两边不是三边"，点名工具面数目真由 `test/tools.test.mjs`(16) + `test/shell-2026-defects.test.mjs` 钉住 |
| 3 | 安全：`engine.sock` 无 peer 鉴权、缺成文 invariant | **否证** | `errors.ts:101` + `SECURITY.md` 已有"same uid = full authority"成文 invariant，`GP_E_SOCKET_TRUST` 是壳侧信任根判据；探针 peer auth（`ProbeSocketServer.helloRejectionReason`）是**额外纵深**，非 engine socket 缺失判据。两者不冲突 |
| 4 | 安全：registry 隔离要等下次 daemon 启动才修 0700 | **否证** | `saveProjects` 每次写都跑 `tightenMode(dir,0700)` + `nearestExistingAncestor` owner/world-writable 检查（`project-registry.ts:940`、`:1621-1637`），不是"等修" |

**无 P0/P1**：GUI 控件↔daemon 能力无缺口（每个按钮都指到真实 daemon flag 或 model 方法）、CLI 32 开关
与退出码表与 `exit()` 站点全对、更新器三道 consent 门各自给得出动作、工具面三处计数一致
（daemon `hello.capabilities` 11 = 壳 `DAEMON_FORWARDED_METHODS` 11，壳总 16，name-for-name）。

## 2. 修复明细（2 条，随 1.31.2 发出）

- **#1 两枚按钮补 hint**：`SettingsPanelView.swift`（验证调试能力）、`RecipesTabView.swift`（校验）。
  既有 11-04 那道闸（`DailyRound20261104PanelReasonAndPathTests`）判据是"有 `.disabled` **且有 `.help`**
  ⇒ 要 hint"，对这两枚 never-had-a-help 的站点**自始空转**——这正是它们能绿着藏到今天的原因。
  新增 `DailyRound20261109DisabledA11yTests`，判据放宽为"有 `.disabled` ⇒ 要 `.accessibilityHint` 或
  `.help`"，链取法多处理两个盲区（多行实参续行、hint 与 `.disabled` 间隔的注释行）。
  开发期两次判据写错（先报 4 处假阳，根因是 up-walk 遇注释/续行断链），改用缩进判断后 python 复刻
  归零再落 Swift。
- **#2 注释纠偏**：`mcp-shell/src/engine-client.ts` `describeCapabilityDrift` 头注释。纯注释，无行为变化。

**反向验证**：摘掉 recipe 校验按钮的 hint ⇒ `testEveryDisabledControlTellsAXWhy` 具名红点名
`RecipesTabView.swift:188`；恢复后 2/2 复绿。快照存 `/var/tmp/glasspane-main-check/backup-20261109/`。

## 3. 本轮我替你做了哪些决定（依据 / 回滚）

1. **取 patch 号 1.31.2**。依据：本轮两条修复都是 P2——面板 `.accessibilityHint`（内部读屏文案，非 CLI
   参数/非对外 `gp_*` 返回形状）、一条 TS 注释、一道新增面板闸（`engine/Tests/`，不进 engine src 分母）。
   四条判据（状态文件字段/退出码集合/CLI 参数/npm `bin`）一条没碰。1.31.1 已发故另取号。
   回滚：`git revert 66087f2d`；1.31.2 若已发 tag 则不动，缺陷另取号。
2. **`tool-surface --check` 转红按本轮有意增长 `--record`**。依据：surface A +7（我改的注释）、engine
   分母 +12（我补的两处 hint）；新测试文件按"tests excluded"不计入 src 分母。harness 树在 `--record`
   前实测干净（0 条未提交），只重记 `tool-surface.json` 一处，单独 `chore(harness)` 提交。
   回滚：`git revert 083ca4aa`（但那样 `--check` 会恒红）。
3. **3 个审查代理的高危结论逐条否证、只落 2 条 P2**。依据：判据是文件字节，不是代理置信度——安全代理
   的两条 P0 形状结论都把既有守卫（成文 invariant / saveProjects 的 tightenMode）当成了缺失。
   回滚：不涉及产品字节。
4. **只清 `engine/.build` 不清 npm cache**。依据：磁盘 1.4 GiB < 4 GiB 门槛，`engine/.build` 673 MB 可
   再生；npm cache 属 root 需 sudo，而 `npm ci` 复装成功未触发 ENOSPC，按最小干预留它。
   回滚：无（`.build` 会由下一次 build 再生）。

## 4. 未观测（只限物理边界）

- **Apple 公证**：需付费开发者账号，owner 未启用；文档未写成已完成（既有事实，本轮未触碰）。
- **`npm stage approve`**：需 owner 2FA；本轮预期不需要（1.30.0/1.31.0/1.31.1 均走 trusted publisher 直发）。
- 本轮 GUI 改动只是 `.accessibilityHint`（读屏文案），真机六页 AX 走查未重跑——补法：
  `engine/smoke.md` 里 `gp-ax-walk` 那条整树走查。新闸已在源码字节层钉住"每处 `.disabled(` 都有读屏
  理由"，真机走查是它的硬件复核，非判据本体。

## 5. 收口 · 门禁逐字复跑（跑在本轮改动后的树上）

| 命令（逐字） | rc | 实际计数 |
|---|---|---|
| `swift build --package-path engine` | 0 | `Build complete!` |
| `swift test --package-path engine` | 0 | XCTest **1615** executed / **0** failures / 5 skipped（1613→1615，新增 2 条）；Swift Testing 76 passed |
| `swift test --package-path engine/probe` | 0 | **58** executed / 1 skipped / **0** failures |
| `python3 -m pytest -q bridge` | 0 | 223 passed, 1 skipped |
| `npm ci` | 0 | 干净复装 |
| `npm run build` | 0 | 根 + glasspane-mcp(tsc) + 其余 workspace |
| `npm test --workspaces --if-present` | 0 | 壳 762/762/0；安装器 353/353/0；更新器 818/818/0 |
| `node scripts/check-version.mjs`（后 `1.31.2`） | 0 | OK 版本线一致 |
| `node scripts/check-doc-links.mjs` | 0 | 文档 32 份／仓内链 275／外链 46／markdown 表 487 |
| `node scripts/check-workflows.mjs --self-test` | 0 | 48 条各自验证为会失败（28 抓 + 20 静） |
| `node scripts/check-workflows.mjs` | 0 | 5 份工作流文件干净 |
| `sh -n install.sh` | 0 | 无输出 |
| `cd engine && python3 .signal_smoke.py .build/debug/glasspaned` | 0 | `SIGNAL SMOKE OK` |
| `cd mcp-shell && npm run bundle && npm pack --dry-run` | 0 | `glasspane-mcp-1.31.2.tgz` |
| `node harness/tools/tool-surface.mjs --check` | 0（重记后） | 转红→`--record`（083ca4aa）→复绿 |
| `node harness/tools/fork-diff.mjs --check` | 0 | `divergence matches the recorded surface` |

## 6. 清理盘点（收口后）

见最终汇报的清理盘点表。本轮自建临时件只有 `/var/tmp/glasspane-main-check/backup-20261109/`（3 个快照 +
2 个 commit msg），收口时清；`engine/.build` 是本轮 build 再生的合法产物，不清。
