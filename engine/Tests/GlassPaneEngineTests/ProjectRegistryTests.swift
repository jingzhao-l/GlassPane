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
        let listResult = core.projectList()
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
        let listAfter = core.projectList()
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
