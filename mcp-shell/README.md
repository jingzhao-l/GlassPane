# glasspane-mcp

GlassPane 的 MCP 服务器（stdio）：把 AI 客户端的 `gp_*` 工具调用转发给本机
GlassPane 后台服务，并把每一次界面操作的证据带回给你。

This package is the **transport layer only**. It needs the GlassPane daemon
(`glasspaned`) running on this Mac, which the installer provides — installing this
package alone does not give you a working verification engine.

本包只是转发层：它需要本机已在跑 GlassPane 后台服务，而该服务由安装器产出。
只装本包不会得到可用的验证引擎——先装引擎：

```bash
# Fetch install.sh, then run it — two steps on purpose: piped into `sh`, a curl that fails
# leaves stdin empty and the pipeline exits 0 while nothing was installed.
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh
# 或：npx glasspane-install
```

## 用法 / Usage

```bash
npm i -g glasspane-mcp
glasspane-mcp            # 默认连接 ~/.glasspane/engine.sock
GLASSPANE_ENGINE_SOCK=/path/to/engine.sock glasspane-mcp
```

MCP 客户端配置：

```json
{ "mcpServers": { "glasspane": { "command": "glasspane-mcp" } } }
```

后台服务未运行或权限未就绪时，工具调用会返回带补救步骤的结构化错误——
按错误里的命令执行即可，无需查阅其它文档。

工具清单与语义以 `gp_*` 运行时 `tools/list` 返回为准。

## What ships in this package / 包里有什么

`dist/index.js` 是 esbuild 单文件产物：已发布的 `iterate-kernel`（schema 真源，devDependency，
只按 `iterate-kernel/<module>` 子路径引入）在发布时已捆绑内联，包内不存在指向源码仓库的
`file:` 依赖，也不残留一个裸的 `import "iterate-kernel"`——后者会让装到本机的产物去解析一份
没人拿这份产物对照过的内核，比 `ERR_MODULE_NOT_FOUND` 安静，但不更安全；发布档的
bundle-shape 闸专拒这一条。`schemas/` 是内核契约的发布副本，每次 `npm run bundle` 由
`scripts/bundle-kernel-schemas.mjs` 从**装好的那一份包**重新同步，并核
manifest 声明 = 装到的 = fork 的 pin 三者同号。

两个入口，各自是什么就按什么用 / two entries, each with one job：

| specifier | file | 行为 / behaviour |
| --- | --- | --- |
| `glasspane-mcp`（`exports["."]`） | `dist/index.js` | 就是 `glasspane-mcp` 命令本体：import 它即开始跑 stdio 会话，接管该进程的 stdin/stdout。它是程序，不是库——宿主不要 import 它。 |
| `glasspane-mcp/stdio-session`（`exports["./stdio-session"]`） | `dist/stdio-session.js` | 同一个会话的库形态（`parseArgs`、`startStdioServer`、`USAGE`、`tooLargeResponse`）：import 时既不读 stdin 也不写 stdout，只有你调用 `startStdioServer()` 才接管。要嵌进自己的进程就用这一条。 |

`exports["."]` 与 `bin["glasspane-mcp"]` 指向同一个文件是刻意的：命令必须无条件运行，
`argv[1]`/`require.main` 那类"自我判断要不要跑"的守卫曾在 19 个版本里把发布包变成 0
字节。所以运行与否由你选哪个 specifier 决定，而不是由文件猜。

License: MIT.
