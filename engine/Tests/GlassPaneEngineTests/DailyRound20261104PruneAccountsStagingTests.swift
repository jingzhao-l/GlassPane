import XCTest
import Foundation
@testable import GlassPaneEngine

/// 每日任务 2026-11-04（同日第二条会话）· 候选 H 复核成立并修完。
///
/// 缺陷。`clear()` 早在 2026-11-03 把 `.tmp-*` 残渣计进了自己的返回值（"清完之后目录里不许还剩
/// 字节"那一格）；`prune(olderThanDays:)` 同一趟里也收残渣，却是 `_ = reclaimStaleStagingFiles()`
/// ——收下的数量被丢掉，只回 `removeExpired` 那一半。`countExpired(olderThanDays:)` 是 CLI
/// `--dry-run` 的"同一来源的数"（P5 §12.2），它连残渣都不数，因为它数的那批名字过不了
/// `isEntryName`。两条合起来的失效模式：dry-run 报 N、真跑那趟从目录里拿掉 N+1 个，而 CLI 报的
/// 删除数是 N+1 里少算残渣的那一半——报出去的数与盘上少掉的字节对不上。
///
/// 修法。残渣的"该不该收"从 reclaim 的身体里抽出来成 `staleStagingNames()`，三处共用：
/// 删除那一趟、dry-run 计数那一趟、以及 `prune` 的返回值。
///
/// REVERSE：把 `countExpired` 里 `+ staleStagingNames().count` 去掉 ⇒ `theDryRunCountsTheOrphan` 红；
/// 把 `prune` 改回 `_ = reclaim…` ⇒ `theReportedNumberMatchesWhatLeftTheDirectory` 红。
final class DailyRound20261104PruneAccountsStagingTests: XCTestCase {

    /// 本机不存在的那一号（与 2026-11-03 那条同一取法）：pid 已不在 ⇒ 这一枚才轮到我们收。
    private static let deadPid: pid_t = 999_997

    private func store(withOrphan named: String) throws -> (EvidenceStore, String) {
        let directory = TestSandbox.directory("prune-staging-\(named)")
        try Data("half-written".utf8).write(to: URL(fileURLWithPath: "\(directory)/\(named)"))
        return (EvidenceStore(directory: directory), directory)
    }

    func testTheDryRunCountsTheOrphan() throws {
        let (store, _) = try store(withOrphan: "op_A.json.tmp-\(Self.deadPid)-orphan")
        XCTAssertEqual(store.countExpired(olderThanDays: 1), 1,
            "dry-run 只数年龄档、不数残渣 ⇒ 报出去的数与真跑的删除数天然不同")
    }

    func testTheReportedNumberMatchesWhatLeftTheDirectory() throws {
        let (store, directory) = try store(withOrphan: "op_B.json.tmp-\(Self.deadPid)-orphan")
        let planned = store.countExpired(olderThanDays: 1)
        let reported = store.prune(olderThanDays: 1)
        XCTAssertEqual(reported, planned,
            "P5 §12.2 要的是同一来源的数：dry-run 报 \(planned)，真跑报 \(reported)")
        let left = (try? FileManager.default.contentsOfDirectory(atPath: directory))?.sorted() ?? []
        XCTAssertEqual(left, [],
            "报完数目录里还剩字节，就是那句「删掉了 \(reported) 个」没做到：\(left)")
    }

    func testALiveWritersFileIsStillNotCounted() throws {
        // 反向的一格：活着的那一号不许进任何一边的数——否则这条闸只是把计数灌大。
        let (store, _) = try store(withOrphan: "op_C.json.tmp-\(ProcessInfo.processInfo.processIdentifier)-live")
        XCTAssertEqual(store.countExpired(olderThanDays: 1), 0, "活着的写者还没交笔，这一枚不归我们")
        XCTAssertEqual(store.prune(olderThanDays: 1), 0)
    }
}
