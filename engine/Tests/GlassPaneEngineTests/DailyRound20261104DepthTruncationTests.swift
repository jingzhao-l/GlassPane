import XCTest
import Foundation
@testable import GlassPaneEngine

/// 每日任务 2026-11-04（同日第二条会话）· 候选 I 复核成立并修完。
///
/// 缺陷。`AXChannel.findElement` 走到 `searchMaxDepth`（24）那一档就不再展开子节点，然后
/// 与"整棵树读完且没有匹配"共用同一个出口 `nil`；而它自己的文档写着 "nil means the whole
/// tree was read and nothing matched"。两个读者把那个 nil 各自打印成一句确定负例——
/// `performAction` 抛 `actRejected(reason: "no element matches the selector")`，
/// `readProperty` 抛 `assertTargetNotFound`，`EngineCore.map` 再把它写成
/// `message: "no element matches the selector"`。于是"这次搜索没走完"被产品说成
/// "界面上没有这个控件"，而同一层里 X-9 修掉的正是这一族（读不出属性却答"控件不存在"）。
///
/// 修法。判据留在 Swift：搜索回 `(match, truncatedByDepth)`，措辞由
/// `AXChannel.selectorMissReason(truncatedByDepth:)` 一处给出，act 与 assert 两面都从它取。
///
/// REVERSE：把 `performAction` 那一处改回硬写的 "no element matches the selector" ⇒
/// `theAbsenceSentenceHasExactlyOneAuthor` 红（同一句话出现两次）；把 `findElement` 里那句
/// `truncatedByDepth = true` 删掉 ⇒ 深度那一档再也没人报得出来，`stoppedExpandingIsSaidOutLoud` 红；
/// 把 `selectorMissReason(true)` 折回否定句 ⇒ 两档同答，`theTwoReadingsAreNotTheSameSentence` 红。
final class DailyRound20261104DepthTruncationTests: XCTestCase {

    private func source(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try XCTUnwrap(
            try? String(contentsOf: url, encoding: .utf8),
            "读不到 \(url.path)——这一条源码对照没有对照物了"
        )
    }

    /// 只数代码行：注释里提一次那句措辞不算一次拼写（本仓既有判据）。
    private func codeOnly(_ text: String) -> String {
        text.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("//") && !$0.hasPrefix("///") && !$0.hasPrefix("/*") && !$0.hasPrefix("*") }
            .joined(separator: "\n")
    }

    private static let absence = "no element matches the selector"

    // MARK: - 措辞真源

    func testTheTwoReadingsAreNotTheSameSentence() {
        let complete = AXChannel.selectorMissReason(truncatedByDepth: false)
        let truncated = AXChannel.selectorMissReason(truncatedByDepth: true)
        XCTAssertEqual(complete, Self.absence, "读完的负例不许跟着改口径——那是既有契约的句子")
        XCTAssertNotEqual(truncated, complete, "两档同答 ⇒ 深度上限又被说成确定负例")
        XCTAssertTrue(truncated.contains("never read"), truncated)
        XCTAssertFalse(truncated.contains(Self.absence),
                       "没走完的那一档不许复述确定负例：\(truncated)")
        // 那句必须给得出下一步，而不是只说"没测到"。
        XCTAssertTrue(truncated.contains("identifier") && truncated.contains("shallower"),
                      "出路要点名做得动的动作：\(truncated)")
    }

    func testStoppedExpandingIsSaidOutLoud() throws {
        // 深度数字不许在测试里再抄一份：它只能来自那一档的真源。
        let truncated = AXChannel.selectorMissReason(truncatedByDepth: true)
        let source = codeOnly(try source("Sources/GlassPaneEngine/AXChannel.swift"))
        let digits = source.components(separatedBy: "searchMaxDepth = ").dropFirst().first?
            .prefix { $0.isNumber } ?? ""
        XCTAssertFalse(digits.isEmpty, "找不到 searchMaxDepth 的取值——这条对照没有对照物")
        XCTAssertTrue(truncated.contains("depth \(digits)"),
                      "句子说的档数必须是代码里那一档：\(truncated) vs \(digits)")
    }

    // MARK: - 接线（一条事实只许有一个作者）

    func testTheAbsenceSentenceHasExactlyOneAuthor() throws {
        let channel = codeOnly(try source("Sources/GlassPaneEngine/AXChannel.swift"))
        let core = codeOnly(try source("Sources/GlassPaneEngine/EngineCore.swift"))
        let engine = channel.components(separatedBy: Self.absence).count - 1
        let inCore = core.components(separatedBy: Self.absence).count - 1
        XCTAssertEqual(engine + inCore, 1,
                       "那句确定负例现在有 \(engine)（AXChannel）+ \(inCore)（EngineCore）处拼写：除了 selectorMissReason 里的那一处，别处再写一次就会各漂一次")
        // 两个读者（act 与 assert）都必须从真源取措辞，而不是自己造句子。
        let calls = channel.components(separatedBy: "selectorMissReason(truncatedByDepth:").count - 1
        XCTAssertGreaterThanOrEqual(calls, 2,
            "AXChannel 里从真源取措辞的读者只剩 \(calls) 个：act 与 assert 两面各一个")
        XCTAssertTrue(core.contains("case .assertTargetNotFound(let reason)"),
                      "EngineCore 不再把映射写成一句自造的确定负例")
        XCTAssertTrue(channel.contains("truncatedByDepth: search.truncatedByDepth"),
                      "两个读者不再把搜索的 truncation 交给措辞真源")
    }

    // MARK: - 映射半边（assert 面）

    func testAssertFaceCarriesTheTruncationIntoTheWireMessage() throws {
        let reason = AXChannel.selectorMissReason(truncatedByDepth: true)
        let mapped = EngineCore.map(.assertTargetNotFound(reason: reason))
        XCTAssertEqual(mapped.code, .assertTargetNotFound, "错误码表是冻住的，这里只动措辞")
        XCTAssertTrue(mapped.message.contains("never read"), mapped.message)
        XCTAssertFalse(mapped.message.contains(Self.absence), mapped.message)
        let negative = EngineCore.map(.assertTargetNotFound(
            reason: AXChannel.selectorMissReason(truncatedByDepth: false)))
        XCTAssertEqual(negative.message, Self.absence, "读完的负例仍是那句既有契约")
    }
}
