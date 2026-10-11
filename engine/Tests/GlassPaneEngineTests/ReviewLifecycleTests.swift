import XCTest
@testable import GlassPaneEngine

/// 复审（daily 2026-10-09）落在 daemon 生命周期上的三条，都在这里钉住。
///
///   * **X-24（P0）名字的接管**：`DaemonProbe` 的 `.noListener` 说的只是"这个名字
///     后面没有监听者"。普通文件对 `connect()` 回的正是 ECONNREFUSED/ENOTSOCK，
///     也就是那条分类**接受**的形态，于是 `glasspaned --socket-path <私钥路径>`
///     会先 `unlink` 私钥、再在原地 bind 一个 socket，关停收尾又删一次。而
///     `installer/cli.js` 把调用方给的 `--socket-path` 原样写进 launchd plist，这条
///     路在生产上是可达的。现在的规则是：每一个"我们即将接管"的 unlink 之前必须
///     `lstat` 并要求 `S_ISSOCK`；普通文件/目录/符号链接一律致命拒绝，报出路径与
///     它到底是什么，且永不删除。`DaemonProbe.takeoverDecision` 本身一个字没改——
///     收紧发生在动手删的那一刻，而不是发生在"有没有人听"的判定里。
///   * **X-22 的兄弟（P1）具名 socket 的路径形态**：`--state-dir` 早就要求绝对路径，
///     `--socket-path`/`--probe-socket-path` 却没有；而监听者会把 socket 的**父目录**
///     收成 0700，所以相对值的 chmod 落在当前工作目录上，bind 失败退出后还留着。
///     判据现在在解析期做完，任何目录都还没碰。
///   * **X-25（P1 安全）探针监听者的目录隔离**：`ProbeSocketServer` 从前只有
///     `createDirectory(attributes:)`——对**已存在**的目录那是 no-op：不 chmod、不查
///     属主、不读回模式、不拒绝。于是别人属有的或 0755 的目录可以长期托管 `probe.sock`：
///     他 unlink 那个名字再自己 bind 上，被测应用的探针流就进他手里，而 daemon 一直报
///     "no probe attached"，归因与 checkpoint 回滚静默失效。现在跑的是 `SocketServer`
///     那一份规则（复用 helper，不是把函数体抄一遍）。
///
/// 已知**未修**（report-only，交给编排方记录）：`SocketServer.run()` 先 bind（文件当场
/// 出现）再回调 `onBound`（`main.swift` 在那里才把名字登记给关停线程），这段窗口里到达
/// 的 SIGTERM 会 exit(0) 并把 `daemon.sock` 留在盘上。两种修法都要动信号/setup 的次序
/// （提前登记会让抢名失败的一方去 unlink 现任的 socket，正是 A-18 消灭的形状；把回调挪
/// 进 `bindAndListen()` 就是重排本次约束不许动的步骤），所以这里**没有**对应测试——
/// 不要把这条读成"已覆盖"。
final class ReviewLifecycleTests: XCTestCase {

    // MARK: - Fixtures

    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        return url.path
    }

    /// A fresh directory for one case, at a requested mode (0755 unless the case
    /// needs another). Created by the fixture rather than left absent, because the
    /// premise these cases share is "the directory was already there when the
    /// daemon got here" — `createDirectory(attributes:)` is a no-op for exactly
    /// that shape, which is what X-25 was missing. The mode is applied here,
    /// before any immutable flag is set: with `uchg` on the directory even the
    /// *fixture's* chmod would answer EPERM, and the case would then be asserting
    /// a mode it never installed.
    private func socketDirectory(_ tag: String, mode: mode_t = 0o755) throws -> String {
        let path = TestSandbox.pendingDirectory(tag)
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        XCTAssertEqual(chmod(path, mode), 0, "夹具目录的 chmod 必须成功，否则测到的模式不是夹具装上的")
        XCTAssertEqual(posixMode(of: path), Int(mode), "夹具目录的前置模式")
        return path
    }

    /// `sockaddr_un.sun_path` is 104 bytes, so the bound name has to stay short —
    /// asserted rather than assumed, or an over-long path reads as a defect in
    /// the guard under test instead of in the fixture.
    private func socketName(in directory: String, _ leaf: String = "daemon.sock") -> String {
        let path = directory + "/" + leaf
        XCTAssertLessThan(path.utf8.count, 104, "socket path exceeds sun_path: \(path)")
        return path
    }

    private func makeServer(at path: String, preempts: Bool = false) -> SocketServer {
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard), settle: {})
        // `run()` serves `while !shutdownRequested { accept() }`. Requesting the
        // shutdown *before* the call is what keeps these cases from hanging: with
        // the guard removed the bind succeeds, the accept loop blocks forever, and
        // "the lstat check was deleted" would read as a stuck test rather than a
        // failure. Asked to shut down first, `run()` still performs the whole bind
        // path (takeover judgement included), skips the loop and unwinds — which is
        // exactly the part under test.
        _ = core.shutdown()
        return SocketServer(
            socketPath: path,
            dispatcher: Dispatcher(core: core, log: EngineLog(quiet: true)),
            log: EngineLog(quiet: true),
            preemptsExistingSocket: preempts
        )
    }

    private func makeProbeServer(at path: String, preempts: Bool = false) -> ProbeSocketServer {
        // No `livenessProbe:` injected on purpose: the classification under review
        // is what a *regular file* answers with, so the real `DaemonProbe` has to
        // be the one that measures it.
        ProbeSocketServer(
            socketPath: path,
            inbox: ProbeInbox(),
            log: EngineLog(quiet: true),
            preemptsExistingSocket: preempts
        )
    }

    @discardableResult
    private func plant(_ path: String, _ contents: String) -> String {
        FileManager.default.createFile(atPath: path, contents: Data(contents.utf8))
        return contents
    }

    private func contents(of path: String) -> String? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private func posixMode(of path: String) -> Int {
        let attributes = (try? FileManager.default.attributesOfItem(atPath: path)) ?? [:]
        return ((attributes[.posixPermissions] as? NSNumber)?.int16Value).map(Int.init) ?? -1
    }

    private func fileType(of path: String) -> FileAttributeType? {
        let attributes = (try? FileManager.default.attributesOfItem(atPath: path)) ?? [:]
        return attributes[.type] as? FileAttributeType
    }

    /// A bound-then-closed listener: the inode stays behind as a **stale socket**
    /// (no unlink), which is the legitimate half of the takeover rule — a name
    /// like this is what a starting daemon is still allowed to clear.
    private func makeStaleSocketFile(at path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let copied = path.withCString { source -> Bool in
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                guard let base = destination.baseAddress else { return false }
                _ = strncpy(base.assumingMemoryBound(to: CChar.self), source, destination.count)
                return true
            }
        }
        guard copied else { close(fd); return false }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                Darwin.bind(fd, rebound, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(fd, 4) == 0 else { close(fd); unlink(path); return false }
        // Closing without unlinking is what leaves a real stale socket on disk; a
        // connect to it answers ECONNREFUSED, i.e. `.noListener` for a name that
        // genuinely **is** a socket.
        close(fd)
        return true
    }

    /// The refusal shape X-24 owes the operator: which path, and what it is.
    /// `String(describing:)`, not `localizedDescription`: this enum is
    /// `CustomStringConvertible`, and the NSError bridge would replace the whole
    /// sentence with "The operation couldn't be completed."
    ///
    /// 载荷是 `nameOccupied(一句话)`（上游实现）而不是一个带 kind 的独立 case，所以这里
    /// 断言的是那句话里**必须同时出现**路径与测到的 inode 类别——少一样，这条拒绝就退回成
    /// "名字被占了"，而读者真正需要知道的是"这是一份不属于你的普通文件，daemon 没删它"。
    private func assertNotASocketRefusal(
        _ error: Error?,
        path expectedPath: String,
        kind expectedKind: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let error else {
            return XCTFail("必须致命拒绝而不是 unlink+bind", file: file, line: line)
        }
        // 两个监听者各有各的错误类型，同一条判据走的是同一份 `nonSocketNameDescription`，
        // 所以这里按类型各取一次载荷——写成只认 engine 那份，探针侧那条对照就会把
        // "确实拒绝了"读成"报错了但形状不对"。
        let detail: String
        switch error {
        case SocketErrorResponse.nameOccupied(let engineDetail):
            detail = engineDetail
        case ProbeServerError.nameOccupied(let probeDetail):
            detail = probeDetail
        default:
            return XCTFail(
                "必须报 nameOccupied（普通文件/目录/符号链接都不许被删），实得 \(error)",
                file: file, line: line)
        }
        XCTAssertTrue(detail.contains(expectedPath), "拒绝理由要点名那个路径：\(detail)",
                      file: file, line: line)
        XCTAssertTrue(detail.contains(expectedKind), "拒绝理由要说清测到的到底是什么：\(detail)",
                      file: file, line: line)
        XCTAssertTrue(detail.contains("not a socket"),
                      "要说的是「这不是 socket」，不是笼统的「名字被占」：\(detail)",
                      file: file, line: line)
        let message = String(describing: error)
        XCTAssertTrue(message.contains(expectedPath), "运维看到的一句话里必须有路径：\(message)",
                      file: file, line: line)
        XCTAssertTrue(message.contains(expectedKind), "运维看到的一句话里必须说明那是什么：\(message)",
                      file: file, line: line)
    }

    private func captureThrow(_ body: () throws -> Void) -> Error? {
        do {
            try body()
            return nil
        } catch {
            return error
        }
    }

    // MARK: - X-24: the engine listener never deletes a non-socket name

    func testEngineRefusesToReplaceARegularFileAtItsSocketNameAndKeepsItsBytes() throws {
        let directory = try socketDirectory("x24file")
        let path = socketName(in: directory)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        // The premise from the report: a private key where a caller pointed
        // `--socket-path`. Losing this file is not a degraded run — it is an
        // unsolicited deletion inside the user's home.
        let secret = plant(path, "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n")
        let refusal = captureThrow { try self.makeServer(at: path).run() }
        assertNotASocketRefusal(refusal, path: path, kind: "a regular file")
        XCTAssertEqual(contents(of: path), secret,
                       "拒绝不许吃掉字节。移除 lstat 判定后这一条必红：文件已被 unlink，原地换成 socket")
        XCTAssertTrue(fileType(of: path) == .typeRegular, "名字处必须还是那个普通文件")
    }

    func testEngineRefusesToTakeOverASymlinkedSocketNameAndKeepsBothEnds() throws {
        let directory = try socketDirectory("x24link")
        let target = directory + "/target"
        let path = socketName(in: directory)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let written = plant(target, "not-a-socket-either")
        try FileManager.default.createSymbolicLink(atPath: path, withDestinationPath: target)
        let refusal = captureThrow { try self.makeServer(at: path).run() }
        assertNotASocketRefusal(refusal, path: path, kind: "a symlink")
        XCTAssertTrue(fileType(of: path) == .typeSymbolicLink,
                      "链接本身不许被 unlink：判定用 lstat，跟随链接去删对端就不是清残留")
        XCTAssertEqual(contents(of: target), written, "链接指向的文件更不许被删")
    }

    func testEngineRefusesToTakeOverADirectoryAtItsSocketName() throws {
        let directory = try socketDirectory("x24dir")
        let path = socketName(in: directory)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: false)
        let refusal = captureThrow { try self.makeServer(at: path).run() }
        assertNotASocketRefusal(refusal, path: path, kind: "a directory")
        XCTAssertTrue(fileType(of: path) == .typeDirectory, "拒绝之后目录还在")
    }

    func testForceSocketFlagGrantsNoPermissionToDeleteARegularFile() throws {
        // `--force-socket` is intent to displace a *listener*, not intent to
        // delete whatever happens to live here: the guard sits in front of the
        // force unlink too, not only in front of the stale-name retry.
        let directory = try socketDirectory("x24force")
        let path = socketName(in: directory)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let written = plant(path, "precious")
        let refusal = captureThrow { try self.makeServer(at: path, preempts: true).run() }
        assertNotASocketRefusal(refusal, path: path, kind: "a regular file")
        XCTAssertEqual(contents(of: path), written, "force 路径同样不得吃掉字节")
    }

    func testProbeListenerRefusesToReplaceARegularFileAtItsName() throws {
        let directory = try socketDirectory("x24probe")
        let path = socketName(in: directory, "probe.sock")
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let written = plant(path, "someone-elses-file")
        let refusal = captureThrow { try self.makeProbeServer(at: path).start() }
        assertNotASocketRefusal(refusal, path: path, kind: "a regular file")
        XCTAssertEqual(contents(of: path), written, "探针监听者也不能把普通文件当残留清掉")
    }

    func testProbeForceFlagGrantsNoPermissionToDeleteARegularFile() throws {
        let directory = try socketDirectory("x24probeforce")
        let path = socketName(in: directory, "probe.sock")
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let written = plant(path, "still-not-a-socket")
        let refusal = captureThrow { try self.makeProbeServer(at: path, preempts: true).start() }
        assertNotASocketRefusal(refusal, path: path, kind: "a regular file")
        XCTAssertEqual(contents(of: path), written, "--force-probe-socket 是抢占监听者的授权，不是删文件的授权")
    }

    // MARK: - X-24 positive controls: a real stale socket is still takeover-able

    func testEngineStillClearsAStaleSocketItMeasuredAsASocket() throws {
        // The other half of A-18 has to keep working: tightening the rule may not
        // turn "no listener behind a leftover socket inode" into a refusal, or a
        // crashed daemon's name becomes permanently unusable.
        let directory = try socketDirectory("x24stale")
        let path = socketName(in: directory)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        guard makeStaleSocketFile(at: path) else {
            throw XCTSkip("夹具造不出残留 socket（bind/listen 在本机失败）")
        }
        XCTAssertTrue(fileType(of: path) == .typeSocket, "前置条件：名字处确实是一个 socket 文件")
        XCTAssertNoThrow(try self.makeServer(at: path).run(),
                         "无主的真 socket 残留照旧应当被接管")
    }

    func testProbeStillClearsAStaleSocketItMeasuredAsASocket() throws {
        let directory = try socketDirectory("x24probestale")
        let path = socketName(in: directory, "probe.sock")
        defer { try? FileManager.default.removeItem(atPath: directory) }
        guard makeStaleSocketFile(at: path) else {
            throw XCTSkip("夹具造不出残留 socket（bind/listen 在本机失败）")
        }
        let server = makeProbeServer(at: path)
        XCTAssertNoThrow(try server.start(), "探针侧同一判据：确实是无主 socket 就可以清")
        server.stop()
    }

    // MARK: - X-22 sibling: named sockets have to be absolute

    func testRelativeSocketPathIsRefusedByTheSameRuleThatRefusesARelativeStateDir() {
        for relative in ["./s.sock", "s.sock", "../up.sock", ""] {
            XCTAssertNotNil(StateRootArgument.rejection(for: relative),
                            "相对路径 \(relative) 必须在解析期就被拒绝")
        }
        XCTAssertNotNil(StateRootArgument.rejection(for: nil), "开关后面什么都没有也要拒绝")
        XCTAssertNotNil(StateRootArgument.rejection(for: "--force-socket"),
                        "把另一个开关当成路径同样要拒绝")
        XCTAssertNil(StateRootArgument.rejection(for: "/abs/dir/s.sock"), "绝对路径放行")
        if let reason = StateRootArgument.rejection(for: "./s.sock") {
            XCTAssertTrue(reason.contains("absolute"), "拒绝理由说的是绝对路径，实得：\(reason)")
        }
        // `main.swift` reaches this rule set through two accessors: the socket
        // flags use `rejection(for:)`, `--state-dir` switches on `init(raw:)`.
        // One rule set behind two spellings is only true while the two agree, so
        // the equality is measured per sample — a diverging pair would let
        // `--socket-path ./s.sock` pass while `--state-dir ./s` is refused.
        for probe in [nil, "", "./s.sock", "../up.sock", "--force-socket", "/abs/dir/s.sock"] {
            let direct = StateRootArgument.rejection(for: probe)
            let viaInit: StateRootArgument = StateRootArgument(raw: probe)
            switch (direct, viaInit) {
            case (.none, .named):
                break
            case (.some(let reason), .rejected(let sameReason)):
                XCTAssertEqual(reason, sameReason,
                               "同一判据的两个入口给出了两条理由：\(String(describing: probe))")
            default:
                XCTFail("两个入口对 \(String(describing: probe)) 一个放行一个拒绝：\(String(describing: direct)) / \(String(describing: viaInit))")
            }
        }
    }

    /// The other half of the proof: the daemon actually calls that rule, at the
    /// parse, **before** anything resolves a path or touches a directory. A rule
    /// that only exists in the engine library is a rule nothing reaches.
    func testDaemonParserRefusesRelativeSocketPathsBeforeTouchingAnyDirectory() throws {
        let source = try readMain()
        for flag in ["--socket-path", "--probe-socket-path"] {
            let block = try XCTUnwrap(
                caseBlock(for: flag, in: source),
                "解析表里找不到 \(flag) 的 case 块，这条对照已经看不见东西")
            XCTAssertTrue(block.contains("StateRootArgument.rejection"),
                          "\(flag) 必须在解析期就按绝对路径判据过一遍：监听者会把 socket 的父目录收成 0700，相对值 chmod 的是当前工作目录")
        }
        // 等号形态与空格形态共用一份判据，两种拼写不能对同一个值给两个答案。
        guard let equalsStart = source.range(of: "hasPrefix(\"--socket-path=\")")?.lowerBound,
              let equalsEnd = source.range(of: "hasPrefix(\"--state-dir=\")",
                                           range: equalsStart..<source.endIndex)?.lowerBound else {
            return XCTFail("找不到 --socket-path= 的等号分支，这条对照看不见它")
        }
        XCTAssertTrue(source[equalsStart..<equalsEnd].contains("StateRootArgument.rejection"),
                      "等号形态绕开判据，就等于同一 flag 有两种拼写两套答案")
        // 三个 flag 只有一份判据：`--state-dir` 那一段也必须落在同一个类型上。
        let stateDirBlock = try XCTUnwrap(caseBlock(for: "--state-dir", in: source),
                                          "解析表里找不到 --state-dir 的 case 块")
        XCTAssertTrue(stateDirBlock.contains("StateRootArgument"),
                      "状态根换了判据类型，socket 路径的\"同源\"这句就没人保证了")
        // 顺序：第一次绝对路径判定必须早于状态根解析——那之后的第一步就是动目录。
        let firstRejection = source.range(of: "StateRootArgument.rejection")?.lowerBound ?? source.endIndex
        let resolvesPath = source.range(of: "StateRoot.engineSocketPath(")?.lowerBound ?? source.endIndex
        XCTAssertTrue(firstRejection < resolvesPath,
                      "绝对路径判据必须跑在解析出 socket 路径之前，否则先动的就是目录")
    }

    /// Behavioural half against the built binary: the documented usage error, and
    /// nothing created or chmod'ed. Skips out loud when the debug product is
    /// absent (same idiom as `DaemonVersionFlagTests`).
    func testDaemonBinaryRefusesRelativeSocketPathWithoutCreatingOrChmoddingAnything() throws {
        let binary = repoRoot + "/engine/.build/debug/glasspaned"
        guard FileManager.default.isExecutableFile(atPath: binary) else {
            throw XCTSkip("没有 \(binary)；这一条要的是真 argv 处理（produce it with: cd engine && swift build）。"
                + "判据本体与调用位点已由上面两条在无产物环境下钉住。")
        }
        let working = try socketDirectory("relcwd")
        let state = TestSandbox.pendingDirectory("relstate")
        defer {
            try? FileManager.default.removeItem(atPath: working)
            // Only a run that failed to refuse would have created this one; the
            // cleanup has to cover it either way, or a revert leaves residue.
            try? FileManager.default.removeItem(atPath: state)
        }
        let modeBefore = posixMode(of: working)
        let outcome = try spawnDaemon(
            binary: binary,
            arguments: ["--state-dir", state, "--socket-path", "./s.sock", "--no-probe"],
            workingDirectory: working
        )
        XCTAssertFalse(outcome.served,
                       "这一次调用没有拒绝：daemon 绑上并开始服务了（\(outcome.text)）")
        XCTAssertEqual(outcome.status, 64,
                       "相对 socket 路径是 usage error（与坏 --state-dir 同一退出码）：\(outcome.text)")
        XCTAssertTrue(outcome.text.contains("--socket-path"), "拒绝要点名这个 flag：\(outcome.text)")
        XCTAssertTrue(outcome.text.lowercased().contains("absolute"),
                      "拒绝理由要说绝对路径，而不是只回一句 usage error：\(outcome.text)")
        XCTAssertEqual(posixMode(of: working), modeBefore,
                       "一次失败的启动不许改掉当前工作目录的模式")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: working), [],
                       "拒绝之后工作目录里既不该有 socket，也不该多出别的文件")
        XCTAssertFalse(FileManager.default.fileExists(atPath: state),
                       "解析期就拒绝的这一次调用连状态根都不该创建")
    }

    /// The pre-bind statement has to agree with what the run is about to do.
    /// Before the `lstat` split, a daemon aimed at somebody's regular file logged
    /// "nothing listens … — binding it" and *then* refused: two contradictory
    /// promises from one process, the second one about a file it must not touch.
    /// Pinned against the built binary — the refusal wording, the absence of the
    /// promise, and the file's bytes.
    func testDaemonBinaryAnnouncesRefusalNotBindingWhenItsNameIsARegularFile() throws {
        let binary = repoRoot + "/engine/.build/debug/glasspaned"
        guard FileManager.default.isExecutableFile(atPath: binary) else {
            throw XCTSkip("没有 \(binary)；这一条要的是真启动（produce it with: cd engine && swift build）。")
        }
        let state = TestSandbox.pendingDirectory("takeoverfile")
        let socketName = state + "/engine.sock"
        let secret = Data("not a socket".utf8)
        try FileManager.default.createDirectory(atPath: state, withIntermediateDirectories: true)
        try secret.write(to: URL(fileURLWithPath: socketName))
        defer { try? FileManager.default.removeItem(atPath: state) }
        let outcome = try spawnDaemon(
            binary: binary,
            arguments: ["--state-dir", state, "--socket-path", socketName, "--no-probe"],
            workingDirectory: state
        )
        XCTAssertFalse(outcome.served,
                       "普通文件占着 socket 名，这一次启动不许把自己当成服务：\(outcome.text)")
        XCTAssertTrue(outcome.text.contains("not a socket"),
                      "拒绝要说出测到的 inode 类别：\(outcome.text)")
        XCTAssertFalse(outcome.text.contains("binding it"),
                       "同一次运行既宣布拒绝又宣布要绑，等于对着别人的文件许诺：\(outcome.text)")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: socketName)), secret,
                       "被拒之后那个文件必须一个字节都没动")
    }

    // MARK: - X-25: the probe listener runs the engine socket's directory rules

    /// A directory this account cannot bring to 0700 (the immutable flag makes
    /// `chmod` answer EPERM even for the owner, so this is reachable without a
    /// second account) must be a refusal naming the path **and** the mode actually
    /// measured — and it must bind nothing.
    func testProbeBindRefusesADirectoryItCannotBringTo0700AndNamesTheMeasuredMode() throws {
        let directory = try socketDirectory("x25locked", mode: 0o755)
        guard chflags(directory, UInt32(UF_IMMUTABLE)) == 0 else {
            throw XCTSkip("这台机器上造不出 chmod 不成功的目录（chflags 被拒）；同一条判据的正面一半由收紧用例覆盖")
        }
        defer {
            _ = chflags(directory, 0)
            try? FileManager.default.removeItem(atPath: directory)
        }
        let probeSocket = socketName(in: directory, "probe.sock")
        // Precondition, so the case cannot pass on a fixture that did nothing:
        // the chmod the enforcement needs has to be the one that fails here.
        XCTAssertEqual(chmod(directory, 0o700), -1, "夹具必须让 chmod(0700) 失败，否则这条测的是别的东西")
        XCTAssertEqual(posixMode(of: directory), 0o755, "夹具测到的模式应当仍是 0755")
        let refusal = captureThrow { try self.makeProbeServer(at: probeSocket).start() }
        let message = refusal.map { String(describing: $0) } ?? "(没有拒绝：探针在没有隔离的目录里绑上了)"
        XCTAssertNotNil(refusal, message)
        XCTAssertTrue(message.contains(directory), "拒绝理由要点名那个目录：\(message)")
        XCTAssertTrue(message.contains("0755"), "拒绝理由要带上实测到的模式：\(message)")
        XCTAssertFalse(FileManager.default.fileExists(atPath: probeSocket),
                       "拒绝之后名字处不该有 socket——绑上去就是把可劫持的目录当成探针出口")
    }

    /// The same rule on the engine listener, reached through the same helper: the
    /// probe did not get a copied body that can drift away from it.
    func testEngineBindRefusesTheSameUnprotectableDirectory() throws {
        // 0770: group **and** other writable, and this time untightenable — the
        // mode is installed before the flag, so the "0770" asserted below is a
        // measurement the fixture really made.
        let directory = try socketDirectory("x25lockedengine", mode: 0o770)
        guard chflags(directory, UInt32(UF_IMMUTABLE)) == 0 else {
            throw XCTSkip("同上：这台机器造不出 chmod 不成功的目录")
        }
        defer {
            _ = chflags(directory, 0)
            try? FileManager.default.removeItem(atPath: directory)
        }
        XCTAssertEqual(chmod(directory, 0o700), -1, "夹具必须让 chmod(0700) 失败")
        let refusal = captureThrow { try self.makeServer(at: socketName(in: directory)).run() }
        let message = refusal.map { String(describing: $0) } ?? "(没有拒绝：engine 侧不认这条目录判据)"
        XCTAssertNotNil(refusal, message)
        XCTAssertTrue(message.contains(directory), "拒绝理由要点名路径：\(message)")
        XCTAssertTrue(message.contains("0770"), "拒绝理由要带实测模式：\(message)")
    }

    /// A group-**writable** directory this account owns is not a refusal: it is a
    /// tighten-then-bind. Without this control the two cases above could be
    /// satisfied by a listener that simply never binds anywhere.
    func testProbeBindTightensAGroupWritableDirectoryItOwnsAndBinds() throws {
        let directory = try socketDirectory("x25tighten", mode: 0o770)
        let path = socketName(in: directory, "probe.sock")
        let server = makeProbeServer(at: path)
        defer {
            server.stop()
            try? FileManager.default.removeItem(atPath: directory)
        }
        XCTAssertNoThrow(try server.start(), "能收紧的目录不该拒绝，否则探针监听者会被这次修复顺手关掉")
        XCTAssertEqual(posixMode(of: directory), 0o700, "绑上之前那次 chmod 必须真的落地（X-25 的正面一半）")
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "名字归这个监听者")
        XCTAssertEqual(posixMode(of: path), 0o600, "探针 socket 的 0600 是硬不变量（P6 §2.1）")
    }

    // MARK: - Reading the daemon source, and the real binary

    private func readMain() throws -> String {
        let path = repoRoot + "/engine/Sources/glasspaned/main.swift"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 main.swift；这一条对照在没有该文件的环境里不作数")
        }
        return text
    }

    /// The `case "--flag":` block of `parseArguments`, up to the next `case` (or
    /// `default`) at the same indentation — enough to say "this site validates".
    private func caseBlock(for flag: String, in source: String) -> String? {
        guard let start = source.range(of: "case \"\(flag)\":") else { return nil }
        let tail = source[start.upperBound...]
        let nextSite = tail.range(of: "\n        case ") ?? tail.range(of: "\n        default:")
        let end = nextSite?.lowerBound ?? tail.endIndex
        return String(source[start.lowerBound..<end])
    }

    private struct DaemonOutcome {
        let status: Int32
        let text: String
        /// True when the process never refused and kept serving: that is a
        /// failure of the parser rule, and it is reported as one instead of
        /// waiting on a daemon that has no reason to exit.
        let served: Bool
    }

    private func spawnDaemon(binary: String, arguments: [String], workingDirectory: String) throws -> DaemonOutcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: workingDirectory)
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        var served = false
        let deadline = Date().addingTimeInterval(8)
        while process.isRunning, Date() < deadline {
            usleep(50_000)
        }
        if process.isRunning {
            served = true
            process.terminate()
            let stopped = Date().addingTimeInterval(4)
            while process.isRunning, Date() < stopped { usleep(50_000) }
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return DaemonOutcome(
            status: served ? -1 : process.terminationStatus,
            text: String(data: data, encoding: .utf8) ?? "",
            served: served
        )
    }
}
