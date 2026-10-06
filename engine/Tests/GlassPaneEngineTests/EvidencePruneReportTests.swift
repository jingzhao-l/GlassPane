import Foundation
import XCTest

@testable import GlassPaneEngine

/// `--prune-evidence` 对外那一句的形状闸。立的规矩只有一条：**没数出来的东西不许写成 0**。
///
/// REVERSE MUTATION：把 `main.swift` 里 `listFailure == nil ? removed : nil` 退回成
/// `removed`（即删掉这一步），`archiveThatCouldNotBeListedIsNotReportedAsZeroPruned`
/// 这条一起红——旧行为正是"归档读不了也报 pruned:0 + exit 0"。
final class EvidencePruneReportTests: XCTestCase {
    private func serialize(_ payload: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(
            withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }

    func testArchiveThatCouldNotBeListedIsNotReportedAsZeroPruned() throws {
        let payload = EvidencePruneReport.payload(
            pruned: nil,
            dryRun: false,
            project: nil,
            dir: "/tmp/glasspane-evidence",
            listFailure: "cannot read the evidence archive at /tmp/glasspane-evidence (perm)"
        )
        XCTAssertNotNil(payload["pruned"] as? NSNull,
                        "读不了的归档必须写成 null；0 是一句「已经清理过了」的谎")
        XCTAssertEqual(payload["listFailure"] as? String,
                       "cannot read the evidence archive at /tmp/glasspane-evidence (perm)",
                       "失败原因要原样发出去，否则调用方只能猜")
        XCTAssertTrue(try serialize(payload).contains(#""pruned":null"#),
                      "落到线上也得是 null，而不是被 Swift 的 Any 装箱糊成一个对象")
    }

    func testAListingThatSucceededReportsTheNumberItMeasured() {
        for n in [0, 1, 17] {
            let payload = EvidencePruneReport.payload(
                pruned: n, dryRun: false, project: nil, dir: "/d", listFailure: nil)
            XCTAssertEqual(payload["pruned"] as? Int, n, "数到了就写数到的，包括 0")
            XCTAssertNotNil(payload["listFailure"] as? NSNull,
                            "没有失败要写成 null，而不是干脆没有这个键")
        }
    }

    func testDryRunAndProjectSurviveTheShape() {
        let payload = EvidencePruneReport.payload(
            pruned: 3, dryRun: true, project: "com.example.app", dir: "/d", listFailure: nil)
        XCTAssertEqual(payload["dryRun"] as? Bool, true)
        XCTAssertEqual(payload["project"] as? String, "com.example.app")
        XCTAssertEqual(payload["dir"] as? String, "/d")
        let absent = EvidencePruneReport.payload(
            pruned: 0, dryRun: false, project: nil, dir: "/d", listFailure: nil)
        XCTAssertNotNil(absent["project"] as? NSNull,
                        "没点名项目时写 null，与 --evidence-stats 同形")
    }

    /// 字段集合要与 `--evidence-stats` 一样能表达"没测出来"：两个 CLI 的读者是同一个面板
    /// 与同一批 remedy，一边有这个表达、另一边没有，就又是"同一个错误码从两层得到两句
    /// 相反的话"那个形状。
    func testListFailureIsPartOfTheContractOnBothSides() throws {
        let keys = Set(EvidencePruneReport.payload(
            pruned: 0, dryRun: false, project: nil, dir: "/d", listFailure: nil).keys)
        XCTAssertTrue(keys.isSuperset(of: ["pruned", "dryRun", "project", "dir", "listFailure"]))
        XCTAssertNil(EvidenceArchiveStats(count: 0, totalBytes: 0).listFailure,
                     "stats 侧的 listFailure 是这条句子的另一半，它改了名这里先红")
    }
}
