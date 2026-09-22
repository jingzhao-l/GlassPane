# GlassPane

[![npm: glasspane-mcp](https://img.shields.io/npm/v/glasspane-mcp)](https://www.npmjs.com/package/glasspane-mcp)
[![npm: glasspane-install](https://img.shields.io/npm/v/glasspane-install)](https://www.npmjs.com/package/glasspane-install)
![license: MIT](https://img.shields.io/badge/license-MIT-green)
[![CI](https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml/badge.svg)](https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml)

> 让 AI 代理在 macOS 上"说到做到"的运行时验证引擎 — a runtime verification engine that makes AI agents on macOS prove what they claim.

GlassPane 给 AI 代理（Claude、Cursor 等任意 MCP 客户端）提供一组 `gp_*` 工具：
每一次界面操作都会留下可回放的证据包——操作前后的界面结构对比、像素对比、
归因结论（这次变化是不是这次操作造成的）、以及可一键回到操作前状态的检查点。

## 一键安装（macOS 14+）

```bash
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | bash
```

安装器会编译引擎与界面、装好后台服务（launchd 自启）、打开设置面板。
需要人工完成的两类事只有：① 在系统设置里为「GlassPane Daemon」勾选权限
（辅助功能/输入监控/屏幕录制，面板里有逐卡引导和实测按钮）；② 确认安装。

## 接入 MCP 客户端

安装完成后把下面这段并入你的 MCP 配置（路径以安装输出提示为准）：

```json
{
  "mcpServers": {
    "glasspane": {
      "command": "node",
      "args": ["<仓库目录>/mcp-shell/dist/index.js"]
    }
  }
}
```

也可以直接使用 npm 包：`npm i -g glasspane-mcp`，命令名为 `glasspane-mcp`。

## 工具一览

| 工具 | 做什么 |
|---|---|
| `gp_attach` / `gp_observe` / `gp_act` | 挂接应用、读界面树、执行点击/改值并当场确认真的变了 |
| `gp_assert_element` | 断言某个控件的状态（存在、可用、值正确） |
| `gp_diagnose` | 一次操作没生效时给出分类结论（界面没变？变晚了？被人同时操作？） |
| `gp_snapshot` / `gp_restore` | 检查点与回滚：把应用状态带回操作之前 |
| `gp_export_evidence` | 导出证据包（JSON/HTML），给评审与回归留档 |

## 权限与诚实性设计

- 一切状态以**后台服务自己的身份**实测上报；面板不代测、不猜。
- 拿不到数据就显示「未验证」，永远不会为了好看而点亮。
- 授权对象是 `glasspaned`（或其 app），不是任何终端或设置窗口。

## 更多文档

`specs/` 目录是实现规格与验收记录（P0–P6），`docs` 视角的入口：
- 安装与日常：`specs/GlassPane_P4_*.md` §34
- 权限面板：`specs/GlassPane_P1_实施规格_v1.2_GUI设置面板.md`
- 探针 SDK 与调试桥：`specs/GlassPane_P6_*.md`

## License

MIT — 见 [LICENSE](LICENSE)。
