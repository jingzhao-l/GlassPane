# SYNCLOG — glasspane-harness 与上游的同步记录

一次同步一条，倒序。每条必须给出：**改动面数字**（`fork-diff` 输出）、**跑了哪些闸、结果如何**、**没跑的部分照实写没跑**。

## 2026-09-25 · M1：`gp_*` 工具面进 fork（第一次真正的 vendored 编辑）

- 改动面（`fork-diff`）：**`6631/6636 byte-identical, 1 edited, 4 added, 0 deleted`**
  - `edited`：`packages/opencode/src/tool/registry.ts`（3 个 hunk：import、`yield* glasspaneDefs`、`...glasspane` 进 builtin 列表）
  - `added`：`packages/opencode/src/tool/glasspane/daemon.ts`、`.../index.ts`（另两件是本目录的 FORK.md/SYNCLOG.md）
  - 纪律走通了一遍：先跑 `--check` → 它**拒了**并点名 registry.ts（`✗ edited list changed (0 → 1)`），确认改动是有意的之后才 `--record`。金样更新与改动同批落地，不是事后补。
- 三条不变量的落点：判定全在 daemon（TS 侧只转发与成形）；`output` 里带错误码与可执行 remedy、`metadata` 只作结构化副本（这条是 §5.0 E6 实测逼出来的）；会动到真实应用的 `gp_act` 先过 `ctx.ask` 权限面。方法是否可用**不写死清单**，从 daemon `hello.capabilities` 读——上游刚把 `audit_ui` 加进去，抄死的清单必然过期。
- 跑过的闸：
  - 注册表实测：从 fork 源码起 `serve`，`GET /experimental/tool/ids` 返回 `…,"apply_patch","gp_probe_status","gp_attach","gp_observe","gp_act","gp_diagnose","gp_last_evidence"`（原始 id、无命名空间，且不经过任何插件）。
  - 传输实测：直接驱动 `glasspane/daemon.ts` → `capabilities = {version 0.1.0, protocolVersion 0, capabilities[act,observe,…], permissions{accessibility granted, developerTools unverifiable,…}}`、`probe_status` **ok:true**；未知方法返回 `GP_E_METHOD_NOT_FOUND` 且 remedy 非空。
  - `tsgo --noEmit`（按包，上游口径 `bun turbo typecheck`）：`packages/opencode` **exit 0**。过程中 typecheck 抓出我 14 处错（`Tool.define` 返回 effect 却被当 Info 传给 `Tool.init`、execute 错误通道必须是 `never`、`NumberFromString` 解码后是 number 不是 string、以及我给 `glasspaneDefs` 写了 `Effect<Def[], never, never>` 这种**谎报 R 通道**的注解），全部据此改正后才转绿。
  - lint：`registry.ts` 在同一棵树内 patched vs pristine 对照，规则命中键集与计数一致（6 规则 / 7 warnings / 0 errors），我的 patch 没给它引入新命中。我新写的两个文件首版有 **19 warnings**，两类原因：13 处 `String(unknown)`（会把 `[object Object]` 当成事实喂给模型，不只是风格问题）、5 处对 daemon 响应做 `as` 形状断言。改成显式 `text(value, fallback)` 与 `fields(value)` 收窄之后降到 **4 warnings / 0 errors**，typecheck 仍 0 错。
    对照实验本身也翻过车两次：一次 `npx --no-install` 两棵树都失败而 stderr 被我吞掉，一次抽取正则写成 `plugin/rule`（oxlint 打的是 `plugin(rule)`）——两份空集 `diff` 出来当然"一致"。现在脚本先断言两边键集非空才允许比较。
  - 上游 `mcp-shell` 里唯一的 `String()` 命中是 `evidence-report.ts:269 valueText(value: string | boolean)`，类型安全，不改。顺带记一笔真实的口径差：**工具面 A 至今没有任何 lint 层**（`tsc` 只在 `npm run build` 里跑），而 fork 线第一天就有 `tsgo` + `oxlint`。把等价检查引入 mcp-shell 是后续批次的候选，需要先录一份基线金样，否则一加就是几十条既存噪声。
- **未跑/未验证**：真模型轮次下这些工具被实际调用一次（`ctx.ask` 的权限卡是否按预期弹出、`output` 截断行为、M4 压缩钩子的运行时形状）；`packages/tui` 未因 M1 改动（M5 才动它）；构建产物未随本次改动重建（`dist/` 仍是 02:04 那一次）。
- 遗留：`jingzhao-l/glasspane-harness` 远端未创建，subtree split 发布尚未执行（外部写操作，需用户点头）。

## 2026-09-24 · import `v1.18.32`（base 建立，非同步）

- base：`anomalyco/opencode` tag `v1.18.32` / commit `545f51d`；参照克隆在 `.external/opencode/`（gitignore）。
- 改动面：`fork-diff` 判定 **`6632/6632 byte-identical, 0 edited, 0 added, 0 deleted`** —— 全树忠实照搬，未做任何删减（用户裁决）。本目录的 `FORK.md` 与本文件是 import 之后新增的自有文件，因此现在的记录面里它们出现在 `added`。
- 跑过的闸：
  - `fork-diff --record` 建立记录面：`{identical 6632, edited 0, added 2, deleted 0}`（`added` 那两项就是本目录的 `FORK.md` 与 `SYNCLOG.md`，是我们自己的文件）。
  - **尺子能变红，四条因果验证**：① 未记录的自有新增 → 报 `2 added` 且 exit 1；② `--record` 后 → exit 0；③ 给 vendored 的 `packages/tui/src/routes/session/index.tsx` 追加一行 → 报 `1 edited` 并**点名该文件**、exit 1；④ 从参照还原 → 转绿。安装产物不会污染测量面（`node_modules` 被 fork 自带 `.gitignore:2` 挡住，`git check-ignore -v` 已验；唯一命中 "node_modules" 的未跟踪路径是上游真实源文件 `nix/node_modules.nix`）。
  - 参照克隆完整性：那次被中途杀掉的 clone 让我怀疑基准被污染，所以直接验而不是推理——`git fsck` 无错、工作树干净、`git describe` = `v1.18.32` → `545f51d`、索引 6,632 条。
- **类型检查：已验证，含负例。** 上游 CI 的口径是 `bun turbo typecheck`（按包），所以按包测：`packages/tui`（M5 的目标文件所在）与 `packages/opencode`（工具注册表所在）各自 `tsgo --noEmit` **exit 0**。这个 0 是被证伪测试过的：先跑基线 0 → 往 `packages/tui/src/routes/session/index.tsx` 注入 `const x: number = "…"` → **exit 2 且点名 `index.tsx(2708,7): error TS2322`** → 从上游参照还原 → 回到 0 → `fork-diff --check` 仍绿（整轮折腾没在测量面留痕）。
  过程里先出过一次**我自己的假绿**：前一版脚本写 `( cd pkg && tsgo | tail )` 再取 `$?`，读到的是 `tail` 的状态，结构上永远不可能非零——所以当时那句"typecheck 退出 0"不成立，已撤回并重做。
- **依赖安装：成功，但没有关掉任何校验。** `bun install` 卡在 `packages/app` 的 `ghostty-web@github:…`（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）；`openssl s_client` 查明是**本机有 TLS 拦截代理**：tarball 最终落点 `objects.githubusercontent.com` 的证书由 `CN=SteamTools Certificate` 签发，macOS 钥匙串信任它（故 curl/git 通过），而自带 CA 的 bun 正确拒绝。出路是把钥匙串根（163 张）导成 PEM 配 `NODE_EXTRA_CA_CERTS`，装了 4,671 个包。**没有使用任何"跳过证书校验"的开关。**
- **整包 bundle 构建：已验证（run 5，2026-09-25 02:05）。** 判据三条都来自脚本自己写的标记与产物指纹，不来自包装层退出码：
  - `BUILD_RC=0`（`/var/tmp/glasspane-harness/build-run5.log:1318`），vite 段 `✓ built in 3m 11s`；
  - 产物：`packages/opencode/dist/opencode-darwin-arm64/bin/opencode`，**138 MB**，mtime `2026-09-25 02:04:27`；`dist/` 共 6+ 个平台包，约 2.0 G；
  - **跑起来了，而且能证明是我们的树**：`--version` → exit 0 → `0.0.0-harness/fork-import-202609241756`（渠道=分支名 `harness/fork-import`、时间戳=本次构建时刻），`--help` 列出 23 个子命令。
  - 构建后 `fork-diff --check` 仍是 `6632/6634 identical, 0 edited, 2 added`；`git status` 中 `dist/`、`node_modules/` 零命中——**2 G 产物既不进版本控制，也不进测量面**。
  归因修正：run 4 的失败点确实是 `script/build.ts` 内部那次 `bun add ghostty-web@github:…`；把 `NODE_EXTRA_CA_CERTS` 导出给子进程后就过了。我上一版把它写成"本会话的机制限制跑不完"是**错的**，真实结论是"fork 构建需要把本机信任锚传给子进程"。
  工程含义：不 pin `ghostty-web`，任何带 TLS 拦截或无 github 直连的干净环境都构建不了这个 fork（上游 CI 能过只是它环境没这层拦截）。
- **从源码可运行：已验证。** `bun packages/opencode/src/index.ts --version` exit 0（输出 `local`，源码运行未注入发布版本时的正常值）。
- 遗留：`jingzhao-l/glasspane-harness` 远端未创建，subtree split 发布尚未执行（外部写操作，需用户点头）。
