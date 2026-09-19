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
}
