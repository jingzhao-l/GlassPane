import XCTest
@testable import GlassPaneEngine

/// `CGEventInputMonitor`'s teardown has to publish what it actually did.
///
/// Two halves, both in `installTap` / `stop()`:
///
/// (a) `stop()` on the joinable path (a tap pumped by the monitor's own background
/// thread) disabled delivery and then **left `tapAlive` true** until that thread got
/// around to its own teardown — up to one pump interval (`runLoopWakeInterval`, 50 ms).
/// During that window `isMonitoringInput` answered "monitored" while nothing could be
/// delivered, which is the exact state `AttributionGuard` reads to decide that a window
/// was watched. Ordering fix: clear the alive flag *before* disabling delivery, then ask
/// the owning thread to unbuild the source and the port.
///
/// (b) `installTap` created the run-loop source **before** taking the state lock, so the
/// `shuttingDown` race built a `CFRunLoopSource`, invalidated the mach port underneath it
/// and returned — leaving the abort path holding an object this file has to reason about
/// instead of one it never created. (Swift's ARC releases the source at scope exit, so
/// this is not a leak in today's runtime; it is a teardown path that has to *clean up*
/// rather than one that never *needs* cleaning up — and the next edit to this branch can
/// store the source without noticing it is on the abandoned path.)
///
/// Why these two are shape gates rather than behavioural tests: creating a real session
/// tap would swallow this machine's keyboard for the length of the suite — the file's own
/// header says the pump cannot be exercised in-process, and `ReviewCoreATests` gates the
/// neighbouring `tapAlive = ` assignment the same way. Each gate states the REVERSE that
/// reddens it. Comments are stripped before scanning (this file quotes the very literals
/// it forbids), per `CaptureChannelShapeTests.codeOnly`.
final class Qoder20261019StopPublishesImmediatelyTests: XCTestCase {

    private func monitorSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("engine/Sources/GlassPaneEngine/CGEventInputMonitor.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// `codeOnly`: drop `/* … */` blocks and `//` lines, then hand back one member body.
    private func codeOnly(_ source: String) -> String {
        var out = source
        while let open = out.range(of: "/*") {
            guard let close = out.range(of: "*/", range: open.upperBound..<out.endIndex) else { break }
            out.removeSubrange(open.lowerBound..<close.upperBound)
        }
        return out
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { line in
                let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
                return !trimmed.hasPrefix("//")
            }
            .joined(separator: "\n")
    }

    private func body(of source: String, from marker: String) -> String {
        guard let start = source.range(of: marker) else {
            XCTFail("no \(marker) in CGEventInputMonitor.swift — this gate is looking at nothing")
            return ""
        }
        var end = source.endIndex
        for terminator in ["\n    private func ", "\n    public func ", "\n    fileprivate func ",
                           "\n    static let ", "\n    ///"] {
            if let found = source.range(of: terminator, range: start.upperBound..<source.endIndex),
               found.lowerBound < end {
                end = found.lowerBound
            }
        }
        return String(source[start.lowerBound..<end])
    }

    /// (a) REVERSE: move `tapAlive = false` back inside the `if !joinable` branch → red.
    func testStopClearsTheAliveFlagBeforeDisablingDelivery() throws {
        let stop = body(of: codeOnly(try monitorSource()), from: "public func stop()")
        XCTAssertTrue(stop.contains("CGEvent.tapEnable(tap: tap, enable: false)"),
                      "stop() no longer disables delivery at all — the gate has lost its subject")
        XCTAssertTrue(stop.contains("joinable"),
                      "the joinable / non-joinable split is gone; this gate would pass by accident")

        guard let alive = stop.range(of: "tapAlive = false"),
              let joinable = stop.range(of: "joinable") else {
            return XCTFail("stop() lost one of the two statements it must order: \(stop)")
        }
        XCTAssertLessThan(
            alive.lowerBound, joinable.lowerBound,
            "the alive flag is only cleared on the non-joinable branch, so `stop()` returns with "
                + "isMonitoringInput == true while the tap has already been disabled"
        )
        // And the flag must be cleared before the disabling call itself, not after it.
        let disable = try XCTUnwrap(stop.range(of: "CGEvent.tapEnable(tap: tap, enable: false)"))
        XCTAssertLessThan(alive.lowerBound, disable.lowerBound,
                          "publish \"not monitoring\" first, then stop delivery — in that order")
    }

    /// (b) REVERSE: hoist `CFMachPortCreateRunLoopSource` back above the `shuttingDown`
    /// check → red.
    func testAbortPathCreatesNoRunLoopSourceToTearDown() throws {
        let install = body(of: codeOnly(try monitorSource()), from: "private func installTap(")
        let create = try XCTUnwrap(
            install.range(of: "CFMachPortCreateRunLoopSource"),
            "installTap no longer creates a run-loop source — the pump is gone"
        )
        let race = try XCTUnwrap(
            install.range(of: "if shuttingDown"),
            "the shutdown race branch is gone: installTap no longer checks `shuttingDown` at all"
        )
        XCTAssertGreaterThan(
            create.lowerBound, race.upperBound,
            "the source is built before the abort branch is even reached, so the abandoned path "
                + "leaves a created object behind instead of creating nothing"
        )
        // The aborted branch still has to stop delivery and invalidate what it did create.
        let branch = install[race.lowerBound...]
        XCTAssertTrue(branch.contains("CFMachPortInvalidate"),
                      "the abort branch must still invalidate the tap it holds")
        XCTAssertTrue(branch.contains("return false"),
                      "and it must report that nothing was installed")
    }

    /// Control that survives both fixes untouched: a monitor that never installed a tap
    /// reports "not monitoring", keeps no fault it did not measure, and `stop()` on it is
    /// a no-op rather than an invented cause. (This is the shape the daemon sees when the
    /// Input Monitoring seat is missing.)
    func testUninstalledMonitorStopStaysQuietAndNotMonitoring() {
        let monitor = CGEventInputMonitor(log: EngineLog(quiet: true))
        XCTAssertFalse(monitor.isMonitoringInput)
        XCTAssertNil(monitor.inputMonitoringFault, "never installed: there is no cause to report")
        monitor.stop()
        XCTAssertFalse(monitor.isMonitoringInput)
        XCTAssertNil(monitor.lastTapFault, "stop() on a monitor that never installed must not invent a fault")
        XCTAssertFalse(monitor.disabledSinceLastCheck())
    }
}
