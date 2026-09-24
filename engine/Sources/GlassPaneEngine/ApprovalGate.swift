import Foundation
import CryptoKit

// MARK: - Approval ledger (P5 spec v5.0 §3 审批/权限签名链)

/// Risk classification of an approved operation (P5 §3.2).
public enum RiskTier: String, Codable {
    case low, medium, high
}

/// The recorded decision for an operation.
///
/// The current protocol has no human-in-the-loop approval interaction (the
/// socket method table is frozen), so today only `approve` records occur —
/// daemon-auto-registered. `deny` is fully supported in the data model and
/// chain verification so a future batch that adds an approval UI can start
/// emitting real denials without a schema change (P5 §3.8 诚实声明 1).
public enum ApprovalDecision: String, Codable {
    case approve, deny
}

/// A single approval ledger entry. The chain is anchored via `prevHash`:
/// each record's hash covers the full prior linkage, so tampering with any
/// historical record breaks every subsequent hash (P5 §3.2–§3.3).
public struct ApprovalRecord: Codable, Equatable {
    public let approvalId: String     // appr_ + Crockford base32 (26)
    public let operationRef: String   // associated operation (snapshotId / operationId / CLI name)
    public let operationType: String  // e.g. "restore" / "prune-evidence"
    public let riskTier: RiskTier
    public let decision: ApprovalDecision
    public let approvedBy: String     // daemon auto-registration uses "daemon:auto"
    public let reason: String         // ≤ ApprovalGate.reasonMaxLength 字符
    public let timestamp: String      // ISO-8601 milliseconds UTC
    public let prevHash: String       // full 64-hex hash of the previous record; "" for genesis
    public let hash: String           // full 64-hex SHA-256 of this record's canonical payload

    public init(
        approvalId: String,
        operationRef: String,
        operationType: String,
        riskTier: RiskTier,
        decision: ApprovalDecision,
        approvedBy: String,
        reason: String,
        timestamp: String,
        prevHash: String,
        hash: String
    ) {
        self.approvalId = approvalId
        self.operationRef = operationRef
        self.operationType = operationType
        self.riskTier = riskTier
        self.decision = decision
        self.approvedBy = approvedBy
        self.reason = reason
        self.timestamp = timestamp
        self.prevHash = prevHash
        self.hash = hash
    }
}

/// Append-only approval ledger with a SHA-256 hash chain.
///
/// - Pure in-memory when `path` is nil (test default);
/// - File-persisted (atomic tmp + rename) when `path` is non-nil: loads the
///   chain on init, appends atomically after every record;
/// - A corrupt or unreadable ledger loads as an empty chain — never as a
///   silently-valid one — so `--approval-verify` exposes the damage.
public final class ApprovalGate {

    /// Default daemon ledger path: the approvals file of the home-derived state
    /// root. Derived from `StateRoot` rather than composed here — the home
    /// lookup behind it ignores a `HOME` override, so the per-user location has
    /// to come from one named source (X-22).
    public static let defaultPath = StateRoot.homeDefault().approvalsFile
    /// Upper bound for `ApprovalRecord.reason` (P5 §3.2).
    public static let reasonMaxLength = 512

    private let path: String?
    private let clock: () -> Date
    /// In-memory chain, head = oldest. Append order defines the linkage.
    public private(set) var records: [ApprovalRecord]
    /// True when a non-nil path pointed at an existing file that failed to
    /// decode. The ledger loads as empty (§3.4) but this flag lets the CLI
    /// surface the damage honestly instead of presenting an empty-but-valid
    /// ledger as evidence of a healthy audit trail.
    public private(set) var loadFailed = false
    /// The last persistence attempt that did **not** leave this chain on disk as
    /// an owner-only file, with the concrete reason and the target path; cleared
    /// by the next attempt that did. nil means "the disk side matches what this
    /// process holds" — for an in-memory gate (`path == nil`) nothing is
    /// expected on disk, so it stays nil.
    ///
    /// This is an audit fact, not debug output. `verifyChain()` verifies the
    /// **in-memory** `records`, so a silently failed persist cannot be caught by
    /// it — and `--approval-verify` reads the file from a *different* process, so
    /// it does not lie either: what it reports is the shorter chain the disk
    /// actually holds. Before this field existed, both halves of that statement
    /// were invisible from inside the process doing the appending: the append was
    /// reported to its caller as recorded, the chain kept verifying, and the
    /// record simply was not in the audit trail. A reader that needs to know
    /// "this approval exists only in RAM" has to be able to ask.
    public private(set) var persistFailed: String?
    /// Where persistence failures go. Both the primary write and its fallback
    /// can fail, and the ledger's contract ("the disk side is simply stale,
    /// surfaced by verify/audit") only holds if somebody says so — a silent
    /// second failure is how an audit trail ends up missing records that every
    /// in-process reader believed were appended (the chain still verifies; it
    /// just stops containing things that happened).
    private let log: EngineLog

    /// The isolation verdict for a finished ledger, as one named step — the same
    /// seam `EvidenceStore.isolationCheck` is, for the same measured reason: the
    /// volume this refuses (a mount that ignores `chmod`) cannot be built by a
    /// non-root test, and a refusal no test has executed is the shape this
    /// round's review keeps rejecting. Production always answers with
    /// `StateRoot.isolateFile`; the candidate space that fails to reach the
    /// verdict any other way is measured and written up on
    /// `StatePermissionTests.testFallbackWriteRefusesAPackItCannotIsolate`, and
    /// `ApprovalGateTests.testFallbackIsolationFailureIsRecordedToo` drives this
    /// one through the same door.
    var isolationCheck: (String) -> String? = StateRoot.isolateFile(at:)

    public init(
        path: String? = nil,
        clock: @escaping () -> Date = { Date() },
        log: EngineLog = EngineLog(quiet: true)
    ) {
        self.path = path
        self.clock = clock
        self.log = log
        if let path {
            // File exists → decode; missing or corrupt → empty chain (honest:
            // a corrupt ledger is never presented as a valid one — verify
            // exposes it, and the next append re-anchors from scratch).
            if FileManager.default.fileExists(atPath: path),
               let data = FileManager.default.contents(atPath: path),
               let decoded = try? JSONDecoder().decode([ApprovalRecord].self, from: data) {
                records = decoded
            } else {
                loadFailed = FileManager.default.fileExists(atPath: path)
                records = []
            }
        } else {
            records = []
        }
    }

    /// A file-persisted ledger over `<stateRoot>/approvals.json` — the route
    /// `glasspaned` takes for `--approval-audit`, `--approval-verify` and the
    /// daemon itself, so a run that named a state root cannot append to the
    /// per-user chain and a run that named none cannot be pointed elsewhere.
    ///
    /// The directory is **not** created here, and that is a measured gap rather
    /// than a claim of safety: `persist()` has no mkdir step, so an append into
    /// a directory that does not exist yet does not reach disk — it is reported
    /// in `persistFailed` (with the target path) and the next process reads
    /// `count: 0` from a chain it never got. In `glasspaned` the root is always
    /// there before the ledger is used (the archive and the registry each create
    /// it on their first write, and the smoke runs pre-create it mode 0700), but
    /// a caller that builds only a ledger has to create the directory itself.
    public convenience init(
        stateRoot: StateRoot,
        clock: @escaping () -> Date = { Date() },
        log: EngineLog = EngineLog(quiet: true)
    ) {
        self.init(path: stateRoot.approvalsFile, clock: clock, log: log)
    }

    // MARK: - Chain access

    /// The file this ledger persists to, or nil when it is memory-only. Exposed
    /// because every surface that reports the chain has to name the file it
    /// actually read: `--approval-verify` under `--state-dir` reads
    /// `<state-dir>/approvals.json`, and a payload that printed the home-derived
    /// default instead would point an agent at a file this process never opens.
    public var ledgerPath: String? { path }

    /// Current chain, head first.
    public func chain() -> [ApprovalRecord] {
        records
    }

    /// Hash of the last record; "" on an empty chain (genesis prevHash).
    public func tailHash() -> String {
        records.last?.hash ?? ""
    }

    /// Count of ledger entries.
    public var count: Int { records.count }

    // MARK: - Append

    /// Append a new approval. `approvalId`/`timestamp`/`prevHash`/`hash` are
    /// auto-completed per §3.3. Returns the appended record, or nil when the
    /// reason exceeds `reasonMaxLength` (nothing is appended on rejection).
    @discardableResult
    public func append(
        operationRef: String,
        operationType: String,
        riskTier: RiskTier,
        decision: ApprovalDecision,
        approvedBy: String,
        reason: String
    ) -> ApprovalRecord? {
        guard reason.count <= Self.reasonMaxLength else { return nil }
        let timestamp = isoString(clock())
        let prevHash = tailHash()
        let record = ApprovalRecord(
            approvalId: OperationID.generateApprovalLive(),
            operationRef: operationRef,
            operationType: operationType,
            riskTier: riskTier,
            decision: decision,
            approvedBy: approvedBy,
            reason: reason,
            timestamp: timestamp,
            prevHash: prevHash,
            hash: ""
        )
        guard let hash = ApprovalGate.hash(of: record) else { return nil }
        let finalized = ApprovalRecord(
            approvalId: record.approvalId,
            operationRef: record.operationRef,
            operationType: record.operationType,
            riskTier: record.riskTier,
            decision: record.decision,
            approvedBy: record.approvedBy,
            reason: record.reason,
            timestamp: record.timestamp,
            prevHash: record.prevHash,
            hash: hash
        )
        records.append(finalized)
        persist()
        return finalized
    }

    // MARK: - Verification

    /// Replay-verify the full chain: each record's own hash must match its
    /// recomputed canonical payload, and record N's prevHash must equal record
    /// N-1's verified hash. Returns the first broken index (nil = valid).
    public func verifyChain() -> (valid: Bool, firstBrokenIndex: Int?) {
        ApprovalGate.verify(records: records)
    }

    /// Pure verification core — reuses the same rules the instance method
    /// applies, exposed (static) for tamper/truncation unit tests that feed
    /// modified arrays directly.
    public static func verify(records: [ApprovalRecord]) -> (valid: Bool, firstBrokenIndex: Int?) {
        var expectedPrev = ""
        for (index, record) in records.enumerated() {
            guard let recomputed = hash(of: record) else {
                return (false, index)
            }
            if recomputed != record.hash || record.prevHash != expectedPrev {
                return (false, index)
            }
            expectedPrev = record.hash
        }
        return (true, nil)
    }

    // MARK: - Hash

    /// SHA-256 (full 64 hex) of the key-sorted canonical JSON of every field
    /// except `hash` — feeding the record's own `hash` back in would make the
    /// digest self-referential (P5 §3.3).
    public static func hash(of record: ApprovalRecord) -> String? {
        let payload: [String: Any] = [
            "approvalId": record.approvalId,
            "operationRef": record.operationRef,
            "operationType": record.operationType,
            "riskTier": record.riskTier.rawValue,
            "decision": record.decision.rawValue,
            "approvedBy": record.approvedBy,
            "reason": record.reason,
            "timestamp": record.timestamp,
            "prevHash": record.prevHash
        ]
        guard let data = CanonicalJSON.stringify(payload).data(using: .utf8) else {
            return nil
        }
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Persistence

    /// Atomic write (tmp + replaceItemAt, same pattern as EvidenceStore and
    /// ProjectRegistry). A failed write never breaks the in-memory chain —
    /// the disk side is simply stale, surfaced by verify/audit (P5 §3.4) — but
    /// "surfaced" requires a voice, so every failure shape below both logs and
    /// records the reason in `persistFailed`, and every shape that ends with the
    /// chain actually on disk owner-only clears it. Publishing the state is the
    /// point: a verdict that only ever reaches a log line leaves the caller
    /// holding records it believes are recorded.
    ///
    /// The ledger file is left owner-only (`0600`) because it is a signature
    /// chain other accounts must not read (R5-04). On the fallback route the
    /// bytes land before the mode is fixed, so an isolation failure there is
    /// reported as its own reason: the record *is* on disk, but exposed.
    private func persist() {
        guard let path else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data: Data
        do {
            data = try encoder.encode(records)
        } catch {
            reportPersistenceFailure(
                "approval ledger could not be encoded (\(records.count) records): \(error) — nothing was written to \(path)"
            )
            return
        }
        let tmpPath = path + ".tmp"
        do {
            try data.write(to: URL(fileURLWithPath: tmpPath))
            // The mode is set while the bytes are still under the temporary
            // name, so the published name is never *created* group- or
            // world-readable; the check after the rename below is what covers the
            // case where a destination that already had that mode is replaced.
            if let defect = isolationCheck(tmpPath) {
                throw NSError(
                    domain: "GlassPaneApprovalGate", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: defect]
                )
            }
            _ = try FileManager.default.replaceItemAt(
                URL(fileURLWithPath: path),
                withItemAt: URL(fileURLWithPath: tmpPath)
            )
            try? FileManager.default.removeItem(atPath: tmpPath)
            // …and the window the temporary name closes is only half the story:
            // measured on APFS, `replaceItemAt` hands the *destination's*
            // attributes to the item that lands, so a ledger that was ever
            // published 0644 — an installation that predates R5-04, or one written
            // by the fallback below — keeps that mode through every later rewrite,
            // while the temporary file's check reports success. The published name
            // is therefore judged too, and a defect there is reported rather than
            // assumed away. Nothing is deleted: this is the audit trail, and the
            // honest outcome is a failed persist the reader can see.
            if let defect = isolationCheck(path) {
                reportPersistenceFailure(
                    "approval ledger \(path) is not owner-only after the rename: \(defect) — permission judgment, not a full disk: the chain is on disk and readable by every local account, because the published file kept the mode of the one it replaced (chmod 600 \(path), or move the state root with --state-dir to a volume that honors permissions)"
                )
            } else {
                persistFailed = nil
            }
        } catch {
            let primary = error
            log.error("approval ledger write via \(tmpPath) failed: \(primary) — falling back to an atomic rewrite of \(path)")
            // The rejected copy holds the whole chain, and the reason it was
            // rejected may be precisely that it is not owner-only. Leaving it
            // there publishes the exposure the failure was reported for, so it
            // goes — same discipline `EvidenceStore.write` applies to its own
            // temporary file, and reported the same way when it cannot go.
            if FileManager.default.fileExists(atPath: tmpPath) {
                do {
                    try FileManager.default.removeItem(atPath: tmpPath)
                } catch {
                    log.error("the rejected ledger copy \(tmpPath) could not be removed (\(error)) — it is still on disk and it is NOT owner-only; delete that one file by name")
                }
            }
            do {
                try data.write(to: URL(fileURLWithPath: path), options: .atomic)
                if let defect = isolationCheck(path) {
                    reportPersistenceFailure(
                        "approval ledger \(path) is not owner-only after the fallback write: \(defect) — permission judgment, not a full disk: the \(records.count) record(s) reached disk but the hash chain is readable by every local account, so \(path) has to be tightened (chmod 600) or the state root moved with --state-dir to a volume that honors permissions"
                    )
                } else {
                    persistFailed = nil
                }
            } catch {
                reportPersistenceFailure(
                    "approval ledger write to \(path) failed twice (via \(tmpPath): \(primary); direct: \(error)) — the \(records.count) record(s) exist in this process only and are NOT in the audit trail on disk"
                )
            }
        }
    }

    /// One persistence failure, stated once and kept queryable.
    private func reportPersistenceFailure(_ reason: String) {
        persistFailed = reason
        log.error(reason)
    }

    // MARK: - Helpers

    private static let isoFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    private func isoString(_ date: Date) -> String {
        Self.isoFormatter.string(from: date)
    }

    public static func isoString(date: Date) -> String {
        isoFormatter.string(from: date)
    }

    /// Encoded ledger bytes (key-sorted), used by `--approval-audit`.
    public func auditJSON() -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try? encoder.encode(records)
    }
}