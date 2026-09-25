import XCTest
import Foundation
import ScreenCaptureKit
@testable import GlassPaneEngine

/// P1-A2 真机捕获验证（opt-in）：驱动 `SCKCapturer` 真实截一个**当前确实在屏的
/// 应用窗口**，断言返回非空 CGImage 且裁剪生效。仅当 GLASSPANE_SCK_DIAG=1 且本
/// 进程有屏幕录制席位时运行；CI 无 GUI 会话，会干净跳过。
///
/// 历史修正：这里原本写死 `finderPID = 706`。pid 每次开机都变，所以 2026-09-16
/// 那次通过之后它再也没绿过，而失败被当成"daemon 缺屏幕录制席位"记进了 P1 规格
/// 与 smoke.md 的观察——那条结论混进了一个 CGWindowList 键名错误（见 AXChannel
/// `frontmostWindow` 的注释），不能由这次诊断复现。现在每次现找目标。
final class SCKCapturerDiagnosticTests: XCTestCase {

    override func setUpWithError() throws {
        try super.setUpWithError()
        // 非诊断环境下跳过；准确的 skip 消息写入失败描述便于排查。
        guard ProcessInfo.processInfo.environment["GLASSPANE_SCK_DIAG"] == "1" else {
            throw XCTSkip("opt-in real-device capture diagnostic; set GLASSPANE_SCK_DIAG=1")
        }
        // 权限观察需要访问 CGPreflightScreenCaptureAccess（macOS 10.15+）。
        guard CGPreflightScreenCaptureAccess() else {
            throw XCTSkip("screen recording permission not granted in this context")
        }
    }

    func testRealAppCaptureReturnsCroppedImage() throws {
        let candidates = RealWindowCandidates.largestAppWindows()
        guard let target = candidates.first else {
            throw XCTSkip("此刻没有任何属于常规应用的在屏窗口可截（候选需要非本进程、应用层窗口）")
        }
        let capture = try SCKCapturer.captureWindow(ownerPid: target.pid, windowId: target.windowId)
        print("DIAG SCK CAPTURE OK app=\(target.name) pid=\(target.pid) window=\(capture.windowId) "
            + "px=\(capture.image.width)x\(capture.image.height) "
            + "frame=\(Int(target.frame.width))x\(Int(target.frame.height))")

        XCTAssertGreaterThan(capture.image.width, 0)
        XCTAssertGreaterThan(capture.image.height, 0)
        // 身份必须是真的那个窗口，不是"请求的那个"：回退到别的窗口时报告也要跟着改，
        // 否则上层会把两个不同窗口的差值当成一次像素测量。
        XCTAssertGreaterThan(capture.windowId, 0, "必须报出实际截到的窗口号")
        XCTAssertEqual(capture.windowId, target.windowId,
                       "SCK 落到了别的窗口（请求 \(target.windowId)，实得 \(capture.windowId)）")
        // 裁剪生效：输出宽高比必须跟着窗口走，否则截到的是整屏而不是这块区域。
        let frameRatio = target.frame.width / target.frame.height
        let imageRatio = CGFloat(capture.image.width) / CGFloat(capture.image.height)
        XCTAssertEqual(imageRatio, frameRatio, accuracy: max(0.08, frameRatio * 0.08),
                       "裁剪区域与窗口形状不符：image=\(imageRatio) frame=\(frameRatio)")
    }
}

// MARK: - Pure capture-context judgement (no live capture session)

/// R2-10 / R2-11 / A-19 的回归锚：窗口与显示器的选择判据、async→sync 桥的三种
/// 结局、以及"未测量"到 `pixelCaptureDenied` 的映射都是纯逻辑，不需要屏幕录制
/// 权限、不需要真机 SCStream，所以永远随全量套件跑（上面那个类是 opt-in 真机诊断）。
///
/// 钉住的三条判据：
///  - windowID 命中不等于属于目标进程：ID 被系统回收复用后，别的进程的画面会被
///    记成目标的前后像素。
///  - 没有显示器与窗口 frame 相交时必须失败：回落 `displays.first` + 越界
///    sourceRect 会得到一张合法但空白的图，上层据此判"像素没有变化"。
///  - 超时不是"查无内容"：丢弃 `wait(timeout:)` 的返回值等于把未测量报成正向结果。
final class SCKCapturerCaptureContextTests: XCTestCase {

    private static let targetPid: pid_t = 4242
    private static let otherPid: pid_t = 9999

    private struct StubError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }

    private func candidate(
        _ windowId: Int,
        owner: pid_t?,
        onScreen: Bool = true,
        frame: CGRect = CGRect(x: 0, y: 0, width: 100, height: 100)
    ) -> SCKCapturer.WindowCandidate {
        SCKCapturer.WindowCandidate(windowId: windowId, ownerPid: owner, isOnScreen: onScreen, frame: frame)
    }

    private func display(_ frame: CGRect) -> SCKCapturer.DisplayCandidate {
        SCKCapturer.DisplayCandidate(frame: frame)
    }

    /// 像素通道的未测量必须是 pixelCaptureDenied，且把 reason 交回给断言。
    private func reason<Value>(_ resolution: SCKCapturer.WaitResolution<Value>) -> String {
        switch resolution {
        case .value:
            XCTFail("期望未测量，实际取到了值")
            return ""
        case .failure(let error):
            switch error {
            case .pixelCaptureDenied(let text):
                return text
            default:
                XCTFail("像素通道的失败必须是 pixelCaptureDenied，实际 \(error)")
                return ""
            }
        }
    }

    // MARK: R2-10 — 两条分支同一属主判据

    func testRecycledWindowIdOwnedByAnotherProcessIsNeverCaptured() throws {
        let windows = [
            candidate(100, owner: Self.otherPid, frame: rect(0, 0, 800, 600)),
            candidate(200, owner: Self.targetPid, frame: rect(0, 0, 300, 200)),
        ]
        let index = try SCKCapturer.selectWindowIndex(
            candidates: windows, exactWindowId: 100, ownerPid: Self.targetPid
        )
        XCTAssertEqual(windows[index].windowId, 200, "ID 100 已归属别的进程，只能采目标进程自己的窗口")
        XCTAssertEqual(windows[index].ownerPid, Self.targetPid)
    }

    func testWindowWithoutOwningApplicationIsNotSelectable() {
        XCTAssertThrowsError(try SCKCapturer.selectWindowIndex(
            candidates: [candidate(100, owner: nil)], exactWindowId: 100, ownerPid: Self.targetPid
        )) { error in
            guard let failure = error as? SCKCapturer.ContextError else {
                return XCTFail("期望 ContextError，实际 \(error)")
            }
            XCTAssertEqual(failure, .noOnScreenWindow(ownerPid: Self.targetPid))
        }
    }

    func testExactMatchRequiresTheWindowToBeOnScreen() throws {
        let windows = [
            candidate(100, owner: Self.targetPid, onScreen: false, frame: rect(0, 0, 1000, 1000)),
            candidate(200, owner: Self.targetPid, frame: rect(0, 0, 300, 200)),
        ]
        let index = try SCKCapturer.selectWindowIndex(
            candidates: windows, exactWindowId: 100, ownerPid: Self.targetPid
        )
        XCTAssertEqual(windows[index].windowId, 200, "离屏窗口的像素不代表界面上的变化")
    }

    func testOwnedOnScreenExactMatchStillWinsOverLargerWindow() throws {
        let windows = [
            candidate(100, owner: Self.targetPid, frame: rect(0, 0, 200, 120)),
            candidate(200, owner: Self.targetPid, frame: rect(0, 0, 1600, 900)),
        ]
        XCTAssertEqual(
            try SCKCapturer.selectWindowIndex(candidates: windows, exactWindowId: 100, ownerPid: Self.targetPid),
            0
        )
    }

    func testFallbackPicksLargestOnScreenOwnedWindow() throws {
        let windows = [
            candidate(1, owner: Self.otherPid, frame: rect(0, 0, 4000, 4000)),
            candidate(2, owner: Self.targetPid, onScreen: false, frame: rect(0, 0, 4000, 4000)),
            candidate(3, owner: Self.targetPid, frame: rect(0, 0, 120, 80)),
            candidate(4, owner: Self.targetPid, frame: rect(0, 0, 640, 480)),
        ]
        XCTAssertEqual(
            try SCKCapturer.selectWindowIndex(candidates: windows, exactWindowId: nil, ownerPid: Self.targetPid),
            3
        )
    }

    func testFallbackKeepsFirstWindowWhenAreaTies() throws {
        let windows = [
            candidate(5, owner: Self.targetPid, frame: rect(0, 0, 200, 100)),
            candidate(6, owner: Self.targetPid, frame: rect(0, 0, 100, 200)),
        ]
        XCTAssertEqual(
            try SCKCapturer.selectWindowIndex(candidates: windows, exactWindowId: 999, ownerPid: Self.targetPid),
            0,
            "同面积保留先出现者：与修复前 max(by:) 的既有语义一致"
        )
    }

    func testTargetWithoutAnyOnScreenWindowIsNotMeasured() {
        let windows = [
            candidate(1, owner: Self.otherPid),
            candidate(2, owner: Self.targetPid, onScreen: false),
        ]
        XCTAssertThrowsError(try SCKCapturer.selectWindowIndex(
            candidates: windows, exactWindowId: nil, ownerPid: Self.targetPid
        )) { error in
            guard let failure = error as? SCKCapturer.ContextError else {
                return XCTFail("期望 ContextError，实际 \(error)")
            }
            XCTAssertEqual(failure, .noOnScreenWindow(ownerPid: Self.targetPid))
        }
    }

    // MARK: R2-11 — 没有包含显示器就是未测量，绝不拿替身显示器顶替

    func testWindowOnSecondDisplaySelectsThatDisplay() throws {
        let displays = [display(rect(0, 0, 1440, 900)), display(rect(1440, 0, 1920, 1080))]
        XCTAssertEqual(
            try SCKCapturer.selectDisplayIndex(
                displays: displays, windowFrame: rect(1500, 100, 400, 300),
                windowId: 77, ownerPid: Self.targetPid
            ),
            1
        )
    }

    func testWindowOutsideEveryDisplayFailsInsteadOfFallingBackToPrimary() {
        let outsideFrame = rect(5000, 5000, 200, 120)
        XCTAssertThrowsError(try SCKCapturer.selectDisplayIndex(
            displays: [display(rect(0, 0, 1440, 900))],
            windowFrame: outsideFrame,
            windowId: 77,
            ownerPid: Self.targetPid
        )) { error in
            guard let failure = error as? SCKCapturer.ContextError else {
                return XCTFail("期望 ContextError，实际 \(error)")
            }
            XCTAssertEqual(
                failure,
                .windowOutsideEveryDisplay(
                    ownerPid: Self.targetPid, windowId: 77, frame: outsideFrame, displayCount: 1
                )
            )
        }
    }

    func testEmptyDisplayListIsNotMeasured() {
        let windowFrame = rect(0, 0, 200, 120)
        XCTAssertThrowsError(try SCKCapturer.selectDisplayIndex(
            displays: [], windowFrame: windowFrame, windowId: 77, ownerPid: Self.targetPid
        )) { error in
            guard let failure = error as? SCKCapturer.ContextError else {
                return XCTFail("期望 ContextError，实际 \(error)")
            }
            XCTAssertEqual(
                failure,
                .windowOutsideEveryDisplay(
                    ownerPid: Self.targetPid, windowId: 77, frame: windowFrame, displayCount: 0
                )
            )
        }
    }

    func testZeroAreaWindowIsNotTreatedAsInsideADisplay() {
        // 空 rect 与任何显示器都不相交：过去回落主屏 + 0×0 sourceRect，
        // 采回一张 1×1 的空白图，现在这是一次显式未测量。
        XCTAssertThrowsError(try SCKCapturer.selectDisplayIndex(
            displays: [display(rect(0, 0, 1440, 900))],
            windowFrame: .zero,
            windowId: 77,
            ownerPid: Self.targetPid
        )) { error in
            guard let failure = error as? SCKCapturer.ContextError else {
                return XCTFail("期望 ContextError，实际 \(error)")
            }
            XCTAssertEqual(
                failure,
                .windowOutsideEveryDisplay(
                    ownerPid: Self.targetPid, windowId: 77, frame: .zero, displayCount: 1
                )
            )
        }
    }

    func testNotMeasuredReasonsStayDistinctAndCarryFacts() {
        let noWindow = SCKCapturer.channelError(for: .noOnScreenWindow(ownerPid: Self.targetPid))
        let outside = SCKCapturer.channelError(for: .windowOutsideEveryDisplay(
            ownerPid: Self.targetPid, windowId: 77, frame: rect(5000, 5000, 200, 120), displayCount: 1
        ))
        let noWindowText = pixelReason(noWindow)
        let outsideText = pixelReason(outside)
        XCTAssertFalse(noWindowText.isEmpty)
        XCTAssertNotEqual(noWindowText, outsideText, "两种未测量不能塌成同一条文案（诊断会指错方向）")
        XCTAssertTrue(noWindowText.contains("4242"), noWindowText)
        XCTAssertTrue(outsideText.contains("77"), outsideText)
        XCTAssertTrue(outsideText.contains("no SCDisplay intersects"), outsideText)
    }

    private func pixelReason(_ error: ChannelError) -> String {
        guard case .pixelCaptureDenied(let text) = error else {
            XCTFail("必须是 pixelCaptureDenied，实际 \(error)")
            return ""
        }
        return text
    }

    // MARK: A-19 — async→sync 桥的三种结局互不折叠

    func testCompletedBodyYieldsItsValue() throws {
        let outcome: SCKCapturer.WaitOutcome<Int> = SCKCapturer.waitForAsync(timeout: 2) { 7 }
        guard case .finished(let value, let error) = outcome else {
            return XCTFail("预算内完成的任务不该是超时，实际 \(outcome)")
        }
        XCTAssertEqual(value, 7)
        XCTAssertNil(error)
        switch SCKCapturer.resolveWait(outcome, subject: "SCShareableContent query", timeoutSeconds: 5) {
        case .value(let resolved):
            XCTAssertEqual(resolved, 7)
        case .failure(let failure):
            XCTFail("取到值的结局不该失败，实际 \(failure)")
        }
    }

    func testThrownErrorBecomesItsOwnFailureFact() {
        let outcome: SCKCapturer.WaitOutcome<Int> = SCKCapturer.waitForAsync(timeout: 2) {
            throw StubError(message: "boom")
        }
        guard case .finished(let value, let error) = outcome else {
            return XCTFail("预算内抛错的任务不该是超时，实际 \(outcome)")
        }
        XCTAssertNil(value, "抛错时不得留下可被误读成正向结果的值")
        XCTAssertEqual((error as? StubError)?.message, "boom")
        let text = reason(SCKCapturer.resolveWait(outcome, subject: "SCStream start", timeoutSeconds: 5))
        XCTAssertEqual(text, "SCStream start failed: boom")
    }

    func testTimeoutIsItsOwnFactAndNeverReadAsNoContent() {
        let outcome: SCKCapturer.WaitOutcome<Int> = SCKCapturer.waitForAsync(timeout: 0.02) {
            try await Task.sleep(nanoseconds: 200_000_000)
            return 42
        }
        guard case .timedOut = outcome else {
            return XCTFail("超时必须报成超时，实际 \(outcome)")
        }
        let text = reason(SCKCapturer.resolveWait(outcome, subject: "SCShareableContent query", timeoutSeconds: 5))
        XCTAssertTrue(text.contains("timed out after 5.0s"), text)
        XCTAssertFalse(text.contains("returned no result"), "超时不得折叠成\"查无内容\"（A-19 的根因）")
    }

    func testEmptyResultIsDistinctFromTimeout() {
        // `Value` is not inferable from two nils, so the case is pinned with a
        // concrete payload type; the assertion is about the outcome, not the value.
        let outcome: SCKCapturer.WaitOutcome<String> = .finished(value: nil, error: nil)
        let text = reason(SCKCapturer.resolveWait(
            outcome, subject: "SCShareableContent query", timeoutSeconds: 5
        ))
        XCTAssertEqual(text, "SCShareableContent query returned no result")
    }

    // MARK: A-19 — 交接盒的读写必须同步

    func testAsyncBoxHandsOverBothSlots() {
        let box = SCKCapturer.AsyncBox<Int>()
        var snapshot = box.snapshot()
        XCTAssertNil(snapshot.value)
        XCTAssertNil(snapshot.thrown)

        box.setValue(41)
        box.setThrown(StubError(message: "late writer"))
        snapshot = box.snapshot()
        XCTAssertEqual(snapshot.value, 41)
        XCTAssertNotNil(snapshot.thrown, "一对值必须在同一把锁下读出，取消后仍在写的任务不能只留下一半")
    }

    func testAsyncBoxSurvivesConcurrentLateWriters() throws {
        // 模拟 A-19 的真实形状：同步侧已经按超时收工，被取消的任务之后仍在写盒。
        let box = SCKCapturer.AsyncBox<Int>()
        let writers = 200
        let group = DispatchGroup()
        for index in 0..<writers {
            group.enter()
            DispatchQueue.global().async {
                box.setValue(index)
                group.leave()
            }
            // 与写入并发的读取：任何一次快照都必须是可读的、不炸锁。
            _ = box.snapshot()
        }
        group.wait()
        let value = try XCTUnwrap(box.snapshot().value)
        XCTAssertTrue((0..<writers).contains(value), "并发写入下必须留下其中一个终值，实际 \(value)")
    }
}