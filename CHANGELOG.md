# Changelog

本文件记录 GlassPane 的值得注意的变更。格式遵循 Keep a Changelog，版本号遵循 Semantic Versioning，条目按时间倒序。

关于 `v0.1.0` 之前的历史：仓库在 2026-09-22 之前不存在任何 git tag，也不存在可用的版本号，因此那段时间按 P0…P6
规格阶段作为里程碑分节记录，不追溯伪造版本号。所有日期取自 `git log`，每条 bullet 可回溯到其给出的 commit hash 或
`specs/` 正文；两者都给不出来的内容已被删除。

## [1.1.0] — 2026-09-22

一次基础设施审计的结果：本仓库被逐条对照作者的另一个项目检视，发现的全部问题在同一批提交中修完。

### Added

- **单一版本线**。此前四个包版本各自漂移（根 `@glasspane/monorepo` `1.0.0` / `glasspane-install` `1.0.0` /
  `glasspane-mcp` `0.1.0` / `@iterate/kernel` `0.1.0-draft.1`）。新增 `scripts/set-version.mjs` 以根 `package.json`
  为真源改写全部派生位点（四个 `package.json` + lockfile、`install.sh` 与 `installer/cli.js` 钉住的 release ref、
  mcp-shell 的 `serverInfo.version`、daemon `hello` 自报版本、`.app` 的 `CFBundleShortVersionString`，位点清单集中在
  `scripts/version-sites.mjs`），新增 `scripts/check-version.mjs` 在任意漂移时让构建失败，并新增 CI job 强制执行。
- **可复现的安装**。`install.sh` 原本 `git clone` 移动的默认分支（`main`），同一天两个用户可能拿到不同代码。现在
  clone 钉住的 release tag（`GLASSPANE_REF` 可覆盖，缺省即发布线），`GLASSPANE_REPO_URL` 覆盖能力保留。
- **`npx glasspane-install` 变成真话**。installer 自己的 README 承诺 npx 即可完成完整安装，而 `installer/cli.js`
  在定位不到仓库时直接 `throw new Error(repoMissingText())`——源码树必须先存在。现在安装器自举：定位不到仓库时
  clone 钉住的 tag 到 `~/glasspane` 并继续，与 `install.sh` 同一策略。
- **发布自动化**。`.github/workflows/release.yml` 新增 tag 触发的 GitHub Release job，产出确定性 source tarball +
  `SHA256SUMS.txt`（v1.1.0 的 Release 即由它生成，校验和经下载侧 `sha256sum -c` 独立复核）；手动 `workflow_dispatch`
  job 以 `npm publish --provenance` 发两个裸名包，直发被拒时自动回落 `npm stage publish`（Trusted Publishing 配成
  staged-only，"是否存在"最后一步 `npm stage approve` 留在 owner 手里）。dry 分支改用 `npm pack --dry-run`——npm 11
  的 `publish --dry-run` 不再纯本地，会查 registry 撞已发版本。
- **文档门面**。`README.md` 重写为英文主入口 + 新增 `README.zh-CN.md`；新增 `CONTRIBUTING.md`、`SECURITY.md`、`.github/CODEOWNERS` 与 issue / PR 模板。

- **自我 dogfood**。新增 `ITERATE.md` + `iterate.config.yaml`（本项目的 iterate onboarding 产物，AI 通道生成）：
  审查维度按层分 6 套蓝图，`validation.commands` 逐字收录从仓库根实测通过的 7 条门禁命令（与 `ci.yml` 各 lane 同源），
  并把 `specs/**` 与 `kernel/schemas/**` 设为禁区、归因核心与发布工作流设为需架构审批。
  验证：`iterate doctor` 18 项全通过、`iterate fingerprint` 无漂移、`scripts/validate.py config` 通过。

### Changed

- 四个包版本统一到 `1.1.0`。`1.1.0` 是两个已发布包都从未用过的号，不覆盖任何已发布产物（registry 实测：
  `glasspane-mcp` 仅有 `0.1.0`，`glasspane-install` 仅有 `1.0.0`）。

### Fixed

- **发布产物形状**。`mcp-shell` 的 bundle 步骤用 `cp -R ../kernel/schemas schemas` 复制 schema，重复执行时会嵌套。
  从 registry 拉下的 `glasspane-mcp@0.1.0` tarball 实测确认带着重复项（49 个文件，`package/schemas/schemas/*.json`
  与 `package/schemas/*.json` 并存）。该步骤现在幂等，并额外清除非入口的编译产物 `.js`/`.map` 残留——同一 tarball 里
  esbuild 单文件 bundle 与逐模块 `dist/*.js`、`dist/*.js.map` 曾一起打包，与"kernel 内联进一个 bundle"的形状不符。

### Notes

- **一键安装的诚实边界**。一条命令安装出来的是 ad-hoc 签名产物，没有 Apple Developer ID 签名、没有公证——这是记录在
  [P6 §13](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md) 的决策单，前置是一次付费的 Apple Developer
  Program（$99/年）。外部用户首次启动因此会被 Gatekeeper 拦下，需在系统设置里手动允许；此前 README 承诺"一键安装"却
  未带这条限定，与项目自陈的原则冲突（"拿不到数据就显示未验证，永远不会为了好看而点亮"）。
- **1.1.0 先在 GitHub 存在**。GitHub Release 与源码 tarball 已随 tag 产出；registry 上仍是 `glasspane-mcp@0.1.0`
  与 `glasspane-install@1.0.0`，直到 owner 跑一次 `mode=publish` 并 `npm stage approve`（发布不可逆，这最后一步刻意
  不自动化，见 [release.yml](.github/workflows/release.yml) 头部口径）。

## [0.1.0] — 2026-09-21 … 2026-09-22

唯一真实存在的发布 tag `v0.1.0`（打于 2026-09-22，指向 `927805c`）。

### Added

- 裸名发布形态落地（`4f78484`）：`glasspane-mcp`、`glasspane-install` 两个包上架 npm，`LICENSE` 为 MIT，公开
  `README.md`，`files` 白名单与 `bin` 就位——兑现
  [P4 §33.2](specs/GlassPane_P4_实施规格_v4.0_收口与里程碑一致性.md) 决策链条目 3 的裸名映射。GitHub 仓库转公开
  `jingzhao-l/GlassPane`，`install.sh` 的 curl 分发通道自此对外成立（P6 §13）。
- evidence schema 冻结执行 `0.1-draft → 0.1`（`0ec4d0e`）：`$id` / JSON Schema const / zod literal / Swift
  `schemaVersionConst` / fixtures ok-01…03 全绑定同步，读侧 `legacySchemaVersions` 保持 draft 期历史包可解码
  （[P6 §12](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md)）。
- `34cd904` 补上 provenance 发布通道与 publish-shape 守卫，并把 handler lane 的真 app 命中闭环（`spike/h1-retest-result.json`：
  `hitCount=1、level=strong`）；`927805c` 同步 `mcp-shell` 独立 lock 的 esbuild devDep；`0340e6a` 给 README 加
  npm / License / CI 徽章；`b65199d` 把公证决策单与"发布后遗留"清单入档 P6 §13。

## Phase B 入口与 CI 首跑收口（2026-09-21）

### Fixed

- CI 第一次真跑挖出三处潜伏缺陷（`b3d8002`）：Node 20 不展开带引号的 `test/*.test.mjs` glob（本地 Node 26 支持，
  故只在 CI 暴露）、`mcp-shell` job 没先构建 `file:../kernel` 依赖、`bridge` job 缺装 pytest。根因档案在
  [P1 v1.2 §11.9](specs/GlassPane_P1_实施规格_v1.2_GUI设置面板.md)。
- 请求超时定时器不再 `unref()`（`879117e`，`mcp-shell/src/engine-client.ts`）：unref 的定时器不维持事件循环，当
  "等 daemon 回应"是进程里唯一剩余工作时 Node 直接退出，超时永不交付——调用方拿到的是进程死亡而不是
  `GP_E_ENGINE_UNREACHABLE` 与 remedy。缺陷自 `fa537b4`（首个 mcp-shell 提交）就在；补一条在裸进程里验证的回归
  fixture `mcp-shell/test/fixtures/timeout-loop.mjs`（P1 v1.2 §11.9 第四处 / P1-S21）。
- 桥 attach 参数真缺陷修复（`b090567`）：lldb 无 `--attach` 选项，改 `-p` 并单测禁回潮，P6 §7.5 挂账自此收窄为纯
  环境项（调用方勾选开发者工具）。同批补 Phase B 前置补数三闸与 `spike/run_spikes2.py`。
- 两台真机回归闸（`5d72a9f`，P1-S8/S10 收尾）：`engine/.rebuild_survival_smoke.py`（换装 cdhash 已变、identifier
  与 designated requirement 未变的产物后权限仍 granted）与 `engine/.input_monitoring_registration_smoke.py`，前者
  改真实安装并重启现网作业故不进 CI。`.c6_smoke.py` 必须打隔离 socket 的约定入档（`13f9bdb`）。

## P6 §11 — 人工介入最小化审计（2026-09-19 … 2026-09-20）

审计口径：用户剩余动作必须收敛到物理性不可约操作（TCC 勾选 / 付款 / 发布授权），检测、验证、恢复一律机器化，
remedy 必须 agent 可执行且不许诺不存在的能力。八项发现的逐项落点见
[P6 §11](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md)。

### Added

- `degrade` 参数落地（`d4843c6`）：`GP_E_BUSY_INPUT` 的 remedy 此前指向一个不存在的 "degrade mode"，现在它指向
  真实参数（act 全链 → `acquireOperationRight(degradeOnBusy:)` → Dispatcher → mcp-shell schema）。
- `installer --restore-launchd`（`3507048`）：检测 → bootstrap → `hello` 自报校验 → 已加载未授权时 `kickstart -k`
  换进程复验，退出码即判定；`GP_E_ENGINE_UNREACHABLE` 的 remedy 同步换成该可执行命令。
- `engine/.p4i4_smoke.py` 与 `spike/run_h1_retest.py`（`9d90f06`）：P4-I4 拖拽引导逐卡机器断言，H1 真实 app 强归因
  率复测一条命令可跑（真机 24/24 strong = 100%，`stateSource=z2-mirror`，`hitCount=0` 如实记录）。
- 开发者工具席位接入机器验证（`801aaac`，P1 v1.2 §11.6）：`DebugCapabilityProbe` 受限真探测三态，未知失败报
  `spawnFailed` 而不冒充权限判定。

### Fixed

- SIGTERM/SIGINT 哑火真修（`a38054d` + `4e166f5`）：入口早期 `pthread_sigmask` + 专用 `sigwait` 线程消费 pending，
  收尾只 unlink `engine.sock`/`probe.sock`、不 close 在 `accept()` 中使用的 fd；`--grant-accessibility` 文案不再
  导向"给终端勾选"的借来席位。
- 面板 `launchctl` 路径写死 `/usr/bin/launchctl`（本机真值 `/bin/launchctl`，真机发现 F11），四类 launchd 动作
  抛错全被 `return nil` 吞掉，用户症状是"点了没反应"；同批修掉探测跑在主线程导致的看门狗冻结、把实测结论上到
  徽标、面板文案全面改为面向用户（`ac889a8`、`3894ab9`）。
- `ac889a8` 同时修好那份从未被解析成功的 CI YAML——步骤名 `Install kernel (local file: dep)` 含裸 `": "` 导致整份
  workflow 解析失败，GitHub 上每个 run 都是 0s failure、无 job、无日志（P1 v1.2 §11.9）。
- 崩溃夹具源纳入仓库（`90f04d4`，`bridge/crashcanary.swift`），P6 §7.5 夹具债闭环。

### Notes

- **一条无法自动化的验证，如实记下**：P4-I4 原口径是"拖拽无法自动模拟 → 待人工目视"。审计把它拆开——真机发现 F10：
  CGEvent 合成点击能驱动 macOS UI（标题栏双击 zoom 实测生效），但三种拟真形态共 6+ 次都无法启动 SwiftUI 的
  `.onDrag` 拖拽会话——拖拽是系统级不可合成维度，而该手势本身无独立授权语义（`handleDrop` 恒委托 `guide(kind)`）。
  于是可断言面全部机器化，"不可自动化"精确化到手势维度，人工目视项撤除（P4 §34.3 P4-I4、`engine/smoke.md` 17）。

## P6 — 探针 SDK 与 LLDB 桥（2026-09-19）

### Added

- [P6 v6.0 实施规格](specs/GlassPane_P6_实施规格_v6.0_探针SDK与LLDB桥实现.md)（`d732de0`）：补齐仓库内七项规格空白，
  §0 先登记 8 条实施期实测事实（`task_for_pid` 被拒、attach 被拒、SB API 可用、swift-syntax 603 可达、lldb 冷启动
  惩罚、Text-AXValue 可见性边界、菜单徽标噪声、act 全窗 463ms）。
- `GlassPaneProbe` 独立 SPM 包 Z1–Z4.5 全级交付（`5b75f12`）：`#gpHandler` 宏（swift-syntax 603.0.2
  ExpressionMacro）、Z2 Mirror 有界遍历（深度 ≤8、节点 ≤4000）、Z3 KVC 实时 state 事件、Z4.5 `MTLCaptureManager`
  描述符式捕获。swift-syntax 不进 daemon 构建图；probe 10 用例。
- daemon 探针链路全面接线（`329829b`）：`probe.sock` 多连接 NDJSON + `ProbeInbox` 窗口归属/迟到计数/防篡改 digest
  复核；分类器 T4/T5/T7/T8 + strong 归因首次落地；档 1 兑现 P5 预留槽（`checkpoint_export` 真值 payload +
  `rollback_full` 执行面，`evicted`/`setter-missing`/分歧三路如实拒绝不假保真）。engine 319 用例。
- LLDB 桥（`962b08b`，`bridge/glasspane_bridge.py`）：Python + SB API，capture/trace/interactive 三模式，Z4 硬件
  watchpoint 4 槽 + FIFO64，`test_bridge.py` 17 纯函数用例；launch-capture 端到端真机打通见 `4fa83d7`（实证 batch
  模式在 crash stop 即终止会话，真机发现 F9）。kernel schema 转真值三点同步 + `gp_probe_status`（`2068f2e`）把
  工具面推到 14。

### Notes

- spike 首轮真数据（`a52dd2c`、`7470e45`，[spike/results.md](spike/results.md)）：H3 双口径扫描 strict 17.4% < 20% ✓；
  **H7 超阈**（宏冷全量 +720%、增量 +102% 超 C1 预算）触发规格预设的失败动作——宏转 opt-in，Z1 语义由手动
  `GP.recordState`/`GP.recordHandler` 承担；H4 按 §10.1 失败动作降为基线对比通道。attach 面当时仍为 kernel not
  permitted（`4fa83d7`），P6 §7.1 判定 TCC 开发者工具授权是用户动作。

## P4 — 收口与一键安装（2026-09-18 … 2026-09-19）

### Added

- [P4 v4.0](specs/GlassPane_P4_实施规格_v4.0_收口与里程碑一致性.md) 收口与里程碑一致性检查（`174e783`）：实施规格
  系列最终版，含全量验收清点总表与铁约束遵守复核（§30–§32）。遗留项落实：B7/C6/D6 真机冒烟资产入库并跑通
  （`71eee50`），收口记录与分发形态决策入档 §33（`569ceb2`）。
- 一键安装器 `installer/cli.js`：纯 Node ESM、零第三方依赖、Node ≥18（`88c5bfa`，P4 §34），纯逻辑 11 用例
  （`600243b`，P4-I1）；端到端真机走通见 §34.3 P4-I2。GUI 打包 `make-app.sh` 零依赖生成 minimal bundle（`848f37e`）、
  daemon 开机自启 launchd plist + `launchctl bootstrap`（`39a2a13`，`--no-launchd` 可跳过）。
- 设置面板拖拽引导：拖 app 图标到权限卡精确打开系统面板 + 1s 轮询自动点亮（`01995ae`，P1 v1.2 §10），
  `PermissionGuide` 深链映射与诚实边界 10 用例（`734aaf4`，P1-G1）。
- `install.sh` 一键入口与 MCP 配置片段输出（`0fe0992`，P4 §35）；§33.2 落发布决策链全记录（Phase B 门控 / org 出局
  证据 / 裸名映射 / kernel 命名裁决 / installer 一等渠道），installer 21 用例。
- C33/T9 真机冒烟脚本落地并跑通（`c182259`，P4 §34.5）：`glasspaned --check-input-permission` 三态探测、
  `.c33_smoke.py` 多实例发现、`.t9_smoke.py` 泄漏金丝雀 16 轮触发 `diagnose.class=T9`。

### Fixed

- daemon 审批台账显式持久化路径（`8e9b776`）：`ApprovalGate()` 默认 path 为 nil 即纯内存台账，restore 执行成功但
  `approvals.json` 不落盘、`--approval-verify` 恒 count 0。
- 权限主体与产物身份修正（`426913c`、`c5a739b`）：面板不再代测 daemon 席位；同批实测发现同一 bundle 经 `open` 起与
  经 launchd 起自报读数不同（真机对照：用户实际只勾了屏幕录制，另两项是从启动者借来的），口径入档 P1 v1.2 §11.1
  （`c197836`）。
- daemon 默认注入 `AttributionGuard`（`c99c026`，P4 §36）：tap 创建即权限如实探测，失败自动降级回纯互斥形态而非
  谎称启用；`.c33_smoke.py` 升级三阶段真机全过。

### Notes

- 发布形态就位但发布动作暂缓（`21cd7f6`、`6cda8bd`、`468dcc0`）：`npm publish --dry-run` 零警告，但 registry 上
  `@glasspane`/`@iterate` org 均不存在、`@iterate/kernel` 是 `file:` 依赖，两条仓库外前置未解除。根 workspace 全绿
  守护 job `install-gate` 同期接入（`55f6d3c`）。
- **launchd 自启形态的辅助功能授权未闭环**（P4 §36.3）：同路径二进制终端子进程可 attach，launchd 拉起报
  `GP_E_AX_UNAVAILABLE`（TCC 随责任进程归属）。用户动作面收敛为"仅勾选"，恢复由 `--restore-launchd` 承担。

## P5 — 方向候选四连批（2026-09-18）

### Added

- [P5 v5.0 规格](specs/GlassPane_P5_实施规格_v5.0_方向候选四连批.md)（`aa88f71`）：新系列首版，四批连发；收口
  `bd217a6` 记验收表 P5-A/B/C/D/E 全部 ✓，用例 engine 284 / mcp-shell 65 / kernel 47。
- 批一审批签名链（`123ef85`）：`ApprovalGate` 哈希链 + 持久化 + EngineCore 登记 + CLI 审计/校验；批二恢复快照
  tier-1 基建（`0f5c452`）：`SnapshotProbeInfo` + `RestorePipeline` 计划/校验/防篡改。
- 批三保留策略按天数/项目维度（`6ef8f11`）、批四 CLI 维护入口（`6f17122`：`--prune-evidence` / `--evidence-stats` / `--older-than` / `--project` / `--dry-run`）。

### Fixed

- `approvalGate` 注入缺口（`ff4f1d6`）：daemon 构造未挂默认路径审批台账，与 P5 §3.4 不一致。

## P3 — 三方消费者一致性与两次形态评估（2026-09-17 … 2026-09-18）

### Added

- [P3 v3.0 规格](specs/GlassPane_P3_实施规格_v3.0_三方消费者一致性.md)（`bbfe12b`）：C28/C35 三点回环与失败三分类
  归因（基于 v2.1 逐字继承，仅追加 §21–23）。落地为 `DecisionLogEntry` Swift Codable（`aa80c6f`，+11 用例）与 mcp-shell 以 kernel fixtures 为真值的三层回环契约测试（`aeb84d9`，+9 用例）。

### Notes

- 两次形态评估均以"维持现状 + 显式守卫条件"收口，不开启实现批次：v3.1 复审 Swift 手写 MCP 消息层 → 维持 TS 壳
  （`0169d81`），v3.2 复审 LLDB 桥形态 → 维持 Python SB API、C++ plugin 不自动激活（`e886d8f`）。两版均写有
  "触发重估条件"以防关闭即永冻。

## P2 — 并发归因污染防护与渐进退化检测（2026-09-17）

### Added

- 批一 C33（`4352ff2`）：`InputEventSource` + `AttributionGuard`——操作权互斥、输入空闲检测、污染标注
  （`EngineP2Batch1Tests`）。批二 T9 渐进退化检测（`da1d06e`）：三信号联合判定、熔断升级、诊断归类。

### Notes

- 判定逻辑为无 AX 依赖的合成单测，本批只交付单测面：
  [P2 v2.0 §16.2](specs/GlassPane_P2_实施规格_v2.0_并发归因污染防护.md) 的真机冒烟口径当时留为"待人工/待授权"，
  直到 2026-09-19 的 P4 §34.5 与 §36（daemon 注入 guard）才收口。

## P1 — SCK 迁移、快照恢复、GUI 面板与 evidence 生命周期（2026-09-16 … 2026-09-17）

### Added

- ScreenCaptureKit 像素捕获迁移 + 屏幕录制权限 onboarding（`eeabcd5`，P1 v1.0），替换 P0 已弃用的
  `CGWindowListCreateImage` 通道；路径 B 回退为 macOS 13 `SCStream` 单帧捕获桥（`a7e82ad`）。
- 快照/恢复原语 + 性能型熔断（`ab61a91`，P1 v1.1）：工具面六工具 → 八工具（`gp_snapshot`/`gp_restore`）。
  GUI 设置面板（`6126a61`，P1 v1.2）：权限 onboarding 可视化；evidence 审查 UX（`ed7287d`，P1 v1.3）。
- 批五多项目注册表与配方管理（`3964800`，spec v1.4），验收标记随后同步为"已实现并单测通过"（`c2fd954`）；
  批六 evidence 持久化落盘（`cc795be`，P1 v1.5）与批七归档生命周期（`903bb9c`，P1 v1.6）：限量修剪、统计、清空。

### Notes

- 路径 B 只有编译保证：本机为 macOS 26，macOS 13 上的首帧真机行为未验证，风险与延后口径写在
  [P1 v1.0 §5.2](specs/GlassPane_P1_实施规格_v1.0_SCK迁移.md)。

## P0 — 规格奠基与最小闭环（2026-09-14 … 2026-09-15）

### Added

- 设计-of-record 入档：5.7 项目综述（含 5.6 存档）与 PRD v1.0（`b8527b7`）、5.8 综述 R41–R45 实施级深化与
  [P0 实施规格 v1.0](specs/GlassPane_P0_实施规格_v1.0.md)（`c576135`）。
- `@iterate/kernel` Phase A（`d542494`）：JSON Schema 真源 + zod 双绑定 + C35 双侧 roundtrip 测试。
- GlassPane Engine Core + `glasspaned` daemon + 真机冒烟流程（`0e02454`，27 文件 / 4081 行）。
- MCP stdio 壳（`fa537b4`）：手写 JSON-RPC 2.0 + 六工具 + engine 客户端；`gp_last_evidence` 返回前先以 kernel
  schema 强校验 evidence 包（`0842477`）。GitHub Actions CI 三侧 job（`5b13334`）：swift / kernel / mcp-shell。

### Fixed

- daemon 忽略 `SIGPIPE`，客户端断开不再崩溃（`815c1a1`）；`treeSnapshot` 增加总量超时预算，`observe` 不再被无响应
  应用阻塞（`0ab7e60`）。kernel `ajv` 8.17.1 → 8.20.0 修复 moderate ReDoS（`d74342e`），并同步规格里的版本钉扎
  （`ef243ed`）。

### Notes

- 从第一天起就写明降级不是失败：[P0 §9](specs/GlassPane_P0_实施规格_v1.0.md) 规定 handler/state 信号缺失时 evidence
  显式 `null` 且 T4/T5/T7/T8/T9 落 `INCONCLUSIVE`；屏幕录制拒绝时 `pixelDiff=null` + 熔断 level 1，T3 判定仍可用。
  `contaminated` 字段先存在、语义恒 false，等 P2 填充。
- **CI 从一开始就不承载真机面**：[P0 §7.3](specs/GlassPane_P0_实施规格_v1.0.md) 把 A7 真机冒烟列为人工/自建 runner
  验收步骤，[engine/smoke.md](engine/smoke.md) 开篇即写"CI 不承载本流程：AX 依赖辅助功能权限与真实 GUI 会话"。此后所有
  AX/CGEvent/LLDB attach 类验收（B7/C6/D6、C33/T9、P4-I4、P6-E、`.rebuild_survival_smoke.py`）都在开发者本机完成。
