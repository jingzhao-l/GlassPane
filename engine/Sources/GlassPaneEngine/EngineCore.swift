import Foundation

/// Engine orchestration: attachment state, the act pipeline (P0 spec §3.3
/// 语义细则), evidence assembly, and the bounded in-memory evidence history.
/// All observable behavior goes through RuntimeChannel, so the complete
/// walking-skeleton loop is unit-testable without accessibility permission.
public final class EngineCore {

    /// Settle interval between performing the action and the post-capture.
    public static let actSettleInterval: TimeInterval = 0.15
    /// AX ping timeout used when the channel reports .pingTimeout.
    public static let pingTimeoutMs: Double = 2000
    /// Evidence packs kept in memory (P0: recent entries only, never on disk).
    public static let historyLimit = 64
    /// Performance circuit-breaker budget (P1 spec v1.1 §2.2): an act whose
    /// full pipeline exceeds this wall-clock budget is flagged so diagnosis
    /// can separate "channel slow" from "channel broken".
    public static let performanceLatencyBudgetMs: Double = 10_000
    /// In-memory snapshot retention cap (P1 spec v1.1 §1.5).
    public static let snapshotHistoryLimit = 8

    public let version = "0.1.0"
    public let protocolVersion = "0"
    public private(set) var attachedApp: AttachedApp?
    /// Currently active project (P1 spec v1.4 §1.3). Set via attach with projectId.
    public private(set) var activeProjectId: String?
    public private(set) var shutdownRequested = false

    private let channel: RuntimeChannel
    private let clock: () -> Date
    private let settle: () -> Void
    private var history: [EvidencePack] = []
    /// Recent app-state snapshots (P1 spec v1.1 §1.5); FIFO-evicted.
    private var snapshots: [AppStateSnapshot] = []
    /// Project registry (P1 spec v1.4 §1).
    public let projectRegistry: ProjectRegistry
    /// File-persisted evidence archive (P1 spec v1.5 §9). Empty disk side
    /// when `nil` is injected — used to disable persistence in tests that
    /// assert pure in-memory behavior.
    private let evidenceStore: EvidenceStore?
    /// Concurrency attribution guard (P2 spec v2.0 §15.4). Nil disables C33 —
    /// act() then behaves exactly like v1.6.
    private let attributionGuard: AttributionGuard?
    /// Progressive degradation tracker (P2 spec v2.1 §18.3). Nil disables T9 —
    /// act() then behaves exactly like v2.0.
    private let degradationTracker: DegradationTracker?
    /// Process metrics adapter feeding memory/handle signals into the tracker.
    /// Nil means those signals are absent: the joint verdict can then never
    /// reach .degrading (honest degradation instead of fake slopes).
    private let metricsProbe: ProcessMetricsProviding?
    /// Approval ledger (P5 spec v5.0 §3.5): nil disables registration and
    /// restore behaves exactly as before. Non-nil registers a high-risk record
    /// before each executed restore.
    private let approvalGate: ApprovalGate?
    /// Tier-1 probe signal slot (P5 spec v5.0 §6.4): invoked at every snapshot
    /// capture to attach a `SnapshotProbeInfo` payload. The daemon does not
    /// inject a probe (this repo ships none), so it yields nil; tests inject
    /// scripted payloads to exercise the rollback_full pipeline.
    private let snapshotProbe: (() -> SnapshotProbeInfo?)?
    /// Probe inbox (P6 spec v6.0 §5.2). Nil or connection-less means the
    /// Z5-only black-box form: handlerProbe/stateDiff stay null and act()
    /// behaves exactly like v5.0 — the honest absence is preserved verbatim.
    private let probeInbox: ProbeInbox?
    /// TCC 席位自报钩子（P1 spec v1.2 §11.2）：daemon 注入自身探针，`hello`
    /// 因此带上 `identity` + `permissions`，让设置面板读到的是**授权主体
    /// （daemon 进程）**的状态而非面板进程的。缺省 nil 表示不上报（旧行为，
    /// 面板据此如实降级为"未验证"，不猜测）。
    private let permissionsReport: (() -> DaemonPermissionSnapshot?)?
    /// Busy-input retry budget before surfacing GP_E_BUSY_INPUT.
    public static let idleRetryCount = 5
    /// Interval between busy-input retries.
    public static let idleRetryInterval: Double = 0.05
    /// op_end → window-close drain slack for probe-delivered state diffs.
    public static let probeEndDrainSeconds: TimeInterval = 0.06

    public init(
        channel: RuntimeChannel,
        clock: @escaping () -> Date = { Date() },
        settle: (() -> Void)? = nil,
        projectRegistry: ProjectRegistry? = nil,
        evidenceStore: EvidenceStore? = nil,
        attributionGuard: AttributionGuard? = nil,
        degradationTracker: DegradationTracker? = nil,
        metricsProbe: ProcessMetricsProviding? = nil,
        approvalGate: ApprovalGate? = nil,
        snapshotProbe: (() -> SnapshotProbeInfo?)? = nil,
        probeInbox: ProbeInbox? = nil,
        permissionsReport: (() -> DaemonPermissionSnapshot?)? = nil
    ) {
        self.channel = channel
        self.clock = clock
        self.settle = settle ?? { Thread.sleep(forTimeInterval: EngineCore.actSettleInterval) }
        self.projectRegistry = projectRegistry ?? ProjectRegistry()
        self.evidenceStore = evidenceStore
        self.attributionGuard = attributionGuard
        self.degradationTracker = degradationTracker
        self.metricsProbe = metricsProbe
        self.approvalGate = approvalGate
        self.snapshotProbe = snapshotProbe
        self.probeInbox = probeInbox
        self.permissionsReport = permissionsReport
    }

    // MARK: - ISO-8601 timestamp

    private static let isoFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    private func nowISO() -> String {
        Self.isoFormatter.string(from: clock())
    }

    // MARK: - Methods (P0 spec §3.3)

    public func hello() -> [String: Any] {
        var payload: [String: Any] = [
            "engine": "glasspaned",
            "version": version,
            "protocolVersion": protocolVersion,
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "capabilities": ["act", "observe", "assert_element", "diagnose", "snapshot", "restore", "probe"]
        ]
        // P1 v1.2 §11.2：带上 daemon 自身的授权主体与四类席位（未注入钩子时
        // 整段省略——面板据此如实显示"未验证"，不以面板进程的权限冒充）。
        if let snapshot = permissionsReport?() {
            payload["identity"] = snapshot.subject.wireValue
            payload["permissions"] = snapshot.permissionsWire
        }
        return payload
    }

    public func attach(bundleId: String?, pid: pid_t?, projectId: String? = nil) throws -> [String: Any] {
        do {
            let app = try channel.attach(bundleId: bundleId, pid: pid)
            // Validate projectId against registry if provided (spec v1.4 §1.3):
            // the registry entry's bundleId or pid must match the attached app.
            if let projectId {
                guard let entry = projectRegistry.get(projectId) else {
                    throw GPError(code: .notFound, message: "unknown projectId \(projectId)")
                }
                if let expectedBundleId = entry.bundleId {
                    guard expectedBundleId == app.bundleId else {
                        throw GPError(
                            code: .badParams,
                            message: "projectId \(projectId) expects bundleId '\(expectedBundleId)' but attached '\(app.bundleId ?? "nil")'"
                        )
                    }
                }
                if let expectedPid = entry.pid {
                    guard expectedPid == app.pid else {
                        throw GPError(
                            code: .badParams,
                            message: "projectId \(projectId) expects pid \(expectedPid) but attached \(app.pid)"
                        )
                    }
                }
                activeProjectId = projectId
                // Point the archive at the active project's storage dir; a
                // project without evidenceStoragePath falls back to the
                // store default (spec v1.5 §9.3).
                if let evidenceStore,
                   let dir = entry.evidenceStoragePath {
                    evidenceStore.setDirectory(dir)
                }
            }
            // Re-attach to the same app is idempotent; a different app
            // invalidates the evidence history and the degradation window
            // (T9 traces are scoped to the app-under-test session, §18.3).
            if attachedApp != app {
                attachedApp = app
                history.removeAll()
                degradationTracker?.reset()
            }
            return attachResult(app)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }
    }

    public func act(selector: Selector, action: Action) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        // C33 concurrency attribution protection (P2 spec v2.0 §15.4): the
        // daemon must hold the operation right before acting. If real user
        // input keeps the input window busy, retry a bounded number of times
        // then surface GP_E_BUSY_INPUT instead of silently running polluted.
        var contaminationVerdict: OperationRightVerdict?
        if let attributionGuard {
            var acquisition: OperationRightAcquisition = .idleNotMet
            var attempts = 0
            while attributionGuard.isHolding == false {
                acquisition = attributionGuard.acquireOperationRight()
                if acquisition == .acquired {
                    break
                }
                attempts += 1
                guard attempts < EngineCore.idleRetryCount else { break }
                Thread.sleep(forTimeInterval: EngineCore.idleRetryInterval)
                acquisition = .idleNotMet
            }
            guard acquisition == .acquired else {
                throw GPError(
                    code: .busyInput,
                    message: "input window stayed busy for \(attempts) retries; refusing a possibly contaminated act"
                )
            }
        }
        // Safety net: any throw path below still releases the operation right.
        defer {
            if let attributionGuard, attributionGuard.isHolding {
                _ = attributionGuard.releaseOperationRight()
            }
        }

        let started = clock()
        // P6 §2.3: the operationId is generated up-front so probe events can
        // be windowed against it. Still a fresh ULID per act, same contract.
        let operationId = OperationID.generateLive()

        let aliveBefore = channel.isProcessAlive()

        // AX responsiveness probe.
        var responsiveness: ResponsivenessSignal
        do {
            let pingMs = try channel.ping()
            responsiveness = ResponsivenessSignal(responsive: true, pingMs: pingMs)
        } catch let error as ChannelError where error == .pingTimeout {
            responsiveness = ResponsivenessSignal(responsive: false, pingMs: Self.pingTimeoutMs)
        }

        // Pre-capture.
        var treeBefore: AxTreeSnapshot?
        if aliveBefore && responsiveness.responsive {
            do {
                treeBefore = try channel.treeSnapshot(maxDepth: Self.defaultObserveDepth)
            } catch let error as ChannelError {
                if case .axUnavailable = error { throw EngineCore.map(error) }
                treeBefore = nil
            }
        }
        var captureBefore: WindowCapture?
        if aliveBefore && responsiveness.responsive {
            do {
                captureBefore = try channel.captureWindow()
            } catch { captureBefore = nil }
        }

        // P6 §5.2: open the probe attribution window right before the action
        // is performed. A window only exists for a live probe connection to
        // the attached pid; otherwise the Z5-only form proceeds untouched.
        let probePid: Int32? = {
            guard let inbox = probeInbox, let app = attachedApp,
                  inbox.connection(for: app.pid) != nil else { return nil }
            return app.pid
        }()
        if let inbox = probeInbox, let pid = probePid {
            inbox.beginWindow(pid: pid, opId: operationId)
            inbox.sendCommand("op_begin", to: pid)
        }

        // Perform the action.
        var actConfirmed = false
        var actRejectReason: String?
        if !aliveBefore {
            actRejectReason = "target process is not alive"
        } else if !responsiveness.responsive {
            actRejectReason = "app unresponsive (AX ping timeout)"
        } else {
            do {
                try channel.performAction(selector: selector, action: action)
                actConfirmed = true
            } catch let error as ChannelError {
                if case .axUnavailable = error { throw EngineCore.map(error) }
                actRejectReason = Self.actRejectReason(error)
            }
        }

        // Settle, then post-capture.
        if actConfirmed {
            settle()
        }
        var treeAfter: AxTreeSnapshot?
        if treeBefore != nil, aliveBefore, actConfirmed {
            treeAfter = try? channel.treeSnapshot(maxDepth: Self.defaultObserveDepth)
        }
        var captureAfter: WindowCapture?
        if captureBefore != nil, aliveBefore {
            captureAfter = try? channel.captureWindow()
        }

        // P6 §2.3: close the probe window after the post-captures (t1) and
        // pull the [t0, t1] handler/state signals out of the inbox.
        var probeSignals: (handlerProbe: HandlerProbeSignal?, stateDiff: StateDiffSignal?)?
        if let inbox = probeInbox, let pid = probePid {
            inbox.sendCommand("op_end", to: pid)
            // Drain slack: the probe emits its op_end-baseline mirror diff
            // synchronously on command handling; 60 ms covers loopback
            // delivery before the window closes (P6 §2.3, probe-connected
            // acts only — Z5-only acts pay nothing).
            Thread.sleep(forTimeInterval: EngineCore.probeEndDrainSeconds)
            probeSignals = inbox.endWindow(pid: pid, opId: operationId)
        }

        let latencyMs = clock().timeIntervalSince(started) * 1000

        // Signals.
        let axChanged = Self.axChanged(before: treeBefore, after: treeAfter)
        let axEvent: AxEventSignal?
        if let before = treeBefore, let after = treeAfter {
            axEvent = AxEventSignal(
                treeDigestBefore: before.digest,
                treeDigestAfter: after.digest,
                nodeCount: after.nodeCount,
                axChanged: axChanged,
                latencyMs: latencyMs
            )
        } else {
            axEvent = nil
        }
        let pixelDiff: PixelDiffSignal?
        let pixelChanged: Bool
        if let before = captureBefore, let after = captureAfter {
            if let outcome = try? PixelDiffer.diff(before: before.image, after: after.image) {
                pixelDiff = PixelDiffSignal(
                    changedPixelRatio: outcome.changedPixelRatio,
                    bounds: outcome.bounds.map {
                        Bounds(x: $0.x, y: $0.y, width: $0.width, height: $0.height)
                    },
                    windowId: before.windowId
                )
                pixelChanged = outcome.changedPixelRatio > 0
            } else {
                pixelDiff = nil
                pixelChanged = false
            }
        } else {
            pixelDiff = nil
            pixelChanged = false
        }

        // Circuit breaker level: 3 > 2 > 1 > 0 (P0 spec §3.3/P0 熔断口径).
        let level: CircuitBreakerLevel
        var reason: String?
        if !aliveBefore {
            level = .actFailedChannelAlive
            reason = "process-exited"
        } else if !responsiveness.responsive {
            level = .actFailedChannelAlive
            reason = "ax-ping-timeout"
        } else if !actConfirmed {
            level = .actFailedChannelAlive
            reason = actRejectReason
        } else if pixelDiff == nil && treeBefore != nil {
            level = .degraded
            reason = captureBefore == nil ? "screen-recording-denied" : "pixel-capture-failed"
        } else if treeBefore == nil {
            level = .degraded
            reason = "ax-tree-capture-failed"
        } else {
            level = .normal
        }

        // Performance circuit breaker (P1 spec v1.1 §2): an act that exceeded
        // the wall-clock budget is flagged. Escalation only — never lowers an
        // existing channel-fault level, and level 2/3 are untouched by max.
        var finalLevel: CircuitBreakerLevel
        var finalReason: String?
        if latencyMs > Self.performanceLatencyBudgetMs {
            finalLevel = CircuitBreakerLevel(rawValue: max(level.rawValue, CircuitBreakerLevel.degraded.rawValue)) ?? level
            let perfReason = "performance-act-latency-over-budget: \(Int(latencyMs.rounded()))ms > \(Int(Self.performanceLatencyBudgetMs))ms"
            finalReason = reason.map { "performance|" + $0 } ?? perfReason
        } else {
            finalLevel = level
            finalReason = reason
        }

        // T9 progressive degradation (P2 spec v2.1 §18.3): record a sample,
        // then let the joint verdict escalate the circuit breaker level —
        // escalation only, never lowering an existing channel-fault level.
        if let degradationTracker, let attached = attachedApp {
            let probeMetrics = metricsProbe?.metrics(for: attached.pid)
            degradationTracker.record(
                DegradationSample(
                    timestamp: clock().timeIntervalSince1970,
                    pingMs: responsiveness.responsive ? responsiveness.pingMs : nil,
                    memoryBytes: probeMetrics?.memoryBytes,
                    handleCount: probeMetrics?.handleCount
                )
            )
            let t9Verdict = degradationTracker.verdict()
            if t9Verdict.tier == .degrading {
                finalLevel = CircuitBreakerLevel(
                    rawValue: max(finalLevel.rawValue, CircuitBreakerLevel.degraded.rawValue)
                ) ?? finalLevel
                let degradation = "degradation|" + t9Verdict.drivers.joined(separator: "+")
                    + "; longSession=\(t9Verdict.longSession)"
                finalReason = finalReason.map { degradation + "; " + $0 } ?? degradation
            }
        }

        // C33 verdict: scan the input stream for the whole operation window,
        // then release the operation right. Contamination downgrades the
        // attribution to weak + contaminated=true (spec v2.0 §15.4).
        if let attributionGuard {
            attributionGuard.monitorInput()
            contaminationVerdict = attributionGuard.releaseOperationRight()
        }
        let contaminated = contaminationVerdict?.contaminated ?? false
        // P6 §2.3: an in-window probe event (handler hit OR state change)
        // upgrades soft → strong (first hard attribution surface);
        // contamination still dominates → weak. State-only strong covers the
        // real-world binding-write paths (SwiftUI `$state` writes the author
        // cannot annotate — Z1b), where the state channel is the only, yet
        // genuinely operation-attributable, evidence (P6 §8 H1/H3 refinement).
        var attributionLevel: AttributionLevel = contaminated ? .weak : .soft
        if !contaminated, let signals = probeSignals,
           (signals.handlerProbe?.hitCount ?? 0) > 0 || (signals.stateDiff?.changed ?? false) {
            attributionLevel = .strong
        }
        let attribution = Attribution(
            level: attributionLevel,
            contaminated: contaminated
        )
        let pack = EvidencePack(
            operationId: operationId,
            createdAt: nowISO(),
            attribution: attribution,
            circuitBreaker: CircuitBreaker(level: finalLevel, reason: finalReason),
            signals: Signals(
                act: ActSignal(selector: selector, action: action, actConfirmed: actConfirmed),
                axEvent: axEvent,
                handlerProbe: probeSignals?.handlerProbe,
                stateDiff: probeSignals?.stateDiff,
                pixelDiff: pixelDiff,
                responsiveness: responsiveness,
                crash: CrashSignal(processAliveBefore: aliveBefore, processAliveAfter: channel.isProcessAlive())
            )
        )
        store(pack)

        guard actConfirmed else {
            throw GPError(code: .actFailed, message: actRejectReason ?? "action failed")
        }
        return [
            "operationId": operationId,
            "actConfirmed": actConfirmed,
            "axChanged": axChanged,
            "pixelChanged": pixelChanged,
            "latencyMs": latencyMs,
            "evidenceId": operationId
        ]
    }

    public func observe(maxDepth: Int, role: String?) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        let snapshot: AxTreeSnapshot
        do {
            snapshot = try channel.treeSnapshot(maxDepth: maxDepth)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }
        let roots: [AxNode]
        let nodeCount: Int
        let digest: String
        if let role {
            roots = EngineCore.prune(snapshot.roots, matchingRole: role)
            nodeCount = TreeDigest.nodeCount(roots)
            digest = (try? TreeDigest.digest(roots)) ?? snapshot.digest
        } else {
            roots = snapshot.roots
            nodeCount = snapshot.nodeCount
            digest = snapshot.digest
        }
        let treeData = try AxNode.arrayEncoder.encode(roots)
        let treeObject = try JSONSerialization.jsonObject(with: treeData)
        return [
            "axTree": treeObject,
            "nodeCount": nodeCount,
            "digest": digest,
            "latencyMs": snapshot.latencyMs
        ]
    }

    public func assertElement(
        selector: Selector,
        property: AssertionProperty,
        expected: StringOrBool
    ) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        guard let context = latestPack() else {
            // P0 §3.3：assert 证据的 signals 复用最近一次 act 的上下文，因此它不能
            // 成为会话的第一个操作。错误码保持 GP_E_NO_OPERATION（错误码表冻结），
            // 但 remedy 必须可执行——原文案"run act or assert_element first"对这条
            // 路径是自指的（真机踩过：用它核验设置面板时循环无解）。
            throw GPError(
                code: .noOperation,
                message: "no prior operation to reuse signal context from",
                remedy: "run act first — assert_element reuses the most recent act's signal context (P0 spec §3.3)"
            )
        }
        let actual: StringOrBool
        do {
            actual = try channel.readProperty(selector: selector, property: property)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }
        let passed = actual == expected
        let operationId = OperationID.generateLive()
        // Signal context is reused from the referenced operation (spec §3.3).
        let pack = EvidencePack(
            operationId: operationId,
            createdAt: nowISO(),
            attribution: context.attribution,
            circuitBreaker: context.circuitBreaker,
            signals: context.signals,
            assertion: Assertion(
                selector: selector,
                property: property,
                expected: expected,
                actual: actual,
                passed: passed
            )
        )
        store(pack)
        return [
            "passed": passed,
            "actual": Self.wireValue(actual),
            "operationId": operationId,
            "evidenceId": operationId
        ]
    }

    public func diagnose(operationId: String?) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        var target: EvidencePack
        if let operationId {
            guard let found = pack(withId: operationId) else {
                throw GPError(code: .noOperation, message: "unknown operationId \(operationId)")
            }
            target = found
        } else {
            guard let latest = latestPack() else {
                throw GPError(code: .noOperation, message: "no operation to diagnose")
            }
            target = latest
        }
        // P6 §3.1: late probe arrivals (async handlers finishing after the
        // act window) only become visible by diagnose time — refresh the
        // stored signal before classifying so T8 is decidable, then persist.
        if let inbox = probeInbox, let refreshed = inbox.refreshedHandlerProbe(for: target) {
            target.signals.handlerProbe = refreshed
            replace(target)
        }
        let (diagnosisClass, report) = Classifier.classify(target)
        var updated = target
        updated.diagnosis = Diagnosis(class: diagnosisClass, report: report)
        replace(updated)
        return [
            "class": diagnosisClass.rawValue,
            "report": [
                "path": report.path,
                "anomaly": report.anomaly,
                "evidence": report.evidence,
                "next": report.next
            ]
        ]
    }

    /// P6 §5.4: probe connectivity snapshot. Agents use this to learn whether
    /// T4/T5/T7/T8 verdicts are decidable for the attached app *before*
    /// spending a cycle, and to surface the GP_E_PROBE_UNAVAILABLE remedy.
    public func probeStatus() -> [String: Any] {
        let probes = probeInbox?.statusJSON() ?? []
        var attachedHasProbe = false
        if let inbox = probeInbox, let app = attachedApp, inbox.connection(for: app.pid) != nil {
            attachedHasProbe = true
        }
        return ["probes": probes, "attachedHasProbe": attachedHasProbe]
    }

    public func lastEvidence(operationId: String?) throws -> EvidencePack {
        if let operationId {
            // Two-level lookup: in-memory ring first, then the on-disk archive
            // so a daemon restart can still replay past evidence (spec v1.5 §9.3).
            if let found = pack(withId: operationId) {
                return found
            }
            if let onDisk = evidenceStore?.read(operationId: operationId) {
                return onDisk
            }
            // P1 v1.3: a lookup miss means "no such evidence in the bounded
            // history" — a distinct code from "no operation to diagnose".
            throw GPError(code: .noEvidence, message: "unknown operationId \(operationId)")
        }
        if let latest = latestPack() {
            return latest
        }
        // Memory is empty (fresh daemon / history evicted): fall back to the
        // most recently written archive entry so the audit trail survives.
        if let evidenceStore,
           let newestId = evidenceStore.lastOnDisk(),
           let newest = evidenceStore.read(operationId: newestId) {
            return newest
        }
        throw GPError(code: .noEvidence, message: "no evidence recorded yet")
    }

    public func shutdown() -> [String: Any] {
        shutdownRequested = true
        return ["bye": true]
    }

    // MARK: - P1 project registry (spec v1.4 §1)

    /// List all registered projects.
    public func projectList() -> [String: Any] {
        let entries: [[String: Any]] = projectRegistry.all.map { entry in
            var dict: [String: Any] = [
                "projectId": entry.projectId,
                "displayName": entry.displayName,
                "createdAt": entry.createdAt
            ]
            if let bundleId = entry.bundleId { dict["bundleId"] = bundleId }
            if let pid = entry.pid { dict["pid"] = Int(pid) }
            if let v = entry.recipeConfigPath { dict["recipeConfigPath"] = v }
            if let v = entry.calibrationAssetsPath { dict["calibrationAssetsPath"] = v }
            if let v = entry.evidenceStoragePath { dict["evidenceStoragePath"] = v }
            return dict
        }
        return ["projects": entries]
    }

    /// Register or update a project.
    public func projectSet(
        projectId: String?,
        displayName: String,
        bundleId: String?,
        pid: Int32?,
        recipeConfigPath: String?,
        calibrationAssetsPath: String?,
        evidenceStoragePath: String?
    ) throws -> [String: Any] {
        let entry: ProjectEntry
        if let projectId {
            // Update existing.
            entry = try projectRegistry.update(
                projectId: projectId,
                displayName: displayName,
                bundleId: bundleId,
                pid: pid,
                recipeConfigPath: recipeConfigPath,
                calibrationAssetsPath: calibrationAssetsPath,
                evidenceStoragePath: evidenceStoragePath
            )
        } else {
            // Create new.
            entry = try projectRegistry.create(
                displayName: displayName,
                bundleId: bundleId,
                pid: pid,
                recipeConfigPath: recipeConfigPath,
                calibrationAssetsPath: calibrationAssetsPath,
                evidenceStoragePath: evidenceStoragePath,
                now: clock
            )
        }
        var dict: [String: Any] = [
            "projectId": entry.projectId,
            "displayName": entry.displayName,
            "createdAt": entry.createdAt
        ]
        if let bundleId = entry.bundleId { dict["bundleId"] = bundleId }
        if let pid = entry.pid { dict["pid"] = Int(pid) }
        if let v = entry.recipeConfigPath { dict["recipeConfigPath"] = v }
        if let v = entry.calibrationAssetsPath { dict["calibrationAssetsPath"] = v }
        if let v = entry.evidenceStoragePath { dict["evidenceStoragePath"] = v }
        return ["project": dict]
    }

    /// Get a project by ID.
    public func projectGet(projectId: String) throws -> [String: Any] {
        guard let entry = projectRegistry.get(projectId) else {
            throw GPError(code: .notFound, message: "unknown projectId \(projectId)")
        }
        var dict: [String: Any] = [
            "projectId": entry.projectId,
            "displayName": entry.displayName,
            "createdAt": entry.createdAt
        ]
        if let bundleId = entry.bundleId { dict["bundleId"] = bundleId }
        if let pid = entry.pid { dict["pid"] = Int(pid) }
        if let v = entry.recipeConfigPath { dict["recipeConfigPath"] = v }
        if let v = entry.calibrationAssetsPath { dict["calibrationAssetsPath"] = v }
        if let v = entry.evidenceStoragePath { dict["evidenceStoragePath"] = v }
        return ["project": dict]
    }

    // MARK: - P5 evidence maintenance (spec v5.0 §9.3)

    /// Age-prune evidence, either on the active store's directory (nil
    /// projectId) or on a registered project's evidenceStoragePath directory.
    /// Returns the number of entries removed; a missing directory counts 0.
    /// Storage-layer primitive — no socket frame, no method-table change.
    public func pruneEvidence(projectId: String?, olderThanDays: Int) throws -> Int {
        let dir: String
        if let projectId {
            guard let entry = projectRegistry.get(projectId) else {
                throw GPError(code: .notFound, message: "unknown projectId \(projectId)")
            }
            dir = entry.evidenceStoragePath ?? EvidenceStore.defaultDirectory
        } else {
            dir = evidenceStore?.directory ?? EvidenceStore.defaultDirectory
        }
        // A temporary store over the resolved directory — never mutates the
        // active store's own directory/retention state (P5 §9.3). The engine's
        // injected clock drives age judgment, keeping TTL deterministic in
        // tests that pin `now`.
        return EvidenceStore(directory: dir, now: clock).prune(olderThanDays: olderThanDays)
    }

    // MARK: - P1 snapshot/restore (spec v1.1 §1)

    /// Captures a digest-only baseline of the attached app's AX tree and
    /// stores it in the bounded in-memory snapshot store (§1.2 snapshot).
    public func snapshot(maxDepth: Int) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        let started = clock()
        let tree: AxTreeSnapshot
        do {
            tree = try channel.treeSnapshot(maxDepth: maxDepth)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }
        // P6 §5.5: probe checkpoint export gives snapshots a *real* tier-1
        // probe payload (gpz1-json-v1). The P5 scripted `snapshotProbe` hook
        // keeps priority so existing unit tests stay verbatim; daemon ships it
        // nil. Export failure (no connection / no capability / digest mismatch
        // / timeout) keeps probeInfo nil — rollback_full then refuses honestly.
        let snapshotId = OperationID.generateSnapshotLive()
        var probeInfo = snapshotProbe?()
        if probeInfo == nil, let inbox = probeInbox, let pid = attachedApp?.pid,
           let connection = inbox.connection(for: pid),
           connection.hello.capabilities.contains("checkpoint"),
           let exported = inbox.checkpointExport(pid: pid, ref: snapshotId) {
            probeInfo = SnapshotProbeInfo(
                probeVersion: connection.hello.probeVersion,
                exportedDomains: exported.domains.keys.sorted(),
                stateDigest: exported.digest,
                checkpointFormat: "gpz1-json-v1",
                capturedAt: nowISO()
            )
        }
        let snapshot = AppStateSnapshot(
            snapshotId: snapshotId,
            treeDigest: tree.digest,
            nodeCount: tree.nodeCount,
            capturedAt: nowISO(),
            probeInfo: probeInfo
        )
        storeSnapshot(snapshot)
        let latencyMs = clock().timeIntervalSince(started) * 1000
        return [
            "snapshotId": snapshot.snapshotId,
            "treeDigest": snapshot.treeDigest,
            "nodeCount": snapshot.nodeCount,
            "capturedAt": snapshot.capturedAt,
            "latencyMs": latencyMs
        ]
    }

    /// Restores from a stored snapshot. With `steps`, replays them via the
    /// standard act pipeline (tier-2 ffwd); without steps, compares the
    /// current tree digest against the baseline. Tier-1 full snapshot
    /// restore requires the Z5 probe SDK and is rejected by design (§1.2).
    public func restore(
        snapshotId: String,
        steps: [(Selector, Action)]?,
        mode: String? = nil
    ) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        if mode == "restore_snapshot" {
            // Tier-1 full-snapshot restore depends on the Z5 probe SDK
            // (综述 §5.7 不可快照区). Not entered in P1 — surface the honest
            // boundary as a structured error with a concrete remedy.
            throw GPError(
                code: .restoreUnsupported,
                message: "mode 'restore_snapshot' (tier-1 full snapshot restore) requires the Z5 probe SDK, which is not in P1"
            )
        }
        if mode == "rollback_full" {
            // P5 v5.0 §6.4 tier-1 pipeline: noSnapshot invariant first, then
            // no-probe → structured refusal (same code/semantics as the P1
            // tier-1 boundary), probe present → plan + validate. A returned
            // plan carries rollbackExecuted: false — the rollback execution
            // surface is the probe runtime, which this daemon does not ship.
            guard let snapshot = snapshot(withId: snapshotId) else {
                throw GPError(code: .noSnapshot, message: "unknown snapshotId \(snapshotId)")
            }
            guard let probe = snapshot.probeInfo else {
                throw GPError(
                    code: .restoreUnsupported,
                    message: "tier-1 restore requires a Z5 probe payload; snapshot '\(snapshotId)' has none — attach the probe and re-snapshot"
                )
            }
            guard let plan = RestorePipeline.plan(snapshot: snapshot) else {
                throw GPError(
                    code: .restoreUnsupported,
                    message: "tier-1 restore plan unbuildable for snapshot '\(snapshotId)' (cyclic or inconsistent probe domains)"
                )
            }
            let validation = RestorePipeline.validate(plan: plan, snapshot: snapshot)
            guard validation.valid else {
                throw GPError(
                    code: .restoreUnsupported,
                    message: "tier-1 restore plan invalid for snapshot '\(snapshotId)': \(validation.issues.joined(separator: "; "))"
                )
            }
            registerRestoreApproval(snapshotId: snapshotId, mode: "rollback_full", hasSteps: false)

            // P6 §5.5: gpz1 checkpoints have a live execution surface — the
            // probe retained the export under this snapshot's ref, so the
            // daemon can command a rewrite and verify the post-restore digest
            // against the plan. Any other format keeps the P5 plan-only answer.
            if probe.checkpointFormat == "gpz1-json-v1",
               let inbox = probeInbox, let pid = attachedApp?.pid,
               inbox.connection(for: pid) != nil {
                if let post = inbox.checkpointRestore(pid: pid, ref: snapshot.snapshotId, domains: plan.domains) {
                    return [
                        "snapshotId": snapshot.snapshotId,
                        "baselineTreeDigest": snapshot.treeDigest,
                        "domains": plan.domains,
                        "postStateDigest": post,
                        "rollbackExecuted": true,
                        "executionSurface": "gp-probe",
                        "probeVersion": probe.probeVersion,
                        "consistent": post == plan.expectedStateDigest
                    ]
                }
                throw GPError(
                    code: .restoreUnsupported,
                    message: "tier-1 restore execution refused by probe: \(inbox.lastResultError ?? "no result")"
                )
            }
            return [
                "snapshotId": snapshot.snapshotId,
                "baselineTreeDigest": snapshot.treeDigest,
                "plan": [
                    "domains": plan.domains,
                    "steps": plan.steps.map { step -> [String: Any] in
                        [
                            "domain": step.domain,
                            "checkpointRef": step.checkpointRef,
                            "action": step.action,
                            "preconditions": step.preconditions
                        ]
                    },
                    "expectedStateDigest": plan.expectedStateDigest,
                    "domainCount": plan.domainCount
                ],
                "planValid": true,
                "rollbackExecuted": false,
                "executionSurface": "z5-probe-runtime",
                "probeVersion": probe.probeVersion,
                "consistent": true
            ]
        }
        guard let snapshot = snapshot(withId: snapshotId) else {
            throw GPError(code: .noSnapshot, message: "unknown snapshotId \(snapshotId)")
        }

        // P5 §3.5: high-risk approval registration before every executed
        // restore form (compare / ffwd / rollback_full). Registration is
        // best-effort — the ledger is an audit surface, never a gate: a write
        // failure or rejected reason must not change restore semantics.
        registerRestoreApproval(snapshotId: snapshotId, mode: mode, hasSteps: steps != nil)

        guard let steps else {
            // Baseline-consistency form: compare current tree against the
            // snapshot digest. confirmed/total stay 0 — no step ran.
            let tree = try currentTreeDigest()
            let consistent = tree.digest == snapshot.treeDigest
            return [
                "snapshotId": snapshot.snapshotId,
                "baselineTreeDigest": snapshot.treeDigest,
                "steps": [],
                "confirmed": 0,
                "total": 0,
                "targetDigest": tree.digest,
                "consistent": consistent
            ]
        }

        var stepResults: [[String: Any]] = []
        stepResults.reserveCapacity(steps.count)
        for (index, step) in steps.enumerated() {
            do {
                let outcome = try act(selector: step.0, action: step.1)
                // act() throws GP_E_ACT_FAILED on rejection; reaching here
                // means the step was confirmed.
                stepResults.append([
                    "selector": ["role": step.0.role, "title": step.0.title ?? "", "identifier": step.0.identifier ?? ""],
                    "action": step.1.rawValue,
                    "actConfirmed": true,
                    "operationId": outcome["operationId"] as? String ?? ""
                ])
            } catch {
                throw GPError(
                    code: .restoreStepFailed,
                    message: "ffwd step \(index) failed: \(error.localizedDescription)"
                )
            }
        }

        // Post-roll-forward target tree for the consistency reference.
        let target = try? currentTreeDigest()
        return [
            "snapshotId": snapshot.snapshotId,
            "baselineTreeDigest": snapshot.treeDigest,
            "steps": stepResults,
            "confirmed": stepResults.count,
            "total": steps.count,
            "targetDigest": target?.digest as Any,
            "consistent": target.map { $0.digest == snapshot.treeDigest } ?? false
        ]
    }

    // MARK: - P1 snapshot/restore internals

    /// P5 §3.5: registers one high-risk approval record for an executed
    /// restore. Best-effort and non-blocking by design.
    private func registerRestoreApproval(snapshotId: String, mode: String?, hasSteps: Bool) {
        let label = mode ?? (hasSteps ? "ffwd" : "compare")
        approvalGate?.append(
            operationRef: snapshotId,
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "daemon:auto",
            reason: "restore executed: \(label)"
        )
    }

    private func snapshot(withId snapshotId: String) -> AppStateSnapshot? {
        snapshots.first { $0.snapshotId == snapshotId }
    }

    private func storeSnapshot(_ snapshot: AppStateSnapshot) {
        snapshots.append(snapshot)
        if snapshots.count > EngineCore.snapshotHistoryLimit {
            snapshots.removeFirst(snapshots.count - EngineCore.snapshotHistoryLimit)
        }
    }

    private func currentTreeDigest() throws -> AxTreeSnapshot {
        // Tree capture failures surface as GP_E_AX_UNAVAILABLE, matching
        // observe's error vocabulary (§1.2 restore error codes).
        do {
            return try channel.treeSnapshot(maxDepth: Self.defaultObserveDepth)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }
    }

    // MARK: - Internals

    static let defaultObserveDepth = 6

    private func attachResult(_ app: AttachedApp) -> [String: Any] {
        var result: [String: Any] = [
            "pid": Int(app.pid),
            "appName": app.appName
        ]
        if let bundleId = app.bundleId {
            result["bundleId"] = bundleId
        }
        return result
    }

    private func latestPack() -> EvidencePack? {
        history.last
    }

    private func pack(withId operationId: String) -> EvidencePack? {
        history.last { $0.operationId == operationId }
    }

    private func store(_ pack: EvidencePack) {
        history.append(pack)
        if history.count > EngineCore.historyLimit {
            history.removeFirst(history.count - EngineCore.historyLimit)
        }
        persist(pack)
    }

    private func replace(_ pack: EvidencePack) {
        if let index = history.lastIndex(where: { $0.operationId == pack.operationId }) {
            history[index] = pack
        } else {
            history.append(pack)
        }
        persist(pack)
    }

    /// Best-effort archive write (spec v1.5 §9.3): never throws so a disk
    /// fault cannot break the main pipeline. When persistence is disabled
    /// (evidenceStore == nil) this is a no-op.
    private func persist(_ pack: EvidencePack) {
        evidenceStore?.write(pack)
    }

    private static func axChanged(before: AxTreeSnapshot?, after: AxTreeSnapshot?) -> Bool {
        guard let before, let after else { return false }
        return before.digest != after.digest
    }

    private static func actRejectReason(_ error: ChannelError) -> String {
        if case .actRejected(let reason) = error {
            return "action rejected: \(reason)"
        }
        return "action failed: \(error)"
    }

    /// Maps channel failures onto protocol error codes (P0 spec §3.4).
    static func map(_ error: ChannelError) -> GPError {
        switch error {
        case .axUnavailable(let reason):
            return GPError(code: .axUnavailable, message: reason)
        case .appNotFound:
            return GPError(code: .appNotFound, message: "no running app matches the given bundleId/pid")
        case .actRejected(let reason):
            return GPError(code: .actFailed, message: "action rejected: \(reason)")
        case .assertTargetNotFound:
            return GPError(code: .assertTargetNotFound, message: "no element matches the selector")
        case .attributeUnavailable(let reason):
            return GPError(code: .assertTargetNotFound, message: reason)
        case .treeCaptureFailed(let reason):
            // 错误码保持 GP_E_AX_UNAVAILABLE（码表冻结），但 remedy 必须与**成因**
            // 一致：`treeCaptureFailed` 按定义是"通道活着、树抓取部分失败/超时"
            // （RuntimeChannel 注释），此时叫用户去授予辅助功能既是幻影指引又会
            // 把人引向死路（真机踩到：辅助功能已 granted 却被告知去 --grant-accessibility）。
            if Self.isBudgetFailure(reason) {
                return GPError(
                    code: .axUnavailable,
                    message: "tree capture failed: \(reason)",
                    remedy: "narrow the scope: retry observe/snapshot with a smaller maxDepth (1...10) or a more specific selector; the AX channel is alive — only this capture hit its time budget. Do not re-grant Accessibility: verify the seat with `glasspaned --check-accessibility`"
                )
            }
            return GPError(code: .axUnavailable, message: "tree capture failed: \(reason)")
        case .pixelCaptureDenied:
            // 窗口捕获失败的成因是屏幕录制席位（或窗口不在屏），不是辅助功能。
            return GPError(
                code: .axUnavailable,
                message: "window capture unavailable",
                remedy: "grant Screen Recording to the daemon (System Settings > Privacy & Security > Screen Recording), then restart the daemon to pick it up; verify with `glasspaned --check-screen-permission`. Until then pixelDiff stays null and T6 degrades to INCONCLUSIVE (P1 v1.0 §5)"
            )
        case .pingTimeout:
            return GPError(code: .actFailed, message: "app unresponsive (AX ping timeout)")
        }
    }

    /// 是否为"时间预算耗尽"类失败（而非权限缺失）。按 reason 文本判定，与
    /// `AXChannel` 的预算措辞同源；未知形态保守回落默认 remedy（不硬猜）。
    static func isBudgetFailure(_ reason: String) -> Bool {
        let lowered = reason.lowercased()
        return lowered.contains("budget") || lowered.contains("timeout") || lowered.contains("timed out")
    }

    /// Keeps subtrees rooted at nodes whose role matches (observe role filter).
    static func prune(_ roots: [AxNode], matchingRole role: String) -> [AxNode] {
        var result: [AxNode] = []
        for node in roots {
            if node.role == role {
                result.append(node)
            } else {
                result.append(contentsOf: prune(node.children, matchingRole: role))
            }
        }
        return result
    }

    private static func wireValue(_ value: StringOrBool) -> Any {
        switch value {
        case .string(let string): return string
        case .bool(let bool): return bool
        }
    }
}

extension AxNode {
    static let arrayEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}
