import XCTest
@testable import GlassPaneEngine

/// The developer-tools seat has two faces — `glasspaned --check-developer-tools`
/// (whose exit code is what an agent reads) and the permission card (what the
/// person reads). The card learned to honour an explicitly measured refusal;
/// the CLI kept answering 0 for `launch:"ok", attach:"denied"`, so one payload
/// produced two verdicts. Both now come from the same computation.
final class DeveloperToolsVerdictTests: XCTestCase {

    /// The flags lldb parses for "attach to this pid" (`lldb --help`, ATTACHING).
    /// `--attach` is not one of them — it never was — and this stub used to key on
    /// it, so both halves were answered with the launch outcome and the pairing
    /// below compared a card that had seen "denied" against a payload that had
    /// never been asked the attach question at all.
    private static let attachFlags = ["-p", "--attach-pid"]

    /// Drives the real classification from the argv it is handed, so a launch
    /// probe can never be answered with an attach outcome. It also counts which
    /// arm was driven, because a stub that answers one arm twice used to make this
    /// file's central pairing pass while measuring nothing.
    private final class StubRunner: DebugCapabilityProbe.Running {
        let launch: (exit: Int32?, timedOut: Bool, output: String)
        let attach: (exit: Int32?, timedOut: Bool, output: String)
        private let attachFlags: [String]
        var launchRuns = 0
        var attachRuns = 0

        init(
            launch: (exit: Int32?, timedOut: Bool, output: String),
            attach: (exit: Int32?, timedOut: Bool, output: String),
            attachFlags: [String]
        ) {
            self.launch = launch
            self.attach = attach
            self.attachFlags = attachFlags
        }

        func run(
            _ binary: String, _ arguments: [String], timeout: TimeInterval
        ) -> (exit: Int32?, timedOut: Bool, output: String) {
            XCTAssertEqual(binary, "/usr/bin/xcrun", "the probe must not be answered for another binary")
            if arguments.contains(where: { attachFlags.contains($0) }) {
                attachRuns += 1
                return attach
            }
            launchRuns += 1
            return launch
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

    private func payload(launch: String, attach: String) -> (json: [String: Any], runner: StubRunner) {
        let runner = StubRunner(
            launch: outcome(launch), attach: outcome(attach), attachFlags: Self.attachFlags
        )
        return (DebugCapabilityProbe(runner: runner).jsonPayload(), runner)
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
            let (json, runner) = payload(launch: launch, attach: attach)
            // 两侧都真的各跑了一次：这条闸的全部内容就是"一半的答案不许当另一半用"，
            // 而它以前靠一个 lldb 不认识的 `--attach` 来分流——那个 flag 不存在，于是
            // attach 那一侧从未被问过，负载里的 `granted` 说的只是 launch 半边的故事。
            XCTAssertEqual(runner.launchRuns, 1, "launch arm must run exactly once for \(launch)/\(attach)")
            XCTAssertEqual(runner.attachRuns, 1,
                           "attach arm must run exactly once for \(launch)/\(attach) - an argv without -p/--attach-pid means it measured nothing")
            let granted = (json["granted"] as? Bool) ?? true
            // 卡片读的是负载自己发出的那两个词，不是测试的参数。
            let emittedLaunch = (json["launch"] as? [String: Any])?["state"] as? String ?? "<missing>"
            let emittedAttach = (json["attach"] as? [String: Any])?["state"] as? String ?? "<missing>"
            XCTAssertEqual(
                [emittedLaunch, emittedAttach], [launch, attach],
                "the probe must put the driven half into the payload it publishes for \(launch)/\(attach)"
            )
            let report = DeveloperToolsCapability.Report(
                launch: emittedLaunch, attach: emittedAttach, granted: granted, observedAt: Date()
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
