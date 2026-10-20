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
        case spawnFailed
    }

    public struct Snapshot: Codable, Equatable {
        public let launch: Outcome
        public let attach: Outcome
        /// One verdict for this seat, computed once: an explicitly measured
        /// refusal is not cancelled by the other half succeeding. The panel card
        /// (`DeveloperToolsCapability.status`) and `--check-developer-tools`'s
        /// exit code both read this, so the same payload cannot answer "granted"
        /// to the agent and "被系统拒绝" to the person looking at the card.
        ///
        /// The seat this snapshot names is the **attach** arm
        /// (`PermissionDescriptor.developerTools` purposeText: 让调试器附加到进程). The
        /// launch arm is published beside it as its own measurement, and it may not
        /// answer for attach: `launch == .ok` with an attach arm that never got an
        /// answer lit 可用（实测） on a machine that had never been asked the question
        /// the card exists to answer — the same substitution `DeveloperToolsVerdictTests`
        /// calls "一半的答案不许当另一半用".
        public var granted: Bool {
            if launch == .denied || attach == .denied { return false }
            return attach == .ok
        }
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
        /// 读者收尾窗口：子进程退出/被杀之后，管道要到写端全部关闭才落到 EOF。
        /// 正常情况下这在一瞬间；给 2s 上限是"探测不许把调用线程挂住"的下半句。
        static let drainGraceSeconds: TimeInterval = 2

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
            // 读管道与等退出必须**同时**进行。旧写法在轮询循环**之后**才
            // `readDataToEndOfFile()`：`lldb --batch` 的输出一旦超过管道的内核缓冲
            // （macOS 上 64 KiB），子进程就阻塞在自己的 write() 上，循环看到的
            // "还在跑"正是这个阻塞，于是到点 terminate，`classify` 把一次健康的调试
            // 席位判成 `.timeout`——而面板"验证调试能力"显示的就是那个结论。
            // 这里沿用本仓已经验证过的读者形状（`ConsoleModel.runDaemonCLI`：后台队列
            // 读到 EOF + 带时限的 `DispatchGroup.wait`）。两条流共用同一个 Pipe，
            // 所以一个读者就够，不存在"先写满第一路才写第二路"的交叉阻塞。
            let collected = PipeCollector()
            let reader = DispatchGroup()
            reader.enter()
            DispatchQueue.global(qos: .utility).async {
                collected.append(pipe.fileHandleForReading.readDataToEndOfFile())
                reader.leave()
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
            // 被杀掉的那一侧也会让读者落到 EOF；收尾窗口用尽就取已经拿到的部分——
            // 输出一段截过的文本，好过把探测挂在这里。这里**不**去 invalidate 那个
            // FileHandle：读者的 `readDataToEndOfFile()` 还在它上面阻塞着，关掉会是
            // 一次 use-after-close。后台块自己收尾、只往收集器里追加，没有别的作用。
            _ = reader.wait(timeout: .now() + Self.drainGraceSeconds)
            let text = String(data: collected.value, encoding: .utf8) ?? ""
            if text.hasPrefix("spawn failed:") { return (nil, false, text) }
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
    /// The floor for a victim's lifetime. It is a **floor, not the answer**: the victim
    /// is the fixture the probe measures through, and a fixture that expires before the
    /// measurement does is not a permission result (see `victimLifetimeSeconds`).
    static let attachVictimSeconds = 30
    /// victim 必须活得比这一侧的预算久，否则探测测到的是夹具的死亡而不是系统的答复。
    ///
    /// 从前 attach 用的 victim 是固定 30 秒的 `/bin/sleep`，而预算是 120 秒：一次合法
    /// 但慢的 attach（冷启动、弹窗后人再确认）会在 sleep 到点之后才跑起来，lldb 于是打
    /// `error: attach failed: no such process`——真机复现（`lldb --batch -p <已退出的 pid>`），
    /// 而 `classify` 从前见到 "attach failed" 就回 `.denied`，面板显示"被系统拒绝"。
    /// 一句夹具寿命的事实被写成了权限结论。
    static func victimLifetimeSeconds(forProbeBudget budget: TimeInterval) -> Int {
        Swift.max(attachVictimSeconds, Int(ceil(budget)))
    }

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
    ///
    /// `-p <pid>` is the flag lldb parses. The arm used to run `--attach <pid>`, which is
    /// not an option at all: lldb answers `error: unknown option: --attach`, the probe
    /// classified that as `.spawnFailed`, and the question this arm exists to answer
    /// ("can this machine attach a debugger?") was never asked. The same defect was found
    /// and fixed on the Python side of this repo (`bridge/glasspane_bridge.py:696-699`,
    /// "--attach 不存在…真机复验抓到这个参数缺陷"), and `engine/smoke.md:218-224` records
    /// the attach arm reading `{"state":"spawnFailed"}` while `granted:true`.
    public func probeAttach() -> Outcome {
        let victimLifetime = Self.victimLifetimeSeconds(forProbeBudget: timeout)
        guard let pidText = runner.spawnVictim(seconds: victimLifetime),
              let pid = Int32(pidText) else {
            return .spawnFailed
        }
        defer { runner.killVictim(pid) }
        let result = runner.run(
            "/usr/bin/xcrun",
            ["lldb", "--batch", "-p", pidText, "-o", "detach", "-o", "quit"],
            timeout: timeout
        )
        return Self.classify(result)
    }

    public func snapshot() -> Snapshot {
        Snapshot(launch: probeLaunch(), attach: probeAttach())
    }

    /// 夹具寿命的说法，不是权限的说法：victim 已经不在了，调试器自然"附加失败"，而这条
    /// 通道从头到尾没有对"这台机器允不允许调试"给出任何回答。
    /// 只列**明确指认进程不存在**的措辞；拒绝串（`Not allowed to attach` /
    /// `not permitted` / `(os/kern) failure`）仍然算拒绝。
    static let victimLifetimePhrases = ["no such process", "does not exist"]

    static func reportsVictimLifetime(_ text: String) -> Bool {
        let lowered = text.lowercased()
        return victimLifetimePhrases.contains { lowered.contains($0) }
    }

    /// Output-shape classification. Unknown failures surface as spawnFailed
    /// verbatim — never silently folded into a permission claim either way.
    ///
    /// 判据顺序：**拒绝先于成功**。旧顺序先测 `.ok`（含 "attached" 即算），于是
    /// `lldb` 一次"先挂上、随后失败"的输出（`Process 42 attached` 之后跟
    /// `error: attach failed: …`）被判成 `.ok`，把一次没成功的席位报成 granted——
    /// 而 `.denied` 那三条字符串就在下面几行等着，永远读不到。一句话里两个信号时，
    /// 说"系统不让"的那半句才是结论。
    ///
    /// 例外只有一条，就是上面那段：拒绝串里**先认出夹具寿命**的那一种。它不是"软化拒绝"
    /// ——一次没发生的拒绝被写成 `denied`，和一次没发生的成功被写成 `ok` 是同一种错。
    static func classify(_ run: (exit: Int32?, timedOut: Bool, output: String)) -> Outcome {
        let text = run.output
        if !reportsVictimLifetime(text),
           text.contains("Not allowed to attach") || text.contains("attach failed")
            || text.contains("not permitted") { return .denied }
        // 一次没跑完的会话不能因为"它中途说了句 attached"就被判成席位是通的：
        // 卡住被 terminate/SIGKILL 的那一趟，输出里最正常的就是那半句 attach。
        // 判据的顺序就是证据的优先级——先问"这台子是怎么结束的"，再问"它说了什么"。
        if run.timedOut { return .timeout }
        if run.exit == nil { return .spawnFailed }
        if let code = run.exit, code != 0 { return .spawnFailed }
        if text.contains("exited with status") { return .ok }
        if text.contains("attached") && !text.contains("Not allowed") { return .ok }
        return .spawnFailed
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
            case .spawnFailed: return ["state": "spawnFailed"]
            }
        }
        return [
            "capability": "developer-tools-debug",
            "launch": encode(snap.launch),
            "attach": encode(snap.attach),
            "granted": snap.granted,
            "note": "TCC 无公开查询 API；本结果是受限真实 lldb 探测的三态陈述。granted=false 的唯一人工步骤是系统设置勾选，验证/复验全由本命令承担。",
        ]
    }
}

/// 后台读者累加管道输出的地方：一把锁 + 一个 `Data`。
///
/// 面板侧的同形状是 `ConsoleModel.MutexBox`（在 `glasspane-settings` target 里，
/// 本 target 不依赖它，也不该为一个 20 行的盒子加依赖）。它存在的全部理由是
/// `ProcessRunner.run` 现在**边等退出边读**：读者在别的队列上，取值的一方在调用
/// 线程上，没有锁就是一次并发读写 `Data`。
private final class PipeCollector {
    private let lock = NSLock()
    private var storage = Data()

    func append(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.lock()
        storage.append(data)
        lock.unlock()
    }

    var value: Data {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
