import XCTest
import Foundation
@testable import GlassPaneEngine

/// P5 批一：审批/权限签名链（spec v5.0 §3，验收 P5-A1..A6）。
final class ApprovalGateTests: XCTestCase {

    // MARK: - Fixtures

    private static let isoEpoch = Date(timeIntervalSince1970: 0)

    private func makeGate(
        path: String? = nil,
        date: Date = ApprovalGateTests.isoEpoch
    ) -> ApprovalGate {
        ApprovalGate(path: path, clock: { date })
    }

    /// Appends `count` deterministic records (operationRef = "op-\(n)").
    private func appendChain(_ gate: ApprovalGate, count: Int) -> [ApprovalRecord] {
        var appended: [ApprovalRecord] = []
        for index in 0..<count {
            guard let record = gate.append(
                operationRef: "snap-\(index)",
                operationType: "restore",
                riskTier: .high,
                decision: .approve,
                approvedBy: "daemon:auto",
                reason: "fixture \(index)"
            ) else {
                XCTFail("append \(index) failed")
                break
            }
            appended.append(record)
        }
        return appended
    }

    // MARK: - P5-A1 genesis & chained hashing

    func testGenesisPrevHashIsEmpty() {
        let gate = makeGate()
        XCTAssertTrue(gate.chain().isEmpty)
        XCTAssertEqual(gate.tailHash(), "")
        XCTAssertTrue(gate.verifyChain().valid)
        XCTAssertEqual(gate.verifyChain().firstBrokenIndex, nil)
    }

    func testAppendCompletesIdAndHashFormat() {
        let gate = makeGate()
        guard let record = gate.append(
            operationRef: "snap-a",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "daemon:auto",
            reason: "genesis"
        ) else {
            return XCTFail("append failed")
        }
        XCTAssertTrue(
            record.approvalId.range(
                of: "^appr_[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression
            ) != nil,
            "approvalId format: \(record.approvalId)"
        )
        XCTAssertTrue(record.hash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil)
        XCTAssertEqual(record.prevHash, "")
        XCTAssertEqual(gate.count, 1)
        XCTAssertEqual(gate.tailHash(), record.hash)
    }

    func testRecordsChainLinkage() {
        let gate = makeGate()
        let records = appendChain(gate, count: 4)
        XCTAssertEqual(records.count, 4)
        for index in 1..<records.count {
            XCTAssertEqual(records[index].prevHash, records[index - 1].hash)
        }
        // Full-length digest — never truncated to 16 hex by policy.
        XCTAssertEqual(records.last?.prevHash, records[records.count - 2].hash)
    }

    // MARK: - P5-A2 chain integrity

    func testVerifyValidChain() {
        let gate = makeGate()
        _ = appendChain(gate, count: 3)
        let verdict = gate.verifyChain()
        XCTAssertTrue(verdict.valid)
        XCTAssertNil(verdict.firstBrokenIndex)
    }

    func testTamperedDecisionBreaksChainAtBadIndex() {
        let gate = makeGate()
        let records = appendChain(gate, count: 3)
        // Rewrite the middle record with a changed decision but keep hashes.
        let middle = records[1]
        let tampered = ApprovalRecord(
            approvalId: middle.approvalId,
            operationRef: middle.operationRef,
            operationType: middle.operationType,
            riskTier: middle.riskTier,
            decision: .deny, // tampered
            approvedBy: middle.approvedBy,
            reason: middle.reason,
            timestamp: middle.timestamp,
            prevHash: middle.prevHash,
            hash: middle.hash
        )
        var chain = records
        chain[1] = tampered
        let verdict = ApprovalGate.verify(records: chain)
        XCTAssertFalse(verdict.valid)
        XCTAssertEqual(verdict.firstBrokenIndex, 1)
    }

    func testTamperedReasonAndApproverBreakChain() {
        let gate = makeGate()
        let records = appendChain(gate, count: 3)
        for (field, tamperedRecord) in [
            ("reason", ApprovalRecord(
                approvalId: records[1].approvalId, operationRef: records[1].operationRef,
                operationType: records[1].operationType, riskTier: records[1].riskTier,
                decision: records[1].decision, approvedBy: records[1].approvedBy,
                reason: "rewritten history", timestamp: records[1].timestamp,
                prevHash: records[1].prevHash, hash: records[1].hash
            )),
            ("approvedBy", ApprovalRecord(
                approvalId: records[1].approvalId, operationRef: records[1].operationRef,
                operationType: records[1].operationType, riskTier: records[1].riskTier,
                decision: records[1].decision, approvedBy: "intruder",
                reason: records[1].reason, timestamp: records[1].timestamp,
                prevHash: records[1].prevHash, hash: records[1].hash
            )),
        ] {
            var chain = records
            chain[1] = tamperedRecord
            let verdict = ApprovalGate.verify(records: chain)
            XCTAssertFalse(verdict.valid, "\(field) tamper must be detected")
            XCTAssertEqual(verdict.firstBrokenIndex, 1)
        }
    }

    func testTamperedPrevHashBreaksChain() {
        let gate = makeGate()
        let records = appendChain(gate, count: 3)
        let middle = records[1]
        let tampered = ApprovalRecord(
            approvalId: middle.approvalId,
            operationRef: middle.operationRef,
            operationType: middle.operationType,
            riskTier: middle.riskTier,
            decision: middle.decision,
            approvedBy: middle.approvedBy,
            reason: middle.reason,
            timestamp: middle.timestamp,
            prevHash: String(repeating: "a", count: 64), // tampered linkage
            hash: middle.hash
        )
        var chain = records
        chain[1] = tampered
        let verdict = ApprovalGate.verify(records: chain)
        XCTAssertFalse(verdict.valid)
        XCTAssertEqual(verdict.firstBrokenIndex, 1)
    }

    /// Tail-truncation + splice: an attacker cuts the history and appends a
    /// fresh record whose prevHash still references the deleted entry. The
    /// spliced linkage can never match the surviving chain — detected at the
    /// splice point. (A pure tail cut with no follow-up append is undetectable
    /// by replay alone — a fundamental hash-chain property without an external
    /// anchor; the realistic attack path is truncation-then-append, which this
    /// test covers.)
    func testTruncationThenSpliceBreaksChain() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("approval-truncation-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fileURL = dir.appendingPathComponent("approvals.json")

        let gate = makeGate(path: fileURL.path)
        let records = appendChain(gate, count: 3)

        // 1) Attacker rewrites the file to the truncated [A, B].
        var surviving = records
        let removedTail = surviving.removeLast()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(surviving).write(to: fileURL)

        // 2) A stale writer appends a record whose prevHash points at the
        //    deleted entry — the classic truncation-then-append attack.
        let spliced = ApprovalRecord(
            approvalId: OperationID.generateApprovalLive(),
            operationRef: "snap-spliced",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "daemon:auto",
            reason: "post-truncation",
            timestamp: ApprovalGate.isoString(date: Date(timeIntervalSince1970: 1)),
            prevHash: removedTail.hash,
            hash: ""
        )
        guard let realHash = ApprovalGate.hash(of: spliced) else { return XCTFail("hash failed") }
        let finalizedSpliced = ApprovalRecord(
            approvalId: spliced.approvalId, operationRef: spliced.operationRef,
            operationType: spliced.operationType, riskTier: spliced.riskTier,
            decision: spliced.decision, approvedBy: spliced.approvedBy,
            reason: spliced.reason, timestamp: spliced.timestamp,
            prevHash: spliced.prevHash, hash: realHash
        )
        var attackerFile = surviving
        attackerFile.append(finalizedSpliced)
        try encoder.encode(attackerFile).write(to: fileURL)

        // 3) A fresh gate loads the tampered file; replay must break at 2.
        let reloaded = makeGate(path: fileURL.path)
        XCTAssertEqual(reloaded.chain().count, 3)
        let verdict = reloaded.verifyChain()
        XCTAssertFalse(verdict.valid)
        XCTAssertEqual(verdict.firstBrokenIndex, 2)
    }

    // MARK: - P5-A3 persistence

    func testPersistenceRoundtrip() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("approval-roundtrip-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fileURL = dir.appendingPathComponent("approvals.json")

        let gate = makeGate(path: fileURL.path)
        _ = appendChain(gate, count: 3)

        let reloaded = makeGate(path: fileURL.path)
        XCTAssertEqual(reloaded.count, 3)
        XCTAssertEqual(reloaded.chain(), gate.chain())
        XCTAssertTrue(reloaded.verifyChain().valid)
    }

    func testCorruptFileLoadsEmptyLedger() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("approval-corrupt-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fileURL = dir.appendingPathComponent("approvals.json")
        try Data("{not valid json".utf8).write(to: fileURL)

        let gate = makeGate(path: fileURL.path)
        XCTAssertTrue(gate.chain().isEmpty, "corrupt ledger must load empty, never silently valid")
        XCTAssertTrue(gate.loadFailed, "load failure must be flagged for honest CLI surfacing")
        XCTAssertTrue(gate.verifyChain().valid)
    }

    func testAtomicWriteLeavesNoTmpResidue() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("approval-tmp-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fileURL = dir.appendingPathComponent("approvals.json")

        let gate = makeGate(path: fileURL.path)
        _ = appendChain(gate, count: 2)
        let leftover = dir.appendingPathComponent("approvals.json.tmp")
        XCTAssertFalse(FileManager.default.fileExists(atPath: leftover.path))
    }

    func testInMemoryGateHasNoDiskSideEffect() {
        let gate = makeGate()
        _ = appendChain(gate, count: 2)
        XCTAssertEqual(gate.count, 2)
        XCTAssertTrue(gate.verifyChain().valid)
    }

    func testOversizeReasonRejectedAndChainUnchanged() {
        let gate = makeGate()
        let longReason = String(repeating: "x", count: ApprovalGate.reasonMaxLength + 1)
        let rejected = gate.append(
            operationRef: "snap-x",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "daemon:auto",
            reason: longReason
        )
        XCTAssertNil(rejected)
        XCTAssertEqual(gate.count, 0)
    }
}

/// P5-A4: EngineCore registration with/without an injected approval gate.
final class ApprovalGateEngineIntegrationTests: XCTestCase {

    private func makeCore(
        channel: ScriptedChannel,
        gate: ApprovalGate?
    ) throws -> EngineCore {
        let core = EngineCore(channel: channel, evidenceStore: nil, approvalGate: gate)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return core
    }

    func testRestoreRegistersHighRiskApproval() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let gate = ApprovalGate()
        let core = try makeCore(channel: channel, gate: gate)

        let snap = try core.snapshot(maxDepth: 6)
        guard let snapshotId = snap["snapshotId"] as? String else {
            return XCTFail("no snapshotId")
        }
        _ = try core.restore(snapshotId: snapshotId, steps: nil, mode: nil)

        XCTAssertEqual(gate.count, 1)
        guard let record = gate.chain().first else { return XCTFail("no record") }
        XCTAssertEqual(record.operationRef, snapshotId)
        XCTAssertEqual(record.operationType, "restore")
        XCTAssertEqual(record.riskTier, .high)
        XCTAssertEqual(record.decision, .approve)
        XCTAssertEqual(record.approvedBy, "daemon:auto")
        XCTAssertTrue(record.reason.hasPrefix("restore executed:"))
        XCTAssertTrue(gate.verifyChain().valid)
    }

    func testFfwdRestoreRegistersWithFfwdLabel() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let gate = ApprovalGate()
        let core = try makeCore(channel: channel, gate: gate)

        let snap = try core.snapshot(maxDepth: 6)
        guard let snapshotId = snap["snapshotId"] as? String else {
            return XCTFail("no snapshotId")
        }
        let step: (Selector, Action) = (
            Selector(role: "AXButton", title: "Submit"), .press
        )
        _ = try core.restore(snapshotId: snapshotId, steps: [step], mode: nil)

        XCTAssertEqual(gate.count, 1)
        XCTAssertTrue(gate.chain().first?.reason.contains("ffwd") == true)
    }

    func testUnsupportedModeDoesNotRegister() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let gate = ApprovalGate()
        let core = try makeCore(channel: channel, gate: gate)

        let snap = try core.snapshot(maxDepth: 6)
        guard let snapshotId = snap["snapshotId"] as? String else {
            return XCTFail("no snapshotId")
        }
        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: "restore_snapshot"))
        XCTAssertEqual(gate.count, 0, "a rejected restore must not be registered as executed")
    }

    func testNilGateKeepsRestoreBehaviorUnchanged() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = try makeCore(channel: channel, gate: nil)

        let snap = try core.snapshot(maxDepth: 6)
        guard let snapshotId = snap["snapshotId"] as? String else {
            return XCTFail("no snapshotId")
        }
        let result = try core.restore(snapshotId: snapshotId, steps: nil, mode: nil)
        XCTAssertEqual(result["consistent"] as? Bool, true)
        XCTAssertEqual(result["confirmed"] as? Int, 0)
    }
}