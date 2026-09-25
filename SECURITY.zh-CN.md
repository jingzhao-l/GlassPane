# GlassPane 安全策略

[English](./SECURITY.md) · **简体中文**

GlassPane 不是普通工具库：它**持有** macOS 的高危权限（辅助功能、输入监控、屏幕录制、开发者工具），
并以登录用户身份驱动任意被授权的 app，因此它自身就是一块攻击面。下面这份威胁模型按「谁能做什么、
什么东西落在盘上、边界在哪里」如实交代，不粉饰，也不承诺尚未建立的响应时限。

## 1. 如何报告漏洞

- 仓库为 `jingzhao-l/GlassPane`（public，MIT）。**开启私密漏洞报告后**（Settings → Security →
  Private vulnerability reporting），优先提交 GitHub 私密安全通告：
  `https://github.com/jingzhao-l/GlassPane/security/advisories/new`。该入口在本仓库**尚未确认已开启**；
  若不可用，走下面的退化路径。
- 退化路径是开一个普通 issue，只写**症状与影响**，把复现细节与产物留在自己一方，由维护者私信补充。
- 无论走哪条：**不要**在公开 issue 里粘贴令牌、`~/.glasspane/` 下的日志原文、证据包 JSON、导出报告或
  截图。这些文件里可能含被测界面上他人账号、姓名、邮件内容。
- 值得报告的方向举例：新的 socket/权限/证据路径未落入下面的边界描述、能把「未验证」伪装成「已验证」、
  跨用户进程触达 daemon 或桥、证据越出 `~/.glasspane/` 与调用方显式路径、launchd 被重新注册。
  任何严重级别都欢迎——把未验证的东西显示成已验证，在本项目里按缺陷处理。

## 2. 威胁模型摘要

**边界（如实声明）**：本机上与登录用户同权限的其他进程。跨用户、跨网络、以及已被 root 的机器都不在
防护范围内，相关报告通常会被判定为 out of scope。

### 2.1 daemon 能看到什么、能做什么、以谁的身份

- `glasspaned` 由 launchd 用户代理（`gui/<uid>`）以**登录用户本人身份**拉起，不是 root、没有提权。
- 辅助功能：读取任意 app 的 AX 树（含控件标题与属性文本），并通过 `AXUIElementPerformAction` 对任意
  app 执行动作，共 7 个无障碍动词（press、increment、decrement、showMenu、confirm、cancel、pick）。
  当前实现不写 `AXValue`、不合成 CGEvent 键鼠事件。
- 输入监控：全局（session 级）事件 tap，用于分辨「这次变化是代理做的还是人做的」——是**读**用户输入流；
  回调把每个事件原样转发，engine 内也不存在任何合成事件投递。它不是 daemon 用来注入输入的通道。
- 屏幕录制：抓取前台窗口图像做像素比对（缺权限时降级为 `pixelDiff: null` + 判定 INCONCLUSIVE）。
- 探针通道：监听 `~/.glasspane/probe.sock`，接收被测进程内 SDK 上报的 handler/state/checkpoint 信号。

### 2.2 unix socket 是唯一的本地信任边界

- `~/.glasspane/engine.sock`：父目录 `0700`、socket 文件 `0600`，daemon 自己 bind 与 chmod。
- **命令路径上没有任何对端鉴权**（不校验调用方的 uid/pid/代码身份，无令牌、无加密）。凡是能以该用户身份打开这个
  socket 的进程，就能等价地驱动 daemon 的全部能力——包括以「GlassPane Daemon」这个已授权主体去操作
  其他 app。信任模型即「本机任意代码 = 代理的手」：跑在你账号下的代码、你接入的 MCP server/插件，
  都在圈内。
- `~/.glasspane/probe.sock` 同源同权限，但**连接方自报 pid**（`hello` 帧字段），而这个自报值只对照
  内核对这条连接的视角校验，**不校验任何代码身份**。因此一个配合或撒谎的同用户 app 可以以自己的
  真实 pid 注册成探针、注入 handler/state 信号；而探针信号在场时会把归因从 `soft` 升级为 `strong`——
  即**归因强度可被同用户进程伪造**（已知、如实标注，不构成跨用户越权）。
- daemon 提供 `--force-socket` 可接管已被占用的 socket；`--replace-daemon` 会先结束在跑的实例。旧的或
  恶意拉起的实例可能顶替授权主体，安装完成后请核对面板「Daemon 状态 → 主体」与实际二进制路径。

### 2.3 证据包会带出屏幕内容：什么在盘上、怎么擦

- 位置：`~/.glasspane/evidence/<operationId>.json`（一操作一文件，默认归档上限 10000 份，
  `EvidenceStore.defaultMaxFiles = 10_000`）、`~/.glasspane/projects.json`、
  `~/.glasspane/approvals.json`、`~/.glasspane/installer-daemon.log`（launchd 的 stdout 与 stderr 都写
  这里）。
- 内容：操作 selector（role/title/identifier —— **标题是被测 app 自己的文本**）、动作与确认位、AX 树摘要与
  节点数、像素差异比例与窗口几何/窗口号、响应性与存活信号、handler 命中的 file:line、状态变更的
  before/after 规范化字符串（各 ≤1 KiB）、分类结论与归因。**证据通路不落任何原始截图**（只存派生量），
  但 `gp_observe` 会把完整 AX 树交回 MCP 会话——那部分会进入代理宿主的上下文与远端模型。
- **`gp_capture_view` 是唯一会移动像素的通路，且它是"过路"而非"存档"**：引擎把挂接窗口编成 PNG
  作为 MCP image content 返回，daemon 不写任何文件；这个工具**刻意没有 `path` 参数**——让模型自己
  选输出路径，等于在协议里开一个由屏幕内容驱动的任意文件写入口。它撤不掉的是暴露面：图像进到
  会话里，就会落到你的模型服务商保留的一切，与上面那些 AX 树同级，只是换成像素。用过
  `gp_capture_view` 的会话要按"那个窗口当时的画面已被截走"对待；凡是测量能定的事，优先用
  `gp_audit_ui` / `gp_assert_element`。
- 导出件是副本：`gp_export_evidence` / `gp_recent_reports` 生成的 HTML/Markdown 报告按调用方指定路径
  落地，同样含界面文本；Z4.5 Metal 捕获会把 `.gputrace` 文档写进**被测 app** 的临时目录。
- 清理：先看体量，再按期限清理。

  ```sh
  glasspaned --evidence-stats
  glasspaned --prune-evidence [--older-than <days>] [--project <id>] [--dry-run]
  ```

  最直接的是停 daemon 后删除 `~/.glasspane/evidence/`。审批账本用
  `glasspaned --approval-audit` / `--approval-verify`（SHA-256 链）检查。
- 不要把 `~/.glasspane/` 放进云同步、共享目录或 CI 制品；提交 issue 前先按上一节的规则脱敏。

### 2.4 安装器注册的 launchd 持久化

- 写入 `~/Library/LaunchAgents/com.glasspane.daemon.plist`（`RunAtLoad` + 异常退出重启 + `ThrottleInterval 5`，
  可执行指向 `~/Applications/GlassPane Daemon.app`）：**用户级**代理，登录即起，不获取任何系统级持久化。
- 取消持久化：

  ```sh
  launchctl bootout gui/$(id -u)/com.glasspane.daemon
  rm ~/Library/LaunchAgents/com.glasspane.daemon.plist
  ```

- 作业被 bootout 后（等授权期间很常见）用 `node installer/cli.js --restore-launchd` 修复：检测 →
  bootstrap → hello 校验自报席位。安装时可用 `--no-launchd` 直接不注册。

### 2.5 LLDB 桥的调试器附加能力

- `bridge/glasspane_bridge.py` 以 `xcrun lldb` 的 SB API **启动新进程或 attach 到既有 pid**，读取回溯、寄存器、
  局部变量并可挂硬件观察点；attach 现成进程需手工勾选「隐私与安全性 → 开发者工具」，且该席位无查询接口。
- 这是本项目里最强的能力：**任何能驱动桥的输入，等价于能在目标进程里读内存**。因此桥只作为独立
  CLI/脚本资产交付，daemon 不自动 spawn lldb，socket 命令面也没有转发到桥的路径。二次开发时请勿把桥
  接到 `gp_*` 工具或任何远程可影响的输入上——那会把「本机同权限」边界扩大成远程代码调试。

### 2.6 ad-hoc 签名、无公证，防什么不防什么

- 分发形态是 ad-hoc 签名 + 不含 cdhash 的 identifier 型 designated requirement：

  ```sh
  codesign --force --sign - \
    --identifier "$bundle_id" \
    -r="designated => identifier \"$bundle_id\"" \
    "$app_dir"
  ```

  目的很窄：让 TCC 席位跨重编译存活、并让系统设置里出现有名字有图标的条目。
- 它**不提供**发布者身份、分发完整性或防篡改：没有 Developer ID、没有 notarization、没有 stapling。任何人
  都能用同一 identifier 重编译出同名 bundle；在已按 identifier 授权的机器上，替换后的二进制仍可能被认作
  已授权主体。因此只从审阅过的 commit 构建，把 `~/Applications` 与 `~/.glasspane/` 当安全相关资产对待。
- 补上这一环的手段是公证，而它是**一次由 owner 拍板、前置为付费 Apple Developer Program 会员资格的
  暂缓决策**。当前未启用，本文档任何地方都不声称已启用。
- 对端用户侧的可见后果：首次运行会被 Gatekeeper 拦（需在系统设置里手动允许）；一键安装的
  `curl … | sh` 属于「执行远端脚本」，请先读脚本或用 `GLASSPANE_REPO` 指向本地 clone。

## 3. 这些**不是**安全问题（by design）

- 权限必须人肉在系统设置里勾选、程序无法代勾；拖拽引导只是导航，不是代授权。
- 授权主体必须是 daemon（`GlassPane Daemon` / `glasspaned`），不是终端也不是设置窗口——终端能跑不代表
  daemon 能跑，读数不同是真实语义。
- 开发者工具席位无查询接口，权限行因此恒显示「未验证」而不是点亮；显式触发的能力探测会真跑受限的
  `xcrun lldb` 并如实回报实测结果。不假点亮是要求，不是缺陷。
- 同用户任意进程可连 socket 驱动 daemon；探针可自报 pid；跨用户/网络隔离不在范围内（见第 2 节）。
- 缺屏幕录制/输入监控时的降级（`pixelDiff: null`、INCONCLUSIVE、熔断等级变化）与 `restore` 的档 1
  拒绝（`GP_E_RESTORE_UNSUPPORTED`）：如实降级，不是可绕过的门。
- 审批账本目前只有 `daemon:auto` 的 approve 记录，它是**事后签名审计链**，不是人工审批闸。

## 4. 受影响版本

| 版本 | 是否支持 |
|---|---|
| 1.1.x | ✅ 当前版本线（1.1.0 与 1.1.1 已打 tag 并发布），安全修复在此发布 |
| 1.0.x | ❌ 不再修补（版本线已统一到 1.1.x） |
| 0.x（`glasspane-mcp@0.1.0` / `glasspane-install@1.0.0` 之前的发布） | ❌ 无修补，请升级 |

**尚不承诺修复时限（SLA）**：单人维护、无安全团队，无法给出「X 天内响应/修复」的承诺。能承诺的是：
私密通告会被阅读并回复，确认的问题会修在 `1.1.x` 线上，并在 Release/CHANGELOG 里说明影响范围与规避
手段。需要临时规避时，最有效的两条是停掉 launchd 作业（`launchctl bootout`，见 2.4）或删掉 TCC 授权席位。
