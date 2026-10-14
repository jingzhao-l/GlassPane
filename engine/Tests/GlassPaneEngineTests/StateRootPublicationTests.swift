import XCTest
@testable import GlassPaneEngine
@testable import glasspane_settings

/// The state root a socket serves was knowable only from that process's argv.
/// `http-gateway` tells agents to run maintenance "against the same --state-dir
/// this socket serves" — an instruction with nothing behind it — while the panel
/// showed its *own* root next to a daemon's readings (the ambiguity
/// `engine/smoke.md` recorded). The daemon now states the root it resolved, and
/// the panel shows that statement or its absence.
@MainActor
final class StateRootPublicationTests: XCTestCase {

    private func helloData(_ result: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: ["result": result, "id": 0])
    }

    func testHelloCarriesTheRootTheDaemonResolved() throws {
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard), settle: {})
        XCTAssertNil(core.hello()["stateRoot"], "an unresolved root is not reported as a path")
        core.stateRootPath = "/Users/example/.glasspane"
        XCTAssertEqual(core.hello()["stateRoot"] as? String, "/Users/example/.glasspane")
    }

    func testParseReadsTheReportedRoot() throws {
        let data = helloData([
            "engine": "glasspaned", "version": "1.15.0", "protocolVersion": "0", "pid": 4242,
            "stateRoot": "/Users/example/scratch/.glasspane"
        ])
        let summary = try XCTUnwrap(DaemonProbe.parseHelloResponse(data))
        XCTAssertEqual(summary.stateRoot, "/Users/example/scratch/.glasspane")
    }

    func testAnOlderDaemonHelloLeavesTheRootUnknownRatherThanGuessed() throws {
        let data = helloData([
            "engine": "glasspaned", "version": "1.14.1", "protocolVersion": "0", "pid": 4242
        ])
        let summary = try XCTUnwrap(DaemonProbe.parseHelloResponse(data))
        XCTAssertNil(summary.stateRoot, "absence is the absence of a report, not the home default")
    }

    func testPanelCaptionSaysUnreportedInsteadOfSubstitutingItsOwnRoot() {
        let model = SettingsModel(socketPath: "/tmp/gp-state-root-tests/daemon.sock", refreshOnAppear: false)
        XCTAssertEqual(model.daemonStateRootCaption, "状态根未上报")
        XCTAssertFalse(
            model.daemonStateRootCaption.contains(NSHomeDirectory()),
            "the panel must not fill the daemon's root with the one it happens to read: \(model.daemonStateRootCaption)"
        )
    }

    /// SHAPE GATE, not behavioural: `applyLiveness` is private and its input is a
    /// live handshake. This pins that the parsed field is actually carried into the
    /// entry the view reads, and cleared with every other report when the daemon
    /// stops answering — the same pairing `version`/`pid` already follow.
    /// REVERSE: delete the assignment, or drop it from `clearDaemonReport` → red.
    func testTheReportedRootIsWiredIntoTheEntryAndClearedWithTheRest() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let path = url.appendingPathComponent("engine/Sources/glasspane-settings/SettingsModel.swift").path
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("no SettingsModel.swift to read in this checkout; this gate cannot speak")
        }
        let code = text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        XCTAssertTrue(
            code.contains("daemon.stateRoot = summary.stateRoot"),
            "the parsed root never reaches the entry the view renders"
        )
        XCTAssertTrue(
            code.contains("daemon.stateRoot = nil"),
            "a daemon that stopped answering keeps reporting the root it resolved last time"
        )
    }
}
