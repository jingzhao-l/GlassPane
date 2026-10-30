import Foundation
import ApplicationServices
import CoreGraphics

// MARK: - TCC 授权主体（P1 v1.2 §11 权限主体修正）

/// 一次 TCC 席位判定所依附的**进程身份**。
///
/// 系统按「每个客户端身份」分别记账，客户端身份由可执行文件解析而来：
///  - bundle 身份（`.app` 内、`Info.plist` 被签名绑定）→ 系统设置里显示为
///    bundle 可读名并带图标，可用「+」选择或从 Finder 拖入；
///  - 裸二进制（无 bundle / `Info.plist=not bound`）→ 无展示名与图标可解析，
///    条目以可执行文件名单独呈现，且**当父进程为 GUI app 时授权判定会继承
///    父 app 的席位**（真机实测：同一未授权副本从已授权终端启动时
///    `CGPreflightListenEventAccess()` 返回 true，改由 launchd 起则为
///    notDetermined）。
///
/// 结论：权限只能由「真正使用该权限的那个进程」自己测量与申请。daemon 的
/// 席位必须由 daemon 上报（`hello.permissions`），申请动作也必须由 daemon
/// 以自身上下文发起（见 `PermissionGuide.daemonRequestCommand`）。
public struct PermissionSubject: Equatable, Sendable {
    /// daemon 可执行文件的绝对路径（TCC 按路径记账时即为该值）。
    public let binaryPath: String
    /// 所属 bundle 的标识符；裸二进制为 nil（= 无 bundle 身份）。
    public let bundleIdentifier: String?
    /// 所属 bundle 路径；裸二进制为 nil。
    public let bundlePath: String?

    public init(binaryPath: String, bundleIdentifier: String? = nil, bundlePath: String? = nil) {
        self.binaryPath = binaryPath
        self.bundleIdentifier = bundleIdentifier
        self.bundlePath = bundlePath
    }

    /// 是否具备 bundle 身份（决定系统设置面板里能否显示可读名与图标）。
    public var hasBundleIdentity: Bool { bundleIdentifier != nil && bundlePath != nil }

    /// 系统设置权限列表里该主体**实际会显示**的条目名：bundle 身份取 bundle
    /// 目录名（去 `.app`，与 CFBundleDisplayName 同源），裸二进制取文件名。
    public var tccEntryName: String {
        if let bundlePath, hasBundleIdentity {
            return URL(fileURLWithPath: bundlePath).deletingPathExtension().lastPathComponent
        }
        return URL(fileURLWithPath: binaryPath).lastPathComponent
    }

    /// 本进程身份（默认解析路径允许注入，便于单测覆盖裸二进制/bundle 两态）。
    public static func current(
        binaryPath: String? = nil,
        bundle: Bundle = .main
    ) -> PermissionSubject {
        let resolvedBinary = binaryPath
            ?? bundle.executableURL?.path
            ?? bundle.bundlePath + "/Contents/MacOS/unknown"
        let bundleIdentifier = bundle.bundleIdentifier
        // 只有当 bundleURL 确实是 .app 目录时才算 bundle 身份：SwiftPM 裸二进制的
        // Bundle.main 会指向当前目录，不能误判为 bundle。
        let bundlePath = bundle.bundleURL.pathExtension == "app" ? bundle.bundlePath : nil
        return PermissionSubject(
            binaryPath: resolvedBinary,
            bundleIdentifier: bundlePath == nil ? nil : bundleIdentifier,
            bundlePath: bundlePath
        )
    }

    /// `hello` 线上的 `identity` 字典（nil 字段如实省略，不留假值）。
    public var wireValue: [String: Any] {
        var value: [String: Any] = ["binaryPath": binaryPath]
        if let bundleIdentifier { value["bundleIdentifier"] = bundleIdentifier }
        if let bundlePath { value["bundlePath"] = bundlePath }
        value["hasBundleIdentity"] = hasBundleIdentity
        return value
    }

    /// 从 `hello` 的 `identity` 字典还原（字段缺失时返回 nil，供调用方判定
    /// "旧 daemon 不上报身份"）。
    public static func from(wireValue value: [String: Any]?) -> PermissionSubject? {
        guard let value, let binaryPath = value["binaryPath"] as? String else { return nil }
        return PermissionSubject(
            binaryPath: binaryPath,
            bundleIdentifier: value["bundleIdentifier"] as? String,
            bundlePath: value["bundlePath"] as? String
        )
    }
}

// MARK: - daemon 自身权限席位快照

/// daemon 四类权限席位 + 身份（P1 v1.2 §11.2：权限状态的**唯一真源**）。
///
/// 探针全部走注入式钩子，因此在无 TCC / 无 GUI 环境下可直接单测；真机上
/// 由 daemon 进程自身求值，面板经 `hello` 取回，绝不由面板进程代测。
public struct DaemonPermissionSnapshot: Equatable, Sendable {
    public let subject: PermissionSubject
    public let statuses: [PermissionKind: PermissionStatus]

    public init(subject: PermissionSubject, statuses: [PermissionKind: PermissionStatus]) {
        self.subject = subject
        self.statuses = statuses
    }

    public func status(for kind: PermissionKind) -> PermissionStatus {
        statuses[kind] ?? .unverifiable
    }

    /// `hello` 线上的 `permissions` 字典（kind.rawValue → status.rawValue）。
    ///
    /// 这一面**不跟着 CLI 改键名**：`hello` 的读者（mcp-shell、面板的 `DaemonProbe`）
    /// 今天读的就是 camelCase，换键是一次协议变更，不属于本轮。CLI 那一面另有
    /// `cliWire(statuses:)`，出键与 `--request-permission` 吃的名字同源。
    public var permissionsWire: [String: String] {
        var value: [String: String] = [:]
        for (kind, status) in statuses {
            value[kind.rawValue] = status.rawValue
        }
        return value
    }

    /// 从 `hello` 响应或 CLI 自报 JSON 还原四类席位；缺失或非法值一律跳过（旧 daemon 兼容）。
    ///
    /// 两种拼写都认：`hello` 线用 `kind.rawValue`（camelCase），`--permissions` /
    /// `--request-permission` 的出键自本轮起用 `kind.cliValue`（kebab-case，与
    /// `--request-permission` 吃的名字同一真源）。面板的重探读的是后者的输出
    /// （`PermissionReprobe.parse`），所以这一句必须两个都收 —— 只认一形就是让
    /// 面板对着一次它其实读到了的自报说"读不懂"。
    public static func statuses(from wire: [String: Any]?) -> [PermissionKind: PermissionStatus] {
        guard let wire else { return [:] }
        var result: [PermissionKind: PermissionStatus] = [:]
        for kind in PermissionKind.allCases {
            let raw = (wire[kind.cliValue] as? String) ?? (wire[kind.rawValue] as? String)
            if let raw, let status = PermissionStatus(rawValue: raw) {
                result[kind] = status
            }
        }
        return result
    }
}

// MARK: - `--permissions` 的机器可读出口

/// `glasspaned --permissions` 那一行 JSON 的形状与判决。
///
/// 为什么这份判据在库里而不是在 `main.swift`：CLI 里拼的载荷没有读者也没有闸，本仓
/// 已经为同一形状修过三轮（`ProjectRegistry.pruneUnreadableAtLoadPayload` 那批）。
///
/// 三条口径：
///  1. 出键用 `cliValue`——从前它出 `developerTools/inputMonitoring/screenRecording`，
///     而 `--request-permission` 只吃 `developer-tools/input-monitoring/screen-recording`：
///     读到一个键名、照着抄回去喂给另一条命令就是一次失败的调用；
///  2. 每一个非 granted 席位带一条**现成能跑**的命令（`PermissionGuide.systemPaneURL`
///     与 `daemonRequestCommand` 早就拼好了，只是没接到这一面），并且带 `next`——
///     本文件其它 27 个机器可读出口都带；
///  3. 退出码说的是这一面**测得到**的那三个席位读成了什么（与 `--check-developer-tools`
///     同规矩）：开发者工具这一面无从测量（TCC 无公开查询接口，恒 `unverifiable` 是设计），
///     所以它既不参与判决、也不许被折成一次拒绝——它拿到的是一条实测命令，不是一个码。
public enum PermissionSeatReport {
    /// 这一面能测量的席位（其余的读数由别的命令承担）。
    public static let measuredKinds: [PermissionKind] = [.accessibility, .inputMonitoring, .screenRecording]
    /// 这一面测量不了的席位：报读数，不参与退出码。
    public static let unmeasuredKinds: [PermissionKind] = [.developerTools]

    /// CLI 出键形状：`kind.cliValue` → `status.rawValue`。
    public static func cliWire(statuses: [PermissionKind: PermissionStatus]) -> [String: String] {
        var value: [String: String] = [:]
        for kind in PermissionKind.allCases {
            value[kind.cliValue] = (statuses[kind] ?? .unverifiable).rawValue
        }
        return value
    }

    /// 测得到的席位是否全部 `granted`——`--permissions` 退出码的唯一判据。
    public static func allMeasuredSeatsGranted(_ statuses: [PermissionKind: PermissionStatus]) -> Bool {
        measuredKinds.allSatisfy { statuses[$0] == .granted }
    }

    /// 非 granted 席位的现成命令（按 `PermissionKind.allCases` 的稳定顺序）。
    public static func remedies(
        statuses: [PermissionKind: PermissionStatus],
        daemonBinaryPath: String,
        nonce: String
    ) -> [[String: Any]] {
        measuredKinds.compactMap { kind -> [String: Any]? in
            let status = statuses[kind] ?? .unverifiable
            guard status != .granted else { return nil }
            let command = PermissionGuide.daemonRequestCommand(
                for: kind, daemonBinaryPath: daemonBinaryPath, nonce: nonce
            )
            // 逐字渲染 `PermissionGuide.daemonRequestCommand` 拼的那条 argv：固定词原样
            // 写出，只有**来自对端自报**的那个二进制路径过 `RemedyCommand.quote`——
            // 这条字符串是给人（和 agent）照着敲的，不是再拼一遍的第二份判据。
            let submit = ([command.launchPath] + command.arguments.map {
                $0 == daemonBinaryPath ? RemedyCommand.quote($0) : $0
            }).joined(separator: " ")
            return [
                "seat": kind.cliValue,
                "status": status.rawValue,
                "pane": PermissionGuide.systemPaneURL(for: kind),
                "request": submit,
                "recheck": "glasspaned --permissions",
            ]
        }
    }

    /// 那一行 JSON。
    public static func payload(
        subject: PermissionSubject,
        statuses: [PermissionKind: PermissionStatus],
        nonce: String
    ) -> [String: Any] {
        let subjectValue = subject.wireValue.merging(
            ["entryName": subject.tccEntryName], uniquingKeysWith: { _, new in new }
        )
        let remedies = remedies(
            statuses: statuses, daemonBinaryPath: subject.binaryPath, nonce: nonce
        )
        let notGranted = remedies.map { ($0["seat"] as? String) ?? "" }.filter { !$0.isEmpty }
        let verdict = notGranted.isEmpty ? "granted" : "not-granted"
        let unmeasured: [[String: Any]] = unmeasuredKinds.map { kind in
            [
                "seat": kind.cliValue,
                "status": (statuses[kind] ?? .unverifiable).rawValue,
                "judgedByThisCommand": false,
                "reason": "TCC exposes no query API for this seat, so this command never measures it; reporting it as granted or denied would be a verdict nobody read",
                "next": "glasspaned --check-developer-tools",
            ]
        }
        let next: String
        if notGranted.isEmpty {
            next = "all three seats this command can measure read granted; the developer-tools seat is answered by `glasspaned --check-developer-tools`, not by this one"
        } else {
            next = "run the request command listed for each seat under `seatsNotGranted` (it asks as the daemon's own identity through launchd), then re-read with `glasspaned --permissions` — the pane URL is there too when a person has to tick the switch"
        }
        return [
            "subject": subjectValue,
            "permissions": cliWire(statuses: statuses),
            "verdict": verdict,
            "verdictSeats": measuredKinds.map { $0.cliValue },
            "verdictExcludes": unmeasured,
            "seatsNotGranted": remedies,
            "next": next,
        ]
    }

    /// 退出码：测得到的席位全 granted 才 0，其余一律 1（与 `--check-developer-tools`
    /// 那一支同一规矩：码说的是读数，不是"这条命令跑完了"）。
    public static func exitCode(_ statuses: [PermissionKind: PermissionStatus]) -> Int32 {
        allMeasuredSeatsGranted(statuses) ? 0 : 1
    }
}

// MARK: - 输入监控条目登记探针

/// `CGRequestListenEventAccess()` 只会弹询问，**不会**让「输入监控」列表出现
/// 条目（真机对照：辅助功能申请后条目直接出现，输入监控不会，只能手动把
/// `.app` 拖进列表）。真正登记该 client 的动作是创建 event tap——与 P4 §36
/// "tap 创建即权限如实探测"同源。这里用 `.listenOnly` 被动 tap（不改写事件流、
/// 不进 C33 数据面），创建成功即销毁，只为把条目登记出来。
public enum ListenEventTapProbe {
    public typealias Create = () -> Bool

    public static let createOnce: Create = {
        let callback: CGEventTapCallBack = { _, _, event, _ in Unmanaged.passUnretained(event) }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
            callback: callback,
            userInfo: nil
        ) else {
            return false
        }
        CGEvent.tapEnable(tap: tap, enable: false)
        CFMachPortInvalidate(tap)
        return true
    }
}

/// 权限探针聚合器：把四类探针折叠成一份快照，并提供"以本进程身份发起申请"
/// 的统一入口（daemon 侧 `--request-permission <kind>` 与单测共用）。
public final class PermissionProbeSet {
    public let accessibility: AccessibilityPermissionProbe
    public let inputMonitoring: InputMonitoringPermissionProbe
    public let screenRecording: ScreenCapturePermissionProbe
    public let developerTools: DeveloperToolsPermissionProbe
    /// 输入监控条目登记动作（创建即销毁的被动 tap）；注入式便于单测。
    private let inputTapProbe: ListenEventTapProbe.Create
    private let subjectProvider: () -> PermissionSubject

    public init(
        accessibility: AccessibilityPermissionProbe = AccessibilityPermissionProbe(),
        inputMonitoring: InputMonitoringPermissionProbe = InputMonitoringPermissionProbe(),
        screenRecording: ScreenCapturePermissionProbe = ScreenCapturePermissionProbe(),
        developerTools: DeveloperToolsPermissionProbe = DeveloperToolsPermissionProbe(),
        inputTapProbe: @escaping ListenEventTapProbe.Create = ListenEventTapProbe.createOnce,
        subjectProvider: @escaping () -> PermissionSubject = { PermissionSubject.current() }
    ) {
        self.accessibility = accessibility
        self.inputMonitoring = inputMonitoring
        self.screenRecording = screenRecording
        self.developerTools = developerTools
        self.inputTapProbe = inputTapProbe
        self.subjectProvider = subjectProvider
    }

    /// 当前快照（本进程身份下的四类席位）。
    ///
    /// 三个测量席位在这里给出的是同一句话：`granted`，或者"这一次没量到授权"
    /// （`unverifiable`）。屏幕上没有第三种词——`notDetermined` 说的是"系统还没决定/没问过"，
    /// 而那是一段任何进程内布尔都读不到的历史（2026-10-30 S1-3：输入监控与屏幕录制两支从前
    /// 都还发它）。屏幕录制走 `panelStatus` 而不是 `state`，因为发布出去的那一面是
    /// `PermissionStatus`；两支现在同一个事实源，答案不会分叉。
    public func snapshot() -> DaemonPermissionSnapshot {
        DaemonPermissionSnapshot(
            subject: subjectProvider(),
            statuses: [
                .accessibility: accessibility.displayStatus(),
                .inputMonitoring: inputMonitoring.state,
                .screenRecording: screenRecording.panelStatus,
                .developerTools: developerTools.status,
            ]
        )
    }

    /// 以**本进程身份**发起一型权限申请：只唤起系统申请面（弹窗 / TCC 登记），
    /// 不跳系统面板、不轮询等待——面板由调用方（设置 GUI）打开，申请结果由
    /// 调用方重新 `snapshot()` 观测。返回值是申请发起后的即时观测状态。
    ///
    /// `unverifiable` / `notDetermined` 都不代表失败：TCC 还没有回答，用户可能稍后才在
    /// 系统面板里勾选。从前这里回答 `denied`（预检 false 就算拒绝），而 `--permissions`
    /// 与面板把 `denied` 渲染成「已拒绝」——一个决定，在系统还没做决定的时候说出口。
    @discardableResult
    public func request(_ kind: PermissionKind) -> PermissionStatus {
        switch kind {
        case .accessibility:
            accessibility.requestPrompt()
            return accessibility.displayStatus()
        case .inputMonitoring:
            if inputMonitoring.state != .granted {
                inputMonitoring.requestOnly()
                // 询问之外还要真正登记一次 tap，否则「输入监控」列表里不会出现
                // 该主体（用户就只能手动拖 .app 进去）。
                inputTapProbe()
            }
            return inputMonitoring.state
        case .screenRecording:
            screenRecording.requestOnly()
            return screenRecording.panelStatus
        case .developerTools:
            // 无系统总开关、无公开查询 API：不伪造申请动作，恒为 unverifiable。
            return developerTools.status
        }
    }
}
