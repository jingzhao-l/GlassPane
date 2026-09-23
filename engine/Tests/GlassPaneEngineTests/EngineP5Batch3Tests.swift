import XCTest
import Foundation
@testable import GlassPaneEngine

/// P5 批三：保留策略按天数/项目维度（spec v5.0 §9，验收 P5-C1..C6）。
///
/// 时钟策略：所有用例注入固定 `now`（2027-01-15 UTC）。磁盘上文件的真实
/// mtime 是测试运行当刻（真实日历时间），相对注入时钟恒为"过去"——这恰好
/// 让"createdAt 优先 / 损坏回退 mtime"两条判定路径都能写出可判定用例。
final class EngineP5Batch3Tests: XCTestCase {

    private let injectedNow = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: - Fixtures

    private func iso(_ date: Date) -> String {
        EvidenceStore.isoDateFormatter.string(from: date)
    }

    private func daysAgo(_ days: Int) -> String {
        iso(injectedNow.addingTimeInterval(-TimeInterval(days) * 86_400))
    }

    private func opId(_ seed: UInt64) -> String {
        OperationID.generate(
            milliseconds: seed,
            entropy: [UInt8](repeating: UInt8(seed & 0xFF), count: 10),
            prefix: "op_"
        )
    }

    private func pack(createdAt: String, seed: UInt64) -> EvidencePack {
        EvidencePack(
            operationId: opId(seed),
            createdAt: createdAt,
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "X"),
                    action: .press,
                    actConfirmed: true
                )
            )
        )
    }

    /// 写盘用的存储默认无 TTL——写时修剪是独立判定的（P5-C4 有专项用例），
    /// 常规 TTL 用例用 `prune(olderThanDays:)` 一次性阈值显式触发。
    private func makeStore(
        dir: String,
        maxAgeDays: Int? = nil
    ) -> EvidenceStore {
        EvidenceStore(directory: dir, maxAgeDays: maxAgeDays, now: { self.injectedNow })
    }

    /// Every scratch directory in this file goes through `TestSandbox`, so the
    /// isolation verdict (`TestSupport.assertIsolated`) is computed before a
    /// store can be pointed at a path — a local `temporaryDirectory` here was a
    /// route around the gate that W5-A exists to close, and `EvidenceStore`
    /// deletes from whatever directory it is handed.
    private func makeTempDir(_ name: String) throws -> String {
        TestSandbox.directory("p5-b3-\(name)")
    }

    // MARK: - P5-C1 TTL pruning

    func testPruneRemovesAgedKeepsFresh() throws {
        let dir = try makeTempDir("ttl")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = makeStore(dir: dir)

        XCTAssertTrue(store.write(pack(createdAt: daysAgo(40), seed: 1)))
        XCTAssertTrue(store.write(pack(createdAt: daysAgo(10), seed: 2)))
        XCTAssertEqual(store.stats().count, 2)

        let removed = store.prune(olderThanDays: 30)
        XCTAssertEqual(removed, 1, "the 40-day-old entry must be pruned")
        XCTAssertEqual(store.stats().count, 1)
        XCTAssertNotNil(store.read(operationId: opId(2)), "the fresh entry must survive")
        XCTAssertNil(store.read(operationId: opId(1)))
    }

    func testPruneExactlyAtBoundaryKeepsEntry() throws {
        let dir = try makeTempDir("boundary")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = makeStore(dir: dir)
        // 30 days exactly: age > maxAgeDays is strict, so the boundary stays.
        XCTAssertTrue(store.write(pack(createdAt: daysAgo(30), seed: 7)))
        XCTAssertEqual(store.prune(olderThanDays: 30), 0)
        XCTAssertEqual(store.stats().count, 1)
    }

    // MARK: - P5-C2 clamping

    func testZeroAndNegativeMaxAgeDaysClampToDisabled() throws {
        for value in [0, -1, -100] {
            let dir = try makeTempDir("clamp\(value)")
            defer { try? FileManager.default.removeItem(atPath: dir) }
            let store = EvidenceStore(directory: dir, maxAgeDays: value, now: { self.injectedNow })
            XCTAssertNil(store.maxAgeDays, "maxAgeDays \(value) must clamp to disabled")
            XCTAssertTrue(store.write(pack(createdAt: daysAgo(400), seed: 1)))
            XCTAssertEqual(store.prune(olderThanDays: value), 0, "clamped values must not prune")
            XCTAssertEqual(store.stats().count, 1, "aged entry must survive a disabled TTL")
        }
    }

    func testSetRetentionRestoresAndClamps() throws {
        let dir = try makeTempDir("retention")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = EvidenceStore(directory: dir, now: { self.injectedNow })
        XCTAssertNil(store.maxAgeDays)

        store.setRetention(maxAgeDays: 7)
        XCTAssertEqual(store.maxAgeDays, 7)
        store.setRetention(maxAgeDays: 0)
        XCTAssertNil(store.maxAgeDays, "0 must clamp back to disabled")
    }

    // MARK: - P5-C3 expiry basis

    func testCreatedAtTakesPriorityOverMtime() throws {
        let dir = try makeTempDir("createdat-prio")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = makeStore(dir: dir)
        // Fresh by createdAt (10 days < 30) but old by mtime (real wall clock
        // is days before the injected now) — createdAt must win → kept.
        XCTAssertTrue(store.write(pack(createdAt: daysAgo(10), seed: 3)))
        let mtime = (try? FileManager.default.attributesOfItem(
            atPath: dir + "/" + opId(3) + ".json"
        )[.modificationDate] as? Date)
        XCTAssertNotNil(mtime)
        XCTAssertLessThan(mtime!, injectedNow, "precondition: mtime older than injected now")

        XCTAssertEqual(store.prune(olderThanDays: 30), 0)
        XCTAssertEqual(store.stats().count, 1, "createdAt (fresh) governs over mtime (old)")
    }

    func testCorruptEntryFallsBackToMtime() throws {
        let dir = try makeTempDir("corrupt")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = makeStore(dir: dir)
        XCTAssertTrue(store.write(pack(createdAt: daysAgo(10), seed: 4)))
        // Corrupt the file: read() now yields nil, so age falls back to mtime,
        // which is old relative to the injected now → expired.
        let fileURL = URL(fileURLWithPath: dir + "/" + opId(4) + ".json")
        try Data("{corrupt".utf8).write(to: fileURL)

        let removed = store.prune(olderThanDays: 30)
        XCTAssertEqual(removed, 1, "corrupt entry must be removable via mtime fallback")
        XCTAssertEqual(store.stats().count, 0)
    }

    // MARK: - P5-C4 write-time pruning

    func testWriteTimePruneTriggersWithTtl() throws {
        let dir = try makeTempDir("writeprune")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        // Seed an aged entry through the legacy (no-TTL) write path, then a
        // TTL-configured store's fresh write must clear it.
        let legacy = makeStore(dir: dir)
        XCTAssertTrue(legacy.write(pack(createdAt: daysAgo(40), seed: 1)))
        XCTAssertEqual(legacy.stats().count, 1)

        let ttlStore = makeStore(dir: dir, maxAgeDays: 30)
        XCTAssertTrue(ttlStore.write(pack(createdAt: daysAgo(1), seed: 2)))
        XCTAssertEqual(legacy.stats().count, 1, "write-time TTL must remove the aged entry")
        XCTAssertNotNil(legacy.read(operationId: opId(2)))
    }

    func testWriteTimePruneOffByDefault() throws {
        let dir = try makeTempDir("no-ttl")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        // Default maxAgeDays nil — legacy "full archive never expires".
        let store = EvidenceStore(directory: dir, now: { self.injectedNow })
        XCTAssertTrue(store.write(pack(createdAt: daysAgo(400), seed: 1)))
        XCTAssertTrue(store.write(pack(createdAt: daysAgo(1), seed: 2)))
        XCTAssertEqual(store.stats().count, 2, "no TTL config → no write-time expiry")
    }

    // MARK: - P5-C1 count/prune contract

    func testCountExpiredMatchesPrune() throws {
        let dir = try makeTempDir("count")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = makeStore(dir: dir)
        XCTAssertTrue(store.write(pack(createdAt: daysAgo(40), seed: 1)))
        XCTAssertTrue(store.write(pack(createdAt: daysAgo(10), seed: 2)))
        XCTAssertEqual(store.countExpired(olderThanDays: 30), 1)
        XCTAssertEqual(store.prune(olderThanDays: 30), 1)
        XCTAssertEqual(store.countExpired(olderThanDays: 30), 0)
    }

    func testPruneMissingDirectoryReturnsZero() throws {
        // A path *inside* the sandbox that was never created: the case under
        // test is "this directory does not exist", not "this path was never
        // checked", so it still goes through `TestSandbox`.
        let missing = TestSandbox.directory("missing") + "/absent-\(UUID().uuidString)"
        let store = makeStore(dir: missing)
        XCTAssertEqual(store.prune(olderThanDays: 30), 0)
        XCTAssertEqual(store.countExpired(olderThanDays: 30), 0)
        XCTAssertEqual(store.stats().count, 0)
    }

    // MARK: - P5-C5 project-dimension maintenance

    func testPruneEvidenceProjectIsolation() throws {
        let dirA = try makeTempDir("projA")
        let dirB = try makeTempDir("projB")
        let dirActive = try makeTempDir("projActive")
        let regPath = try makeTempDir("registry") + "/projects.json"
        defer {
            try? FileManager.default.removeItem(atPath: dirA)
            try? FileManager.default.removeItem(atPath: dirB)
            try? FileManager.default.removeItem(atPath: dirActive)
            try? FileManager.default.removeItem(atPath: regPath)
        }
        let registry = ProjectRegistry(filePath: regPath)
        let projectA = try registry.create(
            displayName: "A", bundleId: "com.a", evidenceStoragePath: dirA
        )
        _ = try registry.create(displayName: "B", bundleId: "com.b", evidenceStoragePath: dirB)

        let storeA = EvidenceStore(directory: dirA, now: { self.injectedNow })
        let storeB = EvidenceStore(directory: dirB, now: { self.injectedNow })
        XCTAssertTrue(storeA.write(pack(createdAt: daysAgo(40), seed: 1)))
        XCTAssertTrue(storeA.write(pack(createdAt: daysAgo(10), seed: 2)))
        XCTAssertTrue(storeB.write(pack(createdAt: daysAgo(40), seed: 3)))

        // The engine's *own* archive — a third directory this call never named.
        // This case used to inject no store at all, so it proved nothing about
        // the active archive; naming one turns the same call into a proof that a
        // project-dimension prune stays inside that project's directory (and the
        // store-less engine is pinned by its own case below).
        let activeStore = EvidenceStore(directory: dirActive, now: { self.injectedNow })
        XCTAssertTrue(activeStore.write(pack(createdAt: daysAgo(40), seed: 9)))

        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            clock: { self.injectedNow },
            projectRegistry: registry,
            evidenceStore: activeStore
        )
        let removed = try core.pruneEvidence(projectId: projectA.projectId, olderThanDays: 30)
        XCTAssertEqual(removed, 1, "only project A's aged entry is pruned")

        XCTAssertEqual(EvidenceStore(directory: dirA).stats().count, 1)
        XCTAssertEqual(EvidenceStore(directory: dirB).stats().count, 1, "project B untouched")
        XCTAssertNotNil(EvidenceStore(directory: dirA).read(operationId: opId(2)))
        XCTAssertEqual(
            activeStore.stats().count, 1,
            "the archive injected into the engine is not a project's substitute either"
        )
        XCTAssertNotNil(activeStore.read(operationId: opId(9)))
    }

    func testPruneEvidenceUnknownProjectThrowsNotFound() throws {
        let regPath = try makeTempDir("unknown") + "/projects.json"
        defer { try? FileManager.default.removeItem(atPath: regPath) }
        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            projectRegistry: ProjectRegistry(filePath: regPath)
        )
        XCTAssertThrowsError(try core.pruneEvidence(projectId: "prj_unknown", olderThanDays: 30)) { error in
            guard let gpError = error as? GPError else {
                return XCTFail("expected GPError")
            }
            XCTAssertEqual(gpError.code, .notFound)
        }
    }

    /// The one legitimate reading of a nil `projectId`: the archive *this*
    /// instance was handed. It has to be a real injected store — the case below
    /// pins what happens when there is none.
    func testPruneEvidenceNilUsesActiveStoreDirectory() throws {
        let dir = try makeTempDir("nilpath")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let activeStore = EvidenceStore(directory: dir, now: { self.injectedNow })
        XCTAssertTrue(activeStore.write(pack(createdAt: daysAgo(40), seed: 1)))

        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            clock: { self.injectedNow },
            evidenceStore: activeStore
        )
        let removed = try core.pruneEvidence(projectId: nil, olderThanDays: 30)
        XCTAssertEqual(removed, 1)
        XCTAssertEqual(activeStore.stats().count, 0)
    }

    /// An engine built with **no archive injected** has no directory to prune.
    /// `pruneEvidence(projectId: nil)` used to fold that absence into the shared
    /// default archive and delete aged entries from it — the substitution
    /// `noArchiveRefusal` refuses from the project side, reached here by
    /// *omitting* an argument, which is why no path-shaped rule saw it and why a
    /// `swift test` run was one argument away from the developer's real archive.
    /// No store now means no disk side effect, and the refusal names both ways
    /// to point at an archive.
    func testPruneEvidenceWithNoStoreRefusesInsteadOfReachingTheSharedArchive() throws {
        let dir = try makeTempDir("no-store")
        let regPath = try makeTempDir("no-store-registry") + "/projects.json"
        defer {
            try? FileManager.default.removeItem(atPath: dir)
            try? FileManager.default.removeItem(atPath: regPath)
        }
        let registry = ProjectRegistry(filePath: regPath)
        let project = try registry.create(
            displayName: "Owned", bundleId: "com.owned", evidenceStoragePath: dir
        )
        let seeded = makeStore(dir: dir)
        XCTAssertTrue(seeded.write(pack(createdAt: daysAgo(40), seed: 1)))
        XCTAssertTrue(seeded.write(pack(createdAt: daysAgo(1), seed: 2)))

        // `evidenceStore` is left out entirely: that is the "no archive
        // configured" instance the daemon never builds and the tests do.
        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            clock: { self.injectedNow },
            projectRegistry: registry
        )
        XCTAssertThrowsError(try core.pruneEvidence(projectId: nil, olderThanDays: 30)) { error in
            guard let gpError = error as? GPError else {
                return XCTFail("expected a GPError, got \(error)")
            }
            XCTAssertEqual(gpError.code, .badParams, "the frozen code of every archive-scope refusal")
            XCTAssertEqual(
                gpError.message, EngineCore.noStoreArchiveRefusal().message,
                "one wording for the same refusal, so a call site cannot paraphrase the fallback back in"
            )
            XCTAssertTrue(gpError.message.contains("nothing was deleted"), gpError.message)
            XCTAssertTrue(
                gpError.remedy.contains("--prune-evidence"),
                "the remedy must name the surface that does own the shared archive: \(gpError.remedy)"
            )
            XCTAssertTrue(
                gpError.remedy.contains("gp_project_set"),
                "…and the way to give this instance a project-scoped one: \(gpError.remedy)"
            )
        }
        // A refusal, not a silent no-op pass: both entries still stand.
        XCTAssertEqual(makeStore(dir: dir).stats().count, 2)
        // Naming an archive still prunes, so the guard did not lock the surface.
        XCTAssertEqual(try core.pruneEvidence(projectId: project.projectId, olderThanDays: 30), 1)
        XCTAssertEqual(makeStore(dir: dir).stats().count, 1)

        // The sibling refusal — a project that named no directory of its own —
        // must not send the reader to "leave projectId out" as an unqualified
        // route either: on an instance with no archive that is exactly the call
        // this case refuses above.
        let homeless = try registry.create(displayName: "Homeless", bundleId: "com.homeless")
        let sibling = EngineCore.noArchiveRefusal(projectId: homeless.projectId)
        XCTAssertFalse(
            sibling.remedy.contains("by leaving projectId out of the call"),
            sibling.remedy
        )
        XCTAssertTrue(sibling.remedy.contains("--prune-evidence"), sibling.remedy)
    }
}

/// The two `rollback_full` remedies tell an agent which fields of
/// `gp_probe_status` to read before it spends another act against the socket.
/// Round 2's A-10 moved the drop history out of the live `probes` list into a
/// top-level `recentDisconnections` and turned `disconnections` into a plain
/// count, which left both sites advising a read that now returns an integer and
/// an all-true list — an agent concluding the probe is alive. This pins the
/// advice against the shape the surface actually publishes. Its natural home is
/// `HumanInterventionAuditTests` (the R2-13 phantom-remedy gate); it lives here
/// because that file belongs to another batch this round.
final class EngineTier1RemedyFieldTests: XCTestCase {

    private func repoSource(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // engine
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// What `probeStatus()` publishes after A-10.
    func testStatusSurfacePublishesADropHistoryAndACount() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(ProbeHello(
            pid: 4242, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.1.0", capabilities: ["z1"]
        ))
        inbox.disconnect(pid: 4242, reason: "connection closed")
        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            settle: {},
            probeInbox: inbox
        )
        let status = core.probeStatus()
        XCTAssertNotNil(status["disconnections"] as? Int, "`disconnections` is a count")
        XCTAssertTrue(
            ((status["probes"] as? [[String: Any]]) ?? []).isEmpty,
            "a dropped probe is not a live registration"
        )
        let rows = try XCTUnwrap(status["recentDisconnections"] as? [[String: Any]])
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row["disconnectReason"] as? String, "connection closed")
        XCTAssertNotNil(row["disconnectedAt"] as? String)
        XCTAssertEqual(row["drops"] as? Int, 1)
    }

    /// What the shipped remedies say to read — the two sites are every mention
    /// of the method in the file, so a third one that forgets the rule is
    /// reported rather than assumed.
    func testTier1RemediesNameTheDropHistoryNotTheLiveRows() throws {
        let source = try repoSource("engine/Sources/GlassPaneEngine/EngineCore.swift")
        let remedyLines = source.components(separatedBy: "\n")
            .filter { $0.contains("gp_probe_status") }
        XCTAssertEqual(
            remedyLines.count, 2,
            "every gp_probe_status remedy is pinned below; a new one needs its own check"
        )
        for line in remedyLines {
            XCTAssertTrue(line.contains("recentDisconnections"), line)
            XCTAssertTrue(line.contains("disconnectReason"), line)
            XCTAssertTrue(line.contains("`drops`"), line)
            XCTAssertTrue(
                line.contains("only the total number of drops"),
                "`disconnections` must be described as the count it is: \(line)"
            )
            XCTAssertFalse(
                line.contains("each row's"),
                "the per-row `connected` flag no longer distinguishes anything: \(line)"
            )
            XCTAssertFalse(
                line.contains("`connected` flag"),
                "the drop history left `probes` with A-10: \(line)"
            )
        }
    }
}
