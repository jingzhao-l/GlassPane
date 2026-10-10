import XCTest
@testable import GlassPaneEngine

/// The storage-side findings of this round's review, one named case each.
///
/// The invariant they all sit under: when a file cannot be read, the answer is
/// "I could not look" — never "nothing exists", and never a rewrite that quietly
/// destroys what was on disk. Each case states in its own failure message which
/// revert it is watching, so a green run says the guard ran rather than that the
/// fixture happened to be forgiving.
final class ReviewStorageTests: XCTestCase {

    // MARK: - CanonicalJSON (finding 4: the two languages must digest one tree)

    /// NaN/±Infinity are reachable from an AX geometry read. `JSON.stringify`
    /// answers `null` for them; `String(describing:)` answered `nan`/`inf`, which
    /// is not JSON at all, so one tree canonicalised into different bytes on each
    /// side — and `treeDigest` is taken over these bytes on both.
    func testNonFiniteDoublesCanonicaliseToNullTheWayJSONStringifyDoes() {
        XCTAssertEqual(
            CanonicalJSON.stringify(["v": Double.nan]), "{\"v\":null}",
            "revert: NaN reached `String(describing:)` and printed the non-JSON word `nan`"
        )
        XCTAssertEqual(
            CanonicalJSON.stringify(["v": Double.infinity]), "{\"v\":null}",
            "revert: +Infinity printed `inf`"
        )
        XCTAssertEqual(
            CanonicalJSON.stringify(["v": -Double.infinity]), "{\"v\":null}",
            "revert: -Infinity printed `-inf`"
        )
        // Nested values reach the same branch, and the tree stays parseable JSON.
        XCTAssertEqual(CanonicalJSON.stringify(["a": [Double.nan]]), "{\"a\":[null]}")
        let bytes = Data(CanonicalJSON.stringify(["v": Double.nan]).utf8)
        let reparsed = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
        XCTAssertTrue(reparsed?["v"] is NSNull,
                      "the canonical bytes must still parse on the way out: \(String(decoding: bytes, as: UTF8.self))")
    }

    /// 9e15 is integral and exactly representable, but Swift's shortest-roundtrip
    /// description is `9.0e+15` where `JSON.stringify(9e15)` is
    /// `9000000000000000`. Two canonical spellings of one number, so two digests.
    func testIntegralDoublesAtOrAboveTwoPowerFiftyThreePrintInFixedNotation() {
        XCTAssertEqual(
            CanonicalJSON.stringify(["v": 9.0e15]), "{\"v\":9000000000000000}",
            "revert: the old `< 9.0e15` bound fell through to exponent form"
        )
        XCTAssertEqual(
            CanonicalJSON.stringify(["v": 9_007_199_254_740_992.0]),  // 2^53
            "{\"v\":9007199254740992}",
            "revert: 2^53, the exact-integer edge, printed as `9.007199254740992e+15`"
        )
        XCTAssertEqual(CanonicalJSON.stringify(["v": -9.0e15]), "{\"v\":-9000000000000000}")
        // Below the old bound nothing moved: the small-integral form is what it was.
        XCTAssertEqual(CanonicalJSON.stringify(["v": 3.0]), "{\"v\":3}")
        XCTAssertEqual(CanonicalJSON.stringify(["v": -0.0]), "{\"v\":0}",
                       "JSON carries one zero; a fixed-notation formatter would write `-0`")
    }

    /// The round trip a digest actually takes: parser in, canonicaliser out.
    func testALargeIntegralValueRoundTripsThroughTheParserByteForByte() throws {
        for raw in ["{\"v\":9007199254740992}", "{\"v\":100000000000000000000}"] {
            let incoming = Data(raw.utf8)
            let parsed = try JSONSerialization.jsonObject(with: incoming)
            XCTAssertEqual(
                CanonicalJSON.stringify(parsed), raw,
                "revert: a value the parser handed back as 2^53 (or 1e20) canonicalised into exponent form"
            )
        }
    }

    // MARK: - The id patterns (finding 6: four copies of one literal)

    /// A drift gate with a reader: `OperationID` is the only generator of these
    /// ids, so the validating pattern has to be *built* from its constants. The
    /// hand-copied alphabet is what let `ParamValidation` keep accepting the old
    /// set after a change to `OperationID` — and it is the same literal
    /// `EvidenceStore` derives for the on-disk file name.
    func testIdPatternsAreBuiltFromOperationIDAndNotCopiedFromIt() {
        let derivedBody = "[\(String(OperationID.crockfordAlphabet))]{\(OperationID.totalLength)}"
        XCTAssertEqual(
            ParamValidation.operationIdPattern,
            "^\(OperationID.prefix)\(derivedBody)$",
            "revert: the op_ pattern is a hand-copied literal again — change `OperationID.crockfordAlphabet` and validation silently keeps the old set"
        )
        XCTAssertEqual(
            ParamValidation.snapshotIdPattern,
            "^\(OperationID.snapshotPrefix)\(derivedBody)$",
            "revert: the snap_ pattern drifted from `OperationID.snapshotPrefix`"
        )
        // The two derived sites must still describe one set: the archive's file
        // name and the parameter's value are checked by different code, over the
        // same literal.
        XCTAssertTrue(
            EvidenceStore.entryNamePattern.contains(derivedBody),
            "the evidence file name no longer shares the id body the parameter validates: \(EvidenceStore.entryNamePattern)"
        )
        // Behaviour, not just text: everything the generator emits is accepted…
        for _ in 0..<8 {
            XCTAssertMatches(
                OperationID.generateLive(), ParamValidation.operationIdPattern,
                "a live op_ id must satisfy the pattern that guards the archive path"
            )
            XCTAssertMatches(
                OperationID.generateSnapshotLive(), ParamValidation.snapshotIdPattern,
                "a live snap_ id must satisfy the snapshotId pattern"
            )
            XCTAssertTrue(
                EvidenceStore.isEntryName(OperationID.generateLive() + "." + EvidenceStore.fileExtension),
                "…and lands as a file name the archive recognises as its own"
            )
        }
        // …and the four characters Crockford excludes are not.
        for excluded in ["I", "L", "O", "U"] {
            let body = String(repeating: "0", count: OperationID.totalLength - 1) + excluded
            XCTAssertDoesNotMatch("op_" + body, ParamValidation.operationIdPattern,
                                  "\(excluded) is not in the Crockford alphabet")
            XCTAssertDoesNotMatch("snap_" + body, ParamValidation.snapshotIdPattern,
                                  "\(excluded) is not in the Crockford alphabet")
            XCTAssertDoesNotMatch("appr_" + body, "^" + OperationID.approvalPrefix + derivedBody + "$",
                                  "the same body is what the ledger's own id is checked against")
        }
    }

    // MARK: - Probe wire (finding 8: two truncations posing as one check)

    /// `intValue > 0` then `.int32Value` maps 4294967297 (2^32 + 1) onto pid **1**,
    /// registering a probe against a process nobody started — and every later
    /// "hitCount: 0" is then a measurement about somebody else's pid.
    func testHelloFrameWithAPidBeyondInt32IsRejectedNotFoldedOntoPidOne() {
        for outside in ["4294967297", "2147483648", "0", "-1", "1e30"] {
            let frame = Data((
                #"{"t":"hello","pid":"# + outside
                    + #","appName":"A","probeVersion":"v","capabilities":[]}"#
            ).utf8)
            guard case let .malformed(reason) = ProbeWire.decode(frame) else {
                return XCTFail("pid \(outside) must be a malformed frame, never a registration")
            }
            XCTAssertTrue(reason.contains("pid"), reason)
        }
        if case let .hello(hello) = ProbeWire.decode(Data(
            #"{"t":"hello","pid":4242,"appName":"A","probeVersion":"v","capabilities":[]}"#.utf8
        )) {
            XCTAssertEqual(hello.pid, 4242, "revert: the range check swallowed the legal frames too")
        } else {
            XCTFail("a normal pid must still register")
        }
        if case let .hello(hello) = ProbeWire.decode(Data(
            #"{"t":"hello","pid":2147483647,"appName":"A","probeVersion":"v","capabilities":[]}"#.utf8
        )) {
            XCTAssertEqual(hello.pid, Int32.max, "the upper bound is inclusive")
        } else {
            XCTFail("Int32.max is a pid the daemon can hold")
        }
    }

    /// Same fold on `line`: a source position past Int32 is not a position, and a
    /// negative one is not either.
    func testHandlerFrameWithALineBeyondInt32IsRejected() {
        for outside in ["4294967296", "-2", "1e30"] {
            let frame = Data((
                #"{"t":"handler","file":"a.swift","line":"# + outside + "}"
            ).utf8)
            guard case let .malformed(reason) = ProbeWire.decode(frame) else {
                return XCTFail("line \(outside) must be refused, not truncated into a handler hit")
            }
            XCTAssertTrue(reason.contains("line"), reason)
        }
        if case let .handler(file, line, _, _) = ProbeWire.decode(Data(
            #"{"t":"handler","file":"a.swift","line":12,"ts":1.5}"#.utf8
        )) {
            XCTAssertEqual(file, "a.swift")
            XCTAssertEqual(line, 12, "revert: the range check swallowed the legal frames too")
        } else {
            XCTFail("a normal handler frame must still decode")
        }
    }

    // MARK: - Staged temporary names (finding 2: one shared name, any local account)

    /// `ProjectRegistry` documents this hazard and fixed it with a per-write
    /// unique name; the archive kept `<file>.tmp`, so a local account that can
    /// write the state root may pre-plant that name and have the daemon chmod its
    /// bytes 0600 and rename them into the audit trail.
    func testEvidencePackIsNeverStagedUnderTheSharedTmpName() throws {
        let directory = TestSandbox.directory("archive-staging")
        let store = TestSandbox.evidenceStore(at: directory)
        let pack = pack(createdAt: "2026-10-09T00:00:00.000Z", seed: 5)
        let filePath = directory + "/" + pack.operationId + ".json"
        let planted = "planted by somebody else"
        try planted.write(toFile: filePath + ".tmp", atomically: false, encoding: .utf8)

        var staged: [String] = []
        store.isolationCheck = { candidate in
            staged.append(candidate)
            return StateRoot.isolateFile(at: candidate)
        }
        XCTAssertTrue(store.write(pack))
        let name = try XCTUnwrap(staged.first, "the staged name is judged before it is published")
        XCTAssertNotEqual(name, filePath + ".tmp", "revert: the shared fixed name is back")
        XCTAssertTrue(name.hasPrefix(filePath + ".tmp-"), name)
        XCTAssertFalse(FileManager.default.fileExists(atPath: name), "…and is renamed away")
        XCTAssertEqual(
            try String(contentsOfFile: filePath + ".tmp", encoding: .utf8), planted,
            "the pre-planted file must be left exactly where its owner put it"
        )
        let expected = try pack.jsonData()
        let landed = try Data(contentsOf: URL(fileURLWithPath: filePath))
        XCTAssertEqual(landed, expected, "the archive holds this pack, not the waiting bytes")
    }

    /// …and the name is unique *per write*, which is the other half: two writers
    /// must not be able to rename each other's half-written buffer into place.
    func testStagedNamesDifferPerWrite() throws {
        let store = TestSandbox.evidenceStore(at: TestSandbox.directory("archive-staging-unique"))
        let names = (1...8).map { _ in store.stagePath("/state/projects.json") }
        XCTAssertEqual(Set(names).count, 8, names.joined(separator: "\n"))
        for name in names {
            XCTAssertFalse(name.hasSuffix("/projects.json.tmp"), name)
            XCTAssertTrue(name.hasPrefix("/state/projects.json.tmp-"), name)
        }
    }

    // MARK: - DaemonProbe defaults (finding 9: the folder name has one owner)

    /// `StateRoot` owns the state-folder name and every path inside it; a second
    /// home-derived string in the panel's probe means the panel keeps pointing at
    /// a path that no longer exists the day the folder moves — and shows "not
    /// running" forever.
    func testDaemonProbeDefaultSocketPathsComeFromStateRootNotASecondHomeLookup() throws {
        let root = StateRoot.homeDefault()
        XCTAssertEqual(
            DaemonProbe.defaultProbeSocketPath, root.probeSocketFile,
            "revert: the probe path was composed by hand again, so it drifts from `StateRoot.folderName`"
        )
        XCTAssertEqual(
            DaemonProbe.defaultSocketPath, root.path + "/engine.sock",
            "the historic leaf name is kept, but the directory has to come from StateRoot"
        )
        XCTAssertEqual(
            DaemonProbe.defaultSocketPath,
            StateRoot.engineSocketPath(explicitSocketPath: nil, stateRoot: nil),
            "revert: the one function that writes the engine-socket precedence rule no longer answers this constant"
        )
        // The textual half: this file may not compose a home path any more.
        let source = try repoSource("engine/Sources/GlassPaneEngine/DaemonProbe.swift")
        let code = source.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        XCTAssertFalse(
            code.contains("NSHome" + "Directory"),
            "DaemonProbe looks up the home directory again: the state folder now has two owners"
        )
        XCTAssertTrue(code.contains("StateRoot."), code)
    }

    // MARK: - Recipe error text (finding 7: attacker-reachable bytes)

    /// Recipe bytes come from a cloned repository and `--recipe-validate` prints
    /// these strings to an agent. Only `name` was bounded; the `schemaVersion`,
    /// `kind` and unknown-key cases echoed the value verbatim and uncapped.
    func testRecipeErrorTextCapsEveryEchoedCallerValue() throws {
        let long = String(repeating: "x", count: 4_000)
        let emptyParams = [String: Any]()
        let wrongVersion: [String: Any] = [
            "schemaVersion": long,
            "name": "n",
            "steps": [["kind": long, "params": emptyParams]],
            long: 1
        ]
        // The unknown-*step*-key case cannot share the dictionary above, because
        // its key would collide with the value being echoed there.
        let wrongKind: [String: Any] = [
            "schemaVersion": RecipeLoader.schemaVersion,
            "name": "n",
            "steps": [["kind": "unknown-" + long, "params": emptyParams, long: 2]]
        ]
        var reported: [String] = []
        for subject in [wrongVersion, wrongKind] {
            let result = RecipeLoader.validate(try JSONSerialization.data(withJSONObject: subject))
            XCTAssertFalse(result.valid)
            reported += result.errors
        }
        XCTAssertEqual(reported.count, 5, reported.joined(separator: "\n"))
        for error in reported {
            XCTAssertNil(
                error.range(of: String(repeating: "x", count: RecipeLoader.errorEchoMaxLength + 1)),
                "an error echoed more than \(RecipeLoader.errorEchoMaxLength) code points of caller text: \(error)"
            )
            XCTAssertLessThan(error.unicodeScalars.count, 600, error)
        }
        // Every one of them says it was truncated, instead of looking complete.
        let truncations = reported.filter { $0.contains("code points total, first") }
        XCTAssertEqual(truncations.count, 5, reported.joined(separator: "\n"))
        XCTAssertTrue(truncations.allSatisfy { $0.contains("…") }, truncations.description)
        // Short values are still echoed whole: the cap is not a blind truncator.
        let short = RecipeLoader.validate(try JSONSerialization.data(withJSONObject: [
            "schemaVersion": "glasspane.recipe/9.9", "name": "n", "steps": []
        ]))
        XCTAssertTrue(
            short.errors.contains { $0.contains("\"glasspane.recipe/9.9\"") },
            short.errors.joined(separator: "\n")
        )
        XCTAssertFalse(short.errors.contains { $0.contains("code points total") })
        // An astral character straddling the cut must not leave half a scalar in
        // the message: the marker counts what it shows, and the bytes stay valid.
        let astral = String(repeating: "a", count: RecipeLoader.errorEchoMaxLength - 1)
            + "\u{1F600}" + String(repeating: "b", count: 40)
        let astralError = RecipeLoader.validate(try JSONSerialization.data(withJSONObject: [
            "schemaVersion": astral, "name": "n", "steps": []
        ])).errors.first ?? ""
        XCTAssertTrue(astralError.contains("code points total"), astralError)
        XCTAssertTrue(
            astralError.contains("first \(RecipeLoader.errorEchoMaxLength) shown"),
            "按标量截，永远不会把一次 U+1F600 剪成两半：\(astralError)"
        )
        XCTAssertTrue(
            astralError.unicodeScalars.contains("\u{1F600}"),
            "astral 字符落在保留段里，它必须完整出现（截的是标量，不是码元）：\(astralError)"
        )
        XCTAssertFalse(
            astralError.unicodeScalars.contains { $0.value >= 0xD800 && $0.value <= 0xDFFF },
            "a lone surrogate reached the error text: \(astralError)"
        )
        XCTAssertEqual(
            String(decoding: Data(astralError.utf8), as: UTF8.self), astralError,
            "the message is not valid UTF-8 any more, so whoever prints it gets a hole"
        )
    }

    // MARK: - Approval ledger (finding 1: an unreadable ledger is not an empty one)

    /// The shape this round called data loss plus false evidence: `init` latches
    /// `loadFailed` and loads an empty chain, while `append` never consulted it —
    /// so the next approval re-anchored from genesis (`prevHash = tailHash()` was
    /// "") and `persist()` renamed that one record over the file. Every earlier
    /// approval was deleted, and `--approval-verify` replayed the survivor and
    /// printed `valid: true`.
    func testCorruptLedgerRefusesTheAppendAndLeavesTheDamagedBytesUntouched() throws {
        let directory = TestSandbox.directory("ledger-refuse")
        let path = directory + "/approvals.json"
        let healthy = ApprovalGate(path: path, clock: { Date(timeIntervalSince1970: 0) })
        for index in 0..<2 {
            XCTAssertNotNil(healthy.append(
                operationRef: "snap-\(index)", operationType: "restore", riskTier: .high,
                decision: .approve, approvedBy: ApprovalGate.autoApprover,
                reason: "record \(index) of the history that must survive"
            ))
        }
        let whole = try Data(contentsOf: URL(fileURLWithPath: path))
        let damaged = whole.prefix(whole.count / 2)
        try damaged.write(to: URL(fileURLWithPath: path))

        let gate = ApprovalGate(path: path, clock: { Date(timeIntervalSince1970: 1) })
        XCTAssertTrue(gate.loadFailed, "premise: the file exists and does not decode")
        XCTAssertEqual(gate.count, 0)
        XCTAssertNil(
            gate.append(
                operationRef: "snap-3", operationType: "restore", riskTier: .high,
                decision: .approve, approvedBy: ApprovalGate.autoApprover,
                reason: "this approval must not be written at all"
            ),
            "revert: the append went through, re-anchored from genesis, and renamed a one-record chain over the file"
        )
        XCTAssertEqual(gate.count, 0, "the refusal adds nothing, not even in memory")
        let refusal = try XCTUnwrap(
            gate.persistFailed,
            "a refused append has to be askable about: the caller cannot tell 'recorded' from 'refused' otherwise"
        )
        XCTAssertTrue(refusal.contains(path), "the reason must name the ledger file: \(refusal)")
        XCTAssertTrue(refusal.contains("could not be decoded"), refusal)
        XCTAssertTrue(
            refusal.contains("python3 -m json.tool"),
            "and give the agent a step it can actually run: \(refusal)"
        )
        XCTAssertTrue(
            refusal.contains("do not delete"),
            "the remedy must not order the destruction of the audit trail: \(refusal)"
        )
        XCTAssertEqual(
            try Data(contentsOf: URL(fileURLWithPath: path)), damaged,
            "the existing bytes must be provably the ones that were there before"
        )
        XCTAssertEqual(gate.ledgerPath, path, "the refusal points at the file this gate does open")

        // Repair-and-reload is the whole remedy: nothing is unlocked by deleting.
        try whole.write(to: URL(fileURLWithPath: path))
        let repaired = ApprovalGate(path: path, clock: { Date(timeIntervalSince1970: 2) })
        XCTAssertFalse(repaired.loadFailed)
        XCTAssertEqual(repaired.count, 2, "the recovered history is the file, byte for byte")
        XCTAssertTrue(repaired.verifyChain().valid)
        XCTAssertNotNil(repaired.append(
            operationRef: "snap-3", operationType: "restore", riskTier: .high,
            decision: .approve, approvedBy: ApprovalGate.autoApprover,
            reason: "appended after the ledger could be read again"
        ))
        XCTAssertEqual(repaired.count, 3)
        XCTAssertTrue(repaired.verifyChain().valid)
        XCTAssertEqual(
            repaired.chain()[2].prevHash, repaired.chain()[1].hash,
            "the new record links to the recovered tail, not to a fresh genesis"
        )
        XCTAssertNil(repaired.persistFailed)
    }

    /// The other direction: a guard that cannot be taken off is a lockout, so a
    /// ledger that decodes must keep appending — and keep the whole chain on disk.
    func testDecodingLedgerStillAppendsAndIsStillRewrittenWhole() throws {
        let directory = TestSandbox.directory("ledger-healthy")
        let path = directory + "/approvals.json"
        let gate = ApprovalGate(path: path, clock: { Date(timeIntervalSince1970: 0) })
        XCTAssertNotNil(gate.append(
            operationRef: "snap-a", operationType: "restore", riskTier: .low,
            decision: .approve, approvedBy: ApprovalGate.autoApprover, reason: "first"
        ))
        let reloaded = ApprovalGate(path: path, clock: { Date(timeIntervalSince1970: 1) })
        XCTAssertFalse(reloaded.loadFailed)
        XCTAssertNil(reloaded.persistFailed)
        XCTAssertNotNil(reloaded.append(
            operationRef: "snap-b", operationType: "prune-evidence", riskTier: .high,
            decision: .approve, approvedBy: ApprovalGate.autoApprover, reason: "second"
        ))
        XCTAssertEqual(reloaded.count, 2)
        XCTAssertNil(reloaded.persistFailed, "a successful append leaves no refusal standing")
        let decoded = try JSONDecoder().decode([ApprovalRecord].self, from: Data(
            contentsOf: URL(fileURLWithPath: path)
        ))
        XCTAssertEqual(decoded.count, 2, "the file holds both records, not just the newest")
        XCTAssertEqual(decoded, reloaded.chain())
        XCTAssertTrue(ApprovalGate.verify(records: decoded).valid)
    }

    /// Same hazard as the archive, on the signature ledger: `<ledger>.tmp` is a
    /// name any local account that can write the state root may pre-create, and
    /// `persist()` would chmod those bytes 0600 and rename them into the chain.
    func testStagedTempNameIsUniquePerWriteAndNeverConsumesAPrePlantedFile() throws {
        let directory = TestSandbox.directory("ledger-staged")
        let path = directory + "/approvals.json"
        let planted = "{\"not\":\"the ledger\"}"
        try planted.write(toFile: path + ".tmp", atomically: false, encoding: .utf8)

        let gate = ApprovalGate(path: path, clock: { Date(timeIntervalSince1970: 0) })
        var judged: [String] = []
        gate.isolationCheck = { candidate in
            judged.append(candidate)
            return StateRoot.isolateFile(at: candidate)
        }
        XCTAssertNotNil(gate.append(
            operationRef: "snap-1", operationType: "restore", riskTier: .high,
            decision: .approve, approvedBy: ApprovalGate.autoApprover,
            reason: "staged under a name nobody else could have named"
        ))
        let staged = try XCTUnwrap(judged.first, "the temporary name is judged before it is published")
        XCTAssertNotEqual(staged, path + ".tmp", "revert: persist() staged under the shared fixed name")
        XCTAssertTrue(staged.hasPrefix(path + ".tmp-"), staged)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged), "…and is renamed away")
        XCTAssertEqual(
            judged.last, path, "the published name is judged too: \(judged)"
        )
        XCTAssertEqual(
            try String(contentsOfFile: path + ".tmp", encoding: .utf8), planted,
            "the planted bytes must stay put — they were never this ledger's staging name"
        )
        let records = try JSONDecoder().decode([ApprovalRecord].self, from: Data(
            contentsOf: URL(fileURLWithPath: path)
        ))
        XCTAssertEqual(records.count, 1, "what landed is this process's chain, not the planted JSON")
        XCTAssertTrue(ApprovalGate.verify(records: records).valid)

        // Per *write*, not per process: two appends must not share a staging name.
        judged.removeAll()
        XCTAssertNotNil(gate.append(
            operationRef: "snap-2", operationType: "restore", riskTier: .high,
            decision: .approve, approvedBy: ApprovalGate.autoApprover, reason: "second"
        ))
        let secondStaged = try XCTUnwrap(judged.first)
        XCTAssertNotEqual(secondStaged, staged, "revert: the name is stable per process, not per write")
    }

    // MARK: - Project registry (finding 5: another writer owns the file now)

    /// The documented concurrent writer is `glasspaned --project-prune`, a separate
    /// process over the same table. `verifySaved(expecting:)` only compares the
    /// count *this* process just wrote, so the long-lived daemon's next create
    /// silently reverted the prune and still reported success.
    func testCreateRefusesWhenAnotherWriterChangedTheFileSinceThisProcessReadIt() throws {
        let path = TestSandbox.filePath("registry-concurrent")
        let daemon = ProjectRegistry(filePath: path)
        _ = try daemon.create(displayName: "Kept", bundleId: "com.kept")

        // A one-shot CLI run: reads the same file, writes a different table.
        let oneShot = ProjectRegistry(filePath: path)
        _ = try oneShot.create(displayName: "Added by the prune run", bundleId: "com.other")
        XCTAssertEqual(oneShot.count, 2)

        XCTAssertThrowsError(
            try daemon.create(displayName: "Would revert the other writer", bundleId: "com.stale")
        ) { error in
            let refusal = (error as? GPError)?.message ?? error.localizedDescription
            XCTAssertEqual((error as? GPError)?.code, .internalError)
            XCTAssertTrue(
                refusal.contains("refused") && refusal.contains(path),
                "the refusal has to name the file and say it was refused, not that it failed: \(refusal)"
            )
            XCTAssertTrue(
                refusal.contains("changed after this process read it"),
                "revert: the stale table was renamed over the newer one and the call still reported success: \(refusal)"
            )
        }
        XCTAssertEqual(
            ProjectRegistry(filePath: path).all.map(\.displayName),
            ["Kept", "Added by the prune run"],
            "the other writer's result has to survive the refusal"
        )
        XCTAssertEqual(daemon.count, 1, "the refused entry did not stay in memory either")

        // A process that re-reads is writable again: the guard answers the stale
        // view, not the file's ownership — and it never deleted anything.
        let reread = ProjectRegistry(filePath: path)
        _ = try reread.create(displayName: "Third", bundleId: "com.third")
        XCTAssertEqual(ProjectRegistry(filePath: path).count, 3)
    }

    /// …and the deletion half: a file that is *gone* is also a change, and a
    /// whole-table rewrite onto a name somebody removed is not a verified save.
    func testCreateRefusesWhenTheFileDisappearedSinceThisProcessReadIt() throws {
        let path = TestSandbox.filePath("registry-vanished")
        let registry = ProjectRegistry(filePath: path)
        _ = try registry.create(displayName: "First", bundleId: "com.first")
        try FileManager.default.removeItem(atPath: path)
        XCTAssertThrowsError(
            try registry.create(displayName: "Second", bundleId: "com.second")
        ) { error in
            let refusal = (error as? GPError)?.message ?? error.localizedDescription
            XCTAssertTrue(refusal.contains("gone"), refusal)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: path), "the refusal wrote nothing")
    }

    // MARK: - Evidence archive listing (finding 3: could not look ≠ nothing there)

    /// A directory that exists but cannot be listed used to yield `names = []`, so
    /// the scan reported `directoryExists: true` with empty summaries and no
    /// failure marker: "I could not look" rendered as "the archive is empty".
    func testScanSeparatesAnUnreadableDirectoryFromAnEmptyOne() throws {
        let blocked = TestSandbox.directory("archive-blocked")
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o755], ofItemAtPath: blocked
            )
        }
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o000], ofItemAtPath: blocked
        )
        // The premise, checked rather than assumed: a process that can list a
        // mode-000 directory (running as root) cannot measure this branch, and a
        // green run there would be a pass by fixture, not by code.
        if (try? FileManager.default.contentsOfDirectory(atPath: blocked)) != nil {
            throw XCTSkip("this process can list a mode-000 directory, so the refusal is unmeasurable here")
        }

        let blockedScan = LocalArchive.scanEvidence(directory: blocked)
        XCTAssertTrue(blockedScan.directoryExists, "the directory is there — that half is a fact")
        XCTAssertNotNil(
            blockedScan.listFailure,
            "revert: the failure was folded into `names = []`, so the panel said 'the archive is empty'"
        )
        XCTAssertTrue(blockedScan.listFailure?.contains(blocked) == true, blockedScan.listFailure ?? "")
        XCTAssertTrue(blockedScan.summaries.isEmpty, "nothing was seen, so nothing is claimed")
        XCTAssertEqual(blockedScan.totalBytes, 0)

        // The contrast in the same run: a readable-but-empty archive has no failure.
        let empty = TestSandbox.directory("archive-empty")
        let emptyScan = LocalArchive.scanEvidence(directory: empty)
        XCTAssertTrue(emptyScan.directoryExists)
        XCTAssertNil(emptyScan.listFailure, "this one really was counted")
        XCTAssertTrue(emptyScan.summaries.isEmpty)
        XCTAssertNotEqual(blockedScan, emptyScan, "the two must not be presentable as one answer")

        // And the third shape keeps its own: a directory that is not there at all.
        XCTAssertNil(EvidenceArchiveScan.empty.listFailure)
        XCTAssertFalse(LocalArchive.scanEvidence(
            directory: TestSandbox.pendingDirectory("archive-missing")
        ).directoryExists)
    }

    /// The failure marker must not swallow the cases it sits beside: a readable
    /// archive keeps counting, and one corrupt pack is still an `unreadableFiles`
    /// entry rather than an unreadable *directory*.
    func testReadableArchiveStillCountsAndOneBadFileIsStillAFailureOfThatFile() throws {
        let directory = TestSandbox.directory("archive-readable")
        let store = TestSandbox.evidenceStore(at: directory)
        let first = pack(createdAt: "2026-10-01T00:00:00.000Z", seed: 11)
        let second = pack(createdAt: "2026-10-02T00:00:00.000Z", seed: 12)
        XCTAssertTrue(store.write(first))
        XCTAssertTrue(store.write(second))

        let scan = LocalArchive.scanEvidence(directory: directory)
        XCTAssertEqual(scan.summaries.count, 2)
        XCTAssertNil(scan.listFailure)
        XCTAssertTrue(scan.unreadableFiles.isEmpty)

        try "{ broken".write(toFile: directory + "/" + first.operationId + ".json",
                             atomically: false, encoding: .utf8)
        let damaged = LocalArchive.scanEvidence(directory: directory)
        XCTAssertEqual(damaged.unreadableFiles, [first.operationId + ".json"])
        XCTAssertEqual(damaged.summaries.count, 1)
        XCTAssertNil(damaged.listFailure, "one bad file is not an unreadable directory")
    }

    // MARK: - Fixtures

    /// A pack with a deterministic operationId, the way `StatePermissionTests`
    /// builds them, so the entry name is known before the write happens.
    private func pack(createdAt: String, seed: UInt64) -> EvidencePack {
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
                    selector: Selector(role: "AXButton", title: "X"),
                    action: .press,
                    actConfirmed: true
                )
            )
        )
    }

    /// Repo-relative source, read through this file's compiled-in location, so the
    /// working directory `swift test` happens to pick cannot move the answer.
    private func repoSource(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // engine
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
    }
}

// MARK: - Pattern helpers

/// Both halves of the drift gate need to be executable, so the assertions are
/// spelled once: a generated id has to pass, and an excluded character has to
/// fail. `XCTAssertNotNil(range(of:options:))` is the whole matching API a
/// reader needs here, but written twice it becomes two places to get wrong.
private func XCTAssertMatches(
    _ value: String, _ pattern: String, _ message: String,
    file: StaticString = #filePath, line: UInt = #line
) {
    XCTAssertNotNil(
        value.range(of: pattern, options: .regularExpression),
        "\(message)\nvalue: \(value)\npattern: \(pattern)",
        file: file, line: line
    )
}

private func XCTAssertDoesNotMatch(
    _ value: String, _ pattern: String, _ message: String,
    file: StaticString = #filePath, line: UInt = #line
) {
    XCTAssertNil(
        value.range(of: pattern, options: .regularExpression),
        "\(message)\nvalue: \(value)\npattern: \(pattern)",
        file: file, line: line
    )
}
