import Foundation

/// P0 diagnosis classifier (5.8 §5.3 "P0 分类器能力边界"). With the Z5
/// channel the available signals are: AX tree digest change, pixel diff,
/// process liveness, and AX responsiveness. Decidable classes: T0 (channel
/// fault), T1 (crash), T2 (hang), T3 (dead click), T6 (tree changed, screen
/// did not). Everything that needs handler/state probes (T4/T5/T7/T8/T9)
/// yields INCONCLUSIVE — no guessing.
public enum Classifier {

    public static func classify(_ pack: EvidencePack) -> (class: DiagnosisClass, report: DiagnosisReport) {
        let evidenceSummary = evidenceLine(pack)
        let path = "act.\(pack.signals.act.action.rawValue) -> ax-confirm -> tree-digest -> pixel-diff"

        // Ordered rules; the first match wins.
        if pack.signals.crash?.processAliveAfter == false {
            return outcome(.t1, path: path, evidence: evidenceSummary,
                anomaly: "target process exited during the operation",
                next: "relaunch the app and re-attach, then replay the recipe; inspect ~/Library/Logs/DiagnosticReports for a crash report")
        }

        if pack.circuitBreaker.level == .channelFault {
            return outcome(.t0, path: path, evidence: evidenceSummary,
                anomaly: "engine channel fault: AX API unavailable during the operation",
                next: "check accessibility permission (glasspaned --grant-accessibility) and the daemon log, then retry the operation")
        }

        if pack.signals.responsiveness?.responsive == false {
            return outcome(.t2, path: path, evidence: evidenceSummary,
                anomaly: "app unresponsive: AX ping timed out (likely main-thread block)",
                next: "sample the process (sample <pid>) to find the blocking work; retry after the app recovers")
        }

        if !pack.signals.act.actConfirmed {
            return outcome(.inconclusive, path: path, evidence: evidenceSummary,
                anomaly: "action was rejected by the element (actConfirmed=false); no runtime anomaly can be classified",
                next: "verify the selector targets an element supporting action '\(pack.signals.act.action.rawValue)'; try observe to confirm the element exists")
        }

        // T9 progressive degradation (P2 spec v2.1 §18.4): the joint verdict
        // marked this evidence with a `degradation|` reason prefix (≥2 of
        // ping/memory/handles trending positive). This must precede the
        // T3/T6 branches so a slowly degrading session is not misread as a
        // dead click or a render-layer defect.
        if pack.circuitBreaker.reason?.hasPrefix("degradation|") == true {
            return outcome(.t9, path: path, evidence: evidenceSummary,
                anomaly: "progressive degradation: ≥2 signals (main-thread ping latency / resident memory / handle count) trend persistently positive; joint T9 verdict",
                next: "inspect the app for resource leaks (memory growth, fd/handle growth, main-thread latency drift); fix the leak or end the long session, then re-attach and resume")
        }

        guard let axEvent = pack.signals.axEvent else {
            return outcome(.inconclusive, path: path, evidence: evidenceSummary,
                anomaly: "AX tree signal unavailable (tree capture failed); classification requires probe signals (P1)",
                next: "retry the act; if the AX channel is degraded see the circuitBreaker reason field")
        }

        if axEvent.axChanged {
            guard let pixelDiff = pack.signals.pixelDiff else {
                // P0 spec §9: with the pixel signal unavailable, a changed
                // tree cannot be separated into T6 vs NO_ANOMALY.
                return outcome(.inconclusive, path: path, evidence: evidenceSummary,
                    anomaly: "AX tree changed but the pixel signal is unavailable (circuitBreaker level \(pack.circuitBreaker.level.rawValue)); T6 is undecidable without screen capture",
                    next: "grant screen recording permission to the daemon and replay the act for a decidable T6/NO_ANOMALY verdict")
            }
            if pixelDiff.changedPixelRatio > 0 {
                if pack.assertion?.passed == false {
                    return outcome(.inconclusive, path: path, evidence: evidenceSummary,
                        anomaly: "signals normal (tree and pixels changed) but the assertion failed: state/view-model mismatch suspected (T7 family needs state probes, P1)",
                        next: "re-check the expected value; Z1 state probes (P1) will localize the mismatch")
                }
                return outcome(.noAnomaly, path: path, evidence: evidenceSummary,
                    anomaly: "none: operation confirmed, AX tree changed and pixels changed",
                    next: "no action required; continue the recipe")
            }
            return outcome(.t6, path: path, evidence: evidenceSummary,
                anomaly: "AX tree changed but pixels did not (changedPixelRatio=\(pixelDiff.changedPixelRatio)); render layer suspected",
                next: "check view visibility/layer/drawing for the changed subtree; Z1 probes (P1) will localize the render defect")
        }

        // axChanged == false
        if let pixelDiff = pack.signals.pixelDiff, pixelDiff.changedPixelRatio > 0 {
            return outcome(.inconclusive, path: path, evidence: evidenceSummary,
                anomaly: "pixels changed but AX tree did not: transient visual effect or view-model decoupling (T7 family needs state probes, P1)",
                next: "re-observe the tree; if the change should be reflected in state, Z1 probes (P1) are required to decide")
        }
        let failure = pack.assertion?.passed == false
            ? " and the assertion failed"
            : ""
        return outcome(.t3, path: path, evidence: evidenceSummary,
            anomaly: "operation confirmed but neither the AX tree nor pixels changed\(failure); binding lost",
            next: "verify the selector matches an enabled control; observe the tree; check the action binding and isEnabled state")
    }

    // MARK: - Internals

    private static func outcome(
        _ `class`: DiagnosisClass,
        path: String,
        evidence: String,
        anomaly: String,
        next: String
    ) -> (class: DiagnosisClass, report: DiagnosisReport) {
        let report = DiagnosisReport(path: path, anomaly: anomaly, evidence: evidence, next: next)
        return (`class`, report)
    }

    private static func evidenceLine(_ pack: EvidencePack) -> String {
        var parts: [String] = [
            "\(pack.operationId) \(pack.attribution.level.rawValue) attribution",
            "actConfirmed=\(pack.signals.act.actConfirmed)"
        ]
        if let axEvent = pack.signals.axEvent {
            parts.append("axChanged=\(axEvent.axChanged) (digest \(axEvent.treeDigestBefore) -> \(axEvent.treeDigestAfter), \(axEvent.nodeCount) nodes, \(axEvent.latencyMs)ms)")
        }
        if let pixelDiff = pack.signals.pixelDiff {
            parts.append("changedPixelRatio=\(pixelDiff.changedPixelRatio)")
        } else {
            parts.append("pixelDiff=unavailable")
        }
        if let responsiveness = pack.signals.responsiveness {
            parts.append("responsive=\(responsiveness.responsive) pingMs=\(responsiveness.pingMs)")
        }
        if let crash = pack.signals.crash {
            parts.append("alive \(String(crash.processAliveBefore)) -> \(String(crash.processAliveAfter))")
        }
        parts.append("circuitBreaker=\(pack.circuitBreaker.level.rawValue)")
        return parts.joined(separator: "; ")
    }
}
