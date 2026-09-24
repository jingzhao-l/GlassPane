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

    /// Every ledger file this file creates lives inside `TestSandbox`, so the
    /// isolation verdict is computed before a path can be written to. The older
    /// shape composed `FileManager.default.temporaryDirectory` by hand here, which
    /// is a route around the gate that exists because one `swift test` run took
    /// the unbypassed version of it into the developer's real `~/.glasspane`.
    private func makeTempDir(_ label: String) throws -> URL {
        URL(fileURLWithPath: TestSandbox.directory(label))
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
        let dir = try makeTempDir("approval-truncation")
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

    /// R6-07, stated as what it is: P5 §3.7 and the P5-A2 acceptance row claimed
    /// "截断链尾 → invalid" as delivered, and no hash chain can deliver that — a
    /// truncated chain re-verifies from genesis, so the claim was false as written.
    /// The fix is the honest one: the surface publishes the two values that make
    /// a shrinkage observable across runs (`count`, `tailHash`), and this test
    /// pins both halves — replay genuinely cannot see the cut, and the published
    /// pair genuinely can. An anchor file next to the ledger would have "fixed"
    /// neither: whoever can rewrite `approvals.json` can delete the anchor too,
    /// which is exactly the same-account threat model `SECURITY.md` declares.
    func testPureTailCutIsUndetectableByReplayAndDetectableByComparison() throws {
        let dir = try makeTempDir("approval-tailcut")
        defer { try? FileManager.default.removeItem(at: dir) }
        let fileURL = dir.appendingPathComponent("approvals.json")

        let gate = makeGate(path: fileURL.path)
        let records = appendChain(gate, count: 4)
        let beforeCount = gate.count
        let beforeTail = gate.tailHash()
        XCTAssertEqual(beforeCount, 4)
        XCTAssertEqual(beforeTail, records.last?.hash)

        // Cut the tail and rewrite the file — no appended record, so nothing is
        // spliced and every remaining link still matches its predecessor.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(Array(records.dropLast(2))).write(to: fileURL)

        let reloaded = makeGate(path: fileURL.path)
        XCTAssertTrue(
            reloaded.verifyChain().valid,
            "premise of this test: replay alone must NOT flag a pure tail cut, or the spec claim would not have been wrong"
        )
        XCTAssertNotEqual(reloaded.count, beforeCount, "the published count moves")
        XCTAssertNotEqual(reloaded.tailHash(), beforeTail, "…and so does the published tail")
        // The pair is what an agent compares; `count` alone would let a cut-and-
        // regrow attack through with the same length but a different end.
        XCTAssertEqual(reloaded.count, 2)
    }

    // MARK: - P5-A3 persistence

    func testPersistenceRoundtrip() throws {
        let dir = try makeTempDir("approval-roundtrip")
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
        let dir = try makeTempDir("approval-corrupt")
        defer { try? FileManager.default.removeItem(at: dir) }
        let fileURL = dir.appendingPathComponent("approvals.json")
        try Data("{not valid json".utf8).write(to: fileURL)

        let gate = makeGate(path: fileURL.path)
        XCTAssertTrue(gate.chain().isEmpty, "corrupt ledger must load empty, never silently valid")
        XCTAssertTrue(gate.loadFailed, "load failure must be flagged for honest CLI surfacing")
        XCTAssertTrue(gate.verifyChain().valid)
    }

    func testAtomicWriteLeavesNoTmpResidue() throws {
        let dir = try makeTempDir("approval-tmp")
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

    // MARK: - P8: a persist that did not reach disk is an audit fact

    /// The divergence this pins: `verifyChain()` verifies the **in-memory**
    /// `records`, and `--approval-verify` reads the file from a different
    /// process — so neither one ever lied about it, and neither one could tell
    /// the process that was appending either. The append was reported to its
    /// caller as recorded, the chain kept verifying, and the record simply was
    /// not in the audit trail. `persistFailed` is the answer to "is what I hold
    /// on disk", and a success has to take the answer back.
    ///
    /// Reachable without any exotic volume, and that is not a coincidence:
    /// `ApprovalGate(stateRoot:)` documents that persist() creates no directory,
    /// so a ledger whose parent does not exist yet cannot be written — measured
    /// on this checkout, the temp write throws (`NSCocoaErrorDomain Code=4`) and
    /// the atomic fallback throws too (`mktemp` fails, same code 4), which is the
    /// shape of the failure the field now keeps.
    func testPersistFailureIsRecordedWithItsTargetAndClearedBySuccess() throws {
        let path = TestSandbox.directory("ledger-nowrite") + "/absent/approvals.json"
        TestSandbox.assertIsolated(path, label: "ledger-nowrite")
        let gate = ApprovalGate(path: path, clock: { ApprovalGateTests.isoEpoch })
        XCTAssertNil(gate.persistFailed, "no attempt yet — nil must not read as 'already durable'")

        XCTAssertNotNil(gate.append(
            operationRef: "snap-1",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "daemon:auto",
            reason: "first record never reached disk"
        ))
        XCTAssertEqual(gate.count, 1)
        XCTAssertTrue(gate.verifyChain().valid, "the in-memory chain is intact — which is exactly why this needed a field")
        let failure = try XCTUnwrap(
            gate.persistFailed,
            "a record that did not reach disk has to be askable about, not only logged"
        )
        XCTAssertTrue(failure.contains(path), "the reason has to name the target: \(failure)")
        XCTAssertTrue(
            failure.contains("NOT in the audit trail"),
            "and say that the consequence is a missing record, not a slow disk: \(failure)"
        )
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: path),
            "premise of the test: nothing was written to \(path)"
        )

        // The environment is fixed; the next durable append clears the record, so
        // a reader can never be told "the last write failed" about a ledger that
        // has since been written.
        try FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        XCTAssertNotNil(gate.append(
            operationRef: "snap-2",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "daemon:auto",
            reason: "now it is on disk"
        ))
        XCTAssertNil(gate.persistFailed, "a success must clear the last failure")
        XCTAssertFalse(gate.loadFailed)
        let reloaded = ApprovalGate(path: path, clock: { ApprovalGateTests.isoEpoch })
        XCTAssertEqual(
            reloaded.count, 2,
            "the field and the file now agree: both records are on disk"
        )
        XCTAssertTrue(reloaded.verifyChain().valid)
    }

    /// The other persistence shape: an in-memory ledger (`path == nil`) has no
    /// disk side to be stale against, so it must never report a failure — and the
    /// path it publishes is nil, so no surface can print a location this gate
    /// does not use.
    func testInMemoryLedgerReportsNeitherPathNorFailure() {
        let gate = makeGate()
        _ = appendChain(gate, count: 2)
        XCTAssertNil(gate.persistFailed)
        XCTAssertNil(gate.ledgerPath)
        XCTAssertEqual(gate.count, 2)
    }

    /// …and the third: the bytes land, the mode does not. `persist()`'s fallback
    /// ends with the same isolation check the evidence archive runs, and before
    /// this round that check answered only with a log line, so "the signature
    /// chain is readable by every local account" was a fact no reader could ask
    /// about.
    ///
    /// The predicate stands for one specific volume: a mount that will not
    /// isolate *any* file it is given, which is why both names are refused — the
    /// temporary one (the primary throws on its own verdict, real code, and the
    /// run falls back) and the published one (the reason under test). What the
    /// filesystem still decides for real is that the writes *land*: measured on
    /// this checkout, the temp write and the atomic rewrite both succeed with the
    /// production verdict (mode 0644 in between), so the refusal below is the
    /// judgment and not the fixture. Driving the fallback any other way was
    /// measured and does not work here — a directory squatting on
    /// `approvals.json.tmp` does **not** make the primary write throw, because
    /// unlike `EvidenceStore` this one is not `.atomic`.
    func testFallbackIsolationFailureIsRecordedToo() throws {
        let dir = TestSandbox.directory("ledger-isolate-fallback")
        let path = dir + "/approvals.json"
        TestSandbox.assertIsolated(path, label: "ledger-isolate-fallback")
        let gate = ApprovalGate(path: path, clock: { ApprovalGateTests.isoEpoch })
        var judged: [String] = []
        gate.isolationCheck = { candidate in
            judged.append(candidate)
            return "\(candidate) is still 0644 after chmod(0600)"
        }

        XCTAssertNotNil(gate.append(
            operationRef: "snap-exposed",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "daemon:auto",
            reason: "landed world-readable"
        ))
        XCTAssertEqual(
            judged, [path + ".tmp", path],
            "the primary judges the temporary name, its verdict throws into the fallback, and the fallback judges the published ledger: \(judged)"
        )
        let failure = try XCTUnwrap(
            gate.persistFailed,
            "a ledger that reached disk without isolation is an audit fact, not a log line"
        )
        XCTAssertTrue(failure.contains("not owner-only after the fallback write"), failure)
        XCTAssertTrue(failure.contains(path), "the reason has to name the exposed file: \(failure)")
        XCTAssertTrue(
            failure.contains("--state-dir"),
            "…and carry the executable fix, since a volume that ignores chmod is the cause: \(failure)"
        )
        XCTAssertEqual(gate.count, 1, "this shape is 'exposed', not 'absent': the record is on disk")
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: path + ".tmp"),
            "the rejected temporary copy must not stay on disk holding the chain"
        )

        // Control: the production verdict on the same bytes clears the record.
        gate.isolationCheck = StateRoot.isolateFile(at:)
        XCTAssertNotNil(gate.append(
            operationRef: "snap-isolated",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "daemon:auto",
            reason: "and isolated this time"
        ))
        XCTAssertNil(gate.persistFailed)
        XCTAssertEqual(
            try (FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?
                .int16Value, 0o600
        )
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