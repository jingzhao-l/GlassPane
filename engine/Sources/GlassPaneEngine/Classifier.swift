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
        let path = pack.signals.handlerProbe != nil
            ? "act.\(pack.signals.act.action.rawValue) -> probe-window -> handler/state -> ax-digest -> pixel-diff"
            : "act.\(pack.signals.act.action.rawValue) -> ax-confirm -> tree-digest -> pixel-diff"

        // Ordered rules; the first match wins.
        // T1 只在"操作前活着、操作后没了"时成立。此前只看 after==false，
        // 于是 attach 到一个已死进程（before 也是 false）会被说成"崩在本次
        // 操作里"——把"没启动"报成"被我们弄坏了"。
        if pack.signals.crash?.processAliveBefore == true
            && pack.signals.crash?.processAliveAfter == false {
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

        // P6 spec v6.0 §3.2: probe-signal branches, inserted after T9 and
        // before the black-box T3/T6 paths. They only fire when the pack
        // carries a handlerProbe (§3.1 presence = probe connection served the
        // window); without it every rule below stays byte-identical to P0 and
        // the requires-probe-signals INCONCLUSIVE boundary is preserved.
        if let handlerProbe = pack.signals.handlerProbe {
            let axChanged = axEvent.axChanged
            let pixelChanged = (pack.signals.pixelDiff?.changedPixelRatio ?? 0) > 0
            let stateChanged = pack.signals.stateDiff.map { $0.changed }

            // T8: the window stayed silent but events landed late (async timing).
            if handlerProbe.hitCount == 0 && (stateChanged ?? false) == false && handlerProbe.lateCount > 0 {
                return outcome(.t8, path: path, evidence: evidenceSummary,
                    anomaly: "async timing: no probe signal inside the act window but \(handlerProbe.lateCount) late handler arrival(s) followed (windowed attribution §2.3)",
                    next: "inspect the handler for async dispatch (\(handlerProbeSummary(handlerProbe))); shorten the settle interval or await the async continuation before asserting")
            }
            // T4 needs a decidable state channel; without stateDiff it is not
            // claimed (silence ≠ no-change for state-incapable probes).
            if handlerProbe.hitCount > 0 && stateChanged == false && !axChanged && !pixelChanged {
                return outcome(.t4, path: path, evidence: evidenceSummary,
                    anomaly: "logic bug: \(handlerProbe.hitCount) handler hit(s) (\(handlerProbeSummary(handlerProbe))) but state and AX tree silent, \(pixelClause(pack))",
                    next: "inspect the handler body between hit locations \(handlerProbeSummary(handlerProbe)) — the bound effect is missing or writes a stale key")
            }
            // T5: state moved but neither view channel followed (dependency loss).
            if handlerProbe.hitCount > 0 && stateChanged == true && !axChanged && !pixelChanged {
                return outcome(.t5, path: path, evidence: evidenceSummary,
                    anomaly: "SwiftUI dependency loss: handler hit and state changed (\(stateDiffSummary(pack))) but AX tree stayed silent, \(pixelClause(pack))",
                    next: "check the view's observation of the changed key (Z1b-style direct @State writes and missing @Observable registration are the usual roots); re-bind or route through the observed model")
            }
            // T7: view channels moved while the observed state stayed put.
            if handlerProbe.hitCount > 0 && stateChanged == false && (axChanged || pixelChanged) {
                return outcome(.t7, path: path, evidence: evidenceSummary,
                    anomaly: "view-model decoupling: AX/pixels changed while observed state did not (handler hit \(handlerProbe.hitCount), stateDiff.changed=false)",
                    next: "locate the direct UI mutation bypassing the state layer; assert against the state channel (stateDiff entries) rather than pixels")
            }
            // Honest gap: the handler ran but the probe carries no state
            // channel — T4/T5/T7 are undecidable and the black-box T3 verdict
            // ("dead click") would contradict the probe. Do not guess.
            if handlerProbe.hitCount > 0 && stateChanged == nil && !axChanged && !pixelChanged {
                return outcome(.inconclusive, path: path, evidence: evidenceSummary,
                    anomaly: "handler ran (\(handlerProbeSummary(handlerProbe))) but the probe has no state channel and AX/pixels are silent — T4 vs no-anomaly needs a state source (z2/z3)",
                    next: "register state observation in the probe (GP.registerMirrorRoot or GP.registerKVCObject), then re-run the act; do not conclude binding loss while the probe says the handler executed")
            }
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
            anomaly: "operation confirmed but the AX tree did not change and \(pixelClause(pack))\(failure); binding lost",
            next: "verify the selector matches an enabled control; observe the tree; check the action binding and isEnabled state")
    }

    // MARK: - Internals

    /// 像素通道的如实措辞：没有捕获值时不能写成"像素没变"。
    /// 归类判定保持保守不变（nil 走 false 分支），改的只是**说出来的那句话**
    /// ——P0 §8 授权 T3/T4/T5 的是归类结论，不是宣称一个未测量的负例。
    static func pixelClause(_ pack: EvidencePack) -> String {
        pack.signals.pixelDiff == nil ? "pixels not measured" : "pixels unchanged"
    }

    private static func handlerProbeSummary(_ handlerProbe: HandlerProbeSignal) -> String {
        let refs = handlerProbe.handlers.prefix(4).map { "\($0.file):\($0.line)" }.joined(separator: ", ")
        return refs.isEmpty ? "no localized hits" : refs
    }

    private static func stateDiffSummary(_ pack: EvidencePack) -> String {
        guard let stateDiff = pack.signals.stateDiff else { return "stateDiff=unavailable" }
        let keys = stateDiff.entries.prefix(4).map(\.key).joined(separator: ", ")
        return "source=\(stateDiff.source.rawValue), changed=\(stateDiff.changed), keys=[\(keys)]"
    }

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
        if let handlerProbe = pack.signals.handlerProbe {
            parts.append("handlerProbe hitCount=\(handlerProbe.hitCount) late=\(handlerProbe.lateCount) [\(handlerProbeSummary(handlerProbe))]")
        }
        if let stateDiff = pack.signals.stateDiff {
            parts.append(stateDiffSummary(pack))
        }
        parts.append("circuitBreaker=\(pack.circuitBreaker.level.rawValue)")
        return parts.joined(separator: "; ")
    }
}
