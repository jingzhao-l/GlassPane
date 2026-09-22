# glasspane-mcp

GlassPane 的 MCP 服务器（stdio）：把 AI 客户端的 `gp_*` 工具调用转发给本机
GlassPane 后台服务，并把每一次界面操作的证据带回给你。

This package is the **transport layer only**. It needs the GlassPane daemon
(`glasspaned`) running on this Mac, which the installer provides — installing this
package alone does not give you a working verification engine.

本包只是转发层：它需要本机已在跑 GlassPane 后台服务，而该服务由安装器产出。
只装本包不会得到可用的验证引擎——先装引擎：

```bash
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh
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

`dist/index.js` 是 esbuild 单文件产物：`@iterate/kernel`（schema 真源）在发布时
已捆绑内联，包内不存在指向源码仓库的 `file:` 依赖；`schemas/` 是 kernel schema
的发布副本，每次 `npm run bundle` 重新同步。

License: MIT.
