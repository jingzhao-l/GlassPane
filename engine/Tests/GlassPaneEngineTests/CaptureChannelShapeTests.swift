import XCTest
@testable import GlassPaneEngine

/// macOS 13 那条像素通道的两处形状闸 + evidence 落盘结论的传递闸。
///
/// 三条都是**静态形状**闸，原因分别是：
///  - `SCStream` 需要真实窗口与屏幕录制席位，CI 与本机都造不出来（本仓的
///    `SCKCapturerDiagnosticTests` 因此一直是 opt-in、默认 skip）；
///  - `glasspaned` 是 executable target，单测进不去内部函数。
/// 静态闸不是妥协的终点：每一条都写清了它防的那一次静默失效，并且都能被反向撤销
/// 让具名用例变红（见各条 REVERSE）。
final class CaptureChannelShapeTests: XCTestCase {

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
            throw XCTSkip("读不到 \(relative)；这一条对照在没有该文件的环境里不作数")
        }
        return text
    }

    /// 注释必须先剥掉再扫。本文件的注释里就写着 `waitForFirstFrame()` 与
    /// `addStreamOutput(_:type:)` 这两串字面量（那是教训本身），带着注释扫会让闸红在
    /// 自己的说明上——而一个人的第一反应是**改掉注释**让它变绿，那条真缺的登记就此
    /// 自由了。写法沿用 `mcp-shell/test/http-gateway.test.mjs` 的 `gatewayCode()`。
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

    /// `SCStream(filter:configuration:delegate:)` 的 `delegate` 只收生命周期回调，
    /// **不收帧**。这一句从前不存在，于是 `waitForFirstFrame()` 每次只能等到超时：
    /// macOS 13 的 pixelDiff 自始至终一次也没测到过，方向是诚实的（测不到就说不测到），
    /// 代价是每次 act 都要为一条永不产帧的通道付 5s × 候选窗口 × before/after。
    /// REVERSE：删掉 `addStreamOutput` 那一句 → 本条红（并且 `defer` 的 stopCapture
    /// 依旧把会话收干净，所以运行时看不出任何异常——正是"绿着却什么都没测"的形状）。
    func testMacOS13StreamRegistersAFrameOutputBeforeWaitingForTheFirstFrame() throws {
        let source = codeOnly(try read("engine/Sources/GlassPaneEngine/SCKCapturer.swift"))
        guard let start = source.range(of: "private static func snapViaStream") else {
            return XCTFail("SCKCapturer.swift 里找不到 snapViaStream，这条对照已不作数")
        }
        // 注释已被 codeOnly 剥掉，所以函数体的边界就是下一个 `private static func`。
        let end = source.range(of: "\n    private static func", range: start.upperBound..<source.endIndex)
        let body = String(source[start.lowerBound..<(end?.lowerBound ?? source.endIndex)])

        XCTAssertFalse(body.isEmpty)
        XCTAssertTrue(body.contains("addStreamOutput(bridge, to: stream)"),
                      "SCStream 的帧输出没有被登记：bridge 永远收不到帧")
        guard let register = body.range(of: "addStreamOutput(bridge, to: stream)"),
              let wait = body.range(of: "waitForFirstFrame()") else {
            return XCTFail("登记或等待至少有一个不见了，这条闸看不见东西")
        }
        XCTAssertLessThan(register.lowerBound, wait.lowerBound,
                          "登记必须发生在等首帧之前——先等再挂输出，等的就是空气")
        // 登记动作本身抽在下面那个 `addStreamOutput(_:to:)` 里，所以这两条在整份文件上核：
        // 类型写错或漏掉队列参数，编译与运行时都只表现为"登记没生效"。
        XCTAssertTrue(source.contains("stream.addStreamOutput("),
                      "抽出去的那个函数不再调用 SDK 的登记接口，调用点成了空壳")
        XCTAssertTrue(source.contains("type: .screen"),
                      "帧输出的类型不是 `.screen`，登记的是一条不存在的通道")
        XCTAssertTrue(source.contains("sampleHandlerQueue:"),
                      "这个 SDK 形态里唯一可用的登记签名带队列参数；漏掉它等于没登记")
    }

    /// 登记失败必须当场说话，不许伪装成一次超时。
    /// REVERSE：把 `catch` 里的 `pixelCaptureDenied` 改成继续往下走 → 本条红。
    func testStreamOutputRegistrationFailureIsNotReportedAsATimeout() throws {
        let source = codeOnly(try read("engine/Sources/GlassPaneEngine/SCKCapturer.swift"))
        guard let start = source.range(of: "addStreamOutput(bridge, to: stream)") else {
            return XCTFail("登记这一句不见了")
        }
        let from = start.lowerBound
        let limit = source.index(from, offsetBy: 600, limitedBy: source.endIndex) ?? source.endIndex
        let window = source[from..<limit]
        XCTAssertTrue(window.contains("catch"), "登记没有失败分支")
        XCTAssertTrue(window.contains("could not be attached"),
                      "登记失败要说它失败了，而不是让下一句把它读成一次超时：\(window)")
    }

    /// `store(pack)` 的落盘结论是 `Bool?`：`nil`＝没有档案存储这回事（缺席），
    /// `false`＝写了但没落到盘上。act 早就把这句话转给调用方（R1-07），
    /// assert_element 从前把返回值直接丢掉，却照样把 `evidenceId` 报出去——
    /// 调用方拿着一个重启后 `GP_E_NO_EVIDENCE` 的 id，以为证据已经存好了。
    /// REVERSE：把 `result["evidencePersisted"] = persistence` 删掉 → 本条红。
    func testAssertElementHandsOverThePersistenceVerdictItMeasured() throws {
        let source = codeOnly(try read("engine/Sources/GlassPaneEngine/EngineCore.swift"))
        guard let start = source.range(of: "public func assertElement(") else {
            return XCTFail("EngineCore.swift 里找不到 assertElement，这条对照已不作数")
        }
        let end = source.range(of: "\n    public func ", range: start.upperBound..<source.endIndex)
        let body = String(source[start.lowerBound..<(end?.lowerBound ?? source.endIndex)])

        XCTAssertTrue(body.contains("let persistence = store(pack)"),
                      "落盘结论又被丢回 `_`：evidenceId 成了空头承诺")
        XCTAssertTrue(body.contains("if let persistence { result[\"evidencePersisted\"] = persistence }"),
                      "结论测到了却没出口——和没有结论一样")
        // 下面两处不许用 `!`：本轮真把这句强制解包踩爆了——判据缺失时它让整条 xctest
        // 进程以 signal 5 收尾，红的那一条以外的结果全部丢失，CI 里看到的是一次环境故障而
        // 不是一个具名缺陷。闸要红得有名有姓，不能靠崩。
        guard let store = body.range(of: "let persistence = store(pack)"),
              let report = body.range(of: "evidencePersisted") else {
            return XCTFail("先测后报的两段里至少一段不见了：测得着的结论没有出口")
        }
        XCTAssertLessThan(store.lowerBound, report.lowerBound, "先测后报；顺序反了就是报一个没测过的值")
    }

    /// 状态根里那份 launchd 日志的名字只能有一处定义。这条盯的是**第二个读者**：
    /// 扫描用的那张表与 `child("update.log")` 必须成对出现，否则更新器写的日志名
    /// 改了、daemon 还在扫一个不存在的文件（`installer/test/log-modes.test.mjs` 从
    /// JS 侧盯同一条，这里从 Swift 侧盯被扫的那张表）。
    /// REVERSE：把 `updateLogFile` 从 `tightenPermissions` 的表里拿掉 → 本条红。
    func testUpdateLogIsDefinedInOnePlaceAndActuallySwept() throws {
        let source = codeOnly(try read("engine/Sources/GlassPaneEngine/StateRoot.swift"))
        XCTAssertTrue(source.contains("child(\"update.log\")"),
                      "update.log 的名字不在唯一出处，别处就会各抄一份")
        guard let start = source.range(of: "func tightenPermissions") else {
            return XCTFail("StateRoot.swift 里找不到 tightenPermissions")
        }
        let end = source.range(of: "\n    ///", range: start.upperBound..<source.endIndex)
        let sweep = String(source[start.lowerBound..<(end?.lowerBound ?? source.endIndex)])
        XCTAssertTrue(sweep.contains("updateLogFile"),
                      "update.log 只是定义了，没进被收紧的那张表：那份日志仍归 umask 说了算")
    }
}
