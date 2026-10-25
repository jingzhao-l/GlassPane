# Changelog

All notable changes to **glasspane-harness** (the product) are recorded here. The
per-batch measurements of the *fork* live in `SYNCLOG.md`; upstream opencode's own
changelog is not this file's subject.

The format follows [Keep a Changelog](https://keepachangelog.com/); the product uses
semantic versioning starting at `0.1.0` (pre-1.0: the surface may still move, the evidence
contract does not).

## [Unreleased]

### Added — 场景②：计划交接落到生产路径上，压缩开始按维度决定丢谁

- `readRunPlan(env, projectDirectory)` 有了第二个生产者。此前 fork 只认
  `GLASSPANE_RUN_PLAN`，而全仓实测唯一设过它的地方是 operator 命令
  `check_run_plan_channel.py`——本插件自己的注释就写着"as shipped, the production path reaches
  this with no plan"。现在没有显式交接时读**本工程自己的** `.iterate/run-plan.json`（即
  iterate-harness `write_run_plan` 的落点），目录取插件实例的 `input.directory`，不是
  `process.cwd()`：一个 harness 进程可以同时开好几个项目的 session，从 cwd 猜会拿别的项目的计划
  给本项目记账。`RunPlanRef.source` 记下来路（`env` / `project`）。这不是"默认计划"：文件不在
  仍算未计划，覆盖率那行继续沉默；engine state root 里的候选一律不读；读不通/不合 schema 各自
  具名拒绝，且 remedy 不再让人去 unset 一个他们从没设过的变量。
- `selectAnchors`：超过 `MAX_ANCHORS` 时的丢弃不再永远是"最近 N 条"。按内核 `dimensionContext`
  自己的账分三档——本 run 从没声明过的维度历史先丢（就是 §8.5 row 2 的"优先压缩无关维度历史"）、
  无声明维度的锚点其次、计划内的最后；档内按新旧。块里**写出用的是哪条规则**：按计划排的情况下
  再说"showing the most recent"就是假话。没有计划或计划读不通→退回纯按新旧，与改版前一致。
- `collectEvidenceAnchors` 多了一个被打印出来的数：`declaredWithoutAnchor`——声明了审查维度、却没
  进到任何锚点的调用条数。这条不对称此前只有本模块的头注知道（引擎只在一个方法上出 `evidencePack`，
  所以 `gp_act/gp_observe/gp_attach/gp_diagnose` 上声明的维度进不了锚点），注释不能在引擎加宽时变红，
  数可以。块里只在真丢了东西时打印那一行，且它是"带声明的那部分"而不是全部无锚点调用——两者不同，
  混为一谈会让每个 status-only 调用都谎报成丢了一个维度。
- 未动的：内核仍是唯一算账的地方（本模块不自行声明维度词表、不判证据语义），`MAX_ANCHORS` 从
  `const` 改为 `export const` 以便测试引用同一个数而不是抄一个。

判据与实测在 `SYNCLOG.md` 的 2026-10-25 那一条。分支 `gp-bidi-20261024`，**未取号、未发版、未推
主干**——版本线与发布归在飞的那条每日线。

## [0.10.5] - 2026-10-24

判据：patch（发布闸自己的一条缺陷。`release-artifact` 那条"发布物 == 主干"的等式与前四版同一条；
本版搬的是 `packages/opencode/script/` 里的字节）。

### Fixed — 发布闸此前问的是元数据，而安装要的是 tarball

- v0.10.4 的 `install the published bytes and run them` 连红两次，而 Release 与 npm 三包都是好的。
  读数摆在那里：wrapper 的元数据在 21 s 后可读，这道闸就宣布"可以装"，随后 npm 死在
  `404 … /glasspane-harness-darwin-arm64-0.10.4.tgz`。npm 写元数据与写 tarball 走的是不同的路，
  CDN 上那份 tarball 比元数据晚了大约十五分钟——第三次 attempt 通过，不是因为它修好了什么，
  而是因为这段时间过去了。
- 一次"问对了对象"的就绪判断现在长这样：元数据认识这个版本 → 元数据指向哪个 tarball → 那个 URL
  真的被服务。任一环回答"还没有"就继续等；不是 404 的失败（5xx、代理、DNS）**不算答案**，仍然走
  `not-observed`（exit 2），因为"发布坏了"与"这台机器问不成"是两句话。
- 等的清单从**发布出去的 wrapper 自己的** `optionalDependencies` 读回来，而不是拿 `product.json`
  再算一遍：要被服务的是安装器被告知的东西，不是这棵树自认为声明过的东西。读不回清单、或清单是
  空的，一律 exit 2 拒装——空清单不是"没有要等的东西"。
- 预算改成一整套共享（wrapper + 每个平台包共用那 20 分钟），因为每包各等 20 分钟会把这条 lane 拖到
  runner 超时，而超时的失败连判决都不留（同 `release-artifact` 那条停滞上限的理由）。
- 判据与因果：`test/script/registry-readiness.test.ts` 11 → 19 条（注入时钟与 fetch，没有一条靠真等）。
  三次变异各自具名变红，恢复按 sha256 核回——把 tarball 那几行删掉（=改前行为）⇒ 4 条红，而
  "tarball 已被服务"那条**照绿**（证明那 4 条不是同一条红的四种化装）；把 404 当成已服务 ⇒ 具名红两条；
  把 5xx 洗成"还没有" ⇒ 具名红一条。
## [0.10.4] - 2026-10-24

判据：patch（`release-artifact` 那条"发布物 == 主干"的等式要求这一号——本轮动的是依赖字节，
不是主干上的一段账；理由与 0.10.1–0.10.3 同一条等式）。

### Changed — zod 4.1.8 → 4.6.7，内核追到 `iterate-kernel@0.1.10`

- **为什么必须走这一版**：`GHSA-mrhx-c7xc-m3w5`（zod 校验超限集合时耗尽内存，**high**）的官方修复
  只在 **4.6.6**，3.x 线不 backport，而本 workspace 的 catalog 钉的 4.1.8 就在脆弱区间 `< 4.6.6` 内。
  取的 4.6.7 发布于 2026-10-12（本机读数 12 天），是 `minimum-release-age: 3 天` 那条闸允许的最新的号。
- **内核跟着走同一条线**：`kernel-pin.mjs --record` 的重钉读数里**只有四行动**——version、lockKey、
  integrity、recordedAt；随包 **26 份契约文件的 sha256 一字未变**。两份发布物（0.1.9 / 0.1.10）逐目录
  对比给出同一答案：`schemas/` 与 `fixtures/` 完全相同，只有 `dist/*.d.ts` 里 strict object 的
  TypeScript 发射从 `"strict", z.ZodTypeAny, …` 变成 `z.core.$strict`，以及那一份刻意的运行时修复
  （错误路径里出现符号时按 description 渲染，因为 `String(symbol)` 会抛）。换的是发光形状，不是判决。
- **读数**（本机，逐步取退出码）：`bun install --frozen-lockfile` 与两份 manifest 一致；
  四个包 typecheck 全 0 错（`packages/opencode`、`packages/tui`、`packages/sdk/js`、`packages/plugin`）；
  9 个固定点文件、TUI 渲染快照、
  `publish.ts --dry-run`、`kernel-pin --check`、`kernel-conformance` 全绿。
  父仓那侧 `mcp-shell` 跟着走同一条线：620/620 通过，`check-kernel-corpus` 报
  `26 corpus file(s) match the pin (iterate-kernel@0.1.10)`，两条腿（本机装的、面 A 捆的）同号。

### 本版没盖住的（照实写）

- 第三方自己的两份 zod 仍在脆弱区间：`@modelcontextprotocol/sdk` 解析到 4.4.3，
  `gitlab-ai-provider` 钉死 3.25.76。它们不是本 workspace catalog 那一份，也不是我们 import 的那一份
  （三条根扫描 + realpath 去重后，活链接只有 4.6.7）。把它们也抬到 4.6.7 需要 `overrides`——那是替
  别人决定它没声明过的运行时形状，本轮不做，记在这里。
- fork 的全量 `bun test` 里 6 个文件共 82 条具名失败（provider 16 / plugin.install 15 / session.prompt 36 /
  project 8 / transform 4 / httpapi-provider 3）。同一组文件在**改前那棵树**（zod 4.1.8 + 内核 0.1.9）
  与**改后这棵树**上逐文件同数、pass 数也同数，所以不是本轮带进来的；但 CI 只跑 9 个固定点文件，
  这一族失败在 CI 里没有任何东西看得见——"套件写了而 lane 不跑"那条事故的同一种形状，留给下一轮。

## [0.10.3] - 2026-10-24

判据：patch（`release-artifact` 那条"发布物 == 主干"的等式要求这一号，理由与前两版同一条）。

### Fixed — 产品发出去的字节里那条 critical 覆盖

- **`dompurify` 3.4.16 → 3.4.17**（`packages/ui`、`packages/session-ui` 的依赖，也就是发布物里那个
  embedded web app 的代码路径）。逐条把真版本号代入 GHSA 的 vulnerable range 算出覆盖 3.4.16 的是三条：
  GHSA-cg2g-xh64-v4q7 **critical**（`>= 3.4.4, <= 3.4.16`）、GHSA-mrv2-3pqr-j5jr **high**（`<= 3.4.16`）、
  GHSA-c6gr-qvv4-5v3f low（`<= 3.4.16`）。
- **顺带拆掉 catalog 里的那颗雷**：`workspaces.catalog.dompurify` 钉的是 3.3.1，同样落在 `<= 3.4.16` 内。
  它当下没有任何引用方（两个引用方都写死版本），但下一个写 `"dompurify": "catalog:"` 的包会静默拿到
  一条高危副本——与本轮 MCP SDK 那件事同一族形状：问题不在声明，而在声明与解析之间那条没人看的路。
  三个位点因此一起改到 3.4.17，而不是只改 dependabot 提到的两个。
- 取 3.4.17 是这条 workspace 的 `minimum-release-age: 3 天` 闸允许的号（发布于 2026-10-12，11.5 天），
  不是"最新"。

验证判据落在"图里与装上的都过线"，不是"manifest 改了"：`bun.lock` 只解析 `dompurify@3.4.17`，
两个 workspace 的 `node_modules/dompurify` 链接都指向 3.4.17，`--frozen-lockfile` 回 "no changes"。
过程中被自己的断言挡下一次误判：`node_modules/.bun` 里还留着一条 `dompurify@3.4.16`——bun 不回收
store；分清"产品加载得到的"（看链接）与"缓存里残留的"之后确认是孤儿并清掉，判据也改成看链接。
`ui` 与 `session-ui` 的 typecheck、各自测试、以及 web app 的 `bun run build` 全部 rc 0；
`patched-deps --check` 仍 18/19；`product-surface` / `tool-surface` / `check-workflows` 绿。

## [0.10.2] - 2026-10-23

判据：patch。四项 patch 判据（状态文件字段、退出码集合、CLI 参数、npm `bin` 声明）逐条未动，
用户读得到的形状没变。取号的理由与 0.10.1 同一条：`release-artifact` 要求发布物 == 主干，而本轮
主干落了新字节。

### Added — 发布 lane 开始问产物本身的字节

0.10.1 那笔把"主干这棵树的安装产物带没带 fork 补丁"变成了持续量，但那条闸看不见发布本身：
构建作业在它自己的 runner 上装它自己的 `node_modules`。本版把同一个问题问到 **registry 交付的字节**上：

- `script/patched-deps.mjs` 多两个模式：`--items --package <name>`（把"该问什么"从声明的补丁文件现推出来，
  作为 JSON 交给消费者，判据因此只有一份实现）、`--artifact <file> --package <name>`（拿这份清单去问一个
  文件的字节）。0/1/2 三码：0 全在、1 逐条点名缺哪一项并说明"bundle 是从未打补丁的源建的"、
  2 问不成（文件读不到 / 包没声明 / 清单为空）。
- `verify-published.ts` 在装好发布包之后以命令方式调用它，读 `realpath` 解析出的那份已安装二进制。
  用命令而不是 import：`tsgo` 对越界 `.mjs` 的类型不站得住，而且这样测的正是发布 lane 实际走的路径。
- 判据窄到只有**字符串字面量与新增方法名**两类，是三次误报筛出来的：新增的每一行会要求 `.d.ts`
  的内容（运行时 bundle 里没有这些字节）；引入的每个标识符会要求打包器改名的局部绑定
  （`isSessionRetry` / `requestSessionId` / `expiredSessionId`）与补丁只是调用的上游符号
  （`isJSONRPCErrorResponse` / `determineScope`）；再加上调用名会要求被打包器抹掉的模块说明符
  （`'../types.js'`）。留下的两类改名等于改行为，在已发布的 0.10.1 二进制（sha256 与 GitHub 为该
  资产计算的 `digest` 逐字相等）上 **8/8 命中**。
- 本仓 19 条声明里 **18 条产不出可查项**，只有 MCP SDK 那条有 8 项。所以 lane 点名问一个包而不是
  扫全部声明：扫的话 18 条都走"问不出问题"那条分支，绿得与什么都没测一样。空清单必须拒答，
  这条分支用真声明 `effect` 测。

### Fixed — 两处自己的坏形状

- 上一版的 `--check` 对 payload 读两遍（一次判决、一次报告读了多少字节），发布时那是 145 MB × 2。
- 上一版留了一个**空的**目标文件白名单（"某些平台可能不带这个文件"），全树没有任何用例能走到它；
  删掉，缺失目标一律红——未应用的补丁最常见的长相就是"文件不见了"。
- `isMain` 判定按书写路径比：macOS 的 `tmpdir()` 给 `/var/folders/…`，Node 解析模块 URL 得到
  `/private/var/folders/…`，于是被复制到临时目录里跑的那份脚本以为自己是被 import 的，
  **静默什么都不做**，23 条断言同时红。现在两侧都比 realpath。

### 覆盖

`test/script/patched-artifact.test.ts` 6 条用例 / 24 断言，已点进 fork CI 的固定点名单（8 → 9 个文件）：
名单是窄集合、带全部标记的负载过并报告读了多少字节、单条缺失具名红、空 payload 全条红、
空清单拒答、三种问不成问题的入参各回 2。`verify-published-selftest.sh` 加"带标记 / 不带标记"两条
（12 条 ok），`patched-deps-selftest.mjs` 28 条断言全绿。固定点 9 个文件 **178 pass / 0 fail /
966 expect()**；`packages/opencode` typecheck rc 0、`error TS` 计 0。
## [0.10.1] - 2026-10-23

判据：patch。四项 patch 判据（状态文件字段、退出码集合、CLI 参数、npm `bin` 声明）逐条未动，
用户读得到的形状没变——变的是这版**装到的依赖**与发布 lane 的一句话。

### Fixed — 依赖与发布 lane

- **`@modelcontextprotocol/sdk` 1.31.0 → 1.32.0，并把那 32 KB 的 fork 补丁重钉到新版本**。
  覆盖 1.31.0 的是 4 条 advisory（2 high：CVE-2026-111768 / CVE-2026-111767；2 medium），全部以
  `< 1.32.0` 收口；1.32.0 的安全侧内容是"重定向只在端点同源内跟随"。直接升级会**静默丢补丁**：
  bun 对版本对不上的 `patchedDependencies` 不报错，它把条目从锁里删掉、装一份没打补丁的产物，
  而 `package.json` 的声明还留在原地——丢的是 404 会话恢复、`isRequestActive` 取消已死请求、
  SSE 里把 JSON-RPC 错误也算作回了话，以及 `callTool` 的重载。补丁逐 hunk 重键（32→34 hunk、
  12 个文件一个没少，新增行集与删除行集与旧补丁逐字相同），因果两边各自量过：漂回旧 key 重装后
  `test/mcp/session-recovery.test.ts` 由绿转红，改回后 `package.json` 与 `bun.lock` 的 sha256
  与变异前逐字相等、该用例复绿。
- **`electron` 42.10.0 → 42.11.16**（`packages/desktop` 的 devDependency）。覆盖 42.10.0 的 7 条
  advisory（4 medium + 3 low，无 high/critical）里要求最高的一条是 `< 42.11.9`。取 42.11.16 而不是
  42.11.18，是因为本 workspace 的 `minimum-release-age: 259200` 秒实测挡住了 42.11.17/18。
  如实说覆盖边界：`packages/desktop` 不构建也不发布（`product.json` 明写它是需要签名/公证账号的第二批），
  CI 没有 lane 跑它的 typecheck，本轮补跑 `tsgo -b` ⇒ rc 0、`error TS` 计 0；新 Chromium 的运行时
  行为没有验证手段。
- **发布 lane 的成功分支现在说出它观察到了什么**：`verify-published.ts` 的 registry 就绪等待过去只在
  失败时报读数，成功只留一句 `ok npm install of the published package`，于是一条绿日志分不出
  "等过并且等到了"与"根本没问"。现在两分支同一标签，成功行带 `seen`/`attempts`/`waitedMs`/registry，
  判据是与本版号相等——registry 回读到别的版本就是红。对照 3 条加进
  `test/script/registry-readiness.test.ts`（该文件在 fork 的 fixed-point 名单里）。

### Added — 一条新的尺子（父仓侧）

- `script/patched-deps.mjs`（本仓）+ `harness/tools/patched-deps-selftest.mjs`（父仓）：每条
  `patchedDependencies` 声明都按三方核对——key 的版本、`bun.lock` 是否还带着这个 key、补丁新增的行
  是否逐行出现在安装产物里。11 组夹具 / 28 条具名断言，其中两条是**反过度反应**的用例（不在图里的
  声明、被覆盖版本旁边的未覆盖版本，都必须绿且只打 `△`）。本仓读数 18/19 逐行核过。

## [0.10.0] - 2026-10-21

判据：minor。两条用户读得到的形状变了：`gp_diagnose` 的回包多了归属键
`provider{id, version, method, requires}`（面 A 与 fork 两扇门都从内核的 provider 注册契约取它），
而 provider 契约第一次有了**产品侧**消费者——此前两侧只有尺子（`kernel-conformance` 与
`diff_kernel_implementations`）读它。四项 patch 判据（状态文件字段、退出码集合、CLI 参数、
npm `bin` 声明）逐条未动。

### Added — 场景⑤：判定生产者按内核契约注册

- fork 的 `tool/glasspane/providers.ts` 注册 `glasspane-engine-ae`（diagnose / diagnose-pixel /
  diagnose-probed，requires 用证据包自己的信号词）与 `glasspane-evidence`（capture / last-evidence）；
  面 A 的 `mcp-shell/src/providers.ts` 经 `requireMethod` 把未声明的方法挡在帧发出之前。每条注册都过
  内核的 parse/register，本仓不重述任何 pattern 或长度；version 取产品自己的运行版本，夹具里的
  `1.11.0` 在产品里一个字节都不出现——抄它等于替产品认证一条产品没测过的主张。
- 两扇门的归属句由一条既有对账钉住逐字相同。新增的两个测试文件（provider 注册 20 条、registry
  就绪 8 条）**点进了 fork 的 fixed-point 名单**——不点进去就是住在没人跑的目录里：断言写了而 CI
  从不执行，这种绿是假的。

### Fixed — 发布 lane 不再把读副本延迟当坏发布

`install the published bytes and run them` 在 0.9.1 那次 publish 被接受后 96 秒就跑去
`npm install`，npm 回 `ETARGET … No matching version found`：具名 FAIL 的是这条 lane，发布物本身
是好的（那版今天装得上，registry 的 `dist.shasum` 与 CI 当时打印的 tarball shasum 逐字相同）。
现在先等 registry 读得到这个版本再装：`script/registry-readiness.ts` 把等待做成可注入时钟的纯函数，
三种结局分开——就绪 / 预算用完走 exit 2 的 NOT OBSERVED / 问不成（transport 失败）绝不当成就绪；
`absent` 与 `unaskable` 的分法沿用本文件既有的 `npmAnswer`（读 registry 自己的错误文本，因为 npm
退出码对两者相同）。`--prefix` 那条路不碰 registry，所以既有的三结局负向对照形状不变。

## [0.9.1] - 2026-10-20

判据：patch。四项用户可见判据逐条实测未动——状态文件字段、退出码集合、CLI 参数、npm `bin`
声明。本版带走的是内核的**声明**：`iterate-kernel@0.1.9` 把 `zod` 从范围收成精确版本，
于是 `mcp-shell` 上游那两处 npm `overrides`（在下游钉住整棵树的 zod，绕开的正是内核自己的
声明与它发出去的 `.d.ts` 不同号）删掉了。判决一字未动：0.1.9 的语料字节与 0.1.8 相同，
`kernel-conformance` 的 16 份摘要逐字复算一致。

### Changed — 内核追到 `iterate-kernel@0.1.9`（那一份声明把它发出去的 `.d.ts` 说清楚了）

- **依赖再升 `iterate-kernel@0.1.9`**。0.1.9 不改任何判决：它把 `zod` 从 `">=3.25.76 <5"` 收成
  `"3.25.76"`，因为发布物里的 `.d.ts` 是按 3.25.76 发光的（`ZodObject<Shape,"strict",z.ZodTypeAny,Out,In>`）。
  声明允许 zod 4 而声明文件说的是 zod 3，消费者的解析器一旦挑了 4，拿到的不是类型错误而是**类型消失**
  （`z.infer` 静默变 `any`，TS7006 去抱怨消费者自己的回调）。GlassPane 这条线上一批刚在下游用
  npm `overrides` 钉住整棵树绕过它——上游修好之后那两处 override 都已删除，实测依赖树只剩一份
  zod@3.25.76（`iterate-kernel` deduped 到它），`mcp-shell` 独立安装与根 workspace 两条路各自
  `npm ci` + 全测：**510/510**。
- `kernel-pin --record` 26 份（版本、lock integrity、逐文件 sha256）、`kernel-conformance --record`
  16 份。判决一条都没动——0.1.9 的语料字节与 0.1.8 相同，摘要逐字复算一致；`harness/README.md`
  里那句"今天以 registry 依赖 `iterate-kernel@0.1.x`"是可复算主张，由 `check-doc-links` 拿 pin
  反算，本批把它追平（这条红是闸抓的，不是人查的）。

## [0.9.0] - 2026-10-19

判据：**minor**。pre-1.0 语义下"产品面/CLI 形状变动 = minor"，这一版改的每一条都是用户读得到或
做得到东西，不是纯内部修复：TUI 首页文案、CLI 收尾语与 `--help` 分支、安装/兜底通道印出的包名与
安装 URL、运行时不再抓模型目录、决策台账默认路径（**需要用户动手搬一次**，见下）。另外本版的
发布 lane 与六把尺子的判据面都变了形，装的人与读文档的人看到的承诺随之改变。取号说明：上一轮
（2026-10-18）把 `v0.8.3` 这个号留给主人、故意让 `artifact` 那格红；本轮按同一口径取号，但改动
形状 ⇒ 走 minor，`0.8.3` 作废不取。

### Changed — 产品面

- **模型目录改为树上的 pin**：`contracts/models-catalog.json`（232 个 provider）进版本控制，
  `packages/opencode/script/generate.ts` 默认读它，文件缺失**构建失败**并按名指出刷新命令，绝不
  悄悄回落去抓网络。此前每次发布把 `models.dev` 当时的响应体贴进签名产物——tag 决定不了发布物字节。
- **运行时不再抓目录**：`packages/core/src/models-dev.ts` 的默认主机不再是 `models.opencode.ai`；
  不设 `OPENCODE_MODELS_URL` 就一次都不请求。那半份"禁用抓取"本来是假的：`populate` 吃
  `OPENCODE_DISABLE_MODELS_FETCH`，`refresh()` 与后台 60 分钟轮询不吃——现在三处都吃。抓回的正文
  先验形状再落缓存（缓存比内嵌快照先读，一次坏写入会长期遮蔽快照）。
  这条改的是安全形状：目录里一个字符串字段会被交给 `npm install` + `await import()` 执行，
  执行环境持有整个 `gp_*` 无障碍面。
- **TUI 首页删掉两条 tips**：`docker run -it --rm ghcr.io/anomalyco/opencode` 与 OpenCode Zen 引导。
  它们教每个安装去拉上游的容器镜像与上游的付费模型服务；本产品的规矩是分发面不许出现别人的基础设施，
  而管这条的闸当时只读 7 个手抄文件，从没打开过那个文件。
- **`uninstall` 收尾语**改为产品名（此前对用户说"感谢你使用 OpenCode"）。
- **`--help`/usage 那条分支**原本拿 `"opencode "` 去比，而 `.scriptName()` 早已是产品名——
  分支永远走不到，等于"是否重复打 logo"这个决定从来没发生。现在两处共用一个常量。
- **安装/兜底文案只点发得出的包**：`postinstall.mjs` 与 `bin/glasspane-harness` 不再建议
  "手动安装 `glasspane-harness-darwin-x64-baseline` / `-musl` / `linux-*` / `windows-*`"——
  这些包本产品决定不发。机器不在矩阵里时直接说不支持并列出支持集。
- **安装 URL 钉本版 tag**：`product.json → install.curl` 与两份 README、`docs/install.md`、
  `install.sh` 头部那行，全部从 `/main/` 改为 `/v0.9.0/`。安装脚本是验二进制的那个东西，钉在分支上
  等于任何能 push split 仓 main 的人都能换掉校验器。新闸 `installer-curl-pinned` 四处逐字核，
  下一版漏改一处就红。
- **决策台账默认路径去掉重复目录段**：`~/.local/share/glasspane-harness/decisions.jsonl`
  （此前实际落在 `…/glasspane-harness/glasspane-harness/decisions.jsonl`，而 `docs/troubleshooting.md`
  与 `docs/models-and-keys.md` 一直发布的是单段形式——照文档去找的人看到"No such file"）。
  **需要动手**：已有深层台账的用户请搬一次
  `mv ~/.local/share/glasspane-harness/glasspane-harness/decisions.jsonl ~/.local/share/glasspane-harness/`，
  不搬则新条目从一条空链开始（哈希链本身不跨文件续接，这是有意的：没有东西能证明续得上）。

### Fixed — 工具面与宿主之间

- 台账写失败或内核抛出**不再带走 `gp_*` 的答案**。`plugin.trigger` 不接拒绝，而
  `session/tools.ts` 是在完成 tool call **之前**触发 `tool.execute.after`：一次写不进去的台账
  （只卷、被 chmod 过的审计文件）此前会把整个 `gp_act` 判失败，而此时应用已经被点过。
- `HOME=""` 不再造出相对的 socket/状态根（`??` 不吃空串），非绝对的默认根直接拒绝——那同时
  也是引擎状态根守卫失效的方式。
- `gp_probe_status` 的模型可见描述不再复述"四个权限席位"及其名单；集合的真源是引擎的 `hello`，
  复制过来就是等着说谎。`docs/install.md` 同一处措辞一并改。
- `gp_*` 进行中的专属文案（Reading accessibility tree… 等）现在真的会显示：渲染路径先匹
  `spinner` 再把 `children` 塞进去，而 `~ {pending}` 在只有别的状态能到的分支里，那几个字符串
  此前是写了、传了、从不显示。选择在纯函数 `glasspaneRowLook().text` 里决定，那句主张第一次可测。

### 发布链与尺子（本版同时收紧，属产品承诺的一部分）

- 发布 lane 的 `version-check` 现在双向核 tag / `product.json` / `packages/opencode/package.json`，
  并新增 CI-green 前置（按 peel 后的 commit 查 `ci.yml`；缺 token、报错、无记录、非 success、
  预算耗尽一律拒绝）。`docs/release.md` 原先声称的 `check-version` 只存在于父仓，split 仓里从来没有它。
- `setup-bun` 里那条 `pip install setuptools || … || true` **删除**：按本仓真实构建路径量过，
  node-gyp@12.3.0 自带的 gyp 对 setuptools/distutils 零依赖，那一步只是往签名构建机上放一份
  不钉版本的第三方包并把失败咽掉。
- `tools/gpg-signing.sh` 的私钥与 passphrase 不再走 argv（任何本地账号 `ps -eww` 可读）；
  那条审计改为按路径同时覆盖父子两份拷贝，父份不在时大声 SKIP 而非静默通过。
- 六把尺子审出 14 处"记录写着、代码不读"或"失败分支跑不到"的缺陷并全部修掉：`brand-surface`
  的 productFiles/docFiles 无人回读、locale 命中数折成 1、`--record` 无脏树拒绝、内置 skill 规则
  的输入路径早在私有化时改名（于是它贡献 0 命中而金样记成"干净"）；`tool-surface` 的分母
  （engine）无人回读、内核出处解析失败只打一行 stderr 然后判绿；`fork-diff` 两条自回显长度比较、
  降级泳道不看"提交里有而工作树里没有"、参照侧无空集地板且不校检出干净；`hook-liveness` 读参照
  工作树而不看 git 状态（本地编辑会被判成"上游换了地板"）；`surface-semantics` 的 `--record`
  无脏树拒绝（它记的是允许面，洗进去就永远红不了）；`release-artifact` 把读不出的字节折成 0 行、
  把工具崩溃报成分歧；`product-surface` 的 selftest 语料含 YAML 注释、两处地板比实测松 27、
  `registry` 那条是 `x ?? y === y` 的自回显。
- 新闸与修复由 `harness/tools/rulers-selftest.mjs` 逐条驱动到具名红（含一条"把守卫拆掉后
  同一变异应当变绿"的因果对照），已接进父仓 `ci.yml` 的 `harness-rulers` job。
- `scripts/check-doc-links.mjs` 首次开始核尺子自己的出处指针（`limitSource` 曾指向一份
  从未存在的 specs 决策记录），并把 `docs/models-and-keys.md`、`docs/release.md`、
  `docs/kernel-integration.md` 与 `harness/README.md` 登记进死链/主张校验集合。
- `product.json` 不再描述空气：`lineageOnly` 里六条不存在的路径拆成 `deletedFromTree`，
  新闸 `declared-shape` 双向核声明与磁盘。

### 本批内核依赖（原 `[Unreleased]` 账，随本版一并落地）

- **依赖再升 `iterate-kernel@0.1.8`**（`RoundState.breakerLevel` 改成可选：缺席读作"这个跑没有
  断路器通道"，不再等同于 `0`——`0` 断言的是"有断路器且未跳闸"）。fork 自己不读 `convergence`
  规则，所以 `packages/opencode/src` 一字未动；动的是契约语料与两份记录文件。
- **红先绿后**：`kernel-conformance` 在 `--record` 之前当场红在唯一一条移动了的判决上——
  `convergence.ok-01.json` 摘要 `28f8a3d93028` → `d001e5209e55`，并点名 "behaviour moved"；其余
  15 份逐字未动。`kernel-pin --record` 重记 26 份契约档案（版本 + lock integrity + 逐文件 sha256）。
- **父仓镜像 `kernel/` 按 canonical 追平**（`tools/sync-kernel.sh --target=repo`，源
  `iterate-skill@9d6d9036`）。变的仍只有那三份收敛文件：`fixtures/convergence.ok-01.json`、
  `schemas/convergence-round-state.schema.json`、`src/convergence.ts`。镜像的 `fixtures|schemas`
  与 pin 逐文件核过（`scripts/check-kernel-corpus.mjs`：26 份同源）——Swift 的 C35 腿
  `TestSupport.swift:467` 直读 `kernel/fixtures`，镜像落后就等于引擎侧对新发布的契约全盲。
  本轮对引擎无影响，这一点是查出来的不是推断的：Swift 按名字取语料、不遍历目录，且
  `engine/Tests` 里没有一处引用 `convergence`。
- 实测：镜像 kernel 231 pass、mcp-shell 495 pass、installer 172 pass、fork 侧
  `glasspane-kernel.test.ts` 40 pass；`kernel-pin --check`、`kernel-conformance`（16 份）、
  `check-kernel-corpus` 与六把尺子全绿，面 A 9609 LOC / 面 B 8793 LOC 一字未动。
  updater 的 `scripts-assert-ci-green.test.mjs::等满预算按未验证拒绝，不是放行` 在四套并跑时红过
  一次（`pending 就该反复问，实得 1 次`——轮询次数被负载吃掉），单独复跑 14/14 绿；与内核无关，
  记在这里而不是抹掉。
- ~~本批没做完的（点名）：`mcp-shell` 仍挂在 `file:../kernel` 上~~ —— 这条是过期账，本轮删：
  `mcp-shell` 已改为发布包 `iterate-kernel` 依赖，`kernel/{src,test,package.json,…}` 那份代码镜像
  也已于 2026-10-18 退役，`tools/sync-kernel.sh` 两个 `--target` 现在都返回拒绝（判据见 SYNCLOG
  2026-10-18 与 `FORK.md` 纪律 4）。留着它，下一轮就会有人去"修"一件已经修完的事。

## [0.8.2] - 2026-10-16

判据：patch，与 0.8.1 同一口径（四条用户可见判据逐条未动：状态文件字段、退出码集合、CLI 参数、
npm `bin`；子树里变的只有版本号、`docs/release.md` 的一步程序、以及两份记录文件）。

**这一版存在的理由就是新闸自己下的一道判决**：`v0.8.1` 的 tag 切完之后，主干又收了
`docs/release.md` 的第 3b 步。`release-artifact` 的 `artifact` 规则只把
`SYNCLOG.md`/`CHANGELOG.md` 认作"发布自己的记录"而容忍 tag 落后——**程序文档不是记录，是产品
内容**，所以它必须被一版带走，而不是被那条容忍放过去。闸据此打了红并写明
"1 of the differing path(s) are not the release ledger, so no allowance applies"。

同一天连出两版 docs-only patch 是这套口径的价格，记在这里而不是回避它：出路只有三条——
① 把程序改动与台账都写在 tag 之前（下一轮的默认做法，`docs/release.md` 的 3b 教的正是这件事）；
② 像本版这样再出一版；③ 放宽那条容忍。③ 是唯一被禁止的那种，因为它就是本轮开场那个缺陷
（"发布物里没有它自己的记录"）换成尺子写成的样子。

- docs(harness): `docs/release.md` 第 **3b** 步——收口记录落进主干之后必须再切一次搬运分支并
  push，它不消耗版本号；判据是 `split-main` 任何时刻都要求 split `refs/heads/main` 逐字等于主干子树，
  而 `△ artifact` 那种容忍只覆盖两份记录文件。实测出处：0.8.0 那轮补记进了主干、没再切一次，
  于是装到用户机器上的 `v0.8.0` 归档里没有本次发布的记录。
- 无代码变更：新闸 `harness/tools/release-artifact.mjs` 与它的自测都住在**父仓**的尺子层，
  不在 fork 子树内，所以本版用户可见的字节仍只有版本号与文档。

## [0.8.1] - 2026-10-16

判据：本版**四条用户可见判据逐条实测未动**（状态文件字段、退出码集合、CLI 参数、npm `bin`），
子树里的字节变化只有版本号与 `SYNCLOG.md` ⇒ patch。它存在的理由不是"改了东西"，而是
"发布物里没有上一版自己的收口记录"——那条等式 0.8.0 只在切 tag 那一刻被量过一次。

- fix(harness): **发布物 ⊅ 主干，这次两个方向同时**（P0 机制留下的那一格）。0.8.0 加的
  `version-check` 锚切 tag 时比一次 tree 哈希，此后再没有任何尺子量过这段窗口。实测
  `main` = `96e1b27f`：主干子树 `c21d9e4b`，而 tag `v0.8.0` 与 split `main` 都是 `8620e992`，
  差一个文件 `SYNCLOG.md`（发布物缺 74 行——正是 0.8.0 那条"发布链跑完之后"的收口补记，
  于是装到用户机器上的归档里没有本次发布的实测记录）。第二个方向更危险：主干那一侧的
  `draft=false` 被 `943b2841` 吃成了 `draft=`（真相独立核过：
  `gh release view v0.7.8 --json isDraft` → `false`），也就是说**照原样重切一次就会把 split 里
  正确的字节删掉**——同一类等式、相反的去向，合并/补记时最常踩的那一侧。本版把主干的字找回来，
  再把两侧一起装进发布物。
- feat(harness): **新增 `harness/tools/release-artifact.mjs`：这条等式现在由父仓持续量，不再只在
  切 tag 那一刻量一次**。两条规则各自独立、各自能红：`split-main` 要求 split 的
  `refs/heads/main` 与主干子树**严格**相等（推一次搬运分支不消耗版本号，没有"回头再推"的正当性）；
  `artifact` 要求被 tag 的那棵树等于主干，唯一容忍的状态是"tag 还没带上本版自己的收口记录"，
  且必须以 `△` 打印出来、绝不静默放行——因为那段记录无法描述一个当时还不存在的树。容忍只此一种：
  任何非 `SYNCLOG.md`/`CHANGELOG.md` 的路径不等、或发布物**领先**主干（主干丢了字节），一律红。
  差集按 `+远端独有行 / -主干独有行` 报到行级，并单列 `⚠ RE-SPLIT RISK`：整文件缺席看得见，
  两边都在的文件里丢了哪几行看不见，`draft=false` 就是这么消失的。没有 `--record`——一把能
  把"发布物过期"记成基线的尺子不是尺子。固定点测试
  `harness/tools/release-artifact-selftest.mjs` 用 `file://` 上的真仓库（真 commit、真 annotated
  tag，peel 走生产同一条路径）跑 10 条电池，其中两条是"一条规则绿、另一条红"的形状：把它们
  合成一句"树不等"就分不清"补一版"与"先把字找回主干"这两种相反的处置。反向控制：把两处 tree
  比较阉成 `true` 的副本，在已知不等的夹具上回 exit 0（证明那些红确实是比出来的，不是恰好崩）；
  远端取不到与子树未提交都回 exit 2 且 CI 判红。两条都接进 `.github/workflows/ci.yml` 的
  `harness-rulers`（`product-surface` 的 `selftest-wired` 因此从四把变五把）。
- docs(harness): 补回被 shell 展开吃掉的两处文本——`draft=false`（0.7.8 的 `isDraft` 实测）与
  `VP_GATE`（`verify-published-selftest.sh` 里真实存在的变量名，值被吞成空）。

## [0.8.0] - 2026-10-16

判据：本轮有**三处用户可见的形状/默认变化**，不是纯修复 ⇒ minor（pre-1.0 口径）。①
`glasspane-harness upgrade --method` 不再接受 `brew` / `choco` / `scoop`——本产品在这三个渠道
没有包，过去显式给 `[target]` 还会绕过"没有可核对渠道"的拒绝，直接对陌生包管理器动手；② `curl`
兜底安装通道在 `gpg` 不在 PATH 时从"警告后继续安装"翻成**拒绝**，只留
`GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1` 一条出口（裸 macOS 本来就不带 GnuPG，那条跳过等于在
最需要它的机器上关掉溯源控制）；③ 发布泳道多了一道**能拦住发布**的活门：被 tag 的那棵树必须
逐字等于主干的 fork 子树。其余按缺陷计。

- fix(harness): **主干把发布物领回来**（P0，本轮开工第一件事）。v0.7.10 的发布树里有两笔提交
  只存在于 split 仓——`d56660e`（7 个钉死依赖升到"第一个已修补版本"之上：dompurify、electron、
  minimatch、katex、`@modelcontextprotocol/sdk` 1.29.0→1.31.0（CVE-2026-104850 / GHSA-6qxp-vccf-f47h
  OAuth 客户端凭据泄露）、`@babel/core`、`@hey-api/openapi-ts`）与 `3207508`（CODEOWNERS）——主干
  `main` 从未收到它们，于是下一笔 subtree split 会**静默撤销一次安全升版**。判据用字节：主树里那
  10 个未提交文件与 split 的 blob 逐哈希相等，唯一缺的是重生成的 `bun.lock`；补上后
  `git rev-parse HEAD:harness/glasspane-harness` == split 仓 main 的树（`896398d`），
  `bun install --frozen-lockfile` 实测过，装的版本实测是 1.31.0 / 10.2.3 / 7.29.6。
- fix(harness): **没有任何尺子量过"发布物 == 主干"**（同一 P0 的机制面）。这条等式原先只活在
  `docs/release.md` 里一句手打的 `test "$(git rev-parse …)"`，SYNCLOG 每轮记它被**人**跑过一遍。
  现在它落在 split 仓 `release.yml` 的 `version-check`（取号之后、`create-release` 公开之前），
  `create-release` 与 `binaries` 都 `needs:` 它；抓不到主干就红，红的时候打出文件级差集与出路。
  反向控制：把那个 step 删掉 → `product-surface` `[release-anchor]` 具名变红（实测 exit 1）。
- fix(harness): **升级与"打开一个项目"两条路不再让别人的配置决定字节从哪来**。
  `Installation.latest()` 的 registry 取自 `NpmConfig.registry(process.cwd())`——它吃**项目目录**
  里的 `.npmrc` 与 `npm_config_registry`；三条 `install -g` 更是连 `--registry` 都不传。于是陌生
  仓库可以既决定"最新版本是谁"又决定"全局装的是谁的包"，而那包的 `postinstall` 跑的是它的 JS。
  同样形状的第二处：`Npm.reify` 把项目 `.npmrc` 原样交给 Arborist，而本产品会往用户刚打开的项目
  里写依赖。两处都改为钉住产品自己的 registry（与 `postinstall.mjs` / `install.sh` /
  `verify-published.ts` 同一条政策）。固定点＝`test/installation/glasspane-registry-pin.test.ts`
  （观察真实 argv 与真实请求 URL，不是回显常量）+ `packages/core/test/npm.test.ts` 新增一条：
  假 registry 收零请求、且错误串里点名的是真 registry（先断言 `.npmrc` 确实被解析到，否则
  "没被咨询"可以是空转）。
- fix(harness): **写进用户项目的插件 API 版本从来不存在**（P1）。`config.ts` 用**本产品**版本号
  请求 `@opencode-ai/plugin`，而那个包按上游自己的发布编号出版——实测 npm 对 `0.7.10` 回 404、
  对 `1.18.32` 回 200；安装跑在 forked 后台、失败只留一条 warning，所以每个被发行版打开的项目
  都静悄悄地拿不到它插件文件 import 的那个 API。改为取自 `packages/plugin/package.json` 的版本，
  值由尺子对着那份文件钉住。
- fix(harness): 检测/升级面里三处**跑不到的拒绝分支**。`getBrewFormula()` 两个 return 给同一个
  字符串 ⇒ `formula.includes("/")` 恒假 ⇒ "这个 formula 来自别人的 tap"那条拒绝从未生效，代码
  照样对陌生 tap 执行 `brew upgrade`；现在真去读 `brew info --json --formula` 的 `full_name`。
  `method()` 里 `installedName` 的三元两侧相同；`--method` 的 `choices` 仍列着本产品没有包的三个
  渠道。三条都改成能真正分岔的形状。
- fix(harness): `--pure` 与 `GLASSPANE_HARNESS_*` 这批名字在工具宿主这一侧**从未生效**（P1）。
  CLI 中间件写 `GLASSPANE_HARNESS_PURE=1`，而 `runtime-flags.ts` 用 `Config.boolean("OPENCODE_PURE")`
  按字面名问 ConfigProvider，从不经过产品自己的解析点 `flag.ts::read()`；每轮会话都被注入的
  `customize-harness` skill 却在教用户导出这些名字。现在解析回到那一个点（产品名先、旧名后，
  兼容不变），`plugin/index.ts` 里那个空 `if` 也补上它本来要说的"丢掉了几个 plugin origin"。
- fix(harness): 兜底安装器不再打印**执行不了的补救命令**。两条拒绝写的是
  `GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 curl -fsSL <install.sh> | bash`——行首赋值只作用于 `curl`，
  管道里的 `bash` 永远看不到它，照抄的用户会被再拒一次。`install.sh` 与 `docs/install.md` 都改成
  真正把 override 交给读脚本那个 shell 的形式；自测也跟着反转：它过去**庆祝** `gpg` 缺席时
  `exit 0`＋"skipped (gpg not on PATH)"，现在要求拒绝、要求点名 `brew install gnupg`、要求它
  **执行自己打印的那条命令**而不是手写一个长得像的。
- fix(harness): `gpg-signing.sh audit` 在什么都没读到的时候出具健康证明。每个工作流正文都用
  `gh api … 2>/dev/null | base64 -d 2>/dev/null || true` 取，取不到就 `continue`，最后
  "一条都没读成"反而打印 `ok no silent-skip signing found`——正是它存在的目的（发现
  `if: secrets.GPG_PRIVATE_KEY != ''` 这种静默跳过）。现在逐目标记 `UNVERIFIABLE` 并非零退出，
  没读全就不许说"没问题"（同文件对 `secret_names` 早就是这么办的）。
- fix(harness): 尺子自己"只能绿"的六处（本轮逐条实测能红）：`tool-surface` 的测量集下限原本
  问的就是它自己守的那份金样（清空 `fork-diff.json` 的 `added`/`edited` ⇒ 面 B 8,275 LOC/216 文件
  → 0，`--check` 照旧绿退 0，还把面 A 从 21.66% 推到 26.63% 而 A 自己一行没动）；
  `hook-liveness` 把"读不到版本"的检出当成"没有漂移"，`--record` 会把没读过的 tag 写进金样；
  `brand-surface` 金样丢掉 `lineage` 字段后 `undefined` 比较恒不成立 ⇒ 绿，且它的命中数是
  `re.test()`+`count:1`（一个已记录文件从 1 处涨到 100 处都看不见），豁免名单还是"点名一个文件
  就豁免全部四条规则"；`product-surface` 只打印一致性条数从不比较它（发现集空了就静默变绿）、
  并且**照收 `--record`**（它没有基线）——现在拒绝未知参数退 2、把四个发现集的规模钉住；
  `contracts/engine-methods.json` 里那颗 `swiftBlob` **没有任何读者**（引擎缺席时只打一条 note
  退 0），现在它对着 `FrameCodec.swift` 的真哈希核，引擎不在就退 2 说"CANNOT OBSERVE, not agreement"。
- fix(harness): 三把写了却**没人跑**的自测（`ref-batch-selftest.mjs`、`kernel-pin-selftest.mjs`、
  `verify-published-selftest.sh` 被任何工作流与任何 package.json 脚本引用的都是零），以及两把
  "测不到就退 0"的自测（藏掉参照检出 / 缺 bun 时打印 `NOT self-tested` `SKIP` 然后退 0）。全部
  接进 `ci.yml` 的 `harness-rulers`，退出口按"能不能测量"分流；`product-surface` 新增
  `[selftest-wired]` 一条规则：自测文件若没有任何读者就红——把这件事从"记得跑"变成机制。
- fix(harness): `kernel-pin.mjs --probe` 问不到 registry 时退 0，而唯一吃它的 `harness-contract.yml`
  `kernel-drift` job 的判词就是退出码，注释还写着"anchor 不可达就失败"。现在"问不到/答空"退 2、
  "同一版本"与**真漂移**保持退 0（漂移是要人看的发现，不是 CI 红），那条 lane 把判决写进
  step summary 让漂移有读者；`probe-lane-selftest.sh` 三种结局各自可红。
- fix(harness): 发布链三处"绿得不诚实"。`build.ts` 丢掉 `Bun.build` 的返回值（编译失败不打字、
  退 0、`dist/<pkg>/bin` 是空的，只有本机那个 target 会被冒烟测抓到）；`publish.ts` 的
  `gp-pack-*` 临时目录只在成功路径清理，任何一次校验抛错就留一份；`verify-published.ts` 把
  `npm view` 的传输错误（ECONNRESET/ENOTFOUND/429 都退非零）判成"这个发布是坏的"，与它自己
  写在文件头的三态规则相反——只会喊狼的闸门，最后的下场是它的红没人理。
- fix(harness): 被 tag 过一次的发布不再能覆盖已经公开的东西。`create-release` 的"release 已存在"
  分支此前只修 `targetCommitish` 就继续，而 `binaries` 带着 `--clobber`：一条版本号于是同时挂着
  GitHub 的新字节与 npm 的旧字节，签名在重签完成前对不上。现在非 draft 且锚点不同的已发布
  release 一律拒绝，出路是往前取新号。
- fix(harness): 发布链的 `uses:` 全部钉到 40 位 SHA，并取消 `check-workflows.mjs` 对 fork 子树的
  豁免（`enforcePins: target.primary === true` ⇒ 两边都管）。这不是洁癖：被改名的 `@v4` 会跑在
  能读 `secrets.GPG_PRIVATE_KEY`、带 `id-token: write` 的 job 里——父仓自己的 `release.yml`
  把这条攻击写成了文档，却用豁免把自己家发布通道的同一形状放过去了。五个 pin 逐个对 GitHub 的
  tag ref 反查核实。反向控制：把一个 `environment: release` job 的 checkout 改回 `@v4` ⇒
  `check-workflows` 具名变红（实测 exit 1）。
- fix(harness): 主仓 npm 发布那两处 `npm publish --provenance || { … npm stage publish … }` 的
  假绿形状（E401、registry 5xx、tarball 问题都走这一支，staged 一退 0 就绿——正是 v0.7.6
  "job 绿而 registry 没有那个号"的形状），改为按失败原因分流并要求版本号真的在场；顺带把
  铸造 OIDC token 那台机器上的浮动 `npm@11` 钉成确切版本。
- security(harness): `packages/{sdk/js,plugin,ui,app,cli}` 补 `private: true`。此前挡它们的只有
  `script/publish.ts` 里那些 `exit 2` 的拒绝桩，而 `npm publish -w @opencode-ai/ui` 根本不经过桩
  ——它会直接拿上游的命名空间往公共 registry 发东西。FORK.md 里"CODEOWNERS/ISSUE_TEMPLATE 全部
  移除"那句也按树的真相反正（这两个是**改写**，且 `CODEOWNERS` 是 10-15 为对齐分支保护恢复的）。
- docs(harness): `docs/release.md` 教的 npm 派发命令少了 `--ref v<X.Y.Z>`，而发布泳道的
  `publish-gate` 对缺它的派发**恒拒绝**——照着文档敲就会撞上一条自己文档里没写的红。

## [0.7.10] - 2026-10-15

判据：本轮全部是缺陷修复与两处默认收紧（安装期验证、项目内插件信任），没有新增工具、参数、
平台目标或命令形状 ⇒ patch。**取号决定**：`0.7.9` 是上一轮（2026-10-14）在 main 上写的版本号，
但它从未离开那个提交——split 仓 `main` 仍是 `46d131e` = `v0.7.8`，远端 tag 列表里没有 `v0.7.9`，
registry 三个包 latest 都还是 `0.7.8`，`npm view glasspane-harness@0.7.9` 回 404。因此 `0.7.9`
这个号在野外并不存在，本轮不把它补发成一个"已知带缺陷"的中间版本，而是把两轮内容一起发成
`0.7.10`，让 `0.7.9` 的号作废并在 `SYNCLOG.md` 留下证据；`[0.7.9]` 条目原样保留，它描述的是
已经在这一版里的代码。

- fix(harness): 发布物的 `SHA256SUMS.txt` 或 `.asc` 缺席时，`curl` 通道不再"警告后继续安装"，
  而是拒绝；只有显式 `GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1` 才放行，且安装摘要把"是这道 override
  而非这条发布"作为未验证的原因写进状态串。判据：发布泳道对每个目标都产 manifest 与签名并在缺失时
  失败，所以缺席描述的是坏发布，不是安装器可以自行豁免的政策。固定点＝`installer-selftest.sh`
  场景 5/8/15 全部反转（改前它们断言"仍然安装、退出码 0"），改后 404→退出码 1、override→退出码 0
  且状态串点名 override。
- fix(harness): GitHub Release 现在以 **draft** 创建，`publish-release` 在 manifest 与全部签名落地后
  才取消 draft，并读回 `isDraft` 确认；此前 release 一存在就公开，`binaries` 矩阵半失败会留下一个
  "没有 manifest 也没有签名但可下载"的 live release，而安装器对它的态度是警告后安装。
- fix(harness): `checksums` 不再只信"GitHub 此刻serve 的字节"。每个 `binaries` job 把自己构建出的
  归档 sha256 作为 workflow artifact 交出，`checksums` 逐个比对：没有构建期记录的资产、与记录不一致
  的资产、记录了却不在 release 里的资产，三种都红。这把"contents: write 的人在上游与下载之间换掉资产，
  然后被本管道签名背书"这条路堵上。
- fix(harness): wrapper 发布前逐个问 registry："我即将点名的每个平台包，这个版本真的在吗"。不在就红，
  并把 `npm stage list` / `npm stage approve <id>` 写给 owner——v0.7.6 那次是 job 绿、provenance 进了
  透明日志、registry 里却没有那个版本，Intel Mac 装完没有命令。同时 `publish-platform` / `publish-wrapper`
  的 staged 分支不再以退出码 0 收场：staged 就是没发布，这条 run 必须红。
- fix(harness): `script/verify-published.ts`——把**已发布**的 tarball 装进临时前缀、跑 `--version`、
  确认那份二进制真在供内嵌 web——第一次被接进 `release.yml`（`verify-published` job，跑在 macOS 上，
  因为 macOS-only 的 `os` 字段在 Linux 上会拒绝安装，那测的不是这次发布）。`product.json` 早就写着
  "发布后跑 verify-published"，此前没有任何东西跑它。
- fix(harness): 打开一个目录不再执行那个目录里的插件。`<project>/.glasspane-harness/plugin(s)/*.ts`
  （含上游 `.opencode` 拼法）现在被"发现但拒载"，因为 import 它＝任意代码执行，而跑它的进程手里有
  `gp_*` 辅助功能面；要信任这份 checkout 请显式设 `GLASSPANE_HARNESS_TRUST_PROJECT_PLUGINS=true`，
  或像以前一样把插件写进配置的 `plugin` 列表（被点名的一直会加载）。固定点＝
  `test/config/glasspane-project-plugin-trust.test.ts`，它先证明 glob 真找得到 2 个文件，再断言默认
  全拒、信任时全放——一个找不到文件的夹具等于什么都没验。
- fix(harness): 发布脚本的三处"拿声明跟自己比"——`validateTarball` 的 name 断言比的是同一个
  package.json 里读出来的字符串；`optionalDependencies`/`os`/`cpu` 比的是本进程几行前刚写下去的内存对象；
  可执行位断言跑在 `chmod -R 755` 之后。现在身份判定抽成纯函数 `script/publish-shape.ts`（能被夹具驱动），
  全部检查读**打好的 tarball**：manifest 从 tarball 解出，模式取 `tar -tvzf` 记录的位（解包会重套本机 umask），
  期望值从磁盘上的 `product.json` 重读。补上反向那道：`dist/` 里出现不是本产品声明目标的包名＝拒发
  （此前只有"声明了没构建"这一侧有人看）。新闸第一次跑就抓到真东西：上一次的 tarball 被下一次 pack
  打了进去（mode 0、文件数 7→8），于是 pack 前先删同名旧归档，`npm publish` 也不再 glob 而是点名。
- fix(harness): `script/publish.ts` 的两处 npm 调用不点名 registry（其余每条消费路径都钉了），以及
  `npm publish ...${provenance}` 这种拼接把 bun 的引号规则变成 `"public --provenance"` 一个 argv——
  实测子进程 argv 后拆成两条字面命令，`--provenance` 这才真的成了一个 flag。registry 从此只有一个来源：
  `product.registry`（`verify-published` 原来读 `product.npm.registry`，两个字段只有一个被闸看），
  `product-surface` 新增 `registry` / `publish-registry` 三条一致断言。
- fix(harness): 上游那五个 per-package 发布脚本的拒载，在**真正会发布东西的那个仓**里第一次被行为验证：
  split 仓 `ci.yml` 逐个 `bun run` 它们并要求退出码 2（`no-foreign-publish` 那条规则住在主仓的尺子层，
  不在 split 树里；一个只扫字节的闸可以被一句注释满足，跑它不能）。
- fix(tui): 渲染层不再从引擎布尔字段铸出"passed/failed/contaminated"这些判决词，改为转写
  `assertion.passed=false` 这类"字段＋字面值"；管这件事的尺子 `surface-semantics` 此前**根本没把这个文件
  纳入口径**（金样 `hits: []` 是空表），现在纳入了，并且每条规则都带正向对照——把任一规则的 `count()`
  改成恒 0，`--check` 具名变红。
- fix(tui): `tool_details_visibility` 关掉时不再把引擎拒绝一起藏掉（拒绝是一个 `completed` 的 part，
  藏起来就等于把这个产品存在的理由做成一个开关）；`Question` 拒绝的身份标记改读宿主真正抛出的那个
  类（此前测试与实现读同一个错类，是个自我认证）。
- fix(harness): `gp_*` 的 timeout 表删掉没人读的行、补上没人给的数（`hello` 的 5 秒、`gp_probe_status`
  的 8 秒此前是调用点自带数字），并新增"这张表说的每个方法引擎真的接受"的对照——它读
  `FrameCodec.swift` 的 `EngineMethod`，且解析器认识 Swift 的 `case a, b, c` 多名一行写法（改前它只认
  单名行，于是把 `attach/observe/act/restore` 都当成不存在，是夹具形状不对导致的假红）。
- fix(harness): 决策台账/运行计划的"引擎状态根"解析与 daemon 用同一套规则（`GLASSPANE_SOCKET` 是相对
  路径时不再把当前工作目录当成引擎的根），拒绝消息同时点名"实际解析到的根"与默认根；E7 台账脚本的归档
  路径改用同一权威并守住 `readdirSync` 的失败面；E8 压缩脚本的子进程与临时目录现在在所有退出路径上都回收
  （此前崩溃路径留下一个活着的 `serve` 和一堆临时文件），requestLog 缺失变成一条具名检查而不是一个 ENOENT。
- fix(harness): 尺子层自身四处"只能绿"的位置——`tool-surface` 的脏树守卫用调用方的 CWD 跑 `git diff`
  （换目录就读错仓）、`diff` 失败/超缓冲被当成 0 行（面 B 只会少算，而那正是棘轮看不见的一侧）、
  `hook-liveness --offline` 的断言是它自己 `--record` 的重言式（金样为空也能报 OK，且从不检查本 fork
  绑定的那两个扩展点还在）、`kernel-pin` 解析 `node_modules` 的顺序与产品运行时相反（两份不一致时它不拒）。
  `kernel-conformance` 那句"corpus 数与驱动数每次比对"此前只是注释，现在真的比，并且 `--check` 与
  `--record` 两个模式都比。
- docs: `SECURITY.md` 新增"仓库自带的代码默认不执行"一节并改写发布物验证段落；`docs/install.md` 的安装期
  验证段落改成与新行为一致（含 override 的确切写法与摘要里会出现的状态串）。
- fix(harness): 上面这些改动第一次推上去以后，split 仓的两条泳道各自抓出一条我自己的缺陷，都按实测修掉：
  1. `checksums` 用 `gh release download` 不带 tag——它解析的是 "latest"，而 release 现在按新规矩是 draft
     （draft 不进 latest），于是它下的是**上一条已发布 release 的资产**，构建期锚如实地报"served 的字节不是
     这次构建的字节"。这条红是新闸自己第一次运行就生效的证据；改成显式点名 `${GITHUB_REF_NAME}`。
  2. 新的"每个方法引擎都接受"固定点测试直读父仓的 `engine/Sources/.../FrameCodec.swift`，而那个文件不随
     subtree split 进产品仓——本地绿、split CI 里两条断言全死。改为把引擎方法表**作为契约随包**
     （`contracts/engine-methods.json`，13 个方法），漂移检查留在有 Swift 的那一侧：
     `product-surface` 新增 `engine-methods` 规则，每次重解析 `EngineMethod` 枚举并拒绝任何双向漂移
     （契约缺方法 / 契约多方法都红）。对照：从契约里删掉 `restore` → `product-surface` 具名红
     （192 条一致 / 1 问题），复原后 193 / 0。缺契约时测试直接拒绝而不是跳过。

## [0.7.9] - 2026-10-14

判据：纯修复，无产品面形状变化 ⇒ patch。本轮把"能红"这件事补在了三个层次上：
**工具面对自己文档里的调用直接失败**、**错误出口把代理指去找人**、**发布链路上游命名空间**
**还能被真 publish** —— 三处都不是新缺陷，是各自闸看不见的位置。

- fix(tui): 拒绝判定从错误类本身读出，不再 grep 上游文案（改前测试喂的正是实现自己搜的那串字，
  是自我认证）；`gp_*` 呈现按家族前缀派生，写死的六个方法名不再冒充全表。
- fix(harness): `gp_observe({maxDepth:6})` / `gp_attach({pid:1234})` 不再被 `NumberFromString`
  拒掉；1-10 的界面对数字与字符串两种形态同时生效。
- fix(harness): 三处 remedy 从"报告给维护者 / 当作未验证 / 去查 client-server 对"改成可执行命令；
  其中 malformed-frame 那条走真 unix socket 断言**发出去的那一帧**，不留"删注释换绿"的口子。
- fix(harness): 压缩器不再把本文件的渲染缺陷报成"读不到会话消息"（pull 与 render 两段各自定罪）。
- fix(harness): 决策日志 `createdAt` 不再把毫秒伪造成 `.000Z`（schema 只要三位数字，任何值都行）；
  E7 实测两条相隔 4ms 的决策现在拿到两个不同时间戳，改前它们是同一个字符串。
- fix(harness): 认不出的命令不再以退出码 0 收场（与同函数六行之上、与 `run.ts` 同一失败分支一致）。
- fix(harness): `kernel-pin --check` 的 remedy 按"到底哪一侧不一致"分流，`--record` 在"装的版本 !=
  锁解析的版本"时直接拒绝 —— 此前它对四种病开同一张方子，而那张方子会建议把正确金样洗成旧产物。
- fix(harness): 尺子的覆盖面进契约（surface-semantics 比扫描集/caliber/规则 id；tool-surface 拒绝在
  脏树上 record）；两条变异各自具名红，其中一条**第一次没落地却报绿**，已按"变异须证明落地"重做。
- fix(harness): `@opencode-ai/plugin`/`-sdk`/`-cli`/`-ui` 四个 per-package 发布脚本此前是**真能 publish
  到上游命名空间**的活门；现在四处一律拒绝并指向本产品的发布泳道，`product-surface` 的规则从写死两份
  改成遍历 `packages/**/script/publish.ts`（漏一个就是静默放行）。125 → 144 条一致。
- fix(harness): `release.yml` 的 publish-platform 补 `success()` —— 此前 tag/HEAD 不一致那道闸红了它照跑；
  `gpg-signing.sh` 口令与私钥不再进 argv（`--passphrase-fd 0` / 无值 `-w` 从 stdin 读），环境级 secret
  读不到不再退回仓库级还打 `ok`；`install.sh` 的 npm 通道钉住 registry（与 wrapper postinstall 同一条
  纪律，此前 `~/.npmrc`/`npm_config_registry` 能决定装谁的字节）。
- docs(harness): `installer-selftest.sh` 进 CI lane；`ci.yml` 打包那条注释不再自称"pack every artifact"
  （该 lane 不构建，平台包在这里根本没被验过，形状验证在 release.yml 的 binaries lane）。

- **`run --share` 删除（未随 0.7.8 发布：tag 已先切）。** `product.json` 把会话共享列在
  `removedFirstParty` 里，而 `run --help` 仍把它当能力 advertised；对本地起的服务实测
  `POST /session/<id>/share` 返回 **HTTP 200 + 内嵌 web 的 HTML**（该路由不存在，被 SPA 兜底吃掉），
  于是 `sdk.session.share()` 不报错、`share.url` 取不到、什么都不打印，命令照样退 0——一个替
  已删除能力作保的入口。现在删掉该 option 与那条永不生效的 `share()`（及其在 `runtime.ts` 的
  注入位），`product-surface` 新增 `no-removed-capability-entry` 规则钉住它不许回来
  （125 条一致 / 0 条问题；把 option 加回去即具名变红，实测）。
  残留一条没做：未知 `/session/*` API 路径被内嵌 web 兜底成 200，客户端无法从状态码分辨
  "端点不存在"——那是 server 路由顺序的问题，另批处理。


## [0.7.8] - 2026-10-13

判据（pre-1.0）：**patch**。没有新增或删除命令，CLI 参数与 `gp_*` 工具面的形状一字未动，目标矩阵仍是
darwin arm64/x64；本批全是"使用可见但此前说错/不做/拦不住"的修复。取号说明：开工时实测上一版三格齐
——split 仓 `v0.7.7` = `6a1acdc`、Release 非草稿且 6 份资产带签名、registry 三个包
（wrapper + darwin-arm64 + darwin-x64）都读到 0.7.7——`0.7.8` 无人占用。版本线三处一起跟上：
`product.json`（真源）、`packages/opencode/package.json`、`bun.lock` 里包自身那条 `version`。

### Fixed — 权限面：对只读工具点"Always allow"会永久放行 `gp_act`

- 六个 `gp_*` 工具共用**同一个** permission 命名空间 `glasspane`，而五个只读工具照抄了上游的
  `always: ["*"]`。上游那么写无害，因为 `read`/`edit`/`glob` 各自占一个命名空间；在这里
  `Permission.reply` 会把 `"*"` 作为 `{permission:"glasspane", pattern:"*"}` 记进会话，
  `evaluate` 把**规则**一侧当 glob（`Wildcard.match` ⇒ `^.*$`），于是它同样命中
  `gp_act` 的 `act:<role>:<action>`，`needsAsk` 保持 false。一次对 `gp_probe_status`
  自报状态的"总是允许"之后，代理就能不打招呼地驱动真实 App——这与本文件开头第 3 条纪律、
  `gp_act` 自己的描述与 `SECURITY.md` 直接矛盾。改成每条调用只授权它自己的 pattern。
- 顺带把 `validateDimension`（与本批新增的 `validateSelector`）挪到 `ctx.ask` **之前**：
  一个由我们自己就能拒绝的请求，不该先花掉人一次回答。
- 新增 `selector.role` 的 glob 字符拒绝（`GP_E_SELECTOR`）。权限键是 `act:<role>:<action>`，
  role 里一个 `*` 或 `:` 就不是笔误而是"由模型挑选自己被哪条规则评估"。AX role 不含这些字符，
  所以合法调用不受影响。
- 证据：`test/permission/next.test.ts` 新增一条**行为**固定点——对 `observe` 答"always"之后，
  `observe` 仍免问而 `act:AXButton:press` 必须仍然排队等人；`test/tool/glasspane-surface.test.ts`
  新增两条源码级棘轮（任何 `always: ["*"]` 复现即红、guard 必须排在 ask 与 daemon 之前）。
  反向验证：把 `observe` 一处改回 `["*"]` ⇒ 具名用例红；把 `SELECTOR_FORBIDDEN` 换成永不匹配
  ⇒ 具名用例红；把测试输入自己改成 `["*"]` ⇒ 那条行为用例红（证明它不是恒真断言）。

### Fixed — TUI 把引擎量到的东西画成"不知道"

- `observe` 行恒显 `nodes=?`：`nodeCount` 在绳上是 `Int`（`EngineCore.swift:1403`），
  旧代码用只认字符串的 `stringValue` 读它，于是每一次成功的树读取都把引擎的头条测量显示成未知，
  而模型侧文案是对的——只有人类被误导。
- `attach` 行从不显 App 名：引擎发的是 `appName`（`EngineCore.swift:2160-2168`），
  旧代码找的是 `app`/`name` 两个不存在的字段，于是要么只剩 `bundleId`、要么只剩 `pid`，
  而 `gp_attach` 的描述承诺"引擎解析出的 App 名与 pid"。
- 两条各配一条用真引擎字段形状的快照用例（`nodes=207 digest=…`、`Notes · pid 4242`）。
  反向验证：把 `numberValue` 换回 `stringValue` ⇒ 具名用例红。

### Fixed — 兜底安装通道把"解析失败"当成"策略性跳过"

- 清单（`SHA256SUMS.txt`）此前只要 HTTP 200 就算取到，随后用 awk 匹配资产名；返回 HTML
  （登录页、强制门户、被重签的 TLS 链）时匹配不到任何行，旧代码把这件事分类成
  "该资产没被列进清单 ⇒ 覆盖率缺口，不是篡改"，**警告一声就装**——一个解析失败换来了完全未校验的安装。
  现在先验清单形状（每行必须 `<64 hex>  <path>`），形状不符即拒绝并说明"200 回的东西不是清单"；
  而一份**形状正确**却不含本资产的清单也改为拒绝（发布链现在保证清单资产集与
  `product.json` 的矩阵逐字相等，见下），跳过只留给真正的 404。
- `installer-selftest.sh` 的 gpg 桩此前对**任何** `--verify` 都打 GOODSIG，只按 `--import`
  区分 argv。那等于替三种错误状态作保：验的是清单而不是资产、根本没带数据文件、资产从未被下载过。
  桩现在要求 `--verify <asset>.asc <asset>` 且两个文件都真实存在、资产在供物目录里。
- 新增场景 18（200 但非清单）、19（清单里没这个资产），**71 PASS → 80 PASS / 0 FAIL**。
  反向验证：把形状检查改成恒假 ⇒ 场景 18 的具名断言红；把 install.sh 的 `--verify "$asc"
  "$file"` 改成 `--verify "$asc" "$asc"` ⇒ "GPG verified"与指纹那条一起红（此前它们红不了）。

### Fixed — 发布与供应链

- `script/postinstall.mjs` 自愈下载此前不点名 registry。npm 会读 `npm_config_registry`
  （npm 自己把 `npm_config_*` 注入 lifecycle 脚本）、环境变量、`~/.npmrc` 与项目 `.npmrc`，
  所以"取来并 chmod 0755 执行的字节来自哪个源"其实由环境决定，而那个源的 integrity 是它自己担保的。
  现在显式 `--registry`，值由 `product-surface` 钉住等于 `product.json` 的 `npm.registry`
  （断言 123 → 124 条）。
- `packages/opencode/script/build.ts` 的构建内烟测此前只要 `--version` 退 0 就打
  "Smoke test passed"。本工作树实测：不带版本 define 直接跑源码时它回答 `local`，而烟测照样绿——
  `FORK.md` 把这条输出当作"可证是从本树构建"的证据，所以它必须比对数字。现在不等即 exit 1。
- split 仓 `release.yml`：
  `${{ github.ref_name }}` 曾被直接插进签名 job 的 shell 命令（git ref 允许 `$`、反引号、`;`、`&`，
  而该 job 由任意 `v*` tag 推送触发）。改为经 `env` 传入并先校验 `v[0-9]*` 形状。
  `--passphrase` 从 argv 改成 `--passphrase-fd 0`（主仓那条线早已改过并留了实测）；每份 `.asc`
  落盘用 `[ -s ]` 断言，不再靠事后一句 `ls`。
  `checksums` 那两条"清单里每行都存在 / 目录里每个文件都被列出"是自回显——清单就是上一行
  从同一个目录 `sha256sum ./*` 生成的，永远为真；改成与 `product.json` 目标矩阵的**集合相等**，
  外加 `sha256sum --strict --check` 重读文件本身。多余资产此前会被一起校验、签名、背书，现在红。
  发布链新增 `publish-gate`：npm 两条 job 之前没有任何"这棵树就是被 tag 的那棵树"的判据，
  而 `actions/checkout` 取 dispatch 的 ref——漏 `--ref` 就把 `main` 的 HEAD 按 `product.json`
  的版本号发上 registry。现在四个具名断言（两个版本线一致、origin 上有该 tag、HEAD == tag SHA、
  dispatch ref == `refs/tags/v<ver>`）先跑，`publish-platform` 依赖它。
- `ci.yml` / `release.yml` 五处 `bun install` 一律 `--frozen-lockfile`；`bunfig.toml` 的
  `minimumReleaseAge` 只挡新解析的版本，不拒绝重解析。

### Changed — 尺子层：`fork-diff` 此前对我们自己的文件只记名字

- `added` 那 82 个条目（包括整个 `gp_*` 工具面）在金样里没有内容哈希。实测：在
  `tool/glasspane/{index,kernel}.ts` 带着 +44 行未提交改动的工作树里跑 `--check`，它照样打
  "divergence matches the recorded surface"（同期 `tool-surface` 是红的）。这把尺子的立身之语是
  "已在名单里的文件又长几行也咬"，而那句话此前只对 `edited` 成立。金样现在对 `added` 也逐文件钉
  `forkHash`。
- 记录与比对一律读**已提交**的树（`git ls-tree HEAD`），不再读磁盘：一个"被 tracked 又被就地改"
  的文件同时出现在两份名单里，因此既不算"磁盘上有而提交里没有"、也不算"提交里有而磁盘没有"，
  旧代码就把它的工作树字节洗成了契约。新增第三条判定（tracked-but-modified），`--record` 遇到它
  直接拒绝并给出先提交再重记的步骤；`--check` 只如实打印条数，不改判。
- 缺参照那条降级泳道此前用 `golden.counts.edited` 当期望值，而那个数字就在被删改的同一个文件里：
  同时删掉 `editedDetail` 与 `counts.edited` 就 exit 0 并宣布"0 edited file(s) hash-checked"。
  期望值改为取自金样的**名单长度**，并要求 `editedDetail`/`addedDetail` 与名单逐条等长。
- `SECURITY.md`、`NOTICE`、`ci.yml` 里"那 14 个契约文件（11 fixtures + 3 schemas）"这类句子
  本来就是错的（11+3=14，而 `kernel-pin --check` 实测 26 条 = 18 fixtures + 8 schemas）。改成
  以清单与 `--check` 的输出为准。
## [0.7.7] - 2026-10-13

判据（pre-1.0）：**patch**。没有新增命令，CLI/TUI 的形状与参数一字未动，目标矩阵仍是 darwin
arm64/x64；一处是依赖升级且新字段全部可选（旧字节不变），其余三条是使用可见的"行为被修对"
（发布验证、兜底下载、占位符那条道歉）。取号说明：开工时实测上一版三格齐——split 仓 tag
`v0.7.6` = `063e32e`、Release 非草稿带签名、registry 上 wrapper 与两个平台包的 `latest` 都是
`0.7.6`——`v0.7.7` 与 npm 的 `0.7.7` 均无人占用，按 patch 取号。版本线两处：`product.json`（真源）
与 `packages/opencode/package.json`，`bun.lock` 里那条包自身 `"version"` 一并跟上。
### Fixed — 0.1.7 re-pin、镜像语料追平，与 Swift 那条欠下的 C35 腿

- **依赖再升 `iterate-kernel@0.1.7`**（内核侧修了发布契约的一个真缺陷：`$defs.selector.role/.title`
  缺 `minLength: 1`，zod 也缺 `.min(1)`，而 daemon 拒空 role——契约对 agent 许的诺与执行它的规则
  是两个答案）。`kernel-pin --record` 得 26 份契约档案、`kernel-conformance --record` 16 份，
  `mcp-shell` 全量 435 pass（其中"daemon / 已发布 schema / 内核 zod 三处同规则"那条正是抓出这个
  缺陷的闸）。
- **根仓 `kernel/` 镜像的语料按已发布包追平**（13 份 → 26 份，逐文件 sha256 与 pin 对过）。
  这一步不是清理：Swift 的 C35 腿 `TestSupport.swift:461` 直读 `kernel/fixtures`，镜像停在
  09-28 就意味着**引擎侧对之后发布的所有契约全盲**——新写的往返用例第一次跑就是
  "文件不存在"而不是"字段丢了"，被这个陈旧咬了一口。
- **`DecisionLogEntry`（Swift 绑定）补上 0.1.6 的四个可选字段**：`kind` / `round` / `dimension`
  / `payload`，加 `validateInvariants` 的对应判据（snake_case kind、round ≥ 0、dimension 用内核
  同一套 id 规则、payload 限 8192 字符**规范形式**）。`payload` 需要任意 JSON 类型而引擎没有，
  新增 `JSONValue`：数字走 `Double` 但**整数值不带小数位**编码——链哈希盖的是规范字节，
  把 `1` 重印成 `1.0` 等于改掉每条链节的摘要。
  红灯先行有档：实现前该用例红在 `321 bytes != 713 bytes —— 扩展条目在重编码时丢了字段`
  （`JSONDecoder` 对未声明字段静默忽略，解码"成功"、重编码即丢决定）；实现后连同两条新守卫用例
  24/24 绿，`decision-log-entry.ok-01` 的旧链节字节一字未动（"缺席"编成 `null` 会全部换摘要）。
- **本批仍没做完的（点名，不含糊）**：镜像只追平了 `fixtures/`+`schemas/`，`kernel/src`、
  `kernel/test`、`kernel/package.json` 仍是 09-28 的陈旧代码，mcp-shell 也还挂在
  `"@iterate/kernel": "file:../kernel"` 上——Step 0b 的正题（镜像退役、mcp-shell 吃 npm 裸名、
  发布机器那 40+ 处）没做。`fork-diff` 金样按本批重记（两条 forkHash + observedAt）。

### Changed — 依赖 `iterate-kernel` 0.1.5 → 0.1.6（决策日志条目收下生产者词汇）

- 内核 0.1.6 把 `DecisionLogEntry` 扩了四个**可选**字段（`kind` / `round` / `dimension` /
  `payload`）并新增 `decision-log-transcribe`。对本 fork 的实际意义：场景②"recorded 半边"的
  维度归属现在可以走共享账本，而不是只活在 fork 自己的工具元数据里；场景③两侧日志有了同一
  个可对照的形状。既有链节不受影响——新字段缺席即不进规范字节，`kernel-conformance` 对
  `decision-log-entry.ok-01.json` 的摘要读数一字未动。
- 本批实测：`kernel-pin --record`（26 份契约档案、lock integrity `sha512-5B3CY7R8…`、
  registry 侧复核 0.1.6 已 live）、`kernel-conformance --record` 16 份档案（新增两份：
  扩展条目 + 转录档案，后者走 oracle+golden 双通道）；`packages/opencode` 的
  `glasspane-kernel.test.ts` 31 条全绿；`bun run typecheck` 干净；八把尺子里只有
  `fork-diff` 因我动的两个文件（`bun.lock`、`packages/opencode/package.json`）变红，
  按它自己的 remedy 在同批重记金样（金样差值只有那两条 forkHash）。面 B 因
  `script/kernel-conformance.mjs` +55 行（我本批加的转录驱动与 oracle）重记，
  `tool-surface.json` 差值逐笔可归属自己：loc 6974→7029、该文件 725→780、ratio 两项随之。
- **未随本批落地，点名留着**：Swift 侧 `DecisionLogEntry`（`engine/Sources/GlassPaneEngine/
  EvidenceModels.swift`，C35 第三条绑定腿）还没有这四个字段。它不影响产品行为（引擎不写账本，
  全仓 `Sources/` 里除定义处无人使用该类型），但 `JSONDecoder` 对未声明字段是**静默忽略**，
  所以解码仍"成功"、重编码就把这些决定丢了——而它自己的往返测试正是拿规范字节比对的。
  已写好红灯用例 `testExtendedDecisionLogRoundtripsThroughCanonicalJSON`（打在
  `decision-log-entry.ok-02.json` 上），与实现同批提交；它需要一次干净的 engine 构建，
  本批所在的隔离工作树没有 `.build`，从零编译会与本线其它测量抢磁盘，故拆到下一批做。

### Fixed — 0.7.6 端到端真跑才暴露的两处

- **`verify-published` 从不确认 wrapper 点名的平台包是否真在 registry 上。** 它验已装包的
  `os`/`cpu`/`version`、registry 的 integrity、内嵌 web，唯独没问 `optionalDependencies` 里那条
  `glasspane-harness-darwin-x64@<ver>` 存不存在——可选依赖解析不到时 npm 不报错，只是那台机器
  拿不到二进制。于是 Intel Mac 可以"安装成功、命令不存在"，而本机（arm64）这条通道全程绿灯。
  现在逐个 `npm view` 声明到的平台包版本，任一取不到即 FAIL；`optionalDependencies` 整个为空也算红。
- **兜底安装通道对半路断流既不重试也说不出出路。** 对已发布的 v0.7.6 资产实测：本机那个 TLS 拦截代理
  （响应头 `server: WattToolkit`）在 ~47 MB 的流上把它掐断，curl 退 **92**
  （`HTTP/2 stream 1 was not closed cleanly`），只落 473 KB；安装器原本只打
  `download failed: <url>`。现在带 `--retry 5 --retry-all-errors --continue-at -`（续传比重试更要紧），
  失败时报告 curl 自己的退出码与原话，并给出 `--http1.1`、"手工取回后对着 `SHA256SUMS.txt` 校"、
  "改走 npm 那条"三条出路。退出码必须是真码：`if ! curl …; then rc=$?` 读的是取反后的 0。
  `installer-selftest.sh` 新增一条以 curl 形状退出的资产场景（**71 PASS / 0 FAIL**，此前 61）。

### Fixed — 装不上时那句道歉，本来就打印不出来

- **占位符 `bin/glasspane-harness.exe` 没有 shebang，而它的补救是一条相对项目根的路径。**
  这一份文件是 npm/bun 把生命周期脚本闸掉之后，用户 PATH 上唯一还在的东西。两处都在 0.7.6 的
  端到端里实测过：
  *不经 shell 直接 execve 它的启动器拿不到任何字*——node 的 `spawnSync` 回
  `error: ENOEXEC`（stdout 是 `undefined`），bun 的 `spawnSync` 抛
  `ENOEXEC: unknown error, posix_spawn`（errno `-8`），而同一份文本加上 `#!/bin/sh` 之后两条路径
  都照常打印并退 1；`sh -c` 那类会自己回落到 `/bin/sh` 的调用才看得到这段话，所以只有人肉在终端里
  试的时候它显得没病。补救那句写的是 `cd node_modules/glasspane-harness && node postinstall.mjs`，
  可是本机那个 `bun add -g` 的包落在 `$HOME/node_modules/glasspane-harness`——全局安装没有"项目根"
  这个位置，那行字从任何别处都解析不出来。
  现在由脚本自己算位置：`$0` 是启动器实际所用的 PATH 项（sh、bash、zsh、node `spawnSync` 四条路径
  实测都给出绝对路径），顺符号链接链解到本文件再取上一层，打印的是**这一份安装**的目录。补救另给
  两条实测跑得通的命令（`bun pm trust glasspane-harness` 在 scratch 项目里 1 script ran、之后
  `--version` 回 `0.7.6`；`npm install -g --allow-scripts=…` 被 npm 11.17 在 `-g` 下接受，dry-run
  退 0），其中 `$(npm root -g)` 保持单引号交给使用者的 shell 展开——免得只有 bun 的机器上打出空路径。
  端到端复测：把新文本装进那个 bun 全局安装，从 cwd `/` 逐字执行它打印的那行，postinstall 退 0、
  `glasspane-harness --version` 回 `0.7.6`。
- **`validateTarball` 从不看 wrapper 自己 bin 条目的字节。** 平台包那支早就查可执行位，wrapper 这支
  只查"文件在不在"。现在补齐四条，且每条都被反向变异打红过：删掉 shebang ⇒
  `has no shebang` ＋ `could not be spawned …: ENOEXEC`；把补救退回相对路径 ⇒
  `prints no absolute "cd <dir> && node postinstall.mjs" remedy`；目录算少一层 ⇒
  `sends the reader to …/bin, which does not hold postinstall.mjs`；把 `chmod -R 755` 换成对该文件
  `chmod 644` ⇒ `is not executable in the tarball (mode 644)`；`exit 1` 改 `exit 0` ⇒
  `exits 0 when run`。检查是把那份文本**从无关目录 spawn 一次**再读它的输出，不是比字面。

## [0.7.6] - 2026-10-12

判据（pre-1.0）：**patch**。没有新增命令、没改 CLI/TUI 形状与参数、没动目标矩阵；使用者可见的两处是
"行为被修对"。取号说明：本批开工时 `0.7.5` 已被同日那批（第三次会话）占用，而它当时只到"已提交、
未发布"（split 无 `v0.7.5` tag、npm live 仍 `0.7.4`）——同号并发正是 `product.json` 记过的"版本号被
npm stage 烧掉"的成因，所以本批一度把内容挂在 `[Unreleased]` 让号；随后实测 `v0.7.5` 两条通道全部
落地（npm wrapper 与两个平台包均 `0.7.5`，Release 两条 run `completed / success`），通道空出，本批
按 patch 取 **0.7.6**。版本线两处：`product.json`（真源）与 `packages/opencode/package.json`，
`bun.lock` 里那条包自身 `"version"` 一并跟上（它此前停在 `0.7.3`）。

### Fixed — 断言问的并不是它标签上那个问题

- **`gp_attach` 的能力闸问的是 `"observe"`。** `requireCapability(tool, method, capability)` 收第三个
  参数，于是调用点可以写成一个与方法无关的能力名，而它确实写错了：引擎 advertise `observe` 而不
  advertise `attach` 时被放行（走到一个它没有的方法上），反过来 advertise `attach` 而不 `observe`
  时被误拒——一个说"引擎不支持"的拒绝，是对一个支持的引擎编造的指控。`hello` 的 capabilities 就是
  引擎方法表的线名（`FrameCodec.swift` 的 `EngineMethod.capabilityWireNames` ＝ 全表去掉 `hello` 与
  `shutdown`），所以第三参删除、闸按方法名自查，写错字符串从此过不了类型检查。`gp_diagnose` /
  `gp_last_evidence` 明确不加闸并写明成本理由：daemon 只服务一条连接，多一次 `hello` 是有代价的，
  而未知方法的回答本来就是引擎自己的 `{code, message, remedy}`。
  固定点测试：`test/tool/glasspane-surface.test.ts` 新增一条双向用例（只列 observe → 拒绝且点名
  "attach"；列出 attach → 放行）。
- **被权限拒绝的 `gp_*` 调用渲染成"Performing action…"。** `state: "denied"` 既不给 `complete` 也不给
  `failed`，于是 `InlineToolRow` 落到 in-flight 分支：对一次永远不会发生的调用说"还在跑"，工具名也
  一起丢了——而这正是这条面承诺过的"引擎拒绝必须读得出是拒绝"。row→props 的映射抽成导出的纯函数
  `glasspaneRowLook`（组件本身要 theme/sync provider，当不了断言面），拒绝与两种失败同样算已结束，
  图标 ⊘、warning 色、可按开看理由。固定点测试两条：映射四态四张脸 + 渲染帧，并留旧形态的反例夹具
  证明断言能红。
- **e7 台账那条恒真谓词。** `check("gp_last_evidence replays the newest archive entry", withId.ok &&
  !noId.ok ? false : true)` 在两次调用都失败时（当前 daemon 的真实形态：`GP_E_NO_EVIDENCE`）打印
  PASS——标签主张"重放成功"，谓词从不检查 `withId.ok`。拆成两条各问各的断言。
- **compaction 的维度覆盖声明与实际相反。** 头部注释写"没有计划的会话也会产出一行覆盖度"，而
  `renderDimensionCoverage` 对那种情形返回 `undefined`；更实际的是生产路径从不填字段——
  `collectEvidenceAnchors` 只转录 daemon 的帧与 M2 的回单，引擎两份 schema
  （`decision-log-entry`、`evidence-pack`）里都没有 dimension（`run-plan` 有 `dimensions`，fork 还没接）。
  所以那行覆盖度在产品里根本不出现，只有测试手工喂字段时才存在。改成按 as-shipped 写清，并加一条走
  真路径的固定点测试（真采集 → 块里没有 coverage 行、`plannedDimensions` 为 undefined），把"以后接上
  run-plan 才改这段声明"钉在测试上。
- **`hook-liveness --offline` 把"本 lane 不读上游"打印成"upstream checkout absent"。** 那是关于机器的
  断言，而并行 worktree 里那份检出通常是存在的（指回主树的符号链接）。降级输出不许写成测量结论：
  现在说"这一 lane 不读上游，因此上游未被观测"，并明写那个路径没被打开过、不对它作任何断言。
- **fork `release.yml` 的注释声称 binaries lane 覆盖五个原生目标、musl/baseline"声明了但没有
  lane"。** `product.json` 的矩阵只有 `darwin-arm64`/`darwin-x64`，其余是被有意 drop 的（见
  `platform.dropped`）——"没有 lane"是因为"没有目标"。注释改成陈述实测形状，否则下一个人会照注释去补
  runner，补出来的就是分发面上的假承诺。

### Fixed — 发布说明与依赖清单自己的字节

- **CHANGELOG 的 0.7.4 条目里还留着模板字面量的痕迹。** 那一版是通过 JS 模板字面量写进文件的：
  两行 `const …` 已被同日批次删掉，但整段 `\`` 转义还在（本轮实测 116 处），于是那条发布说明在
  markdown 里渲染成"反斜杠 + 代码跨度"。本批把 0.7.4 全段剥回正常反引号，并核到全文转义残留为 0。
- **`bun.lock` 里包自身的 `"version"` 停在 `0.7.3`**，而 `product.json` 已是 `0.7.5`（0.7.4/0.7.5 两次
  发版都没同步它）。`bun install` 把它带到与真源一致；这条不是装饰——清单与声明不一致时，"锁记录的
  就是那次发布"这句话就没有读者。

### Tests / 闸（本批实测）

- 固定点测试：`packages/opencode` 四个 glasspane 文件与 `packages/tui` 的
  `inline-tool-wrap-snapshot.test.tsx`；`installer-selftest.sh` 离线跑完整兜底通道；`kernel-pin --check`、
  `kernel-conformance`、六把尺子与主仓 `check-workflows` / `check-doc-links` 的读数逐条写在 `SYNCLOG.md`
  本批那一节（含**一条没清掉的负载敏感计时断言**：`glasspane-surface.test.ts` 的 oversized-frame 用例
  在同一棵树上两次红、两次绿，绿的那次单条就花 26.96s、距 30s 预算只剩 3 秒；判据不改、超时不加，
  按本仓口径它是不稳定对照，进未修清单，不写成"复跑证明是假红"）。
- 尺子自身的三条反向路径本轮重验（本批改过的尺子只有 `hook-liveness`）：金样伪写 `permission.ask=live`
  → `--check` 具名红 exit 1（**第一次的 perl 没落地，那条控制当场作废重做**）；删金样 → exit 2 指名
  `--record`；藏参照检出 → `--check` exit 2 给出 `--offline` 出路，`--offline` exit 0 且明说未观测。

## [0.7.5] - 2026-10-11

判据（pre-1.0）：**patch**。没有新增命令、没改形状、没动参数与目标矩阵；改的是三句**文案**、
一条**六把尺子没看到的用户可见文本**、以及发布链路上一次**没跑自家校验的发布**。

### Fixed — 产品还在替上游项目说话的地方

- **`serve` / `web` 的告警与 `attach` / `run` 的 `--help` 报的是上游的变量名。** 四条字符串写着
  `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`，而本产品每个变量都有
  `GLASSPANE_HARNESS_*` 的名字且**先读它**（旧名只是兼容回退：`product.json` →
  `privateSurface.envVars`，唯一解析点在 `packages/core/src/flag/flag.ts` 的 `read()`）。
  读回退是代码，把它**打印给用户**就是替上游作产品主张。代码里的 `Flag.OPENCODE_SERVER_PASSWORD`
  这类标识**没动**——那是血缘，也是兼容读取真正落地的地方。
- **六把尺子此前从不看 `src/cli/cmd/` 里的字符串字面量**，所以这个改名可以悄悄退回去而无人说。
  `product-surface` 新增 `cli-text-names-product-env`：扫 `packages/opencode/src/cli/cmd/*.ts`
  **剥掉注释之后**的字符串字面量，凡 "defaults to / Warning / is not set" 这类话里出现上游变量名、
  `opencode.ai` 或 `@opencode-ai/` 即红，点名文件与原文。断言数 98 → **123**。
  双向控制实测：把那几个字母只塞进**注释** ⇒ 规则照旧 exit 0 且不命中（证明它不被注释顶替）；
  塞回**打印的字符串** ⇒ `cli-text-names-product-env] …/serve.ts shows the user "Warning:
  OPENCODE_SERVER_PASSWORD is not set;`、exit 1；还原按 sha256 核回 ⇒ 绿。

### Fixed — 平台包发布这一步此前没跑过产品自己的校验

`publish-platform` 直接对构建目录 `npm publish`：没有任何一步问过"这个塔式包里的 `bin/` 在不在、
可不可执行、有没有 README（否则 npm 页面只剩一个裸版本号）、它的 `package.json` 是不是**本次**产品
的版本"。最后一问正是 `bd690a9` 给 `validateTarball` 装上的牙——但那条校验过去只在 wrapper job 上
跑，平台包这条路是裸的。现在该 job 在构建之后、发布之前跑 `bun run script/publish.ts --dry-run`，
按产品自己的校验器过一遍再交给 registry。`--dry-run` 下"其余声明目标未构建"仍按设计打 note
（一台 runner 只建一个目标），不会把这条 job 判红。

### 明确记一条本轮没收口的

`checksums` job 求和用的仍是 **GitHub 供回的字节**（它自己的注释写明了边界：证的是"存的是什么"，
不是"构建产的是什么"）。要接成 `binaries` 用 job output 交出构建目录里算的 sha256、`checksums`
双向断言"下载回来的 == 构建时算的 == 清单里写的"，得改两处 job 的 `needs`/outputs 接线。本轮不冒
这个险——接错的代价又是一次半个的发布，而"失败模式不是红，是没收口"正是这批活的起因。写在这里作为
下一轮的明确任务。

## [0.7.4] - 2026-10-11


判据（pre-1.0）：**patch**。没有新增命令、没改 CLI/TUI 形状、没动参数与目标矩阵。唯一的使用者可见
变化是**兜底安装通道变得更严格**：清单取不到时它现在拒绝安装并报告 HTTP 状态，而不是"当作这个版本
没发清单"然后装上一个没有任何完整性校验的二进制——先前拿到"unverified install + 一个具体但错误的
解释"的那类主机，这次会拿到一次失败与一条出路。这是修掉的行为，不是新形状。

这一批是**收上一轮没收口的活**：`gp-harness-orphan-20261010`（`a054fdc`）保住了 10-10 那轮被
ENOSPC 杀掉时留在未提交状态的五个文件。按内容判据逐条核（`git cherry` + 逐文件比对，不看分支名
也不看提交信息）：`install.sh` 里"签名抓取跟随重定向"那半**已经在 main 上**（`b9409d7` 落过），
本轮不重复；其余四条真没落地，全部并回并各自补了双向控制。

### Fixed — 三条"绿着但从未能红"的发布/安装面

- **`verify-published.ts` 的 os/cpu 闸拿 `product.json` 跟自己比。** 它断言的是
  `product.platform.os.includes("darwin")`，即产品的声明与声明本身比较，且**从没读过 `cpu`**——
  而"wrapper 的 os/cpu 字段让 npm 在非 macOS 上直接拒绝安装"正是这个产品的分发裁决。发出去的包
  少了 `os` 字段也照样报 ok。现在读的是**装进临时前缀的那份 package.json** 的 `os`/`cpu`/`version`。
  反向控制实测：把 `product.json` 的 `platform.arch` 改成 `["arm64"]`（真发布物是
  `["arm64","x64"]`）→ `FAIL the installed package's os/cpu/version gates … cpu is
  ["arm64","x64"], product declares ["arm64"]`、exit 1；还原按 sha256 核回。
- **`scripts/install.sh` 把传输失败化妆成"这个版本没发清单"。** 兜底通道求 `SHA256SUMS.txt` 用的是
  `curl -fsSL` + `if ! …`，于是"未发布""被拦截/重写""答了别的东西"三种情况共用一个出口，而该出口是
  *警告 + 继续安装*。在本机这种由本地根重签 TLS 的主机上（本产品维护机就是），一次被挡的清单抓取
  换来的是**完全没做完整性校验的安装 + 一句具体而假的解释**。现在只有 404 算"政策缺口"（照旧如实
  标注并继续），其余一律 exit 1 并报出状态码与出路。反向控制：`installer-selftest.sh` 跑在**改动前**
  的 install.sh 上 → 5 条具名红（含 "it did say: no SHA256SUMS.txt published"、
  "nothing is installed on that path — it did say: [OK] installed via"），跑在改动后 → 全过。
- **fork 根的 `script/publish.ts` 是一个可用的上游发布编排。** 它会 rewrite 全树 version、
  `npm publish` `@opencode-ai/sdk` / `-plugin` / `-ui`（三个不属于本产品的包、别人的 scope），
  再 `git push --force-with-lease --no-verify` 推 tag、`git push HEAD:dev --no-verify`、
  `gh release edit --draft=false`。纪律 5 说的是"不往我们不拥有的基础设施推"，而这个入口距产品
  发布脚本只差一个 `cd`，且**没有任何闸看着它**。现在它是一具拒绝体：打印原因与真路径后
  `exit 2`（实测退出码 2）；文件保留而非删除，是为了让未来的上游同步落在一个会说明理由的拒绝上，
  而不是悄悄重新拿到一个往别人名字下推东西的脚本。读者是 `product-surface` 新增的
  `no-foreign-publish` 三条规则。

### Fixed — 尺子自己的两处假绿

- **规则不再被注释顶替**：`product-surface.mjs` 的产品同一性规则此前用 `read()`（不剥注释）——
  把 `postinstall.mjs` 里那行平台包模板**改成注释**，规则照样绿，因为字符串还在文件里。现在
  这类规则统一走 `readCode()`（与 `no-upstream-registries` 早就在用的剥注释同一条路）。反向
  控制实测：改注释 → `postinstall-identity` 具名红、exit 1；还原 → 绿。
- **`kernel-provenance` 的 `corpus.length > 8` 是魔法数**：它自己那句话写着"the published package
  ships 14"，而 pin 当时记 15、0.1.4 发 17、0.1.5 发 **24**——每次 bump 都让这句话变成谎，而少掉
  八个契约文件仍然绿。改成形状断言：每条必须点名文件并带 64 位十六进制 sha256，且同一文件不得
  出现两次（否则其中一条哈希永远读不到）。断言数 **94 → 98**。

### Changed — 内核 0.1.5 与出处

`packages/opencode/package.json` 与 `contracts/kernel-pin.json` 已由并行批次推到 **0.1.5**，而这棵
树的 `node_modules` 还停在 0.1.4——`kernel-pin --check` 正确地报了
"installed 0.1.4 but the manifest pins 0.1.5"。按文档路径 `bun install` 之后：24 个契约文件逐条
sha256 对得上，行为闸 **14 条 fixture 全答对**，且 **`--impl` 直接指 canonical 检出就能跑**——
`iterate-skill` 的 `main` 已带 0.1.5 的全部 15 个模块，与 `kernel/npm-canonical` 的 `kernel/src`
逐字节同内容。上一轮汇报里那条"已发布产物的源码不在清单坐标（`canonical.branch: main`）上、按它
复现不出来"的 canonical 侧问题，本轮实测已不成立（分支被合了），文档相应改掉；`--impl` 的缺模块
报告（exit 3）保留，因为这种分叉在两个月里发生过三次（0.1.2 / 0.1.3 / 0.1.4）。

### 记录

血缘 9,619 → **9,622**（+3）：新增字样全部落在"写下被改掉的那个名字"的位置——新的拒绝体点名它
拒绝发布的那三个上游包。按既有先例（9616/9617/9618）`--record` 并在金样 `source`/`lineageNote`
写明；反证仍成立（再新增一处即红）。

## [0.7.3] - 2026-10-11


判据（pre-1.0）：**patch** —— 一条发布链路的修复，产品面、CLI 形状、证据契约、目标矩阵全部不动。

### Fixed — `checksums` 那条 job 的三个步骤活在两个目录里

`v0.7.2` 的 Release run 把这条抓了出来（run 38098337688）：两个平台的 `binary` job 与
`create-release` 都绿，`SHA256SUMS for the release assets` **失败**在最后一步
`no matches found for SHA256SUMS.txt`（exit 1）——于是 0.7.2 有二进制、**没有清单也没有签名**。

成因是上一批（`f36748b`）把下载+求和那一步的工作目录从仓库里的 `assets/` 挪到了
`${RUNNER_TEMP}/release-assets`（理由写在注释里：`assets/` 是被版本控制的目录，装着
`logo.svg`/`banner.svg`，`cd assets` 是个 no-op，`sha256sum ./*` 于是给两个跟发布无关的
仓库文件作保），但**只挪了一步**：紧随的 `Sign release assets with GPG` 与
`Upload checksum and signature files` 仍然写着 `cd assets`。后果分两半，都在那次 run 里发生：
签名步签的是那两张已提交的 svg，上传步在自己的目录里找不到 `SHA256SUMS.txt` 而退出。
0.7.1 的资产列表里那对 `logo.svg.asc`/`banner.svg.asc`（下载数 0）就是同一件事的化石。

修法（今天树里实际长的样子）：下载/求和、签名、上传三步都指向同一个
`${RUNNER_TEMP:-/tmp}/release-assets`，并把"这条路径两步不一致就是路径本身的 bug"写进注释。并行
lane 独立提交了同一处修复（`a51b96f`，三步各写一次路径 + 因果注释），我这边先提交的是 job 级
`env: ASSET_DIR`（`bd690a9`）；合并时冲突取 trunk 那份，等价修法不并排放两份，`ASSET_DIR` 那两处
非冲突 hunk 一并撤掉，不给树留一个没人读的变量。

### Fixed — 一条会误报的发布闸（改的是报告，不是判据）

`script/verify-published.ts 0.7.3` 在这台机器上 exit 1，失败项写作
`the installed binary serves the embedded web app — no response`。读代码：等待窗口是
30 × 500ms = 15s，而子进程的 stdout/stderr 被丢掉不看——于是"负载太重、108MB 单文件 15s 内没起来"
与"这份产物里没有内嵌 web"共用同一句话。手测同一条通道：`serve --port 4814` 起来后
`curl http://127.0.0.1:4814/` 在 **8s** 内回 2,883 字节真 HTML，所以那次红是环境而不是发布物。
现在失败报告会写明等了多久、服务器有没有报出监听端口，并带出它输出的最后三行；从未报出监听端口
的那种情形明写 `INCONCLUSIVE` 并给出复跑办法。**判据一条没放宽**：观察不到仍然不绿。

### 0.7.2 的发布物状态（如实记，不当作已具备的保证）

GitHub Release `v0.7.2` 存在且带着 `glasspane-harness-darwin-arm64.zip` /
`-darwin-x64.zip`，**但没有 `SHA256SUMS.txt`、没有 `.asc`**；npm 上没有 0.7.2（publish 两条
job 在 push 触发的 run 里全部 `skipped`）。curl 兜底安装器对 0.7.2 会走"清单缺失"那条拒绝
分支——这是坏发布，不是噪声。0.7.3 才是这一版内容应有的发布物；0.7.2 的 tag 与 Release 保留
原地（版本号与 tag 不回收、不删），本节就是它的说明。

## [0.7.2] - 2026-10-10

判据（pre-1.0）：**patch** —— 本轮没有新增命令、没有改 CLI/TUI 形状、没有动参数；改的全是
"发布链路会发出装不上的包"与"闸绿着却红不了"。证据契约一条没动（判定仍全在 Swift、错误帧仍
`{code,message,remedy}`），三条安装通道的形状没动，`product.json` 的目标矩阵没动。内核依赖升到
0.1.4 是依赖形态的变化，不是产品面。

**一条通道会被"绿着的 Release run"悄悄漏掉。** `v0.7.1` 打 tag 那一次 run 是 **push** 触发的
（run 37813349574），而两条 publish job 的条件是 `workflow_dispatch && publish_npm && confirm`：
`version-check`/`create-release`/`binaries`/`checksums` 全绿，`npm darwin-arm64`、`npm darwin-x64`、
`npm wrapper` 三条 `skipped`——整条 run 报 success，npm 上却一个字节都没动。本轮 20:49 实测
registry 仍是 `glasspane-harness@0.7.0`。这条在 23:1x 由并行 lane 补发掉（实测 registry 回到
`0.7.1`），所以 0.7.2 **不是**来补这个洞的；洞的成因留着：一个 `skipped` 的 job 在 GitHub 的
run 结论里不计成失败，于是"发布成功"与"发出去了"是两件事。`docs/release.md` 第 5 步写的是显式 dispatch，本轮把这条也补进 `SYNCLOG.md`。

### Fixed — 发布链路：会发出装不上的包的那三条

- **平台包与 wrapper 的版本互检是恒真的。** `script/publish.ts` 把 `binaries[name]` 交给
  `validateTarball()`，而 `binaries` 就是从同一个 `dist/<pkg>/package.json` 里读出来的，于是
  `manifest.version !== version` 比的是"这个文件和它自己"，永远不会成立。本机就是现场：`dist/`
  还停在 0.7.0 而 `product.json` 已是 0.7.1，`--dry-run` 照样报
  `ok glasspane-harness-darwin-arm64@0.7.0 packs cleanly`。真发一次的后果是 wrapper@新版本点名一个
  没人构建过的平台包版本，而平台包那次 `npm publish` 会回"already published"什么也不发 ——
  wrapper 的 `optionalDependencies` 是 optional，npm 于是"安装成功、命令没有"。现在平台包按
  **产品版本**验收：同一棵树、同一条命令改报
  `✗ … package.json version 0.7.0 != product version 0.7.1` 并 exit 1。
- **wrapper 被平台循环当成平台包发了第二次。** `dist/<product>/` 是上一次运行留下的目录，
  `dist/*/package.json` 的扫描把它算进 `binaries`，于是 wrapper 在平台包**之前**就发了 —— 正好是
  `publish-wrapper` 用 `needs: publish-platform` 保证的那个顺序。`--dry-run` 里
  `ok glasspane-harness@… packs cleanly` 打了两遍就是这件事的现场；现在这条循环只处理平台包。
- **"声明的目标没构建"从 note 改成拒绝（live 路径）。** `--dry-run` 打条 note 是诚实的；真发的时候
  它意味着 wrapper 会引用一个本次没人产出的平台包版本，现在它 exit 2 并给出出路（构建全部目标，
  或用 `--wrapper-only` 由持有全部产物的那条 lane 发）。
- 顺带一条会说谎的输出：`--dry-run` 不管是不是 wrapper-only 都打 `wrapper-only mode`，读发布日志的
  人被告知"平台包不在范围内"，而那一刻它正在打包平台包。

### Fixed — 闸自己被验过吗：两条绿着红不了的

- **`harness contract` 的上游探针把"测不了"报成"没漂移"。** 那条 step 是
  `out="$(… --probe 2>&1 || true)"` 再 `grep -q "drift"` 定胜负：`--probe` 的 exit 2（参照检出不在
  `$HARNESS_UPSTREAM_CHECKOUT`、金样读不到、抛错）三条路径的文案里都没有 "drift" 字样，于是这条
  lane 唯一的职责失效时它是绿的。现在判决吃 **exit 码**（0 干净 / 1 漂移 / 其余一律红，且在
  step 摘要里写明"未观测"，不构成"上游没漂移"）。新闸
  `harness/tools/probe-lane-selftest.sh` 不做复制品：它从 YAML 里**抽出真 step 正文**，用桩喂三种
  退出码。反向证据实测 —— 把改动前的正文喂给它：`exit 2 → step exit 0` 等三条全红；改动后：绿。
- **`tool-surface` 的架构铁律数字由脚本自己说了算。** `LIMIT`（<10% 那条）、`LIMIT_SOURCE`、
  `caliber` 都是脚本里的常量，金样记了它们却没人比对：把 `0.1` 改成 `0.25` 是一笔**全绿**的提交，
  效果是两条越限的面（A 22.84% / B 15.70%）当场"合法"，连 `← OVER LIMIT` 那句自报一起消失。现在
  `--check` 先比这三样，任一不同就 red 并点名金样值与代码值。实测：改成 0.25 → 具名红；改
  `caliber.engine` 的措辞 → 具名红；还原 → 绿。量尺不配重新定义它守的那条铁律。
- **`kernel-conformance --impl` 的"这份实现缺模块"守卫跑不到。** `loadImpl()` 在 REQUIRED 检查之前
  就 `import()`，而把 `--impl` 指向 canonical 的 `main`（它没有
  `decision-log`/`evidence-decision`/`dimension-context`/`run-plan`）时，结果是裸的
  `Cannot find module '…/dist/decision-log.js'` —— 唯一能解释发生了什么的报告正好在唯一的失败路径
  上不可达。现在先验存在性，再导入，具名缺哪几个模块、指出 `contracts/kernel-pin.json` 记的
  canonical 坐标与产物出处不一致，exit 3。

### Changed — 文档与树对表

- `FORK.md`、`harness/README.md`、`docs/kernel-integration.md` 里"现在是什么"的那几句按实测改：随包
  契约文件 **14（11 fixtures + 3 schemas）→ 17（13 fixtures + 4 schemas）**；"今天以依赖形态活着的
  是 `iterate-kernel@0.1.2`/`0.1.3`" → **0.1.4**（历史叙述段保持原样，不改写已发生过的事）。
- 两条实测事实入档：**已发布的内核源码不在 canonical 的 `main` 上。** `iterate-kernel@0.1.4` 出自
  分支 `kernel/npm-canonical`（比 `main` 前 29 笔；`main` 的 `kernel/package.json` 仍是
  `0.1.0-draft.1`，`kernel/src` 里没有 decision-log / evidence-decision / dimension-context /
  run-plan），而 `contracts/kernel-pin.json` 的 `canonical.branch` 是 `--record` 里写死的
  `"main"` —— 出处清单指得到一个从未含过所发字节的 ref。`pin.canonical` 只被写不被读，所以这条
  不一致没有任何闸能看到。本轮不改 canonical（那是 iterate-skill 的决定），把 `--impl` 的失败改成
  会说话，并列进汇报的待裁决。
- 把 `main..kernel/npm-canonical` 真构建出来跑双方对照（`--impl` 指向那份
  `kernel/`）：**11 条 fixture 两侧逐字节同答案**，fork 跑 zod 4.1.8、canonical 跑 zod 3.25.76。
  这是这条通道第一次在有参照实现的情况下测成，之前的"9 条同答案"记的是别的组合。

### Changed — 依赖升 0.1.3，行为闸不再与自己比较


- **`iterate-kernel` 0.1.2 → 0.1.3。** 升这一版不是为了新功能，是为了让随包语料里的转录契约
  （`evidence-decision.ok-01.json`）进到本仓 CI：停在 0.1.2，那条 fixture 不在包内，下面那条
  oracle 分支永远不触发，"两侧同一套转录"就只剩 iterate 一边的证据。出处清单重记为 15 个契约文件。
- **`script/kernel-conformance.mjs` 的比较对象补齐。** 单实现模式此前把实现与它自己比，恒真，
  而 CI 正是这么跑的。现在三方可指认：`contracts/kernel-conformance.json` 记下每条 fixture 的
  答案摘要，fixture 自带期望的优先按期望断言（`dimension-context` 的 `expected`/`expectedLine`、
  `evidence-decision` 的 8 个 case），加 `--impl` 才是双方逐字节对照。每行报告写明这条是靠什么
  比的（`[oracle+golden+impl×N]`），一样都没有就打 `?!`；金样不在时拒绝跑绿，`--record` 在
  oracle 违反时拒绝盖章。被拒的样本也不再印成通过：`REJECTED …` + 行尾 `rejected` 身份。
  `evidence-pack` 那类改走产品实际消费的读侧契约 `parseEvidencePackRead`。
- 一条 `kindOf` 前缀表 + "包发了但本 lane 不驱动任何 kind"的守卫：`dimension-context` 就是因为
  判成 null 而整份语料白带着走了一轮。

### Changed — 共享内核改为依赖，仓内副本退役

- **内核不再是抄进仓里的源码。** `packages/opencode/vendor/kernel/`（25 个文件：11 份源码、3 份 schema、11 份 fixture）连同镜像到 `contracts/kernel-fixtures/` 的契约语料一起删除。`glasspane-harness` 现在把 **`iterate-kernel@0.1.2`** 当作 `packages/opencode` 的普通依赖，从 npm 解析，解析结果与完整性记在 `bun.lock`。运行时的行为与 vendored 时期一致：同一份内核、同一套 schema、同一个契约语料。
- **出处由新清单钉住。** `contracts/kernel-pin.json` 记下版本、registry 解析坐标（`lockKey`/`specifier`/`integrity`）与随包发出的 **14** 个契约文件（11 fixtures + 3 schemas）的 sha256；`script/kernel-pin.mjs --check` 逐条验证——装的版本 == pin、`bun.lock` 那条 specifier 为空（即来自 registry，而不是只在本地存在的 `file:`/`link:` 目录）、lock integrity == pin、契约字节 == pin。`--probe` 改为问 registry（`npm view iterate-kernel version`）。旧的 `kernel-vendor.mjs` / `kernel-vendor.json` 退役。
- **新增一条行为闸，覆盖面更广。** `script/kernel-conformance.mjs` 把随包发出的 fixtures 跑过**装进来的那份内核**；哈希只证明字节没变，这条证明产品实际依赖的那些答案还是那些答案。它现在也驱动 `dimension-context`——会话压缩里那条维度覆盖线用的就是它，此前没有任何 fixture 校过它。加 `--impl <canonical checkout>` 会再跑第二份实现并要求逐字节同答案：实测 9 条 fixture 两侧同答案，zod major 不同导致的**报错文案**差异被打印成 note，而不是抹平。
- **单文件二进制的 import 形状是产品要求。** 内核绑定模块只走 per-module 子路径（`iterate-kernel/parse` 这类），不 import barrel：barrel 会在模块加载时读包旁边的 schema 文件，而单文件产物满足不了那次读取。改依赖形态后重跑了这条通道——`bun run script/build.ts --single --skip-install --skip-embed-web-ui` 编译通过，其自带 boot smoke 通过（`glasspane-harness --version` → `0.7.0`）。
- **安装策略一处例外，随包说明。** `bunfig.toml` 的 `minimumReleaseAgeExcludes` 列出 `iterate-kernel`，与同列的 `@opentui/*`、`@ff-labs/*` 同理：三日冷静期挡的是上游发布窗口被投毒，而这个包的发布方就是本产品线的维护者，且它的字节仍由 lock integrity 与 pin 清单钉住。

### Fixed

- **一条一直绿着却什么都没验的测试。** `test/tool/glasspane-kernel.test.ts` 检查内核出处时按固定层数向上找清单文件，落在一个从来不存在的路径上；文件不在时它打印一条警告然后返回，于是测试通过而断言数为零。出处与包位置的解析现在收在 `test/lib/kernel-contract.ts`（逐级上溯直到找到；缺 pin 直接判红，不再是一句警告），同一条规则被三个测试文件共用。

### Internal

- 更新内核的唯一合法路径变成三步：在 `packages/opencode/package.json` bump 版本并 `bun install` → `node script/kernel-pin.mjs --record` → `bun script/kernel-conformance.mjs --impl <canonical kernel checkout>`。`tools/sync-kernel.sh --target=fork` 现在拒绝执行并打印这三步；`--target=repo`（mcp-shell 用的那份镜像）本批未动。
- 三道 CI 引用改到新闸：本仓 `.github/workflows/ci.yml`、GlassPane 根 `.github/workflows/ci.yml`、`.github/workflows/harness-contract.yml`。
- 两把尺子的基线随本批重记：`fork-diff` 对 `v1.18.32` 为 **`4668 identical / 259 edited / 81 added / 1705 deleted`**（全树 6,713 个条目）；`tool-surface` 面 A 8,601 行未变（**23.19%**）、面 B **5,376 行 / 14.50%**，vendored 排除项由 11 文件 / 1,464 行归零——内核现在是依赖，不再是需要从产品自有行数里剔出去的抄本，金样因此记下 `kernel: iterate-kernel@0.1.2`。
- 文档同批对齐：`FORK.md`、`SYNCLOG.md`、`docs/kernel-integration.md`、`NOTICE`、两份 README、`SECURITY.md` 与 `harness/README.md` 里的内核形态、闸名与数字。

## [0.7.1] - 2026-10-09

判据（pre-1.0）：**patch** —— 本轮没有新增命令、没有改 CLI 形状、没有动参数；改的全是
"报告与实测不一致"。产品面与安装通道形状不变，证据契约（判定仍全在 Swift、错误帧仍
`{code,message,remedy}`）一条没动；`brand-surface` 血缘计数 9,627 → **9,617**（减 10，
去掉 brew/choco/scoop 与上游仓库那些字面），棘轮只许减不许增，方向对。

这一批来自两条审查泳道（定制面正确性 + 发布/供应链）与一次尺子自检。重点仍是**有几道闸
绿着却红不了**，以及**有几处把没做过的事说成做过**。每条修复都给反向证据（破坏被修的点 →
具名用例或某把尺子必须变红），口径见 `harness/README.md`「闸自己被验过吗」的 2026-10-09 段。

### Fixed — 发给模型与用户的话

- **升级路径向上游的基础设施要版本号。** `installation/index.ts` 的 `latest()` 在非
  npm 通道上落到 `api.github.com/repos/anomalyco/opencode/releases/latest` 并回上游的
  `tag_name`；而 `method()` 对我们自己的 install.sh 兜底装出来的位置正好回 `"curl"`，
  且 `cli/upgrade.ts` 在 `method === "unknown"` 守卫**之前**就发了这个请求，`upgrade()`
  每次 TUI 启动都跑。于是产品把上游的发布号当"可更新版本"报给自己装出去的用户。同段还去查
  `formulae.brew.sh/.../glasspane-harness.json`（我们没发这个 formula）、Chocolatey
  `Id eq 'opencode'`、Scoop 桶 `opencode.json`（后两个是上游包名）。现在只认两条真发过的
  通道（npm 家族读配置 registry 上的本产品包，curl 读 `jingzhao-l/glasspane-harness` 自己的
  releases），其余通道回 `NoUpdateChannelError`，**请求根本不出进程**。
  `docs/migrate-from-opencode.md` 那句"curl 自升级路径已去掉"与代码不符，按实测改写。
- **引擎忙 = 告诉模型"这个方法这个引擎没有"。** `requireCapability` 把
  `probeCapabilities() → null` 一律映射成写死的 `GP_E_CAPABILITY_UNAVAILABLE` 加
  "start or update the background service"；但 `hello()` 对任何非 ok 回帧都回 null，
  **包括** `GP_E_ENGINE_TIMEOUT`，而 daemon 是单连接的——槽位一忙，每条 `gp_*` 都被说成
  能力缺失，还被指去重启一个正常运行的服务。现在引擎给了什么就转达什么，只有真正确认过
  "没宣布过"才说不支持。`daemon.ts` 里 `{"error": "<字符串>"}` 那种帧被记成"既不是结果也
  不是错误"的错账，一并改正（拒绝不变，指错的条款变对）。
- **TUI 把没有引擎结论的一行画成有结论。** `glasspaneRow` 只对 `meta.ok === false` 走
  拒绝分支，其余一律 `success`；`registry.ts` 给任何插件工具塞
  `metadata: {...metadata, truncated}`，一个返回字符串的 `gp_*` 插件工具到手就是 `{}`，
  而 `toolDisplay` 把所有 `gp_` 开头的 id 都送进这条分支。新增 `no-verdict` 态（`?` +
  warning 色），只转达"这里没有结论"；判定仍然只在 `glasspaned` 那一侧。
- **curl 那条拒绝的话写在跑不到的字段上。** `upgradeCurl` 把 remedy 写进 `stderr`，统一
  出口随后用 `upgradeFailure(m, upgradeResult)` 覆盖成 `Upgrade failed for curl (exit code 1).`
  ——为"过滤抓来的脚本输出"而设的净化器把产品自己的那句话也滤掉了。现在原样送达；
  `cli/cmd/upgrade.ts` 那个无守卫的 `await Installation.latest()` 也不再让新错误从 yargs
  `.fail()` 裸抛。

### Fixed — 装到用户机器上的东西

- **兜底安装给一条根本没跑起来的命令打 [OK]。** 收尾用 `command -v` 验 PATH 上最先撞见的
  那份拷贝（本机实测：它指着一次旧安装给了绿，而这次装进去的是占位桩），再
  `"$BIN" --version 2>&1 | head -1` 配 `|| true`——管道状态是 `head` 的，连那个也丢了。
  占位桩往 stderr 道歉并 exit 1，于是打成 `[OK] … --version -> Error: … postinstall was
  not run.` 且退出 0。现在按安装通道定位这次真写进去的文件，退出码取命令本身。
- **验签失败照样装。** `GPG_STATE="FAILED (…)"` 后面只 warn 就 return 0，而这条路径上另一
  道检查 SHA256SUMS.txt 与资产同源。"没发布 .asc / 机器没 gpg"照旧是策略缺口（只警告，
  0.6.4 定的策不变）；"验不过"、"不是那把钥匙"、"拉签名不是 404 地失败"三类现在是篡改
  信号，拒装。`.asc` 的 404 与传输失败此前被 `curl -f` 折成同一件事，现按 HTTP 状态分开。
- **指纹只在注释里，没人断言。** 装钥与验签只要求 `grep -q GOODSIG`，任何一把能做出好签名
  的钥匙都算过。`VALIDSIG` 的完整 40 位现在必须等于安装器自带的指纹，不等就点名两把指纹
  并拒装。`gpg --import` 那条裸管道在 `set -e` 下会让安装器只留一句 gpg 的 stderr 就死掉且
  把临时钥匙环留在盘上，照 `--verify` 已有的写法收进 `if`，从创建起每条出口都清理。
  安装器自检从 31 条断言扩到 **51 条**，全部实测；三处旧夹具改为真形状（curl 桩回 HTTP
  状态码、gpg 桩补 `VALIDSIG` 全指纹行、发布物里的二进制打纯版本号——对已发布 0.7.0 实测
  `--version` 就输出 `0.7.0`）。

### Fixed — 发布链路与尺子

- **任何发布失败都被说成"staged-only 拒了直接发布"。** 平台包那条 `npm publish || { notice;
  npm stage publish .; }`、wrapper 那条 `if ! publish.ts; then …`，把 E401/404/5xx/打包问题/
  E409 重复版本（0.5.0 真踩过）全折进同一分支；而 `product.json` 记着 trusted publisher
  至今是 `owner-action: not yet configured`，也就是说这句归因当前从来不是真因。现在留住退出码
  与原始输出，只有日志真说"staged/trusted publisher"才降级，且明写 `STAGED, NOT PUBLISHED`。
- **checksums 把下载失败吞了**（`gh release download … || true` + 只判目录非空），两平台只
  到一个也能产出一份看着完整的清单；现去掉 `|| true` 并按 `product.json` 的 platformTargets
  逐个点名，缺一个就拒写。清单同时写明它**不**证明什么：算的是 GitHub 供回来的字节，
  担保"存的就是这些"，不担保"构建产出的就是这些"。
- **`gh release create` 没有 `--target`**，Release 记的是分支不是被 tag 的 commit（v0.6.4
  实测 `targetCommitish=main`）。现钉到 `$GITHUB_SHA`。四条 job 级 `if` 全部显式写成
  `success() && …`——"显式 `if` 是否替换隐式 needs 成功条件"这一条本轮没能从官方文档取证，
  所以不依赖那个未证实语义。
- **publish.ts 的校验只在 `--dry-run` 跑**，真正发布那条路一条断言都不做（而它自己的注释写着
  "checked before it can be published"）。现在两条路径都校验。反证：造一个有 package.json、
  无 `bin/glasspane-harness` 的平台包 → `--dry-run` exit 1 并点名缺件。
  残留如实记：wrapper 那几个文件是 publish.ts 自己写完再查自己，删掉 README 也会被重新生成，
  所以这条对 wrapper 近于自证；真正能咬的是 build.ts 产出的平台包——而 release.yml 现在仍用裸
  `npm publish` 发平台包，绕过 publish.ts，那一侧的闸本轮没接上。
- **npm 钉住了，而且是有证据地钉。** 上一条提交写"0.7.0 用的哪个 npm 已从 job log 查不出来"，
  只对一半：log 里没有，registry 有——已发布 0.7.0 wrapper 的元数据记着
  `_npmVersion: 12.2.0`、`_npmUser: GitHub Actions <npm-oidc-no-reply@github.com>`。
  三个发布 job 据此钉到 `npm@12.2.0`，版本仍照打。
- **verify-published 三条"过不了也报过"**：非 macOS 分支原断言 `exitCode !== 0`，离线/代理/
  404/npm 不存在(127) 全满足 → 改为显式拒答（exit 2，"什么都没验证"）；只查 `product.binary`
  一个命令 → 改为遍历 `product.bins` 并要求 `--version` exit 0 且等于版本号；"内嵌 web 已供出"
  原来正文里有 `<html` 就算过（错误页也满足）→ 改为 content-type + doctype + `/assets/…` 三项。
  registry 显式点名，integrity 断言与 provenance 分开写。对本机已发布的 0.7.0 实跑：全绿，
  `dist.attestations.provenance` 挂着 SLSA v1 predicateType。
- **preflight 的 `openssl verify` 只吃链里第一张证书**，中间证书既没当 untrusted 也没当 CA，
  一条本可通过的链会读成 FAILED；改为 leaf + `-untrusted`，并删掉算了却没用的 `issuer`，
  把 `ghostty-web` 的出处从 `build.ts` 改对到 `packages/app`。两条方向都实测：163 张束 → OK/0，
  158 张系统根 → FAILED/1 并给出正确 remedy。
- **三把尺子的假绿口径**：`tool-surface` 里 `let ri = 0` 从不前进，一条删除行可以免掉任意多
  条新增行（40 份改了品牌的复制行记 0）；面 B 越过书面 10% 却没人说（跨限判定对已超限的基线
  恒假，那句 "already over" 只写给面 A）；排除清单的出处打在屏幕上是**不存在的路径**。
  `brand-surface` 的 `--record` 会把"这个文件没被扫到"写成绿色基线，`--check` 从不比对扫描
  覆盖（子树消失＝血缘计数下降＝看着像进步）。`surface-semantics` 的阈值规则只认一种操作数
  顺序（`ratio > 0.5` 命中，`0.5 < ratio` 记 0）——两侧都认之后本树仍 0 命中/18 文件，
  **没有**为此重记金样。
- **SECURITY.md 那句 "npm releases carry provenance in CI (Trusted Publisher, staged-only)"
  三个限定词两个半不成立**，按实测改写；并补上此前四份文档里一个都没出现的"怎么验你装到的
  东西"（SHA256SUMS、`.asc`、GPG、`npm audit signatures`），以及一条边界：CI 那边仍是
  "secret 里是什么就用什么"，**没有任何一步证明发布用的私钥就是安装器断言的那把**，所以
  安装器是执法点而不是 CI 步骤。

### Measured — 本轮收口时各闸的实际数字

engine 23,209 LOC / 60 files；面 A `mcp-shell/src` 8,652 LOC = 22.85%；面 B（fork 内我们写的）
6,007 LOC = 15.86%（书面限制 10%，两面都超限且如实标注"跨限判定已用尽，还在守它的是 LOC
棘轮"）；测试排除 27 files / 1,718 lines；vendored 排除 11 files / 1,464 lines（清单出处
`harness/glasspane-harness/contracts/kernel-vendor.json`）。
`fork-diff`：4,667/6,746 byte-identical，260 edited，114 added，1,705 deleted。
`brand-surface`：26 product files + 2 docs，0 hit，血缘 9,617 / 3,310 files（覆盖不变）。
`surface-semantics`：0 hit / 18 files。`product-surface`：88 agreement / 0 problem @ 0.7.1。
`hook-liveness`：21 hooks against v1.18.32，no drift。`kernel-vendor`：25 files / 84,308 bytes
@ `2ed342b`，与溯源清单一致。`kernel-conformance`：8 fixtures ok。
固定点测试：`packages/opencode` 80 pass / 0 fail（305 expect），`test/installation`
13 pass / 0 fail，`packages/tui` 24 pass / 0 fail（8 snapshots，67 expect）；
四个发布包 `tsgo --noEmit` 各 exit 0。安装器自检 51 条断言全过。

金样本轮**同批 --record 两次**并在此说清长了多少、为什么：`fork-diff.json` 的 edited
258 → 260（`script/verify-published.ts` 与 `src/cli/cmd/upgrade.ts` 首次进入分叉记录面），
`tool-surface.json` 面 B 5,548 → 6,007（+459：其中约 +23 是**配对规则修正后重新计费**的
既有重复行，不是新写的代码；其余是本轮 install.sh/publish.ts/verify-published/尺子与测试
的真实新增）。面 A 的 +51 来自同日 main 上 1.9.0 那批 mcp-shell 改动，不是本线。


## [0.7.0] - 2026-10-07

判据（pre-1.0）：**minor** —— 用户可见的安装器 CLI 形状（`--version <值>`、`--help`、
Intel Mac 的兜底通道）与同目录配置优先级都变了，不是纯修复。证据契约（判定仍全在
Swift、错误帧仍 `{code,message,remedy}`）一条没动。

这一批同样来自一次全面审查（正确性 + 发布/供应链两条泳道），但重点不在"改了多少行"，
而在**有几道闸当时是绿的却红不了**——逐条给出破坏证据后才算修完（口径见
`harness/README.md` 的「闸自己被验过吗」）。

### Fixed — 发给用户的东西

- **兜底安装器在 Intel Mac 上把自己拒了。** `uname -m` 报 `x86_64`，而白名单只收
  npm 词表里的 `arm64|x64`，于是在写着"this product ships darwin-arm64 and
  darwin-x64"的那一行拒绝了一台正好是 darwin-x64 的机器。加了 `x86_64→x64` /
  `aarch64→arm64` 的映射层，其余架构照旧明确拒绝。
- **安装器宣称它没做过的校验。** 收尾无条件打印 `sha256 + GPG verified`，而
  无 `SHA256SUMS.txt`、资产未被列出、机器上没有 `gpg`、没有 `.asc` 四种情况各自
  只 warn 后继续安装。现在结论由实际状态拼出（`sha256: verified (SHA256SUMS.txt);
  GPG: skipped (no .asc published …)`），两者都没验时额外警告"装上的字节未被完整
  校验"。缺签名仍只警告不拒装是 0.6.4 定的策（区分"策略缺口"与"篡改"），这一版
  改的是**别把没做的事说成做过**；校验不匹配照旧直接拒装。
- **`install.sh --version 0.1.0` 100% 失败**（文件开头就教这条写法）：`for arg in "$@"`
  里的 `shift` 不影响已展开的循环，版本号随后被当成未知参数报错退出。改成 `while/[ $# ]`
  循环。`--help` 在 `curl … | bash` 形态下用 `sed "$0"` 打印自身，而那时 `$0` 是
  `bash`，必失败；改为直接输出用法。
- **GPG 验签失败会杀死整个安装器。** `set -e` 下 `out="$(gpg --verify …)"` 一失败脚本
  就地退出，其后的 `rc=$?`、警告分支、`rm -rf "$gnupg"` 全是死代码，用户只看到 gpg 的
  stderr 和一个泄漏的临时目录。改为在 `if` 里取值，清理先行。
- **引擎没答话时，工具说"成功了"。** `daemon.ts` 对既无 `error` 又无 `result` 的帧
  回 `{ok:true, result:undefined}`，TUI 于是渲染成 `gp_act: act ok` ——模型读到"这次
  点下去了"，而引擎其实什么都没答。改为按帧契约拒绝（`{id,result}` 或 `{id,error}`，
  `result` 缺席＝缺陷）；`result: null`（"这个 id 没有证据包"）仍算合法回答。
  同批补：`close`/`end` 事件（守护进程一次只服务一条连接，此前挂断要空等满 30/60 秒
  超时，remedy 还教 agent"别动鼠标键盘"）、响应 `id` 核对、跨 chunk 的 UTF-8 解码
  （CJK 窗口标题此前会被截成替换字符，再报成"引擎发的不是合法 JSON"）。
- **同目录里旧名字的配置赢过新名字。** `~/.config/glasspane-harness/` 下四个候选文件的
  合并顺序把 `glasspane-harness.jsonc` 排在 `opencode.jsonc` 之前，而"后合并者赢"正是
  `product.json.compatRead`、`config/paths.ts:26-31` 与本文件自己（项目级那段）写的
  规则——于是遗留文件静默劫持产品配置。改成遗留在前、产品在后。
- **构建把第三方响应原文当源码插进二进制。** `script/generate.ts` 取
  `https://models.dev/api.json` 的响应体**原文**交给 `Bun.build({define})`，而 `define`
  是源码文本替换：JSON 恰好是合法表达式所以一直没出事。现在要求 2xx、必须是 JSON
  对象、每个 provider 是对象，再重新序列化——非法响应让构建点名失败，不再可能成为
  发给所有用户的那份二进制里的代码。

### Fixed — 闸自己（这几条在坏的时候都是绿的）

- **`kernel-vendor` 的跨读读的是"碰巧 checkout 的那一支"，却把结论标成钉点。**
  实测：canonical 检在 `main`、pin 是 `kernel/decision-log-chain@2ed342b`，25 个与
  清单逐字节一致的文件报了 9 条红，remedy 写"backflow or drop it"。改为按
  `git show <ref>:kernel/<file>` 从对象库读；对象不在场时大声声明"未跨读"而不是判红；
  canonical 工作树脏不再污染测量。`checkDeclaredMode()` 一直在找一条任何布局下都不存在
  的路径 ⇒ `kernel.mode` 与树的形态是否一致**从未被检查过**，现已执行并两条验红。
- **`product-surface` 的 4 条断言落在判决之后**（打印与 `process.exit(1)` 都发生在它们
  之前），把 bin shim / 升级包名 / 卸载包名改回上游写法照样绿。收成底部唯一一处判决，
  断言计数 **84 → 88**。
- **`hook-liveness` 缺参照检出时 `TypeError` 退 1**，而 1 的语义是"上游坏了，冻结升级"
  ——把"这台机器没克隆"报成了上游事故（现退 2 并指向 `--offline`）。钩子名正则不认
  下划线，`experimental.provider.small_model` 被漏掉（声明 21、金样 20）；补上后又发现
  fire-site 正则不认带泛型的 `plugin.trigger<"…">(`，会把**活的**钩子判成 dead。
  金样重记为 21（live 15 / structural 5 / dead 仍只有 `permission.ask`），并加了
  "声明解析出 0 个名字＝无法测量（退 2）"的兜底。
- **`tool-surface` 的 `--record` 会在没有参照克隆时把沿用行数盖成新基线**（此后该 lane
  对 edited 文件的增长永久失明）；无参照时面 B 还会把"上游文件改名而来"算成我们写的行
  （同一棵树 5,115 vs 6,203）。现在两种都拒绝，且无参照 lane 拒绝断言面 B 在限内。
- **`brand-surface` 在产品语言目录被搬走时抛 ENOENT 退 1**（会被读成"品牌漂移"），
  改为退 2 并写明"跑不了不等于过"。

### Internal

- 新增 `packages/opencode/script/installer-selftest.sh`：桩 curl/uname/npm/gpg，把
  GitHub 兜底通道**离线跑完**（31 条断言，含校验不匹配必须拒装、无清单必须不说"已验"）。
  此前这条路径没有任何测试碰过，`product-surface` 的 `--dry-run` 也走不到它。
- 新增固定点测试 7 条：`test/tool/glasspane-surface.test.ts` 传输层 6 条、
  `test/config/config.test.ts` 同目录优先级 1 条；每条都对**改动前**的源码跑出具名红。
- `harness/README.md` 的金样数字全部按本轮实测校正（fork-diff 四桶、面 A/面 B、
  血缘计数、product-surface 断言数、surface-semantics 扫描集），并把 `kernel-vendor`
  清单与 fixture 的真实路径写对（它们在 fork 树里，不在 `harness/contracts/`）。
- `FORK.md` 订正两处与代码不符的主张：仓里没有 `--embed-web-ui` 这个 flag（内嵌自
  2026-09-25 起是默认，反向开关是 `--skip-embed-web-ui`），以及"本 pin 的内核没有
  `dimensionContext`"——重新钉 pin 后它已在 `vendor/kernel/src/dimension-context.ts:179`。

### 未观测（不写成通过）

真模型轮次仍未跑（这台机器上没有可用的 provider key，且花别人的额度该由 owner 决定）；
真 TUI 会话里的观感仍未观测（`gp_*` 需要 daemon 席位齐，本轮只跑到无头 `serve` 形态）；
`packages/{app,session-ui,desktop}` 与 TUI 的关系仍是待决项；canonical kernel 已前进到
`4541cd1` 并发到 npm（`iterate-kernel@0.1.1`），是否改换分发形态属 owner 裁决。

## [0.6.4] - 2026-10-03

这一版的内容全部来自一次全面审查：把 harness 从长期寄生的 worktree 合回主仓
`main`（形态与 iterate 生态对齐），然后逐道复核它的六把尺子。三个 P0 都是
「发布出去的东西是坏的」，其中两个在 npm 与 GitHub release 上已存在数日。

### Fixed

- **GitHub release 兜底安装此前从未成功过。** 安装器请求
  `<product>-<platform>-<version>.tar.gz`，而 `script/build.ts` 上传的是
  `<product>-<os>-<arch>.zip`：文件名里没有版本号（版本由 URL 里的 tag 承载），
  且只有 Linux 目标才打成 tar.gz。实测 v0.6.3 / v0.5.1 / v0.4.0 的两种猜法
  全部 HTTP 404。npm 不可用时（无 Node、无 npm、被代理拦）这条路径只会报
  "download failed"。
- **兜底安装不校验任何东西。** 0.6.3 随包发出的 `install.sh` 里
  sha256 / gpg / asc / checksum 一个都没有——发布链给每个资产签了 `.asc`、
  发了 `SHA256SUMS.txt`，而收到它们的安装器从不读。现在两个判定都补上：
  对 `SHA256SUMS.txt` 校验 sha256（完整性；**不匹配直接拒绝安装**，不降级为
  警告，因为字节不是发布的字节），对 `<asset>.asc` 验签（来源；缺 gpg 或缺
  签名仍只警告，区分「策略缺口」与「篡改」）。两者不可互相替代。
  对 v0.6.3 的真实资产实测：sha256 通过、GPG GOODSIG 通过；追加一个字节后
  sha256 判定拒绝安装。
- **`verify_asset_gpg` 读全局变量而不是参数。** 它声明了 `local asc` 却用
  `"$TMP/$ASSET"`，并引用 `$URL`——在 `set -u` 下以非 `$URL` 的 URL 调用会
  直接 `URL: unbound variable` 而死。改为全部走 `$1/$2/$3`。
- **版本序崩坏。** CHANGELOG 的章节顺序是 0.6.3 / 0.6.1 / 0.6.0 /
  `[Unreleased]` / 0.1.0 / 0.2.0 / 0.5.1 / 0.5.0 / 0.4.0 / 0.3.0——`[Unreleased]`
  卡在文件中部，且 M4 一条在 0.6.0 与 `[Unreleased]` 下逐字重复。改为严格
  降序、`[Unreleased]` 置顶，删掉重复的那条（它仍在 0.6.0 下）。

### Internal

- **尺子层合回主干，`harness-rulers` 成为主仓 CI 的一条 lane。** 此前
  `harness/tools`（6 把尺子）与 `harness/contracts`（5 份金样）只存在于一个
  worktree 的分支里，不在 `main` 的版本控制内——`FORK.md` 却把「分叉必须
  可测量」列为不可让步纪律并给出 4 条命令，其中 3 条在 `main` 上是
  `MODULE_NOT_FOUND`，而 `main` 的 CI 里 `grep -c harness` 当时是 0。
  纪律变成了散文，**两个月里没有任何东西发现**。现在每次 push 先断言 6 把
  尺子与 5 份金样在树里（就是这次的回归形态），再逐道跑。
- **三道闸的金样重记**（`fork-diff` / `brand-surface` / `tool-surface`）。逐条
  查证后重记，不是盖数：`fork-diff` 的 9 条过期项先逐文件比对确认与已发布的
  0.6.3 逐字节一致；`brand-surface` 的 +1 定位到一处**注释**（同一提交把用户
  可见的 `opencode -s <id>` 修成了 `glasspane-harness -s <id>`，注释里提到
  旧名，按字面计数 +1）；`tool-surface` 的两处增长分别是 main 上 1.6.x 的
  真实产品代码与尺子第一次在有上游参照检出时正确归属我们自己的 `gp_*` 工具面。
  `surface-semantics` 同批仍 0 hit——判定全部留在 Swift 引擎里，这条才是本棘轮
  真正要守的不变量。
- **`FORK.md` 新增第 3 条纪律「尺子必须和 fork 同仓」**，并说明 `subtree split`
  只带走 `harness/glasspane-harness/` 是对的：尺子量的是主仓里这棵树，不随产品
  分发。

### Added

- **Kernel conformance lane** (`bun script/kernel-conformance.mjs`): the kernel's own
  fixtures, mirrored into `contracts/kernel-fixtures/` and hash-pinned, are run through the
  kernel this package ships. Byte-identical answers or exit 1. With `--impl <dir>` it runs
  a second implementation — a built `dist/` or an installed `@iterate/kernel` — and
  demands the same answers, which is the evidence that changing how the kernel is
  delivered does not change what it means.
- **Kernel provenance gate** (`node script/kernel-vendor.mjs --check`) now also covers the
  mirrored fixtures, and both gates live in the product tree so this repository can
  verify itself.

### Fixed (kernel provenance, shipped in this version)

- The kernel's pinned ref was unresolvable because the canonical branch had never been
  pushed; the branch is now published and the manifest re-anchored to it.
- The drift probe asked `git ls-remote` to resolve a commit SHA. `ls-remote` matches ref
  names, so it reported "anchor unreachable" even for refs that were on the remote. It now
  asks the one question `ls-remote` can answer, and declines to guess at ancestry it cannot
  see.

## [0.6.3] - 2026-09-30

### Fixed

- **npm 发布通道被两个版本号卡住，现在绕过。** `0.6.1` 与 `0.6.2` 在 npm 侧处于
  *staged* 状态，`npm publish` 对这两个号一律返回
  `E409 Cannot publish over previously staged version`，而 `npm stage list`
  并**不显示**它们。成因是一次误操作：本机这个 npm 版本上
  `npm publish --dry-run` 仍然真的 PUT 了版本号（dry-run 并不 dry），于是被
  用来排查的号自己也进了 stage。stage 需要交互式认证才能 reject，因此这一版
  改发 `0.6.3`。**内容与 `v0.6.1` 的 GitHub release 完全相同**——跳号只影响
  npm 上的版本号连续性，不含任何功能差异。
- **GitHub release 的资产现在带 GPG 签名。** `v0.6.1` 起，两个平台归档与
  `SHA256SUMS.txt` 各带一份 `.asc`；`gpg --verify` 对从 release 下载的文件
  通过。签名步在 secret 缺失时**拒绝发布**而不是静默跳过——静默跳过正是
  GlassPane 自己的 v1.4.0 发出无签名产物的原因。

### Internal

- **`script/gpg-signing.sh`** (new) — 签名配置与发布凭据的一处入口，
  `seed` / `install` / `verify` / `verify-pass` / `local` / `audit` / `selftest`。
  放在产品树内而非仓外 `tools/`，因为 subtree split 不带走仓外目录。
- keychain 里的私钥以 **base64** 存放：`security add-generic-password -w`
  在本机会把**多行**参数 hex 编码，keychain UI 看不出异常，而 CI 拿到的就是
  那串 hex，`gpg --import` 报 `no valid OpenPGP data found` 且不会提它来自
  keychain。存后读回比对字节，`install` 推之前拒收非 armored key 的值。

## [0.6.1] - 2026-09-30 (GitHub release only — never reached npm)

The binaries, checksums and GPG signatures for this version are on the GitHub
release. npm never received it: the version number was left *staged* by a
misstep (see 0.6.3), and `0.6.2` then went out as an empty placeholder. Both are
deprecated on npm with an explanation. **Install from npm: use 0.6.3 or 0.5.1.**

### Fixed

- **Release assets are now GPG-signed, and the release refuses to publish without
  them.** v0.6.0 shipped two platform archives and no `SHA256SUMS.txt.asc`:
  the signing step read `GPG_PRIVATE_KEY` from the `release` environment, where
  it had never been set, and the step failed after the archives were already
  uploaded. The two secrets are configured now, and the lane is re-run.

  Consumers can verify provenance, not just integrity:

  ```bash
  gh release download v0.6.1 -p glasspane-harness-darwin-arm64.zip -p '*.asc'
  gpg --verify glasspane-harness-darwin-arm64.zip.asc glasspane-harness-darwin-arm64.zip
  ```

### Internal

- **`script/gpg-signing.sh`** (new) holds how this product and the four other
  projects in the two ecosystems sign their releases, so the question stops
  being re-derived: `seed` (one-time, the only interactive step), `install`,
  `verify`, `verify-pass`, `local`, `audit`, `selftest`. It lives in the product
  tree rather than the fork's `tools/` because subtree split does not carry the
  fork's directories into the published repo.
- `audit` names the release workflows that still sign behind
  `if: secrets.GPG_PRIVATE_KEY != ''` — a condition under which the step
  disappears silently and the release publishes unsigned. GlassPane's own v1.4.0
  shipped that way; this repo's `release.yml` was already migrated to failing
  loudly with a remedy.

## [0.6.0] - 2026-09-28

### Fixed

- **The session epilogue printed a command that does not resolve.** Exiting a
  session showed `opencode -s <id>`; this product installs as
  `glasspane-harness`, so the line a user copies to resume was the wrong binary.
  It now prints `glasspane-harness -s <id>`.
- **The epilogue could print `-s undefined`.** `sessionID` is optional, because
  the session may not have finished loading. The continuation line is now
  omitted unless there is an id, rather than emitting a literal `undefined` that
  reads like a runnable command.
- **The provider dialog kept a dead upstream key** in its description table —
  unreachable, but shipped. Removed.

### Added

- **Dimension-aware compaction (M4).** A compacted `gp_*` session now carries a
  coverage line computed by the kernel: which planned review dimensions the
  engine recorded a decision for, which recorded nothing, and which recorded
  something the run never planned. A dimension with no decisions is reported as
  unverified — never dropped, and never described as fine, since only the engine
  may judge that. The dimension vocabulary is the iterate config's; this side
  neither enumerates it nor infers one from a method name.

### Internal

- **The release lane was broken end to end and had been for several releases.**
  Five separate defects sat between a tag and a published binary, each hiding the
  next: a `steps.*` expression that made GitHub reject the workflow file (zero
  jobs dispatched), a `secrets` reference in a step's `if:` (same, and invisible
  to any local YAML check), a `build` script invoked from the workspace root
  where it does not exist, an upload that globbed both `.zip` and `.tar.gz` when
  each runner only ever produces one, and no step creating the GitHub release
  before the upload. `darwin-x64` additionally never got a runner at all, because
  its matrix pinned `macos-13`, which GitHub has retired.
  `check-workflows` now rejects `secrets` in an `if:`, so the second class of
  failure is caught before it reaches the registry.

- `packages/tui` typechecks clean (11 errors, one root cause: a `createResource`
  whose `T` could not be inferred, so every consumer lost its element type).
- Two files that ship user-facing strings were outside the brand-surface
  ratchet's scan list, which is why the two leaks above reached a release. They
  are scanned now, and the ratchet is verified to fail on a regression in them.

## [0.5.1] - 2026-09-26

**The same content as 0.5.0, published cleanly.** 0.5.0 exists on the registry because
two publishes of it were launched by mistake and raced; npm accepted one and staged the
other, which burned the number for the wrapper. The release moved to 0.5.1, and
`publish.ts` now takes an exclusive lock (`dist/.publish.lock`, an atomic `mkdir`) so two
publishes cannot run at once — a mistake that cost a version number is now a script bug
instead of an operator one.

## [0.5.0] - 2026-09-26

**The product surface says our name, everywhere a person can see it — and the trees that
were never ours are gone from the repository.**

### Changed — the private-isation, audited rather than assumed
- **Environment variables**: every knob now has a `GLASSPANE_HARNESS_*` name, resolved in
  one place (`flag/flag.ts`'s `read()`). The old `OPENCODE_*` names still work — a
  private-isation that silently ignores a setting someone already exported is its own bug.
- **What we call ourselves on the wire**: `X-Title`, `X-Source`, `User-Agent`,
  `originator`, `HTTP-Referer`, the MCP client name and the OTLP service name all say
  `glasspane-harness`. Previously a request to OpenRouter, Cerebras, Kilo, Vercel,
  NVIDIA, Zenmux or a user's own web fetch identified itself as opencode.
- **The user's own files**: the database is `glasspane-harness.db` (with a one-time rename
  of the old file — losing someone's session history would be the worst possible
  private-isation bug), the log is `glasspane-harness.log`, and the server's basic-auth
  default username is the product's rather than `opencode`.
- **The LAN**: the mDNS default is now actually `glasspane-harness.local`. The help text
  was rebranded in 0.1.0 while the value was not, so the product advertised one domain and
  announced another.
- **The CLI**: `scriptName` is the product's, which is what `--help` and usage errors print.
  The ACP integration (what editors launch) no longer advertises a login that cannot exist.
- **The built-in skill** is `customize-harness`, and its body documents this product's
  config paths. It is injected into every session, so its text is product surface.
- **No third-party `$schema` is written into your config any more.** Upstream injected
  `https://opencode.ai/config.json` into every file it opened; the first line of a user's
  own config was somebody else's URL.
- First-party remnants removed from the TUI and web app: the Zen upsell and its link, the
  "free models" claims, the paid-plan nudge, the recommended tags, the provider ordering
  that floated the house gateway to the top.

### Removed — trees that were never this product
`packages/console`, `packages/enterprise`, `packages/stats`, `packages/web` (the docs
site), `packages/storybook`, `packages/containers`, `packages/function`,
`packages/identity`, `packages/slack`, `packages/docs`, plus `artifacts/` (an upstream
promo-video project for a model release), `.vscode/`, `install/` (the upstream
`opencode.ai/install` script), `nix/` + `flake.*`, `sdks/vscode` (an editor extension),
`infra/` + `sst.config.ts`, `perf/`, `github/` (the upstream bot action) and
`screenshot-uk.png`. None of them were referenced by shipped code — measured, not assumed.

**Kept on purpose**: `packages/desktop` (product surface, batch 2), `patches/` (bun
applies them at install time), `specs/` (the design record of the code we maintain).

### Gates
- `brand-surface` gained five rule classes — first-party gateway, wire identity, foreign
  schema writes, product file names, and removed trees — with a short explicit allowance
  list for the three places that legitimately *read* an old name (the database migration,
  the legacy config file names, a stored theme id).
- The ruler's own blind spot was fixed: `fork-diff` used to treat gitignored build output
  as "a file that exists but was never committed", which is the same class of false
  positive as the import bug it was built to catch.

## [0.4.0] - 2026-09-25

**A complete programming agent with the GlassPane kernel fused in — and no account to
log into.** This release is mostly the removal of a first-party vendor surface, plus the
npm and docs work that goes with it.

### Added
- `docs/models-and-keys.md` — the model catalog and the three ways to supply a key
  (env var, `{env:NAME}` config template, TUI `/connect`). "Bring your own key" is now the
  documented model story, not an accident.
- `docs/release.md` — the release runbook, including the **npm trusted-publisher setup**
  for all three packages (the field values are pinned to what `release.yml` presents:
  owner `jingzhao-l`, repo `glasspane-harness`, workflow `release.yml`, environment
  `release`). Until that is configured, CI cannot publish; the manual path is documented
  too.
- **npm READMEs.** 0.2.0's npm pages were a bare version string. The wrapper now ships the
  product README (EN + 中文) and each platform package ships a short README that says what
  the binary is and points at the wrapper. `publish.ts --dry-run` fails without them, so a
  README-less tarball cannot ship.
- The publishing jobs carry `environment: release`, which is both the value npm's trusted
  publisher must match and a place to require a human reviewer.

### Changed
- **This repository's own project directory is now `.glasspane-harness/`** (was upstream's
  `.opencode/`): the agent, command, skill, glossary and theme config that opencode used to
  develop itself now lives under the product's own name, so the repo dogfoods the rename.
  `.opencode/` is kept as a *read-only compatibility target* in a user's project — a
  `product-surface` assertion fails if a `.opencode/` reappears at the root **or** if the
  compat read is deleted.
- The repo's dev config file is `glasspane-harness.jsonc` (the name the product reads
  first).

### Removed — the first-party account surface (BYOK instead)
- The `opencode` first-party provider is filtered out of the model catalog.
- `auth login` / `logout` / `switch`, the `/org` TUI command and the console-org dialog.
- `/experimental/console*` server endpoints, the console-managed-provider config state,
  and the provider dialog's "managed by console" branch.
- Session sharing to opencode's cloud: the share modules, share/unshare endpoints, the
  `share` and `autoshare` config keys, the TUI `/share` command and the web app's share
  affordances (kept in the component shape, permanently off, one line to flip).
- The local `account` / `account_state` tables are no longer managed by the schema. The
  tables remain in existing databases — no destructive migration; the rows are inert.
- `import <share-url>` no longer fetches console shares; import a local JSON export.

Everything else in the catalog is untouched: Anthropic, OpenAI, Google, GitHub Copilot,
Bedrock, Azure, OpenRouter and the rest still ship, unlocked by your own key.

## [0.3.0] - 2026-09-25

**macOS-only, and the npm distribution says so.** The GlassPane engine, its four macOS
permission seats and the whole evidence pipeline exist only on macOS, so the product is
macOS-only (owner decision). The npm side enforces it rather than describing it.

### Changed
- The npm distribution is macOS-only: the wrapper declares `os: ["darwin"]` /
  `cpu: ["arm64", "x64"]`, so `npm install` on Linux or Windows is **refused by the
  package manager with a reason** instead of downloading a binary that cannot run. The
  target matrix in `product.json` is now exactly the two macOS targets.
- `scripts/install.ps1` (Windows one-click) is **removed** — the POSIX installer is the
  only one, and on a non-macOS host it says "macOS-only is a decision, not a missing
  port" and exits.
- The Linux/Windows/Intel-baseline platform packages published before this decision are
  **deprecated on npm with the reason attached** (they cannot be unpublished; a
  deprecation that explains itself beats a package that still installs).
- The release lane builds the two macOS targets on `macos-14` / `macos-13`.

### Added — npm infrastructure
- `publish.ts --dry-run`: packs every artifact and validates its shape **without
  touching the registry** — bin targets exist inside the tarball, the platform binary is
  present and executable, the wrapper's `optionalDependencies` match `product.json`'s
  target matrix, and the wrapper's `os`/`cpu` agree with the product's platform block.
  Wired into the fork's CI, so a broken package shape fails a PR instead of a release.
- `verify-published.ts`: "published" is not "works" — installs the **published** tarball
  into a throwaway prefix, runs `--version`, and confirms the embedded web app is served
  by that binary. Runs as the release lane's final job; on a non-macOS host it asserts
  that npm refuses the install.
- Wrapper metadata completed for its npm page: `engines.node`, `funding`,
  `publishConfig` (access + tag), `sideEffects`, and a dist-tag policy —
  `latest` for stable, `next` for anything on a non-latest channel, so a preview can
  never be installed by `npm i -g glasspane-harness` by accident.
- The npm publish/deprecation policy is recorded in `product.json` (`npm` block) so it
  travels with the code instead of living in someone's head.

### Docs
- READMEs, `docs/install.md`, `docs/index.md` and `docs/troubleshooting.md` state the
  platform boundary up front, with the npm `EBADPLATFORM` case in the troubleshooting
  table.

## [0.2.0] - 2026-09-25

The companion product surfaces, brought in as first-class citizens (owner decision:
"那几个配套产品面还是需要的"), plus the release infrastructure around them.

### Added
- **Web app embedded in the binary again** (upstream default, and what iterate-harness
  does with its dashboard): `glasspane-harness serve` serves the browser UI from the same
  process. `--skip-embed-web-ui` still produces a CLI-only build, and a build without the
  bundle starts and says the UI is absent instead of failing.
- Product README (EN + 简体中文) rebuilt in the iterate-harness shape: language switch,
  npm-downloads / version / CI / license / stars badges, product-surface table, the
  problem statement, quick start, docs index, and the attribution block.
- `assets/logo.svg` + `assets/banner.svg` (SVG on purpose: the brand stays diffable text).
- `docs/` (six pages: index, install, tools, evidence, migrate-from-opencode,
  troubleshooting) — the in-repo canonical documentation the READMEs link to.
- `CHANGELOG.md` for the product (this file), `SECURITY.md` for the product (upstream's
  pointed at upstream's disclosure process).
- GitHub issue templates (bug with a mandatory `gp_probe_status` payload, feature with an
  "which evidence does it rely on" question) and a PR template carrying the line's
  checklist (fork-diff record, product.json first, brand gate, fixed points with reverse
  controls, stated boundaries).

### Changed
- The docs link checker now covers the product's documents too (24 files, 212 links): a
  dead link in the product README is the same red as one in the repository's.
- The M1 rows in `FORK.md` / `SYNCLOG.md` no longer hard-code a tool count — the count was
  a claim the checker could not verify, and this line's doctrine is "read it from
  `hello.capabilities`, never copy it".

### Not in this release
- The docs **site** (`packages/web`) is still upstream's Astro/Starlight tree: it builds
  and is kept for lineage, but its content is not yet our documentation. Until that is
  done, the canonical docs are `docs/` in this repository — the docs site is marked
  `not-yet-ours` in `product.json` rather than being quietly presented as finished.
- Electron desktop app (second batch; needs signing and notarisation accounts).

## [0.1.0] - 2026-09-25

First public release of the private customisation. Everything below is a decision that
used to be upstream's, recorded so the next release notes can be diffed against reality.

### Added
- Product identity: `glasspane-harness` (binaries, `gp-harness` alias, npm wrapper
  `glasspane-harness` + 12 platform packages, user agent, mDNS name, `~/.glasspane-harness`
  state root, `glasspane-harness.json(c)` config names with upstream names kept as legacy
  fallbacks, default TUI theme, basic-auth default user name).
- GlassPane's native `gp_*` tool surface: `gp_probe_status`, `gp_attach`, `gp_observe`,
  `gp_act`, `gp_diagnose`, `gp_last_evidence` — capabilities read from the running engine,
  never hard-coded.
- Evidence discipline: hash-chained decision log (op id ↔ entry hash) written through the
  vendored `@iterate/kernel`; a compaction hook that re-injects the session's evidence
  anchors; tool-surface ratchets that keep judgement in the engine (no threshold, pixel
  verdict or pass/fail synthesis in a shell).
- Session-flow evidence rendering in the TUI (engine refusal vs engine answer are visually
  distinct; the row model is a pure function the fixed points pin).
- Product surfaces: CLI + TUI, the **web app embedded in the binary**, the docs site and
  in-repo `docs/`, SDKs shipped with the tree.
- One-click installers (`scripts/install.sh`, `install.ps1`): npm first, GitHub release
  asset as fallback, verification step, and the GlassPane-daemon prerequisite spelled out.
- Fixed-point tests for every module (M1–M5), plus two runtime probes: E7 (decision chain
  against bytes the engine wrote) and E8 (the compaction hook against a real host).

### Changed
- Project configuration directory is `.glasspane-harness/`; `.opencode/` is still read
  (legacy), and when both exist the product's directory wins the merge.
- Web UI embedding is the default again (`--skip-embed-web-ui` opts out).
- `glasspane-harness --version` reports the manifest's version verbatim (it used to
  inherit upstream's release-time patch bump and print a version that was never built).

### Removed (on purpose, recorded)
- The hosted console / enterprise / stats stack and its SST infrastructure — a private
  harness has no organisation-and-quota back office.
- Paths that would have executed or published *another project's* assets: the upstream
  docker/AUR/Homebrew publishing tail and the `opencode.ai/install` self-upgrade.
- The Electron desktop app is not shipped in 0.1.0 (second batch; needs signing and
  notarisation accounts). It remains in the tree as lineage.
