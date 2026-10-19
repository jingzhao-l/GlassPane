import XCTest
@testable import GlassPaneEngine

/// 2026-10-19 review lane, the archive readers and the refused write.
///
/// Defect 7 is the "a refusal destroyed an audit entry" shape; defects 8 and 9 are
/// the "two readers, two verdicts" shape: the daemon answers an archive entry with
/// `EvidenceStore.isEntryName` + `decodeAndValidate`, while the panel's scan used
/// plain `decode` over any `*.json`. Fixtures follow `StatePermissionTests` /
/// `ReviewStorageTests`: deterministic opIds, a real store in the sandbox, and an
/// injected isolation verdict (the only non-root route to that branch, as that
/// file's own comment documents).
final class Qoder20261019ArchiveHonestyTests: XCTestCase {

    private func pack(createdAt: String, seed: UInt64, title: String = "X") -> EvidencePack {
        EvidencePack(
            operationId: OperationID.generate(
                milliseconds: seed,
                entropy: [UInt8](repeating: UInt8(seed & 0xFF), count: 10),
                prefix: OperationID.prefix
            ),
            createdAt: createdAt,
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: title),
                    action: .press,
                    actConfirmed: true
                )
            )
        )
    }

    // MARK: - defect 7: a refusal must not delete the entry it refused to replace

    /// `replaceItemAt` overwrites an existing entry *before* the post-publish
    /// isolation verdict runs, and when that verdict fails
    /// `removeAfterRefusal(filePath)` deletes the published path. Re-writing one
    /// pack's own entry — the normal `EngineCore.diagnose` → `replace` → `persist`
    /// route — could therefore leave no entry where one existed: the refusal
    /// destroyed the audit trail it was refusing to modify.
    func testRefusedRewriteOfAnExistingEntryLeavesThePreviousPackOnDisk() throws {
        let directory = TestSandbox.directory("refused-rewrite")
        let store = TestSandbox.evidenceStore(at: directory)
        let original = pack(createdAt: "2026-10-18T00:00:00.000Z", seed: 41, title: "Before the refusal")
        XCTAssertTrue(store.write(original), "premise: the entry exists in the archive")
        let entryPath = directory + "/" + original.operationId + ".json"
        let priorBytes = try Data(contentsOf: URL(fileURLWithPath: entryPath))

        // The volume that will not isolate a file it is handed: every judgment of
        // the published name fails — the `StatePermissionTests` fixture shape (a
        // non-root test cannot build such a volume, which is why the seam exists).
        var judged: [String] = []
        store.isolationCheck = { candidate in
            judged.append(candidate)
            return candidate == entryPath ? "\(candidate) is still 0644 after chmod(0600)" : nil
        }
        let replacement = pack(createdAt: "2026-10-19T00:00:00.000Z", seed: 42, title: "Never published")
        // Same opId this time: this is a rewrite of one entry, not a new one.
        let rewritten = EvidencePack(
            schemaVersion: replacement.schemaVersion,
            operationId: original.operationId,
            createdAt: replacement.createdAt,
            attribution: replacement.attribution,
            circuitBreaker: replacement.circuitBreaker,
            signals: replacement.signals
        )
        XCTAssertFalse(
            store.write(rewritten),
            "a pack that cannot be isolated is still refused — the verdict must not soften"
        )
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: entryPath),
            "revert: the refusal removed the published entry, leaving no pack where one existed"
        )
        let survivingBytes = try Data(contentsOf: URL(fileURLWithPath: entryPath))
        XCTAssertEqual(
            survivingBytes, priorBytes,
            "the entry must be what it was before the refused write, byte for byte"
        )
        XCTAssertEqual(
            judged.first, entryPath,
            "the name about to be overwritten is judged before anything is overwritten onto it: \(judged)"
        )
        XCTAssertEqual(store.read(operationId: original.operationId), original, "and the store still serves it")
    }

    /// The refusal keeps refusing, and a *first* publish that cannot be isolated
    /// still leaves nothing world-readable behind: a pre-flight must not turn
    /// R5-04 into a rule that only holds for entries nobody has written yet.
    func testFirstPublishOfAnEntryStillRefusesAndLeavesNothingPublished() throws {
        let directory = TestSandbox.directory("refused-first")
        let store = TestSandbox.evidenceStore(at: directory)
        let fresh = pack(createdAt: "2026-10-19T00:00:00.000Z", seed: 43)
        let entryPath = directory + "/" + fresh.operationId + ".json"
        store.isolationCheck = { candidate in
            candidate == entryPath ? "\(candidate) is still 0644 after chmod(0600)" : nil
        }
        XCTAssertFalse(store.write(fresh))
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: entryPath),
            "a first publish that cannot be isolated must leave nothing world-readable behind"
        )
    }

    // MARK: - defects 8 and 9: the panel's reader vs the daemon's reader

    /// The daemon answers `GP_E_NO_EVIDENCE` for an entry whose bytes decode but
    /// violate the frozen contract (`EvidenceStore.read` → `decodeAndValidate`),
    /// and it never reads a name that is not one of its own entries. The panel
    /// used to render both as rows (plain `decode`, any `*.json`), so one archive
    /// had two verdicts and the UI showed evidence the daemon refuses to hand out.
    func testPanelRefusesWhatTheDaemonRefuses() throws {
        let directory = TestSandbox.directory("two-readers")
        let store = TestSandbox.evidenceStore(at: directory)
        let good = pack(createdAt: "2026-10-19T00:00:00.000Z", seed: 51)
        XCTAssertTrue(store.write(good))

        // Conforming name, JSON the Codable synthesis accepts, body that violates a
        // pattern the frozen schema states: `createdAt` must carry milliseconds.
        let forgedId = OperationID.generate(
            milliseconds: 52, entropy: [UInt8](repeating: 52, count: 10), prefix: OperationID.prefix
        )
        let badBytes = """
        {"schemaVersion":"glasspane.evidence/0.1","operationId":"\(forgedId)",\
        "createdAt":"2026-10-19T00:00:00Z",\
        "attribution":{"level":"soft","contaminated":false},\
        "circuitBreaker":{"level":0},\
        "signals":{"act":{"selector":{"role":"AXButton","title":"X"},"action":"press","actConfirmed":true},\
        "handlerProbe":null,"stateDiff":null}}
        """
        try Data(badBytes.utf8).write(to: URL(fileURLWithPath: directory + "/" + forgedId + ".json"))
        XCTAssertNotNil(
            try? JSONDecoder().decode(EvidencePack.self, from: Data(badBytes.utf8)),
            "premise: plain `decode` accepts this pack — that is why the panel used to render it"
        )
        XCTAssertThrowsError(try EvidencePack.decodeAndValidate(Data(badBytes.utf8))) { error in
            XCTAssertTrue(error is EvidencePackError, "and the daemon's reader is the one that refuses: \(error)")
        }
        XCTAssertNil(store.read(operationId: forgedId), "premise: the daemon answers no-evidence for this entry")

        // A `.json` that is not an entry name at all: the daemon never reads it.
        try Data("{\"entries\":[]}".utf8).write(to: URL(fileURLWithPath: directory + "/settings.json"))

        let scan = LocalArchive.scanEvidence(directory: directory)
        XCTAssertEqual(
            scan.summaries.map(\.operationId), [good.operationId],
            "revert: the panel rendered a row for a pack the daemon answers GP_E_NO_EVIDENCE for"
        )
        XCTAssertEqual(
            Set(scan.unreadableFiles),
            [forgedId + ".json", "settings.json"],
            "a file the daemon will not serve is not silently dropped — it is counted and named"
        )
    }

    /// `totalBytes` and `stats().totalBytes` answer one question — how big is this
    /// archive — from two different populations: the panel summed every `*.json`
    /// whose contents it could read (foreign files included) and skipped any file
    /// it could not read, while `EvidenceStore.stats()` sums `.fileSizeKey` for
    /// exactly the `op_<26>.json` entries. Both directions of the mismatch are
    /// produced here, so the parity claim is measured rather than assumed.
    func testPanelTotalBytesMatchesStoreStatsWhenPartOfTheArchiveIsUnreadable() throws {
        let directory = TestSandbox.directory("byte-parity")
        let store = TestSandbox.evidenceStore(at: directory)
        let good = pack(createdAt: "2026-10-19T00:00:00.000Z", seed: 61)
        XCTAssertTrue(store.write(good))
        let brokenName = OperationID.generate(
            milliseconds: 62, entropy: [UInt8](repeating: 62, count: 10), prefix: OperationID.prefix
        ) + ".json"
        try Data("{ not json".utf8).write(to: URL(fileURLWithPath: directory + "/" + brokenName))
        // Bytes the daemon does not count as part of the archive at all.
        try Data("{\"entries\":[]}".utf8).write(to: URL(fileURLWithPath: directory + "/settings.json"))

        // An entry whose contents this process may not read: the daemon still
        // counts its size, the panel used to lose it entirely. Measured, not
        // assumed — if a mode-000 file stays readable here, this half cannot be
        // produced and the case would be a pass by fixture (same premise gate as
        // `ReviewStorageTests.testScanSeparatesAnUnreadableDirectoryFromAnEmptyOne`).
        let sealedName = OperationID.generate(
            milliseconds: 63, entropy: [UInt8](repeating: 63, count: 10), prefix: OperationID.prefix
        ) + ".json"
        let sealedPath = directory + "/" + sealedName
        try Data(String(repeating: "s", count: 4096).utf8).write(to: URL(fileURLWithPath: sealedPath))
        XCTAssertEqual(chmod(sealedPath, 0o000), 0, "test setup: mode 000 on a real entry name")
        guard (try? Data(contentsOf: URL(fileURLWithPath: sealedPath))) == nil else {
            chmod(sealedPath, 0o600)
            throw XCTSkip("this process can read a mode-000 file, so the unreadable-entry half is unmeasurable here")
        }

        let scan = LocalArchive.scanEvidence(directory: directory)
        let stats = store.stats()
        XCTAssertEqual(scan.summaries.count, 1)
        XCTAssertEqual(
            Set(scan.unreadableFiles), [brokenName, sealedName, "settings.json"],
            "a file that cannot be read and a file that cannot be decoded are both failures of that file, and a `.json` that is not an archive entry is named rather than silently dropped"
        )
        XCTAssertEqual(stats.count, 3, "premise: the daemon counts three entries, foreign names excluded")
        var expectedBytes = 0
        for name in [good.operationId + ".json", brokenName, sealedName] {
            expectedBytes += try fileSize(of: directory + "/" + name)
        }
        XCTAssertEqual(
            scan.totalBytes, stats.totalBytes,
            "revert: the panel summed a different set of files than the daemon, so its figure was neither the archive nor a stated subset of it"
        )
        XCTAssertEqual(scan.totalBytes, expectedBytes, "and the shared figure is those three entries' own sizes")
        XCTAssertEqual(chmod(sealedPath, 0o600), 0, "cleanup: leave the sandbox normal")
    }

    private func fileSize(of path: String) throws -> Int {
        try URL(fileURLWithPath: path).resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    }
}
