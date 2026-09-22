import XCTest
import CryptoKit
@testable import GlassPaneProbe

// P6 spec v6.0 §4 probe runtime tests: canonical mirror of the daemon-side
// §2 digest, bounded Mirror export, checkpoint export/restore roundtrip,
// Z1 instrument passthrough and offline buffering honesty.

final class ProbeRuntimeTests: XCTestCase {

    override func setUp() {
        super.setUp()
        GP.runtime.resetForTests()
    }

    // Cross-language vector pinned in engine Tests/GlassPaneEngineTests
    // (P6ProbeWireTests) — both sides must canonicalize identically.
    func testCheckpointCanonicalMatchesDaemonVector() {
        let domains = ["b": ["y": "2", "x": "1\"\n"], "a": ["k": "v"]]
        XCTAssertEqual(
            ProbeCanonical.checkpointJSON(domains),
            #"{"a":{"k":"v"},"b":{"x":"1\"\n","y":"2"}}"#
        )
        XCTAssertEqual(
            ProbeCanonical.sha256Hex(ProbeCanonical.checkpointJSON(["counter": ["value": "3"]])),
            SHA256.hash(data: Data(#"{"counter":{"value":"3"}}"#.utf8))
                .map { String(format: "%02x", $0) }.joined()
        )
    }

    func testInstrumentEvaluatesOnceAndPassesValueThrough() {
        var evaluations = 0
        let result = GP.instrument(file: "ProbeRuntimeTests.swift", line: 1) {
            evaluations += 1
            return "value"
        }
        XCTAssertEqual(result, "value")
        XCTAssertEqual(evaluations, 1)
        let frames = GP.runtime.debugOfflineSnapshot()
        XCTAssertEqual(frames.filter { ($0["t"] as? String) == "handler" }.count, 1)
        XCTAssertEqual(frames.first?["file"] as? String, "ProbeRuntimeTests.swift")
    }

    func testOfflineBufferingDropsBeyondCapAndCounts() {
        for index in 0..<(ProbeRuntime.offlineBufferLimit + 10) {
            GP.recordHandler(file: "f\(index)", line: index)
        }
        XCTAssertEqual(GP.droppedEventCount, 10)
        XCTAssertEqual(GP.runtime.debugOfflineSnapshot().count, ProbeRuntime.offlineBufferLimit)
    }

    func testCheckpointExportAndRestoreRoundtrip() throws {
        final class Box: NSObject {
            @objc dynamic var value = 1
        }
        let box = Box()
        GP.registerCheckpoint(
            domain: "box",
            get: { ["value": String(box.value)] },
            set: { values in box.value = Int(values["value"] ?? "1") ?? 1 }
        )
        GP.runtime.handleCommand(["t": "checkpoint_export", "ref": "snap_A"])
        let export = try XCTUnwrap(GP.runtime.debugOfflineSnapshot().last { ($0["t"] as? String) == "checkpoint" })
        XCTAssertEqual(export["ref"] as? String, "snap_A")
        XCTAssertEqual((export["domains"] as? [String: [String: String]])?["box"]?["value"], "1")
        let digest = try XCTUnwrap(export["digest"] as? String)
        XCTAssertEqual(digest, ProbeCanonical.sha256Hex(ProbeCanonical.checkpointJSON(["box": ["value": "1"]])))

        box.value = 99 // drift away from the checkpoint
        GP.runtime.handleCommand(["t": "checkpoint_restore", "ref": "snap_A", "domains": ["box"]])
        XCTAssertEqual(box.value, 1, "restore must rewrite through the registered setter")
        let result = try XCTUnwrap(GP.runtime.debugOfflineSnapshot().last { ($0["t"] as? String) == "result" })
        XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual(result["postStateDigest"] as? String, digest)
    }

    func testRestoreWithoutSetterIsRefusedNotFaked() throws {
        GP.registerCheckpoint(domain: "readonly", get: { ["k": "v"] }, set: nil)
        GP.runtime.handleCommand(["t": "checkpoint_export", "ref": "snap_R"])
        GP.runtime.handleCommand(["t": "checkpoint_restore", "ref": "snap_R", "domains": ["readonly"]])
        let result = try XCTUnwrap(GP.runtime.debugOfflineSnapshot().last { ($0["t"] as? String) == "result" })
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertTrue((result["error"] as? String)?.contains("without setter") ?? false)
    }

    func testEvictedRefIsRefused() throws {
        GP.registerCheckpoint(domain: "d", get: { ["x": "1"] }, set: { _ in })
        for index in 0...ProbeRuntime.checkpointRetention {
            GP.runtime.handleCommand(["t": "checkpoint_export", "ref": "snap_\(index)"])
        }
        GP.runtime.handleCommand(["t": "checkpoint_restore", "ref": "snap_0", "domains": ["d"]])
        let result = try XCTUnwrap(GP.runtime.debugOfflineSnapshot().last { ($0["t"] as? String) == "result" })
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertTrue((result["error"] as? String)?.contains("evicted") ?? false)
    }

    func testKVCEventsEmitWithLabelAndOldNewValues() throws {
        final class Model: NSObject {
            @objc dynamic var count = 0
        }
        let model = Model()
        GP.registerKVCObject(model, label: "demo", keys: ["count"])
        model.count = 5
        // The offline buffer must contain the z3-kvc event for demo.count.
        let state = GP.runtime.debugOfflineSnapshot().compactMap { frame -> [String: Any]? in
            frame["t"] as? String == "state" ? frame : nil
        }
        XCTAssertFalse(state.isEmpty, "KVO change must emit a state event")
        let event = state.first!
        XCTAssertEqual(event["key"] as? String, "demo.count")
        XCTAssertEqual(event["before"] as? String, "0")
        XCTAssertEqual(event["after"] as? String, "5")
        XCTAssertEqual(event["source"] as? String, "z3-kvc")
    }

    func testOpEndMirrorDiffEmitsChangedKeys() throws {
        final class Root: NSObject {
            @objc dynamic var label = "a"
        }
        let root = Root()
        GP.registerMirrorRoot(label: "root", object: root)
        GP.runtime.handleCommand(["t": "op_begin"])
        root.label = "b"
        let before = GP.runtime.debugOfflineSnapshot().count
        GP.runtime.handleCommand(["t": "op_end"])
        let frames = GP.runtime.debugOfflineSnapshot()
        let state = frames.suffix(from: min(before, frames.count)).first { ($0["t"] as? String) == "state" }
        let event = try XCTUnwrap(state, "op_end diff must emit the changed mirror key")
        XCTAssertEqual(event["key"] as? String, "root.label")
        XCTAssertEqual(event["source"] as? String, "z2-mirror")
    }

    func testMirrorWalkBoundedDepthAndBudget() {
        struct Nest { var depth: Int; var child: AnyObject? }
        final class Deep: NSObject { var value = 0 }
        var root = Deep()
        var current = root
        for _ in 0..<20 {
            let child = Deep()
            current.value = 1 // keeps each level non-empty
            current = child
        }
        var out: [String: String] = [:]
        MirrorWalk.flatten(root, label: "n", maxDepth: 8, maxNodes: 4000, into: &out)
        XCTAssertFalse(out.isEmpty)
        XCTAssertTrue(out.keys.allSatisfy { $0.hasPrefix("n.") })
    }

    // MARK: Host-safety and delivery (connect options, backpressure, reconnect)

    func testAdoptedSocketDisablesSigpipeAndIsBoundedByPollNotBlockingWaits() throws {
        var pair = [Int32](repeating: -1, count: 2)
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
        defer { close(pair[0]) }
        XCTAssertTrue(GP.runtime.attachSocketForTests(pair[1]), "an unprotected descriptor must be refused")
        defer { GP.runtime.resetForTests() } // also closes pair[1]

        var noSigpipe = Int32(0)
        var length = socklen_t(MemoryLayout<Int32>.size)
        XCTAssertEqual(getsockopt(pair[1], SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, &length), 0)
        XCTAssertEqual(noSigpipe, 1, "a probe write must never raise SIGPIPE in the app under test")
        XCTAssertNotEqual(fcntl(pair[1], F_GETFL) & O_NONBLOCK, 0, "writes are bounded by POLLOUT, not by a hang")
    }

    func testStalledPeerTurnsWritesIntoCountedDropsWithoutBlockingTheCaller() throws {
        var pair = [Int32](repeating: -1, count: 2)
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
        defer { close(pair[0]) } // never read from: the peer that stopped draining
        XCTAssertTrue(GP.runtime.attachSocketForTests(pair[1]))
        defer { GP.runtime.resetForTests() }

        let startedAt = Date()
        for index in 0..<(ProbeRuntime.queuedWriteLimit * 2) {
            GP.recordHandler(file: "stalled", line: index)
        }
        XCTAssertLessThan(
            Date().timeIntervalSince(startedAt), 1.0,
            "emitting on the host thread must not block behind a stalled daemon"
        )
        XCTAssertTrue(
            waitUntil(5) { !GP.isConnected },
            "a write that cannot complete must retire the connection so it can be re-established"
        )
        XCTAssertGreaterThan(GP.droppedWriteCount, 0, "unwritten frames must be counted, never thrown")
        GP.recordHandler(file: "after-dropout", line: 0)
        XCTAssertGreaterThan(GP.bufferedEventCount, 0, "later frames re-enter the offline buffer, visibly")

        let reader = FrameReader(pair[0])
        var delivered: [String] = []
        while let line = reader.nextLine(0.5) { delivered.append(line) }
        XCTAssertFalse(delivered.isEmpty, "the peer must have received the frames it had room for")
        for line in delivered {
            XCTAssertNotNil(
                try? JSONSerialization.jsonObject(with: Data(line.utf8)),
                "the stream must stay newline-framed even around a drop: \(line)"
            )
        }
    }

    func testReconnectReannouncesCapabilitiesAndDrainsTheOfflineBuffer() throws {
        let path = scratchSocketPath("reconnect")
        let listener = makeListener(path: path)
        defer { close(listener); unlink(path) }
        GP.runtime.backoffOverrideMs = 50
        GP.start(socketPath: path, appName: "unit-test")
        defer { GP.runtime.resetForTests() }

        let client = acceptConnection(listener, within: 5)
        XCTAssertGreaterThanOrEqual(client, 0, "the probe must connect to a listening daemon")
        let reader = FrameReader(client)
        let hello = try XCTUnwrap(reader.nextJSON())
        XCTAssertEqual(hello["t"] as? String, "hello")
        XCTAssertEqual(hello["capabilities"] as? [String], ["z1"])
        XCTAssertNotNil(hello["droppedEvents"], "the registration must carry its loss counters")
        XCTAssertNotNil(hello["droppedWrites"])

        // A capability registered after the connection was accepted.
        final class Model: NSObject { @objc dynamic var count = 0 }
        let model = Model()
        GP.registerKVCObject(model, label: "demo", keys: ["count"])
        let reannounced = try XCTUnwrap(reader.nextJSON())
        XCTAssertEqual(reannounced["t"] as? String, "hello", "late registration must be announced, not assumed")
        XCTAssertEqual(Set((reannounced["capabilities"] as? [String]) ?? []), ["z1", "z3", "checkpoint"])
        XCTAssertTrue(GP.detachKVCObject(model))
        let afterDetach = try XCTUnwrap(reader.nextJSON())
        XCTAssertEqual(afterDetach["capabilities"] as? [String], ["z1"], "detaching must re-announce the smaller set")

        // Daemon restart, and it stays down long enough to buffer evidence.
        unlink(path)
        close(client)
        XCTAssertTrue(waitUntil(5) { !GP.isConnected }, "the probe must notice the dropped connection")
        GP.recordHandler(file: "buffered", line: 1)
        GP.recordHandler(file: "buffered", line: 2)
        XCTAssertEqual(GP.bufferedEventCount, 2, "offline frames wait in the buffer, visibly")

        let revivedListener = makeListener(path: path)
        defer { close(revivedListener) }
        let revived = acceptConnection(revivedListener, within: 5)
        XCTAssertGreaterThanOrEqual(revived, 0, "the probe must re-arm and reconnect on its own")
        let revivedReader = FrameReader(revived)
        defer { close(revived) }
        XCTAssertEqual(try XCTUnwrap(revivedReader.nextJSON())["t"] as? String, "hello")
        for line in 1...2 {
            let frame = try XCTUnwrap(revivedReader.nextJSON(), "buffered frame \(line) must drain after reconnect")
            XCTAssertEqual(frame["t"] as? String, "handler")
            XCTAssertEqual(frame["line"] as? Int, line)
        }
        XCTAssertTrue(waitUntil(5) { GP.bufferedEventCount == 0 }, "the drain must empty the offline buffer")
        XCTAssertTrue(waitUntil(5) { GP.runtime.debugIsReaderRunning })
    }

    func testExhaustedConnectCycleReArmsInsteadOfQuitting() throws {
        let path = scratchSocketPath("rearm")
        GP.runtime.backoffOverrideMs = 50
        GP.start(socketPath: path, appName: "unit-test") // nothing listening yet
        defer { GP.runtime.resetForTests() }
        XCTAssertTrue(
            waitUntil(5) { GP.runtime.debugFailedCycleCount >= 1 },
            "a failed retry cycle must be counted and retried, not latched off"
        )
        // Schedule proof (P6 §2.1): 1s, 2s, 3s per attempt, cycle gap beyond it.
        XCTAssertEqual(ProbeRuntime.attemptBackoffMs(afterFailedAttempt: 0), 1000)
        XCTAssertEqual(ProbeRuntime.attemptBackoffMs(afterFailedAttempt: 2), 3000)
        XCTAssertGreaterThan(ProbeRuntime.reconnectCycleIntervalMs, ProbeRuntime.reconnectIntervalMs)

        let listener = makeListener(path: path)
        defer { close(listener); unlink(path) }
        let client = acceptConnection(listener, within: 5)
        XCTAssertGreaterThanOrEqual(client, 0, "a daemon that arrives late must still be served")
        defer { close(client) }
        XCTAssertEqual(try XCTUnwrap(FrameReader(client).nextJSON())["t"] as? String, "hello")
    }

    func testRegistrationDoesNotKeepRegisteredObjectsAlive() throws {
        final class Model: NSObject { @objc dynamic var count = 0 }
        var model: Model? = Model()
        weak var reference = model
        var root: Model? = Model()
        weak var rootReference = root
        GP.registerKVCObject(model!, label: "demo", keys: ["count"])
        GP.registerMirrorRoot(label: "root", object: root!)
        model = nil
        root = nil
        XCTAssertNil(reference, "the probe must not keep an app's model alive (Z3)")
        XCTAssertNil(rootReference, "the probe must not keep a mirror root alive (Z2)")
        XCTAssertEqual(GP.runtime.debugKVCRegisteredCount, 0, "released targets get pruned, not observed forever")
        XCTAssertTrue(GP.runtime.exportMirrorState().isEmpty, "dead state must not be exported as a diff source")
    }

    func testDetachKVCAndCheckpointAPIsAreIdempotentAndSilenceFrames() throws {
        final class Model: NSObject { @objc dynamic var count = 0 }
        let model = Model()
        GP.registerKVCObject(model, label: "demo", keys: ["count"])
        model.count = 4
        XCTAssertEqual(GP.runtime.debugOfflineSnapshot().count, 1)
        XCTAssertTrue(GP.detachKVCObject(model), "detach must report a real removal")
        model.count = 7
        XCTAssertEqual(GP.runtime.debugOfflineSnapshot().count, 1, "a detached object must emit nothing")
        XCTAssertFalse(GP.detachKVCObject(model), "detaching twice is not a second removal")
        XCTAssertEqual(GP.runtime.debugCapabilities, ["z1"], "z3/checkpoint must disappear with the object")

        GP.registerCheckpoint(domain: "box", get: { ["k": "v"] }, set: { _ in })
        XCTAssertTrue(GP.detachCheckpoint(domain: "box"))
        XCTAssertFalse(GP.detachCheckpoint(domain: "box"))
        XCTAssertTrue(GP.runtime.exportCheckpointDomains().isEmpty)
    }

    // MARK: Socket fixtures

    private func scratchSocketPath(_ name: String) -> String {
        NSTemporaryDirectory() + "gp-probe-\(name)-\(ProcessInfo.processInfo.processIdentifier).sock"
    }

    private func waitUntil(_ seconds: Double, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return condition()
    }

    /// Binds an NDJSON listener — the daemon side, as minimally as possible.
    private func makeListener(path: String) -> Int32 {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return -1 }
        unlink(path)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        path.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { slot in
                _ = strncpy(slot.baseAddress!.assumingMemoryBound(to: CChar.self), source, slot.count)
            }
        }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { name in
                Darwin.bind(descriptor, name, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(descriptor, 4) == 0 else {
            close(descriptor)
            return -1
        }
        return descriptor
    }

    private func acceptConnection(_ listenFD: Int32, within seconds: Double) -> Int32 {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            var slot = pollfd(fd: listenFD, events: Int16(POLLIN), revents: 0)
            if poll(&slot, 1, 100) > 0 { return accept(listenFD, nil, nil) }
        }
        return -1
    }
}

/// Reads the probe's NDJSON off a socket, keeping a torn tail buffered exactly
/// like the daemon's FrameCodec does.
private final class FrameReader {
    private let fd: Int32
    private var pending = Data()

    init(_ fd: Int32) { self.fd = fd }

    func nextLine(_ seconds: Double = 5) -> String? {
        let deadline = Date().addingTimeInterval(seconds)
        while true {
            if let newline = pending.firstIndex(of: UInt8(ascii: "\n")) {
                let line = Data(pending[pending.startIndex..<newline])
                pending.removeSubrange(pending.startIndex...newline)
                return String(decoding: line, as: UTF8.self)
            }
            guard Date() < deadline else { return nil }
            var slot = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&slot, 1, 100) > 0 else { continue }
            var buffer = [UInt8](repeating: 0, count: 4096)
            let received = read(fd, &buffer, buffer.count)
            guard received > 0 else { return nil }
            pending.append(contentsOf: buffer[0..<received])
        }
    }

    func nextJSON(_ seconds: Double = 5) throws -> [String: Any] {
        let line = try XCTUnwrap(nextLine(seconds), "no frame arrived before the deadline")
        let object = try JSONSerialization.jsonObject(with: Data(line.utf8))
        return try XCTUnwrap(object as? [String: Any], "frame is not a JSON object: \(line)")
    }
}
