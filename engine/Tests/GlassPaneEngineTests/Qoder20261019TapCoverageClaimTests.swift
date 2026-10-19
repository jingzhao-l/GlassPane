import XCTest
@testable import GlassPaneEngine

/// The C33 claim must name what the tap actually subscribes to.
///
/// `CGEventInputMonitor.swift:88-91` builds the mask from keyDown + three mouse-**down**
/// kinds, while `EngineCore.swift:1246` published
/// "the input stream was watched for the whole operation window". A person who only
/// scrolled the target, or only released a drag, produced **zero** monitored events, and
/// the window was still archived as fully watched — `contaminated: false` on the strength
/// of a channel that was deaf to exactly the input that happened.
///
/// Chosen half of the fix (the smaller one that makes the claim true rather than the
/// bigger one that changes what the product detects): the mask is generated from an
/// exported list, widened to the interaction kinds the claim already covers, and the act
/// response publishes that list next to the sentence. Which set is watched stays the
/// product's decision — this suite asserts the *correspondence* (published kinds == kinds
/// named in the sentence == bits in the mask), never a particular set.
final class Qoder20261019TapCoverageClaimTests: XCTestCase {

    private func makeCore(
        source: InputEventSource,
        kindsProvider: (() -> [String])? = nil
    ) -> EngineCore {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        return EngineCore(
            channel: channel,
            clock: { Date(timeIntervalSince1970: 1_000) },
            settle: {},
            attributionGuard: guard_,
            inputEventKindsProvider: kindsProvider
        )
    }

    private func act(
        source: InputEventSource = ScriptedInputEventSource(events: []),
        kindsProvider: (() -> [String])? = nil
    ) throws -> [String: Any] {
        let core = makeCore(source: source, kindsProvider: kindsProvider)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
    }

    /// The correspondence, stated on the quiet-window path that publishes the claim: the
    /// response that says "watched for the whole operation window" has to say **which
    /// kinds** it watched, and the sentence may not name a kind the mask does not carry.
    func testWatchedWindowSentenceNamesExactlyThePublishedKinds() throws {
        let result = try act(source: ScriptedInputEventSource(events: []))
        XCTAssertEqual(result["contaminationMonitored"] as? Bool, true)
        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        XCTAssertTrue(basis.contains("watched for the whole operation window"), basis)
        let published = try XCTUnwrap(
            result["monitoredEventKinds"] as? [String],
            "a window claimed as watched must state the kinds that were watched: \(basis)"
        )
        XCTAssertFalse(published.isEmpty, "an empty kind list claims nothing was watched: \(basis)")
        XCTAssertEqual(Set(published), Set(CGEventInputMonitor.monitoredEventKinds),
                       "the response and the tap must be reading one list")
        for kind in published {
            XCTAssertTrue(basis.contains(kind), "kind \(kind) is published but not named: \(basis)")
        }
    }

    /// A narrower declaration gets a narrower sentence: the claim is derived from what the
    /// channel declares, not from a constant the engine carries. (`AttributionGuard` keeps
    /// its input source private, so an embedding that watches through something other than
    /// this tap says so through `inputEventKindsProvider` — which is exactly the seam that
    /// keeps the sentence from hard-coding today's list.)
    func testNarrowerDeclarationIsDescribedNarrowly() throws {
        let result = try act(kindsProvider: { ["keyDown"] })
        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        let published = try XCTUnwrap(result["monitoredEventKinds"] as? [String])
        XCTAssertEqual(published, ["keyDown"], "\(published)")
        XCTAssertTrue(basis.contains("keyDown"), basis)
        XCTAssertFalse(basis.contains("scrollWheel"),
                       "this channel does not watch scrolling; the sentence may not say it does: \(basis)")
    }

    /// A channel that declares nothing is stated as unmeasured: an empty list must not be
    /// printed as a confident kind list.
    func testUndeclaredKindsAreStatedAsUnmeasured() throws {
        let result = try act(kindsProvider: { [] })
        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        XCTAssertTrue(basis.contains("declared no event kinds"), basis)
        XCTAssertFalse(basis.contains("keyDown"), "no kind may be named when none was declared: \(basis)")
        XCTAssertEqual(try XCTUnwrap(result["monitoredEventKinds"] as? [String]), [])
    }

    /// Control on the other side of the claim: a window nobody watched gets no kind list
    /// dressed up as a measurement, and no "watched" sentence.
    func testUnwatchedWindowIsNotDescribedAsAWatchedOne() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let core = EngineCore(
            channel: channel, settle: {},
            inputMonitorAbsenceReason: "the CGEvent input tap could not be created"
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        XCTAssertEqual(result["contaminationMonitored"] as? Bool, false)
        XCTAssertNil(result["monitoredEventKinds"],
                     "a window nobody watched must not publish the kinds it watched")
        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        XCTAssertTrue(basis.contains("the CGEvent input tap could not be created"), basis)
        XCTAssertFalse(basis.contains("watched for the whole operation window"), basis)
    }

    /// The instance surface the daemon/panel read: a monitor publishes the same list its
    /// mask installs, and `stop()` does not silently redefine what the coverage claim is
    /// about. Conformance to `InputEventKindReporting` is checked through `as?` the same
    /// way `InputLivenessAndHandleScanTests` checks the liveness protocol — if the
    /// conformance drops, a caller asking "which kinds?" gets nothing and must not be
    /// allowed to read that as "all of them".
    func testMonitorInstancesPublishTheSharedList() {
        let monitor = CGEventInputMonitor(log: EngineLog(quiet: true))
        XCTAssertEqual(monitor.monitoredEventKinds, CGEventInputMonitor.monitoredEventKinds)
        XCTAssertNotNil(monitor as? InputEventKindReporting,
                        "the kinds are only exportable while the protocol conformance holds")
        XCTAssertEqual((monitor as? InputEventKindReporting)?.monitoredEventKinds,
                       CGEventInputMonitor.monitoredEventKinds)
        XCTAssertFalse(monitor.isMonitoringInput, "not installed: nothing is being delivered")
        monitor.stop()
        XCTAssertEqual(monitor.monitoredEventKinds, CGEventInputMonitor.monitoredEventKinds,
                       "stopping the tap does not change which kinds the coverage claim is about")
    }

    // MARK: - the mask and the list are one thing

    /// The mask must be *generated* from the published list. Without this the sentence and
    /// the bits are two independent texts, and tomorrow one of them moves alone.
    func testMaskIsGeneratedFromThePublishedKinds() {
        let kinds = CGEventInputMonitor.monitoredEventKinds
        let mask = CGEventInputMonitor.monitoredEventMask
        XCTAssertEqual(kinds.count, Set(kinds).count, "a kind listed twice is one kind, not two")
        XCTAssertFalse(kinds.isEmpty)
        var accounted = CGEventMask(0)
        for kind in kinds {
            guard let bit = CGEventInputMonitor.eventMask(forKind: kind) else {
                return XCTFail("\(kind) is published but contributes no bit — the sentence claims a kind nobody installed")
            }
            XCTAssertEqual(mask & bit, bit, "\(kind) is claimed but not in the mask")
            accounted |= bit
        }
        XCTAssertEqual(mask, accounted, "the installed mask and the published list are not the same set")
    }

    /// A name the table does not know must not silently become bit 0 — `1 << 0` is a real
    /// event kind, so a typo in this list would subscribe to something nobody named.
    func testUnknownKindNameHasNoBitRatherThanBitZero() {
        XCTAssertNil(CGEventInputMonitor.eventMask(forKind: "mouseMoved"))
        XCTAssertNil(CGEventInputMonitor.eventMask(forKind: "keyDownn"))
    }

    /// The defect's two named shapes must now be inside the claimed coverage: a human who
    /// only scrolled, or only released a drag, used to produce zero monitored events while
    /// the window was published as fully watched. This pins those two, not the rest of the
    /// product's choice.
    func testScrollAndReleaseAreInsideTheClaimedCoverage() {
        let kinds = Set(CGEventInputMonitor.monitoredEventKinds)
        XCTAssertTrue(kinds.contains("scrollWheel"),
                      "a human who only scrolled was silently unattributed: \(kinds)")
        XCTAssertTrue(kinds.contains("leftMouseUp"),
                      "a human who only released a drag was silently unattributed: \(kinds)")
    }
}

