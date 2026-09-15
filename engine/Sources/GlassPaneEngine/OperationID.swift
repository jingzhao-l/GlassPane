import Foundation
import Security

/// ULID-shaped operation identifier: 26 Crockford base32 characters =
/// 10-char millisecond timestamp prefix + 16-char random suffix
/// (P0 spec §4.1 operationId pattern).
public enum OperationID {
    public static let crockfordAlphabet: [Character] = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    public static let prefix = "op_"
    public static let snapshotPrefix = "snap_"
    public static let totalLength = 26

    /// Deterministic construction from a millisecond timestamp and 80 bits of
    /// entropy (10 bytes). Pure function — unit-testable.
    public static func generate(milliseconds: UInt64, entropy: [UInt8]) -> String {
        generate(milliseconds: milliseconds, entropy: entropy, prefix: prefix)
    }

    /// Deterministic construction with an explicit id prefix (op_/snap_).
    public static func generate(milliseconds: UInt64, entropy: [UInt8], prefix: String) -> String {
        precondition(entropy.count == 10, "entropy must be exactly 10 bytes (80 bits)")
        // 128-bit big-endian value: 48-bit timestamp high part + 80-bit entropy.
        var bytes: [UInt8] = [
            UInt8((milliseconds >> 40) & 0xFF),
            UInt8((milliseconds >> 32) & 0xFF),
            UInt8((milliseconds >> 24) & 0xFF),
            UInt8((milliseconds >> 16) & 0xFF),
            UInt8((milliseconds >> 8) & 0xFF),
            UInt8(milliseconds & 0xFF)
        ]
        bytes.append(contentsOf: entropy)

        // 26 base-32 digits * 5 bits = 130 bits; the 128-bit value is
        // zero-padded by 2 bits on the left (standard ULID layout).
        var chars: [Character] = []
        chars.reserveCapacity(totalLength)
        for index in 0..<totalLength {
            let fieldStart = 5 * index
            var digit = 0
            for offset in 0..<5 {
                let fieldBit = fieldStart + offset
                // Field bits 0 and 1 are padding zeros before the value MSB.
                if fieldBit >= 2, bitValue(bytes, fieldBit - 2) {
                    digit |= (1 << (4 - offset))
                }
            }
            chars.append(crockfordAlphabet[digit])
        }
        return prefix + String(chars)
    }

    /// Live generation: current time + cryptographically secure entropy.
    public static func generateLive() -> String {
        generateLive(prefix: prefix)
    }

    /// Live snapshot identifier: same 26-char body, `snap_` prefix
    /// (P1 spec §1.2 snapshotId pattern).
    public static func generateSnapshotLive() -> String {
        generateLive(prefix: snapshotPrefix)
    }

    private static func generateLive(prefix: String) -> String {
        let milliseconds = UInt64(Date().timeIntervalSince1970 * 1000)
        var entropy = [UInt8](repeating: 0, count: 10)
        let status = SecRandomCopyBytes(kSecRandomDefault, entropy.count, &entropy)
        if status != errSecSuccess {
            // Entropy source failure must not halt the engine; mix a
            // monotonic kernel clock into the fallback stream. The millisecond
            // timestamp still separates concurrent fallback generations.
            var state = mach_absolute_time()
                ^ UInt64(Date.timeIntervalSinceReferenceDate * 1000)
            for index in 0..<10 {
                state = state &* 6364136223846793005 &+ 1442695040888963407
                entropy[index] = UInt8(truncatingIfNeeded: state >> 33)
            }
        }
        return generate(milliseconds: milliseconds, entropy: entropy, prefix: prefix)
    }

    /// Bit at `index` (0 = most significant bit of the 128-bit value).
    private static func bitValue(_ bytes: [UInt8], _ index: Int) -> Bool {
        let byteIndex = index / 8
        let bitInByte = 7 - (index % 8)
        return (bytes[byteIndex] >> bitInByte) & 1 == 1
    }
}
