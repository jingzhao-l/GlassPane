import XCTest
@testable import GlassPaneEngine
@testable import glasspane_settings

/// A hash chain proves nothing about whether its tail is still on disk: a shorter
/// chain re-verifies from the same genesis, and the record that never got written
/// simply is not there to be checked. The only process that knows a persist failed
/// is the running daemon — `--approval-verify` is a one-shot that reads the file and
/// never appends, so its own `persistFailed` is structurally nil. Before this round
/// the panel could print 「签名链完整」 about a chain whose newest record had never
/// reached disk, because the fact had no way out of the daemon.
@MainActor
final class ApprovalLedgerPersistenceHonestyTests: XCTestCase {

    private func report(chainValid: Bool = true, loadFailed: Bool = false) -> ApprovalLedgerReport {
        ApprovalLedgerReport(
            records: [], chainValid: chainValid, firstBrokenIndex: chainValid ? nil : 0,
            loadFailed: loadFailed, fileExists: true, autoApprovedHighRiskCount: 0
        )
    }

    func testChainTitleRefusesToClaimCompletenessOverAnUnpersistedAppend() {
        XCTAssertEqual(
            ConsoleModel.chainTitle(report: report(), daemonPersistFailure: nil),
            "签名链完整", "没有落盘失败时报正常结论——这条判据不许一律降级"
        )
        let degraded = ConsoleModel.chainTitle(
            report: report(), daemonPersistFailure: "the ledger write failed: ENOSPC"
        )
        XCTAssertNotEqual(degraded, "签名链完整", "链自洽 ≠ 最新记录在盘上")
        XCTAssertTrue(degraded.contains("没落盘"), degraded)

        XCTAssertEqual(
            ConsoleModel.chainTitle(report: report(chainValid: false), daemonPersistFailure: "x"),
            "签名链已断裂", "断裂本来就是断裂，降级措辞不许盖住它"
        )
        XCTAssertEqual(
            ConsoleModel.chainTitle(report: report(loadFailed: true), daemonPersistFailure: nil),
            "台账文件读不开"
        )
        XCTAssertNil(ConsoleModel.chainTitle(report: nil, daemonPersistFailure: nil)
            .range(of: "完整"), "没有读数时不许说完整")
    }

    func testHelloCarriesTheDaemonsOwnPersistFailure() throws {
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard), settle: {})
        XCTAssertNil(core.hello()["approvalPersistFailed"], "没有失败时不写这个键，而不是写个空串")
    }

    func testProbeReadsTheFieldAndTreatsAbsenceAsAbsence() throws {
        let withKey = try XCTUnwrap(DaemonProbe.parseHelloResponse(Data(
            #"{"result":{"version":"1.15.1","protocolVersion":"0","pid":7,"approvalPersistFailed":"ENOSPC"},"id":0}"#.utf8
        )))
        XCTAssertEqual(withKey.approvalPersistFailed, "ENOSPC")

        let without = try XCTUnwrap(DaemonProbe.parseHelloResponse(Data(
            #"{"result":{"version":"1.14.1","protocolVersion":"0","pid":7},"id":0}"#.utf8
        )))
        XCTAssertNil(
            without.approvalPersistFailed,
            "旧 daemon 不上报 ≠ 没有落盘失败；面板只能显示它知道的那部分"
        )
    }

    /// SHAPE GATE, not behavioural: the caption above is only honest if the page
    /// actually reads the daemon's field. REVERSE: drop either use in
    /// `ApprovalsTabView.swift` and the card goes back to green-on-unchanged-file.
    func testTheApprovalsPageActuallyReadsTheReportedFailure() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("engine/Sources/glasspane-settings/ApprovalsTabView.swift")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            throw XCTSkip("no ApprovalsTabView.swift in this checkout; this gate cannot speak")
        }
        let code = text.split(separator: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        XCTAssertEqual(
            code.components(separatedBy: "settings.daemon.approvalPersistFailed").count - 1, 2,
            "标题与灯色两处都得读这个字段：读到一处，另一处就会对一条没落盘的链亮绿灯"
        )
    }
}
