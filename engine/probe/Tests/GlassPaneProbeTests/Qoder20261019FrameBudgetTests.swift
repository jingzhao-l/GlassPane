import XCTest
@testable import GlassPaneProbe

// Qoder 2026-10-19 — the frame budget, charged in bytes.
//
// Z2/Z3 bounded state in CHARACTERS and NODE COUNTS; the daemon charges in
// BYTES. `engine/Sources/GlassPaneEngine/FrameCodec.swift:7` caps one frame at
// 4 MiB and *discards* an oversized line, so one fat frame is not a degraded
// reading — it is the whole state channel for that pid, gone without a word.
// These tests pin the two bounds in the unit that actually matters (encoded
// UTF-8 bytes) and pin the third thing that makes the channel survivable: a
// frame that cannot fit is dropped on purpose and counted, so the daemon reads
// "N frames dropped by the probe" instead of silence.

final class Qoder20261019FrameBudgetTests: XCTestCase {

    /// Pinned from the daemon rather than read off the probe: this is
    /// `FrameCodec.maxFrameBytes`. A probe constant would let the probe redefine
    /// its own budget and keep every test here green.
    private let frameBudgetBytes = 4 * 1024 * 1024
    /// Pinned from P6 §2.2 ("≤1 KiB 截断") in the unit the wire charges for:
    /// encoded UTF-8 bytes, not characters.
    private let valueCapBytes = 1024

    override func setUp() {
        super.setUp()
        GP.runtime.resetForTests()
    }

    // MARK: The value cap is a byte cap

    func testOneValueIsCappedInEncodedBytesNotCharacters() throws {
        // 漢 is three UTF-8 bytes, so a 1024-*character* cut is a 3 KiB value:
        // three times the documented cap, charged by the daemon on every frame
        // that carries it.
        let loud = String(repeating: "漢", count: 4000)
        XCTAssertEqual(loud.count, 4000)
        XCTAssertEqual(loud.utf8.count, 12_000)

        GP.recordState(key: "demo.cjk", before: "quiet", after: loud)
        let frame = try XCTUnwrap(
            GP.runtime.debugOfflineSnapshot().last { ($0["t"] as? String) == "state" },
            "the state lane must still emit"
        )
        let kept = try XCTUnwrap(frame["after"] as? String)
        XCTAssertLessThanOrEqual(
            kept.utf8.count, valueCapBytes,
            "the cap is 1 KiB of encoded bytes; this value left the probe at \(kept.utf8.count)"
        )
        XCTAssertEqual(
            kept.utf8.count, 1023,
            "341 whole 3-byte characters is the largest cut that stays inside 1 KiB"
        )
        XCTAssertEqual(kept.count, 341, "and it is 341 *characters*, not a slice padded to a byte count")
        XCTAssertEqual(String(kept.unicodeScalars).unicodeScalars.count, 341)
        XCTAssertEqual(kept, String(loud.prefix(341)), "the kept prefix is the head of the host value")
        XCTAssertEqual(frame["before"] as? String, "quiet", "a value inside the cap is reported untouched")
    }

    func testByteTruncationNeverSplitsAComposedCharacter() throws {
        // The cut is a byte cut, so its real risk is landing in the middle of a
        // cluster: "e"+U+0301 COMBINING ACUTE is one character over two scalars
        // and three bytes, and an orphan combining mark is mojibake on the panel.
        let cluster = "e\u{0301}" // base letter + COMBINING ACUTE: one character, two scalars
        XCTAssertEqual(cluster.count, 1)
        XCTAssertEqual(cluster.unicodeScalars.count, 2)
        XCTAssertEqual(cluster.utf8.count, 3)
        let marks = String(repeating: cluster, count: 4000)

        GP.recordState(key: "demo.marks", before: "x", after: marks)
        let kept = try XCTUnwrap(
            (GP.runtime.debugOfflineSnapshot().last { ($0["t"] as? String) == "state" })?["after"] as? String
        )
        XCTAssertLessThanOrEqual(kept.utf8.count, valueCapBytes, "\(kept.utf8.count) bytes escaped the cap")
        XCTAssertNotNil(kept.unicodeScalars.last, "the value was not emptied by the cut")
        // A whole cluster legitimately *ends* on its combining mark; what must
        // never leave the process is a mark that lost its base — so the tail is
        // checked as a cluster, not as a scalar.
        let tail = try XCTUnwrap(kept.last, "the kept prefix has no character at all")
        XCTAssertEqual(
            tail.unicodeScalars.count, 2,
            "the last character on the wire is base+mark, not half a cluster: \(tail.unicodeScalars.map { String($0.value) })"
        )
        XCTAssertTrue(
            kept.unicodeScalars.allSatisfy { $0.value == 0x0065 || $0.value == 0x0301 }
                && Array(kept.unicodeScalars).enumerated().allSatisfy { index, scalar in
                    scalar.value == (index.isMultiple(of: 2) ? 0x0065 : 0x0301)
                },
            "every mark kept here still has its base in front of it: \(kept.debugDescription)"
        )
        XCTAssertEqual(kept.utf8.count, 1023, "341 complete clusters is the whole budget it can keep")

        // A bigger cluster (flag sequence = two regional-indicator scalars, 8
        // bytes) must come out paired too, and the surviving bytes must decode
        // back to exactly the same string — i.e. the frame carries valid UTF-8.
        let flag = "\u{1F1E8}\u{1F1F3}" // regional indicator C + N, one glyph
        XCTAssertEqual(flag.count, 1)
        XCTAssertEqual(flag.utf8.count, 8)
        GP.recordState(key: "demo.flag", before: "x", after: String(repeating: flag, count: 4000))
        let keptFlag = try XCTUnwrap(
            (GP.runtime.debugOfflineSnapshot().last { ($0["t"] as? String) == "state" })?["after"] as? String
        )
        XCTAssertLessThanOrEqual(keptFlag.utf8.count, valueCapBytes)
        XCTAssertEqual(keptFlag.utf8.count, 1024, "128 complete flag clusters spend the budget exactly")
        XCTAssertEqual(
            keptFlag.unicodeScalars.filter { $0.value == 0x1F1E8 }.count,
            keptFlag.unicodeScalars.filter { $0.value == 0x1F1F3 }.count,
            "no half a flag sequence may leave the process"
        )
        XCTAssertEqual(Data(keptFlag.utf8).count, keptFlag.utf8.count, "the prefix is whole scalars end to end")

        // And the case the byte cut has to refuse rather than perform: a 5-byte
        // cluster, where 1024 bytes is 204 clusters + 4 bytes, i.e. the budget
        // boundary falls *inside* a character. A slice at the byte would still be
        // legal UTF-8 — and would change which character the panel shows.
        let stacking = "e\u{0301}\u{0327}" // base + acute + ring below: one character, 5 bytes
        XCTAssertEqual(stacking.count, 1)
        XCTAssertEqual(stacking.utf8.count, 5)
        GP.recordState(key: "demo.stacking", before: "x", after: String(repeating: stacking, count: 4000))
        let keptStacking = try XCTUnwrap(
            (GP.runtime.debugOfflineSnapshot().last { ($0["t"] as? String) == "state" })?["after"] as? String
        )
        XCTAssertEqual(
            keptStacking.utf8.count, 1020,
            "the cut gives back the last whole cluster instead of spending 4 bytes on a fragment"
        )
        XCTAssertEqual(keptStacking.count, 204)
        XCTAssertTrue(
            keptStacking.unicodeScalars.allSatisfy { $0.value == 0x0065 || $0.value == 0x0301 || $0.value == 0x0327 }
                && Array(keptStacking.unicodeScalars).enumerated().allSatisfy { index, scalar in
                    scalar.value == [0x0065, 0x0301, 0x0327][index % 3]
                },
            "every kept cluster is base+acute+ring, in order"
        )
    }

    // MARK: The frame itself is bounded

    func testWorstCaseStateFrameIsWhatTheCapCommentsClaim() throws {
        // The bound in `stateValueByteCap`'s comment is a byte claim, so it is
        // measured here rather than trusted: two capped values at the worst JSON
        // escaping the encoder can do (one raw control byte becomes `\u0001`, six
        // bytes on the wire), plus the frame's own key, source, ts and newline.
        let control = String(String.UnicodeScalarView(repeating: UnicodeScalar(1)!, count: 1024))
        XCTAssertEqual(control.utf8.count, valueCapBytes, "exactly at the cap, so nothing is cut here")
        GP.recordState(key: "demo.control", before: control, after: control)
        let frame = try XCTUnwrap(
            GP.runtime.debugOfflineSnapshot().last { ($0["t"] as? String) == "state" }
        )
        let line = try XCTUnwrap(ProbeRuntime.frameLine(frame))
        XCTAssertLessThanOrEqual(
            line.count, 13 * 1024,
            "the documented worst case for one state frame is under 13 KiB; measured \(line.count)"
        )
        XCTAssertGreaterThanOrEqual(line.count, 2 * 6 * valueCapBytes, "and the escaping really was at its worst")
        XCTAssertGreaterThan(
            frameBudgetBytes / line.count, 300,
            "one state frame leaves the probe ~300× inside the budget the daemon charges"
        )
        XCTAssertEqual(GP.truncatedValueCount, 0, "a value exactly at the cap is not a truncation")
    }

    func testBudgetConstantsAreTheDocumentedNumbers() {
        // Pinned the way the existing suite pins 深度 ≤8 / 节点 ≤4000: a constant
        // nobody pins can be widened out of the wire contract while every
        // behaviour test keeps passing against the new number.
        XCTAssertEqual(ProbeRuntime.stateValueByteCap, valueCapBytes, "P6 §2.2: 值 ≤1 KiB，按编码字节算")
        XCTAssertEqual(
            ProbeRuntime.maxOutboundFrameBytes, frameBudgetBytes,
            "must equal the daemon's FrameCodec.maxFrameBytes, or the probe measures against a budget nobody agreed to"
        )
        XCTAssertEqual(
            ProbeRuntime.maxInboundLineBytes, ProbeRuntime.maxOutboundFrameBytes,
            "both directions ride the same framing, so both carry the same cap"
        )
        XCTAssertEqual(
            ProbeRuntime.mirrorMaxNodes * ProbeRuntime.stateValueByteCap, 4_096_000,
            "the node budget alone is ~3.9 MiB of value payload: one batched export does NOT fit one frame, which is why writeFrame measures the line it is about to send"
        )
    }

    func testCJKMirrorExportCapsEveryValueInTheEncodedBytes() throws {
        // The Z2 side of the same budget: the walk exports each node's value with
        // the cap the `state` frame applies, and CJK is where a character cap
        // stops being a byte cap.
        let root = mirrorCJKTree(depth: 6)
        GP.registerMirrorRoot(label: "cjk", object: root)
        let out = withExtendedLifetime(root) { GP.runtime.exportMirrorState() }

        let cjkKeys = out.keys.filter { $0.hasSuffix(".cjk") }
        XCTAssertGreaterThanOrEqual(cjkKeys.count, 60, "the fixture must really carry CJK payload: \(cjkKeys.count) keys")
        for (key, value) in out {
            XCTAssertLessThanOrEqual(
                value.utf8.count, valueCapBytes,
                "\(key) escaped the byte cap at \(value.utf8.count) bytes (\(value.count) characters)"
            )
        }
        let kept = try XCTUnwrap(out["cjk.cjk"])
        XCTAssertEqual(kept.utf8.count, 1023, "the container and leaf arms both cut at 1 KiB of bytes")
    }

    func testFourThousandValueCJKRootNeverHandsTheSocketAnOversizeFrame() throws {
        // The review's worst case: 4000 nodes (P6 §Z2) × 1024 CJK characters is
        // ~16 MB of UTF-8. One state frame per key stays small once each value is
        // capped, but the batched `checkpoint` frame carries the whole table in a
        // single line — and a single line over 4 MiB is what the daemon throws away.
        var table: [String: String] = [:]
        for index in 0..<ProbeRuntime.mirrorMaxNodes {
            table["k\(index)"] = String(repeating: "漢", count: 1024)
        }
        let values = table
        var published = false
        GP.registerCheckpoint(domain: "big", get: { published ? values : [:] }, set: nil)

        GP.runtime.handleCommand(["t": "op_begin"]) // baseline: nothing published yet
        published = true
        let writesBefore = GP.droppedWriteCount
        GP.runtime.handleCommand(["t": "op_end"]) // 4000 changed keys

        let frames = GP.runtime.debugOfflineSnapshot().filter { ($0["t"] as? String) == "state" }
        XCTAssertEqual(
            frames.count, ProbeRuntime.offlineBufferLimit,
            "this burst is bounded by the offline buffer cap, not by the frame budget"
        )
        for frame in frames {
            let line = try XCTUnwrap(ProbeRuntime.frameLine(frame), "a state frame must serialize")
            XCTAssertLessThanOrEqual(
                line.count, frameBudgetBytes,
                "a frame the daemon discards costs the whole channel: \((frame["key"] as? String) ?? "?") is \(line.count) bytes"
            )
            XCTAssertLessThanOrEqual(
                ((frame["after"] as? String) ?? "").utf8.count, valueCapBytes,
                "the value cap is what keeps each of these inside a frame"
            )
        }
        XCTAssertEqual(
            GP.droppedEventCount, ProbeRuntime.mirrorMaxNodes - ProbeRuntime.offlineBufferLimit,
            "the frames the buffer could not hold are counted as buffer losses"
        )
        XCTAssertEqual(
            GP.droppedWriteCount, writesBefore,
            "and none of them were dropped *by the budget guard* — capped values fit on their own"
        )

        // Now the frame that genuinely cannot fit: measured before it is written,
        // refused on purpose, and counted, instead of handed over for the daemon
        // to discard in silence.
        let batch = try XCTUnwrap(
            ProbeRuntime.frameLine(["t": "checkpoint", "ref": "r1", "domains": ["big": values], "digest": "0"])
        )
        XCTAssertGreaterThan(batch.count, frameBudgetBytes, "the fixture must cross the budget, or this proves nothing")
        GP.runtime.handleCommand(["t": "checkpoint_export", "ref": "r1"])
        XCTAssertEqual(
            GP.droppedWriteCount, writesBefore + 1,
            "an oversized frame must land in the counter the daemon already reads, not in silence"
        )
        XCTAssertFalse(
            GP.runtime.debugOfflineSnapshot().contains { ($0["t"] as? String) == "checkpoint" },
            "and it must never enter the buffer or the socket"
        )
    }

    // MARK: The daemon must be able to tell the two losses apart

    func testReportedCountersSeparateTruncatedValuesFromDroppedFrames() throws {
        var pair = [Int32](repeating: -1, count: 2)
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
        defer { close(pair[0]) }
        XCTAssertTrue(GP.runtime.attachSocketForTests(pair[1]))
        defer { GP.runtime.resetForTests() }
        let reader = BudgetFrameReader(pair[0])

        // `hello` is the only frame that carries the probe's counters, and it is
        // re-sent when the registration changes — so a second registration is how
        // a test gets the counters reported *after* they moved.
        GP.registerCheckpoint(domain: "big", get: {
            var table: [String: String] = [:]
            for index in 0..<ProbeRuntime.mirrorMaxNodes {
                table["k\(index)"] = String(repeating: "漢", count: 1024)
            }
            return table
        }, set: nil)
        let opening = try XCTUnwrap(reader.nextJSON(5), "the first hello never arrived")
        XCTAssertEqual(opening["t"] as? String, "hello")
        XCTAssertEqual(opening["droppedWrites"] as? Int, 0)
        XCTAssertEqual(
            opening["truncatedValues"] as? Int, 0,
            "a clean probe reports zero truncations, which the daemon must be able to tell from silence: \(opening)"
        )

        // One frame carrying two oversized values = two truncated VALUES, and the
        // frame itself is still delivered.
        let loud = String(repeating: "漢", count: 4000)
        GP.recordState(key: "demo.cjk", before: loud, after: loud)
        // One frame that cannot fit at all = one DROPPED FRAME.
        GP.runtime.handleCommand(["t": "checkpoint_export", "ref": "budget-test"])

        final class Model: NSObject { @objc dynamic var count = 0 }
        let model = Model()
        GP.registerKVCObject(model, label: "demo", keys: ["count"]) // caps change → hello re-announces
        var hello: [String: Any]?
        var seen: [[String: Any]] = []
        while hello == nil, let frame = reader.nextJSON(5) {
            if (frame["t"] as? String) == "hello" { hello = frame } else { seen.append(frame) }
        }
        let report = try XCTUnwrap(hello, "the re-announcement never arrived: \(seen)")

        XCTAssertEqual(
            report["droppedWrites"] as? Int, 1,
            "exactly one frame was dropped because it exceeded the budget: \(report)"
        )
        XCTAssertEqual(
            report["truncatedValues"] as? Int, 2,
            "two values were cut at the byte cap — a different fact from losing a frame: \(report)"
        )
        XCTAssertNotEqual(
            report["truncatedValues"] as? Int, report["droppedWrites"] as? Int,
            "the panel has to read 'a value was shortened' and 'a frame was dropped' as two numbers: \(report)"
        )
        XCTAssertEqual(report["droppedEvents"] as? Int, 0, "the delivered state frame was not a buffer loss")
        XCTAssertEqual(
            GP.droppedWriteCount, 1,
            "the same number the socket reports is the one the host reads"
        )
        XCTAssertEqual(
            GP.truncatedValueCount, 2,
            "and the truncation count the socket carried is the host-visible one, not a hello-only figure"
        )
        XCTAssertTrue(
            seen.contains { ($0["t"] as? String) == "state" },
            "the truncated value's frame was still written: \(seen)"
        )
        for frame in seen {
            if let after = frame["after"] as? String {
                XCTAssertLessThanOrEqual(after.utf8.count, valueCapBytes, "on the wire too: \(after.utf8.count) bytes")
            }
        }
    }

    // MARK: Fixtures

    /// One root, 1 KiB of CJK per node: the shape that made the character cap a
    /// multiple of the byte cap.
    private func mirrorCJKTree(depth: Int) -> AnyObject {
        guard depth > 0 else { return MirrorCJKLeaf() }
        let child = mirrorCJKTree(depth: depth - 1)
        return MirrorCJKBranch(child, child)
    }
}

private let probeCJKValue = String(repeating: "漢", count: 1024) // 1024 characters, 3072 bytes

private final class MirrorCJKLeaf: NSObject {
    var cjk = probeCJKValue
}

private final class MirrorCJKBranch: NSObject {
    var cjk = probeCJKValue
    var left: AnyObject
    var right: AnyObject

    init(_ left: AnyObject, _ right: AnyObject) {
        self.left = left
        self.right = right
    }
}

/// Reads the probe's NDJSON off a socket, frame by frame, the way the daemon's
/// `FrameCodec` does.
private final class BudgetFrameReader {
    private let fd: Int32
    private var pending = Data()

    init(_ fd: Int32) { self.fd = fd }

    func nextLine(_ seconds: Double) -> String? {
        let deadline = Date().addingTimeInterval(seconds)
        while true {
            if let newline = pending.firstIndex(of: UInt8(ascii: "\n")) {
                let line = Data(pending[pending.startIndex..<newline])
                pending.removeSubrange(pending.startIndex...newline)
                return String(decoding: line, as: UTF8.self)
            }
            guard Date() < deadline else { return nil }
            var slot = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&slot, 1, 50) > 0 else { continue }
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            let received = read(fd, &buffer, buffer.count)
            guard received > 0 else { return nil }
            pending.append(contentsOf: buffer[0..<received])
        }
    }

    func nextJSON(_ seconds: Double) -> [String: Any]? {
        guard let line = nextLine(seconds) else { return nil }
        let object = try? JSONSerialization.jsonObject(with: Data(line.utf8))
        return object as? [String: Any]
    }
}
