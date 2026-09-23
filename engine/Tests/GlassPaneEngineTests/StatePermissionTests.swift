import XCTest
@testable import GlassPaneEngine

/// R5-04's other half: the modes the project *documents* (`0700` directories,
/// `0600` files — P0 §3.5, P6 §2.1, SECURITY.md) were only ever applied to what
/// a call creates. `createDirectory(attributes:)` does not touch an existing
/// directory and `Data.write(.atomic)` creates with the process umask, so an
/// installation whose `~/.glasspane` was made by the MCP shell kept the project
/// registry, the approval hash chain and every evidence pack at `0644` — readable
/// by every local account — while the code believed the invariant held.
///
/// Every path here is a `TestSandbox` directory: these tests chmod real files, so
/// pointing them at anything else would be the exposure they exist to close.
final class StatePermissionTests: XCTestCase {

    private func mode(of path: String) -> Int {
        var info = stat()
        guard stat(path, &info) == 0 else { return -1 }
        return Int(info.st_mode & 0o777)
    }

    private func writeFile(_ contents: String, at path: String, mode: mode_t) throws {
        try contents.write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertEqual(chmod(path, mode), 0, "test setup: chmod \(String(format: "%04o", mode)) \(path)")
    }

    // MARK: - isolateFile

    func testIsolateFileTightensAWorldReadableFileAndVerifiesIt() throws {
        let path = TestSandbox.directory("isolate") + "/projects.json"
        try writeFile("[]", at: path, mode: 0o644)
        XCTAssertEqual(mode(of: path), 0o644, "the exposure this function exists for")
        XCTAssertNil(StateRoot.isolateFile(at: path), "no defect reported")
        XCTAssertEqual(mode(of: path), 0o600, "and the file really is owner-only afterwards")
    }

    func testIsolateFileIsIdempotentAndSilentOnAlreadyPrivate() throws {
        let path = TestSandbox.directory("isolate-again") + "/approvals.json"
        try writeFile("{}", at: path, mode: 0o600)
        XCTAssertNil(StateRoot.isolateFile(at: path))
        XCTAssertEqual(mode(of: path), 0o600)
    }

    /// A missing file has no exposure; "nothing to do" must not be reported as a
    /// failure, and the call must not create the path on the way to checking it.
    func testIsolateFileOnMissingPathDoesNothingAndReportsNothing() throws {
        let dir = TestSandbox.directory("isolate-absent")
        let path = dir + "/not-there.json"
        XCTAssertNil(StateRoot.isolateFile(at: path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: path), "a tightening helper must not create state")
    }

    /// The refusal branch has to be reachable and *named*, or the function is a
    /// check that can only pass. A directory occupying an archive entry's name is
    /// that branch: chmod would succeed and still leave world-traversal, so the
    /// helper reports it instead of claiming success.
    func testIsolateFileRefusesToPretendADirectoryIsAFile() throws {
        let path = TestSandbox.directory("isolate-dir") + "/stray"
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        let defect = try XCTUnwrap(StateRoot.isolateFile(at: path))
        XCTAssertTrue(defect.contains("not a regular file"), defect)
        XCTAssertEqual(mode(of: path), 0o755, "it was left exactly as found")
    }

    // MARK: - the sweep over a pre-existing root

    /// The whole point of the startup sweep: a root that predates the rule comes
    /// out isolated, entry by entry, without the sweep touching anything it does
    /// not own by name.
    func testTightenPermissionsBringsAPreExistingRootToOwnerOnly() throws {
        let rootPath = TestSandbox.directory("root")
        let root = StateRoot(path: rootPath)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: rootPath)
        try FileManager.default.createDirectory(
            atPath: root.evidenceDirectory, withIntermediateDirectories: true
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: root.evidenceDirectory
        )
        try writeFile("[]", at: root.projectsFile, mode: 0o644)
        try writeFile("[]", at: root.approvalsFile, mode: 0o644)
        // One archive entry at the umask default, and one foreign file that the
        // sweep has no business rewriting the permissions of.
        let entry = root.evidenceDirectory + "/op_0123456789ABCDEFGHJKMNPQRS.json"
        try writeFile("{}", at: entry, mode: 0o664)
        let foreign = root.evidenceDirectory + "/notes.txt"
        try writeFile("mine", at: foreign, mode: 0o664)

        XCTAssertEqual(mode(of: rootPath), 0o755)
        let notes = root.tightenPermissions(log: EngineLog(quiet: true))
        XCTAssertTrue(notes.isEmpty, "everything here is tighten-able: \(notes)")
        XCTAssertEqual(mode(of: rootPath), 0o700)
        XCTAssertEqual(mode(of: root.evidenceDirectory), 0o700)
        XCTAssertEqual(mode(of: root.projectsFile), 0o600)
        XCTAssertEqual(mode(of: root.approvalsFile), 0o600)
        XCTAssertEqual(mode(of: entry), 0o600)
        XCTAssertEqual(
            mode(of: foreign), 0o664,
            "a file that is not an archive entry is not this sweep's to touch"
        )
    }

    /// A note is only worth logging if it can actually be produced: an archive
    /// entry name held by a directory is reported, and the rest still tightens.
    func testTightenPermissionsReportsWhatItCouldNotIsolate() throws {
        let rootPath = TestSandbox.directory("root-partial")
        let root = StateRoot(path: rootPath)
        try FileManager.default.createDirectory(
            atPath: root.evidenceDirectory, withIntermediateDirectories: true
        )
        try writeFile("[]", at: root.projectsFile, mode: 0o644)
        try FileManager.default.createDirectory(
            atPath: root.evidenceDirectory + "/op_0123456789ABCDEFGHJKMNPQRS.json",
            withIntermediateDirectories: true
        )
        let notes = root.tightenPermissions(log: EngineLog(quiet: true))
        XCTAssertEqual(notes.count, 1, notes.description)
        XCTAssertTrue(notes[0].contains("not a regular file"), notes.description)
        XCTAssertEqual(mode(of: root.projectsFile), 0o600, "the reportable case does not stop the rest")
    }

    /// A root that does not exist yet is not a failure — the writers create it
    /// with 0700 attributes — and the sweep must say "nothing to do" rather than
    /// manufacture the directory while checking.
    func testTightenPermissionsOnAbsentRootCreatesNothing() throws {
        let root = StateRoot(path: TestSandbox.directory("root-absent") + "/later")
        XCTAssertTrue(root.tightenPermissions(log: EngineLog(quiet: true)).isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }

    // MARK: - the writers themselves

    func testEvidenceStoreWritesOwnerOnlyPacks() throws {
        let dir = TestSandbox.directory("store-mode")
        let store = EvidenceStore(directory: dir)
        XCTAssertTrue(store.write(pack(createdAt: "2026-09-23T00:00:00.000Z", seed: 7)))
        let entries = try FileManager.default.contentsOfDirectory(atPath: dir)
        let name = try XCTUnwrap(entries.first)
        XCTAssertEqual(
            mode(of: dir + "/" + name), 0o600,
            "the pack must never exist under a world-readable name, not even briefly"
        )
    }

    func testProjectRegistrySavesOwnerOnly() throws {
        let path = TestSandbox.filePath("registry-mode")
        let registry = ProjectRegistry(filePath: path)
        _ = try registry.create(displayName: "Owned", bundleId: "com.owned")
        XCTAssertEqual(mode(of: path), 0o600)
    }

    func testApprovalLedgerPersistsOwnerOnly() throws {
        let path = TestSandbox.filePath("ledger-mode")
        let gate = ApprovalGate(path: path, clock: { Date(timeIntervalSince1970: 1_800_000_000) })
        XCTAssertNotNil(gate.append(
            operationRef: "op_0123456789ABCDEFGHJKMNPQRS",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "state-permission-test",
            reason: "test"
        ))
        XCTAssertEqual(
            mode(of: path), 0o600,
            "the hash chain is a signature ledger; 0644 let another account read (and so imitate) it"
        )
    }

    /// The state root outside the home directory is isolated **by ownership**,
    /// which is what `--state-dir` made reachable: the old rule exempted
    /// everything outside `NSHomeDirectory()`, logged the gap, and wrote anyway —
    /// so the runs that most needed isolation were the ones that skipped it.
    func testStoreOutsideHomeIsStillIsolated() throws {
        let dir = TestSandbox.directory("outside-home")
        XCTAssertFalse(
            dir.hasPrefix(NSHomeDirectory() + "/"),
            "test premise: the sandbox must actually be outside home, got \(dir)"
        )
        let store = EvidenceStore(directory: dir)
        XCTAssertTrue(store.write(pack(createdAt: "2026-09-23T00:00:00.000Z", seed: 9)))
        XCTAssertEqual(mode(of: URL(fileURLWithPath: dir).path), 0o700)
    }

    private func pack(createdAt: String, seed: UInt64) -> EvidencePack {
        EvidencePack(
            operationId: OperationID.generate(
                milliseconds: seed,
                entropy: [UInt8](repeating: UInt8(seed & 0xFF), count: 10),
                prefix: "op_"
            ),
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
}
