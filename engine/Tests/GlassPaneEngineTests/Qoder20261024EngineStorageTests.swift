import XCTest
@testable import GlassPaneEngine

/// 2026-10-24 unattended-engine lane: semantic / storage / protocol fixes.
///
/// One test per numbered defect, written so that **reverting the fix turns the
/// named assertion red** (each case says where). The fixtures follow
/// `DailyRound20261022DurabilityTests` and `Qoder20261019ArchiveHonestyTests`:
/// a real registry/store inside `TestSandbox`, real bytes written by the
/// production write path, and an injected judgment **only** for the volume
/// condition a non-root test cannot build — which is the reason
/// `ProjectRegistry.isolationCheck` and `EvidenceStore.isolationCheck` exist.
final class Qoder20261024EngineStorageTests: XCTestCase {

    // MARK: - Helpers

    private func pack(seed: UInt64) -> EvidencePack {
        EvidencePack(
            operationId: OperationID.generate(
                milliseconds: seed,
                entropy: [UInt8](repeating: UInt8(seed & 0xFF), count: 10),
                prefix: OperationID.prefix
            ),
            createdAt: "2026-10-24T00:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "Submit"),
                    action: .press,
                    actConfirmed: true
                )
            )
        )
    }

    private func json(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    private func decodedRegistry(_ path: String) throws -> [ProjectEntry] {
        try JSONDecoder().decode(
            [ProjectEntry].self, from: Data(contentsOf: URL(fileURLWithPath: path))
        )
    }

    // MARK: - A1: a refusal raised *after* publication must not fork memory from disk

    /// The defect: `save()` throws the owner-only refusal on the published name
    /// (ProjectRegistry.swift:520-526) although `replaceItemAt` + `syncPublished`
    /// + `verifySaved` already succeeded — the disk holds the new table — while
    /// `create()`'s catch did `projects.removeLast()` and `loadedIdentity` had
    /// already advanced to the new bytes (:459). The caller heard "write failed"
    /// about a write that had landed.
    ///
    /// REVERT → red at `XCTAssertEqual(registry.all.count, 1)`: the old catch
    /// rolled the in-memory table back, so memory said 0 while disk said 1.
    func testPostPublishIsolationRefusalKeepsMemoryAndDiskOnOneTable() throws {
        let path = TestSandbox.filePath("a1-published-refusal")
        let registry = ProjectRegistry(filePath: path)
        registry.isolationCheck = { subject in
            subject == path
                ? "\(subject) is still 0644 after chmod(0600)"
                : nil
        }

        var thrown: GPError?
        do {
            _ = try registry.create(displayName: "landed but exposed", bundleId: "com.example.a1")
        } catch let error as GPError {
            thrown = error
        }
        guard let refusal = thrown else {
            return XCTFail("the published-but-not-owner-only write must still be refused out loud")
        }
        XCTAssertEqual(refusal.code, .internalError)
        XCTAssertTrue(
            refusal.message.contains("landed but is not owner-only"),
            "the refusal has to stay the refusal it was: \(refusal.message)"
        )

        // 盘上量到的那一条：写真的落进去了。
        let onDisk = try decodedRegistry(path)
        XCTAssertEqual(onDisk.count, 1, "the table on disk is the new one — the write landed")

        // 内存必须与盘一致（A1 的核心断言）。
        XCTAssertEqual(
            registry.all.count, 1,
            "a refusal raised after publication must not fork the in-memory table from the file: memory says \(registry.all.count), the file says \(onDisk.count)"
        )
        XCTAssertNotNil(
            registry.get(onDisk[0].projectId),
            "the registration that is on disk has to be findable in this process too"
        )
    }

    /// A1's second, worse half: with the memory table rolled back and
    /// `loadedIdentity` pointing at the new bytes, the *next* legitimate write
    /// passes `requireUnchangedSinceLoad` and publishes a table that silently
    /// lacks the registration that really landed.
    ///
    /// REVERT → red at `XCTAssertEqual(afterSecond.count, 2)` (old code wrote one
    /// entry, the first registration gone without a word).
    func testRefusedButLandedRegistrationSurvivesTheNextCreate() throws {
        let path = TestSandbox.filePath("a1-next-write")
        let registry = ProjectRegistry(filePath: path)
        registry.isolationCheck = { subject in
            subject == path ? "\(subject) is still 0644 after chmod(0600)" : nil
        }
        var landedProjectId = ""
        do {
            let entry = try registry.create(displayName: "first, landed", bundleId: "com.example.one")
            landedProjectId = entry.projectId
        } catch let error as GPError {
            landedProjectId = try XCTUnwrap(
                decodedRegistry(path).first?.projectId,
                "the refusal says the table landed: \(error.message)"
            )
        }
        XCTAssertFalse(landedProjectId.isEmpty)

        // 现场修好了（判定回到真判定），下一次写必须成功，而且不许把第一条挤掉。
        registry.isolationCheck = StateRoot.isolateFile(at:)
        _ = try registry.create(displayName: "second", bundleId: "com.example.two")

        let afterSecond = try decodedRegistry(path)
        XCTAssertEqual(
            afterSecond.count, 2,
            "the registration that had already reached disk was silently dropped by the next write"
        )
        XCTAssertTrue(
            afterSecond.contains { $0.projectId == landedProjectId },
            "the landed entry has to still be on disk: \(afterSecond.map(\.displayName))"
        )
    }

    // MARK: - A3: an id is whole-string or it is not an id

    /// The defect: `operationIdPattern`/`snapshotIdPattern` are judged with
    /// `range(of:options:.regularExpression)`, and `NSRegularExpression`'s `$`
    /// also matches before a trailing newline — so `"op_…\n"` was admitted, while
    /// `Dispatcher.swift:210-212` states the value keys an on-disk file name.
    ///
    /// REVERT → red at both `XCTAssertThrowsError` calls (HEAD returns the value).
    func testIdWithTrailingNewlineIsRejectedNotAdmitted() throws {
        let operationId = "op_0123456789ABCDEFGHJKMNPQRS"
        let snapshotId = "snap_0123456789ABCDEFGHJKMNPQRS"
        for suffix in ["\n", "\r\n", "\n\n"] {
            XCTAssertThrowsError(
                try ParamValidation.requireOperationId(["operationId": operationId + suffix]),
                "a \(suffix.debugDescription)-suffixed operationId must not be admitted: it keys the archive file name"
            ) { error in
                XCTAssertEqual((error as? GPError)?.code, .badParams)
            }
            XCTAssertThrowsError(
                try ParamValidation.requireSnapshotId(["snapshotId": snapshotId + suffix]),
                "same rule for snapshotId"
            ) { error in
                XCTAssertEqual((error as? GPError)?.code, .badParams)
            }
            // 行首/行中的换行也一样：匹配必须覆盖整条串。
            XCTAssertThrowsError(
                try ParamValidation.requireOperationId(["operationId": suffix + operationId])
            )
        }
        // 对照：整条就是 id 的照旧通过（拒绝不是因为"任何非空输入"）。
        XCTAssertEqual(
            try ParamValidation.requireOperationId(["operationId": operationId]), operationId
        )
        // 错误句要说得出量到的东西，而不是只重贴一遍模式。
        do {
            _ = try ParamValidation.requireOperationId(["operationId": operationId + "\n"])
            XCTFail("unreachable")
        } catch let error as GPError {
            XCTAssertTrue(
                error.message.contains("30 UTF-16 units"),
                "the refusal must name what it measured: \(error.message)"
            )
            XCTAssertTrue(error.message.contains("line break"), error.message)
        }
    }

    /// A3 的同源要求: the parameter side and the archive side judge with one
    /// function, so a value cannot be "a valid id" for `requireOperationId` and
    /// "not one of my entries" for `EvidenceStore.isEntryName` at the same time.
    ///
    /// REVERT (either side back to its own judgment) → red at the equality.
    func testIdJudgmentIsTheSameFunctionOnBothSides() {
        let body = String(repeating: "0", count: OperationID.totalLength)
        let candidates = [
            "op_" + body,                       // the real shape
            "op_" + body + "\n",                // A3: newline-suffixed
            "\nop_" + body,                     // newline-prefixed
            "op_" + body + "x",                 // one unit long
            "op_" + body.dropLast(),            // one unit short
            "op_" + body.lowercased(),          // wrong case is not Crockford here
            "appr_" + body,                     // another family's prefix
        ]
        for candidate in candidates {
            XCTAssertEqual(
                ParamValidation.matchesOperationId(candidate),
                EvidenceStore.isEntryName(candidate + "." + EvidenceStore.fileExtension),
                "one id, two verdicts: the parameter accepts what the archive cannot name — \(candidate.debugDescription)"
            )
        }
        // 而且这一族真的有一条被两边曾经判反的输入。
        XCTAssertFalse(ParamValidation.matchesOperationId("op_" + body + "\n"))
    }

    /// The same exposure inside `EvidenceModels`: a pack read back from untrusted
    /// JSON is judged by these patterns, and its operationId is the archive name.
    ///
    /// REVERT → red at `XCTAssertThrowsError` (HEAD's `firstMatch` accepted both).
    func testDecodedPackAndLedgerRejectNewlineSuffixedPatternFields() throws {
        let base = pack(seed: 7)
        let newlineId = base.operationId + "\n"
        let damaged = EvidencePack(
            operationId: newlineId,
            createdAt: base.createdAt,
            attribution: base.attribution,
            circuitBreaker: base.circuitBreaker,
            signals: base.signals,
            assertion: base.assertion,
            diagnosis: base.diagnosis
        )
        XCTAssertThrowsError(try damaged.validateInvariants(), "a pack whose id carries a newline must not validate") { error in
            XCTAssertEqual(error as? EvidencePackError, .badOperationId(newlineId))
        }
        XCTAssertThrowsError(
            try EvidencePack(
                operationId: base.operationId,
                createdAt: base.createdAt + "\n",
                attribution: base.attribution,
                circuitBreaker: base.circuitBreaker,
                signals: base.signals
            ).validateInvariants(),
            "same rule for createdAt"
        )

        let entry = DecisionLogEntry(
            entryId: "dl_" + String(repeating: "0", count: OperationID.totalLength),
            sequence: 0,
            prevEntryHash: String(repeating: "a", count: 64) + "\n",
            summary: "genesis",
            outcome: .pass,
            createdAt: "2026-10-24T00:00:00.000Z"
        )
        XCTAssertThrowsError(
            try entry.validateInvariants(),
            "a hash-chained field whose pattern is anchored must not accept a newline"
        )
    }

    // MARK: - A12: the unit a length cap counts

    /// Cross-language readers are real, which is what makes this a defect rather
    /// than a style choice: `mcp-shell/src/project-registry.ts:413` applies
    /// `z.string().max(256)` (JavaScript `.length` = UTF-16 units) and
    /// `mcp-shell/src/tools.ts:694` publishes `maxLength: 256` for the same field.
    ///
    /// REVERT → red at `XCTAssertThrowsError` (grapheme `String.count` said 256).
    func testDisplayNameCapCountsUtf16UnitsLikeThePublishedReader() throws {
        let registry = ProjectRegistry(filePath: TestSandbox.filePath("a12-display-name"))
        let combining = String(repeating: "e\u{0301}", count: ProjectEntry.maxDisplayNameLength)
        XCTAssertEqual(combining.count, 256, "fixture premise: 256 grapheme clusters")
        XCTAssertEqual(combining.utf16.count, 512, "…and 512 UTF-16 code units")
        XCTAssertThrowsError(
            try registry.create(displayName: combining, bundleId: "com.example.a12"),
            "a name the shell and the published schema refuse must not be admitted here"
        ) { error in
            let gpError = try! XCTUnwrap(error as? GPError)
            XCTAssertEqual(gpError.code, .badParams)
            XCTAssertTrue(
                gpError.message.contains("UTF-16 code units"),
                "the refusal has to name the unit it judged in: \(gpError.message)"
            )
        }
        XCTAssertEqual(registry.all.count, 0, "a refused create writes nothing")

        // 对照：正好 256 个码元的名字照旧收下——拒绝不是因为换了个更严的判据。
        let atCap = String(repeating: "n", count: ProjectEntry.maxDisplayNameLength)
        let entry = try registry.create(displayName: atCap, bundleId: "com.example.a12b")
        XCTAssertEqual(entry.displayName, atCap)

        // `update` 同一条判据（从前是两处 `String.count`）。
        XCTAssertThrowsError(try registry.update(projectId: entry.projectId, displayName: combining))
        XCTAssertEqual(
            try decodedRegistry(registry.filePath).first?.displayName, atCap,
            "a refused update must not reach the file"
        )
    }

    /// A12's other side: which of the `String.count` sites is **not** a defect,
    /// stated with the evidence that makes it so. Every field below is judged by a
    /// pattern whose character class is ASCII-only, so any value that survives the
    /// pattern has `count == utf16.count == unicodeScalars.count`: there is no
    /// input for the three units to disagree about. `dimensionMaxLength` is the
    /// one with a visible cap, so it is pinned here rather than left to argument.
    func testAsciiClassFieldsCannotSplitAcrossLengthUnits() throws {
        let ascii64 = String(repeating: "a", count: DecisionLogEntry.dimensionMaxLength)
        let entry = DecisionLogEntry(
            entryId: "dl_" + String(repeating: "0", count: OperationID.totalLength),
            sequence: 0,
            prevEntryHash: "",
            summary: "cap",
            outcome: .pass,
            createdAt: "2026-10-24T00:00:00.000Z",
            dimension: ascii64
        )
        XCTAssertNoThrow(try entry.validateInvariants(), "64 ASCII units is 64 of every unit")
        XCTAssertThrowsError(
            try DecisionLogEntry(
                entryId: entry.entryId, sequence: 0, prevEntryHash: "",
                summary: "over", outcome: .pass,
                createdAt: "2026-10-24T00:00:00.000Z",
                dimension: ascii64 + "-x"
            ).validateInvariants()
        )
        // 非 ASCII 的 dimension 在**模式**那一关就被拒了，根本走不到长度判据：
        // 这就是"单位在这里不构成两个判决"的证据。
        XCTAssertThrowsError(
            try DecisionLogEntry(
                entryId: entry.entryId, sequence: 0, prevEntryHash: "",
                summary: "combining", outcome: .pass,
                createdAt: "2026-10-24T00:00:00.000Z",
                dimension: String(repeating: "e\u{0301}", count: 10)
            ).validateInvariants(),
            "the pattern, not the unit, is what decides this field"
        )
    }

    // MARK: - A4 / A11: a non-durability staging failure must leave no residue, and must say why

    /// The defect: `stage()` failing on `open`/`write` (ENOSPC, EDQUOT — the
    /// `isDurabilityFault == false` family) fell into `EvidenceStore.write`'s
    /// generic catch, which neither removed `<op>.json.tmp-<pid>-<uuid>` nor
    /// logged the primary reason. A `.tmp-*` name fails `isEntryName`, so
    /// `clear()`, both prunes and `stats()` walk past it: one orphan per failed
    /// write, forever, on a full disk.
    ///
    /// REVERT → red at `XCTAssertEqual(entries, [expected])` (HEAD leaves the
    /// staged temp behind) and at the log-line assertions (HEAD logs nothing).
    func testStagingFailureCleansItsTempFileAndLogsThePrimaryReason() throws {
        let dir = TestSandbox.directory("a4-staging-residue")
        var lines: [String] = []
        let store = EvidenceStore(
            directory: dir,
            log: EngineLog(quiet: true, sink: { lines.append(String(decoding: $0, as: UTF8.self)) })
        )
        let stagedName = "staged-name-is-known-here"
        store.temporaryPath = { $0 + "." + stagedName }

        let live = DurableFileWrite.Operations.live
        store.durableWriteOperations = DurableFileWrite.Operations(
            open: live.open,
            // 盘满：`open` 已经独占创建了那个名字，`write` 才回 ENOSPC。
            write: { _, _, _ in -1 },
            fsync: live.fsync,
            close: live.close,
            lastErrno: { ENOSPC }
        )
        let pack = pack(seed: 11)
        XCTAssertTrue(
            store.write(pack),
            "the fallback route is the designed answer for a staging failure, so this write still lands"
        )

        let entries = try FileManager.default.contentsOfDirectory(atPath: dir)
        XCTAssertEqual(
            entries.sorted(), [pack.operationId + "." + EvidenceStore.fileExtension],
            "a `.tmp-*` orphan is invisible to `clear()`, both prunes and `stats()` — nothing would ever reclaim it"
        )
        XCTAssertTrue(
            lines.contains { $0.contains("staging via") && $0.contains(stagedName) && $0.contains("falling back") },
            "A11: the primary reason and the route taken have to be in the log, as ApprovalGate already does: \(lines)"
        )
        XCTAssertTrue(
            lines.contains { $0.contains(stagedName) && $0.contains("systemError") },
            "the staging error the fallback replaced has to be quoted, not dropped: \(lines)"
        )
    }

    /// The staged temp is only ever ours when it is a regular file. A squatting
    /// directory is somebody else's data, and this type's declared blast radius is
    /// its own `op_<26>.json` entries — `StatePermissionTests
    /// .testEntryNameHeldByADirectoryIsRefusedAndLeftIntact` pins that promise —
    /// so A4's cleanup must not turn into a recursive delete.
    func testCleanupRefusesToRemoveSomethingThatIsNotARegularFile() throws {
        let dir = TestSandbox.directory("a4-squatter")
        var lines: [String] = []
        let store = EvidenceStore(
            directory: dir,
            log: EngineLog(quiet: true, sink: { lines.append(String(decoding: $0, as: UTF8.self)) })
        )
        let pack = pack(seed: 12)
        let filePath = dir + "/" + pack.operationId + "." + EvidenceStore.fileExtension
        store.temporaryPath = { $0 + ".squatter" }
        try FileManager.default.createDirectory(
            atPath: filePath + ".squatter/sub", withIntermediateDirectories: true
        )
        try "someone else's data".write(
            toFile: filePath + ".squatter/sub/keep.txt", atomically: true, encoding: .utf8
        )

        XCTAssertTrue(
            store.write(pack),
            "the staging name is unusable (a directory squats on it) — that is exactly the fallback's case"
        )
        XCTAssertEqual(
            try String(contentsOfFile: filePath + ".squatter/sub/keep.txt", encoding: .utf8),
            "someone else's data",
            "the cleanup may only ever withdraw a regular file this process created"
        )
        XCTAssertTrue(
            lines.contains { $0.contains("not a regular file this process created") },
            "the decline has to be said out loud, not just done silently: \(lines)"
        )
    }

    // MARK: - A5: no remedy may point at a step that needs the thing that is missing

    /// REVERT → red at `testSelfReferentialDefaultsAreGone`.
    func testDefaultRemediesForMissingOperationNameOnlyAStepThatWorks() {
        for code in [GPErrorCode.noOperation, .noEvidence] {
            let remedy = GPError.remedy(for: code)
            XCTAssertTrue(
                remedy.lowercased().contains("run act") || remedy.lowercased().contains("act first"),
                "\(code.rawValue): the executable next step is an act: \(remedy)"
            )
            XCTAssertFalse(
                remedy.contains("run act or assert_element first"),
                "\(code.rawValue): the old text told the caller to run a method that itself requires a recorded operation"
            )
            XCTAssertFalse(
                remedy.contains("(act/assert_element/diagnose)"),
                "\(code.rawValue): three names, two of which cannot be the first step: \(remedy)"
            )
        }
        // 只点名这条二进制真解析的命令（`HumanInterventionAuditTests` 扫同一件事）。
        XCTAssertTrue(
            GPError.remedy(for: .noEvidence).contains("--evidence-stats"),
            "the check-an-id step has to name a command that exists"
        )
    }

    /// `diagnose` and `last_evidence` used to eat those defaults.
    ///
    /// REVERT → red at `XCTAssertFalse(remedy.contains("assert_element first"))`
    /// (HEAD's answer for this arm *is* the default sentence).
    func testDiagnoseAndLastEvidenceRemediesArePerArm() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.a5", pid: nil)

        XCTAssertThrowsError(try core.diagnose(operationId: nil)) { error in
            let gpError = try! XCTUnwrap(error as? GPError)
            XCTAssertEqual(gpError.code, .noOperation)
            XCTAssertFalse(
                gpError.remedy.contains("assert_element first"),
                "a remedy that routes through assert_element dies here: \(gpError.remedy)"
            )
            XCTAssertTrue(gpError.remedy.contains("only `act` records"), gpError.remedy)
        }
        XCTAssertThrowsError(
            try core.lastEvidence(operationId: "op_0123456789ABCDEFGHJKMNPQRS")
        ) { error in
            let gpError = try! XCTUnwrap(error as? GPError)
            XCTAssertEqual(gpError.code, .noEvidence)
            XCTAssertTrue(
                gpError.remedy.contains("--evidence-stats"),
                "an unknown id is not 'no evidence exists'; the caller has to be able to see what is stored: \(gpError.remedy)"
            )
            XCTAssertFalse(gpError.remedy.contains("assert_element/diagnose"), gpError.remedy)
        }
    }

    // MARK: - A7: a stream that stopped with a reason is not a timeout

    /// REVERT → red at the two absence assertions: HEAD folded every "no frame"
    /// into `.timedOut` and published "timed out after 5s **or stream stopped**".
    func testStreamStopReasonIsNotFoldedIntoATimeout() throws {
        let reason = "kCGErrorIllegalArgument: stream was interrupted"
        XCTAssertEqual(
            SCKCapturer.classifyFirstFrame(arrived: false, stopErrorDescription: reason),
            .stopped(errorDescription: reason),
            "a cause the stream reported itself may not be re-labelled as timing"
        )
        XCTAssertEqual(
            SCKCapturer.classifyFirstFrame(arrived: false, stopErrorDescription: nil), .timedOut
        )
        XCTAssertEqual(
            SCKCapturer.classifyFirstFrame(arrived: true, stopErrorDescription: reason),
            .frameArrived
        )

        let stopped = SCKCapturer.firstFrameAbsenceReason(
            .stopped(errorDescription: reason), timeoutSeconds: 5
        )
        XCTAssertTrue(stopped.contains(reason), stopped)
        XCTAssertFalse(stopped.contains("timed out"), "the known cause must not be reported as a timeout: \(stopped)")

        let timedOut = SCKCapturer.firstFrameAbsenceReason(.timedOut, timeoutSeconds: 5)
        XCTAssertTrue(timedOut.contains("timed out after 5.0s"), timedOut)
        XCTAssertFalse(
            timedOut.contains("stream stopped"),
            "the folded half of the old sentence has a branch of its own now: \(timedOut)"
        )
    }

    // MARK: - A10: a source that cannot answer "what is pending" must not read as idle

    /// REVERT (restore `peekAvailable()`'s `[]` default) → red at
    /// `XCTAssertEqual(verdict.monitored, false)`: the gate silently never ran and
    /// the window was archived as fully watched.
    func testSourceWithoutIdlePeekFailsClosedIntoTheContaminationVerdict() throws {
        let source = NoPeekInputSource(events: [
            InputEvent(timestamp: 999.9, source: .human)
        ])
        XCTAssertTrue(
            source is InputSourceMonitoring,
            "the honest route reuses the channel the guard already asks (`AttributionGuard.swift:111-114`), it is not a new comment"
        )
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired, "the busy gate has nothing to measure, and must not pretend otherwise")
        let verdict = guard_.releaseOperationRight()
        XCTAssertEqual(verdict.monitored, false, "an un-peekable stream is an unmeasured window, not a clean one")
        XCTAssertTrue(verdict.contaminated, "'not measured' may only ever fold to the conservative value")
        XCTAssertTrue(
            verdict.monitoringFault?.contains("idle-input gate is not enabled") == true,
            "the reason has to name the gate that was not enabled: \(verdict.monitoringFault ?? "nil")"
        )
    }

    /// The same fact at the surface that publishes the claim: `EngineCore.swift
    /// :1309-1312` says "the input stream was watched for the whole operation
    /// window", and that sentence must not be reachable for such a source.
    func testUnpeekableSourceNeverPublishesTheWatchedWholeWindowClaim() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let guard_ = AttributionGuard(
            inputSource: NoPeekInputSource(events: []),
            clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        let core = EngineCore(
            channel: channel, clock: { Date(timeIntervalSince1970: 1_000) },
            settle: {}, attributionGuard: guard_
        )
        _ = try core.attach(bundleId: "com.example.a10", pid: nil)
        let result = try core.act(
            selector: Selector(role: "AXButton", title: "Submit"), action: .press
        )
        XCTAssertEqual(result["contaminationMonitored"] as? Bool, false)
        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        XCTAssertFalse(
            basis.contains("watched for the whole operation window"),
            "the basis would be claiming a watch nobody installed: \(basis)"
        )
        XCTAssertTrue(basis.contains("idle-input gate is not enabled"), basis)
        // 归因强度是这条折叠真正买到的东西：未测量的窗口不配升级。
        let recorded = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(
            recorded.attribution.level, .weak,
            "an unmeasured window must not earn an attribution upgrade"
        )
        XCTAssertNotNil(
            recorded.circuitBreaker.reason?
                .range(of: "input-contamination-monitor-lost"),
            "the pack must carry the label as well as the sentence: \(recorded.circuitBreaker.reason ?? "nil")"
        )
    }

    // MARK: - E1: the method_not_found sentence must match what is dispatched

    /// FrameCodec.swift:151 claimed "the methods it does answer are
    /// <capabilityWireNames>" while `Dispatcher.swift:94` executes `shutdown`.
    /// REVERT → red at `XCTAssertTrue(message.contains("shutdown"))`.
    func testMethodNotFoundNamesTheOperationalMethodsSeparately() throws {
        guard case .failure(let failure) = RequestParser.parse(
            Data(#"{"id":3,"method":"teleport","params":{}}"#.utf8)
        ) else { return XCTFail("an unknown method must be refused") }
        XCTAssertEqual(failure.error.code, .methodNotFound)
        let message = failure.error.message
        XCTAssertTrue(
            message.contains("shutdown"),
            "the daemon answers shutdown; a caller told otherwise goes looking for a way to stop it: \(message)"
        )
        XCTAssertTrue(message.contains("hello"), message)
        XCTAssertTrue(
            message.contains("`capabilities`") || message.contains("capabilities"),
            "the two lists have to be told apart by name: \(message)"
        )
        // 清单仍然是派生的，不是抄的：两个派生集合必须互补且互斥。
        XCTAssertEqual(
            Set(EngineMethod.allCases.map(\.rawValue)),
            Set(EngineMethod.capabilityWireNames).union(EngineMethod.unadvertisedMethodWireNames)
        )
        XCTAssertTrue(EngineMethod.unadvertisedMethodWireNames.contains("shutdown"))
        XCTAssertFalse(
            EngineMethod.capabilityWireNames.contains("shutdown"),
            "the fix must not go the other way: shutdown is not a capability hello advertises"
        )
    }

    // MARK: - E2: a recipe step's params have to be keys that method actually reads

    /// The panel's built-in template hands out `observe` with
    /// `{"selector":{role,title}}`, and `observe` reads only `maxDepth`/`role`
    /// (`Dispatcher.swift:120,164-171`) — the frame would be refused by
    /// `requireOnlyReadParamKeys`. Shape-only validation called that "valid".
    ///
    /// REVERT → red at `XCTAssertFalse(result.valid)`.
    func testRecipeStepParamsMustBelongToTheMethodTheyAreWrittenUnder() throws {
        func recipe(_ steps: [[String: Any]]) -> Data {
            json([
                "schemaVersion": RecipeLoader.schemaVersion,
                "name": "template",
                "steps": steps,
            ])
        }
        let offending = RecipeLoader.validate(recipe([
            ["kind": "observe", "params": ["selector": ["role": "AXButton", "title": "Submit"]]]
        ]))
        XCTAssertFalse(offending.valid, "an `observe` step whose params name a selector cannot be dispatched at all")
        XCTAssertTrue(
            offending.errors.contains {
                $0.contains("steps[0].params' has key 'selector'") && $0.contains("does not read")
            },
            offending.errors.joined(separator: "\n")
        )

        // 接受集来自 `Dispatcher.acceptedParamKeys`，所以对照也必须由同一张表说出：
        // 每一步用"这个方法真读的那几个键"当 params，都必须判过——否则新规则是在
        // 拒绝一个线上接受得下的配方（那是把缺陷换成一个更严的语言，本文件反对的东西）。
        for (kind, method) in RecipeLoader.stepKindMethods {
            let accepted = Dispatcher.acceptedParamKeys[method] ?? []
            let params = Dictionary(
                uniqueKeysWithValues: accepted.map { ($0, NSNull() as Any) }
            )
            let result = RecipeLoader.validate(recipe([["kind": kind, "params": params]]))
            XCTAssertTrue(
                result.valid,
                "\(kind): params drawn from what `\(method.rawValue)` reads must validate: \(result.errors)"
            )
        }

        // 冻结契约自己的夹具必须继续合法：这条新规则不许把 kernel 的 ok 文件判成非法
        // （两个校验器接受不相交的语言，正是 R4-02 要拆的东西）。
        let fixture = RecipeLoader.validate(try KernelFixtures.data("recipe-config.ok-01.json"))
        XCTAssertTrue(fixture.valid, "kernel fixture rejected by the new rule: \(fixture.errors)")

        // 没有执行器这条结论要随结果一起交出去（面板/CLI 指的是这里，不是文案）。
        XCTAssertTrue(
            fixture.notes.contains { $0.contains("no recipe executor exists in this build") },
            fixture.notes.joined(separator: "\n")
        )
        XCTAssertTrue(
            fixture.notes.contains { $0.contains("assert_element") },
            "the file's `assert` is the wire's `assert_element`; that has to be said somewhere: \(fixture.notes)"
        )
        // notes 不参与判定：一条都不许出现在 errors 里。
        XCTAssertTrue(fixture.errors.isEmpty)
    }

    // MARK: - P3: nested unknown keys must be refused like top-level ones

    /// REVERT → red at `XCTAssertThrowsError` (HEAD silently dropped `titel`).
    func testUnknownSelectorKeyIsRefusedNotIgnored() throws {
        XCTAssertThrowsError(
            try ParamValidation.requireSelector([
                "selector": ["role": "AXButton", "titel": "Submit"]
            ]),
            "a mistyped title was dropped, so the act matched with no title constraint"
        ) { error in
            let gpError = try! XCTUnwrap(error as? GPError)
            XCTAssertEqual(gpError.code, .badParams)
            XCTAssertTrue(gpError.message.contains("'titel'"), gpError.message)
            XCTAssertTrue(gpError.message.contains("identifier"), gpError.message)
        }
        // `steps[i]` 同一判据（ffwd 的重演会进哈希链台账）。
        XCTAssertThrowsError(
            try ParamValidation.optSteps([
                "steps": [["selector": ["role": "AXButton"], "action": "press", "delay": 1]]
            ]),
            "an ignored `delay` changes what a replay replays"
        ) { error in
            XCTAssertTrue(((error as? GPError)?.message ?? "").contains("'delay'"))
        }
        // 对照：契约允许的键集照旧全通过（拒绝不是因为更严的语言，是因为未知键）。
        let ok = try ParamValidation.requireSelector([
            "selector": ["role": "AXButton", "title": "Submit", "identifier": "submit-1"]
        ])
        XCTAssertEqual(ok.identifier, "submit-1")
        XCTAssertNotNil(try ParamValidation.optSteps([
            "steps": [["selector": ["role": "AXButton"], "action": "press"]]
        ]))
    }

    /// The nested accepted sets are not a hand copy: they have to be exactly the
    /// properties `Selector` carries. REVERT/remove a key → red here.
    func testNestedAcceptedKeyListsAreDerivedFromTheTypeTheyValidate() {
        let properties = Set(Mirror(reflecting: Selector(role: "AXButton", title: nil, identifier: nil))
            .children.compactMap { $0.label })
        XCTAssertEqual(
            Set(ParamValidation.selectorKeys), properties,
            "`Selector` grew or lost a stored property without the whitelist following"
        )
        XCTAssertEqual(Set(ParamValidation.ffwdStepKeys), ["selector", "action"])
    }
}

/// A10 的夹具：只有消费式读法、没有非破坏性快照的源，走协议给它的登记路线。
/// 它**不**实现 `peekAvailable()`——那是 `InputEventSourceWithoutIdlePeek` 的默认实现，
/// 而 A10 之后 `InputEventSource` 不再提供任何 `peekAvailable` 默认值。
private final class NoPeekInputSource: InputEventSourceWithoutIdlePeek {
    private var queue: [InputEvent]
    init(events: [InputEvent]) { queue = events }
    func nextEvent() -> InputEvent? { queue.isEmpty ? nil : queue.removeFirst() }
    var idlePeekUnavailableReason: String { "this source only pops; it keeps no snapshot to read" }
}
