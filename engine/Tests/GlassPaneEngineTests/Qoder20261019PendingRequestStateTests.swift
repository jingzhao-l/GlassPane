import XCTest
@testable import GlassPaneEngine

/// An unanswered TCC prompt is not a decision.
///
/// `InputMonitoringPermissionProbe.swift:39` and `ScreenCapturePermission.swift:45` both
/// answered `hasRequestedThisRun ? .denied : .notDetermined`, and
/// `DaemonPermissionSnapshot.swift:213` handed that straight to `--permissions` / the
/// panel, which renders `.denied` as "已拒绝" (`SettingsPanelView.swift:786`). The CG
/// preflight is a single boolean: after a request it says "not granted **yet**", which is
/// not the same fact as "the system refused". TCC has not decided — the person in front of
/// the machine is usually looking at the prompt at the moment the probe reads false.
///
/// The honest value is the product's not-measured one:
///  - `PermissionStatus.unverifiable` (panel copy "未验证") for the surfaces that speak
///    `PermissionStatus` — the daemon snapshot, `hello.permissions`, `--permissions`, the
///    panel cards;
///  - `ScreenCapturePermissionState.notDetermined` for the three-case seat model itself:
///    of granted / denied / notDetermined it is the one that means "the system has not
///    determined", and no new case is invented for it. The probe's own `panelStatus`
///    (the value the snapshot publishes) is where a *pending request* is separated from
///    a *never-asked* seat, because "未请求" would be its own small lie once the probe
///    has just asked.
///
/// `.granted` stays `.granted` on every path that observes it, and `.denied` stays
/// available for a denial that is actually observed rather than inferred from a
/// preflight that has not been answered yet.
final class Qoder20261019PendingRequestStateTests: XCTestCase {

    // MARK: - input monitoring (`PermissionStatus` surface)

    func testRequestedButUnansweredInputMonitoringIsNotReportedAsDenied() {
        var requestCalls = 0
        let probe = InputMonitoringPermissionProbe(
            preflight: { false },
            requestAccess: { requestCalls += 1 },
            openPane: {}
        )
        // Before anything was asked, "not determined" is the truthful reading.
        XCTAssertEqual(probe.state, .notDetermined)

        let observed = probe.requestAccess()
        XCTAssertEqual(requestCalls, 1, "the system prompt really was invoked")
        XCTAssertNotEqual(observed, .denied,
                          "TCC has not answered; reporting a decision is the defect")
        XCTAssertEqual(observed, .unverifiable, "the product's honest not-measured value")
        XCTAssertNotEqual(probe.state, .denied)
        XCTAssertEqual(probe.state, .unverifiable)
    }

    /// `requestOnly()` is the daemon-side path (P1 v1.2 §11.2: the daemon registers the
    /// seat with its own identity, the panel does not ask on its behalf). Same rule: the
    /// snapshot the daemon publishes afterwards must not say 已拒绝.
    func testDaemonSideRequestOnlyDoesNotBecomeADenialInTheSnapshot() {
        let probe = InputMonitoringPermissionProbe(
            preflight: { false }, requestAccess: {}, openPane: {}
        )
        probe.requestOnly()
        XCTAssertNotEqual(probe.state, .denied)
        XCTAssertEqual(probe.state, .unverifiable)

        let set = PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(trustCheck: { true }, prompt: {}, openPane: {}),
            inputMonitoring: probe,
            screenRecording: ScreenCapturePermissionProbe(preflight: { true }, requestAccess: {}),
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            subjectProvider: { PermissionSubject(binaryPath: "/x/glasspaned") }
        )
        XCTAssertEqual(set.snapshot().status(for: .inputMonitoring), .unverifiable,
                       "the value the panel renders as 已拒绝 comes from here")
        XCTAssertEqual(set.snapshot().permissionsWire["inputMonitoring"], "unverifiable")
    }

    /// Control: a seat the preflight actually grants is granted, requested or not.
    func testGrantedInputMonitoringStillReadsGranted() {
        let probe = InputMonitoringPermissionProbe(preflight: { true }, requestAccess: {}, openPane: {})
        XCTAssertEqual(probe.state, .granted)
        XCTAssertEqual(probe.requestAccess(), .granted, "已授权时短路，不去弹一个没必要的窗")
    }

    /// And the other control: a request that is answered within the run (preflight flips
    /// to true) reads granted — the honest "unknown" must not have swallowed a real yes.
    func testRequestAnsweredInTheRunReadsGranted() {
        var granted = false
        let probe = InputMonitoringPermissionProbe(
            preflight: { granted }, requestAccess: { granted = true }, openPane: {}
        )
        XCTAssertEqual(probe.state, .notDetermined)
        XCTAssertEqual(probe.requestAccess(), .granted)
        XCTAssertEqual(probe.state, .granted)
    }

    // MARK: - screen recording (its own three-case state)

    func testPendingScreenRecordingRequestIsNotADenial() {
        var requestCalls = 0
        let probe = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: { requestCalls += 1 })
        XCTAssertEqual(probe.state, .notDetermined, "nothing asked yet")

        let observed = probe.guideAccess()
        XCTAssertEqual(requestCalls, 1)
        XCTAssertNotEqual(observed, .denied, "guideAccess used to hard-code a decision here")
        XCTAssertNotEqual(probe.state, .denied)
        XCTAssertEqual(
            probe.state, .notDetermined,
            "of granted/denied/notDetermined the case that means \"the system has not determined\" is notDetermined"
        )
    }

    /// The published surface must not read 未请求 about a prompt the user is looking at
    /// either — that separation is what `ScreenCapturePermissionProbe.panelStatus` is for
    /// (the value the daemon snapshot publishes), asserted below.
    func testSnapshotSeparatesPendingScreenRecordingFromADenialAndFromNeverAsked() {
        let pending = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        pending.requestOnly()
        XCTAssertNotEqual(pending.panelStatus, .denied)
        XCTAssertEqual(pending.panelStatus, .unverifiable, "已请求、系统未决定 → 未验证")
        XCTAssertNotEqual(pending.panelStatus, .notDetermined,
                          "and it is not \"never asked\" either — the request went out")

        let neverAsked = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        XCTAssertEqual(neverAsked.panelStatus, .notDetermined, "未请求 is the truth here")

        let granted = ScreenCapturePermissionProbe(preflight: { true }, requestAccess: {})
        XCTAssertEqual(granted.panelStatus, .granted)
        granted.requestOnly()
        XCTAssertEqual(granted.panelStatus, .granted, "a granted seat never downgrades")
    }

    /// The daemon surface end to end: `PermissionProbeSet.snapshot()` is what `hello` and
    /// `--permissions` publish.
    func testSnapshotPublishesUnknownForBothPendingSeats() {
        let input = InputMonitoringPermissionProbe(preflight: { false }, requestAccess: {}, openPane: {})
        let screen = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        let set = PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(trustCheck: { true }, prompt: {}, openPane: {}),
            inputMonitoring: input,
            screenRecording: screen,
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            subjectProvider: { PermissionSubject(binaryPath: "/x/glasspaned") }
        )
        input.requestOnly()
        screen.requestOnly()
        let snapshot = set.snapshot()
        XCTAssertEqual(snapshot.status(for: .accessibility), .granted)
        XCTAssertEqual(snapshot.status(for: .inputMonitoring), .unverifiable)
        XCTAssertEqual(snapshot.status(for: .screenRecording), .unverifiable)
        XCTAssertNotEqual(snapshot.status(for: .screenRecording), .denied)
    }

    /// `PermissionProbeSet.request(_:)` is the daemon's own "ask with my identity" entry
    /// point; its return value is what the CLI prints. Neither seat may come back as a
    /// decision the OS never made.
    func testRequestSurfaceReturnsTheHonestStateForBothSeats() {
        let input = InputMonitoringPermissionProbe(preflight: { false }, requestAccess: {}, openPane: {})
        let screen = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        let set = PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(trustCheck: { true }, prompt: {}, openPane: {}),
            inputMonitoring: input,
            screenRecording: screen,
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            inputTapProbe: { true },
            subjectProvider: { PermissionSubject(binaryPath: "/x/glasspaned") }
        )
        XCTAssertEqual(set.request(.inputMonitoring), .unverifiable)
        XCTAssertEqual(set.request(.screenRecording), .unverifiable)
        XCTAssertNotEqual(set.request(.inputMonitoring), .denied)
    }

    /// A seat that is genuinely granted is never dressed as unknown, requested or not
    /// (the same control on the request surface).
    func testRequestSurfaceStillReportsAGrantedSeatAsGranted() {
        let set = PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(trustCheck: { true }, prompt: {}, openPane: {}),
            inputMonitoring: InputMonitoringPermissionProbe(preflight: { true }, requestAccess: {}, openPane: {}),
            screenRecording: ScreenCapturePermissionProbe(preflight: { true }, requestAccess: {}),
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            inputTapProbe: { XCTFail("已授权时不该再建 tap"); return false },
            subjectProvider: { PermissionSubject(binaryPath: "/x/glasspaned") }
        )
        XCTAssertEqual(set.request(.inputMonitoring), .granted)
        XCTAssertEqual(set.request(.screenRecording), .granted)
    }

    // MARK: - the wording the two values carry downstream

    /// `unverifiable` is the value whose copy means "not measured", and the panel's guide
    /// button stays live for it — otherwise the honest value would also be a dead end.
    func testUnverifiableIsTheNotMeasuredValueAndStaysActionable() {
        XCTAssertEqual(PermissionStatus.unverifiable.rawValue, "unverifiable")
        XCTAssertEqual(PermissionGuide.statusIcon(for: .unverifiable), "questionmark.circle")
        XCTAssertEqual(
            PermissionGuide.statusIdentifier(kind: .inputMonitoring, status: .unverifiable),
            "gp-perm-input-monitoring-unverifiable"
        )
        let identifier = PermissionGuide.statusIdentifier(kind: .inputMonitoring, status: .denied)
        XCTAssertNotEqual(identifier, "gp-perm-input-monitoring-unverifiable",
                           "the two states must stay two identifiers")
    }

    /// The `ScreenCapturePermissionState` mapping keeps its shape for the states it can
    /// actually name, and the three-case enum gains no new case in this batch.
    func testScreenCaptureStateMappingIsUnchangedForTheStatesThatExist() {
        XCTAssertEqual(ScreenCapturePermissionState.granted.panelStatus, .granted)
        XCTAssertEqual(ScreenCapturePermissionState.denied.panelStatus, .denied)
        XCTAssertEqual(ScreenCapturePermissionState.notDetermined.panelStatus, .notDetermined)
        XCTAssertEqual(
            [ScreenCapturePermissionState.granted.rawValue,
             ScreenCapturePermissionState.denied.rawValue,
             ScreenCapturePermissionState.notDetermined.rawValue],
            ["granted", "denied", "notDetermined"],
            "the wire vocabulary of the seat model is frozen"
        )
    }
}
