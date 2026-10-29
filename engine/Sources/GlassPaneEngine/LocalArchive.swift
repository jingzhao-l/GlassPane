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
//  - 目录在但列不出来 ≠ 空档案，扫描结果用 `listFailure` 说这句（与
//    `EvidenceStore.stats()` 的 `listFailure` 同口径）；
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
    /// `circuitBreaker.reason` verbatim: `contaminated` is a verdict, and the engine sets it
    /// conservatively when nothing watched the window (it names that in this string). Without
    /// it a row cannot tell "a person was measured operating" from "nobody looked, so assumed".
    public let breakerReason: String?
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
        breakerReason: String?,
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
        self.breakerReason = breakerReason
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
            breakerReason: pack.circuitBreaker.reason,
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
        // 过滤器按**结论**筛（contaminated 为 true 的都进来），标题不许替它声称是测量：
        // 无人看守时引擎也判 true，那一半在行里读得到（EvidenceCopy.contamination 给的
        // 是"未监测（无人看守该窗口…）"）。写"有人同时操作"会把没看守的行说成看守过。
        case .contaminated: return "污染判定"
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
/// 第三态是 `listFailure`：目录在、却列不出来。此时 `summaries` 的空是"没看过"
/// 的空，把它当"档案是空的"呈现就是本轮反复在拆的那句话（对照
/// `EvidenceStore.archiveListing`/`EvidenceArchiveStats.listFailure`）。
public struct EvidenceArchiveScan: Equatable {
    public let summaries: [EvidenceSummary]
    /// 存在但解不开的文件名（不静默丢，条数要呈现）。
    public let unreadableFiles: [String]
    public let directoryExists: Bool
    /// 本档案所有条目的字节总量；**有条目没报出大小时为 nil**。从前这里是 `Int` 并把
    /// 读不到大小那一条折成 `?? 0`，于是面板用一个更小的总数冒充一次测量——而 daemon
    /// `--evidence-stats` 对同一件事的判据写在 `EvidenceStore.stats()` 里："not
    /// obtained … reported as null with exit 1 rather than as the smaller total of the
    /// entries that did answer"（本轮修的缺陷）。
    public let totalBytes: Int?
    /// nil = 每一个所有条目都报出了大小。非 nil = 哪几个没报出来，句子由本文件与
    /// `EvidenceStore` 同一口径写；把它折回一个数字等于把"我没测到"说成"就这么大"。
    public let sizeFailure: String?
    /// 本档案**拥有**的条目数（`op_<26>.json` 那一份人口）。与 `summaries.count` 是两
    /// 个数：后者只数解得开的。同一行里说"N 条 · X KB"时 KB 数的是拥有的人口，条数也
    /// 必须用同一份人口，否则三个文件配一个"条"就是这一行自己在打架。
    public let entryCount: Int
    /// nil = 列举**真的完成了**，所以 `summaries.isEmpty` 说的是"里面没有档案"。
    /// 非 nil = 目录存在却读不了，理由在这里；把它折回空档案等于把"我看不了"
    /// 说成"那里没有"。
    public let listFailure: String?

    public init(
        summaries: [EvidenceSummary],
        unreadableFiles: [String],
        directoryExists: Bool,
        totalBytes: Int?,
        sizeFailure: String? = nil,
        entryCount: Int? = nil,
        listFailure: String? = nil
    ) {
        self.summaries = summaries
        self.unreadableFiles = unreadableFiles
        self.directoryExists = directoryExists
        self.totalBytes = totalBytes
        self.sizeFailure = sizeFailure
        // 没显式给就按"这一份人口等于解得开的那一份"——只有既有调用方那种"扫不出
        // 任何拥有条目"的场合会走到这里，此时两个数确实相同。
        self.entryCount = entryCount ?? summaries.count
        self.listFailure = listFailure
    }

    public static let empty = EvidenceArchiveScan(
        summaries: [], unreadableFiles: [], directoryExists: false, totalBytes: 0,
        listFailure: nil
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
    ///
    /// **与 daemon 同一个读者**（defect 8，2026-10-19）。此前这里是 `decode` +
    /// 任意 `*.json`，而 daemon 是 `EvidenceStore.isEntryName` + `decodeAndValidate`：
    /// 一份档案、两个判决，面板会渲染 daemon 用 GP_E_NO_EVIDENCE 回答的档案行。
    /// 现在两条判据都在，且"看了却给不出行"的那种文件不静默丢——它进
    /// `unreadableFiles`，条数与名字都呈现。
    public static func scanEvidence(
        directory: String = EvidenceStore.defaultDirectory,
        fileReader: (String) -> Data? = { path in try? Data(contentsOf: URL(fileURLWithPath: path)) },
        /// 单条目尺寸的读法，默认与 daemon `stats()` 同一句（`.fileSizeKey`）。可注入是
        /// 因为生产里"报不出大小"是**列完之后那条被并发改掉**（prune 与扫描赛跑）才出现的
        /// 形态；单元测试造不出这个竞态，而这条判据不许因此只能钉文本。
        sizeReader: (String) -> Int? = { path in
            try? URL(fileURLWithPath: path).resourceValues(forKeys: [.fileSizeKey]).fileSize
        }
    ) -> EvidenceArchiveScan {
        let url = URL(fileURLWithPath: directory)
        guard FileManager.default.fileExists(atPath: directory) else {
            return .empty
        }
        let names: [String]
        // 列不出来是一次**失败**，不是"里面没有档案"：`names = []` 在这里会让
        // `directoryExists: true` 配上一份空摘要，把"我看不了"呈现成"档案是空的"。
        var listFailure: String?
        do {
            names = try FileManager.default.contentsOfDirectory(
                at: url,
                includingPropertiesForKeys: [.fileSizeKey],
                options: [.skipsHiddenFiles]
            )
                .map { $0.lastPathComponent }
                .filter { $0.hasSuffix("." + EvidenceStore.fileExtension) }
                .sorted()
        } catch {
            names = []
            listFailure = "cannot list the evidence archive at \(directory) (\(error)) — the archive was never read, so an empty result here means nothing was seen, not that nothing is there"
        }
        var summaries: [EvidenceSummary] = []
        var unreadable: [String] = []
        var total = 0
        var sizeFailures: [String] = []
        var ownedEntries = 0
        for name in names {
            let path = directory + "/" + name
            guard EvidenceStore.isEntryName(name) else {
                // Not a name this archive's owner ever writes (`op_<26>.json`), so
                // the daemon will not read it, will not count it in `stats()`, and
                // will not delete it. A panel row for it would be the lying half of
                // that; naming it is the honest half.
                unreadable.append(name)
                continue
            }
            ownedEntries += 1
            // Defect 9: the archive's size is what the daemon counts — the size of
            // every entry it owns, including one whose *contents* cannot be read.
            // Summing only the files that decoded made the panel state a smaller
            // archive in exactly the same breath as reporting it partly unreadable.
            let listedSize = sizeReader(path)
            // 大小报不出来 ⇒ 这一条**不计入**总量，而是记进 `sizeFailures`。把它折成
            // `?? 0` 就是把"没测到"写成一个更小的测量值（daemon 那一侧同一件事报 null）。
            if let listedSize {
                total += listedSize
            } else {
                sizeFailures.append(name)
            }
            guard let data = fileReader(path) else {
                unreadable.append(name)
                continue
            }
            guard let pack = try? EvidencePack.decodeAndValidate(data) else {
                unreadable.append(name)
                continue
            }
            summaries.append(.from(pack: pack, fileBytes: data.count, filePath: path))
        }
        summaries.sort { lhs, rhs in
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
            return lhs.operationId > rhs.operationId
        }
        // 与 `EvidenceStore.stats()` 同一句判据：有条目没报出大小，总量就不是"测得的"，
        // 报 null 而不是报那个少了几KB的数字。名字点出来，读的人才知道缺的是哪一份。
        let sizeStatement: String? = sizeFailures.isEmpty ? nil :
            "\(sizeFailures.count) of \(ownedEntries) archive entries would not report a size "
            + "(first: \(sizeFailures.first ?? "")), so totalBytes is not obtained — this is reported as "
            + "null rather than as the smaller total of the entries that did answer"
        return EvidenceArchiveScan(
            summaries: summaries,
            unreadableFiles: unreadable,
            directoryExists: true,
            totalBytes: sizeFailures.isEmpty ? total : nil,
            sizeFailure: sizeStatement,
            entryCount: ownedEntries,
            listFailure: listFailure
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

    /// 某项目档案目录里的 evidence 条数。目录缺席返回 nil ——「没有档案」与
    /// 「档案目录已被清理」在面板上是两种措辞，而"没配目录"绝不能回落到
    /// 共用档案去数：那等于替一个项目宣称它没有的测量。`fallback:` 参数与它的
    /// `EvidenceStore.defaultDirectory` 缺省值已删（面板侧不再传），因为默认值
    /// 就是那条替身路径本身。
    ///
    /// 计数的判据与 daemon **同一个谓词**（defect 8 的同一句话）：`EvidenceStore.isDeletableEntry`，
    /// 不是 `pathExtension == "json"`，也不止于"名字合规格"。前者把 `settings.json`、一个叫
    /// `x.json` 的目录、一个不合规范的 `op_*.json` 都算成已归档证据；后者仍会把一个**取了
    /// 合规格名字的目录或符号链接**算进条数，而 `stats()` 走的是 `archiveListing` 那一层
    /// （`isDeletableEntry`：合规格名字 + 普通文件 + 不是符号链接），于是同一个目录、两个数字，
    /// 用户看到的是面板这一个。缺席的目录仍回 nil，不折算成 0 条。
    public static func evidenceCount(at path: String?) -> Int? {
        guard let path, !path.isEmpty else { return nil }
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let url = URL(fileURLWithPath: path)
        guard let listed = try? FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        ) else { return nil }
        return listed.filter { EvidenceStore.isDeletableEntry($0) }.count
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
    ///
    /// `replyShaped` 是"这一行回得就是约定的那份 JSON"。少了它，进程跑起来却**没被
    /// 理解**（daemon 不认这条命令 → 退出码 64 + 一段帮助文本）会被折算成
    /// `matched = 0`，面板于是当着一屏"68 条残留"说"没有需要清理的测试残留项目"。
    /// "没东西可删"与"这条命令不存在"是两件事，混起来的后果是用户以为已经干净了。
    ///
    /// `loadFailed` 有**两支**，各说各话：
    ///  * 写之前就读不开（`requiresDaemonRestart:false`，回话里根本没有 matched）——
    ///    一次都没动手，那句"清理没有执行"说得出口；
    ///  * 写完读不回（`requiresDaemonRestart:true`，后台服务自己说这一趟动过盘）——
    ///    这里不许再说"没有执行/未改动"：盘与内存此刻已经不一致，替它断言"没动过"
    ///    会把唯一那一步补救（先修文件、再重启）说成没必要做。
    public static func pruneResultMessage(
        cliRan: Bool,
        replyShaped: Bool,
        exitCode: Int32,
        loadFailed: Bool,
        matched: Int,
        pruned: Int,
        failed: Int,
        needsRestart: Bool
    ) -> String {
        if !cliRan {
            return "清理命令没能跑起来，注册表未改动。请确认后台服务的程序路径可用。"
        }
        if !replyShaped {
            return "后台服务没有按约定的形状回这条清理命令（退出码 \(exitCode)），注册表未改动。"
                + "这多半是它已经不认得 `--project-prune`——跑一次 `glasspaned --help` 核对。"
                + "这一句不代表已经干净了：一条都没删，也没人去问过有没有可删的。"
        }
        if loadFailed {
            if needsRestart {
                return "清理已经动过盘上那份注册表，可这一趟写完读不回它，确认不了删掉了哪几条、"
                    + "现在还剩什么。下一步：先把那份文件修到能读开，再重启后台服务——"
                    + "它手里此刻还是改动前的那一份。"
            }
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

    /// 单条删除结果 → 面板那句话。未知 id、"拒绝覆写损坏表"、以及"这条命令根本
    /// 不被认识"是三件事。第三种从前会被读成"没找到这个项目"——同一个 `removed: false`，
    /// 一个说的是用户给错了 id，一个说的是这台机器上没有这条命令。
    ///
    /// `found` 把 `loadFailed` 那一支再分成两件事，它们互相否定：
    ///  * `found` 缺席 = 表在**动手之前**就读不开，这一趟确实什么都没写；
    ///  * `found:true` = 它先读开了表、认出了这条注册项、把删除写了下去，之后才读不回——
    ///    这时说"删除没有执行"就是把已经动过的盘说成没动过，还会顺带抹掉那一步补救
    ///    （先修文件、再重启）的必要性。后台服务自己都不敢断言"未改动"，面板不许替它断。
    public static func removeResultMessage(
        cliRan: Bool,
        replyShaped: Bool,
        exitCode: Int32,
        removed: Bool,
        loadFailed: Bool,
        found: Bool = false,
        needsRestart: Bool
    ) -> String {
        if !cliRan { return "删除命令没能跑起来，注册表未改动。" }
        if !replyShaped {
            return "后台服务没有按约定的形状回这条删除命令（退出码 \(exitCode)），注册表未改动。"
                + "这多半是它已经不认得 `--project-remove`——跑一次 `glasspaned --help` 核对。"
                + "这一句不是说该 id 不存在：命令没被理解，还没走到查 id 那一步。"
        }
        if removed {
            return "已删除该项目。"
                + (needsRestart ? "重启后台服务后，它内存里的旧列表才会同步。" : "")
        }
        if loadFailed {
            if found {
                return "删除已经写进盘上那份注册表，可这一趟写完读不回它，确认不了它现在还在不在、"
                    + "表里还剩什么。下一步：先把那份文件修到能读开，再重启后台服务——"
                    + "它手里此刻还是改动前的那一份。"
            }
            return "注册表文件读不开，为避免把读不回的条目覆写掉，删除没有执行。"
        }
        if found {
            return "后台服务认得这一条注册项，但这一趟没把它删掉，注册表还是原样。"
                + "下一步：点「刷新」重读注册表确认它仍在，再重试删除。"
        }
        return "没找到这个项目，注册表未改动。"
    }
}
