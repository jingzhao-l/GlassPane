import XCTest
import Darwin
import GlassPaneEngine
@testable import glasspane_settings

/// Qoder lane 2026-10-19（分支 `qoder-20261019-panel`）——daemon CLI 与设置面板的诚实性闸。
///
/// 这一批钉的是同一个家族：**一句"成功了"背后必须有一次实测**。
///  · CLI 侧：编码发不出去时必须拒绝，而不是零输出 + 退出码 0；席位没批下来不许退 0；
///    同时要两条子命令不许只跑第一条。
///  · 面板侧：只许报它真的连上的那一个 daemon（隔离根上的 `daemon.sock`）；更新页
///    只许跟着 daemon 报的根走；在途的写入动作必须看得见；永远点不亮的指示器必须消失；
///    副标题只许说这一屏真显示的那份来源。
///
/// 每条都写明**什么改动会把它变红**；抓不住反向改动的断言等于没写。结构闸只认代码
/// （`PanelSourceText.strip` 先把注释剥掉）——把结论写在注释里不算有人读了它。
/// 唯一例外是 `testTheHeaderCommentDescribesThePersistenceThatExists`：那条缺陷本身就是
/// 一句注释，判据只能落在文字上。
///
/// 端到端那几条用真二进制、真 socket：一个只对某个输入应答的桩会替一条不存在的能力
/// 背书（`ConsoleDaemonStateRootTests`、`ReviewLifecycleTests` 的同一口径）。
///
/// 一条写在这里的平台事实，免得后来人把"编码失败"这一支读成端到端测过的东西：
/// macOS 上 `JSONSerialization` 对非法值是**抛 Objective-C 异常**（进程直接没），
/// 不是回一个 Swift error——实测 `Double.nan`、`Date`、`URL`、Swift struct 四种都这样。
/// 所以 `AgentText.jsonLine` 那句"编不出去回 nil"在这台平台上没法从外部驱动，
/// 收口点那条拒绝只能由源码形状 + "0 必有输出"的不变量两条一起管。

// MARK: - 共用夹具

/// daemon 真二进制（`swift build --package-path engine` 的产物）与一次性调用的结局。
enum QoderDaemonBinary {
    /// `engine/.build/debug/glasspaned`，由本文件位置推出（不吃进程工作目录）。
    static var path: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }   // → engine/
        return url.appendingPathComponent(".build/debug/glasspaned").path
    }

    struct Run {
        let status: Int32
        let stdout: String
        let stderr: String
        var text: String { stdout + stderr }
    }

    /// 跑一次性 CLI。状态类命令一律由调用方带上 `--state-dir`（不给的那一次动的就是
    /// 这台机器的 `~/.glasspane`）；权限类命令本来就不读状态，所以不需要。
    static func run(_ arguments: [String]) throws -> Run {
        guard FileManager.default.isExecutableFile(atPath: path) else {
            throw XCTSkip("没有 \(path)；这一条要的是真 argv 处理（swift build --package-path engine）")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        // 先读到 EOF 再等退出：子进程输出超过管道缓冲时，反过来的写法会互相死等。
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        process.waitUntilExit()
        return Run(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }
}

/// `glasspaned/main.swift` 的源码，剥掉注释后的文本（结构闸用）。
enum QoderMainSource {
    static var path: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // → 仓库根
        return url.appendingPathComponent("engine/Sources/glasspaned/main.swift").path
    }

    static func code() throws -> String {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(path)；这一条对照在没有该文件的环境里不作数")
        }
        return PanelSourceText.strip(text)
    }

    /// `[startMarker, endMarker)` 之间那一段。找不到边界时报失败而不是放过去：
    /// 一条看不见窗口的闸会在新代码形状出现时一路绿。
    static func block(from startMarker: String, to endMarker: String,
                      file: StaticString = #filePath, line: UInt = #line) throws -> String {
        let source = try code()
        guard let start = source.range(of: startMarker) else {
            XCTFail("源码里找不到 \(startMarker)：这一条已经看不见它要闸的东西", file: file, line: line)
            return ""
        }
        guard let end = source.range(of: endMarker, range: start.upperBound..<source.endIndex) else {
            XCTFail("源码里找不到 \(endMarker)：窗口没有右边界", file: file, line: line)
            return ""
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }
}

/// `setenv`/`unsetenv` 的成对使用：这些改动的是**本测试进程**的环境，而面板的解析器
/// 读的就是它，不成对恢复会漏给同一进程里后面的每一条测试。
private final class QoderEnvGuard: @unchecked Sendable {
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
        if let previous { setenv(key, previous, 1) } else { unsetenv(key) }
    }
}

/// 固定的假席位探针：构造面板模型时不碰真 TCC。
enum QoderFakeProbes {
    static func set() -> PermissionProbeSet {
        PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(trustCheck: { false }, prompt: {}, openPane: {}),
            inputMonitoring: InputMonitoringPermissionProbe(preflight: { false }, requestAccess: {}, openPane: {}),
            screenRecording: ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {}),
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            inputTapProbe: { false },
            subjectProvider: { PermissionSubject(binaryPath: "/opt/glasspane/panel-probe") }
        )
    }
}

enum QoderWait {
    /// 主 actor 上的等待：面板那一侧的结论是 `Task.detached` 跑完后落回 MainActor 的，
    /// 所以这里必须 `await` 让出线程，不能用 RunLoop 自旋把 actor 占住。
    @MainActor
    static func until(timeoutSeconds: Int = 20, _ condition: @MainActor () -> Bool) async {
        let iterations = max(1, timeoutSeconds * 20)
        for _ in 0..<iterations {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }
}

// MARK: - CLI：编码发不出去 / 席位没批 / 一次要两条命令

final class QoderPanel20261019DaemonCLITests: XCTestCase {

    // MARK: 缺陷 1：writeJSON 的收口点

    /// `writeJSON` 是全部机器可读出口唯一的收口点。它从前是
    /// `guard let line = AgentText.jsonLine(object) else { return }`——编不出去的那一次
    /// **一个字都不写**，调用方随后照样 `exit(0)`：同一份文件在 :1078-1081 里明令禁止的
    /// 形状（"调用方读到的是零输出 + 退出码 0"），而 `--list-projects`、`--recipe-validate`
    /// 两处已经各自补过拒绝，其余 ~27 个调用点没有。
    /// 反向变异：把收口点改回 `else { return }` → 四条断言同时红；只修几个调用点而把
    /// 拒绝留在调用方 → 红在"收口点自己不报 encodeFailed"那一句。
    func testWriteJSONChokePointRefusesAndTerminatesInsteadOfReturningSilently() throws {
        // 边界取代码而不是 `// MARK:`：窗口是按剥掉注释之后的文本切的。
        let body = try QoderMainSource.block(
            from: "private func writeJSON(",
            to: "private func runGrantAccessibilityFlow()"
        )
        XCTAssertFalse(body.contains("else { return }"),
            "收口点里还有一句 else { return }：编不出去＝零输出 + 上游退出码 0\n\(body)")
        XCTAssertTrue(body.contains("encodeFailed"),
            "收口点自己不报 encodeFailed，这条例外就还得靠 27 个调用点各自记得\n\(body)")
        XCTAssertTrue(body.contains("standardError"),
            "拒绝必须写在 stderr：stdout 那一头是留给答案的\n\(body)")
        XCTAssertTrue(body.contains("exit("),
            "收口点自己不许把控制权交回调用方去退 0：终止权必须留在这里\n\(body)")
    }

    /// 两处手写站点保持既有形状与用词（收口点接管其余站点之后，这两处不许被双打一遍：
    /// 它们的外层编码器是 `JSONEncoder`，与 `AgentText.jsonLine` 不是同一台）。
    /// 反向变异：把 `--list-projects` 的报文删掉让收口点代劳 → 红在 `entriesRead`/
    /// `registryPath` 那两句（那两个键只有这一处知道）。
    func testTheTwoHandWrittenEncodeRefusalsKeepTheirOwnKeys() throws {
        let list = try QoderMainSource.block(
            from: "if options.listProjects {",
            to: "if let activeId = options.activeProjectId {"
        )
        XCTAssertTrue(list.contains(#""encodeFailed": true"#), "--list-projects 的编码拒绝不见了")
        XCTAssertTrue(list.contains("entriesRead"), "--list-projects 那次拒绝丢了自己读到的条数")
        XCTAssertTrue(list.contains("registryPath"), "--list-projects 那次拒绝没点名是哪份表")

        let recipe = try QoderMainSource.block(
            from: "if let recipePath = options.recipeValidate {",
            to: "if options.approvalAudit || options.approvalVerify {"
        )
        XCTAssertTrue(recipe.contains(#""encodeFailed": true"#), "--recipe-validate 的编码拒绝不见了")
        XCTAssertTrue(recipe.contains(#""command": "--recipe-validate""#))
    }

    /// 端到端的不变量：**退出码 0 的那一次必须在 stdout 上留下一行读得懂的 JSON**。
    /// 这一条测的不是某一次失败注入（这些命令的 payload 都编得出去，见文件头那条平台
    /// 事实），它是那面墙：今天全过，收口点被改回静默、或新加一条命令漏写拒绝时就红。
    func testEveryJsonSubcommandThatAnswersZeroPrintsOneJsonLine() throws {
        let cases: [(String, [String], Bool)] = [
            ("--permissions", ["--permissions"], false),
            ("--list-projects", ["--list-projects"], false),
            ("--evidence-stats", ["--evidence-stats"], true),
            ("--prune-evidence", ["--prune-evidence", "--older-than", "1", "--dry-run"], true),
            ("--project-prune", ["--project-prune", "--dry-run"], false),
            ("--approval-verify", ["--approval-verify"], false),
            ("--active-project", ["--active-project", "prj_01M34567890123456789012A"], false),
        ]
        for (label, tail, makeArchive) in cases {
            let root = TestSandbox.pendingDirectory("jsoncmd")
            try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
            if makeArchive {
                try FileManager.default.createDirectory(
                    atPath: root + "/evidence", withIntermediateDirectories: true
                )
            }
            let run = try QoderDaemonBinary.run(["--state-dir", root] + tail)
            guard run.status == 0 else {
                // 非 0 的那一次同样必须有话说：拒绝是一种答案，但一句都不许是空的。
                XCTAssertFalse(
                    run.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    "\(label) 回了 \(run.status) 却一个字都没说"
                )
                continue
            }
            let line = run.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            XCTAssertFalse(line.isEmpty,
                           "\(label) 退出码 0 而 stdout 是空的：那正是被禁止的形状")
            guard let data = line.data(using: .utf8),
                  (try? JSONSerialization.jsonObject(with: data)) != nil else {
                return XCTFail("\(label) 退出码 0，stdout 却不是一份 JSON：\(line.prefix(120))")
            }
            XCTAssertEqual(line.split(separator: "\n", omittingEmptySubsequences: true).count, 1,
                           "\(label) 的机器可读出口必须是一行：\(line)")
        }
    }

    /// 库那一句契约的对照：正常 payload 确实编得出去（"拒绝"这一支不是因为编码器
    /// 什么都编不了才永远走不到）。NaN 那类非法值不能用——见文件头：那会抛
    /// Objective-C 异常把测试进程带走，不是回 nil。
    func testTheEncoderStillAnswersEveryPayloadTheCliActuallySends() {
        XCTAssertNotNil(AgentText.jsonLine(["command": "--x", "count": 0]))
        XCTAssertNotNil(AgentText.jsonLine(["command": "--x", "value": NSNull()]))
        XCTAssertNotNil(AgentText.jsonLine(["command": "--x", "nested": [["id": "a"]]]))
    }

    // MARK: 缺陷 4：--approval-audit 用的是另一台编码器

    /// `gate.auditJSON()` 回的是**已经编码好的 Data**（`JSONEncoder`，与 writeJSON 那台
    /// `JSONSerialization` 不是同一台），所以收口点管不到它。从前是
    /// `if let data = … { 写 }` 没有 else，随后 `exit(0)`。
    /// 反向变异：把 else 那一支删掉 → 三条断言红。
    func testApprovalAuditRefusesWhenItsOwnEncoderHandsBackNothing() throws {
        let block = try QoderMainSource.block(
            from: "if options.approvalAudit {",
            to: "if options.pruneEvidence || options.evidenceStats {"
        )
        XCTAssertTrue(block.contains("auditJSON()"), "这一条窗口已经看不见 --approval-audit")
        XCTAssertTrue(block.contains("encodeFailed"),
            "auditJSON 交不回数据时这一支还是零输出 + 退出码 0：\(block)")
        XCTAssertTrue(block.contains("standardError"),
            "拒绝要写在 stderr：stdout 那一头是给读 JSON 的人留的：\(block)")
        XCTAssertTrue(block.contains("exit(1)"),
            "--help 把 1 定义成\"被拒绝或只部分成功\"，这一支回的就是它：\(block)")
    }

    // MARK: 缺陷 5：--request-permission 的退出码

    /// 申请到的席位**不是 granted** 时这条命令不许退 0：脚本按 rc 分叉，
    /// `denied`/`unverifiable` 读成成功就是替一次没批下来的授权背书
    /// （同文件的 `--check-developer-tools` 早就按 `granted` 分叉）。
    /// `developer-tools` 按设计恒为 unverifiable（TCC 无公开查询接口），所以它是这台
    /// 机器上唯一与环境无关的"没批下来"样本，也不会弹任何系统面板。
    /// 反向变异：退出码改回无条件 `exit(0)` → 第一条红。
    func testRequestPermissionDoesNotAnswerSuccessWhenTheSeatIsNotGranted() throws {
        let run = try QoderDaemonBinary.run(["--request-permission", "developer-tools"])
        XCTAssertNotEqual(run.status, 0,
            "requestedStatus 不是 granted 的一次调用退了 0：任何按 rc 分叉的脚本都会把它读成批下来了\n"
            + "stdout=\(run.stdout.prefix(200)) stderr=\(run.stderr.prefix(200))")
        // 非 0 不等于没答：结论仍然完整交回 stdout。
        guard let data = run.stdout.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return XCTFail("拒绝的那一次也必须把 JSON 交回 stdout：\(run.stdout.prefix(200))")
        }
        XCTAssertEqual(payload["requested"] as? String, "developer-tools", "\(payload)")
        XCTAssertEqual(payload["requestedStatus"] as? String, "unverifiable",
                       "这一支测到的是 unverifiable，不是 granted：\(payload)")
    }

    /// 正面一半：**实测到 granted 的那一次必须退 0**，否则"非 0＝没批"这句成了假话。
    /// 只在二进制自己的席位真读成 granted 时才跑：没批下来时去申请会弹系统面板，
    /// 那是替测试改这台机器的授权表。
    func testRequestPermissionStillAnswersZeroForASeatThatReadsGranted() throws {
        let snapshot = try QoderDaemonBinary.run(["--permissions"])
        XCTAssertEqual(snapshot.status, 0, snapshot.text)
        guard let data = snapshot.stdout.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let permissions = object["permissions"] as? [String: Any],
              permissions["accessibility"] as? String == "granted" else {
            throw XCTSkip("这个二进制的辅助功能席位此刻没读成 granted；granted 这一支没有可测对象")
        }
        let run = try QoderDaemonBinary.run(["--request-permission", "accessibility"])
        XCTAssertEqual(run.status, 0,
            "席位实测为 granted 时这一条必须退 0：\(run.stdout.prefix(200)) \(run.stderr.prefix(200))")
        XCTAssertFalse(run.stdout.isEmpty, "退出码之外报文本身也要交回去：\(run.text)")
    }

    /// `--help` 必须说得出这条命令的退出码口径——说它做的事，不说它希望做的事
    /// （pending/unknown 同样不是 granted，所以那句话不能写成"申请失败才非 0"）。
    /// 反向变异：只改代码不改帮助文本 → 红在这里。
    func testUsageTextStatesWhatRequestPermissionReturnsOnItsExitCode() throws {
        let paragraph = try QoderMainSource.block(
            from: "--request-permission <kind>  Ask for",
            to: "--check-developer-tools"
        )
        XCTAssertTrue(paragraph.lowercased().contains("exit"),
            "帮助文本没交代这一条的退出码，而调用方正是按 rc 分叉的：\(paragraph)")
        XCTAssertTrue(paragraph.contains("nonzero"),
            "帮助文本仍然只说\"print the resulting JSON\"，没说自己无条件退 0 这件事：\(paragraph)")
        XCTAssertTrue(paragraph.contains("granted"),
            "那句话的判据是读没读到 granted：\(paragraph)")
        XCTAssertTrue(
            paragraph.contains("pending") || paragraph.contains("unverifiable") || paragraph.contains("notDetermined")
                || paragraph.contains("unanswered"),
            "帮助文本必须说清\"问了没答\"这一支也不算批：\(paragraph)"
        )
        XCTAssertFalse(paragraph.contains("exit 0"),
            "无条件 exit 0 的旧说法与代码不再一致：\(paragraph)")
    }

    // MARK: 缺陷 6：一次要两条子命令

    /// 子命令由一条 first-match 的 `if` 链分发：要两条时跑第一条、静默跳过其余、退 0。
    /// 真机在 HEAD 上实测过 `glasspaned --state-dir <tmp> --version --evidence-stats`
    /// 只回版本号退 0。
    /// 反向变异：只断退出码 → "跑了第一条再退 64"也能过，所以 stdout 那一半必须一起断。
    func testAskingForTwoSubcommandsIsRefusedBeforeEitherRuns() throws {
        let root = TestSandbox.pendingDirectory("twocmd")
        try FileManager.default.createDirectory(
            atPath: root + "/evidence", withIntermediateDirectories: true
        )
        let run = try QoderDaemonBinary.run(["--state-dir", root, "--version", "--evidence-stats"])
        XCTAssertEqual(run.status, 64,
            "两条子命令是一次用法错误（64），不是\"跑了第一条\"：\(run.text.prefix(300))")
        XCTAssertTrue(run.stderr.contains("--version"), "拒绝要点名第一条：\(run.stderr.prefix(300))")
        XCTAssertTrue(run.stderr.contains("--evidence-stats"), "拒绝要点名第二条：\(run.stderr.prefix(300))")
        // 只断退出码不够用："跑了第一条再退 64" 也能过。第一条的输出必须没有出现过——
        // 拿同一条命令单独跑的那一次当对照，不写死版本号（`--help` 那一段也在 stdout 上，
        // 所以不能用"stdout 有没有 glasspaned 字样"来判）。
        let version = try QoderDaemonBinary.run(["--version"])
        let printed = version.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertFalse(printed.isEmpty, "对照本身没打印版本：\(version.text.prefix(120))")
        XCTAssertFalse(run.stdout.contains(printed),
            "拒绝之前第一条已经跑出去了：\(run.stdout.prefix(200))")
    }

    /// 同一条闸的另一半：单条命令照旧（拒绝不许退化成"逢双必拒、单条也拒"）。
    func testASingleSubcommandAloneStillBehavesExactlyAsToday() throws {
        let version = try QoderDaemonBinary.run(["--version"])
        XCTAssertEqual(version.status, 0, version.text)
        XCTAssertTrue(version.stdout.contains("glasspaned"), version.stdout)

        let root = TestSandbox.pendingDirectory("onecmd")
        try FileManager.default.createDirectory(
            atPath: root + "/evidence", withIntermediateDirectories: true
        )
        let stats = try QoderDaemonBinary.run(["--state-dir", root, "--evidence-stats"])
        XCTAssertEqual(stats.status, 0, stats.text)
        XCTAssertTrue(stats.stdout.contains("\"count\""), stats.stdout)
    }
}

// MARK: - 面板：它连的到底是哪一个 daemon

@MainActor
final class QoderPanel20261019SocketResolutionTests: XCTestCase {

    private let engineSockKey = "GLASSPANE_ENGINE_SOCK"
    private let stateDirKey = "GLASSPANE_STATE_DIR"

    private func model(
        socketPath: String? = nil,
        probe: DaemonProbe = DaemonProbe(
            fileExists: { _ in false },
            rawTransport: { _, _, _ in .noListener(reason: "no test listener") }
        )
    ) -> SettingsModel {
        SettingsModel(
            socketPath: socketPath, refreshOnAppear: false,
            probes: QoderFakeProbes.set(), daemonProbe: probe
        )
    }

    /// 面板源码里必须出现这个变量名：`mcp-shell` 认它、`updater/lib/idle.js` 也认它，
    /// 而 `grep GLASSPANE_ENGINE_SOCK engine/Sources` 从前回空——同一个 daemon 三个读者
    /// 两套口径。扫的是剥掉注释后的代码：只把它写进注释不算认了它。
    func testPanelSourcesHonourTheEngineSocketOverride() throws {
        let code = try QoderPanelSource.allCode()
        XCTAssertTrue(code.contains("GLASSPANE_ENGINE_SOCK"),
            "面板一个文件都不认 GLASSPANE_ENGINE_SOCK：用它自己的帮助文档那个隔离 flag 起的 daemon，在面板里是\"未运行\"")
    }

    /// 第一级回落：环境点名的那个 socket。反向变异：解析回落到
    /// `DaemonProbe.defaultSocketPath` → 这一条红。
    func testTheIsolatedSocketNamedByTheEnvironmentIsTheOneThePanelProbes() {
        let root = TestSandbox.directory("sockenv")
        let socket = root + "/daemon.sock"
        let env = QoderEnvGuard(key: engineSockKey, value: socket)
        defer { env.restore() }
        XCTAssertEqual(model().daemon.socketPath, socket,
            "GLASSPANE_ENGINE_SOCK 点名了 \(socket)，面板却在探别处")
    }

    /// 空白串按"没点名"处理（与 `mcp-shell` 的 `socket-override-blank` 同一条规则：
    /// `export GLASSPANE_ENGINE_SOCK=` 之后不能拿空串去 connect）。
    func testABlankEnvironmentOverrideFallsThroughInsteadOfBeingHonoured() {
        let env = QoderEnvGuard(key: engineSockKey, value: "   ")
        defer { env.restore() }
        XCTAssertEqual(model().daemon.socketPath, DaemonProbe.defaultSocketPath,
            "空白串被当成一个 socket 名字了：那一次探测的对象没人选过")
    }

    /// 第二级回落：面板已经知道的那一个状态根（`GLASSPANE_STATE_DIR`，与
    /// `UpdatePanel.stateRoot` 同一份规则）下的 `daemon.sock`。叶子名按既有规则换
    /// （默认根 `engine.sock`、点名过的根 `daemon.sock`），`StateRoot.engineSocketPath`
    /// 是这条规则唯一的作者。
    func testANamedStateRootResolvesToThatRootsDaemonSocket() {
        let root = TestSandbox.directory("sockroot")
        let sock = QoderEnvGuard(key: engineSockKey, value: nil)
        let dir = QoderEnvGuard(key: stateDirKey, value: root)
        defer { dir.restore(); sock.restore() }
        XCTAssertEqual(model().daemon.socketPath, root + "/daemon.sock",
            "面板知道根 \(root)，却没探那个根上的 daemon.sock")
    }

    /// 什么都没点名时保持今天那一个。这一条不许由"顺手把默认根也改成 daemon.sock"满足：
    /// 默认根的叶子名是 engine.sock，那是文档化的既有规则（`ProjectRegistryIsolationTests`
    /// 还钉着它与 mcp-shell 的一致）。
    func testNothingNamedStillProbesTheHomeDefaultSocket() {
        let sock = QoderEnvGuard(key: engineSockKey, value: nil)
        let dir = QoderEnvGuard(key: stateDirKey, value: nil)
        defer { dir.restore(); sock.restore() }
        XCTAssertEqual(model().daemon.socketPath, DaemonProbe.defaultSocketPath)
    }

    /// 显式 `--socket-path` 永远赢过环境（与 daemon 自己的优先级同一条）。
    func testAnExplicitSocketOutranksTheEnvironment() {
        let root = TestSandbox.directory("sockexplicit")
        let explicit = root + "/panel-chosen.sock"
        let env = QoderEnvGuard(key: engineSockKey, value: root + "/daemon.sock")
        defer { env.restore() }
        XCTAssertEqual(model(socketPath: explicit).daemon.socketPath, explicit)
    }

    /// 端到端：真起一个带隔离根的 daemon（它绑的就是 `<root>/daemon.sock`），面板不许
    /// 把它读成"后台服务未运行"，且要说出它在跟哪一个根说话。
    /// 反向变异：任何一级回落漏了、或"文件在就算活着"回来了 → 这一条红。
    func testADaemonAnsweringOnAnIsolatedSocketIsReportedAsAnswering() async throws {
        let root = TestSandbox.pendingDirectory("sockspy")
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        let socket = root + "/daemon.sock"
        XCTAssertLessThan(socket.utf8.count, 104, "socket 路径超出 sockaddr_un：\(socket)")
        let binary = QoderDaemonBinary.path
        guard FileManager.default.isExecutableFile(atPath: binary) else {
            throw XCTSkip("没有 \(binary)；这一条要的是真 daemon")
        }
        let daemon = Process()
        daemon.executableURL = URL(fileURLWithPath: binary)
        daemon.arguments = ["--state-dir", root, "--no-probe"]
        daemon.currentDirectoryURL = URL(fileURLWithPath: root)
        daemon.standardOutput = FileHandle.nullDevice
        daemon.standardError = FileHandle.nullDevice
        try daemon.run()
        defer {
            daemon.terminate()
            daemon.waitUntilExit()
            try? FileManager.default.removeItem(atPath: root)
        }
        let deadline = Date().addingTimeInterval(10)
        while !FileManager.default.fileExists(atPath: socket), Date() < deadline {
            usleep(50_000)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: socket),
                      "夹具 daemon 没能在 10 s 内绑上 \(socket)")

        let env = QoderEnvGuard(key: stateDirKey, value: root)
        let cleared = QoderEnvGuard(key: engineSockKey, value: nil)
        defer { cleared.restore(); env.restore() }
        let settings = model(probe: DaemonProbe())
        XCTAssertEqual(settings.daemon.socketPath, socket,
            "面板探的不是那个真在应门的 socket，它说的是别处")
        settings.refresh()
        await QoderWait.until(timeoutSeconds: 12) { settings.daemon.liveness != .unmeasured }
        XCTAssertEqual(settings.daemon.liveness, .answering,
            "它在应门，页面上却写着未运行：\(settings.daemon.liveness)")
        XCTAssertEqual(settings.daemon.stateRoot, root, "hello 报的根要落到页面上")
        XCTAssertTrue(settings.daemonStateRootCaption.contains(root),
            "页面必须说出它在跟哪一个根说话：\(settings.daemonStateRootCaption)")
    }

    /// 什么都没点名、那个名字后面也确实没人时，报"未运行"仍然是对的——
    /// 修这条不许顺手把"读不到"改成"读得到"。
    func testAnAbsentSocketIsStillReportedNotRunning() async {
        let root = TestSandbox.pendingDirectory("sockabsent")
        let env = QoderEnvGuard(key: engineSockKey, value: root + "/daemon.sock")
        defer { env.restore() }
        let settings = model()
        settings.refresh()
        await QoderWait.until(timeoutSeconds: 8) { settings.daemon.liveness != .unmeasured }
        XCTAssertEqual(settings.daemon.liveness, .notRunning)
        XCTAssertTrue(settings.daemonCaption.contains("未运行"), settings.daemonCaption)
        XCTAssertEqual(settings.daemonTone, .bad, "未运行那一支的灯色不许跟着这次修改一起改")
    }

    /// 四级回落的**顺序**本身（纯函数，注入 env/home，不碰这个测试进程的环境）。
    /// 判据抄 `StateRoot.engineSocketPath`：显式 → env 点名 → 已知根的 `daemon.sock` →
    /// 家目录 `engine.sock`。反向变异：任意换两级顺序 → 对应那一行红。
    func testTheResolverPrecedenceIsTheDocumentedOrder() throws {
        let home = "/Users/someone-else"
        let root = TestSandbox.directory("sockorder")
        let named = "\(root)/daemon.sock"
        let env: [String: String] = [
            "GLASSPANE_ENGINE_SOCK": "/tmp/yet-elsewhere/daemon.sock",
            "GLASSPANE_STATE_DIR": root
        ]

        XCTAssertEqual(
            SettingsModel.resolveSocketPath(explicitSocketPath: named, env: env, home: home), named,
            "显式 socket 必须赢过两个环境变量（与 daemon 自己的优先级同一条）"
        )
        XCTAssertEqual(
            SettingsModel.resolveSocketPath(explicitSocketPath: nil, env: env, home: home),
            "/tmp/yet-elsewhere/daemon.sock",
            "GLASSPANE_ENGINE_SOCK 必须赢过状态根那一级：它是唯一一条点名 socket 本身的通道"
        )
        XCTAssertEqual(
            SettingsModel.resolveSocketPath(
                explicitSocketPath: nil, env: ["GLASSPANE_STATE_DIR": root], home: home
            ), named,
            "点名的根下必须落到 daemon.sock（叶子名跟着根换是既有规则，不是这一一条的新发明）"
        )
        XCTAssertEqual(
            SettingsModel.resolveSocketPath(explicitSocketPath: nil, env: [:], home: home),
            DaemonProbe.defaultSocketPath,
            "什么都没点名时还是家目录那一个：这一条不许被顺手改名成 daemon.sock"
        )
        // 空白与缺失同义：三条都得退回下一级，而不是拿空串去 connect。
        for blank in ["", "   ", "\t"] {
            XCTAssertEqual(
                SettingsModel.resolveSocketPath(
                    explicitSocketPath: nil,
                    env: ["GLASSPANE_ENGINE_SOCK": blank, "GLASSPANE_STATE_DIR": root], home: home
                ), named, "空白的 ENGINE_SOCK 把已知根那一级也吞了：\"\(blank)\""
            )
            XCTAssertEqual(
                SettingsModel.resolveSocketPath(
                    explicitSocketPath: nil,
                    env: ["GLASSPANE_STATE_DIR": blank], home: home
                ), DaemonProbe.defaultSocketPath, "空白的 STATE_DIR 该按没点名算：\"\(blank)\""
            )
            XCTAssertEqual(
                SettingsModel.resolveSocketPath(
                    explicitSocketPath: blank,
                    env: ["GLASSPANE_ENGINE_SOCK": named], home: home
                ), named, "空白的显式 socket 不许当一个路径用：\"\(blank)\""
            )
        }
        // `~/…` 按注入的家目录展开——与 `UpdatePanel.stateRoot` 同一份规则（那一处是作者）。
        XCTAssertEqual(
            SettingsModel.resolveSocketPath(
                explicitSocketPath: nil, env: ["GLASSPANE_STATE_DIR": "~/sandbox-root"], home: home
            ), "\(home)/sandbox-root/daemon.sock"
        )
    }
}

/// 面板全部源码（剥注释）：一条闸要知道"这一面有没有任何地方认这个变量"，
/// 只看一个文件就会漏掉写在该页另一个文件里的那一份。
enum QoderPanelSource {
    static func allCode() throws -> String {
        let directory = PanelSourceText.panelDirectory
        let names = try XCTUnwrap(
            FileManager.default.contentsOfDirectory(atPath: directory) as [String]?
        )
        XCTAssertGreaterThanOrEqual(names.filter { $0.hasSuffix(".swift") }.count, 10,
            "面板源码只扫到 \(names.count) 个文件，这条闸已经在看不到东西的地方")
        var code = ""
        for name in names where name.hasSuffix(".swift") {
            guard let text = try? String(
                contentsOfFile: directory + "/" + name, encoding: .utf8) else { continue }
            code += PanelSourceText.strip(text)
        }
        XCTAssertFalse(code.isEmpty, "一个面板源码都没读到，这条闸在看空表")
        return code
    }
}

// MARK: - 更新页跟着 daemon 报的根走

@MainActor
final class QoderPanel20261019UpdateRootTests: XCTestCase {

    /// `ConsoleModel` 早就有 `adoptDaemonReport`（:148-152 把这条记成它**只给自己**修掉
    /// 的 P1），而 `UpdateModel` 的根在 init 那一刻由 env/家目录定死（`private let
    /// stateRootPath`），`ConsoleRootView.syncFromSettings`（:104）只把 `console` 接到
    /// hello 上。结果：同一个窗口两个"状态根"，而「自动更新」开关写的是**默认家目录
    /// 那一份真状态**。反向变异：接线删掉 → 前两条红；根留成 let → 第三条红。
    func testTheUpdatePageIsFedTheDaemonReportedRoot() throws {
        let root = try PanelSourceText.code("ConsoleRootView.swift")
        XCTAssertTrue(root.contains("updates.adoptDaemonReport"),
            "更新页没有从 hello 接根：它还住在自己算的那一个里")
        let model = try PanelSourceText.code("UpdateModel.swift")
        XCTAssertTrue(model.contains("func adoptDaemonReport"),
            "UpdateModel 上没有接根入口，接线的人只能再算一遍")
        XCTAssertTrue(model.contains("var stateRootPath"),
            "根还是 init 时定死的常量，报来的那一个无处可放")
    }

    /// 状态根那一行要带出处（与 `ConsoleModel.displayedStateRootCaption` 同一套说法），
    /// 否则屏幕上两行"状态根"看不出它们不是同一个数。
    func testTheUpdatePageCaptionsWhichRootItMeans() throws {
        let model = try PanelSourceText.code("UpdateModel.swift")
        XCTAssertTrue(model.contains("stateRootCaption"),
            "更新页那一行还在只印路径：两行状态根并排时没人说得出谁是谁")
        let tab = try PanelSourceText.code("UpdateTabView.swift")
        XCTAssertTrue(tab.contains("model.stateRootCaption"),
            "那句话算出来了却没画出来——正是 lastActionMessage 当年的形状")
    }

    /// 端到端的这一条：hello 报 `stateRoot = X` 之后，这一页读写的三个位置都必须在 X 下，
    /// 而**家目录默认那一份真状态**一个字节都不该被这一页碰过。
    /// 反向变异：`pointerFile`/`caBundleFile` 里漏掉一个跟着换（半修）→ 对应那一句红；
    /// 把 `--state-dir` 从交给更新器的那串参数里拿掉 → 最后一条红。
    @MainActor
    func testThePointerAndTheBundleFollowTheReportedRoot() {
        let home = "/Users/someone-else"
        let panelRoot = TestSandbox.directory("update-panel-root")
        let daemonRoot = TestSandbox.directory("update-daemon-root")
        let model = UpdateModel(
            stateRoot: UpdatePanel.stateRoot(env: ["GLASSPANE_STATE_DIR": panelRoot], home: home)
        )
        // 上报之前：这一页按自己算的那一个走，出处也要这么写（不是"daemon 报的"）。
        XCTAssertEqual(model.stateRoot, panelRoot)
        XCTAssertEqual(model.pointerFile, panelRoot + "/update-install.json")
        XCTAssertTrue(model.stateRootCaption.contains("面板自己算的"), model.stateRootCaption)

        model.adoptDaemonReport(daemonStateRoot: daemonRoot, answered: true)

        XCTAssertEqual(model.stateRoot, daemonRoot, "根没跟着 daemon 报的那个换")
        XCTAssertEqual(model.pointerFile, daemonRoot + "/update-install.json",
            "更新器指针还在旧根下读——开关写的就是那一份真状态")
        XCTAssertEqual(model.caBundleFile, daemonRoot + "/ca-roots.pem",
            "根证书束同样留在旧根下：node 拿到的是另一个安装的束")
        XCTAssertTrue(model.stateRootCaption.contains("这一帧上报的"), model.stateRootCaption)
        XCTAssertTrue(model.stateRootCaption.contains(daemonRoot),
            "出处说了，路径也要说：" + model.stateRootCaption)
        // 交给更新器的那条命令必须点名同一个根，否则它自己会再解析出一个根来。
        XCTAssertEqual(
            UpdateModel.arguments(for: .enable, stateRoot: model.stateRoot),
            ["enable", "--state-dir", daemonRoot, "--json"]
        )
        // 家目录默认那一个不是这一页现在用的那一个——这一句就是"没往真状态里写"的判据。
        let defaultRoot = UpdatePanel.stateRoot(env: [:], home: home)
        XCTAssertNotEqual(model.pointerFile, UpdatePanel.pointerFile(stateRoot: defaultRoot),
            "换过隔离根之后指针又落回默认家目录那一份：那正是这条缺陷的动作侧")
    }

    /// 三态出处（与 `ConsoleModel` 同一套）：报过又不报了要**降级**，不许继续冒充"这一帧报的"；
    /// 空白串不是一次上报；没应门的那一帧（`presentButSilent`）更不许拿残留路径换根。
    @MainActor
    func testTheReportedRootDowngradesInsteadOfBeingAssumedForever() {
        let daemonRoot = TestSandbox.directory("update-earlier-root")
        let model = UpdateModel(stateRoot: TestSandbox.directory("update-init-root"))
        model.adoptDaemonReport(daemonStateRoot: daemonRoot, answered: true)
        XCTAssertEqual(model.stateRoot, daemonRoot)

        // 老 daemon 的这一帧没带这个键：路径留着（那是实测过的），出处降级。
        model.adoptDaemonReport(daemonStateRoot: "   ", answered: true)
        XCTAssertEqual(model.stateRoot, daemonRoot, "降级只许改那句出处，不许把实测到的根换成面板算的")
        XCTAssertTrue(model.stateRootCaption.contains("早前上报"), model.stateRootCaption)

        // 服务只应了门没回话：那一路径是上一次的残留，不能当作这一次的上报去换根。
        let otherRoot = TestSandbox.directory("update-silent-root")
        model.adoptDaemonReport(daemonStateRoot: otherRoot, answered: false)
        XCTAssertEqual(model.stateRoot, daemonRoot, "没应门的那一帧换了根，就是拿一次没发生的测量动真状态")
    }
}

// MARK: - 在途的写入动作 / 点不亮的红行 / 没闸的按钮

@MainActor
final class QoderPanel20261019ControlHonestyTests: XCTestCase {

    /// 一个根已经由 daemon 报下来的控制台模型：写入动作的判据要能按到"能跑"那一支，
    /// 否则在途那条红就成了"本来就按不动"的另一种写法。
    private func makeConsole(stateRoot: String) -> ConsoleModel {
        let console = ConsoleModel(
            daemonBinaryPath: "/opt/glasspane/glasspaned",
            env: ["GLASSPANE_STATE_DIR": TestSandbox.directory("pruneidle")],
            home: "/Users/someone-else",
            evidenceScanner: { _ in
                ConsoleModel.EvidenceScanOutcome(directoryExists: true, totalBytes: 0, listFailure: nil)
            }
        )
        console.adoptDaemonReport(
            binaryPath: "/opt/glasspane/glasspaned", daemonStateRoot: stateRoot, answered: true
        )
        // 注册表这一侧要落在"读成了"那一支：下面的在途禁用理由才只能是"正在删"。
        console.projectsState = .loaded
        return console
    }

    /// `isRunningPrune` 从前只被模型自己读（`guard !isRunningPrune`），一次真删最长 20 s
    /// 里「清理」已经回到 `.ready`：第二次点击会对着正在被改的注册表起一次 dry-run。
    /// 反向变异：`pruneControl` 不再看这个状态 → 两条断言同时红。
    func testAPruneInFlightDoesNotLeaveTheCleanControlReady() {
        let console = makeConsole(stateRoot: "/Users/example/isolated-root")
        XCTAssertTrue(console.canPreviewTestResiduePrune,
            "对照：没有东西在途时这一枚本来按得动（否则下面的红说明不了在途）")
        console.isRunningPrune = true
        XCTAssertFalse(console.canPreviewTestResiduePrune,
            "上一次 --project-prune 还在跑，这一枚就又按得动了：第二次点击会对着正在被改的表起 dry-run")
        guard case .blocked(let banner, let reason) = console.pruneControl else {
            return XCTFail("在途的删除要用 .blocked 说话，不许回到 .ready：\(console.pruneControl)")
        }
        XCTAssertFalse(banner.isEmpty, "禁用态也要报得出这一页知道的东西")
        XCTAssertTrue(reason.contains("按不动"), reason)
        XCTAssertTrue(reason.contains("下一步"), "禁用那句必须给得出下一步：\(reason)")
        XCTAssertTrue(reason.contains("清理"), "那句话说的是这一枚控件：\(reason)")
        XCTAssertFalse(reason.contains("没有需要清理"), "在途不许被写成没得清：\(reason)")
    }

    /// 闸的收紧：写入动作的状态必须有一个**视图**读者。模型里那句 `guard !isRunningPrune`
    /// 是闸门本身，不是读者——`PanelActionReadoutTests` 把它算成一个读者，于是这条状态
    /// "有读者"而屏幕上看不见它。
    func testWriteActionStatesHaveAViewReaderNotJustASelfGate() throws {
        let directory = PanelSourceText.panelDirectory
        let names = try XCTUnwrap(
            FileManager.default.contentsOfDirectory(atPath: directory) as [String]?
        )
        var views: [String: String] = [:]
        var models: [String: String] = [:]
        for name in names where name.hasSuffix(".swift") {
            guard let text = try? String(contentsOfFile: directory + "/" + name, encoding: .utf8) else { continue }
            if name.hasSuffix("Model.swift") { models[name] = PanelSourceText.strip(text) }
            else { views[name] = PanelSourceText.strip(text) }
        }
        XCTAssertGreaterThanOrEqual(views.count, 8, "视图侧一个文件都没扫到，这条闸在看空表")
        XCTAssertGreaterThanOrEqual(models.count, 3,
            "模型侧没扫到东西：模型/视图的分界已经变了，这条闸的两侧不再是它说的那两侧")
        let writeActions = ["isRunningPrune", "isPreparingPrunePreview", "lastActionMessage", "pruneNeedsRestart"]
        for state in writeActions {
            let readInView = views.values.contains { PanelActionReadoutTests.hasRead(name: state, in: $0) }
            XCTAssertTrue(readInView,
                "\(state) 只在模型里被读到——写入动作的在途与结论在屏幕上没有形状")
        }
    }

    /// 「在访达中显示」这一枚：同胞「打开报告」走 `reportControl(...)` 带禁用理由，
    /// 它自己却是一句 `revealFile()`——路径为空或整包没读到时按下去什么都不发生
    /// （一个看着能按、按了没反应的控件在这一面就是 P0）。
    /// 反向变异：把 `.disabled`/`.help` 摘掉 → 红在这里。
    func testRevealButtonIsGatedByTheSameJudgementAsItsSibling() throws {
        let view = try PanelSourceText.code("EvidenceTabView.swift")
        XCTAssertTrue(view.contains("ConsoleModel.revealFileControl"),
            "「在访达中显示」没有判据了：按不动的那一次既不灰也不说原因")
        XCTAssertTrue(view.contains(".disabled(!revealControl.enabled)"),
            "这一枚的禁用没有走那个判据：它还会回到「按了没反应」")
        XCTAssertTrue(view.contains(".help(revealControl.help)"),
            "禁用那句理由必须挂在它自己身上，与同胞同一套")
        XCTAssertTrue(view.contains(".accessibilityIdentifier(\"gp-reveal-evidence-file\")"),
            "这一枚要留一个可指认的标识，自动化才点得到它")
    }

    /// `pruneControl` 那一侧的判据本体（纯函数）：在途的删除必须自己说出它按不动，
    /// 而且说得出这是**哪一趟**在跑、下一步是什么。
    /// 反向变异：`isPruneRunning` 不被读 → 第一条红。
    func testThePruneJudgementItselfBlocksWhileADeleteIsRunning() {
        let ready = ConsoleModel.pruneControl(
            projectsState: .loaded, residueCount: 2, canRunDaemonCLI: true,
            isPreparingPreview: false, isPruneRunning: false
        )
        guard case .ready = ready else {
            return XCTFail("对照：没有东西在途时这条判据要给的是 .ready，实得 \(ready)")
        }
        let running = ConsoleModel.pruneControl(
            projectsState: .loaded, residueCount: 2, canRunDaemonCLI: true,
            isPreparingPreview: false, isPruneRunning: true
        )
        guard case .blocked(let banner, let reason) = running else {
            return XCTFail("删除在途时这一枚不许是 .ready：\(running)")
        }
        XCTAssertTrue(banner.contains("2"), "禁用态仍要报得出这一页测到的条数：\(banner)")
        XCTAssertTrue(reason.contains("--project-prune"), "要说得出是哪一趟在跑：\(reason)")
        XCTAssertTrue(reason.contains("下一步"), reason)
        // 在途删除优先于在途预览：两张闸同时为真时报的是"正在被改写"那件更硬的事。
        let both = ConsoleModel.pruneControl(
            projectsState: .loaded, residueCount: 2, canRunDaemonCLI: true,
            isPreparingPreview: true, isPruneRunning: true
        )
        guard case .blocked(_, let bothReason) = both else { return XCTFail("\(both)") }
        XCTAssertTrue(bothReason.contains("上一趟 --project-prune 还在跑"), bothReason)
    }

    /// 「在访达中显示」的四态：路径为空 / 整包没读到都按不动并给得出下一步；
    /// 读到且路径在才按得动。反向变异：`filePath` 不参与判据 → 空路径那条红。
    func testRevealFileControlSplitsTheFourReadings() throws {
        let path = TestSandbox.filePath("reveal-pack")
        let loading = ConsoleModel.revealFileControl(packLoad: .loading, filePath: path)
        XCTAssertFalse(loading.enabled)
        XCTAssertTrue(loading.help.contains("按不动"), loading.help)
        XCTAssertTrue(loading.help.contains("下一步"), loading.help)

        let failed = ConsoleModel.revealFileControl(
            packLoad: .failed(reason: "这条档案读不出内容"), filePath: path
        )
        XCTAssertFalse(failed.enabled)
        XCTAssertTrue(failed.help.contains("读不出"), failed.help)
        XCTAssertTrue(failed.help.contains("重试"), failed.help)

        let nothing = ConsoleModel.revealFileControl(packLoad: .none, filePath: path)
        XCTAssertFalse(nothing.enabled)
        XCTAssertTrue(nothing.help.contains("下一步"), nothing.help)

        let pack = try EvidencePack.decodeAndValidate(
            KernelFixtures.data("evidence-pack.ok-01.json")
        )
        // 整包读到了，可这一条记录没带着它在盘上的路径：访达没有去处可显示。
        let noPath = ConsoleModel.revealFileControl(packLoad: .loaded(pack), filePath: "   ")
        XCTAssertFalse(noPath.enabled, "路径为空时这一枚还是能按下去，而它按出一个什么都不显示的访达")
        XCTAssertTrue(noPath.help.contains("按不动"), noPath.help)
        XCTAssertTrue(noPath.help.contains("下一步"), noPath.help)

        let ready = ConsoleModel.revealFileControl(packLoad: .loaded(pack), filePath: path)
        XCTAssertTrue(ready.enabled, ready.help)
        XCTAssertTrue(ready.help.contains(path), "启用态那句话要指点名它要打开哪里：" + ready.help)
        XCTAssertFalse(ready.help.contains("按不动"), ready.help)
    }

    /// 「打开报告」与「在访达中显示」这一对都必须只说这条记录自己的两个实测事实：
    /// 读取结局 + 扫描给出的落盘路径。谁都不许拿别的记录、别的目录或"差不多"的
    /// 位置顶替（面板不代测，也不替 daemon 的量数当自己的量数）。
    func testTheReportAndRevealPairPointAtThisRecordsOwnFacts() throws {
        let path = TestSandbox.filePath("reveal-own")
        let pack = try EvidencePack.decodeAndValidate(
            KernelFixtures.data("evidence-pack.ok-01.json")
        )
        let reveal = ConsoleModel.revealFileControl(packLoad: .loaded(pack), filePath: path)
        let report = ConsoleModel.reportButtonControl(packLoad: .loaded(pack))
        XCTAssertTrue(reveal.enabled && report.enabled)
        XCTAssertTrue(reveal.help.contains(path), reveal.help)
        XCTAssertFalse(reveal.help.contains("档案目录"), "「在访达中显示」不许改成打开这一页共用的目录：\(reveal.help)")
        // 两句各说各的事：禁用理由里也不许互相顶替。
        let revealFailed = ConsoleModel.revealFileControl(packLoad: .failed(reason: "读不出"), filePath: path)
        let reportFailed = ConsoleModel.reportButtonControl(packLoad: .failed(reason: "读不出"))
        XCTAssertTrue(revealFailed.help.contains("访达"), revealFailed.help)
        XCTAssertTrue(reportFailed.help.contains("报告"), reportFailed.help)
        XCTAssertNotEqual(revealFailed.help, reportFailed.help,
                          "两枚控件共用一句话，就等于其中一枚在说另一枚做的事")
    }

    /// `lastRefreshError` 只被赋过 nil，那条红字永远点不亮。这一条选的是**删掉**：
    /// 同样的事实已经有能亮的出口（`daemonCaption`/`daemonTone` + 「应门不回话」那一支
    /// 的专属文案与标识），留着它只是多一块没人能点亮的红。
    /// 反向变异：把它接回某个真实失败态 → 红在"这个键又出现在源码里"，那时要改的是
    /// 这条闸的期望（并给出一个已经亮着的出口删掉），不是把死行请回来。
    func testTheErrorRowThatCouldNeverLightIsGone() throws {
        for name in ["SettingsModel.swift", "SettingsPanelView.swift"] {
            let text = try PanelSourceText.code(name)
            XCTAssertFalse(text.contains("lastRefreshError"),
                "\(name) 里还留着 lastRefreshError：那一行要么能亮，要么就该消失")
        }
        // 它原先要说的话确实有能亮的出口——删掉死行不等于把这些事实也删了。
        let live = try PanelSourceText.code("SettingsPanelView.swift")
        XCTAssertTrue(live.contains("model.daemonLivenessIdentifier"),
            "存活那一行失去了机器可读出口")
        XCTAssertTrue(live.contains("gp-daemon-silent-reason"),
            "「应门不回话」那一支的专属出口不见了：删掉死行不许顺手把这些事实也删了")
    }

    /// 配方页副标题：`load()` 只试 CWD 相对的候选，launchd/Finder 起面板时 cwd 是 `/`，
    /// 屏上显示的永远是内置快照，而那句副标题写着"真源：kernel/schemas/…"。
    /// 反向变异：副标题改回硬写的静态句子 → 红在后两条。
    func testTheRecipeSubtitleNamesTheSourceActuallyDisplayed() throws {
        let snapshot = RecipeSchemaLoader.load(fromWorkingDirectory: "/")
        XCTAssertTrue(snapshot.source.contains("内置快照"),
            "夹具没造出\"从未读到 schema 文件\"那一支：\(snapshot.source)")
        XCTAssertFalse(snapshot.source.contains("只读真源"),
            "工作目录是 / 的一次加载居然自称读到了真源：\(snapshot.source)")
        // 折算函数本体由 Stage 2 的 `QoderPanel20261019RecipeSourceNamingTests` 测；
        // 这里只闸"这一行不许再是硬写的静态句子"。
        let view = try PanelSourceText.code("RecipesTabView.swift")
        XCTAssertTrue(view.contains("RecipeSchemaLoader.subtitle"),
            "那一行必须由这份 overview 的 source 折算出来，才可能说的是它显示的东西")
    }

    /// 那句话的两个分支各说什么（cwd 里真有一份 schema 时才允许提那个路径）。
    /// 反向变异：把 subtitle 写成常量 → 前两条红。
    func testTheRecipeSubtitleHasTwoBranchesAndSaysEachOne() throws {
        let snapshot = RecipeSchemaLoader.load(fromWorkingDirectory: "/")
        let fromSnapshot = RecipeSchemaLoader.subtitle(for: snapshot)
        XCTAssertTrue(fromSnapshot.contains("内置快照"), fromSnapshot)
        XCTAssertFalse(fromSnapshot.contains("真源"), "读到的是快照就不许自称真源：" + fromSnapshot)

        // 真源分支：造一个 cwd，把 kernel/schemas/… 放在它下面，用同一份 load() 读它。
        let cwd = TestSandbox.directory("recipe-schema-cwd")
        let schemaDirectory = cwd + "/kernel/schemas"
        try FileManager.default.createDirectory(
            atPath: schemaDirectory, withIntermediateDirectories: true
        )
        try RecipeSchemaLoader.embeddedRaw.write(
            toFile: schemaDirectory + "/recipe-config.schema.json", atomically: true, encoding: .utf8
        )
        let loaded = RecipeSchemaLoader.load(fromWorkingDirectory: cwd)
        XCTAssertTrue(loaded.source.contains("schema 文件"), loaded.source)
        XCTAssertTrue(
            RecipeSchemaLoader.subtitle(for: loaded).contains("kernel/schemas/recipe-config.schema.json"),
            "真读到那份文件时，那一行要点名它：" + RecipeSchemaLoader.subtitle(for: loaded)
        )
    }

    /// 头部注释：`面板不持久化任何配置` 被两处真持久化证伪（配方草稿 `@AppStorage`
    /// 在 `RecipesTabView`、卡片折叠状态在 `ConsoleTheme`）。持久化是故意的，所以修的是
    /// 那句话。这一条读的是**注释本身**——缺陷就是一句注释，判据只能落在文字上。
    func testTheHeaderCommentDescribesThePersistenceThatExists() throws {
        let path = PanelSourceText.panelDirectory + "/GlassPaneSettingsApp.swift"
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(path)；这一条在没有该文件的环境里不作数")
        }
        XCTAssertFalse(raw.contains("面板不持久化任何配置"),
            "这句自述被同一页的两处 AppStorage 证伪：草稿与折叠状态确实落在 UserDefaults")
        XCTAssertTrue(raw.contains("AppStorage"),
            "注释要说出持久化的是什么，而不是把它否认掉")
        XCTAssertTrue(raw.contains("折叠") || raw.contains("草稿"),
            "要点名持久化的具体两样：配方草稿与卡片折叠状态")
    }
}
