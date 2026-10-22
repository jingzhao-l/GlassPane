import XCTest
@testable import GlassPaneEngine

/// 2026-10-22 durability round: the archive's pre-flight gate, the panel's
/// per-project count, and the socket rule's chmod-before-the-refusal.
///
/// Fixtures follow `Qoder20261019ArchiveHonestyTests` and
/// `Qoder20261019SocketLeafSymlinkTests`: a real store in the process-private
/// sandbox, real bytes written by the production write path, real modes set with
/// `chmod`, real `lstat` readings. The isolation verdict is injected **only** for
/// the volume condition a non-root test cannot build (`readOnly mount / ACL /
/// immutable flag`), which is what `EvidenceStore.isolationCheck`'s own comment
/// documents; every input that decides the branch under test is a file on disk.
final class DailyRound20261022DurabilityTests: XCTestCase {

    private func pack(createdAt: String, seed: UInt64, title: String = "X") -> EvidencePack {
        EvidencePack(
            // Same seed → same operationId (`OperationID.generate` is pure on it),
            // so two packs here are one entry rewritten, not two entries.
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

    /// `lstat` the leaf and report what it is: type, mode, inode. Read without
    /// following and without needing read permission, which is what makes it the
    /// witness for an entry this process may not open.
    private func leaf(_ path: String) throws -> stat {
        var info = stat()
        XCTAssertEqual(lstat(path, &info), 0, "lstat(\(path)) must answer: \(String(cString: strerror(errno)))")
        return info
    }

    // MARK: - 1. the pre-flight is gated on the name, not on whether the backup read worked

    /// `EvidenceStore.write` gated its pre-flight on `priorBytes != nil`, so an
    /// entry it **refused to modify but could not read** — mode 000, a foreign
    /// deny-read ACL, anything that makes `Data(contentsOf:)` throw — skipped the
    /// pre-flight. `replaceItemAt` then published over that entry (its bytes gone
    /// with the destination it replaced), the post-publish verdict failed, and with
    /// no prior bytes to restore the refusal unlinked the name as well. The archive
    /// entry that existed before the call did not exist after it: the exact outcome
    /// the comment above that call forbids.
    ///
    /// REVERT: gate the pre-flight on `priorBytes != nil` again (and let the
    /// post-publish arm fall through to `removeAfterRefusal`) → the entry is gone,
    /// so the existence, inode and byte assertions all redden. Reverting only the
    /// post-publish arm leaves the *refused* bytes on disk, which the inode and byte
    /// comparisons still catch.
    func testUnreadablePreExistingEntryIsRefusedBeforeAnythingIsPublished() throws {
        let directory = TestSandbox.directory("unreadable-entry")
        TestSandbox.assertIsolated(directory, label: "evidence")
        var logged: [String] = []
        var judged: [String] = []
        let store = EvidenceStore(
            directory: directory,
            log: EngineLog(quiet: true, sink: { data in
                logged.append(String(decoding: data, as: UTF8.self))
            })
        )
        let original = pack(createdAt: "2026-10-21T00:00:00.000Z", seed: 71, title: "Before the refusal")
        let entryPath = directory + "/" + original.operationId + ".json"
        XCTAssertTrue(store.write(original), "premise: the archive holds a real entry written by this store")
        let archivedBytes = try Data(contentsOf: URL(fileURLWithPath: entryPath))

        // The entry becomes one this process cannot read. A mode-000 file owned by
        // this uid is the production-shaped way that happens (an ACL or an
        // unsearchable parent is the same shape from the store's side: the read
        // throws), and the premise is measured rather than assumed.
        XCTAssertEqual(chmod(entryPath, 0o000), 0, "test setup: mode 000 on a real archive entry")
        guard (try? Data(contentsOf: URL(fileURLWithPath: entryPath))) == nil else {
            chmod(entryPath, 0o600)
            throw XCTSkip("this process can read a mode-000 file (running as root?), so the unreadable-entry arm is unmeasurable here and a control that cannot fail is not a control")
        }
        let before = try leaf(entryPath)
        XCTAssertEqual(Int(before.st_mode & 0o777), 0o000, "premise: the refusal below is about an entry nobody can open")

        // The volume that will not isolate a file it is handed. Non-root cannot
        // build one (`isolationCheck`'s comment is the record of that), so only
        // this verdict is injected — the entry, its mode and its bytes are real.
        store.isolationCheck = { candidate in
            judged.append(candidate)
            return candidate == entryPath
                ? "\(candidate) is still 0644 after chmod(0600)"
                : nil
        }

        let replacement = pack(createdAt: "2026-10-22T00:00:00.000Z", seed: 71, title: "Never published")
        XCTAssertEqual(replacement.operationId, original.operationId, "premise: this is a rewrite of that entry")
        XCTAssertFalse(
            store.write(replacement),
            "(i) a pack that cannot be isolated is still refused — the verdict must not soften"
        )

        XCTAssertTrue(
            FileManager.default.fileExists(atPath: entryPath),
            "(ii) revert: the refusal unlinked the name it had refused to modify, leaving no entry where one existed"
        )
        let after = try leaf(entryPath)
        XCTAssertEqual(
            after.st_ino, before.st_ino,
            "the same file, not a replacement that inherited the name (and the mode): \(Int(before.st_mode & 0o777)) → \(Int(after.st_mode & 0o777))"
        )
        XCTAssertEqual(Int(after.st_mode & 0o777), 0o000, "the refusal left the entry's own attributes alone")

        let names = try FileManager.default.contentsOfDirectory(atPath: directory)
        XCTAssertEqual(
            names.sorted(), [original.operationId + ".json"],
            "(iii) a refused-before-publishing writes nothing at all — no staged `.tmp-*` is left in the archive either"
        )
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: entryPath + ".tmp"),
            "(iii) the old fixed staging name is back: a `.tmp` here can be another writer's buffer"
        )
        // The refusal happens *before* the temp name is even written, so the only
        // judgment this call makes is the one on the name it was about to overwrite.
        XCTAssertEqual(judged, [entryPath], "nothing was staged, so nothing else was judged: \(judged)")

        // The refusal has to be readable by whoever has to act on it: with no copy
        // in hand, "nothing was published" is the whole difference between this line
        // and the one that unlinked an entry.
        let text = logged.joined()
        XCTAssertTrue(text.contains("could NOT be read"), "the refusal says the previous entry was unreadable: \(text)")
        XCTAssertTrue(text.contains("nothing was published"), "…and that nothing went out: \(text)")

        // And the surviving entry is the one that was there, byte for byte.
        XCTAssertEqual(chmod(entryPath, 0o600), 0, "cleanup: open the entry again to read what survived")
        let survivor = try leaf(entryPath)
        XCTAssertEqual(survivor.st_ino, before.st_ino, "the same inode survived the refused write")
        let survivingBytes = try Data(contentsOf: URL(fileURLWithPath: entryPath))
        XCTAssertEqual(survivingBytes, archivedBytes, "the archive still holds the bytes written before the refusal")
        XCTAssertEqual(
            store.read(operationId: original.operationId), original,
            "and the store still serves that pack, not the refused one"
        )
    }

    /// The gate is the name, so the control is that the name is not a refusal: an
    /// entry this store can read, on a volume that isolates it, is still rewritten —
    /// `EngineCore.diagnose` → `replace` → `persist` runs through exactly this path.
    ///
    /// REVERT: make the pre-flight refuse every pre-existing entry (the tempting
    /// over-correction) → the second `write` returns false and this reddens.
    func testReadablePreExistingEntryIsStillRewrittenByTheSameStore() throws {
        let directory = TestSandbox.directory("readable-rewrite")
        let store = TestSandbox.evidenceStore(at: directory)
        let original = pack(createdAt: "2026-10-21T00:00:00.000Z", seed: 72, title: "First")
        let entryPath = directory + "/" + original.operationId + ".json"
        XCTAssertTrue(store.write(original))
        XCTAssertTrue(
            store.write(pack(createdAt: "2026-10-22T00:00:00.000Z", seed: 72, title: "Second")),
            "rewriting one's own entry is the normal route; a pre-flight that refuses it is a new defect"
        )
        let landed = try Data(contentsOf: URL(fileURLWithPath: entryPath))
        let expected = try pack(createdAt: "2026-10-22T00:00:00.000Z", seed: 72, title: "Second").jsonData()
        XCTAssertEqual(landed, expected, "the archive holds the second pack under that name")
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: directory).sorted(),
            [original.operationId + ".json"],
            "and nothing was left staging"
        )
    }

    // MARK: - 2. the panel's per-project count is the daemon's count

    /// `LocalArchive.evidenceCount` counted `pathExtension == "json"`, i.e. a
    /// `settings.json`, a directory named `notes.json`, an `op_` name that is not
    /// one of the daemon's entries. `EvidenceStore.stats()` — the daemon side of the
    /// same question, and what defect 8's rule in this very file exists to keep
    /// aligned — counts only names passing `EvidenceStore.isEntryName`. One directory,
    /// two numbers, and the panel's is the one the user reads.
    ///
    /// REVERT: `listed.filter { $0.pathExtension == EvidenceStore.fileExtension }`
    /// → the count is 5 (the real entry, `settings.json`, the `O`-bearing near-miss,
    /// `op_short.json` and the directory wearing the `.json` name) and this reddens.
    func testProjectEvidenceCountCountsOnlyNamesTheDaemonWouldRead() throws {
        let directory = TestSandbox.directory("project-count-parity")
        let store = TestSandbox.evidenceStore(at: directory)
        let real = pack(createdAt: "2026-10-22T00:00:00.000Z", seed: 81)
        XCTAssertTrue(store.write(real), "premise: one entry the daemon itself wrote")

        // Foreign config file in the same directory — the shape a project's own
        // tooling leaves behind.
        try Data("{\"entries\":[]}".utf8).write(to: URL(fileURLWithPath: directory + "/settings.json"))
        // A directory wearing the extension: `FileManager.removeItem` recurses, which
        // is why the deletion scope excludes it and why `stats()` must not count it.
        try FileManager.default.createDirectory(
            atPath: directory + "/notes.json", withIntermediateDirectories: true
        )
        // Right length, wrong alphabet: the Crockford set has no `I`, `L`, `O` or
        // `U`, so swapping the last character for an `O` keeps `op_<26>.json`'s
        // shape while being a name `write` can never produce.
        let nearMiss = String(real.operationId.dropLast()) + "O"
        XCTAssertFalse(EvidenceStore.isEntryName(nearMiss + ".json"), "fixture really is a near-miss")
        try Data("{\"entries\":[]}".utf8).write(to: URL(fileURLWithPath: directory + "/" + nearMiss + ".json"))
        // `op_` prefix, not an entry.
        try Data("{}".utf8).write(to: URL(fileURLWithPath: directory + "/op_short.json"))

        let counted = try XCTUnwrap(
            LocalArchive.evidenceCount(at: directory),
            "the directory exists, so the panel owes a number rather than nil"
        )
        XCTAssertEqual(
            counted, 1,
            "revert: every `.json` name was archived evidence, so the panel's per-project number was this directory's file count"
        )
        XCTAssertEqual(store.stats().count, 1, "the daemon's `--evidence-stats` number for the same directory")
        XCTAssertEqual(
            counted, LocalArchive.scanEvidence(directory: directory).summaries.count,
            "and the panel's own two readers cannot disagree about one directory"
        )
    }

    // MARK: - 3. the socket rule measures the leaf before it touches it

    /// `SocketDirectoryRule.enforce` refused a non-directory leaf *after*
    /// `createDirectory` and `chmod(0700)` had already run on it, so
    /// `--socket-path /Users/me/notes/engine.sock` with `notes` a regular file
    /// re-permissioned a file this run has no business touching and only then said
    /// no. The file's own comment says chmod follows symlinks and that is why the
    /// leaf check comes first; the same "measure the leaf, then act" rule is
    /// `EvidenceStore.nameIsUsableArchiveDirectory`.
    ///
    /// REVERT: move the `leafNotDirectoryDefect` call below the `chmod` → the file
    /// is found at 0700 (and the exact-wording assertion reddens on `mode 0700`).
    func testSocketRuleRefusesARegularFileLeafWithoutRePermissioningIt() throws {
        let work = TestSandbox.directory("socket-leaf-file")
        chmod(work, 0o700)
        let leafPath = work + "/notes"
        let contents = Data("a file, not this run's socket directory\n".utf8)
        try contents.write(to: URL(fileURLWithPath: leafPath))
        XCTAssertEqual(chmod(leafPath, 0o644), 0, "test setup: a real file with a mode of its own")
        let before = try leaf(leafPath)
        XCTAssertEqual(Int(before.st_mode & 0o777), 0o644, "premise: the mode the owner wrote is measurable")

        let defect = try XCTUnwrap(
            SocketDirectoryRule.enforce(directory: leafPath),
            "叶子是一个普通文件时这道规则放过了它——先 chmod 再说不合法"
        )
        XCTAssertTrue(
            defect.contains("is not a directory (mode 0644)"),
            "拒绝要说出量到的那个模式，而且不许先把它改了再说：\(defect)"
        )
        XCTAssertEqual(
            defect, SocketDirectoryRule.notDirectoryDefect(leafPath, measuredMode: 0o644),
            "这一句只有一个拼法：不许在拒绝点另起一份措辞"
        )

        let after = try leaf(leafPath)
        XCTAssertEqual(
            Int(after.st_mode & 0o777), Int(before.st_mode & 0o777),
            "revert: chmod(0700) ran on a regular file this run only refused — 0\(String(format: "%o", Int(after.st_mode & 0o777))) ≠ 0\(String(format: "%o", Int(before.st_mode & 0o777)))"
        )
        XCTAssertEqual(after.st_mode, before.st_mode, "the leaf's mode is exactly what this run found, not what it set")
        XCTAssertEqual(after.st_ino, before.st_ino, "the name still holds the same file")
        XCTAssertTrue((after.st_mode & S_IFMT) == S_IFREG, "it is still the regular file it was")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: leafPath)), contents, "and its bytes are untouched")
    }

    /// The control, the arm that keeps this from being a rule that refuses every
    /// first run: `lstat` failing with ENOENT is not a defect, so an absent leaf is
    /// still created at 0700 by the sequence the pre-flight now guards.
    ///
    /// REVERT: answer the pre-flight with a defect when `lstat` fails (instead of
    /// `nil`) → no socket directory is ever created and this reddens.
    func testSocketRuleStillCreatesAnAbsentLeaf() throws {
        let work = TestSandbox.directory("socket-leaf-absent")
        chmod(work, 0o700)
        let leafPath = work + "/state"
        XCTAssertNil(SocketDirectoryRule.leafNotDirectoryDefect(leafPath), "名字还不在这儿，就没有东西被改动")
        let defect = SocketDirectoryRule.enforce(directory: leafPath)
        XCTAssertNil(defect, "第一次运行仍然要能把自己指名的目录建出来：\(defect ?? "nil")")
        let info = try leaf(leafPath)
        XCTAssertTrue((info.st_mode & S_IFMT) == S_IFDIR, "建出来的还是目录")
        XCTAssertEqual(Int(info.st_mode & 0o777), 0o700, "createDirectory + chmod 的属性照旧落在这个新建的目录上")
    }
}
