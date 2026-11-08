# 每日审查 2026-11-08（承接 11-06/11-07 两条会话）· 发现台账（发现 1 / 修复 1 / 未修 0）

> 真源提示词：`tools/prompts/daily-glasspane-main.md`。范围＝主仓产品面；`harness/` 不审查不修改。
> 本轮性质特殊：**1.31.0 已完整发布**（tag/Release/registry 三线齐），main 上压着一条**已提交但未发**的
> 1.31.1。本轮在 1.31.1 上又审出并修掉 1 条缺陷，随该版发出。

## 0. 开工时读到的状态（判据是文件字节，不是分支名/提交信息）

- 本会话是被多次挂起的续跑。每次醒来都**重新锁基线**——中途 main 被并行的 10:30 那条 harness 线推过多次。
- 最重要的纠正：开工 HEAD `dc4c5f45` 时本地 `git tag -l` 看不到 `v1.31.0`，一度判为"1.31.0 未发"。
  `git fetch origin --prune` 后实测：**远端 tag `v1.31.0` 在 `dc4c5f45`、Release 非草稿且 Latest、
  registry 两包都读 1.31.0**——本地 tag 列表滞后，**1.31.0 早已完整发布，不是本轮待办**。
  教训：判"发没发"只认 fetch 后的远端读数与 registry，不认本地 tag 缓存。
- 真正未收口的是 **1.31.1**：`CHANGELOG.md` 有 `## [1.31.1]` 完整条目（6 小节）、
  `node scripts/check-version.mjs` 报 20 个位点全 1.31.1，但无 tag、无 Release、registry 仍 1.31.0。
  它被卡住的原因（11-08 那条线在 `e600e792` 里写明）：harness rulers 那条 lane 的 fork-diff 金样滞后。
  本轮开工时那条线已自己 `--record` 补齐（`a32b70c7`），CI 在 `a32b70c7` 上 success（run `42462729048`），
  `node scripts/assert-tag-ready.mjs 1.31.1 --repository jingzhao-l/GlassPane` ⇒ **可以打 tag**。
- 开工环境：`df -k /Volumes/Eng-Dev` 可用 ~21 GiB（> 4 GiB 门槛）；`git status --porcelain` 在我动手前
  只有一枚未追踪的 `specs/GlassPane_每日2026-11-06_发现台账.md`（上一轮的台账，后来由那条线自己提交）。
- 在飞现场（不碰、不代提交）：`.worktrees/harness-daily-2026110{4,5,6}`、
  `.worktrees/harness-integrate-20261107`，分支前缀 `gp-harness-*`，提交前缀 `[gp]`——都是 10:30 那条线。
- 本轮审查用 **5 个并行只读审查代理**（Swift 引擎 / TS 壳+安装器 / updater+bridge / 安全信任边界 /
  UX+能力缺口）。**它们的每一条主张我都逐条回到文件字节复核**——高危结论几乎全部被否证（见第 2 节）。

## 1. 本轮发现 → 修复 → 具名测试（1 条，随 1.31.1 发出）

| # | 发现（触发输入 → 错误行为） | 修在哪 | 具名测试 | 反向破坏 |
|---|---|---|---|---|
| 1 | 1.31.0 把"没量到"从 exit 1 挪到 **exit 5**（`--check-developer-tools` 三档判决），EXIT CODES 表（`main.swift:705`）改对了，但 OPTIONS 里那一格（`main.swift:610-618`）仍写 `Exit 1 for a refusal and for an arm that never reached a verdict`——**同一文件两处文档各说各话**，只读那一格的读者/agent 拿到的仍是老契约：一次没跑成的探测被许诺成"被拒"。这是把 11-05 那条红线（不许把没量到的写成量到的）在文档面漏掉的一半 | `main.swift` OPTIONS 那一格改为 `Exit 1 for a refusal; exit 5 for an arm that never reached a verdict（工具链不在位或探测超时）`，并点名 `verdict` 字段说清是哪一臂没答；退出码集合/`exit()` 三档/CLI 参数/`bin` 一字未动，仍属 patch | `DailyRound20261105DeveloperToolsVerdictTests.testTheFlagBlockItselfNamesExitFiveForAnUnmeasuredArm`（新增第 6 条，锚到 OPTIONS 里以该开关起头那一格） | 把那一格改回 `Exit 1 for a refusal and for an arm that never reached a verdict` ⇒ 该用例两条断言同时具名红（`XCTAssertTrue` 退 5 那条 + `XCTAssertFalse` 老句子那条）；恢复后 6/6 复绿。既有的 `testTheExitCodeHasThreeArmsNotTwo`（钉 `exit()` 三档）与 `DaemonExitCodeTests`（钉"表里没码不放行"）**都不读 OPTIONS 那一格**，所以这次漂移能绿着藏到今天 |

## 2. 审查代理报出、经复核**否证**的（各附否证证据）

逐条回文件字节复核，高危结论无一成立。记在这里免得下一轮把它们当"已知未修"重新捞出来：

- **(a) "smoke.md 写'三次起停'与 `.signal_smoke.py` 只测 SIGTERM/SIGINT 不符"** —— 否证。
  `.signal_smoke.py` 实跑三案：`run_case(..., "SIGTERM", ...)`、SIGINT 案、以及 `inherit_ignored` 案
  （`R6-12`，让 daemon 在继承 `SIGINT=SIG_IGN` 下起）。文档"三次起停"与代码一致，**不是陈旧主张**。
- **(b) "`--check-developer-tools` CLI 退 5 与面板 MCP 侧不符"** —— 否证。payload 三档
  `granted|denied|unverifiable` → `granted:0/denied:1/default:5` 是**一致且正确**的设计
  （`DebugCapabilityProbe.verdict` + `main.swift:1231-1236`），面板那一卡读的是同一份 payload。
- **(c) "installer 有无 shebang 的 `install.js`"** —— 否证，**该文件不存在**。`installer/` 只有
  `cli.js`/`glasspane.js`，`bin` 是 `glasspane-install→cli.js`、`glasspane→glasspane.js`；
  `glasspane-mcp` 的 `bin` 是 `dist/index.js`/`dist/http-gateway-cli.js`——**四个真实 bin 全有
  `#!/usr/bin/env node`**。该发现引用的是幻觉路径。
- **(d) "http-gateway 绑定 0.0.0.0 / 可路由地址"** —— 否证。`http-gateway.ts` 硬绑
  `DEFAULT_GATEWAY_HOST = "127.0.0.1"`，`assertLoopbackHost` 拒绝任何非 loopback host（文档 227-231 行）。
- **(e) "daemon socket 无 peer 鉴权＝同用户即全权、无凭据校验"** —— 否证。
  `ProbeSocketServer.helloRejectionReason`（910-928 行）取 `getpeereid`（uid）+ `LOCAL_PEERPID`（pid），
  **fail-closed**：uid 读不出 / pid 读不出 / uid≠daemonUID / pid≠claimed 一律拒绝并给理由。
  这是既有 `GP_E_SOCKET_TRUST` 判据的落地，不是无凭据校验。
- 其余为 P2/P3 文档措辞与"可考虑"建议，无一条构成当前缺陷；未修项为空。

## 3. 本轮我替你做了哪些决定（依据 / 回滚）

1. **本轮修复并入 1.31.1，不再取新号**。依据：1.6.2 那条判据——本轮只动 `main.swift` 的**帮助文本**，
   退出码集合、`exit()` 三档、CLI 参数、`bin` 声明、状态文件字段**一字未动**，完全落在 1.31.1 的
   patch 口径内；且 1.31.1 尚未打 tag，把它收进去让发布的 tag 自带这处文档修复，避免"发了 1.31.1
   立刻又要 1.31.2 修文档"。
   回滚：`git revert <本轮 fix 提交>`；1.31.1 若已发 tag 则一律不动，缺陷另取一号。
2. **5 个审查代理的高危结论逐条否证、只落 1 条 P2 文档修复**。依据：审查代理（无 diff、通读现存代码）
   报的 P0/P1 几乎全部引用了不存在的文件、或把既有 fail-closed 守卫（loopback 硬绑、socket peer
   凭据校验）当成缺失。**判据是文件字节，不是代理的置信度。** 回滚：不涉及产品字节。
3. **先跑齐门禁再打 tag**。依据：本轮改动落在 `main.swift` + 一条测试上，1.31.1 的 tag 必须指向
   **含本轮修复的新提交**，而 `assert-tag-ready` 要求 tag 那笔 sha 的 CI 绿。所以顺序是：
   提交修复 → 推 main → 等 CI 绿 → `assert-tag-ready` → tag → Release → npm。
   回滚：修复只动文档与测试，若 CI 转红则 revert 该笔，1.31.1 按原样（不含文档修复）发。

## 4. 未观测（只限物理边界）

- **`unverifiable` 那一档的真实现场本机造不出**：探测走绝对路径 `/usr/bin/xcrun`，这台机器 CLT 在位且会答。
  补它的动作：在一台没有 Command Line Tools 的 mac 上跑
  `glasspaned --state-dir <临时根> --check-developer-tools`，预期 `verdict: unverifiable` 且退 5。
  该档由注入层 `DebugCapabilityProbe.Running` 的 5 条用例量到，不是"没测"。
- **Apple 公证**：需付费开发者账号，owner 未启用；文档未写成已完成（既有事实，本轮未触碰）。
- **`npm stage approve`**：需 owner 2FA；本轮预期不需要（1.30.0/1.31.0 均走 trusted publisher 直发成功）。

## 5. 收口

### a. 门禁逐字命令复跑（跑在本轮改动后的树上）

| 命令（逐字） | rc | 实际计数 |
|---|---|---|
| `swift build --package-path engine` | 0 | `Build complete!` |
| `swift test --package-path engine` | 0 | XCTest **1613** executed / **0** failures / 5 skipped（本轮新增 1 条 → 从 1612 到 1613） |
| `swift test --package-path engine --filter DailyRound20261105DeveloperToolsVerdictTests` | 0 | **6** executed / **0** failures（原 5 条 + 本轮新增 1 条） |
| `swift test --package-path engine/probe` | 0 | **58** executed / 1 skipped / **0** failures（首轮 1 失败为与引擎套件并跑的负载假红，隔离复跑转绿） |
| `npm run build` | 0 | 根 + `glasspane-mcp`（tsc）+ 其余 workspace 全过 |
| `npm test --workspaces --if-present` | 0 | 壳 762/762/0；安装器 353（350 pass/3 skipped）/0；更新器 818/818/0 |
| `npm ci` | 0 | 见上一轮读数；本轮重装后 build/test 均在其上复跑 |
| `node scripts/check-version.mjs` | 0 | `OK：版本线一致（1.31.1）` |
| `node scripts/check-doc-links.mjs` | 0 | 文档 32 份／仓库内链接 275 条／外链 46 条／markdown 表 484 张 |
| `node scripts/check-workflows.mjs --self-test` | 0 | 48 条各自验证为会失败（28 抓 + 20 静） |
| `node scripts/check-workflows.mjs` | 0 | 5 份工作流文件干净 |
| `python3 -m pytest -q bridge` | 0 | 223 passed, 1 skipped |
| `sh -n install.sh` | 0 | 无输出 |
| `cd engine && python3 .signal_smoke.py .build/debug/glasspaned` | 0 | `SIGNAL SMOKE OK`（三次起停各自跑在隔离状态根里） |
| `cd mcp-shell && npm run bundle && npm pack --dry-run` | 0 | `glasspane-mcp-1.31.1.tgz` |
| `node harness/tools/tool-surface.mjs --check` | 0 | no growth past the recorded baseline（面 B 超限提示是既有基线，非本轮增长） |

### b. 反向验证（本轮新做的）

- #1：把 OPTIONS 那一格改回老句子 `Exit 1 for a refusal and for an arm that never reached a verdict`
  ⇒ `testTheFlagBlockItselfNamesExitFiveForAnUnmeasuredArm` **两条断言同时具名红**；
  恢复后 `diff` 对备份确认只含新 5 行契约、6/6 复绿。
- 开发期教训：该用例第一版 `flagBlock` 匹配到的是 `main.swift:43` 那处**注释**里首次出现的开关名
  （正确树上红）、第二版丢了开关自己那一行（那句折行就写在那一格），两次都是**判据写错**不是产品错——
  锚到"以开关起头的那一行"才对。

### c. 真机读数

本轮改动**只动帮助文本**，不落在面板/daemon 读路径上；真机三档判决读数已在 11-06 台账第 5c 节
按发布物量过（`--check-developer-tools` 真 hardware 答 `denied` 退 1）。本轮未新增 GUI 事实，
故未重跑六页 AX 走查——补法与上一轮相同：`engine/smoke.md` 里 `gp-ax-walk` 那条整树走查。

## 6. 清理盘点（收口后）

见最终汇报的清理盘点表。
