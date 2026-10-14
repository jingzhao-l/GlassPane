import Foundation

/// Daemon logging to stderr. `--verbose` gates **INFO only**; an ERROR is always
/// written (P0 spec §3.5 puts the log on stderr, and 2026-09-22 audit row `D`
/// named the bug fixed here). Never logs pixel data — only digests, metrics and
/// method outcomes.
///
/// 为什么 ERROR 不能跟着 `quiet` 一起关：发布的形态恰恰是 quiet 的。`main.swift`
/// 用 `EngineLog(quiet: !options.verbose)` 构造，而 launchd 作业
/// （`installer/cli.js` 的 `launchdPlistString`）的 ProgramArguments 只有
/// `--socket-path`，从不带 `--verbose`。从前 `write` 用一句 `guard !quiet` 把 INFO
/// 和 ERROR 一起吞掉，于是默认安装下每一条 ERROR 都被丢弃——而
/// `ProtocolErrors.swift` 给 `internalError` 开的处方是 "check the daemon log
/// (stderr)"。那句 stderr 由 plist 的 `StandardErrorPath` 重定向进
/// `~/.glasspane/installer-daemon.log`，**目的地一直是有的**，缺的是产品往里写。
/// 一条指向产品从不写入的那条流的处方，就是坏的处方。
public final class EngineLog {

    /// 级别的唯一拼写源：门按它判级，`info`/`error` 按它落笔，测试按它提问。
    static let infoLevel = "INFO"
    static let errorLevel = "ERROR"

    private let quiet: Bool
    /// 落笔的地方，默认就是 stderr（发布形态里那条被 launchd 重定向的流）。
    /// 做成可注入的**唯一**理由是"这一行到底有没有写出去"必须能被确定性验红：
    /// 把判据留在 `emits`、把目的地交给调用方，与 `writeBounded(note:)`、
    /// `partialLineDeadline(now:)`、`ProbeSocketServer(livenessProbe:)` 是同一条路子。
    private let sink: (Data) -> Void

    public convenience init(quiet: Bool) {
        self.init(quiet: quiet, sink: nil)
    }

    /// internal 而非 public：注入目的地只是为了让"ERROR 被 quiet 吃掉"这件事
    /// 能在测试里被直接观测（`@testable` 到 internal 为止），不是给调用方的开关。
    init(quiet: Bool, sink: ((Data) -> Void)?) {
        self.quiet = quiet
        self.sink = sink ?? { FileHandle.standardError.write($0) }
    }

    public func info(_ message: String) {
        write(level: Self.infoLevel, message)
    }

    public func error(_ message: String) {
        write(level: Self.errorLevel, message)
    }

    /// 这一行要不要写出去。**这是判据本体**，所以抽成不带实例的纯函数：
    /// ERROR 与 `quiet` 无关（见类型注释），INFO 照旧只在 `--verbose` 下出——
    /// 把 INFO 也放开就等于在 launchd 的日志里堆刷屏，那不是这次要修的缺陷。
    static func emits(level: String, quiet: Bool) -> Bool {
        if level == errorLevel { return true }
        return !quiet
    }

    /// 要不要写 + 写出去长什么样，一次算清。`write` 只负责把这一行交给 sink，
    /// 所以测试断言的就是线上真实那一条字节序列，而不是另一个平行实现。
    static func line(toWrite level: String, message: String, quiet: Bool) -> String? {
        guard emits(level: level, quiet: quiet) else { return nil }
        return "[glasspaned] \(level) \(message)\n"
    }

    private func write(level: String, _ message: String) {
        guard let line = Self.line(toWrite: level, message: message, quiet: quiet) else { return }
        sink(Data(line.utf8))
    }
}
