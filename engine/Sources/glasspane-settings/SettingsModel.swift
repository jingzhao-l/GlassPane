import SwiftUI
import GlassPaneEngine

/// 设置面板状态模型：聚合 **daemon 自报**的四类权限席位与 daemon 探测，提供
/// 快照供 UI 渲染（P1 spec v1.2 §11.2 权限主体修正）。
///
/// 关键约束：TCC 席位按「每个进程身份」记账，因此
///  - 状态真源是 daemon 自己（经 `hello` 的 `permissions` 字段上报），面板
///    **不代测**——面板进程被授权不等于 daemon 被授权；daemon 未运行或为不上报
///    该字段的旧版本时，卡片如实显示"未验证"；
///  - 申请动作由 daemon 以自身身份发起（`launchctl submit` 起一过性任务，
///    避免面板成为责任父进程而把席位记到面板 app 头上）；
///  - 面板仍负责打开系统设置深链与文案引导，勾选由用户在系统面板完成。
///
/// 状态判定全部在 engine 库探针层，本层仅做编排与缓存
/// （P1 spec v1.2 §9.3：SwiftUI 壳不做逻辑单测）。
@MainActor
final class SettingsModel: ObservableObject {

    /// 单权限条目（供卡片渲染）。
    struct PermissionEntry: Identifiable {
        let kind: PermissionKind
        let descriptor: PermissionDescriptor
        var status: PermissionStatus
        /// 状态来源说明（daemon 自报 / daemon 未运行 / 旧 daemon 不上报）。
        var statusNote: String?
        var id: PermissionKind { kind }
    }

    /// 后台服务存活的**实测**结局，唯一来源是一次 hello 握手（`DaemonProbe.liveness`）。
    ///
    /// 从前这里是一个 `reachable: Bool`，而它的取数是"socket 文件在不在"——崩掉的
    /// 服务会把文件留在那儿，于是页脚顶着绿点写"运行中"，同一页四张权限卡同时说
    /// 服务没在运行。socket 在不在从来不是存活判据；"有人接了连接却不开口"也不是
    /// "运行中"，更不是"未运行"，所以它有自己的一个成员。
    enum DaemonLiveness: Equatable {
        /// 还没实测过（面板刚起来、一次握手都还没跑）：不点亮也不熄灭。
        case unmeasured
        /// 它回了合规的 hello——这一枚绿点背后有一次真实测量。
        case answering
        /// 那个名字后面没有监听者（文件不在、没人接这个连接）。
        case notRunning
        /// 连接建好了却没有回话（或回来的不是 hello）：占着门的那个进程不应门。
        case presentButSilent(reason: String)
    }

    /// daemon 状态卡内容。
    struct DaemonEntry {
        var socketPath: String
        /// 存活判定：只有实测到 hello 回话才是 `.answering`。
        var liveness: DaemonLiveness
        var version: String?
        var protocolVersion: String?
        var pid: Int?
        /// daemon 自报的授权主体（nil = 未连上或旧 daemon 不上报）。
        var subject: PermissionSubject?
    }

    @Published var entries: [PermissionEntry] = []
    @Published var daemon: DaemonEntry
    @Published var isRefreshing = false
    @Published var lastRefreshError: String?
    /// 拖拽引导状态：最近一次落点的权限类别（nil = 无进行中的引导）。
    @Published var pendingGuideKind: PermissionKind?
    /// 拖拽引导文案（`PermissionGuide.instruction` 或手动按钮引导文案）。
    @Published var pendingGuideText: String?

    /// 面板进程的席位探针：仅用于"本窗口自身"这一次要信息，不作为卡片状态真源。
    private let panelProbes: PermissionProbeSet
    private let daemonProbe: DaemonProbe
    /// 本面板进程自己的身份（只作说明用；它的授权不等于 daemon 的授权）。
    let panelSubject: PermissionSubject
    /// hello 往返在途标记（1s 轮询不得叠加 3s 超时的 socket 会话）。
    private var probeInFlight = false
    /// 同一身份新进程的重探结果（用于区分"系统里没授权"与"授权了但 daemon
    /// 需重启才生效"，P1 v1.2 §11.4）。
    @Published var reprobed: PermissionReprobe.Result?
    private var reprobeInFlight = false
    private var lastReprobeAt = Date.distantPast
    /// 重探节流：只在有必备权限未达成且距上次超过该间隔时才发起。
    static let reprobeInterval: TimeInterval = 4
    /// 重探节流上限：面板长期开着又未授权时，不该每 4s 起一个一次性任务。
    static let reprobeIntervalCap: TimeInterval = 60
    /// 当前节流间隔（指数退避；必备权限达成或重启后复位）。
    private var reprobeIntervalNow: TimeInterval = SettingsModel.reprobeInterval
    /// launchd 作业标签（安装器写入的同名 plist）。
    static let launchdLabel = "com.glasspane.daemon"

    /// daemon 未运行 / 旧 daemon 不上报时的卡片注记。
    static let noDaemonReportNote = "后台服务未在运行或版本过旧，暂时读不到它的授权状态"

    /// "有人应门但没回话"那一支的卡片注记：它既不是未运行，也不是运行中，
    /// 权限卡不能借用上面那句（那句会把人支去重启一个其实还活着的进程）。
    static let silentDaemonReportNote = "后台服务接了连接却没回话，暂时读不到它的授权状态"

    /// 页脚与后台服务卡共用的存活陈述。`footer` 决定要不要带上"后台服务"主语
    /// （侧栏那一行没有上下文，需要主语；卡内标题不需要）。
    static func livenessCaption(_ liveness: DaemonLiveness, footer: Bool) -> String {
        let subject = footer ? "后台服务" : ""
        switch liveness {
        case .unmeasured: return subject + "还没实测过"
        case .answering: return subject + "运行中"
        case .notRunning: return subject + "未运行"
        case .presentButSilent: return footer ? "后台服务应了门，却没回话" : "有人应门但没回话"
        }
    }

    /// 那一枚点的颜色：实测到回话才给绿点，没实测过给中性点，应门不回话给警示点。
    static func livenessTone(_ liveness: DaemonLiveness) -> StatusDotView.Tone {
        switch liveness {
        case .unmeasured: return .neutral
        case .answering: return .good
        case .notRunning: return .bad
        case .presentButSilent: return .warning
        }
    }

    /// 后台服务卡标题那一行：状态 + 实测到的版本号（没测到就不写，不占位）。
    static func daemonSummaryLine(_ entry: DaemonEntry) -> String {
        let caption = livenessCaption(entry.liveness, footer: false)
        guard entry.liveness == .answering, let version = entry.version, !version.isEmpty else {
            return caption
        }
        return caption + " \(version)"
    }

    /// 存活那一行的无障碍标识（带状态段）：中文文案不进 AXTitle，真机冒烟
    /// 要靠它读出"此刻 lit 的到底是哪一种实测结局"。
    static func livenessIdentifier(_ liveness: DaemonLiveness) -> String {
        let key: String
        switch liveness {
        case .unmeasured: key = "unmeasured"
        case .answering: key = "answering"
        case .notRunning: key = "not-running"
        case .presentButSilent: key = "silent"
        }
        return "gp-daemon-liveness-\(key)"
    }

    /// 当前存活结局那一行的文案与点色（页脚与卡共用，两处不许各写一套判据）。
    var daemonCaption: String { Self.livenessCaption(daemon.liveness, footer: false) }
    var daemonFooterCaption: String { Self.livenessCaption(daemon.liveness, footer: true) }
    var daemonTone: StatusDotView.Tone { Self.livenessTone(daemon.liveness) }
    var daemonLivenessIdentifier: String { Self.livenessIdentifier(daemon.liveness) }

    /// 第一帧 hello 回来**之前**的卡片状态。从前这里初始化成 `.notDetermined`
    /// （面板上写"未请求"），那是对一个还没问过的 daemon 声称它没请求过授权——
    /// 面板进程自己更不曾替它请求。三者（未验证 / 未在运行 / 未请求）必须各说各话，
    /// 与 `rebuildEntries()` 里"daemon 没上报"那一支同判据；开发者工具一项按设计
    /// 恒为未验证（TCC 无公开查询接口），它的注记同样不该先斩后奏。
    static func entriesBeforeDaemonReport() -> [PermissionEntry] {
        PermissionDescriptor.all.map { descriptor in
            PermissionEntry(
                kind: descriptor.kind,
                descriptor: descriptor,
                status: .unverifiable,
                statusNote: descriptor.kind == .developerTools ? nil : noDaemonReportNote
            )
        }
    }

    /// 顶部图标的拖拽源：daemon 有 bundle 身份时提供 **daemon 真身 .app**
    /// 的 fileURL（可直接拖进系统设置列表并显示图标）；daemon 未上报身份时
    /// 只提供纯文本导航——把设置面板自己的 .app 拖进去会授权错主体。
    var dragSource: PermissionGuide.DragSource {
        PermissionGuide.dragSource(for: daemon.subject)
    }

    /// 拖拽横幅副标题里给出的主体说明。
    var dragSourceHint: String {
        switch dragSource {
        case .bundleURL(let bundlePath):
            return "顶部图标就是后台服务本体（\(bundlePath)）：拖到下方卡片可直接打开对应授权面板"
        case .plainText:
            return "后台服务当前是未打包形态，系统设置列表里只显示文件名：拖拽仅用于跳转，重新安装打包版本后点「刷新」"
        }
    }

    /// 与 daemon 默认一致的 socket 路径。
    public static func defaultSocketPath() -> String {
        DaemonProbe.defaultSocketPath
    }

    init(
        socketPath: String? = nil,
        refreshOnAppear: Bool = true,
        probes: PermissionProbeSet = PermissionProbeSet(),
        daemonProbe: DaemonProbe = DaemonProbe()
    ) {
        let resolvedSocketPath = socketPath ?? Self.defaultSocketPath()
        self.panelProbes = probes
        self.daemonProbe = daemonProbe
        self.panelSubject = probes.snapshot().subject
        daemon = DaemonEntry(
            socketPath: resolvedSocketPath,
            liveness: .unmeasured,
            version: nil,
            protocolVersion: nil,
            pid: nil,
            subject: nil
        )
        entries = Self.entriesBeforeDaemonReport()
        if refreshOnAppear {
            refresh()
        }
    }

    // MARK: - 引导动作（P1 v1.2 §11.2：由 daemon 自己申请，面板只导航）

    /// 权限卡的统一引导入口：
    ///  1. 已授权 → 只把系统设置里对应那一页打开（按钮语义是"查看"）；
    ///  2. 取到 daemon 身份 → `launchctl submit` 让 daemon 以**自身身份**发起
    ///     系统申请，随后打开对应系统面板深链；
    ///  3. 取不到 daemon 身份 → 只打开深链并如实说明"面板代申请会记错主体"，
    ///     绝不把申请动作落在面板进程上。
    func guide(_ kind: PermissionKind) {
        setPendingGuide(kind)
        switch kind {
        case .developerTools:
            // 无系统总开关、无公开查询 API：仅打开面板 + 文案（恒 unverifiable）。
            PermissionGuide.openSystemPane(for: kind)
            return
        case .accessibility, .inputMonitoring, .screenRecording:
            if status(of: kind) == .granted {
                // 已授权时按钮的语义是"跳到系统设置里那一行"，所以必须真的跳。
                // 早先这里直接 return，用户点一个写着"查看"的按钮却毫无反应。
                pendingGuideKind = kind
                pendingGuideText = "系统设置已打开，\(PermissionGuide.descriptorName(for: kind))这一项当前是开启的。"
                PermissionGuide.openSystemPane(for: kind)
                return
            }
            if let binaryPath = daemon.subject?.binaryPath {
                requestPermissionViaDaemon(kind, daemonBinaryPath: binaryPath)
            }
            PermissionGuide.openSystemPane(for: kind)
        }
        refresh()
    }

    func guideAccessibility() { guide(.accessibility) }
    func guideInputMonitoring() { guide(.inputMonitoring) }
    func guideScreenRecording() { guide(.screenRecording) }
    func guideDeveloperTools() { guide(.developerTools) }

    /// 拖拽落点入口：语义是"精确导航 + 让 daemon 自己申请"。`droppedName` 是
    /// 被拖入 bundle 的可读名——它**不再是授权对象**（授权对象恒为 daemon），
    /// 因此仅用于回落文案，不进入卡片状态判定。
    @discardableResult
    func handleDrop(kind: PermissionKind, droppedName: String?) -> String {
        guide(kind)
        return pendingGuideText ?? PermissionGuide.instruction(for: kind, droppedName: droppedName ?? "GlassPane")
    }

    /// 以 launchd 一过性任务的方式让 daemon 发起申请。命令构造是 engine 侧纯
    /// 函数（`PermissionGuide.daemonRequestCommand`），本处只负责执行与清理。
    private func requestPermissionViaDaemon(_ kind: PermissionKind, daemonBinaryPath: String) {
        let nonce = "\(Int(Date().timeIntervalSince1970))-\(UInt32.random(in: 1...UInt32.max))"
        let command = PermissionGuide.daemonRequestCommand(
            for: kind,
            daemonBinaryPath: daemonBinaryPath,
            nonce: nonce
        )
        runSystemBinary(command.launchPath, arguments: command.arguments)
        // 任务为一次性（申请动作即起即停）；延迟清理标签，失败静默。
        let cleanup = PermissionGuide.daemonRequestCleanupCommand(jobLabel: command.jobLabel)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            self.runSystemBinary(cleanup.launchPath, arguments: cleanup.arguments)
        }
    }

    /// 尽力而为地执行系统侧命令（launchctl / open）：不取输出、失败静默——
    /// 命令不可用时卡片文案仍然给出下一步（与 `PermissionGuide.openSystemPane` 同口径）。
    nonisolated private func runSystemBinary(_ launchPath: String, arguments: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        try? process.run()
    }

    // MARK: - 状态测量（真源 = daemon 自报）

    /// 周期性权限检测（拖拽/按钮后自动点亮）：向 daemon 打一次 hello 取其自报
    /// 席位。必备权限全部 granted 时返回 true，供 UI 停表。
    ///
    /// 每一轮都是**新的实测**：这一轮没拿到回话就把灯灭掉（socket 文件还在而
    /// 对端不应门的那台进程，不是"运行中"的凭证）。只有"同一时刻已有另一轮在途"
    /// 才保持现状——那一轮正在测，这里既不该亮也不该灭。
    func pollPermissions() async -> Bool {
        if let liveness = await probeLiveness() {
            applyLiveness(liveness)
        }
        if !essentialPermissionsGranted {
            // 运行实例没达成：先分清"系统里真没授权"还是"授权了没重启"。
            await reprobeSeats()
        }
        return essentialPermissionsGranted
    }

    /// 必备三类（辅助功能/输入监控/屏幕录制）是否全部达成——`unverifiable`
    /// 不算达成（诚实呈现：daemon 不可达时不得停表假称已完成）。
    var essentialPermissionsGranted: Bool {
        entries.filter { $0.kind != .developerTools }.allSatisfy { $0.status == .granted }
    }

    func status(of kind: PermissionKind) -> PermissionStatus {
        entries.first { $0.kind == kind }?.status ?? .unverifiable
    }

    /// 系统里已授权、但运行中的 daemon 还读不到的权限（需重启生效）。
    var kindsNeedingRestart: [PermissionKind] {
        PermissionReprobe.kindsNeedingRestart(running: daemonReportedStatuses, reprobed: reprobed)
    }

    var restartHint: String {
        let kinds = kindsNeedingRestart
        return kinds.isEmpty ? "" : PermissionGuide.restartNeededText(kinds)
    }

    /// daemon 自报的席位（重探/重启后需要重算注记，单独留一份）。
    private var daemonReportedStatuses: [PermissionKind: PermissionStatus] = [:]

    /// 最近一次"调试能力"机器探测结果（P6 §7 的 `--check-developer-tools`，
    /// 由 daemon 自己的二进制在 launchd 上下文中跑）。显式触发、带时刻，
    /// 不作为实时席位。
    @Published var developerToolsCapability: DeveloperToolsCapability.Report?
    /// developerToolsCapability 是在哪个 daemon 进程上测得；pid 变了必须作废
    /// （旧结论不能冒充新进程的状态）。
    @Published var developerToolsProbePid: Int?
    @Published var isProbingDeveloperTools = false
    @Published var developerToolsProbeError: String?
    /// 失败在哪一步（供标识与自动化判读；文案仍走 developerToolsProbeError）。
    @Published var developerToolsProbeFailure: CapabilityFailure?
    private var capabilityInFlight = false
    /// 调试能力探测含真实 lldb 冷启动（P6 §0 F5 预算 120s × 两侧），等待窗要宽。
    static let capabilityProbeTimeout: TimeInterval = 260

    /// 用 daemon 自己的二进制重跑一次 `--permissions`（launchd 一次性任务，
    /// 责任上下文是 daemon 本身）：拿到"同一身份的新进程"看到的席位。
    func reprobeSeats(force: Bool = false) async -> PermissionReprobe.Result? {
        guard let binaryPath = daemon.subject?.binaryPath else { return nil }
        guard !reprobeInFlight else { return reprobed }
        if !force && Date().timeIntervalSince(lastReprobeAt) < reprobeIntervalNow { return reprobed }
        reprobeInFlight = true
        reprobeIntervalNow = min(reprobeIntervalNow * 2, Self.reprobeIntervalCap)
        lastReprobeAt = Date()
        defer { reprobeInFlight = false }
        let nonce = "\(Int(Date().timeIntervalSince1970))"
        let directory = NSTemporaryDirectory()
        let scriptPath = directory + "glasspane-reprobe-\(nonce).zsh"
        let outputPath = directory + "glasspane-reprobe-\(nonce).json"
        guard let submission = PermissionReprobe.submission(
            scriptPath: scriptPath, nonce: nonce,
            daemonBinaryPath: binaryPath, outputPath: outputPath
        ) else {
            // 路径不合规格＝这帧 hello 不可信（或 daemon 换了形态）。宁可不动。
            return reprobed
        }
        // 一次性任务轮询是阻塞调用——必须在主 actor 之外执行，否则面板整窗
        // 冻结（launchd 挂起 UI 进程会被看门狗杀掉，用户侧症状就是"点了没反应"）。
        let outcome = await Task.detached(priority: .utility) {
            Self.runOneShot(
                script: submission.script, scriptPath: scriptPath,
                outputPath: outputPath, command: submission.command
            )
        }.value
        let result: PermissionReprobe.Result?
        if case .text(let text) = outcome { result = PermissionReprobe.parse(text) } else { result = nil }
        if let result {
            reprobed = result
            rebuildEntries()
        }
        return result
    }

    /// 显式验证 daemon 的调试能力（开发者工具席位）。探测本身是受限的真
    /// `xcrun lldb` 运行（P6 §7），代价高，因此只由用户点击触发，结果带时刻
    /// 呈现；`hello.permissions.developerTools` 仍是 `unverifiable`（TCC 无公开
    /// 查询接口这一事实不变）。
    func verifyDeveloperTools() async {
        guard let binaryPath = daemon.subject?.binaryPath else {
            recordProbeFailure(.unreadable, "还没连上后台服务：调试能力要由它自己实测。点「刷新」恢复连接后重试。")
            return
        }
        guard !capabilityInFlight else { return }
        capabilityInFlight = true
        isProbingDeveloperTools = true
        developerToolsProbeError = nil
        defer { capabilityInFlight = false; isProbingDeveloperTools = false }
        let nonce = "\(Int(Date().timeIntervalSince1970))"
        let directory = NSTemporaryDirectory()
        let scriptPath = directory + "glasspane-devtools-\(nonce).zsh"
        let outputPath = directory + "glasspane-devtools-\(nonce).json"
        guard let submission = PermissionReprobe.submission(
            scriptPath: scriptPath, nonce: nonce,
            daemonBinaryPath: binaryPath, outputPath: outputPath,
            arguments: PermissionReprobe.developerToolsArguments
        ) else {
            // daemon 自报的路径不是绝对路径（或含换行）——这帧 hello 不可信，
            // 也不该把它交给 launchd 去执行。如实记失败，不改脚本形态去"绕一下"。
            recordProbeFailure(
                .writeFailed,
                "后台服务自报的程序路径不合规格（需为绝对路径），本次验证未提交：\(binaryPath)"
            )
            return
        }
        // 同 reprobeSeats：分钟级的实测等待绝不占用主线程。
        let timeout = Self.capabilityProbeTimeout
        let outcome = await Task.detached(priority: .utility) {
            Self.runOneShot(
                script: submission.script, scriptPath: scriptPath, outputPath: outputPath,
                command: submission.command, timeoutSeconds: timeout
            )
        }.value
        switch outcome {
        case .text(let text):
            if let report = DeveloperToolsCapability.parse(text, observedAt: Date()) {
                developerToolsCapability = report
                developerToolsProbePid = daemon.pid
                developerToolsProbeError = nil
                developerToolsProbeFailure = nil
                setPendingGuide(.developerTools)
            } else {
                recordProbeFailure(.unreadable)
            }
        case .writeFailed:
            recordProbeFailure(.writeFailed)
        case .spawnFailed:
            recordProbeFailure(.spawnFailed)
        case .timedOut:
            recordProbeFailure(.timedOut)
        }
    }

    /// 记录一次验证失败：文案（可覆盖为上下文更贴切的说法）+ 可判读的失败阶段。
    ///
    /// 旧结论必须同一步作废。从前这里只写失败，于是徽标还挂着上一次的
    /// "可用（实测）"，而下面那一行说的是这次超时——两句话讲的是同一个席位，
    /// 留一句假的比留两句更糟。
    func recordProbeFailure(_ failure: CapabilityFailure, _ text: String? = nil) {
        invalidateDeveloperToolsVerdict()
        developerToolsProbeFailure = failure
        developerToolsProbeError = text ?? failure.fallbackText
    }

    /// 作废"验证调试能力"的那次实测结论（结论、时刻与失败阶段一起）：
    /// daemon 换了进程、或这一次没测成，旧结论都不再代表现状。
    private func invalidateDeveloperToolsVerdict() {
        developerToolsCapability = nil
        developerToolsProbeError = nil
        developerToolsProbePid = nil
        developerToolsProbeFailure = nil
    }

    /// 结论行的状态标记：在途 / 失败(在哪一步) / 已出结论；nil = 整行不渲染。
    var capabilityMarker: PermissionGuide.CapabilityMarker? {
        if isProbingDeveloperTools { return .pending }
        if let report = developerToolsCapability { return .concluded(report.status) }
        if let failure = developerToolsProbeFailure { return .failed(failure) }
        return nil
    }

    /// 「重启后台服务」这一按的实际结局：非 0 退出或 launchctl 压根起不来时
    /// 给出手动重启那句话。从前这里 `try?` 把结果丢掉，服务不是 launchd 托管的
    /// 机器上按下什么也不会发生，而那句"重启后生效"的横幅留在原处。
    @Published var daemonRestartHint: String?

    /// 重启 launchd 托管的 daemon 让授权生效。会打断正在进行的 act，
    /// 因此只作为用户显式点击的动作提供，绝不自动执行。
    func restartDaemon() {
        let command = PermissionGuide.daemonRestartCommand(label: Self.launchdLabel, uid: Int(getuid()))
        daemonRestartHint = nil
        // 节流复位，让下一轮重探早点补上新进程看到的席位。
        reprobeIntervalNow = Self.reprobeInterval
        // 旧进程那次重探的结论此刻仍然算数（新进程还没应门），所以这里不清空：
        // 一按下就把"待重启"的横幅抹掉，等于把"这一步可能根本没成"藏起来。
        Task.detached(priority: .userInitiated) {
            let status = Self.runSystemBinaryAndWait(command.launchPath, arguments: command.arguments)
            Task { @MainActor in
                self.daemonRestartHint = Self.restartOutcomeHint(exitStatus: status)
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if let liveness = await self.probeLiveness() {
                    self.applyLiveness(liveness)
                    if self.daemonRestartHint == nil, case .answered = liveness {
                        // kickstart 报成、服务也重新应了门：旧进程的重探结论不再代表现状，
                        // 撤掉它，让下一轮重探重新判"还差哪个席位"。
                        self.reprobed = nil
                        self.lastReprobeAt = Date.distantPast
                    }
                }
            }
        }
    }

    /// kickstart 的结局 → 要不要给手动重启那句话：`nil`（连 launchctl 都没起来）
    /// 与非 0 退出都等于**没重启**，这时候留着横幅等用户再点是第二次欺骗。
    static func restartOutcomeHint(exitStatus: Int32?) -> String? {
        exitStatus == 0 ? nil : PermissionGuide.manualRestartHint
    }

    /// 起进程并等它退出，返回退出码；起不来返回 nil。
    nonisolated private static func runSystemBinaryAndWait(_ launchPath: String, arguments: [String]) -> Int32? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        do {
            try process.run()
        } catch {
            return nil
        }
        process.waitUntilExit()
        return process.terminationStatus
    }

    /// 一次性任务的结局：文本，或失败在哪一步。两者必须分开——面板曾在
    /// "启动器路径不存在"与"实测超时"共用一个 nil 的状态里摸黑排查。
    enum OneShotOutcome {
        case text(String)
        case writeFailed
        case spawnFailed
        case timedOut
    }

    /// 一次性 launchd 任务的执行面（后台队列）：落脚本 → submit → 轮询读回
    /// 原始输出 → 清理任务标签与临时文件。
    nonisolated private static func runOneShot(
        script: String,
        scriptPath: String,
        outputPath: String,
        command: PermissionGuide.PermissionRequestCommand,
        timeoutSeconds: TimeInterval = 6
    ) -> OneShotOutcome {
        let url = URL(fileURLWithPath: scriptPath)
        do {
            // NSTemporaryDirectory() 对非 sandbox 进程可能指向尚未创建的目录，
            // 不先 mkdir 时原子写直接抛错、一次性任务从未提交（面板侧表现为
            // "点了没反应"）。目录不存在就必须先建。
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try script.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptPath)
        } catch {
            FileHandle.standardError.write(Data("runOneShot script-write failed: \(error) path=\(scriptPath)\n".utf8))
            return .writeFailed
        }
        try? FileManager.default.removeItem(atPath: outputPath)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.launchPath)
        process.arguments = command.arguments
        do {
            try process.run()
        } catch {
            FileHandle.standardError.write(Data("runOneShot launchctl submit failed: \(error)\n".utf8))
            return .spawnFailed
        }
        var result: OneShotOutcome = .timedOut
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if let text = try? String(contentsOfFile: outputPath, encoding: .utf8),
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result = .text(text)
                break
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        let cleanup = PermissionGuide.daemonRequestCleanupCommand(jobLabel: command.jobLabel)
        let remover = Process()
        remover.executableURL = URL(fileURLWithPath: cleanup.launchPath)
        remover.arguments = cleanup.arguments
        try? remover.run()
        try? FileManager.default.removeItem(atPath: scriptPath)
        try? FileManager.default.removeItem(atPath: outputPath)
        return result
    }

    /// 重查全部权限与 daemon 状态：一次真实的 hello 握手（3s 会话，放后台不阻塞主线程）。
    ///
    /// 这里刻意不再取 `reachable(socketPath:)` 的数——那个函数只回答"文件在不在"，
    /// 拿它当存活判据就是"灯亮着而服务早没了"这一类缺陷的由来。
    func refresh() {
        isRefreshing = true
        lastRefreshError = nil
        let socketPath = daemon.socketPath
        let transport = daemonProbe
        Task.detached(priority: .userInitiated) {
            let liveness = transport.liveness(socketPath: socketPath)
            Task { @MainActor in
                self.applyLiveness(liveness)
                self.isRefreshing = false
            }
        }
    }

    /// 一次性存活实测（后台队列，带在途保护）。
    /// nil = 这一轮根本没跑（已有在途），调用方必须保持现状，不得据此改灯。
    private func probeLiveness() async -> DaemonProbe.Liveness? {
        guard !probeInFlight else { return nil }
        probeInFlight = true
        defer { probeInFlight = false }
        let socketPath = daemon.socketPath
        let transport = daemonProbe
        return await withCheckedContinuation { (continuation: CheckedContinuation<DaemonProbe.Liveness?, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: transport.liveness(socketPath: socketPath))
            }
        }
    }

    /// 把一次实测的存活结局落到发布状态上：daemon 自报什么就显示什么；没有回话
    /// 就没有自报，权限卡一律 `unverifiable` + 注记，不用面板进程的席位冒充。
    ///
    /// 从前这里写着"探测失败不推翻此前的 reachable=true 判定"，那句话就是这个缺陷
    /// 本身的形状：残留 socket 让绿点一直亮着，而它下面四张卡说服务没在运行。
    /// 现在没有回话就灭灯，重新应门才会再亮。
    private func applyLiveness(_ liveness: DaemonProbe.Liveness) {
        switch liveness {
        case .answered(let summary):
            daemon.liveness = .answering
            daemon.version = summary.version
            daemon.protocolVersion = summary.protocolVersion
            daemon.pid = summary.pid
            daemon.subject = summary.subject
            daemonReportedStatuses = summary.permissions
            if let probePid = developerToolsProbePid, probePid != summary.pid {
                // daemon 换过进程：上一次"验证调试能力"的结论不再代表现状。
                invalidateDeveloperToolsVerdict()
            }
        case .noListener:
            clearDaemonReport(to: .notRunning)
        case .presentButNotAnswering(let reason):
            clearDaemonReport(to: .presentButSilent(reason: reason))
        }
        rebuildEntries()
    }

    /// 没回话时能读到的东西就是没有：版本号 / 协议 / PID / 身份 / 自报席位一起清空。
    /// 留着任何一个都是"上一次测量的结论冒充这一次的现状"。
    private func clearDaemonReport(to liveness: DaemonLiveness) {
        daemon.liveness = liveness
        daemon.version = nil
        daemon.protocolVersion = nil
        daemon.pid = nil
        daemon.subject = nil
        daemonReportedStatuses = [:]
    }

    /// 由 daemon 自报席位 + 重探结果重算卡片状态与注记。
    private func rebuildEntries() {
        let reported = daemonReportedStatuses
        let restartKinds = Set(kindsNeedingRestart)
        for index in entries.indices {
            let kind = entries[index].kind
            if kind == .developerTools {
                entries[index].status = .unverifiable
                entries[index].statusNote = nil
                continue
            }
            if let status = reported[kind] {
                entries[index].status = status
                entries[index].statusNote = restartKinds.contains(kind)
                    ? "系统设置里已勾选，重启后台服务后生效"
                    : nil
            } else {
                entries[index].status = .unverifiable
                entries[index].statusNote = noReportNote
            }
        }
    }

    /// "这张卡为什么没有状态"那一句，按实测到的存活结局分两种说法：没在运行、
    /// 应了门但不回话是两件不同的事——后者让人去重启一个其实还活着的进程就是支错招。
    private var noReportNote: String {
        if case .presentButSilent = daemon.liveness { return Self.silentDaemonReportNote }
        return Self.noDaemonReportNote
    }

    private func setPendingGuide(_ kind: PermissionKind, droppedName: String? = nil) {
        pendingGuideKind = kind
        let subject = daemon.subject
        let subjectName = subject?.tccEntryName ?? "glasspaned"
        let hasBundleIdentity = subject?.hasBundleIdentity ?? false
        var text = PermissionGuide.instruction(for: kind, subjectName: subjectName, hasBundleIdentity: hasBundleIdentity)
        if kind != .developerTools, subject == nil {
            text = PermissionGuide.daemonRequiredText + " " + text
        }
        if let droppedName, !droppedName.isEmpty {
            text += "（拖入的『\(droppedName)』只是帮你跳转；真正要勾选的是后台服务本身）"
        }
        pendingGuideText = text
    }
}
