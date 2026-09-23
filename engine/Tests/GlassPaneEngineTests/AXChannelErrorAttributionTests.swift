import XCTest
import ApplicationServices
@testable import GlassPaneEngine

/// R2-06 / R2-15 / R2-19: the AX channel is how GlassPane reads a target app's
/// UI, so "the accessibility read did not answer" must never come out as a
/// factual-sounding negative about the interface ("the element is not there",
/// "the value is false"). Everything below exercises decisions that were
/// extracted as pure functions — no live accessibility target is touched.
final class AXChannelErrorAttributionTests: XCTestCase {

    private let definitive = AXChannel.AttributeReadOutcome.noAnswer

    // MARK: - R2-06: failure to read vs. a definitive absence

    func testSuccessfulReadWithAValueIsAnAnswer() {
        XCTAssertEqual(
            AXChannel.classifyAttributeRead(
                error: .success, hasValue: true, processTrusted: true, action: "reading AXRole"
            ),
            .answered
        )
    }

    func testSuccessfulReadOfNothingIsDefinitiveAbsenceNotAnAnswer() {
        XCTAssertEqual(
            AXChannel.classifyAttributeRead(
                error: .success, hasValue: false, processTrusted: true, action: "reading AXRole"
            ),
            definitive
        )
    }

    /// The only errors allowed to mean "this element has no such attribute".
    func testDefinitiveNoAnswerCodes() {
        for error in [AXError.attributeUnsupported, .noValue, .notImplemented] {
            let verdict = AXChannel.classifyAttributeRead(
                error: error, hasValue: false, processTrusted: true, action: "reading AXTitle"
            )
            XCTAssertEqual(verdict, definitive, "\(error) must stay a definitive answer")
            XCTAssertFalse(
                isUnreadable(verdict),
                "\(error) is a fact about the element, not about our read"
            )
        }
    }

    /// kAXErrorCannotComplete is the common case on a busy main thread — exactly
    /// when `findElement` used to answer "no element matches the selector".
    func testTimeoutIsNeverTreatedAsAbsence() {
        let trusted = AXChannel.classifyAttributeRead(
            error: .cannotComplete, hasValue: false, processTrusted: true, action: "reading AXTitle"
        )
        XCTAssertEqual(trusted, .unreadable(ChannelError.pingTimeout))
        XCTAssertNotEqual(trusted, definitive)

        let revoked = AXChannel.classifyAttributeRead(
            error: .cannotComplete, hasValue: false, processTrusted: false, action: "reading AXTitle"
        )
        guard case .unreadable(ChannelError.axUnavailable(let reason)) = revoked else {
            return XCTFail("a timeout with the permission revoked must report the permission, got \(revoked)")
        }
        XCTAssertTrue(reason.contains("revoked"), reason)
    }

    func testAPIDisabledAndStaleElementAreReadFailures() {
        let disabled = AXChannel.classifyAttributeRead(
            error: .apiDisabled, hasValue: false, processTrusted: true, action: "walking children"
        )
        XCTAssertNotEqual(disabled, definitive)
        guard case .unreadable(ChannelError.axUnavailable(let reason)) = disabled else {
            return XCTFail("kAXErrorAPIDisabled must not become 'no match', got \(disabled)")
        }
        XCTAssertTrue(reason.lowercased().contains("disabled"), reason)

        // 元素句柄失效：界面里可能就有那个元素，只是这次没读到。
        let stale = AXChannel.classifyAttributeRead(
            error: .invalidUIElement, hasValue: false, processTrusted: true, action: "reading AXTitle"
        )
        XCTAssertNotEqual(stale, definitive)
        guard case .unreadable(ChannelError.axUnavailable(let reason)) = stale else {
            return XCTFail("kAXErrorInvalidUIElement must propagate, got \(stale)")
        }
        XCTAssertTrue(reason.contains("re-attach"), reason)
    }

    /// Any code the switch does not enumerate lands in `default`, which must be
    /// "the read failed" — never the old silent "does not match".
    func testUnenumeratedErrorCodeFailsLoudly() {
        let verdict = AXChannel.classifyAttributeRead(
            error: .actionUnsupported, hasValue: false, processTrusted: true, action: "reading AXValue"
        )
        XCTAssertNotEqual(verdict, definitive)
        guard case .unreadable(ChannelError.axUnavailable(let reason)) = verdict else {
            return XCTFail("unenumerated kAXError must be unreadable, got \(verdict)")
        }
        XCTAssertTrue(reason.contains("kAXError"), reason)
    }

    /// R2-06 was an *asymmetry* defect: `attributeString` swallowed what
    /// `childElements` threw. Both now ask the same function, so one error code
    /// cannot get two different verdicts depending on which read hit it.
    func testAttributeReadAndChildrenWalkAgreeOnEveryCode() {
        let codes: [AXError] = [
            .success, .attributeUnsupported, .noValue, .notImplemented,
            .cannotComplete, .apiDisabled, .invalidUIElement, .actionUnsupported,
        ]
        for code in codes {
            for hasValue in [true, false] {
                let attributeRead = AXChannel.classifyAttributeRead(
                    error: code, hasValue: hasValue, processTrusted: true, action: "reading AXTitle"
                )
                let childrenRead = AXChannel.classifyAttributeRead(
                    error: code, hasValue: hasValue, processTrusted: true, action: "walking children"
                )
                XCTAssertEqual(
                    shape(of: attributeRead), shape(of: childrenRead),
                    "kAXError \(code.rawValue) (hasValue: \(hasValue)) is judged differently by the two reads"
                )
            }
        }
    }

    // MARK: - R2-15: never invent a comparable value

    func testUnreadValueThrowsForEveryPropertyInsteadOfAComparableDefault() {
        for property in AssertionProperty.allCases {
            XCTAssertThrowsError(
                try AXChannel.stringOrBool(from: nil, attribute: "AXValue", property: property),
                "\(property.rawValue) invented an observation out of nothing"
            ) { error in
                guard let channelError = error as? ChannelError,
                      case ChannelError.attributeUnavailable(let reason) = channelError else {
                    return XCTFail("expected attributeUnavailable, got \(error)")
                }
                XCTAssertTrue(reason.contains("no value"), reason)
            }
        }
    }

    func testBooleanPropertyDoesNotDefaultToFalseForNonBooleanAnswer() {
        for property in [AssertionProperty.enabled, .focused] {
            XCTAssertThrowsError(
                try AXChannel.stringOrBool(
                    from: "yes" as CFString, attribute: "AXEnabled", property: property
                ),
                "\(property.rawValue) fell back to .bool(false) for a value that is not a boolean"
            )
            XCTAssertThrowsError(
                try AXChannel.stringOrBool(
                    from: [1, 2] as NSArray, attribute: "AXEnabled", property: property
                )
            )
        }
    }

    func testTextPropertyDoesNotDefaultToEmptyString() {
        for property in [AssertionProperty.role, .title] {
            XCTAssertThrowsError(
                try AXChannel.stringOrBool(
                    from: NSNumber(value: 42), attribute: "AXTitle", property: property
                ),
                "\(property.rawValue) fell back to .string(\"\") for a non-text answer"
            )
        }
        XCTAssertThrowsError(
            try AXChannel.stringOrBool(
                from: [1, 2] as NSArray, attribute: "AXValue", property: .value
            ),
            "AXValue returned nothing comparable, so no string may be reported"
        )
    }

    /// The honest path stays intact: a value that really was read is reported.
    func testValuesThatWereReadStillConvert() throws {
        XCTAssertEqual(
            try AXChannel.stringOrBool(from: "Submit" as CFString, attribute: "AXTitle", property: .title),
            .string("Submit")
        )
        XCTAssertEqual(
            try AXChannel.stringOrBool(from: "AXButton" as CFString, attribute: "AXRole", property: .role),
            .string("AXButton")
        )
        XCTAssertEqual(
            try AXChannel.stringOrBool(from: NSNumber(value: 42), attribute: "AXValue", property: .value),
            .string("42")
        )
        XCTAssertEqual(
            try AXChannel.stringOrBool(from: true as CFTypeRef, attribute: "AXEnabled", property: .enabled),
            .bool(true)
        )
        XCTAssertEqual(
            try AXChannel.stringOrBool(from: false as CFTypeRef, attribute: "AXFocused", property: .focused),
            .bool(false)
        )
    }

    // MARK: - R2-19: the budget is a bound, not a per-node check

    func testPerCallTimeoutIsCappedAtTheMessagingDefault() throws {
        let timeout = try XCTUnwrap(
            AXChannel.messagingTimeout(remaining: AXChannel.treeTimeoutSeconds)
        )
        XCTAssertEqual(Double(timeout), AXChannel.messagingTimeoutSeconds, accuracy: 0.0001)
    }

    func testPerCallTimeoutScalesToWhatIsLeft() throws {
        for remaining: CFTimeInterval in [1.0, 0.5, 0.2] {
            let timeout = try XCTUnwrap(AXChannel.messagingTimeout(remaining: remaining))
            XCTAssertEqual(Double(timeout), remaining, accuracy: 0.0001)
        }
    }

    /// Below the floor no call is issued at all, and a zero timeout can never
    /// reach `AXUIElementSetMessagingTimeout` (there it means "system default",
    /// which would silently break the bound).
    func testExhaustedBudgetRefusesTheNextCall() {
        for remaining: CFTimeInterval in [
            0, -1, AXChannel.minMessagingTimeoutSeconds / 2,
            AXChannel.minMessagingTimeoutSeconds - 0.001,
        ] {
            XCTAssertNil(AXChannel.messagingTimeout(remaining: remaining))
        }
        XCTAssertNotNil(
            AXChannel.messagingTimeout(remaining: AXChannel.minMessagingTimeoutSeconds)
        )
    }

    /// Worst case for the old code: one budget check per node, but every node
    /// issues three attribute reads plus a children fetch, each with its own
    /// timeout — so the documented ceiling could be exceeded several times over.
    func testWorstCaseWalkCannotOvershootTheBudget() {
        let consumed = simulatedWalkSeconds(nodes: 50, callsPerNode: 4)
        XCTAssertLessThanOrEqual(consumed, AXChannel.treeTimeoutSeconds + 0.0001)
        // 预算确实被用满了（不是靠提前退出蒙过去的上界）。
        XCTAssertGreaterThan(consumed, AXChannel.treeTimeoutSeconds / 2)
    }

    func testBudgetGateAbortsBeforeIssuingADeadCall() {
        let element = AXUIElementCreateApplication(getpid())
        XCTAssertNoThrow(
            try AXChannel.enforceBudget(
                on: element,
                deadline: CFAbsoluteTimeGetCurrent() + AXChannel.treeTimeoutSeconds,
                what: "reading AXTitle"
            )
        )

        var thrown: ChannelError?
        XCTAssertThrowsError(
            try AXChannel.enforceBudget(
                on: element, deadline: CFAbsoluteTimeGetCurrent() - 1, what: "reading AXTitle"
            )
        ) { error in
            thrown = error as? ChannelError
        }
        guard case .treeCaptureFailed(let reason)? = thrown else {
            return XCTFail("an exhausted walk must be a tree capture failure, got \(String(describing: thrown))")
        }
        // EngineCore.map 靠 "budget" 这个词判定成因并给出可执行 remedy（文案耦合）。
        XCTAssertTrue(reason.lowercased().contains("budget"), reason)
        XCTAssertTrue(reason.contains("reading AXTitle"), reason)
    }

    // MARK: - Helpers

    /// 最坏情况模拟：每一次调用都把自己被允许的整段时间用满，返回累计秒数。
    private func simulatedWalkSeconds(nodes: Int, callsPerNode: Int) -> CFTimeInterval {
        var remaining = AXChannel.treeTimeoutSeconds
        var consumed: CFTimeInterval = 0
        walk: for _ in 0..<nodes {
            for _ in 0..<callsPerNode {
                guard let timeout = AXChannel.messagingTimeout(remaining: remaining) else {
                    break walk  // enforceBudget 在这里抛 treeCaptureFailed
                }
                let seconds = Double(timeout)
                XCTAssertLessThanOrEqual(seconds, remaining + 0.0001)
                XCTAssertGreaterThan(seconds, 0)
                remaining -= seconds
                consumed += seconds
            }
        }
        return consumed
    }

    /// 只看结局的形状（reason 文案里的 action 词组两边本来就不同）。
    private func shape(of outcome: AXChannel.AttributeReadOutcome) -> String {
        switch outcome {
        case .answered: return "answered"
        case .noAnswer: return "noAnswer"
        case .unreadable(let error):
            if case .pingTimeout = error { return "unreadable:pingTimeout" }
            if case .axUnavailable = error { return "unreadable:axUnavailable" }
            return "unreadable:\(error)"
        }
    }

    private func isUnreadable(_ outcome: AXChannel.AttributeReadOutcome) -> Bool {
        if case .unreadable = outcome { return true }
        return false
    }
}
