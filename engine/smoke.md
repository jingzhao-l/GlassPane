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
