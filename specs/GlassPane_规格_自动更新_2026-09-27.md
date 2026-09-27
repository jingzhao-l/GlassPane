# 规格 — 自动更新（2026-09-27，v1.4.0 新功能）

用户口径（原话归纳）：每天定时从源检查更新并自动更新；对象是**已安装的 daemon（.app + launchd 服务）**
与 **npm 两个包**；面板上要能手动检查/手动更新，并在"固定时间没跑成（关机）或重启失败"时**提示用户
有更新可用**；默认开、可一键关。

本文是这件事的契约：什么是"可信的更新"、什么时候允许换版、失败了留下什么。
判据不写"应该没问题"，每条都要能被测试变红（`updater/test/**`、`engine/Tests/**`）。

## 1. 更新源与信任链

- **源**：`https://api.github.com/repos/jingzhao-l/GlassPane/releases/latest`。仓库名是常量，
  不由参数或环境变量决定；`GLASSPANE_UPDATE_BASE` 只能把主机换成 **https** 或 **127.0.0.1**
  （后者仅供测试），换成明文地址即拒绝启动检查而不是降级。
- **七道校验，任一不过就不换版**，并把不过的那条以稳定 code 记进状态文件：
  1. `tag` 必须匹配 `^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`，且**语义化版本严格大于**当前
     （当前值取本机 `.app` 的 `CFBundleShortVersionString`，与 `glasspaned --version` 读回的值必须
     一致，不一致 = `version-mismatch-local`，不更新并提示重装）；`code=tag-unparseable`。
  2. 大版本号不同 ⇒ `status=needs-consent`：**major 升级永不自动应用**（本仓的 major 意味着
     对外契约变化，见 CHANGELOG 的 1.1.0/1.3.0 判断）。
  3. 该 release 必须同时带 `GlassPane-<ver>.tar.gz` 与 `SHA256SUMS-<ver>.txt` 两个资产，缺一即
     `assets-missing`（缺校验文件的 release 与没有校验文件等同）。
  4. `SHA25SUMS` 严格解析：只接受 `<64 hex>  <两个空格> 文件名` 的行，且必须**恰好一行**命中该
     tarball 名；多行命中或格式不符 = `sums-ambiguous`（不做"取第一个"的猜测）。
  5. tarball 落到 0700 的暂存目录后按 sha256 **实测**比对（读文件算，不信 Content-Length、不信头），
     不符 = `digest-mismatch`，暂存目录连同内容一起删除。
  6. 解包后**自我一致性**：暂存树里的根 `package.json`、`mcp-shell/package.json`、
     `engine/Sources/GlassPaneEngine/EngineCore.swift` 的版本常量三者都等于 `<ver>`，并**在暂存树里跑
     它自己的** `node scripts/check-version.mjs`（退出码非 0 即 `version-line-broken`）。这一条防的
     是"tag 与内容不同源"的版本混淆——本仓用单一版本线，所以拿它自己的守卫来验货。
  7. CI 凭据：该 release 的 `target_commitish` 指向的提交必须在 `main` 上有**结论为 success 的 CI run**
     （查询 `actions/runs?head_sha=…&branch=main`）；查不到 = `ci-unverified`，查得到但非 success =
     `ci-not-green`。理由与 1.3.0 的发版凭据同一条：这个仓库对外发布时用的就是 CI 绿。
- **作者性（诚实边界，不当成已解决）**：release 的 tag 未做签名（无 Git sign / minisign），所以
  第 4–7 条给的是**完整性 + 版本一致性 + 构建可追溯**，不是"这份产物一定出自仓库所有者"。
  因此：状态文件与面板都要显示 tarball 的 sha256（人可与网页核对），并且
  **自动应用只在无交互变更的补丁/次版本上发生**；major 一律要人点按钮。签名通道的接入是后续项，
  本规格不假装它已经存在。
- **npm 两个包不走 registry 更新**：从**已校验的暂存树**里 `npm pack` 出 tgz 再
  `npm install -g <该 tgz>`，避免"校验了 A 却装了 B"的双源。安装后必须 `npm ls -g` 读回版本等于
  `<ver>`，否则 `rollback`。

## 2. 什么时候才允许换版

- **空闲判据**：向 daemon socket 发 `probe_status`，**答得上来**才算空闲——守护进程单连接、按到达顺序
  串行（P0 §6），探针被回答意味着它前面没有请求，也就是没有任何动作正落在用户屏幕上。
  答不上（超时/连接失败）⇒ `status=deferred, reason=busy-or-unreachable`，**本轮什么都不换**；
  绝不把"探针没答"当成宕机，也绝不在忙的时候 `kickstart`（那会取消并回滚在飞的 act——本仓为此已经修过
  三轮）。
- **不猜运行参数**：用 `launchctl print gui/<uid>/com.glasspane.daemon` 读回**正在跑的那个 job** 的
  参数；若它带着非默认 `--state-dir`，本工具的换版语义不适用于它 ⇒ `status=needs-consent`
  （提示由人来做，因为它写的是别人的状态根）。这条读法与 round 9/10 的注册表通知同源。
- **窗口**：launchd `StartCalendarInterval` 每日一次（时刻可配，默认 12:00 本地），
  `RunAtLoad=false`（不让它每次登录都抢启动）。macOS 在睡眠期间错过的日历任务会在唤醒后补跑一次，
  **但关机期间错过的不会**——所以有 §4 的兜底。

## 3. 换版、握手核对与回滚

1. 备份当前 `~/Applications/GlassPane.app` 与 `GlassPane Daemon.app` 到 `<stateRoot>/update-backup/`
   （含版本标记），备份成功后才动现场。
2. 从暂存树构建（`swift build -c release` + `engine/scripts/make-app.sh`）并安置两个 bundle；
   构建失败 ⇒ 现场未动，`status=staged-build-failed`。
3. `launchctl kickstart -k gui/<uid>/com.glasspane.daemon` 重启，**再读一次版本**：
   socket 的 `hello` 必须回 `<ver>`，且 `glasspane-mcp` 的 `tools/list` 可用；15 s 内不成立即
   `restore backup + kickstart`，状态记 `rolled-back`，并把两侧版本写进 `lastError`。
4. npm 全局包的安装同样先记录原版本，读回不符就装回原版本。
5. 一切成功才更新 `current`；历史保留最后 10 次（时间、动作、结论、digest 前 12 位）。

## 4. 没跑成 / 失败时，用户看得到也能动手

- 状态文件 `<stateRoot>/update-state.json`（**0600**，写临时文件 + `rename`，读回校验落盘 mode；
  chmod 不生效即报错，与注册表同一形状）：`{lastCheckAt, current, latest, status, staged, lastError,
  disabled, autoApply, history[]}`。
- **过期判定**：`now - lastCheckAt > 36 h` ⇒ 面板与 `gp_diagnose` 显示"检查已过期（上次 X）"并给
  「立即检查」；这一条专门兜住"固定时间电脑是关的"。
- `status` 是封闭枚举（`up-to-date / available / staged / applied / deferred / needs-consent /
  check-overdue / rolled-back / …-failed / disabled`），面板按它决定哪个按钮可用；
  **不可用不是隐藏，是 disabled 并带原因**（原因文案必须是人能照做的，不写 §、不写内部自辩）。
- 面板的「立即检查」「安装更新」只是同一个 CLI 的入口（`updater check` / `updater apply`），
  不允许面板自己实现第二套下载与换版逻辑——一处实现，一处真相。
- MCP 面：`gp_diagnose` 的响应里带上 `update` 摘要（当前/最新/状态/上次检查），让代理也能如实回答
  "这台机器的 GlassPane 是不是旧的"。方法表是冻结面，这是**响应字段的新增**，不是新方法。

## 5. 默认与关闭

- 默认**开**：安装器注册 `com.glasspane.update`（除显式 `--no-auto-update`）。
- 一键关：`updater --disable`（卸代理 + 状态里 `disabled=true`）与面板开关等效；
  关闭后面板仍显示"自动更新已关闭（上次检查 X）"，不静默消失。
- 关闭状态下 `check`/`apply` 仍可手动执行（手动不受自动开关约束）。

## 6. 每条判据对应哪个能红的测试

| 判据 | 测试 | 反向变异 |
| --- | --- | --- |
| 源只能是 https/pinned | `updater/test/source.test.mjs` | 放开明文 ⇒ 红 |
| tag 解析与 semver 严格大于 | `version.test.mjs` | 允许相等 ⇒ 红 |
| major 不自动应用 | `policy.test.mjs` | 去掉 consent 分支 ⇒ 红 |
| 双资产必须齐 | `assets.test.mjs` | 缺 SUMS 仍继续 ⇒ 红 |
| SUMS 严格解析 | `sums.test.mjs` | 取第一个命中 ⇒ 红 |
| 实测 sha256 | `digest.test.mjs` | 改用头长度 ⇒ 红 |
| 暂存树版本线自证 | `selfcheck.test.mjs` | 跳过 check-version ⇒ 红 |
| CI 凭据 | `ci.test.mjs` | 允许无 CI run ⇒ 红 |
| 忙时不换版 | `idle.test.mjs`（假 socket 不答探针） | 把超时当空闲 ⇒ 红 |
| 非默认 state-dir 不动 | `launchd.test.mjs` | 去掉读参数 ⇒ 红 |
| 握手不符即回滚 | `apply.test.mjs` | 去掉 restore 调用 ⇒ 红 |
| 状态文件 0600 + 读回校验 | `state.test.mjs` | 去掉 chmod/校验 ⇒ 红 |
| 过期判定 | `overdue.test.mjs` | 阈值改成 ∞ ⇒ 红 |
| 面板按钮可达性 | `engine/Tests/…/UpdatePanelTests.swift` | 无条件可用 ⇒ 红 |

## 7. 接口契约（面板、launchd、代理共用一处实现）

- 入口：`node <installRoot>/updater/cli.js <子命令>`。子命令与语义：
  - `check` 拉 release → §1 七道校验 → 通过则解包暂存（`<stateRoot>/update-staging/<ver>/`）并写状态；
  - `apply` 只在**已暂存且 §2 空闲判据通过**时换版（含 §3 的备份/握手/回滚）；
  - `status` 读状态文件并附 §4 的过期判定，不联网；
  - `rollback` 用备份恢复上一版并重启核对；
  - `enable` / `disable` 注册或卸载 launchd agent，并写 `disabled`。
- 退出码是契约的一部分（面板与 launchd 只能靠它判成败）：`0` 成功；`2` 用法错误；
  `3` 被拒（忙 / needs-consent / 任一校验不过）；`4` 已换版但握手不成、**回滚成功**；
  `5` 换版失败**且回滚也未成功**（必须人工，面板要把这句原样显示）。
- `--json` 时 stdout 恰好一行 JSON（状态文件同 schema：`updater/schema/update-state.schema.json`，
  本包内自校验；**不进 kernel**，它是本机安装态而不是跨语言证据契约），日志与人类文案走 stderr。
  面板解析失败要显示"读不到更新状态"而不是显示成功。
- 面板**不自己实现下载/换版**，只 `Process` 起这条 CLI 并读那一行 JSON；launchd agent 也起同一条命令。
- 路径发现：安装器把 `{updaterCli, installRoot, agentLabel, registeredAt}` 写进
  `<stateRoot>/update-install.json`（0600，临时文件 + rename + 读回校验 mode），面板与诊断都从这份
  指针读；指针指向的脚本不存在时状态是 `installer-pointer-stale`，面板提示重装而不是静默失败。
- 环境变量：`GLASSPANE_STATE_DIR`（状态根，与 daemon 同义）、`GLASSPANE_UPDATE_BASE`（仅测试/自建镜像，
  见 §1 的 https 限制）、`GLASSPANE_UPDATE_DISABLE=1`（等效 disable，且不注册 agent）。

## 8. 审后追加（2026-09-27，round 11：审这份实现本身查出的，已升为契约）

第一轮审计（读代码 + 现场复现）在这份实现上查出下列条目。它们不是"以后再说"，而是本节契约的一部分：
实现与测试都要按这里说，缺一条就是缺陷。

1. **空闲证据不许过期**。§2 的探针只在**换版前一刻**有效：构建可能要十几分钟，探针答过一次就去
   `kickstart` 等于用一条过期证据取消用户屏幕上正在执行的动作。判据改为：每一次 `kickstart`
   （换版后重启、回滚后重启都算）**前**都必须重新探一次并拿到回答；拿不到就 `deferred`，一次都不重启。
2. **七道校验的次序与"整链"必须被测到**。逐条测各 gate 不算数：`check` 的编排（哪条 gate 在哪个动作之前、
   任一不过就不落地）要有端到端用例。且**任何会执行暂存内容的步骤（自检脚本）必须排在所有网络可验的
   gate 之后** —— 先验完再运行别人写的代码。
3. **CI 凭据要指名道姓**。只要求"该 sha 上有一个 success 的 run"不够（文档工作流也算）。必须指名
   发布所用的 CI 工作流；提交号取 release 的 `commit_id`，`target_commitish` 只作缺失时的回落，
   并把用的是哪一个记进结果。
4. **产物 URL 与重定向都要钉住**。载荷里给的资产 URL 只能落在钉住的主机上（回环例外只服务于测试基址）；
   `redirect: 'follow'` 之后必须比对 `response.url` 的主机，不同即拒。否则攻击者只要在自己的 release
   文本里换一个地址，校验的就是自己发的两份文件。
5. **launchd 里的命令不得经过 shell**。渲染 agent 时把路径插进 `/bin/sh -c "…"` 等于把"路径里有个引号"
   变成每天以用户身份执行一次任意命令。判据：`ProgramArguments` 用 argv 数组，或先拒掉含 shell 元字符的
   路径并证明拒得住。渲染出的 plist 还要能被 lint/解析。
6. **读别人的输出要 fail-closed**。`launchctl print` 的参数字符串解析不能在第一处 `}` 截断——那样
   `--note=}` 就能藏住后面的 `--state-dir /别人的目录`，§2 的"别人状态根"闸门直接形同不存在。
   解析不出/不平衡 ⇒ 判为 `unknown`，按需要人工处理。
7. **npm 侧也要读回校验**。§1 的"装完把版本读回，不符就装回原版本"必须真的存在：只检查子进程
   `ok===false` 不算，它测的是桩，不是门。
8. **换版之后的失败要说"已经换了"**。`installBundles` 之后再抛错，若被顶层当成 `check-failed`/退出 3，
   状态文件与现场就不一致（面板会显示"什么都没变"）。判据：换版后的任何失败必须落在 4/5 两个语义里，
   并写清哪一半成功。
9. **不允许换到相同或更旧的版本**。`apply` 必须对着**apply 当时**实际安装的版本要求 `upgrade`；
   一次失败的 `check` 要清掉 `staged`，否则一份过期暂存树能把人手工装好的新版本降回去。
10. **关闭开关与状态根同一个 home**。`disable`/agent 路径若按 `$HOME` 解析而状态根按口令库记录解析，
    重定向过 `HOME` 的调用会"关掉"一个并不存在的 agent 并报告成功。两处必须同一个来源。
