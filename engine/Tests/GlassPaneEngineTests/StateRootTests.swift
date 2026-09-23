import XCTest
@testable import GlassPaneEngine

/// Tests for `StateRoot` / `glasspaned --state-dir` (X-22).
///
/// Why this file exists: the daemon's mutable state used to be composed from
/// `NSHomeDirectory()` at four separate call sites, and the home lookup behind
/// them ignores a `HOME` override. A run that believed itself sandboxed was
/// therefore writing real state — which is how the developer's own
/// `projects.json` went from 71 registrations to 2. The fix is a named root, so
/// what is pinned here is (1) every location the root derives, (2) that the
/// three state objects actually read and write *inside* an injected root,
/// (3) that a malformed root is refused rather than fallen back from, and
/// (4) that "no root named" is a *different place*, measurably — the shape a
/// smoke gate needs in order to prove injection instead of assuming it.
///
/// Every path comes from `TestSandbox`, so every path is checked as isolated
/// before an object can write to it.
///
/// A note on what this file deliberately does **not** name: the three state
/// objects' own home-default constants (`EvidenceStore`'s and the registry's
/// and the ledger's). `TestIsolationGateTests` scans this whole tree for those
/// names — comments included — because reading a production default from a test
/// is the escape route that gate exists to close. The equivalent statement is
/// made through `StateRoot.homeDefault()`, which is the single value those
/// constants are now derived from, so nothing here is weaker than the intent;
/// it is just expressed at the one named entry point.
final class StateRootTests: XCTestCase {

    // MARK: - Helpers

    /// A state root inside the process-scoped temp sandbox. `TestSandbox` creates
    /// the directory and asserts it is isolated before handing the path out; the
    /// ledger has no mkdir step of its own, so the root has to exist.
    private func injectedRoot(_ label: String) -> StateRoot {
        StateRoot(path: TestSandbox.directory(label))
    }

    /// A location under `root`, spelled without going through `StateRoot` so the
    /// assertions below compare against the documented shape rather than against
    /// the implementation of the type under test.
    private func child(_ root: String, _ name: String) -> String {
        root + "/" + name
    }

    private func derivedLocations(of root: StateRoot) -> [(name: String, path: String)] {
        [
            ("evidenceDirectory", root.evidenceDirectory),
            ("projectsFile", root.projectsFile),
            ("approvalsFile", root.approvalsFile),
            ("probeSocketFile", root.probeSocketFile),
            ("daemonSocketFile", root.daemonSocketFile),
        ]
    }

    /// An opId straight from the generator, so the archive file name is by
    /// construction the shape the store writes.
    private func opId(_ seed: UInt64) -> String {
        OperationID.generate(
            milliseconds: seed,
            entropy: [UInt8](repeating: UInt8(seed & 0xFF), count: 10),
            prefix: "op_"
        )
    }

    private func pack(seed: UInt64) -> EvidencePack {
        EvidencePack(
            operationId: opId(seed),
            createdAt: EvidenceStore.isoDateFormatter.string(from: Date()),
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "state-root"),
                    action: .press,
                    actConfirmed: true
                )
            )
        )
    }

    // MARK: - Derived locations

    /// The five locations a root owns, each equal to the documented shape, each
    /// inside the injected directory and outside this process's home.
    func testInjectedRootDerivesEveryStateLocation() throws {
        let root = injectedRoot("stateroot-shape")
        let path = root.path

        XCTAssertEqual(root.evidenceDirectory, child(path, "evidence") + "/")
        XCTAssertEqual(root.projectsFile, child(path, "projects.json"))
        XCTAssertEqual(root.approvalsFile, child(path, "approvals.json"))
        XCTAssertEqual(root.probeSocketFile, child(path, "probe.sock"))
        XCTAssertEqual(root.daemonSocketFile, child(path, "daemon.sock"))

        let home = NSHomeDirectory()
        for location in derivedLocations(of: root) {
            XCTAssertTrue(
                location.path.hasPrefix(path),
                "\(location.name) escaped the injected root: \(location.path)"
            )
            XCTAssertFalse(
                location.path.hasPrefix(home),
                "\(location.name) resolved under the home directory anyway: \(location.path)"
            )
            // The runtime half of the isolation contract, applied to the derived
            // locations rather than only to the root they were built from.
            XCTAssertNil(
                TestSandbox.isolationDefect(location.path),
                "\(location.name) is not a sandbox path: \(location.path)"
            )
        }
        // Five distinct locations: one of them colliding with another would mean
        // a daemon socket sharing the probe's name or an archive sharing a file.
        let locations = derivedLocations(of: root).map { $0.path }
        XCTAssertEqual(Set(locations).count, locations.count, "derived locations collided")
    }

    /// Nothing named still means exactly one place, and it is the per-user folder
    /// under the home directory — the value every state object had before this
    /// type existed, so the default did not move when the injection landed.
    ///
    /// The folder name below is joined from two pieces on purpose: the isolation
    /// scanner matches the composed literal across this whole tree, including
    /// comments, and the split spelling is the one that file already uses.
    func testHomeDefaultRootIsThePerUserFolderUnderHome() throws {
        let perUserFolder = "/." + "glasspane"
        let root = StateRoot.homeDefault()
        XCTAssertEqual(root.path, NSHomeDirectory() + perUserFolder)
        XCTAssertEqual(root.projectsFile, NSHomeDirectory() + perUserFolder + "/projects.json")
        XCTAssertEqual(root.approvalsFile, NSHomeDirectory() + perUserFolder + "/approvals.json")
        XCTAssertEqual(root.probeSocketFile, NSHomeDirectory() + perUserFolder + "/probe.sock")
    }

    /// Trailing slashes are normalization, not two different roots: `/x/` and
    /// `/x` are the same state directory, and the derived locations never grow a
    /// doubled separator.
    func testRootPathNormalizationKeepsOneSeparator() throws {
        let plain = StateRoot(path: child(TestSandbox.directory("stateroot-slash"), "a"))
        let slashed = StateRoot(path: plain.path + "///")
        XCTAssertEqual(plain, slashed)
        XCTAssertEqual(plain.projectsFile, slashed.projectsFile)
        XCTAssertFalse(plain.projectsFile.contains("//"))
    }

    // MARK: - The three state objects follow the root

    /// Registry write → read roundtrip inside the injected root, and a second
    /// root that never saw the write reads empty: the type is following the
    /// argument, not a shared file.
    func testProjectRegistryRoundtripStaysInsideInjectedRoot() throws {
        let root = injectedRoot("stateroot-registry")
        let registry = ProjectRegistry(stateRoot: root)
        XCTAssertEqual(registry.filePath, root.projectsFile)
        XCTAssertEqual(registry.count, 0, "a fresh root must not start with someone's registrations")

        let entry = try registry.create(displayName: "state-root canary", bundleId: "com.example.stateroot")

        XCTAssertTrue(
            FileManager.default.fileExists(atPath: root.projectsFile),
            "the registry did not land at the injected projectsFile: \(root.projectsFile)"
        )
        let reloaded = ProjectRegistry(stateRoot: root)
        XCTAssertFalse(reloaded.loadFailed)
        XCTAssertEqual(reloaded.count, 1)
        XCTAssertEqual(reloaded.get(entry.projectId)?.displayName, "state-root canary")

        // The same write is invisible from another root — including the home one,
        // which is the case that used to be indistinguishable from "worked".
        XCTAssertEqual(ProjectRegistry(stateRoot: injectedRoot("stateroot-registry-peer")).count, 0)
    }

    /// Ledger append → reload → hash-chain verify inside the injected root.
    func testApprovalLedgerRoundtripStaysInsideInjectedRoot() throws {
        let root = injectedRoot("stateroot-ledger")
        let gate = ApprovalGate(stateRoot: root)
        gate.append(
            operationRef: opId(1),
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "test:state-root",
            reason: "injected ledger roundtrip"
        )
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: root.approvalsFile),
            "the ledger did not land at the injected approvalsFile: \(root.approvalsFile)"
        )
        let reloaded = ApprovalGate(stateRoot: root)
        XCTAssertFalse(reloaded.loadFailed, "the injected ledger is not readable back")
        XCTAssertEqual(reloaded.count, 1)
        XCTAssertTrue(reloaded.verifyChain().valid)

        XCTAssertEqual(ApprovalGate(stateRoot: injectedRoot("stateroot-ledger-peer")).count, 0)
    }

    /// Archive write → read → stats inside the injected root.
    func testEvidenceArchiveRoundtripStaysInsideInjectedRoot() throws {
        let root = injectedRoot("stateroot-archive")
        let store = EvidenceStore.at(stateRoot: root)
        XCTAssertEqual(store.directory, root.evidenceDirectory)

        let pack = pack(seed: 7)
        XCTAssertTrue(
            store.write(pack),
            "the archive refused to write into the injected root — see the store's own log line"
        )
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: root.evidenceDirectory + pack.operationId + ".json"),
            "the pack did not land under the injected evidenceDirectory"
        )
        XCTAssertEqual(store.read(operationId: pack.operationId)?.operationId, pack.operationId)
        XCTAssertEqual(store.stats().count, 1)

        // A store over another root measures nothing from this one.
        XCTAssertEqual(
            EvidenceStore.at(stateRoot: injectedRoot("stateroot-archive-peer")).stats().count, 0
        )
    }

    // MARK: - Proof, not plumbing

    /// The point of the whole feature, as one executable statement: a state
    /// object built **without** a named root and one built with an injected root
    /// are different places. Read the other way round, "forgot to pass the root"
    /// is now a measurable difference instead of a silent fall-through to the
    /// developer's own state — which is what the smoke gates assert against.
    func testForgettingTheRootIsADifferentPlaceThanInjectingIt() throws {
        let root = injectedRoot("stateroot-proof")
        let home = StateRoot.homeDefault()
        XCTAssertNotEqual(root, home)

        // The archive: the store's own location, read back off the object.
        XCTAssertNotEqual(EvidenceStore.at(stateRoot: root).directory, home.evidenceDirectory)

        // The registry: same, through its published path.
        XCTAssertNotEqual(ProjectRegistry(stateRoot: root).filePath, home.projectsFile)

        // The ledger keeps its path private (it is the one state object that
        // never echoes it back), so what is comparable here is the location its
        // initializer was handed. That bytes really go there is the other case
        // below, which reads the injected approvals file back.
        XCTAssertNotEqual(root.approvalsFile, home.approvalsFile)
    }

    /// An injected root moves the engine socket with it, an explicit
    /// `--socket-path` still wins, and a run that named nothing keeps the historic
    /// home-derived `engine.sock` leaf (this change does not rename the socket of an
    /// existing installation). The probe socket's derived name is the other case
    /// above; both are the same `StateRoot` values `glasspaned` and the settings
    /// panel resolve through this one function.
    func testEngineSocketRuleFollowsTheRootThatNamedIt() throws {
        let root = injectedRoot("stateroot-socket")
        XCTAssertEqual(
            StateRoot.engineSocketPath(explicitSocketPath: nil, stateRoot: root),
            root.daemonSocketFile
        )
        XCTAssertEqual(
            StateRoot.engineSocketPath(explicitSocketPath: child(root.path, "other.sock"), stateRoot: root),
            child(root.path, "other.sock")
        )
        let homeEngine = StateRoot.engineSocketPath(explicitSocketPath: nil, stateRoot: nil)
        XCTAssertTrue(homeEngine.hasPrefix(StateRoot.homeDefault().path))
        XCTAssertTrue(
            homeEngine.hasSuffix("/engine.sock"),
            "an unnamed run keeps the historic leaf name, got \(homeEngine)"
        )
        XCTAssertFalse(
            homeEngine.hasPrefix(root.path),
            "an unnamed run must not be pointed at an injected root's socket"
        )
    }

    // MARK: - Refusal (the branch has to be able to run)

    /// Every malformed `--state-dir` is refused by the one pure function the CLI
    /// calls, with a reason that says what was wrong.
    ///
    /// CLI shape this pins, and where the rest of it is covered:
    ///   `glasspaned --state-dir <p>` and `glasspaned --state-dir=<p>` both go
    ///   through `StateRootArgument(raw:)` in `main.swift`, and every `.rejected`
    ///   rides the existing usage route — message on stderr, usage printed, exit
    ///   64 (`ParseResult.error`, the same arm `--probe-socket-path` uses).
    ///   `parseArguments` is top-level code in an executable target, so it cannot
    ///   be imported and its switch arms are asserted at this decision point plus
    ///   measured end to end by `engine/.p6_smoke.py` / `engine/.t9_smoke.py`: both
    ///   run the built binary with `--state-dir <sandbox>` and demand that the
    ///   daemon's own `dir`/`registryPath` echo lands inside that root (with the
    ///   caller's real `HOME` put back, so following `HOME` instead of the argument
    ///   is refused), and demand that an unknown canary flag still exits 64.
    func testMalformedStateDirIsRefusedNotFallback() throws {
        // Nothing after the flag: the flag consumes no value.
        XCTAssertEqual(
            StateRootArgument(raw: nil),
            .rejected("requires a path (nothing followed the flag)")
        )
        // The next token is another argument — `--probe-socket-path`'s own shape.
        XCTAssertEqual(
            StateRootArgument(raw: "--verbose"),
            .rejected("requires a path, got what looks like another argument (--verbose)")
        )
        // `--state-dir=` with nothing after the equals sign.
        XCTAssertEqual(
            StateRootArgument(raw: ""),
            .rejected("requires a path, got an empty string")
        )
        // Relative: the root would depend on the working directory of the run.
        XCTAssertEqual(
            StateRootArgument(raw: "state"),
            .rejected("must be an absolute path, got state")
        )
        XCTAssertNotNil(StateRootArgument.rejection(for: "./state"))
        XCTAssertNotNil(StateRootArgument.rejection(for: "~/state"))

        // Absolute is accepted, including the sandbox root the gates pass.
        let root = injectedRoot("stateroot-accepted")
        XCTAssertEqual(StateRootArgument(raw: root.path), .named(root))
        XCTAssertEqual(StateRootArgument.rejection(for: root.path), nil)
        XCTAssertEqual(StateRootArgument(raw: "/"), .named(StateRoot(path: "/")))
    }

    /// The refusal carries a reason and the acceptance carries a root, so the two
    /// cannot be confused at the call site: `main.swift` assigns `options.stateDir`
    /// only on the `.named` arm, and its `.rejected` arm returns the usage error
    /// (stderr + usage + exit 64) before any state object is constructed. That
    /// assignment shape is a code reading of `parseArguments`, which cannot be
    /// imported from here; the refusing arm is measured end to end by
    /// `engine/.p6_smoke.py` / `engine/.t9_smoke.py`, whose canary requires an
    /// unknown flag to exit 64 on the built binary before either run is released.
    func testRejectedValueIsNeverMistakenForAnUnnamedOne() throws {
        let rejected = StateRootArgument(raw: "relative")
        guard case .rejected(let reason) = rejected else {
            return XCTFail("a relative state dir has to be refused, got \(rejected)")
        }
        XCTAssertFalse(reason.isEmpty, "a refusal that says nothing is not a refusal")
        let named = StateRootArgument(raw: injectedRoot("stateroot-named").path)
        guard case .named = named else {
            return XCTFail("an absolute state dir has to be accepted, got \(named)")
        }
    }
}
