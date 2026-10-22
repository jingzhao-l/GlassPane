import XCTest
import Foundation
import Darwin
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 2026-10-22 每日轮 · 面板 B 面（exec 那一侧）的自报路径闸。
///
/// 缺陷形状（P0）：昨天那条护栏 `PermissionReprobe.isSubmittableExecutable` 只装在
/// `SettingsModel` 的三条 `launchctl submit` 点上（A 面）。同一个由 peer 在 `hello` 帧里
/// 自报的字符串，面板还拿去 exec 了五次——`ConsoleModel.runDaemonCLI` 里
/// `process.executableURL = URL(fileURLWithPath: binary)` 前面**一个字都不问**，而其中
/// `--evidence-stats` 那条由 `refreshDaemonStats()` 在刷新/切页时自动触发，连一次点击都不
/// 需要。engine.sock 无 peer 鉴权（同用户即全权），所以任何能在候选 socket 名
/// （`GLASSPANE_ENGINE_SOCK` 还排在回落表第一级）上回一帧的进程，都能把这个已登录的 Aqua
/// 会话变成"以该会话身份启动任意路径"的执行器，而屏幕上不出声。这就是本项目禁止的半修。
///
/// 两条门都是本轮修的：
///   * 入口 `adoptDaemonReport` —— 拒掉的值记进 `refusedDaemonBinaryPath`，`daemonBinaryPath`
///     保持原样（常为 nil），于是 `refreshDaemonStats()` 那句
///     `guard let binary else { daemonStats = .notAsked }` 说的是"没问"而不是假测量；
///   * exec 本体 `runDaemonCLI` —— 后来的调用点忘不掉它。
///
/// 每条都写明什么改动会把它变红。
@MainActor
final class DailyRound20261022PanelGuardTests: XCTestCase {

    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }
        return url.path
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOfFile: repoRoot + "/Sources/" + relative, encoding: .utf8)
    }

    /// 一页只读盘、不扫档案的控制台：状态根的出处由 `GLASSPANE_STATE_DIR` 点名到沙箱里，
    /// 扫描桩固定回"目录在、里面没有档案"（见文件末尾那一份）。
    private func makeConsole(root: String) -> ConsoleModel {
        ConsoleModel(
            env: ["GLASSPANE_STATE_DIR": root],
            home: root + "/fake-home",
            evidenceScanner: emptyScan
        )
    }

    /// 这个账号自己的目录里放一份能跑起来的 glasspaned 桩：普通文件、属主是当前 uid、
    /// 所在目录 0700——`isSubmittableExecutable` 那三条全过，与真机上的合法安装同形。
    private func makeOwnDaemonScript(dir: String, name: String = "glasspaned") throws -> String {
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir)
        let script = dir + "/" + name
        try "#!/bin/sh\necho '{}'\n".write(toFile: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script)
        return script
    }

    /// 一份**看着完全合法**的 payload：绝对路径、无控制字符、属主是我、0755。
    /// 形状规则（`isSubmittablePath`）拦不住它，拦它的是"父目录不许对全体写开放"。
    /// 被 exec 时它会先把 `marker` 落盘——测试据此判断"到底起没起过进程"，不靠读注释。
    private func makeTmpPayload(marker: String) throws -> String {
        let payload = "/tmp/gp-panel-guard-\(UUID().uuidString)"
        try "#!/bin/sh\ntouch '\(marker)'\necho '{}'\n".write(toFile: payload, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: payload)
        return payload
    }

    // MARK: - 1. 入口那道门：peer 自报的 payload 不许换成一次 exec

    /// REVERSE：把 `adoptDaemonReport` 里那句判据去掉（回到 `daemonBinaryPath = reported`
    /// 无条件赋值）→ 这一条红：路径被采纳、`canRunDaemonCLI` 变真、拒掉的那枚是 nil。
    func testAdoptRefusesAPayloadDroppedInAPeerWritableDirectory() throws {
        let dir = TestSandbox.directory("panel-guard-refuse")
        let console = makeConsole(root: dir)
        let payload = try makeTmpPayload(marker: dir + "/RAN-ENTRY")
        defer { try? FileManager.default.removeItem(atPath: payload) }

        console.adoptDaemonReport(
            binaryPath: payload, daemonStateRoot: dir + "/daemon-root", answered: true
        )

        XCTAssertNil(console.daemonBinaryPath, "自报的 payload 被换成了可执行入口：这一页随时会 exec 别人放下的东西")
        XCTAssertFalse(console.canRunDaemonCLI, "没有可执行入口就该说出来")
        XCTAssertEqual(console.refusedDaemonBinaryPath, payload, "拒了却没人知道拒的是哪一个——下一次排查只能对着一条空读数猜")
        XCTAssertEqual(console.daemonStats, .notAsked, "没问就是没问：被拒的路径不许量出一份假统计")
        XCTAssertTrue(console.refusedDaemonBinaryPathCaption.contains(payload),
                      "那句话必须点得出被拒的路径：\(console.refusedDaemonBinaryPathCaption)")
        XCTAssertTrue(
            console.refusedDaemonBinaryPathCaption.contains("它不是这个账号拥有的普通文件"),
            "与提交那条腿（`SettingsModel`）两套说法就是两扇门讲两个故事：\(console.refusedDaemonBinaryPathCaption)"
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir + "/RAN-ENTRY"),
                       "入口这一趟已经把 payload 起起来了")
    }

    /// 合法那份照旧过闸，且过闸那一趟真的去问了后台服务；随后一帧"没自报"不许把它抹掉。
    /// REVERSE：① 把判据写成恒 false → 前三条红（合法安装被拒 = 这一页再也做不了任何事）；
    /// ② 把"nil = 这一帧没自报"改成"清空" → 第四条红。
    func testAdoptKeepsWorkingForThisAccountsOwnFileAcrossASilentFrame() async throws {
        let dir = TestSandbox.directory("panel-guard-accept")
        let real = try makeOwnDaemonScript(dir: dir)
        let console = makeConsole(root: dir)

        console.adoptDaemonReport(
            binaryPath: real, daemonStateRoot: dir + "/daemon-root", answered: true
        )
        XCTAssertEqual(console.daemonBinaryPath, real, "本账号拥有的普通文件就是合法安装的那一份，没有理由拒")
        XCTAssertNil(console.refusedDaemonBinaryPath)
        XCTAssertEqual(console.daemonStats, .asking,
                       "路径落地那一趟必须重问一次后台服务（这一栏从前永远停在没问）")

        // 让那一趟跑完再往下走：别留一个还在 exec 的子进程活过这条测试。
        for _ in 0..<100 {
            if console.daemonStats != .asking { break }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertNotEqual(console.daemonStats, .asking, "那一趟没跑完：桩起了却没回话，或压根没被 exec")

        // 这一帧没自报（旧 daemon / 没连上）：保持现状，"没读到路径"不等于"路径没了"。
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: nil, answered: true)
        XCTAssertEqual(console.daemonBinaryPath, real, "一句没自报不许把写入动作整个断掉")
        XCTAssertNil(console.refusedDaemonBinaryPath)

        // 再来一帧报了一个不能信的：留旧值，同时把拒掉的那一个记下来。
        let payload = try makeTmpPayload(marker: dir + "/RAN-LATER")
        defer { try? FileManager.default.removeItem(atPath: payload) }
        console.adoptDaemonReport(binaryPath: payload, daemonStateRoot: nil, answered: true)
        XCTAssertEqual(console.daemonBinaryPath, real, "坏帧把已经过闸的那一份换成了别人的程序")
        XCTAssertEqual(console.refusedDaemonBinaryPath, payload)
    }

    // MARK: - 2. exec 本体那道门：调用点忘不掉它

    /// REVERSE：删掉 `runDaemonCLI` 里那段判据 → 后半红（payload 被 exec，marker 落盘，
    /// 返回值也不再是 nil）；把豁免那一支也一起删掉的话，前半与第三条一起红。
    func testExecDoorRefusesAPayloadBeforeItBecomesAProcess() throws {
        let dir = TestSandbox.directory("panel-guard-exec")
        let marker = dir + "/RAN"
        let mine = try makeOwnDaemonScript(dir: dir, name: "glasspaned")

        // 对照：同一台机器、同一条通道，本账号自己那份跑得动——否则下面的"被拒"什么也没证明。
        let allowed = ConsoleModel.runDaemonCLI(binary: mine, arguments: ["--evidence-stats"], timeoutSeconds: 15)
        XCTAssertNotNil(allowed, "自家目录里的普通文件都被拦了：这一道门把合法安装也关在外面了")

        let payload = try makeTmpPayload(marker: marker)
        defer { try? FileManager.default.removeItem(atPath: payload) }
        let refused = ConsoleModel.runDaemonCLI(binary: payload, arguments: ["--evidence-stats"], timeoutSeconds: 15)
        XCTAssertNil(refused, "全体可写目录里那份 payload 被面板起起来了")
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker),
                       "返回值说了 nil，进程却真的跑过：这一道门只剩一句注释")
    }

    /// 豁免那一支的存在是为了不把 A 面一起拦死：`SettingsModel` 那三条 launchd 腿复用同一条
    /// 通道，而 `/bin/launchctl`、`/bin/ls` 恒不属当前账号。
    /// REVERSE：只留第一条判据（删掉 `rootOwnedSystemTool` 那一支）→ 前两条红；
    /// 豁免写成恒真 → 后两条红。
    func testExecDoorStillRunsTheSystemsOwnRootOwnedTools() throws {
        let run = ConsoleModel.runDaemonCLI(
            binary: "/bin/ls", arguments: ["/glasspane-no-such-path-here"], timeoutSeconds: 15
        )
        XCTAssertNotNil(run, "系统自带的 root 属主工具都被拒了：提交与重启那几条 launchd 腿会静默失效")
        XCTAssertTrue(ConsoleModel.rootOwnedSystemTool("/bin/ls"))

        let dir = TestSandbox.directory("panel-guard-exempt")
        let payload = try makeTmpPayload(marker: dir + "/RAN")
        defer { try? FileManager.default.removeItem(atPath: payload) }
        XCTAssertFalse(ConsoleModel.rootOwnedSystemTool(payload),
                       "peer 放得下的那一份被当成系统工具：豁免这一支就把第一道门也拆了")
        let mine = try makeOwnDaemonScript(dir: dir, name: "glasspaned")
        XCTAssertFalse(ConsoleModel.rootOwnedSystemTool(mine),
                       "本账号那份走的是第一条判据；这一支只认 root 属主的系统工具")
    }

    // MARK: - 3. 判据装在读者那一侧：源码扫描

    /// 与 `DailyRound20261021EngineTests.testPanelGuardsEverySubmitSite` 成对：那一条数 A 面
    /// （`SettingsModel` 三处 submit），这一条数 B 面（一处入口 + 一处 exec 本体）。
    /// REVERSE：删掉任一处 → 计数从 2 掉到 1 → 红；把 exec 那一处的判据挪到 `Process()`
    /// **之后** → 顺序断言红（起了才问等于没问）。
    func testExecSitesConsultThePredicateInSource() throws {
        let model = try source("glasspane-settings/ConsoleModel.swift")
        XCTAssertEqual(
            model.components(separatedBy: "PermissionReprobe.isSubmittableExecutable(").count - 1, 2,
            "同一个自报路径有两扇门：`adoptDaemonReport` 的入口与 `runDaemonCLI` 的 exec 本体，两处都得有护栏"
        )
        let body = try XCTUnwrap(
            Self.body(of: model, startsAt: "nonisolated static func runDaemonCLI(", stopsBefore: "static func cliReply"),
            "`runDaemonCLI` 的函数体找不出来：夹具本身就没成立"
        )
        let guardAt = try XCTUnwrap(
            body.range(of: "PermissionReprobe.isSubmittableExecutable("),
            "`runDaemonCLI` 自己不问那条判据：它只是碰巧被一个问过的人调用"
        )
        let processAt = try XCTUnwrap(
            body.range(of: "Process()"),
            "函数体里没有 `Process()`：这条顺序断言的对照物没了"
        )
        XCTAssertTrue(guardAt.lowerBound < processAt.lowerBound,
                      "判据在 `Process()` 之后才问——进程已经起来了才决定要不要拒绝它")
    }

    /// 拒掉必须看得见：那一行挂在侧栏页脚"程序路径"旁边，且带无障碍标识（人手读得到，
    /// 自动化也点得出它）。
    /// REVERSE：删掉 `ConsoleRootView` 里那一行 → 两条都红（模型算了结论却没人渲染，
    /// 正是 `PanelActionReadoutTests` 记过的"写了没人读"形状）。
    func testRefusalIsRenderedNextToTheDaemonCard() throws {
        let view = try source("glasspane-settings/ConsoleRootView.swift")
        XCTAssertTrue(view.contains(".accessibilityIdentifier(\"gp-daemon-refused-binary\")"),
                      "那一行没有可核验的标识：自动化读不到这次拒绝")
        XCTAssertTrue(view.contains("console.refusedDaemonBinaryPathCaption"),
                      "页面上那句话必须是模型算好的同一条，不是视图里再抄一遍的第二份说法")
    }

    private static func body(of text: String, startsAt marker: String, stopsBefore stop: String) -> String? {
        guard let start = text.range(of: marker) else { return nil }
        let tail = text[start.lowerBound...]
        guard let end = tail.range(of: stop) else { return nil }
        return String(tail[..<end.lowerBound])
    }
}

/// 2026-10-22 每日轮 · 探针侧的第二条缺陷（P2）：peer 自报的文本被原样插进 daemon 日志。
///
/// `~/.glasspane/installer-daemon.log` 是 launchd 重定向出来的那条 stderr，`--verbose` 时
/// 还会被打印出来；而 `state.source`、坏帧的 `type`、hello 的 `appName` 全是 peer 写的字节。
/// 一句 ANSI/OSC 就在下一个读者（终端、`cat`、报告）那里生效，一个 `\n` 更是凭空多写出
/// 一行 daemon 从没写过的日志。
///
/// 走的是端到端：真 listener + 真连接 + 真帧，判据是**落进 sink 的那串字节**，
/// 不是某个平行实现里的字符串。
final class DailyRound20261022ProbeLogSanitisationTests: XCTestCase {

    /// 日志的落笔处换成可读数组。`quiet: false` = `--verbose` 那一档，INFO 也要收：
    /// `probe connected:` 那一行写的正是 peer 自报的 appName / probeVersion / capabilities。
    private final class Capture: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [String] = []

        var log: EngineLog {
            EngineLog(quiet: false, sink: { data in
                self.lock.lock()
                self.storage.append(String(decoding: data, as: UTF8.self))
                self.lock.unlock()
            })
        }

        var lines: [String] {
            lock.lock(); defer { lock.unlock() }
            return storage
        }

        var text: String { lines.joined() }
    }

    private enum FixtureError: Error {
        case couldNotConnect(String)
    }

    /// 连上去的那一手，形状与 `EngineP6ProbeTests` 的 `rawConnect` 逐字相同（那一份是
    /// 现在真跑得起来的夹具）；连不上就报一个具名失败——"连不上就跳过"会让这一条永远绿。
    private func connectProbe(to path: String) throws -> Int32 {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let copied = path.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                guard let base = destination.baseAddress else { return false }
                _ = strncpy(base.assumingMemoryBound(to: CChar.self), source, destination.count)
                return true
            }
        }
        guard copied else { throw FixtureError.couldNotConnect("装不进 sockaddr_un 的路径名") }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw FixtureError.couldNotConnect("socket() errno \(errno)") }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                Darwin.connect(fd, rebound, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            let code = errno
            close(fd)
            throw FixtureError.couldNotConnect("connect() errno \(code)")
        }
        return fd
    }

    private func writeLine(_ line: String, to fd: Int32) {
        line.withCString { pointer in
            let written = Darwin.write(fd, pointer, strlen(pointer))
            if written <= 0 {
                // 写不出去就是夹具自己没成立，后面每一条断言都测不到东西。
                XCTFail("对端这一侧写不出去（fd \(fd), errno \(errno)）：这一帧根本没交给 daemon")
            }
        }
    }

    private func waitUntil(_ predicate: () -> Bool, within limit: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(limit)
        while Date() < deadline {
            if predicate() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return predicate()
    }

    /// 对端自报的每一段文本都不许把控制字节带进日志行。
    /// REVERSE：把 `ProbeSocketServer.logSafePeerText` 的那三处调用之一改回裸插值
    /// （`rawSource` / `firstUnmappedSource` / 坏帧的 `reason`），或把 hello 那两处的包装删掉
    /// → 对应那一行带着 ESC/BEL/换行 → 红。把整条判据改成恒 false 会让四条 peer 文本全红。
    func testPeerSuppliedTextCannotDriveTheDaemonLog() throws {
        let dir = TestSandbox.directory("probe-log")
        let path = dir + "/p"
        let capture = Capture()
        let inbox = ProbeInbox()
        let server = ProbeSocketServer(socketPath: path, inbox: inbox, log: capture.log)
        try server.start()
        defer {
            server.stop()
            try? FileManager.default.removeItem(atPath: dir)
        }

        let fd = try connectProbe(to: path)
        // 主动收口那一次是唯一一次 `close`；这一枚旗子是为了不让 defer 再关第二次——
        // 数字被别的线程回收之后再关一次，关掉的就是别人家的描述符。
        var hungUp = false
        defer { if !hungUp { close(fd) } }

        // 1) hello：appName / probeVersion 各带一段 ANSI 与一个裸换行。
        let hello = "{\"t\":\"hello\",\"pid\":\(getpid()),"
            + "\"appName\":\"Glass\\u001B[31mPane\\u000A\",\"probeVersion\":\"gp-probe/1.0\\u0007x\","
            + "\"capabilities\":[\"z1\"]}\n"
        writeLine(hello, to: fd)
        XCTAssertTrue(
            waitUntil({ capture.text.contains("probe connected") }, within: 3),
            "夹具自检：这一帧 hello 没被收下，后面每一条断言都测不到东西。已收到：\(capture.text.debugDescription)"
        )

        // 2) 一个不属于 schema 的 state source：:481 那一行按原话点名它。
        let state = "{\"t\":\"state\",\"key\":\"k\",\"before\":\"a\",\"after\":\"b\","
            + "\"source\":\"\\u001B]0;pwn\\u0007\\u000Afake\"}\n"
        writeLine(state, to: fd)
        XCTAssertTrue(
            waitUntil({ capture.text.contains("reports state source") }, within: 3),
            "夹具自检：这一帧没被读成 state 帧：\(capture.text.debugDescription)"
        )

        // 3) 一个坏帧：`reason` 里带着 peer 自己那个 type（第三处裸插值）。
        writeLine("{\"t\":\"\\u001B[31mnope\",\"pid\":1}\n", to: fd)
        XCTAssertTrue(
            waitUntil({ capture.text.contains("frame malformed from pid") }, within: 3),
            "夹具自检：这一帧没被读成 malformed：\(capture.text.debugDescription)"
        )

        // 4) 收口：detach 那一行把第一个未知 source 再点一次名（:404）。
        close(fd)
        hungUp = true
        XCTAssertTrue(
            waitUntil({ capture.text.contains("could not map to a state channel") }, within: 3),
            "夹具自检：关闭这一手的收口没写出来：\(capture.text.debugDescription)"
        )

        // 判据落在**每一行**上：这一条通道里只要还有一处裸插值，这里就红。
        for chunk in capture.lines {
            XCTAssertTrue(chunk.hasSuffix("\n"), "一条日志就该是一行：\(chunk.debugDescription)")
            XCTAssertEqual(
                chunk.filter { $0 == "\n" }.count, 1,
                "peer 的一个换行在日志里多写出了一行 daemon 从没写过的话：\(chunk.debugDescription)"
            )
            let line = String(chunk.dropLast())
            XCTAssertFalse(
                AgentText.containsTerminalControlText(line),
                "这一行带着会让终端动起来的字节（<0x20 或 0x7F）：\(line.debugDescription)"
            )
        }
        // 转义是**可见**而不是删除：句子还得读得出它拒/不认识的是哪一个 token。
        XCTAssertTrue(capture.text.contains("\\u001B"),
                      "控制字符被悄悄删掉了，而不是折成看得见的转义：\(capture.text.debugDescription)")
        XCTAssertTrue(capture.text.contains("reports state source \"\\u001B]0;pwn\\u0007"),
                      capture.text.debugDescription)
    }
}

/// 固定成"目录在、里面没有档案"的扫描桩（与 `ConsoleDaemonStateRootTests` 那份同形）：
/// 这一轮测的是那个路径能不能被 exec，不是扫盘本身。
private func emptyScan(_ path: String) -> ConsoleModel.EvidenceScanOutcome {
    ConsoleModel.EvidenceScanOutcome(directoryExists: true, totalBytes: 0, listFailure: nil)
}
