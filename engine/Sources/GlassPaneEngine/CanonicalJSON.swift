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
        // Integral values print without a fraction on both language sides.
        if double.rounded() == double, abs(double) < 9.0e15 {
            return String(Int64(double))
        }
        // Swift's Double description is the shortest roundtrip form, matching
        // JSON.stringify on the TS side for the value ranges fixtures use.
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
