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
/// 唯一的例外是 daemon 存活：它按**本层自己的测量**呈现——`hello` 有回音才算
/// 在运行，socket 文件存在与否只用来区分"没人答话"和"没有服务"。
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

    /// daemon 存活状态：**只由测量决定**——向它打 `hello` 到底有没有回音。
    /// socket 文件存在不等于后台服务在跑（进程被 SIGKILL 后文件照旧留在原地，
    /// 卡死的进程也照样留着），因此"文件在、没人答话"必须是独立一态，
    /// 既不算运行中，也不冒充"测量过说它没跑"。
    enum Liveness: Equatable {
        /// hello 得到回音（版本/PID/协议/主体这几行的内容就来自这次回音）。
        case running
        /// socket 文件在，但 hello 没有回音（对端卡死，或残留的 stale socket）。
        case presentButSilent
        /// socket 文件不在。
        case absent
        /// 还没打过 hello（面板起来后的第一拍）。
        case notMeasured
    }

    /// 一次存活测量的结局。`notMeasured` 与"没有回音"必须分开：被在途保护跳过的
    /// 那一拍什么也没测，不能拿它去作废上一次测量。
    private enum DaemonMeasurement {
        case answered(DaemonProbe.Summary)
        case silent(socketPresent: Bool)
        case notMeasured
    }

    /// daemon 状态卡内容。
    struct DaemonEntry {
        var socketPath: String
        /// 最近一次存活测量的结果（还没测量过时为 `.notMeasured`）。
        var liveness: Liveness
        var version: String?
        var protocolVersion: String?
        var pid: Int?
        /// daemon 自报的授权主体（nil = 最近一次没拿到回音，或回音里没带身份）。
        var subject: PermissionSubject?

        /// 只有真的收到回音才算"在运行"。
        var isRunning: Bool { liveness == .running }
    }

    @Published var entries: [PermissionEntry] = []
    @Published var daemon: DaemonEntry
    @Published var isRefreshing = false
    /// 「读不到后台服务」的红字（渲染在 daemon 卡里）：只由存活测量赋值，读到了
    /// 就清空。此前全文没有任何地方给它赋值，失败在界面上完全没有痕迹。
    @Published var lastRefreshError: String?
    /// 用户点下去的动作（申请授权 / 重启后台服务）没执行成功时的红字。与上一行
    /// 分列：一句说的是"读"，一句说的是"做"，混用会互相抹掉。
    @Published var lastActionError: String?
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
    /// 重探节流上限：面板长期开着又未授权时，不该每 4s 起一个一次性任务。
    static let reprobeIntervalCap: TimeInterval = 60
    /// 当前节流间隔（指数退避；必备权限达成或重启后复位）。
    private var reprobeIntervalNow: TimeInterval = SettingsModel.reprobeInterval
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
            liveness: .notMeasured,
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
            // 无公开查询 API：只打开面板 + 文案；卡片状态来自「验证调试能力」
            // 的实测结论（没测过才是 unverifiable）。
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
        lastActionError = nil
        let command = PermissionGuide.daemonRequestCommand(
            for: kind,
            daemonBinaryPath: daemonBinaryPath,
            nonce: Self.oneShotNonce()
        )
        if let failure = Self.runSystemBinary(command.launchPath, arguments: command.arguments) {
            // 申请动作没跑起来 = 系统设置里不会出现这个主体，卡片也不会自己变绿；
            // 这句必须留在界面上，否则用户只看到"已请求授权"。
            lastActionError = "没能请后台服务自己发起授权申请：\(failure)。授权动作本身仍可在系统设置里手动加。"
        }
        // 任务为一次性（申请动作即起即停）；延迟清理标签。
        let cleanup = PermissionGuide.daemonRequestCleanupCommand(jobLabel: command.jobLabel)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if let failure = Self.runSystemBinary(cleanup.launchPath, arguments: cleanup.arguments) {
                FileHandle.standardError.write(Data("one-shot cleanup \(command.jobLabel): \(failure)\n".utf8))
            }
        }
    }

    /// 一次性 launchd 任务的标签后缀：**秒级时间戳加随机尾**。只用秒级时间戳时，
    /// 同一秒内并发的两个任务（席位重探与调试能力验证会同时发生）标签撞车，
    /// 收尾的 `launchctl remove` 会把对方刚提交的作业 bootout 掉——那条测量
    /// 从未起跑，却被报成"等得有点久"。
    nonisolated private static func oneShotNonce() -> String {
        "\(Int(Date().timeIntervalSince1970))-\(UInt32.random(in: 1...UInt32.max))"
    }

    /// 尽力而为地执行系统侧命令（launchctl / open）：不取输出，但"命令没跑起来"
    /// 与"跑起来了"必须区分开——静默失败曾让整面板停摆数日无人察觉。
    /// 返回 nil 表示已交给系统执行。
    nonisolated private static func runSystemBinary(
        _ launchPath: String,
        arguments: [String],
        waitsForExit: Bool = false
    ) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        do {
            try process.run()
        } catch {
            return "命令无法执行（\(launchPath)）：\(error.localizedDescription)"
        }
        guard waitsForExit else { return nil }
        process.waitUntilExit()
        guard process.terminationStatus != 0 else { return nil }
        return "没有成功（\(launchPath) 退出码 \(process.terminationStatus)）"
    }

    /// 同上，但**等命令跑完并取回退出码**（等待放在主 actor 之外）：需要知道
    /// 成没成就用这条，不能只凭"我把它 spawn 出去了"。
    nonisolated private static func runSystemBinaryAndWait(
        _ launchPath: String,
        arguments: [String]
    ) async -> String? {
        await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: runSystemBinary(
                    launchPath, arguments: arguments, waitsForExit: true
                ))
            }
        }
    }

    // MARK: - 状态测量（卡片席位 = daemon 自报；daemon 存活 = hello 有没有回音）

    /// 周期性权限检测（拖拽/按钮后自动点亮）：向 daemon 打一次 hello 取其自报
    /// 席位。必备权限全部 granted 时返回 true，供 UI 停表。
    ///
    /// hello 无回音时**不保留上一次的自报内容**：那几行属于一个此刻不答话的进程，
    /// 继续挂着就是拿它的旧话当现状（存活行与四张卡同步降级）。
    func pollPermissions() async -> Bool {
        applyDaemonSummary(await measureDaemon())
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

    /// 「重启后台服务」横幅的文案；nil = 此刻不必显示。
    ///
    /// 两类成因都要给出这个入口：
    ///  - 授权已落、运行实例读不到（`kindsNeedingRestart`）；
    ///  - 后台服务根本没应答——这时 `kindsNeedingRestart` 恰好恒为空（重探要先
    ///    拿到 daemon 身份才可能成功），把唯一可执行的自救控件只挂在那个集合上，
    ///    等于 daemon 一死面板就没有任何可点的按钮。
    var daemonAttentionText: String? {
        if !kindsNeedingRestart.isEmpty { return restartHint }
        switch daemon.liveness {
        case .presentButSilent:
            return "后台服务没有回应（socket 文件还在，但它不答话）：点「重启后台服务」重新拉起它"
        case .absent:
            return "后台服务没有在运行：点「重启后台服务」让 launchd 重新拉起它"
        case .running, .notMeasured:
            return nil
        }
    }

    /// daemon 自报的席位（重探/重启后需要重算注记，单独留一份）。
    private var daemonReportedStatuses: [PermissionKind: PermissionStatus] = [:]

    /// 最近一次"调试能力"机器探测结果（P6 §7 的 `--check-developer-tools`，
    /// 由 daemon 自己的二进制在 launchd 上下文中跑）。显式触发、带时刻；
    /// 归属进程还在答话时它才算现状（见 `liveDeveloperToolsReport`）。
    @Published var developerToolsCapability: DeveloperToolsCapability.Report?
    /// 这次实测**归属**哪个 daemon 进程：发起验证时就按当时自报的 pid 钉死
    /// （不是在最长 260s 的等待之后才补记），回音时它必须还是当前进程。
    @Published var developerToolsProbePid: Int?
    @Published var isProbingDeveloperTools = false
    @Published var developerToolsProbeError: String?
    /// 失败在哪一步（供标识与自动化判读；文案仍走 developerToolsProbeError）。
    @Published var developerToolsProbeFailure: CapabilityFailure?
    private var capabilityInFlight = false
    /// 调试能力探测含真实 lldb 冷启动（P6 §0 F5 预算 120s × 两侧），等待窗要宽。
    static let capabilityProbeTimeout: TimeInterval = 260

    /// **当前有效**的调试能力实测结论：它归属的那个 daemon 进程必须还是此刻
    /// 正在答话的这个进程。没有有效结论时卡片两副面孔（可见徽标与机器可读
    /// 标识）一律回到 `unverifiable`——不由视图各取一次值，避免两面互相冒充。
    var liveDeveloperToolsReport: DeveloperToolsCapability.Report? {
        guard daemon.isRunning,
              let report = developerToolsCapability,
              let probePid = developerToolsProbePid,
              probePid == daemon.pid else { return nil }
        return report
    }

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
        let nonce = Self.oneShotNonce()
        let directory = NSTemporaryDirectory()
        let scriptPath = directory + "glasspane-reprobe-\(nonce).zsh"
        let outputPath = directory + "glasspane-reprobe-\(nonce).json"
        let script = PermissionReprobe.script(daemonBinaryPath: binaryPath, outputPath: outputPath)
        let command = PermissionReprobe.submitCommand(scriptPath: scriptPath, nonce: nonce)
        // 一次性任务轮询是阻塞调用——必须在主 actor 之外执行，否则面板整窗
        // 冻结（launchd 挂起 UI 进程会被看门狗杀掉，用户侧症状就是"点了没反应"）。
        let outcome = await Task.detached(priority: .utility) {
            Self.runOneShot(script: script, scriptPath: scriptPath, outputPath: outputPath, command: command)
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
    /// 呈现；daemon 自报的 `hello.permissions.developerTools` 恒为
    /// `unverifiable`（TCC 无公开查询接口这一事实不变），开发者工具卡显示的
    /// 是这次实测的结论——结论作废时卡片同步退回未验证。
    func verifyDeveloperTools() async {
        // 身份与 pid 在**发起时**一次取全：这次实测从头到尾只属于这个进程。
        // 等到回音后再记 pid，等于把一份可能来自上一个进程的结论挂到重启后的
        // 新进程头上（面板自己就带重启按钮，这条路径是常规路径不是边角）。
        guard let binaryPath = daemon.subject?.binaryPath, let probePid = daemon.pid else {
            recordProbeFailure(.unreadable, "还没连上后台服务：调试能力要由它自己实测。点「刷新」恢复连接后重试。")
            return
        }
        guard !capabilityInFlight else { return }
        capabilityInFlight = true
        isProbingDeveloperTools = true
        developerToolsProbeError = nil
        developerToolsProbeFailure = nil
        developerToolsProbePid = probePid
        defer { capabilityInFlight = false; isProbingDeveloperTools = false }
        let nonce = Self.oneShotNonce()
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
        let outcome = await Task.detached(priority: .utility) {
            Self.runOneShot(
                script: script, scriptPath: scriptPath, outputPath: outputPath, command: command,
                timeoutSeconds: timeout
            )
        }.value
        guard developerToolsProbePid == probePid else {
            // 在途期间 daemon 换过进程（作废由 applyDaemonSummary 落地）：
            // 这份回音不属于当前进程，直接丢掉，不点亮任何结论。
            recordProbeFailure(.unreadable, "后台服务在这次验证期间换过进程：这份回音不是它给的，结论已作废，请再验证一次。")
            return
        }
        switch outcome {
        case .text(let text):
            if let report = DeveloperToolsCapability.parse(text, observedAt: Date()) {
                developerToolsCapability = report
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
        rebuildEntries()
    }

    /// 记录一次验证失败：文案（可覆盖为上下文更贴切的说法）+ 可判读的失败阶段。
    /// **同时作废上一次的结论**——新一轮实测没拿出结果，之前那个"可用（实测）"
    /// 就不再是现状（撤销授权后再验证失败时留着绿徽标，等于用旧测量冒充新状态）。
    private func recordProbeFailure(_ failure: CapabilityFailure, _ text: String? = nil) {
        developerToolsProbeFailure = failure
        developerToolsProbeError = text ?? failure.fallbackText
        developerToolsCapability = nil
        developerToolsProbePid = nil
        rebuildEntries()
    }

    /// 结论行的状态标记：在途 / 失败(在哪一步) / 已出结论；nil = 整行不渲染。
    /// 只认**当前有效**的实测结论（作废过的、换了进程的都不算）。
    var capabilityMarker: PermissionGuide.CapabilityMarker? {
        if isProbingDeveloperTools { return .pending }
        if let report = liveDeveloperToolsReport { return .concluded(report.status) }
        if let failure = developerToolsProbeFailure { return .failed(failure) }
        return nil
    }

    /// 重启 launchd 托管的 daemon 让授权生效。会打断正在进行的 act，
    /// 因此只作为用户显式点击的动作提供，绝不自动执行。
    func restartDaemon() {
        let command = PermissionGuide.daemonRestartCommand(label: Self.launchdLabel, uid: Int(getuid()))
        // kickstart -k 会杀掉当前进程：属于它的调试能力实测结论同时失效。
        invalidateDeveloperToolsProbe()
        lastActionError = nil
        lastRefreshError = nil
        reprobed = nil
        reprobeIntervalNow = Self.reprobeInterval
        Task { @MainActor in
            // 退出码要看：这个后台服务不是 launchd 托管时 kickstart 直接失败，
            // 不取退出码就只剩一句"点了没反应"。
            if let failure = await Self.runSystemBinaryAndWait(
                command.launchPath, arguments: command.arguments
            ) {
                self.lastActionError = "重启后台服务\(failure)：\(PermissionGuide.manualRestartHint)"
            }
            // kickstart 之后后台服务还要一点时间才把 socket 重新绑上：那之前的
            // "没有回应"不是重启的结果，测了只会白降一级。
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            self.applyDaemonSummary(await self.measureDaemon())
        }
    }

    /// 作废调试能力的实测结论与其进程归属：换了进程 = 没测过。
    private func invalidateDeveloperToolsProbe() {
        developerToolsCapability = nil
        developerToolsProbePid = nil
        developerToolsProbeError = nil
        developerToolsProbeFailure = nil
        rebuildEntries()
    }

    /// 一次性任务的结局：文本，或失败在哪一步。两者必须分开——面板曾在
    /// "启动器路径不存在"与"实测超时"共用一个 nil 的状态里摸黑排查。
    /// `.spawnFailed` 覆盖"提交就没被接受"（作业从未起跑），`.timedOut` 只用于
    /// "起跑后没在预算内回话"。
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
        // 提交命令的退出码要看：launchctl 拒收（标签已被占用、脚本不可执行…）时
        // 作业从未起跑，等满预算再报"没有回音"就是把没发生的事说成超时。
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            FileHandle.standardError.write(Data("runOneShot submit exited \(process.terminationStatus) label=\(command.jobLabel)\n".utf8))
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
        do {
            try remover.run()
        } catch {
            // 清理没跑成 = 标签留在 launchd 里等下次回收；不假装已经收干净。
            FileHandle.standardError.write(Data("runOneShot cleanup \(command.jobLabel) failed: \(error)\n".utf8))
        }
        try? FileManager.default.removeItem(atPath: scriptPath)
        try? FileManager.default.removeItem(atPath: outputPath)
        return result
    }

    /// 重查全部权限与 daemon 状态（hello 会话 3s 超时，放后台不阻塞主线程）。
    /// 失败**必须留下一句话**：这一行红字本来就渲染在 daemon 卡里，此前没有任何
    /// 地方给它赋值，于是"读不到后台服务"在面板上完全没有痕迹。
    func refresh() {
        isRefreshing = true
        lastRefreshError = nil
        Task { @MainActor in
            let measurement = await self.measureDaemon()
            self.applyDaemonSummary(measurement)
            self.lastRefreshError = Self.daemonUnreachableText(
                measurement, socketPath: self.daemon.socketPath
            )
            self.isRefreshing = false
        }
    }

    /// 一次存活测量（后台队列，带在途保护）：hello 有没有回音，以及没回音时
    /// socket 文件在不在。后者只用来区分"没人答话"与"根本没在服务"，
    /// 它自己**永不**充当存活判据——文件是进程死后也会留在原地的东西。
    private func measureDaemon() async -> DaemonMeasurement {
        guard !helloInFlight else { return .notMeasured }
        helloInFlight = true
        defer { helloInFlight = false }
        let socketPath = daemon.socketPath
        let transport = daemonProbe
        let (summary, socketPresent) = await withCheckedContinuation {
            (continuation: CheckedContinuation<(DaemonProbe.Summary?, Bool), Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let summary = transport.helloSummary(socketPath: socketPath)
                continuation.resume(returning: (summary, transport.reachable(socketPath: socketPath)))
            }
        }
        if let summary { return .answered(summary) }
        return .silent(socketPresent: socketPresent)
    }

    /// 把一次测量落到发布状态：**测到什么就显示什么**。
    ///  - 有回音：daemon 自报什么就显示什么，没上报的权限卡一律 `unverifiable`，
    ///    不用面板进程的席位冒充；
    ///  - 没回音：清掉上一次回音留下的版本/协议/PID/主体行。留着它们，就是把一个
    ///    此刻不答话（甚至已经死了）的进程的自报当成现状，与同一屏上的
    ///    "后台服务未在运行"自相矛盾。
    private func applyDaemonSummary(_ measurement: DaemonMeasurement) {
        switch measurement {
        case .notMeasured:
            // 这一拍什么都没测（在途保护），上一次的结果继续有效。
            return
        case .answered(let summary):
            daemon.liveness = .running
            daemon.version = summary.version
            daemon.protocolVersion = summary.protocolVersion
            daemon.pid = summary.pid
            daemon.subject = summary.subject
            // 这一行红字只表达"读不到后台服务"；这次读到了，它就该消失。
            lastRefreshError = nil
            if let probePid = developerToolsProbePid, probePid != summary.pid {
                // daemon 换过进程：上一次"验证调试能力"的结论不再代表现状。
                invalidateDeveloperToolsProbe()
            }
            daemonReportedStatuses = summary.permissions
        case .silent(let socketPresent):
            daemon.liveness = socketPresent ? .presentButSilent : .absent
            daemon.version = nil
            daemon.protocolVersion = nil
            daemon.pid = nil
            daemon.subject = nil
            // 实测结论的归属进程此刻无从确认（没答话=拿不到 pid）：卡片两副面孔
            // 一律回到未验证；记录本身留着，同一个进程重新答话时结论还能归属回去。
            daemonReportedStatuses = [:]
        }
        rebuildEntries()
    }

    /// 显式刷新失败时给用户的红字（nil = 这次读到了）。文案只说测到了什么、
    /// 下一步点哪个控件，不写规格编号也不解释实现。
    nonisolated private static func daemonUnreachableText(
        _ measurement: DaemonMeasurement,
        socketPath: String
    ) -> String? {
        switch measurement {
        case .notMeasured, .answered:
            return nil
        case .silent(let socketPresent):
            return socketPresent
                ? "读不到后台服务的状态：\(socketPath) 的 socket 文件在，但它没有回应（可能已被其他客户端占满，或已停止响应）。点「重启后台服务」重新拉起它。"
                : "读不到后台服务的状态：\(socketPath) 上没有服务在监听。点「重启后台服务」让 launchd 重新拉起它。"
        }
    }

    /// 由 daemon 自报席位 + 重探结果重算卡片状态与注记。这里算出来的 `status`
    /// 是每张卡的**唯一**状态来源：可见徽标与机器可读标识（`gp-perm-<kind>-<status>`）
    /// 都读它，两面不允许各取一次值。
    private func rebuildEntries() {
        let reported = daemonReportedStatuses
        let restartKinds = Set(kindsNeedingRestart)
        for index in entries.indices {
            let kind = entries[index].kind
            if kind == .developerTools {
                // 系统没有查询接口 ≠ 不能实测：有当前有效的实测结论就按结论显示
                // （granted/denied/unverifiable），没有就回到"未验证"。
                entries[index].status = liveDeveloperToolsReport?.status ?? .unverifiable
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
