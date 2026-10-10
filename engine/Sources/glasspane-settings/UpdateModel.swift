import Foundation
import GlassPaneEngine

/// 「更新」页的数据模型：面板与后台服务之间的**唯一一条命令通道**。
///
/// 职责边界（与 `SettingsModel` 的"面板不代测"同一口径）：
///  - 只发 `node <更新器> <子命令> --json`，只读它回的那一行 JSON；
///  - 每一次起子进程都带上这台机器导出的系统根证书束（`NODE_EXTRA_CA_CERTS`），
///    束不在盘上或空着就不带这个键——node 只在启动那一刻读它，只有这里能给；
///  - 不下载、不校验、不换版、**不重启后台服务**——换版后的重启由更新器在
///    它自己确认后台服务空闲之后做，面板抢着重启会打断用户眼前正在跑的动作；
///  - 读不到就说读不到：指针缺失、指针指向的脚本没了、node 没了、
///    那一行解析不出来、子进程没按时回话，各有一种说法，绝不显示成功。
///
/// 状态判定与按钮开关全在 `UpdatePanel`（纯函数），本类只做编排与缓存。
@MainActor
final class UpdateModel: ObservableObject {

    /// 面板要跑的更新器子命令。契约里只有这五条：面板不重启后台服务，
    /// 也不自己实现下载或换版（那两条分别是 `apply` 与 `check` 的事）。
    enum Command: String, CaseIterable {
        case status
        case check
        case apply
        case enable
        case disable
    }

    @Published private(set) var snapshot: UpdatePanel.Snapshot?
    /// 最近一次"没能读到结论"的原因（与 snapshot 并存：旧结论仍然显示，
    /// 但页面上必须有这一句，不然用户以为刚那次点击白点了）。
    @Published private(set) var readFailure: UpdatePanel.ReadFailure?
    @Published private(set) var pointer: UpdatePanel.PointerRead = .failed(.missingPointer)
    @Published private(set) var isRunning = false
    @Published private(set) var runningCommand: Command?
    /// 时钟可注入：过期判定的"现在"由它给，测试据此造 37 小时前的状态。
    private let clock: () -> Date
    private let stateRootPath: String
    /// node 程序位置；nil 表示每次按 `UpdatePanel.nodeCandidates` 现找。
    private let injectedNodePath: String?
    /// 起子进程时那份环境的底子。可注入是为了让测试能把"这台机器本来就带着
    /// NODE_EXTRA_CA_CERTS"这一种情况摆出来；不注入时就是面板自己的那一份。
    private let baseEnvironment: [String: String]
    /// 在途标记：`isRunning` 是发布给 UI 的副本，这个是判据本身。
    private var inFlight = false

    init(
        stateRoot: String = UpdatePanel.stateRoot(),
        nodePath: String? = nil,
        clock: @escaping () -> Date = Date.init,
        baseEnvironment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.stateRootPath = stateRoot
        self.injectedNodePath = nodePath
        self.clock = clock
        self.baseEnvironment = baseEnvironment
    }

    // MARK: - 派生呈现

    var now: Date { clock() }

    var stateRoot: String { stateRootPath }

    var pointerFile: String { UpdatePanel.pointerFile(stateRoot: stateRootPath) }

    /// 这台机器给 node 的那份根证书束在哪：状态根下那一个，路径只有一个作者。
    var caBundleFile: String { UpdatePanel.caBundleFile(stateRoot: stateRootPath) }

    /// 「更新」区里那句关于根证书束的话（每一态各有一句，缺失也有一句）。
    var caRootsText: String { UpdatePanel.caRootsText(snapshot) }

    /// 这一项是否真的备好了——只有记录写着 `ok` 才算，其余都算没备好。
    var caRootsIsUsable: Bool { UpdatePanel.caRootsIsUsable(snapshot) }

    /// 「更新器自身」那一句人话：每一态各有一句，从没记录过也有一句。
    var runtimeText: String { UpdatePanel.runtimeText(snapshot) }

    /// 更新器自己那份副本是否真的换上了——只有 `refreshed` 且在册任务核对过才算。
    var runtimeIsUsable: Bool { UpdatePanel.runtimeIsUsable(snapshot) }

    /// 这一项要多少注意力（配色之外的形状由状态点自己表达）。
    var runtimeAttention: UpdatePanel.RuntimeAttention { UpdatePanel.runtimeAttention(snapshot) }

    /// 记录里那份真实的更新器脚本路径；没有就返回 nil，页面上不出现猜出来的路径。
    var runtimeCliPath: String? { snapshot?.runtime?.cliPath.flatMap { $0.isEmpty ? nil : $0 } }

    /// 面板显示用的状态（含 36 小时过期加成）。
    var status: UpdatePanel.Status? { UpdatePanel.effectiveStatus(snapshot, now: now) }

    /// 自动更新开关的显示值：读不到状态时为 nil（不猜默认值）。
    var autoUpdateOn: Bool? { UpdatePanel.autoUpdateOn(snapshot) }

    /// 两个按钮与开关的可用性，连同不可用的理由。
    var buttons: UpdatePanel.Buttons {
        UpdatePanel.buttons(for: makeButtonContext())
    }

    /// 页面顶部那句"该做什么"。
    var promptText: String? { UpdatePanel.promptText(snapshot: snapshot, status: status, now: now) }

    /// 逐字显示的失败原话（`lastError.message` 优先）。
    var errorText: String? { UpdatePanel.errorText(snapshot: snapshot) }

    /// 上一次检查的时间。
    var lastCheckText: String { UpdatePanel.lastCheckText(snapshot, now: now) }

    /// 有版本等着装时侧栏才给标记（不为"已是最新"造一个噪点的角标）。
    var offersUpdate: Bool {
        switch status {
        case .available, .staged, .needsConsent, .checkOverdue,
             .deferred, .rolledBack, .checkFailed, .applyFailed, .rollbackFailed:
            return snapshot?.stagedVersion != nil || status == .available || status == .needsConsent
        default:
            return false
        }
    }

    private func makeButtonContext() -> UpdatePanel.ButtonContext {
        UpdatePanel.ButtonContext(
            status: status,
            hasStagedOffer: snapshot?.stagedVersion != nil,
            exitCode: snapshot?.exitCode,
            current: snapshot?.current,
            stagedVersion: snapshot?.stagedVersion,
            code: snapshot?.code ?? snapshot?.lastErrorCode,
            isRunning: inFlight,
            pointerReady: pointer.isReady,
            updaterPath: pointer.cliPath,
            now: now
        )
    }

    // MARK: - 动作

    /// 读一次已记录的状态（不联网，所以进页与刷新都用它）。
    func refresh() {
        perform(.status, extraArguments: [], timeoutSeconds: 20)
    }

    /// 问一次源：拉最新版本、跑七道校验、通过就暂存。
    func checkNow() {
        perform(.check, extraArguments: [], timeoutSeconds: 240)
    }

    /// 带着"这个人已经认下这个发布"的确认再问一次源。
    ///
    /// 作者身份缺口（发布未签名 / 这台机器验不了签名）下，检查在下载之前就停了，
    /// 盘上没有任何可暂存的东西——所以那一枚按钮要发的不是 `apply` 而是这一条。
    /// 确认只跟着这一次点击，不写进任何默认值：定时任务永远不带它。
    func consentedCheck() {
        perform(.check, extraArguments: buttons.consentArguments, timeoutSeconds: 240)
    }

    /// 装那份已校验的暂存版本（换版与重启由更新器在空闲窗口里自己做）。
    func applyUpdate() {
        perform(.apply, extraArguments: buttons.applyArguments, timeoutSeconds: 2_400)
    }

    /// 「自动更新」开关：等价于更新器的 enable / disable。
    func setAutoUpdate(_ on: Bool) {
        perform(on ? .enable : .disable, extraArguments: [], timeoutSeconds: 60)
    }

    /// 发一条命令。同一时刻只允许一条在飞——按钮的禁用状态是它的结果，
    /// 但这里再设一道闸，防止键盘回车绕过灰掉的按钮。
    private func perform(_ command: Command, extraArguments: [String], timeoutSeconds: TimeInterval) {
        guard !inFlight else { return }
        let resolution = resolveRunner()
        guard case .ready(let node, let cli) = resolution else {
            applyResolution(resolution)
            return
        }
        inFlight = true
        isRunning = true
        runningCommand = command
        readFailure = nil
        let arguments = [cli] + Self.arguments(for: command, stateRoot: stateRootPath, extra: extraArguments)
        // 束的路径现在就定下来，读盘与拼环境放到后台那一趟去做：
        // 那是一次整文件的读，不该占住主线程（这一页曾被主线程等子进程搞到整窗冻结）。
        let bundlePath = caBundleFile
        let base = baseEnvironment
        Task.detached(priority: .userInitiated) {
            let environment = UpdatePanel.caBundleEnvironment(
                base: base,
                bundle: UpdatePanel.inspectCaBundle(at: bundlePath)
            )
            let outcome = UpdateModel.runUpdater(
                node: node, arguments: arguments, environment: environment, timeoutSeconds: timeoutSeconds
            )
            await MainActor.run {
                self.inFlight = false
                self.isRunning = false
                self.runningCommand = nil
                self.absorb(outcome: outcome, command: command)
            }
        }
    }

    /// 一条命令的完整参数（纯函数，便于逐条验红）：
    /// `<子命令> --state-dir <状态根> --json [确认参数…]`。状态根显式传过去，
    /// 面板与更新器不得各自解析出一个根来；`--json` 让 stdout 恰好一行。
    nonisolated static func arguments(
        for command: Command, stateRoot: String, extra: [String] = []
    ) -> [String] {
        [command.rawValue, "--state-dir", stateRoot, "--json"] + extra
    }

    // MARK: - 更新器位置的解析

    enum RunnerResolution: Equatable {
        case ready(node: String, cli: String)
        case pointerFailed(UpdatePanel.ReadFailure)
        case nodeMissing
    }

    /// 每次动作现读一遍指针：用户中途重装完，这一页不用重开就能用。
    private func resolveRunner() -> RunnerResolution {
        let text = try? String(contentsOfFile: pointerFile, encoding: .utf8)
        let read = UpdatePanel.readPointer(json: text) { path in
            FileManager.default.fileExists(atPath: path)
        }
        pointer = read
        guard let cli = read.cliPath else {
            return .pointerFailed(read.failure ?? .unreadablePointer)
        }
        let exists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
        guard let node = injectedNodePath ?? UpdatePanel.resolveNode(candidates: UpdatePanel.nodeCandidates(), exists: exists) else {
            return .nodeMissing
        }
        return .ready(node: node, cli: cli)
    }

    private func applyResolution(_ resolution: RunnerResolution) {
        switch resolution {
        case .ready:
            break
        case .pointerFailed(let failure):
            readFailure = failure
        case .nodeMissing:
            readFailure = .nodeMissing
        }
    }

    // MARK: - 结果吸收

    /// 子进程的结局。**非 0 退出也照样把那一行读进来**：拒绝本身就是结论
    /// （含"为什么不给你装"的原话），按退出码把输出丢掉面板就只剩一句空话。
    private func absorb(outcome: RunOutcome, command: Command) {
        switch outcome {
        case .launchFailed:
            readFailure = .launchFailed
        case .timedOut:
            readFailure = .timedOut
        case .completed(let stdout, let exitCode):
            switch UpdatePanel.parseLine(stdout) {
            case .success(var parsed):
                // 进程退出码是比那一行里写着的数字更硬的证据，以它为准。
                parsed.exitCode = Int(exitCode)
                parsed.command = parsed.command ?? command.rawValue
                snapshot = parsed
                readFailure = nil
            case .failure(let failure):
                // 解析不出来：保留上一次的结论，但这一轮的失败必须摆在脸上。
                readFailure = failure
            }
        }
    }

    // MARK: - 子进程

    enum RunOutcome: Equatable {
        case completed(stdout: String, exitCode: Int32)
        case timedOut
        case launchFailed
    }

    /// 跑一次更新器：stdout 收成一行交回去，stderr 直接丢弃（人类文案与
    /// 日志按契约走 stderr，面板要的原话在那一行里），超时则终止子进程。
    ///
    /// `environment` 是子进程那份**完整**环境（不是增量）：`NODE_EXTRA_CA_CERTS`
    /// 只能在这里进去——node 只在进程启动那一刻读它，面板起完了再设改不了已经跑起来的那一个。
    /// 束不在或空着时这一份里就没有这个键（不设与设成空串是两件事，见 `caBundleEnvironment`）。
    ///
    /// `nonisolated static`：分钟级的换版不能占住主线程——面板曾经在主线程
    /// 等子进程，症状是整窗冻结后被系统看门狗杀掉。
    nonisolated static func runUpdater(
        node: String,
        arguments: [String],
        environment: [String: String] = ProcessInfo.processInfo.environment,
        timeoutSeconds: TimeInterval
    ) -> RunOutcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = arguments
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        // 更新器的 stderr 可能很啰嗦（每一道校验一行），从不读它就等着管道塞满，
        // 所以直接接到 /dev/null：契约里那一行在 stdout，退出码在进程上。
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return .launchFailed
        }
        let reader = DispatchQueue(label: "glasspane.update.cli-reader")
        let box = SendableBox<Data>(Data())
        let group = DispatchGroup()
        group.enter()
        reader.async {
            box.value = pipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        if group.wait(timeout: .now() + timeoutSeconds) == .timedOut {
            process.terminate()
            return .timedOut
        }
        process.waitUntilExit()
        let text = String(data: box.value, encoding: .utf8) ?? ""
        return .completed(stdout: text, exitCode: process.terminationStatus)
    }
}

/// 跨队列取回管道读取结果的最小容器（与 `ConsoleModel` 同形）。
private final class SendableBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ initial: Value) { stored = initial }

    var value: Value {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            stored = newValue
            lock.unlock()
        }
    }
}
