import Foundation

/// 权限状态枚举（P1 spec v1.2 §6.1）。
///
/// 四类权限共享该状态面：辅助功能/输入监控/屏幕录制为三态（granted/denied/
/// notDetermined），开发者工具因无公开 TCC 查询 API 恒为 unverifiable。
public enum PermissionStatus: String, Equatable, Sendable, CaseIterable {
    case granted
    case denied
    case notDetermined
    case unverifiable
}

/// 权限类别（P1 spec v1.2 §6.1 权限清单的单一真源）。
public enum PermissionKind: String, Equatable, Sendable, CaseIterable {
    case accessibility
    case inputMonitoring
    case screenRecording
    case developerTools

    /// `glasspaned --request-permission <value>` 的命令行取值（daemon CLI 与
    /// 设置面板共用同一真源，避免两侧字面量漂移）。
    public var cliValue: String {
        switch self {
        case .accessibility:
            return "accessibility"
        case .inputMonitoring:
            return "input-monitoring"
        case .screenRecording:
            return "screen-recording"
        case .developerTools:
            return "developer-tools"
        }
    }

    /// 从 CLI 取值还原权限类别（未知值返回 nil，由调用方报错）。
    public static func from(cliValue: String) -> PermissionKind? {
        allCases.first { $0.cliValue == cliValue }
    }
}

/// 权限静态文案（displayName / purposeText / degradationText 单一真源，
/// 供 SwiftUI 卡片与拒绝降级形态折叠区消费）。
public struct PermissionDescriptor: Equatable, Sendable {
    public let kind: PermissionKind
    public let displayName: String
    public let purposeText: String
    public let degradationText: String

    public init(kind: PermissionKind, displayName: String, purposeText: String, degradationText: String) {
        self.kind = kind
        self.displayName = displayName
        self.purposeText = purposeText
        self.degradationText = degradationText
    }

    /// 全量权限清单（综述 §5.14 / PRD US-01）。
    public static let all: [PermissionDescriptor] = [
        PermissionDescriptor(
            kind: .accessibility,
            displayName: "辅助功能",
            purposeText: "读取并操作被测应用的 AX 树（observe/act 主通道）",
            degradationText: "完全不可用：GP_E_AX_UNAVAILABLE，验证循环无法运行"
        ),
        PermissionDescriptor(
            kind: .inputMonitoring,
            displayName: "输入监控",
            purposeText: "C33 并发污染检测所需的 CGEvent 输入流监控",
            degradationText: "降级为纯操作权互斥，污染标注禁用"
        ),
        PermissionDescriptor(
            kind: .screenRecording,
            displayName: "屏幕录制",
            purposeText: "像素 diff 通道（T6/T7 视觉断言）",
            degradationText: "pixelDiff=null + circuitBreaker.level=1，T6 判定退化为 INCONCLUSIVE"
        ),
        PermissionDescriptor(
            kind: .developerTools,
            displayName: "开发者工具",
            purposeText: "LLDB attach（Z1–Z4.5 探针通道）",
            degradationText: "探针通道不可用（P1 默认不启用该通道）"
        ),
    ]

    public static func descriptor(for kind: PermissionKind) -> PermissionDescriptor {
        all.first { $0.kind == kind } ?? PermissionDescriptor(kind: kind, displayName: kind.rawValue, purposeText: "", degradationText: "")
    }
}

// MARK: - ScreenCapturePermissionState → PermissionStatus（统一 UI 状态面）

extension ScreenCapturePermissionState {
    /// 映射到面板通用状态枚举（P1 spec v1.2 §6.1，单一真源）。
    public var panelStatus: PermissionStatus {
        switch self {
        case .granted:
            return .granted
        case .denied:
            return .denied
        case .notDetermined:
            return .notDetermined
        }
    }
}

// MARK: - 权限引导：系统面板深链与引导文案（P1 v1.2 拖拽引导单一真源）

/// 拖拽引导的纯逻辑层：把权限类别映射到系统设置深链面板与引导文案。
/// 不触碰系统 API（Process / AX / CG 全部由注入的闭包承担），因此可在
/// 无 TCC、无 GUI 环境下直接单测（P1 v1.2 拖拽引导验收）。
public enum PermissionGuide {
    /// 系统设置面板深链（x-apple.systempreferences 协议）。
    /// 开发者工具（Automation）以 `Privacy_Automation` 为准；诚实边界：
    /// 该面板专用于 Apple Events，UI 恒为 unverifiable（无公开查询接口）。
    public static func systemPaneURL(for kind: PermissionKind) -> String {
        switch kind {
        case .accessibility:
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .inputMonitoring:
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        case .screenRecording:
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case .developerTools:
            // 真机核对（2026-09-19）：系统设置确有「隐私与安全性 > 开发者工具」入口，
            // LLDB attach 的授权落在这里；`Privacy_Automation` 是 Apple Events 的
            // 询问面板，与调试器权限不同主体——早期版本误指向后者。
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_DeveloperTools"
        }
    }

    /// 打开系统面板深链（尽力而为，失败静默——面板打开失败时引导文案仍可见）。
    public static func openSystemPane(for kind: PermissionKind) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = [systemPaneURL(for: kind)]
        try? process.run()
    }

    /// 拖拽落点后的引导文案；`droppedName` 为被拖入 bundle 的可读名
    /// （缺省用 GlassPane）。文案承担两类边界：
    ///  - 目标入口名可能不是 "GlassPane"（如二进制直跑时是 glasspaned）；
    ///  - 开发者工具恒为 unverifiable，只给 Apple Events 触发说明。
    public static func instruction(for kind: PermissionKind, droppedName: String = "GlassPane") -> String {
        switch kind {
        case .accessibility:
            return "已打开「辅助功能」面板：请为 \(droppedName) 打开开关。开启后本窗口会自动变绿。"
        case .inputMonitoring:
            return "已打开「输入监控」面板：请为 \(droppedName) 打开开关。开启后本窗口会自动变绿（首次需重启该 app 生效）。"
        case .screenRecording:
            return "已打开「屏幕录制」面板：请为 \(droppedName) 打开开关。开启后本窗口会自动变绿。"
        case .developerTools:
            // 2026-09-19 真机核对：「隐私与安全性 > 开发者工具」面板确实存在且可勾选，
            // 旧文案"无系统总开关"不成立；诚实边界只保留"状态无公开查询接口"。
            return "已打开「开发者工具」面板：请为 \(droppedName) 打开开关（LLDB attach 需要它）。TCC 无公开查询接口，状态栏保持\"未验证\"；要确认 daemon 能否真调试，点卡片上的「验证调试能力」跑一次受限探测（结果带时刻，不是实时读数）。"
        }
    }

    // MARK: - 授权主体引导（P1 v1.2 §11.2）

    /// 一条"让 daemon 以自身身份发起权限申请"的 launchd 一次性任务命令。
    ///
    /// 为什么必须经 launchd 而不是 `Process` 直接起子进程：裸二进制在 GUI
    /// 父进程下启动时，TCC 判定会**继承父 app 的席位**（真机实测），由
    /// launchd 起的一过性任务与面板无父子责任链，申请与记账都落在 daemon
    /// 自己的身份上——这才能保证系统设置里出现的条目与真正需要权限的进程一致。
    public struct PermissionRequestCommand: Equatable, Sendable {
        public let launchPath: String
        public let arguments: [String]
        public let jobLabel: String
    }

    /// 构造 `launchctl submit` 命令；`daemonBinaryPath` 为运行中 daemon 自报的
    /// 可执行路径（`hello.identity.binaryPath`），`nonce` 保证标签唯一。
    public static func daemonRequestCommand(
        for kind: PermissionKind,
        daemonBinaryPath: String,
        nonce: String
    ) -> PermissionRequestCommand {
        let label = "com.glasspane.guide.\(kind.cliValue).\(nonce)"
        return PermissionRequestCommand(
            launchPath: "/usr/bin/launchctl",
            arguments: ["submit", "-l", label, "--", daemonBinaryPath, "--request-permission", kind.cliValue],
            jobLabel: label
        )
    }

    /// 一次性任务清理命令（`launchctl remove`，幂等，失败静默）。
    public static func daemonRequestCleanupCommand(jobLabel: String) -> PermissionRequestCommand {
        PermissionRequestCommand(
            launchPath: "/usr/bin/launchctl",
            arguments: ["remove", jobLabel],
            jobLabel: jobLabel
        )
    }

    /// 面向"授权主体"的引导文案：明确要在系统设置里勾选的是 **daemon 的条目**
    /// （名字与图标取决于 daemon 是否以 bundle 身份运行），而不是本设置面板。
    public static func instruction(
        for kind: PermissionKind,
        subjectName: String,
        hasBundleIdentity: Bool
    ) -> String {
        let identityNote = hasBundleIdentity
            ? ""
            : "当前 daemon 以裸二进制运行，条目在列表里只显示文件名「\(subjectName)」（无图标、不可用「+」选择）；改用打包形态后会显示为带图标的 app 名。"
        let action: String
        switch kind {
        case .accessibility, .inputMonitoring, .screenRecording:
            action = "已让 daemon 申请「\(descriptorName(for: kind))」并打开对应面板：请为 \(subjectName) 打开开关。"
                + "开启后需重启 daemon 才会生效（已在跑的进程读到的是它启动时的判定），"
                + "本卡片会在检测到差异时给出「重启 daemon」按钮。"
        case .developerTools:
            action = "已打开「开发者工具」面板：请为 \(subjectName) 打开开关（LLDB attach 需要它）。"
                + "TCC 无公开查询接口，状态栏不伪造已授权/已拒绝；点「验证调试能力」可由 daemon 自身跑一次受限 lldb 探测（P6 §7）给出带时刻的结论。"
        }
        return identityNote.isEmpty ? action : action + " " + identityNote
    }

    /// daemon 未运行时的如实降级文案（面板不代测、不假点亮）。
    public static let daemonOfflineText = "daemon 未运行：权限席位按进程记账，无法向 daemon 查询，本卡不代替其状态"

    /// daemon 不可达时的申请边界：面板代申请会把席位记到**面板 app** 头上，
    /// 因此不发起申请，只打开面板并说明前置条件（P1 v1.2 §11.2）。
    public static let daemonRequiredText = "daemon 未运行（或未上报身份），本面板不代为申请——那会把席位记到设置窗口 app 头上而不是 daemon"

    /// 面板自身席位的免责说明：面板进程的授权不等于 daemon 的授权。
    public static let panelSubjectDisclaimer = "勾选对象是守护进程 glasspaned（或其 .app），不是本设置窗口"

    /// 拖拽引导条标题（诚实呈现可自动检测的子集）。
    public static let bannerTitle = "拖拽引导：把窗口顶部的 GlassPane 图标拖到下方权限卡上，直接打开对应的系统设置面板"
    public static let bannerHint = "授权对象是守护进程 glasspaned（卡片按它自报的席位显示），开发者工具无系统总开关，按卡片文案触发即可。"

    // MARK: - 拖拽源选择（P1 v1.2 §11.3）

    /// 顶部图标可提供的拖拽内容。系统设置权限列表接受**从 Finder 拖入的
    /// `.app`**（条目会显示 bundle 可读名与图标），但「+」文件选择器看不到
    /// 隐藏目录里的裸二进制——所以 daemon 有 bundle 身份时必须拖真身，
    /// 裸二进制形态下只能给出纯文本导航（并如实说明限制）。
    public enum DragSource: Equatable, Sendable {
        case bundleURL(String)
        case plainText(String)
    }

    /// 权限中文展示名（文案拼装用，与 `PermissionDescriptor.displayName` 同源）。
    public static func descriptorName(for kind: PermissionKind) -> String {
        PermissionDescriptor.descriptor(for: kind).displayName
    }

    /// 由 daemon 自报身份决定拖拽源：bundle 身份 → `.app` 的 fileURL；
    /// 裸二进制或无上报 → 纯文本（缺省名 GlassPane）。
    public static func dragSource(for subject: PermissionSubject?) -> DragSource {
        if let subject, subject.hasBundleIdentity, let bundlePath = subject.bundlePath {
            return .bundleURL(bundlePath)
        }
        return .plainText("GlassPane")
    }
}
// MARK: - 席位重探与 daemon 重启（P1 v1.2 §11.4）

/// 「已在跑的 daemon 读到的是它启动时的 TCC 判定」——真机实测：用户为
/// 「GlassPane Daemon」勾上辅助功能/输入监控后，运行中的实例仍报
/// `notDetermined`，而**同一身份的新进程**报 `granted`。所以面板必须能区分
/// 两种"没绿"：系统里真没授权，还是授权了但 daemon 需要重启。
///
/// 做法：用 daemon 自己的二进制再跑一次 `--permissions`（一次性 launchd 任务，
/// 责任上下文是 daemon 自己，不继承面板 app），把结果写文件后读回。
public enum PermissionReprobe {
    /// 重探结果：同一 bundle 身份下"新进程"看到的席位。
    public struct Result: Equatable, Sendable {
        public let subject: PermissionSubject
        public let statuses: [PermissionKind: PermissionStatus]

        public init(subject: PermissionSubject, statuses: [PermissionKind: PermissionStatus]) {
            self.subject = subject
            self.statuses = statuses
        }
    }

    /// 一次性任务脚本正文：调用 daemon 二进制并把 JSON 写到指定路径。
    /// 路径全部由调用方给（面板把 daemon 自报的 binaryPath 传进来），因此
    /// 重探的主体恒等于被探测的那个 daemon。
    public static func script(
        daemonBinaryPath: String,
        outputPath: String,
        arguments: [String] = ["--permissions"]
    ) -> String {
        [
            "#!/bin/zsh",
            "\"\(daemonBinaryPath)\" \(arguments.joined(separator: " ")) > \"\(outputPath)\" 2>&1",
            "",
        ].joined(separator: "\n")
    }

    /// 调试能力探测的重探参数（P6 §7 的 `--check-developer-tools`）。
    public static let developerToolsArguments = ["--check-developer-tools"]

    /// 提交重探任务（与申请同一条路径：走 launchd，避免面板成为责任父进程）。
    public static func submitCommand(scriptPath: String, nonce: String) -> PermissionGuide.PermissionRequestCommand {
        let label = "com.glasspane.reprobe.\(nonce)"
        return PermissionGuide.PermissionRequestCommand(
            launchPath: "/usr/bin/launchctl",
            arguments: ["submit", "-l", label, "--", scriptPath],
            jobLabel: label
        )
    }

    /// 解析重探输出（非法/缺字段 → nil，调用方保持旧读数，不猜）。
    public static func parse(_ text: String) -> Result? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let subject = PermissionSubject.from(wireValue: object["subject"] as? [String: Any])
        else {
            return nil
        }
        let statuses = DaemonPermissionSnapshot.statuses(from: object["permissions"] as? [String: Any])
        guard !statuses.isEmpty else { return nil }
        return Result(subject: subject, statuses: statuses)
    }

    /// 需要重启 daemon 才能让授权生效的权限类别：运行实例没达成、新进程已达成。
    public static func kindsNeedingRestart(
        running: [PermissionKind: PermissionStatus],
        reprobed: Result?
    ) -> [PermissionKind] {
        guard let reprobed else { return [] }
        return PermissionKind.allCases.filter { kind in
            kind != .developerTools
                && reprobed.statuses[kind] == .granted
                && running[kind] != .granted
        }
    }
}

extension PermissionGuide {
    /// 重启 launchd 托管的 daemon（`kickstart -k` 先杀再起，读新席位）。
    /// 不自动执行——重启会打断正在进行的 act，必须由用户点。
    public static func daemonRestartCommand(label: String = "com.glasspane.daemon", uid: Int) -> PermissionRequestCommand {
        PermissionRequestCommand(
            launchPath: "/usr/bin/launchctl",
            arguments: ["kickstart", "-k", "gui/\(uid)/\(label)"],
            jobLabel: label
        )
    }

    /// 授权生效需要重启 daemon 的说明（卡片注记与横幅共用）。
    public static func restartNeededText(_ kinds: [PermissionKind]) -> String {
        let names = kinds.map { descriptorName(for: $0) }
        return "\(names.joined(separator: "、"))已在系统里授权，但运行中的 daemon 读到的仍是它启动时的判定——点「重启 daemon」生效"
    }

    /// daemon 非 launchd 托管时的手动重启指引。
    public static let manualRestartHint = "该 daemon 不是 launchd 拉起（无 com.glasspane.daemon 作业）：需手动结束再启动，例如 kill <pid> 后 open \"GlassPane Daemon.app\""
}

// MARK: - 开发者工具席位的机器探测（P1 v1.2 §11.5 × P6 §7）

/// `DebugCapabilityProbe`（P6 §7）的三态结果在**权限面板**里的呈现形态。
///
/// 为什么要经 launchd 一次性任务、由 daemon 自己的二进制去跑：调试能力属于
/// **daemon 进程**的席位，而 TCC 判定会沿责任进程链继承（§11.1 结论 2）——
/// 面板自己跑 `xcrun lldb` 测的是面板 app 的能力，不是 daemon 的。
///
/// 诚实边界：真实 lldb 探测代价高（冷启动预算 120s），所以它**不**进 `hello`
/// 的实时席位（那一栏仍为 `unverifiable`：TCC 无公开查询接口这一事实没变），
/// 只作为"最近一次显式验证"的带时间戳陈述呈现。
public enum DeveloperToolsCapability {
    public struct Report: Equatable, Sendable {
        public let launch: String
        public let attach: String
        public let granted: Bool
        /// 观测时刻（由调用方注入，保证纯解析可单测）。
        public let observedAt: Date

        public init(launch: String, attach: String, granted: Bool, observedAt: Date) {
            self.launch = launch
            self.attach = attach
            self.granted = granted
            self.observedAt = observedAt
        }

        /// granted → 已授权；被系统明确拒绝 → 已拒绝；timeout / spawnFailed 等
        /// 未知失败 → 不可判定（绝不折算成任一权限结论，与 P6 的口径一致）。
        public var status: PermissionStatus {
            if granted { return .granted }
            if launch == "denied" || attach == "denied" { return .denied }
            return .unverifiable
        }

        /// 卡片上的一行话：状态 + 两侧探测 + 时刻（不冒充实时读数）。
        public func summaryText(at now: Date = Date()) -> String {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "HH:mm:ss"
            let verdict: String
            switch status {
            case .granted: verdict = "调试能力可用"
            case .denied: verdict = "系统已拒绝调试"
            default: verdict = "不可判定（探测超时或未能起进程，不折算权限）"
            }
            return "\(verdict)：launch=\(launch) / attach=\(attach)，验证于 \(formatter.string(from: observedAt))（非实时读数）"
        }
    }

    /// 解析 `--check-developer-tools` 的 JSON；结构不符即 nil（调用方保持
    /// "未验证"，不猜）。
    public static func parse(_ text: String, observedAt: Date) -> Report? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (object["capability"] as? String) == "developer-tools-debug",
              let launch = (object["launch"] as? [String: Any])?["state"] as? String,
              let attach = (object["attach"] as? [String: Any])?["state"] as? String,
              let granted = object["granted"] as? Bool
        else {
            return nil
        }
        return Report(launch: launch, attach: attach, granted: granted, observedAt: observedAt)
    }
}
