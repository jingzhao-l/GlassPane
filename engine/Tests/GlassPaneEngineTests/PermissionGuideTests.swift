import XCTest
@testable import GlassPaneEngine

/// P1 v1.2 拖拽引导纯逻辑验收：系统面板深链映射、引导文案、诚实边界
/// （开发者工具不可枚举）。逻辑层不触碰系统 API，可在无 TCC / 无 GUI 环境直测。
final class PermissionGuideTests: XCTestCase {

    // MARK: - 系统面板深链映射

    func testSystemPaneURLForAccessibility() {
        XCTAssertEqual(
            PermissionGuide.systemPaneURL(for: .accessibility),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        )
    }

    func testSystemPaneURLForInputMonitoring() {
        XCTAssertEqual(
            PermissionGuide.systemPaneURL(for: .inputMonitoring),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        )
    }

    func testSystemPaneURLForScreenRecording() {
        XCTAssertEqual(
            PermissionGuide.systemPaneURL(for: .screenRecording),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        )
    }

    func testSystemPaneURLForDeveloperTools() {
        // Automation 专属面板：仅适用于 Apple Events，体系里不可枚举 UI 状态。
        XCTAssertEqual(
            PermissionGuide.systemPaneURL(for: .developerTools),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        )
    }

    func testSystemPaneURLsAreUniquePerKind() {
        let urls = Set(PermissionKind.allCases.map { PermissionGuide.systemPaneURL(for: $0) })
        XCTAssertEqual(urls.count, PermissionKind.allCases.count, "四类权限必须映射到不同的面板深链")
    }

    // MARK: - 引导文案

    func testInstructionMentionsDroppedName() {
        for kind in [PermissionKind.accessibility, .inputMonitoring, .screenRecording] {
            let instruction = PermissionGuide.instruction(for: kind, droppedName: "MyGlassPane")
            XCTAssertTrue(instruction.contains("MyGlassPane"), "\(kind) 文案应包含被拖入的 app 名")
        }
    }

    func testInstructionUsesDefaultNameWhenNotProvided() {
        let instruction = PermissionGuide.instruction(for: .accessibility)
        XCTAssertTrue(instruction.contains("GlassPane"))
    }

    func testDeveloperToolsInstructionIsHonest() {
        // 诚实边界：开发者工具无系统总开关，文案必须说明触发动作即自动弹窗，
        // 不得声称可以打开开关或在 UI 点亮。
        let instruction = PermissionGuide.instruction(for: .developerTools)
        XCTAssertTrue(instruction.contains("无系统总开关"))
        XCTAssertTrue(instruction.contains("Apple Events"))
        XCTAssertTrue(instruction.contains("允许"))
        XCTAssertFalse(instruction.contains("变绿"), "developerTools 永远不可自动点亮，文案不应暗示变色")
    }

    func testBannerTextsAreNonEmptyAndMentionDrag() {
        XCTAssertTrue(PermissionGuide.bannerTitle.contains("拖"))
        XCTAssertFalse(PermissionGuide.bannerTitle.isEmpty)
        XCTAssertFalse(PermissionGuide.bannerHint.isEmpty)
    }

    // MARK: - 引导前后状态一致性（指令在同一 kind 上不串台）

    func testInstructionsAreDistinctPerKind() {
        let set = Set(PermissionKind.allCases.map { PermissionGuide.instruction(for: $0, droppedName: "GlassPane") })
        XCTAssertEqual(set.count, PermissionKind.allCases.count, "四类权限引导文案不得互相重复")
    }
}