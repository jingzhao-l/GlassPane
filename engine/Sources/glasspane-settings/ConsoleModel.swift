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

    @Published var evidenceState: LoadState = .idle
    @Published private(set) var summaries: [EvidenceSummary] = []
    @Published private(set) var unreadableFiles: [String] = []
    @Published private(set) var archiveExists = false
    @Published private(set) var archiveTotalBytes = 0
    @Published var filter: EvidenceFilter = .all
    @Published var searchText = ""
    @Published var selectedOperationId: String?
    /// 选中项的整包（详情页按需读盘，列表只用摘要）。
    @Published private(set) var selectedPack: EvidencePack?

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

    init(
        daemonBinaryPath: String? = nil,
        evidenceDirectory: String = EvidenceStore.defaultDirectory,
        projectsPath: String = ProjectRegistry.defaultProjectsPath,
        approvalsPath: String = ApprovalGate.defaultPath
    ) {
        self.daemonBinaryPath = daemonBinaryPath
        self.evidenceDirectory = evidenceDirectory
        self.projectsPath = projectsPath
        self.approvalsPath = approvalsPath
    }

    /// daemon 二进制路径是否已知——决定"清理/删除"这类写入动作可用与否。
    var canRunDaemonCLI: Bool { daemonBinaryPath != nil }

    // MARK: - 刷新

    /// 刷新全部三块档案（面板打开、切页、点刷新时调用）。
    func refreshAll() {
        reloadEvidence()
        reloadProjects()
        reloadApprovals()
    }

    func reloadEvidence() {
        evidenceState = .loading
        let directory = evidenceDirectory
        Task.detached(priority: .userInitiated) {
            let scan = LocalArchive.scanEvidence(directory: directory)
            await MainActor.run {
                self.summaries = scan.summaries
                self.unreadableFiles = scan.unreadableFiles
                self.archiveExists = scan.directoryExists
                self.archiveTotalBytes = scan.totalBytes
                self.evidenceState = .loaded
                if self.selectedOperationId == nil {
                    self.selectedOperationId = scan.summaries.first?.operationId
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

    private func loadSelectedPackIfNeeded() {
        guard let operationId = selectedOperationId,
              let summary = summaries.first(where: { $0.operationId == operationId }) else {
            selectedPack = nil
            return
        }
        let path = summary.filePath
        Task.detached(priority: .userInitiated) {
            let pack: EvidencePack?
            if let data = try? Data(contentsOf: URL(fileURLWithPath: path)) {
                pack = try? JSONDecoder().decode(EvidencePack.self, from: data)
            } else {
                pack = nil
            }
            await MainActor.run { self.selectedPack = pack }
        }
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
                let output = run?.output ?? ""
                self.pruneNeedsRestart = Self.boolField("requiresDaemonRestart", in: output) ?? false
                self.lastActionMessage = LocalArchive.pruneResultMessage(
                    cliRan: run != nil,
                    loadFailed: Self.boolField("loadFailed", in: output) ?? false,
                    matched: Self.intField("matched", in: output) ?? 0,
                    pruned: Self.intField("pruned", in: output) ?? 0,
                    failed: Self.intField("failed", in: output) ?? 0,
                    needsRestart: self.pruneNeedsRestart
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
                let output = run?.output ?? ""
                self.pruneNeedsRestart = Self.boolField("requiresDaemonRestart", in: output) ?? false
                self.lastActionMessage = LocalArchive.removeResultMessage(
                    cliRan: run != nil,
                    removed: (Self.intField("removed", in: output) ?? 0) > 0,
                    loadFailed: Self.boolField("loadFailed", in: output) ?? false,
                    needsRestart: self.pruneNeedsRestart
                )
                if self.selectedProjectId == projectId { self.selectedProjectId = nil }
                self.reloadProjects()
            }
        }
    }

    /// 跑一次 daemon 一次性 CLI，返回它的 stdout 与退出码；起不来/超时才回 nil。
    ///
    /// **非 0 退出也要把 JSON 交回去**：这些命令的报告体本身就是结论（部分修剪成功
    /// 时 `pruned` 与 `matched` 不同），按退出码把输出丢掉会让面板只剩一句
    /// "没执行成功"，然后对着一份已经改了一半的注册表说"保持原样"——那就是撒谎。
    /// 这些命令只读写 `~/.glasspane` 下的普通文件，不涉及 TCC 席位，
    /// 因此以面板进程直接执行即可——不像权限申请必须落在 daemon 自己身上。
    /// `nonisolated static`：调用方一律放后台队列，主线程不等子进程。
    nonisolated static func runDaemonCLI(
        binary: String?,
        arguments: [String],
        timeoutSeconds: TimeInterval = 20
    ) -> (output: String, status: Int32)? {
        guard let binary else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            return nil
        }
        // 先读到 EOF 再等退出：反过来时子进程输出超过管道缓冲会互相死等。
        // 但仍要有上限——子进程卡住不能把后台队列永久占住。
        let readQueue = DispatchQueue(label: "glasspane.console.cli-reader")
        let box = MutexBox<Data>(Data())
        let group = DispatchGroup()
        group.enter()
        readQueue.async {
            box.value = pipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        if group.wait(timeout: .now() + timeoutSeconds) == .timedOut {
            process.terminate()
            return nil
        }
        process.waitUntilExit()
        guard let text = String(data: box.value, encoding: .utf8) else { return nil }
        return (text, process.terminationStatus)
    }

    private static func intField(_ key: String, in json: String) -> Int? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object[key] as? Int
    }

    private static func boolField(_ key: String, in json: String) -> Bool? {
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
}
