import XCTest
@testable import GlassPaneEngine

/// A3 (engine side): C35 dual-binding roundtrip against the kernel fixtures
/// — the same truth set the TypeScript suite consumes (P0 spec §7.2).
final class EvidenceRoundtripTests: XCTestCase {
    /// 冻结读取兼容：draft 期落盘的包（schemaVersion 为 legacy 字符串）必须仍能
    /// 解码并通过校验；写侧恒 stamp v0.1（store 里历史包不因冻结自毁）。
    func testLegacyDraftVersionStillValidatesOnRead() throws {
        let fresh = try KernelFixtures.data("evidence-pack.ok-01.json")
        var text = String(data: fresh, encoding: .utf8)!
        text = text.replacingOccurrences(
            of: "\"glasspane.evidence/0.1\"",
            with: "\"glasspane.evidence/0.1-draft\"")
        let legacy = text.data(using: .utf8)!
        let pack = try EvidencePack.decodeAndValidate(legacy)
        XCTAssertEqual(pack.schemaVersion, "glasspane.evidence/0.1-draft")
        let reencoded = try pack.jsonData()
        XCTAssertTrue(String(data: reencoded, encoding: .utf8)!.contains("0.1-draft"),
                      "值保真：读 legacy 不悄悄改写（改写只发生在下次新建）")
    }


    /// 冻结前落盘的档案可能**根本没有** `pixelDiff.bounds` 这个键（Swift 的合成编码器
    /// 在 nil 时省略键，而 schema 要求它存在）。写侧现已显式补 `"bounds": null`，
    /// 所以 ok-05 有意**不进** `evidenceFixtureNames`：那条 canonical 字节比对会红，
    /// 而那个红正是本次修复要制造的非对称。这里把它钉成预期行为，防止后来者
    /// "顺手"把 fixture 加进往返表或把读侧兼容当成冗余删掉。
    func testPreFreezeArchiveWithoutBoundsReadsButReEncodesDifferently() throws {
        let fixture = try KernelFixtures.data("evidence-pack.ok-05-pixelbounds-null.json")
        let fixtureSignal = try XCTUnwrap(
            pixelDiff(in: fixture), "fixture has no signals.pixelDiff object")
        XCTAssertNil(fixtureSignal["bounds"],
                     "fixture must model the pre-fix on-disk shape: key absent, not null")

        // 读侧兼容：缺键的档案仍可解码并通过校验。
        let pack = try EvidencePack.decodeAndValidate(fixture)
        XCTAssertNil(pack.signals.pixelDiff?.bounds)

        // 写侧诚实：重新编码必须把键补回来（值可以是 null），否则内核强校验会
        // 把一条合法档案说成 "engine and kernel schema drifted"。
        let encoded = try pack.jsonData()
        let encodedSignal = try XCTUnwrap(
            pixelDiff(in: encoded), "re-encoded pack lost signals.pixelDiff")
        XCTAssertTrue(encodedSignal.keys.contains("bounds"),
                      "write side must emit pixelDiff.bounds explicitly (null is the honest absence marker)")
        XCTAssertTrue(encodedSignal["bounds"] is NSNull,
                      "the key carries an explicit null, not an invented rectangle")
        XCTAssertNotEqual(try canonicalJSON(fixture), try canonicalJSON(encoded),
                          "the asymmetry is intentional — ok-05 stays out of the byte-equal roundtrip list")
    }

    /// `signals.pixelDiff` 子对象（键存在性与值分开判），避免依赖序列化空白风格。
    private func pixelDiff(in data: Data) -> [String: Any]? {
        guard let root = try? JSONSerialization.jsonObject(with: data),
              let object = root as? [String: Any],
              let signals = object["signals"] as? [String: Any] else { return nil }
        return signals["pixelDiff"] as? [String: Any]
    }

    private let evidenceFixtureNames = [
        "evidence-pack.ok-01.json",
        "evidence-pack.ok-02.json",
        "evidence-pack.ok-03.json", // P6 §3.1: probe-carrying pack (null→object)
    ]

    func testFixturesRoundtripThroughCanonicalJSON() throws {
        for name in evidenceFixtureNames {
            let fixture = try KernelFixtures.data(name)
            let pack = try EvidencePack.decodeAndValidate(fixture)
            let encoded = try pack.jsonData()
            XCTAssertEqual(
                try canonicalJSON(encoded),
                try canonicalJSON(fixture),
                "canonical form drifted for \(name)"
            )
        }
    }

    func testFixturesReencodeToEqualValue() throws {
        for name in evidenceFixtureNames {
            let pack = try EvidencePack.decodeAndValidate(try KernelFixtures.data(name))
            let redecoded = try EvidencePack.decodeAndValidate(try pack.jsonData())
            XCTAssertEqual(pack, redecoded, "value drifted after re-encode for \(name)")
        }
    }

    func testFixture01Shape() throws {
        let pack = try EvidencePack.decodeAndValidate(
            try KernelFixtures.data("evidence-pack.ok-01.json")
        )
        XCTAssertEqual(pack.schemaVersion, "glasspane.evidence/0.1")
        XCTAssertEqual(pack.attribution.level, .soft)
        XCTAssertEqual(pack.circuitBreaker.level, .normal)
        XCTAssertNotNil(pack.signals.axEvent)
        XCTAssertNotNil(pack.signals.pixelDiff)
        XCTAssertNotNil(pack.assertion)
        XCTAssertEqual(pack.diagnosis?.class, .noAnomaly)
    }

    func testFixture02ExplicitNullsSurviveRoundtrip() throws {
        let pack = try EvidencePack.decodeAndValidate(
            try KernelFixtures.data("evidence-pack.ok-02.json")
        )
        XCTAssertNil(pack.assertion)
        XCTAssertNil(pack.diagnosis)
        XCTAssertNil(pack.signals.pixelDiff)
        XCTAssertNil(pack.signals.responsiveness)
        XCTAssertNil(pack.signals.crash)
        XCTAssertEqual(pack.circuitBreaker.level, .degraded)
        // Encode writes the keys as explicit nulls — required by the schema.
        let json = String(data: try pack.jsonData(), encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains("\"assertion\":null"))
        XCTAssertTrue(json.contains("\"diagnosis\":null"))
        XCTAssertTrue(json.contains("\"handlerProbe\":null"))
    }

    func testSchemaVersionInvariantIsEnforced() throws {
        let fixture = try KernelFixtures.data("evidence-pack.ok-01.json")
        var object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: fixture) as? [String: Any]
        )
        object["schemaVersion"] = "glasspane.evidence/9.9-bogus"
        let mutated = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try EvidencePack.decodeAndValidate(mutated)) { error in
            XCTAssertEqual(error as? EvidencePackError, .badSchemaVersion("glasspane.evidence/9.9-bogus"))
        }
    }

    func testOperationIdInvariantIsEnforced() throws {
        let fixture = try KernelFixtures.data("evidence-pack.ok-01.json")
        var object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: fixture) as? [String: Any]
        )
        object["operationId"] = "not-an-op-id"
        let mutated = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try EvidencePack.decodeAndValidate(mutated)) { error in
            XCTAssertEqual(error as? EvidencePackError, .badOperationId("not-an-op-id"))
        }
    }

    func testCreatedAtInvariantIsEnforced() throws {
        let fixture = try KernelFixtures.data("evidence-pack.ok-01.json")
        var object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: fixture) as? [String: Any]
        )
        object["createdAt"] = "2026/09/14 12:00:00"
        let mutated = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try EvidencePack.decodeAndValidate(mutated)) { error in
            XCTAssertEqual(error as? EvidencePackError, .badCreatedAt("2026/09/14 12:00:00"))
        }
    }

    func testCircuitBreakerLevelRejectsOutOfEnumValues() throws {
        let fixture = try KernelFixtures.data("evidence-pack.ok-01.json")
        var object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: fixture) as? [String: Any]
        )
        var breaker = try XCTUnwrap(object["circuitBreaker"] as? [String: Any])
        breaker["level"] = 7
        object["circuitBreaker"] = breaker
        let mutated = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try EvidencePack.decodeAndValidate(mutated))
    }

    // MARK: - decision-log-entry binding (spec v3.0 §21.3: C35 Swift-side leg)

    private func decisionLogObject() throws -> [String: Any] {
        let fixture = try KernelFixtures.data("decision-log-entry.ok-01.json")
        return try XCTUnwrap(
            try JSONSerialization.jsonObject(with: fixture) as? [String: Any]
        )
    }

    private func decisionLogJSON(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    func testDecisionLogFixtureRoundtripsThroughCanonicalJSON() throws {
        let fixture = try KernelFixtures.data("decision-log-entry.ok-01.json")
        let entry = try DecisionLogEntry.decodeAndValidate(fixture)
        let reencoded = try entry.jsonData()
        XCTAssertEqual(
            try canonicalJSON(reencoded),
            try canonicalJSON(fixture),
            "canonical form drifted for decision-log-entry.ok-01.json"
        )
    }

    func testDecisionLogFixtureReencodesToEqualValue() throws {
        let data = try KernelFixtures.data("decision-log-entry.ok-01.json")
        let entry = try DecisionLogEntry.decodeAndValidate(data)
        let redecoded = try DecisionLogEntry.decodeAndValidate(try entry.jsonData())
        XCTAssertEqual(entry, redecoded, "value drifted after re-encode")
    }

    func testDecisionLogFixtureShape() throws {
        let entry = try DecisionLogEntry.decodeAndValidate(
            try KernelFixtures.data("decision-log-entry.ok-01.json")
        )
        XCTAssertEqual(entry.entryId, "dl_0123456789ABCDEFGHJKMNPQRS")
        XCTAssertEqual(entry.sequence, 0)
        XCTAssertEqual(entry.prevEntryHash, "")
        XCTAssertEqual(entry.operationId, "op_0123456789ABCDEFGHJKMNPQRS")
        XCTAssertEqual(entry.outcome, .pass)
        XCTAssertEqual(entry.createdAt, "2026-09-14T12:34:56.789Z")
        XCTAssertLessThanOrEqual(entry.summary.count, DecisionLogEntry.summaryMaxLength)
    }

    func testDecisionLogRejectsBadEntryId() throws {
        var object = try decisionLogObject()
        object["entryId"] = "dl_short"
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(try decisionLogJSON(object))) { error in
            XCTAssertEqual(error as? DecisionLogEntryError, .badEntryId("dl_short"))
        }
    }

    func testDecisionLogRejectsBadPrevEntryHash() throws {
        var object = try decisionLogObject()
        object["prevEntryHash"] = "zz-not-hex"
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(try decisionLogJSON(object))) { error in
            XCTAssertEqual(error as? DecisionLogEntryError, .badPrevEntryHash("zz-not-hex"))
        }
    }

    func testDecisionLogRejectsNegativeSequence() throws {
        var object = try decisionLogObject()
        object["sequence"] = -1
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(try decisionLogJSON(object))) { error in
            XCTAssertEqual(error as? DecisionLogEntryError, .badSequence(-1))
        }
    }

    func testDecisionLogRejectsUnknownOutcome() throws {
        var object = try decisionLogObject()
        object["outcome"] = "maybe"
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(try decisionLogJSON(object)))
    }

    func testDecisionLogRejectsBadOperationId() throws {
        var object = try decisionLogObject()
        object["operationId"] = "nope"
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(try decisionLogJSON(object))) { error in
            XCTAssertEqual(error as? DecisionLogEntryError, .badOperationId("nope"))
        }
    }

    func testDecisionLogRejectsBadCreatedAt() throws {
        var object = try decisionLogObject()
        object["createdAt"] = "2026/09/14 12:00:00"
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(try decisionLogJSON(object))) { error in
            XCTAssertEqual(error as? DecisionLogEntryError, .badCreatedAt("2026/09/14 12:00:00"))
        }
    }

    func testDecisionLogRejectsMissingRequiredField() throws {
        var object = try decisionLogObject()
        object.removeValue(forKey: "prevEntryHash")
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(try decisionLogJSON(object)))
    }

    func testDecisionLogRejectsOverlongSummary() throws {
        var object = try decisionLogObject()
        let overlong = DecisionLogEntry.summaryMaxLength + 1
        object["summary"] = String(repeating: "a", count: overlong)
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(try decisionLogJSON(object))) { error in
            XCTAssertEqual(error as? DecisionLogEntryError, .summaryTooLong(overlong))
        }
    }
}
