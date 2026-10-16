import XCTest
@testable import GlassPaneEngine

/// `selector.title` 的空串：发布的契约说拒，执行它的层必须真的拒（P2 #6）。
///
/// 缺陷形状：`kernel/schemas/evidence-pack.schema.json` 的 `$defs.selector.title`
/// 写着 `minLength: 1`，而 `ParamValidation.optSelector` 只对 `role` 做非空判定，
/// `title`/`identifier` 走的是只管长度的 `optString`。于是
/// `gp_act {"selector":{"role":"AXButton","title":""}}` 被 daemon 收下、写进证据包，
/// 而那份包又被同一份已发布的 schema 判为非法——**一个契约、两个判决**，且 daemon
/// 是 schema 自己声明的最后判决层。
///
/// `identifier` 保持可空串，判据同样是那份 schema 的原文（"Deliberately has no
/// minLength: no side rules on an empty identifier (the daemon has no guard for it),
/// so the kernel does not invent one."）：这一侧跟着契约走，不在代码里发明规则。
///
/// 夹具来自真文件：直接读 `kernel/schemas/evidence-pack.schema.json` 本体，期望值
/// 由那份已发布的契约算出来，不是测试里手抄的。
final class SelectorTitleEmptinessTests: XCTestCase {

    // MARK: - 行为

    func testExplicitlyPresentEmptyTitleIsRefusedAsBadParams() {
        XCTAssertThrowsError(
            try ParamValidation.requireSelector(["selector": ["role": "AXButton", "title": ""]])
        ) { error in
            let gp = error as? GPError
            XCTAssertEqual(gp?.code, .badParams, "契约的拒绝口径就是 GP_E_BAD_PARAMS")
            XCTAssertTrue(gp?.message.contains("selector.title") == true,
                          "报文要点名是哪个字段：\(gp?.message ?? "\(error)")")
        }
    }

    /// 空串出现在 ffwd 的步骤里同样要拒——那一步的 selector 会原样进证据包。
    func testEmptyTitleInsideRestoreStepsIsRefusedWithTheStepIndex() {
        XCTAssertThrowsError(
            try ParamValidation.optSteps([
                "steps": [["selector": ["role": "AXButton", "title": ""], "action": "press"]]
            ])
        ) { error in
            let gp = error as? GPError
            XCTAssertEqual(gp?.code, .badParams)
            XCTAssertTrue(gp?.message.contains("steps[0]") == true, "\(gp?.message ?? "\(error)")")
            XCTAssertTrue(gp?.message.contains("selector.title") == true, "\(gp?.message ?? "\(error)")")
        }
    }

    // MARK: - 对照必须能过：这条改动只关掉"显式空串"这一格

    func testAbsentTitleIsStillOptional() throws {
        let selector = try ParamValidation.requireSelector(["selector": ["role": "AXButton"]])
        XCTAssertNil(selector.title, "省略 title 仍然是合法的：这条修复不许把可选变成必填")
    }

    func testNonEmptyTitleIsStillAccepted() throws {
        let selector = try ParamValidation.requireSelector(["selector": ["role": "AXButton", "title": "Submit"]])
        XCTAssertEqual(selector.title, "Submit")
    }

    /// 长度判据不变（超上限仍拒），空串判据不越界到别处。
    func testTitleLengthCapIsUnchanged() {
        XCTAssertThrowsError(try ParamValidation.requireSelector([
            "selector": ["role": "AXButton", "title": String(repeating: "x", count: ParamValidation.selectorMaxLength + 1)]
        ]))
    }

    /// `identifier` 是这条规则**刻意不扩过去**的那一侧，判据来自 schema 原文；
    /// 这里的行为断言与下面那条 schema 对照一起成立。
    func testEmptyIdentifierIsStillAcceptedBecauseTheSchemaSaysSo() throws {
        let selector = try ParamValidation.requireSelector([
            "selector": ["role": "AXButton", "identifier": ""]
        ])
        XCTAssertEqual(selector.identifier, "", "空 identifier 的沉默是 schema 写的，不是遗漏")
    }

    // MARK: - 与发布契约的对照：schema 说什么，代码就判什么

    /// 从**真的** schema 文件里读出 `$defs.selector.title.minLength`，按它决定这一格
    /// 应当拒还是应当收。两侧任何一处漂移都会让这条红：schema 加了 minLength 而
    /// 从**真的** schema 文件读 `$defs.selector.<field>.minLength`，由它决定这一格
    /// 应当拒还是应当收。两侧任何一处漂移都会让这条红：schema 加了 minLength 而
    /// daemon 不拒（原缺陷），或 daemon 拒了而 schema 说可收（反向发明规则）。
    func testDaemonEmptinessVerdictFollowsThePublishedSchema() throws {
        let schema = try publishedSelectorSchema()

        for field in ["title", "identifier"] {
            let spec = try XCTUnwrap(schema[field] as? [String: Any], "schema 里读不到 selector.\(field)")
            let minLength = (spec["minLength"] as? NSNumber)?.intValue ?? 0
            let frame: [String: Any] = ["role": "AXButton", field: ""]

            if minLength > 0 {
                XCTAssertThrowsError(
                    try ParamValidation.requireSelector(["selector": frame]),
                    "schema 对 selector.\(field) 声明了 minLength \(minLength)，daemon 却收下空串：一份契约两个判决"
                ) { error in
                    XCTAssertEqual((error as? GPError)?.code, .badParams)
                }
            } else {
                // 这一支的期望值来自 schema 自己的句子："Deliberately has no minLength:
                // no side rules on an empty identifier (the daemon has no guard for it),
                // so the kernel does not invent one."
                XCTAssertNoThrow(
                    try ParamValidation.requireSelector(["selector": frame]),
                    "schema 对 selector.\(field) 没有立空串规则，daemon 却凭空加了拒绝"
                )
            }
        }
    }

    /// 已发布契约里 `$defs.selector.properties` 的那一份，读的是仓库里的真文件。
    private func publishedSelectorSchema() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // engine
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("kernel/schemas/evidence-pack.schema.json")
        let data = try Data(contentsOf: url)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let defs = try XCTUnwrap(root["$defs"] as? [String: Any])
        let selector = try XCTUnwrap(defs["selector"] as? [String: Any])
        return try XCTUnwrap(selector["properties"] as? [String: Any])
    }
}
