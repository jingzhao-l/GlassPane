# Changelog

本文件记录 GlassPane 的值得注意的变更。格式遵循 Keep a Changelog，版本号遵循 Semantic Versioning，条目按时间倒序。

## [1.3.0] — 2026-09-26

MCP 专项审查（round 8）与对同批修复自身的复审（round 8b）落地。**这一版之前 MCP 面被判定为
"不宜对外发布"**：三条高危都在真实负载下可走到，而当时的门禁一条都不会红。本版把三条连同
4 项中危、若干低危与 12 条新闸一起收口；判据与残留项写在
`specs/GlassPane_规格修订_2026-09-23_iterate-round4.md` 的「追加三」与 `.iterate_decisions.md`。

### Fixed — 代理指引不得在忙的时候喊"重启"，也不得诱导重复点击

- **`gp_probe_status` 的调用方期限 15 s → 50 s（客户端耐性上限），且重启指令只挂在
  `GP_E_ENGINE_UNREACHABLE` 上**。守护进程单连接串行，探针排在被它诊断的那个请求**后面**：
  一次合法跑过 15 s 的 `gp_act` 必然让探针超时，而旧文案明写"`gp_probe_status` 也超时就重启"，
  于是代理会去 `--restore-launchd` 一个正在用户屏幕上执行动作的 daemon（SIGTERM 会取消并回滚
  那次动作）。四种探针结局（answered / engine-error / timed-out / unreachable）现在各自陈述
  自己被允许引出什么动作，只有 `unreachable` 给出重启命令。
- **同一形状在握手处也补上**：`hello` 原为 15 s，而懒连接下"触发连接的那一帧"先写，
  所以会话的第一个请求是 `act` 时版本/协议比对必然丢失（只剩一行 stderr）。`hello` 同样抬到
  ceiling。
- **`engine-error` 那句"该码自己的 remedy 永不重启"是未实测的全称断言**，已删除：守护进程给
  `GP_E_AX_UNAVAILABLE` 的 remedy 本身就命令 `--restore-launchd` + `launchctl kickstart -k`。
  现在由测试从 Swift 的 remedy 表里**量出**哪些码命令重启，并要求壳层判据不得禁止它。
- **超时之后才落地的回复，其 `operationId` 现在会写进本会话证据链**。此前只进日志：
  `gp_recent_reports` 对一次真正执行过的 `gp_act` 回答 `GP_E_NO_EVIDENCE … run gp_act first`，
  等于叫代理再点一次。迟到回复带着它被准入时的**链纪元**，纪元不符（中途换过应用）即
  **拒绝写入并说明**，同时给出还能把它取回来的那条路。
- **证据链只在被 attach 的应用真的变化时重新开始**（与守护进程
  `if attachedApp != app { history.removeAll() }` 同条件，身份键覆盖 Swift `AttachedApp` 的
  全部字段）。旧实现每次成功 attach 都清空，于是幂等的同应用 re-attach 会抹掉刚记录的操作。
- **HTTP 网关不再给出 MCP 面才成立的答案**：`curl` 调用方拿到的指引不再提
  `gp_recent_reports`（该路由恒 404），改指本进程 stderr 与 `GET /v1/evidence/<operationId>`；
  同时真的注册了 note / late-reply 两个汇点，"去读 stderr"这句话不再落空。

### Fixed — 跨语言同源与输入边界

- **`projects.json` 的路径与"不得指向用户主目录"的保护改按守护进程的规则解析主目录**
  （`os.userInfo().homedir`，读口令库而非 `$HOME`）。此前导出一个 `HOME` 就能让两侧读写不同文件、
  并绕过主目录保护。默认 socket 路径**刻意**继续跟随 `$HOME`（否则一个把自己关进沙箱的进程会
  静默接上用户的真 daemon），这一不对称由两条测试钉住，理由写进源码与规格。
- **`gp_attach` 的 `bundleId` 与 `pid` 改为互斥**。守护进程的解析是 pid 优先并**静默忽略**
  `bundleId`，而壳层的 zod 只要求"至少一个"（对外 advertised 的 JSON Schema 早已是 `oneOf`）：
  同时点名两个应用会 attach 到代理没有说的那个并在其界面上下钻。现在两者同给即
  `GP_E_BAD_PARAMS`，一帧都不发。
- **`notifications/cancelled` 不再被静默丢弃**：落一行日志，并明说"本壳无法撤销已经发往
  daemon 的请求，撤销不是撤销回"。
- **超帧回复的建议改为按该请求真实携带的参数生成**（`capture_view` 拿的是 `scale`，
  旧文案让它去缩一个它没有的 `maxDepth`）。
- **`GP_E_NO_USER_RECORD` / `GP_E_UNKNOWN` 收进错误码单一出口**；`GP_E_PAYLOAD_TOO_LARGE`
  的"壳层专有"注释改口（守护进程枚举里本来就有它）；`McpServer` 的审计会话改为运行时必填，
  缺它即拒绝构造（此前类型必填、运行时可选，未接线看起来完全正常）。
- **引擎侧**："拍不到采集面"不再冒充"窗口没上屏"（新标签 `pixel-capture-no-surface` + 对应的
  可执行下一步），面板证据页的通道分母从写死的 3 改为真实的 6。

### Added — 门禁（每条都做过"撤销修复即红"的因果核对）

- `mcp-shell/test/probe-liveness.test.mjs`：用 mock timers 量真实布防期限（15 s 时探针仍在飞、
  30 s 得到答复、50 s 才结算）+ "任何被发送方法的调用方期限不得超过探针"的表上不变量 +
  "四结局里恰有一处可给出重启命令"。
- `mcp-shell/test/method-table.test.mjs`：从 `FrameCodec.swift` 解析 `EngineMethod`，凡本壳会
  发上线的方法必须有**具名**期限（`audit_ui` / `capture_view` 此前一直在吃缺省 30 s）。
- `mcp-shell/test/attach-identity.test.mjs`：身份键必须覆盖 Swift `AttachedApp` 的每个存储属性，
  且守护进程"按应用变化清历史"这一条件若改写即红。
- `mcp-shell/test/remedy-surface.test.mjs`：错误码"共享 / 壳层专有"的分类与 daemon 枚举双向比对、
  `src/` 内 `GP_E_*` 字面量单一出口、两种接入面各自的 remedy 文本。
- `mcp-shell/test/path-consistency.test.mjs`：真值表的系统树行由 Swift 两份清单**生成**（原为手抄
  5 个名字，清单实际 8+3 项）；4 MiB 帧上限三判据对表；PNG 预算 × 4/3 ≤ 帧上限的不等式。
- `engine/.p6_smoke.py` / `.t9_smoke.py`：`verify_shared_block()` 把"改一处必须同步另一处"这句
  人读注释变成机器闸（漂移、例外被抄平、例外表过期三个方向都能红）。

### 已知边界（不当成已交付）

- `act` 的守护进程侧最坏值是 120 s，而探针最多只能等 50 s：某些真实负载下"探针没答上"必然发生，
  承担这件事的是判据而不是某个期限。
- `installer/cli.js` 仍以 `process.env.HOME` 拼 launchd 的 `--socket-path` 与日志路径（风险区，
  本轮只登记）。
- `notifications/cancelled` 只能记一行：真撤销需要 daemon 侧的取消通道，而方法表是冻结面。

## [1.2.0] — 2026-09-25

### Added — feature-gap 四维精简审查落地

承接 1.1.2 之后的一次"优先级审查 + 功能缺口"复核（round gap），确认既有 `gp_export_evidence` /
`gp_recent_reports` / daemon `--evidence-stats` / `--recipe-validate` 已覆盖的基线后，本轮补齐四项缺口：

- **HTTP/REST transport（新增 `glasspane-http` 入口）**。`mcp-shell` 新开一个 HTTP gateway：token
  经 `GLASSPANE_HTTP_TOKEN` 注入（缺失即退出），仅绑定 127.0.0.1，处理 SIGINT/SIGTERM 干净退出。
  新增 `/v1/stats` 与 `/v1/recipes/validate`；对无 daemon socket 通道的路径返回 `GP_HTTP_NOT_PROVIDED`。
- **证据趋势统计卡**。设置/面板新增证据统计视图，输出分布与 `==` 计数（见下条的越界归并）。
- **配方校验 + 模板编辑器**。RecipesTab 支持模板编辑，校验走 daemon 的 `--recipe-validate` 语义。

### Fixed — 第二轮代码优先审查（正确性 / 安全 / 发布链路）

- **http-gateway 发布链路缺失（阻断发版）**。此前 bundle 单入口会删掉非 index.js，且无独立 CLI 入口、
  测试消费 tsc dist 而非 bundle，导致"测试绿但发布丢功能"且 CI 拦不住。本轮新增独立
  `http-gateway-cli.ts` 入口、bundle 三入口、bundle smoke 门禁。
- **证据 id 无上限 → DoS**。`MAX_EVIDENCE_IDS` 收敛到 20。
- **token 长度探测**。改为 sha256 + `timingSafeEqual`，去掉按长度提前返回的分支。
- **多余路径段触发真实 act**。路径段拆分后先 404，而不是透传到 act。
- **绕过契约校验的 `LAST_EVIDENCE` 透传**。`last_evidence` 改走 `parseEvidenceFrame` 校验后再进入。
- **证据统计越界 circuitBreakerLevel 丢失**。越界 level 归入显式"其他(不识别)" bucket，分布与 `==` 计数含盖。
- **recipe 临时文件权限 / TOCTOU**。临时文件用 0600 + `O_EXCL` + `O_NOFOLLOW` + UUID。
- **校验结果过期覆盖**。校验 token 门控（递增 token），防止慢校验覆盖新结果；验证期间禁用模板/刷新按钮。

## [1.1.2] — 2026-09-25

### Fixed — R6 遗留四项收口

承接 1.1.1 的 iterate 复审（r1–r4b），本轮把决策日志里标记"仍开着"的四项逐个落地，
版本线从 1.1.1 升至 1.1.2。以下每项都配套了能满足"撤销即红"的测试。

- **面板人读面缺席渲染**。`EvidenceTabView` 此前对 `stateDiff/crash/handlerProbe` 缺席直接无卡、
  `responsiveness` 整块不渲染——"没测到长得像没事"。新增六通道缺席/已测判定的唯一纯函数
  `PanelChannelFields`，各自渲染中文"不可用"卡而非消失。
- **probe-status surface 闸形制收紧**。裸 `includes(key)` 会让短键命中无关散文造成假绿；改为
  反引号 ``` `key` ``` 形制匹配，并核实 description 里 15 个发布键（含 `attachedHasProbe`、
  `longSession` 两处真漏）全部有包裹。
- **path-consistency 以语义而非字形判据**。不再匹配 `for…where…hasPrefix(x+"/")` 的字形，
  改为读 Swift 侧实现断言"子树匹配 + ownability 兜底的存在与可达"，并禁止旧的 `.contains(`
  等值匹配回来；等价重构不假红。
- **双采集失败标签归并**。`no capture surface available` 此前落入 `pixel-capture-failed`
  被当作应用缺陷；现在归并为既有环境边界标签 `pixel-capture-no-onscreen-window`，并同步
  `.p6_smoke.py` 的不可用标签容忍集注释。

## [未发布]

### Fixed — 像素通路修好之后暴露的六条"像测量其实没测"

上一条修复让捕获第一次真的跑到，于是那条路上从没走到的分支全部现形。这一批逐条来自
一次全新视角的复核（报告 20 条，先回代码复核再动手，其中 6 条判为不成立或已修，未采纳）。
下面每一条都做了反向注入验证：**把修复撤销，对应测试必须红**。

- **一次子树没答上不再掐掉整次遍历**。旧实现只有一个 `stopReason`，兄弟循环
  `guard stopReason == nil` 于是把"这一截没看到"执行成"后面全部别看"——而注释写的正好
  相反。真机后果是覆盖率分母里根本没有未走过的子树：看过 5% 也能报 `ratio=1.00`。
  现在 `aborted`（只有预算耗尽才置位）与 `stopReason`（任何不完整都记）分开。
  实测：Finder 一次走查 nodes 298 → **315**，`smallHitTarget` 9 → 15——多出来的不是新规则，
  是以前被丢掉的那些元素。判据抽成纯函数 `AXChannel.walkFailure`，CI 里能跑。
- **尺寸不同的两帧不再返回 `changedPixelRatio = 1`**。窗口在操作中间被 resize 是常见结局，
  "界面变了"成立，"100% 的像素都变了"没人测过。现在抛 `PixelDiffError.geometryChanged`
  带上两边尺寸，证据面记未测量（标签 `pixel-capture-window-resized`）。
- **换窗判据现在比的是"真截到的那个窗口"**。`SCKCapturer` 在 windowID 被回收时会按既有
  语义回退到该 pid 最大的在屏窗口，而 `WindowCapture` 一直携带**请求**的 id——于是可能
  "报告 12 号、像素来自 13 号"，而且上一条修复比的就是这两个请求 id，两边都回退时判据会被绕过。
  采集现在回传实际命中的 `(windowId, frame)`。
- **像素缺失的下一步不再一律答"去授予屏幕录制权限"**（`Classifier.pixelAbsentNextStep`）。
  通路坏着的时候这条分支永远走不到，修好之后它成了常路：换窗 / resize / 没有窗口 / 超时
  全被指去系统设置。现在按已成文的成因标签分支，认不出来就让人去读 reason 原文，绝不猜成席位。
- **成因分类的顺序改成"具体成因先于席位词"**。像素 reason 里大段是 Apple 的
  `localizedDescription`，`denied` / `permission` 出现在那种句子里不等于屏幕录制没给。
- **CGWindowList 少 layer 字段时不再放行**（`isAppWindowLayer(nil) == false`）。"读不到就算通过"
  正是把这条通路弄死十天的同一类错误，而这里放行会一路放行到桌面/菜单条层。
- 另外三条同样按"不许发明主张"处理：PNG 静默降采样失败时如实报告**实际应用**的倍率
  （`appliedScale`，由像素数倒推）；MCP 壳层不再在引擎没回答时补 `persisted: false`
  （缺这个字段就拒帧——"不落盘"是协议主张，不是壳层可以填的默认值）；`map()` 的
  像素降级句从"默认值"改成"调用方自己给"，因为全仓唯一把像素拒绝抛成错误的调用方是
  `capture_view`，它没有 pixelDiff 可降级，gp_verify 走证据包那条路。

### Added / fixed — 文档与诊断跟着改口径

- `gp_audit_ui` 返回体新增 `complete` 与 `stopReason`：README 早就写着"遍历没走完会带
  `complete: false`"，而这两个字段**从来没上过线**——不完整只藏在一条 finding 的文字里。
  截断（`overlapScanTruncated`）有一等布尔值，不完整没有，这个不对称补齐。
- `noInteractiveElements` 在遍历未完成时不再声称"整棵树里没有可交互角色"，只说"本次走过的
  部分里没有"：一条没走过的子树不配得出关于这个应用的结论。
- SECURITY（双语）：屏幕录制席位的两个消费者写清楚（像素比对 + `gp_capture_view`）；
  "唯一移动像素的通路"改成"唯一会把屏幕像素搬出本机的通路"，与 `.gputrace` 只写本地不冲突。
- 真机诊断：`SCKCapturerDiagnosticTests` 的目标 pid 曾写死 `706`，开机就失效，从此再没绿过，
  而它的红被记成了"daemon 缺屏幕录制席位"（P1 规格 §注 3、smoke.md 观察 3 都抄了那条）。
  现在每次现找候选，找不到就如实 skip；同时新增 `RealWindowCandidates`（判据与产品同源）。
  本机的红不再被解释成结论。
- 视觉通道流水线自证改紧：窗口改用 sRGB 纯红，中心像素阈值 r>0.9 / g<0.08 / b<0.08
  （旧版容忍 g<0.35，而它自己记录的实测值 g=0.15 其实来自色彩空间转换——那等于"只要不是绿的都算过"）。
  现在实测 `r=1.0 g=0.0 b=0.0`，640x400。清理 `defer` 移到窗口出现**之前**登记。
- 测试：`swift test` 650 全绿、mcp-shell 176 全绿。新增/改写的判据包括帧预算的
  **带信封**测量（真实字段集除 payload 外的字节数 + base64 上界 < 4 MB，且留 >10% 余量）、
  `capture_view` 的 scale 范围走真实协议入口（旧测试把范围字面量抄进测试里调校验函数，
  `Dispatcher` 改成 `0.01...2.0` 也照样绿）、未挂接时不得给出席位指引。

### Fixed — 像素通路从来没有真的跑通过（2026-09-15 起）

`AXChannel` 读 CGWindowList 时把键名写死成 `"PID"` 与 `"Bounds"`，而系统真正发出来的键是
`kCGWindowOwnerPID` / `kCGWindowBounds`。于是窗口查找**在任何真机上都返回 nil**，
`captureWindow()` 永远抛 "no on-screen window owned by pid N"，`pixelDiff` 自引擎第一笔提交起
恒为缺失、T6 恒 `INCONCLUSIVE`。它一路全绿是因为：那条 remedy 说的"没有窗口，权限也修不了"
听起来永远合理，而这段逻辑是私有实例方法——只在有窗口的 GUI 会话里才可能被走到。
README 里"数值化像素验证"这条主张，在此之前从未被交付过。

- 键名改为直接取 CoreGraphics 常量，且窗口挑选拆成**纯函数**并由单测覆盖（写错键名现在要么
  编译不过要么测试红，不再静默失效）。
- 顺带补层规则，否则修好键名的第一次截图就会把**桌面图片**当成应用窗口：负层是桌面/墙纸/
  程序坞底片，≥20 是菜单条/通知中心——拿它们算像素差是把壁纸的变化记成"界面变了"，
  比"没测到"更糟。
- **修复后才暴露的判据缺口**：前后两次截的不是同一个窗口号（操作让应用换了前台窗口）时，
  跨窗口的比值仍然落在 0...1、看起来完全像一次正常测量，但它不是"这次操作改变了界面"的证据。
  现在这条通路报 `pixel-capture-window-changed` 的未测量，标签仍由同一个分类函数生成。
  `engine/.p6_smoke.py` 的像素豁免集同步登记了这个标签（枚举集合，不是"任意 reason"）。
- 真机证明（`GLASSPANE_LAYOUT_DIAG=1` 的 opt-in 诊断）：测试进程自己开一张纯红窗口，走产品的
  同一条 `captureWindow()` → `PngEncoding` 通路截回来，得到 640×400 / 8983 字节的 PNG，
  解码后中心像素 r=1.0 g=0.15 b=0.0 —— 像素通路第一次"知道该截到什么"，而不只是"没报错"。
  外来窗口那条分支在本次上下文仍测不到（当前 Space 上没有别的在屏应用窗口，且规格早已记录
  daemon 的屏幕录制席位独立于测试进程），诊断会如实打印 `NO CANDIDATE` 而不是假装通过。
- 测试：`AXWindowLookupTests` 5 例（键名必须等于 CoreGraphics 常量、按真机字典形状取窗口、
  层规则、零尺寸窗口跳过、畸形 bounds 不猜值）+ 1 例换窗判据（含"同窗口号必须照常给出数字"
  的对照组）。反向验证：注入旧键名 → 4 条红；关掉换窗判据 → 那条假证据
  （`changedPixelRatio=0.25, windowId=12`，而第二次截的其实是 13 号窗口）如期暴露。

### Added — 显式视觉审查通道

- `gp_capture_view`（引擎方法 `capture_view`，工具面 15 → **16**）：把挂接窗口编成一张 PNG，
  作为 MCP `image` content 交给**用户自己的**模型，用来判规则判不了的东西（整体观感、
  "这看着不对"、没有无障碍树的自绘控件）。
- 三条设计约束，都写进了 SECURITY（双语）：
  1. **引擎不落盘**，且**没有 `path` 参数**——由模型选输出路径等于在协议里开一个屏幕内容驱动的
     任意文件写入口。报告类工具能指定路径是因为它们是文本，图像不是。
  2. 暴露面不可撤销：图像进入会话，就会落到模型服务商保留的一切里，与 `gp_observe` 的 AX 树同级，
     只是换成像素。用过它的会话要按"那窗口当时的画面已被截走"对待。
  3. 摘要与图像同发（尺寸/字节数/scale/`persisted: false`）：模型只看图时没人记得它被 0.6 缩过，
     而"我看清了"与"我看清的是缩过的版本"是两个结论。
- 尺寸受 socket 帧上限硬约束：`FrameCodec.maxFrameBytes = 4 MB`，base64 又放大 4/3，
  故 PNG 预算定在 2.4 MB；超限报 `GP_E_PAYLOAD_TOO_LARGE` 并附**建议倍率**，而不是悄悄降采样——
  悄悄降会让模型以为它看清了。`scale` 合法区间 0.1–1，越界在参数校验层就拒（0.05 的图是
  "看着像看过、其实满屏马赛克"）。
- 新增 `PngEncoding`（ImageIO 编码 + 等比降采样）；`ToolResult.content` 加宽为
  `text | image` 联合类型，只为此一个工具开。
- 测试：Swift `CaptureViewTests` 9 例（PNG 签名自证、scale 换算、超限拒并给倍率、
  倍率算术的精确值（旧写法 `.rounded(.down) * 10 / 10` 会把任何建议塌成 0.1，反向注入验证过
  这条断言能红）、**按它自己给的建议倍率重试必须真能装下**、
  **默认预算必须容得下 base64 膨胀与 JSON 信封**这条不变式、引擎返回形状、
  捕获被拒时绝不回空白图且 remedy 不得借用 gp_verify 的 pixelDiff 口径）；
  mcp-shell 4 例（image+摘要、透传引擎拒绝、
  无图帧报错、越界 scale 本地拦下）。
- `[待真机]` 未在有屏幕录制授权的进程里跑过端到端：本机的诊断进程只有辅助功能授权，
  走的正是"被拒 → 如实报错"那条分支。

### Changed — `gp_audit_ui` 的输出按真机数据收紧

真机跑 Finder 一次性倒出 49 条 finding，其中 36 条是同一个分段控件的"自我重叠"。这份改动
是为了让审计结果**能被读完**，而不是为了让数字好看：

- 返回体新增 `ruleCounts`（每条规则的完整计数），`findings` 每条规则只留前 5 条样本，并补一条
  `findingsAggregated` 说明"被截的是样本，不是计数"。
- 同父且同角色的可交互元素不再互相判为遮挡（分段控件/单选组的子元素共享矩形是设计如此）。
  判据必须同时看父路径与角色：只看父路径会连根层的两个真控件一起豁免——单测当场抓到过一次。
- `tinyHitTarget` 更名 `smallHitTarget`，文案写明 44pt 的出处是 iOS 触控 HIG、对 Mac 工具条偏严
  （真机 Finder 因此报了 9 条）。它是一条线索而非裁决：密集界面应传自己的 `minHitTargetPt`。
- 无障碍读取失败的原因文本不再拼在"trying to"后面（`trying to walking children failed` 这类
  不成句的输出会让人怀疑整条通道是模板造的）。成因词不变，`kAXError` 码照旧原样带出。

### Added — 界面可操作性与几何

- `gp_audit_ui`（引擎方法 `audit_ui`，工具面 14 → **15**）：一次只读的几何遍历 + 确定性规则，
  回答"这个界面是不是能用"。阻塞级 = 零尺寸的可交互元素、中心落在窗口外的元素；提示级 =
  命中目标小于 44pt（可用 `minHitTargetPt` 覆盖）、被窗口裁切、两个可交互目标重叠超过小者 50%
  （启发式，无障碍树没有层级顺序，只能报形状冲突）、整棵树无可交互角色。
- 新增 `engine/Sources/GlassPaneEngine/AXGeometry.swift`：`AxFrame` / `GeometryRead` /
  `AxGeometryNode` / `AxGeometrySnapshot`。**几何不进入 `AxNode`，因此不进入 `TreeDigest`**——
  树摘要一旦掺进位置尺寸，一次 hover 或一段动画就会让"这次操作是否改变了界面"回答"改变了"。
- `GeometryRead` 是三态（`measured` / `absent` / `unread`）而不是 `frame: AxFrame?`：
  "应用明确不给几何"和"这次没读到"是两件事，混成一个 nil 就会把没看到的算进通过。
- 判定值多了 `insufficient`，且优先级高于 `pass`：几何覆盖率为 0 或 measured/total < 0.8 时
  不许报干净；重叠扫描超出 300 目标配对预算被截断时，会自己留下 `overlapScanTruncated`
  finding 并且不再可能给出 `pass`。空树判 `insufficient`，不判干净。
- `RuntimeChannel` 新增 `geometrySnapshot(maxDepth:)` 协议成员，**不给默认实现**：新的 channel
  形态必须正面回答能不能读几何，不能靠继承一个"返回空"把能力假装存在。
- 新增 `ParamValidation.optDouble`（与 `optInt` 同判据：布尔不当数字收、越界即拒、非有限拒）。
- 测试：`UILayoutAuditTests` 18 例（含"量不到就不许通过""窗口未知时不许凭空判越界"
  "未知角色不报目标过小""截断不换 pass"），走 `ScriptedChannel`，不依赖活的 AX 目标，
  因此进 CI；`dispatch.test.mjs` 增加 3 例（参数转发、越界值与未知参数在本地拦下、
  不落到引擎）。`[待真机]` 真实应用上的几何覆盖率与规则误报率尚未测过——
  单元测试只证明规则本身按设计工作，不证明某个具体界面。


一次面向陌生读者的文档重审：原文把 GlassPane 写成"让 AI 证明它说了什么"的诚实性工具，
这偏离了立项动机。按 `specs/GlassPane_5.8_项目综述文档.md` 自己的定位改回来——它是 **macOS 上给
AI 编程代理用的 GUI 测试与验证层**：代理已经能做静态半场（构建/审查/单元测试），缺的是运行时半场
（构建 → 到达状态 → 操作 → 观察 → 诊断 → 修复 → 重验），而常见的替代方案"截图 → 视觉理解 → 坐标操作"
既不能断言也不能归因、不能重复、不能撤销。

- 新增"为什么不是截图"对照表（元素级定位、结构化差异、数值像素测量、归因强度、可重复、成本、回滚、
  审计留痕），并如实写出代价的另一面：视觉判断（审美、无树内容）仍归视觉模型，GlassPane 负责测量。
- 新增"它做不到什么"：不能无头跑（需登录 GUI 会话）、SwiftUI 拖拽会话合成不出（实测）、
  仅 7 个无障碍动词（不写控件值、不发合成 HID，故自由文本输入不在范围内）、
  目标应用不暴露无障碍树时结构验证受限、`strong` 归因需应用内嵌探针配合。
- README 加 npm 下载量徽章（`npm/dm` 两包，实测 shields.io 返回 200）；示例 tag 更新为 v1.1.1。
- 双语补齐：`SECURITY.md`、`CONTRIBUTING.md` 由中文单腿改为英文主 + `*.zh-CN.md` 镜像，
  章节 1:1 对齐；翻译过程中按代码收紧两处被写过头的主张（探针 pid 校验、事件 tap 的位置），
  并把"测试绝不可指向真实 ~/.glasspane"写成贡献者硬规则（对应 projects.json 被覆盖事故）。
- 新增 `scripts/check-doc-links.mjs` 与 CI `docs` 任务：对外 9 份文档的相对链接、页内/跨页锚点、
  双语成对性一次体检（当前 183 条仓库内链接 0 死链）；命令同步登记进
  `iterate.config.yaml` 的 `validation.commands.docs` 与 `ITERATE.md` 门禁清单。

关于 `v0.1.0` 之前的历史：仓库在 2026-09-22 之前不存在任何 git tag，也不存在可用的版本号，因此那段时间按 P0…P6
规格阶段作为里程碑分节记录，不追溯伪造版本号。所有日期取自 `git log`，每条 bullet 可回溯到其给出的 commit hash 或
`specs/` 正文；两者都给不出来的内容已被删除。

- 真机诊断 `GeometryAuditDiagnosticTests`（`GLASSPANE_LAYOUT_DIAG=1` 才跑，无权限/无 GUI 会话干净跳过）
  抓到一个合成用例永远抓不到的缺陷：第一版每个元素 role/title/identifier/position/size 全读，
  在真实应用上 10 秒无障碍预算被击穿、整次审计**颗粒无收**（还观察到 wall time 明显大于宣称的
  预算）。两处修正：① 只读 role + 几何，title 仅对可交互角色读（"哪个按钮点不到"才需要名字）；
  ② 预算耗尽改为带着已测部分返回并置 `complete=false` + `stopReason`，审计据此留下
  `geometryScanIncomplete` 且不允许给出 `pass`——"要么全有要么报错"与大界面天然不兼容。

## [1.1.1] — 2026-09-23

在 1.1.0 纳入基础设施审计后，本迭代把 iterate 复审（r1–r4b）与既有主线的各类收口合并进 main，并统一推送。
版本从 `1.1.0` 升至 `1.1.1`；发布前按单一版本线全员对齐，四包（根 `@glasspane/monorepo` / `glasspane-install` /
`glasspane-mcp` / `@iterate/kernel`）与引用位点统一到 `1.1.1`。

### Added

- **iterate 复审收口合入**。`iterate/full-review-20260922`（r1–r4b 六回合审查）并入 `main`，解决 engine 源码/测试、
  bridge、`iterate.config.yaml` 等 14 处冲突；两侧成果共存（如 bridge 的 `SEND_SOCK_TIMEOUT_S=10.0` 与
  `MAX_TRACE_SAMPLES`、B-24 语义；`ApprovalGate` 的 `StateRoot.approvalsFile` 与 `autoApprover="daemon:auto"`），
  engine 迁移至 `StateRoot` 工厂构造，`TestIsolationGateTests` 扫描通过。

### Changed

- 发布前版本线从 `1.1.0` 升至 `1.1.1`（原因：`1.1.0` 已在 GitHub 先存在并钉在更早的 tag 上，为避免 npm 发布的
  `1.1.0` 与 GitHub Release 内容漂移，改为推送新的 `v1.1.1`）。含 iterate 合并的最新代码落在 `1.1.1`，三线
  （tag=main=npm）对齐。

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
