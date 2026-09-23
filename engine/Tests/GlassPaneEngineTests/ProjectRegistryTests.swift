import XCTest
@testable import GlassPaneEngine

/// Tests for ProjectRegistry and project management (P1 spec v1.4).
final class ProjectRegistryTests: XCTestCase {

    // MARK: - Helpers

    private func tempFilePath() -> String {
        // Same shape as before (a unique, not-yet-existing `.json` path under a
        // created parent), routed through `TestSandbox` so the isolation
        // predicate runs on it — see `TestSupport.swift`.
        TestSandbox.filePath("registry")
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

// MARK: - RecipeLoader tests (spec v1.4 §2, P1-E5) — R4-02 / R6-01

/// Every literal here is written against the **kernel contract**, not against
/// the implementation: `schemaVersion` is the string const, a step is
/// `{kind, params}`. Each case also pins the *error text*, because
/// `"missing or non-integer 'schemaVersion'"` is what told a person holding
/// `"1"` that the key was absent.
final class RecipeLoaderTests: XCTestCase {

    private static let version = RecipeLoader.schemaVersion

    private func json(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    /// One valid step, in the contract's shape.
    private func step(
        kind: Any = "act",
        params: Any = ["selector": ["role": "AXButton", "title": "Submit"], "action": "press"],
        extra: [String: Any] = [:]
    ) -> [String: Any] {
        var step: [String: Any] = ["kind": kind, "params": params]
        for (key, value) in extra { step[key] = value }
        return step
    }

    private func recipe(version: Any = RecipeLoaderTests.version,
                        name: Any = "signup flow",
                        steps: [Any]) -> [String: Any] {
        ["schemaVersion": version, "name": name, "steps": steps]
    }

    /// The shared truth set: this is the same file the kernel suite validates
    /// with ajv and the MCP shell validates with zod. If this ever fails, the
    /// two languages have drifted apart again — which is the defect, and it is
    /// no longer only visible in `kernel/`.
    func testKernelFixtureIsTheTruthThisValidatesAgainst() throws {
        let data = try KernelFixtures.data("recipe-config.ok-01.json")
        let result = RecipeLoader.validate(data)
        XCTAssertTrue(result.valid, "the contract's own fixture must validate: \(result.errors)")
        XCTAssertFalse(
            RecipeLoader.schemaVersion.isEmpty,
            "the version literal must be a real value, not a stub"
        )
        // …and the literal this file is written against is the fixture's, read
        // from the bytes rather than restated from the code.
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(
            root["schemaVersion"] as? String, RecipeLoader.schemaVersion,
            "kernel fixture and engine validator disagree about the version literal"
        )
        let steps = try XCTUnwrap(root["steps"] as? [[String: Any]])
        XCTAssertFalse(steps.isEmpty)
        for one in steps {
            XCTAssertEqual(
                Set(one.keys), Set(RecipeLoader.stepKeys),
                "the fixture's step shape is not the one this validator documents"
            )
        }
    }

    func testValidRecipePasses() {
        let result = RecipeLoader.validate(json(recipe(steps: [step()])))
        XCTAssertTrue(result.valid, "expected valid; got errors: \(result.errors)")
        XCTAssertEqual(result.recipeName, "signup flow")
        XCTAssertTrue(result.errors.isEmpty)
    }

    /// The split this test used to encode: an integer version was the *only*
    /// accepted answer, and every file the contract calls valid failed.
    func testIntegerSchemaVersionIsRejectedByName() {
        let result = RecipeLoader.validate(json(recipe(version: 1, steps: [step()])))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains {
                $0.contains("must be the string \"\(Self.version)\"") && $0.contains("a number")
            },
            "a wrong-typed version must be reported as the type it is: \(result.errors)"
        )
    }

    /// `JSONSerialization` gives both of these an `NSNumber`, and Swift's
    /// `is Bool` says yes to a plain numeric one — so without the CoreFoundation
    /// type check this pair collapses into the same sentence, and an agent reads
    /// "got a boolean" about a file that contains `1`.
    func testBooleanAndNumberAreToldApartInErrorText() {
        let numeric = RecipeLoader.validate(json(recipe(version: 1, steps: [step()])))
        XCTAssertTrue(
            numeric.errors.contains { $0.contains("got a number") },
            numeric.errors.description
        )
        let boolean = RecipeLoader.validate(json(recipe(version: true, steps: [step()])))
        XCTAssertTrue(
            boolean.errors.contains { $0.contains("got a boolean") },
            boolean.errors.description
        )
    }

    func testWrongStringSchemaVersionIsRejectedWithBothValues() {
        let result = RecipeLoader.validate(
            json(recipe(version: "glasspane.recipe/0.2", steps: [step()]))
        )
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains {
                $0.contains("\"glasspane.recipe/0.2\"") && $0.contains("requires exactly \"\(Self.version)\"")
            },
            result.errors.description
        )
    }

    func testMissingSchemaVersionRejected() {
        var body = recipe(steps: [step()])
        body["schemaVersion"] = nil
        let result = RecipeLoader.validate(json(body))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains { $0.contains("'schemaVersion' is required") },
            result.errors.description
        )
    }

    func testEmptyStepsRejected() {
        let result = RecipeLoader.validate(json(recipe(steps: [])))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains { $0.contains("at least \(RecipeLoader.minSteps) step") },
            result.errors.description
        )
    }

    func testStepCountBoundaries() {
        let atLimit = RecipeLoader.maxSteps
        XCTAssertTrue(
            RecipeLoader.validate(json(recipe(steps: Array(repeating: step(), count: atLimit)))).valid,
            "\(atLimit) steps is the contract's ceiling and must pass"
        )
        let over = RecipeLoader.validate(
            json(recipe(steps: Array(repeating: step(), count: atLimit + 1)))
        )
        XCTAssertFalse(over.valid)
        XCTAssertTrue(
            over.errors.contains {
                $0.contains("contains \(atLimit + 1) steps") && $0.contains("maximum is \(atLimit)")
            },
            over.errors.description
        )
    }

    func testMissingNameRejected() {
        var body = recipe(steps: [step()])
        body["name"] = nil
        let result = RecipeLoader.validate(json(body))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains { $0.contains("'name' is required") },
            result.errors.description
        )
    }

    func testNameLengthBoundary() {
        XCTAssertTrue(
            RecipeLoader.validate(
                json(recipe(name: String(repeating: "n", count: RecipeLoader.nameMaxLength),
                             steps: [step()]))
            ).valid,
            "the cap is inclusive in the contract (z.string().max(256))"
        )
        let tooLong = String(repeating: "n", count: RecipeLoader.nameMaxLength + 1)
        let result = RecipeLoader.validate(json(recipe(name: tooLong, steps: [step()])))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains {
                $0.contains("is \(tooLong.count) characters") && $0.contains("maximum is \(RecipeLoader.nameMaxLength)")
            },
            result.errors.description
        )
    }

    func testStepKindMustBeOneOfTheContractEnum() {
        let result = RecipeLoader.validate(json(recipe(steps: [step(kind: "click")])))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains {
                $0.contains("steps[0].kind") && $0.contains("\"click\"")
                    && $0.contains("act, observe, assert, diagnose")
            },
            result.errors.description
        )
        // Every allowed kind is accepted — the enum is a set, not a guess.
        for kind in RecipeLoader.stepKinds {
            XCTAssertTrue(
                RecipeLoader.validate(json(recipe(steps: [step(kind: kind)]))).valid,
                "'\(kind)' is in the contract and must validate"
            )
        }
    }

    func testStepMissingParamsRejected() {
        let result = RecipeLoader.validate(
            json(recipe(steps: [["kind": "act"]]))
        )
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains { $0.contains("steps[0].params' is required") },
            result.errors.description
        )
    }

    func testStepParamsMustBeAnObject() {
        let result = RecipeLoader.validate(
            json(recipe(steps: [step(params: "press it")]))
        )
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains {
                $0.contains("steps[0].params' must be an object") && $0.contains("a string")
            },
            result.errors.description
        )
    }

    /// The old daemon-only shape: `selector`/`action` at step level. This must
    /// fail *and* say where those keys belong, or the migration off it is a
    /// mystery to whoever hits it.
    func testLegacyStepShapeIsRejectedAndPointAtParams() {
        let result = RecipeLoader.validate(
            json(recipe(steps: [["kind": "act", "params": [:],
                                  "selector": ["role": "AXButton"], "action": "press"]]))
        )
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains {
                $0.contains("steps[0]' has unknown key 'selector'") && $0.contains("inside 'params'")
            },
            result.errors.description
        )
        XCTAssertTrue(
            result.errors.contains { $0.contains("unknown key 'action'") },
            result.errors.description
        )
    }

    func testUnknownTopLevelKeyRejected() {
        var body = recipe(steps: [step()])
        body["author"] = "me"
        let result = RecipeLoader.validate(json(body))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains { $0.contains("unknown top-level key 'author'") },
            result.errors.description
        )
    }

    func testNonObjectStepRejectedByType() {
        let result = RecipeLoader.validate(json(recipe(steps: ["press submit"])))
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains {
                $0.contains("steps[0]' must be an object") && $0.contains("a string")
            },
            result.errors.description
        )
    }

    /// A top-level array parses fine as JSON; calling it "not valid JSON" sends
    /// the reader to the wrong fix.
    func testTopLevelArrayIsReportedAsShapeNotAsParseFailure() {
        let data = try! JSONSerialization.data(withJSONObject: [["kind": "act"]])
        let result = RecipeLoader.validate(data)
        XCTAssertFalse(result.valid)
        XCTAssertFalse(
            result.errors.contains { $0.contains("not valid JSON") },
            "the bytes *are* JSON: \(result.errors)"
        )
        XCTAssertTrue(
            result.errors.contains { $0.contains("top level must be a JSON object") },
            result.errors.description
        )
    }

    func testEmptyFileRejected() {
        let result = RecipeLoader.validate(Data())
        XCTAssertFalse(result.valid)
        XCTAssertTrue(
            result.errors.contains { $0.contains("not valid JSON") },
            result.errors.description
        )
    }
}
