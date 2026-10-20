# GlassPane 主仓 · 每日审查记录 2026-10-20

本轮为无人值守每日任务（`tools/prompts/daily-glasspane-main.md`）。开工 HEAD：`c2538f1b`（本地 main，落后 origin 一笔）；
fetch 后基线 `24c27904`，收口基线 `origin/main = b9fd7bc0`（harness 线那两笔：0.9.1 发布 + 3b 台账）。工作树在
`/Volumes/Eng-Dev/.worktrees/gp-daily-20261020`（分支 `daily/main-20261020`），原因是**另一条线正在飞**：
`.worktrees/gp-019` 有 6 份 `harness/glasspane-harness/**` 未提交改动（07:26–07:31 仍在动），主仓常被并行会话占用。
快照：`/var/tmp/glasspane-main-check/20261020/`（16 份改前文件 + `sha256` 清单）。

## 1. 上一轮没收口的活（判据只用文件字节）

| 活 | 判定 | 依据 |
|---|---|---|
| `v1.17.0` 签名 tag 已打、Release 与 npm 两条通道未跑（10-19 记在 CHANGELOG「发布状态」与 specs §6） | **真未落地，且交接命令本身不可执行** | `gh release list` 最新是 `v1.16.4`，`gh release view v1.17.0` 无此发布；`npm view glasspane-mcp version` = 1.16.4。§6 那条 `gh run rerun … --failed` 的前提（"harness 落下 0.8.3 之后就能接着跑完"）**不成立**：`assert-ci-green` 问的是 tag 落点那笔 commit 的 `ci.yml`，而那笔 commit 上 `harness/tools/release-artifact.mjs` 永远红——它比较的是**被检出的那棵树**里的 `harness/glasspane-harness` 子树与 `product.json` 所写版本（当时 0.8.2）的**已发布 tag** 是否同一份字节，已发布的 tag 绝不移动，所以那个 sha 的 CI 事后转不了绿。harness 线 10-20 自己也在其台账里记下同一件事（"旧 sha 的 CI-green 事后转不了"）。 |
| 本地 main 落后 origin 一笔（`24c27904`） | 已落地 | `git merge --ff-only origin/main` 后 `git rev-list --left-right --count HEAD...origin/main` = `0 0`。 |
| `gp-019-pin`（worktree，sha == `origin/main`） | 无未合并提交，是那条线的工作台 | `git rev-list --count main..gp-019-pin` = 0；它的 6 份未提交改动全在 `harness/**`，**本轮一行未动**（见 §7）。 |
| `gp-harness-daily-20261019`（worktree，干净，== 当时 main） | 已落地 | `ahead=0 behind=0`；10-19 那批已随 main 进去。 |
| `split/20261018-closeout`、`split/20261018-step0b`、`split/check-20261018`、`split/glasspane-harness`（本地） | subtree 搬运产物，不参与"未落地"判定 | 提示词第 2 条明文：`split/*` 内容由 tag 与 split 仓承载。 |
| `daily/main-*` 本线分支（远端） | 无 | `git branch -r --list "origin/daily/main-*"` 为空。 |

**本轮对那条旧活的处置**：不试图让 `v1.17.0` 变成一次发布（做不到，见上），改为**取新号 1.18.0** 并把本轮全部修复随它发出；
`v1.17.0` 作为一枚"打了但永不发布"的锚点**如实记进 CHANGELOG 与 §3**（与本仓 `v1.16.2` 空号同一处理方式），并新增
`scripts/assert-tag-ready.mjs` 把"tag 打在红树上"这件事变成打 tag 之前就拒。

## 2. 本轮发现与处置（发现 44 条缺陷，终态一律"已修 + 有测试 + 进 main"；表内 47 项处置，多出的三项是把缺陷机制化的新增闸）

审查面：六条独立泳道（mcp-shell / Swift 引擎 / installer+updater+install.sh / scripts+workflows / 信任边界安全 / UX 与功能缺口），
每条都由主代理回代码复核后才动手；复核后**主张不成立**的两条写在 §4（不计入 43 条）。

| # | 层 | 位置 | 失效模式（用户/agent 实际读到什么） | 处置 |
|---|---|---|---|---|
| 1 | TS | `mcp-shell/src/update-state.ts` parse 之后 | `update-state.json` 内容整份是 `null` 时 `JSON.parse` 不抛，下一行 `parsed.status` 抛 TypeError → `gp_diagnose` 回一条壳内错误，**daemon 真正的诊断被丢掉** | 顶层不是对象就按"读不出的状态"拒，话术与既有 `unreadable` 同口径；`test/daily-20261020.test.mjs` |
| 2 | TS | `mcp-shell/src/engine-client.ts:1190` `settleFromFrame` | 一帧 `{"result":null}` 被判成成功 → 工具回文本 `"null"`、`isError:false`，即"什么都没答"被读成"通过了"。今天 Swift 发不出这帧，但这根 socket **无 peer 鉴权**，任何同用户进程都能写 | `result === null` 与"没有 result 键"同判拒；两条用例（新形状 + 旧形状对照 + 真结果仍过） |
| 3 | TS | `mcp-shell/src/tools.ts` `describeFetchFailure` | 映射过的证据读失败若没有 text 段，会把一句裸文本塞进 `gp_recent_reports` 的部分报告——违反"错误恒三字段" | 该支改成 `formatToolError(GP_E_INTERNAL, …)`；用例核三字段 |
| 4 | TS | `mcp-shell/src/project-registry.ts` 写侧 | `gp_project_set` 永远写 `<systemHome>/.glasspane/projects.json`，从不看 daemon 在 `hello` 里报的 `stateRoot`（该键 1.15.0 起就有）→ 对着 `--state-dir /tmp/sandbox` 的 daemon 注册，改的却是开发者**真注册表**（与当年 71→2 同一类） | `daemonProjectsPath(daemonStateRoot)` / `projectsPath` / 三个公开操作 / 文案一起接这个值；`engine-client` 捕获 `hello.stateRoot`，工具层把 `context.engine.reportedStateRoot` 传下去；无报告时文案明说"这不从这儿知道" |
| 5 | Swift | `EvidenceStore.read(operationId:)` | 只按**请求的 id** 拼路径、解码即回，从不比 `pack.operationId`：把 `op_A.json` 复制/改名成 `op_B.json`，`gp_last_evidence{op_B}`、档案扫描与 HTML 报告都把 A 的测量当成 B 的"已验证" | 读侧比 id，不符即 nil（→ `GP_E_NO_EVIDENCE`）并记一条 error；用例真写档案、真改名 |
| 6 | Swift | `glasspane-settings/EvidenceTabView.swift:261,478` + `LocalArchive.swift` 过滤器 | 半修：详情页早已改成 `EvidenceCopy.contamination(contaminated:breakerReason:)`，列表那侧（芯片、结论标题、过滤器标题）还只看 `contaminated`。`--no-c33` 或 tap 建不起来的 daemon 每一行都写"有人同时操作"——引擎刻意拒绝做出的测量被面板替它声称 | `EvidenceSummary` 带上 `breakerReason`（`from(pack:)` 填 `circuitBreaker.reason`），列表芯片/标题走同一判据，过滤器标题改"污染判定"（它按结论筛）；用例含看守/未看守/判净三臂 |
| 7 | Swift | `DebugCapabilityProbe.Snapshot.granted` + `PermissionStatus.Report.status` | `granted = launch == .ok \|\| attach == .ok`，而这张卡的名字就是"让调试器附加到进程"。`engine/smoke.md:218-224` 的真机负载 `launch:ok / attach:spawnFailed / granted:true` 被点成 **可用（实测）**：一半的答案代答了另一半——同文件自己的注释把这叫做被禁止的折叠 | `granted` 只认 `attach == .ok`（拒绝仍优先）；`Report.status` 以两臂实测词为准，旧负载的或值不再点亮；`--check-developer-tools` 的 0/1 随之改变触发条件（数字集合未动 → minor 判据，见 §3）；改掉 10-19 那条把或值钉成预期的断言并写明理由 |
| 8 | Swift | `SocketServer.bindAndListen()` | 叶子是符号链接时 `bind()` **顺链成功**：监听点建在别处，`chmod 0600` 与退出时 `unlink` 都打在链接另一头，而 `SocketDirectoryRule` 从没量过那个位置。两条既有守卫只在 `EADDRINUSE` 那一支跑，看不见这个形状 | bind 之前先 `DaemonProbe.nameIsClearableSocketName`；用例真建悬空链接，断言回 `nameOccupied` 且另一头什么都没生成 |
| 9 | Swift | `StateRoot.tightenPermissions` | `stat`/`chmod` 跟符号链接：`--state-dir` 指到一个链接时，这一趟**先把目标目录改成 0700、里面的档案改成 0600**，随后才在 bind 处拒——与同文件那句"要改任何东西的资格"自相矛盾 | 根与档案目录都用 `lstat` 判叶子；符号链接即刻返回缺陷且不 chmod；用例断言目标模式原样 |
| 10 | Swift | `Dispatcher.processFrame` 的 `catch` | 逃逸的非 `GPError` 直接把 `\(error)` 写进 message：Foundation 的 `NSError` 文本含绝对路径（状态根、档案目录、home），而这一帧任何持 socket 的同用户进程都收得到（SECURITY §2.3 明说 loopback gateway 的可达面） | 原始文本只进 daemon 日志，帧里给"类型 + 那句它不发路径"；message 有界 |
| 11 | Swift | `EvidenceReportGenerator.doubleText` | `String(format: "%g", value)` 按**用户 locale** 解析：逗号小数机器写出 `changedRatio=0,25`，而 TS 那份永远 `0.25`；对 `kernel/fixtures/report.ok-01.*` 的字节比对只是恰好测试机是小数点 locale 才一直绿 | 显式 `en_US_POSIX`；用例含"另一 locale 确实会变"的对照 + 写法闸（任何机器都红得了） |
| 12 | Swift | `glasspaned/main.swift` 参数解析 | `--key=value` 只有 `--state-dir=` 与 `--socket-path=` 两支手写分支，其余取值开关（`--older-than=7`、`--request-permission=x`、`--probe-socket-path=`…）一律"unknown argument" + 64 | 入口统一裁一次 `=`，删掉那两支特例；所有取值开关同形；用例打在真二进制上（两条具名校验语 + 不认识开关的对照） |
| 13 | Swift | `--guide-screen-permission` | 打印"Screen recording is still not granted…"之后 `exit(0)`；同文件 `--request-permission` 却按读数退 1。按 rc 分叉的脚本把一次没批下来的引导读成成功 | 退码跟着这次读到的席位（0 仅 granted），`--help` 写清；`--check-screen-permission` 那支维持"打印即 0"不变 |
| 14 | Swift | `--grant-accessibility` 的 `--help` | 只写"onboarding 提示"，漏掉 `GP_E_AX_UNAVAILABLE` 那条 remedy 花整段讲的两个事实：它授的是**跑这条命令的进程**的席位，且**阻塞至多 300s** 等人——对以 agent 为主用户的产品就是一次挂死 | help 补上作用对象、阻塞时长与"要 daemon 的席位请用 `--request-permission accessibility`" |
| 15 | Swift | `--check-developer-tools` 的 `--help` | 写"P6 §7"与"exit 0 = granted"，前者是内部规格号，后者在新判据下不再等价 | help 去掉章节号，改说"0 仅当 attach 那一臂实测 ok"，并说明启动臂单独呈现 |
| 16 | Swift | `main.swift --active-project` 的 `--help` | 声称"没有任何协议方法接受它"，而 `attach` 就接受 `projectId` 且真的成为 `EngineCore.activeProjectId`——同一份 help 下一句还让你去 `gp_attach` | 改成"本命令不改变任何东西；路由由 attach 承担" |
| 17 | Swift | `ProtocolErrors.remedy(for: .methodNotFound)` | 手抄 13 个方法名。`capabilityWireNames` 存在的原因就是这份表以前抄漂过（报出线上不存在的 `probe`），而这一处没有任何读者会报错 | 由 `EngineMethod.allCases` 派生；用例逐格核 |
| 18 | Swift | `EngineCore` 的 `GP_E_NO_OPERATION` remedy、`Classifier` 的 T8 anomaly、`DebugCapabilityProbe` 的 `note` | 三处**发出去的**字符串里带 `(P0 spec §3.3)` / `(windowed attribution §2.3)` / `（P6 §7）`，agent 读到的是自辩脚注 | 删括号，规格出处留在注释里；用例扫全部 `GPErrorCode` 的 remedy |
| 19 | Swift | `PanelDaemonCommandContractTests.panelInvocations()` | 契约闸只刮 `ConsoleModel.swift`，看不见 `SettingsModel.swift` / `PermissionStatus.swift` / `RecipesTabView.swift` 里的另三条一次性命令 → 那三处漂了也"全通过" | 刮取范围扩到那三份文件，并加"必须看得见 `--permissions`/`--check-developer-tools`/`--recipe-validate`"的空转闸 |
| 20 | Swift | `glasspane-settings/RecipesTabView.swift` 三枚禁用控件 | 校验中三枚变灰，而 `.help` 说的是启用时做什么，清空那枚连 help 都没有：禁用理由与下一步都看不见。同页 `ProjectsTabView` 已有正确做法 | 加在途那一行（`gp-recipe-in-flight`）与清空的 `.help` |
| 21 | Swift | `EvidenceTabView` 「刷新」 | 同上：`disabled` 时 `.help` 仍写"重新扫描…"。旁边那枚「档案目录」已经做了状态感知 | `.help` 改状态感知，禁用时给理由与"等这一趟回话" |
| 22 | Swift | `ConsoleTheme.PathRowView` + `ProjectsTabView:237-239` | 值是占位句（"未配置"）时仍画复制按钮：按下去把"未配置"三个字送进剪贴板，而按钮说明写着"复制路径"。另外三枚按钮共用缺省标识 `gp-copy-path`，自动化选不中 | 加 `isPlaceholder`，占位行不给按钮；三枚各给稳定 `identifierKey` |
| 23 | 门禁 | `scripts/make-release-archive.mjs` | 排除表按**路径前缀**匹配，`harness/` 改名/移动后这条规则会"armed 而空"：签名归档静默涨 ~64 MB，打包与 `--verify` 双双退 0。`--verify` 也只证明"该有的有"，从不证明"不该到的没到"（tar 全在单一顶层目录下，锚在 `^harness/` 的写法会空过） | 新增导出 `inertExclusions`，生产入口 `main()` 用真 `EXCLUDED_PREFIXES` 拒惰性前缀；`verifyArchive` 增加 `leaked` 判定并在 `--verify` 里拒；用例含真树命中与两种反例 |
| 24 | 门禁 | `scripts/assert-test-count.mjs` | 两种 runner 的计数与"两种都得出声"跨文件**合池**：`engine/probe` 那条线跑 0 个用例也能靠 engine 日志保持绿。另发现单数行形不匹配（`1 suite` / `1 test`）会把真跑过的套件读成零 | 逐份日志要求各自 ≥1 条，池化和只用于下限；正则收单复数；用例真起子进程跑那份脚本 |
| 25 | 门禁 | `scripts/check-doc-links.mjs` | 每支都 `existsSync` 过滤登记文档：把 `MAIN_DOCS` 整体改名会让这一格打 `文档 0 份 … OK` 并退 0（零条用例算绿，本仓已栽过两次同形） | 登记而不在盘上的文档是**问题**；一份都不在时判红；对照臂跑真仓库保证不是永远红 |
| 26 | 门禁 | `.github/workflows/release.yml` target 复核 | `if [ -n "$TARGET_READ" ] && …`：GitHub 回空串时整条判据短路，下面那句"已核实"照打——把"读不到"当成"对上" | 先验形状（非 40 位十六进制即拒），再比；"已核实"移到判定之后 |
| 27 | 门禁 | `ci.yml` / `set-version.mjs` / `version-sites.mjs` 的自述数字 | `ci.yml` 写"swift / bridge / kernel / … 这 10 个 job"（`kernel` 那格 10-18 已退役，实测 9）；`set-version.mjs` 写"三个 lockfile"（`LOCK_DIRS` 是两份）；两处写"10 个声明位点"（`SITES.length` = 12）。同仓 `ITERATE.md` 明令不许写死这个数 | 数字改为派生或删去；`check-workflows.mjs` 已实测报 9 job |
| 28 | 文档 | `README.md:499` / `README.zh-CN.md:433` | 两份都写发布物带 `SHA256SUMS.txt`；真名是 `SHA256SUMS-<ver>.txt`（updater 就按那个名字要）。同处"harness 占已跟踪字节 87.8%"复算实为 86.91% | 名字带上版本占位、数字改为 86.9% 并注明 2026-10-20 实测与复算方法 |
| 29 | 文档 | `README.md:427-430` / `README.zh-CN.md:369-371` | 排查段落教读者用 `glasspaned --permissions` 验证"服务活着"——那条命令量的是**调用进程自己**的 TCC 席位，一个 socket 都不碰（它自己的 `--help` 就这么写）。文档在指导一次假测量 | 改成向 socket 问 `hello`（`nc -U`），并写明 `--permissions` 答的是另一问题 |
| 30 | 发布链 | `install.sh:18` 钉的 tag 与已发布内容不一致 | 钉 `v1.17.0`（tag 在，Release 不在，registry 只到 1.16.4）→ 今天跑一键安装的人装的是**没有任何一条 CI 绿过的树**；`npx glasspane-install`（1.16.4）装的是另一份。README 那句"两条一键命令拿到同一份源码"因此为假 | 本轮取 1.18.0 并把两条通道跑完（§5）；`installer/test/install-sh.test.mjs` 只比"钉的号 == 版本线"，看不出钉了个没发布的号——因此补 §31 那道 tag-ready 前置，并在 CHANGELOG 记下这处不可加的事实 |
| 31 | 发布链 | `scripts/assert-tag-ready.mjs`（**新增**） | 链子上没有任何一环执行"push → 等 CI 绿 → 再打 tag"：`check-version` 只证明树内一致，`assert-ci-green` 只在 tag 已存在后被问。于是 10-19 敢把 tag 打在红树上，造出一枚永远发不出去的锚点 | 新脚本 + 判据复用 `assert-ci-green.mjs` 的 `judgeCiGreen`（两处一套口径）：tag 形状与是否已存在、HEAD == `origin/main`、该 sha 的 CI 最新一条必须 completed+success；读不到仓库名一律判 2，不白拿绿。9 条用例逐条能红 |
| 32 | updater | `updater/lib/policy.js` 的 `downgrade` 分支 | 机器跑的比已发布还新时回 `status: 'up-to-date'` + exit 0，`reason` 说的是真话但那个词会被读成"这台机器在发布线上"（今天正是这形状） | 判据不成立的部分见 §4；成立的部分是把两种读法分开：reason 现在明说"`up-to-date` 只表示没有更新的发布物，不表示这台机器在发布线上"；用例走真 `decide()` |
| 33 | updater | `updater/lib/signature.js:118` + `installer/cli.js:88` 的 pin 住在发布物里 | `runtime.js` 把 `updater/`+`installer/` 整份换掉，所以一次 `--consent unsigned-release` 放行就同时替换了"验签用的 pin"：之后每个攻击者发布都对自己的 pin 报 `verified`，`authorshipNote` 那条常驻警告还会自己消失 | 新增 `updater/lib/trust.js`：`<stateRoot>/trust.json`（0600，由**正在运行**的代码写，绝不从暂存树取），`apply` 在构建/打包/换版之前比暂存树声明的指纹，不同即 `signature-anchor-changed` 且无可绕过旗标——换钥匙只能由人改那一个字段。TOFU 边界如实写在文件头与 §6 |
| 34 | updater | `updater/cli.js:122` 收 `--hour/--minute` 却只有 `enable` 读 | `updater check --hour 3` 退 0 而什么都没动——本文件对 `--consent` 未知值判"grants nothing"的同一条规矩被自己违反 | 非 `enable` 一律拒并给出该跑的那条；用例含 5 条命令的反例 + `enable` 的对照 |
| 35 | updater | `--state-root` 存在但 `USAGE` 不写 | installer 渲染的 plist 用的就是这个拼写（`launchd.js` 的 `daemonFlag`），读者在帮助里找不到它 | `USAGE` 补这一行并说明它是同义拼写（不删它，删了会让已渲染的 job 失效） |
| 36 | updater | `policy.js:131` / `source.js:269` 的 remedy 插值不加分号 | `updater apply --state-dir /Users/a name/…` 与 `export NODE_EXTRA_CA_CERTS=/Users/a name/…`：家目录含空格或中文名时，那条被面板与 `gp_diagnose` 原样印出来的命令作用于被裁断的路径。同子系统 `apply.js:1541` 已有正确写法 | 两处加引号；用例把"含空格路径整条被引住"钉住 |
| 37 | updater | `updater/test/release-archive.test.mjs` 夹具模式反了 | 夹具把 `mcp-shell/dist/index.js` 写成 0755（真 esbuild 产物是 0644，可执行位是 `npm install -g` 补的），又把 `installer/cli.js` 写成 0644（git 记 100755）。它断言的是自己发明的形状——与原 symlink P0 同一类"交付形状没被量过" | 夹具改回真形状，断言换成"归档原样带着两者的模式"，端到端仍跑 `npm pack` → `npm install -g` → 真执行那条命令 |
| 38 | installer | `install.sh` 在非 TTY 时替调用方补 `--no-prompt` | 文档那条一键命令永远不是终端 → 覆盖已有 `.app`、bootout 已加载的 launchd 作业、杀掉在跑的 `glasspaned` 三件事**不问也不说**；同文档的 `npx glasspane-install` 是会问的。两道入口两种同意，差别不可见（`installer/cli.js` 的 finding 11 三档设计因此被入口脚本废掉一半） | 不再代答：非交互走 installer 自己的"跳过并打印命令"档，脚本另打一句说明这一趟会跳过、以及放行的写法是 `… \| sh -s -- --no-prompt`；用例真跑 dry-run 断言将执行的命令里没有那个 flag |
| 39 | installer | `install.sh` 没有平台闸 | README 两份都写"macOS 14+"，脚本却不检查：Linux 上先付完整那次 5600 文件 clone，然后在 installer 里被一句"未找到 open"间接发现装不了——正是 Node 预检被挪到 clone 之前要避免的那种白付 | `uname -s` 非 Darwin 即在 clone 之前拒，且说清"本轮没有 clone、没有写入任何东西"；用例用 `uname` 桩跑出拒绝，并用本机做放行对照 |
| 40 | installer | `installer/cli.js:1779` 那句 `curl \| sh` 的 `$?` 主张 | usage 明说"管道退出码就是这里的结论"。实测 `curl -fsSL http://127.0.0.1:1/nope.sh \| sh` → curl 退 7、**管道退 0**：一次什么都没装的运行被报成成功 | 那句话改成事实（exec 只在脚本自己跑完时透传；curl 失败/断流时不是），并给出分步写法；用例把"curl 必须失败而管道必须退 0"这条实测形状钉住 |
| 41 | installer | `preflightIssues` 四行只说缺什么 | `未找到 npm` / `未找到 git` / `无法解析 Node.js 版本（执行失败）` / `未找到 open` 全靠汇总那句通用的"修复后重新运行即可"（六行里只有 swift 那条自带 remedy）；那句三元还是永远为真的死表达式 | 每行自带可执行动作；死三元删掉 |
| 42 | installer | `cli.js:1865` 对外文案漏内部标识 | 引导第 4 条打印"`4. entryName 核对：…`"——变量名进了用户界面 | 改"主体名核对"；用例扫源码钉住 |
| 43 | 发布链 | `.github/workflows/release.yml:222` 的读回那一步 | `gh release view … --json tagName,isDraft,latest,assets,targetCommitish` 里 **`latest` 不是 `gh release view` 的字段**：gh 直接 `Unknown JSON field: "latest"` 并列出它答得出的 18 个，整步 exit 1。v1.18.0 那一格因此红，而红的位置最难看——发布对象已建、四件资产已挂，唯独"对外了吗"这一问没被回答（这一步是 10-19 那批引入的，本轮第一次跑到）。 | draft/assets 仍由 `gh release view` 读，latest 改由 `gh api repos/<repo>/releases/latest` 读回并与本次 tag 比——那个端点才是 `install.sh` 与 updater 走的路；三条判据各点名自己的失败对象。**本机已用改后的那七行对 `v1.18.0` 真跑**：`draft=false`、`assets=4`、`target=80b81f18…`、`latest=v1.18.0` |
| 44 | 门禁 | `updater/test/scripts-check-workflows.test.mjs:241` 那条"读回 draft/latest/资产"的判据 | 写的是 `--json[^\n]*latest\|latest`——第二个分支只要 `latest` 这个词在步骤里出现过一次就算过。词一直在（`--latest` 本身、那句打印、注释），于是它**绿着放过了自己正要守的那次事故** | 三个量各给形状判据（`--json` 里同时有 isDraft 与 assets、有一行 `gh api …/releases/latest`、有 `[ "$LATEST" != "$REF_NAME" ]`），再加一条"读回的字段表里不许出现 `latest`" |
| 45 | 门禁 | `scripts/check-workflows.mjs`（**新增规则**） | 一个 gh 答不出的字段不是"慢一点的检查"，是"根本没跑的检查"，而链子上没有任何一环在推送前问过这件事 | 用 gh 自己 2026-10-20 列过的那份字段表核对每行**可执行的** `gh release view --json …`；`#` 行不判——`release.yml` 正是用注释记着这个错误，把散文当缺陷报出来得到的修法是删注释而不是改命令。三档 `--self-test` 对照：坏字段被抓到 / 真字段沉默 / 只在注释里的坏字段沉默 |
| 46 | 文档 | 全仓 markdown 表格里有 **13 行**被未转义的竖线撑破：本轮台账自己 2 行（`launch == .ok \|\| attach == .ok`、`… \| sh -s -- --no-prompt`），已归档的规格 11 行（`P1:95` 那一行是真多出一列、 `P2/P3×3/P4` 的 `degradation\|` 前缀、`P6:39` 的 `<addr\|expr>`、`P6:216` 少一格、10-19 记录里 4 行的 `\| remedy:`／`curl \| sh`／`O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW`／`(granted \| notDetermined)`） | 源码里那几行看着整整齐齐，**渲染出来**却被切成多一格：那一行的"处置"跑到别的列里去，而字一个没少， 所以没人看得出来。四道既有文档判据（死链／锚点／双语／可复算主张）对此完全无感——文档还是那份文档， 链接照样通 | 13 行逐行改正：格内的竖线一律写成 `\|`；`P1:95` 把第 4 格并进第 3 格（那是真的多一列，不是转义问题）； `P6:216` **只补一个空格子**——不替 10-19 那位作者发明"验证"栏该写什么。回扫全仓 417 张表 → 0 张不齐。 过程中我自己错过两处，按形状记下来：第一版把 `x \|\| y` 的格数算成 4（真答案是 5，`\|\|` 中间还出一个空格子）， 断言因此红在计数上；第一次比对备份用了 `shasum -a 256 -q`（`-q` 只在校验时有意义），两条哈希都成了空串， 于是"一色 SAME"是假的——换成 `shasum -a 256 \| awk` 之后才看见 2 个 DIFF、4 个 blob 根本没有当前对应文件 |
| 47 | 门禁 | `scripts/check-doc-links.mjs`（**新增规则**） | 这类缺陷只在渲染时现形，链路与锚点都照常绿； 而"记得转义"不是守卫——本轮写台账的人（我）自己就连中两次 | `markdownTableProblems`：围栏内不扫 （``` 里的对齐图行与行格数本来就可以不同，一道误红的闸的下场是被放宽）；`\|` 先折成占位符再数格； 缺 `\|---\|` 分隔行单独判（GFM 没有分隔行根本不渲染成表格）；以竖线开头却不以竖线结尾判裁断； 扫描集合是本仓自己的 markdown（跳过派生目录，也跳过 vendored 的 `harness/glasspane-harness/packages/**` 那棵 fork 产品源码树——那是一次**范围决定**而不是注释：上游 bump 不该能红在本仓的闸上，那种红的唯一修法 就是放宽本闸）。七条用例双向：未转义被抓、转义形状沉默、孤行不判、围栏不判且不计进总数、分隔行格数不齐 被抓、真仓库零问题且**文件数 >100 / 表格数 >200**（两个分母都要有读者，零张表是一种「永远绿」的假绿）、 vendored 树内沉默而**同一形状在树外被抓**（只测一侧会放过「把整仓都跳过去」的实现）。汇总行因此是 `markdown 表格 394 张（扫 113 份 markdown）`——这两个数是收口时读到的，之后会随文档增减，判据盯的是它们不为零。反向变异三处（10-19 记录 122 行、smoke.md 125 行、 P6:39）各自让闸退 1 并点名 `文件:行`，还原按 sha256 逐文件核回 |

（表中 1–47 是**处置条目**：44 条缺陷 + #31、#45、#47 三道为缺陷机制化的新增闸。§2 与 §3 的分工：§2 说每条坏在哪、怎么修，§3 记决定与回滚。）

## 3. 本轮我替你做的决定 · 依据 · 回滚

| 决定 | 依据 | 回滚 |
|---|---|---|
| 取号 **1.18.0（minor）**，不去补发 `v1.17.0` | `v1.17.0` 那笔 commit 的 CI-green 事后不可转（§1）；`assert-ci-green` 与"已发布 tag 绝不移动"两条都在本仓自己写的判据里，放宽任何一条都等于把"没跑过测试的树"签出去。minor 的四项判据实测：CLI 参数语法动了（`=` 统一）、退出码触发条件动了（`--guide-screen-permission`、`--check-developer-tools`、`updater … --hour`）、`install.sh` 的同意行为动了、错误码集合新增 `signature-anchor-changed` —— 数字集合仍是 0/1/2/3/64/65，但按 rc 分叉的调用方读到的世界变了 | `git revert` 本版收口那一笔；tag 不移动，下一个号继续 |
| `v1.17.0` 记为"已打永不发布"的锚点，不删 tag | 提示词第 7 条：tag 是发布锚点，`install.sh`/updater 钉的就是它；删一枚已推远端的签名 tag 比留一个有解释的空号更糟（`v1.16.2` 同处理方式） | 不需要（不动它）；若要强行补发只能在 tag 之后重切，那会改写历史 |
| 面 A 棘轮 `--record`（只记本轮自己的增长） | 本轮有意往 `mcp-shell/src/*` 加了修复行数；`tool-surface.mjs --check` 的红由两部分组成——我的增长 + harness 线自己的分母移动。政策只允许"本轮有意增长且与代码同批"重记，且必须在单独一条 `chore(harness)` 提交里说清长了多少为什么 | `git revert` 那条 chore 提交即回到旧金样；不改判据、不动 `harness/tools/**` 逻辑 |
| 不动 `harness/` 任何一笔（含那条红的 `release-artifact`） | 提示词 §"范围纪律"与第 100 行：那条线有 10:30 的独立任务与独立发布通道；本轮开工时它**正在飞**（`gp-019` 6 份未提交），我替它发版就会撞车。0.9.1 由那条线自己落地后，父仓九 lane 自然转绿 | 不适用（一行未改）；`git diff --stat origin/main..HEAD -- harness/` 必须为空 |
| 判据不动、不放宽：`--consent` 不能洗掉锚点不符；`--verify` 新增的是**另一问**（不该到的没到）而不是把旧问改松 | 提示词"诚实性优先"与红线：任何"让它变绿"的捷径都算失败 | `git revert` 对应提交 |
| TOFU 边界保留在第一版 | 见 §33 那条的 LIMITS：安装期钉锚做不到不破坏交付形状（发布出去的 `glasspane-install` 包里没有 `updater/` 代码，硬 import 就是"测过的形状≠交付的形状"） | 若要安装期钉锚，需先让 npm 包带上那份读取器（属范围变更，未做） |
| §43–§45 这三笔 CI 文件落在 `v1.18.0` **之后**，不为此另取一号、不移动 tag | `v1.18.0` 的签名归档、Release 与（本轮随后 dispatch 的）npm 包都按 tag 树取字节；补号会让"这台机器装的到底是哪一棵树"重新变成问题，而 `install.sh`/updater 钉的就是那枚 tag。这三笔里没有一行会被装到用户机器上执行（改的是发布作业与它自己的尺子），下一次触发 `release.yml` 跑的就是修好的那一份——不损失任何保护。台账仍按提示词第 6 条归进本版条目、不留 `[Unreleased]` 段（先前有一处写着"`v1.17.0`/`v1.16.4` 的收口台账也记在 `[Unreleased]`"——**这句是编的**，实测那两条目里都写着「本版不含 `[Unreleased]`（开工时该段为空）」，故改正） | `git revert` 那一笔提交即可；tag、Release、npm 三格都不必跟着动（它们的内容与这三笔无关） |

## 4. 复核后**主张不成立**的条目（不计入修复，但处置仍进了代码）

| 主张 | 为什么不成立 | 仍然落地的部分 |
|---|---|---|
| `POST /v1/tools/capture_view` 404 是未修缺陷（10-12 台账留到今天，本轮 §"先找上一轮没收口的活"重新核） | 实测是一条**有意拒绝且有闸**的形状：daemon 实现并 advertise `capture_view`（`FrameCodec.swift:79` / `Dispatcher.swift:132-135`），MCP 侧 `gp_capture_view` 走自己的 executor；HTTP 网关的 `FORWARDABLE_TOOLS` 只转 `execute === undefined` 的方法（`http-gateway.ts:237-239`），排除理由双语都写在 `SECURITY.md:112-113` / `SECURITY.zh-CN.md:82-83`，并由 `mcp-shell/test/http-gateway.test.mjs:1141` 把"它必须 404"钉成用例；`TOOL_ROUTES_TEXT` 由同一份映射派生，所以任何 remedy 都指不到那条 404 | 结论记在这里，免得下一轮再当成开放项重新找（10-12 那条记录是误判，不改写它，只新增本条） |
| 三条工具数量镜像不一致即缺陷 | 实测三处一致且**由闸守着**：`mcp-shell/src/tools.ts` 16 个 `gp_*`；daemon advertise 11（`EngineMethod` 13 格去掉 `hello`/`shutdown`，`capabilityWireNames` 派生）；`mcp-shell/schemas` 是构建产物、`kernel/schemas/*.json` 是数据契约，里面**没有**工具定义（0 个）——所以"三处数目必须相等"这个前提本身就写错了 | 16 与 11 的差额是 5 个 shell-only 伪方法，逐个有 `execute`；`DAEMON_FORWARDED_METHODS` 与 daemon 的 11 个由 `test/daily-20261011.test.mjs:97-136` 对真 Swift 枚举比对 |

## 5. 门禁与实测（读数在 `engine/smoke.md` 的 2026-10-20 小节）

逐字命令清单与实跑计数记在汇报第 ③ 项与 `engine/smoke.md` §5；本轮共跑四轮完整门禁（开工基线 + 改后复跑 + 收口前两轮，最后一轮跑在与提交字节相同的树上），
外加这些真机项：`glasspaned --permissions` / `--check-accessibility` / `--check-input-permission` /
`--check-screen-permission` / `--check-developer-tools`（真 lldb 探测，读数 `launch:denied / attach:denied` / rc 1）、
`--guide-screen-permission`（席位已授予 ⇒ 正支 0）、`--state-dir <临时根>` 上的归档类检查、
`--older-than=abc` 等三种等号形态在真二进制上的退出码。

**未观测（物理边界那一类，写在 `engine/smoke.md` §4 与 §1）**：
① `--guide-screen-permission` 的**拒绝支**——要先撤销真权限才能跑到，撤销/重勾会改这台机器的 TCC 状态；
② ~~面板四处改动的 AX 走查~~ **这条本轮改成了"做了只读那一半"**：仓里唯一那条面板冒烟
`.p4i4_smoke.py` 在这台机器上**根本起不来**（三份 python 全都没有 pyobjc：
`ModuleNotFoundError: ApplicationServices`），而它会逐卡按下引导按钮、真改本机 launchd 与 TCC 状态。
本轮抽出它自带的 Swift 辅助器 `swiftc -O` 编好，只走只读路径（`front` / `texts` / 至多 `press` 侧栏
切页按钮）。读到并写进 `engine/smoke.md` §4 的：占位行一枚复制按钮都没有而真路径行有（#22）、
「清空」的 help 进了 AXHelp（#20）、「刷新」可用态那一支（#21）、证据页芯片文本 `有人同时操作`
（#6 的一臂）、4192 个元素的三棵树里 `§` 出现 0 次（#18）、以及 1.6.2 那份真 daemon 因不报
`stateRoot` 而被面板写 `状态根未上报` 并让「清理」拒绝（本轮那条"不许从这儿猜"的判据在真机上的形状）。
**仍然未观测的两处不是权限缺口，是状态造不出来**：#20/#21 的禁用那一支（要在途不足 2s 的窗口里抓）与
#6 的 `污染未经监测` 臂＋过滤器标题（本机 582 份档案全部出自开过 C33 的 daemon；标题那处是辅助器
不读 `kAXIdentifierAttribute`/`AXTitleUIElement` 的工具面缺口）。两条的确切补法都写在 `engine/smoke.md` §4。
③ `npm stage approve`（owner 2FA）与 Apple 公证（付费账号）——照旧是只有两件的物理边界。
本轮**实际没有产生任何 stage 件**：`release.yml` 以 `--ref v1.18.0 -f mode=publish` 触发之后，
trusted publisher 直发成功，两包各自带上 2 条 attestation（SLSA provenance predicate v1 + v0.1），
所以 ③ 里 npm 那一半这一轮没有被用到；Apple 公证本轮没有做，也没有把它写成已完成。

**发布链实测（读回，不是"job 绿了"）**：`v1.18.0` → commit `80b81f18`；Release `draft=false`、
`target=80b81f18eb953…`、4 件资产、`/releases/latest` 服务的就是这个 tag；registry 两包 `latest` 均
`1.18.0`，`versions` 列表里 `1.18.0` 是最后一个（31 个版本，两包同数）。归档端到端读数在
`engine/smoke.md` 本轮 §7。`github-release` job 首跑（run `39369074180`）红在 §43 那一格，
`npm-publish`（dry `39369654952`、publish `39371230541`）两条各自跑完。

## 6. 物理边界（不是决策遗留）

- `npm stage approve <stage-id>` 需要 owner 的 2FA；Apple 公证需要付费账号。本轮没有生成任何公证步骤，也没有把它写成已完成。
- `--guide-screen-permission` 的**拒绝支**（exit 1）本机跑不了：这台机器屏幕录制已授予，那一趟会真的去开系统设置面板。补法写在用例的 `XCTSkip` 里。

## 7. 别人正在飞的批次（本轮未动）

`.worktrees/gp-019`（分支 `gp-019-pin`，== 当时的 `origin/main`）6 份未提交：
`harness/glasspane-harness/{CHANGELOG.md,README.md,README.zh-CN.md,docs/install.md,packages/opencode/package.json,product.json}`，
最后写入 07:31。全部在 `harness/**` 之内 ⇒ **与本轮改动零重叠**（本轮 `harness/` 一行未改），
不影响本轮收口的成立。那条线随后自己把 0.9.1 推上了 main（`1e2921a6`）并补了台账（`b9fd7bc0`）。

## 8. 本轮自己引入又修掉的回归（记下来，不让它只活在提交信息里）

`fix(installer)` 的第一版把 macOS 前置放在 install.sh 入口 ⇒ CI 的 `root workspace gate`（ubuntu runner）
红 20+ 条：那一格测的是 install.sh 的决策分支，不是主机能不能装。第二版把闸搬到"定位不到源码 ⇒
一定要 clone"那一支的开头，并让 dry-run 继续打计划行。

测试侧的桩也错过一次：`test/support/darwin-host.mjs` 初版按 `process.platform` 决定要不要前置 Darwin 的
`uname`，而本机"模拟 Linux"的方式恰恰是往 PATH 里放一枚报 Linux 的 `uname` 桩——两者不一致，导致
三条既有用例在模拟里仍红、而这处不一致本来会在 CI 上以同样的方式暴露。判据改成**子进程会看到的**
`uname -s`。教训一句：凡是"按环境决定要不要伪装环境"的测试脚手架，判据必须取自被伪装的那个观察者，
不能取自进程自己。

修 §43 那一笔的第一版也走错了一次，两处都值得记：① 新用例写成 `import { ghJsonFieldProblems } from
'../../scripts/check-workflows.mjs'`，而那份脚本**顶层就自跑并 `process.exit`**——被 import 即执行，
这正是本仓 `make-release-archive.mjs` 这轮刚修过的那个形状；改成走 `--self-test` 的用例表（CI 真跑的
那一条路）。② 那次 Edit 的锚点吃掉了相邻用例的 `test('a registered document …', () => {` 头一行，
文件语法断了，`node --check` 一步就抓到。教训：往一张已有多条 `test(` 的表里插东西，锚点要取**整条**
用例的首尾，不能只取 MARK 注释——注释下面紧跟什么，是相邻文件的字节决定的，不是我以为的。
