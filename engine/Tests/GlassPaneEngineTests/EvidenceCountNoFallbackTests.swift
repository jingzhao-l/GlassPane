import XCTest
import GlassPaneEngine
@testable import glasspane_settings

/// 项目「证据条数」：一次测量都不许被顶替。
///
/// 从前 `ConsoleModel.reloadProjects()` 把**本页在读的共用档案目录**当 `fallback`
/// 交给 `LocalArchive.evidenceCount(at:fallback:)`，于是没写 `evidenceStoragePath`
/// 的项目显示的是共用档案的文件条数。同一个事实在
/// `glasspaned --evidence-stats --project <id>` 那里答的是 `null` 并明说共享档案
/// 不是它的替身——两个面对一个事实给了两个答案，而面板那个是编出来的。
///
/// 另一半：同一个 nil 从前在列表行写「证据目录已清理」（一件什么都没观测过的事），
/// 在详情行写「证据目录不存在」。现在一个判据、一句字，两处共用。
final class EvidenceCountNoFallbackTests: XCTestCase {

    /// 造一个"注册项没写档案目录"的项目。
    private func entryWithoutArchive() -> ProjectEntry {
        ProjectEntry(
            projectId: "prj_noarchive", displayName: "没有档案的项目",
            bundleId: "com.example.noarchive", createdAt: "2026-10-14T00:00:00Z"
        )
    }

    /// 缺陷 3 的正身：没写目录 = **一次都没数**。计数器在这里必须不被调用。
    func testAProjectThatOwnsNoArchiveIsNeverCountedAgainstSomethingElse() {
        var askedDirectories: [String] = []
        let count = ConsoleModel.ownedEvidenceCount(for: entryWithoutArchive()) { path in
            askedDirectories.append(path)
            return 99
        }
        XCTAssertNil(count, "没配档案目录的项目只能报未测量，不许借别处的条数顶上")
        XCTAssertTrue(askedDirectories.isEmpty,
                      "它去数了别的地方：\(askedDirectories)")
    }

    /// 空白目录串与"没写"是同一种缺失，不许折成任何默认值。
    func testABlankArchivePathCountsAsUnmeasured() {
        var entry = entryWithoutArchive()
        entry.evidenceStoragePath = "   "
        XCTAssertNil(ConsoleModel.ownedEvidenceCount(for: entry) { _ in 7 })
    }

    /// 数的是注册项自己点名的那一个目录，不是别的。
    func testTheDirectoryCountedIsExactlyTheOneTheEntryNamed() {
        let named = TestSandbox.directory("own-archive")
        var entry = entryWithoutArchive()
        entry.evidenceStoragePath = named
        var asked: [String] = []
        let count = ConsoleModel.ownedEvidenceCount(for: entry) { path in
            asked.append(path)
            return 3
        }
        XCTAssertEqual(count, 3)
        XCTAssertEqual(asked, [named], "数的那个目录必须就是注册项写下的那一个")
    }

    // MARK: - 端到端：真的读一份注册表

    /// 在沙箱里造一份档案目录，放 `files` 个档案名的文件。
    private func makeArchive(_ directory: String, files: Int) throws {
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        for index in 0..<files {
            try Data("{}".utf8).write(
                to: URL(fileURLWithPath: directory + "/op_00000000000000000000000\(index).json")
            )
        }
    }

    /// 共用档案里有 5 条、项目自己的档案里有 2 条：那 5 条**永远**不许变成
    /// 没配目录那个项目的读数（这正是 revert 之后会红的断言）。
    @MainActor
    func testReloadProjectsNeverFoldsTheSharedArchiveIntoAProjectThatOwnsNone() async throws {
        let root = TestSandbox.directory("count-no-fallback")
        let shared = root + "/evidence"
        let owned = root + "/projects/p1/evidence"
        try makeArchive(shared, files: 5)
        try makeArchive(owned, files: 2)

        let registryPath = root + "/projects.json"
        let registry = ProjectRegistry(filePath: registryPath)
        let own = try registry.create(
            displayName: "自己有档案", bundleId: "com.example.own", evidenceStoragePath: owned
        )
        let ownerless = try registry.create(displayName: "没写档案目录", bundleId: "com.example.none")

        let console = ConsoleModel(
            env: ["GLASSPANE_STATE_DIR": root],
            home: "/Users/someone-else",
            evidenceDirectory: shared,
            projectsPath: registryPath
        )
        console.reloadProjects()
        for _ in 0..<200 {
            if console.projectsState == .loaded { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(console.projectsState, .loaded)
        XCTAssertEqual(console.projects.count, 2)

        XCTAssertEqual(console.projectEvidenceCounts[own.projectId] ?? nil, 2,
                       "它自己那份档案的条数要数到")
        XCTAssertNil(console.projectEvidenceCounts[ownerless.projectId] ?? nil,
                     "没配目录的项目读出来必须是未测量，而不是共用档案的那 5 条")
        XCTAssertEqual(
            ConsoleModel.evidenceCountReadout(console.projectEvidenceCounts[ownerless.projectId] ?? nil),
            "未测量（注册项没写证据目录，或那个目录不在）"
        )
    }

    // MARK: - 缺陷 4：一个 nil，两句字

    /// 唯一的那句字：nil 说的是"没测量"，不是一次发生过的清理。
    func testOneNilEmitsOneStringThatClaimsNothingUnobserved() {
        let unmeasured = ConsoleModel.evidenceCountReadout(nil)
        XCTAssertTrue(unmeasured.contains("未测量"), unmeasured)
        XCTAssertFalse(unmeasured.contains("已清理"),
                       "「已清理」是在宣称发生过一次清理，而这一页什么都没观测到：\(unmeasured)")
        XCTAssertFalse(unmeasured.contains("不存在"),
                       "同一句要能盖住两种来路，不能只描述其中一种：\(unmeasured)")
        XCTAssertEqual(ConsoleModel.evidenceCountReadout(3), "3 条")
    }

    /// 视图那一半：两处共用同一个判据，页面上不可能长出第二个说法。
    func testRowAndDetailPrintTheSameReadoutForTheSameNil() throws {
        let source = try PanelSourceText.code("ProjectsTabView.swift")
        XCTAssertEqual(PanelSourceText.occurrences(of: "evidenceCountReadout", in: source), 2,
                       "列表行与详情行不再共用那一个判据了")
        XCTAssertFalse(source.contains("已清理"), "那一行又写起了一件没发生过的清理")
        XCTAssertFalse(source.contains("不存在"), "详情那一行又自己写了一句措辞")
        XCTAssertFalse(source.contains("条证据"), "两处又开始各说各的单位了")
    }
}
