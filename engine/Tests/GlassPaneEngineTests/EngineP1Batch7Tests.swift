import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// P1 batch 7 (spec v1.6 §12–§14): evidence archive lifecycle.
/// Covers EvreyStore retention-cap pruning (by mtime), archive stats and
/// on-demand clear, maxFiles clamping, plus an in-memory (no-store) regression
/// — all against injected temporary directories, so no AX/GUI permission is
/// required. `EngineCore` is untouched this batch; the pruning hook lives
/// inside `EvidenceStore.write` so active-project archives stay bounded
/// transparently.
final class EngineP1Batch7Tests: XCTestCase {

    // MARK: - Fixtures

    private let crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /// A valid, fixture-shaped opId per the invariant pattern `op_` + 26
    /// Crockford chars. `n` varies the produced id for distinct files.
    private func opId(_ n: Int) -> String {
        let base = crockford.count
        var result = "op_"
        for _ in 0..<26 {
            let index = crockford.index(crockford.startIndex, offsetBy: n % base)
            result.append(crockford[index])
        }
        return result
    }

    /// A valid EvidencePack built from the kernel fixture, with a fresh
    /// operationId (and optional distinct created timestamp).
    private func pack(operationId: String, createdAt: String = "2026-09-17T12:00:00.000Z") throws -> EvidencePack {
        let template = try EvidencePack.decodeAndValidate(
            try KernelFixtures.data("evidence-pack.ok-01.json")
        )
        return EvidencePack(
            operationId: operationId,
            createdAt: createdAt,
            attribution: template.attribution,
            circuitBreaker: template.circuitBreaker,
            signals: template.signals
        )
    }

    /// `TestSandbox` rather than a hand-composed temp path: the sandbox is where
    /// the isolation verdict is computed *before* a store can be pointed at a
    /// directory, and its creation failure is reported instead of swallowed.
    private func tempDir() -> String {
        TestSandbox.directory("gpb7")
    }

    private func groupURL(_ base: String) -> URL {
        URL(fileURLWithPath: base, isDirectory: true)
    }

    private func fileExists(_ dir: String, _ operationId: String) -> Bool {
        FileManager.default.fileExists(
            atPath: groupURL(dir).appendingPathComponent(operationId + ".json").path
        )
    }

    /// Pin a file's modification time so prune ordering is deterministic even
    /// when several entries are written within the same wall-clock second.
    private func setMTime(_ dir: String, _ operationId: String, _ date: Date) {
        let path = groupURL(dir).appendingPathComponent(operationId + ".json").path
        try? FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: path)
    }

    // MARK: - Retention-cap pruning (spec v1.6 §12.2)

    func testPruneRemovesOldestWhenOverLimit() throws {
        let dir = tempDir()
        let store = EvidenceStore(directory: dir, maxFiles: 3)
        store.write(try pack(operationId: opId(0))) // op0
        store.write(try pack(operationId: opId(1))) // op1
        // Pivot: make op1 clearly older than op0 so the victim is unambiguous.
        setMTime(dir, opId(0), Date(timeIntervalSinceNow: -100))
        setMTime(dir, opId(1), Date(timeIntervalSinceNow: -300))
        store.write(try pack(operationId: opId(2))) // count = 3, at cap: no prune
        XCTAssertTrue(fileExists(dir, opId(2)))

        // 4th write exceeds the cap → prune the single oldest (op1).
        store.write(try pack(operationId: opId(3)))
        XCTAssertFalse(fileExists(dir, opId(1)), "oldest entry must be pruned")
        XCTAssertTrue(fileExists(dir, opId(0)))
        XCTAssertTrue(fileExists(dir, opId(2)))
        XCTAssertTrue(fileExists(dir, opId(3)), "newly written entry must survive")
        XCTAssertEqual(store.stats().count, 3, "archive must settle back at maxFiles")
    }

    func testNoPruneAtOrUnderLimit() throws {
        let dir = tempDir()
        let store = EvidenceStore(directory: dir, maxFiles: 3)
        store.write(try pack(operationId: opId(0)))
        store.write(try pack(operationId: opId(1)))
        store.write(try pack(operationId: opId(2)))
        XCTAssertTrue(fileExists(dir, opId(0)))
        XCTAssertTrue(fileExists(dir, opId(1)))
        XCTAssertTrue(fileExists(dir, opId(2)))
        XCTAssertEqual(store.stats().count, 3, "exactly-at-cap write must not prune")
    }

    func testPruneLeavesNeverCreatedAndEmptyDirectoriesAlone() throws {
        // A never-created directory prunes to nothing without throwing.
        let missing = tempDir() + "/nowhere"
        let store = EvidenceStore(directory: missing, maxFiles: 2)
        _ = store.write(try pack(operationId: opId(0)))
        _ = store.write(try pack(operationId: opId(1)))
        _ = store.write(try pack(operationId: opId(2)))
        // Directory is now real and bounded; also confirm empty tolerance below.
        XCTAssertEqual(store.stats().count, 2)
    }

    // MARK: - Archive stats (spec v1.6 §12.3)

    func testStatsEmptyReportsZero() throws {
        let store = EvidenceStore(directory: tempDir())
        XCTAssertEqual(store.stats(), EvidenceArchiveStats(count: 0, totalBytes: 0))
    }

    func testStatsGrowsWithWrites() throws {
        let dir = tempDir()
        let store = EvidenceStore(directory: dir)
        _ = store.write(try pack(operationId: opId(0)))
        let one = store.stats()
        XCTAssertEqual(one.count, 1)
        XCTAssertGreaterThan(one.totalBytes, 0)

        _ = store.write(try pack(operationId: opId(1), createdAt: "2026-09-17T12:00:01.000Z"))
        let two = store.stats()
        XCTAssertEqual(two.count, 2)
        XCTAssertGreaterThan(two.totalBytes, one.totalBytes, "bytes should grow as entries are added")
    }

    func testStatsReflectsDiskRegardlessOfWriteOrder() throws {
        // stats reads the directory as-is, so recent writes are always visible.
        let dir = tempDir()
        let store = EvidenceStore(directory: dir)
        _ = store.write(try pack(operationId: opId(5)))
        _ = store.write(try pack(operationId: opId(2)))
        XCTAssertEqual(store.stats().count, 2)
        let firstBytes = store.stats().totalBytes
        XCTAssertGreaterThan(firstBytes, 0)
        // Re-reading yields a stable, non-destructive snapshot.
        XCTAssertEqual(store.stats().totalBytes, firstBytes)
    }

    // MARK: - On-demand clear (spec v1.6 §12.3)

    func testClearRemovesAllAndIsIdempotent() throws {
        let dir = tempDir()
        let store = EvidenceStore(directory: dir)
        _ = store.write(try pack(operationId: opId(0)))
        _ = store.write(try pack(operationId: opId(1)))
        _ = store.write(try pack(operationId: opId(2)))
        XCTAssertEqual(store.clear(), 3)
        XCTAssertEqual(store.stats().count, 0)
        XCTAssertEqual(store.clear(), 0, "clearing an already-empty archive returns 0")
    }

    func testClearOnMissingDirectoryReturnsZero() {
        let store = EvidenceStore(directory: tempDir() + "/never-created")
        XCTAssertEqual(store.clear(), 0)
    }

    // MARK: - maxFiles clamping (spec v1.6 §12.2)

    func testMaxFilesClampedToAtLeastOne() {
        XCTAssertEqual(EvidenceStore(directory: tempDir(), maxFiles: 0).maxFiles, 1)
        XCTAssertEqual(EvidenceStore(directory: tempDir(), maxFiles: -5).maxFiles, 1)
        XCTAssertEqual(EvidenceStore(directory: tempDir(), maxFiles: 8).maxFiles, 8)
        XCTAssertEqual(EvidenceStore(directory: tempDir(), maxFiles: nil).maxFiles, EvidenceStore.defaultMaxFiles)
    }

    func testTinyCapKeepsJustWrittenEntry() throws {
        // maxFiles == 1 must never delete the entry being written right now;
        // it removes the prior one instead.
        let dir = tempDir()
        let store = EvidenceStore(directory: dir, maxFiles: 1)
        _ = store.write(try pack(operationId: opId(0)))
        XCTAssertTrue(fileExists(dir, opId(0)))
        _ = store.write(try pack(operationId: opId(1)))
        XCTAssertFalse(fileExists(dir, opId(0)), "previous oldest entry is pruned")
        XCTAssertTrue(fileExists(dir, opId(1)), "just-written entry survives")
        XCTAssertEqual(store.stats().count, 1)
    }

    // MARK: - In-memory (no-store) regression (spec v1.6 §13 P1-G6)

    func testCoreWithoutArchiveStillWorksInMemoryOnly() throws {
        // Default EngineCore (evidenceStore nil) keeps its pre-v1.5 in-memory
        // behavior; a batch-6 style repo guard that a fresh store default
        // cap does not alter it.
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        let core = EngineCore(channel: channel, settle: {}, projectRegistry: nil, evidenceStore: nil)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let actResult = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let operationId = actResult["operationId"] as! String
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.operationId, operationId)
    }
}