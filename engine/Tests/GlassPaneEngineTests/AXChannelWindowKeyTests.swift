import CoreGraphics
import XCTest
@testable import GlassPaneEngine

/// The window dictionary `captureWindow` selects from is produced by
/// CoreGraphics, and a wrong key spelling does not throw — it just never
/// matches, so the pixel channel reports "no on-screen window owned by pid N"
/// for every app and `pixelDiff` stays null in every pack. Measured here on
/// 2026-09-25: two of the three keys this file uses were spelled `"PID"` and
/// `"Bounds"`, neither of which exists in a CGWindow dictionary.
///
/// These tests exist so that class of failure is *decided* rather than inferred:
/// one side feeds the real spellings, the other feeds the old ones and must
/// return nothing. A test that only checked the first would pass on the bug.
final class AXChannelWindowKeyTests: XCTestCase {

    private func window(
        pid: Int, number: Int, keyPrefix: String,
        x: Double = 10, y: Double = 20, width: Double = 800, height: Double = 600
    ) -> [String: Any] {
        [
            "\(keyPrefix)OwnerPID": pid,
            "\(keyPrefix)Number": number,
            "\(keyPrefix)Bounds": ["X": x, "Y": y, "Width": width, "Height": height],
        ]
    }

    /// The live spellings, verified against CoreGraphics on this machine.
    func testRealKeySpellingsSelectTheOwningWindow() throws {
        let windows: [[String: Any]] = [
            window(pid: 111, number: 7, keyPrefix: "kCGWindow"),
            window(pid: 4242, number: 99, keyPrefix: "kCGWindow"),
        ]
        let found = try XCTUnwrap(AXChannel.frontmostWindow(in: windows, pid: 4242))
        XCTAssertEqual(found.0, 99, "the first window owned by the pid, front-to-back")
        XCTAssertEqual(found.1, CGRect(x: 10, y: 20, width: 800, height: 600))
    }

    /// The control that makes the above mean something: with the spellings this
    /// file used before the fix, nothing matches — which is exactly what the
    /// daemon was reporting as a fact about the attached app.
    func testOldKeySpellingsMatchNothingProvingTheTestCanCatchTheBug() {
        let windows: [[String: Any]] = [
            ["PID": 4242, "kCGWindowNumber": 99, "Bounds": ["X": 0.0, "Y": 0.0, "Width": 100.0, "Height": 80.0]],
        ]
        XCTAssertNil(
            AXChannel.frontmostWindow(in: windows, pid: 4242),
            "a dictionary keyed `PID`/`Bounds` must select nothing — if this ever returns a window, "
                + "the key constants drifted again and the pixel channel is silently dead"
        )
    }

    func testWindowsWithoutUsableBoundsOrOfAnotherOwnerAreSkipped() {
        let zeroSized = window(pid: 4242, number: 5, keyPrefix: "kCGWindow", width: 0, height: 40)
        let otherOwner = window(pid: 1, number: 6, keyPrefix: "kCGWindow")
        let mine = window(pid: 4242, number: 7, keyPrefix: "kCGWindow")
        let found = AXChannel.frontmostWindow(in: [zeroSized, otherOwner, mine], pid: 4242)
        XCTAssertEqual(found?.0, 7, "off-screen-shaped and foreign-owned entries must not be captured")
        XCTAssertNil(AXChannel.frontmostWindow(in: [zeroSized, otherOwner], pid: 4242))
    }

    /// Live cross-check against the framework itself: whatever windows this
    /// machine can see have to carry the owner-pid key the selector reads.
    ///
    /// Skips with the measured count when the list is empty (no window access
    /// for this process, or a headless runner) rather than asserting — the point
    /// is the *key names*, and an empty list says nothing about them. The skip
    /// states what was measured so it cannot be mistaken for a pass.
    func testLiveWindowListActuallyCarriesTheseKeys() throws {
        guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
                as? [[String: Any]] else {
            throw XCTSkip("CGWindowListCopyWindowInfo returned nil — no window access for this process")
        }
        guard !raw.isEmpty else {
            throw XCTSkip("0 on-screen windows visible to the test runner — key names not measurable here")
        }
        let owners = raw.filter { $0["kCGWindowOwnerPID"] != nil }
        XCTAssertEqual(
            owners.count, raw.count,
            "\(raw.count) windows visible, only \(owners.count) carry kCGWindowOwnerPID — "
                + "the selector would silently skip the rest"
        )
        let selectable = owners.filter { window in
            AXChannel.frontmostWindow(in: [window], pid: (window["kCGWindowOwnerPID"] as? Int) ?? -1) != nil
        }
        XCTAssertGreaterThan(
            selectable.count, 0,
            "no visible window in the live list is selectable by the current key set — "
                + "the pixel channel is dead again (bounds key drift is the usual cause)"
        )
    }
}
