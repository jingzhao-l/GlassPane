# GlassPane Harness

> 证据诚实的 macOS 应用 GUI 验证 harness。
> [opencode](https://github.com/anomalyco/opencode) 的 fork，带上 GlassPane 原生的 `gp_*` 工具面——
> 引擎说应用发生了什么，harness 负责如实呈现，不替它下结论。

**它是什么。** 终端里的编码 agent（TUI + 无头 server + `run`），被定制成只干一件事：驱动并
**验证**真实的 macOS 应用界面。模型不再靠猜"按钮到底点没点上"：agent 调用 Swift 引擎采集辅助
功能树 diff、像素 diff、崩溃与响应性信号，然后转述**引擎自己的归因**（`strong`/`soft`/`none`、
熔断级、pass/fail/inconclusive）——TypeScript 侧不合成任何裁决。每次成包的验证调用追加进哈希链
决策日志；压缩钩子会把证据锚点重新注入压缩提示词，摘要再长也丢不掉审计链。

**产品面：CLI + TUI**（含无头 `serve`/`run`）。上游 Web UI、桌面 app 与托管 console **不随产品
发布**——它们留在树里只做血缘与同步，Web UI 嵌入改为 `--embed-web-ui` 显式开启。理由与代价见
`FORK.md`。

---

## 安装

```bash
npm install -g glasspane-harness            # 推荐
bun add -g glasspane-harness
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.sh | bash
irm https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.ps1 | iex   # PowerShell
```

会装出两个命令：**`glasspane-harness`** 与短别名 **`gp-harness`**。

前提：macOS 13+；要用 `gp_*` 工具面还需要 **GlassPane** 后台服务在跑且已授予辅助功能权限——
先装 GlassPane（[jingzhao-l/GlassPane](https://github.com/jingzhao-l/GlassPane)），安装器会把
下一步说清楚，agent 也可以用 `gp_probe_status` 自查引擎。

## 上手

```bash
glasspane-harness                       # 交互式 TUI
glasspane-harness run "attach 到备忘录，打一个标题，并告诉我 UI 有没有给出证据"
glasspane-harness serve --port 4096     # 给其他客户端用的无头服务
```

## `gp_*` 工具面

| 工具 | 作用 | 权限 |
|---|---|---|
| `gp_probe_status` | 引擎自报：版本、能力、辅助功能/开发者工具权限 | 询问（诊断入口，所有 remedy 都指向它） |
| `gp_attach` | 按 bundle id 或 pid 附着到运行中的应用 | 询问 |
| `gp_observe` | 快照附着窗口的辅助功能树（digest、节点数） | 询问 |
| `gp_act` | 执行一次辅助功能动作，返回引擎观察到的东西（op id 关联证据包） | 询问（会动真实应用） |
| `gp_diagnose` | 按证据包给操作定性（污染 / 带外 / 回调 / 既有问题 / 无变化） | 询问 |
| `gp_last_evidence` | 取回引擎为某次操作归档的证据包 | 询问 |

方法是否可用**从运行中的引擎读**（`hello.capabilities`），永远不写死清单——那份清单在本文件之后
还会长。

## 证据纪律（这个 fork 存在的理由）

1. **判定留在 Swift**：归因、诊断类、熔断级、pass/fail/inconclusive 都由 GlassPane 引擎算；harness
   只转录、不推导（`surface-semantics.mjs` 棘轮闸盯着：工具面长出阈值、像素裁决或 pass/fail 合成
   即 CI 变红）。
2. **模型看到的必须是引擎说过的**：错误码与可执行 remedy 进工具的 `output` 文本，不只塞 metadata。
3. **审计链是产品功能**：成包调用进哈希链决策日志（op id ↔ entry hash）；固定点测试用两个独立
   哈希实现复算链条，账本不必信任写它的那段代码也能验。
4. **压缩不许抹掉证据**：压缩钩子把证据锚点注入摘要提示词；缺席以算术呈现
   （`gp_* calls: N · decisions recorded: M`），不许靠默认。

## 私有化改造（对照表）

| 改了（产品面） | 刻意保留（血缘） |
|---|---|
| 产品名、二进制、命令、npm 包、user agent、mDNS 名、状态根（`~/.local/share/glasspane-harness`）、配置文件名（`glasspane-harness.json(c)`，仍读上游名）、TUI 默认主题、`--version`/`serve`/升级/卸载文案、README、安装器、发布流水线 | `@opencode-ai/*` 工作区包名、`OPENCODE_*` 环境变量名、协议/类型名、Web UI/app/console 源码（不发布）、上游 AGENTS/CONTEXT 文档 |

本目录的 `product.json` 是左列的机器可读真源；`product-surface.mjs` 闸在脚本漂移时让 CI 变红，
`brand-surface.mjs` 棘轮盯品牌串。上游钉在 `v1.18.32`，我们的每个定制提交都带 `[gp]` 前缀，
分叉面由 `fork-diff` 实测而不是散文维持。

## 开发

```bash
bun install            # 工作区（被 TLS 拦截的网络上 bun 需要 NODE_EXTRA_CA_CERTS，实验记录见 FORK.md）
bun run typecheck
bun test --timeout 30000          # 固定点测试（在 packages/opencode 里跑）
bun run build --single            # 产品构建：CLI+TUI，不嵌 Web UI
```

## 许可与署名

MIT，与上游一致。`LICENSE` 是上游原文未改，`NOTICE` 记录本 fork 改了什么、代码来自哪里。上游：
[anomalyco/opencode](https://github.com/anomalyco/opencode) `v1.18.32` © SST——没有他们就没有这个
产品，而 `FORK.md` 的存在是为了让这句话在未来的每次同步后仍然成立。
