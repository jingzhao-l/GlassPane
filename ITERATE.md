# ITERATE.md — GlassPane

<!-- ITERATE:AI-MAINTAINED:START -->

## 1. 项目概述

GlassPane 是给 **AI agent** 用的 macOS 观测/取证面板：agent 通过 MCP（stdio）驱动一个常驻 daemon，
daemon 用 Accessibility + ScreenCaptureKit + LLDB 对被测 macOS 应用做「操作 → 观测 → 归因 → 复现」闭环，
产出可验证的证据档案（evidence pack）与回滚计划。人类侧只有一个 SwiftUI 设置/控制台面板。

- 仓库：`jingzhao-l/GlassPane`（public，MIT）
- 面向 agent 的设计底线：**人类需要介入的步骤越少越好**；检测/复验/冒烟一律机器化，不许留「用户请跑这条命令」。
- 诚实底线（比 bug 更高优先级）：**未测量的结论不得上报**。`try?` 吞错、硬编码 `consistent: true`、
  把「没采到」说成「没命中」、把 1 次测量报成 5 次 —— 都算 A 级缺陷。

## 2. 技术栈与模块地图

| 模块 | 路径 | 语言/形态 | 职责 |
|---|---|---|---|
| engine 库 | `engine/Sources/GlassPaneEngine/` | Swift 6, SPM | 核心：`EngineCore`(1.1k 行) + AXChannel / SCKCapturer / Classifier / EvidenceStore / EvidenceModels / ApprovalGate / ProjectRegistry / RestorePipeline / ProbeSocketServer / SocketServer / PermissionStatus / DegradationSignal |
| daemon | `engine/Sources/glasspaned/main.swift` | Swift executable | 单实例护栏、socket 服务、一次性 CLI（`--project-prune` 等） |
| 面板 | `engine/Sources/glasspane-settings/` | SwiftUI | 权限引导 + 控制台（读已落盘文件，**不写** `projects.json`） |
| probe SDK | `engine/probe/` | 独立 SPM 包 | 被测应用内嵌探针（`GlassPaneProbe`），与 daemon 经 probe.sock 通信 |
| mcp-shell | `mcp-shell/src/` | TypeScript (ESM) | JSON-RPC 2.0 over stdio；`tools.ts`(712) / engine-client / io / dispatch / project-registry / evidence-report |
| kernel | `kernel/src/` + `kernel/schemas/` | TypeScript + JSON Schema | iterate 生态共享契约层（evidence-pack / decision-log / recipe schema）。**canonical 编辑入口在 iterate-skill 主仓**，GlassPane 侧为镜像 |
| bridge | `bridge/glasspane_bridge.py` (586) | Python 3.11 + lldb | LLDB 取证桥：capture / trace / queue / snapshot |
| installer | `installer/cli.js` (995) + `install.sh` | Node | 一键安装：依赖 → 构建 → 安置 bundle → launchd → 起 daemon → 开面板 |
| spike | `spike/*.py` | Python | 一次性实验脚本（非交付面） |
| specs | `specs/GlassPane_P0…P6_*.md` | 中文规格 | **实施契约真源**（P0 协议 / P1 GUI / P2 AX / P3 采集 / P4 安装发布 / P5 证据与回滚 / P6 探针 SDK） |

## 3. Gate（CI 等价，每轮修复后全量跑一次）

工作目录不同，命令须逐模块在其目录下执行（见 `iterate.config.yaml` 的 `validation.commands`）：

| 模块 | cwd | 命令 |
|---|---|---|
| engine | `engine/` | `swift build` → `swift test` |
| probe | `engine/probe/` | `swift test` |
| signal gate | `engine/` | `python3 .signal_smoke.py .build/debug/glasspaned` |
| bridge | `bridge/` | `python3 -m pytest -q` |
| kernel | `kernel/` | `npm test`（内含 `tsc` 构建） |
| mcp-shell | `mcp-shell/` | `npm test`（需 kernel 先 build） |
| installer | `installer/` | `npm test` |
| 根 | `.` | `npm run build && npm run test --workspaces --if-present` |

真机冒烟（需 GUI/TCC，CI 不跑、本机可选）：`engine/.c6_smoke.py`（面板 AX 契约）、`.p4i4_smoke.py`、`.p6_smoke.py`、`.c33_smoke.py`、`.t9_smoke.py`、`.rebuild_survival_smoke.py`。

基线（HEAD 实测）：`swift test` 374 通过 / 1 跳过；kernel 51；mcp-shell 71；bridge 17；installer 48+。

## 4. 审查时必须守住的既有约束（踩过的坑）

1. **`~/.glasspane/projects.json` 是活数据**：`swift test` 里任何用默认路径构造 `ProjectRegistry` / `EvidenceStore` 的用例都会污染真实注册表（`maxProjects=128` 触顶后真实注册失败）。跑 gate 请用隔离 `HOME`。
2. **面板各页不得设 `.navigationTitle`**（会顶掉窗口标题 `GlassPane 设置`，`.c6_smoke.py` FAIL）；侧栏条目必须是显式 `Button`（`List(selection:)` 的行在 AX 树里是 AXStaticText，`act` 选不中）。
3. **面板不写 `projects.json`**：运行中的 daemon 内存持有注册表，直接覆写会被静默冲掉；写入只走 `glasspaned --project-prune/--project-remove`。
4. **§6.5 协议面冻结**：不新增 socket 方法、不新增 MCP 工具、不改 evidence/decision-log/recipe schema 的既有字段。evidence schema 已冻结 `0.1`（读侧 legacy `0.1-draft` 必须仍可读）。
5. **kernel 归属**：canonical 在 iterate-skill 主仓，GlassPane `kernel/` 是镜像；改 kernel 必须同步回流，否则两侧漂移。
6. **`mcp-shell` 发布形态**：`prepublishOnly` 用 esbuild 把 kernel 与 schemas 内联捆绑；`file:` 依赖泄漏进发布 manifest = 干净安装即失联。
7. **SwiftPM 串行**：`.build` 上有包锁，gate 在跑时不要改源码；一次批完改动再跑一次 gate。

## 5. 已知在飞/未修清单（不要重复报为新发现，修它才是本轮价值）

`specs/GlassPane_Audit_2026-09-22_全量审查与UI迭代.md` §4：A-13…A-22、B-4…B-24、C-3…C-5、D、结构性缺口 B1/B2。
其中 A-1…A-12、B-1…B-3、C-1…C-2 的修复**存在于另一会话未提交的工作副本**，HEAD 上仍是缺陷——
按「不重复实现」处理，标 `covered-by-wip` 跳过，除非 HEAD 版本与 WIP 修法有实质分歧。

## 6. 推荐审查蓝图（本项目实况）

- **核心 6 维**（本项目默认启用集）：`correctness`、`security`、`architecture`、`spec-compliance`、`frontend-backend`、`tech-debt`。
  理由：面板/`ui-ux` 面另一会话正在重做；`performance`/`style-tests` 的历史结论是「已知 O(N) 磁盘 IO 与 800+ 行大函数按规格保留」，收益低于上述 6 维。
- 范围分区（并行 reviewer 用）：① `engine/Sources/GlassPaneEngine`；② `glasspaned` + `glasspane-settings` + `engine/probe`；③ `mcp-shell/src` + `kernel/src`；④ `bridge` + `installer` + `install.sh`；⑤ `engine/Tests` + `*/test` + 冒烟脚本。

<!-- ITERATE:AI-MAINTAINED:END -->

<!-- ITERATE:USER-OWNED:START -->
## 用户维护区（AI 刷新时保留）

- 产品意图类决策（审批入口 B1、发布节奏、schema 变更）永远由用户拍板，AI 只给方案与代价。
- 不可逆动作（push / merge / npm publish / 真实删除注册表条目）必须显式授权。
<!-- ITERATE:USER-OWNED:END -->
