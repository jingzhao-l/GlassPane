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

    // MARK: - 存活那一行的三句人话（同一判据的另一半：灯）

    /// 反向变异：**"应门但没回话"被并进"运行中"或"未运行"**（发现 1 的那处折叠），
    /// 或者三态里任何两态共用一句文案——那一枚灯就又成了一句没测过的断言。
    func testTheThreeMeasuredAnswersGetThreeDifferentSentences() {
        let running = SettingsModel.livenessCaption(.answering, footer: true)
        let absent = SettingsModel.livenessCaption(.notRunning, footer: true)
        let silent = SettingsModel.livenessCaption(.presentButSilent(reason: "r"), footer: true)
        XCTAssertEqual(running, "后台服务运行中")
        XCTAssertEqual(absent, "后台服务未运行")
        XCTAssertNotEqual(silent, running, "有人应门但没回话不是运行中")
        XCTAssertNotEqual(silent, absent, "它也不是未运行：那个名字后面确实有进程")
        XCTAssertTrue(silent.contains("没回话"), silent)
        // 卡内标题不带主语（那一张卡自己就叫「后台服务」）。
        XCTAssertTrue(SettingsModel.livenessCaption(.presentButSilent(reason: "r"), footer: false).contains("应门"))
    }

    /// 反向变异：**把版本号写死在文案里**，或者没实测到回话还印出版本号——
    /// 那一行就成了上一帧 hello 的遗照。
    func testSummaryLineOnlyNamesAVersionItActuallyHeard() {
        let entry = SettingsModel.DaemonEntry(
            socketPath: "/tmp/x.sock", liveness: .answering,
            version: "1.9.0", protocolVersion: "1.1", pid: 1, subject: nil
        )
        XCTAssertEqual(SettingsModel.daemonSummaryLine(entry), "运行中 1.9.0")

        var silent = entry
        silent.liveness = .presentButSilent(reason: "r")
        silent.version = nil
        XCTAssertFalse(SettingsModel.daemonSummaryLine(silent).contains("1.9.0"))
        XCTAssertTrue(SettingsModel.daemonSummaryLine(silent).contains("没回话"))

        var noVersion = entry
        noVersion.version = nil
        XCTAssertEqual(SettingsModel.daemonSummaryLine(noVersion), "运行中",
                       "没读到版本号就只说状态，不编一个占位数")
    }

    /// 反向变异：**"应门不回话"那一支借用了"未在运行"那句注记**——四张卡会把人
    /// 支去重启一个其实还活着的进程。
    func testTheSilentStateHasItsOwnCardNote() {
        XCTAssertNotEqual(SettingsModel.silentDaemonReportNote, SettingsModel.noDaemonReportNote)
        XCTAssertTrue(SettingsModel.silentDaemonReportNote.contains("没回话"),
                      SettingsModel.silentDaemonReportNote)
        XCTAssertTrue(SettingsModel.noDaemonReportNote.contains("未在运行"),
                      SettingsModel.noDaemonReportNote)
        for note in [SettingsModel.silentDaemonReportNote, SettingsModel.noDaemonReportNote] {
            XCTAssertFalse(note.contains("§"), "给人读的注记里不许有内部编号：\(note)")
        }
    }
}
