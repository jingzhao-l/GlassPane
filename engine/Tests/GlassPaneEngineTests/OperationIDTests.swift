import XCTest
@testable import GlassPaneEngine

/// A2/A5: operationId format, determinism and uniqueness (P0 spec §4.1).
final class OperationIDTests: XCTestCase {

    private let formatRegex = try! NSRegularExpression(
        pattern: "^op_[0-9A-HJKMNP-TV-Z]{26}$"
    )

    private func matchesFormat(_ id: String) -> Bool {
        let range = NSRange(id.startIndex..., in: id)
        return formatRegex.firstMatch(in: id, range: range) != nil
    }

    func testAllZeroValueIsAllZeros() {
        let id = OperationID.generate(
            milliseconds: 0,
            entropy: [UInt8](repeating: 0, count: 10)
        )
        XCTAssertEqual(id, "op_" + String(repeating: "0", count: 26))
    }

    func testMaxTimestampWithZeroEntropy() {
        let id = OperationID.generate(
            milliseconds: UInt64.max & 0xFFFFFFFFFFFF,  // 48-bit timestamp
            entropy: [UInt8](repeating: 0, count: 10)
        )
        // First 10 chars encode 2 padding zeros + the 48 timestamp bits.
        // With the timestamp all-ones: '7' (0b00111 | padding) then nine 'Z'.
        XCTAssertEqual(id, "op_7" + String(repeating: "Z", count: 9) + String(repeating: "0", count: 16))
    }

    func testMaxEntropyIsAllZSuffix() {
        let id = OperationID.generate(
            milliseconds: 0,
            entropy: [UInt8](repeating: 0xFF, count: 10)
        )
        // Timestamp bits are zero; the 80 entropy bits are all ones, so the
        // 10 timestamp chars are '0' and the 16 entropy chars are 'Z'.
        XCTAssertEqual(id, "op_" + String(repeating: "0", count: 10) + String(repeating: "Z", count: 16))
    }

    func testDeterministicForSameInputs() {
        let entropy: [UInt8] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        let a = OperationID.generate(milliseconds: 1_700_000_000_000, entropy: entropy)
        let b = OperationID.generate(milliseconds: 1_700_000_000_000, entropy: entropy)
        XCTAssertEqual(a, b)
    }

    func testDifferentTimestampsDifferInFirstTenChars() {
        let entropy: [UInt8] = [UInt8](repeating: 0x42, count: 10)
        let a = OperationID.generate(milliseconds: 1, entropy: entropy)
        let b = OperationID.generate(milliseconds: 2, entropy: entropy)
        XCTAssertTrue(a.hasPrefix("op_0000000001"), "ms=1 prefix: \(a)")
        XCTAssertTrue(b.hasPrefix("op_0000000002"), "ms=2 prefix: \(b)")
        // Identical entropy: only the timestamp chars differ.
        XCTAssertEqual(a.dropFirst(13), b.dropFirst(13))
    }

    func testLiveIDsMatchFormat() {
        for _ in 0..<1000 {
            XCTAssertTrue(matchesFormat(OperationID.generateLive()), "id out of format")
        }
    }

    func testLiveIDsAreUnique() {
        var seen = Set<String>()
        for _ in 0..<1000 {
            let id = OperationID.generateLive()
            XCTAssertTrue(seen.insert(id).inserted, "duplicate live id: \(id)")
        }
    }

    func testAlphabetExcludesAmbiguousCharacters() {
        // Crockford base32: no I, L, O, U.
        XCTAssertFalse(OperationID.crockfordAlphabet.contains("I"))
        XCTAssertFalse(OperationID.crockfordAlphabet.contains("L"))
        XCTAssertFalse(OperationID.crockfordAlphabet.contains("O"))
        XCTAssertFalse(OperationID.crockfordAlphabet.contains("U"))
        XCTAssertEqual(OperationID.crockfordAlphabet.count, 32)
    }
}
