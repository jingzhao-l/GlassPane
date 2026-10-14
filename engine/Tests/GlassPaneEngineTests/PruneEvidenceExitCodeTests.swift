import XCTest
@testable import GlassPaneEngine

/// `--prune-evidence` answered 0 while printing `pruned: null`.
///
/// `main.swift` documents 1 as "the operation was refused or only partly succeeded",
/// and the identical condition already answers 1 in `--list-projects`, in
/// `--project-prune` and in the post-write readback. A caller that branches on the
/// exit code — the updater, a CI step, an agent — got a green answer whose body says
/// it obtained nothing.
///
/// Run against the real binary with `--state-dir` (never the home default: the same
/// command without it would prune the machine's real archive).
final class PruneEvidenceExitCodeTests: XCTestCase {

    private var daemonBinary: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }
        return url.appendingPathComponent(".build/debug/glasspaned").path
    }

    private func run(_ args: [String]) -> (status: Int32, out: String, err: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: daemonBinary)
        process.arguments = args
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try! process.run()
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        process.waitUntilExit()
        return (process.terminationStatus, stdout, stderr)
    }

    func testUnreadableArchiveRefusesRatherThanAnsweringZero() throws {
        XCTAssertTrue(FileManager.default.fileExists(atPath: daemonBinary), "真二进制不在：\(daemonBinary)")
        let root = TestSandbox.directory("prune-exit")
        // The archive directory replaced by a regular file: the store cannot list it,
        // which is exactly the "not obtained" case `pruned: null` reports.
        try "not a directory".write(toFile: root + "/evidence", atomically: true, encoding: .utf8)

        let result = run(["--state-dir", root, "--prune-evidence", "--older-than", "1"])
        XCTAssertTrue(
            result.out.contains("\"pruned\"") && result.out.contains("null"),
            "读不出来时必须写 null 而不是 0：\(result.out)"
        )
        XCTAssertEqual(
            result.status, 1,
            "pruned:null 是 --help 定义的 1（被拒绝/部分成功），不是 0。stdout=\(result.out) stderr=\(result.err)"
        )
    }

    func testReadableArchiveStillAnswersZero() throws {
        XCTAssertTrue(FileManager.default.fileExists(atPath: daemonBinary), "真二进制不在：\(daemonBinary)")
        let root = TestSandbox.directory("prune-ok")
        try FileManager.default.createDirectory(
            atPath: root + "/evidence", withIntermediateDirectories: true
        )
        let result = run(["--state-dir", root, "--prune-evidence", "--older-than", "1"])
        XCTAssertEqual(result.status, 0, "空档案是真测到的 0 条：\(result.out) \(result.err)")
        XCTAssertFalse(result.out.contains("\"pruned\" : null"), result.out)
    }

    func testDryRunAgainstUnreadableArchiveAlsoRefuses() throws {
        XCTAssertTrue(FileManager.default.fileExists(atPath: daemonBinary), "真二进制不在：\(daemonBinary)")
        let root = TestSandbox.directory("prune-dry")
        try "not a directory".write(toFile: root + "/evidence", atomically: true, encoding: .utf8)
        let result = run(["--state-dir", root, "--prune-evidence", "--older-than", "1", "--dry-run"])
        XCTAssertEqual(
            result.status, 1,
            "--dry-run 报的 0 同样不是「没有过期的」：\(result.out) \(result.err)"
        )
    }
}
