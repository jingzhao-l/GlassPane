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
    /// 扫注册表这一趟**顺带量到**的"本页在读的那一份档案目录在不在"。
    /// 三态：`nil` = 这一趟还没跑过（不是"不在"）；`true`/`false` = 量到的结局。
    /// 项目页那枚「在访达中打开证据目录」在它没有自己的目录时就开这一份，所以这一
    /// 枚的可用性只能由这一次实测决定，不能由"看起来应该有"决定。
    @Published private(set) var sharedEvidenceDirectoryExists: Bool?
    @Published var selectedProjectId: String?
    /// 待确认的清理清单。**必须由 daemon 的 `--project-prune --dry-run` 产生**：
    /// 从前这里是面板自己按 `LocalArchive.isTestResidue` 过滤本地读到的注册表，
    /// 而确认之后真删的是 daemon——两份判定之间没有保证，表格上摊开的"N 条"
    /// 就成了面板的主张而不是后台服务的答复。字段只取 daemon 报回来的那四个，
    /// 不补 `createdAt`（补了就是编一个它没说过的东西）。
    @Published var prunePreview: [PrunePreviewRow] = []
    @Published var isPreparingPrunePreview = false
    @Published var isPruneSheetPresented = false
    /// 确认后的真删在途。**这一枚必须有屏幕上的形状**：`pruneControl` 把它折算成
    /// 一个 `.blocked` 的「清理」（带原因与下一步），`ProjectsTabView` 那一行再画一枚
    /// 沙漏与一句"哪一趟在跑"（`gp-prune-in-flight`）。从前它只被模型自己的 `guard`
    /// 读过，而那是闸门不是读者——真删那 20 秒里按钮已经回到可点状态。
    @Published var isRunningPrune = false
    /// 修剪后是否需要重启后台服务（daemon 内存里还是旧表）。
    @Published var pruneNeedsRestart = false
    /// 上一次写入动作（清理／删除）的结论。**必须被渲染**：这条曾经只被写入、
    /// 没有任何读者，于是"确认清理"点下去只是关掉确认表，删了几条、失败在哪、
    /// 要不要重启全都看不见——而消息本身算得好好的，测试也全绿。
    /// `PanelActionReadoutTests` 闸住"写了没人读"这个形状。
    @Published var lastActionMessage: String?

    // MARK: - approvals

    @Published var approvalsState: LoadState = .idle
    @Published private(set) var approvalReport: ApprovalLedgerReport?

    /// daemon 可执行文件路径：由面板在 hello 拿到 daemon 身份后回填。
    /// 没有它，清理/删除这类写入动作就没有可执行入口。
    @Published var daemonBinaryPath: String?
    /// 面板这一页读与写的状态根。
    ///
    /// 由来：`GLASSPANE_STATE_DIR` 是更新器那侧的口径，daemon 从不读它（它只认启动时的
    /// `--state-dir`），于是"面板按 env 算根、daemon 守另一个根"时同一屏并排显示两个根的
    /// 数据，而「清理/删除」这四条一次性 CLI 改的是**另一个实例的真注册表**
    /// （`smoke.md` 2026-10-13 §4 记为已确认 P1）。现在 hello 报来根就跟着换，
    /// 出处由 `stateRootSource` 如实标着。
    @Published private(set) var stateRoot: StateRoot
    /// 这一页的根是从哪来的——三种来源三句话，"daemon 报的"不许由"面板算的"来冒充。
    enum StateRootSource: Equatable {
        /// 最近一帧 hello 里 daemon 自己报的。
        case daemonReported
        /// daemon 报过，之后的帧没再报（老 daemon 没带这个键）：路径留着，出处如实降级。
        case daemonReportedEarlier
        /// daemon 从没报过，这是面板按 `GLASSPANE_STATE_DIR`/家目录算的。
        case panelComputed
    }
    @Published private(set) var stateRootSource: StateRootSource = .panelComputed
    @Published private(set) var evidenceDirectory: String
    @Published private(set) var projectsPath: String
    @Published private(set) var approvalsPath: String
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
        env: [String: String] = ProcessInfo.processInfo.environment,
        home: String = NSHomeDirectory(),
        evidenceDirectory: String? = nil,
        projectsPath: String? = nil,
        approvalsPath: String? = nil,
        evidenceScanner: ((String) -> EvidenceScanOutcome)? = nil,
        packReader: ((String) -> EvidencePack?)? = nil
    ) {
        // 与更新器同一份口径（`UpdatePanel.stateRoot`）：环境变量优先，否则家目录默认根。
        // 不是"也写一遍相似的规则"，而是同一个函数——两条腿各写一遍正是这条缺陷的来源。
        let rootPath = UpdatePanel.stateRoot(env: env, home: home)
        let root = StateRoot(path: rootPath)
        self.daemonBinaryPath = daemonBinaryPath
        self.stateRoot = root
        self.evidenceDirectory = evidenceDirectory ?? root.evidenceDirectory
        self.projectsPath = projectsPath ?? root.projectsFile
        self.approvalsPath = approvalsPath ?? root.approvalsFile
        self.evidenceScanner = evidenceScanner ?? { ConsoleModel.scanArchiveDirectory($0) }
        self.packReader = packReader ?? { ConsoleModel.readPackFile(at: $0) }
    }

    /// 控制台三类 daemon 调用的 argv 组装（纯函数，可单测）：根**必须**显式点名，
    /// 放在命令之前，且不因为"根看起来就是默认值"而省略——省略一次，这条命令就会
    /// 在另一个实例的根上执行。
    static func daemonCLIArguments(_ command: [String], stateRoot: String) -> [String] {
        ["--state-dir", stateRoot] + command
    }

    /// 四条 daemon 一次性命令实际用的 argv：**只能**从这一页当前认的根组装。
    /// 从前四个调用点各自拼 `stateRoot.path`，于是"跟着 daemon 换根"这件事要改四处，
    /// 少改一处就是半修（读的是新根、删的是旧根）。收在这里，测试也只需要对这一条说话。
    func daemonCLIArguments(_ command: [String]) -> [String] {
        ConsoleModel.daemonCLIArguments(command, stateRoot: stateRoot.path)
    }

    /// 面板这一页认的状态根（供文案点名"这数字是从哪儿读的"）。
    var displayedStateRoot: String { stateRoot.path }

    /// 这一页的根是**谁**认定的。从前这句话只报路径，于是 daemon 报一个根、面板按
    /// `GLASSPANE_STATE_DIR` 另算一个根时，屏幕两侧都写着一个"状态根"而看不出它们不是
    /// 同一个数——现在把出处一起说出来，没报过就不冒充报过。
    var displayedStateRootCaption: String {
        let origin: String
        switch stateRootSource {
        case .daemonReported: origin = "后台服务这一帧上报的"
        case .daemonReportedEarlier: origin = "后台服务早前上报的（这一帧没再报）"
        case .panelComputed: origin = "面板自己算的（后台服务从没报过它实际在用的根）"
        }
        return "\(origin)状态根 \(displayedStateRoot)——本页读数与「清理/删除」都按它走"
    }

    /// daemon 二进制路径是否已知——决定"清理/删除"这类写入动作可用与否。
    var canRunDaemonCLI: Bool { daemonBinaryPath != nil }

    /// daemon 至少应过一次门。没有它，"这一页的根是自己算的"与"根本没有服务可问"
    /// 是两件事，而只有前者才该拦下写入动作。
    @Published private(set) var daemonHasAnswered = false
    /// 服务在应门，却从没报过它自己的根，而这一页手里那个根是面板按 env/家目录算的——
    /// 这种情形下 `--project-prune` / `--project-remove` 动的是**哪个实例的注册表**没人知道。
    /// 读侧靠 `displayedStateRootCaption` 把出处说出来；写侧不能只靠一句话就照常动手。
    var writesLackAReportedRoot: Bool { daemonHasAnswered && stateRootSource == .panelComputed }

    /// 把一次 hello 的实测结局接到控制台数据上。
    ///
    /// 从前这里只在 `daemonBinaryPath == nil` 时赋值一次，于是重装/重开之后
    /// `.onChange` 再也更新不动它——清理/删除/校验/统计一直在 exec 那份已经退役的
    /// 二进制，而页面上写的是新那一份。现在**每帧自报了就跟着换**（nil = 这一帧
    /// 没自报，保持现状，因为"没读到路径"不等于"路径没了"）。
    /// - Parameter answered: 这一帧是不是真的拿到了 hello 回话。"注册表改动要重启
    ///   后台服务才生效"那句话只能在服务重新应门之后撤，点一下按钮不算重启成功。
    func adoptDaemonReport(binaryPath: String?, daemonStateRoot: String? = nil, answered: Bool) {
        // 只有真空白算"这一帧没自报"；空白串也不能当路径——后面四条动作都要拿它去 exec。
        let reported = binaryPath?.trimmingCharacters(in: .whitespacesAndNewlines)
        let reportedRoot = daemonStateRoot?.trimmingCharacters(in: .whitespacesAndNewlines)
        var rootChanged = false
        if let reportedRoot, !reportedRoot.isEmpty {
            let next = StateRoot(path: reportedRoot)
            if next != stateRoot {
                stateRoot = next
                evidenceDirectory = next.evidenceDirectory
                projectsPath = next.projectsFile
                approvalsPath = next.approvalsFile
                rootChanged = true
            }
            stateRootSource = .daemonReported
        } else if stateRootSource == .daemonReported {
            // 报过又断了（老 daemon 不带这个键）：路径留着，但出处必须降级——
            // "上一次报的"与"这一帧报的"是两句话，写成一句就是替另一句背书。
            stateRootSource = .daemonReportedEarlier
        }
        if let reported, !reported.isEmpty, reported != daemonBinaryPath {
            daemonBinaryPath = reported
            // 换的是"该问哪一个进程"，那一栏的旧结论（或从没结论）要跟着重测。
            refreshDaemonStats()
        }
        if rootChanged {
            // 换根之后这一页三个数都读错了对象：档案、注册表、台账全部重扫。
            reloadEvidence()
            reloadProjects()
            reloadApprovals()
        }
        if answered {
            daemonHasAnswered = true
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
        let sharedDirectory = evidenceDirectory
        Task.detached(priority: .userInitiated) {
            let registry = ProjectRegistry(filePath: path)
            let entries = registry.all
            var counts: [String: Int?] = [:]
            for entry in entries {
                counts[entry.projectId] = Self.ownedEvidenceCount(for: entry)
            }
            let damaged = registry.loadFailed
            // 同一趟里量一下"本页在读的那一份档案目录在不在"：项目页那枚打开目录的
            // 控件在注册项没写目录时开的就是它，判据必须来自这里，不能来自猜。
            let sharedExists = Self.directoryIsPresent(sharedDirectory)
            await MainActor.run {
                self.projects = entries
                self.projectEvidenceCounts = counts
                self.sharedEvidenceDirectoryExists = sharedExists
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
        let statsArgs = daemonCLIArguments(["--evidence-stats"])
        Task.detached(priority: .userInitiated) {
            let run = ConsoleModel.runDaemonCLI(binary: binary, arguments: statsArgs)
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
    // MARK: - 写入动作（一律经 daemon CLI）

    /// 先向 daemon 要一次 `--project-prune --dry-run`，把**它的**命中清单摊开给人确认。
    /// 从前这一步是面板本地过滤：表格上写的"N 条"是面板的主张，而按确认之后删的是
    /// daemon 那份判定，两边可以各说各话。CLI 在后台队列跑（主线程等子进程 = 看门狗杀窗口）。
    func previewTestResiduePrune() {
        guard canRunDaemonCLI else {
            lastActionMessage = "还没连上后台服务：读不到它的程序路径，清理动作无法执行。点「刷新」恢复后重试。"
            return
        }
        guard !isPreparingPrunePreview else { return }
        // 一次真删可以跑上约 20 s。这一趟里再起一次 `--project-prune --dry-run`，摊出来
        // 的清单读的是**正在被改的那张表**——预览与删除用的是同一份 projects.json，
        // 而运行中的 daemon 手里还持着另一份。控件那一份判据在 `pruneControl`
        // （`isPruneRunning` 那一支），这里再来一道：键盘与自动化会绕过灰掉的按钮。
        guard !isRunningPrune else {
            lastActionMessage = "清理没有再问一次预览：上一次「确认清理」还在后台服务里跑，"
                + "这一趟的清单会读着一张正在被改的表。下一步：等它跑完（页面那一行会自己说什么时候完），"
                + "再点一次「清理」。"
            return
        }
        isPreparingPrunePreview = true
        let binary = daemonBinaryPath
        // 状态根必须显式点名（与另三条控制台命令同一个组装函数）：预览读的是哪张表，
        // 就得是面板这一页正在显示的那张根，否则摊给人看的清单来自另一个实例。
        let args = daemonCLIArguments(["--project-prune", "--dry-run"])
        Task.detached(priority: .userInitiated) {
            let run = ConsoleModel.runDaemonCLI(binary: binary, arguments: args)
            await MainActor.run {
                self.isPreparingPrunePreview = false
                switch Self.prunePreviewOutcome(
                    cliRan: run != nil,
                    stdout: run?.output ?? "",
                    stderr: run?.errorOutput ?? "",
                    exitCode: run?.status ?? -1
                ) {
                case .rows(let rows):
                    self.prunePreview = rows
                    self.isPruneSheetPresented = true
                case .refused(let message):
                    // 读不到就不摊清单：确认表面前一条空表与"没读出来"必须能分开。
                    self.prunePreview = []
                    self.isPruneSheetPresented = false
                    self.lastActionMessage = message
                }
            }
        }
    }

    /// dry-run 回话怎么折算成清单（纯函数，供单测）。判据与 `pruneActionMessage`
    /// 同一条：**这一行里到底有没有约定那几个字段**，不是进程有没有回来过。
    /// `dryRun:false` 的回话单独拦——面板要的是预览，daemon 却报"已经删过了"，
    /// 那必须说出来而不是当成清单显示。
    nonisolated static func prunePreviewOutcome(
        cliRan: Bool, stdout: String, stderr: String, exitCode: Int32
    ) -> PrunePreviewOutcome {
        guard cliRan else {
            return .refused("清理预览没有执行：读不到后台服务的程序路径，或它没在时限内回话。点「刷新」恢复后重试。")
        }
        let reply = replyText(stdout: stdout, stderr: stderr)
        // 先问"这张表读得开吗"，再问"命中几条"。反过来的时候，daemon 那份
        // `loadFailed:true` 的拒绝载荷——它故意不再带 `matched`，因为读不到的表给不出
        // 任何条数——会被这里当成"后台服务没按约定回答"，把一个已经如实说明原因的回话
        // 折成一句猜测。顺序就是这两件事的先后：先确认有没有答案，再看答案说什么。
        if boolField("loadFailed", in: reply) == true {
            return .refused("注册表读不开（loadFailed:true），预览与删除都不可信；先修 \(registryPath(in: reply)) 再试。")
        }
        guard let matched = intField("matched", in: reply) else {
            return .refused(
                "后台服务没有按约定回答清理预览（退出码 \(exitCode)，回文里没有 matched 字段）。"
                + "清单不显示，任何删除都不会执行——它原话：\(quoteDaemonWords(stderr.isEmpty ? stdout : stderr))")
        }
        if boolField("dryRun", in: reply) == false {
            return .refused(
                "要的是预览（--dry-run），后台服务回的是 `dryRun:false`——它说这一趟已经动过注册表了。"
                + "先查它报了哪些结果（matched/pruned/remaining），别在这里点确认。")
        }
        var rows: [PrunePreviewRow] = []
        if let data = reply.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let projects = object["projects"] as? [[String: Any]] {
            for item in projects {
                guard let projectId = item["projectId"] as? String,
                      let displayName = item["displayName"] as? String else { continue }
                rows.append(PrunePreviewRow(
                    projectId: projectId,
                    displayName: displayName,
                    bundleId: item["bundleId"] as? String,
                    evidenceStoragePath: (item["evidenceStoragePath"] as? String) ?? nil
                ))
            }
        }
        // 命中数与清单条数不符：报出来，不折成"没有"也不静默截短。
        if rows.count != matched {
            return .refused(
                "后台服务的预览自相矛盾：`matched` 说 \(matched) 条，`projects` 给了 \(rows.count) 条。"
                + "清单不显示，任何删除都不会执行。")
        }
        return .rows(rows)
    }

    /// 确认清理：真正执行 `--project-prune`，随后如实告知是否需要重启。
    /// CLI 在后台队列跑——面板曾经把一次性任务放在主线程等，结果是
    /// "点了没反应"直到系统看门狗把窗口杀掉。
    func confirmPrune() {
        guard !isRunningPrune else { return }
        // 没有 daemon 二进制就没有可执行入口。从前这里不设闸：确认表照样关掉，
        // `runDaemonCLI` 回 nil，结论算好了却没人显示，用户看到的就只剩
        // "点了一下，什么都没发生"。
        guard canRunDaemonCLI else {
            isPruneSheetPresented = false
            lastActionMessage = "还没连上后台服务：读不到它的程序路径，清理动作无法执行。点「刷新」恢复后重试。"
            return
        }
        // 写入动作需要一次**实测到的根**：服务在应门却没报过根，这一页手里那个根是面板
        // 自己算的，动的手可能落在另一个实例的注册表上。
        guard !writesLackAReportedRoot else {
            isPruneSheetPresented = false
            lastActionMessage = "清理没有执行：后台服务在应门，但它没有报过自己用的状态根，而这一页现在按的是"
                + "面板自己算的那一个（\(displayedStateRoot)）。在这种情形下点「清理」动的是谁的注册表没人说得清，"
                + "所以这一枚拒绝。下一步：重启后台服务并在启动时点名 `--state-dir <你要清的根>`，"
                + "或把它升级到会自报状态根的版本（1.6.2 及以后会报），然后点「刷新」重来。"
            return
        }
        isRunningPrune = true
        isPruneSheetPresented = false
        let binary = daemonBinaryPath
        let pruneArgs = daemonCLIArguments(["--project-prune"])
        Task.detached(priority: .userInitiated) {
            let run = ConsoleModel.runDaemonCLI(binary: binary, arguments: pruneArgs)
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
        guard !writesLackAReportedRoot else {
            lastActionMessage = "删除 \(projectId) 没有执行：后台服务在应门，却没有报过自己用的状态根，"
                + "而这一页按的是面板自己算的那一个（\(displayedStateRoot)）——这一枚删的是谁的注册表说不准。"
                + "下一步：让服务带着 `--state-dir <根>` 重启，或升级到会自报状态根的版本后点「刷新」。"
            return
        }
        let binary = daemonBinaryPath
        let removeArgs = daemonCLIArguments(["--project-remove", projectId])
        Task.detached(priority: .userInitiated) {
            let run = ConsoleModel.runDaemonCLI(binary: binary, arguments: removeArgs)
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

    /// 收起上一条动作结论。渲染它的横幅必须有关闭入口，否则一次结论会一直
    /// 挂在页面上，下一次动作的新结论到底换没换都看不出来。
    func dismissActionMessage() {
        lastActionMessage = nil
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

    /// 回话里"它自己说出来的原因"（纯函数，供单测）。
    ///
    /// 这些一次性命令把拒绝写在 stderr：`--recipe-validate` 读不到那个文件时回
    /// `{"valid":false,"errors":["file not found: …"],"path":…}`（退出码 2），
    /// 结论编码不出去时回 `{"encodeFailed":true,"error":"…"}`（退出码 1）。
    /// 上游要的从来不是"退出码非 0"这一个比特，而是**它到底说了什么**——
    /// 把这句丢掉换成"后台服务不可达"，就是拿一件没发生过的事替掉了量到的那件。
    /// 取序：`errors` 数组 → `error` 字符串 → 回话原文；一个字都没有就如实说没有。
    nonisolated static func daemonRefusalReason(reply: String) -> String {
        let trimmed = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        if let data = trimmed.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let errors = object["errors"] as? [String],
               !errors.filter({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }).isEmpty {
                return errors.joined(separator: "；")
            }
            if let error = object["error"] as? String,
               !error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return error
            }
        }
        return trimmed.isEmpty ? "它一个字都没回（这一趟没有任何可指认的原因）" : trimmed
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

    /// 报文里那份"哪张表"。缺它时不说成一个空路径——那会让下一步的
    /// `cat`/`ls` 指到一个不存在的位置，出路就成了假的。
    nonisolated private static func registryPath(in json: String) -> String {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let path = object["registryPath"] as? String, !path.isEmpty else {
            return "（回话没给出注册表路径）"
        }
        return path
    }

    // MARK: - 档案辅助呈现

    /// 档案目录的完整路径（空状态里告诉用户去哪儿看，不让人猜）。
    var evidenceDirectoryPath: String { evidenceDirectory }

    /// 台账文件的完整路径：这一页**读过的那一份**（`reloadApprovals` 用的就是它）。
    var approvalsLedgerPath: String { approvalsPath }

    /// 台账所在的目录：由上面那份实测到的路径反推，**不是**引擎那个"家目录默认根"
    /// 常量的父目录。后者永远指向 `~/.glasspane`，而这一页读的台账可能在别的根
    /// （`GLASSPANE_STATE_DIR` / daemon 的 `--state-dir`）——于是那一枚「台账文件」
    /// 开的是一个它从没测过的目录：里面根本没有被读到的那份 `approvals.json`；
    /// 反过来，挪过根的那台机器上它会说"还没有 approvals.json"而文件其实就在屏幕上
    /// 那一份的位置。与证据页早就在用的 `evidenceDirectoryPath` 同一条口径。
    var approvalsDirectory: String { (approvalsPath as NSString).deletingLastPathComponent }

    /// 测试残留条数（项目页的横幅用它，让人先知道有多少）。
    /// **它不是「清理」这一枚显示与否的判据**——见 `pruneControl`。
    var testResidueCount: Int { projects.filter { LocalArchive.isTestResidue($0) }.count }

    // MARK: - 项目「证据条数」：只量它自己那份档案

    /// 某项目**自己拥有**的档案条数；没写 `evidenceStoragePath` 就是**没测量**（nil）。
    ///
    /// 这里绝不接受任何"顶替"：从前这一页把本页在读的共用档案目录当 `fallback` 交给
    /// `LocalArchive.evidenceCount(at:fallback:)`，于是没配目录的项目显示的是
    /// **共用档案**的文件条数，而被顶替掉的那个数字才是这个项目的答案。同一个事实在
    /// `glasspaned --evidence-stats --project <id>` 那里答的是 `null` 并明说共享档案
    /// 不是它的替身（`EngineCore.noArchiveRefusal`），两个面不能各答各的，
    /// 而面板那一侧给的正是编出来的那一个。
    ///
    /// `counter` 是注入点：单测用它证明"没配目录 → 一次都没数"，不靠磁盘形状。
    nonisolated static func ownedEvidenceCount(
        for entry: ProjectEntry,
        counter: (String) -> Int? = { LocalArchive.evidenceCount(at: $0) }
    ) -> Int? {
        guard let directory = entry.evidenceStoragePath?
                .trimmingCharacters(in: .whitespacesAndNewlines), !directory.isEmpty else {
            return nil
        }
        // Only a directory this entry owns is ever handed to the counter:
        // `LocalArchive.evidenceCount` no longer has a fallback parameter at all,
        // so "count something else instead" is not a branch anyone can re-add here.
        return counter(directory)
    }

    /// 「证据条数」唯一的那一句：列表行与详情行共用同一判据、同一串字。
    ///
    /// 同一个 nil 从前在列表行写「证据目录已清理」、在详情行写「证据目录不存在」——
    /// 前者宣称发生过一次清理，而这一页什么都没观测到（它只测到过"那里没有目录"）；
    /// 后者是它真正测到的事。两个说法里较响的那个不是事实，所以这里只留一个。
    nonisolated static func evidenceCountReadout(_ count: Int?) -> String {
        guard let count else {
            return "未测量（注册项没写证据目录，或那个目录不在）"
        }
        return "\(count) 条"
    }

    // MARK: - 一枚按不动的控件：理由 + 下一步

    /// 一枚控件的呈现：按得动与否 + 那一句话（禁用时它就是理由与下一步）。
    struct PanelControl: Equatable {
        let enabled: Bool
        let help: String
    }

    /// 「档案目录」这一枚的呈现（纯函数，供单测）。
    /// 从前禁用态那句 help 只描述启用态（"在访达中打开 …"），于是按不动的时候
    /// 屏幕上那句话说的是一件它没做的事。
    nonisolated static func evidenceDirectoryControl(
        exists: Bool, directory: String
    ) -> PanelControl {
        if exists {
            return PanelControl(enabled: true, help: "在访达中打开这一页在读的档案目录：\(directory)")
        }
        return PanelControl(enabled: false, help:
            "「档案目录」现在按不动：这个根里还没有档案目录，访达没有一个去处可显示（应在：\(directory)）。"
            + "下一步：执行一次会留档案的操作后点「刷新」重扫；后台服务的状态根只在启动时用 "
            + "--state-dir 点名（它不读 GLASSPANE_STATE_DIR），这一页跟着它上报的那一个读，"
            + "侧栏「状态根」那一行就是它报的数。")
    }

    /// 项目页「在访达中打开证据目录」这一枚的呈现（纯函数，供单测）。
    ///
    /// 缺陷形状：注册项没写档案目录时它开的是**本页在读的那一份共用目录**，而那一份
    /// 这一页已经量过"不在盘上"（同一屏上面那一行就是按占位画的）——`NSWorkspace.selectFile`
    /// 对一个不存在的位置什么都不做，屏幕上没有一个字说为什么。证据页的同胞早就由
    /// `evidenceDirectoryControl(exists:directory:)` 管住了自己，这一枚是漏网的那一个。
    ///
    /// `sharedDirectoryExists` 用的是三态而不是 Bool：`nil` = 这一趟还没量过。
    /// 把"没量过"写成"那里没有"、或把"没量过"放过去开一个没验证过的位置，是同一个
    /// 毛病的两个方向。
    nonisolated static func projectEvidenceDirectoryControl(
        registeredPath: String?,
        sharedDirectory: String,
        sharedDirectoryExists: Bool?,
        stateRootCaption: String
    ) -> PanelControl {
        let registered = registeredPath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !registered.isEmpty {
            return PanelControl(enabled: true, help:
                "在访达中打开这条注册项自己写的档案目录：\(registered)")
        }
        switch sharedDirectoryExists {
        case .some(true):
            return PanelControl(enabled: true, help:
                "这条注册项没写档案目录，所以它自己没有可打开的档案。这一枚开的是本页在读的那一份："
                    + "\(sharedDirectory)（\(stateRootCaption)）——那是本页共用的档案目录，不是这个项目的替身。")
        case .some(false):
            return PanelControl(enabled: false, help:
                "「在访达中打开证据目录」现在按不动：这条注册项没写档案目录，而这一页量过它本来要开的"
                    + "那一份 \(sharedDirectory)——它不在盘上（\(stateRootCaption)）。访达没有一个去处可显示。"
                    + "下一步：执行一次会留档案的操作后点「刷新」重扫；要让这个项目有自己的档案目录，"
                    + "就在注册时给它写上 evidenceStoragePath。")
        case nil:
            return PanelControl(enabled: false, help:
                "「在访达中打开证据目录」现在按不动：这条注册项没写档案目录，而这一页还没量过它本来要"
                    + "开的那一份 \(sharedDirectory) 在不在——没量过就不开一个没验证过的位置。"
                    + "下一步：点这一页的「刷新」量一次，再决定去哪儿。")
        }
    }

    /// 这一页量到的「那个位置在不在」：目录存在且确实是目录才算 `true`。
    nonisolated static func directoryIsPresent(_ path: String) -> Bool {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        var isDirectory = ObjCBool(false)
        guard FileManager.default.fileExists(atPath: trimmed, isDirectory: &isDirectory) else {
            return false
        }
        return isDirectory.boolValue
    }

    /// 「打开报告」这一枚的呈现：**判据是这条档案的读取结局**，不是那个共用的 nil。
    /// 每一支都带上这一屏做得动的那一步。
    nonisolated static func reportButtonControl(packLoad: PackLoad) -> PanelControl {
        switch packLoad {
        case .loaded:
            return PanelControl(enabled: true, help:
                "用浏览器打开这条证据的报告：会在系统临时目录写一份 0600 的副本，看完可自行删除")
        case .loading:
            return PanelControl(enabled: false, help:
                "「打开报告」现在按不动：这条档案还在读盘，报告要拿到完整信号链才写得出来。"
                + "下一步：等这一条读完，或点「刷新」重读。")
        case .failed(let reason):
            return PanelControl(enabled: false, help:
                "「打开报告」现在按不动：\(reason) 下一步：点这一屏的「重试」再读一次；"
                + "还是读不出就用 MCP 侧的 gp_export_evidence 取这份档案的文本。")
        case .none:
            return PanelControl(enabled: false, help:
                "「打开报告」现在按不动：这一帧没读到这条记录的内容（还没点中左侧的记录，或列表刚重扫）。"
                + "下一步：左侧点一条记录，或点「刷新」重读一次。")
        }
    }

    /// 「在访达中显示」这一枚的呈现（纯函数，供单测）。
    ///
    /// 缺陷形状：它是「打开报告」旁边那一枚没有闸的按钮——`revealFile()` 在路径为空
    /// 时直接 `return`，整包没读到时同样什么都不发生，而它的同胞早就经
    /// `reportButtonControl(...)` 给出禁用理由。按了没反应、屏幕上又没有一个字说为什么，
    /// 在这一产品里就是 P0：控件看着能按，本身就是一种主张。
    ///
    /// 判据只有两个，而且都是这一页**测到**的东西：这条档案的读取结局，与扫描给出的那个
    /// 落盘路径。没有第三条"差不多可以"的回落——路径为空就是这条记录没带着它在盘上的位置，
    /// 整包没读到就是访达那头的东西还没被确认存在。
    nonisolated static func revealFileControl(packLoad: PackLoad, filePath: String) -> PanelControl {
        let path = filePath.trimmingCharacters(in: .whitespacesAndNewlines)
        switch packLoad {
        case .loaded:
            guard !path.isEmpty else {
                return PanelControl(enabled: false, help:
                    "「在访达中显示」现在按不动：这条档案的扫描结果没带着它在盘上的路径，"
                    + "访达没有一个去处可显示。下一步：点「刷新」重扫一次档案目录；"
                    + "还是空的就是这条记录本身没有路径可报，这一页不会替它编一个。")
            }
            return PanelControl(enabled: true, help: "在访达中选中这一条档案自己那份文件：\(path)")
        case .loading:
            return PanelControl(enabled: false, help:
                "「在访达中显示」现在按不动：这条档案还在读盘，它到底在不在都要等这一次读完才知道。"
                + "下一步：等这一条读完，或点「刷新」重读。")
        case .failed(let reason):
            return PanelControl(enabled: false, help:
                "「在访达中显示」现在按不动：\(reason) 下一步：点这一屏的「重试」再读一次；"
                + "整包读不出时访达里那个位置也可能已经不在了，先用「档案目录」那一枚看这一页在读的目录。")
        case .none:
            return PanelControl(enabled: false, help:
                "「在访达中显示」现在按不动：这一帧没读到这条记录的内容（还没点中左侧的记录，"
                + "或列表刚重扫）。下一步：左侧点一条记录，或点「刷新」重读一次。")
        }
    }

    // MARK: - 项目页「清理」这一枚

    /// 「清理」的呈现。
    enum PanelPruneControl: Equatable {
        /// 按得动：横幅那句实测计数 + help 里那句"清单以后台服务为准"。
        case ready(banner: String, help: String)
        /// 按不动：**照样画出来**，`banner` 是这一页报得出的条数，`reason` 是原因 + 下一步。
        case blocked(banner: String, reason: String)
    }

    /// 「清理」这一枚的呈现判据（纯函数，供单测）。
    ///
    /// **永不隐藏**：这一页有没有得清，只有后台服务的 `--project-prune --dry-run`
    /// 答得出；面板自己按 `LocalArchive.isTestResidue` 数出来的那个数不是它的判据。
    /// 从前按钮只在 `testResidueCount > 0` 时才画，而注册表**读失败**时那个数就是 0
    /// （`projects` 是空的），于是 daemon 一次都没被问过——一个入口因为解释不了
    /// 自己就被收掉了，正是 README 认下的那类毛病（"never hides a control to avoid
    /// explaining it"）。现在它永远在屏上：按不动时把原因和下一步写在同一枚控件上。
    nonisolated static func pruneControl(
        projectsState: LoadState,
        residueCount: Int,
        canRunDaemonCLI: Bool,
        writesLackReportedRoot: Bool = false,
        isPreparingPreview: Bool,
        isPruneRunning: Bool = false
    ) -> PanelPruneControl {
        let banner: String
        /// 读表那一侧给出的"按不动"原因（表读成了就是 nil）。
        let readBlock: String?
        switch projectsState {
        case .idle, .loading:
            banner = "注册表还在读，这一页报不出条数"
            readBlock = "「清理」现在按不动：注册表还在读，这一页既不知道表里有什么，也就说不出要清什么。"
                + "下一步：等它读完，或点「刷新」重读注册表。"
        case .failed(let message):
            banner = "注册表这次没读成，这一页报不出条数"
            readBlock = "「清理」现在按不动：注册表这次没读成（\(message)），这一页的零条是读不到的零条，"
                + "不是后台服务的答复。下一步：先点「刷新」把注册表读成，这一枚才有清单可要。"
        case .loaded:
            banner = residueCount > 0
                ? "\(residueCount) 条注册项指向系统临时目录"
                : "面板在这台机器上读到 0 条指向系统临时目录的注册项"
            readBlock = nil
        }
        // 在途的**删除**排在在途的预览之前说：删除正在进行时注册表正被改写，
        // 这时候再点「清理」起一次 dry-run，摊开的清单读的是改到一半的表。
        if isPruneRunning {
            return .blocked(banner: banner, reason:
                "「清理」现在按不动：上一趟 --project-prune 还在跑（真删一条最长要等 20 秒的"
                + "daemon 回话），注册表此刻正被它改写。这一步再按下去，对着的就是一张改到一半的表。"
                + "下一步：等这一趟回话——它删了几条、失败在哪、要不要重启都会写在页面上方那条横幅里，"
                + "那时再点「清理」要清单才有意义。")
        }
        if isPreparingPreview {
            return .blocked(banner: banner, reason:
                "预览已经在路上：这一趟 --project-prune --dry-run 还没回话，同时问两次没有意义。"
                + "下一步：等它回话，或稍后再点一次「清理」。")
        }
        if let readBlock {
            return .blocked(banner: banner, reason: readBlock)
        }
        if !canRunDaemonCLI {
            return .blocked(banner: banner, reason:
                "「清理」现在按不动：还没读到后台服务的程序路径，这一枚没有可执行入口。"
                + "下一步：点「刷新」等后台服务重新应门，它会把自己那份路径报回来。")
        }
        if writesLackReportedRoot {
            return .blocked(banner: banner, reason:
                "「清理」现在按不动：后台服务在应门，却没有报过它自己用的状态根，而这一页按的是面板自己算的"
                + "那一个（出处就写在侧栏「状态根」那一行）。按下它可能动到另一个实例的真注册表，所以这一枚"
                + "拒绝。下一步：让服务带着 `--state-dir <你要清的根>` 重启，或升级到会自报状态根的版本，"
                + "然后点「刷新」。")
        }
        let help = residueCount > 0
            ? "这些是引擎自检过程留下的示例项目，不是你注册的应用。按下「清理」先向后台服务要一份"
                + "将删除的清单（--project-prune --dry-run），确认之后才动手。"
            : "这个 0 只是面板本地的计数：有没有得清，以后台服务的 --project-prune --dry-run 为准。"
                + "按下「清理」先拿那份清单，确认之后才动手。"
        return .ready(banner: banner, help: help)
    }

    /// 现在这一屏上「清理」该有的形态。
    var pruneControl: PanelPruneControl {
        Self.pruneControl(
            projectsState: projectsState,
            residueCount: testResidueCount,
            canRunDaemonCLI: canRunDaemonCLI,
            writesLackReportedRoot: writesLackAReportedRoot,
            isPreparingPreview: isPreparingPrunePreview,
            isPruneRunning: isRunningPrune
        )
    }

    /// 「清理」按得动吗——**永远画得出来**，这里只答"能不能按"。
    var canPreviewTestResiduePrune: Bool {
        if case .ready = pruneControl { return true }
        return false
    }

    /// 那一枚控件上的一句话：按得动时是它做什么，按不动时是原因 + 下一步。
    var pruneControlHelp: String {
        switch pruneControl {
        case .ready(_, let help): return help
        case .blocked(_, let reason): return reason
        }
    }

    /// 横幅那一行：面板这一趟报得出的条数（读不到时那句就写着读不到）。
    var pruneControlBanner: String {
        switch pruneControl {
        case .ready(let banner, _): return banner
        case .blocked(let banner, _): return banner
        }
    }

    /// 「档案目录」那一枚的现在形态（按得动与否 + 那一句话）。
    var evidenceDirectoryControl: PanelControl {
        Self.evidenceDirectoryControl(exists: archiveExists, directory: evidenceDirectory)
    }

    /// 项目页「在访达中打开证据目录」那一枚的现在形态。判据与证据页那枚同一条：
    /// 这一页量到过那个去处，才谈得上按得动。
    func projectEvidenceDirectoryControl(for entry: ProjectEntry) -> PanelControl {
        Self.projectEvidenceDirectoryControl(
            registeredPath: entry.evidenceStoragePath,
            sharedDirectory: evidenceDirectoryPath,
            sharedDirectoryExists: sharedEvidenceDirectoryExists,
            stateRootCaption: displayedStateRootCaption
        )
    }

    // MARK: - 审批台账文件那一枚按钮

    /// 「台账文件」要不要按得动：**读过一次、并且台账文件确实在**才给得出一个去处。
    /// 从前它永远可用，没有台账时按下什么也不发生——一个按了没反应的按钮，
    /// 和这一页其他"只亮不给证据"的控件是同一类毛病。
    var canRevealApprovalLedger: Bool { Self.ledgerRevealable(report: approvalReport) }

    /// 按不动时那句理由（同时是空台账那一屏的下一步）。
    var approvalLedgerUnavailableReason: String { Self.ledgerUnavailableReason(report: approvalReport) }

    /// 台账那一行标题唯一的措辞源。
    ///
    /// `report.chainValid` 说的是**文件里那条链**自洽；它证明不了最新一条记录落过盘
    /// （P8：一条更短的链同样能从创世校验通过）。知道这件事的只有正在服务的那个 daemon
    /// 进程——`--approval-verify` 是一次性读文件，它自己永远不会有 `persistFailed`。
    /// 所以 daemon 报了落盘失败时，这里不许单独说"签名链完整"。
    nonisolated static func chainTitle(
        report: ApprovalLedgerReport?, daemonPersistFailure: String?
    ) -> String {
        guard let report else { return "台账状态未知" }
        if report.loadFailed { return "台账文件读不开" }
        if daemonPersistFailure != nil {
            return report.chainValid ? "文件里的链完整，但后台服务有记录没落盘" : "签名链已断裂"
        }
        return report.chainValid ? "签名链完整" : "签名链已断裂"
    }

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

/// 清理确认表的一行。**字段就是 daemon `--project-prune --dry-run` 报文里那几个**：
/// 面板不替它补 `createdAt` 之类它没说过的东西，也不带 `ProjectEntry` 那种
/// 本地注册表才有的完整形状。
struct PrunePreviewRow: Equatable {
    let projectId: String
    let displayName: String
    let bundleId: String?
    let evidenceStoragePath: String?
}

/// 清理预览的两种结局：拿到清单，或者**不摊清单并说清为什么**。
enum PrunePreviewOutcome: Equatable {
    case rows([PrunePreviewRow])
    case refused(String)
}
