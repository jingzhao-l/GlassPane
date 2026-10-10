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
        // P6 §Z2 fixes the bounds (深度 ≤8、节点 ≤4000) and the export site is
        // supposed to carry exactly them. Pinned as documented values first: a
        // bound that nobody pins can be widened out of the wire contract while
        // every test below keeps passing against the new number.
        XCTAssertEqual(ProbeRuntime.mirrorMaxDepth, 8, "P6 §Z2: Mirror 深度 ≤8")
        XCTAssertEqual(ProbeRuntime.mirrorMaxNodes, 4000, "P6 §Z2: Mirror 节点 ≤4000")

        // A *linked* chain (each node names its successor), three links longer
        // than the depth limit, driven through the production export path so the
        // bounds the export site passes are the ones under test. Held strongly:
        // the probe registers roots weakly, and a fixture the app has already
        // released is a fixture that exports nothing.
        let chain = mirrorChain(levels: ProbeRuntime.mirrorMaxDepth + 3)
        let wide = mirrorTree(depth: 7)
        GP.registerMirrorRoot(label: "chain", object: chain)
        // A tree with room to spare past the node budget (see `mirrorTree`):
        // 43689 measurable children against a budget of 4000. The walk runs out
        // of budget inside the graph it is allowed to reach, so this root proves
        // the *node* bound, and its seventh level is leaves — the depth limit is
        // never the reason anything stopped here.
        GP.registerMirrorRoot(label: "wide", object: wide)

        let out = withExtendedLifetime([chain, wide]) { GP.runtime.exportMirrorState() }
        let isMarker = { (key: String) in
            key.hasSuffix(".\(MirrorWalk.depthMarkerKey)") || key.hasSuffix(".\(MirrorWalk.budgetMarkerKey)")
        }
        let markers = out.keys.filter(isMarker)
        let measured = Set(out.keys.filter { !isMarker($0) })

        // Depth: the walk stops with the limit still un-reached — the chain's
        // tail is never measured, so a daemon must not read its absence as
        // "the object ends here".
        XCTAssertEqual(measured.filter { $0.hasPrefix("chain.") }.count,
                       2 * ProbeRuntime.mirrorMaxDepth,
                       "a chain deeper than the limit must contribute exactly maxDepth levels of two-key nodes")
        XCTAssertFalse(measured.contains { $0.hasPrefix("chain.") && $0.hasSuffix(".tail") },
                       "the chain's tail sits past the depth limit; measuring it means the bound moved")
        let deepestChainLevel = measured.filter { $0.hasPrefix("chain.") }
            .map { $0.split(separator: ".").count }.max() ?? 0
        XCTAssertEqual(deepestChainLevel, ProbeRuntime.mirrorMaxDepth + 1,
                       "the deepest key is the root label plus maxDepth hops, never deeper")
        XCTAssertEqual(markers.filter { $0.hasPrefix("chain.") }, ["chain.\(MirrorWalk.depthMarkerKey)"],
                       "the depth cut has to be reported, or truncated state reads as complete state")
        XCTAssertFalse(markers.contains { $0.hasPrefix("chain.") && $0.contains(MirrorWalk.budgetMarkerKey) },
                       "16 keys is nowhere near the node budget")

        // Budget: the walk stops mid-graph and says where.
        XCTAssertEqual(measured.filter { $0.hasPrefix("wide.") }.count, ProbeRuntime.mirrorMaxNodes,
                       "the node budget is the walk's own ceiling: it must be exactly exhausted, not approximate")
        XCTAssertEqual(markers.filter { $0.hasPrefix("wide.") }, ["wide.\(MirrorWalk.budgetMarkerKey)"],
                       "a budget-exhausted export must name itself, or 'no more keys' reads as 'no more state'")
        XCTAssertFalse(markers.contains { $0.hasPrefix("wide.") && $0.contains(MirrorWalk.depthMarkerKey) },
                       "this fixture is shallower than maxDepth; only the budget may fire")

        // Keys stay inside their root's namespace (multi-root export shares one
        // table; a key escaping it would attribute one object's state to another).
        XCTAssertTrue(measured.allSatisfy { $0.hasPrefix("chain.") || $0.hasPrefix("wide.") },
                      "stray keys: \(measured.filter { !$0.hasPrefix("chain.") && !$0.hasPrefix("wide.") })")
        XCTAssertTrue(out.values.allSatisfy { $0.count <= ProbeRuntime.stateValueCharCap })
    }

    func testMirrorExportCapsContainerValuesTheWayItCapsLeaves() throws {
        // The finding: the leaf arm truncated at 1 KiB and the non-leaf arm did
        // not, so one host object with a megabyte `description` produced a state
        // frame bigger than the daemon's `FrameCodec.maxFrameBytes` — and the
        // daemon drops the *whole* state channel, not the one oversized key.
        let loud = MirrorLoudRoot()
        GP.registerMirrorRoot(label: "loud", object: loud)
        let out = withExtendedLifetime(loud) { GP.runtime.exportMirrorState() }

        XCTAssertEqual(out["loud.big"]?.count, ProbeRuntime.stateValueCharCap,
                       "the container arm is the one that used to be stored verbatim")
        XCTAssertEqual(out["loud.speech"]?.count, ProbeRuntime.stateValueCharCap,
                       "and the leaf arm stays capped with it")
        for (key, value) in out {
            XCTAssertFalse(value.count > ProbeRuntime.stateValueCharCap, "\(key) escaped the cap")
        }

        // Same 4.5 MB description on both arms: capped, the export fits in one
        // frame; uncapped (the bug), it is past the wire's limit.
        let payload = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
        XCTAssertLessThan(payload.count, ProbeRuntime.maxInboundLineBytes,
                          "an export that cannot fit a frame is an export the daemon throws away")
    }

    func testCaptureResultHookTravelsThroughTheRuntimeNotAGlobal() throws {
        // Z4.5's host hook is assigned by the app and read by the probe's
        // connection thread. What this can prove without a running app is that
        // the storage is the runtime's locked field: a value set on another
        // thread is what the capture path fires, and clearing it takes effect.
        // The race itself is only visible under TSan inside a host process.
        final class Seen {
            var results: [(path: String?, error: String?)] = []
        }
        let seen = Seen()
        let host = DispatchQueue(label: "glasspane.test.host-thread")
        host.sync { GP.onMetalCaptureResult = { path, error in seen.results.append((path, error)) } }
        XCTAssertNotNil(GP.onMetalCaptureResult, "the getter answers with what the host set")

        GP.runtime.handleCommand(["t": "capture_end"]) // no capture in progress
        XCTAssertEqual(seen.results.count, 1, "the hook fires once per capture frame")
        let frame = try XCTUnwrap(
            GP.runtime.debugOfflineSnapshot().last { ($0["t"] as? String) == "capture" },
            "the capture frame and the hook are the same event, seen from two sides"
        )
        XCTAssertEqual(seen.results.first?.error, frame["error"] as? String,
                       "the host must see exactly what the daemon is told")

        host.sync { GP.onMetalCaptureResult = nil }
        GP.runtime.handleCommand(["t": "capture_end"])
        XCTAssertEqual(seen.results.count, 1, "a hook the host cleared must not keep firing")

        // Storage proof: the hook belongs to the runtime that reads it, so a
        // runtime reset takes it with everything else the probe registered. A
        // loose `GP` global survived resets and kept firing into whichever
        // runtime came next.
        host.sync { GP.onMetalCaptureResult = { _, _ in seen.results.append((nil, nil)) } }
        GP.runtime.resetForTests()
        XCTAssertNil(GP.onMetalCaptureResult, "the hook is runtime state, not a process global")
    }

    func testSharedNestedKeyPathIsMarkedAmbiguousInsteadOfGuessed() throws {
        // KVO delivers a nested keyPath from the *tail* object, which belongs to
        // neither registration. Picking the first match — the old fallback —
        // labels one model's change with the other model's name.
        let first = ProbeKVCModel()
        let second = ProbeKVCModel()
        first.child = ProbeKVCChild()
        second.child = ProbeKVCChild()
        GP.registerKVCObject(first, label: "first", keys: ["child.title", "count"])
        GP.registerKVCObject(second, label: "second", keys: ["child.title", "count"])

        first.child?.title = "moved"
        let frames = stateFrames()
        XCTAssertEqual(frames.count, 1, "one change is one event; the tie is about attribution, not volume")
        let key = try XCTUnwrap(frames.first?["key"] as? String)
        XCTAssertTrue(key.hasSuffix(".child.title"), "the keyPath survives the tie: \(key)")
        XCTAssertEqual(key, "\(KVCObserver.ambiguousLabel).child.title",
                       "two registrations claim this tail object, so neither may be reported as the owner")
        XCTAssertFalse(key.hasPrefix("first."), "mis-attributed to the model that did not change: \(key)")
        XCTAssertFalse(key.hasPrefix("second."), "mis-attributed to the model that did not change: \(key)")
        XCTAssertEqual(frames.first?["after"] as? String, "moved", "the value is still the value")

        // The same tie broken by identity, not by guesswork: a plain keyPath
        // arrives from the object that changed, so it keeps its own label even
        // while another model observes the same key.
        second.count = 7
        let plain = try XCTUnwrap(stateFrames().last?["key"] as? String)
        XCTAssertEqual(plain, "second.count",
                       "the observed object is the owner here — the other model must not steal it")
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
        // X-3: refused KVC/state registrations ride the same frame, because a
        // daemon that never learns them reports "state never changed" for a
        // probe that was never told to watch anything.
        XCTAssertEqual(hello["rejectedKeys"] as? Int, 0, "a clean registration reports zero, and the daemon can tell that from silence")

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

    func testWriterDetectedDropoutHandsTheDescriptorToTheConnectionThreadThatClosesIt() throws {
        let path = scratchSocketPath("retire")
        var listener = makeListener(path: path)
        var client: Int32 = -1
        defer {
            if client >= 0 { close(client) }
            if listener >= 0 { close(listener) }
            unlink(path)
        }
        // Deliberately no `backoffOverrideMs`: the first connect attempt is
        // immediate anyway, and once the socket is unlinked below the probe
        // retries on the real 1s/2s/3s rhythm — so its transient `socket()`
        // allocations cannot keep stealing the descriptor number that the last
        // proof here looks for.
        GP.start(socketPath: path, appName: "unit-test")
        defer { GP.runtime.resetForTests() }

        client = acceptConnection(listener, within: 5)
        XCTAssertGreaterThanOrEqual(client, 0, "the probe must connect to a listening daemon")
        XCTAssertTrue(waitUntil(5) { GP.runtime.debugConnectionDescriptor >= 0 }, "the probe must adopt the accepted connection")

        let adopted = GP.runtime.debugConnectionDescriptor

        // The daemon end is never read from *and stays open*: the reader parks in
        // poll() on its descriptor while the writer is the one that discovers the
        // connection is dead. That split is what used to leave the socket with no
        // owner — the writer only cleared `fd`, the reader exited as "not the
        // owner", and teardown closed nothing.
        for index in 0..<(ProbeRuntime.queuedWriteLimit * 2) {
            GP.recordHandler(file: "retire", line: index)
        }
        XCTAssertTrue(
            waitUntil(5) { GP.runtime.debugConnectionDescriptor == -1 },
            "a write that cannot complete must retire the connection"
        )
        XCTAssertEqual(
            GP.runtime.debugDescriptorAwaitingClose, adopted,
            "the retiring side must hand the close to a named owner instead of dropping it"
        )
        XCTAssertGreaterThan(GP.droppedWriteCount, 0, "retirement stays a counted drop, not an error")

        // Now the daemon goes away for real: the reader wakes on POLLHUP and its
        // teardown is the owner of that descriptor. Unlink first, or the probe's
        // next connect would take the number back and the proof below would mean
        // nothing.
        close(client)
        client = -1
        close(listener)
        listener = -1
        unlink(path)
        XCTAssertTrue(
            waitUntil(5) { GP.runtime.debugDescriptorAwaitingClose == -1 && fcntl(adopted, F_GETFD) == -1 },
            "the connection thread must close the retired descriptor exactly once — one leaked unix socket per daemon restart ends in socket() failing and the probe going quiet"
        )
    }

    func testStalledPeerCyclesDoNotAccumulateDescriptorsInTheHostProcess() throws {
        guard let baseline = openDescriptorCount() else {
            throw XCTSkip(
                "/dev/fd is unreadable here, so accumulation cannot be *counted* on this machine — "
                    + "runStalledPeerCycle still asserts the ownership state (and that the descriptor "
                    + "ends closed) for every cycle, which is the portable half of the same proof."
            )
        }
        for cycle in 0..<4 {
            runStalledPeerCycle("cycle \(cycle)")
        }
        let after = try XCTUnwrap(openDescriptorCount(), "the descriptor table disappeared mid-test")
        XCTAssertLessThanOrEqual(
            after - baseline, 1,
            "4 stalled-peer cycles took \(after - baseline) descriptors with them: each daemon restart that the writer notices first used to leak one unix socket (plus its kernel buffers) into the app under test, until socket() fails and the probe silently stops reporting. Slack of 1 covers unrelated fd churn in the test process."
        )
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

    // MARK: Z3 registration cannot raise inside the host app

    func testRepeatedKeyPathInOneCallIsNormalisedInsteadOfRegisteringTwice() {
        let model = ProbeKVCModel()
        // The shape that used to kill the app under test: two key lists
        // concatenated into one call. Registering the same keyPath twice makes
        // Foundation throw an Objective-C exception — from a library call, on
        // the app's own thread.
        GP.registerKVCObject(model, label: "demo", keys: ["count", "count"])
        XCTAssertEqual(GP.rejectedKeyCount, 0, "a repeat inside one call is collapsed, not refused: the key is observed once")
        XCTAssertEqual(GP.kvcRejections, [])
        model.count = 5
        XCTAssertEqual(stateFrames().count, 1, "exactly one observation for 'count', so exactly one frame")
        XCTAssertEqual(stateFrames().first?["key"] as? String, "demo.count")

        // Re-registering with an overlapping set neither duplicates nor loses the
        // observation, and the malformed entries are what get reported.
        GP.registerKVCObject(model, label: "demo", keys: ["count", "  ", "hidden"])
        XCTAssertEqual(GP.rejectedKeyCount, 2)
        XCTAssertEqual(GP.kvcRejections.count, 2)
        XCTAssertTrue(
            GP.kvcRejections.contains { $0.contains("demo.∅") && $0.contains("empty keyPath") },
            "an empty/whitespace entry is refused visibly: \(GP.kvcRejections)"
        )
        XCTAssertTrue(
            GP.kvcRejections.contains { $0.contains("'hidden'") && $0.contains("is not an observable KVC key on") },
            "a typo names the key and says what to do about it: \(GP.kvcRejections)"
        )
        model.count = 9
        XCTAssertEqual(stateFrames().count, 2, "the accepted key survived the re-registration exactly once")
        XCTAssertEqual(GP.runtime.debugCapabilities, ["z1", "z3", "checkpoint"], "the refusals must not cost the real channel")
    }

    func testUnresolvableKeyPathsAreRefusedWithAReasonAndDetachUndoesTheBookkeeping() {
        let model = ProbeKVCModel()
        GP.registerKVCObject(model, label: "demo", keys: [
            "hidden",           // the plain typo
            "totallyAbsentKey", // nothing answers it, as an accessor or otherwise
            "child.title",      // valid shape, but `child` is nil right now: nothing to check the tail against
            "items.upper",      // steps through a to-many
            "@count"            // collection operator: element type unknown without evaluating the chain
        ])
        XCTAssertEqual(GP.rejectedKeyCount, 5, "not one of these may reach KVO")
        let expectations: [(key: String, needle: String)] = [
            ("hidden", "is not an observable KVC key on"),
            ("totallyAbsentKey", "is not an observable KVC key on"),
            ("child.title", "nil on this object"),
            ("items.upper", "steps through the to-many"),
            ("@count", "is a KVC collection operator")
        ]
        for expectation in expectations {
            let quoted = "'\(expectation.key)'"
            XCTAssertTrue(
                GP.kvcRejections.contains { $0.contains(quoted) && $0.contains(expectation.needle) },
                "no note explains \(quoted) (\(expectation.needle)): \(GP.kvcRejections)"
            )
        }
        XCTAssertEqual(GP.runtime.debugCapabilities, ["z1"], "an object with no observable key is not a z3 channel")
        XCTAssertTrue(GP.detachKVCObject(model), "a refused registration is still a registration, so detach must undo it")
        XCTAssertEqual(GP.kvcRejections, [], "detach drops the refusal notes it inherited from that object")
        XCTAssertEqual(GP.rejectedKeyCount, 5, "the lifetime count does not forget what was refused")
    }

    func testSwiftOnlyStorageIsRefusedInsteadOfBecomingADeadChannel() {
        let model = ProbeKVCLimitModel()
        GP.registerKVCObject(model, label: "limits", keys: ["swiftOnly", "observable"])
        XCTAssertEqual(
            GP.rejectedKeyCount, 1,
            "KVC can read a Swift-only stored property through its ivar, but KVO cannot instrument it: taking it would have promised a state channel that can never fire"
        )
        XCTAssertTrue(
            GP.kvcRejections.contains { $0.contains("'swiftOnly'") && $0.contains("is not an observable KVC key on") },
            "\(GP.kvcRejections)"
        )
        model.observable = 1
        let frames = stateFrames()
        XCTAssertEqual(frames.count, 1, "the key that is observable still is")
        XCTAssertEqual(frames.first?["key"] as? String, "limits.observable")
    }

    func testNestedKeyPathIsObservedOnceItsObjectGraphIsPopulated() {
        let model = ProbeKVCModel()
        model.child = ProbeKVCChild()
        GP.registerKVCObject(model, label: "demo", keys: ["child.title"])
        XCTAssertEqual(GP.rejectedKeyCount, 0, "the same keyPath validates once the intermediate exists")
        XCTAssertEqual(GP.runtime.debugCapabilities, ["z1", "z3", "checkpoint"])
        model.child?.title = "b"
        let frames = stateFrames()
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(
            frames.first?["key"] as? String, "demo.child.title",
            "a nested notification arrives from the tail object; the label still has to come from the registered model"
        )
        XCTAssertEqual(frames.first?["before"] as? String, "a")
        XCTAssertEqual(frames.first?["after"] as? String, "b")
        XCTAssertEqual(frames.first?["source"] as? String, "z3-kvc")
        XCTAssertTrue(GP.detachKVCObject(model))
        model.child?.title = "c"
        XCTAssertEqual(stateFrames().count, 1, "detach removed the nested observation too")
    }

    // MARK: Fixtures

    private func stateFrames() -> [[String: Any]] {
        GP.runtime.debugOfflineSnapshot().filter { $0["t"] as? String == "state" }
    }

    /// Descriptors open in this process, read off the fd table the kernel exposes
    /// at `/dev/fd`. nil means "not measurable here", which the counting test
    /// reports as a skip instead of pretending the property held.
    private func openDescriptorCount() -> Int? {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: "/dev/fd") else { return nil }
        let numbered = entries.filter { Int($0) != nil }
        return numbered.isEmpty ? nil : numbered.count
    }

    /// One stalled-peer cycle on the socketpair seam: adopt a socket whose peer is
    /// already gone, turn writes into counted drops until the writer retires the
    /// connection, then let the reset act as the closer (this seam has no
    /// connection thread, so the reset owns the descriptor here). Asserts the
    /// whole retirement contract, including that the number is free again at the
    /// end — which is what keeps the per-cycle descriptor count flat.
    @discardableResult
    private func runStalledPeerCycle(_ context: String) -> Int32 {
        var pair = [Int32](repeating: -1, count: 2)
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0, context)
        XCTAssertTrue(GP.runtime.attachSocketForTests(pair[1]), context)
        XCTAssertEqual(
            GP.runtime.debugDescriptorAwaitingClose, -1,
            "\(context): a previous cycle must not have left a descriptor owed to someone"
        )
        close(pair[0]) // the peer that vanished: every write from here on is a failure
        for index in 0..<(ProbeRuntime.queuedWriteLimit * 2) {
            GP.recordHandler(file: "stalled-cycle", line: index)
        }
        XCTAssertTrue(
            waitUntil(5) { !GP.isConnected },
            "\(context): a write that cannot complete must retire the connection"
        )
        XCTAssertEqual(
            GP.runtime.debugDescriptorAwaitingClose, pair[1],
            "\(context): retirement hands the descriptor to its closer instead of forgetting it"
        )
        GP.runtime.resetForTests()
        XCTAssertEqual(GP.runtime.debugDescriptorAwaitingClose, -1, "\(context): the closer took ownership")
        XCTAssertTrue(
            waitUntil(5) { fcntl(pair[1], F_GETFD) == -1 },
            "\(context): the cycle's socket is still open in the host process — a leaked descriptor"
        )
        return pair[1]
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

/// Z3 fixtures: the shapes `registerKVCObject` has to tell apart — a plain
/// observable key, a nil-able one-to-one child, and a to-many.
private final class ProbeKVCChild: NSObject {
    @objc dynamic var title = "a"
}

private final class ProbeKVCModel: NSObject {
    @objc dynamic var count = 0
    @objc dynamic var child: ProbeKVCChild?
    @objc dynamic var items = ["row-1", "row-2"]
}

/// The documented limit of Z3 (P6 §4: "仅 NSObject/KVC-compatible 键；
/// Swift-only 存储不可用"): a Swift-only stored property has no accessor for
/// the ObjC runtime to instrument, so the probe must refuse it out loud instead
/// of registering a channel that can never fire.
private final class ProbeKVCLimitModel: NSObject {
    var swiftOnly = 0
    @objc dynamic var observable = 0
}

// MARK: Z2 Mirror fixtures
//
// Shapes the walk has to earn its bounds on: a *linked* chain (the old fixture
// had no child property at all, so there was no depth to truncate), a tree with
// more children than the node budget, and an object whose `description` alone is
// bigger than one wire frame. Stored `AnyObject` children rather than optionals:
// an optional hop is a different graph shape from the one the limits guard.

private final class MirrorChainEnd: NSObject {
    var tail = 0
}

private final class MirrorChainNode: NSObject {
    var index = 0
    var child: AnyObject

    init(_ child: AnyObject) { self.child = child }
}

private func mirrorChain(levels: Int) -> AnyObject {
    var node: AnyObject = MirrorChainEnd()
    for _ in 0..<levels { node = MirrorChainNode(node) }
    return node
}

private final class MirrorBranchNode: NSObject {
    var index = 0
    var left: AnyObject
    var center: AnyObject
    var right: AnyObject
    var far: AnyObject

    init(_ left: AnyObject, _ center: AnyObject, _ right: AnyObject, _ far: AnyObject) {
        self.left = left
        self.center = center
        self.right = right
        self.far = far
    }
}

/// `depth` levels of four-way branching: five measurable children per branch and
/// a leaf tip at the bottom, so the graph offers 5*(1+4+…+4^6) + 4^7 = 43689 keys
/// — ten times the documented budget of 4000, and all of them inside the depth
/// the walk is allowed to reach. Only the node budget can stop this walk, and the
/// tip level (seventh) has nothing left to recurse into, so the depth limit stays
/// clean of it: exactly one marker, `∅truncated-budget`, is expected.
private func mirrorTree(depth: Int) -> AnyObject {
    guard depth > 0 else { return MirrorChainEnd() }
    let child = mirrorTree(depth: depth - 1)
    return MirrorBranchNode(child, child, child, child)
}

private final class MirrorLoudValue: NSObject {
    override var description: String { String(repeating: "x", count: 4_500_000) }
}

private final class MirrorLoudRoot: NSObject {
    var big = MirrorLoudValue() // the non-leaf arm
    var speech = String(repeating: "y", count: 4_500_000) // the leaf arm
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
