import XCTest
import AppKit
@testable import GlassPaneEngine

/// 真机几何诊断（opt-in）：对**当前前台应用**跑一次 `geometrySnapshot` +
/// `UILayoutAudit`，用来回答单元测试答不了的那个问题——真实应用的无障碍树里
/// 到底有多少元素肯给 position/size，规则在真实界面上会不会胡说。
///
/// 仅当 `GLASSPANE_LAYOUT_DIAG=1` 且本进程被系统授予辅助功能时运行；CI 无 GUI
/// 会话也无授权，会干净跳过，不影响全量绿（与 SCKCapturerDiagnosticTests 同惯例）。
///
/// 刻意只做只读遍历：不构造 EngineCore、不建 ProjectRegistry、不碰证据存储，
/// 因此这条测试没有任何路径能写到 ~/.glasspane（那里曾被一次测试覆盖掉真实注册表）。
final class GeometryAuditDiagnosticTests: XCTestCase {

    private var target: NSRunningApplication?

    override func setUpWithError() throws {
        try super.setUpWithError()
        guard ProcessInfo.processInfo.environment["GLASSPANE_LAYOUT_DIAG"] == "1" else {
            throw XCTSkip("opt-in real-device geometry diagnostic; set GLASSPANE_LAYOUT_DIAG=1")
        }
        guard AXIsProcessTrusted() else {
            throw XCTSkip("accessibility permission not granted in this context")
        }
        // 只读地挑一个真有界面的前台应用；找不到就跳过，不去 spawn 任何进程。
        guard let front = NSWorkspace.shared.runningApplications.first(where: { app in
            app.isActive && app.activationPolicy == .regular && app.processIdentifier != getpid()
        }) ?? NSWorkspace.shared.runningApplications.first(where: { app in
            app.activationPolicy == .regular && app.processIdentifier != getpid()
        }) else {
            throw XCTSkip("no regular GUI application is running to inspect")
        }
        target = front
    }

    func testRealAppGeometryIsReadableAndAuditStaysHonest() throws {
        guard let app = target else { return }
        let channel = AXChannel()
        _ = try channel.attach(bundleId: nil, pid: app.processIdentifier)

        let snapshot = try channel.geometrySnapshot(maxDepth: 8)
        XCTAssertFalse(snapshot.nodes.isEmpty, "\(app.localizedName ?? "?") 的树不该是空的")

        let measured = snapshot.nodes.filter { if case .measured = $0.geometry { return true }; return false }.count
        let absent = snapshot.nodes.filter { if case .absent = $0.geometry { return true }; return false }.count
        let unread = snapshot.nodes.filter { if case .unread = $0.geometry { return true }; return false }.count
        let windowSide = snapshot.window.map { "\($0.width)x\($0.height)" } ?? "unknown"
        print("DIAG GEOMETRY app=\(app.localizedName ?? "?") nodes=\(snapshot.nodes.count) "
            + "measured=\(measured) absent=\(absent) unread=\(unread) window=\(windowSide) "
            + "latencyMs=\(String(format: "%.1f", snapshot.latencyMs))")

        // 真正的判据只有一条：几何必须基本量得到。若一条都读不到，说明遍历本身坏了，
        // 而不是"这个应用没有可用界面"——两者不能混成一次"通过"。
        XCTAssertGreaterThan(measured, 0, "一次都没读到 position/size，说明几何遍历不可用（不是界面问题）")
        // 真机上"某个子树那一刻没回 AX"是常态（kAXError -25200），所以 unread
        // 不该被当成失败——但它必须每一条都有原因，并且整体覆盖率达标。
        // 上一版这里断言的是"unread 必须为 0"，那是把愿望写成了设计。
        XCTAssertGreaterThanOrEqual(Double(measured), Double(snapshot.nodes.count) * 0.8,
            "几何覆盖率低于 80%：\(measured)/\(snapshot.nodes.count)")
        if unread > 0 {
            let reasons = snapshot.nodes.compactMap { node -> String? in
                if case let .unread(reason) = node.geometry { return reason }
                return nil
            }
            XCTAssertEqual(reasons.count, unread)
            for reason in reasons { XCTAssertFalse(reason.isEmpty, "unread 必须带原因，否则调用方无从判断") }
            XCTAssertFalse(snapshot.complete, "有未读子树却报 complete=true：结论会盖住没看过的部分")
        }

        // 视觉通道的真机分支：这台机器上 daemon 有屏幕录制、而测试进程继承的是
        // 代理宿主的席位，所以两条分支都可能。两条都如实打印，绝不静默——
        // "没测到"和"测了没通过"必须能被区分。
        do {
            let capture = try channel.captureWindow()
            let encoded = try PngEncoding.encode(capture.image, scale: 0.6)
            print("DIAG CAPTURE OK window=\(capture.windowId) pngBytes=\(encoded.byteCount) "
                + "px=\(encoded.pixelWidth)x\(encoded.pixelHeight)")
            XCTAssertGreaterThan(encoded.byteCount, 0)
        } catch let error as ChannelError {
            print("DIAG CAPTURE DENIED \(error)")
        } catch let error as PngEncoding.EncodingError {
            print("DIAG CAPTURE TOO LARGE \(error)")
        }

        let result = UILayoutAudit.audit(snapshot)
        print("DIAG AUDIT verdict=\(result.verdict.rawValue) findings=\(result.findings.count) "
            + "coverage=\(String(format: "%.2f", result.coverage.ratio)) truncated=\(result.overlapScanTruncated)")
        // 先绑定再打印：字符串插值里放跨行的闭包，Swift 解析不了（编译期就炸）。
        let counts = result.ruleCounts.sorted { $0.value > $1.value }
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: " ")
        print("DIAG AUDIT COUNTS " + counts)
        for finding in result.findings.prefix(8) {
            print("  - \(finding.rule)/\(finding.severity.rawValue) path=\(finding.elementPath ?? "-") "
                + "role=\(finding.role ?? "-") title=\(finding.title ?? "-") :: \(finding.detail)")
        }
        // 覆盖率不足时结论必须跟着变弱；量到了才允许给干净判定。
        if unread > 0 {
            XCTAssertTrue(result.findings.contains { $0.rule == "geometryScanIncomplete" },
                          "遍历不完整却没在结论里说：\(result.findings.map(\.rule))")
        }
        if result.coverage.ratio < UILayoutAudit.passCoverageRatio {
            XCTAssertEqual(result.verdict, .insufficient, "覆盖率不足却给出了 \(result.verdict)")
        }
        XCTAssertTrue(
            measured == snapshot.nodes.count || result.verdict != .pass,
            "只量到一部分元素却报了 pass：部分测量不能换全量结论"
        )
    }
}
