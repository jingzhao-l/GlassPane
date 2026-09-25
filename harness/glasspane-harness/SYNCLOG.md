# SYNCLOG — glasspane-harness 与上游的同步记录

一次同步一条，倒序。每条必须给出：**改动面数字**（`fork-diff` 输出）、**跑了哪些闸、结果如何**、**没跑的部分照实写没跑**。

## 2026-09-25 · 度量侧收口：上游参照合一 + 工具面棘轮（不动 vendored 树）

- 改动面（`fork-diff --check`）：**仍是 `6631/6637 byte-identical, 1 edited, 5 added, 0 deleted`，绿**。本批只动 `harness/`（尺子与文档）与本文件，未触碰任何 vendored 源文件；FORK.md/SYNCLOG.md 的编辑不改变 added **名单**，所以记录面不变——这正是"以文件名为单位声明分叉"的含义，也是它的盲区（见下第 4 条）。
- **两把尺子过去读两份"上游"**：`hook-liveness` 读 `upstream.json.checkout`（当初的 142 MB tarball 解包目录 `/Volumes/Eng-Dev/.upstream/opencode-1.18.32`），`fork-diff` 读 `.external/opencode`（含 `.git` 的完整克隆）。合并为**一份**：`checkout` 改成 `.external/opencode`，工具改为"相对路径按仓根解析"。合并前先验两份参照**说的是不是同一件事**：`HARNESS_UPSTREAM_CHECKOUT=.external/opencode node harness/tools/hook-liveness.mjs --check` → `checked 20 hooks against anomalyco/opencode@v1.18.32: no drift`，再 `--record` → 与仓内金样**逐字节相同**（仅 `observedAt` 差）。两份能各说各话的"上游"就是这条线自己要防的失效模式，所以这不是清理，是消除一个真实的分裂真源。
- 新增第三把尺子 `harness/tools/tool-surface.mjs`（+ `contracts/tool-surface.json`，进 `ci.yml` 的 `tool-surface` job）。它量的是 fork 自己的账：**我们在 fork 里写的行也算工具面**。基线：engine 17,197 LOC；面 A（`mcp-shell/src`）3,719 行 = **17.33%**；面 B（fork 内我们写的）539 行 = **2.51%**（`preflight.sh` 83 + `glasspane/daemon.ts` 171 + `glasspane/index.ts` 276 + `registry.ts` 的 `+9`）。铁律的 10% **不改成能过的数字**，A 的越限如实记在金样里，闸只挡没被记录的增长（负例：A +3 行红、B +20 行红、给已 `edited` 的 `registry.ts` 加 3 行也红、删 `fork-diff.json` 让归因不能也红；还原后全绿，三个被动的文件 MD5 前后一致）。
- **一个盲区被发现并当场关掉**（先记录现象，再修，再复验）：`fork-diff` 原本以**文件名**为单位声明分叉，于是"已经在我们改动面里的文件又长了几行"它看不见——实测给 `registry.ts` 加 3 行，`--check` 仍 `6631/6637 … 1 edited …` **exit 0**（日志 `/var/tmp/glasspane-harness/blind-spot.log`）。这正是 iterate 侧那种失控的机制版本：名单看着没变，内容一直在长。修法：金样给每个 edited 文件钉**两个哈希**（上游的与我们的），`--check` 名单之外再比内容。关闸后的复验（`/var/tmp/glasspane-harness/fork-diff-hash.log`）：① 用**旧金样**（无哈希字段）跑 `--check` → exit 1 并指名 `--record`（证明新断言真的在跑，不是装饰）；② 重记后 → exit 0，`editedDetail = {registry.ts, upstreamHash 9167cb3e…, forkHash 36a359e3…}`（前者与"pristine import"那次核对过上游 blob 一致）；③ 再加 2 行 → **exit 1 并点名 our content moved**（同一步在修之前是绿的）；④ 还原 → exit 0，`git status` 该文件零残留。
- **CI 侧的覆盖跟着一起补上**（否则上一条修法只管本地，等于没管日常）：`fork-diff --check` 现在**没有参照克隆也能核我们这一侧**——比对金样里的 fork 侧哈希与 added 文件是否还在，并照实打印"上游字节本轮未复测"。该步已进 `ci.yml` 的 `install-gate`。四条负例实测（`/var/tmp/glasspane-harness/fork-diff-offline.log`）：清树 → exit 0 并报 `1 edited file(s) hash-checked, 5 added file(s) present`；给 `registry.ts` 加 2 行 → **exit 1**；金样被剥掉 `editedDetail`（＝这条 lane 无事可控）→ **exit 1 并直说 "this lane has nothing to check"**，而不是绿；删掉一个 added 文件 → exit 1。还原后在线全量 `--check` 仍 exit 0，三个被动文件 MD5 前后一致、`git status` 零残留。**剩余边界**：上游侧内容（我们相对 v1.18.32 究竟改了多少行）只有本地/发布前的全量跑与周跑覆盖，PR CI 不看上游——这是有意的：223 MB 参照 + 2 分钟全树哈希进 PR CI，结局是被人关掉。
- **合流后基线复算（同日，merge `origin/main` = f16f8c8）**：占比棘轮当场变红并报 `surface A grew 3719 recorded → 3859 LOC (+140)`。这 140 行是别的会话在 main 上加 `gp_capture_view` 写的，不是本线——所以同批 `--record` 重记：engine 17,197 → **18,335**，A 3,719 → 3,859（比例 17.33% → **16.98%**，反而降，因为分母里引擎长得更凶），B 仍 539 / 2.37%。**这次红正是闸设计要的样子**：改动不是没发生，是发生了且这里看得见。
- 同一场合并暴露了我自己先前埋的雷：一次跨 base 的 ci.yml 搬移让 `git merge` 把 `docs:` job **整块复制成两份**（"两边各自加了同一段文本"，三方合并不报冲突、静默通过），而 YAML 映射重名键后定义覆盖前定义＝那份守卫从此不再运行。已去重，并加 `scripts/check-workflows.mjs`（进 `docs` job）盯两件事：jobs 段不许有重名键、`run:` 引用的仓内脚本必须存在（按各 step 的 `working-directory` 解析）。六条负例实测：重复 job 名 → exit 1 点名行数；引用不存在的脚本 → exit 1；同一脚本藏进错误的 `working-directory` → exit 1（证明不是橡皮图章）；正确 wd 下的真脚本 → 仍绿；`.github/workflows` 整目录不存在 → **exit 2**（拒绝在空集上报告成功）；还原 → exit 0 且 `git status` 干净。
- 合并后的复跑（本 worktree，装了依赖）：check-version OK / build OK / kernel 59 59 / mcp-shell 176 176 / hook-liveness `--offline` OK / tool-surface OK（重记后）/ fork-diff 在线 `6631/6637 identical, 1 edited, 5 added, 0 deleted` OK。
- **未跑/未验证（照实挂账）**：`bun run build` 未随本批重跑（`dist/` 产物仍是 M1 条那次的 138 MB 二进制，本次没动 vendored 源码，但"构建产物与当前树一致"这句**不成立**，要用产物前先重建）；真模型轮次依旧没做（`ctx.ask` 权限卡、`output` 截断、M4 运行时形状三条仍挂账）；`packages/tui` 未动（M5 才动）。

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
