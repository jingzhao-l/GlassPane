# GlassPane

[English](./README.md) · **简体中文**

[![npm: glasspane-mcp](https://img.shields.io/npm/v/glasspane-mcp)](https://www.npmjs.com/package/glasspane-mcp)
[![npm: glasspane-install](https://img.shields.io/npm/v/glasspane-install)](https://www.npmjs.com/package/glasspane-install)
![license: MIT](https://img.shields.io/badge/license-MIT-green)
[![CI](https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml/badge.svg)](https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/jingzhao-l/GlassPane)](https://github.com/jingzhao-l/GlassPane/releases)

<center>
  <strong>让 AI 代理在 macOS 上"说到做到"的运行时验证引擎。</strong>
</center>

AI 代理说"我点了保存，设置已生效"。这是真的吗？GlassPane 站在代理与操作系统之间：
凡经它执行的界面操作都会留下**可回放的证据包**——操作前后的无障碍树、像素差异实测、
"这次变化是不是这次操作造成的"归因结论，以及可一键回到操作前的检查点。
代理拿到 14 个 `gp_*` MCP 工具；评审者拿到一份"证不出来就写未验证"的报告。

## 目录

- [它改变了什么](#它改变了什么)
- [能力一览](#能力一览)
- [快速开始](#快速开始)
- [安装](#安装)
- [接入 MCP 客户端](#接入-mcp-客户端)
- [工具清单](#工具清单)
- [证据包里有什么](#证据包里有什么)
- [权限与诚实性设计](#权限与诚实性设计)
- [故障排查与 FAQ](#故障排查与-faq)
- [安全](#安全)
- [目录结构](#目录结构)
- [开发](#开发)
- [文档](#文档)
- [与 iterate 生态的关系](#与-iterate-生态的关系)
- [免责声明](#免责声明)
- [许可证](#许可证)

## 它改变了什么

没有 GlassPane 时，代理驱动 macOS 应用只有一个信号：它敲的那条命令返回了什么。
而无障碍 API 常常对"什么都没改变"的操作返回成功——于是代理报告"完成"，
分歧在几天后别人的截图里才暴露。

装上之后，同一个动作走 `gp_act`，返回的是带着证据的答案：命中的是哪个元素、
两侧界面树长什么样、有多少像素动了、操作期间有没有人手同时碰过这个应用、以及怎么撤销。

## 能力一览

- **14 个 MCP 工具，任意 MCP 客户端** —— Claude Desktop、Cursor 等，stdio 接入。
- **执行并当场确认** —— `gp_act` 执行无障碍动作并实测结果，"点了没反应"成为返回事实而非争论。
- **归因而不只是观测** —— `gp_diagnose` 给没生效的操作分类：界面没变 / 变晚了 / 被并发输入污染。
- **检查点与回滚** —— `gp_snapshot` 记录基线，`gp_restore` 重放动作步骤回到基线，或与基线比对。
- **可交付评审的证据** —— `gp_export_evidence` / `gp_recent_reports` 出 JSON/HTML/Markdown 审计报告。
- **可选的应用内探针做强归因** —— [GlassPaneProbe](engine/probe) 是一个可内嵌的 Swift 包；
  探针在线时，归因从"可能是这次操作造成的"升级为"是它造成的，处理器在这里跑过"。
- **调试桥处理疑难场景** —— [bridge/](bridge) 附挂运行中的进程，取无障碍层看不到的崩溃与运行时上下文。
- **构造性诚实** —— 权限与状态由后台服务**以自己身份实测**上报；测不出的就显示未验证，永远不为了好看而点亮。

## 快速开始

**1. 安装**（macOS 14+；clone 的是钉住的发布 tag，因此可复现）：

```bash
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh
```

**2. 授权**：面板打开后，在系统设置里为 **`GlassPane Daemon`** 勾选辅助功能、输入监控、屏幕录制。
这一步无法程序化；面板逐卡引导并在每次勾选后重新实测。

**3. 告诉 MCP 客户端它的存在** —— 安装结束时会自动打印带真实路径的配置片段：

```json
{
  "mcpServers": {
    "glasspane": {
      "command": "node",
      "args": ["<你的仓库目录>/mcp-shell/dist/index.js"],
      "env": { "GLASSPANE_ENGINE_SOCK": "/Users/you/.glasspane/engine.sock" }
    }
  }
}
```

**4. 让代理证明一件事。** 在 MCP 客户端里说：

> 挂接系统设置，找到"深色外观"复选框，用 `gp_act` 切换它，并把"它确实变了"的证据给我看。

成功调用会返回归因结论与前后差异；`gp_export_evidence` 把它变成可阅读、可归档的报告。

## 安装

### 前置条件

| 依赖 | 用途 | 检查命令 |
|---|---|---|
| macOS 14+ | 引擎（无障碍 / HID / 屏幕录制 API） | `sw_vers -productVersion` |
| Xcode Command Line Tools | 编译 Swift 引擎 | `swift --version` |
| Node.js ≥ 18 | MCP 层与安装器 | `node --version` |
| git | 取源码 | `git --version` |
| Python 3.11 | 仅 LLDB 桥测试套件 | `python3 --version` |

安装器对每一项都做真实探测，缺哪项就逐条报哪项，没有"假设它存在"的路径。

### 安装渠道

三条渠道最终走同一份代码，且两条一键渠道 clone 的是**同一个钉住的发布 tag**，不是移动的分支：

```bash
# 1) 一行命令
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh

# 2) 经 npm，无需先 clone
npx glasspane-install

# 3) 自己管源码
git clone --branch v1.1.0 https://github.com/jingzhao-l/GlassPane.git && cd GlassPane && node installer/cli.js
```

`GLASSPANE_REF=<tag>` 指定其他发布版，`GLASSPANE_REF=main` 追主干（不推荐，主干不是固定产物）。
`--no-prompt --no-gui` 为静默安装；`--help` 列全部选项。

### 必须人工完成的事

只有两件：

1. **TCC 权限勾选。** macOS 不允许程序化授权。授权对象是 daemon 本体（`GlassPane Daemon`），
   不是你的终端，也不是设置窗口。
2. **确认破坏性步骤** —— 收拢已在跑的旧实例。

### 首次启动与 Gatekeeper

**在别人机器上装之前先读这段。** 构建产物是 ad-hoc 签名（`codesign --sign -`），
没有 Developer ID 证书，也未公证。作者本机这样没问题；对外部分发时 Gatekeeper 会拒绝首次启动，
需要在系统设置 → 隐私与安全性里手动允许。公证能消除这一步，但它是一个待决且需付费的决策
（Apple Developer Program），记录在 [P6 发布执行记录](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md)。
一条有已知人工步骤的"一键安装"，我们不会把它说成没有门槛。

### 装了什么，怎么卸载

| 路径 | 是什么 |
|---|---|
| `~/Applications/GlassPane.app` | 设置与权限引导面板 |
| `~/Applications/GlassPane Daemon.app` | 后台服务（TCC 授权对象就是它） |
| `~/Library/LaunchAgents/com.glasspane.daemon.plist` | launchd 开机自启作业 |
| `~/.glasspane/engine.sock` | 服务 socket，权限 `0600` |
| `~/.glasspane/evidence/` | 逐操作证据包 |
| `~/.glasspane/installer-daemon.log` | 安装与服务日志 |

```bash
launchctl bootout "gui/$(id -u)/com.glasspane.daemon" 2>/dev/null
rm -f ~/Library/LaunchAgents/com.glasspane.daemon.plist
rm -rf ~/Applications/GlassPane.app ~/Applications/"GlassPane Daemon.app"
rm -rf ~/.glasspane
```

随后在系统设置的四张隐私列表里删掉 `GlassPane Daemon` 条目。
如果只是 launchd 作业丢了（等授权期间很常见），不必手敲 launchctl：

```bash
node installer/cli.js --restore-launchd
```

## 接入 MCP 客户端

两种等价写法：

```jsonc
// 仓库产物 —— 安装器打印的就是这个
{ "mcpServers": { "glasspane": { "command": "node", "args": ["/path/to/GlassPane/mcp-shell/dist/index.js"] } } }

// npm 全局安装 —— 工具集相同
{ "mcpServers": { "glasspane": { "command": "glasspane-mcp" } } }
```

`npm i -g glasspane-mcp` **只装转发层**，它仍然需要上面安装器产出的后台服务。
服务不可达或权限缺失时，工具调用返回带补救命令的结构化错误——照命令执行即可，不必翻文档。

## 工具清单

权威清单以运行时 `tools/list` 返回为准，下表是地图不是规格。

| 分组 | 工具 | 做什么 |
|---|---|---|
| 驱动 | `gp_attach` | 按 `bundleId` 或 `pid` 挂接运行中的应用 |
| | `gp_observe` | 快照应用的无障碍树 |
| | `gp_act` | 执行无障碍动作（`press`/`increment`/`decrement`/`showMenu`/`confirm`/`cancel`/`pick`）并确认效果 |
| 校验 | `gp_assert_element` | 断言控件属性：存在、可用、值符合预期 |
| | `gp_diagnose` | 给没生效的操作分类：没变 / 变晚了 / 并发输入污染 |
| 证据 | `gp_last_evidence` | 取最近（或指定）操作的完整证据包 |
| | `gp_export_evidence` | 把一次操作的包渲染成 HTML/Markdown 审计报告 |
| | `gp_recent_reports` | 把最近 N 次操作汇总成一份审计视图 |
| 回滚 | `gp_snapshot` | 记录无障碍树的摘要基线 |
| | `gp_restore` | 重放动作步骤回到基线，或与基线比对 |
| 探针 | `gp_probe_status` | 哪些应用有在线 `GlassPaneProbe`，它报了些什么 |
| 项目 | `gp_project_list` / `gp_project_set` / `gp_project_get` | 项目维度的配置登记与读取 |

注意 `gp_act` 用的是无障碍 API 自带的动作动词：它不直接写控件值，也不合成 HID 事件。
滑杆/步进器会变，是因为 `increment`/`decrement` 本身就是合法的无障碍动作。

## 证据包里有什么

每次操作产出一个带版本的 `glasspane.evidence` 包（JSON，schema 见
[kernel/schemas](kernel/schemas)）：

- **目标选择器** —— 元素是怎么被识别出来的，不只是它的显示名；
- **前后无障碍树**与两者结构差异；
- **像素差异实测**（比例与区域；原始截图不落盘）；
- **归因结论**：默认 `weak`，只有目标应用内在线的 `GlassPaneProbe` 确认处理器跑过才升 `strong`；
- 操作期间有其他输入进来时的**污染标记**；
- `gp_restore` 所需的**检查点步骤**。

`soft → strong` 依赖探针自报 pid，而同用户进程都可以这么做——所以 `strong` 的含义是
"一个配合的应用确认了这件事"，不是"密码学意义上的证明"。见 [SECURITY.md](SECURITY.md)。

## 权限与诚实性设计

- 状态由**后台服务实测自身**上报，不由界面推断；面板不代测、不猜。
- 读不到的权限显示**未验证**。没有任何指示灯为了好看而点亮；开发者工具卡尤其如此，
  它不会借用别的卡的读数。
- daemon 必须由 launchd 或登录项拉起，其自报才等于真实授权席位；从终端起的实例会继承
  **启动者**的判定，所以面板显示的是它实际测到的主体。
- 证据与审批记录是哈希链审计台账，记录发生了什么，不是执行拦截。

## 故障排查与 FAQ

**Gatekeeper 说应用无法打开/来自 unidentified developer。**
符合预期：产物 ad-hoc 签名且未公证（见[安装](#安装)）。在系统设置 → 隐私与安全性里允许后重开。

**我勾了权限，卡片还是红的。** 多半勾到了别的主体——条目必须是 `GlassPane Daemon`，
不是终端也不是 `GlassPane.app`。卡片会显示它测到的主体；重跑
`node installer/cli.js --restore-launchd`，它会把服务换到 launchd 下并复验。

**面板开着，工具还是报错。** 面板不是服务。检查 `~/.glasspane/engine.sock` 是否存在、
服务二进制 `--permissions` 是否应答。若 socket 被旧构建占着，用 `--replace-daemon` 重跑安装——
否则你授权的那个应用和干活的那个应用不是同一个。

**数据会离开本机吗？** 不会。服务是本机 unix socket，MCP 层是本机 stdio，证据留在
`~/.glasspane/`。但注意 `gp_observe` 会把无障碍树送进代理对话，你的模型服务商记录什么，
就等于记录了那棵树——把会话内容按敏感处理。

**怎么确认自己跑的是哪个版本？** 服务 `--permissions` 自报、设置面板同值、
MCP `initialize` 响应里回显，`node scripts/check-version.mjs` 会打印版本号出现的每一处。
它们都来自同一个数字（[CHANGELOG.md](CHANGELOG.md)）。

**支持哪些 macOS 版本？** 14 及以后。引擎的真实行为（无障碍时序、事件监听、屏幕录制）
就是按这个范围测的；更早版本不在范围内。

## 安全

GlassPane 持有辅助功能、输入监控与屏幕录制权限，注册 launchd 作业，还能附挂调试器——
它既强，也是攻击面。漏洞报告方式见 [SECURITY.md](SECURITY.md)；
不要把日志或证据包贴进公开 issue。

## 目录结构

```
GlassPane/
├── install.sh          一键入口：定位/取源码，委托 installer
├── installer/          零依赖 Node 安装器 → npm `glasspane-install`
├── engine/             Swift 包：glasspaned 服务、设置界面、无障碍通道
│   ├── probe/          GlassPaneProbe（内嵌后可做强归因）
│   └── scripts/        make-app.sh —— 两个 .app 的打包与 ad-hoc 签名
├── mcp-shell/          TypeScript MCP stdio 服务 → npm `glasspane-mcp`
├── kernel/             JSON Schema 真源，与 iterate 生态共享
├── bridge/             Python LLDB 调试桥（崩溃/运行时采集）
├── spike/              可行性实验与留档结果
├── scripts/            set-version / check-version —— 单一版本线
├── specs/              实施规格与验收记录（P0–P6、PRD）
├── ITERATE.md          iterate 技能的项目知识库（本仓自吃狗粮）
├── iterate.config.yaml 审查维度、可信门禁命令、禁区与风险区
└── .github/workflows/  ci.yml（5 条 lane + 发布形态守卫）、release.yml
```

## 开发

环境准备、各条测试通道怎么跑、提交与 PR 约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。简版：

```bash
npm ci && npm run build && npm test --workspaces --if-present   # TS：kernel / mcp-shell / installer
cd engine && swift build && swift test                          # Swift 引擎与探针
cd bridge && python3 -m pytest -q                               # LLDB 桥
node scripts/check-version.mjs                                  # 版本线漂移检查
```

CI 除这些通道外还跑**发布形态守卫**：打包 `glasspane-mcp` → 装进干净目录 → 完成 MCP
`initialize` 握手。因为打包类缺陷（`file:` 依赖失联、schema 缺文件）只在发布产物里现形，
本地跑永远看不到。

有些验收项按设计不能进 CI：无障碍、事件监听与屏幕录制需要登录的 GUI 会话和已授权限。
它们以真机冒烟记录留在 [engine/smoke.md](engine/smoke.md)，而不是被静默跳过。

发布：`node scripts/set-version.mjs <semver>` 写整条版本线；打 tag 触发 GitHub Release
（源码 tarball + `SHA256SUMS.txt`）；npm 发布走 `release.yml` 的 provenance 通道。

## 文档

`specs/` 是设计真源与验收台账，主张在哪里被验证、哪里没有被验证都记在那里，
因此它最接近参考手册：

| 文档 | 范围 |
|---|---|
| [PRD](specs/GlassPane_PRD_v1.0.md) | 产品定义 |
| [项目综述 5.8](specs/GlassPane_5.8_项目综述文档.md) | 最近一次全项目综述 |
| [P0](specs/GlassPane_P0_实施规格_v1.0.md) | 证据内核：attach / observe / act / 归因 |
| [P1](specs/GlassPane_P1_实施规格_v1.2_GUI设置面板.md) | 检查点、证据生命周期、GUI 权限面板 |
| [P2](specs/GlassPane_P2_实施规格_v2.0_并发归因污染防护.md) | 并发归因污染防护、渐进退化检测 |
| [P3](specs/GlassPane_P3_实施规格_v3.0_三方消费者一致性.md) | 三方消费者一致性、MCP 消息层、桥形态 |
| [P4](specs/GlassPane_P4_实施规格_v4.0_收口与里程碑一致性.md) | 里程碑收口、npm 命名决策链、一键安装 |
| [P5](specs/GlassPane_P5_实施规格_v5.0_方向候选四连批.md) | 方向候选 |
| [P6](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md) | 探针 SDK、LLDB 桥、公开发布执行记录 |

## 与 iterate 生态的关系

`kernel/` 是作者 [iterate](https://github.com/jingzhao-l/iterate-skill) 生态的共享 schema 契约层
（`@iterate/kernel`）：同一批 JSON Schema 同时被 iterate 的多轮评审、GlassPane 服务与 MCP 层消费，
双语绑定用共享 fixture 校验。GlassPane 是这对搭档里的运行时验证半边——
iterate 审"代码写得对不对"，GlassPane 证"代理说的界面效果真的发生了没有"。
发布时 kernel 被捆绑进 `glasspane-mcp`，npm 包不会带着指回本仓库的 `file:` 依赖。

本仓库同时吃自己的狗粮：[ITERATE.md](ITERATE.md) 与 [iterate.config.yaml](iterate.config.yaml)
就是本项目的 onboarding 产物，`/iterate` 在这里审查时用的门禁命令与 CI 强制的完全一致。
2026-09-22 实测：`iterate doctor` 18 项全部通过、`iterate fingerprint` 无漂移。

## 免责声明

GlassPane 在真实桌面上驱动真实应用，持有读屏与操作其他应用界面的权限。请只在你有意控制的应用上
运行，不要把证据目录放在共享位置，并把它导出的报告视为"包含屏幕上出现过的内容"。
归因结论是实测与推断，不是关于程序内部行为的保证——一个应用若对自己的无障碍树说谎，
任何观测方都可能被误导，这正是探针通道存在的理由。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
