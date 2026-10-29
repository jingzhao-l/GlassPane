import Foundation

// MARK: - State root (X-22: the one named entry for every mutable location)

/// The single directory a `glasspaned` process keeps its mutable state in, and
/// the **only** place that spells out what is inside it:
///
/// ```
/// <root>/evidence/     EvidenceStore archive (one pack per operation)
/// <root>/projects.json ProjectRegistry table
/// <root>/approvals.json ApprovalGate hash chain
/// <root>/probe.sock    default P6 probe listener
/// <root>/daemon.sock   engine socket of a daemon whose root was injected
/// ```
///
/// This type exists because the alternative — each state object composing
/// `NSHomeDirectory() + "/.glasspane"…` on its own — has already cost this
/// project data twice over. On macOS `NSHomeDirectory()` does **not** honour a
/// `HOME` override set by the caller, so "point HOME at a sandbox" does not
/// move any of those locations: a `swift test` run rewrote the developer's
/// real `projects.json` (71 registrations down to 2 synthetic ones,
/// unrecoverable) while every path in the suite looked sandboxed. The fix has
/// to be an *argument* a caller passes, not an environment variable it hopes
/// is read, and every derived location has to come from one value so a
/// subcommand cannot quietly resolve its own.
///
/// Deliberately a value type with no filesystem access: constructing one reads
/// and writes nothing.
public struct StateRoot: Equatable {

    /// Name of the per-user state folder under the home directory. Spelled
    /// here once so no other file in the module composes it again.
    static let folderName = ".glasspane"

    /// Canonical root path: absolute, with no trailing slash (the filesystem
    /// root "/" aside), so `<root>/<name>` joins the same way everywhere.
    public let path: String

    /// An injected root as named on the command line. Nothing on this path
    /// checks the filesystem: the daemon reports where it resolved state, it
    /// does not silently create, chmod or migrate anything.
    public init(path: String) {
        self.path = StateRoot.canonical(path)
    }

    /// The per-user state root — what every one of these locations meant
    /// before this type existed, and what they still mean when `--state-dir`
    /// was not given.
    ///
    /// A function and not a constant on purpose: the home lookup is a process
    /// property that a caller cannot influence (`HOME` is not consulted), so
    /// the one line that says "no root was named" has to be visible at every
    /// place that uses it.
    public static func homeDefault() -> StateRoot {
        StateRoot(path: NSHomeDirectory() + "/" + folderName)
    }

    // MARK: - Derived locations

    /// The evidence archive directory. Carries the trailing slash the store
    /// has always been given, so the value is byte-identical to the one
    /// `EvidenceStore` published before this type existed.
    public var evidenceDirectory: String { child("evidence") + "/" }

    /// The project registry table.
    public var projectsFile: String { child("projects.json") }

    /// The approval hash chain.
    public var approvalsFile: String { child("approvals.json") }

    /// launchd 那份 daemon 日志（`installer/cli.js` 的 `DAEMON_LOG_NAME` 是同一个名字，
    /// 由 `installer/test/log-modes.test.mjs` 反向钉住不许漂移）。它是状态根里唯一
    /// 由**别的进程**创建的文件：安装器现在按 0600 建，但 launchd 自己创建时走的是
    /// 进程 umask（实测 0644），而这份日志的内容是 daemon 的启动行、socket 路径、
    /// pid、连接/断开与权限判定——够另一个账号读出这台机器跑了什么。
    /// 从前这趟扫描管根目录、登记表、审批链与证据包，唯独不管它，文档只能请人手工
    /// chmod；现在它是被扫的对象之一。
    public var installerDaemonLogFile: String { child("installer-daemon.log") }

    /// 每日更新作业自己的日志（`updater/lib/launchd.js` 的 `update.log` 是同一个名字，
    /// 由 `installer/test/log-modes.test.mjs` 反向钉住不许漂移）。和上面那份同源同病：
    /// 它由 **launchd** 按进程 umask 创建（实测 0644），而它的内容是更新器每次
    /// check/apply 的 JSON——已装版本、暂存路径、摘要、tag、GPG 判定与拒绝理由，
    /// 另一个账号读它就读到了这台机器装了什么、更新到哪一步、被什么挡住。
    /// 更新器自己的 `fsutil` 收紧它写的所有文件，唯独不建这个：写的人是 launchd。
    public var updateLogFile: String { child("update.log") }

    /// Default probe listener path (`--probe-socket-path` overrides it).
    public var probeSocketFile: String { child("probe.sock") }

    /// Engine socket of a daemon that **named** its state root. A daemon that
    /// named none keeps the historic `engine.sock` name — see
    /// `engineSocketPath(explicitSocketPath:stateRoot:)`, which is the single
    /// place that rule is written down.
    public var daemonSocketFile: String { child("daemon.sock") }

    /// Where the engine protocol socket is, given what the caller passed.
    /// One implementation shared by `glasspaned` and the settings panel, so
    /// the panel cannot point itself at a different daemon than the daemon
    /// points itself at.
    ///
    /// Precedence is the ordinary one: an explicit `--socket-path` wins, then
    /// the socket that belongs to a named state root, then the historic
    /// home-derived default (whose leaf name stays `engine.sock` — this
    /// function does not rename the socket of an existing installation).
    public static func engineSocketPath(
        explicitSocketPath: String?, stateRoot: StateRoot?
    ) -> String {
        if let explicitSocketPath { return explicitSocketPath }
        if let stateRoot { return stateRoot.daemonSocketFile }
        return homeDefault().child("engine.sock")
    }

    /// `<root>/<name>` without ever producing a doubled slash.
    private func child(_ name: String) -> String {
        path.hasSuffix("/") ? path + name : path + "/" + name
    }

    // MARK: - Ownership-only permissions (R5-04)

    /// Bring one existing file to owner-only (`0600`) and **verify it after the
    /// fact**, returning nil on success or the reason it is still reachable.
    ///
    /// This exists because the modes the project documents (`0700` directory,
    /// `0600` files) were only ever applied to what a call *creates*:
    /// `createDirectory(attributes:)` does not touch an existing directory and
    /// `Data.write(.atomic)` creates with the process umask, so an installation
    /// that predates the rule — or one whose `~/.glasspane` was made by the MCP
    /// shell — kept `projects.json`, `approvals.json` and every evidence pack at
    /// `0644`, readable by every local account, while the code believed the
    /// invariant held. `SECURITY.md` and P0 §3.5 state the modes as fact, so
    /// leaving the existing files alone is not a neutral choice.
    ///
    /// Nothing is created here and nothing is deleted: a missing path returns
    /// nil (there is no exposure in a file that is not there), and a file the
    /// caller cannot chmod is reported, not "recreated".
    /// `lstat` only: a leaf that is a symlink has no mode this sweep may claim to have
    /// tightened, because chmod would act on whatever it points at. Absent is not a
    /// defect (the writers create it); a link is, and it is said rather than followed.
    static func leafSymlinkDefect(_ directory: String) -> String? {
        var info = stat()
        guard lstat(directory, &info) == 0 else { return nil }
        guard (info.st_mode & S_IFMT) == S_IFLNK else { return nil }
        return "\(directory) is a symlink — its owner-only mode cannot be set without acting on "
            + "the file or directory it points at, which this root does not own. Nothing was chmod-ed here; "
            + "point --state-dir at a real directory this account owns"
    }

    public static func isolateFile(at path: String) -> String? {
        // One probe, two very different failures, and the difference is read out
        // of the error rather than from a second `fileExists` call: a file that
        // is **not there** is nothing to isolate (the startup sweep runs against
        // paths a fresh install has not written yet — `approvals.json` appears on
        // the first approval), while a file that **cannot be examined** is
        // exactly as unable to prove 0600 as one that was never tightened.
        // Testing `fileExists` first would fold the second case into the first:
        // an unreadable parent directory makes `fileExists` answer "no", and
        // "no such file" is not evidence that nothing is world-readable.
        let attributes: [FileAttributeKey: Any]
        do {
            attributes = try FileManager.default.attributesOfItem(atPath: path)
        } catch let error as NSError
        where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
            return nil
        } catch {
            return "\(path) cannot be examined (\(error.localizedDescription)) — isolation unproven"
        }
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
            return "\(path) is not a regular file — left untouched"
        }
        let before = (attributes[.posixPermissions] as? NSNumber)?.int16Value ?? -1
        if before & 0o077 == 0 { return nil }
        if chmod(path, mode_t(0o600)) != 0 {
            return "chmod(0600) \(path) failed: \(String(cString: strerror(errno)))"
        }
        let after = (try? FileManager.default.attributesOfItem(atPath: path)) ?? [:]
        guard !after.isEmpty else {
            return "\(path) cannot be read back after chmod — isolation unverified"
        }
        let mode = (after[.posixPermissions] as? NSNumber)?.int16Value ?? -1
        guard mode == 0o600 else {
            return "\(path) is still \(String(format: "%04o", Int(mode))) after chmod(0600)"
        }
        return nil
    }

    /// Whether a directory is safe to *receive* a file this process is about to
    /// hand to another executor (a `launchctl submit` one-shot, a report the
    /// browser will open). Read-only by design: it never chmods, because a
    /// directory the caller does not own is not the caller's to rewrite.
    ///
    /// This exists as one predicate because two of its consumers had already
    /// grown separate hand-rolled versions of the same four checks, and the
    /// third (`runOneShot`, which writes a script that launchd then executes
    /// under the daemon's own responsibility context) had **none** — it created
    /// the directory with the process umask and trusted whatever name it picked,
    /// so a `$TMPDIR` redirected into a shared location let any other account
    /// pre-plant the script or output path that the daemon would then write.
    public enum DirectoryIsolation: Equatable {
        case usable
        case missing
        case notADirectory
        case ownedBy(uid: UInt32)
        case sharedWritable(mode: Int)
    }

    public static func directoryIsolation(at path: String) -> DirectoryIsolation {
        var info = stat()
        guard stat(path, &info) == 0 else { return .missing }
        guard info.st_mode & S_IFMT == S_IFDIR else { return .notADirectory }
        guard info.st_uid == getuid() else { return .ownedBy(uid: info.st_uid) }
        guard info.st_mode & 0o022 == 0 else {
            return .sharedWritable(mode: Int(info.st_mode & 0o777))
        }
        return .usable
    }

    /// Bring the root, its archive directory and the state files inside them to
    /// owner-only, reporting every step. Called once at daemon start, so the
    /// long-lived process that writes the archive is also the one that closes
    /// the pre-existing exposure — and so an operator sees in the log which
    /// paths were tightened by this run rather than discovering it from a
    /// permission error months later.
    ///
    /// Returns the lines it would want a reader to act on (empty when the whole
    /// root is already isolated). It never throws: a directory it cannot tighten
    /// is not a reason to refuse to *start*, and the writers keep refusing
    /// individually (`EvidenceStore.ensureIsolatedDirectory` refuses the write),
    /// so this sweep hardens what it can and says exactly what it could not.
    @discardableResult
    public func tightenPermissions(log: EngineLog) -> [String] {
        var notes: [String] = []
        // `stat`/`chmod` both follow the leaf symlink, so a `--state-dir` naming
        // `~/.glasspane -> /somewhere/else` would tighten the *target* tree and then
        // exit 1 on the bind refusal — a run that changes nothing, changing something.
        // The two writers already refuse this shape (`SocketDirectoryRule` for the
        // socket parent, `EvidenceStore.nameIsUsableArchiveDirectory` for the archive);
        // the sweep holds the same line, measured with `lstat` before any chmod.
        if let defect = Self.leafSymlinkDefect(path) {
            log.error("state permission not isolatable — \(defect)")
            return [defect]
        }
        var info = stat()
        if stat(path, &info) == 0 {
            if chmod(path, mode_t(0o700)) != 0 {
                notes.append("state root \(path): chmod(0700) failed: \(String(cString: strerror(errno)))")
            } else {
                var after = stat()
                let mode = stat(path, &after) == 0 ? Int(after.st_mode & 0o777) : -1
                if mode != 0o700 {
                    notes.append("state root \(path): mode is \(String(format: "%04o", mode)), not 0700")
                }
            }
        } else {
            // The root does not exist yet: every writer creates it with 0700
            // attributes, and saying so here keeps "nothing to do" distinct from
            // "did not look".
            log.info("state root \(path) does not exist yet — nothing to tighten")
            return []
        }
        // The archive directory is judged before it is walked: a symlink there would
        // send the file sweep into a tree this root does not own.
        let archiveDefect = Self.leafSymlinkDefect(evidenceDirectory)
        let files = [projectsFile, approvalsFile, installerDaemonLogFile, updateLogFile]
            + (archiveDefect == nil ? Self.jsonFiles(in: evidenceDirectory) : [])
        for file in files {
            if let defect = Self.isolateFile(at: file) {
                notes.append(defect)
            }
        }
        // The archive directory itself (0700), separate from the root.
        if let defect = archiveDefect {
            notes.append(defect)
        } else if stat(evidenceDirectory, &info) == 0, chmod(evidenceDirectory, mode_t(0o700)) != 0 {
            notes.append("evidence directory \(evidenceDirectory): chmod(0700) failed: \(String(cString: strerror(errno)))")
        }
        for note in notes {
            log.error("state permission not isolatable — \(note)")
        }
        if notes.isEmpty {
            log.info("state root \(path): permissions tightened to owner-only (0700 dirs, 0600 files)")
        }
        return notes
    }

    /// The archive entries this sweep may tighten: exactly the names
    /// `EvidenceStore` writes (`isEntryName`), so a stray file in the directory
    /// is left alone rather than being renamed into the archive's shape.
    private static func jsonFiles(in directory: String) -> [String] {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            atPath: directory
        ) else { return [] }
        return entries
            .filter { EvidenceStore.isEntryName($0) }
            .map { directory + "/" + $0 }
    }

    /// Drops redundant trailing slashes so `/tmp/x/` and `/tmp/x` are the same
    /// root (and `Equatable` says so). Symlinks, `..` and the home-vs-`$HOME`
    /// question are **not** resolved here: the smoke gates compare paths with
    /// `realpath` after asking the daemon what it used, which keeps this
    /// function pure and the measurement honest.
    private static func canonical(_ raw: String) -> String {
        guard raw.count > 1 else { return raw }
        var end = raw.endIndex
        while end > raw.startIndex, raw[raw.index(before: end)] == "/" {
            end = raw.index(before: end)
        }
        // "/" itself: every character was a slash, so keep the one.
        return end == raw.startIndex ? "/" : String(raw[..<end])
    }
}

// MARK: - Command-line shape

/// The verdict on a `--state-dir` argument, as one pure function so the
/// refusing branch is executable in a test (`glasspaned`'s own
/// `parseArguments` is top-level code in an executable target and cannot be
/// imported). `main.swift` maps `.rejected` onto its existing usage-error
/// route: message to stderr, usage printed, exit 64.
public enum StateRootArgument: Equatable {

    /// A usable root.
    case named(StateRoot)

    /// Why this argument is not a root, phrased to follow the flag name.
    case rejected(String)

    /// The whole rule set lives in `classify`, so the verdict and the reason
    /// it reports cannot drift apart.
    private enum Outcome {
        case usable(String)
        case refused(String)
    }

    /// `raw` is the token that followed the flag, or `nil` when nothing did.
    public init(raw: String?) {
        switch StateRootArgument.classify(raw) {
        case .usable(let value):
            self = .named(StateRoot(path: value))
        case .refused(let reason):
            self = .rejected(reason)
        }
    }

    /// Why `raw` cannot name a state root, or nil when it can. Exposed for the
    /// test suite; `main.swift` only needs the message, which it gets from
    /// `.rejected(reason)`.
    public static func rejection(for raw: String?) -> String? {
        guard case .refused(let reason) = classify(raw) else { return nil }
        return reason
    }

    /// Refusal shape follows `--probe-socket-path` (a value that is another
    /// flag is not a value), plus the one extra rule this argument needs: a
    /// relative path would mean a different state root depending on the
    /// working directory the daemon happened to be started in, which is the
    /// opposite of naming where your state lives. An empty value is refused
    /// before the absolute-path rule because its message would be useless.
    private static func classify(_ raw: String?) -> Outcome {
        guard let raw else {
            return .refused("requires a path (nothing followed the flag)")
        }
        guard !raw.hasPrefix("--") else {
            return .refused("requires a path, got what looks like another argument (\(raw))")
        }
        guard !raw.isEmpty else {
            return .refused("requires a path, got an empty string")
        }
        guard raw.hasPrefix("/") else {
            return .refused("must be an absolute path, got \(raw)")
        }
        // The shape rules above are all this argument had, and the sweep the daemon
        // runs 20 lines after resolving it (`tightenPermissions`) chmods **whatever
        // root it names** to 0700 before any later usability refusal. So
        // `--state-dir ~` used to lock the user's home directory — files, Desktop,
        // everything a group or other bit reached — and still bind, and `--state-dir /`
        // reached `chmod("/", 0700)`. A root this product does not own is not a state
        // root, so it is refused here, at the argument, where nothing has been touched
        // yet. The precedent for the rule is this repo's own `isSubmittablePath`
        // (`PermissionStatus.swift`), which refuses `/` for the same reason.
        if let defect = Self.notADedicatedRoot(raw) {
            return .refused(defect)
        }
        return .usable(raw)
    }

    /// Why `raw` cannot serve as *this* product's state root even though it is a
    /// well-formed absolute path: the filesystem root, or the account's home
    /// directory itself. `nil` means the path is dedicated enough to tighten.
    ///
    /// Trailing slashes and `~`-normalised spellings are folded onto the same
    /// comparison because that is what `StateRoot(path:)` does with them: a refusal
    /// that only catches one spelling is a refusal the next typo walks past.
    public static func notADedicatedRoot(_ raw: String) -> String? {
        switch dedicatedness(raw) {
        case .dedicated:
            return nil
        case .filesystemRoot:
            return "would be the filesystem root — the daemon tightens the root it is given to 0700, and it has no business changing the permissions of `/`. Name a directory this install owns, e.g. `--state-dir \(RemedyCommand.quote(NSHomeDirectory() + "/.glasspane"))`"
        case .homeDirectory(let home):
            // Deliberately NOT `ProcessInfo.environment["HOME"]`: `mcp-shell/test/path-consistency.test.mjs`
            // pins that the daemon's home comes from the passwd entry and that a `HOME`
            // override moves nothing, and the shell mirrors that rule. Consulting `$HOME` here
            // would make the refusal depend on the environment while the root the daemon
            // actually defaults to does not — one typo, two answers about where state lives.
            return "would be the home directory itself — the daemon tightens the root it is given to 0700 and writes its socket, registry and archive under it, so this would re-permission everything in \(home) and scatter engine files beside the user's own. Name a directory for the engine's state, e.g. `--state-dir \(RemedyCommand.quote(home + "/.glasspane"))`"
        }
    }

    /// The one measurement behind both refusals: is this path a location this
    /// product owns, or is it home / the filesystem root?
    ///
    /// Split out of the sentences above because the *same hazard* now has two
    /// entry points (`--state-dir`, and the parent directory of `--socket-path`
    /// / `--probe-socket-path`) and those two must not own two copies of the
    /// predicate — that is exactly the shape 2026-10-29 S4-3 found: `--state-dir ~`
    /// was refused, `--socket-path "$HOME/engine.sock"` was not, and both end in
    /// a `chmod(0700)`. Each entry point writes its own next step from this
    /// verdict; the verdict itself has one home.
    private static func dedicatedness(_ raw: String) -> Dedicatedness {
        var normalized = raw
        while normalized.count > 1, normalized.hasSuffix("/") {
            normalized.removeLast()
        }
        if normalized == "/" { return .filesystemRoot }
        for home in Array(Set([
            NSHomeDirectory(),
            FileManager.default.homeDirectoryForCurrentUser.path,
        ])) {
            var root = home
            while root.count > 1, root.hasSuffix("/") { root.removeLast() }
            if normalized == root { return .homeDirectory(home) }
        }
        return .dedicated
    }

    private enum Dedicatedness {
        case dedicated
        case filesystemRoot
        case homeDirectory(String)
    }

    /// Why `raw` cannot serve as a **socket** name: the listener chmods the
    /// directory holding it to 0700 (`SocketServer.prepareSocketDirectory` →
    /// `SocketDirectoryRule.enforce`), so a socket sitting directly in the home
    /// directory or in `/` re-permissions a tree this engine does not own — the
    /// identical hazard `notADedicatedRoot` already refuses for `--state-dir`,
    /// measured on `deletingLastPathComponent` instead of on the root itself.
    ///
    /// `nil` when the parent is dedicated enough to receive a socket, which
    /// includes the default layout (`~/.glasspane/engine.sock`: the parent is the
    /// engine's own folder, not the home directory). Empty parent (a bare name) is
    /// answered by `classify` — the absolute-path rule — and is not re-refused here.
    public static func rejectionForSocketParent(of raw: String) -> String? {
        let directory = (raw as NSString).deletingLastPathComponent
        guard !directory.isEmpty else { return nil }
        switch dedicatedness(directory) {
        case .dedicated:
            return nil
        case .filesystemRoot:
            return "would put the socket directly in `/` — this run brings the directory holding a socket to 0700 before it binds, and `/` is not this install's directory to re-permission. Put the socket inside a directory this install owns, e.g. let it default under --state-dir, or pass --socket-path \(RemedyCommand.quote(NSHomeDirectory() + "/.glasspane/engine.sock"))"
        case .homeDirectory(let home):
            return "would put the socket directly in the home directory \(home) — this run brings the directory holding a socket to 0700 before it binds, which would re-permission everything the user owns and drop engine files beside their own. Put the socket inside the engine's own directory, e.g. --socket-path \(RemedyCommand.quote(home + "/.glasspane/engine.sock")), or name --state-dir and let the socket default to living under it"
        }
    }
}

// MARK: - One value per run (2026-10-29 S4-1)

/// The ledger of value-taking flags this run has already been handed, and the
/// refusal when one of them arrives a second time.
///
/// WHY THIS EXISTS. `glasspaned --state-dir A --state-dir B --list-projects`
/// measured on the shipped binary: exit 0, `A` dropped without a word, stderr
/// zero bytes. `--project-remove idA --project-remove idB` removed (the attempt
/// at) `idB` only, exit 3, and never mentioned `idA`. Neither answer was written
/// down anywhere: "the last one wins" is what a second assignment to
/// `options.stateDir` does by accident, and it contradicts this module's own
/// opening sentence — `--state-dir` is the one named entry for the state root,
/// one run resolves exactly one. A caller that believes it is working in a
/// sandbox while the first root was discarded is one `--prune-evidence` away from
/// deleting in somebody's real archive.
///
/// WHY IT LIVES HERE. `parseArguments` is top-level code in an executable target
/// and no visibility reaches it (the same reason `StateRootArgument` exists), so
/// without a judge in this module the refusing branch would be unexecutable in a
/// test. `main.swift` asks this ledger at every value it accepts, and the flag
/// list below is the only table it asks with — a test counts the table instead of
/// restating it.
///
/// Membership rule: only flags that **carry a value** are here. A boolean flag
/// spelled twice states the same thing twice and loses nothing; a value given
/// twice is a value that was silently thrown away.
public struct ValueFlagLedger: Equatable {

    /// Flags a single run may be given exactly once, and the one thing each of
    /// them resolves. Every entry must be a case label `parseArguments` reads a
    /// value for — `DailyRound20261029Swift3` pins that pairing both ways.
    public static let onePerRun: [String: String] = [
        "--state-dir": "root",
        "--socket-path": "engine socket path",
        "--probe-socket-path": "probe socket path",
        "--older-than": "day count",
        "--project": "project scope",
        "--project-remove": "project id",
        "--active-project": "project id",
        "--recipe-validate": "recipe path",
        "--request-permission": "permission seat",
    ]

    /// The value already recorded for each flag, in the spelling the caller used.
    public private(set) var seen: [String: String] = [:]

    public init() {}

    /// Record `value` for `flag`, or return the refusal when this run already
    /// named that flag. Flags outside `onePerRun` are not this ledger's business
    /// and are recorded nowhere.
    ///
    /// The refusal is returned **instead of** keeping the later value: the whole
    /// point is that this run cannot decide which of the two the caller meant, so
    /// answering one of them would be the defect wearing a message.
    public mutating func note(flag: String, value: String) -> String? {
        guard let noun = Self.onePerRun[flag] else { return nil }
        guard let prior = seen[flag] else {
            seen[flag] = value
            return nil
        }
        return Self.rejection(flag: flag, noun: noun, prior: prior, value: value)
    }

    /// The sentence itself, split out so a test can read both branches (the two
    /// values differ; the caller repeated the same value) without going through
    /// argv. Names **both** values, because "which one won" is exactly the half a
    /// caller cannot see, and ends with the edit that fixes the invocation.
    public static func rejection(flag: String, noun: String, prior: String, value: String) -> String {
        var message = "\(flag) given twice (\(prior) / \(value)) — one run resolves exactly one \(noun), "
        if prior == value {
            message += "and this invocation only states it twice. Nothing was lost, but the run would "
                + "have picked one of the two silently, so it answers nothing here. Next step: pass "
                + "\(flag) once, with the \(noun) you want."
        } else {
            message += "and the last spelling wins only by being last: nothing the first one asked for "
                + "would have happened, and nothing said so. Next step: pass \(flag) once, with the "
                + "\(noun) this run should use."
        }
        return message
    }
}

// MARK: - Remedy command text

/// POSIX quoting for a value this product puts inside a backticked command in an
/// error's `remedy:` / `next:` line.
///
/// WHY THIS EXISTS. A remedy is not prose here: `specs` and the MCP contract both
/// define it as the command an agent runs. The daemon's own paths travel into those
/// lines — `chmod 600 <projects.json>`, `python3 -m json.tool <approvals.json>`,
/// `mv <file> <file>.corrupt` — and the path is only partly this process's choice:
/// `--state-dir` is a command-line value, and the state root is published in `hello`
/// for anything that can reach the socket. Before this helper existed, a value
/// containing `;`, `$(` or a quote turned the *repair instruction* into whatever the
/// shell reading it would execute. Escaping it here is what makes the same string
/// both a usable command and inert data.
public enum RemedyCommand {

    /// `value` as one single-quoted shell word: `'` becomes `'\''`, and a value with
    /// no metacharacters still gets quotes so a space cannot split one argument into
    /// two. Empty input becomes `''` — a quoted nothing is still a nothing the shell
    /// can see, which is not the same as an argument that vanished.
    public static func quote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
