# GlassPane P0 — 真机冒烟流程（A7）

> 对应 P0 实施规格 §7.3。CI 不承载本流程：AX 依赖辅助功能权限与真实 GUI 会话，
> 因此作为人工/自建 runner 验收步骤存在。

## 前置条件

1. **辅助功能权限**：运行 daemon 的终端（或直接运行二进制的父进程）必须在
   系统设置 > 隐私与安全性 > 辅助功能 中被授予权限。首次使用运行：

   ```sh
   swift run glasspaned --grant-accessibility
   ```

   该命令会弹出系统授权提示并打开设置面板，等待授权完成。
2. **屏幕录制权限（可选）**：仅像素信号需要。未授予时 pixelDiff 为 null、
   熔断级=1、T6 判定退化为 INCONCLUSIVE（降级形态，非失败）。
3. 一个被测 app 正在运行（下例使用 Notes；任意 SwiftUI/AppKit app 均可）。

## 冒烟步骤

```sh
cd engine
SOCK=/tmp/glasspane-smoke.sock

# 1. 启动 daemon（verbose 日志走 stderr）
swift run glasspaned --socket-path "$SOCK" --verbose &
sleep 3

# 2. 完整循环：attach -> act -> observe -> assert -> diagnose -> last_evidence
printf '%s\n' \
  '{"id":1,"method":"attach","params":{"bundleId":"com.apple.Notes"}}' \
  '{"id":2,"method":"act","params":{"selector":{"role":"AXButton","title":"新建备忘录"},"action":"press"}}' \
  '{"id":3,"method":"observe","params":{"maxDepth":3}}' \
  '{"id":4,"method":"assert_element","params":{"selector":{"role":"AXButton","title":"新建备忘录"},"property":"enabled","expected":true}}' \
  '{"id":5,"method":"diagnose"}' \
  '{"id":6,"method":"last_evidence"}' \
  '{"id":7,"method":"shutdown"}' \
  | /usr/bin/nc -U "$SOCK"
```

> selector 的 `title` 按被测 app 的实际 AX 标题替换（可先用一次 observe 查看树）。

## 验收断言（人工核对响应帧）

| # | 断言 |
|---|---|
| 1 | attach 返回 `{pid, bundleId, appName}` |
| 2 | act 返回 `operationId`（`op_` + 26 位 Crockford）、`actConfirmed: true`、`axChanged`/`pixelChanged`、`latencyMs`、`evidenceId` |
| 3 | observe 返回 `axTree`（role/title/identifier/children）、`nodeCount`、`digest`（32 hex）、`latencyMs` |
| 4 | assert_element 返回 `passed`、`actual`、`operationId`、`evidenceId` |
| 5 | diagnose 返回 `class`（T0–T9/NO_ANOMALY/INCONCLUSIVE 之一）与四字段报告（path/anomaly/evidence/next） |
| 6 | last_evidence 返回完整 evidence 包：`schemaVersion="glasspane.evidence/0.1-draft"`、`operationId`、`attribution.level="soft"`、`circuitBreaker.level` 0–3、`signals.act` 必填、`handlerProbe`/`stateDiff` 为显式 null |
| 7 | shutdown 返回 `{bye: true}`，daemon 进程随后退出，socket 文件被清理 |

## 常见失败形态

| 现象 | 处置 |
|---|---|
| `GP_E_AX_UNAVAILABLE` | 权限未授予/被撤销：重跑 `--grant-accessibility` |
| `GP_E_APP_NOT_FOUND` | 被测 app 未启动，或 bundleId 拼写错误 |
| `GP_E_ACT_FAILED` | selector 不匹配或元素不支持该 action：先 observe 核对 role/title |
| act 成功但 diagnose 为 INCONCLUSIVE + pixelDiff null | 屏幕录制权限缺失（降级形态，非 bug） |

## 真机冒烟记录与观察（2026-09-18/19）

> 对应 P4 v4.0 §33（遗留项落实记录）。真机 = 开发者本机（AX 权限已授予）。

### 已落实环节（脚本已入库，提交 71eee50）

| 环节 | 脚本 | 结果 |
|---|---|---|
| B7（P1 v1.1 §1）attach→snapshot→restore 全链 | `engine/.smoke_client.py` | SMOKE OK：15 断言全 PASS（真实 Notes attach、snapshot 真实 digest、restore ffwd confirmed=1/total=1），restore 后审批台账落盘 + `--approval-verify` count=1 valid |
| C6（P1 v1.2 §6）GUI 面板冒烟 | `engine/.c6_smoke.py` | C6 SMOKE OK：四权限卡/跳转 AXButton/28 文本节点/降级折叠区/窗口标题齐备；attach by pid 验证通过 |
| D6（P1 v1.3 §10）evidence 审查导出 | `mcp-shell/.d6_smoke.mjs` | D6 SMOKE OK：真实 mcp-shell 代码路径导出 markdown/html 四段（PATH/ANOMALY/EVIDENCE/NEXT） |

### 真机观察（如实留档）

1. **AX 菜单栏 item press 挂起**：真实 AXUIElementPerformAction 对菜单项 press 会阻塞（
   冒烟中 30s 超时），此后冒烟一律避开菜单项，改用 role-only AXButton（Notes toolbar
   按钮无 title/identifier，role 即可命中）。
2. **SwiftUI 静态文本走 AX value 通道**：daemon observe/selector 方法表冻结在
   role/title/identifier 三字段（P0 §3），设置面板 body 文本（如"已授予"）不暴露在
   title，无法经 AX 树断言 → C6 冒烟采用结构断言（卡图标 identifier + 同轴按钮 +
   文本行数），此为方法表冻结的既定边界而非缺陷。
3. **daemon 后台进程屏幕录制 TCC 不继承**：circuitBreaker.reason 含
   `screen-recording-denied` 段、level=1 降级形态（spec R45 预期降级，非故障）。
   现行字面形态由 X-6 决定：该段渲染为 `screen-recording-denied: <捕获原文>`，而整串
   reason 又是 `"; "` 拼的多段（还可带 `performance|` / `degradation|` 前缀），所以
   对 reason 的**全等**比较必然不成立——`.p6_smoke.py` 按段匹配（A-02）。
4. **ApprovalGate 持久化陷阱**：`ApprovalGate()` 的 path 默认 nil = 纯内存台账；daemon
   曾注入默认构造导致 restore 执行成功但 approvals.json 不落盘（--approval-verify 恒
   count 0）。显式传 `ApprovalGate(path: ApprovalGate.defaultPath)` 后落盘 + 哈希链
   verify 全绿（fix 8e9b776）。
5. **attach by pid 与 bundleId 双路径**真机均可用（C6 补验 pid 路径）。
6. **全屏截图可被前台第三方 app 抢占**（本机曾误截 Notes/Qoder），GUI 真机验收以
   AX 结构断言为主、截图人工核对为辅。

### 安装器 + 拖拽引导真机记录（2026-09-19，P4 v4.0 §34 / P1 v1.2 §10）

| 环节 | 方式 | 结果 |
|---|---|---|
| 一键安装端到端 | `node installer/cli.js --no-prompt`（仓库根） | 走通：npm install（workspaces）→ kernel/mcp-shell tsc → swift release（21.47s）→ daemon 后台启动（PID 82922）→ GUI 打开（PID 82923） |
| daemon 监听 | `~/.glasspane/engine.sock` + 日志 `installer-daemon.log` | "glasspaned 0.1.0 listening on …/engine.sock"，srw------- 0600 socket 就位 |
| 拖拽引导 | 人工目视（自动模拟拖拽不可行） | 已随安装流程打开 GUI：顶部拖拽横幅（.onDrag 纯文本 GlassPane）+ 四权限卡落点（fileURL 读 Info.plist 可读名 / plainText）+ 落点悬停高亮 + 引导横幅 + 1s 轮询 auto-light；授权点亮与 developerTools"未验证"不假点亮为 P4-I4 待人工项 |

真机观察补充：

7. **open 命令不支持 `--version`**：`checkEnvironment` 对该命令先试 `--version`、失败退化为
   `/usr/bin/open` X_OK 探测，避免误报"未找到 open"。
8. **多 daemon 实例并存观察**：历史调试遗留的 debug 版 glasspaned 进程（PID 69768/69479）
   仍在，安装器不主动 pkill（仅 socket 探测，避免误杀用户手工进程），release 新 daemon
   成功绑定 socket —— 与 P4 §34.4 边界声明一致。

### C33/T9 真机冒烟（2026-09-19，P2 v2.0 §16.2 / v2.1 §19.2 / P4 v4.0 §34.5）

| 环节 | 脚本 | 结果 |
|---|---|---|
| C33（P2 v2.0 §16.2）输入监控真机冒烟 | `engine/.c33_smoke.py` | C33 SMOKE OK：`glasspaned --check-input-permission`=granted（新增 CLI flag，granted/denied/notDetermined 三态如实输出）→ 自动发现 settings GUI → attach → observe（220 节点）→ act（role-only AXButton，operationId 落盘）→ `last_evidence` 归因面如实呈现（attribution.level=soft、contaminated=false、circuitBreaker.level=1）。按 spec v2.0 §17.2 降级口径：输入流污染判定待 daemon 注入 AttributionGuard 后验证（当前为纯操作权互斥形态），本冒烟覆盖授权环境下完整操作回路与归因面观测 |
| T9（P2 v2.1 §19.2）渐进退化泄漏注入冒烟 | `engine/.t9_smoke.py` | T9 SMOKE OK：脚本自编译泄漏金丝雀（AppKit，每次点击保留 8MB 内存 + 1 个 fd），daemon 驱动 act 至第 16/24 轮 → evidence 熔断升级 degraded、reason 携带 `degradation|memory+handles; longSession=false; screen-recording-denied`（当日实测原样；X-6 起末段为 `screen-recording-denied: <捕获原文>`） → `diagnose.class=T9` |

真机观察补充：

9. **设置窗口关闭时 observe 只见菜单栏**：glasspane-settings 进程存活但窗口已关时，
   observe（maxDepth 10）返回 149 节点全为 AXMenuBar/AXMenuItem、无任何 AXButton——
   C33 脚本因此自动发现全部实例并逐个 attach，取第一个树中有按钮者（裸二进制旧实例
   被如实跳过、.app 新实例命中；顺带多实例并存场景验证）。窗口未开时脚本以明确
   失败信息引导先打开设置面板，不伪造目标。
10. **T9 真机可达性**：8MB+1fd/轮 的注入强度下 16 轮（约 16s 节奏）触发双信号正斜率
    联合裁决；`screen-recording-denied` 段（X-6 后带 `: <捕获原文>` 尾巴，判定按段
    匹配）以 R45 预期降级形态共存于 reason，不阻碍
    T9 判定（内存+句柄两信号即满足联合判定）。

### C33 三阶段完整判定冒烟（2026-09-19，daemon 注入 AttributionGuard 后，P4 v4.0 §36）

| 环节 | 脚本 | 结果 |
|---|---|---|
| C33 阶段一 操作权互斥 | `engine/.c33_smoke.py` | PASS：注入器连发 otherMouseDown（未占用键 29，(5,5) 角落，无交互副作用）期间 act 如实得 `GP_E_BUSY_INPUT`（5 次重试×50ms 预算耗尽） |
| C33 阶段二 污染检出 | 同上 | PASS（第 1 次尝试）：注入事件落入操作持有窗 → evidence `attribution.contaminated=true`、`level=weak`（归因如实降级） |
| C33 阶段三 无误杀 | 同上 | PASS：输入静默后 act `contaminated=false`、`level=soft` |
| T9/基础回路回归 | `.t9_smoke.py` / `.c33_smoke.py` 头部 | guard 注入后 T9 SMOKE OK（第 16/24 轮触发，busy 零误伤）、完整操作回路 + 归因面如实落盘不回归 |

真机观察补充：

11. **CGEvent 注入→tap 回调存在百毫秒级投递延迟**：阶段一最初以"注入器启动后 0.3s 即
    act"编排，acquire 时事件尚未入队 → act 未被拒。改为静候 1s 后三阶段稳定全过。
    污染/忙碌判定面对的是真实时序，冒烟编排必须给投递留余量——这是真机面与单测面的
    实质差异之一，如实留档。
12. **launchd 拉起的 daemon 无辅助功能权限（发现，未闭环）**：同一路径二进制，终端子进程
    形态 glasspaned 可 attach（权限随终端责任链生效），`launchctl kickstart`/开机自启形态
    报 `GP_E_AX_UNAVAILABLE`。含义：**开机自启要真正可用，需用户把 glasspaned 二进制自身
    加入 系统设置>隐私与安全性>辅助功能**（设置面板拖拽引导可完成）。本仓库现网处置：
    launchd 作业暂时 bootout、以终端子进程运行冒烟；用户授权后 `launchctl bootstrap
    gui/$(id -u) ~/Library/LaunchAgents/com.glasspane.daemon.plist` 恢复自启即两全。
    （与 §33.1 观察 3"屏幕录制 TCC 不继承"同族：TCC 以责任进程归属，非常驻身份归属。）

### 权限主体修正真机记录（2026-09-19，P1 v1.2 §11）

现场问题：设置面板点「授权」后，系统设置的权限列表里**没有 GlassPane 条目**，且因为
不是打包应用而无法用「+」手动添加。逐条实测（全部本机可复现）：

| # | 观测 | 手段 |
|---|---|---|
| 1 | 裸二进制席位按**路径**记账：原路径 `glasspaned --check-input-permission`=granted，同内容拷到 `/tmp` 后=notDetermined | 双路径对照 |
| 2 | 无 bundle 身份时**继承父 app 判定**：同一 `/tmp` 副本，终端子进程=granted，`launchctl submit`（父=launchd）=notDetermined；重签改 cdhash 不改变这一结果 | 双上下文对照 |
| 3 | 旧 `make-app.sh` 的 `GlassPane.app` 是坏签名：`codesign --verify` → `code has no resources but signature indicates they must be present`；`Identifier=glasspane-settings` 与 `CFBundleIdentifier=com.glasspane.settings` 不一致、`Info.plist=not bound`；且 installer 打包完仍直接起裸二进制（bundle 从未成为运行主体） | `codesign -dvvv` / `--verify --strict` / `ps` |
| 4 | 面板旧版把**面板进程**的 `AXIsProcessTrusted()` 当作 daemon 状态显示（配合观测 2 即"假绿灯"）；`SettingsModel.refreshEntriesOnly()` 为证据 | 代码 + 上下文对照 |
| 5 | 现场并存 3 个 daemon 实例（含 2 个不响应 SIGTERM 的旧构建，socket 被 unlink+bind 抢走留下孤儿）→ 系统设置里的条目与实际服务实例对不上 | `ps` + `hello` 的 pid |

据此落地的修正与验证结果：

- `hello` 新增 `identity`+`permissions`（不新增方法名），面板改读 daemon 自报席位，读不到
  即 `unverifiable` +「本卡不代替其状态」；申请动作改由 `launchctl submit` 让 daemon 以
  **自身身份**发起（`glasspaned --request-permission <kind>`）。
- `make-app.sh` 产出并**整包重签**两个 bundle，DR 为 `designated => identifier "<id>"`
  （不含 cdhash，重编译不丢授权）；`codesign --verify --strict` 两个 bundle 均通过。
- installer 安置到 `~/Applications`、launchd 与 GUI 改走 bundle、新增 `--replace-daemon`
  （SIGTERM 无效者补 SIGKILL）+ launchd 重拉等待 + daemon 单实例护栏（`--force-socket` 抢占）。
- 端到端实测：`hello` 自报 `entryName="GlassPane Daemon"`、`hasBundleIdentity=true`、
  `binaryPath=/Users/ethanlin/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned`，
  三态如实输出 `accessibility=notDetermined / inputMonitoring=notDetermined /
  screenRecording=notDetermined / developerTools=unverifiable`。
- 单测面：engine 新增 23 用例（`PermissionSubjectTests`），当时全量 317 用例 0 失败；
  installer 新增 16 用例，全量 37 用例 0 失败。

- **同一 bundle、两种起法的自报对照（关键发现）**：由安装器经 `open -g -n -a` 起的实例
  自报 `accessibility=granted / inputMonitoring=granted / screenRecording=notDetermined`；
  随后 `launchctl kickstart -k` 起的实例自报 `accessibility=notDetermined /
  inputMonitoring=notDetermined / screenRecording=granted`。用户在系统设置里为
  「GlassPane Daemon」真实勾选的是屏幕录制一项——前一个实例的两项 granted 是**从启动者
  （终端侧 app）借来的**。含义：`hello` 自报只在 daemon 由 launchd/登录项拉起时才等于真实
  席位；面板与安装器文案都必须按这一口径声明，不能因为读到 granted 就断言已授权。
- 另发现：**daemon 不响应 SIGTERM**（`signal(SIGTERM, SIG_IGN)` 后 handler 依赖主 runloop
  被泵，实测两实例收 TERM 后仍存活），故 `--replace-daemon` 必须有 SIGKILL 兜底；这一条
  属运行时面缺陷（P4 §36 同族），本轮仅在安装器侧兜底，未改 daemon 信号处理。

- **辅助功能条目自动出现（用户实测 19:0x）**：点面板「授权」→ 系统设置「辅助功能」列表
  里直接出现带图标的「GlassPane Daemon」，开关可用；输入监控则**不会**自动出现条目，
  用户只能把顶部拖拽栏（此时提供的是 daemon 真身 `.app` 的 fileURL）手动拖进列表才添加
  → 说明"申请"与"登记条目"是两件事，登记动作是创建 event tap（已按 §11.5 修入
  `--request-permission input-monitoring`）。
- **勾选后卡片没变绿的真实原因（关键）**：同一 bundle 身份下，运行中的 daemon 自报
  `accessibility=notDetermined / inputMonitoring=notDetermined`，而 launchd 一次性任务
  跑的**新进程**自报三项全 `granted`——TCC 判定按进程缓存，用户勾的确实生效了，只是
  老进程读不到旧答案。据此新增 §11.4 席位重探 + 「重启 daemon」按钮（不自动重启，
  因为 kickstart 会中断正在进行的 act）。

> 操作提醒：`engine/.c6_smoke.py` 会走完整的 attach/act 回路并在结束时让 daemon
> 收尾（脚本第 2 参数接受任意 socket 路径）。**必须指向它自己起的隔离 socket**，
> 不要把现网 `~/.glasspane/engine.sock` 传进去——真机踩过一次：跑完现网 daemon 直接
> 退出，因 `KeepAlive(SuccessfulExit=false)` 不会被 launchd 复活，需手动
> `launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon` 恢复。

### 合并后权限面复验（2026-09-19 22:4x–23:2x，P1 v1.2 §11.6 / §11.10）

- **调试能力机器验证通道跑通**：按 `PermissionReprobe.script(arguments:
  ["--check-developer-tools"])` 生成一次性 zsh、`launchctl submit` 用 daemon 自己的
  二进制执行，回物 `{"capability":"developer-tools-debug","launch":{"state":"ok"},
  "attach":{"state":"spawnFailed"},"granted":true}` → 面板侧映射为"调试能力可用"并附
  观测时刻；`attach` 侧未知失败保持 `spawnFailed` 不折算权限（与 P6 §7 同口径）。
- **授权跨重编译/重签不丢（P1-S8 后半实证）**：`make-app.sh` 重新编译并重新签名两个
  bundle（cdhash 变了）后，launchd 形态 daemon 仍自报 `accessibility / inputMonitoring /
  screenRecording = granted`——不含 cdhash 的 designated requirement 收益成立。
- **daemon 不响应 SIGTERM 第三次复现**：`--replace-daemon` 对 PID 40862 发 TERM 无效，
  1s 后 SIGKILL 才收拢（本轮实现已按此设计兜底）。
- 设置面板本身已是可识别主体：`attach {pid: glasspane-settings}` 回
  `appName=GlassPane / bundleId=com.glasspane.settings`（旧裸二进制形态做不到）。
- **两条本轮做不到的核验（如实挂账）**：
  1. `screencapture -x -o` → `could not create image from display`：本会话责任上下文没有
     屏幕录制席位（正是 §11.1 结论 2 的表现），故无法用截图目视面板文案。
  2. 改用 `assert_element` 读面板按钮标题同样拿不到结论——但**更正我上一轮的判断**：
     `GP_E_NO_OPERATION` 不是实现缺陷，P0 §3.3 方法表写明"assert 证据的 signals 复用
     最近一次 act 的信号，无最近 op 时报此码"。真正的缺陷只在 remedy 文案
     （"run act or assert_element first"）对这条路径自指，照做会死循环。已按
     "码不动、语义不动、remedy 可执行"修（P1-S14），并在 §11.7 另开一条不依赖
     assert 的渲染核验通道。

**如实边界与待办（P1-S8）**：新 bundle 身份是全新 TCC 客户端，旧的 `glasspaned` 席位不
继承——需用户在系统设置里为「GlassPane Daemon」重新勾选一次，并目视确认条目名与图标、
确认重编译后授权仍在（DR 不含 cdhash 的预期收益）。本轮未做该人工勾选，故 §11 的
"图标真的出现了"仅到协议面自证为止，不以推断充验收。另：本节观测 1/2 即 §36.3
"launchd 拉起的 daemon 无辅助功能权限"的机理——bundle 身份 + 由 daemon 自身申请后，该
待闭环项的解法已具备，验证随 P1-S8 一并收口。

---

## P6 探针 SDK 三层端到端冒烟（2026-09-19，P6 spec v6.0 §10 P6-E）

脚本：`engine/.p6_smoke.py`（自起专用 daemon：临时目录里一对 engine.sock +
probe.sock、--no-c33，不连用户现网 daemon；拉起 `engine/probe` 的合成对照 app
probe-demo，GLASSPANE_PROBE_SOCK 指向该探针口。**socket 隔离 ≠ 状态根隔离**：
evidence 归档与 approvals.json 走 NSHomeDirectory()，见文末「冒烟状态根隔离与
熔断标签分段匹配（2026-09-23，B-01/A-02）」一节）。
结果：**P6 SMOKE OK**——

| 断言面 | 实测 |
|---|---|
| 注册/能力 | probe hello `gp-probe/0.1.0`，caps=[z1,z3,checkpoint]，attachedHasProbe=true |
| evidence 真值 | handlerProbe `{hitCount:1, handlers:[probe_demo/ProbeDemoApp.swift:76]}` + stateDiff.changed=true 落盘；attribution=**strong**（本仓库首次） |
| 金丝雀 | T4/T5/T7/T8/T3 各检出一次；T8 lateCount=1 由 diagnose 时刷新入账（迟到宽限窗内） |
| 档 1 | snapshot 带真实 gpz1 payload → rollback_full **执行面**回传 rollbackExecuted=true、surface=gp-probe、postStateDigest==expected（consistent=true），恢复后 UI 结构回写可见 |

观察留档（详见 P6 §0 F6–F8）：
13. **SwiftUI Text 内容不进树 digest**：observe 的 AxNode 只有 role/title/identifier，
    Text 文案在 AXValue——纯文本改写对 Z5 树通道不可见。"UI 变了"类 canary 必须用
    结构变化（节点增删）表达；demo 已改 Image 计数行。这是通道可见性边界，不是缺陷。
14. **系统 Apple 菜单徽标是树 digest 噪声源**：全 app 树含"App Store…, N 项更新"类
    菜单项，其自发跳变可翻转 axChanged。冒烟 canary 因此采用"≤4 次重试 + 明示噪声"
    口径（判定语义由单测确定化，真机只证端到端通路存在）。
15. **act 全窗 latency 实测 ~463ms（171 节点树）**：T8 的"延迟"必须大于窗口闭合
    时刻而非固定毫秒数——canary 首版 0.4s 落进窗内被真判成 T5，改 1.2s 后稳定。
16. **屏幕录制对临时目录 daemon 子进程未授予**：pixelDiff 缺席时 NO_ANOMALY
    金丝雀按 P6 §3.2 落 INCONCLUSIVE（T6 不可排除），脚本如实分支不假过。
    该分支的判据自 A-02 起按**段**读 reason 里的 `screen-recording-denied` 标签
    （旧的全等比较在 X-6 之后必然落空 → 无席位机器上永久红，把常态判成失败）。

### 面板渲染状态机器核验闭环（2026-09-20 20:2x，P1 v1.2 §11.7 / P1-S13）

不再依赖截图与人眼：每张权限卡的状态图标带专用无障碍标识
（`PermissionGuide.statusIdentifier`），经产品自身的 socket 通道即可判定渲染结果。
实测（`attach {pid: glasspane-settings}` → `observe maxDepth=10`，nodeCount=207）：

```
gp-perm-accessibility-granted
gp-perm-input-monitoring-granted
gp-perm-screen-recording-granted
gp-perm-developer-tools-unverifiable
```

即：必备三卡在 UI 上确为"已授权"，开发者工具卡如实保持"未验证"（其调试能力另有带时刻
的机器探测行，见 §11.6）。同轮复验：bundle 重新编译重签（cdhash 变）+ daemon 重启后
三项席位仍 `granted`；`--replace-daemon` 第四次遇到 SIGTERM 哑火（PID 1814），
SIGKILL 兜底生效。设置面板自身身份也可被 attach 识别
（`appName=GlassPane / bundleId=com.glasspane.settings`）。

### SIGTERM 哑火根因修复与回归闸（2026-09-20 20:4x，P1 v1.2 §11.10 S15）

前三次记录都只写"daemon 不响应 SIGTERM，安装器靠 SIGKILL 兜底"，本轮查到根因并修：
`installSignalHandlers` 里两处叠加——(1) 信号源只是局部变量，函数返回即被 ARC 释放；
(2) handler 挂在 `.main` 队列，而 `SocketServer.run()` 的 `accept()` 阻塞主线程，
主队列永远不泵。两者叠加使 SIGINT/SIGTERM 彻底哑火（`signal(..., SIG_IGN)` 又把默认
处置改成忽略，于是连"被信号杀掉"都不会发生）。修法：信号源显式持有 + 挂专用队列，
收尾改为 `unlink(engine.sock, probe.sock)` 后 `exit(0)`——**不**调 `server.cleanup()`，
因为它会 close 正被 `accept()` 使用的 fd（跨线程 close 有 fd 复用竞态）。

确定性对照（同一脚本 `engine/.signal_smoke.py`，隔离 socket，不碰现网）：

| 被测二进制 | SIGTERM | SIGINT |
|---|---|---|
| 修复前（已安装的 bundle 旧产物） | 6s 内未退出 → 需 KILL | 6s 内未退出 → 需 KILL |
| 修复后（本次 debug 与 release 产物） | 退出码 0，两个 socket 均 unlink | 退出码 0，两个 socket 均 unlink |

**闸门退出码契约（2026-09-22 收紧）**：`engine/.signal_smoke.py` 是当前**唯一**接进 CI 的
冒烟（ci.yml `swift` job：`swift build` → `python3 .signal_smoke.py .build/debug/glasspaned`），
此前"产物不存在 → 打一行 SKIP 并 exit 0"的口径已作废——构建步骤或产物一改名，那条
SIGTERM/socket-unlink 闸门就会静默变成永久绿、什么都不证明。现契约：
`0 = PASS`（两路断言真实跑过）、`1 = FAIL`（断言不过）、`2 = NOT RUN`（被测二进制缺失/不是
文件/没有可执行位，一条断言都没跑，报文点名期望路径与 `swift build` 产出命令）。
确实要在无产物的机器上放过这一步，只认显式开关 `GLASSPANE_SMOKE_ALLOW_SKIP=1`
（本机机会式跑商用，CI 里勿设）；argv 之外的第二定位通道是 env `GLASSPANE_DAEMON_BIN`。
同口径也适用于 `.p6_smoke.py` / `.t9_smoke.py`（各自已用 exit 2 表达 NOT RUN）。

连带后果（同轮查明并修）：`KeepAlive SuccessfulExit=false` 的语义是"只有异常退出才
重启"，TERM 修好后 daemon 是 clean exit 0 → **launchd 本就不该复活它**，此前看到的
"KILL 后自动重生"其实是哑火的副产物。所以安装器收拢旧实例后必须显式
`launchctl kickstart -k gui/<uid>/com.glasspane.daemon` 才能拿到 launchd 托管形态
（实测：接管成功 → `launchctl print` = `state = running`、单一实例、日志里再无 KILL 兜底）。

### 陈旧作业定义让 launchd 永远起不来（EX_CONFIG，2026-09-20 20:5x）

第二层坑：安装器原地重写 plist 后，**launchd 用的是 bootstrap 时缓存的作业定义**，
新路径不生效——`launchctl print` 表现为 `last exit code = 78: EX_CONFIG` +
`state = spawn scheduled`，kickstart 也永远不起（socket 自然轮不到 launchd 接管，
安装器只能退回手动启动，开机自启形同虚设）。真机还看到过 `last exit code = 65`——
那正是本次新增的单实例护栏在拒绝"已有实例在服务 socket"，说明护栏与 launchd 重试
互相看得见（不是缺陷，但读日志时要认得这两个码）。

修法：重新注册的判据从"plist 文本是否变化"改成**"已加载作业的 `program` 是否等于本次
要安装的路径"**（`loadedLaunchdProgram` + `launchdNeedsReregister`，纯函数可测），不等就
`bootout` + `bootstrap`；读不到定义也一律重来。实测前后：接管前 `--replace-daemon` 报
"launchd 未在时限内接管，改由安装器直接启动"，接管后报
"launchd 已按新配置接管 daemon（kickstart）"、`launchctl print` = `state = running`。

### 「点授权没反应」的第二层根因：launchctl 路径写错（2026-09-20 23:2x）

面板的"让 daemon 以自身身份申请/重探/重启"都经 `Process("/usr/bin/launchctl")`，而 macOS
上它是 **`/bin/launchctl`**——`try? process.run()` 静默吞掉抛错，所以申请动作从未发生，
用户只在系统设置页里看到一个空列表，最后靠手动拖 .app 才添加上（正是本轮最初那条反馈的
现场）。修：路径常量化 + 单测把住可执行性；一次性任务结局拆成
`write/spawn/timeout/unreadable`，面板把它们编进标识（`gp-devtools-failed-spawn` 这类），
不再出现"读不出卡在哪一步"。同轮把面板文案改成用户语言（去掉规格编号与实现自辩）、给
可操作控件加稳定 identifier（SwiftUI 按钮标题不进 AXTitle，按标题 `act` 选不中），
并端到端复验：`act gp-verify-developer-tools` → 一次性任务实跑 → `observe` 读到
`gp-devtools-granted`，全程零人工。

另：`.github/workflows/ci.yml` 因步骤名里含裸 `": "` 而整份 YAML 解析失败——**CI 从来没
跑过**（GitHub 上每个 run 都是 0s failure、无 job 无日志，含另一会话分支上的 run）。
修好并把 `engine/probe`(10) 与 `bridge`(17) 两套测试和信号闸挂进 CI；本地逐 job 复跑：
engine 366、probe 10、bridge 17、kernel 51、mcp-shell 67、installer 40 全绿。

### 登录路径、信号语义与 remedy 准确性（2026-09-20 21:3x）

- **登录时加载等价实测**：`launchctl bootout` → `bootstrap`（RunAtLoad 与登录加载同一入口）
  → `state = running`、新 pid、`hello` 四项席位读数与重载前一致（授权跨完整重载保持，
  这是"重编译/重签/重启都不丢授权"的最强一次证明）。
- **TERM 语义核对**：对该实例 `kill -TERM` → `last exit code = 0`、`state = not running`，
  launchd 依 `KeepAlive(SuccessfulExit=false)` **不再复活**（修复前 TERM 完全无效、只能
  KILL，而 KILL 属异常退出会被立刻重拉——即"杀不掉又重生"）。维护路径因此必须显式
  kickstart，安装器已按此实现。
- **幻影 remedy 复现并修**：对设置面板 `observe {role: AXButton}` 撞到
  `tree capture exceeded the total 10.0s budget`，而回的是 `GP_E_AX_UNAVAILABLE` +
  "run onboarding: glasspaned --grant-accessibility"——但辅助功能当时是 `granted`
  （同一实例 `--check-accessibility` 可自证）。按"码不动、remedy 与成因一致"修：
  预算/超时类给出 `maxDepth`/selector 缩小动作 + 自查命令并明确"不要重新授权"；
  窗口捕获类指向屏幕录制席位与降级形态（P1 v1.0 §5）。

---

## 人工介入最小化批次冒烟（2026-09-19/20，P6 spec §11）

脚本与操作面：

17. **`.p4i4_smoke.py`（P4-I4 自动化销账）**：零坐标 AXPress 逐卡引导按钮→kind 专属
    文案→系统设置前台；developerTools 卡恒「未验证」硬断言。真机 PASS（三卡 granted
    steady-state + dev 卡全链路过）。合成拖拽为如实报告维度。
18. **`installer --restore-launchd`**：bootout→bootstrap→hello 自报校验→（已加载未
    授权时）kickstart 换进程复验；退出码即判定，`GP_E_ENGINE_UNREACHABLE` remedy 已
    指向该命令。分支单测 8 例（注入假件，不碰真 launchctl）。
19. **SIGTERM/SIGINT e2e（§11 ⑥ 验证面，合流后机制为 sigwait+早期遮罩；根因
    归属见上一节 S15：信号源未持有被 ARC 释放 + 主队列不泵）**：
    `glasspaned --socket-path <tmp> &` → `kill -TERM` → 0.2s 内退出且 socket unlink；
    SIGINT 同（bash 后台任务强制忽略 SIGINT、`trap - INT` 在 bash 下不可靠——
    用 python `start_new_session` 干净起进程再发信号；权威闸为 `engine/.signal_smoke.py`）；
    遮罩后、waiter 线程启动前到达的信号以 pending 入账不丢。
20. **`spike/run_h1_retest.py`**：H1 真实 app 强归因率复测一条命令（fetch→壳→构建→
    .app→隔离 daemon→≥20 act→JSON）；真机 24/24 strong=100%，stateSource=z2-mirror，
    hitCount=0 如实记录。
21. **`.rebuild_survival_smoke.py`（P1-S8 重编译存活回归闸）**：把现网
    `~/Applications/GlassPane Daemon.app` 备份后换成**cdhash 已变、identifier 与 DR 未变**
    的产物（`install_name_tool -add_rpath` 造内容差 → `codesign --force --sign -
    -r='designated => identifier "<id>"'` 重签）→ `launchctl kickstart -k` 重启 → 只读
    `hello` 比对席位 → 无论判定如何都恢复原产物并再验一次。断言三条：换装产物 cdhash 必须
    真的变了（否则空测）、换装前已授权的席位换装后仍 `granted`、恢复后 cdhash 与初始一致且
    授权不丢。前置不满足（非 macOS / bundle 未装 / daemon 不应答 / DR 含 cdhash / 一席都没
    授）SKIP 且 exit 0；两条 FAIL 分支（空测、授权丢）为防御性判定，本机跑不出反例故**未
    实测触发过**，只证过 SKIP 两分支。改真实安装 + 重启现网作业，故不进 CI。

真机观察：

17. **F10（P6 §11 ⑤）合成事件可点击、不可起拖**：CGEvent 左键 down/dragged/up 序列
    三种拟真形态 6+ 次，SwiftUI `.onDrag` 拖拽会话均不启动；而标题栏双击 zoom 生效
    证明点击通路真实。另实测：macOS 14 起 `activateIgnoringOtherApps` 无效、裸二进制
    `NSRunningApplication.activate()` 返回 ok 但 NSWorkspace/lsappinfo 前台读数不变
    （AXFrontmost 却为 true）——坐标级冒烟必须以 CGWindowList 逐点遮挡反查为守卫，
    不能信前台断言。
18. **swift 6.2 前端对 FineTune 全树 release WMO 编译 signal 11**（debug 批模式正常）：
    H1 复测壳固定 `-c debug`；与本仓无关，上游复现者注意。
19. **`open` 不传自定义 env**（LS 语义）：探针 sock 环境变量注入必须直接拉起 bundle 内
    可执行 + `open -a` 仅做激活；两次启动去重依赖 LS 对同 bundle 路径的行为。

20. **F11 launchctl 真身在本仓假设之外**：面板四类 launchd 动作曾硬编码
    `/usr/bin/launchctl`（本机实际 `/bin/launchctl`），`Process.run` 抛错被
    `return nil` 吞掉——用户症状"点了没反应"。路径解析必须 `Launchctl.path`
    单点（单测钉死），一次性任务的 stderr 诊断保留在 runOneShot 两个失败分支。
21. **面板主线程禁跑分钟级等待**：调试能力验证（260s 预算）与席位重探（6s）
    必须 `Task.detached`；`NSTemporaryDirectory()` 对非 sandbox 进程可能不
    存在，一次性任务脚本写前须 mkdir 守卫。验收锚（新文案）：徽标「可用
    （实测）」、caption「…一次性验证结果」、按钮「重新验证」。
22. **授权确实跨 cdhash 变化存活**（2026-09-21，`.rebuild_survival_smoke.py` 真机三段）：
    现网 daemon `f967598c…`（pid 67275）→ 换装 `75812885…`（新 pid 67684，同一
    `com.glasspane.daemon` + `designated => identifier "com.glasspane.daemon"`）→
    accessibility / inputMonitoring / screenRecording 三项**仍全部 granted**、
    developerTools 仍如实 unverifiable → 恢复 `f967598c…`（pid 67696）读数不变。
    即 §11.1 结论 3 的推论成立：重编译/重签不需要回系统设置重勾。手工对照轮还另测过
    `693b54ac…` 一次，同结论。

---

## 冒烟状态根隔离与熔断标签分段匹配（2026-09-23，B-01/A-02）

### B-01 状态根隔离：从"自称隔离"改成"实测后才放行"

自起 daemon 的两个冒烟脚本（`engine/.p6_smoke.py`、`engine/.t9_smoke.py`）共用同一套
隔离助手（同名函数段在两个文件里逐字一致——冒烟脚本按本仓惯例各自自包含，不做跨脚本
import）：

1. **daemon 的写入面有三个**，全部由 `NSHomeDirectory()` 解析：
   `EvidenceStore.defaultDirectory`（evidence 归档）、`ApprovalGate.defaultPath`
   （哈希链 approvals.json）、`ProjectRegistry.defaultProjectsPath`（projects.json）。
   `glasspaned` 的 `parseArguments` 里**没有**任何能重定向这个根的 flag
   （`--socket-path` / `--probe-socket-path` 只挪 socket）。
2. **前置闸（起 daemon 之前）**：用被测二进制自己的只读 CLI 问出它实际解析到的状态根
   ——`--evidence-stats` 的 `dir`（`stats()` 只枚举目录）与
   `--active-project <假 id>` 拒绝分支的 `registryPath`（该分支按 R2-16/R6-06
   `stateChanged=false`，从不写状态）。落在沙箱内才起 daemon；问不出结果或落在沙箱外
   即 **NOT RUN(2)**，一条断言都不跑。`.t9_smoke.py` 旧头部把"HOME 重定向"称作唯一
   可行的隔离通道，那是未经测量的断言（round-2 编排者在本机实测：`NSHomeDirectory()`
   不跟随 `$HOME`）；`.p6_smoke.py` 则一直用继承环境起 daemon，等于把 evidence 档案与
   restore 审批行直接写进开发者真实 `~/.glasspane`。两个方向都收在同一判据下：
   **放行者是测量，不是环境变量名**——两脚本对同一件事不再各说一套。
3. **第二道闸（daemon 退出之后）**：对继承环境下问出的真实写入面做前后指纹
   （文件取 size+mtime_ns、归档目录取文件数+总字节）。前置闸放行后指纹仍变化 →
   该轮按 **NOT RUN(2)** 离场（PASS/FAIL 都不可信），报文点名是哪个文件动了，并列出
   两条可自查的可能：未被探测覆盖的状态面（报台账 X-22）／现网 launchd daemon 并行
   写入（`pgrep -fl glasspaned`、`launchctl print gui/$(id -u)/com.glasspane.daemon`）。
   事后指纹**不是**隔离证明，所以它只能作为第二道闸，不可代替前置探测。
4. **今天的实测结论（如实记录，不粉饰）**：本仓 daemon 既无状态根 flag，`$HOME` 又
   不被采纳，所以两脚本在真机（含本编排机）上会以 NOT RUN(2) 拒跑。这是**死闸**，
   满足者只能是 daemon 侧的台账 **X-22**（`glasspaned --state-dir <path>`：
   EvidenceStore/ApprovalGate/ProjectRegistry 改走注入路径、删掉解析到活状态的缺省）；
   flag 落地后把两个脚本的 `daemon_state_dir_args()` 各改一行返回 `["--state-dir", root]`
   即自动转绿。在此之前不得用任何"看起来隔离"的环境变量把这两个闸门蒙成绿——缺失
   就表达为缺失。`.t9_smoke.py` 的显式 socket 旧契约保留：那条路径连的是调用方自己的
   daemon，其状态根不在本脚本掌控内，脚本改为一律打 NOTE 说明，不再自称隔离。

### A-02 熔断 reason 按段匹配

X-6 把未测通道改写成 `"标签: 原文"`，且整串 reason 是 `"; "` 拼的多段（可再带
`performance|` / `degradation|` 前缀）。`.p6_smoke.py` 原先的
`reason == "screen-recording-denied"` 全等比较因此必然落空——在无屏幕录制席位的机器
（本文真机观察 3 与 P6 记录 16 的常态）上把唯一端到端探针闸永久钉红。现行判据
`breaker_reason_has_label()`：剥掉前缀标记后逐段比较，**段等于标签或以 `"标签:"` 开头**
才算"屏幕录制席位缺失"；标签以子串形式出现在别的段原文里不算（那读不出正确成因），
判定强度没有放宽成"任意 reason"。仍写裸字面量的规格文件（specs 为受保护面，本轮未动，
待编排者提规格修正案）：`specs/GlassPane_P1_实施规格_v1.0_SCK迁移.md` §2
「实施记录（P1-A2 真机验证）」项 3、
`specs/GlassPane_P2_实施规格_v2.1_渐进退化检测.md` §19.2 真机冒烟记录、
`specs/GlassPane_P4_实施规格_v4.0_收口与里程碑一致性.md` §33.1 观察 3；
另 `kernel/fixtures/evidence-pack.ok-02.json` 的 `circuitBreaker.reason` 也是裸字面量
（冻结 schema 的 golden 档案，同样只报不改）。
