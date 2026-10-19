import XCTest
@testable import GlassPaneEngine

/// The debugger attach arm measured nothing, and a dead victim was reported as a refusal.
///
/// Half 1 — the argv. `DebugCapabilityProbe.swift:150` runs
/// `xcrun lldb --batch --attach <pid> …`. On this machine lldb answers
/// `error: unknown option: --attach`: its attach options are `--attach-name`,
/// `--attach-pid`, `-n`, `-p`, `--wait-for`, `-w` (`lldb --help`, ATTACHING). So the arm
/// that exists to answer "can this machine attach a debugger" never attached anything and
/// always classified as `.spawnFailed` — which is exactly what `engine/smoke.md:218-224`
/// records (`{"state":"spawnFailed"}` alongside `granted:true`), and the Python side of
/// this repo already learned it: `bridge/glasspane_bridge.py:696-699` documents
/// "--attach 不存在…真机复验抓到这个参数缺陷" and passes `-p`.
///
/// Half 2 — the victim lifetime. `attachVictimSeconds = 30` against
/// `defaultTimeoutSeconds = 120`, and `classify` maps any text containing
/// "attach failed" to `.denied`. A permitted-but-sSlow run whose victim `/bin/sleep`
/// exits first makes lldb print `error: attach failed: no such process` — reproduced on
/// this box with `lldb --batch -p <dead pid>` — and the panel then renders "被系统拒绝"
/// for what is a fixture-lifetime fact. Denial strings stay denial.
///
/// `Outcome`'s public case names are unchanged: the panel and `--check-developer-tools`
/// both read them (`DeveloperToolsCapability.Report`).
final class Qoder20261019AttachArgvTests: XCTestCase {

    // MARK: - the injected process layer the file already takes

    private final class RecordingRunner: DebugCapabilityProbe.Running {
        var runs: [(binary: String, arguments: [String], timeout: TimeInterval)] = []
        var victimRequests: [Int] = []
        var killed: [Int32] = []
        var reply: (exit: Int32?, timedOut: Bool, output: String) = (0, false, "Process 42 attached")
        /// What `spawnVictim` should hand back; nil models a victim that could not start.
        var victimPid: String? = "4242"

        func run(_ binary: String, _ arguments: [String], timeout: TimeInterval)
            -> (exit: Int32?, timedOut: Bool, output: String) {
            runs.append((binary, arguments, timeout))
            return reply
        }
        func spawnVictim(seconds: Int) -> String? {
            victimRequests.append(seconds)
            return victimPid
        }
        func killVictim(_ pid: Int32) { killed.append(pid) }
    }

    /// argv is pinned as the whole rendered invocation, not as a fragment: a probe that
    /// passes `-p` somewhere *and* `--attach` alongside it would still measure nothing.
    func testAttachArmPassesTheFlagLLDBActuallyAccepts() {
        let runner = RecordingRunner()
        let probe = DebugCapabilityProbe(runner: runner, timeout: 5)
        let outcome = probe.probeAttach()

        XCTAssertEqual(runner.runs.count, 1)
        let run = runner.runs[0]
        XCTAssertEqual(run.binary, "/usr/bin/xcrun")
        XCTAssertEqual(
            run.arguments, ["lldb", "--batch", "-p", "4242", "-o", "detach", "-o", "quit"],
            "lldb's attach form is `-p <pid>`; `--attach` is not an option it parses"
        )
        XCTAssertFalse(run.arguments.contains("--attach"), "the phantom flag must be gone entirely")
        XCTAssertEqual(outcome, .ok, "with a real attach argv and an `attached` answer the arm measures ok")
    }

    /// The launch arm is the other half of the same argv contract — it already worked, and
    /// this keeps the fix from being applied to the wrong invocation.
    func testLaunchArmArgvIsUnchanged() {
        let runner = RecordingRunner()
        runner.reply = (0, false, "Process 1 stopped\nexited with status 0")
        XCTAssertEqual(DebugCapabilityProbe(runner: runner, timeout: 5).probeLaunch(), .ok)
        XCTAssertEqual(runner.runs.first?.arguments,
                       ["lldb", "--batch", "-o", "run", "-o", "quit", "/usr/bin/true"])
    }

    // MARK: - classification battery

    /// `error: unknown option: --attach` is the shape that hid the defect for a whole
    /// release line: it is neither a grant nor a refusal, and it must never be read as
    /// "the seat works".
    func testUnknownOptionIsNeitherAGrantNorADenial() {
        let unknown = DebugCapabilityProbe.classify((
            exit: 1, timedOut: false,
            output: "error: unknown option: --attach\nusage: lldb [-c core] [-s script] [-p <pid>] …\n"
        ))
        XCTAssertNotEqual(unknown, .ok, "an unparsed option cannot mean the debugger attached")
        XCTAssertNotEqual(unknown, .denied, "and it cannot mean the OS refused the seat either")
        XCTAssertEqual(unknown, .spawnFailed, "unknown failure keeps its own word (never a permission claim)")
    }

    /// The wrong output the task reproduced on this machine:
    /// `lldb --batch -p <dead pid>` → `error: attach failed: no such process`.
    /// A victim that outlived its own lifetime is a fixture fact, not an answer about TCC.
    func testVictimThatExpiredIsNotReportedAsADenial() {
        let gone = DebugCapabilityProbe.classify((
            exit: 1, timedOut: false,
            output: "error: attach failed: no such process\n"
        ))
        XCTAssertNotEqual(gone, .denied,
                          "\"no such process\" is the victim's lifetime, not the OS refusing debug permission")
        XCTAssertEqual(gone, .spawnFailed)

        // The sibling shape of the same lifetime fact: lldb's other wording for a pid
        // that is not there any more.
        let missing = DebugCapabilityProbe.classify((
            exit: 1, timedOut: false,
            output: "error: attach failed: process 4242 does not exist\n"
        ))
        XCTAssertNotEqual(missing, .denied, "\(missing)")
    }

    /// Denial strings stay denial — the fix must not have softened the verdict the probe
    /// exists to deliver.
    func testRealDenialsStayDenials() {
        for text in [
            "error: attach failed: Not allowed to attach to process 4242\n",
            "error: attach failed: (os/kern) failure\n",
            "error: attach failed: getting registers is not permitted\n",
            "taskgated: not permitted\n",
        ] {
            XCTAssertEqual(
                DebugCapabilityProbe.classify((exit: 1, timedOut: false, output: text)),
                .denied, "refusal wording must still be a refusal: \(text)"
            )
        }
        // The mixed shape DebugCapabilityProbeDrainTests pinned: attached *then* refused.
        XCTAssertEqual(
            DebugCapabilityProbe.classify((
                exit: 1, timedOut: false,
                output: "Process 42 attached\nerror: attach failed: Not allowed to attach\n"
            )),
            .denied
        )
    }

    // MARK: - victim lifetime vs probe budget

    /// The budget half: the victim must outlive the run it is attached to, or every
    /// permitted-but-slow probe ends in the `.denied` shape above.
    func testVictimOutlivesTheProbeBudget() {
        let runner = RecordingRunner()
        _ = DebugCapabilityProbe(runner: runner, timeout: 120).probeAttach()
        XCTAssertEqual(runner.victimRequests.count, 1)
        XCTAssertGreaterThanOrEqual(
            runner.victimRequests[0], 120,
            "a 30 s victim under a 120 s probe budget dies first and gets reported as a refusal"
        )
        XCTAssertEqual(runner.killed, [4242], "the victim is still reaped on the way out")
    }

    /// A short budget keeps the historical floor rather than spawning a needlessly long
    /// sleeper, and the lifetime still covers the budget.
    func testShortBudgetKeepsTheVictimFloor() {
        let runner = RecordingRunner()
        _ = DebugCapabilityProbe(runner: runner, timeout: 2).probeAttach()
        XCTAssertEqual(runner.victimRequests, [DebugCapabilityProbe.attachVictimSeconds])
        XCTAssertGreaterThanOrEqual(runner.victimRequests[0], 2)
    }

    /// The pure rule, so the pairing above is not a magic number.
    func testVictimLifetimeRuleIsStatedAndTotal() {
        XCTAssertEqual(DebugCapabilityProbe.victimLifetimeSeconds(forProbeBudget: 0.2),
                       DebugCapabilityProbe.attachVictimSeconds)
        XCTAssertEqual(DebugCapabilityProbe.victimLifetimeSeconds(forProbeBudget: 119.1), 120,
                       "a fractional budget rounds up: the victim must not lose by rounding")
        XCTAssertEqual(DebugCapabilityProbe.victimLifetimeSeconds(forProbeBudget: 600), 600)
    }

    /// A victim that could not be spawned is still `spawnFailed`, and the probe must not
    /// run lldb against a pid it never created.
    func testMissingVictimNeverRunsTheDebugger() {
        let runner = RecordingRunner()
        runner.victimPid = nil
        XCTAssertEqual(DebugCapabilityProbe(runner: runner, timeout: 5).probeAttach(), .spawnFailed)
        XCTAssertTrue(runner.runs.isEmpty, "\(runner.runs)")
    }

    /// The wire payload keeps its vocabulary: the panel and `--check-developer-tools` read
    /// `state` strings, and no public case may be renamed by this fix.
    func testOutcomeWireVocabularyIsUnchanged() {
        XCTAssertEqual(DebugCapabilityProbe.Outcome.ok.rawValue, "ok")
        XCTAssertEqual(DebugCapabilityProbe.Outcome.denied.rawValue, "denied")
        XCTAssertEqual(DebugCapabilityProbe.Outcome.timeout.rawValue, "timeout")
        XCTAssertEqual(DebugCapabilityProbe.Outcome.spawnFailed.rawValue, "spawnFailed")
        XCTAssertEqual(
            DebugCapabilityProbe.Snapshot(launch: .ok, attach: .spawnFailed).granted, true,
            "the launch half still decides granted when the attach half is unknown"
        )
        XCTAssertEqual(DebugCapabilityProbe.Snapshot(launch: .ok, attach: .denied).granted, false)
    }

    /// End-to-end on the injected layer: a machine whose lldb really does attach now
    /// answers `attach: ok` instead of the old permanent `spawnFailed`.
    func testSnapshotReportsAttachMeasuredOnceTheArgvIsRight() {
        let runner = RecordingRunner()
        runner.reply = (0, false, "Process 4242 attached\n(lldb) detach\nProcess 4242 detached\n")
        let snapshot = DebugCapabilityProbe(runner: runner, timeout: 30).snapshot()
        XCTAssertEqual(snapshot.attach, .ok, "\(snapshot)")
        XCTAssertTrue(snapshot.granted)
        XCTAssertEqual(runner.runs.count, 2, "launch + attach, each with its own bounded budget")
    }
}
