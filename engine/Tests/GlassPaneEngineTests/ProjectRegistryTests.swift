import XCTest
@testable import GlassPaneEngine

/// Tests for ProjectRegistry and project management (P1 spec v1.4).
final class ProjectRegistryTests: XCTestCase {

    // MARK: - Helpers

    private func tempFilePath() -> String {
        let dir = NSTemporaryDirectory()
        let name = "glasspane-test-\(UUID().uuidString).json"
        return (dir as NSString).appendingPathComponent(name)
    }

    private var testDate: Date {
        // Fixed date for deterministic roundtrip.
        Date(timeIntervalSince1970: 1_700_000_000)
    }

    // MARK: - CRUD

    func testCreateAndList() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }

        let registry = ProjectRegistry(filePath: path)
        XCTAssertEqual(registry.count, 0)

        let entry = try registry.create(
            displayName: "Test App",
            bundleId: "com.example.test",
            now: { self.testDate }
        )
        XCTAssertEqual(registry.count, 1)
        XCTAssertTrue(entry.projectId.hasPrefix("prj_"))
        XCTAssertEqual(entry.displayName, "Test App")
        XCTAssertEqual(entry.bundleId, "com.example.test")
        XCTAssertNil(entry.pid)
    }

    func testGetByProjectId() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }

        let registry = ProjectRegistry(filePath: path)
        let entry = try registry.create(displayName: "X", pid: 1234, now: { self.testDate })

        let found = registry.get(entry.projectId)
        XCTAssertNotNil(found)
        XCTAssertEqual(found?.displayName, "X")
        XCTAssertEqual(found?.pid, 1234)
        XCTAssertNil(registry.get("prj_NONEXISTENT"))
    }

    func testUpdate() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }

        let registry = ProjectRegistry(filePath: path)
        let entry = try registry.create(displayName: "Old", bundleId: "com.a", now: { self.testDate })

        let updated = try registry.update(
            projectId: entry.projectId,
            displayName: "New",
            bundleId: "com.b"
        )
        XCTAssertEqual(updated.displayName, "New")
        XCTAssertEqual(updated.bundleId, "com.b")
        // Other fields unchanged.
        XCTAssertEqual(updated.projectId, entry.projectId)
        XCTAssertEqual(updated.createdAt, entry.createdAt)
    }

    func testRemove() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }

        let registry = ProjectRegistry(filePath: path)
        let entry = try registry.create(displayName: "R", bundleId: "com.r", now: { self.testDate })
        XCTAssertEqual(registry.count, 1)

        let removed = try registry.remove(entry.projectId)
        XCTAssertTrue(removed)
        XCTAssertEqual(registry.count, 0)
        XCTAssertNil(registry.get(entry.projectId))
    }

    func testRemoveNotFoundThrows() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }

        let registry = ProjectRegistry(filePath: path)
        XCTAssertThrowsError(try registry.remove("prj_NONEXISTENT")) { error in
            let gpError = error as! GPError
            XCTAssertEqual(gpError.code, .notFound)
        }
    }

    // MARK: - Limits

    func testProjectLimit() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }

        let registry = ProjectRegistry(filePath: path)
        for i in 0..<ProjectEntry.maxProjects {
            try registry.create(displayName: "App \(i)", bundleId: "com.test.\(i)", now: { self.testDate })
        }
        XCTAssertEqual(registry.count, ProjectEntry.maxProjects)

        XCTAssertThrowsError(try registry.create(displayName: "Overflow", bundleId: "com.overflow", now: { self.testDate })) { error in
            let gpError = error as! GPError
            XCTAssertEqual(gpError.code, .projectLimit)
        }
    }

    func testEmptyDisplayNameRejected() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }

        let registry = ProjectRegistry(filePath: path)
        XCTAssertThrowsError(try registry.create(displayName: "", bundleId: "com.a", now: { self.testDate })) { error in
            let gpError = error as! GPError
            XCTAssertEqual(gpError.code, .badParams)
        }
    }

    func testBundleIdOrPidRequired() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }

        let registry = ProjectRegistry(filePath: path)
        // Neither bundleId nor pid.
        XCTAssertThrowsError(try registry.create(displayName: "X", now: { self.testDate })) { error in
            let gpError = error as! GPError
            XCTAssertEqual(gpError.code, .badParams)
        }
    }

    // MARK: - Persistence roundtrip

    func testPersistenceRoundtrip() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }

        // Write.
        let registry1 = ProjectRegistry(filePath: path)
        let entry1 = try registry1.create(
            displayName: "Persistent App",
            bundleId: "com.persist",
            recipeConfigPath: "/tmp/recipe.yaml",
            now: { self.testDate }
        )
        XCTAssertEqual(registry1.count, 1)

        // Reload from file.
        let registry2 = ProjectRegistry(filePath: path)
        XCTAssertEqual(registry2.count, 1)
        let entry2 = registry2.get(entry1.projectId)
        XCTAssertNotNil(entry2)
        XCTAssertEqual(entry2?.displayName, "Persistent App")
        XCTAssertEqual(entry2?.bundleId, "com.persist")
        XCTAssertEqual(entry2?.recipeConfigPath, "/tmp/recipe.yaml")
        XCTAssertEqual(entry2?.createdAt, entry1.createdAt)
    }

    // MARK: - EngineCore integration

    func testEngineCoreProjectMethods() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let registry = ProjectRegistry(filePath: tempFilePath())
        defer { try? FileManager.default.removeItem(atPath: registry.filePath) }

        let core = EngineCore(channel: channel, projectRegistry: registry)

        // List (empty).
        let listResult = try core.projectList()
        let projects = listResult["projects"] as! [[String: Any]]
        XCTAssertEqual(projects.count, 0)

        // Create.
        let setResult = try core.projectSet(
            projectId: nil,
            displayName: "Engine Test",
            bundleId: "com.engine.test",
            pid: nil,
            recipeConfigPath: nil,
            calibrationAssetsPath: nil,
            evidenceStoragePath: nil
        )
        let project = setResult["project"] as! [String: Any]
        let projectId = project["projectId"] as! String
        XCTAssertTrue(projectId.hasPrefix("prj_"))
        XCTAssertEqual(project["displayName"] as? String, "Engine Test")

        // Get.
        let getResult = try core.projectGet(projectId: projectId)
        let fetched = getResult["project"] as! [String: Any]
        XCTAssertEqual(fetched["displayName"] as? String, "Engine Test")

        // List (1 entry).
        let listAfter = try core.projectList()
        let projectsAfter = listAfter["projects"] as! [[String: Any]]
        XCTAssertEqual(projectsAfter.count, 1)
    }

    func testEngineCoreProjectGetNotFound() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let registry = ProjectRegistry(filePath: tempFilePath())
        defer { try? FileManager.default.removeItem(atPath: registry.filePath) }

        let core = EngineCore(channel: channel, projectRegistry: registry)
        XCTAssertThrowsError(try core.projectGet(projectId: "prj_NONEXISTENT")) { error in
            let gpError = error as! GPError
            XCTAssertEqual(gpError.code, .notFound)
        }
    }

    // MARK: - Project switch via attach (spec v1.4 §1.3, P1-E4)

    func testAttachWithProjectIdAssociatesActiveProject() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let registry = ProjectRegistry(filePath: tempFilePath())
        defer { try? FileManager.default.removeItem(atPath: registry.filePath) }

        let entry = try registry.create(
            displayName: "Target",
            bundleId: "com.example.app",
            now: { self.testDate }
        )

        let core = EngineCore(channel: channel, projectRegistry: registry)
        XCTAssertNil(core.activeProjectId)

        _ = try core.attach(bundleId: "com.example.app", pid: nil, projectId: entry.projectId)
        XCTAssertEqual(core.activeProjectId, entry.projectId)
    }

    func testAttachThrowsNotFoundForUnknownProjectId() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let registry = ProjectRegistry(filePath: tempFilePath())
        defer { try? FileManager.default.removeItem(atPath: registry.filePath) }

        let core = EngineCore(channel: channel, projectRegistry: registry)
        XCTAssertThrowsError(try core.attach(bundleId: "com.example.app", pid: nil, projectId: "prj_NONEXISTENT")) { error in
            let gpError = error as! GPError
            XCTAssertEqual(gpError.code, .notFound)
        }
    }

    func testAttachRejectsBundleIdMismatch() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let registry = ProjectRegistry(filePath: tempFilePath())
        defer { try? FileManager.default.removeItem(atPath: registry.filePath) }

        let entry = try registry.create(
            displayName: "Target",
            bundleId: "com.expected",
            now: { self.testDate }
        )
        let core = EngineCore(channel: channel, projectRegistry: registry)
        XCTAssertThrowsError(try core.attach(bundleId: "com.other", pid: nil, projectId: entry.projectId)) { error in
            let gpError = error as! GPError
            XCTAssertEqual(gpError.code, .badParams)
        }
        // Attach without projectId still succeeds; activeProject stays nil.
        _ = try core.attach(bundleId: "com.other", pid: nil, projectId: nil)
        XCTAssertNil(core.activeProjectId)
    }

    // MARK: - Corrupt registry must not be overwritten (A-1/B-1 的拒绝分支)

    /// 一个读不回的 projects.json：`loadFailed` 置位，写入被**拒绝**，磁盘上的
    /// 字节一个都不动。此前这里是"损坏＝空表"，紧接着任何一次 create 就把用户的
    /// 全部注册项覆掉——与 `ApprovalGate.loadFailed` 同口径修掉，用测试钉住。
    func testCorruptRegistryRefusesToOverwriteAndLeavesBytesIntact() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }
        let garbage = Data("{ this is not a registry".utf8)
        try garbage.write(to: URL(fileURLWithPath: path))

        let registry = ProjectRegistry(filePath: path)
        XCTAssertTrue(registry.loadFailed)
        XCTAssertEqual(registry.count, 0)   // 内存里是空的，正因为如此才不能写出去

        XCTAssertThrowsError(try registry.create(
            displayName: "Would clobber",
            bundleId: "com.example.test",
            now: { self.testDate }
        )) { error in
            let gpError = error as! GPError
            XCTAssertEqual(gpError.code, .internalError)
            XCTAssertTrue(gpError.message.contains("refusing to overwrite"), gpError.message)
            // 错误里必须给出**可执行**的补救，不能指向一个不存在的解锁接口。
            XCTAssertTrue(gpError.message.contains("--restore-launchd"), gpError.message)
            XCTAssertFalse(gpError.message.contains("recoverFromFailedLoad"), gpError.message)
        }
        XCTAssertEqual(FileManager.default.contents(atPath: path), garbage)
        XCTAssertEqual(registry.count, 0, "被拒的写入不得改变内存状态")
    }

    /// 锁是**故意**不自解的：本进程这份表来自损坏文件，而磁盘可能已被修好并装有
    /// 真条目——自动重读会丢掉刚写的这条，照旧覆写会丢掉文件里那批。唯一的出路是
    /// 重启进程。修好文件后新建一个注册表，必须能正常读写。
    func testFailedLoadLatchStaysUntilTheProcessReReadsTheFile() throws {
        let path = tempFilePath()
        defer { try? FileManager.default.removeItem(atPath: path) }
        try Data("broken".utf8).write(to: URL(fileURLWithPath: path))

        let stuck = ProjectRegistry(filePath: path)
        XCTAssertTrue(stuck.loadFailed)

        // 用户把文件修好了。
        let repaired = "[{\"projectId\":\"prj_REPAIRED\",\"displayName\":\"Real\","
            + "\"bundleId\":\"com.user.app\",\"createdAt\":\"2026-01-01T00:00:00.000Z\"}]"
        try Data(repaired.utf8).write(to: URL(fileURLWithPath: path))

        XCTAssertThrowsError(try stuck.create(
            displayName: "Phantom", bundleId: "com.example.test", now: { self.testDate }
        ))
        let restarted = ProjectRegistry(filePath: path)   // 重启＝重新构造
        XCTAssertFalse(restarted.loadFailed)
        XCTAssertEqual(restarted.count, 1)
        XCTAssertEqual(restarted.get("prj_REPAIRED")?.displayName, "Real")
        _ = try restarted.create(displayName: "New", bundleId: "com.example.test", now: { self.testDate })
        XCTAssertEqual(restarted.count, 2)
    }

    /// 写成功≠落盘成功：每次变更后读回比对，且目录里不留下中间件/备份件。
    /// `replaceItemAt` 会把原件换成一个备份名留在原地——那是含全部注册项的旧副本。
    func testSaveLandsOnDiskAndLeavesNoTempOrBackupFiles() throws {
        let path = tempFilePath()
        let dir = (path as NSString).deletingLastPathComponent
        let base = (path as NSString).lastPathComponent
        defer { try? FileManager.default.removeItem(atPath: path) }

        let registry = ProjectRegistry(filePath: path)
        for i in 0..<3 {
            _ = try registry.create(
                displayName: "App \(i)", bundleId: "com.example.test", now: { self.testDate }
            )
        }
        let decoded = try JSONDecoder().decode(
            [ProjectEntry].self, from: Data(try XCTUnwrap(FileManager.default.contents(atPath: path)))
        )
        XCTAssertEqual(decoded.count, 3, "磁盘上必须就是这 3 条")

        let leftovers = try XCTUnwrap(
            FileManager.default.contentsOfDirectory(atPath: dir)
                .filter { $0.hasPrefix(base) && $0 != base }
        )
        XCTAssertEqual(leftovers, [], "中间件/备份件必须被清掉：\(leftovers)")
    }

    /// 没有注册表的核心在"被问到注册表"时报错，而不是回一份空列表。
    /// 空列表会被 agent 与面板读成"用户没有注册任何项目"——那是没测出来的结论。
    func testCoreWithoutRegistryErrorsInsteadOfClaimingEmpty() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, settle: {})
        XCTAssertNil(core.projectRegistry)

        for call: () throws -> [String: Any] in [
            { try core.projectList() },
            { try core.projectGet(projectId: "prj_ANY") },
            { try core.projectSet(projectId: nil, displayName: "X", bundleId: "com.example.test",
                                  pid: nil, recipeConfigPath: nil, calibrationAssetsPath: nil,
                                  evidenceStoragePath: nil) },
        ] {
            XCTAssertThrowsError(try call()) { error in
                let gpError = error as! GPError
                XCTAssertEqual(gpError.code, .internalError)
                XCTAssertTrue(gpError.message.contains("no project registry"), gpError.message)
            }
        }
        XCTAssertThrowsError(try core.attach(bundleId: "com.example.test", pid: nil, projectId: "prj_ANY"))
    }
}

// MARK: - RecipeLoader tests (spec v1.4 §2, P1-E5)

final class RecipeLoaderTests: XCTestCase {

    private func json(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    func testValidRecipePasses() {
        let recipe: [String: Any] = [
            "schemaVersion": 1,
            "name": "signup flow",
            "steps": [
                ["selector": ["role": "AXButton", "title": "Submit"], "action": "press"],
            ],
        ]
        let result = RecipeLoader.validate(json(recipe))
        XCTAssertTrue(result.valid, "expected valid; got errors: \(result.errors)")
        XCTAssertEqual(result.recipeName, "signup flow")
    }

    func testMissingSchemaVersionRejected() {
        let recipe: [String: Any] = [
            "name": "flow",
            "steps": [],
        ]
        let result = RecipeLoader.validate(json(recipe))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(result.errors.contains { $0.contains("schemaVersion") })
    }

    func testEmptyStepsRejected() {
        let recipe: [String: Any] = [
            "schemaVersion": 1,
            "name": "flow",
            "steps": [],
        ]
        let result = RecipeLoader.validate(json(recipe))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(result.errors.contains { $0.contains("at least 1 step") })
    }

    func testMissingNameRejected() {
        let recipe: [String: Any] = [
            "schemaVersion": 1,
            "steps": [["selector": ["role": "AXButton"], "action": "press"]],
        ]
        let result = RecipeLoader.validate(json(recipe))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(result.errors.contains { $0.contains("'name'") })
    }

    func testStepMissingActionRejected() {
        let recipe: [String: Any] = [
            "schemaVersion": 1,
            "name": "flow",
            "steps": [["selector": ["role": "AXButton"]]],
        ]
        let result = RecipeLoader.validate(json(recipe))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(result.errors.contains { $0.contains("steps[0].action") })
    }

    func testEmptyFileRejected() {
        let result = RecipeLoader.validate(Data())
        XCTAssertFalse(result.valid)
    }
}
