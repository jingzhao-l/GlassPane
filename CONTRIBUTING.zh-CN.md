# 贡献指南（Contributing）

[English](./CONTRIBUTING.md) · **简体中文**

GlassPane 是 **macOS 上给 AI 编程代理用的 GUI 测试与验证层**：代理调用 `gp_*` MCP 工具去操作应用，
每次操作返回它**实际造成**的变更——前后无障碍树、像素差异数值、归因结论，外加一个可回滚的检查点。
它存在的理由是：代理已经能cover macOS 开发的静态半场（构建、审查、单元测试），运行时半场却是盲的，
而常见的替代方案"截图 → 视觉模型 → 点坐标"既不能断言、也不能归因、不能重复、更不能撤销。
核心资产是**诚实**：没有实测就写"未验证"——指示灯绝不为了好看而点亮。代码、测试、文档与 PR 描述都受这一条约束。

## 1. 开发环境

| 依赖 | 要求 | 为什么需要 |
|---|---|---|
| macOS | 14+ | 捕获走 ScreenCaptureKit 的 macOS 14 形态（`SCScreenshotManager`，在 [SCKCapturer.swift](./engine/Sources/GlassPaneEngine/SCKCapturer.swift) 里以 availability 守卫），权限模型是 14 的 TCC |
| Node.js | >= 18 | mcp-shell / kernel / installer 全是 Node ESM（CI 跑 Node 20） |
| Xcode CLT | `xcode-select --install` | `swift build` / `swift test`，以及桥的 `xcrun lldb` |
| Python | 3.11 | LLDB 桥测试套件（唯一第三方依赖是 pytest）与 `engine/` 下的冒烟脚本 |
| git | 任意新版 | 一键安装会自动 clone 钉住的发布 tag |

起步（仓库根）：`npm ci` → `npm run build` → `cd engine && swift build`。

## 2. 仓库布局与各层测试

| 路径 | 是什么 | 本地怎么测 |
|---|---|---|
| [engine/](./engine/) | Swift Package：`glasspaned` 后台服务（辅助功能 / 输入监控 / 屏幕录制，unix socket `~/.glasspane/engine.sock`，launchd 作业 `com.glasspane.daemon`）+ `glasspane-settings` SwiftUI 面板。[engine/scripts/make-app.sh](./engine/scripts/make-app.sh) 组装 ad-hoc 签名的 `.app`，再由安装器安置到 `~/Applications`，好让 TCC 面板出现可选中、有名字的条目，而不是藏在 `.build` 里的二进制 | `cd engine && swift build && swift test` |
| [engine/probe/](./engine/probe/) | 独立 SPM 包 `GlassPaneProbe`：被测进程内的 Z1–Z4.5 探针 SDK | `cd engine/probe && swift test` |
| [mcp-shell/](./mcp-shell/) | TypeScript MCP stdio 服务，npm 包 `glasspane-mcp` | `cd mcp-shell && npm test`；发布形态另跑 `npm run bundle` |
| [installer/](./installer/) | 零第三方依赖的 Node ESM 一键安装器，npm 包 `glasspane-install` | `npm test --workspace glasspane-install` |
| [kernel/](./kernel/) | `@iterate/kernel`，私有且**不单独发布**：JSON Schema 真值源 [kernel/schemas/](./kernel/schemas/)，与作者的 iterate 生态共享，发布时由 bundle 内联 | `cd kernel && npm test` |
| [bridge/](./bridge/) | Python LLDB 调试桥与 pytest 套件（纯逻辑核可脱离 lldb 测） | `cd bridge && python3 -m pytest -q` |
| [spike/](./spike/) | 可行性实验与实测留档 | 不入门禁 |
| [specs/](./specs/) | 中文实施规格与验收文档（PRD、P0–P6、5.6/5.7/5.8 项目综述）＝**设计真值** | 文档改动本身就是 PR |

## 3. 门禁：七条 CI 通道，先在本地跑绿

[.github/workflows/ci.yml](./.github/workflows/ci.yml) 共七条 job。CI 只是同一套东西的重复——先在本地把它们跑绿。

| CI job | Runner | 测什么 |
|---|---|---|
| `swift` | macos-latest | engine 构建、纯逻辑测试套件（无需 GUI 权限）、探针包，以及信号收尾闸 `python3 .signal_smoke.py .build/debug/glasspaned`：SIGTERM/SIGINT 必须自行退出且退出码 0，且两个 socket 文件都被 unlink |
| `bridge` | ubuntu-latest，Python 3.11 | 队列 / 截断 / 哨兵 / argv / socket 回环，全程不依赖 lldb |
| `kernel` | ubuntu-latest | C35 与 fixtures 的往返 |
| `mcp-shell` | ubuntu-latest | 分发 + 工具表 + engine 客户端，再加 publish-shape 守卫（`npm run bundle`、`npm pack`、在干净目录装上产物并完成 MCP `initialize` 握手）：`file:` 依赖泄漏、schemas 缺文件都在这一步现形 |
| `install-gate` | ubuntu-latest | 发布形态所依据的根布局：安装器单测、kernel → mcp-shell 构建、全部 workspace 测试 |
| `version-line` | ubuntu-latest | 每个版本位点与根 manifest 是否一致 |
| `docs` | ubuntu-latest | 对外文档体检：相对链接可达、页内/跨页锚点存在、双语两侧都在位（`node scripts/check-doc-links.mjs`） |

运行时接受的命令是 [iterate.config.yaml](./iterate.config.yaml) → `validation.commands` 里的封闭清单，**逐字**匹配：加参数或换目录都会被拒绝。

```text
npm run build
npm test --workspaces --if-present
node scripts/check-version.mjs
swift build --package-path engine
swift test --package-path engine
swift test --package-path engine/probe
python3 -m pytest -q bridge
sh -n install.sh
```

**engine 通道需要 macOS 14+。** Linux 上只能跑 TypeScript 与 Python 两条通道，因此纯 Linux 环境无法独立证明
CI 等式。CI 同样跑不了所有依赖真实 GUI 会话、真实 TCC 席位与真实被测 app 的流程：它们以人工冒烟记录的形式存在
[engine/smoke.md](./engine/smoke.md)，必须在真机（或自建 runner）上执行并如实留档——包括失败与降级形态。
不要用「CI 绿了」代替「真机验过了」。

## 4. 测试隔离：绝不让测试指向真实用户路径

- 测试必须自备临时路径。**不要用缺省路径构造 `ProjectRegistry()`**——它解析到 `~/.glasspane/projects.json`，
  也就是开发者自己的注册表。曾有一次 `swift test` 把 71 条真实登记替换成 2 条 fixture，不可恢复：见
  [ProjectRegistry.swift](./engine/Sources/GlassPaneEngine/ProjectRegistry.swift) 里对 `live()` 的警告，以及 `engine/Tests/GlassPaneEngineTests/EngineCoreTests.swift:1336` 附近的注释。
- 把 `HOME` 指到沙箱没用：这些缺省背后的 home 查找**不读** `HOME`
  （[StateRoot.swift](./engine/Sources/GlassPaneEngine/StateRoot.swift)）。要显式传参——[TestSupport.swift](./engine/Tests/GlassPaneEngineTests/TestSupport.swift) 里的 `TestSandbox.directory(…)`、`TestSandbox.projectRegistry(…)`、`TestSandbox.evidenceStore(at:)`。
- 两道闸是直接判失败而非告警：
  [TestIsolationGateTests.swift](./engine/Tests/GlassPaneEngineTests/TestIsolationGateTests.swift) 与
  [ProjectRegistryIsolationTests.swift](./engine/Tests/GlassPaneEngineTests/ProjectRegistryIsolationTests.swift)，后者在 `Tests/` 里禁止出现 `ProjectRegistry.live()`、`EvidenceStore.live()`、`ApprovalGate.defaultPath`、
  `EvidenceStore.defaultDirectory`、`LocalArchive.scanEvidence()`、`LocalArchive.readApprovalLedger()`。不要为了让测试通过而放宽任何一道闸——那是重新挖开这个洞。

## 5. 版本线与发布

- 协议 MIT；仓库 `jingzhao-l/GlassPane`；npm 裸名 `glasspane-mcp` 与 `glasspane-install`；kernel 不出单独的包。
- 全仓共用一个数字：根 workspace、两个 npm 包、kernel、MCP `serverInfo` 自报、daemon `hello` 自报、`.app` bundle
  版本、[install.sh](./install.sh) 与 [installer/cli.js](./installer/cli.js) 钉住的发布 tag，以及 lockfile。
- **改版本只走 `node scripts/set-version.mjs <semver>`**：它一次性改写
  [scripts/version-sites.mjs](./scripts/version-sites.mjs) 列出的全部位点。手工改单个 `package.json` 立刻造成版本漂移，
  而 `node scripts/check-version.mjs`（CI job `version-line`）会因此失败。漂移的后果不是难看而是危险：按 tag 装到的
  源码与 registry 上的包不一致，面板显示的版本也不一致。发布自动化见
  [.github/workflows/release.yml](./.github/workflows/release.yml)。

## 6. 提交与 PR 约定

- Conventional Commits 前缀 + 中文正文，与现有历史一致：`fix: 请求超时定时器不再 unref……`、
  `ci+release: provenance 发布通道与 publish-shape 守卫……`、`docs: ……`、`install: ……`。本仓文档与提交正文以中文为主（[iterate.config.yaml](./iterate.config.yaml) 的 `language: zh`）。
- **一个逻辑变更一个提交**（这里是真实执行的习惯，不是口号）：测试与实现同属一个逻辑变更时可用 `test+fix:`，
  跨通道的改动拆开提。分支用 `feat/…`、`fix/…`、`docs/…`、`infra/…`，PR 目标分支是 `main`。
- [.github/pull_request_template.md](./.github/pull_request_template.md) 里的门禁清单照实勾选：没跑过的项留空并写明
  「未跑 + 原因」。在没跑过的行上留一个勾，本身就是缺陷。

## 7. specs/ 是设计真值

- 功能先在 `specs/` 里被规格化、被验收，代码只是它的一种实现。改变**行为**（语义、错误码、降级形态、权限主体、
  证据字段）→ 同一个 PR 里更新对应 `specs/` 文档；只做内部重构且行为逐字节不变 → 在 PR 描述里明确写出这一点。
- 新增或修改任何 `gp_*` 工具 = 三处必须同步，缺一处即视为未完成：[kernel/schemas/](./kernel/schemas/)（JSON Schema
  真值）、[engine/Sources/GlassPaneEngine/](./engine/Sources/GlassPaneEngine/) 里的 daemon 方法表与分类器、
  工具表 [mcp-shell/src/tools.ts](./mcp-shell/src/tools.ts)。
- 错误码表（[ProtocolErrors.swift](./engine/Sources/GlassPaneEngine/ProtocolErrors.swift) 的 `GPErrorCode`）是冻结的：
  失败路径的修法遵循「码不动、语义不动、remedy 可执行」——remedy 必须是代理能直接执行的命令。

## 8. 对贡献者而言的「验证诚实」

- 没有实测就不要让任何指示变绿：状态位、`attribution.level`、面板权限卡、验收项勾选。拿不到就是
  `未验证` / `INCONCLUSIVE` / 结构化降级。
- 不要伪造通过的门禁：跳过断言、放宽阈值、给单测喂 mock 去做真机才能证的事（例如调试器 attach），都算缺陷而不是
  解法。降级形态要按降级如实标注——缺屏幕录制时 pixelDiff 为 null、判定退化为 INCONCLUSIVE——它不是失败，
  也不是成功。
- 权限只能由人在系统设置里逐项勾选，程序无法代勾；授权主体必须是 daemon 本身，不是终端、不是设置窗口。涉及权限
  主体或产物身份的改动，必须真机复验，并把结果写进
  [engine/smoke.md](./engine/smoke.md)。

## 9. 沟通

- 一般问题与功能请求：GitHub issue——[.github/ISSUE_TEMPLATE/](./.github/ISSUE_TEMPLATE/) 里的模板会问齐这个产品
  需要的信息。安全问题与漏洞：见 [SECURITY.md](./SECURITY.md)；**不要**在公开 issue 里贴令牌、日志原文或证据包。
- 本仓库由 [.github/CODEOWNERS](./.github/CODEOWNERS) 指定的单一维护者评审；PR 保持小而聚焦会比大改动更快合入。
  另见 [README.md](./README.md) 与 [CHANGELOG.md](./CHANGELOG.md)。
