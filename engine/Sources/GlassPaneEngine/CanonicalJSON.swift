import Foundation

/// Canonical JSON writer (sorted keys, no insignificant whitespace, shortest
/// roundtrip number form). Used by the C35 engine-side roundtrip test and by
/// the tree digest. The kernel-side test helper implements the exact same
/// rules in TypeScript; any divergence surfaces as a fixture mismatch.
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
        if double.rounded() == double {
            if abs(double) < 9.0e15 {
                return String(Int64(double))
            }
            // Above the exact-integer range Swift's description switches to exponent
            // form (`9.0e+15`) while JSON.stringify keeps fixed notation until 1e21 —
            // two canonical spellings of one number, so two digests.
            if abs(double) < 1.0e21 {
                return String(format: "%.0f", double)
            }
        }
        return String(describing: double)
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
