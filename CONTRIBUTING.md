# 贡献指南（Contributing）

GlassPane 是 macOS 上的 **AI 代理运行时验证引擎**：代理（Claude / Cursor / 任意 MCP 客户端）调用一组
`gp_*` 工具，每一次界面操作都留下可回放的证据包——操作前后的 AX 树对比、像素对比、归因结论（这次变化
是不是这次操作造成的）、以及可回到操作前状态的检查点。它的核心资产是**诚实性**：拿不到实测数据就报
「未验证」，绝不为了让指示灯变绿而撒谎。这条底线适用于代码、测试、文档和 PR 描述。

## 1. 开发环境

| 依赖 | 要求 | 为什么需要 |
|---|---|---|
| macOS | 14+ | 捕获走 ScreenCaptureKit 的 macOS 14 形态（`SCScreenshotManager`），权限模型是 14 的 TCC |
| Node.js | >= 18 | mcp-shell / kernel / installer 全是 Node ESM |
| Xcode Command Line Tools | `xcode-select --install` | `swift build` / `swift test`，以及桥的 `xcrun lldb` |
| Python | 3.11 | LLDB 桥测试套件（唯一第三方依赖是 pytest）与 `engine/` 下的冒烟脚本 |
| git | 任意新版 | 一键安装会自动 clone |

起步（仓库根）：

```sh
npm ci            # 根 workspaces：kernel + mcp-shell + installer
npm run build     # tsc：kernel → mcp-shell
cd engine && swift build
```

## 2. 仓库布局与各层测试

| 路径 | 是什么 | 本地怎么测 |
|---|---|---|
| [engine/](engine/) | Swift Package：`glasspaned` 后台服务（辅助功能 / 输入监控 / 屏幕录制，unix socket `~/.glasspane/engine.sock`，launchd 作业 `com.glasspane.daemon`）+ `glasspane-settings` SwiftUI 面板；[engine/scripts/make-app.sh](engine/scripts/make-app.sh) 打 ad-hoc 签名 `.app` 并安置到 `~/Applications`，好让 TCC 面板出现可选中、有名字的条目 | `cd engine && swift build && swift test` |
| [engine/probe/](engine/probe/) | 独立 SPM 包 GlassPaneProbe：被测进程内的 Z1–Z4.5 探针 SDK | `cd engine/probe && swift test` |
| [mcp-shell/](mcp-shell/) | TypeScript MCP stdio 服务，npm 包 `glasspane-mcp` | `cd mcp-shell && npm test`；发布形态另跑 `npm run bundle` |
| [installer/](installer/) | 零第三方依赖的 Node ESM 一键安装器，npm 包 `glasspane-install` | `npm test --workspace glasspane-install` |
| [kernel/](kernel/) | `@iterate/kernel`，私有且**不单独发布**：JSON Schema 真值源 [kernel/schemas/](kernel/schemas/)，与作者的 iterate 生态共享，发布时由 bundle 内联 | `cd kernel && npm test` |
| [bridge/](bridge/) | Python LLDB 调试桥与 pytest 套件（纯逻辑核可脱离 lldb 测） | `cd bridge && python3 -m pytest -q` |
| [spike/](spike/) | 可行性实验与实测留档 | 不入门禁 |
| [specs/](specs/) | 20 份中文实施规格与验收文档（PRD、P0–P6、5.6/5.7/5.8 项目综述）＝**设计真值** | 文档改动本身就是 PR |

CI 的五条通道见 [.github/workflows/ci.yml](.github/workflows/ci.yml)：swift（build + test + probe +
信号收尾闸 `python3 .signal_smoke.py .build/debug/glasspaned`）、bridge、kernel、mcp-shell（含
publish-shape 守卫：bundle + `npm pack` + 干净环境里完成 MCP initialize 握手）、根 workspace
install-gate。**在提 PR 前把这几条在本地跑绿**，CI 只是同一套东西的重复。

CI 跑不了的那一半：所有依赖真实 GUI 会话、真实 TCC 席位、真实被测 app 的流程。它们记录在
[engine/smoke.md](engine/smoke.md)，必须在真机（或自建 runner）上人工执行并如实留档——包括失败与降级
形态。不要用「CI 绿了」代替「真机验过了」。

## 3. 版本与发布

- 协议 MIT；仓库 `jingzhao-l/GlassPane`；npm 裸名 `glasspane-mcp` 与 `glasspane-install`；kernel 不出包。
- 版本线统一为 `1.1.0`。**改版本只走 `node scripts/set-version.mjs <version>`**，它一次性写全部
  `package.json` 与真源；手工改单个 `package.json` 会立刻造成版本漂移，这类改动会被打回。

## 4. 提交与 PR 约定

- Conventional Commits 前缀 + 中文正文，与现有历史一致：`fix: 请求超时定时器不再 unref……`、
  `ci+release: provenance 发布通道与 publish-shape 守卫……`、`docs: ……`、`test+fix: ……`。
- **一个逻辑变更一个提交**（这里是真实执行的习惯，不是口号）：测试与实现同属一个逻辑变更时可用
  `test+fix:`，跨通道的改动拆开提。
- 分支用 `feat/…`、`fix/…`、`docs/…`、`infra/…`。PR 目标分支是 `main`。
- PR 模板里的门禁清单照实勾选；没跑过的项写「未跑 + 原因」，不要留勾。

## 5. specs 与代码的关系

`specs/` 是设计真值：功能先在里面被规格化、被验收，代码只是它的一种实现。

- 改变**行为**（语义、错误码、降级形态、权限主体、证据字段）→ 同一个 PR 里更新对应 `specs/` 文档；
  只做内部重构且行为逐字节不变 → 在 PR 描述里明确写出这一点。
- 新增或修改任何 `gp_*` 工具 = 三处必须同步，缺一处即视为未完成：
  1. [kernel/schemas/](kernel/schemas/) —— JSON Schema 真值；
  2. daemon —— 方法表与分类器 [engine/Sources/GlassPaneEngine/](engine/Sources/GlassPaneEngine/)；
  3. mcp-shell 工具表 [mcp-shell/src/tools.ts](mcp-shell/src/tools.ts)。
- 错误码表是冻结的：失败路径的修法遵循「码不动、语义不动、remedy 可执行」——remedy 必须是代理能直接
  执行的命令，不是一段安慰性散文。

## 6. 对贡献者而言的「验证诚实」

- 没有实测就不要让任何指示变绿：状态位、`attribution.level`、面板权限卡、验收项勾选，全部以真实测量为
  准；拿不到就是 `未验证` / `INCONCLUSIVE` / 结构化降级。
- 不要伪造通过的门禁：跳过断言、放宽阈值、给单测喂 mock 去做真机才能证的事（例如调试器 attach），都算
  缺陷而不是解法。降级形态要按降级如实标注（例如缺屏幕录制时 pixelDiff 为 null、判定退化为
  INCONCLUSIVE），它不是失败，也不是成功。
- 权限只能由人在系统设置里逐项勾选，程序无法代勾；授权主体必须是 daemon 本身，不是终端、不是设置窗口。
  涉及权限主体或产物身份的改动，必须真机复验并写进 [engine/smoke.md](engine/smoke.md)。

## 7. 沟通

- 一般问题与功能请求：GitHub issue（模板会问齐这个产品需要的信息）。
- 安全问题与漏洞：见 [SECURITY.md](SECURITY.md)。**不要**在公开 issue 里贴令牌、日志原文或证据包。
- 本仓库由 [CODEOWNERS](.github/CODEOWNERS) 指定的单一维护者评审；PR 保持小而聚焦会比大改动更快合入。
