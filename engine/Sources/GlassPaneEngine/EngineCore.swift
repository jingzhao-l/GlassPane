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

    public let version = "0.1.0"
    public let protocolVersion = "0"
    public private(set) var attachedApp: AttachedApp?
    public private(set) var shutdownRequested = false

    private let channel: RuntimeChannel
    private let clock: () -> Date
    private let settle: () -> Void
    private var history: [EvidencePack] = []

    public init(
        channel: RuntimeChannel,
        clock: @escaping () -> Date = { Date() },
        settle: (() -> Void)? = nil
    ) {
        self.channel = channel
        self.clock = clock
        self.settle = settle ?? { Thread.sleep(forTimeInterval: EngineCore.actSettleInterval) }
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
        [
            "engine": "glasspaned",
            "version": version,
            "protocolVersion": protocolVersion,
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "capabilities": ["act", "observe", "assert_element", "diagnose"]
        ]
    }

    public func attach(bundleId: String?, pid: pid_t?) throws -> [String: Any] {
        do {
            let app = try channel.attach(bundleId: bundleId, pid: pid)
            // Re-attach to the same app is idempotent; a different app
            // invalidates the evidence history.
            if attachedApp != app {
                attachedApp = app
                history.removeAll()
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
        let started = clock()

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

        let operationId = OperationID.generateLive()
        let pack = EvidencePack(
            operationId: operationId,
            createdAt: nowISO(),
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: level, reason: reason),
            signals: Signals(
                act: ActSignal(selector: selector, action: action, actConfirmed: actConfirmed),
                axEvent: axEvent,
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
            throw GPError(code: .noOperation, message: "no prior operation to reuse signal context from")
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
        let target: EvidencePack
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

    public func lastEvidence(operationId: String?) throws -> EvidencePack {
        if let operationId {
            guard let found = pack(withId: operationId) else {
                throw GPError(code: .noOperation, message: "unknown operationId \(operationId)")
            }
            return found
        }
        guard let latest = latestPack() else {
            throw GPError(code: .noOperation, message: "no evidence recorded yet")
        }
        return latest
    }

    public func shutdown() -> [String: Any] {
        shutdownRequested = true
        return ["bye": true]
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
    }

    private func replace(_ pack: EvidencePack) {
        if let index = history.lastIndex(where: { $0.operationId == pack.operationId }) {
            history[index] = pack
        } else {
            history.append(pack)
        }
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
            return GPError(code: .axUnavailable, message: "tree capture failed: \(reason)")
        case .pixelCaptureDenied:
            return GPError(code: .axUnavailable, message: "window capture unavailable")
        case .pingTimeout:
            return GPError(code: .actFailed, message: "app unresponsive (AX ping timeout)")
        }
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
