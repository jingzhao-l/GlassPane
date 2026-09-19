import Foundation

/// Developer-tools (debugger) capability probe — P6 spec v6.0 §7 amendment
/// ("minimize human intervention": detecting, verifying and re-verifying the
/// debug capability is machine work; the only human step is the TCC checkbox
/// itself, which no public API can read — P1 v1.3 §6.1 unchanged).
///
/// Like the CGEvent tap precedent ("探测即权限"), the probe runs real,
/// bounded `xcrun lldb` invocations and reports structured three-state
/// outcomes; it never guesses from absence of evidence.
public final class DebugCapabilityProbe {

    public enum Outcome: String, Codable, Equatable {
        case ok          // debugger actually captured/launched the process
        case denied      // OS refused the debug permission (explicit, fast)
        case timeout     // hung past the budget (blocked prompt, cold start)
        case spawnFailed(String)
    }

    public struct Snapshot: Codable, Equatable {
        public let launch: Outcome
        public let attach: Outcome
        public var granted: Bool { launch == .ok || attach == .ok }
    }

    /// Injectable process layer so unit tests never touch lldb.
    public protocol Running {
        /// Run to completion or timeout (kill on timeout).
        func run(_ binary: String, _ arguments: [String], timeout: TimeInterval)
            -> (exit: Int32?, timedOut: Bool, output: String)
        /// Spawn a short-lived victim and return its pid string (nil on fail).
        func spawnVictim(seconds: Int) -> String?
        /// Kill a victim spawned above.
        func killVictim(_ pid: Int32)
    }

    public struct ProcessRunner: Running {
        public init() {}
        public func run(_ binary: String, _ arguments: [String], timeout: TimeInterval)
            -> (exit: Int32?, timedOut: Bool, output: String) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: binary)
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                try process.run()
            } catch {
                return (nil, false, "spawn failed: \(error.localizedDescription)")
            }
            let deadline = Date().addingTimeInterval(timeout)
            var timedOut = false
            while process.isRunning {
                if Date() >= deadline {
                    timedOut = true
                    process.terminate()
                    usleep(200_000)
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                    break
                }
                usleep(100_000)
            }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let status = process.terminationStatus
            let text = String(data: data, encoding: .utf8) ?? ""
            if text.hasPrefix("spawn failed:") { return (nil, false, text) }
            _ = status
            return (timedOut ? nil : process.terminationStatus, timedOut, text)
        }

        public func spawnVictim(seconds: Int) -> String? {
            let victim = Process()
            victim.executableURL = URL(fileURLWithPath: "/bin/sleep")
            victim.arguments = ["\(seconds)"]
            do {
                try victim.run()
            } catch {
                return nil
            }
            return String(victim.processIdentifier)
        }

        public func killVictim(_ pid: Int32) {
            kill(pid, SIGKILL)
        }
    }

    /// Cold-start penalty on real machines (P6 §0 F5): keep the budget wide.
    public static let defaultTimeoutSeconds: TimeInterval = 120
    static let attachVictimSeconds = 30

    private let runner: Running
    private let timeout: TimeInterval

    public init(runner: Running = ProcessRunner(), timeout: TimeInterval = DebugCapabilityProbe.defaultTimeoutSeconds) {
        self.runner = runner
        self.timeout = timeout
    }

    /// launch: debugger-spawns a trivially-exiting program; the
    /// "exited with status" line proves the whole debugserver path works.
    public func probeLaunch() -> Outcome {
        let result = runner.run(
            "/usr/bin/xcrun",
            ["lldb", "--batch", "-o", "run", "-o", "quit", "/usr/bin/true"],
            timeout: timeout
        )
        return Self.classify(result)
    }

    /// attach: spawn a short-lived sleep child and attach to it by pid.
    public func probeAttach() -> Outcome {
        guard let pidText = runner.spawnVictim(seconds: Self.attachVictimSeconds),
              let pid = Int32(pidText) else {
            return .spawnFailed("victim spawn failed")
        }
        defer { runner.killVictim(pid) }
        let result = runner.run(
            "/usr/bin/xcrun",
            ["lldb", "--batch", "--attach", pidText, "-o", "detach", "-o", "quit"],
            timeout: timeout
        )
        return Self.classify(result)
    }

    public func snapshot() -> Snapshot {
        Snapshot(launch: probeLaunch(), attach: probeAttach())
    }

    /// Output-shape classification. Unknown failures surface as spawnFailed
    /// verbatim — never silently folded into a permission claim either way.
    static func classify(_ run: (exit: Int32?, timedOut: Bool, output: String)) -> Outcome {
        let text = run.output
        if text.contains("exited with status") { return .ok }
        if text.contains("attached") && !text.contains("Not allowed") { return .ok }
        if text.contains("Not allowed to attach") || text.contains("attach failed")
            || text.contains("not permitted") { return .denied }
        if run.timedOut { return .timeout }
        if run.exit == nil { return .spawnFailed(trimmed(text)) }
        return .spawnFailed("exit \(run.exit ?? -1): \(trimmed(text))")
    }

    private static func trimmed(_ text: String) -> String {
        String(text.prefix(200)).replacingOccurrences(of: "\n", with: " ")
    }

    public func jsonPayload() -> [String: Any] {
        let snap = snapshot()
        func encode(_ outcome: Outcome) -> [String: Any] {
            switch outcome {
            case .ok: return ["state": "ok"]
            case .denied: return ["state": "denied"]
            case .timeout: return ["state": "timeout"]
            case .spawnFailed(let detail): return ["state": "spawnFailed", "detail": detail]
            }
        }
        return [
            "capability": "developer-tools-debug",
            "launch": encode(snap.launch),
            "attach": encode(snap.attach),
            "granted": snap.granted,
            "note": "TCC 无公开查询 API；本结果是受限真实 lldb 探测的三态陈述（P6 §7）。granted=false 的唯一人工步骤是系统设置勾选，验证/复验全由本命令承担。",
        ]
    }
}
