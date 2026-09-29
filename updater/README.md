# glasspane-update — 自动更新引擎（私有工作区，不单独发布）

一句话：每天到点检查 GitHub Release，按 `specs/GlassPane_规格_自动更新_2026-09-27.md` 的八道校验决定
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
- **本机 TLS 信任**：`<stateRoot>/ca-roots.pem` 由 `lib/ca-bundle.js` 独家导出（`security find-certificate`
  对系统根钥匙串 + `System.keychain`），`enable` 注册 agent 时、每次 `apply` 成功后、以及**证书类失败
  恢复时**各刷新一次；launchd 的 plist 与设置面板起子进程时都带上 `NODE_EXTRA_CA_CERTS`。结果记在状态
  文件的 `caRoots`（五态封闭：`ok` / `empty` / `unavailable` / `write-unverified` / `probe-failed`；
  缺失或 `null` ＝ 旧安装没记录过，面板与 `gp_diagnose` 不能说成"正常"）。两个容易读错的点：
  **端点答了 403/404 不是束的失败**（TLS 验通了，是服务器不同意；记录留在 `ok`，答复写进 `detail`）；
  `probe-failed` 只在传输/TLS 层失败时出现，且必须带子进程自己报出的原因。
- **TLS 失败后的一次自我修复**：`main()`（只有可执行入口，不含库接口 `runCommand`）在拿到
  `tlsVerification` 的拒绝时重导一次束，带着 `NODE_EXTRA_CA_CERTS` 与防循环标记
  `GLASSPANE_CA_REEXEC=1` 把**同一条 argv** 重跑一次；调用方已经给了那个变量就不介入（方向归操作者）；
  导不出可用束就不重跑但一定留痕；子进程被信号杀死 ⇒ 退出码 `3`，绝不返回 `0`。
- **它写哪里**：`<stateRoot>/update-state.json`、`update-install.json`、`update-staging/`、
  `update-backup/`、`update.log`。状态根按**口令库里的家目录**解析（`os.userInfo().homedir`），不按 `$HOME`：
  面板与守护进程读的是同一个 `~/.glasspane`，跟着 `$HOME` 走会写出一个谁也看不到的状态。

## 已知边界（不当成已交付）

- **node 不读 macOS 信任库，这条腿只能靠导出的束**：装了 HTTPS 中间人的机器（企业网关、加速器）上，
  `curl`/`git`/`gh` 都正常而 `fetch` 拒绝同一条链，因为 node 只认自己打包的 CA 束。本树的处理是导出
  "这台机器的管理员已经选择信任"的那些根并追加给 node（不是替换、更不是关闭校验）。边界要说清：
  拦截根若不在这两个钥匙串里，就只能落 `probe-failed` 等人处理；而**内容安全从来不依赖这条腿** ——
  下载字节必须匹配那份由发布 key 签过的 `SHA256SUMS`，中间人签不出它。
- **作者性（第 8 条）如今是被检查的，但只检查到"内置 key"这一层**：`verified` 的确切含义是"这份
  `SHA256SUMS` 与随代码分发的那把公钥相符"，不是"发布者是这个组织"——公钥与代码走同一渠道，轮换就是改
  `installer/cli.js` 里那一个导出值（`updater/lib/signature.js` 动态 import 它，`updater/` 下不留第二份，
  有一条测试专门盯这件事）。签名对不上 = 硬拒，`signature-invalid`，任何 consent 都不能覆盖；
  没签名 / 这台机器没有 `gpg` = 定时运行拒绝（`needs-consent`），人可用
  `updater check --consent unsigned-release` 放行一次，之后状态文件与 `gp_diagnose` 会一直写明"这一版是
  无作者性证明装上的"（`authorship` 字段 + 长期 `lastError`）。人的兜底照旧：面板/`gp_diagnose` 上那串
  sha256、major 永不自动应用、一键关闭。
- **签名的资产名是两处必须一致的约定**：`release.yml` 里 `gpg --detach-sign --armor "$f"` 不带
  `--output`，gpg 就把签名写成 `<文件>.asc`，于是本模块只认 `SHA256SUMS-<ver>.txt.asc`
  （`lib/assets.js:SIGNATURE_NAME`）。工作流哪天改用 `--output`、换后缀、或者只签 tarball，这条 gate 都会
  把该 release 读成 `unsigned-release`（而不是读成"签名没问题"）——`test/signature.test.mjs` 从工作流原文
  反推这个名字，任一侧改名即红。1.3.1 及更早的 release 永远停在 `unsigned-release`，因为签名 job 是之后加的。
- 换版仍需在机器上重建 daemon（`swift build -c release` + `engine/scripts/make-app.sh`）：GitHub Release
  只有源码 tarball，没有预编译二进制。因此一次自动更新可能要几分钟，也依赖本机有 Xcode 工具链。
- 状态文件不落"上一次退出码"，所以 `apply-failed` 在面板重开后只能按"有没有暂存"判断能否重试；
  真实那次到底是 `4` 还是 `5` 只有当次运行知道。这一条是已知缺口，不是已解决。
- `--consent state-dir`（守护进程跑在非默认状态根）只能从命令行给，面板**故意**不给这个按钮。
  `--consent unsigned-release` 同样只能从命令行给：面板的「安装更新」今天只在**跨大版本**的
  `needs-consent` 上附带 `--consent major`，所以对一份未签名的补丁版，页面上只有被拒的理由是原话显示的，
  放行动作本身要去终端（见 README「让 GlassPane 保持最新」）。
