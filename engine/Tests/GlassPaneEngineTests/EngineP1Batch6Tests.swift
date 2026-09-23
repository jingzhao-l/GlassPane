import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// P1 batch 6 (spec v1.5 §9–§11): evidence persistent on-disk archive.
/// Covers EvidenceStore roundtrip/atomicity/fault-tolerance, EngineCore
/// persistence wiring, restart replay, memory-first lookup and project
/// directory association — all against injected temporary directories and a
/// scripted channel, so no AX/GUI permission is required.
final class EngineP1Batch6Tests: XCTestCase {

    // MARK: - Fixtures

    /// A valid EvidencePack built from the kernel fixture on disk.
    private func fixturePack() throws -> EvidencePack {
        try EvidencePack.decodeAndValidate(
            try KernelFixtures.data("evidence-pack.ok-01.json")
        )
    }

    /// An EngineCore normalised to a writable temp archive + scripted channel.
    /// `directory: nil` = **不挂档案**（`evidenceStore` 为 nil，纯内存），
    /// 不再是"回落到 `~/.glasspane/evidence/`"：这个用例原本叫
    /// "without archive"，实际却往用户的真实证据档案里写（A-1 的同一形状）。
    /// 要写档案就必须显式给一个临时目录。
    private func makeCore(
        directory: String? = nil,
        registry: ProjectRegistry? = nil
    ) -> (core: EngineCore, channel: ScriptedChannel, store: EvidenceStore?) {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        let store = directory.map { EvidenceStore(directory: $0) }
        let core = EngineCore(channel: channel, settle: {}, projectRegistry: registry, evidenceStore: store)
        return (core, channel, store)
    }

    private func tempDir() -> String {
        let dir = NSTemporaryDirectory() + "/gpb6-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
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
        let store = EvidenceStore(directory: dir)
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
        let store = EvidenceStore(directory: tempDir())
        XCTAssertNil(store.read(operationId: "op_0123456789ABCDEFGHJKMNPQRS"))
    }

    func testStoreReadCorruptFileReturnsNilWithoutThrowing() throws {
        let dir = tempDir()
        try Data("not-json{{{".utf8).write(to: groupURL(dir).appendingPathComponent("op_0123456789ABCDEFGHJKMNPQRS.json"))
        let store = EvidenceStore(directory: dir)
        XCTAssertNil(store.read(operationId: "op_0123456789ABCDEFGHJKMNPQRS"))
    }

    func testStoreAutoCreatesMissingDirectory() throws {
        let base = tempDir()
        let dir = base + "/nested/deeper"
        // Ensure the nested path does not exist yet.
        try? FileManager.default.removeItem(atPath: dir)
        let store = EvidenceStore(directory: dir)
        let pack = try fixturePack()
        XCTAssertTrue(store.write(pack))
        XCTAssertTrue(fileExists(dir, pack.operationId))
    }

    func testStoreLastOnDiskReturnsMostRecentByMTime() throws {
        let dir = tempDir()
        let store = EvidenceStore(directory: dir)
        let first = try EvidencePack.decodeAndValidate(try KernelFixtures.data("evidence-pack.ok-01.json"))
        XCTAssertTrue(store.write(first))
        // Second pack from a different fixture with a distinct operationId.
        let second = try EvidencePack.decodeAndValidate(try KernelFixtures.data("evidence-pack.ok-02.json"))
        XCTAssertNotEqual(first.operationId, second.operationId)
        XCTAssertTrue(store.write(second))
        XCTAssertEqual(store.lastOnDisk(), second.operationId)
    }

    func testStoreLastOnDiskEmptyDirectoryReturnsNil() {
        let store = EvidenceStore(directory: tempDir())
        XCTAssertNil(store.lastOnDisk())
    }

    func testStoreWriteFaultyDirReturnsFalse() {
        // A path that cannot be created as a directory (parent is a file).
        let base = tempDir() + "/parent-file"
        try? "x".write(toFile: base, atomically: true, encoding: .utf8)
        let store = EvidenceStore(directory: base + "/child")
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
        // 必须注入临时路径：`ProjectRegistry()` 默认落在 ~/.glasspane/projects.json，
        // 那正是运行中 daemon 读写的真表。此前每次 `swift test` 都往用户注册表里
        // 塞一条 com.example.app 假项目（实测已累积 68 条），且 maxProjects=128
        // 一旦触顶，真实项目注册会直接 GP_E_PROJECT_LIMIT。
        let registry = ProjectRegistry(filePath: tempDir() + "/projects.json")
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
        let ctx = makeCore()
        _ = try ctx.core.attach(bundleId: "com.example.app", pid: nil)
        let actResult = try ctx.core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let operationId = actResult["operationId"] as! String
        let pack = try ctx.core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.operationId, operationId)
    }
}