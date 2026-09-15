import XCTest
@testable import GlassPaneEngine

/// A3 (engine side): C35 dual-binding roundtrip against the kernel fixtures
/// — the same truth set the TypeScript suite consumes (P0 spec §7.2).
final class EvidenceRoundtripTests: XCTestCase {

    private let evidenceFixtureNames = [
        "evidence-pack.ok-01.json",
        "evidence-pack.ok-02.json",
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
        XCTAssertEqual(pack.schemaVersion, "glasspane.evidence/0.1-draft")
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
}
