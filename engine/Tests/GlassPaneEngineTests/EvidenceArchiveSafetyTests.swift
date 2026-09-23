import XCTest
@testable import GlassPaneEngine

/// Deletion-radius guard for `EvidenceStore` (P5 §9.2 / v1.6 §12 retention).
///
/// The archive directory is per-project configuration, so these tests pin the
/// two properties that keep a configured directory from being damaged by
/// retention: only files the store itself wrote (regular, non-symlink, named
/// `<opId>.json`) are deletion candidates, and an entry whose age cannot be
/// measured is kept rather than treated as infinitely old.
///
/// Every case runs against an injected temporary directory with a pinned
/// clock; nothing here touches the real `~/.glasspane` archive.
final class EvidenceArchiveSafetyTests: XCTestCase {

    private let injectedNow = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: - Fixtures

    private func iso(_ date: Date) -> String {
        EvidenceStore.isoDateFormatter.string(from: date)
    }

    private func daysAgo(_ days: Int) -> String {
        iso(injectedNow.addingTimeInterval(-TimeInterval(days) * 86_400))
    }

    /// An opId straight from the generator, so its file name is by
    /// construction the shape the store writes.
    private func opId(_ seed: UInt64) -> String {
        OperationID.generate(
            milliseconds: seed,
            entropy: [UInt8](repeating: UInt8(seed & 0xFF), count: 10),
            prefix: "op_"
        )
    }

    private func pack(seed: UInt64, createdAt: String) -> EvidencePack {
        EvidencePack(
            operationId: opId(seed),
            createdAt: createdAt,
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "X"),
                    action: .press,
                    actConfirmed: true
                )
            )
        )
    }

    /// Every directory this file builds an archive on comes from the shared
    /// sandbox, so the path is asserted isolated *before* a store exists to
    /// write to it (C-05: a file-local temp helper passed both halves of the
    /// isolation gate, because nothing checked the path it handed out).
    private func makeTempDir(_ name: String) -> String {
        TestSandbox.directory(name)
    }

    private func makeStore(dir: String, maxFiles: Int? = nil) -> EvidenceStore {
        TestSandbox.assertIsolated(dir, label: "archive")
        return EvidenceStore(directory: dir, maxFiles: maxFiles, now: { self.injectedNow })
    }

    @discardableResult
    private func writeText(_ text: String, to url: URL) throws -> URL {
        try Data(text.utf8).write(to: url)
        return url
    }

    private func setMTime(_ url: URL, to date: Date) throws {
        try FileManager.default.setAttributes(
            [.modificationDate: date],
            ofItemAtPath: url.path
        )
    }

    /// Where `write` puts the pack for `seed`, so a test can pin its mtime.
    private func entryURL(_ dir: String, seed: UInt64) -> URL {
        URL(fileURLWithPath: dir, isDirectory: true)
            .appendingPathComponent("\(opId(seed)).json")
    }

    /// Decoys are aged against the *real* clock, which is what FIFO ordering
    /// compares; the injected clock only ever sits in front of it.
    private func ageDecoys(_ decoys: [Decoy]) throws {
        let aged = Date(timeIntervalSinceNow: -TimeInterval(400 * 86_400))
        for decoy in decoys {
            try setMTime(decoy.url, to: aged)
        }
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    /// Everything a hostile/legacy `evidenceStoragePath` could put in the
    /// archive that this store must never remove.
    private struct Decoy {
        let url: URL
        let label: String
    }

    private func plantDecoys(in dir: String) throws -> [Decoy] {
        let base = URL(fileURLWithPath: dir, isDirectory: true)

        // A directory whose name ends in `.json`: `removeItem` on it is
        // recursive, so its contents are the thing actually being protected.
        let dirNamedJson = base.appendingPathComponent("notes.json")
        try FileManager.default.createDirectory(at: dirNamedJson, withIntermediateDirectories: true)
        let buried = try writeText("user data", to: dirNamedJson.appendingPathComponent("keep-me.txt"))

        // A foreign regular `.json` file — the extension filter alone would
        // have deleted this.
        let foreign = try writeText("{\"setting\": true}", to: base.appendingPathComponent("bar.json"))

        // A sibling of the daemon's own state files, if the archive were ever
        // pointed at ~/.glasspane.
        let registry = try writeText("[]", to: base.appendingPathComponent("projects.json"))

        // A directory wearing the evidence name shape, still populated.
        let opShapedDir = base.appendingPathComponent("op_0123456789ABCDEFGHJKMNPQRS.json")
        try FileManager.default.createDirectory(at: opShapedDir, withIntermediateDirectories: true)
        let insideOpDir = try writeText("also user data", to: opShapedDir.appendingPathComponent("nested.txt"))

        // A symlink wearing the evidence name shape, pointing outside.
        let outside = try writeText("outside the archive", to: base.appendingPathComponent("outside-target.txt"))
        let link = base.appendingPathComponent("op_0000000000000000000000000A.json")
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: outside.path)

        // A near-miss name: valid opId shape, extra suffix.
        let suffixed = try writeText("{}", to: base.appendingPathComponent("op_0000000000000000000000000B.json.bak"))

        return [
            Decoy(url: dirNamedJson, label: ".json directory"),
            Decoy(url: buried, label: "file inside the .json directory"),
            Decoy(url: foreign, label: "foreign .json file"),
            Decoy(url: registry, label: "projects.json"),
            Decoy(url: opShapedDir, label: "op-shaped directory"),
            Decoy(url: insideOpDir, label: "file inside the op-shaped directory"),
            Decoy(url: link, label: "op-shaped symlink"),
            Decoy(url: outside, label: "symlink target"),
            Decoy(url: suffixed, label: "op-shaped name with a suffix"),
        ]
    }

    private func assertDecoysSurvive(
        _ decoys: [Decoy],
        in dir: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for decoy in decoys {
            XCTAssertTrue(exists(decoy.url), "\(decoy.label) must not be deleted", file: file, line: line)
        }
        // Contents survived too, i.e. nothing recursed into the directories.
        let buried = URL(fileURLWithPath: dir, isDirectory: true)
            .appendingPathComponent("notes.json")
            .appendingPathComponent("keep-me.txt")
        let kept = try? Data(contentsOf: buried)
        XCTAssertEqual(kept, Data("user data".utf8) as Data?,
                       "the .json directory must not be recursed into", file: file, line: line)
    }

    // MARK: - clear()

    func testClearRemovesOnlyEvidenceEntries() throws {
        let dir = makeTempDir("clear")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = makeStore(dir: dir)
        XCTAssertTrue(store.write(pack(seed: 1, createdAt: daysAgo(1))))
        XCTAssertTrue(store.write(pack(seed: 2, createdAt: daysAgo(1))))
        let decoys = try plantDecoys(in: dir)

        XCTAssertEqual(store.clear(), 2, "clear counts only entries this store wrote")
        XCTAssertEqual(store.stats().count, 0)
        assertDecoysSurvive(decoys, in: dir)
    }

    // MARK: - Age (TTL) pruning

    func testPruneByAgeKeepsForeignAndUnmeasurableEntries() throws {
        let dir = makeTempDir("ttl")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = makeStore(dir: dir)
        // Two real entries that ARE past the TTL, by their own createdAt.
        XCTAssertTrue(store.write(pack(seed: 3, createdAt: daysAgo(400))))
        XCTAssertTrue(store.write(pack(seed: 4, createdAt: daysAgo(400))))
        let decoys = try plantDecoys(in: dir)
        try ageDecoys(decoys)

        XCTAssertEqual(store.countExpired(olderThanDays: 30), 2,
                       "foreign entries are not expiry candidates, so the count is not inflated")
        XCTAssertEqual(store.prune(olderThanDays: 30), 2)
        XCTAssertNil(store.read(operationId: opId(3)))
        assertDecoysSurvive(decoys, in: dir)
    }

    /// The fail-closed direction of the age fallback: no measurable age is
    /// "unknown", never "infinitely old". Reached directly because the only
    /// way an enumerated entry loses its mtime mid-pass is to vanish, which a
    /// test cannot race deterministically.
    func testUnmeasurableAgeNeverExpires() throws {
        let dir = makeTempDir("unmeasurable")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = makeStore(dir: dir)
        let ghost = URL(fileURLWithPath: dir)
            .appendingPathComponent("\(opId(9)).json")

        XCTAssertFalse(
            store.isExpired(url: ghost, maxAgeDays: 1, now: injectedNow),
            "an entry whose createdAt and mtime both cannot be read must not be treated as expired"
        )

        // Control: the same judgment on a readable, genuinely old entry does
        // expire — the guard is about missing data, not about never deleting.
        XCTAssertTrue(store.write(pack(seed: 11, createdAt: daysAgo(400))))
        let aged = URL(fileURLWithPath: dir).appendingPathComponent("\(opId(11)).json")
        XCTAssertTrue(store.isExpired(url: aged, maxAgeDays: 30, now: injectedNow))
    }

    // MARK: - FIFO (maxFiles) pruning

    func testFifoPruneCountsAndDeletesOnlyEvidenceEntries() throws {
        let dir = makeTempDir("fifo")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = makeStore(dir: dir, maxFiles: 2)
        let decoys = try plantDecoys(in: dir)
        try ageDecoys(decoys)

        // Three writes against a cap of 2. The decoys are far "older" by mtime,
        // so a scope that counts them would spend the whole prune on them.
        // Entry mtimes are pinned so the victim is unambiguous even when every
        // write lands inside the same wall-clock second.
        XCTAssertTrue(store.write(pack(seed: 21, createdAt: daysAgo(3))))
        XCTAssertTrue(store.write(pack(seed: 22, createdAt: daysAgo(2))))
        try setMTime(entryURL(dir, seed: 21), to: Date(timeIntervalSinceNow: -300))
        try setMTime(entryURL(dir, seed: 22), to: Date(timeIntervalSinceNow: -200))
        XCTAssertTrue(store.write(pack(seed: 23, createdAt: daysAgo(1))))

        XCTAssertEqual(store.stats().count, 2, "archive settles at maxFiles evidence entries")
        XCTAssertNotNil(store.read(operationId: opId(23)), "just-written entry survives")
        XCTAssertNotNil(store.read(operationId: opId(22)))
        XCTAssertNil(store.read(operationId: opId(21)), "the oldest evidence entry is the victim")
        assertDecoysSurvive(decoys, in: dir)
    }

    // MARK: - Observation identity

    func testStatsIgnoreNonEvidenceFiles() throws {
        let dir = makeTempDir("stats")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = makeStore(dir: dir)
        XCTAssertTrue(store.write(pack(seed: 31, createdAt: daysAgo(1))))
        let decoys = try plantDecoys(in: dir)

        XCTAssertEqual(store.stats().count, 1, "stats reports the archive, not the directory")
        XCTAssertGreaterThan(store.stats().totalBytes, 0)
        XCTAssertEqual(store.lastOnDisk(), opId(31), "a foreign .json file cannot pose as latest evidence")
        assertDecoysSurvive(decoys, in: dir)
    }
}
