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

    private func makeTempDir(_ name: String) throws -> String {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("p5-b3-\(name)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
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
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("p5-b3-missing-\(UUID().uuidString)")
            .path
        let store = makeStore(dir: missing)
        XCTAssertEqual(store.prune(olderThanDays: 30), 0)
        XCTAssertEqual(store.countExpired(olderThanDays: 30), 0)
        XCTAssertEqual(store.stats().count, 0)
    }

    // MARK: - P5-C5 project-dimension maintenance

    func testPruneEvidenceProjectIsolation() throws {
        let dirA = try makeTempDir("projA")
        let dirB = try makeTempDir("projB")
        let regPath = try makeTempDir("registry") + "/projects.json"
        defer {
            try? FileManager.default.removeItem(atPath: dirA)
            try? FileManager.default.removeItem(atPath: dirB)
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

        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            clock: { self.injectedNow },
            projectRegistry: registry,
            evidenceStore: nil
        )
        let removed = try core.pruneEvidence(projectId: projectA.projectId, olderThanDays: 30)
        XCTAssertEqual(removed, 1, "only project A's aged entry is pruned")

        XCTAssertEqual(EvidenceStore(directory: dirA).stats().count, 1)
        XCTAssertEqual(EvidenceStore(directory: dirB).stats().count, 1, "project B untouched")
        XCTAssertNotNil(EvidenceStore(directory: dirA).read(operationId: opId(2)))
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

    /// 没有档案的核心**不许**去删 `~/.glasspane/evidence/`。
    /// 这是 A-1 的同形缺陷、后果更重的一版：一旦"没注入档案"回落到活目录，
    /// 任何一个个测调用删档接口就会不可逆地清掉用户的真实证据档案。
    func testPruneWithoutArchiveRefusesInsteadOfTouchingLiveArchive() throws {
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard))
        XCTAssertThrowsError(try core.pruneEvidence(projectId: nil, olderThanDays: 1)) { error in
            let gpError = error as! GPError
            XCTAssertEqual(gpError.code, .internalError)
            XCTAssertTrue(gpError.message.contains("no evidence archive"), gpError.message)
        }
    }

    /// A-2 复位的落点是"本实例构造时的目录"，不是家目录常量：
    /// 否则"attach 一个没配证据路径的项目"就把注入的临时档案重定向到真实档案。
    func testAttachWithoutStoragePathResetsToTheStoresOwnDefault() throws {
        let dirA = try makeTempDir("reset-a")
        let dirB = try makeTempDir("reset-b")
        defer {
            try? FileManager.default.removeItem(atPath: dirA)
            try? FileManager.default.removeItem(atPath: dirB)
        }
        let registry = ProjectRegistry(filePath: dirA + "/projects.json")
        let withPath = try registry.create(
            displayName: "With", bundleId: "com.example.app", pid: nil,
            recipeConfigPath: nil, calibrationAssetsPath: nil, evidenceStoragePath: dirB,
            now: { self.injectedNow }
        )
        let noPath = try registry.create(
            displayName: "NoPath", bundleId: "com.example.app", pid: nil,
            recipeConfigPath: nil, calibrationAssetsPath: nil, evidenceStoragePath: nil,
            now: { self.injectedNow }
        )
        let store = EvidenceStore(directory: dirA)
        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            projectRegistry: registry,
            evidenceStore: store
        )

        _ = try core.attach(bundleId: "com.example.app", pid: nil, projectId: withPath.projectId)
        XCTAssertEqual(store.directory, dirB)
        _ = try core.attach(bundleId: "com.example.app", pid: nil, projectId: noPath.projectId)
        XCTAssertEqual(store.directory, dirA, "复位必须回到本实例的构造目录")
        XCTAssertFalse(store.directory.contains("/.glasspane/"), store.directory)
    }
}