import Testing
import Foundation
@testable import GlassPaneEngine

/// 默认安装（launchd，不带 `--verbose`）里 ERROR 必须出得来。
///
/// 这条链的每一环都可查：
///   * `glasspaned/main.swift` 用 `EngineLog(quiet: !options.verbose)` 构造日志——默认就是 quiet；
///   * `installer/cli.js` 的 `launchdPlistString` 里 ProgramArguments 只有 `--socket-path`
///     （从不带 `--verbose`），而那份 plist 的 `StandardErrorPath` 把 stderr 重定向进
///     `daemonLog`（`launchdPlistString` 的调用点算给它的那条路径 = 状态根下的
///     `DAEMON_LOG_NAME`）；
///   * `ProtocolErrors.swift` 给 `internalError` 的处方是 "check the daemon log (stderr)"。
/// 从前 `EngineLog.write` 用一句 `guard !quiet` 把 ERROR 与 INFO 一起吞掉（2026-09-22 审计
/// 表 D 行，点名的就是 `EngineLog.swift` 里那句 guard）。**目的地一直有**（那条 plist
/// 重定向），缺的是产品往里写——一句指向产品从不写入的那条流的处方，就是坏的处方。
@Suite("EngineLog: ERROR is not gated by --verbose")
struct ErrorLogVisibilityTests {

    /// 收下来的行。写成类而不是测试里的局部 `var`，是为了让 sink 那条闭包捕获的不是
    /// 一个被装箱的可变量（EngineLog 的 sink 是存储型闭包，会逃逸）。
    private final class SinkCapture {
        var lines: [String] = []
        var text: String { lines.joined() }
    }

    @Test("An ERROR line is emitted even when the log is quiet — the shipped, non-verbose shape")
    func errorIsEmittedEvenWhenQuiet() {
        #expect(
            EngineLog.emits(level: EngineLog.errorLevel, quiet: true),
            "quiet 里连 ERROR 一起关，就是审计表 D 那一行：默认安装下 socket 层、输入监视器与 Dispatcher 的错误一条都到不了 stderr"
        )
        // 对照：verbose 那一侧也必须出。只断言"quiet 下出 ERROR"的话，一条"永远返回 true"
        // 的判据同样能满足它——判据得能被反着打死。
        #expect(EngineLog.emits(level: EngineLog.errorLevel, quiet: false), "verbose 下 ERROR 照旧要出")
    }

    @Test("INFO stays behind --verbose")
    func infoStaysGatedByQuiet() {
        #expect(
            !EngineLog.emits(level: EngineLog.infoLevel, quiet: true),
            "把 INFO 也一起放开会把 launchd 那份日志刷成噪声——这次修的不是它"
        )
        #expect(EngineLog.emits(level: EngineLog.infoLevel, quiet: false), "verbose 才是 INFO 的开关")
    }

    /// 真走一遍 `EngineLog` 的输出路径：目的地由注入的 sink 给出（生产默认那条就是
    /// `FileHandle.standardError`，见 `EngineLog.init(quiet:)`），形状由同一条 `write`
    /// 产出。这一条钉的是"判据真被 consult"这件事——把 `guard !quiet` 塞回 `write`
    /// 而 `emits` 保持正确，这里就一个字也收不到。
    @Test("A quiet log hands exactly the ERROR line to its stderr sink, and no INFO line")
    func quietLogWritesOnlyTheErrorLine() {
        let capture = SinkCapture()
        let log = EngineLog(quiet: true, sink: { capture.lines.append(String(decoding: $0, as: UTF8.self)) })
        let token = UUID().uuidString

        log.info("info-payload-\(token)")
        log.error("error-payload-\(token)")

        #expect(
            capture.text.contains("[glasspaned] ERROR error-payload-\(token)\n"),
            "quiet 的日志必须把 ERROR 交出去，而且是既有的那行形状：\(capture.text.isEmpty ? "（一个字都没写）" : capture.text)"
        )
        #expect(!capture.text.contains("info-payload-\(token)"), "INFO 仍归 --verbose 管：\(capture.text)")
    }

    @Test("The verbose log hands both lines out — the sink is not just an error pipe")
    func verboseLogWritesBothLevels() {
        let capture = SinkCapture()
        let log = EngineLog(quiet: false, sink: { capture.lines.append(String(decoding: $0, as: UTF8.self)) })
        let token = UUID().uuidString

        log.info("info-payload-\(token)")
        log.error("error-payload-\(token)")

        #expect(capture.text.contains("[glasspaned] INFO info-payload-\(token)\n"), "\(capture.text)")
        #expect(capture.text.contains("[glasspaned] ERROR error-payload-\(token)\n"), "\(capture.text)")
    }

    /// 把处方与被修的那一面接起来：`internalError` 让 agent 去读 daemon log（stderr），
    /// 而 daemon log 现在确实有一句可读的 ERROR——用 socket 层自己生成的那句话验。
    @Test("The daemon-log remedy has a writer behind it: a socket-layer ERROR reaches a quiet log")
    func socketLayerErrorReachesTheStreamTheRemedyPointsAt() throws {
        let remedy = GPError(code: .internalError, message: "boom").remedy
        #expect(remedy.contains("stderr"), "处方指向的是这条流：\(remedy)")

        // 判据来自 SocketServer 的沉默连接分支（SilentClientDeadlineTests 钉着它的内容）。
        let plan = SocketServer.clientReadPlan(
            codec: FrameCodec(),
            spokeOnce: false,
            existingLineDeadline: nil,
            existingFirstByteDeadline: nil,
            now: { 0 }
        )
        guard case .firstByte = plan.wait else {
            Issue.record("一字未发的连接应落在 .firstByte 上，拿到的是 \(plan.wait)")
            return
        }
        guard case .close(let reason) = SocketServer.silenceTimeoutAction(
            for: plan.wait, codec: FrameCodec()
        ) else {
            Issue.record("首字节预算到点必须关闭连接，否则沉默的对端占死唯一的客户端位置")
            return
        }

        let capture = SinkCapture()
        EngineLog(quiet: true, sink: { capture.lines.append(String(decoding: $0, as: UTF8.self)) })
            .error(reason)

        #expect(
            capture.text.contains("[glasspaned] ERROR \(reason)"),
            "处方说\"check the daemon log (stderr)\"，而默认（quiet）的日志一个字都不写，就是这条链断掉的样子：\(capture.text)"
        )
    }

    @Test("The line shape is decided in one place: nothing to write is nil, not an empty string")
    func suppressedLevelsProduceNoLineAtAll() {
        #expect(EngineLog.line(toWrite: EngineLog.infoLevel, message: "noise", quiet: true) == nil,
                "被压掉的级别不该产出一行空字节")
        let errorLine = EngineLog.line(toWrite: EngineLog.errorLevel, message: "still visible", quiet: true)
        #expect(errorLine == "[glasspaned] ERROR still visible\n", "ERROR 的形状与从前一致，只是不再被 quiet 吃掉")
    }
}
