# glasspane-update — 自动更新引擎（私有工作区，不单独发布）

一句话：每天到点检查 GitHub Release，按 `specs/GlassPane_规格_自动更新_2026-09-27.md` 的七道校验决定
能不能装，能装就在守护进程空闲时换版；换不下去就把原因留在状态文件里，让人在面板上看见并点。

契约以规格为准，这里只记实现要点与调用面：

- **入口**：`node updater/cli.js check|apply|status|rollback|enable|disable [--json]`。`--json` 时
  stdout **恰好一行** JSON（`updater/schema/update-state.schema.json` 的字段 + `exitCode`），日志全走 stderr。
- **退出码是契约**（面板与 launchd 只认它）：`0` 做成、`2` 用法、``3` 被拒（忙 / needs-consent / 任一校验不过）、
  `4` 换了但握手不成且回滚成功、`5` 换了且回滚也没成（必须人工，面板原样显示这句话）。
- **谁调用它**：`~/Library/LaunchAgents/com.glasspane.update.plist`（`lib/launchd.js` 渲染，路径以
  **argv 位置参数**传入，命令里唯一的 shell 只用来串 `check && apply`；`apply` 带 `--auto` 标记这是自动运行）
  与设置面板「更新」区（`engine/Sources/glasspane-settings/Update*`）。面板不实现第二套更新逻辑。
- **安装器怎么接**：`installer/cli.js` 动态 import 本树的 `cli.js`（`resolveStateRoot`/`runCommand`）与
  `lib/state.js`（`writePointer`/`readPointer`）、`lib/launchd.js`（`AGENT_LABEL`、排程常量）——
  标签、plist 与状态文件只有这一处实现。注册/卸载一律走 `runCommand('enable'|'disable')`。
- **它写哪里**：`<stateRoot>/update-state.json`、`update-install.json`、`update-staging/`、
  `update-backup/`、`update.log`。状态根按**口令库里的家目录**解析（`os.userInfo().homedir`），不按 `$HOME`：
  面板与守护进程读的是同一个 `~/.glasspane`，跟着 `$HOME` 走会写出一个谁也看不到的状态。

## 已知边界（不当成已交付）

- release tag **未签名**：七道校验给的是完整性 + 版本一致 + 可追溯到一次绿色 CI，不是作者性。
  人的兜底是面板/`gp_diagnose` 上那串 sha256，以及"major 永不自动应用"和一键关闭。
- 换版仍需在机器上重建 daemon（`swift build -c release` + `engine/scripts/make-app.sh`）：GitHub Release
  只有源码 tarball，没有预编译二进制。因此一次自动更新可能要几分钟，也依赖本机有 Xcode 工具链。
- 状态文件不落"上一次退出码"，所以 `apply-failed` 在面板重开后只能按"有没有暂存"判断能否重试；
  真实那次到底是 `4` 还是 `5` 只有当次运行知道。这一条是已知缺口，不是已解决。
- `--consent state-dir`（守护进程跑在非默认状态根）只能从命令行给，面板**故意**不给这个按钮。
