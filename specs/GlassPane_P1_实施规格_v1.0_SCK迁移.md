# GlassPane P1 实施规格 v1.0 — ScreenCaptureKit 迁移 + 屏幕录制权限 onboarding

- 契约真源角色：P1 首批子项目的实施契约（P0 范围内完成事项见 `GlassPane_P0_实施规格_v1.0.md`；本规格基于其第 3.3/8 章迭代，不删减既有内容）
- 版本：v1.0-draft
- 日期：2026-09-15
- 关联决策：5.8 §225（SCK 迁移列 P1 与权限 onboarding 一起做）、§555（CG API 弃用 P1 处理）、PRD §onboarding（权限清单逐项声明 + 拒绝降级形态 + 样例配方一键验证）

---

## 变更说明（相对 P0）

P0 像素捕获使用 `CGWindowListCreateImage`（macOS 14 起标记弃用，P0 仅为最小实现）。本规格按 5.8 R36 把像素捕获迁移到 **ScreenCaptureKit（macOS 13+）**，并把**屏幕录制权限 onboarding** 一并落地。迁移保持 Z5 通道「像素 diff」信号语义不变（降级形态沿用 P0 §8：拒绝→`pixelDiff=null` + `circuitBreaker.level=1`）。

目标构建本机为 macOS 26 / Swift 6.3 / Xcode 26。

---

## 1. 目标：像素捕获管线替换

| 关注面 | P0（现状） | P1（目标） |
|---|---|---|
| 捕获 API | `CGWindowListCreateImage` | ScreenCaptureKit |
| macOS 兼容 | 不依赖模块（CG 直接可用） | 最低 macOS 13（SCK 引入）；macOS 14+ 走 `SCScreenshotManager`，13 走 `SCStream` 单帧信号量 |
| 窗口裁剪 | `CGWindowID + bounds` 先定位再截图 | `SCContentFilter(display:excludingWindows:)` + `sourceRect` + `pointPixelScale` 按目标窗口 frame 裁剪（本 SDK 无 `SCContentFilter(window:)`，见 §2 实施记录） |
| 权限检测 | 隐式（截回 nil 即判拒绝） | 显式 `CGPreflightScreenCaptureAccess()` + onboarding 提示 |
| 权限申请 | 无（失败即降级） | `CGRequestScreenCaptureAccess()` / 引导跳系统设置（P1 onboarding） |
| 通道契约 | `captureWindow() throws -> WindowCapture` | 同签名不变（EngineCore 不感知），内部实现替换 |

**不动**：`WindowCapture` 结构、`ChannelError.pixelCaptureDenied(reason:)`、`EngineCore` 的 capture 调用点与 evidence 组装、P0 降级语义（§8 表格）。

---

## 2. 双路径 API 决策

SCK 在 macOS 13 只有异步流式 API（`SCStream`+delegate）；macOS 14 新增一次性截图 `SCScreenshotManager.captureImage`。为同时满足「推进到 SCK」和「同步通道契约」：

- **路径 A（macOS 14+，本机走此路）**：`SCScreenshotManager.captureImage(contentFilter:configuration:)`。一次性、同步、返回 `CGImage`。用整屏过滤器 `SCContentFilter(display:excludingWindows:)` + `SCStreamConfiguration.sourceRect`（显示器逻辑坐标系，单位 point）采样目标窗口区域，输出像素尺寸 = 窗口逻辑尺寸 × `filter.pointPixelScale`（Retina 保持 2x 不降采样）。
- **路径 B（macOS 13 回退）**：`SCStream` + `SCContentFilter`，`startCapture` 后在 `outputSampleBuffer` 首次回调拿首帧 `CVPixelBuffer`，通过 `DispatchSemaphore` 将异步首帧桥为同步 `CGImage`，随后 `stopCapture`。带超时（复用一个总预算常量，对齐 AXChannel 的 `treeTimeoutSeconds` 防御思路）。
- 选路：编译期 `#available(macOS 14.0, *)` 判分支，缺失走 B。
- 统一返回 `WindowCapture(windowId:bounds:image:)`；`windowId` 优先用 AX 通道从 `CGWindowList` 解析的 `kCGWindowNumber` 做同 pid 窗口精确匹配（与 SCK 的 `SCWindow.windowID` 同号），未命中则回退 pid 属主 + 最大面积屏幕内窗口。

> **实施记录（2026-09-16，规格已同步代码）**：macOS 26 SDK 的 `SCContentFilter` 无 `window:` 初始化器（候选仅 `desktopIndependentWindow:` / `display:excludingWindows:` / `display:includingWindows:` 等）。`desktopIndependentWindow:` 对非桌面独立窗口存在抛异常风险且无法在 Swift 中捕获，故路径 A 落地为「整屏 display 过滤器 + `sourceRect` 采样窗口框」这一确定性方案——不随 SDK 版本猜测窗口组过滤器的 contentRect 语义，也不整屏捕获（开销可控）。

**验证方法**：本机真机触发 `captureWindow` 得到真实 `CGImage`（尺寸=窗口 bounds）即通过；无屏幕录制权限时两路径均抛 `ChannelError.pixelCaptureDenied(reason:)`。

> **实施记录（P1-A2 真机验证，2026-09-16）**：
> 1. XCTest runner 进程内 `SCKCapturer.captureWindow(ownerPid:706, windowId:nil)` 返回真实 CGImage（Finder 最大窗口 1440×900 @2x → 2880×1800），裁剪按 `SCWindow.frame` + `pointPixelScale` 生效。
> 2. 隔离实验确认 `SCScreenshotManager.captureImage` 严格尊重 `configuration.sourceRect`/`width`/`height`（配置 100×100 输出恰为 100×100，`pointPixelScale=2.0`），即裁剪链路无配置被忽略。
> 3. **daemon 进程的 TCC 授权是独立席位**：XCTest runner 与 `glasspaned --check-screen-permission` 均 `granted`，但 daemon 进程 act 时上报 `circuitBreaker.level=1 / screen-recording-denied`（captureBefore=nil）。结论：系统按「每个二进制/进程上下文」分别记录屏幕录制授权；daemon 需用户额外放行。此即 `--guide-screen-permission` 的落地场景，降级路径与 P0 §8 完全一致（T3 仍可用、T6 INCONCLUSIVE）。

> **实施记录（路径 B 落地，2026-09-16）**：`SCKCapturer.captureViaStream` + `snapViaStream` 已完成并编译通过（macOS 26 SDK）。
> 1. **异步启动桥 `awaitStreamStart(of:)`**：`SCStream.startCapture()` 的 async 重载与 completion 版在同步帧内存在解析歧义（编译报 "async call in a function that does not support concurrency"），落地为「Task 内 `try await stream.startCapture()` + 外部 `DispatchSemaphore` 等待 + `AsyncBox` 传值」模式（与路径 A 的 `awaitGuardedNextImage` 同构），统一复用 `captureTimeoutSeconds` 5s 总预算。
> 2. **首帧桥 `StreamFrameBridge`**（`NSObject, SCStreamOutput, SCStreamDelegate`）：`outputSampleBuffer` 首次回调收到 `CVPixelBuffer` 即 `signal`；`didStopWithError` 同样 `signal` 防永久阻塞；NSLock 保证线程安全。
> 3. **缓冲生命周期**：锁定 base address 后经 `CGContext(data:nil)` + 逐行 `memcpy` 生成独立生命周期的 CGImage，不持有流内部缓冲；`defer { stream.stopCapture(completionHandler:) }` 保证超时/失败路径也释放流资源。
> 4. **倍率来源**：macOS 13 无 `pointPixelScale`，回退 `NSScreen.backingScaleFactor`（AppKit 与 SCK 逻辑坐标系一致，P1-A2 已验证两坐标系等价）；找不到屏幕时保守 2x。
> 5. **边界**：本机为 macOS 26，路径 B 仅编译保证，真机首帧行为延后到有 macOS 13 环境时验证（见 §5.2/§4 注）。

---

## 3. 权限检测与 onboarding

### 3.1 检测

- 入口新增 `func screenCapturePermission() -> ScreenCapturePermissionState`（enum: `.granted` / `.denied` / `.notDetermined`）。
- 实现脱层：`CGPreflightScreenCaptureAccess()` 三态映射 `SCStaller` 不对——CG 只给 `kTCCServiceScreenCapture` 的布尔；`notDetermined` 用「从未自定义授权提示」近似判断缺失，P1 以 `CGPreflightScreenCaptureAccess()==false` 表示拒绝，调用 `CGRequestScreenCaptureAccess()` 后返回 `.notDetermined` 前态作为提示触发。

> 实现注意：CG 未提供三态查询，仅布尔。因此状态模型为：
> `notDetermined`⇔「启动上下文」初次；`granted`⇔ `CGPreflightScreenCaptureAccess()==true`；`denied`⇔ `==false` 且系统已弹过授权（无法由 CG 区分时，默认描述为 denied 并给出系统设置引导路径）。诚实声明此边界。

### 3.2 onboarding 命令

daemon 新增 `--check-screen-permission`（只读检测输出三态）与 `--guide-screen-permission`（调用 `CGRequestScreenCaptureAccess()` 弹出系统授权；进程已授权则 no-op）。输出归一到 GP_E 格式之外，返回机器可读三态字符串。

接入点（P1 本批次仅 daemon CLI 层，GUI 设置面板属后续 P1 批次）：
`glasspaned --check-screen-permission`
`glasspaned --guide-screen-permission`

### 3.3 降级语义（沿用 P0 §8 不变）

| 屏幕录制权限拒绝 | captureWindow 抛 `pixelCaptureDenied` → `pixelDiff=null` + `circuitBreaker.level=1`；T3（操作确认+AX）仍可用；T6 退化 `INCONCLUSIVE` |

---

## 4. 工具面与本批次验收

本批次不新增 MCP 工具（快照/恢复类 P1 工具仍按里程碑后移）。验收：

| 编号 | 验收项 | 通过标准 |
|---|---|---|
| P1-A1 | SCK 迁移编译通过（macOS 26 本机 Swift 6.3） | `swift build` 0 error，无 `CGWindowListCreateImage` 调用残留 |
| P1-A2 | 路径 A 真机捕获 | 有权限时 `captureWindow` 返回真实 CGImage，尺寸=目标窗口 bounds |
| P1-A3 | 权限三态命令 | `--check-screen-permission` 输出合法枚举；`--guide-screen-permission` 在已授权态 no-op |
| P1-A4 | 降级保持 | 无权限时 `captureWindow` 抛 `pixelCaptureDenied`，evidence 的 `pixelDiff==null` + `circuitBreaker.level==1` |
| P1-A5 | 纯逻辑单测回归 | 既有 96 用例全绿；新增权限状态解析单测（注入 fake） |
| P1-A6 | CI 兼容 | engine 在 macos-latest（macOS 13 runner）能 `swift build`（路径 B 编译分支存在） | ✓ 路径 B 分支已实现并编译通过（2026-09-16） |

> 注：macos-latest runner 现为 macOS 14+，路径 A 编译；macOS 13 的路径 B 分支已编译保证（`SCKCapturer.captureViaStream`/`snapViaStream`/`StreamFrameBridge` 全链路落地），真机首帧验证延后至有 13 环境的 P1 批次（如实记录此边界）。

---

## 5. 风险与边界（诚实声明）

1. **CG 三态限制**：`notDetermined` 与 `denied` 无法由 CG 精确区分，P1 已声明降级为布尔模型；若后续需精确态，改用 `SCShareableContent` 自捕获空 + `TCC` 工作区检测（列后续）。
2. **路径 B 未真机验证**：macOS 13 分支已实现（路径 B 桥：`SCStream` + `StreamFrameBridge` + `DispatchSemaphore`），编译保证已通过（P1-A6 ✓）；但本机为 macOS 26，首帧真机行为未验证。风险点：SCStream 首帧经 IOSurface 传递，像素格式/方向/耗时与 macOS 13 实际运行环境强相关，若 macOS 13 上首帧延迟或回调时序不同，归 `pixelCaptureDenied` 降级（与 P0 一致，不破坏通道契约）。真机验证延后至有 13 环境的 P1 批次。
3. **窗口裁剪漂移**：窗口缩放/最小化期间 SCK frame 可能滞后；捕获失败（如窗口离屏）归 `pixelCaptureDenied` 降级，与 P0 一致。