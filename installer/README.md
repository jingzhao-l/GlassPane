# glasspane-install

One-command installer for [GlassPane](https://github.com/jingzhao-l/GlassPane): builds the Swift
engine and the MCP shell, packages and signs the `.app` bundles, registers the launchd job, and
opens the settings panel where you grant permissions. Zero third-party dependencies, Node ≥ 18,
macOS 14+.

无第三方依赖的一键安装器：编译引擎与 MCP 层、打包并签名 `.app`、注册 launchd 自启、打开权限引导面板。

## Channels / 安装渠道

```bash
# 1) One-liner (推荐): fetches install.sh, which clones the pinned release tag
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh

# 2) This package via npx — also clones the pinned release tag when no local
#    repo is found, then runs the same flow
npx glasspane-install

# 3) From an existing checkout
node installer/cli.js
```

All three end up in the same code path (`installer/cli.js`), and both one-command
channels clone the **same pinned tag** — never a moving branch — so a fresh install
is reproducible. Override with `GLASSPANE_REF=<tag>` (`main` is available but is not
a fixed artifact).

三条渠道最终都走同一份 `installer/cli.js`，且两条一键渠道 clone 的是同一个**钉住的发布 tag**（不是移动的分支），
所以同一天两次安装拿到的是同一份源码。

## Flags / 选项

| 选项 | 作用 |
|---|---|
| `--repo <dir>` | 指定项目根目录（默认自动向上查找） |
| `--no-bootstrap` | 找不到本地仓库时不自动 clone，只打印定位指引 |
| `--no-prompt` | 跳过逐步确认（脚本/自动化场景） |
| `--no-daemon` / `--no-gui` | 不启动 daemon / 不打开设置面板 |
| `--no-app` | 不打包 `.app`（daemon 将以裸二进制运行，系统设置里只显示文件名） |
| `--no-launchd` | 不注册开机自启 |
| `--replace-daemon` | 先收拢已在跑的旧实例（旧构建会占住 socket） |
| `--skip-build` | 跳过 npm/tsc/swift 编译 |
| `--restore-launchd` | 只做 launchd 恢复 + 校验 daemon 自报席位 |
| `-h, --help` | 完整用法 |

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
