import XCTest
@testable import GlassPaneEngine

/// 2026-10-19 review lane, the pack-writing side.
///
/// These are the fields the frozen contract bounds and the Swift producer never
/// bounded: `kernel/schemas/evidence-pack.schema.json` counts `maxLength` in
/// UTF-16 code units, `mcp-shell/src/tools.ts` counts `z.string().max()` in the
/// same units, and the reader says so in its own words
/// (`kernel/dist/evidence-pack.js:216-228`: "the Swift writer counts Characters
/// and never bounds these fields"). A pack the daemon wrote and then certified
/// with `evidencePersisted: true` is refused by the shell that reads it back.
final class Qoder20261019ProducerBoundsTests: XCTestCase {

    // The caps, spelled as the schema spells them, so a change here must be a
    // change there (and this file goes red if only one side moves).
    private static let stateKeyMaxUTF16 = 512      // $defs.stateDiffSignal…key
    private static let stateValueMaxUTF16 = 1024   // …before / …after
    private static let handlerFileMaxUTF16 = 512   // $defs.handlerProbeSignal…handlers[].file
    private static let probeVersionMaxUTF16 = 64   // $defs.handlerProbeSignal.probeVersion
    private static let selectorMaxUTF16 = 512      // $defs.selector role/title/identifier

    private func hello(
        pid: Int32 = 4242,
        capabilities: [String] = ["z1", "z2"],
        probeVersion: String = "gp-probe/0.1.0"
    ) -> ProbeHello {
        ProbeHello(
            pid: pid, bundleId: "com.example.app", appName: "Example",
            probeVersion: probeVersion, capabilities: capabilities
        )
    }

    // MARK: - defect 4: producer-side bounds on the probe strings

    /// A 4 KiB `before` from a real state frame must land in an archive the
    /// frozen schema accepts, and the elision has to be readable as an elision —
    /// a clipped value that looks complete is the same dishonesty in a smaller
    /// font (`RecipeLoader.capped` says this out loud for the same reason).
    func testOversizedStateValuesAreBoundedAndMarkedInTheStoredPack() throws {
        let inbox = ProbeInbox(now: { Date(timeIntervalSince1970: 1_758_200_000) })
        inbox.register(hello())
        inbox.beginWindow(pid: 4242, opId: "op_oversized")
        let big = String(repeating: "x", count: 4096)
        let bigKey = String(repeating: "k", count: 4096)
        inbox.ingest(
            pid: 4242,
            frame: .state(key: bigKey, before: big, after: "y", source: "z2-mirror", ts: 0)
        )
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_oversized"))
        let entry = try XCTUnwrap(signals.stateDiff?.entries.first)

        XCTAssertLessThanOrEqual(
            entry.before.utf16.count, Self.stateValueMaxUTF16,
            "revert: a 4096-unit `before` was archived verbatim and the frozen reader refuses the pack"
        )
        XCTAssertLessThanOrEqual(entry.key.utf16.count, Self.stateKeyMaxUTF16)
        XCTAssertTrue(
            entry.before.hasSuffix("UTF-16 units total)"),
            "a truncated value must be tellable from a short one: \(entry.before.suffix(60))"
        )
        XCTAssertTrue(entry.before.contains("4096"), "the elision names how much was there")
        XCTAssertEqual(entry.after, "y", "a value inside the cap is left byte-for-byte alone")

        // And the whole pack survives the archive path a reader uses.
        let store = TestSandbox.evidenceStore(at: TestSandbox.directory("oversized-pack"))
        let pack = EvidencePack(
            operationId: "op_0123456789ABCDEFGHJKMNPQRS",
            createdAt: "2026-10-19T00:00:00.000Z",
            attribution: Attribution(level: .strong, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "Submit"),
                    action: .press, actConfirmed: true
                ),
                handlerProbe: signals.handlerProbe,
                stateDiff: signals.stateDiff
            )
        )
        XCTAssertTrue(store.write(pack), "the archive write itself must succeed")
        let read = try XCTUnwrap(store.read(operationId: pack.operationId))
        let stored = try XCTUnwrap(read.signals.stateDiff?.entries.first)
        XCTAssertLessThanOrEqual(stored.before.utf16.count, Self.stateValueMaxUTF16)
        XCTAssertLessThanOrEqual(stored.key.utf16.count, Self.stateKeyMaxUTF16)
    }

    /// The handler side of the same field list: `HandlerRef.file` and
    /// `probeVersion` carry the schema's caps too.
    func testOversizedHandlerFileAndProbeVersionAreBounded() throws {
        let inbox = ProbeInbox(now: { Date(timeIntervalSince1970: 1_758_200_000) })
        inbox.register(hello(probeVersion: String(repeating: "v", count: 200)))
        inbox.beginWindow(pid: 4242, opId: "op_bigfile")
        inbox.ingest(
            pid: 4242,
            frame: .handler(file: String(repeating: "S", count: 4096), line: 12, ts: 0, durationNs: nil)
        )
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_bigfile"))
        let handlerProbe = try XCTUnwrap(signals.handlerProbe)
        let file = try XCTUnwrap(handlerProbe.handlers.first?.file)
        XCTAssertLessThanOrEqual(
            file.utf16.count, Self.handlerFileMaxUTF16,
            "revert: a 4096-unit handler path was archived verbatim"
        )
        XCTAssertTrue(file.hasSuffix("UTF-16 units total)"))
        XCTAssertLessThanOrEqual(
            handlerProbe.probeVersion.utf16.count, Self.probeVersionMaxUTF16,
            "probeVersion is `maxLength: 64` in the same $defs block"
        )
    }

    /// An astral character is 1 Character / 2 UTF-16 units, and the schema counts
    /// units: the bound must not be able to leave a surrogate half behind (that is
    /// not a character, and a JSON writer cannot be asked what it means).
    func testTruncationNeverSplitsAnAstralCharacter() {
        let emoji = "\u{1F600}" // 1 Character, 2 UTF-16 units
        let value = String(repeating: emoji, count: 600) // 1200 units
        let bounded = StateEntry(key: "model.avatar", before: value, after: "small")
        XCTAssertLessThanOrEqual(bounded.before.utf16.count, Self.stateValueMaxUTF16)
        XCTAssertFalse(
            Self.hasOrphanSurrogate(bounded.before),
            "no orphaned surrogate half may reach the archive"
        )
    }

    /// True when `text` contains a UTF-16 half with no partner — the shape a
    /// code-unit cut produces and the shape no JSON reader can be expected to
    /// agree about.
    private static func hasOrphanSurrogate(_ text: String) -> Bool {
        let units = Array(text.utf16)
        var index = 0
        while index < units.count {
            let unit = units[index]
            switch unit {
            case 0xD800...0xDBFF:
                guard index + 1 < units.count, (0xDC00...0xDFFF).contains(units[index + 1]) else {
                    return true
                }
                index += 2
            case 0xDC00...0xDFFF:
                return true
            default:
                index += 1
            }
        }
        return false
    }

    // MARK: - defect 5: the length unit

    /// `z.string().max(512)` and the schema's `maxLength: 512` count UTF-16 code
    /// units; `string.count` counts grapheme clusters. A combining sequence or
    /// an astral character therefore costs the daemon 1 and costs the shell and
    /// the schema 2+, so the daemon admitted what every later reader rejects.
    func testSelectorLengthIsJudgedInUTF16UnitsNotGraphemes() throws {
        let combining = String(repeating: "e\u{0301}", count: 512)   // 512 graphemes, 1024 units
        let astral = String(repeating: "\u{1F600}", count: 512)      // 512 graphemes, 1024 units
        for (label, value) in [("combining", combining), ("astral", astral)] {
            XCTAssertEqual(value.count, 512, "\(label): fixture premise — 512 graphemes")
            XCTAssertEqual(value.utf16.count, 1024, "\(label): fixture premise — over the cap")
            XCTAssertThrowsError(
                try ParamValidation.optSelector(["selector": [
                    "role": "AXButton", "title": value
                ]]),
                "\(label): a 1024-unit title must be GP_E_BAD_PARAMS, not admitted and archived"
            ) { error in
                XCTAssertEqual((error as? GPError)?.code, .badParams, "\(label)")
            }
            XCTAssertThrowsError(
                try ParamValidation.requireExpected(["expected": value]),
                "\(label): `expected` carries the same cap"
            ) { error in
                XCTAssertEqual((error as? GPError)?.code, .badParams, "\(label)")
            }
        }
        // Exactly at the cap, in units: still accepted.
        let atCap = String(repeating: "a", count: 512)
        let selector = try ParamValidation.optSelector([
            "selector": ["role": "AXButton", "title": atCap, "identifier": atCap]
        ])
        XCTAssertEqual(try XCTUnwrap(selector).title, atCap)
        // And an accepted string satisfies the schema cap wherever it lands.
        let pack = EvidencePack(
            operationId: "op_0123456789ABCDEFGHJKMNPQRS",
            createdAt: "2026-10-19T00:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(
                    selector: try XCTUnwrap(ParamValidation.optSelector([
                        "selector": ["role": "AXButton", "title": String(combining.prefix(256))]
                    ])),
                    action: .press, actConfirmed: true
                )
            )
        )
        XCTAssertNoThrow(try pack.validateInvariants())
        XCTAssertLessThanOrEqual(
            pack.signals.act.selector.title?.utf16.count ?? 0, Self.selectorMaxUTF16
        )
    }

    /// The same unit rule for the free-text fields `optString` reads, so a
    /// 512-grapheme `bundleId`-shaped value is not a 1024-unit surprise.
    func testOptStringRejectsOverCapUnitsAndKeepsExactCapValues() throws {
        let over = String(repeating: "\u{1F600}", count: 60) // 60 graphemes, 120 units
        XCTAssertThrowsError(
            try ParamValidation.optString(["mode": over], "mode", maxLength: 100),
            "revert: `count` said 60 <= 100 and the value went through"
        )
        let exact = String(repeating: "a", count: 100)
        XCTAssertEqual(try ParamValidation.optString(["mode": exact], "mode", maxLength: 100), exact)
    }

    // MARK: - defect 10: the integral fast path's cut

    /// The doc above `JSONValue` states the boundary — shortest roundtrip form,
    /// integral values bare, exactly as `canonicalJson` does in TypeScript — and
    /// the fast path cut one decade early (`9.007_199_254_740_992e14` instead of
    /// 2^53 = 9.007199254740992e15), so every integral payload in that decade was
    /// written as a Double and re-spelled. The ledger hashes canonical bytes, so
    /// one such value changes what every later line links against.
    func testIntegralPayloadInThePetabyteDecadeRoundTripsByteIdentical() throws {
        for raw in [
            "{\"n\":1000000000000000}",        // 1e15 — inside the wrong cut
            "{\"n\":9000000000000000}",        // 9e15
            "{\"n\":9007199254740991}",        // MAX_SAFE_INTEGER - 1
            "{\"n\":1234567890123456}",
            "{\"n\":-1000000000000000}"
        ] {
            let decoded = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
            let reencoded = try EvidencePack.encoder.encode(decoded)
            XCTAssertEqual(
                String(decoding: reencoded, as: UTF8.self), raw,
                "revert: \(raw) was archived through the Double path"
            )
        }
    }

    /// The boundary itself stays on the Double side: 2^53 and above cannot be
    /// held by `Int` exactly on every path the kernel takes, and the doc says the
    /// exact-integer boundary is MAX_SAFE_INTEGER — so 2^53 itself is the first
    /// value that is no longer promised bare.
    func testIntegralAtOrAboveTwoPowerFiftyThreeIsNotRewrittenAsAnInt() throws {
        for raw in ["{\"n\":9007199254740992}", "{\"n\":9007199254740993}"] {
            let decoded = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
            let reencoded = try EvidencePack.encoder.encode(decoded)
            let text = String(decoding: reencoded, as: UTF8.self)
            XCTAssertFalse(
                text.contains("9007199254740993"),
                "an unrepresentable integer must not be printed as if it were exact: \(text)"
            )
            // Whatever it prints, it must still parse back to the same value.
            let reparsed = try JSONDecoder().decode(JSONValue.self, from: reencoded)
            XCTAssertEqual(reparsed, decoded)
        }
    }
}
