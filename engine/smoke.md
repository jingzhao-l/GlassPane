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
3. **daemon 后台进程屏幕录制 TCC 不继承**：circuitBreaker.reason="screen-recording-denied"、
   level=1 降级形态（spec R45 预期降级，非故障）。
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
| T9（P2 v2.1 §19.2）渐进退化泄漏注入冒烟 | `engine/.t9_smoke.py` | T9 SMOKE OK：脚本自编译泄漏金丝雀（AppKit，每次点击保留 8MB 内存 + 1 个 fd），daemon 驱动 act 至第 16/24 轮 → evidence 熔断升级 degraded、reason 携带 `degradation|memory+handles; longSession=false; screen-recording-denied` → `diagnose.class=T9` |

真机观察补充：

9. **设置窗口关闭时 observe 只见菜单栏**：glasspane-settings 进程存活但窗口已关时，
   observe（maxDepth 10）返回 149 节点全为 AXMenuBar/AXMenuItem、无任何 AXButton——
   C33 脚本因此自动发现全部实例并逐个 attach，取第一个树中有按钮者（裸二进制旧实例
   被如实跳过、.app 新实例命中；顺带多实例并存场景验证）。窗口未开时脚本以明确
   失败信息引导先打开设置面板，不伪造目标。
10. **T9 真机可达性**：8MB+1fd/轮 的注入强度下 16 轮（约 16s 节奏）触发双信号正斜率
    联合裁决；`screen-recording-denied` 以 R45 预期降级形态共存于 reason，不阻碍
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

**如实边界与待办（P1-S8）**：新 bundle 身份是全新 TCC 客户端，旧的 `glasspaned` 席位不
继承——需用户在系统设置里为「GlassPane Daemon」重新勾选一次，并目视确认条目名与图标、
确认重编译后授权仍在（DR 不含 cdhash 的预期收益）。本轮未做该人工勾选，故 §11 的
"图标真的出现了"仅到协议面自证为止，不以推断充验收。另：本节观测 1/2 即 §36.3
"launchd 拉起的 daemon 无辅助功能权限"的机理——bundle 身份 + 由 daemon 自身申请后，该
待闭环项的解法已具备，验证随 P1-S8 一并收口。

---

## P6 探针 SDK 三层端到端冒烟（2026-09-19，P6 spec v6.0 §10 P6-E）

脚本：`engine/.p6_smoke.py`（自带隔离 daemon：/tmp 专用 engine.sock + probe.sock，
--no-c33，不触碰用户现网 daemon；拉起 `engine/probe` 的合成对照 app probe-demo，
GLASSPANE_PROBE_SOCK 指向隔离探针口）。结果：**P6 SMOKE OK**——

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
16. **屏幕录制对 /tmp 隔离 daemon 子进程未授予**：pixelDiff 缺席时 NO_ANOMALY
    金丝雀按 P6 §3.2 落 INCONCLUSIVE（T6 不可排除），脚本如实分支不假过。
