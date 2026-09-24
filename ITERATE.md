# ITERATE.md — Iterate Skill 项目知识库 / Project Knowledge Base

> 本文件由 AI 通道 onboarding 生成（GlassPane 自身 dogfood iterate）。
> `iterate refresh` 会保留"手动批注"一节；其余小节可被增量刷新覆盖。

<!-- ITERATE:AI-MAINTAINED:START -->

## 项目概述 / Project Overview

GlassPane 是 macOS 上面向 AI 代理的**运行时验证引擎**：代理经 MCP 调用 15 个 `gp_*`
工具驱动真实应用，每次操作产出可复核的证据包（前后无障碍树、像素差异实测、归因结论、
可回滚检查点）。产品的立身之本是**诚实性**——测不出的必须写"未验证"，绝不能为了
好看而点亮指示器。任何改动若在这一点上让步，即使测试全绿也算失败。

两条对外分发面：npm 两个裸名包（`glasspane-mcp` 转发层 / `glasspane-install` 安装器）
与 GitHub Release 源码 tarball；对外部用户首次启动会被 Gatekeeper 拦（ad-hoc 签名、
未公证，是用户 2026-09-22 拍板暂缓的决策，不是遗漏）。

## 技术栈 / Tech Stack

| 层 | 技术 | 真源位置 |
|---|---|---|
| 后台服务与设置界面 | Swift 5.9+ / SwiftUI，SPM 多 target | `engine/Package.swift` |
| 探针 SDK | Swift SPM 包 `GlassPaneProbe` | `engine/probe/Package.swift` |
| MCP 服务器 | TypeScript ESM → esbuild 单文件 bundle | `mcp-shell/` |
| 契约层 | JSON Schema（TS zod ↔ Swift Codable 双向绑定） | `kernel/schemas/` |
| 调试桥 | Python 3.11 + LLDB | `bridge/glasspane_bridge.py` |
| 安装器 | 零第三方依赖 Node ESM | `installer/cli.js` |
| 发布/CI | GitHub Actions；npm Trusted Publishing（staged-only） | `.github/workflows/` |

依赖关系：`mcp-shell` 通过 `file:../kernel` 引 kernel，**发布时由 bundle 内联**，
npm 包里不得残留 `file:` 引用（CI 的 publish-shape 守卫专抓这个）。

## 模块地图 / Module Map

- `engine/Sources/GlassPaneEngine/` — 核心：`EngineCore`（attach/observe/act/归因）、
  `AXChannel`（只有 `performAction` 通道：无写值、无合成 HID）、`DaemonProbe`（自报权限
  席位）、`EvidenceStore`/`EvidenceModels`（证据落盘与 schema）、`ProjectRegistry`、
  `ApprovalGate`（哈希链审计台账，不是拦截器）。
- `engine/Sources/glasspaned/` — daemon 入口（unix socket `~/.glasspane/engine.sock`，
  `chmod 0600`，**无 peer 鉴权**：同用户即全权，这是信任边界）。SIGTERM 走
  sigwait + 入口早期 `pthread_sigmask`（换 GCD 信号源会被证伪，别再改回去）。
- `engine/Sources/glasspane-settings/` — SwiftUI 面板；权限卡只展示 daemon 实测结果。
- `engine/scripts/make-app.sh` — 两个 `.app` 的打包与 ad-hoc 签名（identifier 型 DR，
  让 TCC 席位跨重签存活）。
- `mcp-shell/src/` — `dispatch`（JSON-RPC）、`tools`（15 个工具契约）、`engine-client`。
- `installer/cli.js` — 环境预检→构建→打包安置→launchd→面板→使用说明；纯函数与副作用
  严格分离以便 `node:test` 覆盖。
- `bridge/` — LLDB 附挂采集；`spike/` — 可行性实验与留档结果。
- `scripts/version-sites.mjs` — **版本线位点表**；`specs/` — 设计真源与验收台账。

## 推荐审查维度 / Recommended Review Dimensions

全 9 维都启用（`review.scope: full`，仓库体量小，增量审查反而容易漏跨层不一致）。
最有价值的三个：**spec-compliance**（行为改动必须回到 `specs/` 对应文档留痕）、
**security**（TCC 权限面 + socket 信任边界 + 证据落盘内容）、**style-tests**
（新增能力必须带纯逻辑单测，且门禁命令本身要精确可跑）。

## 推荐审查蓝图（按范围 / by scope）

见 `iterate.config.yaml` 的 `dimension_sets`：`engine` / `gui` / `mcp` / `bridge` /
`release` / `docs` 六套。改动落在哪一层就用哪套；跨层改动（例如新增一个 `gp_*` 工具）
必须同时过 `mcp` + `engine`，因为工具契约在三处镜像（kernel schema、daemon、mcp-shell）。

## Iterate 注意点 / Iterate Notes

1. **门禁命令必须逐字精确匹配** `validation.commands`。本项目实测可用的形态（从仓库根）：
   `swift build --package-path engine`、`swift test --package-path engine`、
   `swift test --package-path engine/probe`、`python3 -m pytest -q bridge`、、`node scripts/check-doc-links.mjs`
   `npm run build`、`npm test --workspaces --if-present`、`node scripts/check-version.mjs`。
   加参数、换目录、串 `&&` 都会被运行时拒绝。
2. **`swift test` 有 1 条按设计跳过**（opt-in 真机项）。基线是"374 通过 / 0 失败 / 1 跳过"，
   别为了让它变绿而删断言或补模拟数据。
3. **CI 不能承载真机验收**：无障碍、事件监听、屏幕录制需要登录 GUI 会话与已勾权限，
   记录在 `engine/smoke.md`。修到这类面时，结论只能标"待真机复跑"，不能标"已验证"。
4. **手势不可合成**：CGEvent 能驱动 UI，但合成不出启动 SwiftUI `.onDrag` 会话的拖拽
   （真机实测 F10）。不要为此改坏点击路径的等价性守卫。
5. **改指示器文案前先读 daemon 自报**：面板不得代测、不得借用别的卡读数；
   开发者工具卡恒"未验证"是设计（P1 v1.2 §11.2）。
6. **版本只走脚本**：`node scripts/set-version.mjs <semver>`。手改单个 `package.json`
   会让 9 个位点漂移，CI 的 `version-line` 任务直接红。
7. **kernel 是生态契约层**：schema 改动要同步 Swift/TS 双侧绑定与共享 fixture，
   并且——上游真源正在迁往 iterate-skill 主仓，本仓 `kernel/` 将降为镜像。

<!-- ITERATE:AI-MAINTAINED:END -->

---

<!-- ITERATE:USER-OWNED:START -->

## 自定义代码约定 / Custom Code Conventions

- 提交信息：Conventional Commits 前缀 + 中文正文（`fix:` / `ci+release:` / `docs:` /
  `install:`），一提交一逻辑变更；正文要说清"为什么"与证据来源。
- Swift：`public` 面显式标注；纯逻辑与副作用分离（`installer/cli.js` 的具名导出模式同此意）；
  魔法字符串收进具名常量。
- TypeScript：ESM + `type: module`；测试用 `node --test`，不引第三方测试框架。
- Python：零第三方依赖（bridge 运行面），测试用 pytest。
- 注释与文档面向读者：解释约束与失效模式，不写"我为什么这么改"的自辩；
  用户可见文案（GUI/终端输出/README）里不出现内部 §引用与规格编号。

## 禁区与风险区 / Restricted & Risk Areas

- **禁区**：`specs/**`（验收台账与决策记录，AI 不得改写历史结论）、`kernel/schemas/**`
  （契约真源，需跨语言同步而非单边修改）、`LICENSE`。
- **风险区（需架构审批）**：`engine/Sources/GlassPaneEngine/`（归因/证据语义）、
  `engine/Sources/glasspaned/main.swift`（信号与 socket 语义）、`mcp-shell/src/tools.ts`
  （对外工具契约）、`.github/workflows/release.yml`（不可逆发布通道）。
- **并行会话现实**：主工作副本常被另一会话占用（dirty），一律用 worktree 隔离；
  绝不 `git checkout --` 别人改过的混合文件。

## 手动批注 / Manual Annotations

- 尚未做 `known_intentional` 登记（需要真实 `file:line`，凭记忆填行号属伪造证据）。
- 公证（Apple Developer ID + notarytool）为**用户决策项**，未启用；不要在任何文档里
  把它写成已完成。
- npm 上 `1.1.0` 是否已存在，取决于 owner 是否已 `npm stage approve`（见
  `.github/workflows/release.yml` 头部与 CHANGELOG 的 1.1.0 Notes）。

<!-- ITERATE:USER-OWNED:END -->
