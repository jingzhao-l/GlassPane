<h1 align="center">
  <code>glasspane-harness</code>
</h1>

<p align="center">
  <a href="README.zh-CN.md"><strong>简体中文</strong></a> ·
  <a href="README.md"><strong>English</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/glasspane-harness"><img src="https://img.shields.io/npm/dt/glasspane-harness?label=Downloads&style=for-the-badge&color=2ea44f&logo=npm&logoColor=white" alt="npm downloads"></a>
  <img src="https://img.shields.io/dynamic/json?url=https%3A%2F%2Fregistry.npmjs.org%2Fglasspane-harness%2Flatest&query=version&label=version&color=brightgreen" alt="version">
  <a href="https://github.com/jingzhao-l/glasspane-harness/actions/workflows/ci.yml"><img src="https://github.com/jingzhao-l/glasspane-harness/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="License"></a>
  <img src="https://img.shields.io/badge/macOS-13%2B-blue?logo=apple&logoColor=white" alt="macOS 13+">
  <a href="https://github.com/jingzhao-l/glasspane-harness"><img src="https://img.shields.io/github/stars/jingzhao-l/glasspane-harness?style=social&label=Star" alt="Stars"></a>
</p>

<p align="center">
  <img src="assets/banner.svg" alt="GlassPane Harness — 证据诚实的 macOS 应用 GUI 验证 harness" width="720">
</p>

---

**问题。** 一个驱动真实 macOS 应用的 AI agent，没法诚实地说清界面到底有没有按它要求的动。
它只看得见自己的工具输出，于是靠散文猜测、报成功。截图也不解决问题：截图给的是**某个瞬间**，
不是**某次变化**，更说不清这次变化是不是那次点击造成的。

**GlassPane Harness** 是一个编码 agent（[opencode](https://github.com/anomalyco/opencode)
的 fork），通过原生 `gp_*` 工具面接到 Swift 验证引擎上。每次动作都被测量——辅助功能树 diff、
像素 diff、崩溃与响应性信号——然后由引擎给出**它自己的**归因（`strong` / `soft` / `none`、
熔断级、pass / fail / inconclusive）。harness 只转录，不自己下结论。成包的验证调用进哈希链
决策日志；压缩钩子会把会话的证据锚点重新注入压缩提示词，摘要再长也丢不掉审计链。

引擎是 [GlassPane](https://github.com/jingzhao-l/GlassPane)，harness 是它的 agent 侧。

## 产品面

| 产品面 | 你拿到什么 | 怎么发 |
|---|---|---|
| **CLI + TUI** | 终端里的 agent：交互式 TUI、`run` 一次性任务、`serve` 无头服务 | `glasspane-harness` / `gp-harness` 二进制，npm + 一键安装器 |
| **Web 应用**（内嵌） | 二进制自己服务的浏览器界面——没有第二个进程、不单独部署 | 嵌进二进制（`--skip-embed-web-ui` 出纯 CLI 构建） |
| **文档** | 本仓 `docs/`——安装、工具面、证据、迁移、排障 | 仓内 markdown（canonical，与代码同版本） |
| **SDK** | TypeScript SDK 与 plugin SDK，用来写自己的 `gp_*` 式工具 | 工作区包，随树发布 |

**刻意不发**：上游的托管 console / enterprise 栈（私有 harness 不需要"组织与额度后台"这种形态）、
Electron 桌面 app（第二批——需要签名与公证账号），以及上游的**文档站**（`packages/web` 仍是上游
Astro/Starlight 内容，能构建、留树，但本产品的 canonical 文档是 `docs/`，等站点由它重建前不算我们的
文档）。三者都留在树里做血缘，让将来对着钉点 tag 的每次同步仍然诚实。

## 安装

```bash
npm install -g glasspane-harness     # 推荐
bun add -g glasspane-harness
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.sh | bash
irm https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.ps1 | iex   # PowerShell
```

会装出两个命令：**`glasspane-harness`** 与短别名 **`gp-harness`**。

前提：macOS 13+；要用 `gp_*` 工具面还需要 **GlassPane** 后台服务在跑且已授予辅助功能权限
（[先装 GlassPane](https://github.com/jingzhao-l/GlassPane)，安装器会把下一步说清楚）。没有引擎时，
每个 `gp_*` 调用只会回 `GP_E_ENGINE_UNREACHABLE` 加一条 remedy——那是引擎的话，不是安装器的。

若 npm 的全局前缀不可写，用 `npm install -g --prefix "$HOME/.local" glasspane-harness` 并把
`~/.local/bin` 放进 PATH；安装器会自己检测到这种失败并把这条补救打出来。

## 上手

```bash
glasspane-harness                                  # 交互式 TUI（内嵌 web 应用也会被服务出来）
glasspane-harness run "attach 到备忘录，打一个标题，然后告诉我 UI 有没有给出证据"
glasspane-harness serve --port 4096                # 无头服务；web 应用由它提供
glasspane-harness --help
```

任何会话里第一件该问的事是 `gp_probe_status`：它报引擎版本、宣称的能力与权限状态——
工具面里每条 remedy 都指回它。

## `gp_*` 工具面

| 工具 | 作用 | 权限 |
|---|---|---|
| `gp_probe_status` | 引擎自报：版本、能力、辅助功能/输入监听/屏幕录制/开发者工具状态 | 询问（诊断入口） |
| `gp_attach` | 按 bundle id 或 pid 附着到运行中的应用 | 询问 |
| `gp_observe` | 快照附着窗口的辅助功能树（digest、节点数） | 询问 |
| `gp_act` | 执行一次辅助功能动作，返回引擎观察到的东西（op id 关联证据包） | 询问（会动真实应用） |
| `gp_diagnose` | 按证据包给操作定性（污染 / 带外 / 回调 / 既有问题 / 无变化） | 询问 |
| `gp_last_evidence` | 取回引擎为某次操作归档的证据包 | 询问 |

方法是否存在**从运行中的引擎读**（`hello.capabilities`），本文件不写死清单——那份清单在本文件
之后还会长。完整参考：[`docs/tools.md`](docs/tools.md)。

## 证据纪律

1. **判定留在 Swift**：归因、诊断类、熔断级、pass / fail / inconclusive 都由 GlassPane 引擎算；
   harness 只转录、不推导。工具面长出阈值、像素裁决或 pass/fail 合成，CI 棘轮即红。
2. **模型看到的必须是引擎说过的**：错误码与可执行 remedy 进工具的 `output` 文本，不只塞 metadata。
3. **审计链是产品功能**：成包调用进哈希链决策日志（op id ↔ entry hash）；固定点用两个独立哈希
   实现复算链条，账本不必信任写它的那段代码也能验。
4. **压缩不许抹掉证据**：压缩钩子把证据锚点注入摘要提示词；缺席以算术呈现
   （`gp_* calls: N · decisions recorded: M`），不许靠默认。

细节：[`docs/evidence.md`](docs/evidence.md)。

## 文档

- [`docs/install.md`](docs/install.md) — 安装通道、权限、自检
- [`docs/tools.md`](docs/tools.md) — 逐个参数的 `gp_*` 参考
- [`docs/evidence.md`](docs/evidence.md) — 归因、诊断、决策日志
- [`docs/migrate-from-opencode.md`](docs/migrate-from-opencode.md) — 私有化改了什么、刻意留了什么
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — 引擎不可达、权限拒绝、`GP_E_*` 码表
- [`FORK.md`](FORK.md) / [`SYNCLOG.md`](SYNCLOG.md) — 分叉坐标、纪律、每批实测数字；
  [`NOTICE`](NOTICE) — 署名；[`CHANGELOG.md`](CHANGELOG.md) — 每个版本发了什么

## 开发

```bash
bun install                # 工作区（被 TLS 拦截的网络上 bun 需要 NODE_EXTRA_CA_CERTS，见 FORK.md）
bun run typecheck
bun test --timeout 30000    # 固定点测试（在 packages/opencode 里跑）
bun run build --single      # 产品构建：CLI + TUI + 内嵌 web 应用
```

仓侧的闸住在 GlassPane 仓的 `harness/`（hook-liveness、fork-diff、kernel-vendor、
tool-surface、surface-semantics、product-surface、brand-surface），理由、反向控制与已知边界
写在 `harness/README.md`。我们每个定制提交都带 `[gp]` 前缀。

## 许可与署名

MIT，与上游一致。`LICENSE` 是上游原文未改，[`NOTICE`](NOTICE) 记录本 fork 改了什么、代码来自哪里。
上游：[anomalyco/opencode](https://github.com/anomalyco/opencode) `v1.18.32` © SST——没有他们就没有
这个产品，而 `FORK.md` 的存在是为了让这句话在未来的每次同步后仍然成立。

