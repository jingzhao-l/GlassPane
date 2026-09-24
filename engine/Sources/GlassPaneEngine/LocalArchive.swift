import Foundation

// MARK: - 本机档案只读视图（GUI 控制台）
//
// 设置面板要能把已经落盘的审计档案呈现给人看：evidence 档案、项目注册表、
// 审批签名链。三者都已在磁盘上（P1 v1.5 落盘 / P1 v1.4 注册表 / P5 §3 台账），
// 但此前只有 daemon CLI 能读，没有任何人类界面。
//
// 本文件是**纯读侧**：不改 socket 协议、不新增 MCP 工具、不写任何配置
// （P1 v1.2 §6.5 的冻结面不变）。面板与 daemon 各自读同一份文件；写操作
// 一律走 daemon 的一次性 CLI（见 `glasspaned --project-prune`），面板不
// 直接改盘——daemon 内存里持有一份注册表，面板侧覆写会被它下一次变更冲掉。
//
// 诚实口径（与 README「拿不到数据就显示未验证」同源）：
//  - 读不到目录 ≠ 空档案，`directoryExists` 如实区分；
//  - 单个文件解码失败不静默跳过，计入 `unreadableFiles` 并呈现条数；
//  - 未测量的通道（如无屏幕录制时的 pixelDiff）保持 nil，不折算成"没变化"。

// MARK: - Evidence 摘要

/// 一条已落盘 evidence 的列表行摘要（详情页直接解码整包，不在此结构里）。
public struct EvidenceSummary: Equatable, Identifiable {
    public let operationId: String
    /// ISO-8601（原样透传包内字段，不重新格式化，避免时区口径漂移）。
    public let createdAt: String
    public let schemaVersion: String
    /// draft 期落盘的历史包（冻结 v0.1 之前的档案）。
    public let isLegacySchema: Bool
    public let action: String
    public let selectorRole: String
    public let selectorTitle: String?
    public let actConfirmed: Bool
    /// 结构通道：nil = 该通道未测量。
    public let axChanged: Bool?
    public let treeChanged: Bool?
    public let nodeCount: Int?
    public let latencyMs: Double?
    /// 像素通道：nil = 未测量（屏幕录制未授予或捕获失败）。
    public let pixelRatio: Double?
    public let attributionLevel: String
    public let contaminated: Bool
    public let circuitBreakerLevel: Int
    public let diagnosisClass: String?
    public let assertionPassed: Bool?
    public let stateChanged: Bool?
    public let processAliveAfter: Bool?
    public let fileBytes: Int
    /// 档案落盘位置（详情页与"在访达中显示"要用；扫描时已知，不必二次查找）。
    public let filePath: String

    public var id: String { operationId }

    public init(
        operationId: String,
        createdAt: String,
        schemaVersion: String,
        action: String,
        selectorRole: String,
        selectorTitle: String?,
        actConfirmed: Bool,
        axChanged: Bool?,
        treeChanged: Bool?,
        nodeCount: Int?,
        latencyMs: Double?,
        pixelRatio: Double?,
        attributionLevel: String,
        contaminated: Bool,
        circuitBreakerLevel: Int,
        diagnosisClass: String?,
        assertionPassed: Bool?,
        stateChanged: Bool?,
        processAliveAfter: Bool?,
        fileBytes: Int,
        filePath: String = ""
    ) {
        self.operationId = operationId
        self.createdAt = createdAt
        self.schemaVersion = schemaVersion
        self.isLegacySchema = EvidencePack.legacySchemaVersions.contains(schemaVersion)
        self.action = action
        self.selectorRole = selectorRole
        self.selectorTitle = selectorTitle
        self.actConfirmed = actConfirmed
        self.axChanged = axChanged
        self.treeChanged = treeChanged
        self.nodeCount = nodeCount
        self.latencyMs = latencyMs
        self.pixelRatio = pixelRatio
        self.attributionLevel = attributionLevel
        self.contaminated = contaminated
        self.circuitBreakerLevel = circuitBreakerLevel
        self.diagnosisClass = diagnosisClass
        self.assertionPassed = assertionPassed
        self.stateChanged = stateChanged
        self.processAliveAfter = processAliveAfter
        self.fileBytes = fileBytes
        self.filePath = filePath
    }

    /// 由整包折算列表行（纯函数，单测直接喂构造包）。
    public static func from(
        pack: EvidencePack,
        fileBytes: Int,
        filePath: String = ""
    ) -> EvidenceSummary {
        let signals = pack.signals
        let ax = signals.axEvent
        return EvidenceSummary(
            operationId: pack.operationId,
            createdAt: pack.createdAt,
            schemaVersion: pack.schemaVersion,
            action: signals.act.action.rawValue,
            selectorRole: signals.act.selector.role,
            selectorTitle: signals.act.selector.title,
            actConfirmed: signals.act.actConfirmed,
            axChanged: ax?.axChanged,
            treeChanged: ax.map { $0.treeDigestBefore != $0.treeDigestAfter },
            nodeCount: ax?.nodeCount,
            latencyMs: ax?.latencyMs,
            pixelRatio: signals.pixelDiff?.changedPixelRatio,
            attributionLevel: pack.attribution.level.rawValue,
            contaminated: pack.attribution.contaminated,
            circuitBreakerLevel: pack.circuitBreaker.level.rawValue,
            diagnosisClass: pack.diagnosis.map { $0.class.rawValue },
            assertionPassed: pack.assertion?.passed,
            stateChanged: signals.stateDiff?.changed,
            processAliveAfter: signals.crash?.processAliveAfter,
            fileBytes: fileBytes,
            filePath: filePath
        )
    }
}

/// 档案列表的筛选维度（面板顶部的过滤器；与行渲染解耦，纯函数可单测）。
public enum EvidenceFilter: String, CaseIterable, Identifiable {
    case all
    case unconfirmed
    case contaminated
    case breaker
    case diagnosed
    case assertionFailed

    public var id: String { rawValue }

    /// 中文标题（面板文案单一真源；不写规格编号）。
    public var title: String {
        switch self {
        case .all: return "全部"
        case .unconfirmed: return "未确认"
        case .contaminated: return "有人同时操作"
        case .breaker: return "已降级"
        case .diagnosed: return "有诊断"
        case .assertionFailed: return "断言未过"
        }
    }

    public func matches(_ summary: EvidenceSummary) -> Bool {
        switch self {
        case .all:
            return true
        case .unconfirmed:
            return !summary.actConfirmed
        case .contaminated:
            return summary.contaminated
        case .breaker:
            return summary.circuitBreakerLevel > 0
        case .diagnosed:
            return summary.diagnosisClass != nil
        case .assertionFailed:
            return summary.assertionPassed == false
        }
    }
}

// MARK: - 扫描结果

/// evidence 目录一次扫描的结局。`directoryExists == false` 与"目录在但是空的"
/// 必须分开：前者是"还没有档案"，后者是"档案被清过"，面板措辞不同。
public struct EvidenceArchiveScan: Equatable {
    public let summaries: [EvidenceSummary]
    /// 存在但解不开的文件名（不静默丢，条数要呈现）。
    public let unreadableFiles: [String]
    public let directoryExists: Bool
    public let totalBytes: Int

    public init(
        summaries: [EvidenceSummary],
        unreadableFiles: [String],
        directoryExists: Bool,
        totalBytes: Int
    ) {
        self.summaries = summaries
        self.unreadableFiles = unreadableFiles
        self.directoryExists = directoryExists
        self.totalBytes = totalBytes
    }

    public static let empty = EvidenceArchiveScan(
        summaries: [], unreadableFiles: [], directoryExists: false, totalBytes: 0
    )
}

// MARK: - 审批台账报告

/// 审批台账 + 签名链校验结果。链校验复用 `ApprovalGate.verifyChain`，
/// 面板只呈现结论，不自行判断真伪。
public struct ApprovalLedgerReport: Equatable {
    public let records: [ApprovalRecord]
    public let chainValid: Bool
    public let firstBrokenIndex: Int?
    /// 台账文件存在但解不开——此时链"看似完整"，必须显式说明（与
    /// `ApprovalGate.loadFailed` 同口径，不把损坏读成空台账）。
    public let loadFailed: Bool
    public let fileExists: Bool
    /// 高风险却由 daemon 自批的条数（当前协议没有人类审批交互，
    /// 面板如实把它作为一个数字呈现，而不是让"已审批"看起来像人批的）。
    public let autoApprovedHighRiskCount: Int

    public init(
        records: [ApprovalRecord],
        chainValid: Bool,
        firstBrokenIndex: Int?,
        loadFailed: Bool,
        fileExists: Bool,
        autoApprovedHighRiskCount: Int
    ) {
        self.records = records
        self.chainValid = chainValid
        self.firstBrokenIndex = firstBrokenIndex
        self.loadFailed = loadFailed
        self.fileExists = fileExists
        self.autoApprovedHighRiskCount = autoApprovedHighRiskCount
    }
}

// MARK: - 入口

/// 控制台数据面：把三处本机档案折算成面板可渲染的视图模型。
/// 全部依赖可注入（目录、读文件、临时目录根），因此无 GUI 权限也能在 CI 跑。
public enum LocalArchive {

    /// 测试/示例用的 bundle 标识：引擎各套件的假想被测应用恒用这个值。
    public static let sampleBundleIdentifier = "com.example.app"

    // MARK: evidence

    /// 扫描一个 evidence 目录。按 createdAt 倒序（新→旧）；同值时按文件名，
    /// 保证两次扫描结果稳定可断言。
    public static func scanEvidence(
        directory: String = EvidenceStore.defaultDirectory,
        fileReader: (String) -> Data? = { path in try? Data(contentsOf: URL(fileURLWithPath: path)) },
        decoder: JSONDecoder = JSONDecoder()
    ) -> EvidenceArchiveScan {
        let url = URL(fileURLWithPath: directory)
        guard FileManager.default.fileExists(atPath: directory) else {
            return .empty
        }
        let names: [String]
        if let listed = try? FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        ) {
            names = listed
                .map { $0.lastPathComponent }
                .filter { $0.hasSuffix("." + EvidenceStore.fileExtension) }
                .sorted()
        } else {
            names = []
        }
        var summaries: [EvidenceSummary] = []
        var unreadable: [String] = []
        var total = 0
        for name in names {
            let path = directory + "/" + name
            guard let data = fileReader(path) else {
                unreadable.append(name)
                continue
            }
            total += data.count
            guard let pack = try? decoder.decode(EvidencePack.self, from: data) else {
                unreadable.append(name)
                continue
            }
            summaries.append(.from(pack: pack, fileBytes: data.count, filePath: path))
        }
        summaries.sort { lhs, rhs in
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
            return lhs.operationId > rhs.operationId
        }
        return EvidenceArchiveScan(
            summaries: summaries,
            unreadableFiles: unreadable,
            directoryExists: true,
            totalBytes: total
        )
    }

    // MARK: 项目

    /// 判定一条注册项是否为**测试残留**：被测标识是引擎假想应用，且证据目录
    /// 落在系统临时目录里（真项目的证据不会放在重启即失的临时目录）。
    /// 两个条件同时成立才算，避免把用户手工注册的同名应用误判。
    public static func isTestResidue(
        _ entry: ProjectEntry,
        tempRoots: [String] = defaultTempRoots()
    ) -> Bool {
        guard entry.bundleId == sampleBundleIdentifier else { return false }
        guard let path = entry.evidenceStoragePath, !path.isEmpty else { return false }
        return tempRoots.contains { path.hasPrefix($0) }
    }

    /// 系统临时目录根（解析 symlink，兼容 /tmp 与 /var/folders 两种形态）。
    public static func defaultTempRoots() -> [String] {
        let raw = NSTemporaryDirectory()
        let resolved = (raw as NSString).resolvingSymlinksInPath
        return [
            raw,
            resolved.hasSuffix("/") ? resolved : resolved + "/",
            "/tmp/",
            "/private/tmp/"
        ].filter { !$0.isEmpty }
    }

    /// 某项目档案目录里的 evidence 条数；目录不存在返回 nil（"没有档案"与
    /// "档案目录已被清理"在面板上是两种措辞）。
    public static func evidenceCount(
        at path: String?,
        fallback: String = EvidenceStore.defaultDirectory
    ) -> Int? {
        let dir = (path?.isEmpty == false) ? path! : fallback
        guard FileManager.default.fileExists(atPath: dir) else { return nil }
        let url = URL(fileURLWithPath: dir)
        guard let listed = try? FileManager.default.contentsOfDirectory(
            at: url, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
        ) else { return nil }
        return listed.filter { $0.pathExtension == EvidenceStore.fileExtension }.count
    }

    // MARK: 审批

    /// 读台账并验链。`ApprovalGate` 在链损坏/文件损坏时都不会抛错，
    /// 因此这里把三种形态分开：文件不存在 / 载入失败 / 链断裂位置。
    public static func readApprovalLedger(
        path: String = ApprovalGate.defaultPath
    ) -> ApprovalLedgerReport {
        let exists = FileManager.default.fileExists(atPath: path)
        let gate = ApprovalGate(path: path)
        let verdict = gate.verifyChain()
        let autoHigh = gate.records.filter {
            $0.riskTier == .high && $0.approvedBy == ApprovalGate.autoApprover
        }.count
        return ApprovalLedgerReport(
            records: gate.records,
            chainValid: verdict.valid,
            firstBrokenIndex: verdict.firstBrokenIndex,
            loadFailed: gate.loadFailed,
            fileExists: exists,
            autoApprovedHighRiskCount: autoHigh
        )
    }

    // MARK: 呈现辅助（纯函数，供面板与单测共用）

    /// ISO-8601 → 面板用的紧凑本地时间（`09-22 19:44:52`）。解析失败原样返回，
    /// 不编造时间。
    public static func displayTimestamp(iso8601: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso8601)
            ?? ISO8601DateFormatter().date(from: iso8601) else {
            return iso8601
        }
        let out = DateFormatter()
        out.locale = Locale(identifier: "en_US_POSIX")
        out.dateFormat = "MM-dd HH:mm:ss"
        return out.string(from: date)
    }

    /// 字节数 → 人类可读容量（1024 进制，一位小数）。
    public static func displayBytes(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let units = ["KB", "MB", "GB"]
        var value = Double(bytes)
        var index = -1
        repeat {
            value /= 1024
            index += 1
        } while value >= 1024 && index < units.count - 1
        return String(format: "%.1f %@", value, units[index])
    }

    // MARK: 写入面的回执文案（纯函数；面板只转述，不自己判定）

    /// 修剪结果 → 面板那句话。口径是**命中 ≠ 删掉**：CLI 报得出 `matched/pruned/failed`
    /// 之后，面板不得再把命中数当成功数，也不得在部分成功时说"保持原样"。
    public static func pruneResultMessage(
        cliRan: Bool,
        loadFailed: Bool,
        matched: Int,
        pruned: Int,
        failed: Int,
        needsRestart: Bool
    ) -> String {
        if !cliRan {
            return "清理命令没能跑起来，注册表未改动。请确认后台服务的程序路径可用。"
        }
        if loadFailed {
            return "注册表文件读不开，为避免把读不回的条目覆写掉，清理没有执行。修好该文件后重启后台服务再试。"
        }
        if matched == 0 { return "没有需要清理的测试残留项目。" }
        let restart = needsRestart ? "重启后台服务后，它内存里的旧列表才会同步。" : ""
        if pruned > 0 && failed == 0 {
            return "已清理 \(pruned) 条测试残留项目。" + restart
        }
        if pruned > 0 {
            return "已清理 \(pruned) 条，另有 \(failed) 条没能清理；没能清理的那几条仍在列表里。" + restart
        }
        return "\(failed) 条都没能清理，注册表保持原样。"
    }

    /// 单条删除结果 → 面板那句话。未知 id 与"拒绝覆写损坏表"是两件事。
    public static func removeResultMessage(
        cliRan: Bool,
        removed: Bool,
        loadFailed: Bool,
        needsRestart: Bool
    ) -> String {
        if !cliRan { return "删除命令没能跑起来，注册表未改动。" }
        if removed {
            return "已删除该项目。"
                + (needsRestart ? "重启后台服务后，它内存里的旧列表才会同步。" : "")
        }
        if loadFailed {
            return "注册表文件读不开，为避免把读不回的条目覆写掉，删除没有执行。"
        }
        return "没找到这个项目，注册表未改动。"
    }
}
