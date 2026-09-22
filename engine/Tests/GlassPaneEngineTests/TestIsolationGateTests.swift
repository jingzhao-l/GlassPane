import XCTest
@testable import GlassPaneEngine

/// B2 (audit register) + R7-02: the source-level test-isolation gate.
///
/// The defect it guards is destruction, not tidiness: a state object built
/// without an injected location resolves that location under the home
/// directory, so a `swift test` run on a developer machine rewrites real
/// state with test fixtures — it did, replacing the real project
/// registrations with the two synthetic entries one test creates. Pointing
/// `HOME` at a sandbox for the run does not help, because the home lookup
/// behind those defaults ignores that variable. The only safe design is
/// structural: no test in this target may build a state object with its
/// production default at all.
///
/// Two halves, per the register:
///   (a) this scan — forbidden textual shapes over every `.swift` file of the
///       engine test tree, so the pattern cannot come back unnoticed;
///   (b) `TestSandbox` — every path a test uses comes from the temp directory
///       and is checked at runtime by `assertIsolated`; the last case below
///       proves (b) holds for the paths those helpers hand out.
///
/// Self-proof obligation: a guard whose refusing branch cannot run is not a
/// guard, so `testScannerRejectsTheForbiddenShapes` feeds every shape back
/// through the same matching code and requires it to be reported.
///
/// Why this file never reports itself: each searched-for fragment is joined
/// at runtime from two or more string pieces (`needle`), so no line of this
/// source contains the contiguous text — or both tokens of a token pair — a
/// rule looks for. Comments are deliberately *not* stripped before matching:
/// the tree was checked for shapes appearing only in prose, and a stripper
/// would also silence a violation hidden behind a `//` inside a raw string.
final class TestIsolationGateTests: XCTestCase {

    // MARK: - Needles

    /// Joins a searchable fragment from pieces (see the class comment).
    private func needle(_ pieces: String...) -> String { pieces.joined() }

    private struct Rule {
        var name: String
        var regex: NSRegularExpression?
        var tokens: [String] = []

        func reports(_ line: String) -> Bool {
            if let regex,
               regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil {
                return true
            }
            guard !tokens.isEmpty else { return false }
            return tokens.allSatisfy { line.contains($0) }
        }
    }

    private func rule(_ name: String, _ pattern: String) throws -> Rule {
        Rule(name: name, regex: try NSRegularExpression(pattern: pattern))
    }

    private func pairRule(_ name: String, _ tokens: [String]) -> Rule {
        Rule(name: name, regex: nil, tokens: tokens)
    }

    /// The forbidden shapes. `registry`, `store` and `gate` are the three
    /// file-backed state objects of the engine; each rule names the cost of
    /// the shape it catches.
    private func rules() throws -> [Rule] {
        let registry = needle("Project", "Registry")
        let store = needle("Evidence", "Store")
        let gate = needle("Approval", "Gate")
        return [
            try rule(
                "bare registry constructor (production projects file)",
                registry + needle("\\s*\\(\\s*\\)")
            ),
            try rule(
                "bare archive constructor (production evidence directory)",
                store + needle("\\s*\\(\\s*\\)")
            ),
            try rule(
                // The R7-02 root cause: a shared helper whose optional
                // directory forwarded nil into the archive location.
                "optional directory parameter with a nil default",
                needle("directory", "\\s*:\\s*String\\?\\s*=\\s*nil")
            ),
            try rule(
                "nil forwarded as an archive location",
                needle("directory", "\\s*:\\s*nil")
            ),
            try rule(
                "production projects path referenced",
                registry + needle("\\.default", "ProjectsPath")
            ),
            try rule(
                "production evidence path referenced",
                store + needle("\\.default", "Directory")
            ),
            try rule(
                "production approvals path referenced",
                gate + needle("\\.default", "Path")
            ),
            pairRule(
                "home directory composed with the state folder",
                [needle("NSHome", "Directory"), needle(".", "glasspane")]
            ),
            try rule(
                "hardcoded path handed to the registry",
                registry + needle("\\(\\s*filePath\\s*:\\s*\"")
            ),
            try rule(
                "hardcoded path handed to the archive",
                store + needle("\\(\\s*directory\\s*:\\s*\"")
            ),
            try rule(
                "hardcoded path handed to the approval ledger",
                gate + needle("\\(\\s*path\\s*:\\s*\"")
            ),
        ]
    }

    // MARK: - Scanning

    /// The engine test tree, derived from this file's own compiled location
    /// (the technique `KernelFixtures` already uses) — not the process
    /// working directory, which `swift test` does not pin, and not a
    /// hardcoded absolute path.
    private var testTreeRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()  // Tests
    }

    private func swiftFiles(under root: URL) -> [URL] {
        guard let walk = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }
        var found: [URL] = []
        for case let url as URL in walk where url.pathExtension == "swift" {
            found.append(url)
        }
        return found.sorted { $0.path < $1.path }
    }

    /// Every rule × line hit in one text, as `name:line [rule] source`.
    private func findings(in text: String, rules: [Rule], prefix: String) -> [String] {
        var hits: [String] = []
        for (index, line) in text.components(separatedBy: "\n").enumerated() {
            let matched = rules.filter { $0.reports(line) }
            guard !matched.isEmpty else { continue }
            let source = line.trimmingCharacters(in: .whitespaces)
            hits += matched.map { "\(prefix):\(index + 1) [\($0.name)] \(source)" }
        }
        return hits
    }

    // MARK: - Cases

    /// Half (a): the scan over the whole engine test tree.
    func testNoTestSourceBuildsStateAtItsProductionPath() throws {
        let root = testTreeRoot
        guard FileManager.default.fileExists(atPath: root.path) else {
            return XCTFail(
                "test-isolation gate cannot run: no test sources at \(root.path). "
                    + "This gate fails closed on purpose — rebuild from this checkout "
                    + "instead of letting an unscanned suite touch real state."
            )
        }
        let files = swiftFiles(under: root)
        XCTAssertFalse(files.isEmpty, "the gate scanned nothing, so it guards nothing")
        XCTAssertTrue(
            files.contains { $0.lastPathComponent == "TestIsolationGateTests.swift" },
            "the gate must scan its own file, or it can be subverted inside it"
        )

        let rules = try rules()
        var reported: [String] = []
        for url in files {
            let text = try String(contentsOf: url, encoding: .utf8)
            let prefix = String(url.path.dropFirst(root.path.count))
            reported += findings(in: text, rules: rules, prefix: prefix)
        }
        guard reported.isEmpty else {
            return XCTFail(
                "\(reported.count) test-isolation violation(s) over \(files.count) source "
                    + "files. A state object built without an injected location rewrites "
                    + "the developer's own projects/evidence/approvals files, and "
                    + "redirecting HOME does not prevent that. Use TestSandbox.\n"
                    + reported.joined(separator: "\n")
            )
        }
    }

    /// The refusing branch has to be reachable, or this file is decoration:
    /// every rule is fed the shape it exists to catch, and the shapes the fix
    /// introduced have to pass.
    func testScannerRejectsTheForbiddenShapes() throws {
        let offenders: [(name: String, line: String)] = [
            (needle("bare", "Project", "Registry"),
             needle("let r = Project", "Registry", "()")),
            (needle("bare", "Evidence", "Store"),
             needle("let s = Evidence", "Store", "()")),
            (needle("optional", "directory"),
             needle("func make(directory", ": String? = nil", ", channel: X)")),
            (needle("nil", "directory"),
             needle("Evidence", "Store", "(directory", ": nil)")),
            (needle("projects", "constant"),
             needle("Project", "Registry", ".", "defaultProjectsPath")),
            (needle("evidence", "constant"),
             needle("Evidence", "Store", ".", "defaultDirectory")),
            (needle("approvals", "constant"),
             needle("Approval", "Gate", ".", "defaultPath")),
            (needle("home", "composition"),
             needle("let p = NSHome", "Directory", "() + \"", "/.glasspane", "/projects.json\"")),
            (needle("hardcoded", "registry"),
             needle("Project", "Registry", "(filePath", ": \"/tmp/p.json\")")),
            (needle("hardcoded", "store"),
             needle("Evidence", "Store", "(directory", ": \"/tmp/ev\")")),
            (needle("hardcoded", "gate"),
             needle("Approval", "Gate", "(path", ": \"/tmp/ap.json\")")),
        ]
        let rules = try rules()
        for offender in offenders {
            XCTAssertFalse(
                findings(in: offender.line, rules: rules, prefix: "snippet").isEmpty,
                "rule gap: nothing reported the \(offender.name) line \"\(offender.line)\""
            )
        }
        let sanctioned = [
            needle("let r = Project", "Registry", "(filePath: TestSandbox.filePath(\"x\"))"),
            needle("let s = Evidence", "Store", "(directory: dir, maxFiles: nil)"),
            needle("let g = Approval", "Gate", "()"),
            needle("let h = NSHome", "Directory", "()  // not composed with the state folder"),
        ]
        for line in sanctioned {
            XCTAssertEqual(findings(in: line, rules: rules, prefix: "snippet"), [String](), line)
        }
    }

    /// Half (b): the paths the shared helpers hand out are unique, inside the
    /// temp directory, and never the production state folder.
    func testSandboxPathsAreTemporaryAndNotTheStateFolder() throws {
        let temp = NSTemporaryDirectory()
        let directory = TestSandbox.directory("gate")
        let file = TestSandbox.filePath("gate")
        let registry = TestSandbox.projectRegistry("gate")
        let store = TestSandbox.evidenceStore(at: TestSandbox.directory("gate-store"))
        let ledger = TestSandbox.approvalLedger("gate")

        let paths = [directory, file, registry.filePath, store.directory, ledger.path]
        for path in paths {
            XCTAssertTrue(path.hasPrefix(temp), "state path escaped the temp dir: \(path)")
            XCTAssertFalse(
                path.contains(needle("/.", "glasspane")),
                "state path names the production state folder: \(path)"
            )
        }
        // Helpers may not hand the same location to two callers: two tests
        // sharing a registry or an archive is how one fixture becomes another
        // test's "existing state".
        XCTAssertEqual(Set(paths).count, paths.count, "sandbox paths collided: \(paths)")

        // The ledger route is only safe if it really persists where it says.
        ledger.gate.append(
            operationRef: "op_0123456789ABCDEFGHJKMNPQRS",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "test:gate",
            reason: "isolation gate self-check"
        )
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: ledger.path),
            "the ledger did not land on the injected path"
        )
        // A sandbox registry is empty even on a machine with registrations.
        XCTAssertEqual(TestSandbox.projectRegistry("gate").count, 0)
    }
}
