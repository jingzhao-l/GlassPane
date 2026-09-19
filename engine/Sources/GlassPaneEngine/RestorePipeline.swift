import Foundation
import CryptoKit

// MARK: - Restore snapshot tier-1 pipeline (P5 spec v5.0 §6)

/// Probe signal carried inside a snapshot (P5 §6.2). Produced by a Z5 probe
/// SDK at capture time; the engine stores it digest-adjacent so a later
/// `rollback_full` restore can plan and validate against the captured state.
/// Engine-internal shape — never part of an evidence schema.
public struct SnapshotProbeInfo: Codable, Equatable {
    public let probeVersion: String            // e.g. "z5-0.1.0"
    public let exportedDomains: [String]       // e.g. ["heap", "objc", "kvc-less-macro"]
    public let stateDigest: String             // overall SHA-256 (64 hex) of the exported state
    public let checkpointFormat: String        // e.g. "z5-json-v1"
    public let capturedAt: String              // ISO-8601 milliseconds UTC

    public init(
        probeVersion: String,
        exportedDomains: [String],
        stateDigest: String,
        checkpointFormat: String,
        capturedAt: String
    ) {
        self.probeVersion = probeVersion
        self.exportedDomains = exportedDomains
        self.stateDigest = stateDigest
        self.checkpointFormat = checkpointFormat
        self.capturedAt = capturedAt
    }
}

/// One ordered restore step for a single exported state domain (P5 §6.2).
public struct RestoreStep: Codable, Equatable {
    public let domain: String
    public let checkpointRef: String           // probe-side persistence key for this domain
    public let action: String                  // "rewrite" — domain state overwrite
    public let preconditions: [String]         // e.g. ["parent-domain-restored"]

    public init(
        domain: String,
        checkpointRef: String,
        action: String = "rewrite",
        preconditions: [String] = []
    ) {
        self.domain = domain
        self.checkpointRef = checkpointRef
        self.action = action
        self.preconditions = preconditions
    }
}

/// Full ordered restore plan (P5 §6.2). `domains` is dependency-sorted:
/// precondition-declaring domains come after their required domains;
/// prerequisite-free domains are ordered lexicographically (deterministic).
public struct RestorePlan: Codable, Equatable {
    public let snapshotId: String
    public let baselineDigest: String          // AX-tree baseline digest, same source as the snapshot
    public let domains: [String]
    public let steps: [RestoreStep]
    public let expectedStateDigest: String     // = probe stateDigest (plan acceptance target)
    public let domainCount: Int

    public init(
        snapshotId: String,
        baselineDigest: String,
        domains: [String],
        steps: [RestoreStep],
        expectedStateDigest: String,
        domainCount: Int
    ) {
        self.snapshotId = snapshotId
        self.baselineDigest = baselineDigest
        self.domains = domains
        self.steps = steps
        self.expectedStateDigest = expectedStateDigest
        self.domainCount = domainCount
    }
}

/// Tier-1 restore planning and validation — pure logic, no dependencies.
///
/// Honest boundary (P5 §6.6): this builds and validates *plans*; executing a
/// process-level rollback lives in the probe runtime, which this repository
/// does not ship. EngineCore surfaces `rollbackExecuted: false` and the
/// `z5-probe-runtime` execution surface rather than faking execution.
public enum RestorePipeline {

    /// Build an ordered plan from a snapshot's probe payload.
    ///
    /// Returns nil when the snapshot has no probe payload or the domain
    /// dependency graph is cyclic (unbuildable). Steps are synthesized
    /// deterministically from the exported domains: one "rewrite" step per
    /// domain, checkpointRef anchored in the probe format, no preconditions.
    public static func plan(snapshot: AppStateSnapshot) -> RestorePlan? {
        guard let probe = snapshot.probeInfo else { return nil }
        let domains = probe.exportedDomains.sorted()
        let steps = domains.map { domain in
            RestoreStep(
                domain: domain,
                checkpointRef: "\(probe.checkpointFormat)#\(domain)"
            )
        }
        return plan(
            snapshotId: snapshot.snapshotId,
            baselineDigest: snapshot.treeDigest,
            domains: domains,
            steps: steps,
            expectedStateDigest: probe.stateDigest
        )
    }

    /// Pure ordering core: dependency-sort the given steps into an ordered
    /// domain list plus their steps in that order.
    ///
    /// - Steps declaring preconditions are placed after those preconditions
    ///   (precondition names are matched against declared domains; symbolic
    ///   requirements the pipeline cannot resolve are ignored for ordering);
    /// - Cycles in the declared precondition graph return nil (unbuildable);
    /// - Steps without resolvable preconditions keep lexicographic order.
    public static func plan(
        snapshotId: String,
        baselineDigest: String,
        domains: [String],
        steps: [RestoreStep],
        expectedStateDigest: String
    ) -> RestorePlan? {
        let domainSet = Set(domains)
        // Edges: precondition domain -> domain that requires it.
        var dependencies: [String: Set<String>] = [:]
        for step in steps where domainSet.contains(step.domain) {
            var required = dependencies[step.domain] ?? []
            for precondition in step.preconditions where domainSet.contains(precondition) {
                // A domain never depends on itself; self/precondition-gap
                // handling still honours the topological contract.
                if precondition != step.domain {
                    required.insert(precondition)
                }
            }
            dependencies[step.domain] = required
        }

        // Kahn's algorithm with a lexicographic tie-break for determinism:
        // at each round pick the smallest ready domain.
        let allDomains = Set(domains)
        var computed: [String] = []
        var dependents: [String: Set<String>] = [:]
        var inDegree: [String: Int] = [:]
        var dependencyCount = 0
        for domain in allDomains {
            let required = dependencies[domain] ?? []
            for requirement in required {
                dependents[requirement, default: []].insert(domain)
                dependencyCount += 1
            }
            inDegree[domain] = required.count
        }
        var pending = allDomains.filter { (inDegree[$0] ?? 0) == 0 }.sorted()
        while !pending.isEmpty {
            let next = pending.removeFirst()
            computed.append(next)
            for dependent in (dependents[next] ?? []).sorted() {
                let remaining = (inDegree[dependent] ?? 1) - 1
                inDegree[dependent] = remaining
                dependencyCount -= 1
                if remaining == 0 {
                    pending.insertSorted(dependent)
                }
            }
        }
        let cyclic = dependencyCount > 0 || computed.count < allDomains.count
        guard !cyclic else { return nil }

        let orderedSteps = steps.sorted { stepA, stepB in
            guard let indexA = computed.firstIndex(of: stepA.domain),
                  let indexB = computed.firstIndex(of: stepB.domain),
                  indexA != indexB else {
                return false
            }
            return indexA < indexB
        }
        return RestorePlan(
            snapshotId: snapshotId,
            baselineDigest: baselineDigest,
            domains: computed,
            steps: orderedSteps,
            expectedStateDigest: expectedStateDigest,
            domainCount: computed.count
        )
    }

    /// Validate a plan against its snapshot probe payload. Every violation is
    /// listed verbatim in `issues`; an empty issues list means `valid`.
    public static func validate(plan: RestorePlan, snapshot: AppStateSnapshot) -> (valid: Bool, issues: [String]) {
        guard let probe = snapshot.probeInfo else {
            return (false, ["snapshot has no probe payload"])
        }
        var issues: [String] = []

        // 1. Domain set matches the probe's exported domains (no extra, no missing).
        let planSet = Set(plan.domains)
        let probeSet = Set(probe.exportedDomains)
        let missing = probeSet.subtracting(planSet).sorted()
        let extra = planSet.subtracting(probeSet).sorted()
        if !missing.isEmpty { issues.append("domains missing from plan: \(missing.joined(separator: ","))") }
        if !extra.isEmpty { issues.append("plan has domains not exported by probe: \(extra.joined(separator: ","))") }

        // 2. No duplicate domains.
        if plan.domains.count != planSet.count {
            issues.append("plan contains duplicate domains")
        }

        // 3. Every step references a planned domain with a non-empty checkpointRef.
        for step in plan.steps {
            guard planSet.contains(step.domain) else {
                issues.append("step domain '\(step.domain)' not in plan")
                continue
            }
            if step.checkpointRef.isEmpty {
                issues.append("step '\(step.domain)' has empty checkpointRef")
            }
        }

        // 4. Topological self-check: a step's resolvable preconditions (names
        //    that are planned domains) must be satisfied strictly earlier.
        if plan.domains.count == planSet.count {
            for step in plan.steps {
                guard let ownIndex = plan.domains.firstIndex(of: step.domain) else { continue }
                for precondition in step.preconditions where planSet.contains(precondition) {
                    guard let preconditionIndex = plan.domains.firstIndex(of: precondition) else {
                        issues.append("step '\(step.domain)' precondition '\(precondition)' missing from plan order")
                        continue
                    }
                    if preconditionIndex >= ownIndex {
                        issues.append(
                            "step '\(step.domain)' precondition '\(precondition)' must run earlier (topological order violated)"
                        )
                    }
                }
            }
        }

        // 5. Digest expectation matches the probe's self-reported state digest.
        if plan.expectedStateDigest != probe.stateDigest {
            issues.append("plan expectedStateDigest does not match probe stateDigest")
        }

        return (issues.isEmpty, issues)
    }

    /// Envelope digest check (P5 §6.3 防篡改): recomputes SHA-256 over the
    /// canonical JSON of every probe field except `stateDigest` and compares
    /// it with the self-reported digest.
    ///
    /// Honest note: the real probe hashes the *exported state*, which the
    /// engine cannot reproduce. The envelope digest is the P5 placeholder
    /// contract (a probe tampering only `stateDigest` gets caught); the exact
    /// Z5 digest input is calibrated by the future Z5 batch (§6.6 风险 2).
    public static func verifyStateDigest(snapshot: AppStateSnapshot) -> Bool {
        guard let probe = snapshot.probeInfo else { return false }
        // P6 §5.5: gpz1 payloads carry a *state* digest, not an envelope
        // digest — the daemon already recomputed and compared it at export
        // time (ProbeInbox.checkpointExport), and the restore path re-verifies
        // against postStateDigest. Recomputing the envelope here would wrongly
        // reject honest probes, so the live contract for gpz1 is "verified at
        // export"; other formats keep the P5 placeholder check below.
        if probe.checkpointFormat == "gpz1-json-v1" { return true }
        let payload: [String: Any] = [
            "probeVersion": probe.probeVersion,
            "exportedDomains": probe.exportedDomains,
            "checkpointFormat": probe.checkpointFormat,
            "capturedAt": probe.capturedAt
        ]
        guard let data = CanonicalJSON.stringify(payload).data(using: .utf8) else {
            return false
        }
        let digest = SHA256.hash(data: data)
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return hex == probe.stateDigest
    }
}

private extension Array where Element == String {
    /// Insert maintaining ascending order (smallest-first heap semantics for
    /// the deterministic Kahn loop).
    mutating func insertSorted(_ value: String) {
        var low = 0
        var high = count
        while low < high {
            let middle = (low + high) / 2
            if self[middle] < value {
                low = middle + 1
            } else {
                high = middle
            }
        }
        insert(value, at: low)
    }
}