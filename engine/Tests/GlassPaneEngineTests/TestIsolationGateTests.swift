import XCTest
@testable import GlassPaneEngine

/// B2 (audit register) + R7-02 + C-02/C-03/C-05: the source-level test-isolation
/// gate.
///
/// The defect it guards is destruction, not tidiness: a state object built
/// without an injected location resolved that location under the home
/// directory, so a `swift test` run on a developer machine rewrote real
/// state with test fixtures — it did, replacing the real project
/// registrations with the two synthetic entries one test creates. Pointing
/// `HOME` at a sandbox for the run does not help, because the home lookup
/// behind those defaults ignores that variable. The only safe design is
/// structural: no test in this target may build a state object with its
/// production default at all.
///
/// Three halves:
///   (a) production has no path-shaped default left to reach — the archive's
///       `directory:` is required, and an engine without `projectRegistry:`
///       has no registry rather than the developer's. That is what makes the
///       47 test call sites that pass neither argument harmless, and it is
///       why the rules below can be textual: they exist to keep the *escaped*
///       routes (named factories, optional values folded into a location)
///       from creeping back in. Round 3 found the one route this claim did not
///       cover, and it was reached by *omitting* an argument rather than by
///       naming a path: `pruneEvidence` with no project on an engine built with
///       no archive fell through to the shared directory and deleted aged files
///       from it. `EngineCore` now refuses that combination ("no store injected
///       means no disk side effect"), and the last rule below is the textual
///       half of the same pair, which is why it matches two shapes at once;
///   (b) this scan — forbidden shapes matched over the **whole text** of every
///       `.swift` file of the engine test tree, so a construct split across
///       lines is caught as the same shape as one written on a single line
///       (C-05: the old line-local scan called an archive built from a nil
///       location on the next line, and a two-line home composition, clean);
///   (c) `TestSandbox` — every path a test uses comes from the temp directory
///       and is checked at runtime by `assertIsolated`; the last case below
///       proves (c) holds for the paths those helpers hand out.
///
/// Self-proof obligation: a guard whose refusing branch cannot run is not a
/// guard, so `testScannerRejectsTheForbiddenShapes` feeds every shape — one-line
/// and multi-line — back through the same matching code and requires it to be
/// reported, and requires the compliant shapes this round introduced to pass.
///
/// Round 6 added a fourth rule family (`locationPeekRules`) for the route the
/// token rules could not see at all: a test helper that composed its own path out
/// of the system temp or home lookup, wrote state there and deleted it afterwards.
/// It is unique-named, so nothing collides, and it is still not isolation — the
/// home one in particular ran `removeItem` on a home-relative tree. Two files are
/// exempt from it by name (`locationPeekAllowlist`), and
/// `testTheExemptionIsLoadBearingAndScoped` requires each of those names to be
/// earned, because an exemption nobody needs is a hole nobody closed.
///
/// Why this file never reports itself: each searched-for fragment is joined at
/// runtime from two or more string pieces (`needle`), so no run of this source
/// contains the contiguous text a rule looks for — which now matters across
/// whole files, not just per line. Comments are deliberately *not* stripped
/// before matching: the tree was checked for shapes appearing only in prose,
/// and a stripper would also silence a violation hidden behind a `//` inside a
/// raw string. That is also why prose elsewhere in this target names the
/// banned lookups descriptively instead of spelling them out.
final class TestIsolationGateTests: XCTestCase {

    // MARK: - Needles

    /// Joins a searchable fragment from pieces (see the class comment).
    private func needle(_ pieces: String...) -> String { pieces.joined() }

    private struct Rule {
        var name: String
        /// Locations (NSString offsets) in the **whole file text** where this
        /// shape occurs. Whole text, not per line: C-05 caught the old scanner
        /// matching line-locally, which let an archive built from a nil
        /// location written on the following line, and a home path composed
        /// over two lines, slip through unreported.
        var find: (String) -> [Int]
    }

    /// A shape matched across the entire file text. `\s` in these patterns
    /// already spans newlines, so a construct broken over several lines is the
    /// same shape written on one.
    private func rule(_ name: String, _ pattern: String) throws -> Rule {
        let regex = try NSRegularExpression(pattern: pattern)
        return Rule(name: name) { text in
            let full = NSRange(text.startIndex..., in: text)
            return regex.matches(in: text, range: full).map { $0.range.location }
        }
    }

    /// `head` … `tail` within `gap` characters of each other. For the shapes
    /// that are two *separate* literals, e.g. a home lookup and a state-folder
    /// literal that only become a production path when composed — the window is
    /// what keeps a file mentioning both 20 lines apart out of the findings.
    private func pairRule(_ name: String, head: String, tail: String, gap: Int = 120) -> Rule {
        Rule(name: name) { text in
            let ns = text as NSString
            var hits: [Int] = []
            var cursor = 0
            while cursor < ns.length {
                let window = NSMakeRange(cursor, ns.length - cursor)
                let found = ns.range(of: head, options: [], range: window)
                guard found.location != NSNotFound else { break }
                let reach = NSMakeRange(
                    found.location,
                    Swift.min(gap, ns.length - found.location)
                )
                if ns.range(of: tail, options: [], range: reach).location != NSNotFound {
                    hits.append(found.location)
                }
                cursor = found.location + head.count
            }
            return hits
        }
    }

    /// The C-02/C-03 root shape: a path/state argument whose value is a **bare
    /// identifier** that this same file declares with an optional type. Such a
    /// call site has a nil case, and nil is a location nobody chose — which is
    /// exactly how the real archive got written to. A call that supplies a
    /// fallback (`registry ?? …`) or an expression (`directory: dir.json`) is
    /// not this shape.
    private func forwardedOptionalRule(
        _ name: String, argument: String, declaredAs: String
    ) throws -> Rule {
        let forward = try NSRegularExpression(
            pattern: argument + "\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*[,)]"
        )
        return Rule(name: name) { text in
            let ns = text as NSString
            let full = NSRange(text.startIndex..., in: text)
            var hits: [Int] = []
            for match in forward.matches(in: text, range: full) {
                let identifier = ns.substring(with: match.range(at: 1))
                guard identifier != "nil" else { continue }
                let declared = try? NSRegularExpression(
                    pattern: "\\b" + NSRegularExpression.escapedPattern(for: identifier)
                        + "\\s*:\\s*" + declaredAs + "\\s*\\?"
                )
                if declared?.matches(in: text, range: full).isEmpty == false {
                    hits.append(match.range.location)
                }
            }
            return hits
        }
    }

    /// The route no token rule can see: an age-prune with **no project named**
    /// on an engine built with **no archive injected**. Neither half is a path
    /// literal or a state-object default — the shared archive was reached by
    /// *omitting* an argument — and that pair is what deleted aged entries out
    /// of the developer's own archive from inside `swift test`, one argument
    /// away. `EngineCore` refuses the combination now; the rule keeps the call
    /// shape from being written again unnoticed. Deliberately a *pair*: an
    /// injected store plus a nil project is the one legitimate form (it prunes
    /// the archive the caller named), and a store-less engine pruned by project
    /// is legitimate too.
    private func storeLessPruneRule(_ name: String) throws -> Rule {
        let prune = try NSRegularExpression(
            // `[^)]*` keeps the search inside one argument list, so the shape
            // is found whatever order the arguments are written in and however
            // many lines the call spans.
            pattern: needle("prune", "Evidence")
                + "\\s*\\([^)]*" + needle("projectId") + "\\s*:\\s*nil"
        )
        let noArchive = try NSRegularExpression(
            pattern: needle("evidence", "Store") + "\\s*:\\s*nil"
        )
        return Rule(name: name) { text in
            let full = NSRange(text.startIndex..., in: text)
            guard noArchive.matches(in: text, range: full).isEmpty == false else {
                return []
            }
            return prune.matches(in: text, range: full).map { $0.range.location }
        }
    }

    /// The forbidden shapes. `registry`, `store` and `gate` are the three
    /// file-backed state objects of the engine; each rule names the cost of
    /// the shape it catches.
    private func rules() throws -> [Rule] {
        let registry = needle("Project", "Registry")
        let store = needle("Evidence", "Store")
        let gate = needle("Approval", "Gate")
        // The labels of the path/state arguments, joined at runtime.
        let directory = needle("directory")
        let filePath = needle("filePath")
        let projectRegistry = needle("project", "Registry")
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
                // directory forwarded nil into the archive location. Extended
                // to the registry path label, which carries the same weight.
                "optional path parameter with a nil default",
                needle("(", directory, "|", filePath, ")", "\\s*:\\s*String\\s*\\?\\s*=\\s*nil")
            ),
            try rule(
                "nil forwarded as an archive or registry location",
                needle("(", directory, "|", filePath, ")", "\\s*:\\s*nil")
            ),
            try rule(
                "nil folded into a state object (its production default)",
                needle("\\?\\?\\s*(", "Project", "Registry", "|", "Evidence", "Store", "|", "Approval", "Gate", ")\\s*\\(")
            ),
            try forwardedOptionalRule(
                "optional path value forwarded into a state object",
                // Non-capturing, so group 1 of the forwarder is the identifier.
                argument: needle("(?:", directory, "|", filePath, ")"),
                declaredAs: "String"
            ),
            try forwardedOptionalRule(
                "optional registry forwarded as an engine's project state",
                argument: projectRegistry,
                declaredAs: registry
            ),
            try rule(
                // The named escape route: production archive, reachable only by
                // spelling this out. No test helper may call it.
                "production archive factory named in a test",
                store + needle("\\.at", "Production", "Default")
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
                head: needle("NSHome", "Directory"),
                tail: needle("/.", "glasspane")
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
            try storeLessPruneRule(
                "age-prune with no project on an engine with no archive (shared default)"
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

    /// The two files exempt from `locationPeekRules`, by name.
    ///
    /// A rule that bans reading the system's own temp and home locations can be
    /// satisfied in exactly one honest way: a test asks for the value from
    /// somewhere. So the ban is "one place may ask, and that place is named",
    /// not "no file may contain the token":
    ///   * `TestSupport.swift` *is* that place — `TestSandbox` hands out every
    ///     write target from the temp root, and its runtime predicate compares
    ///     against the same lookup;
    ///   * this file is the gate's own end-to-end check (half (c)), which
    ///     compares sandbox paths against the raw temp value on purpose: routing
    ///     that assertion through `TestSandbox.systemTempRoot` would let the
    ///     sandbox grade its own homework, since the value under test would be
    ///     the one the sandbox chose to report.
    /// Both files still have to *contain* the banned shapes, which
    /// `testTheExemptionIsLoadBearingAndScoped` re-scans with the exemption
    /// lifted. An allowlist nobody needs is a hole nobody closed.
    private var locationPeekAllowlist: Set<String> {
        Set([needle("Test", "Support") + ".swift",
             needle("TestIsolation", "GateTests") + ".swift"])
    }

    /// The two rules whose only purpose is "no file may compose a state path out
    /// of the system's own locations". Kept separate from `rules()` because half
    /// of them is file-name scoped.
    private func locationPeekRules() throws -> [Rule] {
        [
            try rule(
                "temp location peeked at by hand",
                needle("NS", "Temporary", "Directory") + needle("\\s*\\(")
                    + needle("|", "\\.", "temporary", "Directory")
            ),
            try rule(
                "home location composed into a path by hand",
                needle("NSHome", "Directory") + needle("\\s*\\(\\s*\\)\\s*\\+")
            ),
        ]
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

    /// Every rule hit in one text, as `name:line [rule] source`. The line is
    /// where the *shape* begins, which for a multi-line construct is its first
    /// line; a rule that hits several times reports each one.
    private func findings(in text: String, rules: [Rule], prefix: String) -> [String] {
        let ns = text as NSString
        let lines = text.components(separatedBy: "\n")
        var hits: [String] = []
        for rule in rules {
            for offset in rule.find(text) {
                let index = ns.substring(to: Swift.min(offset, ns.length))
                    .components(separatedBy: "\n").count - 1
                let source = index < lines.count
                    ? lines[index].trimmingCharacters(in: .whitespaces)
                    : ""
                hits.append("\(prefix):\(index + 1) [\(rule.name)] \(source)")
            }
        }
        return hits.sorted()
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
        let peekRules = try locationPeekRules()
        var reported: [String] = []
        for url in files {
            let text = try String(contentsOf: url, encoding: .utf8)
            let prefix = String(url.path.dropFirst(root.path.count))
            reported += findings(in: text, rules: rules, prefix: prefix)
            if !locationPeekAllowlist.contains(url.lastPathComponent) {
                reported += findings(in: text, rules: peekRules, prefix: prefix)
            }
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
    /// every rule is fed the shape it exists to catch — including the shapes
    /// written across several lines, which is what the old line-local scanner
    /// reported as clean — and the shapes the fix introduced have to pass.
    func testScannerRejectsTheForbiddenShapes() throws {
        // The pair shape the token rules cannot see, one line and split. Held in
        // locals so the assertions below can require *this* rule — not any other
        // — to be the one that reports it.
        let projectLessPrune = needle(
            "let c = Engine", "Core", "(channel: ch, evidence", "Store", ": nil)\n",
            "let removed = try c.prune", "Evidence(projectId: nil, olderThanDays: 30)"
        )
        let projectLessPruneSplit = needle(
            "let c = Engine", "Core", "(channel: ch,\n  evidence", "Store", ": nil)\n",
            "let removed = try c.prune", "Evidence(\n  projectId: nil,\n  olderThanDays: 30\n)"
        )
        let offenders: [(name: String, text: String)] = [
            (needle("bare", "Project", "Registry"),
             needle("let r = Project", "Registry", "()")),
            (needle("bare", "Evidence", "Store"),
             needle("let s = Evidence", "Store", "()")),
            (needle("optional", "directory"),
             needle("func make(directory", ": String? = nil", ", channel: X)")),
            (needle("optional", "filePath"),
             needle("func make(filePath", ": String? = nil", ", clock: C)")),
            (needle("nil", "directory"),
             needle("Evidence", "Store", "(directory", ": nil)")),
            (needle("nil-folded registry"),
             needle("self.registry = project", "Registry", " ?? Project", "Registry", "()")),
            (needle("forwarded optional path"),
             needle("let dir: String? = nil\n",
                    "let s = Evidence", "Store", "(\n  directory", ": dir,\n  maxFiles: nil\n)")),
            (needle("forwarded optional registry"),
             needle("var reg: Project", "Registry", "? = nil\n",
                    "let c = Engine", "Core", "(channel: ch,\n  project", "Registry", ": reg)")),
            (needle("production factory"),
             needle("let s = Evidence", "Store", ".", "atProduction", "Default", "()")),
            (needle("projects", "constant"),
             needle("Project", "Registry", ".", "defaultProjectsPath")),
            (needle("evidence", "constant"),
             needle("Evidence", "Store", ".", "defaultDirectory")),
            (needle("approvals", "constant"),
             needle("Approval", "Gate", ".", "defaultPath")),
            (needle("home", "composition, one line"),
             needle("let p = NSHome", "Directory", "() + \"", "/.glasspane", "/projects.json\"")),
            (needle("home", "composition, two lines"),
             needle("let home = NSHome", "Directory", "()\n",
                    "let p = home + \"", "/.glasspane", "/evidence\"")),
            (needle("hardcoded", "registry"),
             needle("Project", "Registry", "(filePath", ": \"/tmp/p.json\")")),
            (needle("hardcoded", "store"),
             needle("Evidence", "Store", "(directory", ": \"/tmp/ev\")")),
            (needle("hardcoded", "gate"),
             needle("Approval", "Gate", "(path", ": \"/tmp/ap.json\")")),
            (needle("project-less", "prune"), projectLessPrune),
            (needle("project-less prune, split across lines"), projectLessPruneSplit),
            (needle("temp location peeked, one line"),
             needle("let dir = NS", "TemporaryDirectory", "() + \"gp-x\"")),
            (needle("temp location peeked, split across lines"),
             needle("let dir = NS", "TemporaryDirectory", "(\n  )\n  + \"gp-x\"")),
            (needle("FileManager temp directory property"),
             needle("let dir = fm.", "temporary", "Directory", "().path")),
            (needle("home location composed into a path"),
             needle("let p = NSHome", "Directory", "() + \"", "/gp-state", "/ev\"")),
        ]
        let rules = try rules() + locationPeekRules()
        for offender in offenders {
            XCTAssertFalse(
                findings(in: offender.text, rules: rules, prefix: "snippet").isEmpty,
                "rule gap: nothing reported the \(offender.name) shape\n\(offender.text)"
            )
        }
        // Attribution: the pair rule has to be the one that fires, or a future
        // rule that happens to cover part of the shape could leave this pair
        // unreported while the loop above still passes.
        let prunePairRules = rules.filter { $0.name.hasPrefix("age-prune") }
        XCTAssertEqual(prunePairRules.count, 1, "the pair rule is missing from `rules()`")
        for shape in [projectLessPrune, projectLessPruneSplit] {
            XCTAssertEqual(
                findings(in: shape, rules: prunePairRules, prefix: "snippet").count, 1,
                "the pair rule did not report the project-less prune shape\n\(shape)"
            )
        }
        let sanctioned: [String] = [
            needle("let r = Project", "Registry", "(filePath: TestSandbox.filePath(\"x\"))"),
            // C-05: this file used to list an archive built from a local `dir`
            // that could hold nil as the compliant shape. An archive location is
            // a required `String` now, so the compliant route is the sandbox,
            // and the optional local above is an offender.
            needle("let s = Evidence", "Store", "(directory: TestSandbox.directory(\"x\"))"),
            needle("let dir = TestSandbox.directory(\"x\")\n",
                   "let s = Evidence", "Store", "(\n  directory", ": dir,\n  maxFiles: nil\n)"),
            needle("let c = Engine", "Core", "(channel: ch, project", "Registry", ": reg ?? TestSandbox.projectRegistry(\"x\"))"),
            needle("let g = Approval", "Gate", "()"),
            // The two legitimate halves of the pair rule: pruning the archive
            // the caller *did* name, with no project; and a store-less engine
            // pruned by project, which resolves through the registry instead.
            needle("let c = Engine", "Core", "(channel: ch, evidence", "Store", ": store)\n",
                   "let removed = try c.prune", "Evidence(projectId: nil, olderThanDays: 30)"),
            needle("let c = Engine", "Core", "(channel: ch, evidence", "Store", ": nil)\n",
                   "let removed = try c.prune", "Evidence(projectId: project, olderThanDays: 30)"),
            needle("let h = NSHome", "Directory", "()  // not composed with the state folder"),
            // The window is what makes the two-line composition rule safe: the
            // same two literals far apart in one file are not a composed path.
            needle("let far = NSHome", "Directory", "()\n",
                   "// a prose note, deliberately long so that it sits outside the composition window:",
                   " the developer keeps their own state under a folder whose name appears here as /.",
                   "glasspane, in prose only; it is never joined to the home lookup above, and that is",
                   " the difference this window is for.\n"),
        ]
        for text in sanctioned {
            XCTAssertEqual(findings(in: text, rules: rules, prefix: "snippet"), [String](), text)
        }
    }

    /// The two location-peek rules exist to stop a test composing a state path
    /// out of the system's own temp/home lookups; the route that replaces them is
    /// naming the location once (`TestSandbox`) and taking it from there. So the
    /// compliant shapes below have to stay clean even though they *do* build a
    /// path from a location value — the ban is on hand-composing the lookup, not
    /// on holding a path in a local.
    func testLocationPeekRulesReportOnlyTheHandComposedLookups() throws {
        let peek = try locationPeekRules()
        XCTAssertEqual(peek.count, 2, "the peek rule set lost a member")
        let offenders = [
            needle("let dir = NS", "Temporary", "Directory", "() + \"gp-x\""),
            needle("let dir = fm.", "temporary", "Directory", "()"),
            needle("let p = NSHome", "Directory", "() + \"/x\""),
        ]
        for (index, text) in offenders.enumerated() {
            let hits = findings(in: text, rules: peek, prefix: "snippet")
            XCTAssertFalse(hits.isEmpty, "peek rule gap: nothing reported \(index)\n\(text)")
        }
        // Attribution, in both directions: the temp rule must be the one that
        // reports a temp lookup and the home rule the one that reports a home
        // composition. Otherwise a future edit could make one pattern swallow the
        // other's shape and the loop above would still pass.
        let tempRule = peek.filter { $0.name.hasPrefix("temp") }
        let homeRule = peek.filter { $0.name.hasPrefix("home") }
        XCTAssertEqual(tempRule.count, 1)
        XCTAssertEqual(homeRule.count, 1)
        XCTAssertEqual(findings(in: offenders[0], rules: tempRule, prefix: "s").count, 1,
                       "the temp rule did not report its own shape")
        XCTAssertEqual(findings(in: offenders[1], rules: tempRule, prefix: "s").count, 1,
                       "the temp rule missed the FileManager property spelling")
        XCTAssertEqual(findings(in: offenders[2], rules: homeRule, prefix: "s").count, 1,
                       "the home rule did not report its own shape")
        for text in [
            // Split like every other snippet in this file: the scan reads this
            // file's whole text too, so a compliant example written as one
            // contiguous literal is a violation the gate reports against itself.
            needle("let dir = TestSandbox.directory(\"x\")\n",
                   "let s = Evidence", "Store", "(directory", ": dir)"),
            needle("let dir = TestSandbox.filePath(\"x\")\n",
                   "let r = Project", "Registry", "(filePath", ": dir)"),
            needle("let t = TestSandbox.systemTempRoot  // read for a predicate, not composed"),
            needle("let inHome = TestSandbox.resolvesUnder", "RealHome", "(dir)"),
        ] {
            XCTAssertEqual(findings(in: text, rules: peek, prefix: "s"), [String](), text)
        }
    }

    /// An exemption that nothing needs is a hole nobody closed, so each
    /// allowlisted file has to earn its name: lifting the exemption over its own
    /// text has to report something. The set is also pinned to exactly the two
    /// files it names, and every *other* file in the tree is proven to hold no
    /// banned lookup by the main scan, which excludes only these names.
    func testTheExemptionIsLoadBearingAndScoped() throws {
        let root = testTreeRoot
        let files = swiftFiles(under: root)
        XCTAssertFalse(files.isEmpty, "the gate scanned nothing, so it guards nothing")
        let names = Set(files.map { $0.lastPathComponent })
        for exempt in locationPeekAllowlist {
            XCTAssertTrue(names.contains(exempt), "allowlist names a file that is not there: \(exempt)")
        }
        XCTAssertEqual(
            locationPeekAllowlist.count, 2,
            "the location-peek exemption is for one implementation file and the gate itself; "
                + "a third name needs that reason written here"
        )
        let peek = try locationPeekRules()
        for exempt in locationPeekAllowlist.sorted() {
            guard let url = files.first(where: { $0.lastPathComponent == exempt }) else { continue }
            let text = try String(contentsOf: url, encoding: .utf8)
            let hits = findings(in: text, rules: peek, prefix: exempt)
            XCTAssertFalse(
                hits.isEmpty,
                "\(exempt) is exempt from the location-peek rules but contains none of their "
                    + "shapes — remove it from the allowlist, or the exemption is decoration."
            )
        }
    }

    /// Half (c): the paths the shared helpers hand out are unique, inside the
    /// temp directory, and never the production state folder — and the runtime
    /// predicate behind those assertions refuses what it claims to refuse.
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

        // C-05: the runtime half must be able to refuse — one case per branch,
        // so a helper that ever hands out a path outside the temp directory, or
        // one inside the state folder, fails at the moment the path is created.
        let stateFolder = needle("/.", "glasspane")
        XCTAssertEqual(
            TestSandbox.isolationDefect("/Use" + "rs/someone" + stateFolder + "/evidence")?
                .contains("outside NSTemporaryDirectory"), true,
            "a path outside the temp directory must be refused before anything else"
        )
        XCTAssertEqual(
            TestSandbox.isolationDefect(temp + stateFolder + "/evidence")?
                .contains("production state folder"), true,
            "a temp-prefixed path that names the state folder must be refused too"
        )
        XCTAssertNotNil(
            TestSandbox.isolationDefect("/Some" + "where/else/T/gate-run"),
            "any other location must be refused"
        )
        XCTAssertNil(
            TestSandbox.isolationDefect(TestSandbox.directory("gate-ok")),
            "the sandbox route must pass its own check"
        )
    }
}
