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

    public init(
        pid: Int32,
        bundleId: String? = nil,
        appName: String,
        probeVersion: String,
        capabilities: [String],
        droppedEvents: Int? = nil,
        droppedWrites: Int? = nil,
        rejectedKeys: Int? = nil
    ) {
        self.pid = pid
        self.bundleId = bundleId
        self.appName = appName
        self.probeVersion = probeVersion
        self.capabilities = capabilities
        self.droppedEvents = droppedEvents
        self.droppedWrites = droppedWrites
        self.rejectedKeys = rejectedKeys
    }
}

public enum ProbeInboundFrame: Equatable {
    case hello(ProbeHello)
    /// Z1 handler event. `durationNs` present only on the >1ms follow-up frame.
    case handler(file: String, line: Int, ts: Double, durationNs: Int?)
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

    /// A drop counter as the wire carries it: absent, or a non-negative integer.
    /// Anything else comes back `nil` — "unreported" — rather than a number the
    /// probe never claimed. A frame carrying `"droppedWrites": "many"` must not
    /// become `0`, because `0` is the assertion that nothing was lost.
    static func counter(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber else { return nil }
        let whole = number.intValue
        return whole >= 0 ? whole : nil
    }

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
            guard let pidNumber = dict["pid"] as? NSNumber, pidNumber.intValue > 0,
                  let appName = dict["appName"] as? String,
                  let probeVersion = dict["probeVersion"] as? String else {
                return .malformed(reason: "hello requires pid>0, appName, probeVersion")
            }
            let capabilities = (dict["capabilities"] as? [String]) ?? []
            return .hello(ProbeHello(
                pid: pidNumber.int32Value,
                bundleId: dict["bundleId"] as? String,
                appName: appName,
                probeVersion: probeVersion,
                capabilities: capabilities,
                droppedEvents: Self.counter(dict["droppedEvents"]),
                droppedWrites: Self.counter(dict["droppedWrites"]),
                rejectedKeys: Self.counter(dict["rejectedKeys"])
            ))
        case "handler":
            guard let file = dict["file"] as? String,
                  let line = (dict["line"] as? NSNumber)?.intValue, line >= 0 else {
                return .malformed(reason: "handler requires file and line>=0")
            }
            return .handler(
                file: file,
                line: line,
                ts: (dict["ts"] as? NSNumber)?.doubleValue ?? 0,
                durationNs: (dict["durationNs"] as? NSNumber)?.intValue
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
                ts: (dict["ts"] as? NSNumber)?.doubleValue ?? 0
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
