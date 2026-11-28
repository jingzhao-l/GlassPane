# 每日审查 2026-11-28 · 记录（发现 1 / 修复 1 / 否证 0 / 未修 0 · 零版本号）

> 真源提示词：`tools/prompts/daily-glasspane-main.md`。范围＝主仓产品面；`harness/` 不审查不改版本。
> 本轮**不取号**：唯一改动在 `harness/contracts/`（金样补记），与任何发布物字节无关。

## 0. 开工时读到的状态（判据＝文件字节）

- 开工 HEAD `39b2544f`，`git status --porcelain` 空（0 条）——上一轮 11-27 已完整收口。
- `git fetch origin --prune` 后：无 `origin/daily/main-*`、无 `daily/*` 本地分支、worktree 只有主树一条。
  本线无未落地遗留。
- **开工即踩到一处真红**：`origin/main` 最新一条 `CI` run `45930747653` 是 **failure**，红在
  `harness rulers` lane 的 `fork-diff.mjs --check`（"Divergence matches the recorded surface" 步）。
  而 `assert-tag-ready.mjs` 要求被 tag 那笔 sha 的 `event=push` CI 最新一条 success，这条红会按住本线任何发版。
- 版本线三方实测一致（开工即 1.31.17）：仓库 `check-version` 全 1.31.17、`git tag` 最高 `v1.31.17`、
  `npm view glasspane-mcp/glasspane-install version` 均 1.31.17 ⇒ 1.31.17 已完整发布。
- 环境：`df -k /Volumes/Eng-Dev` 可用 **~393 GiB**，远高于 4 GiB 门槛，无需清理。

## 1. 本轮发现 → 处置（1 条，已修）

| # | 发现 | 复核 → 处置 | 证据 |
|---|---|---|---|
| 1 | main 的 `harness rulers` CI lane 红：`fork-diff --check` 报 `'SYNCLOG.md': our own file moved (df57749a → 0df66844)`，而 `harness/contracts/fork-diff.json` 仍记旧哈希 | **成立，已修**（跨线修到 harness 契约层） | 上一笔 `39b2544f`（纯审查轮台账）移动了 `harness/glasspane-harness/SYNCLOG.md` 但**没在同笔里 `--record` 金样**。本地复现：`node harness/tools/fork-diff.mjs --check` 逐字命中同一行。重记后 `fork-diff.json` 只动两处（`observedAt` 2026-11-26→11-27、`SYNCLOG.md` forkHash），`counts` 4625/299/143/1708 逐字不变 ⇒ 分叉面没长，唯一移动就是那笔台账本身 |

**修复**：`node harness/tools/fork-diff.mjs --record` → 单独一条 `chore(harness)` 提交 `fddaee66`
（闸自己的 remedy：re-record so the change is reviewed）。推送后 `CI` run `46084961407` **全绿**
（10 个 job 无一非 success），`harness rulers` lane 由 failure 转 success。不消耗 harness 版本号。

## 2. 两路只读审查（正确性 + 安全信任边界）

- **安全路**：零需修缺陷。socket `umask 0177` 在 `bind()` 期建立（无 connectable 窗口）+ 目录祖先隔离
  拒绝符号链接/world-writable + mcp-shell `trustSocket` 独立二次校验；TCC 四席诚实（preflight-false
  映射 `unverifiable`，不凭历史造 `denied`/`granted`）；证据只落 `treeDigest/nodeCount` 等度量不落 AX 文本；
  错误恒 `{code,message,remedy}` 且 remedy 指向真实开关；installer/updater 下载验证分层；bridge 全程
  `argv` 数组零 `shell=True`；workflow 无 `pull_request_target`、`uses:` 全 SHA-pin、publish job 验
  `HEAD_SHA==TAG_SHA`。
- **正确性路**：零需修缺陷。三处工具面镜像由 `allCases` 派生而非手抄（`FrameCodec.capabilityWireNames`
  与 `hello.capabilities` 同源，13 个 case 全覆盖）；壳多出的 `dimension` 参数在 `engineBody()` 剥掉，
  daemon 白名单永不看到；schema 8 文件 `kernel/`↔`mcp-shell/` 字节一致；所有 remedy 字符串点到的开关
  （`--restore-launchd`/`--project-remove`/`--check-developer-tools`/`launchctl kickstart`…）都真实存在；
  强解包均有前置守卫。

## 3. 真机核对（全部做完，见 `engine/smoke.md` 2026-11-28 节）

- **面板六页 AX `kAXPressAction` 走查**（接上 11-27"未做"那一格）：六个 nav 标识逐个按 → 全部
  AX `.success`；枚举 39 个 `gp-*` 控件，席位读数与 daemon 逐字一致，developer-tools 恒诚实 unverifiable。
- **daemon `--permissions` / `--check-developer-tools`**（隔离 `--state-dir`，非环境变量）：verdict granted
  / 诚实 denied（真 lldb 探测），两条命令自报 reads no state、不写状态根。
- **发布物 e2e**：npm pack → 干净前缀安装 → `initialize` 回包 `glasspane-mcp`/`1.31.17`、stderr 0 行。
- **归档自证**：`make-release-archive --verify` 绿；`grep -cE "(^|/)harness/"`=0、
  `grep -cE "(^|/)\.iterate_decisions\.md$"`=0。
- **registry 回查**：两包 `--prefer-online` 均 1.31.17。

## 4. 本轮决定（→ 依据 → 回滚）

| 决定 | 依据 | 回滚命令 |
|---|---|---|
| 修 harness 契约红，跨线改 `harness/contracts/fork-diff.json` | main CI 红会按住本线发版；闸自己的 remedy 就是重记；重记后 counts 逐字不变证明只有台账移动 | `git revert fddaee66` |
| **不取号**（停在 1.31.17） | 唯一改动在 `harness/contracts/`，被发布归档剥 `harness/`、npm 两包不含；`git diff v1.31.17 HEAD -- ':(exclude)harness'` 为空 ⇒ 产品字节与 1.31.17 逐字相同，patch 判据（状态文件字段/退出码/CLI 参数/bin 声明）一条没碰，不构成任何版本事件 | 无需回滚（未动版本线）；若要强制重发同版，跑 `node scripts/set-version.mjs 1.31.18` 另取号 |
| 不重记 `tool-surface` 基线 | `tool-surface --check` 无增长（A 21.25%/B 23.71%，`!` 行是文档写明的常驻噪声非红） | 不适用 |
| 未动 `surface-semantics` | 0 hit，未开始自行判定证据语义 | 不适用 |

## 5. 收口

改动全在 main 并推送（`origin/main` = `fddaee66`），`git status --porcelain` 空，无 tag/Release/npm 动作
（不取号）。清理见汇报末尾盘点表。
