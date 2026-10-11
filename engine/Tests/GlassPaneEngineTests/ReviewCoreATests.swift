import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// Pins for the four review findings in the core-A engine files (slope maths,
/// classifier honesty, the occluder loop, the tap liveness read-back).
///
/// Two shapes of gate live here and they are labelled as such. A **behavioural**
/// test runs the code and would go red on its own if the arithmetic or the branch
/// changes. A **shape** gate reads the source text (comments stripped, the way
/// `CaptureChannelShapeTests` does it) and only proves the judgement is wired the
/// stated way — it is used where the real thing cannot be exercised in-process,
/// and each one says out loud which half it cannot see.
final class ReviewCoreATests: XCTestCase {

    // MARK: - Finding 1: least squares must not run on raw epoch time

    /// Eight samples, exactly 4 s apart on **real wall-clock epoch time** (the only
    /// x the tracker ever sees), with y rising exactly 500 per second in both
    /// accumulating channels. Centred least squares is exact here; the old raw
    /// accumulator (`n*Σxy - Σx*Σy`) subtracts two ~2e20 doubles to keep ~5e3, so
    /// every significant digit cancels — evaluated on this case's arithmetic, that
    /// formula returns 20.5 / 41 / 82 B/s for a true 500 depending on the epoch it
    /// was run at, or no slope at all once the garbage denominator rounds to zero.
    /// Either way the T9 breaker reads a leak as a flat line, or as "not measured".
    func testSlopeOfAFiveHundredBytePerSecondLeakSurvivesEpochTimestamps() throws {
        let epoch = Date().timeIntervalSince1970
        let tracker = DegradationTracker()
        for index in 0..<8 {
            XCTAssertTrue(tracker.record(DegradationSample(
                timestamp: epoch + Double(index) * 4,
                pingMs: 10,
                memoryBytes: Int64(1_000_000 + index * 2_000),
                handleCount: 100 + index * 2_000
            )), "sample \(index) rejected by the sample throttle: the window this test measures is not the window it intended")
        }

        let verdict = tracker.verdict()
        XCTAssertTrue(verdict.judged, verdict.basis)
        XCTAssertEqual(verdict.sampleCount, 8)

        let memory = try XCTUnwrap(
            verdict.memorySlopeBytesPerSec,
            "+500 B/s of real growth must produce a slope, not an absent one"
        )
        XCTAssertEqual(memory, 500, accuracy: 25, "5% of the measured rate, from real epoch x")

        let handles = try XCTUnwrap(
            verdict.handleSlopePerSec,
            "+500 fds/s of real growth must produce a slope, not an absent one"
        )
        XCTAssertEqual(handles, 500, accuracy: 25)
        XCTAssertGreaterThan(handles, 0, "a leak reported with the wrong sign never escalates")

        // A constant channel has no drift at all — centring is what makes it read
        // as zero instead of as cancellation noise.
        let ping = try XCTUnwrap(verdict.pingSlopeMsPerSec)
        XCTAssertEqual(ping, 0, accuracy: 1e-6, "y did not move: \(ping)")

        // 500 B/s sits under the 512 B/s memory floor, so the only driver is the
        // handle channel: the tier below is the number the act evidence publishes.
        XCTAssertEqual(verdict.drivers, ["handles"], "\(verdict.basis)")
        XCTAssertEqual(verdict.tier, .watch)
    }

    /// The other half: jitter must stay jitter. Same real epoch x, y wobbling ±200
    /// bytes around a constant with no trend to find — the centred slope reads that
    /// as ~6 B/s, an ocean below the 512 floor, and no channel escalates.
    func testSlopeOfPureJitterAroundAConstantStaysBelowTheNoiseFloor() throws {
        let epoch = Date().timeIntervalSince1970
        let jitter = [180.0, -60, 140, -200, 90, -150, 40, -110]
        let tracker = DegradationTracker()
        for (index, offset) in jitter.enumerated() {
            XCTAssertTrue(tracker.record(DegradationSample(
                timestamp: epoch + Double(index) * 4,
                pingMs: 10 + offset / 100,
                memoryBytes: Int64(1_000_000 + offset),
                handleCount: 100
            )))
        }

        let verdict = tracker.verdict()
        XCTAssertTrue(verdict.judged, verdict.basis)
        let memory = try XCTUnwrap(verdict.memorySlopeBytesPerSec)
        XCTAssertLessThan(abs(memory), 50, "±200 B of jitter is not a 50 B/s trend: \(memory)")
        let ping = try XCTUnwrap(verdict.pingSlopeMsPerSec)
        XCTAssertLessThan(abs(ping), 1, "±2 ms of jitter is not a 1 ms/s drift: \(ping)")
        XCTAssertEqual(verdict.drivers, [], "\(verdict.basis)")
        XCTAssertEqual(verdict.tier, .healthy)
    }

    /// The guards the centred rewrite had to keep: fewer than two *measured* points
    /// is not a trend, and a window with no time span returns nil rather than a
    /// division by a span of zero.
    func testSlopeStillRefusesASinglePointAndAZeroTimeSpan() throws {
        let epoch = Date().timeIntervalSince1970
        let oneMeasured = DegradationTracker(minimumSamplesForTrend: 2, minimumTrendSpanSeconds: 1)
        _ = oneMeasured.record(DegradationSample(
            timestamp: epoch, pingMs: nil, memoryBytes: 1_000, handleCount: nil
        ))
        _ = oneMeasured.record(DegradationSample(
            timestamp: epoch + 30, pingMs: nil, memoryBytes: nil, handleCount: nil
        ))
        let thin = oneMeasured.verdict()
        XCTAssertTrue(thin.judged, thin.basis)
        XCTAssertNil(thin.memorySlopeBytesPerSec, "one reading out of two samples is not a slope")
        XCTAssertTrue(thin.basis.contains("no slope"), thin.basis)

        // 同一时刻的六个样本：跨度为 0，必须拒答而不是拿一个除出来的数当斜率。
        // 节流阀在这里关掉，否则这条用例测的是节流阀。
        func zeroSpan(_ base: Double) -> DegradationVerdict {
            let tracker = DegradationTracker(
                minimumSamplesForTrend: 2, minSampleIntervalSeconds: 0, minimumTrendSpanSeconds: 0
            )
            for _ in 0..<6 {
                _ = tracker.record(DegradationSample(
                    timestamp: base, pingMs: 10, memoryBytes: 1_000, handleCount: 10
                ))
            }
            return tracker.verdict()
        }
        let stalled = zeroSpan(epoch)
        XCTAssertTrue(stalled.judged, stalled.basis)
        XCTAssertNil(stalled.memorySlopeBytesPerSec, "no x span must refuse, not divide")
        XCTAssertNil(stalled.handleSlopePerSec)
        XCTAssertNil(stalled.pingSlopeMsPerSec)

        // 这条拒绝**不许看时钟相位**。旧实现把跨度判据建立在中心化之后的 `Σx²` 上，
        // 而六个同一个 epoch 的均值不严格等于那个 epoch——残渣是 1e-7 量级、刚过 `> 0`，
        // 于是同一个断言在某些秒值下绿、在另一些下拿到一个 `0.0`：一条会自己消失又自己回来
        // 的红，正是这类"除法冒充测量"最难抓的形态。扫一段相位，每一格都必须拒答。
        var phases = 0
        for step in stride(from: 0.0, to: 300.0, by: 0.1) {
            let verdict = zeroSpan(epoch + step)
            XCTAssertNil(verdict.memorySlopeBytesPerSec, "相位 +\(step) 上没有跨度却给出了斜率")
            XCTAssertNil(verdict.handleSlopePerSec)
            XCTAssertNil(verdict.pingSlopeMsPerSec)
            phases += 1
        }
        XCTAssertGreaterThan(phases, 2_500, "相位扫描必须真的跑满，否则这条对照是空的")
    }

    // MARK: - Finding 2: an unmeasured pixel channel cannot answer for T3

    private func pack(axChanged: Bool, pixelRatio: Double?, breakerReason: String? = nil) -> EvidencePack {
        let selector = Selector(role: "AXButton", title: "Submit")
        return EvidencePack(
            operationId: "op_0123456789ABCDEFGHJKMNPQRS",
            createdAt: "2026-09-14T12:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: pixelRatio == nil ? .degraded : .normal,
                                           reason: breakerReason),
            signals: Signals(
                act: ActSignal(selector: selector, action: .press, actConfirmed: true),
                axEvent: AxEventSignal(
                    treeDigestBefore: "aa", treeDigestAfter: axChanged ? "bb" : "aa",
                    nodeCount: 10, axChanged: axChanged, latencyMs: 5
                ),
                pixelDiff: pixelRatio.map {
                    PixelDiffSignal(
                        changedPixelRatio: $0,
                        bounds: $0 > 0 ? Bounds(x: 1, y: 1, width: 2, height: 2) : nil,
                        windowId: 12
                    )
                },
                responsiveness: ResponsivenessSignal(responsive: true, pingMs: 3),
                crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
            )
        )
    }

    // MARK: - Finding 2 撤回：这条指控与规格相反，不在这里钉

    // 审查意见说"`axChanged == false` 且 `pixelDiff == nil` 落到 T3 是替未测量的通道作答，
    // 应改判 INCONCLUSIVE"。查过真值之后撤回：
    //   specs/GlassPane_P0_实施规格_v1.0.md:294 与 specs/GlassPane_P1_实施规格_v1.0_SCK迁移.md:80
    //   写的都是"屏幕录制权限拒绝 → pixelDiff=null：T3 判定仍可用（树+操作确认），
    //   T6 退化 INCONCLUSIVE"；specs/GlassPane_Audit_2026-09-22_全量审查与UI迭代.md 的 A-7
    //   处理过同一处，结论是"改文案、归类保持保守不变"。
    // 诚实由措辞保证（`pixelClause` 在无测量时说 "pixels not measured"），那条已由
    // ReviewFixes20261009Tests.testDeadClickStaysDecidableWithoutPixelsButMustSaySo 钉成闸。

    // MARK: - Finding 3: the occluder loop may only answer what it counted

    /// Behavioural, and the deterministic half: a window number the list cannot
    /// contain means the loop never reached the target, so nothing is known about
    /// which windows sit above it. It must answer "could not tell" (nil) — not
    /// `[]`, which the old code produced by running off the end of the list, and
    /// which `surfacePlan` reads as "nothing covers it, offer the display crop".
    /// The frame is deliberately desk-wide so a real window server's list cannot
    /// quietly return an empty overlap set for it either.
    func testOcclusionRefusesToAnswerWhenTheTargetIsNotInTheWindowList() throws {
        let desk = CGRect(x: -200_000, y: -200_000, width: 400_000, height: 400_000)
        let answer: [Int]? = SCKCapturer.occludingWindows(inFrontOf: -1, frame: desk)
        XCTAssertNil(answer, "target absent from the CG window list is not evidence of an uncovered window")
    }

    /// Behavioural, second deterministic half: even with a window list this process
    /// can read, an impossible target number must never come back as a positive
    /// "these windows cover it" list either — the count is the thing that broke.
    func testOcclusionDoesNotNameOccludersItNeverOrderedAgainst() throws {
        let answer: [Int]? = SCKCapturer.occludingWindows(
            inFrontOf: -1, frame: CGRect(x: 0, y: 0, width: 1, height: 1)
        )
        XCTAssertNil(answer, "\(answer ?? [])")
    }

    // MARK: - Shape gates (labelled: these read source text, they do not run it)

    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        return url.path
    }

    private func read(_ relative: String) throws -> String {
        let path = repoRoot + "/" + relative
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("no \(relative) to read; this gate cannot speak in this checkout")
        }
        return text
    }

    /// Comments carry the lesson in this repo (and mention the very literals these
    /// gates forbid), so they come off before scanning — the same discipline as
    /// `CaptureChannelShapeTests.codeOnly`.
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

    /// A member's body: from the marker to the next member declaration. Safe
    /// because the comments are already stripped, so no stray doc line ends it.
    private func body(of source: String, from marker: String) -> String? {
        guard let start = source.range(of: marker) else { return nil }
        var end = source.endIndex
        for terminator in [
            "\n    private static func ", "\n    static func ", "\n    private func ",
            "\n    fileprivate func ", "\n    public func ", "\n    private struct "
        ] {
            if let found = source.range(of: terminator, range: start.upperBound..<source.endIndex),
               found.lowerBound < end {
                end = found.lowerBound
            }
        }
        return String(source[start.lowerBound..<end])
    }

    /// SHAPE GATE, not behavioural. The unreadable-bounds neighbour cannot be put
    /// on this machine's window server on demand, so what is pinned is that the
    /// loop no longer fabricates a `CGRect(0,0,0,0)` from `?? 0` (which never
    /// intersects, dropping a real occluder out of the count and re-admitting the
    /// display crop), that it tracks the target being found at all, and that an
    /// uncountable set returns nil before the crop is offered. The two cases that
    /// are executable (target absent) are pinned above instead.
    /// REVERSE: put `?? 0` back, or drop the `foundTarget` guard → red here.
    func testOccluderLoopParsesBoundsStrictlyAndTracksTheTarget() throws {
        let source = codeOnly(try read("engine/Sources/GlassPaneEngine/SCKCapturer.swift"))
        let loop = try XCTUnwrap(
            body(of: source, from: "static func occludingWindows("),
            "no occludingWindows in SCKCapturer.swift — this gate is looking at nothing"
        )

        XCTAssertTrue(loop.contains("foundTarget = true"), "target found is never recorded")
        XCTAssertTrue(loop.contains("guard foundTarget"), "nothing confirms the target was in the list")
        XCTAssertTrue(loop.contains("raw[\"Width\"] as? CGFloat"), "bounds are not parsed strictly")
        XCTAssertFalse(loop.contains("?? 0"),
                       "a missing bound became 0, i.e. an empty rect that never intersects: \(loop)")

        let plan = try XCTUnwrap(
            body(of: source, from: "private static func surfacePlan("),
            "no surfacePlan in SCKCapturer.swift — this gate is looking at nothing"
        )
        XCTAssertTrue(plan.contains("plan.occlusionUncountable = true"), "an uncountable set is not recorded")
        guard let uncountable = plan.range(of: "plan.occlusionUncountable = true"),
              let earlyReturn = plan.range(of: "return plan", range: uncountable.upperBound..<plan.endIndex),
              let crop = plan.range(of: "\"display-region\"") else {
            return XCTFail("the refusal path is not there to check: \(plan)")
        }
        XCTAssertLessThan(earlyReturn.upperBound, crop.lowerBound,
                          "the crop candidate must be unreachable once the count is unknown")
    }

    /// SHAPE GATE, not behavioural: creating a real session tap here would swallow
    /// this machine's keyboard for the length of the suite, so the read-back cannot
    /// be exercised in-process (the file's own note says the same of the pump).
    /// What is pinned is that the alive flag comes from `CGEvent.tapIsEnabled` and
    /// not from the handle being non-nil — `CGEvent.tapEnable` returns nothing, and
    /// a tap the system disables *at creation* sends no disable callback, so the
    /// `noteTapDisabled` branch would never run and AttributionGuard would publish
    /// `monitored: true, contaminated: false` for a window nobody watched.
    /// REVERSE: `tapAlive = source != nil` → red here.
    func testTapLivenessIsAssignedFromTheEnabledReadBackNotFromTheHandle() throws {
        let source = codeOnly(try read("engine/Sources/GlassPaneEngine/CGEventInputMonitor.swift"))
        let install = try XCTUnwrap(
            body(of: source, from: "private func installTap("),
            "no installTap in CGEventInputMonitor.swift — this gate is looking at nothing"
        )

        XCTAssertTrue(install.contains("CGEvent.tapIsEnabled(tap: tap)"),
                      "no read-back: the enable request is being reported as the result")
        guard let assignment = install.range(of: "tapAlive = ") else {
            return XCTFail("installTap no longer assigns the alive flag at all")
        }
        let assigned = String(install[assignment.upperBound...].prefix(while: { $0 != "\n" }))
        XCTAssertTrue(assigned.contains("enabled"),
                      "the alive flag is \(assigned), i.e. not the read-back")
        XCTAssertFalse(assigned.contains("source != nil"),
                       "a handle without an enabled tap is \"monitoring\" again: \(assigned)")
        guard let readBack = install.range(of: "CGEvent.tapIsEnabled(tap: tap)") else { return }
        XCTAssertLessThan(readBack.upperBound, assignment.lowerBound,
                          "the flag is set before the read-back exists")
        XCTAssertTrue(install.contains("CGEventTapIsEnabled read false"),
                      "a false read-back must record the fault the way the disable callback does")
    }
}
