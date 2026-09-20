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

    /// daemon 状态卡内容。
    struct DaemonEntry {
        var socketPath: String
        var reachable: Bool
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
    private var helloInFlight = false
    /// 同一身份新进程的重探结果（用于区分"系统里没授权"与"授权了但 daemon
    /// 需重启才生效"，P1 v1.2 §11.4）。
    @Published var reprobed: PermissionReprobe.Result?
    private var reprobeInFlight = false
    private var lastReprobeAt = Date.distantPast
    /// 重探节流：只在有必备权限未达成且距上次超过该间隔时才发起。
    static let reprobeInterval: TimeInterval = 4
    /// launchd 作业标签（安装器写入的同名 plist）。
    static let launchdLabel = "com.glasspane.daemon"

    /// daemon 未运行 / 旧 daemon 不上报时的卡片注记。
    static let noDaemonReportNote = "后台服务未在运行或版本过旧，暂时读不到它的授权状态"

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
        NSHomeDirectory() + "/.glasspane/engine.sock"
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
            reachable: false,
            version: nil,
            protocolVersion: nil,
            pid: nil,
            subject: nil
        )
        entries = PermissionDescriptor.all.map { descriptor in
            PermissionEntry(kind: descriptor.kind, descriptor: descriptor, status: .notDetermined, statusNote: nil)
        }
        if refreshOnAppear {
            refresh()
        }
    }

    // MARK: - 引导动作（P1 v1.2 §11.2：由 daemon 自己申请，面板只导航）

    /// 权限卡的统一引导入口：
    ///  1. 已授权 → no-op；
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
    /// hello 无响应（daemon 正在处理一次 act，SocketServer 单连接语义下会排队）
    /// 时**保持上一次读数**，不清空也不降级——降级判断交给显式「刷新」。
    func pollPermissions() async -> Bool {
        if let summary = await helloSummary() {
            applyDaemonSummary(summary)
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
    private var capabilityInFlight = false
    /// 调试能力探测含真实 lldb 冷启动（P6 §0 F5 预算 120s × 两侧），等待窗要宽。
    static let capabilityProbeTimeout: TimeInterval = 260

    /// 用 daemon 自己的二进制重跑一次 `--permissions`（launchd 一次性任务，
    /// 责任上下文是 daemon 本身）：拿到"同一身份的新进程"看到的席位。
    func reprobeSeats(force: Bool = false) async -> PermissionReprobe.Result? {
        guard let binaryPath = daemon.subject?.binaryPath else { return nil }
        guard !reprobeInFlight else { return reprobed }
        if !force && Date().timeIntervalSince(lastReprobeAt) < Self.reprobeInterval { return reprobed }
        reprobeInFlight = true
        lastReprobeAt = Date()
        defer { reprobeInFlight = false }
        let nonce = "\(Int(Date().timeIntervalSince1970))"
        let directory = NSTemporaryDirectory()
        let scriptPath = directory + "glasspane-reprobe-\(nonce).zsh"
        let outputPath = directory + "glasspane-reprobe-\(nonce).json"
        let script = PermissionReprobe.script(daemonBinaryPath: binaryPath, outputPath: outputPath)
        let command = PermissionReprobe.submitCommand(scriptPath: scriptPath, nonce: nonce)
        // 一次性任务轮询是阻塞调用——必须在主 actor 之外执行，否则面板整窗
        // 冻结（launchd 挂起 UI 进程会被看门狗杀掉，用户侧症状就是"点了没反应"）。
        let text = await Task.detached(priority: .utility) {
            Self.runOneShot(script: script, scriptPath: scriptPath, outputPath: outputPath, command: command)
        }.value
        let result = text.flatMap { PermissionReprobe.parse($0) }
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
            developerToolsProbeError = "还没连上后台服务：调试能力要由它自己实测。点「刷新」恢复连接后重试。"
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
        let script = PermissionReprobe.script(
            daemonBinaryPath: binaryPath,
            outputPath: outputPath,
            arguments: PermissionReprobe.developerToolsArguments
        )
        let command = PermissionReprobe.submitCommand(scriptPath: scriptPath, nonce: nonce)
        // 同 reprobeSeats：分钟级的实测等待绝不占用主线程。
        let timeout = Self.capabilityProbeTimeout
        let text = await Task.detached(priority: .utility) {
            Self.runOneShot(
                script: script, scriptPath: scriptPath, outputPath: outputPath, command: command,
                timeoutSeconds: timeout
            )
        }.value
        if let text, let report = DeveloperToolsCapability.parse(text, observedAt: Date()) {
            developerToolsCapability = report
            developerToolsProbePid = daemon.pid
            setPendingGuide(.developerTools)
        } else {
            developerToolsProbeError = text == nil
                ? "这次验证等得有点久，没有回音（首次启动调试器可能要好几分钟）。再点一次「验证调试能力」试试。"
                : "这次验证返回了读不懂的结果，状态保持\"未验证\"。稍后再试一次，或联系维护者附上下方时间行。"
        }
    }

    /// 重启 launchd 托管的 daemon 让授权生效。会打断正在进行的 act，
    /// 因此只作为用户显式点击的动作提供，绝不自动执行。
    func restartDaemon() {
        let command = PermissionGuide.daemonRestartCommand(label: Self.launchdLabel, uid: Int(getuid()))
        runSystemBinary(command.launchPath, arguments: command.arguments)
        reprobed = nil
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if let summary = await helloSummary() {
                applyDaemonSummary(summary)
            }
        }
    }

    /// 一次性 launchd 任务的执行面（后台队列）：落脚本 → submit → 轮询读回
    /// 原始输出 → 清理任务标签与临时文件。返回文件内容文本（失败 nil）。
    nonisolated private static func runOneShot(
        script: String,
        scriptPath: String,
        outputPath: String,
        command: PermissionGuide.PermissionRequestCommand,
        timeoutSeconds: TimeInterval = 6
    ) -> String? {
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
            return nil
        }
        try? FileManager.default.removeItem(atPath: outputPath)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.launchPath)
        process.arguments = command.arguments
        do {
            try process.run()
        } catch {
            FileHandle.standardError.write(Data("runOneShot launchctl submit failed: \(error)\n".utf8))
            return nil
        }
        var result: String?
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if let text = try? String(contentsOfFile: outputPath, encoding: .utf8),
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result = text
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

    /// 重查全部权限与 daemon 状态（hello 会话 3s 超时，放后台不阻塞主线程）。
    func refresh() {
        isRefreshing = true
        lastRefreshError = nil
        let socketPath = daemon.socketPath
        let transport = daemonProbe
        Task.detached(priority: .userInitiated) {
            let reachable = transport.reachable(socketPath: socketPath)
            let summary = transport.helloSummary(socketPath: socketPath)
            Task { @MainActor in
                self.applyDaemonSummary(summary, reachable: reachable)
                self.isRefreshing = false
            }
        }
    }

    /// 一次性 hello（后台队列，带在途保护）。
    private func helloSummary() async -> DaemonProbe.Summary? {
        guard !helloInFlight else { return nil }
        helloInFlight = true
        defer { helloInFlight = false }
        let socketPath = daemon.socketPath
        let transport = daemonProbe
        return await withCheckedContinuation { (continuation: CheckedContinuation<DaemonProbe.Summary?, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: transport.helloSummary(socketPath: socketPath))
            }
        }
    }

    /// 把 hello 结果落到发布状态：daemon 自报什么就显示什么；没有上报的
    /// 权限卡一律 `unverifiable` + 注记，不用面板进程的席位冒充。
    private func applyDaemonSummary(_ summary: DaemonProbe.Summary?, reachable: Bool? = nil) {
        if let summary {
            daemon.version = summary.version
            daemon.protocolVersion = summary.protocolVersion
            daemon.pid = summary.pid
            if let probePid = developerToolsProbePid, probePid != summary.pid {
                // daemon 换过进程：上一次"验证调试能力"的结论不再代表现状。
                developerToolsCapability = nil
                developerToolsProbeError = nil
                developerToolsProbePid = nil
            }
        }
        if let reachable {
            daemon.reachable = reachable
        }
        // hello 有响应即视为存活（探测失败不推翻此前的 reachable=true 判定，
        // 因为 socket 文件可能仍在但对端无响应——那种情况由刷新按钮重新判定）。
        if summary != nil {
            daemon.reachable = true
        }
        daemon.subject = summary?.subject
        daemonReportedStatuses = summary?.permissions ?? [:]
        rebuildEntries()
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
                entries[index].statusNote = Self.noDaemonReportNote
            }
        }
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
