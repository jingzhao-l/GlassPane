# glasspane-mcp

GlassPane 的 MCP 服务器（stdio）：把 AI 客户端的 `gp_*` 工具调用转发给本机
GlassPane 后台服务，并把每一次界面操作的证据带回给你。

## 用法

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
License: MIT.
