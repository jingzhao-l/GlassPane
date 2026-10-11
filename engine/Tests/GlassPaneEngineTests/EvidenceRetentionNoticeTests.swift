import XCTest
@testable import GlassPaneEngine

/// 自动留存（写时按条数上限与按龄过期）删掉的档案必须被说出来。
///
/// 缺陷形状：`write()` 成功后调用 `pruneIfNeeded()` / `pruneExpiredIfNeeded()`，
/// 两个函数都 `@discardableResult` 并回"真删了几条"，而**两处调用点都把数丢掉了**。
/// 于是 `EngineCore` 对着一次"存下这一条、同时抹掉 N 条旧档案"的操作报
/// `evidencePersisted: true`——那一句关于本次操作是实话，关于档案柜就不是。
/// 同一条命令走 CLI（`--prune-evidence`）时是逐条报数的，两条路的诚实度不该不一样。
final class EvidenceRetentionNoticeTests: XCTestCase {

    /// 什么都没删就什么都不说：一句"清理了 0 条"会把一次普通写入写成一次维护动作。
    func testNothingRemovedIsNothingSaid() {
        XCTAssertNil(EvidenceStore.retentionNotice(
            capRemoved: 0, ttlRemoved: 0, maxFiles: 500, maxAgeDays: 30, directory: "/tmp/e"))
    }

    func testCapRemovalIsCountedAndAttributed() {
        let notice = EvidenceStore.retentionNotice(
            capRemoved: 3, ttlRemoved: 0, maxFiles: 500, maxAgeDays: 30, directory: "/tmp/e")
        let text = notice ?? ""
        XCTAssertFalse(text.isEmpty, "删了 3 条却没有结论")
        XCTAssertTrue(text.contains("3"), "要说删了几条：\(notice ?? "nil")")
        XCTAssertTrue(text.contains("500"), "要说按哪个上限判的：\(text)")
        XCTAssertFalse(text.contains("day"), "按条数删的，不许顺带声称是按龄删的：\(text)")
    }

    func testAgeRemovalIsCountedAndAttributed() {
        let notice = EvidenceStore.retentionNotice(
            capRemoved: 0, ttlRemoved: 7, maxFiles: 500, maxAgeDays: 21, directory: "/tmp/e")
        let text = notice ?? ""
        XCTAssertTrue(text.contains("7"), "要说删了几条：\(notice ?? "nil")")
        XCTAssertTrue(text.contains("21"), "要说按几天的窗口判的：\(notice ?? "nil")")
        XCTAssertFalse(text.contains("500"), "按龄删的，不许声称碰过条数上限：\(notice)")
    }

    func testBothWindowsReportTheirOwnCounts() {
        let text = EvidenceStore.retentionNotice(
            capRemoved: 2, ttlRemoved: 5, maxFiles: 500, maxAgeDays: 30, directory: "/tmp/e") ?? ""
        XCTAssertTrue(text.contains("2"), text)
        XCTAssertTrue(text.contains("5"), text)
        // 目录名要落在结论里：一次写入删了谁的档案柜，事后要能指认。
        XCTAssertTrue(text.contains("/tmp/e"), text)
    }

    /// 结构闸：两处调用点都必须把返回值交给 `reportRetention`。
    /// 反向破坏：把任一处改回丢弃返回值的裸调用，这一条就红。
    func testEveryRetentionCallUsesTheCountItGetsBack() throws {
        var url = URL(fileURLWithPath: #filePath)
        // …/engine/Tests/GlassPaneEngineTests/<this>.swift → 上溯四级到仓库根
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let sourceURL = url.appendingPathComponent("engine/Sources/GlassPaneEngine/EvidenceStore.swift")
        guard let text = try? String(contentsOf: sourceURL, encoding: .utf8) else {
            throw XCTSkip("读不到 \(sourceURL.path)；这一条对照在没有该文件的环境里不作数")
        }
        var callSites = 0
        for line in text.split(separator: "\n") {
            // 注释里提函数名不算调用点：把注释当缺陷的闸，会被删注释换绿。
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("//") || trimmed.hasPrefix("///") || trimmed.hasPrefix("*") { continue }
            guard line.contains("pruneIfNeeded()") || line.contains("pruneExpiredIfNeeded()") else { continue }
            // `@discardableResult` 的定义行不算调用点（`private func pruneIfNeeded…`）
            if trimmed.contains("func prune") { continue }
            callSites += 1
            XCTAssertTrue(line.contains("reportRetention("),
                "这一处又把留存删除的条数丢掉了：\(trimmed)")
        }
        XCTAssertGreaterThanOrEqual(callSites, 2,
            "只找到 \(callSites) 处留存调用，这条闸已经在看不到东西的地方")
        XCTAssertTrue(text.contains("@discardableResult"),
            "prune* 不再回条数了：这条闸与它守着的那个返回值一起失效")
    }
}
