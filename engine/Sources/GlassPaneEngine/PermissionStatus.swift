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
            return "已打开「辅助功能」设置页：请打开 \(droppedName) 的开关，完成后这里会自动更新。"
        case .inputMonitoring:
            return "已打开「输入监控」设置页：请打开 \(droppedName) 的开关；开启后需重启 GlassPane 后台服务才会生效。"
        case .screenRecording:
            return "已打开「屏幕录制」设置页：请打开 \(droppedName) 的开关；开启后需重启 GlassPane 后台服务才会生效。"
        case .developerTools:
            // 2026-09-19 真机核对：「隐私与安全性 > 开发者工具」面板确实存在且可勾选，
            // 旧文案"无系统总开关"不成立；诚实边界只保留"状态无公开查询接口"。
            return "已打开「开发者工具」设置页：请打开 \(droppedName) 的开关，LLDB 调试需要它。系统不提供这项权限的状态查询，因此这里会一直显示「未验证」；想知道是否已经可用，点「验证调试能力」。"
        }
    }

    // MARK: - 授权主体引导（P1 v1.2 §11.2）

    /// `launchctl` 的真实位置（真机核对：macOS 把它放在 /bin，`/usr/bin/launchctl`
    /// 不存在）。写错路径的后果是静默失效——`Process.run()` 抛错被 `try?` 吞掉，
    /// 面板照常打开系统设置页，看起来像"授权没生效"（本轮就是这么撞上的）。
    public static let launchctlPath = "/bin/launchctl"

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
            launchPath: launchctlPath,
            arguments: ["submit", "-l", label, "--", daemonBinaryPath, "--request-permission", kind.cliValue],
            jobLabel: label
        )
    }

    /// 一次性任务清理命令（`launchctl remove`，幂等，失败静默）。
    public static func daemonRequestCleanupCommand(jobLabel: String) -> PermissionRequestCommand {
        PermissionRequestCommand(
            launchPath: launchctlPath,
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
            : "列表里这条会以文件名「\(subjectName)」出现，没有图标、也无法用「+」添加；改用打包安装后会显示为带图标的 GlassPane。"
        let action: String
        switch kind {
        case .accessibility, .inputMonitoring, .screenRecording:
            action = "已请后台服务申请「\(descriptorName(for: kind))」，并打开对应设置页：请打开 \(subjectName) 的开关。"
                + "开启后要重启 GlassPane 后台服务才会生效，需要时点卡片上的「重启后台服务」。"
        case .developerTools:
            action = "已打开「开发者工具」设置页：请打开 \(subjectName) 的开关，LLDB 调试需要它。"
                + "这项权限系统不提供状态查询，因此这里会一直显示「未验证」；点「验证调试能力」可得到一次实测结论。"
        }
        return identityNote.isEmpty ? action : action + " " + identityNote
    }

    /// daemon 未运行时的如实降级文案（面板不代测、不假点亮）。
    public static let daemonOfflineText = "GlassPane 后台服务未运行，暂时无法确认这些权限是否生效。"

    /// daemon 不可达时的申请边界：面板代申请会把席位记到**面板 app** 头上，
    /// 因此不发起申请，只打开面板并说明前置条件（P1 v1.2 §11.2）。
    public static let daemonRequiredText = "后台服务未运行，无法代为申请权限：请先启动 GlassPane 后台服务，再回到这里点「授权」。"

    /// 可操作控件的稳定标识（供 UI 自动化与冒烟定位，不靠标题文本也不靠位置：
    /// SwiftUI Button 的标题不进 AXTitle，真机 `act` 按标题选不中元素）。
    public static func guideIdentifier(for kind: PermissionKind) -> String {
        "gp-guide-\(kind.cliValue)"
    }

    public static let verifyCapabilityIdentifier = "gp-verify-developer-tools"
    public static let restartDaemonIdentifier = "gp-restart-daemon"
    public static let refreshIdentifier = "gp-refresh"

    /// 能力探测行的脚注（tooltip）：说明它是一次性验证结论而非实时状态。
    public static let capabilityFootnote = "这是一次实测结果，不是实时状态；重新验证可再测一次。"

    /// 面板自身席位的免责说明：面板进程的授权不等于 daemon 的授权。
    public static let panelSubjectDisclaimer = "要勾选的是 GlassPane 后台服务（glasspaned），不是这个设置窗口。"

    /// 拖拽引导条标题（诚实呈现可自动检测的子集）。
    public static let bannerTitle = "把上方的 GlassPane 图标拖到对应的权限卡上，会自动打开该权限的系统设置页"
    public static let bannerHint = "需要授权的是 GlassPane 后台服务，不是这个设置窗口；授权后这里会自动更新。"

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
            launchPath: PermissionGuide.launchctlPath,
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
    /// 权限卡状态标记的无障碍标识（P1 v1.2 §11.7 的机器核验面）。
    ///
    /// 为什么走 identifier：SwiftUI 的 `Text` 内容不进 AXTitle（P6 §0 F6），面板
    /// 渲染状态在 `observe` 树里唯一稳定可读的就是节点的 identifier（图标即如此）；
    /// 因此给状态图标一个专用标识，既不改四类权限图标既有的 identifier（C6 冒烟
    /// 依赖它），又能被 `observe` 直接判定。
    public static func statusIdentifier(kind: PermissionKind, status: PermissionStatus) -> String {
        "gp-perm-\(kind.cliValue)-\(status.rawValue)"
    }

    /// 调试能力行的在途/结局状态；`concluded` 才带实测结论。
    public enum CapabilityMarker: Equatable, Sendable {
        case pending
        case failed(CapabilityFailure)
        case concluded(PermissionStatus)
    }

    /// 验证失败的具体环节。"失败了"这种笼统说法读不出卡在哪一步，机器也就无法
    /// 决定下一步（诚实由可核验的状态保证，不靠文案自辩）。
    public enum CapabilityFailure: String, Equatable, Sendable, CaseIterable {
        case writeFailed = "write"
        case spawnFailed = "spawn"
        case timedOut = "timeout"
        case unreadable = "unreadable"

        /// 面向用户的一句话（不含实现自辩，只说下一步会怎样）。
        public var userText: String {
            switch self {
            case .writeFailed:
                return "无法准备这次验证，这里仍显示「未验证」。"
            case .spawnFailed:
                return "验证任务没能启动，这里仍显示「未验证」。"
            case .timedOut:
                return "验证未在预期时间内完成，这里仍显示「未验证」。"
            case .unreadable:
                return "验证结果读不出来，这里仍显示「未验证」。"
            }
        }
    }

    /// 调试能力行的标识（P1 §11.6：结论是否真渲染靠它判定）。在途/失败必须与
    /// "实测结论为不可判定"区分开——否则会互相冒充（真机就撞过一次：按钮按下去
    /// 后读到 unverifiable，分不清是没跑完、跑挂了还是确实不可判定）。
    public static func capabilityIdentifier(_ marker: CapabilityMarker) -> String {
        switch marker {
        case .pending:
            return "gp-devtools-pending"
        case .failed(let failure):
            return "gp-devtools-failed-\(failure.rawValue)"
        case .concluded(let status):
            return "gp-devtools-\(status.rawValue)"
        }
    }

    /// "系统已授权、后台服务待重启"标记的标识（与状态标识并列，不替换）。
    public static func restartPendingIdentifier(kind: PermissionKind) -> String {
        "gp-perm-\(kind.cliValue)-restart-pending"
    }

    /// 状态图标（SF Symbol 名）：形状本身也表达状态，不依赖颜色（色盲可用）。
    public static func statusIcon(for status: PermissionStatus) -> String {
        switch status {
        case .granted:
            return "checkmark.circle.fill"
        case .denied:
            return "xmark.circle.fill"
        case .notDetermined:
            return "circle.dashed"
        case .unverifiable:
            return "questionmark.circle"
        }
    }

    /// 重启 launchd 托管的 daemon（`kickstart -k` 先杀再起，读新席位）。
    /// 不自动执行——重启会打断正在进行的 act，必须由用户点。
    public static func daemonRestartCommand(label: String = "com.glasspane.daemon", uid: Int) -> PermissionRequestCommand {
        PermissionRequestCommand(
            launchPath: launchctlPath,
            arguments: ["kickstart", "-k", "gui/\(uid)/\(label)"],
            jobLabel: label
        )
    }

    /// 授权生效需要重启 daemon 的说明（卡片注记与横幅共用）。
    public static func restartNeededText(_ kinds: [PermissionKind]) -> String {
        let names = kinds.map { descriptorName(for: $0) }
        return "\(names.joined(separator: "、"))已授权，重启 GlassPane 后台服务后生效。"
    }

    /// daemon 非 launchd 托管时的手动重启指引。
    public static let manualRestartHint = "这个后台服务不是开机自启方式启动的：请手动退出它再重新打开（结束进程后重新运行）。"
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
            case .denied: verdict = "系统拒绝了调试请求"
            default: verdict = "暂无法判定（探测超时或未能启动）"
            }
            return "\(verdict) · launch \(launch) / attach \(attach) · \(formatter.string(from: observedAt)) 验证"
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
