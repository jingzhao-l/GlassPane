import XCTest
@testable import GlassPaneEngine

/// Accessibility exposes one boolean, and two states were being folded into it.
///
/// `AccessibilityPermissionProbe.swift:52` answered `isTrusted() ? .granted : .notDetermined`.
/// `AXIsProcessTrusted()` distinguishes "trusted" from "not trusted" and nothing more: an
/// app that **is** in the Accessibility list with its switch off, an app that was never
/// added, and an app whose entry the user deleted all answer `false`. Publishing that as
/// `notDetermined` tells the reader "this seat was never asked about" — and the panel
/// renders `.notDetermined` as "未请求" (`SettingsPanelView.swift:787`), a positive claim
/// about a history the API cannot give. The enum and the panel icons keep granted /
/// denied / notDetermined / unverifiable distinct precisely so that "we do not know" is
/// not mistaken for any of the three things that are not it.
///
/// `.granted` is still an observation, and it is still the only positive the AX boolean
/// can support.
final class Qoder20261019UntrustedAxTests: XCTestCase {

    func testUntrustedAxIsNotReportedAsNeverAsked() {
        let probe = AccessibilityPermissionProbe(trustCheck: { false }, prompt: {}, openPane: {})
        XCTAssertFalse(probe.isTrusted())
        let status = probe.displayStatus()
        XCTAssertNotEqual(status, .notDetermined,
                          "\"never asked\" is a claim about a history AX does not expose")
        XCTAssertNotEqual(status, .denied, "and \"refused\" is a decision nobody observed either")
        XCTAssertEqual(status, .unverifiable, "the honest reading of a false trust check is: not measured")
    }

    func testTrustedAxIsStillGranted() {
        let probe = AccessibilityPermissionProbe(trustCheck: { true }, prompt: {}, openPane: {})
        XCTAssertEqual(probe.displayStatus(), .granted)
        XCTAssertEqual(probe.isTrusted(), true)
    }

    /// The prompt path: after the probe has asked and the trust check still says false,
    /// `PermissionProbeSet.request(.accessibility)` returns the observed state. It must
    /// not become a decision either.
    func testPromptThatHasNotBeenAnsweredIsNotADenialOrANeverAsked() {
        let set = PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(trustCheck: { false }, prompt: {}, openPane: {}),
            inputMonitoring: InputMonitoringPermissionProbe(preflight: { true }, requestAccess: {}, openPane: {}),
            screenRecording: ScreenCapturePermissionProbe(preflight: { true }, requestAccess: {}),
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            subjectProvider: { PermissionSubject(binaryPath: "/x/glasspaned") }
        )
        let after = set.request(.accessibility)
        XCTAssertNotEqual(after, .notDetermined)
        XCTAssertNotEqual(after, .denied)
        XCTAssertEqual(after, .unverifiable)
        XCTAssertEqual(set.snapshot().status(for: .accessibility), .unverifiable,
                       "and the same value is what the daemon publishes on `hello`")
    }

    // MARK: - what the value does downstream (the copy has to stay truthful)

    /// `unverifiable` renders as "未验证" in the panel — the not-measured wording — while
    /// `notDetermined` renders as "未请求". This is why dressing an untrusted seat as
    /// notDetermined is a claim and not a hedge. Read from the panel source: this suite
    /// does not own that file, so the mapping is checked as text, and the gate is only
    /// allowed to speak when the strings it quotes are really there.
    /// SHAPE GATE on the settings target (labelled, same reason as `PanelControlAlwaysVisibleTests`).
    func testTheValueChosenForUntrustedCarriesTheNotMeasuredCopy() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("engine/Sources/glasspane-settings/SettingsPanelView.swift")
        let panel = try String(contentsOf: url, encoding: .utf8)
        for needle in ["case .unverifiable: text = \"未验证\"", "case .notDetermined: text = \"未请求\""] {
            XCTAssertTrue(panel.contains(needle), "panel wording moved without this suite noticing: \(needle)")
        }

        // Engine-side: the shape/icon/identifier triple the card builds from the status.
        XCTAssertEqual(PermissionGuide.statusIcon(for: .unverifiable), "questionmark.circle")
        XCTAssertNotEqual(PermissionGuide.statusIcon(for: .unverifiable),
                          PermissionGuide.statusIcon(for: .notDetermined),
                          "two different states must not draw the same shape")
        XCTAssertEqual(
            PermissionGuide.statusIdentifier(kind: .accessibility, status: .unverifiable),
            "gp-perm-accessibility-unverifiable"
        )
    }

    /// The guide button stays live for `unverifiable`: the honest value must not turn into
    /// a dead end that stops the user from asking for the seat. The card's title branch
    /// returns 授权 for a non-developer-tools seat at `.unverifiable`, and the model's
    /// guide path only short-circuits on `.granted` — so switching this probe's untrusted
    /// reading to `unverifiable` cannot disable the action.
    /// SHAPE GATE on the settings target (it owns that copy; this suite may not edit it).
    func testUnverifiableKeepsAWorkingGuideActionForAccessibility() throws {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("engine/Sources/glasspane-settings", isDirectory: true)
        let panel = try String(contentsOf: directory.appendingPathComponent("SettingsPanelView.swift"), encoding: .utf8)
        let model = try String(contentsOf: directory.appendingPathComponent("SettingsModel.swift"), encoding: .utf8)

        XCTAssertTrue(
            panel.contains("entry.kind == .developerTools ? \"打开系统设置\" : \"授权\""),
            "the .unverifiable branch of the guide button changed shape — if it stopped offering 授权 "
                + "for a required seat, this batch's honest value would also have disabled the fix path"
        )
        XCTAssertTrue(
            model.contains("if status(of: kind) == .granted {"),
            "the guide path must short-circuit only on a granted seat"
        )
        XCTAssertFalse(
            model.contains("status(of: kind) == .notDetermined"),
            "a guide path gated on notDetermined would quietly stop asking for exactly the seats "
                + "that now read unverifiable"
        )
    }

    /// The daemon snapshot's own default: a kind with no reading at all is unverifiable,
    /// which is the same value an untrusted AX seat now reports — one honest word for
    /// "not measured", not one per channel.
    func testUntrustedAxMatchesTheSnapshotsOwnNotMeasuredValue() {
        let snapshot = DaemonPermissionSnapshot(
            subject: PermissionSubject(binaryPath: "/x/glasspaned"),
            statuses: [:]
        )
        XCTAssertEqual(snapshot.status(for: .accessibility), .unverifiable)
        XCTAssertEqual(
            AccessibilityPermissionProbe(trustCheck: { false }, prompt: {}, openPane: {}).displayStatus(),
            snapshot.status(for: .accessibility)
        )
    }
}
