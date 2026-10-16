import XCTest
@testable import GlassPaneEngine

/// `glasspaned` 一次性 CLI 在"注册表读不开"时的三种答案，跑的是**真二进制**。
///
/// 缺陷形状（P1）：`ProjectRegistry.get(_:)` 对「这条 id 没注册」和「这份
/// projects.json 读不出所以什么都看不见」回的都是 nil，而两条一次性子命令把后者
/// 也写成了前者的报文——`--active-project` 写 `found:false` +
/// "no project … is registered"，`--prune-evidence`/`--evidence-stats --project`
/// 写 "unknown project <id>"。同一份文件在 `--list-projects` 与 `--project-prune`
/// 那里走的是 `loadFailed` 拒绝，所以是**一个事实两个答案**，而那个"没注册"是
/// 本进程凭"看不见"编出来的缺席。判据取自 `ProjectRegistry.listing()`（与
/// `--list-projects` 同源），不在 CLI 里重写一遍。
///
/// 夹具是真东西：一份 `ProjectRegistry` 自己拒绝解码的 projects.json（合法 JSON、
/// 不是项目数组——真机上就是这一类，手改过或别的进程写了同名文件），而不是只对
/// 一个输入应答的 stub。
///
/// 一律带 `--state-dir` 指向沙箱：daemon 忽略 `GLASSPANE_STATE_DIR`，不给参数的
/// 那次运行动的就是这台机器的 `~/.glasspane`。
final class RegistryCliRefusalShapeTests: XCTestCase {

    private var daemonBinary: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }
        return url.appendingPathComponent(".build/debug/glasspaned").path
    }

    private struct Run {
        let status: Int32
        let stdout: String
        let stderr: String
        var json: [String: Any]? {
            for stream in [stderr, stdout] {
                let trimmed = stream.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                return object
            }
            return nil
        }
    }

    /// 先读到 EOF 再等退出：反过来的话，输出超过管道的子进程会把这里卡住。
    private func run(_ root: String, _ arguments: [String]) -> Run {
        XCTAssertTrue(FileManager.default.fileExists(atPath: daemonBinary), "真二进制不在：\(daemonBinary)")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: daemonBinary)
        process.arguments = ["--state-dir", root] + arguments
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try! process.run()
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        process.waitUntilExit()
        return Run(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }

    private func sandboxRoot(_ label: String) -> String {
        TestSandbox.directory(label)
    }

    /// 一份注册表自己**拒绝解码**的 projects.json。
    private func plantUnreadableRegistry(in root: String) throws -> String {
        let path = root + "/projects.json"
        try Data("{\"not\":\"a list\"}\n".utf8).write(to: URL(fileURLWithPath: path))
        XCTAssertTrue(ProjectRegistry(filePath: path).loadFailed,
                      "夹具没能让注册表真的读不开——这份文件会被解码，判据就测不到")
        return path
    }

    private func plantReadableRegistry(in root: String) throws {
        try Data("[]\n".utf8).write(to: URL(fileURLWithPath: root + "/projects.json"))
    }

    private let probeId = "prj_01M34567890123456789012A"

    // MARK: - 1. --active-project：读不开 → loadFailed 拒绝，不给 found

    func testActiveProjectRefusesRatherThanFabricatingAnAbsence() throws {
        let root = sandboxRoot("active-unreadable")
        let registryPath = try plantUnreadableRegistry(in: root)

        let result = run(root, ["--active-project", probeId])
        XCTAssertEqual(result.status, 1, "读不开是一次拒绝（--help 的 1），不是 0：\(result.stdout)\(result.stderr)")
        let payload = try XCTUnwrap(result.json, "拒绝必须是一份 JSON：\(result.stderr)")
        XCTAssertEqual(payload["loadFailed"] as? Bool, true, "\(payload)")
        XCTAssertNil(payload["found"],
                     "看不见这张表的时候「没找到」也没被测量——found 这个键本身就是那次编造")
        if let error = payload["error"] as? String {
            XCTAssertTrue(error.contains(registryPath), "拒绝要点名是哪份文件：\(error)")
        } else {
            XCTFail("拒绝报文没有 error：\(payload)")
        }
        XCTAssertTrue(result.stdout.isEmpty,
                      "拒绝的报文走 stderr，stdout 不许留半份答案：\(result.stdout)")
    }

    /// 对照必须能过：读得开的表里没有这条 id，那句"没有注册"是**测到的**事实。
    func testActiveProjectStillAnswersNotRegisteredForAReadableRegistry() throws {
        let root = sandboxRoot("active-readable")
        try plantReadableRegistry(in: root)

        let result = run(root, ["--active-project", probeId])
        XCTAssertEqual(result.status, 1, "未注册在这条命令里仍是拒绝式回答：\(result.stdout)\(result.stderr)")
        let payload = try XCTUnwrap(result.json)
        XCTAssertEqual(payload["found"] as? Bool, false, "\(payload)")
        XCTAssertNil(payload["loadFailed"], "读得开的表不该被说成读不开")
        XCTAssertEqual(payload["error"] as? String, "no project \(probeId) is registered")
    }

    /// 同一条命令的命中分支也得保持原样（拒绝不能退化成"这条命令逢答必拒"）。
    func testActiveProjectStillVerifiesARegisteredEntry() throws {
        let root = sandboxRoot("active-found")
        let registry = ProjectRegistry(filePath: root + "/projects.json")
        let entry = try registry.create(
            displayName: "Reachable", bundleId: "com.example.reachable",
            now: { Date(timeIntervalSince1970: 1_760_000_000) }
        )
        let result = run(root, ["--active-project", entry.projectId])
        XCTAssertEqual(result.status, 0, "\(result.stderr)")
        let payload = try XCTUnwrap(result.json)
        XCTAssertEqual(payload["found"] as? Bool, true)
        XCTAssertEqual(payload["stateChanged"] as? Bool, false)
    }

    // MARK: - 2. 维护命令的 --project：读不开 → loadFailed，不写 "unknown project"

    func testMaintenanceProjectDimensionRefusesOnUnreadableRegistry() throws {
        for flag in ["--evidence-stats", "--prune-evidence"] {
            let root = sandboxRoot("maint-\(flag.dropFirst(2))")
            let registryPath = try plantUnreadableRegistry(in: root)
            let arguments = flag == "--prune-evidence"
                ? [flag, "--older-than", "1", "--project", probeId]
                : [flag, "--project", probeId]

            let result = run(root, arguments)
            XCTAssertEqual(result.status, 1, "\(flag)：读不开不是 0：\(result.stdout)\(result.stderr)")
            let payload = try XCTUnwrap(result.json, "\(flag) 的拒绝必须是 JSON：\(result.stderr)")
            XCTAssertEqual(payload["loadFailed"] as? Bool, true, "\(payload)")
            XCTAssertEqual(payload["stateChanged"] as? Bool, false, "\(payload)")
            if let error = payload["error"] as? String {
                XCTAssertFalse(error.contains("unknown project"),
                               "\(flag) 把看不见写成了确定的缺席：\(error)")
                XCTAssertTrue(error.contains(registryPath), "\(flag) 没点名文件：\(error)")
            } else {
                XCTFail("\(flag) 的拒绝报文没有 error：\(payload)")
            }
        }
    }

    /// 对照：读得开的表 + 真没有这条 id → 那句 "unknown project" 是测到的答案，必须留下。
    func testMaintenanceProjectDimensionStillNamesUnknownProjectWhenReadable() throws {
        let root = sandboxRoot("maint-known-unknown")
        try plantReadableRegistry(in: root)
        let result = run(root, ["--evidence-stats", "--project", probeId])
        XCTAssertEqual(result.status, 1)
        let payload = try XCTUnwrap(result.json)
        XCTAssertEqual(payload["error"] as? String, "unknown project \(probeId)")
        XCTAssertNil(payload["loadFailed"])
    }

    // MARK: - 3. `--list-projects`：拒绝形状的对照（真二进制）

    /// 读不开的 projects.json 在这条命令上早就回拒绝。这里把它钉成**对照**：
    /// 上面两条分支现在必须与它同形（同一个 `loadFailed` 报文、同一个 1）。
    func testListProjectsRefusesOnUnreadableRegistryWithoutAnEmptyArray() throws {
        let root = sandboxRoot("list-unreadable")
        _ = try plantUnreadableRegistry(in: root)

        let result = run(root, ["--list-projects"])
        XCTAssertEqual(result.status, 1, "\(result.stdout)\(result.stderr)")
        XCTAssertNotEqual(
            result.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "[]",
            "读不开被报成\"什么都没注册\"——而这条命令正是 agent 被指来回答\"注册了什么\"的那一条"
        )
        let payload = try XCTUnwrap(result.json)
        XCTAssertEqual(payload["loadFailed"] as? Bool, true)
        XCTAssertNil(payload["count"], "拒绝报文里不许有一个数不出来的计数")
        XCTAssertNil(payload["projects"], "拒绝报文里不许有一个看不见的表")
    }

    /// 读得开、里面真没有 → `[]` + 0 仍是事实。拒绝不许退化成"逢答必拒"。
    func testListProjectsStillAnswersAnEmptyArrayForAReadableEmptyRegistry() throws {
        let root = sandboxRoot("list-readable")
        try plantReadableRegistry(in: root)
        let result = run(root, ["--list-projects"])
        XCTAssertEqual(result.status, 0, "\(result.stderr)")
        XCTAssertEqual(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "[]")
    }

    // MARK: - 4. --evidence-stats：归档读不开时退出码是 1（与 --prune-evidence 同口径）

    func testEvidenceStatsExitsOneWhenTheArchiveCannotBeListed() throws {
        let root = sandboxRoot("stats-unreadable-archive")
        // 归档位置被一个普通文件占住：`stats()` 列不出来，报的就是 listFailure。
        try "not a directory".write(toFile: root + "/evidence", atomically: true, encoding: .utf8)

        let result = run(root, ["--evidence-stats"])
        let payload = try XCTUnwrap(result.json, "统计的答复必须是 JSON：\(result.stdout)\(result.stderr)")
        XCTAssertTrue(payload["count"] is NSNull, "读不出来时 count 是 null：\(payload)")
        XCTAssertNotNil(payload["listFailure"] as? String, "\(payload)")
        XCTAssertEqual(
            result.status, 1,
            "count:null 是 --help 定义的 1（被拒绝/部分成功）。同一事实 --prune-evidence 20 行之前回的就是 1：\(result.stdout)"
        )
    }

    func testEvidenceStatsStillExitsZeroForAnArchiveThatWasMeasured() throws {
        let root = sandboxRoot("stats-readable-archive")
        try FileManager.default.createDirectory(
            atPath: root + "/evidence", withIntermediateDirectories: true
        )
        let result = run(root, ["--evidence-stats"])
        XCTAssertEqual(result.status, 0, "数出来的 0 条是真测到的：\(result.stdout) \(result.stderr)")
        let payload = try XCTUnwrap(result.json)
        XCTAssertEqual(payload["count"] as? Int, 0)
        XCTAssertTrue(payload["listFailure"] is NSNull)
    }

    // MARK: - 4. --list-projects 的编码失败分支（P2 #2）
    //
    // 这一条**没法用真二进制触发**：`encoder.encode([ProjectEntry])` 对任何能从
    // 盘上解码回来的表都不会失败（字段全是 String/Int32），所以没有一条 CLI 输入
    // 能走到那个 else。沿用本仓对 main.swift 其余不可触发分支的做法（见
    // `RegistryVerdictTests`、`ProjectRegistryTests.testMaintenanceCliRoutes…`）：
    // 用源码形状钉住"这个分支回的是 stderr 拒绝 + exit 1，且整个文件里再没有
    // `[]` 兜底"。它证明的是分支的形状，不是分支会被走到——这一点写在这里，
    // 免得后来人把它读成端到端的证据。

    private func mainSwiftSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("engine/Sources/glasspaned/main.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testListProjectsEncodeFailureRoutesToTheRefusalNotToAnEmptyArray() throws {
        let source = try mainSwiftSource()
        let start = try XCTUnwrap(
            source.range(of: "if options.listProjects {"),
            "--list-projects 的处理块不见了，这条对照已不作数"
        )
        let end = try XCTUnwrap(
            source.range(of: "if let activeId = options.activeProjectId {"),
            "下一条命令的起点找不到：窗口没有边界"
        )
        let block = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(
            block.contains("to: .standardError)"),
            "编码失败的分支没有走 stderr 拒绝：读不回的东西被当成答案发出去了"
        )
        XCTAssertFalse(
            block.contains(#""[]\n""#) || block.contains("[]\\n"),
            "--list-projects 里还留着 `[]` 兜底：那正是它上面注释禁止的形状"
        )
        // 窗口内 `exit(0)` 只许出现在成功之后一次；失败分支必须是 exit(1)。
        XCTAssertEqual(
            block.components(separatedBy: "exit(1)").count - 1, 2,
            "两条拒绝（读不开 / 编不出）都要以 1 离场：\(block.components(separatedBy: "exit(1)").count - 1)"
        )
        XCTAssertEqual(
            block.components(separatedBy: "exit(0)").count - 1, 1,
            "拒绝分支里出现了 exit(0)：编码失败又被回成成功"
        )
    }
}
