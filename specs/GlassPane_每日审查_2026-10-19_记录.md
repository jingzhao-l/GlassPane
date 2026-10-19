# GlassPane 每日审查 · 2026-10-19 记录

本轮为无人值守每日任务（07:30 那条线），范围＝主仓产品面（engine / mcp-shell / installer / updater / bridge / scripts / .github/workflows / install.sh / 对外文档）。`harness/` 不审查、不修改、不发版。

- 开工 HEAD：`e54552ab`；工作树开工时 `git status --porcelain` 为空（无他人正在飞的批次）。
- 磁盘：`df -k /Volumes/Eng-Dev` 可用 21,149,232 KiB（≈20 GiB），高于 4 GiB 门槛，未触发清理。
- 上一轮未收口的活：本地分支 `gp-kernel-npm`、`gp-sc4-step0b` 与两个 worktree（`/Volumes/Eng-Dev/.worktrees/gp-kernel-npm`、`gp-step0b`）逐条按**文件字节**判定为已落地（`git rev-list --count main..<b>` 均为 0，且 step0b 分支与 main 同为 `e54552ab`），故不属"真未落地"，留待【收口清理】删除。远端只剩 `origin/main`。

## 1. 基线（改代码前，逐字命令，实际计数）

| 命令 | 结果 |
|---|---|
| `npm ci` | rc 0 |
| `npm run build` | rc 0 |
| `npm test --workspaces --if-present` | rc 1 — mcp-shell `tests 495 / pass 487 / fail 8`；installer `172/172/0`；updater `537/537/0` |
| `node scripts/check-version.mjs` | rc 0，版本线 1.16.4 一致（12 位点 + 4 处 lock 全 ✓） |
| `node scripts/check-doc-links.mjs` | rc 0：文档 25 份 / 仓库内链接 229 条 / 外链 28 条 |
| `node scripts/check-workflows.mjs --self-test` | rc 0：12 case（11 变异必须被抓 + 1 合法形状必须沉默） |
| `node scripts/check-workflows.mjs` | rc 0：5 个 workflow 文件 clean |
| `swift build --package-path engine` | rc 0 |
| `swift test --package-path engine` | rc 0：XCTest 聚合 `Executed 1074 tests, with 3 tests skipped and 0 failures`；另一 target `Executed 59 tests, 0 failures`；Swift Testing `Test run with 15 tests in 2 suites passed` |
| `swift test --package-path engine/probe` | rc 0：`Executed 29 tests, with 0 failures`；Swift Testing `Test run with 0 tests in 0 suites passed`（该包只有 XCTest 用例，非缺陷，如实记） |
| `python3 -m pytest -q bridge` | rc 0：`79 passed` |
| `sh -n install.sh` | rc 0 |
| `cd engine && python3 .signal_smoke.py .build/debug/glasspaned` | **首轮 rc 1**（"自检 stub（partial）没有走到它声明的现场"），隔离复跑 rc 0 |
| `cd mcp-shell && npm run bundle && npm pack --dry-run` | rc 0（29 文件，glasspane-mcp-1.16.4.tgz） |
| `node harness/tools/tool-surface.mjs --check` | rc 0（面 A 记录 9612 LOC / 21.42%，长期超文档上限已如实记在金样里，闸只挡进一步增长） |

### 基线两条红的定性（都不是"判据错"）

1. mcp-shell 那 8 条全在 `test/published-artifact.test.mjs`：它把打包产物装进干净前缀时要取 `zod`，报 `npm error code ETIMEDOUT … https://registry.npmjs.org/zod`。本机实测 `curl` 三连 `http=000 t=12s`（registry 直连不通），而 `npm view zod@3.25.76 --prefer-online` 能回值；同一 commit 的 CI `mcp-shell (TypeScript)` job 32s 绿。判据：这是**网络边界**，不是字节坏了——不改判据、不加超时，收口报告里写"未观测 + 补它的确切命令"。
2. `signal-smoke` 首轮红、隔离复跑绿。读码定性为**真缺陷**（不是负载借口）：自检 stub 在源码第 4-5 行就创建两个 socket，到第 222-223 行才安装 SIGINT/SIGTERM 处理器，而 harness 只等 engine socket 出现就发信号（`.signal_smoke.py:252-254`）——信号合法地抢在处理器之前，stub 被默认处理器打死在 `open(engine,"w")` 里（traceback 实测）。已修：stub 装完两个处理器后才写就绪标记，harness 见标记才发信号；拿不到标记单列成"stub 从未就绪"，不与"现场不齐"混。判据与超时一个没动。

## 2. 本轮审出的缺陷与处置

审出渠道：六条只读审查泳道（engine 线/证据、判定/权限、CLI+面板、mcp-shell、install/发布链、bridge+文档+安全）＋主代理逐条回代码复核。**复核后不成立的也写在这里**，因为"下一条轮别再重新踩"是这份记录唯一的读者。

### 2.1 探针通道与证据档案（Swift，engine/Sources/GlassPaneEngine）

| # | 缺陷 | 处置 |
|---|---|---|
| W1 | `ProbeInbox.swift:419(+186)`：探针中途掉线时事件环被 `disconnect` 删除而窗口记录还在，`events[pid] ?? []` 把"环没了"折成"报了 0 个事件"，于是 `handlerProbe(hitCount:0)` 当作测量发布，Classifier 顺着走黑盒分支 | 已修：`disconnect` 给该 pid 的在开窗口打标记，`endWindow` 对被标记的窗口回文件自己的"诚实缺席"形状 (nil, nil)。测试 `Qoder20261019ProbeHonestyTests` |
| W2 | `ProbeWire.swift:90`：计数器用 `number.intValue` 读，越出 Int32 的值被静默折回（同文件 `boundedInt32` 的注释早就写明"2^32+1 变成 pid 1"这个坑），`gp_probe_status` 于是能报出探针从没声称过的数 | 已修：计数器走 exact-range 读，越界 ⇒ nil（未上报）。用例补 `4294967296 / 2147483648 / -2147483649 / 9007199254740993 / "many" / null / bool` |
| W3 | `ProbeInbox.swift:471 + 549-552`：`lateCount` 在 act 时硬写 0，唯一写真值的 `refreshedHandlerProbe` 在窗口不在 16 条内存环里时返回 nil，而 `guard … late != stored.lateCount else { return nil }` 把"刷新不了"折成"保留 0"；`EngineCore:1550` 只在非 nil 时替换并重新落盘 ⇒ 归档包替一个从没量过的事实背书"没有迟到事件"，T8 对这些包永远红不了 | 已修：把"刷新不了"做成可区分的状态（不再伪装成测量），标签进包的诊断字段。两条对照：被逐出的窗口不得读成 late=0；仍在环里的窗口读到的真值照旧是测量 |
| W4 | `EvidenceModels.swift:239-249,202-210`：`StateEntry.key/before/after` 与 `HandlerRef.file` 在生产侧完全无上界，而已发布内核的读者（`kernel/dist/evidence-pack.js:216-228`）点名"Swift 写者对这些字段一条长度规则都没有"；`:237` 的注释还写着"探针侧截到 ≤1 KiB"——没有任何东西执行它。结果是一个大帧落进一份自己的读者会拒收的档案，而 `evidencePersisted: true` 已经答出去了 | 已修：按 schema 声明的单位（UTF-16）在构造函数里收界并标明"被截短"，`evidencePersisted` 不许在越界时先答是。测试 `Qoder20261019ProducerBoundsTests` |
| W5 | `ParamValidation.swift:52,182`：长度上界按字素簇计，而契约（`mcp-shell/src/tools.ts` 的 `z.string().max(512)`、`kernel/schemas/evidence-pack.schema.json` 的 `maxLength: 512`、daemon `Dispatcher.swift:80`）按 UTF-16 计量 ⇒ 一份契约两个答案，daemon 收得下、壳与 schema 拒 | 已修：改 `utf16.count`。用例：512 个组合序列 / 512 个 astral 字符 ⇒ GP_E_BAD_PARAMS，且被接受串必过 EvidencePack 自身不变式 |
| W6 | `EngineCore.swift:1484 + 2288-2303`：`assert_element` 无 operationId 时走 `resolvedPack(operationId: nil)`，磁盘兜底是 `lastOnDisk()`（档案里 mtime 最新的一份），而 `attach` 只清内存 history、档案从不按应用划界 ⇒ 挂接到另一个应用之后，断言被记在**别人的**归因（`strong`）、别人的 `signals.act`、别人的崩溃/AX 读数上 | 已修：磁盘兜底限定在本次挂接会话产生的包（或要求包内 act 目标与当前挂接应用一致），否则 GP_E_NO_OPERATION 并给原因。测试 `Qoder20261019AttachmentScopingTests`：A 上 act ⇒ 挂 B ⇒ assert 必须拒，且不得落一份带 A 归因的档案 |
| W7 | `EvidenceStore.swift:382-386`：`replaceItemAt` 在"发布后隔离判定"之前就已覆盖旧条目，而判定失败分支会 `removeAfterRefusal` 删掉发布路径 ⇒ 重写同一个 operationId（diagnose→replace→persist 是正常路径）可能让原本存在的档案条目变成不存在 | 已修：证明不了隔离就不替换（或拒绝时恢复原字节）。测试 `Qoder20261019ArchiveHonestyTests` |
| W8 | `LocalArchive.swift:297,281`：面板侧读者用裸 `decode`（不跑 `validateInvariants()`）且收任何 `*.json`，daemon 侧用 `decodeAndValidate` + `isEntryName` ⇒ 两套读者两套判决，面板渲染出来的行 daemon 回 GP_E_NO_EVIDENCE | 已修：面板侧改用同一套名字判定与校验，违反不变式的计入 `unreadableFiles` |
| W9 | `LocalArchive.swift:290-301`：`totalBytes` 只累加读得动的文件 ⇒ 同一份档案一边被报"部分不可读"、一边被报出偏小的体积（`EvidenceStore.stats()` 对每个条目都取 `.fileSizeKey`） | 已修：不可读的条目也计入尺寸 |
| W10 | `EvidenceModels.swift:609`：账本整数快路径的界写成 `9.007_199_254_740_992e14`（=9.007e14），而它自己的注释（:574-578）说的是精确整数边界 2^53；[9.007e14, 2^53) 的整值因此被写成 Double 而非裸整数——正是注释声称要防的分叉 | 已修：常量改到 2^53。`{"n":1000000000000000}` 必须与内核夹具逐字节相同 |
| W11 | `CanonicalJSON.swift:63`：跨语言格式化只覆盖整值 Double，非整值走 `String(describing:)`；它自己的注释写明 Swift 会切指数形式而 `JSON.stringify` 到 1e21 前保持定点 ⇒ 同一个数两种规范字节、两个摘要，而摘要正是载荷长度上界在量的东西 | 已修：非整值按 JS 口径格式化；`0.00001`、`1.5e20` 与真跑 `node` 取得的 `JSON.stringify` 输出比对（不手推） |
| W12 | 待决：`TreeDigest.swift:33` 用 `JSONEncoder`，而 `CanonicalJSON.swift:5-6` 声称自己"被树摘要使用" | 按实测判定（见 §3 反向验证 R-1）：两条通路对含控制字符的标题给出**同一串字节** ⇒ 注释的主张成立、不是缺陷；主张与实测已写进注释 |
| W13 | 待决：`DurableFileWrite.swift:134-151` 容忍目录 fsync 的 EACCES/EPERM | 按本机 APFS 实测判定（见 §3 R-2）后处置，理由留在注释里 |
| W14 | **本轮新发现（并行泳道之间造成的空档）**：探针 SDK 新增了 `truncatedValues` 计数并在 `hello` 里发布，`SECURITY.md` 也跟着承诺"读者能区分'帧没到'与'值被截短'"，但 daemon 侧**没有任何读者**（`grep -rn truncatedValues engine/Sources/` 为空）——一个无读者的计数＝文档替一个没人消费的数字背书 | 已修：`ProbeWire` 解码 + 重连合并 + `ProbeInbox.statusJSON` 发布，走与其它计数器同一条 `counter()` 精确-range 路径；测试 `Qoder20261019ProbeCounterReaderTests` 5 条，其中 4 条在"把发布打断"的变异下具名变红（§3 R-3） |

### 2.2 判定、权限与捕获（Swift）

| # | 缺陷 | 处置 |
|---|---|---|
| J1 | `Classifier.swift:75`：`pixelChanged` 由 `pack.signals.pixelDiff?.changedPixelRatio ?? 0 > 0` 得出，把"没量"折成"像素没变"，再喂给 T4/T5/T7；同一文件对 `stateDiff` 用的是三态（`stateChanged == false` 必须是量出来的 false），对 T6 用 `guard let pixelDiff … else inconclusive` | 已修：像素通道改三态，未量到时收回需要"像素未变"的分支。测试 `Qoder20261019ClassifierHonestyTests`（nil 通道不得支撑 T5；量到 0 的同一包仍须落 T5——这条对照防止"改绿成永不判定"） |
| J2 | `DaemonProbe.swift:372-394`：绝对时限只在 EAGAIN 分支查；每 <3 秒滴一个字节的读者让 `SO_RCVTIMEO` 一路重计时，却推不动 deadline，注释里"最多拖到 deadline + 一次 syscall"因此是假的，最坏拖到 64 KiB 上限 | 已修：每轮读迭代先查 deadline（含 `count > 0` 那半）。`Qoder20261019DribblingPeerTests` 用**真 AF_UNIX listener** 每 50 ms 滴一字节、1 秒时限实测：修前那一趟跑了 **11.28 秒**并把它报成"对端送了 200 字节没有合规答复（cap 200）"——即把字节上限当成了时限；修后同一用例 1.0 秒级返回并点名绝对时限。文件头写明 `HumanInterventionAuditTests.swift:277` 那组注入时钟的用例为什么**结构上看不见**这件事 |
| J3 | `DebugCapabilityProbe.swift:150`：attach 那一路跑 `xcrun lldb --batch --attach <pid>`，而 lldb 没有 `--attach` 这个选项——本机实测 `xcrun lldb --help` 只列 `--attach-name/--attach-pid/-n/-p/--wait-for/-w`，直接调用回 `error: unknown option: --attach`。本仓另一语言侧早就修过同一件事（`bridge/glasspane_bridge.py:696-699` 写明"`--attach` 不存在…真机复验抓到这个参数缺陷"，改用 `-p`），`engine/smoke.md:218-224` 也留着 `"attach":{"state":"spawnFailed"}` 的读数。⇒ 这一路自始至终没量过 attach | 已修：改用 `-p pidText`；argv 由注入的 `Running` 钉住（`Qoder20261019AttachArgvTests`） |
| J4 | 同文件：victim 只活 30 秒而探针预算 120 秒，且 `classify` 把任何含 "attach failed" 的输出判 `.denied`。本机实测 `lldb --batch -p <已死的 pid>` 输出正是 `error: attach failed: no such process` ⇒ 一次"允许调试但慢"的运行会被说成"系统拒绝授权" | 已修：victim 生命周期覆盖预算；"no such process"归到 spawnFailed，不再冒充席位判决 |
| J5 | `InputMonitoringPermissionProbe.swift:39` / `ScreenCapturePermission.swift:45` / `DaemonPermissionSnapshot.swift:213`：`hasRequestedThisRun ? .denied : .notDetermined` ⇒ 刚发起系统请求、TCC 还没判决的那一刻被报成 denied，面板原样打印"已拒绝"（`SettingsPanelView.swift:786`） | 已修：未答之前不替系统作判决。测试 `Qoder20261019PendingRequestStateTests` |
| J6 | `AccessibilityPermissionProbe.swift:52`：`isTrusted() ? .granted : .notDetermined` ⇒ 真被拒的席位被显示成"未请求" | 已修：不可判定就说不可判定。测试 `Qoder20261019UntrustedAxTests` |
| J7 | `SCKCapturer.swift:455,523`：遮挡兜底路径把窗口的**全局** frame 当 `sourceRect` 交给 SCK，而本仓 P1 规格写明 sourceRect 是显示器逻辑坐标；同文件拿同一个 rect 与 `display.frame` 比较，恰好证明它是全局的 ⇒ 非主显示器上裁的是别处的屏幕区域，却按那个 windowId 的名义作为证据返回 | 已修：抽纯函数 `cropRect(window:display:)` 减去所选显示器原点；单位用例覆盖 (0,0)/负原点/正原点/不相交四种 |
| J8 | `SCKCapturer.swift:212 vs 524`：零面积闸放过了亚像素窗口，`max(1, ceil(...))` 随后造出注释里说要拒绝的"合法但空白的 1×1 截图"，把一个像素的"比例"送进证据 | 已修：输出尺寸任一为 1 像素即拒绝并说明，不再制造空白读数 |
| J9 | `PixelDiff.swift:10-11 vs 137`：`bounds.y` 是 bitmap 的行下标而 CGContext 原点在**左下**，而本仓契约写死"row 0 = 顶"；这个数会进证据报告与面板 | 已修：y 改顶原点，注释/报告/面板三处口径统一；用 `CGDataProvider` 真造"只改顶行"与"只改底行"两幅图断言，不手推 |
| J10 | `CGEventInputMonitor.swift:88-91`：tap 掩码只覆盖 keyDown + 三种 mouse-**down**，而 `EngineCore.swift:1246` 在结论里说"整个操作窗口都在监听输入流"——一个人只滚动、或只抬起拖拽，被监听事件数为 0，窗口照样归档成"全程 watched 且未污染" | 已修：掩码由导出的 kinds 表生成，并把 `monitoredEventKinds` 随句予读者；测试只断言"句子的种类 == 掩码的位 == 发布的表"这一对应关系，不替产品固定该监听哪些种类 |
| J11 | 同文件 :98-105,363-387：`installTap` 的 shuttingDown 竞争 invalidate 了 port 却不释放创建的 `CFRunLoopSource`；可 join 的 `stop()` 路径上 `tapAlive` 要等一次泵转才置 false（其间仍声称在监听） | 已修：释放 source；置 false 先于 disable。测试 `Qoder20261019StopPublishesImmediatelyTests` |
| J12 | `RestorePipeline.swift:173-180`：步骤排序比较器在步骤的 domain 不在 `computed` 里时与 A、C 都判等而 A<C ⇒ 不是严格弱序，调用方给的步骤顺序不确定 | 已修：先把未知 domain 的步骤沉底/过滤，并断言传递性。测试 `Qoder20261019UnknownDomainOrderingTests` |
| J13 | `AXChannel.swift:236-244` + `UILayoutAudit.swift:69`：预算中止后未走的兄弟**不产生任何节点**，于是 `coverage.ratio = measured/total` 的分母只含看过的部分——文件注释自己写着"看过 5% 也能报出 ratio=1.00" | 已修：中止点按兄弟补占位并/或未完成时不给 ratio。测试 `Qoder20261019AbortedWalkCoverageTests` |
| J14 | `EngineCore.auditUI` 的载荷把 `complete`/`stopReason` 作为一等字段交出去（注释说 README 对外承诺的就是这两个），却没有交出**实际走过的深度**，而 `snapshot` 那边有 `captureDepth` ⇒ 省略 `maxDepth` 的调用方读到 "verdict: pass, complete: true" 时无从知道量到的范围 | 已修：审计载荷带上所用深度，与 `captureDepth` 同一命名法。测试 `Qoder20261019AuditDepthFieldTests` |

**复核后不成立的一条**：泳道 2 把 J14 的同类问题报成 P0——"深度截断的走查仍报 `complete: true`，于是 `gp_audit_ui` 能对没访问过的子树发 pass + ratio 1.00"。回代码复核：`auditUI` 的载荷已经把 `complete` 与 `stopReason` 做成一等机器可读字段，`maxDepth` 是调用方在 schema 里自己声明的范围参数（1…10），`complete` 的语义是"承诺的那次走查走完了"，`.pass` 也已同时受 `complete` 与 `overlapScanTruncated` 约束。把深度截断改判成"未完成"会推翻调用方自己选的**范围**，不是诚实性修复。残留的真实缺口是"没交出用了哪一层深度"，即 J14。

### 2.3 daemon CLI 与设置面板（Swift）

| # | 缺陷 | 处置 |
|---|---|---|
| C1 | `main.swift:514` `writeJSON` 在编码失败时 `guard … else { return }`：一份发不出去的报告**什么都不写并退 0**。本文件自己的注释（:1078-1081）把"零输出 + 退出码 0"列为这条命令帮助文本禁止的形状，`--list-projects`（:797-810）与 `--recipe-validate`（:1073-1092）已各自建好正确形状（stderr 的 `{command, encodeFailed:true, error, next}` + 非零），其余 ~27 个调用点被落下——正是"改了 A 面而 B 面仍按旧行为走" | 已修：把保证收进咽喉点——`writeJSON` 编码失败即自行输出 encodeFailed 拒绝并非零终止，任何现有或新增调用点都不可能再"零输出退 0" |
| C2 | `main.swift:709,716,755,774,1100,1168`：子命令按首个匹配执行，其余**静默跳过且退 0**。本机实测 HEAD：`glasspaned --state-dir <tmp> --version --evidence-stats` 只打印版本、退 0，第二条命令什么都没做 | 已修：先收集被点名的命令，多于一条即 64 拒绝并点名，任何命令执行之前 |
| C3 | `main.swift:760-770`：`--request-permission <kind>` 无条件 `exit(0)`，席位落在 denied/unverifiable 也被 rc 分支的调用方读成成功；隔壁 `--check-developer-tools`（:739）已是 `granted ? 0 : 1` | 已修：未 granted 即非零，`--help` 里写明（测试用注入的探针接缝，绝不触发真 TCC 弹窗） |
| C4 | 面板看不见用隔离旗标起的 daemon：`GlassPaneSettingsApp.swift:22` + `SettingsModel.swift:187` 只探测 `DaemonProbe.defaultSocketPath`，而 `--state-dir X` 绑的是 `X/daemon.sock`；`mcp-shell` 与 `updater/lib/idle.js:146` 都认 `GLASSPANE_ENGINE_SOCK`，`grep GLASSPANE_ENGINE_SOCK engine/Sources` 为空 ⇒ 一个正在答话的 daemon 被报成"后台服务未运行"＋四张未验证卡 | 已修：面板按 显式 socket → `GLASSPANE_ENGINE_SOCK` → `<状态根>/daemon.sock` → home 默认 `engine.sock` 的顺序解析，并说出它连的是哪一个根（解析器做成纯函数以便单测；未动 `DaemonProbe.swift`） |
| C5 | 更新页无视 daemon 报告的状态根：`UpdateModel.swift:48,53` 的根在 init 时定死且不可变，`UpdatePanelLogic.swift:899` 的 `pointerFile`/`caBundleFile` 都在那儿读写，而 `ConsoleRootView.swift:104` 只把 `hello.stateRoot` 喂给 console。`ConsoleModel.swift:148-152` 把同一形状记成它**只替自己修好**的 P1——半修。后果：daemon 在沙箱里跑，自动更新的 enable/disable 与两个指针文件写进真实 `~/.glasspane`，同一窗口里两行"状态根"没有任何一行说明各是谁 | 已修：更新页采纳 daemon 报的根并重解析两条路径；每行按来源标注 |
| C6 | `ConsoleModel.swift:129,620,639,646`：`isRunningPrune` 写了但没有任何视图读者（`grep isRunningPrune engine/` 只命中模型），最长 20 秒的真删除期间清理控件已回到 `.ready`；`PanelActionReadoutTests.swift:118` 把模型里那句自守当成"有读者" | 已修：加在飞的 `.blocked` 分支并渲染；闸改为要求写动作状态必须有**视图**读者 |
| C7 | `EvidenceTabView.swift:438-443,727-730`：「打开报告」旁边的文件夹按钮没有闸——`revealFile()` 在 `filePath` 为空或包读不动时静默 return（按下去无事发生），而它的兄弟是按 reason+next 建的 | 已修：纯函数 `revealFileControl(packLoad:filePath:)` 给出禁用理由与下一步 |
| C8 | `SettingsModel.swift:69,699` + `SettingsPanelView.swift:226`：`lastRefreshError` 只被赋过 `nil`，那行红色错误文案是不可达 UI | 已修：接回真实失败状态（不删行） |
| C9 | `RecipesTabView.swift:64,459-462`：副标题声称所示结构的真源是 `kernel/schemas/recipe-config.schema.json`，而 `load()` 只试 CWD 相对路径 ⇒ launchd/Finder 起的面板（cwd `/`）永远显示内置快照却说真源是 schema | 已修：如实说出当前显示的是哪一份，并暴露成可断言的字段 |
| C10 | `GlassPaneSettingsApp.swift:7` 的注释"面板不持久化任何配置"与 `@AppStorage`（recipe 草稿、卡片折叠态）矛盾 | 已修：改为如实写明持久化的是 UI 本地草稿/折叠态，不持久化任何测量与判决 |

### 2.4 MCP 壳（TypeScript）

三处镜像实测（本轮复算，不信文档）：daemon `EngineMethod` 13 个线名、`capabilityWireNames` 11 个、`Dispatcher` switch 13 臂一一对应、`methodNotFound` 的 remedy 点名 13 个；壳侧 `TOOL_SPECS` 16 个 `gp_*`，其中 11 个与 daemon 集合**逐名相等**（双向差集为空），另外 5 个是壳本地伪方法且 HTTP 网关的可转发集合不含它们；内核 `kernel/schemas` 8 份，与装好的 `iterate-kernel@0.1.8` `diff -rq` 为 0。三处一致 ⇒ 工具面数目本轮不写死也自洽。

| # | 缺陷 | 处置 |
|---|---|---|
| T1 | `update-state.ts:403,478,491`：absent/unreadable/unresolvable 三态的出路印的是 `node updater/cli.js check` 与 `… enable`——按读者 cwd 解析的相对命令，而发布物的 `files` 只带 `dist` 与 `schemas`，那条路径在装好的包里不存在；`tools.ts:1466-1468` 明明已为 `kind==="read"` 建了解析绝对路径的那条路 | 已修：走同一口径；点不出绝对路径时直说。测试 `qoder-20261019-remedy-executability.test.mjs`（红在"既没给绝对路径的命令，也没明说点不出"） |
| T2 | `tools.ts:901-927` 的收窄旋钮表只认 `maxDepth/scale/limit/selector/role/title`，于是 `gp_restore` 收到"这个工具没有能缩小回应的参数"——而它自己发布的 schema 里就写着 `steps`（`maxItems:64`），daemon 侧 `ParamValidation.stepsLower/Upper` 收 1…64、`EngineCore` 按步重放 act，壳的 deadline 预算也是 RESTORE_BASE + steps×120s；`test/tools.test.mjs:1490` 还把那句假话**断言成绿** | 已修：加 `kind:"steps"`（数组取 minItems/maxItems 与长度），并把那条断言翻成"必须点名 steps 且不得再说不存在这种参数" |
| T3 | `http-gateway.ts:758-765`：聚合证据路由在 GP_E_NO_EVIDENCE 上断言一个没量过的原因（"引擎可能重启过"），而 MCP 那一半（`tools.ts:2613-2622`）早为同一句话重写过，网关里也没有任何重启探测 | 已修：改成与 MCP 同一事实的说法，不替重启作证 |
| T4 | `engine-client.ts:1184-1192`：无 remedy 兜底对**任何**方法拼"看 daemon 日志（stderr）并重试"，包括 act/restore/attach，与同文件的 `REPLAY_UNSAFE_REASONS`/`slowEngineRemedy`/`writeBacklogRemedy` 的"不许命令重发"规矩相反 | 已修：兜底改按方法分岔（复用 `isReplayUnsafeMethod`），读方法保留"可以再问一次"那半句 |
| T5 | `project-registry.ts:396,400`：同一条 GP_E_INTERNAL 里，message 教人跑 `python3 -m json.tool`，而 remedy 坚持"两个读取器都要绝对路径，因为它们不依赖可能被改掉的 PATH"——一条错误两条相反的规矩，stock macOS 上没有 python3 | 已修：两条 message 共用 `registryReaders()`（绝对 `/usr/bin/plutil` / `/bin/cat`）；测试扫全文（剥注释后）确认没有裸 python3，并断言剥离器没把代码本身剥掉 |
| T6 | bundleId 上限三处两个答案：`gp_attach` 512（与 `Dispatcher.swift:80` 同口径）、`gp_project_set` 256、daemon 自己的注册表不设限 ⇒ 一个 300 字符的 bundleId 能挂接、永远注册不上 | 已修：壳侧统一到 daemon 的 512，`consumer-consistency.test.mjs` 成对钉住（数字从 Swift 读回来，不抄字面量） |
| T7 | `stdio-session.ts:137-140`：超大入站帧答 JSON-RPC `-32600 (Invalid Request)` 而 message 以 `GP_E_PAYLOAD_TOO_LARGE:` 开头——数值码与内嵌码互相反对（两处都各自有独立码：`errors.ts:41`、`Dispatcher.swift:20-24`） | 已修：不新造协议——message 先说它自己码所属的那一类，再把 GP_E_ 标成"这一面与 daemon 对同一帧的标签"；`published-artifact.test.mjs` 钉住的 -32600 与可 grep 的 GP_E_ 都还在 |
| T8 | `dispatch.ts:232,236,240`：`Unknown tool: …` 这类协议层拒绝根本没有 remedy（错误帧必须三字段），调用方的下一步只能再猜一个名字 | 已修：三条 `tools/call` 形状拒绝都带 `| remedy:`，点名的工具一律来自这一面自己发布的列表；测试另外打一个只发布一个工具的 server，防止出路里的例子来自全量表 |
| T9 | `project-registry.ts:92-100` 的注释断言一个**仍然开着**的跨语言分叉（"EngineCore.resolvedStoragePathDefect 还在按精确相等比较 … 本层收不了"），而 `EngineCore.swift:427-436` 早已改成子树匹配——交付源码里替一份已经修好的契约作伪证 | 已修：注释随实状改写；`qoder-20261019-matcher-parity.test.mjs` 钉的是两侧匹配规则**等价**，不再只钉清单等价 |

判定权没漏（实测干净，记下来免得下轮重找）：`isError:false` 要求 daemon 帧里真有 `result`；`gp_capture_view` 不肯给 `persisted`/`mimeType` 兜默认值；`evidence-report.ts` 逐字映射 daemon 字段并对六条空通道打印具名"not measured"；`dispatch.ts` 显式回避比较归因。

### 2.5 安装器 / 更新器 / 脚本 / 发布链

| # | 缺陷 | 处置 |
|---|---|---|
| R1 | `.github/workflows/release.yml:210-212`：`gh release edit --draft=false --latest` 之后只**打印** draft，从不判。GitHub 会把 Actions 身份建的发布留在草稿态；留在草稿态时 `/releases/latest` 继续服务上一个 tag，而 `updater/lib/check.js:238-243` 把"已发布的最新比本机还旧"判成 up-to-date + exit 0 ⇒ 这一格绿着让每台机器安静地停止更新（先例见 v1.4.0 的签名事故与 harness 线那条 `[ "$state" != "false" ]`） | 已修：读回 isDraft/latest/资产数/target 逐项判红；一条校验都没删。`scripts-check-workflows.test.mjs` 补一条扫 workflow 本体的电池（改 workflow 之后若把断言删掉，CI 必红） |
| R2 | `scripts/assert-ci-green.mjs:147`、`check-doc-links.mjs:536`、`make-release-archive.mjs:511`：自执行守卫比较 `path.resolve(argv[1])` 与 `fileURLToPath(import.meta.url)`，**两边都不 realpath**。Node 按真实路径加载 ESM 入口，所以经符号链接调用时守卫为假、`main()` 不跑、进程退 0 且零输出。本机实测（07:40）：`node scripts/assert-ci-green.mjs` → rc 1 + 一句拒绝；同一个文件经 `/var/tmp/.../acg-link.mjs` 符号链接 → rc **0**、无输出。`make-release-archive.mjs` 直接 rc 2 vs 经链接 rc 0 沉默。同一形状本仓已在三个 npm/launchd 交付入口上修过（`installer/cli.js:2693-2710` 等）却没有回流到这三道闸 | 已修：三处都两边 realpath。测试：`symlink + spawnSync` 断言非空 stdout 且非零退出（修前该断言红） |
| R3 | `updater/lib/launchd.js:618-653 registerAgent`：`bootout` 失败而 `bootstrap` 回"Already exists"时仍报 `ok:true, verified:true`——读回来只比 argv，而作业 argv 按设计稳定（`codes.js:102-107`），所以只改时刻/环境的那一次永远"匹配"，launchd 手里仍是旧定义，`enable` 退 0。`installer/cli.js:813-820` 对同一次 bootout 失败是直接拒——两个读者两条规矩 | 已修：bootout 不成功就不给 verified，并把装载中的作业按 schedule 与 env 各自判一次 |
| R4 | `updater/lib/policy.js:176-180,127-134`：旗标在但值解不出来（argv 以 `--state-dir` 结尾，或值以 `-` 开头）时 `stateDirReadings` 推一个 `null`，而"多读数即 unknown"只作用在 `readings.length>1`；`foreignStateDir` 的 `if (!named) return null` 于是把它读成"没旗标 ⇒ 是我们自己的 ⇒ 允许换版" | 已修：解不出即 unknown/deferred，与多读数同一处理 |
| R5 | `updater/lib/policy.js:60` + `apply.js:1421`：major 的 needs-consent 只说"到面板按安装更新"，另两道同意门各点一条跑得动的命令（`--consent state-dir` / `--consent unsigned-release`）——最要紧那道反而没有可执行动作，而 `CONSENT_KINDS` 里 `major` 一直在、`apply.js` 也认它 | 已修：两处话术都补 `updater apply --consent major`（面板那条留着），并把"每条 needs-consent 必点一种真实存在的 --consent"钉进 `remedy-surface.test.mjs` |
| R6 | `updater/cli.js:219-223` 与 parseArgs :122-124：`--state-dir ""` 被收下又被 `trim() !== ""` 判成"没给"，于是静默落到**活的** `~/.glasspane` 并在里面写 state/staging——调用方以为自己圈了沙箱 | 已修：空值是用法错误（退 2），用例并断言活的那份文件没被碰 |
| R7 | `updater/lib/fsutil.js:56-66,115-124` + `staging.js` / `state.js`：所有包含承诺都是词法的（只 `path.resolve`），而同一个文件为了"符号链接分量破坏字符串相等"专门有 `realWithin`——那套只用在运行时/作业路径上，**没用在守卫删除的那根**上。状态根或 `<root>/update-staging` 是指向别处的符号链接时，staging 写入、saveState/writePointer、discardStaging/retireStaleGenerations 都落在链接指向处（含真实 `~/.glasspane`） | 已修：包含判定比 realpath；请求的根解析后就是默认活根而没有 `--consent state-dir` 时拒绝。新测试 `qoder-20261019-symlink-root.test.mjs`：链接指向另一目录时，目标目录逐字节不动且没有 `update-state.json` |
| R8 | `install.sh:109-111` vs `installer/cli.js:1908-1929`：`assert_repo_url` 用 `${1%%://*}` 裁 scheme，值里没有 `://` 时那返回整串 ⇒ 裸词 `https`/`ssh`/`file`（含大小写变体）命中白名单被放过，而 `validateGitRepoUrl` 拒它们。放过的那半是 `curl | sh`，它把值原样送进 `git clone` argv，失败还要被归因成"ref 不存在或网络不可达" | 已修：与 JS 同形——整值小写后比**带分隔符的前缀**，同一个值两侧说同一句话（矩阵补 `https`/`ssh`/`file`/`HTTPS`/`File`/`http` 六个值） |
| R9 | `updater/lib/idle.js:153 resolveEngineSocket` 自己重读状态根且只认 `--state-dir` 一种拼法，而 `STATE_ROOT_FLAGS` 早冻成 `["--state-dir","--state-root"]`、`renderAgentPlist` 的 daemonFlag 默认就是 `--state-root` ⇒ 用另一种拼法写的作业，探的是**这一轮**的 socket。顺带：`policy.js:139-143` 的注释断言"daemon 自己的选项是 `--state-root`"是假的（`main.swift:174` 解析 `--state-dir`），正是这句假话让分叉长期不可见 | 已修：idle 改用同一个读者；注释按实测改正 |

### 2.6 桥 / 探针 SDK / 安全 / 文档

| # | 缺陷 | 处置 |
|---|---|---|
| B1 | `bridge/glasspane_bridge.py:739-741`：`--out` 用 `open(path,"w")` 写被调进程的寄存器与栈帧局部变量——模式随 umask（文档给的用法就是 `--out /tmp/capture.json`，于是世界可读）、已存在文件被静默覆盖、目标是指向别处的符号链接就是以用户身份改写任意文件。Swift 侧同类写者（`EvidenceReportGenerator.swift:189`）本来就 `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` 并要求 mode 0600 | 已修：同一形状；拒绝时回一句 JSON 形状的失败而非写出去。pytest 79 → 82（三条新用例：已存在普通文件拒、符号链接拒且不碰目标、umask 000/022/077 下一律 0600） |
| B2 | `engine/probe/.../GlassPaneProbe.swift:206,216-217,223`：Z2/Z3 的上界按**字符/节点数**计（`stateValueCharCap = 1024`、`prefix(cap)`），4000 个 Mirror 节点 × 1024 个中日韩字符 ≈ 16 MB UTF-8，远超 daemon 的 4 MiB 帧上限（`FrameCodec.swift:7`），而 `:219-222` 的注释承诺的正是"把最坏情况罩在一帧里"。后果不是读数降级而是整条通道被丢 | 已修：按编码字节截且落在字素簇边界、`truncatedValues` 具名计数；写帧前量序列化后的字节，超预算即**具名丢弃**（复用已有 `droppedWrites` 通路，不再新增第二套计数器）。29 → 36 用例 |
| B3 | `SocketDirectoryRule.swift:23-58`：socket 目录规则会**跟着符号链接** chmod 并 bind，而档案侧早就拒这种形状（`EvidenceStore.swift:855-867` 的 `nameIsUsableArchiveDirectory` lstat 拒 `S_IFLNK`，理由写着"chmod 会跟着符号链接走"） | 复核后定性：泳道 1 明确把 `SocketDirectoryRule` 与 `StateRoot.isolateFile` 记为"本轮查过、干净"，与泳道 6 的 Low 结论冲突——见 §3 R-5 的实测判定，不靠谁的措辞 |
| B4 | `SettingsModel.swift:657-658` + `PermissionStatus.swift:358-361`：一次性 launchd 脚本 chmod **0755**，`--permissions` 的输出由 shell 重定向按 launchd 的 umask 创建，而所在目录的隔离只拒绝 group/world **可写**、不管可读 | 同上，按 §3 R-5 实测处置；`EvidenceReportGenerator.swift:200` 对同一类屏幕派生物要求 0600，这个不对称本身是判据 |
| B5 | `SECURITY.md` §2.6 把 `--setup` 说成"读目标进程内存"，而它被逐字插进 lldb 的 `-o`，等价于以用户身份执行任意代码 | 已修：双语照实写明执行等价性 |
| B6 | README（双语）:392/:344 与 ITERATE.md:11 称证据包存有"前后 accessibility 树"；已发布语料里 `evidence-pack.schema.json` 的 `axEvent` 只有 treeDigestBefore/After + nodeCount + axChanged + latencyMs 且 `additionalProperties:false` | 已修：改为"前后树摘要 + 结构差异"，与 `SECURITY.md:194`、README:375 的既有口径一致 |
| B7 | CONTRIBUTING（双语）的 CI job 表列了一条并不存在的 `kernel` lane，并漏了真的 `publish-gate-selftest` | 已修：按 `ci.yml` 实测的 9 个 job 改，并写明内核语料核对是 install-gate 里的**一步**（`ci.yml:146-147`），不是一条 lane |
| B8 | `SECURITY.md:176-177` / `SECURITY.zh-CN.md:131` 说"§2.4 记着一条今天仍然存在的、状态根里世界可读的文件"，而 §2.4 已写"两处都关上了"，代码也关着（`installer/cli.js:1587-1614` 以 0600 开日志并回读模式；`StateRoot.swift:239-245` 在 daemon 起时扫这两个文件名） | 已修：删掉"今天存在"，保留"模式不随复制走"的警告 |
| B9 | `SECURITY.md:196-197` 说状态值"各截到 ≤1 KiB"，实测 SDK 是 1024 **字符** | 已修：随 B2 的代码改动一并改为按编码字节 1024、落在字素簇边界、计入 `truncatedValues`，并写明超预算的帧被具名丢弃 |
| B10 | README.md:477 的 `# TS: kernel, mcp-shell, installer` 报错工作空间集合（根 `package.json` 是 mcp-shell/installer/updater；`kernel/` 没有 package.json） | 已修：双语改准 |
| B11 | README.md:79,167 称报告"可以在浏览器里读或存到 commit 旁边"，而 `gp_export_evidence` 不落盘、也没有路径参数（`tools.ts:584-592`；`SECURITY.md:209-217` 本来就写对了），唯一的写者是面板那个按钮 | 已修：改为"返回文本、自己不写文件；面板的「打开报告」是唯一写者" |
| B12 | `bridge/crashcanary.swift:5-6,17-26` 称随附样例是它的"等价再生成源"，但 `capture-sample.json:205-215` 第 4 帧是 `crashme.swift:4` 的 `main`、模块 `crashme`——那份 Mach-O 来自已删掉的夹具 | 已修：头注释如实标明它是遗留夹具数据（只动注释；不重采样——重采样要编译，Swift 侧另有泳道在跑，且这不是本轮的收口项） |

### 2.7 交给 harness 线的那一条（不改、不发版，按纪律只给判据）

`harness/tools/tool-surface.mjs:59` + `harness/contracts/tool-surface.json:3` 的 `limitSource` 指向 `specs/GlassPane_Design_Decisions.md`——该文件不存在（`specs/` 26 份，无一命名如此），而 `scripts/check-doc-links.mjs` 只走公开文档，所以尺子自己的出处链接没人核过。**该由那条线修**，判据：`harness/` 的内容/版本/发版都在那条线上（本轮任务明确禁止我改它，改了就撞车）；修法二选一——把 `limitSource` 指向真存在的决策记录，或把 `harness/contracts/*.json` 的链接纳入 docs lane 的检查。本轮我未动 `harness/` 任何字节。

## 3. 反向验证（每个新闸都必须能变红）

| # | 破坏的东西 | 具名变红的用例 |
|---|---|---|
| R-1 | `TreeDigest` vs `CanonicalJSON` 的分叉（W12） | 直接把同一 `AxNode`（标题含 U+0008/U+000C）两路编码比字节——见日志与测试；相同 ⇒ 注释主张成立，不改代码 |
| R-2 | `DurableFileWrite` 对目录 fsync 的 EACCES/EPERM 容忍（W13） | 在本机 APFS 上构造被拒的目录 fsync 并看 errno；判定写进注释 |
| R-3 | 探针新计数 `truncatedValues` 的读者（W14） | 把 `ProbeInbox.statusJSON` 里那三行发布改成一行注释（备份 + sha 核回，不用 git checkout），`swift test --filter` 两套件：**4 条具名用例变红**（`testTruncatedValuesSurviveTheWireIntoTheStatusRow`、`testAbsentTruncatedValuesIsNeverRenderedAsZero`、`testRehelloWithoutTheKeyKeepsTheEarlierTruncationCount`、`testFrameLossAndValueTruncationStayTwoNumbers`），第 5 条（越界即无计数）本就该绿——它是"缺席"的对照。恢复后 sha 与备份一致（`063ddf1c…`），21/21 绿 |
| R-4 | `.signal_smoke.py` 的就绪握手 | 负载下（本机 load 曾到 ~69）首轮红、隔离复跑绿即它的红样；修后按 verbatim 命令复跑两趟 + 高负载下六趟均 OK，判据与超时未改 |
| R-5 | 面板/CLI 的两条源码形状闸（`MainRegistryRefusalTests` / `RegistryCliRefusalShapeTests`） | 面板批次把 `writeJSON` 改成咽喉点退出后，这两条按"块内 `exit(0)` 计数==1"的旧表达式量到新结构报了 7≠1；处置要求是把**同一条规矩**改写成更精确的形式并附变异证明（把 encode 失败路径改回 exit 0 ⇒ 必须变红），不许只把期望数字改掉 |
| R-6 | release.yml 的 draft 断言（R1） | `scripts-check-workflows.test.mjs` 那条电池在**改 workflow 之前**先跑一次：没有断言的 release.yml 必须让它红（泳道已实测；本轮在最终门禁里复跑） |
| R-7 | 符号链接让闸静默退 0（R2） | 本机实测两轮：修前 `node <symlink>/assert-ci-green.mjs` → rc 0 且零输出（`make-release-archive` 同形状 rc 0 而非 rc 2）；修后三个脚本经符号链接调用都回非零并打印句子（rc=1/2/0-with-output），这条不依赖任何人的转述 |

诚实性说明：本轮有两条"我本来可以只改期望值让它绿"的闸（R-5、以及 T2 那条断言假话的用例），处置都是先把规矩重述成能表达的形态、再证明它能红，而不是把红消掉。
