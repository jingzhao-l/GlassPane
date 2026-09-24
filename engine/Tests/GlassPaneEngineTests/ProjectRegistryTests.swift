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

    // MARK: - P8 (defect 4): an agent-facing message names the paths it opened

    /// The construction route this round closed, pinned in source because it is
    /// a *route* and not a behavior: the registry's `filePath:` used to carry a
    /// default value pointing at the home-derived table, so a call site that
    /// named no location — one added tomorrow by someone who read nothing — got
    /// the developer's own projects.json instead of an error. That is the same
    /// defect the isolation gate keeps scanning for in `engine/Tests`; the
    /// default parameter was the version of it that lived in production and no
    /// text gate could see. The named factory is the only way left to reach the
    /// per-user table, and it has to stay spelled.
    func testRegistryLocationCannotBeReachedByOmittingTheArgument() throws {
        let source = try repoSource("engine/Sources/GlassPaneEngine/ProjectRegistry.swift")
        XCTAssertFalse(
            source.contains("filePath: String ="),
            "the registry location has to be named at every call site: a default value is how a location-less construction silently became the developer's own projects.json"
        )
        XCTAssertTrue(
            source.contains("public init(filePath: String)"),
            "the required-argument initializer is gone: \(source.prefix(400))…"
        )
        XCTAssertTrue(
            source.contains("atProductionDefault() -> ProjectRegistry"),
            "the home table must stay reachable, and only by name: the named factory is what the isolation gate bans in tests"
        )
        // `stateRoot:` — the route `glasspaned` takes — still exists, so nothing
        // is pushed back towards composing a path by hand.
        XCTAssertTrue(source.contains("init(stateRoot: StateRoot)"))
    }

    /// The other half of the same rule, as behavior: every sentence a registry
    /// refusal sends names **this** instance's table and never the home-derived
    /// one. A `--state-dir` run whose agent is told to `mv` or `json.tool` a file
    /// it never opens follows an instruction against the wrong state.
    func testRefusalTextNamesTheInjectedTableAndNeverTheHomeDefault() throws {
        let path = TestSandbox.filePath("registry-refusal")
        try Data("{ this is not a project list".utf8).write(
            to: URL(fileURLWithPath: path), options: .atomic
        )
        // The exposure the review found: a location this process never reads or
        // writes, derived from a home lookup that no argument can change.
        let homeTable = StateRoot.homeDefault().projectsFile
        XCTAssertNotEqual(homeTable, path, "test premise: the injected table is not the home one")

        let registry = ProjectRegistry(filePath: path)
        XCTAssertTrue(registry.loadFailed)
        let report = try XCTUnwrap(registry.unreadableReport)
        let remedy = registry.unreadableRemedy
        for text in [report, remedy] {
            XCTAssertTrue(text.contains(path), "the refusal must name the file it refused to rewrite: \(text)")
            XCTAssertFalse(
                text.contains(homeTable),
                "and must not name a table this instance never opened: \(text)"
            )
        }
        XCTAssertThrowsError(try registry.create(displayName: "X", bundleId: "com.refusal")) { error in
            guard let gpError = error as? GPError else {
                return XCTFail("the refusal is a GPError with an agent-facing remedy, got \(error)")
            }
            XCTAssertEqual(gpError.code, .internalError)
            XCTAssertFalse(gpError.message.contains(homeTable), gpError.message)
            XCTAssertFalse(gpError.remedy.contains(homeTable), gpError.remedy)
            XCTAssertTrue(gpError.remedy.contains(path), gpError.remedy)
        }
    }

    /// The CLI's side of the same sentence. `glasspaned --prune-evidence --project
    /// <id>` refuses when that project owns no archive; the refusal is correct, but
    /// until now every path in the payload except the engine's own sentence was
    /// this run's, and the sentence named a shared archive derived from home —
    /// the one file a `--state-dir` run never opens. The keys pinned below are the
    /// CLI's answer to that: the root this process resolved, the archive it owns,
    /// and the command (with its `--state-dir`) that can actually prune it.
    ///
    /// Honest about the half this gate cannot pin: `error`/`remedy` are still
    /// `EngineCore.noArchiveRefusal`'s words, so the home-derived path survives
    /// inside that sentence until the engine takes the injected store/registry
    /// path instead (another lane's file). Stated, not assumed away.
    ///
    /// Pinned by text because the branch is top-level code in an executable target
    /// — the same reason `EngineCoreTests` reads `main.swift` instead of calling it.
    func testArchiveRefusalPayloadNamesTheRootThisRunResolved() throws {
        let source = try repoSource("engine/Sources/glasspaned/main.swift")
        let start = try XCTUnwrap(
            source.range(of: "if options.pruneEvidence || options.evidenceStats"),
            "the evidence maintenance branch is gone"
        )
        let end = try XCTUnwrap(
            source.range(of: "let socketPath = StateRoot.engineSocketPath"),
            "the slice anchor (daemon entry) is gone"
        )
        let block = source[start.lowerBound..<end.lowerBound]
        let refusal = try XCTUnwrap(
            block.range(of: "case .failure(let refusal):"),
            "the no-archive refusal is gone from the maintenance branch"
        )
        let payload = block[refusal.lowerBound...]
        XCTAssertTrue(
            payload.contains("\"stateRoot\": stateRoot.path"),
            "the payload has to say which root this process resolved, not one it never touches"
        )
        XCTAssertTrue(
            payload.contains("\"sharedArchiveOfThisRun\": stateRoot.evidenceDirectory"),
            "and which archive it owns: that is the archive the engine's sentence calls \"shared\""
        )
        XCTAssertTrue(
            payload.contains("\"next\": \"glasspaned --prune-evidence"),
            "the remedy has to name, in the emitted command, the surface that actually owns the shared archive"
        )
        XCTAssertTrue(
            payload.contains("--state-dir \\(stateRoot.path)"),
            "…and pin the installation it prunes, so a second run cannot be pointed at another state root"
        )
        XCTAssertTrue(
            payload.contains("\"stateChanged\": false"),
            "a refusal must still deny that anything was deleted"
        )
    }

    /// Reads a repo-relative source file the way `HumanInterventionAuditTests`
    /// and `EngineCoreTests` already do: `#filePath` is compiled in, so the gate
    /// does not depend on the working directory `swift test` happens to run in.
    private func repoSource(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // engine
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
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
