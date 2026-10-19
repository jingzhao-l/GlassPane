import XCTest
import CryptoKit
@testable import GlassPaneEngine

/// 2026-10-19 review lane, the canonical-bytes side.
///
/// `CanonicalJSON` is the form the approval chain and the decision log hash, and
/// the form the kernel's `canonicalJson` reproduces in TypeScript — so a number
/// with two spellings is two digests for one tree. The reference answers below are
/// **run out of node on this machine**, not derived by hand: the whole point of
/// the file is that nobody has to guess what `JSON.stringify` does.
final class Qoder20261019CanonicalBytesTests: XCTestCase {

    // MARK: - defect 11: non-integral doubles

    /// The exponent-vs-fixed split `JSON.stringify` uses.
    private static let jsNumberLiterals = [
        "0.00001", "1.5e20", "1e21", "1e-7", "0.5", "0.3333333333333333",
        "2.5e-10", "1234.5678", "1e100", "-0.00001", "0.1", "1e-6",
        "1.2345e-8", "7e-7", "5e-324", "1.7976931348623157e308", "1e22",
    ]

    /// `JSON.stringify` for each literal, taken from a real node run.
    private static func nodeStringify(_ literal: String) throws -> String {
        let node = try nodeBinary()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["-e", "process.stdout.write(JSON.stringify(\(literal)))"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "node refused \(literal)")
        return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }

    private static func nodeBinary() throws -> String {
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        where FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        throw XCTSkip("no node binary on this host, so the JSON.stringify reference cannot be produced")
    }

    /// The non-integral branch returned `String(describing: double)`, whose own
    /// comment names the hazard: Swift spells `1e-05` where `JSON.stringify`
    /// spells `0.00001`, and `1.5e+20` where it spells `150000000000000000000`.
    /// One number, two canonical spellings, two digests.
    func testNonIntegralDoublesCanonicaliseInTheSpellingJSONStringifyProduces() throws {
        var checked = 0
        for literal in Self.jsNumberLiterals {
            let fromNode = try Self.nodeStringify(literal)
            let parsed = try JSONSerialization.jsonObject(with: Data("{\"v\":\(literal)}".utf8))
            let canonical = CanonicalJSON.stringify(parsed)
            let expected = "{\"v\":\(fromNode)}"
            XCTAssertEqual(
                canonical, expected,
                "revert: \(literal) canonicalised away from JSON.stringify's own spelling"
            )
            // Still a number that parses back to the very same Double.
            let roundTripped = try XCTUnwrap(
                (try JSONSerialization.jsonObject(with: Data(canonical.utf8)) as? [String: Any])?["v"]
            )
            XCTAssertEqual(
                (try XCTUnwrap((parsed as? [String: Any])?["v"] as? NSNumber)).doubleValue,
                (roundTripped as! NSNumber).doubleValue,
                "the shortest spelling must still be the same binary value: \(literal)"
            )
            checked += 1
        }
        XCTAssertEqual(checked, Self.jsNumberLiterals.count, "every listed value was compared")
    }

    /// The integral half of the same function is already pinned by
    /// `ReviewStorageTests`; this keeps the two halves in one sentence: whatever
    /// the shape, the Swift spelling equals the one node produces.
    func testIntegralAndEdgeDoublesStillMatchJSONStringify() throws {
        for literal in ["3.0", "9007199254740992", "9000000000000000", "1e21", "-0.0", "0"] {
            let fromNode = try Self.nodeStringify(literal)
            let parsed = try JSONSerialization.jsonObject(with: Data("{\"v\":\(literal)}".utf8))
            XCTAssertEqual(
                CanonicalJSON.stringify(parsed), "{\"v\":\(fromNode)}",
                "integral path drifted for \(literal)"
            )
        }
    }

    // MARK: - defect 12a: does the tree digest use these bytes?

    /// `CanonicalJSON.swift:5-6` claims it is "used … by the tree digest", while
    /// `TreeDigest.digest` encodes with `JSONEncoder`. Measured here, on the exact
    /// characters that are said to differ: U+0008 and U+000C (which `JSON.stringify`
    /// spells `\b`/`\f`, while a generic writer escapes them `\u0008`/`\u000C`).
    ///
    /// Identical bytes ⇒ the claim is a documentation slip and there is no defect;
    /// different bytes ⇒ a real digest divergence between the two languages, and
    /// the producer is what gets fixed.
    func testTreeDigestBytesAreTheCanonicalBytes() throws {
        let control = AxNode(
            role: "AXWindow",
            title: "a\u{0008}b\u{000C}c\u{0001}d\u{001Fd}e",
            identifier: "slash/and\u{1F600}",
            children: [AxNode(role: "AXButton", title: "\u{2028}\u{2029}", identifier: nil, children: [])]
        )
        let roots = [control]

        // Exactly the encoder `TreeDigest` keeps private.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let encoded = try encoder.encode(roots)
        let encodedText = String(decoding: encoded, as: UTF8.self)

        let canonical = CanonicalJSON.stringify(try JSONSerialization.jsonObject(with: encoded))
        XCTAssertEqual(
            canonical, encodedText,
            "revert: the two producers spell one tree differently, so the digest is a coin flip on which reader recomputes it"
        )

        // And the digest itself, recomputed from the canonical text the TypeScript
        // side would build (`kernel/dist/canonical-json.js` + evidence-pack.js).
        let canonicalDigest = SHA256.hash(data: Data(canonical.utf8))
            .prefix(16).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(
            try TreeDigest.digest(roots), canonicalDigest,
            "the archived digest must be recomputable from the canonical bytes alone"
        )
    }

    /// `JSONEncoder` escapes U+0008/U+000C as `\b`/`\f` on this platform — the
    /// measurement the case above leans on, recorded rather than assumed.
    func testFoundationEscapesTheTwoControlCharactersTheSameWayJSONStringifyDoes() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let text = String(decoding: try encoder.encode(["v": "a\u{0008}b\u{000C}c"]), as: UTF8.self)
        XCTAssertEqual(text, #"{"v":"a\bb\fc"}"#)
        XCTAssertEqual(CanonicalJSON.stringify(["v": "a\u{0008}b\u{000C}c"]), #"{"v":"a\bb\fc"}"#)
    }

    // MARK: - defect 12b: the directory-sync tolerance, measured on APFS

    /// Measured on this APFS volume (`/var/folders/…`, `fstype: apfs`):
    ///   • `fsync(dirfd)` **succeeds** for a 0700 dir, for `O_DIRECTORY`, for a
    ///     `uchg`-flagged dir, and for a directory on the sealed read-only system
    ///     volume root (`fsync(/)` → 0). Nothing on APFS answers "this volume cannot
    ///     sync a directory" with EACCES or EPERM.
    ///   • EACCES **is** reachable, and reachable in exactly the wrong place: a
    ///     directory at mode 0300 takes the rename (write+execute, no read), and the
    ///     follow-up `open(O_RDONLY)` answers EACCES 13. Tolerating that means the
    ///     directory item was never synced while the caller still says persisted —
    ///     the durability claim this file exists to keep honest, hidden by a
    ///     permission the operator can fix.
    ///
    /// So the tolerance is tightened to the errnos that actually mean "not
    /// supported" (`EINVAL`, `ENOTSUP`, `ENOSYS`, `EOPNOTSUPP`) and EACCES/EPERM are
    /// durability refusals again. `DurableFileWriteDirectorySyncToleranceTests`
    /// keeps its ENOTSUP/EIO pins; nothing here softens a check.
    func testUnreadableDirectoryIsADurabilityRefusalNotAnUnsupportedVolume() throws {
        let root = TestSandbox.directory("dirsync-no-read")
        let directory = root + "/archive"
        let temporary = root + "/staged.json"
        try Data("{\"entries\":[]}".utf8).write(to: URL(fileURLWithPath: temporary))
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        XCTAssertEqual(chmod(directory, 0o300), 0, "test setup: writable, executable, NOT readable")
        try FileManager.default.moveItem(atPath: temporary, toPath: directory + "/published.json")

        // Premise gate, the same shape `ReviewStorageTests` uses: a process that
        // can open a mode-0300 directory (root) cannot measure this branch.
        let fd = directory.withCString { Darwin.open($0, O_RDONLY) }
        if fd >= 0 {
            _ = Darwin.close(fd)
            chmod(directory, 0o700)
            throw XCTSkip("this process can open a mode-0300 directory, so the EACCES half is unmeasurable here")
        }
        XCTAssertEqual(errno, EACCES, "measured premise: open(O_RDONLY) on the archive dir answers EACCES")

        XCTAssertThrowsError(
            try DurableFileWrite.syncPublished(atPath: directory + "/published.json")
        ) { error in
            let fault = try? XCTUnwrap(error as? DurableFileWrite.Failure)
            XCTAssertEqual(fault?.step, .syncDirectory, "the directory item is the step that could not be proven")
            XCTAssertEqual(fault?.systemError, EACCES, "and EACCES is a permission, not \"this volume cannot sync\"")
            XCTAssertEqual(
                fault?.isDurabilityFault, true,
                "revert: the tolerance swallowed it, and `evidencePersisted: true` then named a directory fsync that never ran"
            )
        }
        chmod(directory, 0o700)
    }

    /// The tightened set still says "unsupported volume" for the errnos that mean
    /// it, so the fix does not re-create the refusal-on-smbfs/NFS/exFAT problem the
    /// tolerance was written for.
    func testUnsupportedAndDeniedDirectorySyncErrnosAreSplitAsMeasured() {
        let tolerated = DurableFileWrite.unsupportedDirectorySyncErrnos
        let expected: Set<Int32> = Set([EINVAL, ENOTSUP, ENOSYS, EOPNOTSUPP].map { Int32($0) })
        XCTAssertEqual(
            tolerated, expected,
            "revert: EACCES/EPERM still sit in the tolerated set, where a permission problem reads as a volume capability"
        )
        XCTAssertFalse(tolerated.contains(EIO))
        XCTAssertFalse(tolerated.contains(EPERM))
        XCTAssertFalse(tolerated.contains(EACCES))
    }
}
