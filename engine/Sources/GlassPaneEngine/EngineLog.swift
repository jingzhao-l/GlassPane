import Foundation

/// Daemon logging to stderr, gated by --verbose (P0 spec §3.5). Never logs
/// pixel data — only digests, metrics and method outcomes.
public final class EngineLog {
    private let quiet: Bool

    public init(quiet: Bool) {
        self.quiet = quiet
    }

    public func info(_ message: String) {
        write(level: "INFO", message)
    }

    public func error(_ message: String) {
        write(level: "ERROR", message)
    }

    private func write(level: String, _ message: String) {
        guard !quiet else { return }
        let line = "[glasspaned] \(level) \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }
}
