import XCTest
import Foundation
@testable import glasspane_settings

/// 每日轮 2026-11-20 · 安全审查（正确性）审出的 P2：超时那一趟的收尸自己有界了，但收尸
/// **之后**那条 reader join 没有。
///
/// 修好的收尾（`ConsoleModel.runDaemonCLI` 与 `UpdateModel.runUpdater` 同形状）是：
/// terminate → waitForExit(5s) → kill9 → group.wait()。前三步只保证**直系**孩子退场，
/// `kill(pid)` 够不着它派生的、共享 stdout 写端的孩子。那种孩子活着，两条
/// `readDataToEndOfFile()` 就永远等不到「所有写端关闭」，于是超时分支末尾那条
/// `group.wait()` 把这条 detached task 永久钉住——`inFlight` 闸闩死，整页按钮再点不动。
/// 这正是 SIGKILL 升级那一轮要消灭的死法，只是从进程句柄换到了管道读者身上。
///
/// 本仓已有正确形状：`DebugCapabilityProbe` 在收尾时给 reader join 一个
/// `drainGraceSeconds` 上界，取不到 EOF 就取已经读到的部分。本修复把同一个上界
/// 搬到这两处（`readerDrainGraceSeconds = 2`）。
///
/// REVERSE: 把两处 `_ = group.wait(timeout: .now() + readerDrainGraceSeconds)`
/// 退回成无界的 `group.wait()` → 本测试**永久挂住**（XCTest 超时判红）——这正是
/// 修复前生产上那条 detached task 的死法，不是「跑过了」的红。
final class DailyRound20261120PipeDrainBoundTests: XCTestCase {

    /// 派生一个共享 stdout 写端、且活得比预算久的孩子：直接孩子被 SIGTERM/SIGKILL
    /// 收掉，它派生的那个孩子仍握着写端，读端永远等不到 EOF。
    /// 直接孩子忽略 SIGTERM（trap '' TERM）以逼出 kill9 那一手，同时保证「收尸有界」
    /// 已经成立、本缺陷落在它之后的 join 上。
    private func holderScript(pidFile: String, holderFile: String) -> [String] {
        ["-c",
         """
         trap '' TERM
         sleep 300 &
         echo $! > '\(holderFile)'
         echo $$ > '\(pidFile)'
         while true; do sleep 1; done
         """]
    }

    private func killQuietly(_ pid: Int32) {
        kill(pid, SIGKILL)
        _ = waitForGone(pid)
    }

    private func waitForGone(_ pid: Int32, grace: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(grace)
        while kill(pid, 0) == 0 {
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return true
    }

    /// 超时那一趟必须在有界时间内回来，哪怕一个派生的孩子仍握着管道写端。
    /// REVERSE: 退回无界 `group.wait()` → 挂住。
    func testATimedOutRunReturnsEvenWhenAForkedChildHoldsThePipeWriteEnd() throws {
        let directory = TestSandbox.directory("pipe-drain-bound")
        let pidFile = "\(directory)/direct.pid"
        let holderFile = "\(directory)/holder.pid"

        let start = Date()
        let outcome = ConsoleModel.runDaemonCLI(
            binary: "/bin/sh" as String?,
            arguments: holderScript(pidFile: pidFile, holderFile: holderFile),
            timeoutSeconds: 0.5
        )
        let elapsed = Date().timeIntervalSince(start)

        XCTAssertNil(
            outcome,
            "超时仍然回 nil：面板那句折叠就建在这个契约上"
        )
        // 有界 drain（2s）+ 收尸宽限（5s）+ 预算（0.5s）都在 10s 内收得完；
        // 无界 join 在这里永远回不来，这一条断言就是那一格的具名红。
        XCTAssertLessThan(
            elapsed, 10,
            "超时那一趟用了 \(elapsed)s——派生孩子握着写端时 reader join 没有上界，把调用者钉住了"
        )

        // 直接孩子必须被收掉（kill(pid,0) 到已 reap 的号上 ESRCH），派生孩子由本测试
        // 自己清理（那不是面板的债，不能让它跨测试活到套件结束）。
        let directPid = try XCTUnwrap(Int32(
            (try String(contentsOfFile: pidFile, encoding: .utf8))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        ))
        XCTAssertEqual(kill(directPid, 0), -1, "直接孩子没被收掉：\(errno)")
        XCTAssertEqual(errno, ESRCH)

        if let holderText = try? String(contentsOfFile: holderFile, encoding: .utf8),
           let holderPid = Int32(holderText.trimmingCharacters(in: .whitespacesAndNewlines)) {
            killQuietly(holderPid)
        }
    }

    /// 守卫不能反过来咬：预算之内回来的一趟，输出、stderr、退出码一个都不许丢。
    func testAChildThatAnswersInTimeStillReturnsItsReply() throws {
        let result = try XCTUnwrap(ConsoleModel.runDaemonCLI(
            binary: "/bin/sh",
            arguments: ["-c", "printf '{\"ok\":1}'; printf 'note' 1>&2; exit 3"],
            timeoutSeconds: 20
        ), "预算之内回话的一趟不许被折成超时")
        XCTAssertEqual(result.output, "{\"ok\":1}")
        XCTAssertEqual(result.errorOutput, "note")
        XCTAssertEqual(result.status, 3)
    }

    /// 更新器那一条同一个不变量：派生孩子握写端时，超时那一趟照样有界回来。
    /// REVERSE: 退回无界 join → 挂住。
    func testUpdateModelTimedOutRunAlsoReturnsWhenAForkedChildHoldsThePipe() throws {
        let directory = TestSandbox.directory("pipe-drain-bound-update")
        let pidFile = "\(directory)/direct.pid"
        let holderFile = "\(directory)/holder.pid"

        let start = Date()
        let outcome = UpdateModel.runUpdater(
            node: "/bin/sh",
            arguments: holderScript(pidFile: pidFile, holderFile: holderFile),
            environment: ProcessInfo.processInfo.environment,
            timeoutSeconds: 0.5
        )
        let elapsed = Date().timeIntervalSince(start)

        XCTAssertEqual(outcome, .timedOut, "超时那一趟的结论不许变")
        XCTAssertLessThan(elapsed, 10, "更新器超时那一趟用了 \(elapsed)s——reader join 没上界")

        if let holderText = try? String(contentsOfFile: holderFile, encoding: .utf8),
           let holderPid = Int32(holderText.trimmingCharacters(in: .whitespacesAndNewlines)) {
            killQuietly(holderPid)
        }
    }
}
