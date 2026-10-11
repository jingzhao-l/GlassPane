import XCTest
@testable import glasspane_settings

/// 清理预览的来源：**清单必须由 daemon 的 `--project-prune --dry-run` 产生**。
///
/// 从前 `previewTestResiduePrune()` 是面板本地按 `LocalArchive.isTestResidue` 过滤自己
/// 读到的注册表，注释却写着"先跑 dry-run"。于是确认表上那个"N 条"是面板的主张，
/// 而按下确认之后删的是 daemon 的判定——两份判定之间没有任何保证，界面却把它们
/// 说成同一件事。报文形状取自真二进制：`glasspaned --state-dir <临时根> --project-prune --dry-run`
/// 在 2026-10-10 实际回过的那一行（字段与顺序照抄，含 `evidenceStoragePath` 为 null 的写法）。
final class PrunePreviewSourceTests: XCTestCase {

    /// 真报文的形状，命中两条。
    private func dryRunReply(matched: Int, rows: [String], loadFailed: Bool = false,
                             dryRun: Bool = true, registry: String = "/tmp/state/projects.json") -> String {
        let body = rows.joined(separator: ",")
        return """
        {"command":"--project-prune","dryRun":\(dryRun ? "true" : "false"),"failed":0,"failures":[],\
        "loadFailed":\(loadFailed ? "true" : "false"),"matched":\(matched),"projects":[\(body)],\
        "pruned":0,"prunedProjectIds":[],"registryPath":\"\(registry)\","remaining":\(200 - matched),\
        "requiresDaemonRestart":false,"total":200}
        """
    }

    private let rowA = """
    {"projectId":"gp-selftest-01","displayName":"GlassPane 自检示例","bundleId":"com.glasspane.selftest",\
    "evidenceStoragePath":"/var/folders/xx/T/glasspane-evidence"}
    """
    private let rowB = """
    {"projectId":"gp-selftest-02","displayName":"Second","bundleId":"com.glasspane.selftest.two",\
    "evidenceStoragePath":null}
    """

    func testRealDryRunPayloadBecomesTheConfirmationTable() {
        let reply = dryRunReply(matched: 2, rows: [rowA, rowB])
        guard case .rows(let rows) = ConsoleModel.prunePreviewOutcome(
            cliRan: true, stdout: reply, stderr: "", exitCode: 0) else {
            return XCTFail("真报文应当折成清单，实到 refused")
        }
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].projectId, "gp-selftest-01")
        XCTAssertEqual(rows[0].displayName, "GlassPane 自检示例")
        XCTAssertEqual(rows[0].evidenceStoragePath, "/var/folders/xx/T/glasspane-evidence")
        XCTAssertNil(rows[1].evidenceStoragePath, "null 要说成没配，不许折成默认目录")
    }

    /// 空清单是一个答复，不是一个失败：daemon 说没有命中，确认表就该说没有命中。
    func testZeroHitsIsAnAnswerNotARefusal() {
        let reply = dryRunReply(matched: 0, rows: [])
        guard case .rows(let rows) = ConsoleModel.prunePreviewOutcome(
            cliRan: true, stdout: reply, stderr: "", exitCode: 0) else {
            return XCTFail("matched:0 应当回一张空表，而不是拒绝")
        }
        XCTAssertTrue(rows.isEmpty)
    }

    func testUnrecognizedReplyRefusesAndQuotesTheDaemon() {
        // daemon 认不出这条命令时回的是 usage + 64：那句帮助文本里没有 matched，
        // 折算成"0 命中"就等于当着一屏残留说"没有要清理的"。
        let outcome = ConsoleModel.prunePreviewOutcome(
            cliRan: true, stdout: "usage: glasspaned [--state-dir PATH] ...\n", stderr: "", exitCode: 64)
        guard case .refused(let message) = outcome else { return XCTFail("没有字段的回话必须拒") }
        XCTAssertTrue(message.contains("64"), message)
        XCTAssertTrue(message.contains("matched"), message)
        XCTAssertTrue(message.contains("任何删除都不会执行"), message)
    }

    func testUnreadableRegistryRefusesAndNamesTheFile() {
        let reply = dryRunReply(matched: 0, rows: [], loadFailed: true,
                                registry: "/Users/dev/.glasspane/projects.json")
        guard case .refused(let message) = ConsoleModel.prunePreviewOutcome(
            cliRan: true, stdout: reply, stderr: "", exitCode: 1) else {
            return XCTFail("loadFailed 必须拒，不许摊一张空表")
        }
        XCTAssertTrue(message.contains("/Users/dev/.glasspane/projects.json"), message)
    }

    /// 面板要的是预览；回话若说 `dryRun:false`，那是"已经动过注册表"，必须大声说。
    func testAReplyThatAlreadyDeletedIsNotShownAsAPreview() {
        let reply = dryRunReply(matched: 1, rows: [rowA], dryRun: false)
        guard case .refused(let message) = ConsoleModel.prunePreviewOutcome(
            cliRan: true, stdout: reply, stderr: "", exitCode: 0) else {
            return XCTFail("dryRun:false 不许被当成预览清单")
        }
        XCTAssertTrue(message.contains("dryRun:false"), message)
    }

    /// 命中数与清单条数不符 = 回话自相矛盾，两数都要出现在拒绝理由里。
    func testContradictoryCountsAreRefusedRatherThanTruncated() {
        let reply = dryRunReply(matched: 3, rows: [rowA, rowB])
        guard case .refused(let message) = ConsoleModel.prunePreviewOutcome(
            cliRan: true, stdout: reply, stderr: "", exitCode: 0) else {
            return XCTFail("matched:3 而 projects 只有 2 条时必须拒")
        }
        XCTAssertTrue(message.contains("3"), message)
        XCTAssertTrue(message.contains("2"), message)
    }

    /// 拒绝路径的报文在 stderr（`--project-prune` 的 loadFailed 报告就写在那里）。
    func testRefusalPayloadCarriedOnStderrIsStillRead() {
        let reply = dryRunReply(matched: 0, rows: [], loadFailed: true)
        guard case .refused = ConsoleModel.prunePreviewOutcome(
            cliRan: true, stdout: "", stderr: reply, exitCode: 1) else {
            return XCTFail("只看 stdout 会把 stderr 里那份真答复当空气")
        }
    }

    func testMissingBinaryRefusesWithoutNamingAReasonThatBlamesTheUser() {
        guard case .refused(let message) = ConsoleModel.prunePreviewOutcome(
            cliRan: false, stdout: "", stderr: "", exitCode: -1) else {
            return XCTFail("CLI 没跑成必须拒")
        }
        XCTAssertTrue(message.contains("点「刷新」恢复后重试"), message)
    }

    /// 结构闸：预览这一步必须真的去调 `--project-prune --dry-run`，
    /// 并且**不再**用面板本地过滤来填这张表。
    func testPreviewNowComesFromTheDaemonNotAPanelSideFilter() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let path = url.appendingPathComponent("engine/Sources/glasspane-settings/ConsoleModel.swift").path
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 ConsoleModel.swift；这一条对照在没有该文件的环境里不作数")
        }
        let preview = text[text.range(of: "func previewTestResiduePrune()")!.lowerBound...]
        let body = String(preview.prefix(through: preview.range(of: "func confirmPrune")!.lowerBound))
        XCTAssertTrue(body.contains("\"--project-prune\""), "预览不再调 daemon 的 prune：\(body.prefix(160))")
        XCTAssertTrue(body.contains("\"--dry-run\""), "预览没带 --dry-run：确认表前就多了一次真删的风险")
        XCTAssertFalse(body.contains("prunePreview = projects.filter"),
            "确认表又回到面板本地过滤了：那张表重新变成面板的主张而不是后台服务的答复")
    }
}
