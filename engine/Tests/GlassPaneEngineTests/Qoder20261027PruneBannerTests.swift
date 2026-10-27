import XCTest
@testable import glasspane_settings

/// 2026-10-27 审查 E2：项目页「需要重启后才生效」那面旗子的收起判据。
///
/// 缺陷形状：收起只挂在 `.onChange(of: settings.restartOutcome)` 上，而 `onChange` 只在那个视图
/// 挂在屏上时收得到变化；另一条收起路径（`ConsoleModel.adoptDaemonReport`）只在 liveness
/// **翻转**时触发。于是"在项目页之外重启成功、且 1s 轮询没抓到 kill→bind 之间的空隙"会留下
/// 同一屏上两句互相矛盾的话：「注册表已改动，重启后台服务后它才会用新表」与
/// `restartOutcomeText` 的「已换新进程（pid X → Y）」。
///
/// 判据收成 `SettingsModel.pruneBannerCleared(by:)` 一处，两个入口（变化时 / 回到这一页时）共用。
final class Qoder20261027PruneBannerTests: XCTestCase {

    func testOnlyAMeasuredPidChangeClearsTheBanner() {
        XCTAssertTrue(
            SettingsModel.pruneBannerCleared(by: .confirmed(previousPid: 111, currentPid: 222)),
            "实测到换过进程号是唯一的收起理由"
        )
        // 其余四种都必须留着旗子：它们各自的含义都不是"重启成功了"。
        XCTAssertFalse(SettingsModel.pruneBannerCleared(by: .idle))
        XCTAssertFalse(SettingsModel.pruneBannerCleared(by: .inFlight))
        XCTAssertFalse(
            SettingsModel.pruneBannerCleared(by: .unchanged(pid: 111)),
            "pid 没变就是没换进程——旗子不能因为'跑了一次重启命令'就收"
        )
        XCTAssertFalse(SettingsModel.pruneBannerCleared(by: .launchctlFailed(status: 3, detail: "x")))
        XCTAssertFalse(SettingsModel.pruneBannerCleared(by: .spawnFailed))
    }

    func testConfirmedWithoutPreviousPidStillCountsAsANewProcess() {
        // 旧 daemon 读不出 pid（重启前那一读失败）时，换一个进程这个事实仍然成立：
        // 旗子该收。把它判成"没确认"就是让重启成功的人也永远摘不掉这句提示。
        XCTAssertTrue(SettingsModel.pruneBannerCleared(by: .confirmed(previousPid: nil, currentPid: 999)))
    }

    func testBothEntriesIntoThePageShareTheOnePredicate() {
        // 结构闸：两个入口都必须问同一句判据。少掉 `.onAppear` 那一支就是本次修的缺陷；
        // 把它写回 `if case .confirmed` 的本地副本，下一次改判据又会分叉。
        let src = sourceOfProjectsTab()
        let clearedCalls = src.components(separatedBy: "SettingsModel.pruneBannerCleared(by:").dropFirst().count
        XCTAssertGreaterThanOrEqual(
            clearedCalls, 2,
            "旗子的收起判据只剩一个入口了（onChange/onAppear 必须都用它）：\(clearedCalls)"
        )
        XCTAssertTrue(src.contains(".onAppear {"), "回到这一页时不再补判据，E2 就回来了")
        XCTAssertFalse(
            src.contains("if case .confirmed = outcome"),
            "项目页里又出现了一份本地判据副本——判据只住在 SettingsModel 那一处"
        )
    }

    private func sourceOfProjectsTab() -> String {
        let root = URL(fileURLWithPath: String(#filePath))
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/glasspane-settings/ProjectsTabView.swift")
        return (try? String(contentsOf: root, encoding: .utf8)) ?? ""
    }
}
