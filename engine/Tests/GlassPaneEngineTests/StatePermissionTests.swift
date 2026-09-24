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

    /// R5-04's fallback branch, with the rejection made **executable**.
    ///
    /// What it stands for: a volume that will not isolate a file it is handed —
    /// a read-only mount, an ACL override, an immutable flag — on which the
    /// rename route cannot be used at all, so `write` falls back to publishing
    /// the pack under its final name and that finished file refuses `0600`.
    ///
    /// The fallback is driven for real: a directory squatting on `<entry>.tmp`
    /// makes the temporary write throw (measured on this checkout:
    /// `NSCocoaErrorDomain Code=512`), which is exactly the "the temp name is
    /// unusable" condition the fallback exists for, and the pack then lands at
    /// its final name (measured: `Code=512` on the temp, fallback write succeeds).
    /// The *isolation verdict* is injected, because no non-root test can build
    /// that volume — measured candidate space, all of which fail to reach the
    /// branch: a directory, a non-empty directory, a `uchg`-flagged file, a FIFO,
    /// a dangling symlink, a symlink loop and a symlink onto an immutable file
    /// each leave the fallback either throwing too (so the verdict was already
    /// false before the fix and the test proves nothing) or landing a plain
    /// `0644` regular file that `chmod(0600)` fixes on the spot; an inherited
    /// `deny writeattr` ACL is copied onto the new pack (which stays `0644`, i.e.
    /// exactly the exposure) while `chmod` still succeeds, because a file's owner
    /// may always set its own mode. So the seam is the only route to the
    /// refusal — and the control below shows the verdict, not the fixture, is
    /// what decides the answer.
    func testFallbackWriteRefusesAPackItCannotIsolate() throws {
        let dir = TestSandbox.directory("fallback-refuse")
        let store = EvidenceStore(directory: dir)
        let pack = pack(createdAt: "2026-09-23T00:00:00.000Z", seed: 21)
        let filePath = dir + "/" + pack.operationId + ".json"
        try FileManager.default.createDirectory(
            atPath: filePath + ".tmp", withIntermediateDirectories: true
        )

        var judged: [String] = []
        store.isolationCheck = { path in
            judged.append(path)
            return "\(path) is still 0644 after chmod(0600)" // what such a volume answers
        }
        XCTAssertFalse(
            store.write(pack),
            "the fallback's isolation failure has to change the verdict, not only the log line"
        )
        XCTAssertEqual(
            judged, [filePath],
            "the fallback must judge the file it published — and nothing else"
        )
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: filePath),
            "a refused pack must not stay in the archive readable by other accounts"
        )

        // The control: the same filesystem state, the production verdict, and the
        // write lands. So the refusal above was the judgment and not the fixture.
        store.isolationCheck = StateRoot.isolateFile(at:)
        XCTAssertTrue(
            store.write(pack),
            "the fallback still publishes when the volume isolates what it is given"
        )
        XCTAssertEqual(mode(of: filePath), 0o600)
    }

    /// The blast-radius promise this type states in its own documentation is that
    /// it touches nothing but its own `op_<26>.json` entries. Measured against that
    /// promise: when the entry name is held by a **directory**, `replaceItemAt` does
    /// not decline — it takes the directory's contents with it. So a store pointed
    /// at a directory whose names collide with an operationId must refuse on sight,
    /// and the refusal has to leave the stranger exactly as found.
    func testEntryNameHeldByADirectoryIsRefusedAndLeftIntact() throws {
        let dir = TestSandbox.directory("entry-is-directory")
        let store = EvidenceStore(directory: dir)
        let pack = pack(createdAt: "2026-09-23T00:00:00.000Z", seed: 33)
        let filePath = dir + "/" + pack.operationId + ".json"
        let sentinel = filePath + "/not-yours.txt"
        try FileManager.default.createDirectory(atPath: filePath, withIntermediateDirectories: true)
        try "someone else's data".write(toFile: sentinel, atomically: true, encoding: .utf8)

        XCTAssertFalse(
            store.write(pack),
            "publishing onto a directory is the one thing this store's declared radius forbids"
        )
        var info = stat()
        XCTAssertEqual(stat(filePath, &info), 0, "the directory must still exist")
        XCTAssertEqual(
            try String(contentsOfFile: sentinel, encoding: .utf8),
            "someone else's data",
            "…with its contents"
        )
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: filePath + ".tmp"),
            "a refused write leaves no temporary litter either"
        )
    }

    /// The allowed case next to it, so the guard above cannot turn into "never
    /// rewrite": re-publishing the same operationId replaces a real entry.
    func testRewritingARealEntryIsStillAllowed() throws {
        let dir = TestSandbox.directory("entry-rewrite")
        let store = EvidenceStore(directory: dir)
        let first = pack(createdAt: "2026-09-23T00:00:00.000Z", seed: 34)
        XCTAssertTrue(store.write(first))
        let again = pack(createdAt: "2026-09-23T00:00:01.000Z", seed: 34)
        XCTAssertTrue(
            store.write(again),
            "the same operationId is this store's own entry; refusing it would break attach-time re-export"
        )
        XCTAssertEqual(mode(of: dir + "/" + again.operationId + ".json"), 0o600)
    }

    // MARK: - the published name, not just the temporary one

    /// Found by measurement while the fallback case above was being built, and
    /// the same family as the four defects this round is fixing: a check that
    /// answers for the wrong object. `replaceItemAt` hands the **destination's**
    /// attributes to the item that lands (measured: an `0600` temp file replacing
    /// an `0644` destination leaves the result `0644`), so "the mode is set while
    /// it is still the temp file" only holds for a name that does not exist yet.
    /// Every installation that predates R5-04 has a name that exists, so its
    /// evidence packs, project table and approval ledger stayed world-readable
    /// through every rewrite while all three writers reported success — the
    /// exposure the sweep at startup is supposed to end kept being *re-created*
    /// by the writers themselves, one write at a time.
    ///
    /// No fixture beyond a chmod reaches this: the precondition is an existing
    /// file at the wrong mode, which is what an old installation is.
    func testRewritingAPreExistingWorldReadableFileTightensIt() throws {
        // The evidence archive.
        let dir = TestSandbox.directory("rewrite-modes")
        let store = EvidenceStore(directory: dir)
        let pack = pack(createdAt: "2026-09-23T00:00:00.000Z", seed: 31)
        XCTAssertTrue(store.write(pack))
        let entry = dir + "/" + pack.operationId + ".json"
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: entry)
        XCTAssertEqual(mode(of: entry), 0o644, "the exposure this case exists for")
        XCTAssertTrue(store.write(pack), "a rewrite on a normal volume must still succeed")
        XCTAssertEqual(
            mode(of: entry), 0o600,
            "…and the pack has to come out owner-only, not inherit the mode it replaced"
        )

        // The project registry.
        let registryPath = TestSandbox.filePath("registry-modes")
        let registry = ProjectRegistry(filePath: registryPath)
        _ = try registry.create(displayName: "A", bundleId: "com.rewrite.a")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: registryPath)
        _ = try registry.create(displayName: "B", bundleId: "com.rewrite.b")
        XCTAssertEqual(
            mode(of: registryPath), 0o600,
            "the registry lists every project this machine may act on; a rewrite that kept 0644 would keep the leak"
        )

        // The approval ledger, and the state that has to say nothing is outstanding.
        let ledgerPath = TestSandbox.filePath("ledger-modes")
        let gate = ApprovalGate(path: ledgerPath, clock: { Date(timeIntervalSince1970: 1_800_000_000) })
        func approve(_ ref: String) {
            XCTAssertNotNil(gate.append(
                operationRef: ref,
                operationType: "restore",
                riskTier: .high,
                decision: .approve,
                approvedBy: "state-permission-test",
                reason: "rewrite mode case"
            ))
        }
        approve("snap-1")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: ledgerPath)
        approve("snap-2")
        XCTAssertNil(gate.persistFailed, "the ledger came out private, so nothing stands open: \(gate.persistFailed ?? "")")
        XCTAssertEqual(mode(of: ledgerPath), 0o600)
    }

    // MARK: - startup ordering (P8: the sweep is a mutation, so it needs the lock)

    /// The daemon's tightening pass rewrites the modes of the state root, its
    /// archive directory and every entry inside them. Until this gate existed it
    /// ran *before* the single-instance guard, so a second instance that was
    /// about to exit 65 had already chmod-ed the root of the instance that is
    /// serving requests right now — a doomed run mutating live state. The anchor
    /// comparison below is the shape this repo already uses for `main.swift`
    /// (it is top-level code in an executable target and cannot be imported), and
    /// it reads the ordering, not the wording: reordering those two lines is the
    /// regression.
    func testDaemonTightensStateOnlyAfterItWinsTheSocketName() throws {
        let source = try repoSource("engine/Sources/glasspaned/main.swift")
        let liveness = try XCTUnwrap(
            source.range(of: "socketProbe.liveness(socketPath: socketPath)"),
            "the single-instance guard's liveness probe has moved out of main.swift — update this gate deliberately"
        )
        let mask = try XCTUnwrap(
            source.range(of: "blockShutdownSignalsEarly()", range: liveness.upperBound..<source.endIndex),
            "the signal-mask anchor after the guard is gone; the slice below needs a new end"
        )
        let afterGuard = source[liveness.upperBound..<mask.lowerBound]

        let tighten = try XCTUnwrap(
            afterGuard.range(of: "stateRoot.tightenPermissions(log: log)"),
            "the startup sweep must run AFTER the liveness decision: an instance that loses the socket name and exits 65 must not have rewritten the state root of the instance that is serving"
        )
        XCTAssertNil(
            source[..<liveness.lowerBound].range(of: "tightenPermissions"),
            "nothing above the liveness probe may tighten state — that is the ordering this gate pins"
        )
        // Same slice requirement for the resolution the sweep acts on: the run
        // that names no `--state-dir` announces the home fallback only once it is
        // the service, because a run that touches nothing must not claim it
        // reads and writes a root.
        let resolution = try XCTUnwrap(
            afterGuard.range(of: "let stateRoot = resolvedStateRoot(injected: options.stateDir)"),
            "the daemon's state root is resolved before the guard decided anything"
        )
        XCTAssertLessThan(resolution.lowerBound, tighten.lowerBound)
        // And the refusal the ordering protects: exit 65 comes before the sweep.
        XCTAssertNotNil(afterGuard.range(of: "exit(65)"))
    }

    /// Reads a repo-relative source file the way `HumanInterventionAuditTests`
    /// and `EngineCoreTests` already do: `#filePath` is compiled in, so the gate
    /// does not depend on the working directory `swift test` happens to use.
    private func repoSource(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // engine
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
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
