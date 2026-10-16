import XCTest
@testable import GlassPaneEngine

/// restore 的 ffwd 步骤行（P2 #4）与 main.swift 里两条被"读不开"支配的一次性分支
/// （P1 #1 的落点证明）。
///
/// #4 的缺陷形状：`EngineCore.swift` 里那一行写的是
/// `"operationId": outcome["operationId"] as? String ?? ""`，所以任何一次形状漂移
/// 都会落成一个**存在但没有意义**的空 id。仓里别处对"没测到"的编码是**缺席**
/// （`act` 的 `axChanged`/`pixelChanged`，R1-03），而空串读起来像一个答案：agent
/// 拿着它去问 `gp_last_evidence` 就问得到一次根本不存在的操作。
final class RestoreStepRowShapeTests: XCTestCase {

    private func core() -> EngineCore {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, clock: { Date(timeIntervalSince1970: 1_760_000_000) }, settle: {})
        _ = try? core.attach(bundleId: nil, pid: 4242)
        return core
    }

    /// 夹具的正当来源：一次**真 act 的真响应**（本仓的 ScriptedChannel 是 daemon 之外
    /// 唯一被接受的时间线源），不是测试里手拼的字典。
    private func realActOutcome() throws -> [String: Any] {
        let outcome = try core().act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        XCTAssertTrue(outcome["operationId"] is String, "前置条件：真响应里 operationId 是个字符串")
        return outcome
    }

    func testRowCarriesTheOperationIdFromARealActOutcome() throws {
        let row = EngineCore.rollForwardStepRow(
            selector: Selector(role: "AXButton", title: "Submit"),
            action: .press,
            outcome: try realActOutcome()
        )
        let operationId = try XCTUnwrap(row["operationId"] as? String)
        XCTAssertTrue(operationId.hasPrefix("op_"), operationId)
    }

    /// 缺陷的正身：`as? String` 落空时必须**不写这个键**，而不是写一个空串。
    func testRowOmitsOperationIdWhenTheOutcomeDoesNotCarryOne() throws {
        // 由真响应删掉那一个键——表达的是一次上游形状漂移，不是新造的字典。
        var drifted = try realActOutcome()
        drifted.removeValue(forKey: "operationId")

        let row = EngineCore.rollForwardStepRow(
            selector: Selector(role: "AXButton", title: "Submit"),
            action: .press,
            outcome: drifted
        )
        XCTAssertFalse(row.keys.contains("operationId"),
                       "没测到的 id 被写成了缺席的替身：\(row["operationId"] ?? "")——读这行的人拿它去问 gp_last_evidence 就会问到一次不存在的操作")
        // 其余字段照旧：拒绝只该掉那一个键，不该把整行变成空。
        XCTAssertEqual(row["actConfirmed"] as? Bool, true)
        XCTAssertEqual(row["action"] as? String, "press")
    }

    /// 非字符串的 id（形状漂移的另一半）同样必须缺席。
    func testRowOmitsOperationIdWhenItIsNotAString() throws {
        var drifted = try realActOutcome()
        drifted["operationId"] = 42
        let row = EngineCore.rollForwardStepRow(
            selector: Selector(role: "AXButton", title: "Submit"), action: .press, outcome: drifted
        )
        XCTAssertNil(row["operationId"], "\(row)")
    }

    /// 选择器里没给的字段仍然缺席（同一口径的既有形状，撤掉 `if let` 就会红）。
    func testRowOmitsSelectorFieldsThatWereNotGiven() throws {
        let row = EngineCore.rollForwardStepRow(
            selector: Selector(role: "AXButton"), action: .press, outcome: try realActOutcome()
        )
        let selector = try XCTUnwrap(row["selector"] as? [String: Any])
        XCTAssertEqual(Set(selector.keys), ["role"], "\(selector)")
    }

    /// 端到端对照：真走一遍带 steps 的 restore，每一行的 id 都得是有意义的。
    func testRestoredStepsEveryRowHasANonEmptyOperationId() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, clock: { Date(timeIntervalSince1970: 1_760_000_000) }, settle: {})
        _ = try core.attach(bundleId: nil, pid: 4242)
        let snapshot = try core.snapshot(maxDepth: 6)
        let snapshotId = try XCTUnwrap(snapshot["snapshotId"] as? String)

        let restore = try core.restore(snapshotId: snapshotId, steps: [
            (Selector(role: "AXButton", title: "Submit"), .press),
            (Selector(role: "AXCheckBox", title: "Agree"), .press),
        ])
        let rows = try XCTUnwrap(restore["steps"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 2)
        for row in rows {
            let id = try XCTUnwrap(row["operationId"] as? String)
            XCTAssertFalse(id.isEmpty, "空 id 又被写进行里：\(row)")
            XCTAssertTrue(id.hasPrefix("op_"))
        }
    }
}
