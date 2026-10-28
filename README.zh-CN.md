# GlassPane

> [English](./README.md) · **简体中文**

<center>
  <strong>macOS 上给 AI 编程代理用的 GUI 测试与验证层。</strong><br/>
  让代理自己去操作应用、断言界面真的变了、并把证据拿出来——而不是给你发一张截图。
</center>

<br/>

<p align="center">
  <a href="https://www.npmjs.com/package/glasspane-mcp"><img src="https://img.shields.io/npm/dt/glasspane-mcp?label=%E7%B4%AF%E8%AE%A1%E4%B8%8B%E8%BD%BD&style=for-the-badge&color=2ea44f&logo=npm&logoColor=white" alt="npm 累计下载"></a>
  <a href="https://github.com/jingzhao-l/GlassPane/releases"><img src="https://img.shields.io/github/v/release/jingzhao-l/GlassPane?style=for-the-badge" alt="GitHub release"></a>
  <a href="https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml"><img src="https://github.com/jingzhao-l/GlassPane/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge" alt="License"></a>
  <a href="https://github.com/jingzhao-l/GlassPane"><img src="https://img.shields.io/github/stars/jingzhao-l/GlassPane?style=social&label=Star" alt="GitHub stars"></a>
</p>

> 想支持这个项目？点一个 GitHub **Star** 就是最好的感谢，也能让更多人发现 GlassPane。

---

## 目录

- [这项目是什么 / About This Project](#这项目是什么-about-this-project)
- [能力一览 / At a Glance](#能力一览-at-a-glance)
- [快速开始 / Quick Start](#快速开始-quick-start)
- [安装 / Installation](#安装-installation)
- [用法 / Usage](#用法-usage)
- [MCP 工具参考 / MCP Tool Reference](#mcp-工具参考-mcp-tool-reference)
- [它如何工作 / How It Works](#它如何工作-how-it-works)
- [配置 / Configuration](#配置-configuration)
- [常见问题 / FAQ](#常见问题-faq)
- [安全 / Security](#安全-security)
- [目录结构 / Directory Structure](#目录结构-directory-structure)
- [贡献 / Contributing](#贡献-contributing)
- [免责声明 / Disclaimer](#免责声明-disclaimer)
- [许可证 / License](#许可证-license)

---

## 这项目是什么 / About This Project

**GlassPane** 是 macOS 上给 AI 编程代理用的运行时验证层。你的代理会写代码、跑 linter、过单元测试。
但它说不出自己点的那个设置开关到底动没动——因为对一个 GUI 应用而言，代理没有"看"的通道。
于是只有两种结局：要么未经确认就宣布成功，要么截个图靠猜坐标。

GlassPane 补的就是这半个闭环。它把 macOS 应用的界面通过 MCP 暴露成一个结构化、可脚本化的测试面：
代理执行一个无障碍动作，拿回的是**这次动作造成的变更**——按元素定位的树差异加一个像素数值测量——
而不是一张需要它盯着看的图。它可以断言控件状态、把应用回滚到检查点、导出人类可复核的证据。
构建 → 到达状态 → 操作 → 观察 → 诊断 → 修复 → 重验，中间不必每一轮都插一个人。

它真正跑的是一条闭环：

```text
attach → observe → act → measure the change → assert → diagnose if nothing moved
       → roll back to the checkpoint → export the evidence pack
```

### 两个 GlassPane 项目

**GlassPane 是一对产品里的一半。** 另一半是 **[GlassPane Harness](https://github.com/jingzhao-l/glasspane-harness)**，
一个在终端里干活、原生带着同一套 `gp_*` 面的编程代理。两个项目可以分别安装、分别使用，但设计上共用一份契约：

- **本仓库 —— 引擎与传输层。** Swift 后台服务负责测量应用；`glasspane-mcp` 把这套测量通过 MCP 交给
  Claude Desktop、Cursor 或任何其他 MCP host。用下面那条一键安装命令装。
- **[GlassPane Harness](https://github.com/jingzhao-l/glasspane-harness) —— 代理侧。** 一个 AI 编程代理
  （上游 [opencode](https://github.com/anomalyco/opencode) 的 fork），通过原生 `gp_*` 工具调引擎，
  把每条已验证的调用追加进哈希链决策账本，并在长会话被压缩时把这些证据锚点重新注入。它从 npm 安装；
  它要求引擎已在运行且已授予辅助功能，条件不满足时会打印确切的补救命令。

分工：**应用做了什么由引擎判定，harness 只负责转写，绝不自行发明一个判定。**
两个产品都不是对方私有 API 的客户端——它们吃的是同一份公开发布出去的契约层，所以跨越边界的格式只有
一份定义，而不是两份各自演化的文件。harness 也可以单独安装：

```bash
# 代理侧。需要先把下面这条引擎装好、跑起来并授予辅助功能。
npm install -g glasspane-harness
```

> 本文余下部分描述的是**本仓库**：引擎、MCP 层与安装器。harness 有自己的 README——
> [GlassPane Harness](https://github.com/jingzhao-l/glasspane-harness)（源码
> [`harness/glasspane-harness/README.md`](harness/glasspane-harness/README.md)）。

### 它解决的问题

在 macOS 上，代理的工具链把开发的**静态半场**cover 得很好：编译、类型检查、审查、跑终端里的测试。
GUI 应用的**运行时半场**则是断崖：

| 循环 | 今天谁能做 |
|---|---|
| 写代码 → 静态审查 → 单元测试 | 代理本来就会 |
| 构建 → 启动应用 → 到达某个界面状态 → 操作 → **观察** → 诊断 → 修复 → 重验 | **缺失**，或者靠"截图 → 视觉理解 → 坐标操作" |

没有第二行，你就没有一个能自主干活的 macOS 开发者，只有一个乐观汇报的打字机。后果很具体：
"复选框接好了"其实意味着事件处理器从没跑过；布局退化上线了因为没人看；同一个修复被打三次，
因为代理看不见前两次根本没生效。

GlassPane 给代理装上带账本的眼睛和手：

- **手** —— `gp_act` 按角色/标题/层级定位元素并执行无障碍动作，报告界面有没有响应；
- **眼** —— `gp_observe` 返回无障碍树；`gp_assert_element` 把五个控件属性之一（`title`/`value`/`role`/`enabled`/`focused`）判成过或不过；
  受影响窗口区域给出像素变化数值；
- **判断** —— `gp_diagnose` 给"没生效"分类：界面没变、变得晚了、还是有人同时操作污染了测量；
- **撤销** —— `gp_snapshot` / `gp_restore` 把应用带回之前的状态，代理能重跑测试，
  而不是把你的机器留在半配置状态；
- **证明** —— `gp_export_evidence` / `gp_recent_reports` 把这一切渲染成 HTML 或 Markdown 报告，作为文本随会话结果返回——它们不接收路径、也不写文件，要存进浏览器或跟着 commit 归档是你自己的一步；只有设置面板的「打开报告」按钮会把报告落盘。

### 为什么不是截图

"截屏 + 问视觉模型"是一个真实存在的选项，也是大多数代理配置的默认归宿。但作为验证回路它是错的工具，
理由与模型好坏无关：

| | 截图 + 视觉模型 | GlassPane |
|---|---|---|
| 关注单位 | 一片像素 | 具名元素（`AXCheckBox "深色外观"`、它在树里的路径） |
| 一次操作的结果 | 一张需要解读的图 | 结构化的变更差异 + `changedPixelRatio` 与其区域 |
| 断言 | "这看着像可用的吗" | 对具体控件属性的过/不过 |
| 因果 | 假定 | 归因；应用内嵌 [GlassPaneProbe](engine/probe) 时可升到 `strong` |
| 可重复性 | 每次图不同、答案可能不同 | 同样的查询、同样的判定，报告可 diff |
| 单次检查成本 | 每次观测一个视觉模型往返 | 一次本机的无障碍查询 |
| 回滚 | 无 | 检查点与恢复 |
| 审计留痕 | 你的聊天记录 | 落在盘上的证据包 |

最后两行是关键：截图流程答不了"把它恢复回去"，也答不了"拿证据给我看"——它只能重开一次对话。

也说清代价的另一面：视觉模型仍能判断 GlassPane 不判断的东西——视觉品味、一个设计**看起来**对不对、
或者某个根本不暴露无障碍树的视图内容。GlassPane 负责测量，不负责审美。两者各自用于所擅长之处。

### 与 iterate 生态的关系

共享 schema 契约层是作者 [iterate](https://github.com/jingzhao-l/iterate-skill) 生态的内核，
发布为 [`iterate-kernel`](https://www.npmjs.com/package/iterate-kernel)：同一批 JSON Schema 同时被
iterate 的多轮评审、GlassPane 服务与 MCP 层消费，双语绑定用共享 fixture 校验。两半互补——iterate 审
"这段代码对不对"，GlassPane 验"跑起来的应用是不是真像代理所说的那样变了"。两个 TypeScript 消费者各自
装那一份发布包：`mcp-shell` 把它捆进 `glasspane-mcp`（所以发布物里没有指回本仓库的 `file:` 依赖），
fork 经自己的 lockfile 解析它，出处记在
`harness/glasspane-harness/contracts/kernel-pin.json`。[kernel/](kernel/) 因此只剩那份包的**被钉语料**
——`fixtures/` 与 `schemas/`——因为 Swift 的 C35 腿和归档的要求清单读的是这些字节，而它们读不到
TypeScript。

本仓库同时吃自己的狗粮：[ITERATE.md](ITERATE.md) 与 [iterate.config.yaml](iterate.config.yaml)
就是本项目的 onboarding 产物，`/iterate` 在这里审查时用的门禁命令与 CI 强制的完全一致。
2026-09-22 实测：`iterate doctor` 18 项全部通过、`iterate fingerprint` 无漂移。

---

## 能力一览 / At a Glance

- **16 个 MCP 工具（stdio）** —— Claude Desktop、Cursor 或任意 MCP host；`tools/list` 是权威面。
- **执行并当场确认** —— 操作直接返回它造成的变更，"我点了但没反应"成为对话里的事实而非争论。
- **元素级断言** —— `title`/`value`/`role`/`enabled`/`focused` 之一，返回布尔并附上被解析到的选择器。
- **界面可操作性审计** —— `gp_audit_ui` 走一遍元素几何并套用确定性规则：零尺寸、落在窗口外的控件判
  阻塞；命中目标过小、被裁切、互相重叠判提示。量不到的部分永远不计入"通过"，重叠扫描被截断时它自己会
  说明。大界面上遍历可能按预算提前停止：那时它交出已测到的部分并标 `complete: false`，而不是什么都不给。
- **数值化像素验证** —— 目标区域变了多少、变在哪，本机算出；这条测量通路不存储、也不外发截图。
- **有强度等级的归因** —— 默认 `soft`；被测应用内嵌探针 SDK 并确认处理器跑过时才 `strong`，
  只有操作期间被检测到人手介入才降为 `weak`。
- **污染检测** —— 操作中途有人手介入，测量会如实这么说，而不是悄悄把变化算给代理的那一次点击。
- **检查点与回滚** —— 记录基线，按录制的步骤重放回到基线。
- **崩溃与运行时采集** —— [LLDB 调试桥](bridge) 附挂进程，取无障碍层看不到的现场。
- **显式的视觉审查通道** —— `gp_capture_view` 在问题确实是"看上去对不对"时，把窗口的一张 PNG
  交给**你自己的**模型。它是过路通道：引擎编码后什么都不写，图像进到会话里就停在那里。
- **按项目隔离配置** —— 每应用的存储路径、配方与校准根，走 `gp_project_*`。
- **构造性诚实** —— 没测出来的一律"未验证"。指示灯不为了好看而点亮，权限面板与判定结论同理。

---

## 快速开始 / Quick Start

**1. 安装**（macOS 14+；npm 优先——它最短，而且会把 `glasspane doctor` / `glasspane update` 一起留下）：

```bash
npx glasspane-install
```

走脚本那条渠道是同样的一条命令（先取回脚本、再执行——刻意分两步。用管道给 `sh` 时，curl 自己失败会
让 stdin 是空的，`sh` 直接 EOF 退 0：一次什么都没装的运行对外报的是成功）：

```bash
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh
```

两条都拉取钉住的发布 tag，因此可复现；第三条与各自的代价见[安装渠道](#安装渠道)。

**2. 授权**：面板打开后，为 **`GlassPane Daemon`** 勾选辅助功能、输入监控、屏幕录制。
macOS 禁止程序化授权，所以这是唯一的人工步骤；面板逐卡引导并在每次勾选后重新实测。

**3. 注册 MCP 服务** —— 安装结束会自动打印带真实路径、可直接粘贴的配置：

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

**4. 给代理一个测试任务，而不是一个问题。** 有效的句式：

> 构建并启动应用，打开设置，用 `gp_act` 切换"深色外观"，用 `gp_assert_element` 断言复选框已勾选；
> 如果哪一步没生效就用 `gp_diagnose` 分类，最后恢复原状态并把证据给我看。

你会拿到带前后差异的判定，以及一份由 `gp_export_evidence` 作为 HTML/Markdown 文本随会话返回的报告（它不写文件——只有面板的「打开报告」按钮才落盘）。

如果你想要的是闭环里的代理那一侧、而不是自己接一个 host，在第二步之后装上
[GlassPane Harness](#两个-glasspane-项目)。

---

## 安装 / Installation

### 前置条件

| 依赖 | 用途 | 检查命令 |
|---|---|---|
| macOS 14+ | 引擎（无障碍 / 屏幕捕获 API） | `sw_vers -productVersion` |
| Xcode Command Line Tools | 编译 Swift 引擎 | `swift --version` |
| Node.js ≥ 18 | MCP 层与安装器 | `node --version` |
| git | 取源码 | `git --version` |
| Python 3.11 | 仅 LLDB 桥测试套件 | `python3 --version` |

安装器的预检探的是这张表里"能用一条命令问到主机"的那些行——Swift 工具链（`swift`）、Node.js ≥ 18（`node`）、
`git`——外加表里没列的 `npm` 与 `open`：那两项不是谁要去满足的要求，而是上面那几行装的东西的一部分。
它一共实测**五个命令**，这个数的真源是 `installer/cli.js:PREFLIGHT_PROBED_COMMANDS`；缺哪项就逐条报哪项、当场停住。
`macOS 14+` 与 `Python 3.11` 那两行安装期不探测，表里给的是你自己核的命令：
macOS 主版本由 LaunchServices 打开 bundle 时强制（`LSMinimumSystemVersion` = 14.0），
`python3` 只有 LLDB 桥测试套件需要，缺它表现为那套测试失败而不是安装被拒。
它确实探测的这五个命令没有"假设它存在"的路径；不探测的那两行也不假装探测——行里写清了谁去核。

### 安装渠道

三条渠道最终走同一份代码；两条一键渠道 clone 的是**同一个钉住的发布 tag**，不是移动的分支，
所以同一天两次安装拿到同一份源码。**npm 排第一**：它最短，也是唯一一条会把 `glasspane` 这条命令
一起留在 PATH 上的路，而更新器在自己够不着 npm 时给出的那句补救走的也是同一条渠道。

```bash
# 1) 经 npm（自己引导 clone 钉住的 tag，然后构建、安装）。想让 `glasspane` 这条命令长期留着：
#    npm install -g glasspane-install，然后 glasspane-install，之后 glasspane doctor / glasspane update。
npx glasspane-install

# 2) 先取回脚本再执行，分两步：`curl … | sh` 那条管道里，curl 自己失败时 `sh` 读到的是空输入，
#    整条管道照样退 0——而读退出码的正是不在场的 agent 与 CI，它必须是真的那个。
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh -o /tmp/gp-install.sh && sh /tmp/gp-install.sh

# 3) 自己管源码：`install.sh` 钉的是本次发布那一个 tag（它的 `GLASSPANE_RELEASE` 默认值，
#    每次发版由 `scripts/set-version.mjs` 改写）——要装未发布的树才去 `main`。下面那个 tag 不靠人眼
#    核对：它是 `scripts/version-sites.mjs` 登记的派生位点，一旦与 install.sh 不一致，
#    `scripts/check-doc-links.mjs` 就把这一页判红。
git clone --branch v1.24.1 https://github.com/jingzhao-l/GlassPane.git && cd GlassPane && node installer/cli.js
```

npm 不交付的东西也说清：Swift 引擎。上面三条渠道最后都要在你这台机器上跑一次 `swift build`——
npm 上的 `glasspane-mcp` 是传输层、`glasspane-install` 是安装器，都不是预编译好的 app bundle。
把这句话说反，就是让人先装完上面那张依赖表，然后等一个永远不会出现的二进制。

### 装完之后：一条命令，三个动词

`glasspane-install` 会在 PATH 上留下第二条命令。它要回答的是那句"面板按钮失败了，而我不知道自己
装到了哪里"：

```bash
glasspane doctor    # 读这台机器：安装指针、更新器状态、在册的 daemon 作业、socket、两个全局 npm 包。
                    # 每格一行；读不出来的那格就说读不出来——"没有"和"我没看成"是两种答案
glasspane update    # 先检查，再装上通过校验的那一份；退出码沿用更新器自己的那一个
glasspane status    # 把更新器自己的那一行结论原样打出来
```

它一切都按 `~/.glasspane/update-install.json` 走——那个文件是安装器写的、也是面板读的，所以它不会
从当前目录猜一份安装出来。它不 sudo、不删任何东西；需要人做的那一步只把工具名和目录写出来，
不会交出一条可以照着敲的升权命令。

`GLASSPANE_REF=<tag>` 指定其他发布版；`GLASSPANE_REF=main` 追主干（它不是固定产物）。
`--no-prompt --no-gui` 为静默安装；`--help` 列全部选项。

### 必须人工完成的事

1. **TCC 权限勾选。** 授权对象是 daemon 本体（`GlassPane Daemon`），不是你的终端，也不是设置窗口。
2. **确认破坏性步骤** —— 收拢已在跑的旧实例。

### 首次启动与 Gatekeeper

**在别人机器上装之前先读这段。** 构建产物是 ad-hoc 签名（`codesign --sign -`），
没有 Developer ID 证书，也未公证。在你自己这台机器上无感；对外部分发时 Gatekeeper 会拒绝首次启动，
需要在系统设置 → 隐私与安全性里手动允许。公证能消除这一步，但它是一个暂缓且需付费的决策
（Apple Developer Program），记录在 [P6 发布执行记录](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md)。
一条含已知人工步骤的"一键安装"就该把这句话写出来。

### 装了什么，怎么卸载

| 路径 | 是什么 |
|---|---|
| `~/Applications/GlassPane.app` | 设置与权限引导面板 |
| `~/Applications/GlassPane Daemon.app` | 后台服务（TCC 授权对象就是它） |
| `~/Library/LaunchAgents/com.glasspane.daemon.plist` | launchd 开机自启作业 |
| `~/Library/LaunchAgents/com.glasspane.update.plist` | 每日更新检查的 launchd 作业 |
| `~/.glasspane/engine.sock` | 服务 socket，权限 `0600` |
| `~/.glasspane/evidence/` | 逐操作证据包 |
| `~/.glasspane/installer-daemon.log` | 安装与服务日志 |
| `~/.glasspane/update-state.json`、`update-install.json`、`update.log`、`update-staging/`、`update-backup/` | 更新状态、更新器位置记录、日志，以及下载暂存与回滚备份 |

```bash
launchctl bootout "gui/$(id -u)/com.glasspane.daemon" 2>/dev/null
launchctl bootout "gui/$(id -u)/com.glasspane.update" 2>/dev/null
rm -f ~/Library/LaunchAgents/com.glasspane.daemon.plist
rm -f ~/Library/LaunchAgents/com.glasspane.update.plist
rm -rf ~/Applications/GlassPane.app ~/Applications/"GlassPane Daemon.app"
rm -rf ~/.glasspane
```

随后在系统设置的四张隐私列表里删掉 `GlassPane Daemon` 条目。如果只是 launchd 作业丢了
（等授权期间很常见），不必手敲 launchctl：

```bash
node installer/cli.js --restore-launchd
```

### 让 GlassPane 保持最新

安装时会注册一个用户级的定时作业：每天问一次发布页有没有新版本，允许的话就把新版本换上。
操作它的是 `GlassPane.app` 里的「更新」页。

- **更新的是什么**：`~/Applications` 里的两个 bundle（设置面板与后台服务；换版后服务会被重启），
  以及两个全局 npm 包 `glasspane-mcp`、`glasspane-install`。它们全部出自**同一个**校验过校验和的
  发布压缩包——npm 包是从这份已校验的解包树里现场打出来的，不再去 registry 另取一份，
  所以「验过的代码」和「装上的代码」不可能是两份东西。
- **什么时候更新**：每天到点跑一次，默认本地 12:00（`enable --hour 3 --minute 45` 可改时间）。
  换版只在后台服务空闲时发生，不会在代理正在你屏幕上执行动作的中途动手；服务忙就这一轮作罢，
  下一个时间窗再试。
- **现在就想查一次 / 手动装**：点「立即检查」拉取并校验，再点「安装更新」装上通过校验的那一份。
  上方状态卡会给出当前版本、最新版本、上次检查时间、待装版本，以及它的完整 `sha256`——
  想确认自己装的是什么，可以复制后与发布页核对。`gp_diagnose` 也给代理同样的答案：
  这台机器的 GlassPane 旧不旧、现在停在哪个结论上。也可以在终端里做，不用去翻自己装到了哪：
  `glasspane update`，事情没接上的时候先 `glasspane doctor`。
- **一半没成不取消另一半。** 一次更新有两层：`~/Applications` 里那两个 bundle，以及两个全局 npm 包。
  如果这一趟够不着 npm、或者写不进 npm 放全局包的那一层，bundle 照装、daemon 照重启并读回版本，
  结论是 `applied` 带着 `npm-not-refreshed`：同一句话里给出剩下那一半唯一能照抄运行的命令
  （`npm install -g glasspane-mcp@<版本> glasspane-install@<版本>`），并且这一句会一直挂在面板与
  `gp_diagnose` 上，直到那行命令被跑过。它换掉的是从前那种"整场拒绝"——那台机器连着几天停在旧版本上，
  而它本来就没有那两个全局包。
- 没有可装之事可做的按钮**不会消失，而是灰掉并在下面写一行原因**——面板不靠藏起来回避解释，
  也不把失败显示成成功。
- **跨大版本永不自动应用。** 它只是停在页面上等着，并写清理由（跨大版本升级，可能改变对外行为），
  由你按下「安装更新」这一下才算确认；这个确认的作用就是 `--consent major`，而定时运行没有它。
  它不是被悄悄跳过了。
- **没人签名的 release 也不会被定时装上。** 自 `v1.5.0` 起的每一个 release 都为它的校验文件附上一份
  detached GPG 签名，而签名是发布工作流跨不过去的一步：签名没产出、或落盘的是空文件，Release 就不会被
  创建。更新器用随程序分发的那把公钥验签——"这是谁发布的"从此由假设变成可检查的主张（它的准确含义只是
  "与我们发布的 key 相符"）。没什么可验的只有更早的那些 tag——`v1.4.0` 当次 CI 没发出签名（签名步被静默
  跳过，两份 `.asc` 是事后用同一把 key 手工补签的），`v1.3.1` 早于签名 job。所以：release 压根没发签名，
  或这台机器没有 `gpg`——定时运行会停下并在页面上写明原因；人可以自己放行一次：
  `updater check --consent unsigned-release`，此后状态文件与 `gp_diagnose` 会一直写明这一版是
  **无作者性证明装上的**。签名发了却对不上则是直接硬拒，任何 consent 都不能覆盖。「安装更新」这个按钮
  给不了这条确认（它今天只带 `--consent major`），但也用不上终端：检查正是因为这道门停下来的时候，同一页
  会给出「信任这个发布并重新检查」，按下它就是 `updater check --consent unsigned-release`。终端那条写法留给
  没有图形会话的机器。
- **永久关掉自动更新**，下面三条任一即可，最后一条最硬：

  ```bash
  node installer/cli.js --no-auto-update    # 安装时就不注册那个定时作业
  node "<更新器路径>" disable               # 之后任意时刻关掉；enable 可逆
  GLASSPANE_UPDATE_DISABLE=1               # 连之后的 enable 都拒绝，因此重装也不会把它带回来
  ```

  `<更新器路径>` 就是这一页「更新器 → 程序」列出的那个路径。关掉不等于这页消失：面板会继续写
  「自动更新已关闭（上次检查：X）」，而「立即检查」与「安装更新」照样能用——这个开关管的是定时，
  不是你手动更新的能力。
- **到点时这台机器是睡着或关着的**：睡眠中错过的运行 macOS 会在唤醒后补跑，关机期间错过的不会。
  所以这件事不指望补跑：只要这一页没有更该先告诉你的事（有一份待装版本、或上一次被拒以及为什么被拒），
  距上次检查超过 36 小时就会显示「检查已过期」，写明上次检查其实是多久之前，并把「立即检查」开给你按。
- **「回滚需要人来收尾」指的是退出码 5**：新版本已经装上、重启后读回自检没过，而把旧版本放回去这一步
  也没能被验证通过。到这一步工具不再自己猜：「安装更新」会被禁用，原因那一行会写明「自动退回没成功，
  请先人工重新安装」——也就是重跑一次[安装器](#安装渠道)把 `~/Applications` 从源码重建出来，再回到
  这一页。如果退回是验证成功的（退出码 4），你已经在旧版本上，页面会直接这么说。

---

## 用法 / Usage

### 在 AI 助理里

一个测试任务是一串代理能执行、能验证的步骤，而不是一个要靠它理解的提问。四个动词直接落在工具面上：

| 你想知道 | 代理要调 |
|---|---|
| "应用在跑、挂上了吗？" | `gp_attach`，再用 `gp_probe_status` 取引擎自报 |
| "屏幕上是什么？" | `gp_observe` |
| "拨一下开关，告诉我发生了什么" | `gp_act`（返回它造成的变更） |
| "现在勾上了吗？" | `gp_assert_element`（`title` / `value` / `role` / `enabled` / `focused`，过或不过） |
| "为什么没动？" | `gp_diagnose`（没变 / 晚到 / 被污染） |
| "把证据给我看" | `gp_last_evidence`、`gp_export_evidence`、`gp_recent_reports` |
| "把它恢复回去" | `gp_snapshot`，然后 `gp_restore` |

两条经验决定你拿到的是验证还是一次猜测：

- **要差异，不要描述。** "拨一下并断言复选框"给出可测结果；"拨一下告诉我成没成"只会招来一段散文。
- **把回滚写进同一个任务。** 如果这次运行会留下配置，就在指令末尾加上 `gp_restore`，
  失败的一次尝试才不会在你的机器上越积越多。

### 在终端里

终端负责安装、服务存活与更新线——不负责驱动应用。驱动应用一律由 MCP host 发起。

```bash
# 安装 / 修复 / 重挂 launchd 作业
node installer/cli.js
node installer/cli.js --restore-launchd

# 问 daemon 自己是否活着（面板不是服务）
printf '{"id":0,"method":"hello"}\n' | nc -U ~/.glasspane/engine.sock

# 检查更新器与版本线
node "<更新器路径>" check
node scripts/check-version.mjs
```

### 接入 MCP 客户端

**给 MCP 客户端**的两种等价写法（这个包还装了第三个命令，见本节末尾）：

```jsonc
// 仓库产物 —— 安装器打印的就是这个
{ "mcpServers": { "glasspane": { "command": "node", "args": ["/path/to/GlassPane/mcp-shell/dist/index.js"] } } }

// npm 全局安装 —— 工具集相同
{ "mcpServers": { "glasspane": { "command": "glasspane-mcp" } } }
```

`npm i -g glasspane-mcp` **只装转发层**，服务仍要上面那个安装器产出。服务不可达或权限缺失时，
工具调用返回带补救命令的结构化错误——照命令执行即可，不必翻文档。

同一个包还装第二个命令 `glasspane-http`（并以 `./http-gateway` 公开，实测自
`mcp-shell/package.json` 的 `bin` 与 `exports`）。它不是第三种 MCP 写法：把 HTTP/REST 调用方
桥到**同一个** daemon socket 上，除了你自己没人会启动它；它的信任边界——只绑 loopback、
必须自带 bearer token、以及 `act`/`attach`/`restore`/`snapshot` 都在这张面上——写在
[SECURITY.zh-CN.md](SECURITY.zh-CN.md) §2.3。

### 它做不到什么

直说，因为这决定它是否适合你的流程：

- **不能无头跑。** 无障碍、事件监听与屏幕捕获需要登录的 GUI 会话。它在你登录着的 Mac 上工作
  （包括专门的测试机，或有活动会话的自建 runner），不在没有窗口服务器的容器里。
- **合成不出拖拽手势。** macOS 接受合成的点击，但合成不出 SwiftUI 的 `.onDrag` 会话（实测结论，
  不是推测）。按钮/菜单/步进器路径可用；只做拖拽的功能目前驱动不了。
- **七个无障碍动词，不是任意输入。** `gp_act` 执行 `press`、`increment`、`decrement`、`showMenu`、
  `confirm`、`cancel`、`pick`。它不直接写控件值，也不发合成 HID 事件，所以往输入框里打自由文本
  不在范围内。
- **应用不配合或沉默时就受限。** 目标应用若不暴露有用的无障碍树，结构验证只能用它愿意给的那点；
  这时候才轮到探针 SDK，或 `gp_capture_view` + 视觉模型。
- **视觉印象不是测量。** `gp_capture_view` 就是为规则判不了的品味与整体观感准备的。但它不可重复、
  不能被断言，还受帧上限约束（大窗口会被拒并给出建议 `scale`，而不是悄悄降采样）。问它"这看着
  对不对"可以，问它"复选框变了没有"不行——那是 `gp_assert_element` 的活。
- **`strong` 归因需要应用配合。** 它表示应用内嵌的探针确认了处理器执行——具体证明到什么程度，
  见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

---

## MCP 工具参考 / MCP Tool Reference

权威清单以运行时 `tools/list` 为准，下表是地图。

| 分组 | 工具 | 做什么 |
|---|---|---|
| 驱动 | `gp_attach` | 按 `bundleId` 或 `pid` 挂接运行中的应用 |
| | `gp_observe` | 返回应用的无障碍树 |
| | `gp_act` | 执行 7 个无障碍动作之一并确认效果 |
| 断言 | `gp_assert_element` | 控件属性判定：`title`、`value`、`role`、`enabled`、`focused` |
| | `gp_audit_ui` | 只读的界面布局审计：元素几何 + 确定性规则，给出 `pass`/`advisory`/`blocking`/`insufficient` 判定与覆盖率 |
| | `gp_diagnose` | 给没生效的操作分类：没变 / 变晚了 / 被并发输入污染 |
| 证据 | `gp_last_evidence` | 取最近（或指定）操作的完整证据包 |
| | `gp_export_evidence` | 把一次操作的包渲染成 HTML/Markdown 审计报告 |
| | `gp_recent_reports` | 把最近 N 次操作汇总成一份审计视图 |
| 回滚 | `gp_snapshot` | 记录无障碍树的摘要基线 |
| | `gp_restore` | 重放录制的步骤回到基线，或与基线比对 |
| 视觉 | `gp_capture_view` | 把当前窗口的一张 PNG 交给你的模型做视觉审查；引擎侧不落盘 |
| 探针 | `gp_probe_status` | 哪些应用有在线 `GlassPaneProbe`，它报了些什么 |
| 项目 | `gp_project_list` / `gp_project_set` / `gp_project_get` | 登记并读取每应用配置 |

`gp_audit_ui` 不记录操作、也不写证据包：它测的是界面此刻的样子，所以它的判定允许回答"证据不足"，
而不是装成看过了。几何被刻意挡在树的摘要之外——一次 hover、一段动画或光标移动，都不该让
"这次操作有没有改变这个界面"回答"改变了"。

---

## 它如何工作 / How It Works

### 证据包里有什么

每次操作产出一个带版本的 `glasspane.evidence` 包（JSON，schema 见
[kernel/schemas](kernel/schemas)）：

- **目标选择器** —— 元素是怎么被识别出来的，不只是显示名；
- **前后无障碍树的摘要**（定长哈希，外加节点数与是否变化的标志——包里存的是摘要而非整棵树）与两者的结构差异；
- **像素差异实测**（比例与区域；原始截图不落盘）；
- **归因结论**：默认 `soft`，只有目标应用内在线的 [GlassPaneProbe](engine/probe) 确认处理器跑过才 `strong`，
  操作窗口内量到人手介入时才降为 `weak`；
- 操作期间有其他输入进来时的**污染标记**；
- `gp_restore` 需要重放的**检查点步骤**。

### 与审查回路的双向集成

GlassPane 是一半。另一半是
[`iterate-harness`](https://pypi.org/project/iterate-harness/)——审查并修复代理在这里改动的代码的那个
多轮回路。两边不靠聊天记录对接：跨越边界的东西都由一侧写成可核验的记录，另一侧读它。

- **证据进入审计链。** 回[证据包](#证据包里有什么)的那项调用是 `gp_last_evidence`——其余四项工具接受
  `dimension` 却不回包，这正是声明在它们身上的维度被一直报成"没验过"的原因——harness 为每条从包里
  记下的决定追加一条哈希链账本条目，默认在 `~/.local/share/glasspane-harness/decisions.jsonl`，或由
  `GLASSPANE_DECISION_LOG` 指到别处。审查回路把它自己的决定写进被审项目的
  `.iterate/decision-log.jsonl`，用的是同一种链格式，所以从对方那本引来的主张可以先整链验通再被使用：
  被改过的行会被拒绝并说清链断在第几行，答案不会出现"那就改用宽松读法"。今天在生产里跑这个读者的是
  回路这一侧（`fix_proof` 验通对面那本才引它）；fork 带的是同一个校验器，一条固定点测试钉住"这边写的
  链在那边验得过"，但它自己的生产路径只写自己的账本，不读回路那本。
  一个项目可以一次性把**对面那本**账本记为自己的修复证据来源，
  `ih iterate glasspane-ledger <绝对路径>`：链接只可能在整链验通之后落笔，并钉住链的首条——被替换
  而不是被延长的账本因此不再够格。
- **审查维度跟着调用走。** 每一面各有 5 项工具接受可选的 `dimension` 参数，而且是**同**五项：
  `gp_act`、`gp_observe`、`gp_diagnose`、`gp_last_evidence`、`gp_attach`；`gp_probe_status` 两面都
  刻意不带这个参数——自报不产证据帧，带了也永远不会有决定可计。把声明回显出来的是你调的那一面
  （MCP 层或 fork），不是引擎：`dimension` 在请求出网前就被剥掉，引擎从不看见这个词，回显那行是壳
  或 fork 自己写的。回路把回显记成见证；与同一 operationId 上已有见证矛盾的决定会被拒绝
  （`KERNEL_E_DIMENSION_CONTEST`），而不是悄悄变成第二份记录。
- **复核不过，回路就回到应用本身。** 一轮的 invariant 复核失败时，回路会再次问那个正在跑的应用——
  只读、走宿主自己的 MCP 通道。它真正构造的调用，是每个已记录操作一条 `gp_last_evidence` 加一条
  `gp_diagnose`；决定"允许问什么"的那张名单是只读五项（`gp_probe_status` /
  `gp_observe` / `gp_diagnose` / `gp_last_evidence` / `gp_recent_reports`）。会改动应用的调用被点名
  拒绝；这条通道里没有任何东西能替你点鼠标。
- **压缩知道这次查了什么。** 长会话被摘要时，harness 会把这条会话的证据锚点重新注入——operationId、
  结果、台账行号与条目哈希——摘要因此不能把回到链上的指针弄丢。这次运行的计划
  （`.iterate/run-plan.json`，或 `GLASSPANE_RUN_PLAN`）决定谁先被丢：本轮从没声明过的维度历史排在声明过的
  之前，而且注入的块会说出它用的是哪条规则。声明了维度却进不了锚点的那些调用（引擎只给
  `gp_last_evidence` 附证据包）也会被数出来打印，所以这条缺口是一个读数，不是某段希望仍然成立的
  文字。
- **修复不靠代理自称就算完成。** 回路在推进一份修复配方之前读三件实测的东西：本轮的 invariant 判定、
  项目的配方（`recipeConfigPath`，或 `GLASSPANE_RECIPE`），以及一条链可验、按 operationId 记着通过
  结果的账本行。缺任何一件或判定是"未量到"都具名拒绝（`RECIPE_GATE_E_*`）。答案落进本项目的账本——
  发出去的那一轮落，判定通过、因此什么都没发的轮次也落（`iterate-harness` 2.11.1 起）；而契约拒绝这条
  分支一个字节都不写，因为一个从未做成的决定不该变成一条审计记录。两扇门都读得回来：session 里
  `/iterate gate`，终端里 `ih iterate gate`。
- **两个工具面说的是同一份 provider 契约。** fork 与 MCP 层各自注册同一个 provider id 和每个方法相同的
  先决条件，而有一把尺子跑的是两侧的注册代码本身（不是 grep）：两边一旦说得不一致，或者"哪些方法只在
  一边"不再是一份被记下来的清单，它就红。

各归各位的部分：应用做了什么由引擎判定，两个 harness 都不自行给界面下结论。那道闸只报与拦，它不执行
配方——两个产品都没有配方执行器，进度指针得由真正动手修的那一侧写进账本。两边吃的是同一份发布出去的
契约层 [`iterate-kernel`](https://www.npmjs.com/package/iterate-kernel)，所以上面这些格式不是两份各自
演化的文件：格式本身只有一份真源，Python 侧把它吃进来的语料按 sha256 钉住，语料一变就先在哈希检查上
红，再逼两侧的用例各自表态。要说清楚的是边界——"两份实现对**没写进语料的案子**还一致吗"由另一条命令
回答（`scripts/diff_kernel_implementations.py`，逐案子比对两侧的答案），它是给操作者跑的，不在 CI 的
步骤里，所以那条得有人跑才算数。

### 权限与诚实性设计

- 状态由**后台服务实测自身**上报，不由界面推断；面板不代测、不猜。
- 读不到的显示**未验证**。没有任何指示灯为了好看而点亮；开发者工具卡保留自己的实测状态，
  不借用别的卡的颜色。
- daemon 必须由 launchd 或登录项拉起，其自报才等于真实授权席位；从终端起的实例会继承**启动者**
  的判定，所以面板显示的是它实际测到的主体。
- 证据与审批记录是哈希链审计台账：记录发生了什么，不是执行拦截。

---

## 配置 / Configuration

GlassPane 的配置面分两层：引擎一层，每个消费者各一层。没有需要你手改的配置文件——服务路径由安装器
写入，MCP 配置块归你的 host 自己管，harness 读它自己的运行计划与配方。

### 环境变量

| 变量 | 读取方 | 作用 |
|---|---|---|
| `GLASSPANE_ENGINE_SOCK` | `glasspane-mcp`、`glasspane-http` | daemon socket 路径；默认 `~/.glasspane/engine.sock` |
| `GLASSPANE_REF` | `install.sh`、安装器 | 要装的发布 tag；`main` 追主干，而主干不是固定产物 |
| `GLASSPANE_UPDATE_DISABLE` | 更新器 | 设为 `1` 后连之后的 `enable` 都拒绝，重装也不会把定时作业带回来 |
| `GLASSPANE_DECISION_LOG` | GlassPane Harness | 决策账本的写入位置，默认 `~/.local/share/glasspane-harness/decisions.jsonl` |
| `GLASSPANE_RUN_PLAN` | GlassPane Harness | 运行计划，决定会话压缩时先丢哪一维的历史 |
| `GLASSPANE_RECIPE` | GlassPane Harness | 运行计划没给 `recipeConfigPath` 时，修复闸读的配方 |

### 每应用配置

应用相关的设置跟着应用走，不放在全局文件里。`gp_project_set` 按 bundle id 登记一个应用；`gp_project_get`
报出解析后的存储路径、配方与校准根；`gp_project_list` 列出已登记项。证据包与审查回路那道闸读的就是
这些记录，所以改动它们等于改动"对这个应用而言，已验证意味着什么"。

### 更新计划

每日检查是一个 launchd 作业；它的时间与同意级别属于更新器，不属于面板。`enable --hour 3 --minute 45`
移动时间窗；面板上的按钮就是同一条命令，同意语义见[让 GlassPane 保持最新](#让-glasspane-保持最新)。

---

## 常见问题 / FAQ

### 安装

**Gatekeeper 拦住应用/提示 unidentified developer。** 符合预期：产物 ad-hoc 签名且公证暂缓
（见[安装](#安装-installation)）。在系统设置 → 隐私与安全性里允许后重开。

**我勾了权限，卡片还是红的。** 多半勾错了主体——条目必须是 `GlassPane Daemon`，不是终端也不是
`GlassPane.app`。卡片会显示它测到的主体；跑 `node installer/cli.js --restore-launchd`
把服务挪到 launchd 下并复验。

### 用法

**面板开着，工具还是报错。** 面板不是服务。直接问 socket：
`printf '{"id":0,"method":"hello"}\n' | nc -U ~/.glasspane/engine.sock` 会回正在运行的 daemon 的
`hello`——它的版本、能力表与状态根，这才是"服务活着"的读数。不要拿 `glasspaned --permissions`
代替它：那条命令量的是**跑它的那个进程**自己的 TCC 席位，一个 socket 都不碰（它自己的 `--help`
就这么写），回一份绿色 JSON 也不说明服务的事。若 socket 被旧构建占着，用 `--replace-daemon`
重跑安装——否则你授权的那个应用和干活的那个应用不是同一个。

**代理说改了但界面没动。** 这正是 `gp_diagnose` 存在的理由：它把"结构没变""变化晚到""输入污染"
分开。如果你的功能只有拖拽入口，先看[它做不到什么](#它做不到什么)。

**支持哪些 macOS 版本？** 14 及以后；无障碍、事件监听与屏幕录制的行为就是按这个范围实测的。

### 安全

**数据会离开本机吗？** 不会。本机 unix socket、本机 stdio、证据留在 `~/.glasspane/`。
但 `gp_observe` 会把无障碍树送进**代理对话**，你的模型服务商记录什么就等于记录了那棵树——
把会话内容按敏感处理。

**怎么确认跑的是哪个版本？** `glasspaned --version` 自报（`--permissions` 里**没有**版本键，
它只量 TCC 席位）、设置面板同值、MCP `initialize` 响应回显，
`node scripts/check-version.mjs` 会打印版本号出现的每一处。它们都来自同一个数字
（[CHANGELOG.md](CHANGELOG.md)）。

---

## 安全 / Security

GlassPane 持有辅助功能、输入监控与屏幕录制，注册 launchd 作业，读事件流，还能附挂调试器——
它既强，也是攻击面。报告方式与详细威胁模型见 [SECURITY.md](SECURITY.md)（英文）/
[SECURITY.zh-CN.md](SECURITY.zh-CN.md)。不要把日志或证据包贴进公开 issue。

---

## 目录结构 / Directory Structure

```
GlassPane/
├── install.sh          一键入口：定位/取源码，委托 installer
├── installer/          零依赖 Node 安装器 → npm `glasspane-install`
├── engine/             Swift 包：glasspaned 服务、设置界面、无障碍通道
│   ├── probe/          GlassPaneProbe（内嵌后可做强归因）
│   └── scripts/        make-app.sh —— 两个 .app 的打包与 ad-hoc 签名
├── mcp-shell/          TypeScript MCP stdio 服务 → npm `glasspane-mcp`
├── kernel/             已发布 iterate-kernel 的被钉语料（schemas + fixtures）
├── bridge/             Python LLDB 调试桥（崩溃/运行时采集）
├── updater/            每日更新作业与它的同意闸
├── harness/            GlassPane Harness fork（独立仓库、独立发布线；不进本产品归档）
├── spike/              可行性实验与留档结果
├── scripts/            set-version / check-version —— 单一版本线
├── specs/              实施规格与验收记录（PRD、P0–P6、审查记录）
├── ITERATE.md          本仓自己的 iterate onboarding 知识库
└── .github/workflows/  ci.yml（10 条 lane；发布形态守卫是其中一条里的一个步骤）、release.yml
```

---

## 贡献 / Contributing

环境准备、各层测试命令、提交与 PR 约定，以及"测试绝不能碰开发者真实的 `~/.glasspane`"这条规则，
都在 [CONTRIBUTING.md](CONTRIBUTING.md)（[简体中文](CONTRIBUTING.zh-CN.md)）。简版：

```bash
npm ci && npm run build && npm test --workspaces --if-present   # TS 工作区：mcp-shell / installer / updater（kernel/ 没有 package.json）
swift build --package-path engine && swift test --package-path engine   # Swift 引擎
swift test --package-path engine/probe                           # 探针 SDK
python3 -m pytest -q bridge                                      # LLDB 桥
node scripts/check-version.mjs                                   # 版本线漂移检查
```

CI 还跑**发布形态守卫**：打包 `glasspane-mcp` → 装进干净目录 → 完成 MCP `initialize` 握手。
因为打包类缺陷（`file:` 依赖失联、schema 缺文件）只在发布产物里现形，本地跑看不到。

需要真实 GUI 会话的验收项按设计不能进 CI，它们以真机冒烟记录留在
[engine/smoke.md](engine/smoke.md)，而不是被静默跳过。

发布：`node scripts/set-version.mjs <semver>` 写整条版本线；推 tag 即产出带发布归档（被 tag 的树，
**减去 `harness/`**——那是换版路径一行都不读的 vendored fork，却占本仓已跟踪字节的 86.9%（74,253,356
字节里的 64,535,347，2026-10-20 实测；这条数可以
复算：`git ls-tree -r -l HEAD` 按路径累加 blob 大小）；再加
`mcp-shell/dist`、`mcp-shell/schemas` 两份构建产物）与 `SHA256SUMS-<版本>.txt`（版本号在文件名里，
updater 就是按那个名字去要的）的 GitHub Release——纯源码归档
会让 updater 在目标机上 `npm pack` 出一个没有可执行文件的包，2026-10-01 真机因此每次换版都回滚；
npm 发布走 `release.yml` 的 provenance 通道。

### 文档

`specs/` 是设计真源与验收台账，主张在哪里被验证、哪里没有，都记在那里，因此它最接近参考手册：

| 文档 | 范围 |
|---|---|
| [PRD](specs/GlassPane_PRD_v1.0.md) | 产品定义与闭环论证 |
| [项目综述 5.8](specs/GlassPane_5.8_项目综述文档.md) | 最近一次全项目综述 |
| [P0](specs/GlassPane_P0_实施规格_v1.0.md) | 证据内核：attach / observe / act / 归因 |
| [P1](specs/GlassPane_P1_实施规格_v1.2_GUI设置面板.md) | 检查点、证据生命周期、GUI 权限面板 |
| [P2](specs/GlassPane_P2_实施规格_v2.0_并发归因污染防护.md) | 并发归因污染防护、渐进退化检测 |
| [P3](specs/GlassPane_P3_实施规格_v3.0_三方消费者一致性.md) | 三方消费者一致性、MCP 消息层、桥形态 |
| [P4](specs/GlassPane_P4_实施规格_v4.0_收口与里程碑一致性.md) | 里程碑收口、npm 命名决策链、一键安装 |
| [P5](specs/GlassPane_P5_实施规格_v5.0_方向候选四连批.md) | 方向候选 |
| [P6](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md) | 探针 SDK、LLDB 桥、公开发布执行记录 |
| [Audit 2026-09-22](specs/GlassPane_Audit_2026-09-22_全量审查与UI迭代.md) | 全量审查与 UI 迭代记录 |
| [双向集成 2026-10-25](specs/GlassPane_双向集成_2026-10-25_状态.md) | 与审查回路的五个双向场景逐行状态、各自的证据路径，以及哪些是实测、哪些只是声明 |
| [更新系统 2026-10-26](specs/GlassPane_更新系统_2026-10-26_状态.md) | 应用内更新为什么会"探测到了却装失败"：四条根因、部分成功＋一条可照抄的 npm 补救这条契约，以及逐版在发布物上取到的读数 |

另一半产品的文档跟着它自己走：[GlassPane Harness 文档](https://github.com/jingzhao-l/glasspane-harness/tree/main/docs)
覆盖安装、工具面、证据纪律与发布线。

---

## 免责声明 / Disclaimer

GlassPane 在真实桌面上驱动真实应用，持有读屏与操作其他应用界面的权限。请只在你有意控制的应用上
运行，不要把证据目录放在共享位置，并把它导出的报告视为"包含屏幕上出现过的内容"。
归因结论是实测与推断，不是关于程序内部行为的保证——一个应用若对自己的无障碍树说谎，
任何观测方都可能被误导，这正是探针通道存在的理由。

---

## 许可证 / License

MIT —— 见 [LICENSE](LICENSE)。
