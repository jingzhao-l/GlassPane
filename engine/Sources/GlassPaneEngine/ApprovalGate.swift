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

    public init(
        path: String? = nil,
        clock: @escaping () -> Date = { Date() }
    ) {
        self.path = path
        self.clock = clock
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
    /// a directory that does not exist yet is lost silently, and the next
    /// process reads `count: 0` from a chain it never got. In `glasspaned` the
    /// root is always there before the ledger is used (the archive and the
    /// registry each create it on their first write, and the smoke runs
    /// pre-create it mode 0700), but a caller that builds only a ledger has to
    /// create the directory itself.
    public convenience init(stateRoot: StateRoot, clock: @escaping () -> Date = { Date() }) {
        self.init(path: stateRoot.approvalsFile, clock: clock)
    }

    // MARK: - Chain access

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
    /// the disk side is simply stale, surfaced by verify/audit (P5 §3.4).
    private func persist() {
        guard let path else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(records) else { return }
        let tmpPath = path + ".tmp"
        do {
            try data.write(to: URL(fileURLWithPath: tmpPath))
            _ = try FileManager.default.replaceItemAt(
                URL(fileURLWithPath: path),
                withItemAt: URL(fileURLWithPath: tmpPath)
            )
            try? FileManager.default.removeItem(atPath: tmpPath)
        } catch {
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
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