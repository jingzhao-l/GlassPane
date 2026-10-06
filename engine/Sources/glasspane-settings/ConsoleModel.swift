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
}
