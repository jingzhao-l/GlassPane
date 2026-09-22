import Foundation

// MARK: - Primitive value wrappers

/// Explicit JSON null. Z5 channel has no in-process probes; handler/state
/// signals are encoded as *required* nulls (honest absence, P0 spec §4.2).
public struct JSONNull: Codable, Equatable {
    public init() {}

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard container.decodeNil() else {
            throw DecodingError.typeMismatch(
                JSONNull.self,
                .init(codingPath: decoder.codingPath, debugDescription: "expected null")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encodeNil()
    }
}

/// JSON `string | boolean` union used by assertion expected/actual.
public enum StringOrBool: Codable, Equatable {
    case string(String)
    case bool(Bool)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let boolValue = try? container.decode(Bool.self) {
            self = .bool(boolValue)
        } else if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
        } else {
            throw DecodingError.typeMismatch(
                StringOrBool.self,
                .init(codingPath: decoder.codingPath, debugDescription: "expected string or boolean")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        }
    }
}

// MARK: - Enumerations (raw values are the wire contract)

public enum AttributionLevel: String, Codable {
    case soft, strong, weak
}

/// Integer 0–3 is enforced by the raw-value enum: decoding 4 throws.
public enum CircuitBreakerLevel: Int, Codable, Equatable {
    case normal = 0
    case degraded = 1
    case actFailedChannelAlive = 2
    case channelFault = 3
}

public enum Action: String, Codable, CaseIterable {
    case press, increment, decrement
    case showMenu, confirm, cancel, pick
}

public enum AssertionProperty: String, Codable, CaseIterable {
    case title, value, role, enabled, focused
}

public enum DiagnosisClass: String, Codable {
    case t0 = "T0", t1 = "T1", t2 = "T2", t3 = "T3", t4 = "T4"
    case t5 = "T5", t6 = "T6", t7 = "T7", t8 = "T8", t9 = "T9"
    case noAnomaly = "NO_ANOMALY"
    case inconclusive = "INCONCLUSIVE"
}

// MARK: - Signal structures

public struct Selector: Codable, Equatable {
    public let role: String
    public let title: String?
    public let identifier: String?

    public init(role: String, title: String? = nil, identifier: String? = nil) {
        self.role = role
        self.title = title
        self.identifier = identifier
    }
}

public struct Bounds: Codable, Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct ActSignal: Codable, Equatable {
    public let selector: Selector
    public let action: Action
    public let actConfirmed: Bool

    public init(selector: Selector, action: Action, actConfirmed: Bool) {
        self.selector = selector
        self.action = action
        self.actConfirmed = actConfirmed
    }
}

public struct AxEventSignal: Codable, Equatable {
    public let treeDigestBefore: String
    public let treeDigestAfter: String
    public let nodeCount: Int
    public let axChanged: Bool
    public let latencyMs: Double

    public init(
        treeDigestBefore: String,
        treeDigestAfter: String,
        nodeCount: Int,
        axChanged: Bool,
        latencyMs: Double
    ) {
        self.treeDigestBefore = treeDigestBefore
        self.treeDigestAfter = treeDigestAfter
        self.nodeCount = nodeCount
        self.axChanged = axChanged
        self.latencyMs = latencyMs
    }
}

public struct PixelDiffSignal: Codable, Equatable {
    public let changedPixelRatio: Double
    public let bounds: Bounds?
    public let windowId: Int

    public init(changedPixelRatio: Double, bounds: Bounds?, windowId: Int) {
        self.changedPixelRatio = changedPixelRatio
        self.bounds = bounds
        self.windowId = windowId
    }

    enum CodingKeys: String, CodingKey {
        case changedPixelRatio, bounds, windowId
    }

    /// `bounds` stays a required, nullable key (P0 §4.2): a nil bounds is the
    /// measured answer "no pixel changed", not an unknown field. The synthesized
    /// encoder omitted the key whenever bounds was nil, which made every
    /// zero-diff pack fail the frozen schema's required list on read; absence is
    /// therefore written as explicit null, the same way `Signals` writes
    /// `handlerProbe`/`stateDiff`.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(changedPixelRatio, forKey: .changedPixelRatio)
        if let bounds {
            try container.encode(bounds, forKey: .bounds)
        } else {
            try container.encodeNil(forKey: .bounds)
        }
        try container.encode(windowId, forKey: .windowId)
    }
}

public struct ResponsivenessSignal: Codable, Equatable {
    public let responsive: Bool
    public let pingMs: Double

    public init(responsive: Bool, pingMs: Double) {
        self.responsive = responsive
        self.pingMs = pingMs
    }
}

public struct CrashSignal: Codable, Equatable {
    public let processAliveBefore: Bool
    public let processAliveAfter: Bool

    public init(processAliveBefore: Bool, processAliveAfter: Bool) {
        self.processAliveBefore = processAliveBefore
        self.processAliveAfter = processAliveAfter
    }
}

// MARK: - Probe signals (P6 spec v6.0 §3.1, Z1–Z4.5 channel)

/// One handler hit localized by source location (Z1 macro instrumentation).
public struct HandlerRef: Codable, Equatable {
    public let file: String
    public let line: Int

    public init(file: String, line: Int) {
        self.file = file
        self.line = line
    }
}

/// Handler-probe signal: present when a GlassPaneProbe connection was alive
/// for the act window (§2/§3). `lateCount` is refreshed at diagnose time
/// (async arrivals within the 2s grace window, T8 evidence).
public struct HandlerProbeSignal: Codable, Equatable {
    public static let maxHandlers = 32

    public let probeVersion: String
    public let hitCount: Int
    public let handlers: [HandlerRef]
    public let lateCount: Int

    public init(probeVersion: String, hitCount: Int, handlers: [HandlerRef], lateCount: Int = 0) {
        self.probeVersion = probeVersion
        self.hitCount = hitCount
        self.handlers = Array(handlers.prefix(Self.maxHandlers))
        self.lateCount = lateCount
    }
}

public enum StateDiffSource: String, Codable {
    case z1Macro = "z1-macro"
    case z2Mirror = "z2-mirror"
    case z3KVC = "z3-kvc"
}

/// One before/after pair; values are canonical strings (≤1 KiB truncated by
/// the probe side).
public struct StateEntry: Codable, Equatable {
    public let key: String
    public let before: String
    public let after: String

    public init(key: String, before: String, after: String) {
        self.key = key
        self.before = before
        self.after = after
    }
}

public struct StateDiffSignal: Codable, Equatable {
    public static let maxEntries = 64

    public let source: StateDiffSource
    public let changed: Bool
    public let entries: [StateEntry]

    public init(source: StateDiffSource, changed: Bool, entries: [StateEntry]) {
        self.source = source
        self.changed = changed
        self.entries = Array(entries.sorted { $0.key < $1.key }.prefix(Self.maxEntries))
    }
}

/// Decodes a strictly-optional object signal: absent key -> nil;
/// present-but-null or wrong shape -> throws (mirrors the JSON Schema which
/// allows absence but not null for object signals).
extension KeyedDecodingContainer {
    public func decodePresent<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T? {
        guard contains(key) else { return nil }
        return try decode(T.self, forKey: key)
    }
}

public struct Signals: Codable, Equatable {
    public var act: ActSignal
    public var axEvent: AxEventSignal?
    /// P6 §3.1: `null | object`. The key is always present; null remains the
    /// honest absence marker when no probe connection served the window.
    public var handlerProbe: HandlerProbeSignal?
    public var stateDiff: StateDiffSignal?
    public var pixelDiff: PixelDiffSignal?
    public var responsiveness: ResponsivenessSignal?
    public var crash: CrashSignal?

    public init(
        act: ActSignal,
        axEvent: AxEventSignal? = nil,
        handlerProbe: HandlerProbeSignal? = nil,
        stateDiff: StateDiffSignal? = nil,
        pixelDiff: PixelDiffSignal? = nil,
        responsiveness: ResponsivenessSignal? = nil,
        crash: CrashSignal? = nil
    ) {
        self.act = act
        self.axEvent = axEvent
        self.handlerProbe = handlerProbe
        self.stateDiff = stateDiff
        self.pixelDiff = pixelDiff
        self.responsiveness = responsiveness
        self.crash = crash
    }

    enum CodingKeys: String, CodingKey {
        case act, axEvent, handlerProbe, stateDiff, pixelDiff, responsiveness, crash
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        act = try container.decode(ActSignal.self, forKey: .act)
        axEvent = try container.decodePresent(AxEventSignal.self, forKey: .axEvent)
        // Required keys, nullable values: JSON null -> nil, object -> decoded,
        // wrong shape -> throws (mirrors the JSON Schema oneOf [null, object]).
        // Absence is a decode error: the keys stay required (§3.1).
        guard container.contains(.handlerProbe) else {
            throw DecodingError.keyNotFound(
                CodingKeys.handlerProbe,
                .init(codingPath: container.codingPath, debugDescription: "handlerProbe is required (null allowed)")
            )
        }
        guard container.contains(.stateDiff) else {
            throw DecodingError.keyNotFound(
                CodingKeys.stateDiff,
                .init(codingPath: container.codingPath, debugDescription: "stateDiff is required (null allowed)")
            )
        }
        handlerProbe = try container.decodeIfPresent(HandlerProbeSignal.self, forKey: .handlerProbe)
        stateDiff = try container.decodeIfPresent(StateDiffSignal.self, forKey: .stateDiff)
        pixelDiff = try container.decodePresent(PixelDiffSignal.self, forKey: .pixelDiff)
        responsiveness = try container.decodePresent(ResponsivenessSignal.self, forKey: .responsiveness)
        crash = try container.decodePresent(CrashSignal.self, forKey: .crash)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(act, forKey: .act)
        try container.encodeIfPresent(axEvent, forKey: .axEvent)
        if let handlerProbe {
            try container.encode(handlerProbe, forKey: .handlerProbe)
        } else {
            try container.encodeNil(forKey: .handlerProbe)
        }
        if let stateDiff {
            try container.encode(stateDiff, forKey: .stateDiff)
        } else {
            try container.encodeNil(forKey: .stateDiff)
        }
        try container.encodeIfPresent(pixelDiff, forKey: .pixelDiff)
        try container.encodeIfPresent(responsiveness, forKey: .responsiveness)
        try container.encodeIfPresent(crash, forKey: .crash)
    }
}

public struct Attribution: Codable, Equatable {
    public var level: AttributionLevel
    public var contaminated: Bool

    public init(level: AttributionLevel, contaminated: Bool) {
        self.level = level
        self.contaminated = contaminated
    }
}

public struct CircuitBreaker: Codable, Equatable {
    public var level: CircuitBreakerLevel
    public var reason: String?

    public init(level: CircuitBreakerLevel, reason: String? = nil) {
        self.level = level
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey {
        case level, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        level = try container.decode(CircuitBreakerLevel.self, forKey: .level)
        reason = try container.decodePresent(String.self, forKey: .reason)
    }
}

public struct Assertion: Codable, Equatable {
    public let kind: String
    public let selector: Selector
    public let property: AssertionProperty
    public let expected: StringOrBool
    public let actual: StringOrBool
    public let passed: Bool

    public init(
        selector: Selector,
        property: AssertionProperty,
        expected: StringOrBool,
        actual: StringOrBool,
        passed: Bool
    ) {
        self.kind = "element_property"
        self.selector = selector
        self.property = property
        self.expected = expected
        self.actual = actual
        self.passed = passed
    }

    enum CodingKeys: String, CodingKey {
        case kind, selector, property, expected, actual, passed
    }
}

public struct DiagnosisReport: Codable, Equatable {
    public let path: String
    public let anomaly: String
    public let evidence: String
    public let next: String

    public init(path: String, anomaly: String, evidence: String, next: String) {
        self.path = path
        self.anomaly = anomaly
        self.evidence = evidence
        self.next = next
    }
}

public struct Diagnosis: Codable, Equatable {
    public let `class`: DiagnosisClass
    public let report: DiagnosisReport

    public init(`class`: DiagnosisClass, report: DiagnosisReport) {
        self.class = `class`
        self.report = report
    }

    enum CodingKeys: String, CodingKey {
        case `class` = "class"
        case report
    }
}

// MARK: - Evidence pack

public struct EvidencePack: Codable, Equatable {
    public static let schemaVersionConst = "glasspane.evidence/0.1"
    /// 冻结（Phase B 入口第 0 步）读取兼容：draft 期落盘的历史包仍可解码，
    /// 新写入恒用 v0.1。draft 字符串自此只读不写。
    public static let legacySchemaVersions: Set<String> = ["glasspane.evidence/0.1-draft"]

    public let schemaVersion: String
    public let operationId: String
    public let createdAt: String
    public var attribution: Attribution
    public var circuitBreaker: CircuitBreaker
    public var signals: Signals
    public var assertion: Assertion?
    public var diagnosis: Diagnosis?

    public init(
        schemaVersion: String = schemaVersionConst,
        operationId: String,
        createdAt: String,
        attribution: Attribution,
        circuitBreaker: CircuitBreaker,
        signals: Signals,
        assertion: Assertion? = nil,
        diagnosis: Diagnosis? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.operationId = operationId
        self.createdAt = createdAt
        self.attribution = attribution
        self.circuitBreaker = circuitBreaker
        self.signals = signals
        self.assertion = assertion
        self.diagnosis = diagnosis
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion, operationId, createdAt, attribution
        case circuitBreaker, signals, assertion, diagnosis
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(String.self, forKey: .schemaVersion)
        operationId = try container.decode(String.self, forKey: .operationId)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        attribution = try container.decode(Attribution.self, forKey: .attribution)
        circuitBreaker = try container.decode(CircuitBreaker.self, forKey: .circuitBreaker)
        signals = try container.decode(Signals.self, forKey: .signals)
        // Null and absent both decode to nil; encoding always writes the key
        // (null when nil) so fixture roundtrips preserve the explicit shape.
        assertion = try container.decodeIfPresent(Assertion.self, forKey: .assertion)
        diagnosis = try container.decodeIfPresent(Diagnosis.self, forKey: .diagnosis)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(operationId, forKey: .operationId)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(attribution, forKey: .attribution)
        try container.encode(circuitBreaker, forKey: .circuitBreaker)
        try container.encode(signals, forKey: .signals)
        try container.encode(assertion, forKey: .assertion)
        try container.encode(diagnosis, forKey: .diagnosis)
    }
}

// MARK: - Invariant validation (patterns Codable cannot express)

public enum EvidencePackError: Error, Equatable {
    case badSchemaVersion(String)
    case badOperationId(String)
    case badCreatedAt(String)
}

public extension EvidencePack {
    private static let operationIdRegex = try! NSRegularExpression(
        pattern: "^op_[0-9A-HJKMNP-TV-Z]{26}$"
    )
    private static let createdAtRegex = try! NSRegularExpression(
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
    )

    /// Validates the pattern/const invariants the JSON Schema enforces on
    /// the TS side. Call after any decode of untrusted JSON.
    func validateInvariants() throws {
        guard schemaVersion == Self.schemaVersionConst
            || Self.legacySchemaVersions.contains(schemaVersion) else {
            throw EvidencePackError.badSchemaVersion(schemaVersion)
        }
        let opRange = NSRange(operationId.startIndex..., in: operationId)
        guard Self.operationIdRegex.firstMatch(in: operationId, range: opRange) != nil else {
            throw EvidencePackError.badOperationId(operationId)
        }
        let createdRange = NSRange(createdAt.startIndex..., in: createdAt)
        guard Self.createdAtRegex.firstMatch(in: createdAt, range: createdRange) != nil else {
            throw EvidencePackError.badCreatedAt(createdAt)
        }
    }

    static func decodeAndValidate(_ data: Data) throws -> EvidencePack {
        let pack = try JSONDecoder().decode(EvidencePack.self, from: data)
        try pack.validateInvariants()
        return pack
    }
}

// MARK: - JSON (de)serialization helpers

public extension EvidencePack {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    func jsonData() throws -> Data {
        try Self.encoder.encode(self)
    }
}

// MARK: - Decision log entry (C35 dual-binding, spec v3.0 §21.3)

public enum DecisionOutcome: String, Codable {
    case pass, fail, blocked, inconclusive
}

public struct DecisionLogEntry: Codable, Equatable {
    public static let summaryMaxLength = 2048

    public let entryId: String        // ^dl_[0-9A-HJKMNP-TV-Z]{26}$
    public let sequence: Int          // ≥ 0
    public let prevEntryHash: String  // ^([0-9a-f]{64})?$（创世条目为空串）
    public let operationId: String?   // 可选，^op_[0-9A-HJKMNP-TV-Z]{26}$；编码时省略而非写 null
    public let summary: String        // ≤ summaryMaxLength
    public let outcome: DecisionOutcome
    public let createdAt: String      // ISO-8601 毫秒 UTC

    public init(
        entryId: String,
        sequence: Int,
        prevEntryHash: String,
        operationId: String? = nil,
        summary: String,
        outcome: DecisionOutcome,
        createdAt: String
    ) {
        self.entryId = entryId
        self.sequence = sequence
        self.prevEntryHash = prevEntryHash
        self.operationId = operationId
        self.summary = summary
        self.outcome = outcome
        self.createdAt = createdAt
    }
}

// MARK: - Decision log entry invariants (patterns Codable cannot express)

public enum DecisionLogEntryError: Error, Equatable {
    case badEntryId(String)
    case badPrevEntryHash(String)
    case badOperationId(String)
    case badCreatedAt(String)
    case badSequence(Int)
    case summaryTooLong(Int)
}

public extension DecisionLogEntry {
    private static let entryIdRegex = try! NSRegularExpression(
        pattern: "^dl_[0-9A-HJKMNP-TV-Z]{26}$"
    )
    private static let prevEntryHashRegex = try! NSRegularExpression(
        pattern: "^([0-9a-f]{64})?$"
    )
    private static let operationIdRegex = try! NSRegularExpression(
        pattern: "^op_[0-9A-HJKMNP-TV-Z]{26}$"
    )
    private static let createdAtRegex = try! NSRegularExpression(
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
    )

    /// Validates the pattern/const invariants the JSON Schema enforces on the
    /// TS side (mirror of `kernel/schemas/decision-log-entry.schema.json`).
    /// Call after any decode of untrusted JSON.
    func validateInvariants() throws {
        guard Self.matches(Self.entryIdRegex, entryId) else {
            throw DecisionLogEntryError.badEntryId(entryId)
        }
        guard sequence >= 0 else {
            throw DecisionLogEntryError.badSequence(sequence)
        }
        guard Self.matches(Self.prevEntryHashRegex, prevEntryHash) else {
            throw DecisionLogEntryError.badPrevEntryHash(prevEntryHash)
        }
        if let operationId {
            guard Self.matches(Self.operationIdRegex, operationId) else {
                throw DecisionLogEntryError.badOperationId(operationId)
            }
        }
        guard summary.count <= Self.summaryMaxLength else {
            throw DecisionLogEntryError.summaryTooLong(summary.count)
        }
        guard Self.matches(Self.createdAtRegex, createdAt) else {
            throw DecisionLogEntryError.badCreatedAt(createdAt)
        }
    }

    private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
        let range = NSRange(value.startIndex..., in: value)
        return regex.firstMatch(in: value, range: range) != nil
    }

    static func decodeAndValidate(_ data: Data) throws -> DecisionLogEntry {
        let entry = try JSONDecoder().decode(DecisionLogEntry.self, from: data)
        try entry.validateInvariants()
        return entry
    }

    func jsonData() throws -> Data {
        try EvidencePack.encoder.encode(self)
    }
}
