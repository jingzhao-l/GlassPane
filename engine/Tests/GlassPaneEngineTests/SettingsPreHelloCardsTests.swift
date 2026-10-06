import XCTest
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 面板第一帧 hello **之前**的权限卡状态（纯初始化，不碰探针、不连 socket）。
///
/// 从前四张卡在还没问过 daemon 之前就被初始化成 `.notDetermined`（面板上写
/// "未请求"）。那是对一个尚未查询过的进程声称"它没请求过授权"——而这三态必须各
/// 说各话：未验证（没问到）/ 未在运行（问不到）/ 未请求（问到了，答复是没请求）。
@MainActor
final class SettingsPreHelloCardsTests: XCTestCase {

    func testCardsStartUnverifiableNotNotDetermined() {
        let entries = SettingsModel.entriesBeforeDaemonReport()
        XCTAssertEqual(entries.count, PermissionDescriptor.all.count)
        XCTAssertEqual(
            entries.map(\.status),
            Array(repeating: PermissionStatus.unverifiable, count: entries.count),
            "hello 之前一张卡都不许给出结论"
        )
        XCTAssertFalse(entries.contains { $0.status == .notDetermined },
                       "未请求是对没问过的 daemon 编出来的结论")
        XCTAssertFalse(entries.contains { $0.status == .granted })
        XCTAssertFalse(entries.contains { $0.status == .denied })
    }

    /// 三张能问的卡要说明"为什么没问出来"；开发者工具按设计恒为未验证，
    /// 它此刻还没有任何 daemon 可指，所以也不该先挂上"未在运行"这句。
    func testAskableCardsCarryTheNoDaemonReportNote() throws {
        let entries = SettingsModel.entriesBeforeDaemonReport()
        for kind in [PermissionKind.accessibility, .inputMonitoring, .screenRecording] {
            let entry = try XCTUnwrap(entries.first { $0.kind == kind })
            XCTAssertEqual(entry.status, .unverifiable)
            XCTAssertEqual(entry.statusNote, SettingsModel.noDaemonReportNote, "\(kind) 缺了原因说明")
        }
        let developerTools = try XCTUnwrap(entries.first { $0.kind == .developerTools })
        XCTAssertEqual(developerTools.status, .unverifiable)
        XCTAssertNil(developerTools.statusNote)
    }

    /// 标识符面（P1 §11.7 的机器核验）：未验证与未请求必须是两个不同的 id，
    /// 否则冒烟脚本读到的"未请求"和面板说的"未验证"会被当成同一件事。
    func testPreHelloIdentifiersDifferFromTheNotRequestedOnes() {
        for kind in [PermissionKind.accessibility, .inputMonitoring, .screenRecording] {
            let preHello = PermissionGuide.statusIdentifier(kind: kind, status: .unverifiable)
            let notRequested = PermissionGuide.statusIdentifier(kind: kind, status: .notDetermined)
            XCTAssertNotEqual(preHello, notRequested)
            XCTAssertTrue(preHello.hasSuffix("unverifiable"))
        }
    }
}
