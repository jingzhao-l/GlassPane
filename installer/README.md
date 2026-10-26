# glasspane-install

One-command installer for [GlassPane](https://github.com/jingzhao-l/GlassPane): builds the Swift
engine and the MCP shell, packages and signs the `.app` bundles, registers the launchd job, and
opens the settings panel where you grant permissions. Zero third-party dependencies, Node ≥ 18,
macOS 14+.

无第三方依赖的一键安装器：编译引擎与 MCP 层、打包并签名 `.app`、注册 launchd 自启、打开权限引导面板。

## Channels / 安装渠道

```bash
# 1) This package via npx (recommended) — also clones the pinned release tag when no local
#    repo is found, then runs the same flow. It is also the only channel that leaves the
#    `glasspane` command on PATH; `npm install -g glasspane-install` keeps it there permanently.
npx glasspane-install

# 2) Fetch, then run: install.sh clones the pinned release tag. Two steps on
#    purpose — piped into `sh`, a curl that fails leaves stdin empty and the pipeline exits 0.
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh

# 3) From an existing checkout
node installer/cli.js
```

All three end up in the same code path (`installer/cli.js`), and both one-command
channels clone the **same pinned tag** — never a moving branch — so a fresh install
is reproducible. Override with `GLASSPANE_REF=<tag>` (`main` is available but is not
a fixed artifact).

An existing clone at the install directory is **advanced**, not ignored and not
clobbered: if `git status --porcelain` is empty the installer fetches the pinned tag
and `checkout --detach`s onto it; if it is dirty it refuses, names the files in the
way, and offers a different `GLASSPANE_INSTALL_DIR`. No `git stash`, no `checkout -f`,
no `clean` — an installer has no business destroying somebody's uncommitted work
(that refusal is what replaced the 2026-10-26 shape, where one channel printed "the
existing clone will not be switched" and then built from a three-versions-old tree
while the other channel died on git's "already exists and is not an empty directory").

三条渠道最终都走同一份 `installer/cli.js`，且两条一键渠道 clone 的是同一个**钉住的发布 tag**（不是移动的分支），
所以同一天两次安装拿到的是同一份源码。

安装目录里已经有一棵 clone 时，这一趟**把它前进**到钉住的那个 tag，而不是照用旧树、也不是删掉重来：
`git status --porcelain` 是空的就 fetch + `checkout --detach`；不空就**拒绝**，点名挡路的那些文件，
并给出换一个 `GLASSPANE_INSTALL_DIR` 的走法。没有 `git stash`、没有 `checkout -f`、没有 `clean`——
安装器不该有能把别人的未提交工作抹掉的那一格。

## The `glasspane` command / `glasspane` 这条命令

这个包同时交付 `glasspane`（`bin` 里两个名字，见 `package.json`），回答的是"面板按钮失败了，
而我不知道自己装到了哪里"：

| 命令 | 做什么 | 退出码 |
|---|---|---|
| `glasspane doctor` | 只读这台机器：状态根、安装指针、更新器状态、在册 daemon 作业、socket、两个全局 npm 包；每格答 available / absent / unverified | 0 全在位；3 有格子不在位或答不了 |
| `glasspane update` | 先 `check`，再装通过校验的那一份；检查停住就不进安装 | 沿用更新器自己的那一档（0/3/4/5） |
| `glasspane status` | 把更新器那一行结论原样打出来 | 同上 |

它只按 `~/.glasspane/update-install.json` 找那份更新器（安装器写的、面板读的同一份），不从当前目录猜；
不 sudo、不删东西，需要人做的那一步只点名工具与目录。npm 那一格的补法给的是
`npm install -g glasspane-mcp@<版本> glasspane-install@<版本>`——那取的是 registry 的发布物，
与更新器从已校验暂存树里现场打包的那一份是两种来源，这句话也一起说。

## Flags / 选项

| 选项 | 作用 |
|---|---|
| `--repo <dir>` | 指定项目根目录（默认自动向上查找） |
| `--no-bootstrap` | 找不到本地仓库时不自动 clone，只打印定位指引 |
| `--no-prompt` | 跳过逐步确认（脚本/自动化场景） |
| `--no-daemon` / `--no-gui` | 不启动 daemon / 不打开设置面板 |
| `--no-app` | 不打包 `.app`（daemon 将以裸二进制运行，系统设置里只显示文件名） |
| `--no-launchd` | 不注册开机自启 |
| `--no-auto-update` | 不注册每日自动更新代理（并把它卸载 + 状态记 `disabled=true`）；手动 `check`/`apply` 仍可用 |
| `--replace-daemon` | 先收拢已在跑的旧实例（旧构建会占住 socket） |
| `--skip-build` | 跳过 npm/tsc/swift 编译 |
| `--restore-launchd` | 只做 launchd 恢复 + 校验 daemon 自报席位 |
| `-h, --help` | 完整用法 |

默认**开**自动更新：安装器把 `{updaterCli, installRoot, agentLabel,
registeredAt}` 写进 `<stateRoot>/update-install.json`（0600，临时文件 + rename + 读回校验），
并注册每日一次的 `com.glasspane.update` 作业。指针与作业都由 `updater/` 自己那套实现写出
（`writePointer` / `renderAgentPlist` / `registerAgent`），安装器不渲染 plist、不抄标签。
安装树里没有 `updater/cli.js`（旧 checkout）时：**如实打印缺的是哪个文件、你失去什么**，
不写指针、不注册作业，而安装本身仍然成功——静默跳过不是这个仓库允许的失败形态。

卸载本机安装时，除了 daemon 那份作业，**也要**卸掉更新代理：
`node <repo>/updater/cli.js disable` 一条命令做这件事（bootout + 删 plist + 记 `disabled=true`）。

## What still needs a human / 仍需人工的两件事

1. **TCC permissions.** Accessibility, Input Monitoring and Screen Recording must be ticked in
   System Settings, by the person, for **`GlassPane Daemon`** (the daemon binary itself) — not for
   a terminal and not for the settings window. There is no programmatic path; the panel walks you
   through each card and re-measures after you tick it.
2. **First launch past Gatekeeper.** Builds are ad-hoc signed (no Developer ID / notarization
   yet), so on a machine other than the author's, macOS will refuse the app on first launch until
   you allow it in System Settings → Privacy & Security. This is a real caveat, not a guess:
   notarization is a pending owner decision (cost-gated).

Everything else — detection, building, launching, verifying, repairing — is done by the installer.

## Errors / 出错时

失败信息里带可直接执行的补救命令；按提示执行即可，不需要翻文档。安装日志：`~/.glasspane/installer-daemon.log`。

License: MIT.
