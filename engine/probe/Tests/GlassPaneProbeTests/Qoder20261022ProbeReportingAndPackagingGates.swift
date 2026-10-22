import XCTest
@testable import GlassPaneProbe

// 2026-10-22 — the probe's default socket name, the honesty of the `capture`
// frame, the reconnect comment, and the two shapes of `make-app.sh` that the
// shipped product depends on (declared macOS floor, interpreter portability).
//
// WHY SOME OF THESE ARE SOURCE-SCAN GATES. Three of the defects live in code
// that this suite cannot execute: the packaging script produces `.app` bundles
// out of release artifacts a unit test has no business building, `endMetalCapture`
// needs a live GPU capture (no window, no screen-recording seat, no Graphics
// Inspector in CI), and the reconnect schedule's real cost is 36 s of sleeping.
// Each of those gates names the exact mutation that reddens it, in the same
// convention `engine/Tests/GlassPaneEngineTests/CaptureChannelShapeTests.swift`
// and `updater/test/bundle-names.test.mjs` already use. Everything that CAN be
// driven is driven — `resolveSocketPath`, `captureEndReport` and the escalating
// backoff are pure functions and every one of them is called for real below.

final class Qoder20261022ProbeReportingAndPackagingGates: XCTestCase {

    override func setUp() {
        super.setUp()
        GP.runtime.resetForTests()
    }

    override func tearDown() {
        GP.runtime.resetForTests()
        super.tearDown()
    }

    // MARK: File access

    /// `#filePath` is compiled in, so this resolves the same way on CI and here:
    /// engine/probe/Tests/GlassPaneProbeTests/<this file> → repo root (five up).
    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.path
    }

    private func read(_ relative: String) throws -> String {
        let path = repoRoot + "/" + relative
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(relative)；这一条在没有该文件的环境里不作数")
        }
        return text
    }

    /// Shell lines only: a whole-line comment is not code. This script's header
    /// quotes the bash-only option it dropped, so a scan that kept comments would
    /// go red on the explanation of the fix — and the first thing a person does
    /// then is delete the explanation, not the defect.
    private func shellCode(_ script: String) -> String {
        script.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("#") }
            .joined(separator: "\n")
    }

    /// Swift comment lines, same reasoning inverted: the reconnect gate reads
    /// *only* the comments, because the comment is the defect.
    private func swiftCommentLines(_ source: String) -> [String] {
        source.components(separatedBy: "\n").filter {
            let trimmed = $0.trimmingCharacters(in: .whitespaces)
            return trimmed.hasPrefix("//") || trimmed.hasPrefix("/*") || trimmed.hasPrefix("*")
        }
    }

    /// One function's body, as the slice from its declaration line to the closing
    /// brace at the *same* indent. `public static` lines are skipped because every
    /// one of these has a `GP` wrapper of the same name above the runtime, and a
    /// slice of the wrapper would prove nothing about the code under it. A
    /// whole-file scan would let a proof live in a comment instead of in the call
    /// site it is meant to pin.
    private func body(of declaration: String, in source: String) -> String? {
        let lines = source.components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: {
            $0.contains(declaration) && !$0.contains("static func")
        }) else { return nil }
        let indent = lines[start].prefix(while: { $0 == " " || $0 == "\t" }).count
        var out: [String] = []
        for raw in lines[(start + 1)...] {
            let leading = raw.prefix(while: { $0 == " " || $0 == "\t" }).count
            if raw.trimmingCharacters(in: .whitespaces) == "}", leading == indent { break }
            out.append(raw)
        }
        return out.joined(separator: "\n")
    }

    private func probeSource() throws -> String {
        try read("engine/probe/Sources/GlassPaneProbe/GlassPaneProbe.swift")
    }

    /// The major out of the first `macOS <n>+` / `macOS <n> or later` requirement
    /// in a document, so the bundle floor is checked against the *claim* rather
    /// than against a number this test also invented.
    private func documentedFloorMajor(in text: String) -> Int? {
        for raw in text.components(separatedBy: "\n") {
            guard let found = raw.range(of: "macOS ") else { continue }
            var digits = ""
            var cursor = found.upperBound
            while cursor < raw.endIndex, raw[cursor].isNumber {
                digits.append(raw[cursor])
                cursor = raw.index(after: cursor)
            }
            guard !digits.isEmpty, cursor < raw.endIndex else { continue }
            let tail = String(raw[cursor...]).prefix(24).lowercased()
            if tail.hasPrefix("+") || tail.contains("or later") { return Int(digits) }
        }
        return nil
    }

    // MARK: Finding 5 — which socket a default `GP.start()` aims at

    func testTheNamedStateRootResolvesToThatRootsProbeSocket() throws {
        // `glasspaned --state-dir X` binds `X/probe.sock`
        // (`StateRoot.probeSocketFile`, applied at `glasspaned/main.swift:1528`).
        // An app calling `GP.start()` with no argument had to land on that name.
        let root = "/var/tmp/gp-isolated-root"
        XCTAssertEqual(
            ProbeRuntime.resolveSocketPath(
                explicit: nil,
                env: [ProbeRuntime.stateDirEnvironmentKey: root],
                home: "/Users/nobody"
            ),
            root + "/probe.sock",
            "GLASSPANE_STATE_DIR 点名的根下那个 probe.sock 才是 daemon 在听的名字"
        )
    }

    func testBothSpellingsOfTheRootNameTheSameListener() throws {
        // `/tmp/x` and `/tmp/x/` are one root; the daemon's `StateRoot.child` never
        // produces a doubled slash, and neither may the probe — a `//` in a
        // sockaddr_un is a name nobody bound.
        for spelling in ["/var/tmp/gp-root", "/var/tmp/gp-root/", "/var/tmp/gp-root//"] {
            let resolved = ProbeRuntime.resolveSocketPath(
                explicit: nil,
                env: [ProbeRuntime.stateDirEnvironmentKey: spelling],
                home: "/Users/nobody"
            )
            XCTAssertEqual(resolved, "/var/tmp/gp-root/probe.sock", "拼写 \"\(spelling)\" 解析成了别处")
            XCTAssertFalse(resolved.contains("//"), "\(resolved)")
        }
        XCTAssertEqual(ProbeRuntime.probeSocketPath(inRoot: "/var/tmp/gp-root/"), "/var/tmp/gp-root/probe.sock")
    }

    func testTheSocketOverrideOutranksTheNamedRootAndTheExplicitArgumentOutranksBoth() throws {
        let env = [
            ProbeRuntime.probeSocketEnvironmentKey: "/var/tmp/sock-named-directly.sock",
            ProbeRuntime.stateDirEnvironmentKey: "/var/tmp/gp-root"
        ]
        // The argument the caller typed is the highest authority (same rule the
        // daemon applies to `--socket-path` over `--state-dir`).
        XCTAssertEqual(
            ProbeRuntime.resolveSocketPath(explicit: "/var/tmp/caller-chosen.sock", env: env, home: "/Users/nobody"),
            "/var/tmp/caller-chosen.sock"
        )
        // `GLASSPANE_PROBE_SOCK` is the only variable naming a socket outright
        // (P6 §2.1, and what `engine/.p6_smoke.py` sets) — it beats a root.
        XCTAssertEqual(
            ProbeRuntime.resolveSocketPath(explicit: nil, env: env, home: "/Users/nobody"),
            "/var/tmp/sock-named-directly.sock"
        )
        // With only the root named, that root's listener answers.
        XCTAssertEqual(
            ProbeRuntime.resolveSocketPath(
                explicit: nil,
                env: [ProbeRuntime.stateDirEnvironmentKey: "/var/tmp/gp-root"],
                home: "/Users/nobody"
            ),
            "/var/tmp/gp-root/probe.sock"
        )
    }

    func testNothingNamedKeepsTheHomeDefaultProbeSocket() throws {
        // The last level is the one that was already there, and it is the daemon's
        // own default: `~/.glasspane/probe.sock`.
        XCTAssertEqual(
            ProbeRuntime.resolveSocketPath(explicit: nil, env: [:], home: "/Users/nobody"),
            "/Users/nobody/.glasspane/probe.sock"
        )
        // `~/…` is NOT expanded here, because `StateRoot.canonical` does not expand
        // it for `--state-dir` either — the probe must not invent a root the daemon
        // never bound.
        XCTAssertEqual(
            ProbeRuntime.resolveSocketPath(
                explicit: nil,
                env: [ProbeRuntime.stateDirEnvironmentKey: "~/sandbox-root"],
                home: "/Users/nobody"
            ),
            "~/sandbox-root/probe.sock"
        )
    }

    func testABlankValueCountsAsNotNamedAtEveryLevel() throws {
        // `export GLASSPANE_STATE_DIR=` must fall through, not connect to the empty
        // string (the panel applies the same rule; three levels, three chances).
        for blank in ["", "   ", "\t", "\n"] {
            let env = [
                ProbeRuntime.probeSocketEnvironmentKey: blank,
                ProbeRuntime.stateDirEnvironmentKey: "/var/tmp/gp-root"
            ]
            XCTAssertEqual(
                ProbeRuntime.resolveSocketPath(explicit: blank, env: env, home: "/Users/nobody"),
                "/var/tmp/gp-root/probe.sock",
                "空白的显式参数把下一级吞了：\"\(blank)\""
            )
            XCTAssertEqual(
                ProbeRuntime.resolveSocketPath(
                    explicit: nil, env: [ProbeRuntime.probeSocketEnvironmentKey: blank], home: "/Users/nobody"
                ),
                "/Users/nobody/.glasspane/probe.sock",
                "空白的 PROBE_SOCK 不许当一个 socket 名：\"\(blank)\""
            )
            XCTAssertEqual(
                ProbeRuntime.resolveSocketPath(
                    explicit: nil, env: [ProbeRuntime.stateDirEnvironmentKey: blank], home: "/Users/nobody"
                ),
                "/Users/nobody/.glasspane/probe.sock",
                "空白的 STATE_DIR 该按没点名算：\"\(blank)\""
            )
        }
    }

    /// The two packages name the same directory and the same leaf, in words, twice.
    /// This gate reads the daemon's file so the probe cannot redefine either half
    /// and keep its own suite green — the shape of drift `bundle-names.test.mjs`
    /// exists for on the JS side.
    func testTheProbeAndTheDaemonSpellTheFolderAndTheLeafTheSame() throws {
        let stateRoot = try read("engine/Sources/GlassPaneEngine/StateRoot.swift")
        XCTAssertTrue(
            stateRoot.contains("child(\"\(ProbeRuntime.probeSocketFileName)\")"),
            "daemon 不再把 \(ProbeRuntime.probeSocketFileName) 派生自状态根了，而探针还在这么猜"
        )
        XCTAssertTrue(
            stateRoot.contains("folderName = \"\(ProbeRuntime.stateFolderName)\""),
            "家目录默认根的名字变了：探针的 \(ProbeRuntime.stateFolderName) 指的是一个没人绑的目录"
        )
        XCTAssertEqual(ProbeRuntime.probeSocketFileName, "probe.sock")
        XCTAssertEqual(ProbeRuntime.stateFolderName, ".glasspane")
    }

    /// The resolver only matters if `start` uses it. REVERSE: put the old
    /// `socketPath ?? env["GLASSPANE_PROBE_SOCK"] ?? (NSHomeDirectory() + …)` back
    /// into `start` and this goes red while every pure test above stays green —
    /// which is precisely the hole a value-only test would have left.
    func testStartResolvesTheDefaultInsteadOfGuessingIt() throws {
        let source = try probeSource()
        let start = try XCTUnwrap(
            body(of: "func start(socketPath: String?, appName: String?)", in: source),
            "ProbeRuntime.start 的形状变了，这一条钉的正是它"
        )
        XCTAssertTrue(
            start.contains("resolveSocketPath(explicit: socketPath)"),
            "start 没有走 resolveSocketPath：默认名回到了只认 PROBE_SOCK 与家目录那一版"
        )
        XCTAssertFalse(
            start.contains("NSHomeDirectory()"),
            "start 里自己在拼家目录默认名——那一级属于 resolveSocketPath"
        )
        XCTAssertTrue(
            start.contains("serveConnections(path: path"),
            "解析出来的名字没有交给连接线程"
        )
    }

    /// End-to-end, inside a sandbox: a listener bound at the *named root's*
    /// `probe.sock` must be the one the connection thread reaches, and it must be
    /// greeted with `hello`. Aims at nothing on this machine otherwise — see the
    /// guard, which exists because the alternative is a red run attaching to the
    /// live `~/.glasspane/probe.sock`.
    func testTheEnvironmentNamedRootIsTheSocketTheThreadIsAimedAt() throws {
        let root = try sandboxDirectory("sockroot")
        let expected = root + "/" + ProbeRuntime.probeSocketFileName
        XCTAssertLessThan(expected.utf8.count, 104, "socket 路径超出 sockaddr_un：\(expected)")

        let homeDefault = ProbeRuntime.probeSocketPath(
            inRoot: NSHomeDirectory() + "/" + ProbeRuntime.stateFolderName
        )
        guard !FileManager.default.fileExists(atPath: homeDefault) else {
            // Do not start a thread at all: on this machine the live daemon answers
            // that name, and `socketPath:`-less tests must never talk to it.
            // `engine/.p6_smoke.py` would NOT catch this regression either — it
            // exports GLASSPANE_PROBE_SOCK itself, so it never exercises a default.
            throw XCTSkip(
                "\(homeDefault) 存在：这一条不启动任何连接（默认名的端到端要在没有现网 daemon 的机器上跑）；"
                    + "解析与接线由 testStartResolvesTheDefaultInsteadOfGuessingIt 与纯函数用例覆盖"
            )
        }

        let stateGuard = ProcessEnvironmentGuard(key: ProbeRuntime.stateDirEnvironmentKey, value: root)
        let sockGuard = ProcessEnvironmentGuard(key: ProbeRuntime.probeSocketEnvironmentKey, value: nil)
        defer { stateGuard.restore(); sockGuard.restore() }

        let listener = makeListener(path: expected)
        XCTAssertGreaterThanOrEqual(listener, 0, "夹具 listener 没能绑上 \(expected)")
        defer { close(listener); unlink(expected) }

        GP.runtime.backoffOverrideMs = 50
        GP.start(appName: "unit-test") // no socketPath: the default is under test
        XCTAssertEqual(
            GP.runtime.debugSocketPathForTests, expected,
            "start 把连接线程派向了别处：\(String(describing: GP.runtime.debugSocketPathForTests))"
        )
        let client = acceptConnection(listener, within: 5)
        XCTAssertGreaterThanOrEqual(client, 0, "daemon 在点名根的 probe.sock 上听着，探针却没到这个名字上来")
        defer { close(client) }
        let hello = try XCTUnwrap(FrameReader(client).nextJSON(), "第一个帧是握手，没有它什么都没说")
        XCTAssertEqual(hello["t"] as? String, "hello")
        XCTAssertEqual(hello["appName"] as? String, "unit-test")
    }

    // MARK: Finding 4 — a `capture` frame may not certify a file it never looked at

    /// `stopCapture()` is fire-and-forget and the `.gputrace` document lands
    /// asynchronously, so the end frame used to answer `error: nil` for a path it
    /// had never checked: a named-but-absent artifact travelled as a success.
    /// Driven as a pure function over "path + exists" — no live Metal capture.
    func testCaptureEndRefusesToCertifyAnAbsentDocument() throws {
        // Nothing was in progress: the answer the suite already pins.
        let none = ProbeRuntime.captureEndReport(capturedPath: nil, documentExists: false)
        XCTAssertNil(none.path)
        XCTAssertEqual(none.error, "no capture in progress")
        XCTAssertEqual(
            ProbeRuntime.captureEndReport(capturedPath: "", documentExists: true).error,
            "no capture in progress",
            "空路径不是一个产物名"
        )

        // The bug: a path named, no file. REVERSE MUTATION: make this branch return
        // `(capturedPath, nil)` — the shape the fix replaced — and the two lines
        // below go red.
        let absent = ProbeRuntime.captureEndReport(
            capturedPath: "/var/tmp/gp-never-written.gputrace", documentExists: false
        )
        XCTAssertEqual(absent.path, "/var/tmp/gp-never-written.gputrace", "命名仍然要说出来，否认的是成功")
        XCTAssertNotNil(
            absent.error,
            "一个不在磁盘上的产物不能带着 error: nil 出门——那是一条被引用的证据其实不存在"
        )
        XCTAssertTrue(absent.error?.contains("absent") ?? false, "\(String(describing: absent.error))")

        // Present: the success this frame is allowed to claim.
        let present = ProbeRuntime.captureEndReport(
            capturedPath: "/var/tmp/gp-real.gputrace", documentExists: true
        )
        XCTAssertEqual(present.path, "/var/tmp/gp-real.gputrace")
        XCTAssertNil(present.error, "验过的产物不许被改成一句拒绝")
    }

    /// The call site has to *be* the decision above. REVERSE: restore
    /// `emitCapture(path: url?.path, error: nil)` in `endMetalCapture` and this
    /// goes red while the pure test keeps passing — the hole that lets the frame
    /// and the check live in different places.
    func testEndMetalCaptureEmitsTheExistenceCheckedDecision() throws {
        let source = try probeSource()
        let end = try XCTUnwrap(body(of: "func endMetalCapture()", in: source))
        XCTAssertTrue(
            end.contains("captureEndReport"),
            "endMetalCapture 不再经过 captureEndReport：那条帧回到了不看房子的版本"
        )
        XCTAssertTrue(
            end.contains("fileExists(atPath:"),
            "存在性没有从文件系统读：documentExists 是凭空给的"
        )
        XCTAssertFalse(
            end.contains("emitCapture(path: url?.path, error: nil)"),
            "一条只命名产物的帧又被当成成功了"
        )
        // The begin frame is deliberately NOT existence-checked: at begin the
        // document is supposed to be absent (Metal writes it as the capture runs),
        // so a check there would refuse every real capture.
        let begin = try XCTUnwrap(body(of: "func beginMetalCapture(destinationURL: URL?)", in: source))
        XCTAssertFalse(begin.contains("fileExists(atPath:"), "begin 那一条查存在性会把每一次真捕获都判成失败")
    }

    // MARK: Finding 2 — the comment must describe the schedule that runs

    /// The schedule is 1 s, 2 s, 3 s per attempt, then a 30 s cycle gap. A comment
    /// that shortens it to the spec's "three waits of one second" shorthand is how
    /// this file drifted from its own code: the reader who trusts the comment tunes
    /// the wrong thing. REVERSE: put the shorthand back in any comment line here.
    func testNoCommentShorthandsTheReconnectSchedule() throws {
        let source = try probeSource()
        let shorthands = ["1s×3", "1 s×3", "1s x 3", "1s*3"]
        for line in swiftCommentLines(source) {
            for shorthand in shorthands {
                XCTAssertFalse(
                    line.contains(shorthand),
                    "注释把重连退避缩成了 \(shorthand)：真实的日程是 1 s、2 s、3 s 递增，然后 30 s 一周期间隔"
                )
            }
        }
        // …and the comment that documents the cycle gap has to say what escalates.
        let cycleComment = swiftCommentLines(source).joined(separator: "\n")
        XCTAssertTrue(cycleComment.contains("1 s, 2 s, 3 s"), "没有任何注释写出真实日程")
    }

    /// The other half of the same fix: correcting the comment must not have moved
    /// the behaviour the suite defends. REVERSE: change the multiplier in
    /// `attemptBackoffMs` (e.g. back to a flat `reconnectIntervalMs`) and the
    /// escalating numbers below stop being what they are.
    func testTheReconnectScheduleStillEscalates() throws {
        XCTAssertEqual(ProbeRuntime.attemptBackoffMs(afterFailedAttempt: 0), 1_000)
        XCTAssertEqual(ProbeRuntime.attemptBackoffMs(afterFailedAttempt: 1), 2_000)
        XCTAssertEqual(ProbeRuntime.attemptBackoffMs(afterFailedAttempt: 2), 3_000)
        XCTAssertEqual(ProbeRuntime.attemptBackoffMs(afterFailedAttempt: -1), 1_000, "负下标不许排出一个零秒或负秒的睡眠")
        XCTAssertEqual(ProbeRuntime.reconnectAttempts, 3, "每周期三次尝试是 §2.1 绑住的那一半")
        XCTAssertEqual(ProbeRuntime.reconnectCycleIntervalMs, 30_000)
    }

    // MARK: Findings 1 and 3 — the packaging script the shipped bundles come out of

    /// `LSMinimumSystemVersion` is the floor LaunchServices *enforces* at open time,
    /// so a bundle declaring 13.0 lets a Ventura machine run the daemon and take the
    /// macOS-13 `SCStream` path B — the channel this repository's own CHANGELOG
    /// records as never measured on 13 ("macOS 13 上的真值仍属待真机复跑"), which
    /// voids every "measured on 14+" claim with no refusal. REVERSE MUTATION: put
    /// `13.0` back (as a literal, in either place) and the floor-vs-claim check
    /// below stops holding.
    func testTheShippedBundleFloorIsTheDocumentedProductFloor() throws {
        let script = try read("engine/scripts/make-app.sh")
        let code = shellCode(script)

        let assignments = code.components(separatedBy: "\n").filter {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix("MACOS_MIN_VERSION=")
        }
        XCTAssertEqual(assignments.count, 1, "地板又变成多处各写一份：\(assignments)")
        let assignment = try XCTUnwrap(assignments.first)
        let quoted = assignment.components(separatedBy: "\"")
        XCTAssertEqual(
            quoted.count, 3,
            "MACOS_MIN_VERSION 的赋值不是一个双引号字面量，地板读不出来：\(assignment)"
        )
        let declared = quoted[1]
        XCTAssertEqual(declared, "14.0", "bundle 声明的地板不再是文档说的那一档")

        // Against the claim, not against a number invented here.
        let readme = try read("README.md")
        guard let claimed = documentedFloorMajor(in: readme) else {
            XCTFail("README.md 里找不到 \"macOS <n>+\" 那一条前置条件：地板与宣称无从对照")
            return
        }
        let floorMajor = Int(try XCTUnwrap(declared.split(separator: ".").first)) ?? 0
        XCTAssertEqual(
            floorMajor, claimed,
            "声明的地板 \(declared) 与文档宣称的 macOS \(claimed)+ 不是同一档——低的那一半就是没人拒绝的未测路径"
        )
        XCTAssertFalse(code.contains("<string>13.0</string>"), "还有一处 13.0 字面量在给 bundle 声明地板")
    }

    /// One declaration, rendered by both bundles: the key appears once, its value is
    /// the variable, and the one `make_bundle` that writes it is called for both.
    /// REVERSE: inline the literal into the heredoc (the shape that let the two
    /// shipped bundles drift from the docs in the first place) and the value check
    /// goes red.
    func testTheFloorIsDeclaredInOnePlaceThatBothBundlesRender() throws {
        let script = try read("engine/scripts/make-app.sh")
        let lines = shellCode(script).components(separatedBy: "\n")
        let keyLines = lines.enumerated().filter { $0.element.contains("LSMinimumSystemVersion") }
        XCTAssertEqual(keyLines.count, 1, "最低系统版本键出现了 \(keyLines.count) 次：一处声明的要求落空了")

        let index = try XCTUnwrap(keyLines.first?.offset)
        var valueLine = ""
        for candidate in lines[(index + 1)...] {
            let trimmed = candidate.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            valueLine = trimmed
            break
        }
        XCTAssertEqual(
            valueLine, "<string>$MACOS_MIN_VERSION</string>",
            "最低系统版本没有从唯一那一份声明渲染，bundle 之间可以各说各话"
        )

        let folded = script.replacingOccurrences(of: "\\\n", with: " ")
        let built = folded.components(separatedBy: "\n").filter {
            $0.contains("make_bundle ") && !$0.trimmingCharacters(in: .whitespaces).hasPrefix("#")
        }
        XCTAssertGreaterThanOrEqual(built.count, 2, "两个 bundle 都该由这一个 make_bundle 渲染：\(built)")
        XCTAssertTrue(folded.contains("GlassPane.app"), "设置面板那个 bundle 不再由这份脚本组装")
        XCTAssertTrue(folded.contains("GlassPane Daemon.app"), "daemon 那个 bundle 不再由这份脚本组装")
    }

    /// `installer/cli.js` runs this script with `/bin/bash`;
    /// `updater/lib/apply.js` runs it with `/bin/sh`. On a runner whose `/bin/sh`
    /// is dash, the bash-only `set -euo pipefail` kills the staged build at the
    /// preamble (`set: Illegal option -o pipefail`, measured here through
    /// `/bin/dash`: exit 2) and the daily update re-refuses forever as
    /// `staged-build-failed`. REVERSE: put `set -euo pipefail` back and keep the
    /// bash shebang — both go red. (The script has no pipelines, so nothing was
    /// bought by that option: measured 2026-10-22, the only `|` characters in the
    /// file are two logical-ORs.)
    func testThePackagingScriptRunsUnderTheInterpretersItsTwoCallersUse() throws {
        let script = try read("engine/scripts/make-app.sh")
        let firstLine = script.components(separatedBy: "\n").first ?? ""
        XCTAssertEqual(
            firstLine, "#!/bin/sh",
            "shebang 声明的解释器与更新器实际用的那个不一致——读脚本的人会挑错的那一个"
        )

        let code = shellCode(script)
        XCTAssertFalse(code.contains("pipefail"), "preamble 还在要 bash 专有的那个 set 选项：/bin/sh 不是 bash 的 runner 上这一份直接死")
        XCTAssertFalse(code.contains("set -euo"), "set -euo 是 bash 写法")
        XCTAssertTrue(code.contains("set -eu"), "POSIX 的 -eu 被顺手删了：那两条是真在防错")

        for bashism in ["[[", "set -o ", "<<<", "${!"] as [String] {
            XCTAssertFalse(code.contains(bashism), "又一个 bash 专有形状回到了两个 shell 都要跑的脚本里：\(bashism)")
        }
    }

    // MARK: Fixtures

    private func sandboxDirectory(_ name: String) throws -> String {
        let path = NSTemporaryDirectory() + "gp-probe-\(name)-\(ProcessInfo.processInfo.processIdentifier)"
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path)
        return path
    }

    /// Sets one process variable and puts back exactly what was there before —
    /// including "it was not set at all", which `setenv` cannot express.
    private final class ProcessEnvironmentGuard {
        private let key: String
        private let previous: String?

        init(key: String, value: String?) {
            self.key = key
            self.previous = ProcessInfo.processInfo.environment[key]
            if let value {
                setenv(key, value, 1)
            } else {
                unsetenv(key)
            }
        }

        func restore() {
            if let previous {
                setenv(key, previous, 1)
            } else {
                unsetenv(key)
            }
        }
    }

    private func makeListener(path: String) -> Int32 {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return -1 }
        unlink(path)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        path.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { slot in
                _ = strncpy(slot.baseAddress!.assumingMemoryBound(to: CChar.self), source, slot.count)
            }
        }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { name in
                Darwin.bind(descriptor, name, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(descriptor, 4) == 0 else {
            close(descriptor)
            return -1
        }
        return descriptor
    }

    private func acceptConnection(_ listenFD: Int32, within seconds: Double) -> Int32 {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            var slot = pollfd(fd: listenFD, events: Int16(POLLIN), revents: 0)
            if poll(&slot, 1, 100) > 0 { return accept(listenFD, nil, nil) }
        }
        return -1
    }
}

/// Reads the probe's NDJSON off a socket, buffering a torn tail the way the
/// daemon's FrameCodec does.
private final class FrameReader {
    private let fd: Int32
    private var pending = Data()

    init(_ fd: Int32) { self.fd = fd }

    func nextJSON(_ seconds: Double = 5) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(seconds)
        while true {
            if let newline = pending.firstIndex(of: UInt8(ascii: "\n")) {
                let line = Data(pending[pending.startIndex..<newline])
                pending.removeSubrange(pending.startIndex...newline)
                let object = try JSONSerialization.jsonObject(with: line)
                return try XCTUnwrap(object as? [String: Any], "frame is not a JSON object: \(String(decoding: line, as: UTF8.self))")
            }
            guard Date() < deadline else {
                throw NSError(domain: "FrameReader", code: 1, userInfo: [NSLocalizedDescriptionKey: "no frame before the deadline"])
            }
            var slot = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&slot, 1, 100) > 0 else { continue }
            var buffer = [UInt8](repeating: 0, count: 4096)
            let received = read(fd, &buffer, buffer.count)
            guard received > 0 else {
                throw NSError(
                    domain: "FrameReader", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "对端在凑满一帧之前关了这条 socket"]
                )
            }
            pending.append(contentsOf: buffer[0..<received])
        }
    }
}
