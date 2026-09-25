# glasspane-harness — 上游 opencode 的产品级定制 fork

- **上游**：`anomalyco/opencode`（`sst/opencode` 已 301 至此），许可证 **MIT**（见 `LICENSE`，随上游原文保留）
- **base**：tag `v1.18.32`，commit `545f51d`，日期 2026-09-21
- **import 日期**：2026-09-24，**全树忠实照搬**：`harness/tools/fork-diff.mjs --record` 当时判定 `6632/6632 byte-identical, 0 edited, 0 added, 0 deleted`
- **宿主形态**：本目录是 GlassPane 主仓里受版本控制的子目录（项目源头仓内定制），发布走 `git subtree split --prefix=harness/glasspane-harness` 到 `jingzhao-l/glasspane-harness`（远端待创建）。上游完整 clone 放在仓库根的 `.external/opencode/`（gitignore，不入版本控制），diff 尺子与将来 cherry-pick 都从它取。

## 定制纪律（两条，不可让步）

1. **判定性验证逻辑 100% 留在 Swift**。本 fork 里可以有 UI、编排、语义层与呈现，但"这次变化是不是这次操作造成的"这类判定只能由 `glasspaned` 通过 local socket 给出。方法表在合并 `origin/main`（f16f8c8）之后是 **13 个**：`hello / attach / act / observe / assert_element / diagnose / last_evidence / snapshot / restore / audit_ui / capture_view / probe_status / shutdown`（真源是 `engine/Sources/GlassPaneEngine/FrameCodec.swift` 的 `enum EngineMethod`；数的时候要展开 `case hello, attach, act, observe` 这类一行多枚举——**该枚举有 8 行 `case`、13 个成员**，按行数会数错。别信任何写死的数字，包括这一句）。错误帧恒 `{code, message, remedy}` 三字段。**这个数是别的会话会改的**（1.1.1 基点上只有 11 个，`audit_ui`、`capture_view` 都是之后合入的）——所以 fork 侧不许把方法名抄成字面量清单，要从 daemon 的 `hello.capabilities` / 协商结果读。fork 侧只做绑定与呈现。工具面 A 已经犯过一次"同一份状态两边各写一份实现"的错（`projects.json` 的 TS/Swift 双写，见 `specs/…审计_2026-09-22`），fork 不允许成为第三份。
2. **分叉必须可测量**。任何触碰 vendored 树的提交，必须在**同一个提交**里更新 `harness/contracts/fork-diff.json`；不更新就 `fork-diff --check` 红。
3. **vendored 内核不是我们的代码，也不是可以改的地方**。`packages/opencode/vendor/kernel/` 的真源是 `iterate-skill/kernel`（canonical），经 `tools/sync-kernel.sh --target=fork` 单向同步，逐文件 sha256 钉在 `harness/contracts/kernel-vendor.json`。在这里手改一个字节 = `kernel-vendor --check` 红（CI 也跑）。

```bash
node harness/tools/fork-diff.mjs --check    # 实际分叉面 vs 记录面（约 2 分钟，逐文件 blob 比对）
node harness/tools/fork-diff.mjs --record   # 改完上游文件后重记，连同改动一起提交
node harness/tools/tool-surface.mjs --check # 我们在 fork 里写了多少行（棘轮：只挡没被记录的增长，进 CI）
node harness/tools/kernel-vendor.mjs --check # vendored 内核 == 它的溯源清单（进 CI，不需要 canonical）
```

为什么把这条写死：另一条 harness 线（`iterate-harness`）的设计文档写着"8 处定点修改"，而它自己的树里 194 个共享文件有 **144 个**被改过、20 个被删、8 个新增，并且没有任何机器检查能发现这件事。**定制多少从来不是问题，不知道定制了多少才是。**

## fork 侧提交约定

所有我们的提交以 `[gp] ` 前缀标注。于是"我们到底改了什么"永远是可枚举的集合：

```bash
git -C .external/opencode fetch --tags            # 拿上游
git log v1.18.32..HEAD --oneline --grep '^\[gp\]' # 完整定制提交清单
```

## 同步上游（不 rebase、不 merge 上游分支）

1. `git -C .external/opencode fetch --tags` 取新 tag `vX.Y.Z`；
2. 开临时分支，把 `[gp]` 提交集合重放到新 base 上（冲突逐个解，**解冲突时先看 `harness/contracts/fork-diff.json` 里该文件是否已在我们的改动面内**）；
3. 跑三件事：`fork-diff --record` 看新分叉面、`hook-liveness --probe`（`HARNESS_UPSTREAM_CHECKOUT` 指新 tag）看扩展点还在不在、以及 M1–M5 的固定点测试；
4. 结论与冲突写 `SYNCLOG.md`，一次同步一条。

为什么放弃"失败可归因于上游"：产品级 fork 主动改地板，红的时候天然混着"上游变了"和"我们改了"。归因力从哪儿补回来——`fork-diff` 的改动面清单 + `hook-liveness` 的扩展点存活断言 + `SYNCLOG.md` 的时间线。三者都在仓里，都跑过。

## 我们的能力面（M1–M5）

| # | 能力 | 落点 | 现状 |
|---|---|---|---|
| M1 | `gp_*` 工具面（结构化结果 + agent 可执行 remedy） | `packages/opencode/src/tool/glasspane/` + `tool/registry.ts` 注册 | **已落地并实测**（见 `SYNCLOG.md` 2026-09-25 M1 条）：6 个工具以原始 id 出现在 fork 自己的注册表里，传输链直连 daemon 通过；固定点测试 6 条（`test/tool/glasspane-surface.test.ts`，M4 批补齐——raw id 唯一性、remedy 进 `output`、死 socket 仍回 `{code,message,remedy}` 三字段） |
| M2 | evidence 采集 → kernel 决策日志（opID↔entry 哈希链） | `src/plugin/glasspane-decision-log.ts`（内部插件，绑 `tool.execute.after`）+ `src/tool/glasspane/kernel.ts` | **已落地**：outcome/summary 全部转录自引擎写下的字段；运行时证据见 `SYNCLOG.md` 同日条与 `script/glasspane-e7-ledger.ts`。**宿主走到 hook 这一问已由 E8 回答**：真实会话里 `tool.execute.after` 被派发、note 落进 part metadata（skip 分支；`logged` 分支的真会话写入仍需一次证据成包的真轮次） |
| M3 | `@iterate/kernel` 绑定 | **vendored 源** `packages/opencode/vendor/kernel/` + 溯源清单 `harness/contracts/kernel-vendor.json` | **已落地**：不依赖发布（P6 §13 决定 kernel 不单独发布）。同一份源码在 fork 里跑的是 zod 4 而 canonical 钉 zod 3 —— 这条耦合由 `tool/glasspane-kernel.test.ts` 量着 |
| M4 | 维度感知上下文压缩 | `experimental.session.compacting`（触发点 `session/compaction.ts:374`，零 patch）| **已落地（M4 批）**：内部插件 `src/plugin/glasspane-compaction.ts`（`plugin/index.ts` 再 +1 import +1 数组项），钩子经 `client.session.messages` 拉会话，把引擎/内核已写下的**证据锚点**（opID/outcome/台账序号与哈希）追加进 `output.context`（`prompt` 已被替换时改追加进 prompt——上游 `prompt ?? [...context]` 会让 context 成死信）。**维度系统在本 pin 的内核里不存在**（导出面实测无 `dimensionContext`），M4 不发明维度，缺席以 `calls vs decisions recorded` 的算术呈现。固定点测试 16 条；**E8 运行时**（`script/glasspane-e8-compaction.ts`）证明钩子在真实宿主里被派发、注入块出现在 mock provider 收到的压缩提示词里。真模型轮次仍未跑（挂账同前） |
| M5 | 会话流内 evidence 渲染 | `packages/tui/src/routes/session/index.tsx`（`toolDisplay` 加 `gp_` 前缀分支 / 新增 `glasspaneRow` 纯函数与 `GlassPaneTool` / `GenericTool` :1798 兜底） | **已落地（M5 批，2026-09-25）**：引擎拒绝（`ok:false`）与真实结果在会话流里视觉可分；固定点测试 +6（23 全绿、8 个既有 snapshot 未动），行模型 `glasspaneRow` 是导出的纯函数故可直接钉。上游对该文件改动频繁（3 个月 15 次提交），仍是同步冲突的主来源。**真 TUI 会话里的观感未观测**（组件级已测）；`packages/{app,session-ui,desktop}` 会不会取代 TUI 仍是 §10 挂账 |

## 已知边界（不粉饰）

- `permission.ask` 在上游是**死钩子**（`v1.18.32` 全树仅一次出现＝声明处，零派发），fork 的权限引导必须走 `event` 收 `permission.asked` + `client.permission.reply`，不能挂它。运行时旁证与"仍缺决定性证据"的边界见 `specs/GlassPane_Harness_Fork_调研与方案_v0.1.md` §5.0/§5.1：要把这条升级成运行时决定性，需要一次真模型轮次（或上游肯加一个测试注入点）。
- **构建环境要求（先跑 preflight，别重复踩）**：`bun run build` 先 vite 内嵌 Web UI（首次约 10 分钟，缓存后约 3 分钟），随后 `script/build.ts` 自己再跑一次 `bun add ghostty-web@github:…`。本机对 `objects.githubusercontent.com` 的 TLS 由**拦截代理**签发（`CN=SteamTools Certificate`），macOS 钥匙串信任它，所以 curl/git 都过，而自带 CA 的 bun 正确拒绝。构建因此**必须把信任锚传给子进程**：`export NODE_EXTRA_CA_CERTS=<钥匙串导出的 PEM>`。只设 `PATH` 不设它，就会在 10 分钟后死在一个 TLS 报错上，看起来像"fork 构建不了"。
  - 检查方式：`sh packages/opencode/script/glasspane-preflight.sh`（先跑，秒级）。它验的是"这份束能不能验证 bun 将看到的那条链"，不是"有没有设变量"。三条路径都实测过：未设 → exit 1 并给可执行 remedy；只给 158 张系统根 → verification FAILED（正是 bun 失败时的配置）；给完整钥匙串束 163 张 → OK（正是构建通过时的配置）。**任何"跳过证书校验"的开关一律不用。**
  - 不改依赖源的决定：npm 上有 `ghostty-web@0.4.0`，但上游钉的是一个 git commit（`83c0a07b`），换成 npm 版本等于在承诺"分叉可逐字节追溯"的 fork 里塞进一个未验证的依赖漂移。代价写清楚：**干净 CI 环境若没有这张拦截根证书或没有 github 直连，就构建不了这个 fork**——上游 CI 能过只是它环境没这层拦截。将来真要进 CI，先解的是网络与信任，不是悄悄换源。
  验过的构建结果：`BUILD_RC=0`，`dist/opencode-darwin-arm64/bin/opencode` 138 MB，`--version` 返回 `0.0.0-harness/fork-import-<时间戳>`（渠道即分支名，可证是从本树构建）。
- **整包构建耗时**：单次 >10 分钟。不要放在 PR CI 里；闸是**按包** `tsgo --noEmit`（上游口径就是 `bun turbo typecheck`）+ `fork-diff`。
- 上游 v2 插件系统正在并行重写；我们改的是它公开说将来要换的 v1 形状。fork 形态对此反而更耐打（我们能改地板），但 `SYNCLOG.md` 必须如实记下每次同步的代价。
- `fork-diff` 全树哈希约 2 分钟，**不进 PR CI**（和 142 MB 上游一样重）；它跑在本地/发布前与同步上游时。
