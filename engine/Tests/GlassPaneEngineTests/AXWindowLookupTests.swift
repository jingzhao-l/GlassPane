import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// 窗口挑选是像素通路的入口：它认错键，`pixelDiff` 就永远是"未测量"。
/// 这段逻辑在真机上从 2026-09-15 起一直是死的（键名写成 "PID" / "Bounds"），
/// 而所有测试都是绿的——因为它当时是私有成员、又只在有窗口的会话里才可能被走到。
///
/// 夹具**刻意用字面量键名**，不引用产品的常量：用同一组常量造样本，等于让产品
/// 自己给自己出题——把 `windowOwnerPIDKey` 改回 `"PID"` 时夹具会跟着一起变，
/// 除了一条直读常量的断言外全都还是绿的。字面量才是"系统实际发出的那份形状"。
final class AXWindowLookupTests: XCTestCase {

    private static let ownerKey = "kCGWindowOwnerPID"
    private static let numberKey = "kCGWindowNumber"
    private static let boundsKey = "kCGWindowBounds"
    private static let layerKey = "kCGWindowLayer"

    private func entry(pid: Int, number: Int, width: Double, height: Double, layer: Int?) -> [String: Any] {
        var dict: [String: Any] = [
            Self.ownerKey: pid,
            Self.numberKey: number,
            Self.boundsKey: ["X": 0.0, "Y": 0.0, "Width": width, "Height": height],
        ]
        if let layer { dict[Self.layerKey] = layer }
        return dict
    }

    /// 回归钉：这四个键必须就是系统真正发出来的那几个。
    func testWindowInfoKeysMatchCoreGraphics() {
        XCTAssertEqual(AXChannel.windowOwnerPIDKey, "kCGWindowOwnerPID")
        XCTAssertEqual(AXChannel.windowNumberKey, "kCGWindowNumber")
        XCTAssertEqual(AXChannel.windowBoundsKey, "kCGWindowBounds")
        XCTAssertEqual(AXChannel.windowLayerKey, "kCGWindowLayer")
        // 旧实现用的这两个名字在真实字典里根本不存在：任何"顺手起的名字"都要能被这条打回。
        XCTAssertNotEqual(AXChannel.windowOwnerPIDKey, "PID")
        XCTAssertNotEqual(AXChannel.windowBoundsKey, "Bounds")
    }

    /// 对着真机字典形状测一遍：键名与尺寸都来自本机 CGWindowList 的实测输出。
    func testFrontmostWindowReadsRealShapeAndTakesTheFirstHit() {
        let list = [
            entry(pid: 707, number: 39, width: 1440, height: 900, layer: -2147483603),  // 桌面图片
            entry(pid: 707, number: 101, width: 800, height: 600, layer: 0),            // 应用窗口
            entry(pid: 2292, number: 198, width: 1440, height: 826, layer: 0),           // 别的应用
            entry(pid: 707, number: 102, width: 400, height: 300, layer: 0),             // 后面的窗口
        ]
        let found = AXChannel.frontmostWindow(in: list, for: 707)
        XCTAssertEqual(found?.0, 101, "必须跳过桌面层并取最前面的那个应用窗口")
        XCTAssertEqual(found?.1, CGRect(x: 0, y: 0, width: 800, height: 600))
        XCTAssertNil(AXChannel.frontmostWindow(in: list, for: 9999), "没有窗口的外来 pid 必须返回 nil")
    }

    /// 桌面/程序坞/通知中心都不算"应用的窗口"：拿它们算像素差会把壁纸变化
    /// 记成"界面变了"，那是比"没测到"更糟的假证据。
    func testSystemLayersAreNotAppWindows() {
        XCTAssertTrue(AXChannel.isAppWindowLayer(0))
        XCTAssertTrue(AXChannel.isAppWindowLayer(3), "浮动面板属于应用自己的层")
        XCTAssertFalse(AXChannel.isAppWindowLayer(-2147483625), "墙纸/桌面底片不是应用窗口")
        XCTAssertFalse(AXChannel.isAppWindowLayer(20), "程序坞前景不是")
        XCTAssertFalse(AXChannel.isAppWindowLayer(21), "通知中心不是")
        // 缺 layer 字段＝认不出这个窗口。放行等于让"读不到"变成"通过"——
        // 那正是把像素通路弄死十天的错误形态（键名写错时 `as? Int` 就是 nil）。
        XCTAssertFalse(AXChannel.isAppWindowLayer(nil), "读不出层号时必须不认，宁可报『没有窗口』")

        let onlyDesktop = [entry(pid: 707, number: 39, width: 1440, height: 900, layer: -2147483603)]
        XCTAssertNil(AXChannel.frontmostWindow(in: onlyDesktop, for: 707),
                     "只有桌面窗口时必须报『没有窗口』，而不是把桌面当窗口截走")
        let missingLayer = [entry(pid: 500, number: 7, width: 640, height: 480, layer: nil)]
        XCTAssertNil(AXChannel.frontmostWindow(in: missingLayer, for: 500),
                     "层号缺失的窗口不许被当成应用窗口截走")
    }

    /// 零尺寸窗口不能当命中：它会让后面的真窗口永远轮不到。
    func testZeroSizedWindowIsSkippedAndRealOneStillFound() {
        let list = [
            entry(pid: 500, number: 1, width: 0, height: 0, layer: 0),
            entry(pid: 500, number: 2, width: 320, height: 200, layer: 0),
        ]
        XCTAssertEqual(AXChannel.frontmostWindow(in: list, for: 500)?.0, 2)
    }

    /// bounds 字段换了形状（不是字典 / 少键）→ nil，而不是崩或猜一个矩形。
    func testMalformedBoundsAreRejectedNotGuessed() {
        let badShape: [[String: Any]] = [
            [Self.ownerKey: 7, Self.numberKey: 1, Self.boundsKey: "0,0,10,10", Self.layerKey: 0],
            [Self.ownerKey: 7, Self.numberKey: 2, Self.boundsKey: ["X": 0.0, "Y": 0.0, "Width": 10.0], Self.layerKey: 0],
        ]
        XCTAssertNil(AXChannel.frontmostWindow(in: badShape, for: 7))
    }
}
