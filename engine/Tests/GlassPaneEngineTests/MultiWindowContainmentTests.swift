import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// Multi-window containment. The audit used to compare every element against the
/// FRONTMOST window only, so an app with an inspector, palette or dialog got
/// `outsideWindow` BLOCKING findings for controls a person can see and click —
/// invented defects on the one surface agents are told to trust.
final class MultiWindowContainmentTests: XCTestCase {

    private let front = AxFrame(x: 0, y: 0, width: 800, height: 600)
    private let inspector = AxFrame(x: 900, y: 100, width: 300, height: 400)

    private func node(
        _ path: String, frame: AxFrame?, role: String = "AXButton"
    ) -> AxGeometryNode {
        AxGeometryNode(path: path, role: role, geometry: frame.map { .measured($0) } ?? .absent)
    }

    private func snap(_ nodes: [AxGeometryNode], windows: [AxFrame]?) -> AxGeometrySnapshot {
        AxGeometrySnapshot(
            nodes: nodes, window: front, windows: windows, latencyMs: 1
        )
    }

    func testElementInsideASecondWindowIsNotReportedAsOutsideTheApp() {
        let result = UILayoutAudit.audit(snap(
            [node("1", frame: AxFrame(x: 950, y: 150, width: 120, height: 60))],
            windows: [front, inspector]
        ))
        XCTAssertFalse(
            result.findings.contains { $0.rule == "outsideWindow" },
            "the control is inside the inspector window: \(result.findings.map { $0.rule })"
        )
    }

    func testElementOutsideEveryWindowStillBlocks() {
        let result = UILayoutAudit.audit(snap(
            [node("1", frame: AxFrame(x: 2_000, y: 2_000, width: 120, height: 60))],
            windows: [front, inspector]
        ))
        XCTAssertTrue(
            result.findings.contains { $0.rule == "outsideWindow" && $0.severity == .blocking },
            "nothing on screen holds this element; the finding must stay: \(result.findings.map { $0.rule })"
        )
    }

    func testClippingIsMeasuredAgainstTheWindowThatHoldsTheElement() throws {
        // Centre at x=1150 sits in the inspector (900…1200); the control then
        // hangs 50pt past its right edge, so the visible share is 150/200. Measured
        // against the front window it would read as fully outside.
        let result = UILayoutAudit.audit(snap(
            [node("1", frame: AxFrame(x: 1_050, y: 200, width: 200, height: 60))],
            windows: [front, inspector]
        ))
        XCTAssertFalse(result.findings.contains { $0.rule == "outsideWindow" }, "\(result.findings.map { $0.rule })")
        let clipped = try XCTUnwrap(
            result.findings.first { $0.rule == "clippedByWindow" },
            "half the control is outside its own window: \(result.findings.map { $0.rule })"
        )
        XCTAssertEqual(
            try XCTUnwrap(clipped.measured["visibleRatio"] as? Double), 0.75, accuracy: 0.001
        )
    }

    func testSnapshotWithoutWindowEnumerationKeepsTheFrontmostJudgement() {
        // A snapshot from a channel that did not list windows must not answer
        // "outside every window" from an empty set — that would be silence read as
        // a measurement.
        let legacy = AxGeometrySnapshot(nodes: [node("1", frame: AxFrame(x: 950, y: 150, width: 120, height: 60))], window: front, latencyMs: 1)
        XCTAssertEqual(legacy.containmentFrames, [front])
        let result = UILayoutAudit.audit(legacy)
        XCTAssertTrue(result.findings.contains { $0.rule == "outsideWindow" })

        let nothing = AxGeometrySnapshot(nodes: [node("1", frame: AxFrame(x: 950, y: 150, width: 120, height: 60))], window: nil, latencyMs: 1)
        XCTAssertTrue(nothing.containmentFrames.isEmpty, "no window at all is not a window at (0,0,0,0)")
        XCTAssertFalse(UILayoutAudit.audit(nothing).findings.contains { $0.rule == "outsideWindow" })
    }

    // MARK: - Window enumeration (literal key names, per the file's own doctrine)

    private func window(pid: Int, number: Int, layer: Int?, x: Double, y: Double, w: Double, h: Double) -> [String: Any] {
        var entry: [String: Any] = [
            "kCGWindowOwnerPID": pid,
            "kCGWindowNumber": number,
            "kCGWindowBounds": ["X": x, "Y": y, "Width": w, "Height": h]
        ]
        if let layer { entry["kCGWindowLayer"] = layer }
        return entry
    }

    func testAppWindowFramesTakesEveryAppWindowInFrontToBackOrder() {
        let list = [
            window(pid: 4242, number: 3, layer: 0, x: 900, y: 100, w: 300, h: 400),
            window(pid: 4242, number: 2, layer: 3, x: 0, y: 0, w: 800, h: 600),
            window(pid: 9999, number: 9, layer: 0, x: 10, y: 10, w: 50, h: 50),
            window(pid: 4242, number: 4, layer: -1, x: 0, y: 0, w: 1_000, h: 1_000),
            window(pid: 4242, number: 5, layer: 25, x: 0, y: 0, w: 1_000, h: 24),
            window(pid: 4242, number: 6, layer: nil, x: 0, y: 0, w: 100, h: 100),
            window(pid: 4242, number: 7, layer: 0, x: 0, y: 0, w: 0, h: 100)
        ]
        let frames = AXChannel.appWindowFrames(in: list, for: 4242)
        XCTAssertEqual(frames.count, 2, "another pid, wallpaper, system UI, an unreadable layer and a zero-width entry are not this app's windows: \(frames)")
        XCTAssertEqual(frames[0].origin.x, 900, "front-to-back order preserved")
        XCTAssertEqual(frames[1].origin.x, 0)
    }

    func testUnreadableKeyNamesYieldNoWindowsRatherThanFabricatedOnes() {
        // The 2026-09 P0 lived here: `"PID"`/`"Bounds"` parsed to nil on every real
        // machine, so the pixel channel died for ten days while the suite stayed green.
        let wrongKeys: [[String: Any]] = [[
            "PID": 4242,
            "Number": 1,
            "Bounds": ["X": 0.0, "Y": 0.0, "Width": 100.0, "Height": 100.0],
            "Layer": 0
        ]]
        XCTAssertTrue(AXChannel.appWindowFrames(in: wrongKeys, for: 4242).isEmpty)
    }
}
