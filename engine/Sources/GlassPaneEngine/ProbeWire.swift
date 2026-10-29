import Foundation
import CryptoKit

// MARK: - Probe wire codec (P6 spec v6.0 §2)
//
// The probe socket carries newline-delimited UTF-8 JSON frames between
// GlassPaneProbe (inside the app under test, client) and the daemon (server).
// Frames are intentionally decoded into loose value types here — the daemon
// never imports the probe package (swift-syntax stays out of the build graph,
// §4), so the wire table in §2.2 is the single truth source both sides mirror.

public struct ProbeHello: Equatable {
    public let pid: Int32
    public let bundleId: String?
    public let appName: String
    public let probeVersion: String
    public let capabilities: [String]
    /// The probe's own drop counters, carried since §2.2 so a daemon-side
    /// "0 handler hits" can be read against what never arrived. **Optional on
    /// purpose**: a probe that does not report them must not be recorded as
    /// having dropped nothing — `nil` is "unreported", `0` is a measurement.
    public let droppedEvents: Int?
    public let droppedWrites: Int?
    public let rejectedKeys: Int?
    /// Frames the probe could not parse at all — distinct from `droppedEvents`,
    /// which are well-formed frames discarded for volume.
    public let droppedInboundFrames: Int?
    /// The read side gave up on a connection whose unterminated remainder passed
    /// the inbound line cap, so the rest of that stream was never framed.
    public let droppedInboundLines: Int?
    /// Values the probe shortened at its own byte cap on the way to the wire. This is a
    /// different fact from `droppedWrites`: a dropped frame means the daemon read nothing,
    /// a truncated value means it read a prefix of something. Folded into one number they
    /// can no longer be told apart, and a "state never changed" verdict is only readable
    /// against whichever of the two actually happened.
    public let truncatedValues: Int?
    /// How many handler durations the probe read but could not put on this wire, because
    /// they fall outside `0…Int32.max` (`GlassPaneProbe.emitHandler` counts them into
    /// `ProbeRuntime.durationOverflowFrameType` frames instead of shipping a value the
    /// daemon's clamp would refuse). Same optional rule as the counters above: `nil` is
    /// "this probe never reported it", `0` is a measurement that nothing overflowed — so
    /// a reader has to be able to tell them apart, which is why a missing key stays
    /// missing through `counter` rather than folding to `0`.
    public let durationOverflowCount: Int?

    public init(
        pid: Int32,
        bundleId: String? = nil,
        appName: String,
        probeVersion: String,
        capabilities: [String],
        droppedEvents: Int? = nil,
        droppedWrites: Int? = nil,
        rejectedKeys: Int? = nil,
        droppedInboundFrames: Int? = nil,
        droppedInboundLines: Int? = nil,
        truncatedValues: Int? = nil,
        durationOverflowCount: Int? = nil
    ) {
        self.pid = pid
        self.bundleId = bundleId
        self.appName = appName
        self.probeVersion = probeVersion
        self.capabilities = capabilities
        self.droppedEvents = droppedEvents
        self.droppedWrites = droppedWrites
        self.rejectedKeys = rejectedKeys
        self.droppedInboundFrames = droppedInboundFrames
        self.droppedInboundLines = droppedInboundLines
        self.truncatedValues = truncatedValues
        self.durationOverflowCount = durationOverflowCount
    }
}

public enum ProbeInboundFrame: Equatable {
    case hello(ProbeHello)
    /// Z1 handler event. `durationNs` present only on the >1ms follow-up frame.
    case handler(file: String, line: Int, ts: Double, durationNs: Int?)
    /// The probe read a handler duration that cannot fit this wire — outside the
    /// `0…Int32.max` clamp the `handler` branch below applies to `durationNs` — and
    /// named it instead of shipping a value the daemon would refuse
    /// (`GlassPaneProbe.emitHandler`, `ProbeRuntime.durationOverflowFrameType`).
    ///
    /// Its own case, never demoted into `.handler`: the event ring would then count a
    /// frame that carries no usable duration as an invocation, and `hitCount` — the
    /// number T4/T5/T7 branch on — would rise for a click the probe could not measure.
    /// That is the demotion the `durationNs` comment below refuses ("a frame that
    /// claims a duration and cannot state one is refused and named, never demoted to a
    /// different frame type"), and the demotion's twin is `.malformed`: charging the
    /// peer with a protocol violation for a reading this protocol cannot hold.
    ///
    /// Every field is optional because the frame is legitimate the moment it names
    /// itself: `file`/`line` say which handler, `rejectedDurationNs` says what was
    /// read, and a frame that states less is recorded as stating less, not refused and
    /// not folded into a number it never claimed.
    case handlerDurationOverflow(
        file: String?, line: Int?, ts: Double, rejectedDurationNs: Int?
    )
    case state(key: String, before: String, after: String, source: String, ts: Double)
    /// Answer to checkpoint_export: ref + domain table (string values only),
    /// or an error string. `digest` is the probe's self-reported SHA-256 over
    /// the canonical JSON of `domains` (recomputed and compared daemon-side).
    case checkpoint(ref: String, domains: [String: [String: String]]?, digest: String?, error: String?)
    case result(ok: Bool, postStateDigest: String?, error: String?)
    case capture(path: String?, error: String?)
    case malformed(reason: String)
}

public enum ProbeWire {

    /// A drop counter as the wire carries it: absent, or a non-negative integer
    /// that fits the counter's own type. Anything else comes back `nil` —
    /// "unreported" — rather than a number the probe never claimed. A frame
    /// carrying `"droppedWrites": "many"` must not become `0`, because `0` is the
    /// assertion that nothing was lost.
    ///
    /// Booleans need an explicit veto for the same reason: `JSONSerialization`
    /// answers `NSNumber` for `true`/`false` too, and `as? NSNumber` therefore
    /// succeeds on them, so `{"droppedWrites": false}` would otherwise decode as
    /// the measured claim "zero writes lost" — precisely the confusion this
    /// counter exists to prevent. No Swift type test settles it, in either
    /// direction: `NSNumber(value: false) is Bool` is true, but so is
    /// `NSNumber(value: 1) is Bool`, because `NSNumber` bridges to whatever
    /// scalar the cast asks for. Only the CoreFoundation type ID reports what
    /// the object actually is (`RecipeLoader.describe` walks into this same
    /// trap and answers it the same way).
    ///
    /// Range is the third shape of the same mistake, and `intValue` was the whole
    /// of it: `{"droppedWrites": 4294967296}` came back as `0` — a clean bill of
    /// health for a channel that reported losing 4 billion frames — while
    /// 9007199254740993 came back as `1`. `boundedInt32` below already refuses
    /// that coercion for `pid` and `line` (the 2^32+1 → 1 case is documented
    /// there), so the counters go through the same exact-range read: a count the
    /// probe could not have meant is no count at all.
    static func counter(_ value: Any?) -> Int? {
        // The probe's counters are `NSUInteger` on the SDK side and `Int32` is
        // what this daemon can reprint without coercion, so the bound is the
        // wire's own (`0 … Int32.max`), not a convenience.
        boundedInt32(value, in: 0...(Int32.max)).map { Int($0) }
    }

    /// An `NSNumber` only when the JSON really carried a number.
    ///
    /// The boolean veto has to live at the single place every numeric field is
    /// read, not just in the counters below it: `{"pid": true}` used to decode as
    /// `pid == 1` (Swift bridges `NSNumber` to whatever scalar is asked for), so a
    /// malformed frame could register a probe against a pid that no such process
    /// owns — and every later "hitCount: 0" would then be a measurement about
    /// somebody else's process. Same trap as `counter`, same answer.
    static func scalar(_ value: Any?) -> NSNumber? {
        guard let number = value as? NSNumber else { return nil }
        guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return number
    }

    /// A whole number the daemon can actually hold, or nil.
    ///
    /// `intValue` then `.int32Value` is two truncations posing as one check: a
    /// frame carrying 4294967297 (2^32 + 1) came back as pid **1**, registering a
    /// probe against somebody else's process, and every later "hitCount: 0" was a
    /// measurement about that process. The engine side refuses the same shape for
    /// the same reason (`ParamValidation.pidLower`/`pidUpper`), so the range is
    /// read from there rather than restated.
    static func boundedInt32(_ value: Any?, in range: ClosedRange<Int32>) -> Int32? {
        guard let number = scalar(value),
              let whole = number.int64ValueExact,
              let candidate = Int32(exactly: whole) else { return nil }
        return range.contains(candidate) ? candidate : nil
    }

    /// `pid_t` is `Int32`, and a pid of 0 or below names no process.
    static let pidRange: ClosedRange<Int32> =
        Int32(ParamValidation.pidLower)...Int32(ParamValidation.pidUpper)

    /// The frame type a probe sends when the duration it read does not fit this wire
    /// (`GlassPaneProbe.ProbeRuntime.durationOverflowFrameType` — one string, two
    /// packages). It is named here rather than typed twice in the switch below so the
    /// read side and the write side can be locked to each other:
    /// `Qoder20261029Swift6ProbeDurationOverflowReadSide` reads both sources and fails
    /// if either renames it (precedent: the `stateFolderName` interlock).
    public static let durationOverflowFrameType = "handlerDurationOverflow"

    /// Decode one frame payload (no trailing newline). Never throws: bad
    /// frames come back as `.malformed` so the socket layer can log + skip.
    public static func decode(_ data: Data) -> ProbeInboundFrame {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dict = object as? [String: Any] else {
            return .malformed(reason: "frame is not a JSON object")
        }
        guard let type = dict["t"] as? String else {
            return .malformed(reason: "missing frame type key 't'")
        }
        switch type {
        case "hello":
            guard let pid = boundedInt32(dict["pid"], in: pidRange),
                  let appName = dict["appName"] as? String,
                  let probeVersion = dict["probeVersion"] as? String else {
                return .malformed(
                    reason: "hello requires pid in \(pidRange), appName, probeVersion"
                )
            }
            let capabilities = (dict["capabilities"] as? [String]) ?? []
            return .hello(ProbeHello(
                pid: pid,
                bundleId: dict["bundleId"] as? String,
                appName: appName,
                probeVersion: probeVersion,
                capabilities: capabilities,
                droppedEvents: Self.counter(dict["droppedEvents"]),
                droppedWrites: Self.counter(dict["droppedWrites"]),
                rejectedKeys: Self.counter(dict["rejectedKeys"]),
                droppedInboundFrames: Self.counter(dict["droppedInboundFrames"]),
                droppedInboundLines: Self.counter(dict["droppedInboundLines"]),
                truncatedValues: Self.counter(dict["truncatedValues"]),
                durationOverflowCount: Self.counter(dict["durationOverflowCount"])
            ))
        case "handler":
            // `line` is a source position the probe reports; past Int32 there is
            // no such file, and the same truncation that folded a 2^32+1 pid onto
            // 1 would fold a nonsense line onto something readable.
            guard let file = dict["file"] as? String,
                  let line = boundedInt32(dict["line"], in: 0...(Int32.max)) else {
                return .malformed(reason: "handler requires file and line in 0…\(Int32.max)")
            }
            // `durationNs` is this protocol's entry/duration discriminator, so its
            // two questions have to be answered separately: *is the key there*
            // (absence is what makes a frame an entry frame — the SDK omits the key
            // on entry and adds it on the >1ms exit frame, `GlassPaneProbe.emitHandler`)
            // and *is the value a duration this wire can carry* (a hard requirement,
            // same read as `line` above).
            //
            // Reading it with `intValue` answered the second question with the first:
            // `"durationNs": "800"` and any number past Int32 came back `nil`, and
            // `nil` is exactly what an **entry** frame means — so a follow-up frame
            // was counted as a second invocation of the same click and `hitCount` was
            // inflated for the act that T4/T5/T7 branch on, while 4294967297 folded
            // onto 1 (the `boundedInt32` comment calls that shape "two truncations
            // posing as one check"). A frame that claims a duration and cannot state
            // one is refused and named, never demoted to a different frame type.
            let durationNs: Int?
            if dict.keys.contains("durationNs") {
                guard let reported = boundedInt32(dict["durationNs"], in: 0...(Int32.max)) else {
                    return .malformed(
                        reason: "handler durationNs must be an integer in 0…\(Int32.max)"
                    )
                }
                durationNs = Int(reported)
            } else {
                durationNs = nil
            }
            return .handler(
                file: file,
                line: Int(line),
                ts: (scalar(dict["ts"]))?.doubleValue ?? 0,
                durationNs: durationNs
            )
        case durationOverflowFrameType:
            // The write side moved the unreadable number here rather than into
            // `durationNs`, precisely so this branch can exist. `file`/`line` locate
            // the handler and `rejectedDurationNs` is the reading that overflowed —
            // both read with the gates this file already has, and neither is required:
            // the frame has named itself by the time the switch reaches here, so
            // refusing it for a missing companion key would put it back on the
            // `.malformed` branch and charge the peer for the very thing it reported.
            //
            // `rejectedDurationNs` deliberately does not go through `counter` /
            // `boundedInt32`: the clamp is `0…Int32.max`, and the number this frame
            // carries exists *because* it fell outside that range — applying the clamp
            // here would refuse the only fact the frame reports and fold it to "no
            // value". `scalar` still vetoes a boolean, and `int64ValueExact` reads the
            // whole integer (negatives included, since the probe counts a negative
            // duration as an overflow too) without the truncation `boundedInt32`
            // exists to avoid.
            return .handlerDurationOverflow(
                file: dict["file"] as? String,
                line: boundedInt32(dict["line"], in: 0...(Int32.max)).map(Int.init),
                ts: (scalar(dict["ts"]))?.doubleValue ?? 0,
                rejectedDurationNs: scalar(dict["rejectedDurationNs"]).flatMap { number in
                    number.int64ValueExact.flatMap { Int(exactly: $0) }
                }
            )
        case "state":
            guard let key = dict["key"] as? String,
                  let before = dict["before"] as? String,
                  let after = dict["after"] as? String,
                  let source = dict["source"] as? String else {
                return .malformed(reason: "state requires key/before/after/source")
            }
            return .state(
                key: key,
                before: before,
                after: after,
                source: source,
                ts: (scalar(dict["ts"]))?.doubleValue ?? 0
            )
        case "checkpoint":
            let ref = (dict["ref"] as? String) ?? ""
            if let error = dict["error"] as? String {
                return .checkpoint(ref: ref, domains: nil, digest: nil, error: error)
            }
            guard let rawDomains = dict["domains"] as? [String: [String: String]] else {
                return .malformed(reason: "checkpoint requires domains table or error")
            }
            return .checkpoint(
                ref: ref,
                domains: rawDomains,
                digest: dict["digest"] as? String,
                error: nil
            )
        case "result":
            guard let ok = dict["ok"] as? Bool else {
                return .malformed(reason: "result requires ok")
            }
            return .result(ok: ok, postStateDigest: dict["postStateDigest"] as? String, error: dict["error"] as? String)
        case "capture":
            return .capture(path: dict["path"] as? String, error: dict["error"] as? String)
        default:
            return .malformed(reason: "unknown frame type '\(type)'")
        }
    }

    /// Encode a daemon→probe command line (§2.2 whitelist).
    public static func command(_ name: String, _ fields: [String: Any] = [:]) -> Data {
        var payload: [String: Any] = ["t": name]
        for (key, value) in fields { payload[key] = value }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return Data()
        }
        var line = data
        line.append(UInt8(ascii: "\n"))
        return line
    }

    /// Canonical string for the checkpoint digest: sorted-key JSON over a
    /// domain→key→value string table, no insignificant whitespace. Mirrored
    /// byte-for-byte by GlassPaneProbe.checkpointCanonical (string-only maps
    /// keep the escape surface minimal; P6 §5.5).
    public static func checkpointCanonical(_ domains: [String: [String: String]]) -> String {
        let outer = domains.keys.sorted().map { domain -> String in
            let inner = domains[domain]!.keys.sorted().map { key in
                jsonString(key) + ":" + jsonString(domains[domain]![key]!)
            }
            return jsonString(domain) + ":{" + inner.joined(separator: ",") + "}"
        }
        return "{" + outer.joined(separator: ",") + "}"
    }

    private static func jsonString(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    public static func sha256Hex(_ string: String) -> String {
        SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
