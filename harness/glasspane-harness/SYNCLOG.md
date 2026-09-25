# SYNCLOG — glasspane-harness 与上游的同步记录

一次同步一条，倒序。每条必须给出：**改动面数字**（`fork-diff` 输出）、**跑了哪些闸、结果如何**、**没跑的部分照实写没跑**。

## 2026-09-25 · v0.3.0：macOS-only 收口 + npm 基建（dry-run 校验 / 发布即验证 / dist-tag 策略）

owner 2026-09-25："本项目是针对 macOS 的，不需要 Linux 和 Windows 适配" + "npm 包的基础设施完善一下"。

- **平台面收成 macOS-only**（决定，不是"还没做"）：`product.json` 的目标矩阵只剩
  `darwin-arm64` + `darwin-x64`（`darwin-x64-baseline` 也去掉：能跑 macOS 13 的机器全有 AVX2，
  这个目标没有用户）；wrapper 的 `os`/`cpu` 由清单驱动 → **npm 在非 macOS 上直接拒绝安装**，
  而不是给一个跑不了的二进制；`install.ps1` 删除，`install.sh` 的拒绝文案改成"这是决定，不是
  遗漏"并说明引擎/权限/证据流水线都只存在于 macOS；release lane 的两个矩阵收成
  `macos-14`/`macos-13`；README/安装文档/排障表把平台边界与 `EBADPLATFORM` 写进第一屏。
- **已在 registry 上的 10 个不该发的平台包（6 linux + 3 windows + 1 baseline）全部 `npm deprecate`
  并附理由**——版本号不可回收，弃用带说明比留个"还能装"的包诚实。逐个从 registry API 核过
  （不是只看 `npm view` 的 CDN 视图）。
- **npm 基建三件**：
  1. `publish.ts --dry-run`：打包并校验每个 artifact 的形状（bin 指向的文件真在 tarball 里、
     平台二进制存在且可执行、wrapper 的 optionalDependencies == 清单矩阵、os/cpu 与平台块一致），
     **不碰 registry**；接进 fork 的 CI，坏形状在 PR 红而不是发版后红。
  2. `verify-published.ts`：**"已发布"不等于"能用"**——把**已发布的** tarball 装进一次性前缀、
     跑 `--version`、确认那个二进制自己把内嵌 web 服务出来；作为 release lane 的最后一步；
     非 macOS 宿主上它反过来断言 npm 拒绝安装。
  3. wrapper 元数据补齐（`engines`/`funding`/`publishConfig`/`sideEffects`）+ dist-tag 策略
     （稳定 `latest`、预发布 `next`，预发布不会被 `npm i -g` 误装）。
- 策略写进 `product.json` 的 `npm` 块（发布必须带 provenance、平台包与 wrapper 同版本、
  optionalDependencies 不手写、发布后跑 verify），跟着代码走而不是记在某人脑子里。

## 2026-09-25 · v0.2.0：配套产品面回归（web 内嵌）+ README/基础设施（对齐 iterate 形态）

owner 2026-09-25："那几个配套产品面还是需要的" + "README 等基础设施模仿 iterate 生态做"。

- **产品面重新划线**（`product.json` → `product`，FORK.md 同步）：**发** CLI+TUI、**内嵌 web
  应用**（默认恢复内嵌，与上游、与 iterate 把 dashboard 烤进 wheel 一致；`--skip-embed-web-ui`
  出纯 CLI 构建；运行期 `OPENCODE_DISABLE_EMBEDDED_WEB_UI` 与降级路径未动）、仓内 `docs/`、
  随仓 SDK/plugin；**不发** console/enterprise/stats/infra（私有 harness 没有"组织与额度后台"形态）、
  Electron 桌面 app（第二批，需签名/公证账号）、**上游文档站**（`packages/web` 内容尚未私有化，
  product.json 里标 `not-yet-ours`，不把上游文案当我们的文档发）。**内嵌实测**：带内嵌构建
  `Smoke test passed: 0.2.0`，`serve --port 4399` 真的吐出内嵌 HTML 与资源（curl 验过）。
- **README 双语重写**（iterate 同款结构）：居中标题 + 语言切换 + npm 下载/动态版本/CI/License/
  macOS/Stars 徽章 + banner + 问题陈述（agent 无法诚实回答"界面动了吗"）+ 产品面表 + 安装
  （四条通道 + 实测注记：npm≥11 `allow-scripts` 警告、全局前缀不可写的补救）+ 上手 + `gp_*` 表 +
  证据四条律 + 文档索引 + 开发命令 + 许可/署名。
- **基础设施补齐**：`assets/logo.svg` + `assets/banner.svg`（SVG：品牌是可 diff 的文本，不是二进制）、
  产品 `CHANGELOG.md`（0.1.0 首发 + 0.2.0 本批）、产品 `SECURITY.md`（披露流程 + 四张 macOS
  权限表 + 依赖钉定姿态）、`docs/` 六页（index/install/tools/evidence/migrate/troubleshooting）、
  `.github/ISSUE_TEMPLATE`（bug 表单强制要 `gp_probe_status` 输出；feature 表单问"它靠哪条证据"）、
  `.github/pull_request_template.md`（把本线纪律做成勾选清单：fork-diff 同批重记、product.json
  先行、brand 闸、带反向控制的固定点、边界照实）。
- **文档链接检查扩面**：`check-doc-links.mjs` 现在覆盖产品文档（24 份 / 212 条链接）——扩完立刻抓到
  两处**写死了工具数目**（FORK.md 的 M1 行、SYNCLOG 的旧记录；连本条描述修复的句子也先被检查器
  咬了一次——它对"数目字面量"一视同仁），按本线"清单从 `hello` 读、
  不抄"的口径改成不写死数目。私有化换了门面，门面上的死链也得红。
- 版本线 0.1.0 → **0.2.0**（产品面变更走 minor，pre-1.0 语义）；发版前 `product-surface` 复核清单↔
  各脚本一致。

## 2026-09-25 · 首发：glasspane-harness v0.1.0 上 npm + split 远端仓建成（外部动作执行完毕）

用户 2026-09-25 "其他所有问题全部修掉"之后执行（此前记为"等 owner 点头"的外部动作，本机 `gh` 与
`npm` 均以 jingzhao-l 认证）：

- **split 远端仓建成**：`gh repo create jingzhao-l/glasspane-harness --public` + 推送
  `git subtree split --prefix=harness/glasspane-harness`。**先证明再推**：split 分支的 tree 哈希与
  `HEAD:harness/glasspane-harness` 逐字相等（`5efbbc1…`），6,615 文件、125.9 MB。
- **npm 首发 v0.1.0**：本地 12 目标构建 `BUILD_RC=0`（含每个当前平台目标的冒烟 `--version`）→
  `script/publish.ts` 发布 **12 个平台包 + wrapper**（`glasspane-harness` 与
  `glasspane-harness-<os>-<arch>[-baseline][-musl]`），`PUBLISH_RC=0`。
- **两条安装通道端到端实测**（这是"一键下载"真正成立的那一步）：
  - `npm install -g --prefix ~/.local glasspane-harness` → `glasspane-harness --version` = **0.1.0**，
    `gp-harness --version` = **0.1.0**；
  - `bun add -g glasspane-harness` 同理（本机解析较慢，属环境）。
  实测到并已写进 `scripts/install.sh` 与 README 的两件事：npm ≥ 11 对首次见到的包打印
  `allow-scripts` 警告（安装仍成功；安装器在第一次没产出可用命令时用 `--allow-scripts` 重试），
  以及全局前缀不可写（EACCES）时给出确切补救 `npm install -g --prefix "$HOME/.local"`。
- **split 仓的 CI 第一次红，抓出两个真缺陷**（详见下面两条 fix 提交）：import 漏了 7 个上游文件
  （`fork-diff` 盲区：四桶比的是工作树 vs 参照 index，"在磁盘上但从未提交"的文件看起来逐字相同），
  以及**编译产物启动即崩**（vendored kernel 的 barrel 在模块初始化时用 `createRequire` 读
  `../schemas/*.json`，单文件二进制里没有这个路径——源码模式永远看不见，是 build 自己的冒烟测试抓到的）。
- **新仓的 dependabot 关掉了**（`.github/dependabot.yml` 写成 `updates: []` + 理由）：这个仓钉在
  `v1.18.32`，而"与钉点的分叉面是**实测**的"正是本线的纪律；一条自动 bump PR 可以让本仓 CI 全绿
  （固定点不测第三方字节）却让已记录的分叉面失效。依赖移动仍按老路进来：参照克隆、每周 probe、一次
  有意的同步。
- **split 仓 CI 全绿**（干净 runner 上：install + 四个发布包 typecheck + 66 条固定点 + product.json
  冒烟），`conclusion: success`。GitHub release 资产 lane（release.yml 的 5 个原生目标）在本机记录时
  仍在排队等 runner——npm 是主通道且已实测，资产是兜底通道。
- **13 条残留的上游全量测试失败**（`cli/run`、`mcp-add`、`help-snapshots` 等子进程类）：串行 + CA 束 +
  120s 超时后从 51 降到 13，隔离跑单条全过、整文件跑被 30s 预算杀掉（`Error: Timed out`，子进程无输出），
  而 CLI 冷启动实测只要 1.5s（源码）/0.64s（编译产物）——是上游测试写死的时序预算与本机负载/全环境
  隔离子进程之间的张力，不是产品缺陷；stash 对照（M5 基点）证明这 13 条与本线无关。挂账口径改为
  "上游时序敏感用例在本机不可靠"，不再假装能修。

## 2026-09-25 · 私有化批次 D：项目目录改名（`.glasspane-harness`）+ 全量测试真因

- **项目级 `.opencode/` 改名**（C/C′ 批记为"下一批开工项"，本批做完）：9 处——v1 `config/paths.ts` 与
  v2 `core/config.ts` 两套解析器、v1 `config.ts:445` 目录名过滤器与 `config/tui.ts` 扫描过滤器、
  四个写路径（`plugin/install.ts`、`cli/cmd/agent.ts`、`session/session.ts` 的 plans、
  `plugin/tui/runtime.ts` 的 themes/tui.json）、plans 权限两条并列放行（产品路径 + 遗留路径）、
  v1/v2 两份 customize 提示词（C′ 已做）。**"同层共存谁赢"是实测的**：用 remeda 实跑
  `mergeDeep(target, source)` 确认"**后者覆盖前者**"，所以解析器目标顺序写成
  `[".opencode", ".glasspane-harness"]`（遗留在前、产品在后）——反过来会让遗留目录静默压过
  产品自己的配置，而这类失败编译与其它测试都看不见。
- 新增固定点 `test/config/project-config-dirs.test.ts`（6 条 = 3 行为 + 3 结构）：只有遗留目录被
  找到、只有产品目录被找到、**同层两者时产品目录排在后面**（配合实测的合并方向）；三处目录名过滤器
  接受产品名（v2 与 TUI 扫描的过滤器在需要整套配置图的服务层里，结构钉住并在注释里写明这条边界）。
  **反向控制已验**：把目标顺序写反 → 同层用例变红 → 还原转绿。
- **`51 条全量测试失败的真因查清**（此前按"上游旧账"挂着账）：
  1. **头号根因是本机 TLS 拦截，不是代码**：测试运行期要从 GitHub 下载 ripgrep，Bun 不信任拦截证书
     （与 A 批 build 的 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 同一个坑）。带上钥匙串 CA 束
     （`NODE_EXTRA_CA_CERTS=/var/tmp/glasspane-harness/ca-bundle.pem`）后 `tool/grep`/`tool/glob`/
     acp 全绿；
  2. 剩下的子进程类（`cli/run`、`cli/serve`、`mcp-add`、`help-snapshots`、`httpapi-file`、
     `tui/thread`）**隔离跑全过**（单条 10.6s），批量并行时撞的是 30s 默认超时——不是缺陷，是本机
     负载下的超时；串行 + `--timeout 120000` 的复跑结果附在本条末尾。
  教训：**"全量红"先分环境类与代码类再谈修**。上一轮把 51 条整包当"上游旧账"挂着，其中一半当场可解。
- 账：fork-diff 6528/6678 identical、47 edited、46 added、57 deleted；面 B 2,326 行 9.49%；
  固定点 60/60 + 新 6 条 = **66/66**；brand 0 命中（血缘 18,652）；product-surface 86/86；tsgo 0 错。
- **外部动作已解锁**（本机 `gh` 与 `npm` 均以 jingzhao-l 认证；`glasspane-harness` 在 npm 上未被占、
  远端仓尚不存在）：split 子树仓 + 首发 npm 的执行结果见下一条。

## 2026-09-25 · 私有化批次 C′：项目目录配置面的两处低风险补齐

- `cli/cmd/mcp.ts` 的项目目录配置候选：`.glasspane-harness/glasspane-harness.json(c)` 排前，
  `.opencode/opencode.json(c)` 保留为遗留候选（与批次 A 的全局配置同名策略一致）。
- `skill/index.ts` 的 customize 技能提示词：改为教产品自己的配置面（glasspane-harness.json(c)、
  `.glasspane-harness/`、`~/.config/glasspane-harness/`），上游名以 legacy 形式并列；技能 id 与正文
  保持上游（血缘）。顺带把血缘计数从 18,652 降到 **18,649**（提示词里三处 opencode 被产品名替掉）。
- **刻意没做的**（保持 C 批的挂账，理由升级为技术性的）：项目级 `.opencode/` **目录**本身
  （agents/commands/plugins 的项目内落点，20 处解析点）仍不改名。读完解析链才清楚这不是"加个
  候选名"那么简单：v1 `ConfigPaths.directories()` 的下游 `config.ts:445` 用
  `dir.endsWith(".opencode")` 过滤目录，合并方向是 `mergeConfig(result, source)`（后者覆盖前者），
  v2 `core/config.ts` 另有一套 `up()` + basename 过滤 + `toReversed()` 的并行解析——"两者同层
  共存时谁赢"必须先有固定点钉死，否则改名的失败模式是**用户的项目配置被静默忽略**，而这正是本线
  SYNCLOG 反复吃过亏的那类"看起来是进展、实际静默破坏"。现状照实计入血缘基线（18,649），是
  下一批的开工项而非遗漏。
- 门禁：tsgo 0 错；固定点 60/60；brand-surface 0 命中（血缘 18,649）；product-surface 86/86；
  fork-diff 6538/6677、37 edited；面 B 2,279 行 9.31%；E8 复跑全绿。

## 2026-09-25 · 私有化批次 C：品牌面棘轮 + 三条剩余固定点

- `harness/tools/brand-surface.mjs` + `contracts/brand-surface.json`（首次基线：**0 命中**，
  血缘 **18,652 处 / 3,906 文件**（口径：排除 fork 自己的血缘文档——SYNCLOG/FORK/上游 AGENTS/两份 README/NOTICE——它们是"讲血缘故事的地方"，诚实的文档写作不该让代码血缘计数变红；两份 README 的**措辞**仍由行级规则管住））。口径与四条规则见工具头注释；要点：产品面 25 个文件里
  **可执行文本**零容忍（注释豁免——"我们删掉了 X"的注释是记录不是引用），两份 README 按行判定
  （每处 opencode 必须在署名行，**包路径 `packages/opencode` 也算行**），全树血缘计数只许减不许增。
  今日全仓 opencode 串最多的一处就是这条基线本身：它把 `@opencode-ai/*`、`OPENCODE_*` 这些
  **刻意保留**的血缘名变成有基线的存量，而不是没人管的增量。
- 反向因果六条全验可红：安装器装上游 npm 名 / publish 推上游 ghcr / README 叫用户跑 opencode /
  postinstall 解析上游平台包 / 用户可见字符串说 opencode / 血缘计数增长（塞一个新文件）。两条
  **校准负例**：无引号的 `opencode-ai` 与模板形式 `opencode-${platform}` 一开始只被总计数兜住、
  专属规则没咬——都收紧到"任何出现"后各自单咬。总计数兜底不能替代专属规则。**又两条校准**：① 血缘计数最初把 fork 自己的血缘文档算进去，SYNCLOG 里诚实写一句"opencode"就红——按文件排除（README 仍走行级规则）；② `upstream-npm-name` 收紧到"任何出现"后误咬 17 处刻意保留的 `@opencode-ai/*` 工作区作用域（重记基线时 17 个假命中暴露）——改为"前面不是 @ 也不属于标识符"，基线回到 0 命中。
- 三条剩余固定点（`packages/opencode/test/tool/glasspane-surface.test.ts`，57 → **60**）：
  1. **超尺寸帧在带内失败**（真 unix socket 对端吐 5 MiB 无换行 → `GP_E_PAYLOAD_TOO_LARGE` +
     可执行 remedy，不抛异常）——这是"truncate.output 对大 evidence 包"那一挂账项的**可测部分**：
     传输层上限是 4 MiB，越界时模型看到的是引擎形状的错误帧而不是炸掉的调用。
  2. **`maxDepth` 的 1–10 由 schema 强制**（此前只是描述文字：`maxDepth=100000` 会真的发出去，
     等引擎用 payload 错误把它顶回来——一次白跑的对 round，还等于给模型自己的工具调用递了把
     上下文杠杆）。改成 `NumberFromString.check(isInt).check(isBetween{1,10})`，沿用本仓既有的
     `Schema.Int.check(Schema.isBetween(...))` 写法（effect 4 beta 没有 `Schema.int`/`between`，
     第一次尝试的写法被 tsgo 抓住）。
  3. **code-mode 旗标不藏工具面**（结构型，注释里说清它的边界）：钉住 registry 里唯一可能吞掉
     builtin 的那行 `visible = filtered.filter(tool.id !== "execute" || codeModeDescription)`，
     断言没有任何可见性谓词提到 gp_，且 code-mode 目录只由 MCP 工具构成（旗标打开也不会把 gp_*
     折进 MCP-only 描述里）。
- 顺带核实并**结掉**一个旧挂账项：TUI 对 `attachments` 的渲染出口——现有 `gp_*` 工具**今天
  没有一个产出 attachment**（grep 为零），所以"没有渲染出口"目前还不是缺口；等 capture 类工具
  落地那天它才会变成真问题，已写进方案 §10 代替原来的含糊挂账。
- 门禁：固定点 **60/60**；brand-surface 0 漂移；product-surface 86/86；fork-diff / tool-surface /
  hook-liveness / kernel-vendor / surface-semantics / check-workflows(5) / check-doc-links 全绿；
  fork tsgo 0 错。E8 本批未重跑（改的是测试与仓根侧工具，运行时未动；上一批 E8 全绿）。
- **如实挂账**：① code-mode 固定点是结构性的——真跑一遍 `ToolRegistry.tools()` 需要整套服务图，
  这批没搭（注释里写明了这条边界，不是伪装成行为测试）；② 血缘计数把 `.opencode/` 项目目录
  的 20 处解析点全树未改这件事照实计入基线（改名必须带遗留回退，下一批开工项）；③ 外部动作
  （远端仓、Trusted Publisher、npm 首发）仍等 owner。

## 2026-09-25 · 私有化批次 B：一键安装器 + 产品面一致性闸

- **动机**：批次 A 改了名，但"名字"这件事散在 9 个地方（product.json、package.json、build、
  publish、postinstall、bin shim、两个安装器、工作流），改一处忘另一处的症状**不是红测试**——
  是装出来的东西不对，或者发布推到陌生人 registry。iterate 的 npm 包配 postinstall + curl|bash
  双通道；我们照形态建，但把"一致"变成机器检查。
- 新增：`scripts/install.sh`（横幅/OS 探测/npm 优先→GitHub release 资产兜底/`--version`/`--dry-run`/
  验证/`gp_*` 前提说人话：GlassPane 引擎要先装且授权辅助功能，没有它每个 gp_* 调用只会回
  `GP_E_ENGINE_UNREACHABLE`——那是引擎的话，不是安装器的）、`scripts/install.ps1`（同形态，Windows；
  并说清 Windows 上 harness 是跑在 macOS 宿主对面的客户端）；`harness/tools/product-surface.mjs`。
- `product-surface.mjs`：**86 条一致性断言、无基线**（它量的不是数字而是"该不该一样"，所以没有
  `--record`——规则错了改规则，没有金样可盖）。覆盖：manifest 名称/版本/bins ↔ product.json、
  平台包模板与 12 个目标名唯一、build 读清单且写产品二进制名与 user-agent、publish 以产品名发
  wrapper 且有 `--wrapper-only`、**产品面可执行文本里不许再出现上游 registry**（ghcr.io/anomalyco /
  anomalyco/homebrew-tap / aur.archlinux.org / opencode.ai/install / "opencode-ai"）、postinstall 与
  bin shim 的平台包/二进制名、install/upgrade/uninstall 的包名、状态根常量、配置发现**产品名优先且
  遗留名仍在**、两个安装器的 URL/形态（`sh -n` 过语法，`--dry-run` 真跑并断言计划里有产品名）、
  fork 工作流恰好是 ci+release 两个且 release 有 tag/手动双闸、NOTICE 记着上游 tag 与 MIT。
- 接入：`.github/workflows/ci.yml` 的 tool-surface lane 加一步；`package.json` 加
  `contracts:product`；`harness/README.md` 目录表/尺子/怎么跑/金样数字同步（顺手把上一轮遗留的
  旧分叉数字 6630/2/33 与面 B 1,867 更成实测值）。
- 反向因果五条全验可红：① product.json 版本改成 9.9.9 → `manifest-version` 点名；② publish.ts
  代码里塞回 `ghcr.io/anomalyco/opencode` → `no-upstream-registries` 点名；③ 安装器 REPO 指向别人仓
  → `installer-urls` 两条点名；④ 多放回一个 publish.yml → `workflows` 点名；⑤ 配置发现删掉
  `opencode.json(c)` 遗留回退 → `config-names` 点名；还原后转绿。
- **两条校准负例也是这批最值钱的产出**：① 第一版 URL 规则被注释里的仓库名喂饱（`install.sh` 的
  仓库名只出现在 header 注释里，规则却过了）——改为只看可执行文本（注释里的"我们删掉了 X"是记录，
  不是引用）；② state-root/config 两条断言一度被分段插入落在 `process.exit` 之后成了死代码，闸一直
  绿——是计数从 83 跳到 86 时才发现。**"闸是绿的"必须连计数一起看**，这条已写进尺子说明。
- 门禁：product-surface 绿（86/86）；check-workflows 5 个工作流绿；check-doc-links 绿；fork tsgo
  0 错；固定点 57/57 未受本批影响（安装器与闸都在仓根侧，不进 fork 运行时）。
- **如实挂账**：① 整套安装流程（真 `npm install -g`、真下载 release 资产）**未端到端跑过**——
  因为 npm 上还没有 `glasspane-harness` 这个包、远端仓还不存在（外部动作，owner 点头才做）；本地
  能验的（语法、dry-run 计划、URL 与清单一致）都验了。② Windows 侧只做了形态对照，没在 Windows
  机器上跑过（ps1 无法在本机执行）。③ Trusted Publisher 仍待 owner 配置。

## 2026-09-25 · 私有化批次 A：产品身份（glasspane-harness）与发布流水线

- **动机**：上一批把 M1–M5 收口了，但产品还叫 opencode——npm 包、二进制、安装脚本、
  状态根、配置文件、TUI 主题全是上游的名字，一个 GlassPane 的私有产品"装出来是 opencode"
  说不过去。参照 iterate 生态的做法（`iterate-harness` = openharness 的私有化 fork：改发行面、
  保留内部血缘名、自建发布），本批做**产品身份**。
- 改动面（`fork-diff`）：**`6539/6675 byte-identical, 36 edited, 43 added, 57 deleted`**
  （上一批 `6628 / 4 edited / 37 added / 0 deleted`）。`deleted` 57 件逐类：上游 26 个工作流、
  20 份 locale README、`STATS.md`、`CODEOWNERS`/`TEAM_MEMBERS`/`pull_request_template`/
  `ISSUE_TEMPLATE`/`publish-python-sdk.yml`——它们要么会往 anomalyco 的基础设施推（docker
  ghcr、AUR、homebrew tap、`opencode.ai/install` 自升级），要么是上游的营销与协作流程。
  `added`：`product.json`（产品清单）、`NOTICE`、`bin/glasspane-harness`（原 `bin/opencode` 改名）、
  自建 `ci.yml` + `release.yml`。
- 改了哪些产品面：包名/bins/平台包模板/版本线（`0.1.0`，独立产品线，**不参与主仓 1.1.1 版本线**——
  `check-version.mjs` 复跑仍绿）、user agent、mDNS 名、状态根（`global.ts` 一个常量带全部 XDG
  路径）、配置文件名（`glasspane-harness.json(c)` 优先 + 上游名遗留回退）、TUI 默认主题（读时迁移旧
  id）、basic auth 默认用户名、install/upgrade/uninstall/serve/tui/run/attach/pr/providers/web/debug
  的用户可见文案、README 双语重写。细节与"刻意保留的血缘名"清单见 `FORK.md`『产品身份与私有化』。
- **删掉的三处"会替别人干活"的路径**（都不是品牌问题，是安全问题）：`publish.ts` 尾块推 docker
  ghcr/AUR/anomalyco homebrew tap；`installation` 的 curl 自升级会 fetch 并执行
  `opencode.ai/install`；`packages/web` 的 console 部署基建（`infra/`）随产品不发布。
- Web UI 嵌入从默认改为 `--embed-web-ui` 显式开启（产品面只发 CLI+TUI；假设与代价写在
  `FORK.md` 与 `product.json` 的 `product.note`）。
- 门禁：`fork-diff --check` 全量绿（6539/6675）；`tool-surface --check` 绿（面 B 1,867 → **2,098
  行 = 8.64%**，仍 <10%，增量是本批的注释与清单读取）；`hook-liveness --check` 在线 20 钩子无漂移；
  `kernel-vendor` 绿；`surface-semantics` 绿；`check-workflows` 绿（**已扩到扫 fork 自己的两个工作
  流**：脚本路径按各自仓根解析，split 之后子树就是仓根）；`check-version` 绿（主仓版本线未受影响）；
  `check-doc-links` 绿；fork `tsgo --noEmit`：core/opencode/tui **0 错**（过程中抓到 3 个真错：被替换
  掉的 `upgradeCurl` 残留旧函数体导致 `response` 未定义 + 返回类型不匹配、`publish.ts` 的
  `avx2?: false` 与 JSON 导入的 `boolean` 不兼容——全部按错改完转绿）；glasspane 固定点 **57/57**；
  **E8 复跑全绿**（改名后宿主仍能起、钩子仍被派发、注入块仍到 mock provider）。
- **如实挂账**：① npm Trusted Publisher（每个包一条、staged-only）与远端仓 `jingzhao-l/glasspane-harness`
  是外部动作，未执行——`release.yml` 写好了等 owner 点头；② musl/baseline 目标在 `product.json`
  里有声明但 CI 还没有 lane（release.yml 只跑 5 个原生目标）；③ 项目级 `.opencode/` 目录（agents/
  commands/plugins 的项目内落点，20 处解析点）**本批没改名**——改名必须带遗留回退才安全，属于下一
  批的显式开工项，不是遗漏；④ 整包 `bun run build` 未重跑（改名后的产物要等发布 lane 首跑才验；
  E8 与门禁都从源码起服务）；⑤ 上一批挂账的 51 条上游全量测试失败依旧（与本批无关，已对照证明）。
- 本批引入的两道新闸（`product-surface.mjs` / `brand-surface.mjs`）与一键安装器在**下一批**；
  上一条"假设"（产品面只发 CLI+TUI）在下一批的固定点与文档里再钉一次。

## 2026-09-25 · M4 + M1 补齐 + §9-6：五薄模块收口

- 改动面（`fork-diff`）：**`6628/6669 byte-identical, 4 edited, 37 added, 0 deleted`**（M5 批是 `6628 / 4 edited / 33 added`）。`added` +4：`src/plugin/glasspane-compaction.ts`（M4）、`test/plugin/glasspane-compaction.test.ts`（M4 固定点 16 条）、`test/tool/glasspane-surface.test.ts`（M1 固定点 6 条）、`script/glasspane-e8-compaction.ts`（E8 探针）。`edited` 名单不变（`plugin/index.ts` 再 +1 import、+1 数组项，含 3 行注释）。
- **M4 的落点**：内部插件 `src/plugin/glasspane-compaction.ts`，绑 `experimental.session.compacting`（零 patch，触发点 `session/compaction.ts:374`）：
  - 上游只给 `{sessionID}`，所以用 `client.session.messages` 拉会话（方案 §5 M4 行点名的要求）。**"判当前轮属哪个维度"的那半没有做，也没有假装做**：本 pin 的内核导出面里没有 `dimensionContext`（实测），维度系统按综述 §8.5 Phase A 首发范围属 iterate 侧节奏。M4 交付能诚实交付的形态——把引擎/内核**已写下**的证据锚点（opID、outcome、台账序号与哈希）转录进 `output.context`；会话用过 `gp_*` 但决策为 0 条时，缺席以 `calls vs decisions recorded` 的**算术**呈现，不静默。
  - 只转录不判定：锚点字段全部来自 `metadata.result`（引擎写下）与 `metadata.decisionLog`（内核台账票据）；没有阈值、没有 pass/fail 合成——守住自己的边界靠的正是本批那条 §9-6 闸。
  - 上游是 `nextPrompt = compacting.prompt ?? [默认提示, ...compacting.context]`：别人的 `prompt` 一旦被替换，`context` 就是死信。所以两条路都走（`prompt` 已定义 → 追加在它之后；否则进 `context`），且绝不替换别人的提示词。边界照实写在代码注释里：若别的插件在我们**之后**替换 prompt，写进 context 的块仍会被 `??` 丢掉——本 fork 今天没有第二个人碰这个钩子（已 grep）。
  - 失败可见：拉消息失败不抛进宿主的压缩路径，而是把 `anchors NOT preserved` 追加进同一处（缺席必须说得出）。
- **E8 运行时（M4 的决定性证据，不花钱不联网）**：`script/glasspane-e8-compaction.ts`——mock OpenAI-compatible provider（`@ai-sdk/openai-compatible` 在这个 build 里是 **bundled** provider，零安装零凭据）+ 从本树源码起 `serve` + 真实会话（mock 发一次 `gp_probe_status` 工具调用、宿主真执行落成 completed part）+ `POST /session/:id/summarize` 触发真压缩。判定写在 **provider 边界**：mock 记录每个请求体，断言的是"做摘要的那个模型请求带着注入块"、块里 `gp_* calls: 1 · decisions recorded: 0`（缺席被说出来）、且**压缩前的轮次没有泄漏该块**。实测全绿，连跑复现。
  - 顺带把 M2 的一条挂账结了：同一会话里 `tool.execute.after` 的 note 落进了 part metadata（`skipped: gp call did not succeed (GP_E_ENGINE_UNREACHABLE)`）——宿主**确实走到** M2 的 hook（此前只有静态派发点证据）。真会话里 `logged` 分支的写入仍需一次证据成包的真轮次（E7 已用引擎自己写的档案字节验过写入本身）。
- **M1 固定点补齐**（§7.5 纪律要求 M1–M5 各自有行为不变量，此前 M1 只有运行时证据）：`test/tool/glasspane-surface.test.ts` 6 条——id 裸 `gp_` 前缀/唯一/描述与 parser 齐、remedy 必进 `output`（E6 量过模型只读 output）、未宣布能力的方法给可执行 remedy、真死 socket 仍回 `{code,message,remedy}`。为此导出 `present()`/`unavailable()`（同 M5 导出 `glasspaneRow` 的理由：测不出来的规矩不是规矩）。
- **本批修掉一个自己的运行时缺陷（因果已验）**：`daemon.ts` 的 `rawRequest` 原来 `net.createConnection(target)` 先连接、监听器后挂。缺失 socket 的 `error` 可能**在监听器挂上之前**发出，无监听器的 `'error'` 被抛成未捕获异常 → Promise reject，而契约是"永远 resolve 一个可读的 `DaemonReply`"。实测（`bun test` 下，同一条死 socket）：一次 run 回 `GP_E_ENGINE_UNREACHABLE`，一次直接 reject ENOENT，一次 2s 后走 `GP_E_ENGINE_TIMEOUT`。改为 `new net.Socket()` → 先挂全部监听器 → 最后 `socket.connect(target)`，之后连跑 5 次全绿。（真宿主里此前没炸——E8 跑出的是正常的 `GP_E_ENGINE_UNREACHABLE`——但"没炸"只是没赶上那个窗口。）
- **§9-6 开工项落地**：新尺子 `harness/tools/surface-semantics.mjs` + 金样 `harness/contracts/surface-semantics.json`（棘轮式），进 `ci.yml` 的 `tool-surface` job 与根 `package.json` 的 `contracts:semantics`。三条规则：阈值比较（小数对照）、pass/fail 三元/相等合成（**按主语判**：`x.status !== "failed"` 是台账记账，`ok ? "pass" : "fail"` 才是判定）、证据字段比较（`!== undefined` 在场检查豁免——缺席要说得出）。**基线实测 0 命中 / 15 个文件**：两个工具面今天都不判证据语义。**反向因果三条**（都点名红、还原转绿）：`mcp-shell/src/tools.ts` 加 `ratio > 0.95` → threshold 红；`glasspane-decision-log.ts` 加 `ok ? "pass" : "fail"` → verdict 红；`mcp-shell/src/evidence-report.ts` 加 `pack.signals.pixelDiff >= 0.5` → 两条规则同红。无金样 → exit 2 并指名 `--record`。
  - 校准过程照实记：第一版规则把本仓 `status: "failed"`（写台账自己的状态）与 `pixelDiff !== undefined`（在场检查）判成命中，基线一度 6 命中——**先校准规则再记基线**，否则金样记的是规则的噪声而不是事实。
- **顺手修掉 CI 里一处自伤**：`tool-surface` job 的 `kernel-vendor` step 曾被复制成两份（同 name 同 run，同一次跨 base 合并事故的残留）。`check-workflows.mjs` 查的是 job 键与脚本引用，查不出"合法但重复的 step"，所以一直没人发现；已去重。
- 占比账（`tool-surface`）：engine 18,335 / 面 A 3,859（16.03%）/ **面 B 1,867 行 = 7.76%**（M5 批是 1,251 / 5.34%）。测试排除 5 文件 952 行、vendored 排除 10 文件 1,150 行，两项照旧打印并进金样。
- 门禁复跑：`fork-diff --check` 全量（含参照克隆）绿；`tool-surface --check` 绿；`hook-liveness --check` 在线绿（20 钩子无漂移）、`--offline` 绿；`kernel-vendor --check` 绿；`surface-semantics --check` 绿；`check-workflows` 绿（3 个工作流）；fork `tsgo --noEmit` **0 错**；glasspane 固定点 **57/57**（M1 6 + M2/M3 35 + M4 16）；E8 全绿。
- **如实挂账（没跑/仍未验）**：
  - opencode 包**全量** `bun test`：3659 tests / **51 fail**。经 `git stash -u` 对照证明这 51 条在 M5 基点**一模一样**（跑同样 16 个文件，失败名集合逐条相同：ONLY-in-mine 0、ONLY-in-baseline 0）——全在上游面（CLI 子进程 `run/serve/acp/mcp add`、`tool.grep`/`glob`/`skill`、`tui thread`、`httpapi-file`、help 快照），本批无关，但也没人修，如实挂账。
  - tui 包全量 `bun test`：195 pass / 5 fail，全在上游 `DiffViewerFileTree` 与 hunk 导航（`packages/tui` 本批零改动，`git diff --name-only` 可证）；M5 的 `inline-tool-wrap` 与 `glasspaneRow` 23 条全绿。

## 2026-09-25 · M5：会话流内 evidence 渲染（TUI patch + 口径修复）

- 动机（提交 `5f3a494`）：`gp_*` 的引擎失败是一次 `status=completed` 的工具调用，`ok:false` 只在 metadata 里——`GenericTool` 把 `GP_E_NO_EVIDENCE` 这类**引擎拒绝**渲染得和真实结果一模一样。会话流分不出"引擎给了答案"还是"引擎给不出答案"，M5 让两者在会话流里视觉可分。
- 改动面（`fork-diff`，该提交金样）：**`6628 identical / 4 edited / 33 added / 0 deleted`**；`edited` 从 2 涨到 4：`packages/tui/src/routes/session/index.tsx`（+193）与其上游测试 `inline-tool-wrap-snapshot.test.tsx`（+82），两者的**双侧内容哈希**都进金样。
- 内容：`toolDisplay` 加 `gp_` 前缀分支（前瞻兼容未来方法，呼应 M1"从 `hello` 读能力、不抄死名单"）；导出纯函数 `glasspaneRow`（method 感知的安全转写，只转写引擎已下结论的字段；成功行**中性**——不渲染绿色 PASS，因为"证据是否证明 UI 生效"是 kernel 的裁决不是 TUI 的）；`GlassPaneTool` 组件接 `InlineToolRow` + 权限高亮 + 点击展开 remedy。
- 测试 +6（gp_ 路由、成功转写、引擎失败带 remedy、call-error vs denied、`last_evidence` 字段逐字、未知方法不臆造形状）：**23 全绿**，8 个既有 snapshot 未动。
- **守卫自身修复（M5 暴露的）**：`tool-surface` 的 `isTest` 排除原本只在 `added` 循环、`edited` 循环没有——此前没有 edited 文件是测试所以从未触发，M5 让测试文件进了 edited 桶，其 +82 行漏计进面 B，而报告还在打印 "tests excluded"。按口径对称性修复（edited 测试同 added 测试一样排除；面 B 1,251 / 5.34%——两种算法下都 <10%，不是为转绿而改数）。反向因果已验：非测试 edited 文件 +5 行变红，edited 测试 +5 行不计入。
- 门禁（当时）：fork `tsgo --noEmit`、23 测试、hook-liveness、kernel-vendor、check-workflows 全绿。
- **未跑/未验**：真 TUI 会话里这条渲染路径的观感未观测（组件级由测试钉住）；`packages/{app,session-ui,desktop}` 会不会取代 TUI 仍挂账（方案 §10）。

  - 真模型轮次依旧没跑：`ctx.ask` 权限卡观感、`truncate.output` 对大 evidence 包的真截断、M4 在真模型下的压缩质量、真 TUI 会话里 M5 渲染的观感。
  - 整包 `bun run build` 未重跑（产物仍是 M1 条那次的；E8 与门禁都从源码起服务，不需要产物）。


## 2026-09-25 · M2+M3：内核以 vendored 形态进 fork，决策审计链开始生产

- 改动面（`fork-diff`）：**`6630/6665 byte-identical, 2 edited, 33 added, 0 deleted`**（上一批是 `6631/6637, 1 edited, 5 added`）。
  - `edited` 从 1 涨到 2：`tool/registry.ts`（M1）+ **`src/plugin/index.ts`**（M2 的内部插件注册，2 个 hunk：import + 数组末尾一项）。
  - `added` 从 5 涨到 33：我们自己的 5 个源/脚本文件 + 2 个测试文件 + **23 个 vendored 内核文件**（`packages/opencode/vendor/kernel/{src,schemas,fixtures}`）。
- 占比账（`tool-surface`）：engine 18,335 / 面 A 3,859（16.60%）/ **面 B 1,058 行 = 4.55%**。两项排除都被显式打印并计入金样：**vendored 依赖 10 个代码文件 1,150 行**（由溯源清单排除，不算我们写的）与**测试 2 个文件 467 行**（面 A 的口径本来就是 `src/`，把 B 的测试算进去就是拿两个不同的量比大小）。
- **M3 的形态**（订正后）：`@iterate/kernel` 不进 npm，也不跨仓相对引用，而是 **vendored 源 + 溯源钉**：
  - 新尺子 `harness/tools/kernel-vendor.mjs` + 金样 `harness/contracts/kernel-vendor.json`（canonical repo/path/branch/ref/version + 每个文件的 sha256）。`--record` **只在对齐时写**：本批真出过一次 canonical 已经前进（15df8d5）而镜像没跟上，`--record` 直接拒绝（"not byte-identical to canonical … fix the copy or the edit, do not record it"）——它拒绝给分叉盖合法章。
  - `--check` 无克隆也能跑（CI 形态）。六条控制：清树绿；改一个 vendored 源文件 → 点名哈希变更 exit 1；删一个 → exit 1；塞进一个清单没声明的文件 → exit 1 且说"fork 长出了自己的内核文件"；`KERNEL_SRC` 在场时跨读 canonical，镜像落后 → **STALE exit 1**；还原全绿。
  - 为什么放在 `packages/opencode/vendor/kernel` 而不是顶层 `packages/kernel`：**zod 解析不到**。bun 的依赖在 `packages/*/node_modules`，顶层新目录没有 node_modules，`import "zod"` 直接 `Cannot find package`；而给它加 package.json 就要重跑整棵 fork 的 `bun install`（10 分钟起，还会再撞一次 ghostty-web 的 TLS）。放进 opencode 包内 → 用包自己的 zod，零安装。控制实验就是这个报错本身。
  - **同一份源码跑在两个 zod 大版本上**（canonical 钉 3.25.76，fork catalog 是 4.1.8）。`tsgo --noEmit` 立刻抓到一处前向不兼容：`z.record(z.unknown())` 在 zod 4 里键类型必填（TS2554）。修在内核（两参写法 3/4 都合法，canonical 90/90 仍绿），不修在 fork。**这条耦合从此是量出来的**：fork 侧固定点测试里断言 `zod` 主版本为 4，且 strict/absent-vs-null/未知键拒绝这些**跨大版本最容易漂**的行为逐条测。
- **M2 的落点**：`src/plugin/glasspane-decision-log.ts` 作为**内部插件**（`internalPlugins` 末尾一项；`OPENCODE_DISABLE_DEFAULT_PLUGINS` 是上游自己的关闭开关，不再另造私有开关）。绑 `tool.execute.after`：
  - 只转录，不判定——outcome/summary 来自内核的 `decisionOutcomeFromEvidence`/`decisionSummaryFromEvidence`，那两个函数只读引擎已经写下的字段；**判定仍在 Swift**，铁律没动。
  - 不猜哪些方法有包：没有 `evidencePack` 就是 `skipped`，**不维护方法名清单**（方法表这两个星期从 11 长到 13，抄死的清单必过期）。
  - 台账写不进 `~/.glasspane`：`resolveLedger` 直接拒（`GLASSPANE_SOCKET` 也会参与定位状态根），因为那是引擎的地盘——`projects.json` 双写已经付过一次学费（B-1/A-15 同一缺陷两个副本）。
  - 写失败**进 `output`**（`decision log NOT written: … remedy: …`），只在尾部追加、绝不替换模型看到的结论；成功时 `output` 一字节都不动（有断言钉住）。
- **运行时证据（E7，`script/glasspane-e7-ledger.ts`，不进 CI）**：连真 daemon（`hello`/`probe_status`），用**引擎自己写到 `~/.glasspane/evidence/` 的档案字节**驱动 hook → 链条两条、`0600`、跳过路径、损坏尾部拒绝并点名 line 3、档案未被写入。**顺带量出一个 daemon 缺陷**：`gp_last_evidence` 无论带不带 `operationId` 都回 `GP_E_NO_EVIDENCE`，而磁盘上有 **582 个档案**（539 个 `0.1-draft` + 43 个 `0.1`；最新那条 `pixelDiff.bounds` 是 `null`，内核读侧完全接受）。也就是说 daemon 的回放路径与它的写入端不在同一处——E7 把它打成 `NOTE FINDING` 而不是悄悄绕开。engine/派发链是别的会话的地盘，本批不改，只留可复现脚本。
- **本批自己抓出来的四个错**（每个都补了控制，不是口头认错）：
  1. `tools/sync-kernel.sh` 参数化时把守卫① 的干跑写成 `rsync -n --delete`（丢了 `-a`），rsync 报错但**退出码被 awk 吃掉** → 守卫① 变成永久"无删除"。现在 enumerate 的失败会被显式判定为"枚举不出来＝拒绝"。
  2. `tool-surface --record` 会在**归因失败**时照样写金样（那次写下 surface B = 0 LOC 的假基线）。现在 record 前先看归因，拒写并说明"要给一个从没量过的数定基线，等于把无声漂移重新发明一遍"。
  3. 测试排除式 `/(^|\/test\/)/` 里那个 `^` 匹配空串 → **每个文件都被当成测试**，面 B 一度只剩 14 行。除法式子换成 `/(^|\/)test\//`，并加了一条兜底：若有文件该算而我们却一个没算，红着说"排除规则错了，不是面为空"。
  4. 回滚用 `git checkout` + `git clean -fdq`，而 fork 镜像是**未跟踪**的：一次 `bun: command not found`（环境缺件，不是代码坏）被判成红闸，回滚把 23 个 vendored 文件**直接删了**。现在运行前做快照、回滚从快照恢复、绝不 `git clean` 自己创建的路径；控制实验：`BUN=/usr/bin/false` 强制红闸 → 镜像 23 个文件、内容签名、溯源清单三项全 PASS。
- 环境如实记：这台机器的 **bun 不见了**（今天早些时候还用它构建过），按 fork 的 `packageManager: bun@1.3.14` 重装了 1.3.14（安装脚本往 `~/.zshrc` 追加了 PATH 一行）。`bun test` **必须从 `packages/opencode` 里跑**——仓库根有个故意的 `do-not-run-tests-from-root` 挡路；而且要用包脚本的 `--timeout 30000`，否则 `test/preload.ts` 的 afterAll（dispose + 删临时目录）会被 5 秒默认超时打断成"无名失败"。
- 门禁复跑：fork `bun test` **35/35**、`tsgo --noEmit` **0 错**；仓内 build OK、kernel **90/90**、mcp-shell 176/176、installer 70/70、版本线 OK、doc-links OK、check-workflows OK、hook-liveness `--offline` OK、kernel-vendor OK、tool-surface OK、fork-diff 在线/离线双向 OK。
- **未跑/未验证**：`bun run build` 整包未随本批重跑（`dist/` 还是 M1 那次）；**真模型轮次仍然没做**，所以"宿主在 `tool.execute.after` 之后真的会调到这个 hook"这条只有静态证据（`session/tools.ts:121-129`）+ 内部插件确实被装载（serve 起来无报错、`gp_*` 工具都在注册表里）+ hook 函数本体的端到端（E7）；M4/M5 未动。

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
