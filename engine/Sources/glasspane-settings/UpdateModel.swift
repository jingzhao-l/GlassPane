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
    /// 这一页读写的状态根。**不可以在 init 里定死**：见 `adoptDaemonReport`。
    private var stateRootPath: String
    /// 这一页认的根是**谁**认定的，与 `ConsoleModel.StateRootSource` 同一套三态三句话：
    /// 「daemon 报的」不许由「面板算的」冒充，反过来说也一样。
    enum StateRootSource: Equatable {
        /// 最近一帧 hello 里 daemon 自己报的。
        case daemonReported
        /// daemon 报过，之后的帧没再报（老 daemon 没带这个键）：路径留着，出处如实降级。
        case daemonReportedEarlier
        /// daemon 从没报过，这是面板按 `GLASSPANE_STATE_DIR`/家目录算的。
        case panelComputed
    }
    @Published private(set) var stateRootSource: StateRootSource = .panelComputed
    /// 后台服务这一帧自报、而这一侧**拒收**的状态根（nil = 从没拒过）。与
    /// `ConsoleModel.refusedDaemonStateRoot` 同一道闸的另一半：两条腿各自采纳同一个值时，
    /// 只装一处就是半修（`ConsoleModel.swift:148-152` 记过这个形状）。
    @Published private(set) var refusedDaemonStateRoot: String?
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

    // MARK: - 跟着 daemon 报的根走

    /// 把 hello 实测到的状态根接到这一页上（`ConsoleModel.adoptDaemonReport` 的同一步，
    /// 从前只给了它自己那一页）。
    ///
    /// 缺陷形状：`stateRootPath` 从前是 init 时由 `GLASSPANE_STATE_DIR`→家目录定死的
    /// `let`，而 `ConsoleRootView.syncFromSettings` 只把 `console` 接到 `hello.stateRoot`
    /// 上。于是 daemon 带着 `--state-dir X` 起时，同一个窗口并排显示两个"状态根"而没人
    /// 说得出谁是谁，而「自动更新」的开关与检查会把 `update-install.json`、`ca-roots.pem`
    /// 写到**默认家目录那一份真状态**里——操作者以为自己在看沙箱。
    /// `ConsoleModel` 那份注释（:148-152）把这个形状记成它修掉的 P1，却只修了自己一页，
    /// 那正是半修的definition。
    ///
    /// 口径与那一页一致：只有真空白算"这一帧没报"；报过又不报了，路径留着、出处降级，
    /// 不许继续冒充"这一帧报的"。换根之后不自动重跑一次动作：`resolveRunner()` 每次
    /// 动作现读指针，进这一页时也会 `refresh()` 一次，所以旧根的结论不会跟着搬过来。
    func adoptDaemonReport(daemonStateRoot: String?, answered: Bool) {
        // 只有"这一帧真的拿到了 hello 回话"才算一次上报：`presentButSilent` 那一支
        // 手里那个路径是上一次测量的残留，拿它换根就是让旧结论替新现状背书。
        guard answered else {
            if stateRootSource == .daemonReported { stateRootSource = .daemonReportedEarlier }
            return
        }
        let reported = daemonStateRoot?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let reported, !reported.isEmpty {
            // 采纳前先过 `StateRootArgument.rejection(for:)`——与 `ConsoleModel.adoptDaemonReport`
            // 同一道闸、同一个判据函数（TS 侧对同一个值 mirror 的也是这一条：
            // `mcp-shell/src/project-registry.ts` 的 `stateRootRefusal`）。这一页拿这个根去
            // 起更新器（`--state-dir` 那一条）并按它读 `update-install.json` 与 `ca-roots.pem`，
            // 而它是 peer 在 `hello` 里自报的、engine.sock 无 peer 鉴权：少这一句，同用户一帧
            // 回话就能让这一页把更新器指到别处的安装记录上、把根证书束从别处读。
            // 拒收时保留上一个根，出处不升格。
            if let defect = StateRootArgument.rejection(for: reported) {
                refusedDaemonStateRoot = reported
                FileHandle.standardError.write(
                    Data("glasspane-settings: update page refused self-reported state root \(reported) (\(defect))\n".utf8)
                )
            } else {
                refusedDaemonStateRoot = nil
                let next = StateRoot(path: reported).path
                if next != stateRootPath {
                    stateRootPath = next
                    // 根换了，这一页手里那份"更新器位置"与结论都来自**另一个安装**：
                    // 留着它们就等于让旧根的数字在新根的名字下说话。
                    snapshot = nil
                    pointer = .failed(.missingPointer)
                    readFailure = nil
                }
                stateRootSource = .daemonReported
            }
        } else if stateRootSource == .daemonReported {
            stateRootSource = .daemonReportedEarlier
        }
    }

    /// 那一拒的原话。**措辞与 `ConsoleModel.refusedDaemonStateRootCaption` 同源**
    /// （同一种事在两扇门上不许讲成两个故事），只有"这一页拿根去做什么"那半句按本页改写：
    /// 这一页不起 `--project-remove`，它起更新器、并按这个根读那份根证书束。
    var refusedDaemonStateRootCaption: String {
        guard let refused = refusedDaemonStateRoot else { return "" }
        let reason = StateRootArgument.rejection(for: refused) ?? "它不是这套安装自己拥有的专用目录"
        return "后台服务自报的状态根不能被这个面板采用：\(reason)。"
            + "这一页仍按上一个根 \(stateRoot) 起更新器与读那份根证书束，没有按它创建或收紧过任何目录。"
            + "下一步：让后台服务带着属于这套安装的 `--state-dir <专用目录>` 重启，然后点侧栏底部的「刷新」重连。"
    }

    /// 状态根那一行唯一的一句话：路径 + 它是谁认定的 +（有拒绝时）那一拒的原话。
    var stateRootCaption: String {
        let origin: String
        switch stateRootSource {
        case .daemonReported: origin = "后台服务这一帧上报的"
        case .daemonReportedEarlier: origin = "后台服务早前上报的（这一帧没再报）"
        case .panelComputed: origin = "面板自己算的（后台服务从没报过它实际在用的根）"
        }
        var text = "\(origin)状态根 \(stateRoot)——本页的更新器指针与根证书束都按它读"
        let refusal = refusedDaemonStateRootCaption
        if let refused = refusedDaemonStateRoot, !refusal.isEmpty {
            // 那一拒要说给屏幕上看，并且**点名被拒的那一个值**：只写进 stderr 等于没说——
            // 读的人看到的是"这一页按的就是服务报的那个根"，而事实是它被拒了、用的仍是上一个。
            text += "；后台服务这一帧报的根 \(refused) 被这一侧拒了，本行说的仍是上一个被采纳的根。" + refusal
        }
        return text
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
            stateRoot: stateRootPath,
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
