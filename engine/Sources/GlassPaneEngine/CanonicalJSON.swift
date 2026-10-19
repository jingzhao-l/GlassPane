import Foundation

/// Canonical JSON writer (sorted keys, no insignificant whitespace, shortest
/// roundtrip number form). Used by the C35 engine-side roundtrip test, the
/// approval hash chain (`ApprovalGate`), the restore receipt (`RestorePipeline`)
/// and the decision-log payload bound (`DecisionLogEntry`).
///
/// It is **not** what `TreeDigest` serialises with — that one uses `JSONEncoder`
/// with `[.sortedKeys, .withoutEscapingSlashes]`. Measured on this checkout
/// (`Qoder20261019CanonicalBytesTests.testTreeDigestBytesAreTheCanonicalBytes`,
/// 2026-10-19): the two writers produce the same bytes for a whole `AxNode` tree,
/// including the characters that usually split implementations — U+0008 → `\b`,
/// U+000C → `\f`, other C0 controls → lowercase `\u00xx`, `/` and non-ASCII raw,
/// nil keys omitted, array root — so the digest is recomputable from these rules
/// and there is no divergence to fix. That test is the guard: if a future writer
/// change makes the two spellings differ, it goes red there rather than silently
/// giving the two languages two digests.
/// The kernel-side test helper implements the exact same rules in TypeScript
/// (`kernel/dist/canonical-json.js`); any divergence surfaces as a fixture
/// mismatch.
public enum CanonicalJSON {

    public static func stringify(_ value: Any) -> String {
        if value is NSNull {
            return "null"
        }
        if isBoolean(value) {
            return (value as! Bool) ? "true" : "false"
        }
        if let number = value as? NSNumber {
            return numberString(number)
        }
        if let string = value as? String {
            return stringLiteral(string)
        }
        if let array = value as? [Any] {
            return "[" + array.map(stringify).joined(separator: ",") + "]"
        }
        if let object = value as? [String: Any] {
            let keys = object.keys.sorted()
            let members = keys.map { key in
                stringLiteral(key) + ":" + stringify(object[key]!)
            }
            return "{" + members.joined(separator: ",") + "}"
        }
        return "null"
    }

    // MARK: - Internals

    /// Distinguishes JSON booleans from numbers: JSONSerialization boxes them
    /// both as NSNumber, but only booleans carry the CFBoolean type ID.
    private static func isBoolean(_ value: Any) -> Bool {
        CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID()
    }

    private static func numberString(_ number: NSNumber) -> String {
        let double = number.doubleValue
        // A non-finite Double (NaN/±inf is reachable from an AX geometry read) has no
        // JSON spelling: `String(describing:)` used to emit `nan`/`inf`, which makes
        // the canonical bytes unparseable, while the TypeScript side's JSON.stringify
        // emits `null`. `treeDigest` is computed from this text on both sides, so one
        // such value made the two languages disagree about the same tree.
        guard double.isFinite else { return "null" }
        // Integral values print without a fraction on both language sides.
        if double.rounded() == double, abs(double) < 9.0e15 {
            return String(Int64(double))
        }
        // Everything else — an integral value at or above 2^53, and every
        // non-integral value — goes through the one spelling `JSON.stringify`
        // produces. `String(describing:)` was the old tail of this function and it
        // is *not* that spelling: its digits are the same shortest roundtrip, but
        // Swift pads the exponent (`1e-05`, `1.2345e-08`) and switches to exponent
        // form wherever it likes, while ECMAScript keeps fixed notation for the
        // whole decade −7…21 (`0.00001`, `150000000000000000000`) and prints
        // `1e-7`, `1.2345e-8` unpadded otherwise. Measured against node itself, in
        // `Qoder20261019CanonicalBytesTests`: one number, two spellings, two
        // digests — which is exactly what the approval chain cannot afford.
        return jsonStringSpelling(of: double)
    }

    /// ECMAScript `Number::toString` (the algorithm behind `JSON.stringify`) over
    /// the shortest decimal that reads back as the same Double.
    private static func jsonStringSpelling(of value: Double) -> String {
        let negative = value.sign == .minus
        let magnitude = abs(value)
        var digits = ""
        var exponent = 0
        // Smallest number of digits after the leading one that still round-trips;
        // `%e` always answers `d.ddddde±XX`, so digits and exponent are separable.
        for precision in 0...17 {
            let candidate = String(format: "%.\(precision)e", magnitude)
            guard let parsed = Double(candidate), parsed == magnitude,
                  let split = candidate.split(separator: "e").first.map(String.init),
                  let power = Int(candidate.split(separator: "e").last.map(String.init) ?? "")
            else { continue }
            digits = String(split.filter { $0 != "." })
            exponent = power
            break
        }
        guard !digits.isEmpty else { return String(describing: value) } // unreachable
        while digits.hasSuffix("0"), digits.count > 1 { digits.removeLast() }
        let k = digits.count
        // value == 0.digits × 10^n, the spec's `n`.
        let n = exponent + 1
        let sign = negative ? "-" : ""
        if k <= n, n <= 21 { return sign + digits + String(repeating: "0", count: n - k) }
        if n > 0, n <= 21 {
            return sign + String(digits.prefix(n)) + "." + String(digits.dropFirst(n))
        }
        if n > -6, n <= 0 {
            return sign + "0." + String(repeating: "0", count: -n) + digits
        }
        let leading = String(digits.first!)
        let fraction = digits.count > 1 ? "." + String(digits.dropFirst()) : ""
        let power = n - 1
        return sign + leading + fraction + "e" + (power >= 0 ? "+" : "-") + String(abs(power))
    }

    private static func stringLiteral(_ string: String) -> String {
        var out = "\""
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
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
}
