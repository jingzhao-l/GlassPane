import XCTest
import Foundation
@testable import glasspane_settings

/// 每日轮 2026-10-30 · SW2 缺陷 3（P2）：面板的一次性 CLI 调用超时之后不收尸。
///
/// `ConsoleModel.swift:994-997`：
/// ```
/// if group.wait(timeout: .now() + timeoutSeconds) == .timedOut {
///     process.terminate(); return nil
/// }
/// ```
/// `terminate()` 只发 SIGTERM，不 reap：子进程变成一个僵尸，挂在面板这个长命进程的
/// 进程表里，每点一次「清理」多一个。而两条 `readDataToEndOfFile()` 的 handler 还
/// park 在各自的私有队列上——它们要等"所有写端关闭"才见得到 EOF，那份写端在子进程
/// 手里，只有它真死了、并且被收掉，读端才解阻塞。
///
/// 后果不是抽象的：`--project-prune` 跑得比 20 s 预算慢时，页面上说的是
/// 「没在时限内回话」，而那个被 SIGTERM 打断的孩子正停在 `registry.remove()` 中间
/// ——注册表修剪了一半，面板却什么都不知道，下一次点击照旧在这份残局上再走一遍。
///
/// 实测过的管道语义（决定收尾顺序，不靠猜）：
///   1. 子进程自己退出时，父进程不关任何东西，读端也能拿到 EOF（Foundation 在 launch
///      时关掉自己那两份写端）；
///   2. 子进程被 terminate 之后，**reap 完成时**读端才返回。
/// 所以顺序是 terminate → waitUntilExit（收尸，同时解掉两条 reader 的阻塞）→
/// join 那两条队列（此时 EOF 已经发生，这一步不会等下去）→ 显式关读端（句柄不随
/// `Pipe` 的释放时机漂移）。预算 `timeoutSeconds` 一个字没动——一个只在安静时成立的
/// 时限判断不是控制。
///
/// `REVERSE:` 写明退回哪一处修复会让对应那条变红。
final class DailyRound20261030SW2CLIReapTests: XCTestCase {

    /// 本进程的开口句柄数：句柄泄漏的直接读数。
    private func openFileDescriptorCount() -> Int {
        var count = 0
        for fd in 0..<4096 where fcntl(Int32(fd), F_GETFD) != -1 { count += 1 }
        return count
    }

    /// 预算之内会自己退出的孩子。
    private func sleepPastBudget(pidFile: String) -> [String] {
        ["-c", "echo $$ > '\(pidFile)'; exec sleep 120"]
    }

    /// 超时的那一趟必须把孩子收掉：`kill(pid, 0)` 到一个已被 reap 的号上必然 ESRCH，
    /// 而僵尸还挂在表里时它返回 0。
    /// REVERSE: 删掉超时分支里的 `waitUntilExit()` → 红（实测：修复前 `kill` 返回 0，
    /// errno 不是 ESRCH——那个孩子是被 SIGTERM 打死没错，但没人收，成了面板自己的僵尸）。
    func testATimedOutOneShotIsReapedAndDoesNotLeakItsReadHandles() throws {
        let directory = TestSandbox.directory("cli-reap")
        let pidFile = "\(directory)/child.pid"
        let before = openFileDescriptorCount()

        let run = ConsoleModel.runDaemonCLI(
            binary: "/bin/sh",
            arguments: sleepPastBudget(pidFile: pidFile),
            timeoutSeconds: 0.5
        )
        let after = openFileDescriptorCount()

        XCTAssertNil(run, "超时仍然回 nil：面板那句折叠就建在这个契约上")

        let text = try String(contentsOfFile: pidFile, encoding: .utf8)
        let pid = try XCTUnwrap(Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)))
        let alive = kill(pid, 0)
        XCTAssertEqual(
            alive, -1,
            "pid \(pid) 还在面板的进程表里——terminate 之后没人收尸，它就是一份僵尸：\(alive)/\(errno)"
        )
        XCTAssertEqual(
            errno, ESRCH,
            "被 SIGTERM 打死但没有被 reap 的孩子照样回 0，这一条要的是 ESRCH：\(errno)"
        )
        XCTAssertEqual(
            after, before,
            "超时这一趟回来时，两条管道的读端必须已经还回去（前 \(before) / 后 \(after)）"
        )
    }

    /// 守卫不能反过来咬：预算之内回来的那一趟，输出、stderr、退出码一个都不许多，
    /// 收尸也照样收。
    /// REVERSE: 把关闭句柄挪到 `return` 之前的成功分支上（提前关掉读端）→ 红在输出为空。
    func testAChildThatAnswersInTimeStillReturnsItsReply() throws {
        let before = openFileDescriptorCount()
        let run = ConsoleModel.runDaemonCLI(
            binary: "/bin/sh",
            arguments: ["-c", "printf '{\"matched\":2}'; printf 'note' 1>&2; exit 3"],
            timeoutSeconds: 20
        )
        let after = openFileDescriptorCount()

        let result = try XCTUnwrap(run, "预算之内回话的一趟不许被折成超时")
        XCTAssertEqual(result.output, "{\"matched\":2}")
        XCTAssertEqual(result.errorOutput, "note")
        XCTAssertEqual(result.status, 3, "非 0 退出的报告体本身就是结论，不许被丢掉")
        XCTAssertEqual(after, before, "正常这一趟也不许留下句柄：前 \(before) / 后 \(after)")
    }

    /// 折叠不许跟着动：nil 折成的是那句具名的话（本缺陷只修收尸，不替用户重编一句话）。
    /// REVERSE: 改 `prunePreviewOutcome` 的措辞 → 红。
    func testNilFromATimeoutStillFoldsIntoTheExistingNamedMessage() throws {
        guard case .refused(let message) = ConsoleModel.prunePreviewOutcome(
            cliRan: false, stdout: "", stderr: "", exitCode: -1
        ) else {
            return XCTFail("读不到回话时不许摊一张空清单")
        }
        XCTAssertEqual(
            message,
            "清理预览没有执行：读不到后台服务的程序路径，或它没在时限内回话。点「刷新」恢复后重试。"
        )
    }
}
