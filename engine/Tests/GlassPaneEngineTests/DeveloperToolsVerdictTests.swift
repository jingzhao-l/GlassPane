import XCTest
@testable import GlassPaneEngine

/// The developer-tools seat has two faces — `glasspaned --check-developer-tools`
/// (whose exit code is what an agent reads) and the permission card (what the
/// person reads). The card learned to honour an explicitly measured refusal;
/// the CLI kept answering 0 for `launch:"ok", attach:"denied"`, so one payload
/// produced two verdicts. Both now come from the same computation.
final class DeveloperToolsVerdictTests: XCTestCase {

    /// Drives the real classification from the argv it is handed, so a launch
    /// probe can never be answered with an attach outcome.
    private struct StubRunner: DebugCapabilityProbe.Running {
        let launch: (exit: Int32?, timedOut: Bool, output: String)
        let attach: (exit: Int32?, timedOut: Bool, output: String)

        func run(
            _ binary: String, _ arguments: [String], timeout: TimeInterval
        ) -> (exit: Int32?, timedOut: Bool, output: String) {
            XCTAssertEqual(binary, "/usr/bin/xcrun", "the probe must not be answered for another binary")
            return arguments.contains("--attach") ? attach : launch
        }
        func spawnVictim(seconds: Int) -> String? { "4242" }
        func killVictim(_ pid: Int32) {}
    }

    /// Drives each half from the outcome named in the test, keyed on the argv the
    /// probe actually passes — so a launch probe can never be answered with an
    /// attach outcome, and neither half silently inherits the other's result.
    private func outcome(_ state: String) -> (exit: Int32?, timedOut: Bool, output: String) {
        switch state {
        case "ok": return (0, false, "Process completed. exited with status 0")
        case "denied": return (1, false, "error: Not allowed to attach to process")
        case "timeout": return (nil, true, "")
        default: return (nil, false, "no lldb available on this machine")
        }
    }

    private func payload(launch: String, attach: String) -> [String: Any] {
        let probe = DebugCapabilityProbe(runner: StubRunner(
            launch: outcome(launch), attach: outcome(attach)
        ))
        return probe.jsonPayload()
    }

    func testMeasuredRefusalOnEitherHalfIsNotReportedAsGranted() {
        XCTAssertFalse(
            DebugCapabilityProbe.Snapshot(launch: .ok, attach: .denied).granted,
            "an explicit refusal must not be cancelled by the other half succeeding"
        )
        XCTAssertFalse(
            DebugCapabilityProbe.Snapshot(launch: .denied, attach: .ok).granted,
            "the same rule applies in the other order: \(DebugCapabilityProbe.Snapshot(launch: .denied, attach: .ok).granted)"
        )
        XCTAssertTrue(DebugCapabilityProbe.Snapshot(launch: .ok, attach: .ok).granted)
        XCTAssertFalse(
            DebugCapabilityProbe.Snapshot(launch: .timeout, attach: .spawnFailed).granted,
            "an outcome that never reached a verdict is not a grant"
        )
    }

    func testPayloadGrantedAgreesWithTheCardForEveryHalfCombination() {
        for (launch, attach) in [("ok", "denied"), ("denied", "ok"), ("ok", "ok"), ("timeout", "spawnFailed")] {
            let json = payload(launch: launch, attach: attach)
            let granted = (json["granted"] as? Bool) ?? true
            let report = DeveloperToolsCapability.Report(
                launch: launch, attach: attach, granted: granted, observedAt: Date()
            )
            XCTAssertEqual(
                report.status == .granted, granted,
                "the card and the exit code must be the same verdict for \(launch)/\(attach)"
            )
            if launch == "ok", attach == "denied" {
                XCTAssertFalse(granted, "\(launch)/\(attach) must not light green for the agent either")
            }
        }
    }

    func testClassificationDistinguishesRefusalFromEnvironmentFailure() {
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 1, timedOut: false, output: "Not allowed to attach to process")),
            .denied, "a refusal is a permission statement"
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 1, timedOut: false, output: "taskgated: not permitted")),
            .denied
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: nil, timedOut: false, output: "no lldb here")),
            .spawnFailed,
            "an environment failure must never be folded into a permission claim either way"
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: nil, timedOut: true, output: "")),
            .timeout
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 0, timedOut: false, output: "Process 42 attached")),
            .ok
        )
    }

    func testEnvironmentFailureIsNeverReadAsADenialOrAGrant() {
        // The phrasings here are lldb's own (`attach failed: Not allowed to attach
        // to process`); an unrecognized failure stays `spawnFailed` so it cannot be
        // laundered into either a permission refusal or a permission grant.
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 1, timedOut: false, output: "error: attach failed: Not allowed to attach to process 4242")),
            .denied
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 1, timedOut: false, output: "xcrun: error: unable to find utility aibd") ),
            .spawnFailed
        )
    }
}
