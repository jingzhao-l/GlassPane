import XCTest
@testable import GlassPaneEngine

/// 2026-10-19, the day the probe gained a truncation counter.
///
/// `engine/probe` publishes `truncatedValues` in its `hello` and `SECURITY.md` promises a
/// reader can tell "the daemon received a prefix" apart from "a frame never arrived" —
/// two different facts about two different losses. A counter nobody reads is that promise
/// with nothing behind it, which is the same failure this file's predecessor (`X-3`) was
/// written for. So every case here drives the whole chain a real frame travels: wire bytes
/// → `ProbeWire.decode` → `ProbeInbox.register` → the row `statusJSON()` hands
/// `gp_probe_status`. A test that only checked the decoder would still pass with the
/// publisher deleted.
final class Qoder20261019ProbeCounterReaderTests: XCTestCase {

    private static let fixedDate = Date(timeIntervalSince1970: 1_800_000_000)

    private func hello(from json: String) throws -> ProbeHello {
        guard case let .hello(decoded) = ProbeWire.decode(Data(json.utf8)) else {
            throw NSError(
                domain: "fixture", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "the frame must decode as a hello: \(json)"]
            )
        }
        return decoded
    }

    private func inboxRegistered(_ json: String) throws -> ProbeInbox {
        let inbox = ProbeInbox(now: { Self.fixedDate })
        XCTAssertTrue(inbox.register(try hello(from: json)), "the daemon refused a well-formed registration")
        return inbox
    }

    private func helloFrame(_ fields: String) -> String {
        """
        {"t":"hello","pid":4242,"appName":"Example","probeVersion":"gp-probe/0.1.0",\
        "capabilities":["z1"]\(fields.isEmpty ? "" : ",\(fields)")}
        """
    }

    /// The claim, end to end: a probe that says it shortened three values must be
    /// readable saying exactly that.
    func testTruncatedValuesSurviveTheWireIntoTheStatusRow() throws {
        let rows = try inboxRegistered(helloFrame("\"truncatedValues\":3")).statusJSON()
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row["truncatedValues"] as? Int, 3,
            "探针报过\"三个值被截短\"，这一行里却没有这个数——读者只能把\"没提\"读成\"没截\"")
    }

    /// `nil` is unreported and `0` is a measurement: a probe predating this key must not
    /// be dressed as a clean bill of health, and one that reported zero must not be
    /// dressed as unknown.
    func testAbsentTruncatedValuesIsNeverRenderedAsZero() throws {
        let silent = try XCTUnwrap(inboxRegistered(helloFrame("")).statusJSON().first)
        XCTAssertNil(silent["truncatedValues"],
            "这个探针从没上报过截短；写 0 就是替它作\"一个都没截\"的保证")

        let measured = try XCTUnwrap(inboxRegistered(helloFrame("\"truncatedValues\":0")).statusJSON().first)
        XCTAssertEqual(measured["truncatedValues"] as? Int, 0,
            "上报过 0 的探针要能读出 0，否则这行把两次不同的事实压成同一个")
    }

    /// The count is a *number of values*: a frame carrying something outside the wire's
    /// own range reports nothing, and the row must not reprint a coerced value.
    func testTruncatedValuesOutsideInt32IsNoCountAtAll() throws {
        for value in ["4294967296", "-1", "\"many\"", "9007199254740993"] {
            let decoded = try hello(from: helloFrame("\"truncatedValues\":\(value)"))
            XCTAssertNil(decoded.truncatedValues, "\(value) must not become a reported count")
            let row = try XCTUnwrap(inboxRegistered(helloFrame("\"truncatedValues\":\(value)")).statusJSON().first)
            XCTAssertNil(row["truncatedValues"], "\(value) must not reach gp_probe_status as a count")
        }
    }

    /// A re-`hello` that stays silent about this counter must not erase the measurement
    /// the same process already made — the rule every other counter follows.
    func testRehelloWithoutTheKeyKeepsTheEarlierTruncationCount() throws {
        let inbox = ProbeInbox(now: { Self.fixedDate })
        XCTAssertTrue(inbox.register(try hello(from: helloFrame("\"truncatedValues\":5"))))
        XCTAssertTrue(inbox.register(try hello(from: helloFrame("\"droppedWrites\":1"))))
        let rows = inbox.statusJSON()
        XCTAssertEqual(rows.count, 1, "a re-hello is the same process, not a second registration")
        XCTAssertEqual(try XCTUnwrap(rows.first)["truncatedValues"] as? Int, 5,
            "新帧没提这一项，就该沿用上报过的那一个，而不是把它抹成未上报")
    }

    /// Truncation and frame loss are two facts; the row must keep them apart rather than
    /// letting a reader add them up into one "the channel was leaky" impression.
    func testFrameLossAndValueTruncationStayTwoNumbers() throws {
        let row = try XCTUnwrap(
            inboxRegistered(helloFrame("\"droppedWrites\":4,\"truncatedValues\":900")).statusJSON().first
        )
        XCTAssertEqual(row["droppedWrites"] as? Int, 4)
        XCTAssertEqual(row["truncatedValues"] as? Int, 900,
            "900 个值被截短、4 帧没送达，是两件不同的事；任何一侧被折进另一侧都读不回来了")
    }
}
