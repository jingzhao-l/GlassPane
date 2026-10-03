import XCTest
@testable import glasspane_settings

/// 证据列表那一行标签的换行计算。
///
/// 这一栏最窄只有 250pt，而一条记录最多能同时挂五枚标签（有人同时操作 / 降级 3 /
/// 诊断 T5 / 断言未过 / 画面 0.00%）。它们挤在一条 `HStack` 里时每枚都 `fixedSize`，
/// 放不下的那几枚不是被压缩，是被整枚裁掉——标签是颜色之外的第二种状态表达，
/// 裁掉就等于这个状态没有呈现。
final class ChipRowLayoutTests: XCTestCase {

    private let spacing: CGFloat = 5
    private let lineSpacing: CGFloat = 4
    private let chip = CGSize(width: 80, height: 18)

    private func place(_ sizes: [CGSize], _ maxWidth: CGFloat) -> (size: CGSize, frames: [CGRect]) {
        ChipRowLayout.place(sizes: sizes, maxWidth: maxWidth, spacing: spacing, lineSpacing: lineSpacing)
    }

    /// 反向变异：**放不下的时候跳过这一枚**（`continue` 而不是摆出来）——
    /// 于是"降级 3"这种状态在窄栏里直接消失，用户读到的是"这条记录没有降级"。
    func testEveryChipIsPlacedEvenWhenTheRowIsTooNarrow() {
        let five = Array(repeating: chip, count: 5)
        let result = place(five, 250)
        XCTAssertEqual(result.frames.count, 5, "一枚都不许丢")
        XCTAssertGreaterThan(Set(result.frames.map { $0.minY }).count, 1, "250pt 装不下五枚 80pt 的标签，必须折行")
    }

    /// 反向变异：**不折行、把超出可用宽度的部分留在同一行**——列表看起来是好的，
    /// 但右侧那几枚被窗口裁掉，等于把"这条记录最糟的地方"藏起来。
    func testNothingExtendsPastTheAvailableWidthWhenChipsCanWrap() {
        let result = place(Array(repeating: chip, count: 5), 250)
        for frame in result.frames {
            XCTAssertLessThanOrEqual(frame.maxX, 250 + 0.001, "越界：\(frame)")
            XCTAssertGreaterThanOrEqual(frame.minX, 0)
        }
        XCTAssertLessThanOrEqual(result.size.width, 250 + 0.001)
    }

    /// 单枚比可用宽度还长的标签：它必须仍被摆在行首。
    ///
    /// 反向变异：**先折行再摆放**（`x > 0` 那个条件写成 `x >= 0`）——空行上先加一次
    /// 行高，第一行凭空多出一段空白；反过来若在这里直接丢弃，长标签就永远看不见。
    func testOversizedChipIsPlacedRatherThanDropped() {
        let wide = CGSize(width: 400, height: 18)
        let result = place([wide, chip], 250)
        XCTAssertEqual(result.frames.count, 2)
        XCTAssertEqual(result.frames[0].minX, 0, "第一枚就在行首，不许先换行")
        XCTAssertEqual(result.frames[0].minY, 0)
        XCTAssertGreaterThan(result.frames[1].minY, 0, "第二枚得换到下一行")
    }

    /// 装得下时不许无端折行。
    func testSingleRowWhenEverythingFits() {
        let result = place(Array(repeating: chip, count: 2), 250)
        XCTAssertEqual(Set(result.frames.map { $0.minY }), [0], "两枚共 165pt，250pt 里就该是一行")
        XCTAssertEqual(result.size.height, chip.height)
        XCTAssertEqual(result.size.width, chip.width * 2 + spacing, accuracy: 0.001)
    }

    /// 行高取该行最高的一枚；空集合必须是零高，不能报一个假的高度。
    func testRowHeightFollowsTheTallestChip() {
        let tall = CGSize(width: 60, height: 30)
        let result = place([chip, tall], 250)
        XCTAssertEqual(result.size.height, 30)
        XCTAssertEqual(place([], 250).size.height, 0)
    }
}
