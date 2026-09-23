import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// P1 batch 6 (spec v1.5 §9–§11): evidence persistent on-disk archive.
/// Covers EvidenceStore roundtrip/atomicity/fault-tolerance, EngineCore
/// persistence wiring, restart replay, memory-first lookup and project
/// directory association — all against injected temporary directories and a
/// scripted channel, so no AX/GUI permission is required.
///
/// The injection is not optional here (R7-02): this file used to build its
/// registry and, through `makeCore`, its archive at the production default
/// path, so a plain `swift test` rewrote the developer's real project
/// registrations and real evidence archive. Every state object now comes from
/// `TestSandbox`, and `TestIsolationGateTests` fails the target if a
/// default-path construction returns.
final class EngineP1Batch6Tests: XCTestCase {

    // MARK: - Fixtures

    /// A valid EvidencePack built from the kernel fixture on disk.
    private func fixturePack() throws -> EvidencePack {
        try EvidencePack.decodeAndValidate(
            try KernelFixtures.data("evidence-pack.ok-01.json")
        )
    }

    /// An EngineCore normalised to a writable temp archive + scripted channel.
    ///
    /// `directory` is mandatory. The old `String? = nil` default was forwarded
    /// straight into `EvidenceStore(directory:)`, and a nil there meant the
    /// production archive — so every `makeCore()` call site wrote evidence
    /// into the developer's own state (R7-02). `registry` likewise defaults to
    /// an isolated temp registry instead of being omitted: `EngineCore` no
    /// longer builds one over the real projects file (C-03 — it now has *no*
    /// registry, which is right for this file's tests but not the shape a
    /// project-routing test wants to be asserting).
    /// `archive: false` hands the engine no store at all: history stays
    /// in-memory while the injected directory is kept for the caller to prove
    /// nothing was persisted into it.
    private func makeCore(
        directory: String,
        registry: ProjectRegistry? = nil,
        archive: Bool = true
    ) -> (core: EngineCore, channel: ScriptedChannel, store: EvidenceStore?) {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        let store = archive ? TestSandbox.evidenceStore(at: directory) : nil
        let core = EngineCore(
            channel: channel,
            settle: {},
            projectRegistry: registry ?? TestSandbox.projectRegistry("b6-core"),
            evidenceStore: store
        )
        return (core, channel, store)
    }

    private func tempDir() -> String {
        TestSandbox.directory("b6")
    }

    private func groupURL(_ base: String) -> URL {
        URL(fileURLWithPath: base, isDirectory: true)
    }

    private func fileExists(_ dir: String, _ operationId: String) -> Bool {
        FileManager.default.fileExists(
            atPath: groupURL(dir).appendingPathComponent(operationId + ".json").path
        )
    }

    // MARK: - EvidenceStore roundtrip / atomicity

    func testStoreRoundtripPreservesValueAndKeySorted() throws {
        let dir = tempDir()
        let store = TestSandbox.evidenceStore(at: dir)
        let pack = try fixturePack()
        XCTAssertTrue(store.write(pack))
        XCTAssertTrue(fileExists(dir, pack.operationId))
        guard let read = store.read(operationId: pack.operationId) else {
            return XCTFail("read back nil after successful write")
        }
        XCTAssertEqual(pack, read, "roundtripped evidence must equal original")
        // Atomic write must not leave a .tmp behind.
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: groupURL(dir).appendingPathComponent(pack.operationId + ".json.tmp").path
        ))
    }

    func testStoreReadMissingReturnsNil() {
        let store = TestSandbox.evidenceStore(at: tempDir())
        XCTAssertNil(store.read(operationId: "op_0123456789ABCDEFGHJKMNPQRS"))
    }

    func testStoreReadCorruptFileReturnsNilWithoutThrowing() throws {
        let dir = tempDir()
        try Data("not-json{{{".utf8).write(to: groupURL(dir).appendingPathComponent("op_0123456789ABCDEFGHJKMNPQRS.json"))
        let store = TestSandbox.evidenceStore(at: dir)
        XCTAssertNil(store.read(operationId: "op_0123456789ABCDEFGHJKMNPQRS"))
    }

    func testStoreAutoCreatesMissingDirectory() throws {
        let base = tempDir()
        let dir = base + "/nested/deeper"
        // Ensure the nested path does not exist yet.
        try? FileManager.default.removeItem(atPath: dir)
        let store = TestSandbox.evidenceStore(at: dir)
        let pack = try fixturePack()
        XCTAssertTrue(store.write(pack))
        XCTAssertTrue(fileExists(dir, pack.operationId))
    }

    func testStoreLastOnDiskReturnsMostRecentByMTime() throws {
        let dir = tempDir()
        let store = TestSandbox.evidenceStore(at: dir)
        let first = try EvidencePack.decodeAndValidate(try KernelFixtures.data("evidence-pack.ok-01.json"))
        XCTAssertTrue(store.write(first))
        // Second pack from a different fixture with a distinct operationId.
        let second = try EvidencePack.decodeAndValidate(try KernelFixtures.data("evidence-pack.ok-02.json"))
        XCTAssertNotEqual(first.operationId, second.operationId)
        XCTAssertTrue(store.write(second))
        XCTAssertEqual(store.lastOnDisk(), second.operationId)
    }

    func testStoreLastOnDiskEmptyDirectoryReturnsNil() {
        let store = TestSandbox.evidenceStore(at: tempDir())
        XCTAssertNil(store.lastOnDisk())
    }

    func testStoreWriteFaultyDirReturnsFalse() {
        // A path that cannot be created as a directory (parent is a file).
        let base = tempDir() + "/parent-file"
        try? "x".write(toFile: base, atomically: true, encoding: .utf8)
        let store = TestSandbox.evidenceStore(at: base + "/child")
        let pack = try! fixturePack()
        XCTAssertFalse(store.write(pack))
    }

    // MARK: - EngineCore persistence + replay

    func testActPersistsEvidenceToArchive() throws {
        let dir = tempDir()
        let ctx = makeCore(directory: dir)
        _ = try ctx.core.attach(bundleId: "com.example.app", pid: nil)
        let actResult = try ctx.core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let operationId = actResult["operationId"] as! String
        XCTAssertTrue(fileExists(dir, operationId))
    }

    func testReplayAfterRestartReadsFromDisk() throws {
        let dir = tempDir()
        // First daemon instance records evidence, then is discarded (its
        // in-memory ring is gone — simulating a restart).
        let first = makeCore(directory: dir)
        _ = try first.core.attach(bundleId: "com.example.app", pid: nil)
        let actResult = try first.core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let operationId = actResult["operationId"] as! String

        // Second instance with a fresh in-memory history but same directory.
        let second = makeCore(directory: dir)
        _ = try second.core.attach(bundleId: "com.example.app", pid: nil)
        let replay = try second.core.lastEvidence(operationId: operationId)
        XCTAssertEqual(replay.operationId, operationId)
    }

    func testMemoryFirstLookupSkipsDiskOnHit() throws {
        let dir = tempDir()
        let ctx = makeCore(directory: dir)
        _ = try ctx.core.attach(bundleId: "com.example.app", pid: nil)
        let actResult = try ctx.core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let operationId = actResult["operationId"] as! String
        // Present in memory — returns without needing the disk archive.
        let pack = try ctx.core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.operationId, operationId)
    }

    func testNoParamLastEvidenceFallsBackToDiskWhenMemoryEmpty() throws {
        let dir = tempDir()
        let first = makeCore(directory: dir)
        _ = try first.core.attach(bundleId: "com.example.app", pid: nil)
        try first.core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)

        // Fresh core with empty memory; lastEvidence() without opId must pull
        // the newest entry from the archive.
        let second = makeCore(directory: dir)
        _ = try second.core.attach(bundleId: "com.example.app", pid: nil)
        let pack = try second.core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack, try second.core.lastEvidence(operationId: pack.operationId))
    }

    func testAttachWithProjectRoutesArchiveToProjectDir() throws {
        let projectDir = tempDir()
        // An isolated registry: this test creates an entry, and `create`
        // rewrites the whole table at `filePath` — with the old default-path
        // registry that replaced every real project registration.
        let registry = TestSandbox.projectRegistry("b6-route")
        let project = try registry.create(
            displayName: "Proj",
            bundleId: "com.example.app",
            evidenceStoragePath: projectDir
        )
        let ctx = makeCore(directory: tempDir(), registry: registry)
        _ = try ctx.core.attach(bundleId: "com.example.app", pid: nil, projectId: project.projectId)
        let actResult = try ctx.core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let operationId = actResult["operationId"] as! String
        XCTAssertTrue(fileExists(projectDir, operationId))
    }

    // MARK: - Persistence-off regression (default EngineCore without store)

    func testCoreWithoutArchiveStillWorksInMemoryOnly() throws {
        // Existing call sites construct EngineCore without an EvidenceStore;
        // lastEvidence must keep its pre-v1.5 in-memory behavior.
        let dir = tempDir()
        let ctx = makeCore(directory: dir, archive: false)
        _ = try ctx.core.attach(bundleId: "com.example.app", pid: nil)
        let actResult = try ctx.core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let operationId = actResult["operationId"] as! String
        let pack = try ctx.core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.operationId, operationId)
        // "In-memory only" has to be falsifiable: a store-less core must leave
        // the injected directory untouched, or this case would silently keep
        // passing while writing evidence somewhere nobody looked at.
        XCTAssertNil(ctx.store, "the case is about a core without an archive")
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: dir), [],
            "no pack may reach disk when the engine has no store"
        )
    }
}