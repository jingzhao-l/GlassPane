import XCTest
import Foundation
@testable import GlassPaneEngine

/// `DebugCapabilityProbe.ProcessRunner` 的管道读法，与 `classify` 的判据顺序。
///
/// 缺陷形状（P2）：
///  1. `run` 把 stdout/stderr 挂在同一个 `Pipe` 上，轮询 `process.isRunning`，
///     **循环之后**才 `readDataToEndOfFile()`。`lldb --batch` 的输出一旦超过管道
///     的内核缓冲（macOS 上 64 KiB），子进程就阻塞在自己的 write() 上，循环看到的
///     "还在跑"正是这个阻塞，于是到点 terminate、`classify` 判 `.timeout`——面板
///     "验证调试能力"显示的就是这个从未发生过的"卡住"。
///  2. `classify` 先测 `.ok`（含 "attached" 即算）再测拒绝串，所以
///     "先挂上、随后 attach failed" 的输出被判成 `.ok`，等于把一次拒绝读成授权。
///
/// 夹具来源：真进程的真输出（`/bin/cat` 对一份真文件），以及 lldb 自己的措辞
/// （`DeveloperToolsVerdictTests` 已经按同一串钉过）。
final class DebugCapabilityProbeDrainTests: XCTestCase {

    // MARK: - 1. 超过 64 KiB 的输出不是超时

    /// 一条会把管道写满的命令：真文件、真进程、真 512 KiB 输出。
    private func bigOutputFile(bytes: Int) throws -> String {
        let path = TestSandbox.filePath("probe-big-output")
        let line = String(repeating: "A", count: 63) + "\n"      // 64 字节一行
        var body = ""
        body.reserveCapacity(bytes)
        while body.utf8.count < bytes { body += line }
        try body.write(toFile: path, atomically: true, encoding: .utf8)
        return path
    }

    func testOutputBeyondThePipeBufferIsNotAdjudicatedTimeout() throws {
        let path = try bigOutputFile(bytes: 512 * 1024)
        defer { try? FileManager.default.removeItem(atPath: path) }
        let runner = DebugCapabilityProbe.ProcessRunner()

        let result = runner.run("/bin/cat", [path], timeout: 8)

        XCTAssertFalse(result.timedOut,
                       "健康的一次输出只因超过管道缓冲就被判超时：旧写法正是在这里 break 掉一个还活着的子进程")
        XCTAssertEqual(result.exit, 0, "cat 正常退出就该拿到 0：\(String(describing: result.exit))")
        XCTAssertGreaterThanOrEqual(
            result.output.utf8.count, 512 * 1024 - 128,
            "输出被截断了——循环之后才读管道的写法在这里只会拿到 0 字节"
        )
        XCTAssertNotEqual(DebugCapabilityProbe.classify(result), .timeout,
                          "一次成功的探测不许被说成 timeout")
    }

    /// 对照必须能过：小输出仍是原来那个答案（拒绝不是"所有输出都判超时"）。
    func testSmallOutputStillCompletesAsBefore() throws {
        let path = TestSandbox.filePath("probe-small-output")
        try "Process 42 attached\nexited with status 0\n".write(toFile: path, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(atPath: path) }
        let runner = DebugCapabilityProbe.ProcessRunner()

        let result = runner.run("/bin/cat", [path], timeout: 8)
        XCTAssertFalse(result.timedOut)
        XCTAssertEqual(DebugCapabilityProbe.classify(result), .ok)
    }

    /// 真的卡住的进程仍然要被判成 timeout——修的是"读不动"，不是"不等了"。
    func testAHungChildIsStillTimeout() throws {
        let runner = DebugCapabilityProbe.ProcessRunner()
        let result = runner.run("/bin/sleep", ["30"], timeout: 0.5)
        XCTAssertTrue(result.timedOut, "预算用尽必须仍然报 timeout：\(result.exit.map(String.init(describing:)) ?? "nil")")
        XCTAssertEqual(DebugCapabilityProbe.classify(result), .timeout)
    }

    // MARK: - 2. 拒绝优先于成功

    func testMixedAttachedAndFailureOutputIsNotAdjudicatedOk() {
        // lldb 的真实形状：先 "attached"，随后一句失败。
        let mixed = DebugCapabilityProbe.classify((
            exit: 1, timedOut: false,
            output: "(lldb) command script import …\nProcess 42 attached\n(lldb) error: attach failed: (os/kern) failure\n"
        ))
        XCTAssertEqual(mixed, .denied, "同时有 attached 与 attach failed 时，说'不让'的那半句才是结论")

        let launchedThenRefused = DebugCapabilityProbe.classify((
            exit: 1, timedOut: false,
            output: "Process 42 launched: '/usr/bin/true' (x86_64)\nerror: attach failed: Not allowed to attach to process 4242\n"
        ))
        XCTAssertEqual(launchedThenRefused, .denied)
    }

    /// 一次**被这个进程自己掐掉**的会话，不许因为输出里有半句 attached 就点亮席位。
    /// 反向变异：把 `.ok` 那两行重新放到 timeout/exit 判定之前 → 这两条都红。
    func testAKilledSessionWithHalfAnAttachLineIsNotAGrant() {
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: nil, timedOut: true, output: "Process 42 attached\n")),
            .timeout,
            "预算用尽后 terminate 的那一趟，输出最正常的就是那句 attached——它证明不了会话跑完过"
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 1, timedOut: false, output: "Process 42 attached\n")),
            .spawnFailed,
            "lldb 自己非零退出又没有任何成功形状时，未知失败按原有词汇报 spawnFailed，不许折成 granted"
        )
    }

    /// 纯拒绝与纯成功的原有形状不能被顺序改动带偏（对照）。
    func testPureRefusalAndPureGrantKeepTheirVerdicts() {
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 0, timedOut: false, output: "Process 42 attached")),
            .ok, "只有 attached、没有拒绝句时仍然是 ok"
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 0, timedOut: false, output: "Process 1 stopped\nexited with status 0")),
            .ok
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 1, timedOut: false, output: "Not allowed to attach to process")),
            .denied
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: nil, timedOut: false, output: "taskgated: not permitted")),
            .denied
        )
    }

    /// 一条被拒的 attach 不能因为另一条 launch 成功就被抵消（Snapshot.granted 的既有
    /// 口径），这里补的是"混合输出落到 .denied 之后"那条链是真的接上的。
    func testMixedRefusalReachesTheSeatVerdictAsNotGranted() {
        let probe = DebugCapabilityProbe(
            runner: MixedRunner(),
            timeout: 1
        )
        let snapshot = probe.snapshot()
        XCTAssertEqual(snapshot.attach, .denied, "\(snapshot)")
        XCTAssertFalse(snapshot.granted, "一次 attach failed 的席位不许对面板显示成已授权")
    }

    private struct MixedRunner: DebugCapabilityProbe.Running {
        func run(_ binary: String, _ arguments: [String], timeout: TimeInterval)
            -> (exit: Int32?, timedOut: Bool, output: String) {
            if arguments.contains("run") {
                return (0, false, "Process 1 stopped\nexited with status 0")
            }
            return (1, false, "Process 42 attached\nerror: attach failed: (os/kern) internal error\n")
        }
        func spawnVictim(seconds: Int) -> String? { "4242" }
        func killVictim(_ pid: Int32) {}
    }
}
