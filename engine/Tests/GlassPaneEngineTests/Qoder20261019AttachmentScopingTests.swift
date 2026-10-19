import XCTest
@testable import GlassPaneEngine

/// 2026-10-19 review lane, defect 6: the archive fallback is not scoped by app.
///
/// `assert_element` with no `operationId` resolves its signal context through
/// `resolvedPack(operationId: nil)`, whose disk fallback is
/// `evidenceStore.lastOnDisk()` — newest mtime, no questions asked. `attach` only
/// clears the in-memory history, and the archive is never scoped by app, so after
/// re-attaching a *different* app an assertion was filed under another app's
/// attribution ("strong"), with another app's `signals.act` and another app's
/// crash/AX measurements. The fixtures follow `EngineCoreTests`: a
/// `ScriptedChannel` whose `app` is swapped, and an archive in the sandbox.
final class Qoder20261019AttachmentScopingTests: XCTestCase {

    private var channel: ScriptedChannel!
    private var directory: String!

    private let appA = AttachedApp(pid: 4242, bundleId: "com.example.app", appName: "Example")
    private let appB = AttachedApp(pid: 9999, bundleId: "com.other.app", appName: "Other")

    private var submitSelector: Selector { Selector(role: "AXButton", title: "Submit") }

    override func setUp() {
        super.setUp()
        channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        directory = TestSandbox.directory("attach-scope")
    }

    private func makeCore() -> EngineCore {
        EngineCore(channel: channel, settle: {}, evidenceStore: TestSandbox.evidenceStore(at: directory))
    }

    /// The archive's entry names, read straight off the directory.
    private func archivedEntries() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory)
            .filter { $0.hasSuffix(".json") }
            .sorted()
    }

    /// act on A ⇒ attach B ⇒ assert ⇒ refuse, and write nothing.
    func testAssertAfterReAttachingAnotherAppRefusesAndWritesNoPack() throws {
        let core = makeCore()
        channel.app = appA
        _ = try core.attach(bundleId: appA.bundleId, pid: nil)
        let actResult = try core.act(selector: submitSelector, action: .press)
        let operationA = try XCTUnwrap(actResult["operationId"] as? String)
        let entryA = operationA + ".json"
        XCTAssertEqual(try archivedEntries(), [entryA], "premise: A's act is on disk")
        XCTAssertEqual(
            try core.lastEvidence(operationId: operationA).attribution.level, .soft,
            "premise: the pack the fallback would hand over is A's"
        )

        channel.app = appB
        _ = try core.attach(bundleId: appB.bundleId, pid: nil)

        var thrown: GPError?
        do {
            _ = try core.assertElement(selector: submitSelector, property: .enabled, expected: .bool(true))
        } catch let error as GPError {
            thrown = error
        } catch {
            return XCTFail("expected a GPError, got \(error)")
        }
        let refusal = try XCTUnwrap(thrown, "revert: the assert was filed under app A's attribution")
        XCTAssertEqual(refusal.code, .noOperation, refusal.message)
        XCTAssertTrue(
            refusal.message.contains("archive") || refusal.message.contains("attached"),
            "the refusal must state why, not just that nothing was found: \(refusal.message)"
        )
        XCTAssertFalse(
            refusal.message.contains("op_"),
            "and it must not name another app's operationId back to the caller as if it were this session's: \(refusal.message)"
        )
        XCTAssertEqual(
            try archivedEntries(), [entryA],
            "revert: an assertion pack carrying A's signals was archived under B's attachment"
        )
        // Nothing in the archive claims an assertion it did not measure for B.
        XCTAssertEqual(
            try archivedEntries().filter { $0 != entryA }.count, 0
        )
    }

    /// The R1-06 restart case must keep working: a fresh daemon that has never
    /// been attached to anything else may reuse the archived operation, because
    /// nothing in this process contradicts it.
    func testRestartedDaemonStillResolvesTheArchivedOperation() throws {
        let writer = makeCore()
        channel.app = appA
        _ = try writer.attach(bundleId: appA.bundleId, pid: nil)
        XCTAssertNoThrow(try writer.act(selector: submitSelector, action: .press))

        let readerCore = ScriptedChannel(fallbackTree: TestTrees.standard)
        readerCore.fallbackCapture = TestImages.solid(100)
        readerCore.app = appA
        let reader = EngineCore(
            channel: readerCore, settle: {},
            evidenceStore: TestSandbox.evidenceStore(at: directory)
        )
        _ = try reader.attach(bundleId: appA.bundleId, pid: nil)
        XCTAssertNoThrow(
            try reader.assertElement(selector: submitSelector, property: .enabled, expected: .bool(true)),
            "a restarted daemon with no other attachment in its history still has the archive"
        )
    }

    /// Once B has produced its own operation, the assert is filed against B's
    /// context — the refusal is about attribution, not about losing the reuse.
    func testAssertUsesTheNewAppsOwnOperationAfterThatAppActs() throws {
        let core = makeCore()
        channel.app = appA
        _ = try core.attach(bundleId: appA.bundleId, pid: nil)
        _ = try core.act(selector: submitSelector, action: .press)

        channel.app = appB
        _ = try core.attach(bundleId: appB.bundleId, pid: nil)
        let actOnB = try core.act(selector: submitSelector, action: .press)
        let operationB = try XCTUnwrap(actOnB["operationId"] as? String)

        let before = try archivedEntries()
        XCTAssertNoThrow(try core.assertElement(selector: submitSelector, property: .enabled, expected: .bool(true)))
        let after = try archivedEntries()
        XCTAssertEqual(after.count, before.count + 1, "the assert filed a pack of its own")
        let asserted = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(asserted.signals.act.selector, try core.lastEvidence(operationId: operationB).signals.act.selector)
    }

    /// `diagnose` with no operationId resolves through the same fallback, so the
    /// same refusal has to cover it — one resolver, one answer.
    func testDiagnoseWithoutAnOperationIdRefusesTheOtherAppsArchiveEntry() throws {
        let core = makeCore()
        channel.app = appA
        _ = try core.attach(bundleId: appA.bundleId, pid: nil)
        _ = try core.act(selector: submitSelector, action: .press)
        channel.app = appB
        _ = try core.attach(bundleId: appB.bundleId, pid: nil)
        XCTAssertThrowsGPError(.noOperation) {
            _ = try core.diagnose(operationId: nil)
        }
        XCTAssertThrowsGPError(.noEvidence) {
            _ = try core.lastEvidence(operationId: nil)
        }
    }

    /// An operation named explicitly is still readable after a switch — R1-06's
    /// existence answer must not be narrowed into "you cannot audit the past".
    func testExplicitOperationIdStillResolvesAcrossAnAttachmentSwitch() throws {
        let core = makeCore()
        channel.app = appA
        _ = try core.attach(bundleId: appA.bundleId, pid: nil)
        let actResult = try core.act(selector: submitSelector, action: .press)
        let operationA = try XCTUnwrap(actResult["operationId"] as? String)
        channel.app = appB
        _ = try core.attach(bundleId: appB.bundleId, pid: nil)
        XCTAssertNoThrow(try core.lastEvidence(operationId: operationA))
        XCTAssertNoThrow(try core.diagnose(operationId: operationA))
    }
}
