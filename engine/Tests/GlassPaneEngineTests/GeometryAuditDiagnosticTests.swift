import XCTest
import AppKit
import CoreGraphics
import ImageIO
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
        // 不该被当成失败——但它必须每一条都有原因。上一版这里断言的是"unread 必须为 0"，
        // 那是把愿望写成了设计。
        XCTAssertGreaterThanOrEqual(Double(measured), Double(snapshot.nodes.count) * 0.8,
            "几何覆盖率低于 80%：\(measured)/\(snapshot.nodes.count)")
        let unreadNodes = snapshot.nodes.filter { if case .unread = $0.geometry { return true }; return false }
        for node in unreadNodes {
            if case let .unread(reason) = node.geometry {
                XCTAssertFalse(reason.isEmpty, "unread 必须带原因（\(node.path)），否则调用方无从判断")
            }
        }
        // 真正的不变式不是"有 unread 就必须 incomplete"——元素级读不到几何（例如
        // AXValue 不是可解码的形状）会留下 unread 而遍历照常走完，那时 complete=true
        // 是对的。必须成立的是：**放占位节点的那条路**（子树没答上）一定要把
        // complete 落下来，否则未走过的部分会被当成看过了。
        let placeholders = snapshot.nodes.filter { $0.role == AXChannel.unreadSubtreeRole }
        if !placeholders.isEmpty {
            XCTAssertFalse(snapshot.complete,
                "有 \(placeholders.count) 个 unread 占位子树却报 complete=true：结论会盖住没看过的部分")
        }
        // 占位节点不得伪装成可交互元素：它一旦进了 interactive 名单，"这个控件点不到"
        // 就会被报成界面的缺陷而不是我们没读到。
        for placeholder in placeholders {
            XCTAssertFalse(UILayoutAudit.isInteractiveRole(placeholder.role),
                           "占位角色 \(placeholder.role) 不能是可交互角色")
        }

        // 视觉通道的真机分支。这里以前只截"前台那个应用"，而真机前台是 Finder——
        // 它此刻确实没有在屏窗口（桌面归"墙纸"进程），于是"没有目标"和"没有授权"
        // 混成了同一条日志，happy path 一次也没被走到。现在改成：按 CGWindowList
        // 挑真有在屏窗口的常规应用逐个试，并把席位状态用系统 API 问出来，
        // 让"截到了"成为断言而不是运气。
        let seat = CGPreflightScreenCaptureAccess()
        let candidates = RealWindowCandidates.largestAppWindows()
        var captureAttempts: [String] = []
        var foreignPng: PngEncoding.Result?
        var capturedWindowId = 0
        for candidate in candidates {
            let label = "\(candidate.name) pid=\(candidate.pid)"
            do {
                let captureChannel = AXChannel()
                _ = try captureChannel.attach(bundleId: nil, pid: candidate.pid)
                let window = try captureChannel.captureWindow()
                let png = try PngEncoding.encode(window.image, scale: 0.6)
                foreignPng = png
                capturedWindowId = window.windowId
                print("DIAG CAPTURE OK app=\(label) window=\(window.windowId) "
                    + "pngBytes=\(png.byteCount) px=\(png.pixelWidth)x\(png.pixelHeight) "
                    + "points=\(Int(window.bounds.width))x\(Int(window.bounds.height))")
                break
            } catch let error {
                captureAttempts.append("\(label): \(String(describing: error))")
            }
        }
        for attempt in captureAttempts { print("DIAG CAPTURE FAIL " + attempt) }
        if seat && !candidates.isEmpty {
            XCTAssertNotNil(foreignPng,
                "席位在（CGPreflightScreenCaptureAccess=true）却有窗口的应用一个都截不成功：\(captureAttempts)")
        } else if seat {
            print("DIAG CAPTURE NO CANDIDATE 当前 Space 上没有别的应用窗口可截，外来窗口这条分支本上下文测不到")
        } else {
            print("DIAG CAPTURE NO SEAT 本进程没有屏幕录制席位，外来窗口这条分支在此上下文不可验证")
        }
        if let png = foreignPng {
            try assertRealPng(png, windowId: capturedWindowId)
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
        // 覆盖率不足/遍历未完成时结论必须跟着变弱；量到了才允许给干净判定。
        if !snapshot.complete {
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
        // 流水线本身必须有一次"确定能截到、而且知道该截到什么"的验证：
        // 本进程开一个纯红窗口，走同一条 `captureWindow()` → `PngEncoding` 通路截回来，
        // 再解码核对中心像素是红的。只断言"没报错"是不够的——键名写错那半年，
        // 这条通路报的也是"没有窗口"，听起来永远合理。
        let pipelined = try captureOwnRedWindow()
        print("DIAG CAPTURE SELF pngBytes=\(pipelined.byteCount) px=\(pipelined.pixelWidth)x\(pipelined.pixelHeight)")
        try assertRealPng(pipelined, windowId: nil)
        let center = try Self.centerPixel(of: pipelined)
        print("DIAG CAPTURE PIXEL r=\(center.red) g=\(center.green) b=\(center.blue)")
        XCTAssertGreaterThan(center.red, 0.9, "截回来的必须是自己刚画的那个红窗口，实际读到的像素: \(center)")
        // 阈值要紧：窗口是纯红（sRGB 1,0,0）。上一版容忍 g<0.35，而它自己记录的实测值
        // 就是 g=0.15 —— 那不是红，是色彩空间被换过一遍；宽到 0.35 等于"只要不是绿的都算过"。
        XCTAssertLessThan(center.green, 0.08, "中心像素带绿，说明截到的不是这个窗口：\(center)")
        XCTAssertLessThan(center.blue, 0.08, "中心像素带蓝，说明截到的不是这个窗口：\(center)")

    }

    /// 一张"真 PNG"的最低证明：base64 解得回字节、签名对、解得出图像、维度与自报一致、
    /// 且没有越过帧预算。`windowId` 只在"这次确实从某个窗口截的"时核对（不是 0 哨兵值，
    /// 那会让调用点悄悄关掉一条断言）。
    private func assertRealPng(_ png: PngEncoding.Result, windowId: Int?) throws {
        let bytes = try XCTUnwrap(Data(base64Encoded: png.base64))
        XCTAssertEqual(bytes.count, png.byteCount)
        XCTAssertEqual(Array(bytes.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        let source = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(decoded.width, png.pixelWidth, "真机图像：像素维度必须与自报一致")
        XCTAssertEqual(decoded.height, png.pixelHeight)
        XCTAssertGreaterThan(png.pixelWidth, 0)
        XCTAssertLessThanOrEqual(png.byteCount, PngEncoding.defaultMaxBytes,
                                 "真机窗口也必须落在帧预算内，超了就该走拒绝分支")
        if let windowId { XCTAssertGreaterThan(windowId, 0, "窗口号必须真的存在") }
    }

    /// 本进程自己开一个纯红窗口，用**产品同一条通路**截回来。
    /// 窗口一定关掉：这是在别人机器上跑的诊断，不留残骸。
    private func captureOwnRedWindow() throws -> PngEncoding.Result {
        // 命令行测试进程里 `NSApp` 是 nil（全局只在 NSApplicationMain 里赋值），
        // 必须先拿到 shared 实例再改策略——直接写 NSApp.xxx 会当场崩在这里。
        let app = NSApplication.shared
        let previousPolicy = app.activationPolicy()
        app.setActivationPolicy(.accessory)
        let window = NSWindow(
            contentRect: NSRect(x: 40, y: 40, width: 320, height: 200),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.isOpaque = true
        // sRGB 而不是 calibrated RGB：色彩空间转换会把纯红画成 (1, 0.15, 0)，
        // 那时"中心像素是红的"就退化成一条谁都能过的宽阈值。
        window.backgroundColor = NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)
        window.hasShadow = false
        window.level = .normal
        // 清理登记在窗口出现**之前**：orderFront 之后、采集之前任何一步抛错，
        // 都会把一张红窗口留在用户屏幕上。
        defer {
            window.orderOut(nil)
            app.setActivationPolicy(previousPolicy)
        }
        window.orderFrontRegardless()
        window.display()
        // 窗口服务器合成需要一点时间，否则截到的是"还没有这张窗口"。
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))

        let channel = AXChannel()
        _ = try channel.attach(bundleId: nil, pid: getpid())
        let capture = try channel.captureWindow()
        return try PngEncoding.encode(capture.image, scale: 1)
    }

    /// 解回 PNG 并读中心像素（RGBA8，逐字节自己数，不猜通道顺序）。
    private static func centerPixel(of png: PngEncoding.Result) throws -> (red: Double, green: Double, blue: Double) {
        let bytes = try XCTUnwrap(Data(base64Encoded: png.base64))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(
            CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                      bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        )
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let base = context.data else { return (-1, -1, -1) }
        let pointer = base.assumingMemoryBound(to: UInt8.self)
        let center = CGPoint(x: image.width / 2, y: image.height / 2)
        let offset = (Int(center.y) * context.bytesPerRow) + Int(center.x) * 4
        return (
            Double(pointer[offset]) / 255,
            Double(pointer[offset + 1]) / 255,
            Double(pointer[offset + 2]) / 255
        )
    }
}
