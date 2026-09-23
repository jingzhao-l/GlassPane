import XCTest
@testable import GlassPaneEngine

/// `LocalArchive` 单测（GUI 控制台的数据面）。
///
/// 面板本身不做逻辑单测（P1 v1.2 §9.3），但它要读的档案折算必须是纯逻辑：
/// 扫描、摘要、筛选、测试残留判据、台账校验——全部在这里钉住，CI 无 GUI
/// 权限也能跑。
final class LocalArchiveTests: XCTestCase {

    // MARK: - fixtures

    private func tempDir() -> String {
        let dir = NSTemporaryDirectory() + "/gp-archive-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    private func pack(
        operationId: String = "op_0123456789ABCDEFGHJKMNPQRS",
        createdAt: String = "2026-09-14T12:00:00.000Z",
        schemaVersion: String = EvidencePack.schemaVersionConst,
        actConfirmed: Bool = true,
        axChanged: Bool? = true,
        pixelRatio: Double? = 0.02,
        contaminated: Bool = false,
        breaker: CircuitBreakerLevel = .normal,
        diagnosisClass: DiagnosisClass? = nil
    ) -> EvidencePack {
        let selector = Selector(role: "AXButton", title: "Submit")
        var diagnosis: Diagnosis?
        if let diagnosisClass {
            diagnosis = Diagnosis(
                class: diagnosisClass,
                report: DiagnosisReport(
                    path: "p", anomaly: "a", evidence: "e", next: "n"
                )
            )
        }
        return EvidencePack(
            schemaVersion: schemaVersion,
            operationId: operationId,
            createdAt: createdAt,
            attribution: Attribution(level: .soft, contaminated: contaminated),
            circuitBreaker: CircuitBreaker(level: breaker),
            signals: Signals(
                act: ActSignal(selector: selector, action: .press, actConfirmed: actConfirmed),
                axEvent: axChanged.map {
                    AxEventSignal(
                        treeDigestBefore: "dig_before", treeDigestAfter: "dig_after",
                        nodeCount: 42, axChanged: $0, latencyMs: 3
                    )
                },
                pixelDiff: pixelRatio.map {
                    PixelDiffSignal(changedPixelRatio: $0, bounds: nil, windowId: 7)
                },
                responsiveness: nil,
                crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
            ),
            diagnosis: diagnosis
        )
    }

    @discardableResult
    private func write(_ pack: EvidencePack, to directory: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try! encoder.encode(pack)
        let path = directory + "/" + pack.operationId + ".json"
        try! data.write(to: URL(fileURLWithPath: path))
        return path
    }

    // MARK: - 扫描

    func testScanReportsMissingDirectoryAsMissingNotEmpty() {
        let scan = LocalArchive.scanEvidence(directory: tempDir() + "/nope")
        XCTAssertFalse(scan.directoryExists, "目录不存在必须与「目录是空的」分开")
        XCTAssertTrue(scan.summaries.isEmpty)
    }

    func testScanReadsEveryParsablePackAndCountsUnreadable() {
        let dir = tempDir()
        write(pack(operationId: "op_0123456789ABCDEFGHJKMNPQRS"), to: dir)
        write(pack(operationId: "op_0123456789ABCDEFGHJKMNPQRT", createdAt: "2026-09-15T12:00:00.000Z"), to: dir)
        try? Data("{ not json".utf8).write(to: URL(fileURLWithPath: dir + "/op_broken000000000000000000000.json"))
        try? Data("ignored".utf8).write(to: URL(fileURLWithPath: dir + "/notes.txt"))

        let scan = LocalArchive.scanEvidence(directory: dir)
        XCTAssertTrue(scan.directoryExists)
        XCTAssertEqual(scan.summaries.count, 2)
        XCTAssertEqual(scan.unreadableFiles, ["op_broken000000000000000000000.json"],
                       "解不开的文件要按名字列出来，不能静默丢")
        XCTAssertGreaterThan(scan.totalBytes, 0)
    }

    func testScanSortsNewestFirst() {
        let dir = tempDir()
        write(pack(operationId: "op_0123456789ABCDEFGHJKMNPQRS", createdAt: "2026-09-14T12:00:00.000Z"), to: dir)
        write(pack(operationId: "op_0123456789ABCDEFGHJKMNPQRT", createdAt: "2026-09-20T12:00:00.000Z"), to: dir)
        let scan = LocalArchive.scanEvidence(directory: dir)
        XCTAssertEqual(scan.summaries.map(\.operationId),
                       ["op_0123456789ABCDEFGHJKMNPQRT", "op_0123456789ABCDEFGHJKMNPQRS"])
    }

    func testSummaryFlagsLegacySchema() {
        let dir = tempDir()
        write(pack(operationId: "op_0123456789ABCDEFGHJKMNPQRS",
                   schemaVersion: "glasspane.evidence/0.1-draft"), to: dir)
        write(pack(operationId: "op_0123456789ABCDEFGHJKMNPQRT",
                   schemaVersion: EvidencePack.schemaVersionConst), to: dir)
        let scan = LocalArchive.scanEvidence(directory: dir)
        XCTAssertEqual(scan.summaries.filter(\.isLegacySchema).count, 1)
    }

    func testSummaryKeepsUnmeasuredChannelsAsNil() {
        // 屏幕录制未授予时 pixelDiff 为 nil：摘要必须保持"未测量"，
        // 不能折算成 0%（那等于宣称测到了"画面没变"）。
        let summary = EvidenceSummary.from(
            pack: pack(axChanged: nil, pixelRatio: nil), fileBytes: 10
        )
        XCTAssertNil(summary.pixelRatio)
        XCTAssertNil(summary.axChanged)
        XCTAssertNil(summary.treeChanged)
        XCTAssertEqual(summary.action, "press")
        XCTAssertEqual(summary.selectorTitle, "Submit")
    }

    func testSummaryCarriesVerdictFields() {
        let summary = EvidenceSummary.from(
            pack: pack(actConfirmed: false, contaminated: true, breaker: .degraded,
                       diagnosisClass: .t4),
            fileBytes: 12
        )
        XCTAssertFalse(summary.actConfirmed)
        XCTAssertTrue(summary.contaminated)
        XCTAssertEqual(summary.circuitBreakerLevel, 1)
        XCTAssertEqual(summary.diagnosisClass, "T4")
    }

    // MARK: - 筛选

    func testFiltersPartitionTheArchive() {
        let confirmed = EvidenceSummary.from(pack: pack(actConfirmed: true), fileBytes: 1)
        let unconfirmed = EvidenceSummary.from(pack: pack(actConfirmed: false), fileBytes: 1)
        let dirty = EvidenceSummary.from(pack: pack(contaminated: true), fileBytes: 1)
        let broken = EvidenceSummary.from(pack: pack(breaker: .channelFault), fileBytes: 1)
        let diagnosed = EvidenceSummary.from(pack: pack(diagnosisClass: .t9), fileBytes: 1)

        XCTAssertTrue(EvidenceFilter.all.matches(unconfirmed))
        XCTAssertTrue(EvidenceFilter.unconfirmed.matches(unconfirmed))
        XCTAssertFalse(EvidenceFilter.unconfirmed.matches(confirmed))
        XCTAssertTrue(EvidenceFilter.contaminated.matches(dirty))
        XCTAssertTrue(EvidenceFilter.breaker.matches(broken))
        XCTAssertFalse(EvidenceFilter.breaker.matches(confirmed))
        XCTAssertTrue(EvidenceFilter.diagnosed.matches(diagnosed))
        XCTAssertFalse(EvidenceFilter.assertionFailed.matches(confirmed),
                       "没有断言的记录不能算「断言未过」")
    }

    // MARK: - 测试残留判据

    private func entry(
        bundleId: String?,
        evidencePath: String?,
        displayName: String = "Proj"
    ) -> ProjectEntry {
        ProjectEntry(
            projectId: "prj_0123456789ABCDEFGHJKMNPQRS",
            displayName: displayName,
            bundleId: bundleId,
            evidenceStoragePath: evidencePath,
            createdAt: "2026-09-20T00:00:00.000Z"
        )
    }

    func testResidueRequiresBothSampleBundleAndTempPath() {
        let temp = NSTemporaryDirectory()
        XCTAssertTrue(
            LocalArchive.isTestResidue(entry(bundleId: "com.example.app", evidencePath: temp + "/x"))
        )
        XCTAssertFalse(
            LocalArchive.isTestResidue(entry(bundleId: "com.my.app", evidencePath: temp + "/x")),
            "真项目即使把证据放临时目录也不该被自动清掉"
        )
        XCTAssertFalse(
            LocalArchive.isTestResidue(entry(bundleId: "com.example.app", evidencePath: "/Users/me/ev"))
        )
        XCTAssertFalse(
            LocalArchive.isTestResidue(entry(bundleId: "com.example.app", evidencePath: nil))
        )
    }

    func testResidueCatchesRealTempRootForms() {
        let roots = LocalArchive.defaultTempRoots()
        XCTAssertTrue(roots.contains { NSTemporaryDirectory().hasPrefix($0) })
        for root in ["/tmp/", "/private/tmp/"] {
            XCTAssertTrue(
                LocalArchive.isTestResidue(entry(bundleId: "com.example.app", evidencePath: root + "gp")),
                "\(root) 形态的临时路径也要认出来"
            )
        }
    }

    // MARK: - 证据计数

    func testEvidenceCountDistinguishesMissingDirectory() {
        let dir = tempDir()
        write(pack(), to: dir)
        XCTAssertEqual(LocalArchive.evidenceCount(at: dir, fallback: dir), 1)
        XCTAssertNil(LocalArchive.evidenceCount(at: dir + "/gone", fallback: dir),
                     "目录不存在要返回 nil，而不是 0 条")
        XCTAssertEqual(LocalArchive.evidenceCount(at: nil, fallback: dir), 1,
                       "未配置路径时按默认目录计数")
    }

    // MARK: - 审批台账

    private func ledgerPath(withRecords count: Int) -> String {
        let dir = tempDir()
        let path = dir + "/approvals.json"
        let gate = ApprovalGate(path: path)
        for index in 0..<count {
            gate.append(
                operationRef: "snap_0123456789ABCDEFGHJKMNPQR\(index)",
                operationType: "restore",
                riskTier: index == 0 ? .high : .low,
                decision: .approve,
                approvedBy: ApprovalGate.autoApprover,
                reason: "restore executed: ffwd"
            )
        }
        return path
    }

    func testLedgerReportsIntactChain() {
        let report = LocalArchive.readApprovalLedger(path: ledgerPath(withRecords: 3))
        XCTAssertTrue(report.fileExists)
        XCTAssertFalse(report.loadFailed)
        XCTAssertTrue(report.chainValid)
        XCTAssertNil(report.firstBrokenIndex)
        XCTAssertEqual(report.records.count, 3)
        XCTAssertEqual(report.autoApprovedHighRiskCount, 1)
    }

    func testLedgerFlagsCorruptFileInsteadOfReadingItAsEmpty() {
        let dir = tempDir()
        let path = dir + "/approvals.json"
        try? Data("{ truncated".utf8).write(to: URL(fileURLWithPath: path))
        let report = LocalArchive.readApprovalLedger(path: path)
        XCTAssertTrue(report.fileExists)
        XCTAssertTrue(report.loadFailed, "损坏的台账不能读成「空但健康」")
        XCTAssertTrue(report.records.isEmpty)
    }

    func testLedgerMissingFileIsNotAFailure() {
        let report = LocalArchive.readApprovalLedger(path: tempDir() + "/absent.json")
        XCTAssertFalse(report.fileExists)
        XCTAssertFalse(report.loadFailed)
        XCTAssertTrue(report.chainValid)
    }

    // MARK: - 呈现辅助

    func testDisplayTimestampPassesThroughUnparsableValues() {
        XCTAssertEqual(
            LocalArchive.displayTimestamp(iso8601: "2026-09-14T12:00:00.000Z").count > 0, true
        )
        XCTAssertEqual(LocalArchive.displayTimestamp(iso8601: "not-a-date"), "not-a-date",
                       "解析不出原样给回，不编一个看起来合理的时间")
    }

    func testDisplayBytesUsesBinaryUnits() {
        XCTAssertEqual(LocalArchive.displayBytes(512), "512 B")
        XCTAssertEqual(LocalArchive.displayBytes(2048), "2.0 KB")
        XCTAssertEqual(LocalArchive.displayBytes(5 * 1024 * 1024), "5.0 MB")
    }

    /// 写入面的回执：命中 ≠ 删掉。面板曾经拿 `pruned`（当时等于命中数）说话，
    /// 部分失败时对着一份改了一半的注册表讲"已清理"或"保持原样"都是假的。
    func testPruneResultMessageSeparatesMatchedFromPruned() {
        XCTAssertTrue(LocalArchive.pruneResultMessage(
            cliRan: false, loadFailed: false, matched: 3, pruned: 0, failed: 0, needsRestart: false
        ).contains("注册表未改动"))
        XCTAssertTrue(LocalArchive.pruneResultMessage(
            cliRan: true, loadFailed: true, matched: 0, pruned: 0, failed: 0, needsRestart: false
        ).contains("读不开"))
        XCTAssertEqual(LocalArchive.pruneResultMessage(
            cliRan: true, loadFailed: false, matched: 0, pruned: 0, failed: 0, needsRestart: false
        ), "没有需要清理的测试残留项目。")
        let partial = LocalArchive.pruneResultMessage(
            cliRan: true, loadFailed: false, matched: 5, pruned: 3, failed: 2, needsRestart: true
        )
        XCTAssertTrue(partial.contains("3"), partial)
        XCTAssertTrue(partial.contains("2"), partial)
        XCTAssertFalse(partial.contains("保持原样"), "部分成功后不得说保持原样：\(partial)")
        XCTAssertTrue(partial.contains("仍在列表里"), partial)
        XCTAssertEqual(LocalArchive.pruneResultMessage(
            cliRan: true, loadFailed: false, matched: 4, pruned: 0, failed: 4, needsRestart: false
        ), "4 条都没能清理，注册表保持原样。")
    }

    /// 未知 id 与"拒绝覆写损坏表"必须分两句：后者意味着用户的档案坏了，
    /// 面板要说的是损坏，不是"没找到"。
    func testRemoveResultMessageSeparatesNotFoundFromRefusedWrite() {
        XCTAssertEqual(LocalArchive.removeResultMessage(
            cliRan: true, removed: true, loadFailed: false, needsRestart: true
        ), "已删除该项目。重启后台服务后，它内存里的旧列表才会同步。")
        XCTAssertEqual(LocalArchive.removeResultMessage(
            cliRan: true, removed: false, loadFailed: false, needsRestart: false
        ), "没找到这个项目，注册表未改动。")
        XCTAssertTrue(LocalArchive.removeResultMessage(
            cliRan: true, removed: false, loadFailed: true, needsRestart: false
        ).contains("读不开"))
    }
}
