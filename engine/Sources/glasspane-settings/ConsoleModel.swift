import Foundation
import GlassPaneEngine

/// 跨队列传递读取结果的最小容器（后台读管道，主线程取结果）。
private final class MutexBox<Value>: @unchecked Sendable {
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

/// 控制台数据模型：把本机已落盘的审计档案（evidence / 项目 / 审批台账）读进
/// 面板状态。与 `SettingsModel` 并列，各自持有自己的发布状态，互不冒充。
///
/// 三条硬约束：
///  1. **只读**。面板不写 projects.json，也不改证据目录；所有写入都走 daemon
///     的一次性 CLI（`--project-prune` / `--project-remove`），因为运行中的
///     daemon 内存里持有一份注册表，面板直接覆写会被它下一次写盘冲掉。
///  2. **不阻塞主线程**。扫描 500+ 档案与跑 CLI 都在后台队列，主线程只收结果。
///  3. **读不到就说读不到**。目录缺失、文件解不开、CLI 失败各自有独立状态，
///     绝不折算成"没有档案"或"一切正常"。
@MainActor
final class ConsoleModel: ObservableObject {

    // MARK: - evidence

    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    /// 档案列表那一页的读取结局。`empty`（读过了，一条档案也没有）与 `failed`
    /// （读不了）必须分开：把"读不了"写成"目录是空的"，用户就对着一个坏掉的
    /// 档案库以为自己已经看完了所有记录。
    enum EvidenceState: Equatable {
        case idle
        case loading
        /// 读到了至少一条摘要（列表按 `filteredSummaries` 渲染）。
        case loaded
        /// 读过了，目录里没有档案（目录不在、或目录在但是空的）。
        case empty
        case failed(String)
    }

    /// 一次档案目录扫描的结局（面板侧形态）。
    ///
    /// `listFailure` 与 daemon `--evidence-stats` 回的那个键、以及引擎侧
    /// `EvidenceArchiveScan.listFailure` **同名同义**：目录存在却列不出来，原因在这里；
    /// nil 表示列举**真的完成了**，于是 `summaries.isEmpty` 才说得出"里面没有档案"。
    /// 缺这一路时（旧扫描结果 / 只读到零）这一页不许把"没看过"折算成"那里没有"，
    /// 判据见 `foldEvidenceState(outcome:listFailure:)`。
    struct EvidenceScanOutcome: Equatable {
        var summaries: [EvidenceSummary] = []
        var unreadableFiles: [String] = []
        var directoryExists = false
        var totalBytes = 0
        var listFailure: String? = nil
    }

    /// 选中那条档案的读取结局：`failed` 与"还在读"必须分得开。从前这里只有
    /// `selectedPack: EvidencePack?`，读不开与没读完是同一个 nil，详情页于是
    /// 永远停在那句"正在读取这条档案……"上——一个不会再出答案的转圈。
    enum PackLoad: Equatable {
        case none
        case loading
        case loaded(EvidencePack)
        case failed(reason: String)
    }

    /// daemon `--evidence-stats` 的结局。
    enum DaemonStats: Equatable {
        /// 还没问过后台服务（连它的程序路径都还没实测到）：这一栏不能提前
        /// 说"不可达"——那是对一次没发生过的请求下结论。
        case notAsked
        case asking
        case loaded(count: Int?, totalBytes: Int?, listFailure: String?, dir: String?)
        case unreachable

        /// 只有"真的拿到了一份有形状的回话"算数；其余三种都没读出后台服务的想法。
        var isLoaded: Bool {
            if case .loaded = self { return true }
            return false
        }
    }

    @Published var evidenceState: EvidenceState = .idle
    @Published private(set) var summaries: [EvidenceSummary] = []
    @Published private(set) var unreadableFiles: [String] = []
    @Published private(set) var archiveExists = false
    @Published private(set) var archiveTotalBytes = 0
    @Published var filter: EvidenceFilter = .all
    @Published var searchText = ""
    @Published var selectedOperationId: String?
    /// 选中项的读取结局（详情页按需读盘，列表只用摘要）。
    @Published private(set) var packLoad: PackLoad = .none
    /// daemon 侧的档案目录统计（`--evidence-stats`）；来源与本地扫描分开标注。
    @Published private(set) var daemonStats: DaemonStats = .notAsked

    // MARK: - projects

    @Published var projectsState: LoadState = .idle
    @Published private(set) var projects: [ProjectEntry] = []
    /// projectId → 该项目证据目录里的档案条数（nil = 目录不存在）。
    @Published private(set) var projectEvidenceCounts: [String: Int?] = [:]
    @Published var selectedProjectId: String?
    /// 待确认的清理清单（dry-run 结果 → 确认表 → 真删）。
    @Published var prunePreview: [ProjectEntry] = []
    @Published var isPruneSheetPresented = false
    @Published var isRunningPrune = false
    /// 修剪后是否需要重启后台服务（daemon 内存里还是旧表）。
    @Published var pruneNeedsRestart = false
    @Published var lastActionMessage: String?

    // MARK: - approvals

    @Published var approvalsState: LoadState = .idle
    @Published private(set) var approvalReport: ApprovalLedgerReport?

    /// daemon 可执行文件路径：由面板在 hello 拿到 daemon 身份后回填。
    /// 没有它，清理/删除这类写入动作就没有可执行入口。
    @Published var daemonBinaryPath: String?
    private let evidenceDirectory: String
    private let projectsPath: String
    private let approvalsPath: String
    /// 档案目录扫描的注入点：默认走本机 `LocalArchive.scanEvidence`。测试用它
    /// 造出"目录读不了"与"目录在但确实空的"两种不同结局——这两种在真机上
    /// 长得一模一样（都是一份空列表），不注入就永远只测得到其中一种。
    private let evidenceScanner: (String) -> EvidenceScanOutcome
    /// 单条档案读取的注入点：nil = 读不出内容（文件不在，或那段 JSON 解不开）。
    private let packReader: (String) -> EvidencePack?
    /// 最近一次落地的扫描结局（`evidenceState` 由它 + daemon 报的读不了原因一起折算）。
    private var lastScan: EvidenceScanOutcome?
    private var daemonStatsInFlight = false

    init(
        daemonBinaryPath: String? = nil,
        evidenceDirectory: String = EvidenceStore.defaultDirectory,
        projectsPath: String = ProjectRegistry.defaultProjectsPath,
        approvalsPath: String = ApprovalGate.defaultPath,
        evidenceScanner: ((String) -> EvidenceScanOutcome)? = nil,
        packReader: ((String) -> EvidencePack?)? = nil
    ) {
        self.daemonBinaryPath = daemonBinaryPath
        self.evidenceDirectory = evidenceDirectory
        self.projectsPath = projectsPath
        self.approvalsPath = approvalsPath
        self.evidenceScanner = evidenceScanner ?? { ConsoleModel.scanArchiveDirectory($0) }
        self.packReader = packReader ?? { ConsoleModel.readPackFile(at: $0) }
    }

    /// daemon 二进制路径是否已知——决定"清理/删除"这类写入动作可用与否。
    var canRunDaemonCLI: Bool { daemonBinaryPath != nil }

    /// 把一次 hello 的实测结局接到控制台数据上。
    ///
    /// 从前这里只在 `daemonBinaryPath == nil` 时赋值一次，于是重装/重开之后
    /// `.onChange` 再也更新不动它——清理/删除/校验/统计一直在 exec 那份已经退役的
    /// 二进制，而页面上写的是新那一份。现在**每帧自报了就跟着换**（nil = 这一帧
    /// 没自报，保持现状，因为"没读到路径"不等于"路径没了"）。
    /// - Parameter answered: 这一帧是不是真的拿到了 hello 回话。"注册表改动要重启
    ///   后台服务才生效"那句话只能在服务重新应门之后撤，点一下按钮不算重启成功。
    func adoptDaemonReport(binaryPath: String?, answered: Bool) {
        // 只有真空白算"这一帧没自报"；空白串也不能当路径——后面四条动作都要拿它去 exec。
        let reported = binaryPath?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let reported, !reported.isEmpty, reported != daemonBinaryPath {
            daemonBinaryPath = reported
            // 换的是"该问哪一个进程"，那一栏的旧结论（或从没结论）要跟着重测。
            refreshDaemonStats()
        }
        if answered {
            pruneNeedsRestart = false
        }
    }

    // MARK: - 刷新

    /// 刷新全部档案读数（面板打开、切页、点刷新时调用）。
    ///
    /// daemon 统计也在这一条里：它此前只由那一小张卡的 `.onAppear` 触发一次，
    /// 而那次触发时 hello 还没落地、程序路径还是 nil，卡就永远停在
    /// "后台服务不可达或超时"，页面上的「刷新」也再没碰过它。
    func refreshAll() {
        reloadEvidence()
        reloadProjects()
        reloadApprovals()
        refreshDaemonStats()
    }

    func reloadEvidence() {
        evidenceState = .loading
        let directory = evidenceDirectory
        let scanner = evidenceScanner
        Task.detached(priority: .userInitiated) {
            let outcome = scanner(directory)
            await MainActor.run {
                self.lastScan = outcome
                self.summaries = outcome.summaries
                self.unreadableFiles = outcome.unreadableFiles
                self.archiveExists = outcome.directoryExists
                self.archiveTotalBytes = outcome.totalBytes
                self.applyEvidenceState()
                if self.selectedOperationId == nil {
                    self.selectedOperationId = outcome.summaries.first?.operationId
                }
                self.loadSelectedPackIfNeeded()
            }
        }
    }

    func reloadProjects() {
        projectsState = .loading
        let path = projectsPath
        let fallback = evidenceDirectory
        Task.detached(priority: .userInitiated) {
            let registry = ProjectRegistry(filePath: path)
            let entries = registry.all
            var counts: [String: Int?] = [:]
            for entry in entries {
                counts[entry.projectId] = LocalArchive.evidenceCount(
                    at: entry.evidenceStoragePath, fallback: fallback
                )
            }
            let damaged = registry.loadFailed
            await MainActor.run {
                self.projects = entries
                self.projectEvidenceCounts = counts
                self.projectsState = damaged ? .failed("注册表文件读不开，面板只呈现能读到的部分") : .loaded
                if self.selectedProjectId == nil {
                    self.selectedProjectId = entries.first?.projectId
                }
            }
        }
    }

    func reloadApprovals() {
        approvalsState = .loading
        let path = approvalsPath
        Task.detached(priority: .userInitiated) {
            let report = LocalArchive.readApprovalLedger(path: path)
            await MainActor.run {
                self.approvalReport = report
                self.approvalsState = .loaded
            }
        }
    }

    // MARK: - 档案列表状态折算

    /// 由一次扫描结局 + 后台服务报的"读不了原因"折算列表页状态。
    ///
    /// 顺序上的唯一要点：**读不了的原因优先于那个零**。目录读不出条目时扫出来
    /// 也是"零条"，把它写成"档案目录是空的"就是对着一个坏掉的档案库报平安。
    static func foldEvidenceState(
        outcome: EvidenceScanOutcome, listFailure: String?
    ) -> EvidenceState {
        if let listFailure, !listFailure.isEmpty {
            return .failed("后台服务读不了档案目录，所以这一页没有任何条数可报。原话：\(listFailure)")
        }
        if !outcome.directoryExists {
            return .empty
        }
        if outcome.summaries.isEmpty {
            // 目录在、条目一个都读不出来：这不是"空档案"，是"读不动的档案"。
            if outcome.unreadableFiles.isEmpty { return .empty }
            return .failed(
                "档案目录里有 \(outcome.unreadableFiles.count) 个文件，但一个都读不出内容，"
                    + "所以这一页既没有条数也没有列表。"
            )
        }
        return .loaded
    }

    /// 后台服务在 `--evidence-stats` 里报的那个读不了原因（没问过 / 没报 = nil）。
    private var daemonListFailure: String? {
        if case .loaded(_, _, let failure, _) = daemonStats { return failure }
        return nil
    }

    /// 重算列表页状态：扫描结局与 daemon 统计哪一侧先到都得到现在的答案。
    private func applyEvidenceState() {
        guard let outcome = lastScan else { return }
        evidenceState = Self.foldEvidenceState(outcome: outcome, listFailure: daemonListFailure)
    }

    // MARK: - daemon 侧的档案统计（--evidence-stats）

    /// 向后台服务要一次档案目录统计。路径还没实测到时**不发**那次请求，
    /// 也不把"没发过"写成"发了但不可达"。
    func refreshDaemonStats() {
        guard let binary = daemonBinaryPath else {
            daemonStats = .notAsked
            applyEvidenceState()
            return
        }
        guard !daemonStatsInFlight else { return }
        daemonStatsInFlight = true
        daemonStats = .asking
        Task.detached(priority: .userInitiated) {
            let run = ConsoleModel.runDaemonCLI(binary: binary, arguments: ["--evidence-stats"])
            let result = ConsoleModel.foldDaemonStats(fromCLIReply: run)
            await MainActor.run {
                self.daemonStatsInFlight = false
                self.daemonStats = result
                self.applyEvidenceState()
            }
        }
    }

    /// CLI 的三种结局：没跑起来 / 输出不是约定的 JSON 形状 → `unreachable`。
    nonisolated static func foldDaemonStats(
        fromCLIReply run: (output: String, errorOutput: String, status: Int32)?
    ) -> DaemonStats {
        guard let run else { return .unreachable }
        for candidate in [run.output, run.errorOutput] {
            if let stats = parseDaemonStats(candidate), stats.isLoaded { return stats }
        }
        return .unreachable
    }

    /// 解析 `--evidence-stats` 的 JSON。字段名以 daemon 的实现为准，严禁猜；
    /// `listFailure` 这个键**允许整个不存在**（旧 daemon 不回它），缺键读成 nil
    /// 而不是读成"没有失败"。认不出形状时返回 nil，由上游报"不可达"。
    nonisolated static func parseDaemonStats(_ text: String) -> DaemonStats? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              !object.isEmpty else {
            return nil
        }
        guard object.keys.contains("count") || object.keys.contains("listFailure") else {
            return nil
        }
        return .loaded(
            count: object["count"] as? Int,
            totalBytes: object["totalBytes"] as? Int,
            listFailure: object["listFailure"] as? String,
            dir: object["dir"] as? String
        )
    }

    // MARK: - 本地扫描与单条读取的默认实现

    nonisolated private static func scanArchiveDirectory(_ directory: String) -> EvidenceScanOutcome {
        let scan = LocalArchive.scanEvidence(directory: directory)
        return EvidenceScanOutcome(
            summaries: scan.summaries,
            unreadableFiles: scan.unreadableFiles,
            directoryExists: scan.directoryExists,
            totalBytes: scan.totalBytes,
            // 列不出来是一次失败，不是"里面没有档案"：这一路的 `listFailure` 与
            // daemon `--evidence-stats` 那个同名键同义，缺键读成 nil（= 列举真的完成了）。
            listFailure: scan.listFailure
        )
    }

    nonisolated private static func readPackFile(at path: String) -> EvidencePack? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(EvidencePack.self, from: data)
    }

    // MARK: - evidence 选择与过滤

    /// 当前过滤器 + 搜索词下的列表（搜索匹配 operationId 与控件标题）。
    var filteredSummaries: [EvidenceSummary] {
        let needle = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        return summaries.filter { summary in
            guard filter.matches(summary) else { return false }
            guard !needle.isEmpty else { return true }
            if summary.operationId.lowercased().contains(needle) { return true }
            if let title = summary.selectorTitle, title.lowercased().contains(needle) { return true }
            return summary.action.lowercased().contains(needle)
        }
    }

    func select(operationId: String?) {
        guard selectedOperationId != operationId else { return }
        selectedOperationId = operationId
        loadSelectedPackIfNeeded()
    }

    /// 详情页那个「重试」按钮：对同一条档案再读一次（路径与选中项都不变）。
    func reloadSelectedPack() {
        loadSelectedPackIfNeeded()
    }

    /// 选中项的整包（nil = 还没读到 / 读不出，两种由 `packLoad` 分开说）。
    var selectedPack: EvidencePack? {
        if case .loaded(let pack) = packLoad { return pack }
        return nil
    }

    private func loadSelectedPackIfNeeded() {
        guard let operationId = selectedOperationId,
              let summary = summaries.first(where: { $0.operationId == operationId }) else {
            packLoad = .none
            return
        }
        let path = summary.filePath
        let reader = packReader
        packLoad = .loading
        Task.detached(priority: .userInitiated) {
            let pack = reader(path)
            await MainActor.run {
                // 读回来时用户可能已经翻到别的记录：那一帧的结论不再属于这一条。
                guard self.selectedOperationId == operationId else { return }
                self.packLoad = pack.map { .loaded($0) } ?? .failed(reason: Self.packReadFailureText(path: path))
            }
        }
    }

    /// 一句"这条读不出"的人话：说清读不出的是哪一条，并给出这一屏做得动的那一步。
    nonisolated static func packReadFailureText(path: String) -> String {
        "这条档案读不出内容：文件已经不在了，或者里面那段 JSON 不是这一版面板认得的档案。"
            + "可以再点一次「重试」；列表里那条记录的时间与结论仍然有效，缺的是这份完整信号链。"
            + "路径：\(path)"
    }

    /// 选中项在列表里的位置（详情页上下翻页用）。
    var selectedIndex: Int? {
        guard let operationId = selectedOperationId else { return nil }
        return filteredSummaries.firstIndex { $0.operationId == operationId }
    }

    // MARK: - 写入动作（一律经 daemon CLI）

    /// 先跑 dry-run，把"将要删除哪些"摊开给人确认，绝不直接删。
    func previewTestResiduePrune() {
        guard canRunDaemonCLI else {
            lastActionMessage = "还没连上后台服务：读不到它的程序路径，清理动作无法执行。点「刷新」恢复后重试。"
            return
        }
        prunePreview = projects.filter { LocalArchive.isTestResidue($0) }
        isPruneSheetPresented = true
    }

    /// 确认清理：真正执行 `--project-prune`，随后如实告知是否需要重启。
    /// CLI 在后台队列跑——面板曾经把一次性任务放在主线程等，结果是
    /// "点了没反应"直到系统看门狗把窗口杀掉。
    func confirmPrune() {
        guard !isRunningPrune else { return }
        isRunningPrune = true
        isPruneSheetPresented = false
        let binary = daemonBinaryPath
        Task.detached(priority: .userInitiated) {
            let run = ConsoleModel.runDaemonCLI(binary: binary, arguments: ["--project-prune"])
            await MainActor.run {
                self.isRunningPrune = false
                self.pruneNeedsRestart = Self.boolField(
                    "requiresDaemonRestart", in: Self.cliReply(run)
                ) ?? false
                self.lastActionMessage = Self.pruneActionMessage(
                    cliRan: run != nil,
                    stdout: run?.output ?? "",
                    stderr: run?.errorOutput ?? "",
                    exitCode: run?.status ?? -1
                )
                self.reloadProjects()
            }
        }
    }

    /// 删除单个项目（同样经 daemon CLI，避免与内存态注册表打架）。
    func removeProject(_ projectId: String) {
        guard canRunDaemonCLI else {
            lastActionMessage = "还没连上后台服务：读不到它的程序路径，删除动作无法执行。"
            return
        }
        let binary = daemonBinaryPath
        Task.detached(priority: .userInitiated) {
            let run = ConsoleModel.runDaemonCLI(binary: binary, arguments: ["--project-remove", projectId])
            await MainActor.run {
                let reply = Self.cliReply(run)
                self.pruneNeedsRestart = Self.boolField("requiresDaemonRestart", in: reply) ?? false
                self.lastActionMessage = Self.removeActionMessage(
                    cliRan: run != nil,
                    stdout: run?.output ?? "",
                    stderr: run?.errorOutput ?? "",
                    exitCode: run?.status ?? -1
                )
                if self.selectedProjectId == projectId { self.selectedProjectId = nil }
                self.reloadProjects()
            }
        }
    }

    /// 跑一次 daemon 一次性 CLI，返回它的 stdout、stderr 与退出码；起不来/超时才回 nil。
    ///
    /// **非 0 退出也要把 JSON 交回去**：这些命令的报告体本身就是结论（部分修剪成功
    /// 时 `pruned` 与 `matched` 不同），按退出码把输出丢掉会让面板只剩一句
    /// "没执行成功"，然后对着一份已经改了一半的注册表说"保持原样"——那就是撒谎。
    /// **stderr 同样必须交回去**：这些命令在拒绝执行时（注册表读不开、参数不合规格）
    /// 把整份报告写到 stderr，只看 stdout 的那条结论就会读成空。
    /// 这些命令只读写 `~/.glasspane` 下的普通文件，不涉及 TCC 席位，
    /// 因此以面板进程直接执行即可——不像权限申请必须落在 daemon 自己身上。
    /// `nonisolated static`：调用方一律放后台队列，主线程不等子进程。
    nonisolated static func runDaemonCLI(
        binary: String?,
        arguments: [String],
        timeoutSeconds: TimeInterval = 20
    ) -> (output: String, errorOutput: String, status: Int32)? {
        guard let binary else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = arguments
        let pipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = pipe
        process.standardError = errorPipe
        do {
            try process.run()
        } catch {
            return nil
        }
        // 先读到 EOF 再等退出：反过来时子进程输出超过管道缓冲会互相死等。
        // 但仍要有上限——子进程卡住不能把后台队列永久占住。两路管道各占一条并发
        // 队列：串行读会让"写满第一路才写第二路"的子进程卡死。
        let group = DispatchGroup()
        let outBox = MutexBox<Data>(Data())
        let errBox = MutexBox<Data>(Data())
        let readerQueue = DispatchQueue(label: "glasspane.console.cli-reader")
        let errorQueue = DispatchQueue(label: "glasspane.console.cli-error-reader")
        group.enter()
        readerQueue.async {
            outBox.value = pipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        errorQueue.async {
            errBox.value = errorPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        if group.wait(timeout: .now() + timeoutSeconds) == .timedOut {
            process.terminate()
            return nil
        }
        process.waitUntilExit()
        guard let text = String(data: outBox.value, encoding: .utf8),
              let errorText = String(data: errBox.value, encoding: .utf8) else { return nil }
        return (text, errorText, process.terminationStatus)
    }

    /// 两路输出里"被理解的那一份"：带 JSON 对象形状的优先，stdout 在前
    /// （正常回话就在 stdout），两路都没有形状才退回 stdout 的原文。
    nonisolated static func cliReply(_ run: (output: String, errorOutput: String, status: Int32)?) -> String {
        guard let run else { return "" }
        for candidate in [run.output, run.errorOutput] {
            guard !candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let data = candidate.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  !object.isEmpty else { continue }
            return candidate
        }
        return run.output
    }

    /// prune 的结论。**判据是这一行里到底有没有约定那几个字段**，不是进程有没有
    /// 回来过：daemon 不认这条命令时退出码 64、回的是帮助文本，`matched ?? 0` 会把
    /// 它读成"0 命中"，面板于是当着一屏残留说"没有需要清理的项目"。而字段在 stderr
    /// 时（拒绝路径）也算"有形状"——从前这里只看 stdout，于是"注册表读不开"被报成
    /// "它已经不认得 --project-prune"，一个根本没发生过的原因。
    nonisolated static func pruneActionMessage(
        cliRan: Bool, stdout: String, stderr: String, exitCode: Int32
    ) -> String {
        let reply = replyText(stdout: stdout, stderr: stderr)
        let shaped = intField("matched", in: reply) != nil || boolField("loadFailed", in: reply) != nil
        let message = LocalArchive.pruneResultMessage(
            cliRan: cliRan,
            replyShaped: shaped,
            exitCode: exitCode,
            loadFailed: boolField("loadFailed", in: reply) ?? false,
            matched: intField("matched", in: reply) ?? 0,
            pruned: intField("pruned", in: reply) ?? 0,
            failed: intField("failed", in: reply) ?? 0,
            needsRestart: boolField("requiresDaemonRestart", in: reply) ?? false
        )
        return shaped || !cliRan ? message : message + quoteDaemonWords(stderr)
    }

    /// remove 的结论，同一判据：未知 id、"拒绝覆写损坏表"与"这条命令不被认识"是
    /// 三件事，而 stderr 里那份 `loadFailed` 报告属于第二件。
    nonisolated static func removeActionMessage(
        cliRan: Bool, stdout: String, stderr: String, exitCode: Int32
    ) -> String {
        let reply = replyText(stdout: stdout, stderr: stderr)
        let shaped = boolField("removed", in: reply) != nil
            || boolField("found", in: reply) != nil
            || boolField("loadFailed", in: reply) != nil
        let message = LocalArchive.removeResultMessage(
            cliRan: cliRan,
            replyShaped: shaped,
            exitCode: exitCode,
            removed: boolField("removed", in: reply) == true,
            loadFailed: boolField("loadFailed", in: reply) ?? false,
            needsRestart: boolField("requiresDaemonRestart", in: reply) ?? false
        )
        return shaped || !cliRan ? message : message + quoteDaemonWords(stderr)
    }

    /// 结论取哪一路文本：先看 stdout，形状不成才看 stderr（daemon 的拒绝报告在
    /// 那里），两路都不成时才把 stdout 交给上游去判"没被理解"。
    nonisolated static func replyText(stdout: String, stderr: String) -> String {
        func isJsonObject(_ text: String) -> Bool {
            guard let data = text.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return false
            }
            return !object.isEmpty
        }
        return isJsonObject(stdout) ? stdout : (isJsonObject(stderr) ? stderr : stdout)
    }

    /// 把后台服务真正说过的话附在结论后面。控制字符一律折成可见形式——这句会
    /// 被复制进终端和报告（R5-03），而它不是本进程写的。
    nonisolated static func quoteDaemonWords(_ text: String) -> String {
        var visible = ""
        for scalar in text.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars {
            if scalar.value < 0x20 || scalar.value == 0x7f {
                visible += "\\u\(String(format: "%04X", scalar.value))"
            } else {
                visible.unicodeScalars.append(scalar)
            }
        }
        guard !visible.isEmpty else { return "" }
        if visible.count > 240 {
            visible = String(visible.prefix(240)) + "…（已截断）"
        }
        return " 后台服务的原话：\(visible)"
    }

    nonisolated private static func intField(_ key: String, in json: String) -> Int? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object[key] as? Int
    }

    nonisolated private static func boolField(_ key: String, in json: String) -> Bool? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object[key] as? Bool
    }

    // MARK: - 档案辅助呈现

    /// 档案目录的完整路径（空状态里告诉用户去哪儿看，不让人猜）。
    var evidenceDirectoryPath: String { evidenceDirectory }

    /// 测试残留条数（项目页的"清理"按钮标题用它，让人先知道有多少）。
    var testResidueCount: Int { projects.filter { LocalArchive.isTestResidue($0) }.count }

    // MARK: - 审批台账文件那一枚按钮

    /// 「台账文件」要不要按得动：**读过一次、并且台账文件确实在**才给得出一个去处。
    /// 从前它永远可用，没有台账时按下什么也不发生——一个按了没反应的按钮，
    /// 和这一页其他"只亮不给证据"的控件是同一类毛病。
    var canRevealApprovalLedger: Bool { Self.ledgerRevealable(report: approvalReport) }

    /// 按不动时那句理由（同时是空台账那一屏的下一步）。
    var approvalLedgerUnavailableReason: String { Self.ledgerUnavailableReason(report: approvalReport) }

    nonisolated static func ledgerRevealable(report: ApprovalLedgerReport?) -> Bool {
        report?.fileExists ?? false
    }

    nonisolated static func ledgerUnavailableReason(report: ApprovalLedgerReport?) -> String {
        guard report != nil else {
            return "还没读过台账文件：点「刷新」读一次，这一枚才有地方可去。"
        }
        return "这台机器上还没有 approvals.json：执行过一次高风险操作（如回滚）之后它才会出现。"
    }
}
