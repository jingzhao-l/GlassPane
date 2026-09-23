import Foundation

// MARK: - Project Registry (P1 spec v1.4 §1.2)

/// In-memory + file-persisted registry of registered projects.
/// Atomic write via a per-writer unique temp file + `replaceItemAt`; the file is
/// loaded on init.
///
/// B-1 (daemon half, = A-15/R7-05): `save()` serialises the *whole* table, so a
/// registry that failed to load must never be written — the old shape decoded
/// with `try?` and returned on failure, which made a damaged projects.json
/// look like "0 projects" and let the next `create()` replace the file with a
/// one-entry table, destroying every other registration. The posture is the one
/// this repo already uses in `ApprovalGate` (`loadFailed`): the table still
/// loads empty, but the damage is recorded and every destructive write is
/// refused while it stands.
public final class ProjectRegistry {

    /// Default path for the projects file: the registry of the home-derived
    /// state root. Derived from `StateRoot` and not composed here, because the
    /// home lookup behind it ignores a `HOME` override — the location has to
    /// have one named source (X-22).
    public static let defaultProjectsPath = StateRoot.homeDefault().projectsFile

    public let filePath: String
    private var projects: [ProjectEntry] = []

    /// True when `filePath` existed but could not be read or decoded. Read
    /// surfaces (attach/project lookup) must answer "unmeasurable", never
    /// "no such project"; write surfaces refuse outright.
    public private(set) var loadFailed = false

    /// Why the load failed, phrased for the agent-facing message.
    public private(set) var loadFailure: String?

    public init(filePath: String = ProjectRegistry.defaultProjectsPath) {
        self.filePath = filePath
        load()
    }

    /// 生产注册表：`~/.glasspane/projects.json`（由 `StateRoot` 派生）。仅 daemon
    /// 与其一次性 CLI 子命令使用；任何测试构造它都应当被判为缺陷
    /// （`ProjectRegistryIsolationTests`）。单测侧必须注入临时目录
    /// （`Tests` 里的 `ephemeralProjectRegistry()`）。
    public static func live() -> ProjectRegistry {
        ProjectRegistry(filePath: defaultProjectsPath)
    }

    /// A registry over `<stateRoot>/projects.json` — the route `glasspaned`
    /// takes for every subcommand, so `--state-dir` cannot be honoured by one
    /// command and missed by another.
    public convenience init(stateRoot: StateRoot) {
        self.init(filePath: stateRoot.projectsFile)
    }

    /// All registered projects (snapshot). Empty when `loadFailed` — check the
    /// flag before presenting this as "no projects registered".
    public var all: [ProjectEntry] { projects }

    /// Current count.
    public var count: Int { projects.count }

    /// The unreadable registry as one agent-facing sentence, or nil when the
    /// registry is trustworthy. Shared by every refusal so the write side and
    /// the read side cannot describe the same damage differently.
    public var unreadableReport: String? {
        guard loadFailed else { return nil }
        return "projects.json at \(filePath) \(loadFailure ?? "could not be read")"
    }

    /// Executable repair path for an unreadable registry. Deliberately does
    /// **not** mirror the shell's `GLASSPANE_PROJECTS_FORCE_OVERWRITE` escape
    /// hatch: that variable is only parsed by `mcp-shell` (R7-14), and the
    /// daemon-side equivalent — move the damaged file aside yourself — needs no
    /// second hidden mode to keep the registrations recoverable.
    public var unreadableRemedy: String {
        "repair that file before anything writes to it again: print it with `python3 -m json.tool \(filePath)`, fix or restore the damaged entry, then restart the background service so it reloads the registry (`launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon`). To rebuild the registry from scratch instead — which costs every entry still in the unreadable file — move it aside first (`mv \(filePath) \(filePath).corrupt`) and retry."
    }

    /// Lookup by project ID.
    public func get(_ projectId: String) -> ProjectEntry? {
        projects.first { $0.projectId == projectId }
    }

    /// Create a new project entry. Returns the generated entry.
    @discardableResult
    public func create(
        displayName: String,
        bundleId: String? = nil,
        pid: Int32? = nil,
        recipeConfigPath: String? = nil,
        calibrationAssetsPath: String? = nil,
        evidenceStoragePath: String? = nil,
        now: () -> Date = { Date() }
    ) throws -> ProjectEntry {
        try requireWritable()
        guard projects.count < ProjectEntry.maxProjects else {
            throw GPError(
                code: .projectLimit,
                message: "project limit reached (\(ProjectEntry.maxProjects))"
            )
        }
        guard !displayName.isEmpty else {
            throw GPError(code: .badParams, message: "displayName must not be empty")
        }
        guard displayName.count <= ProjectEntry.maxDisplayNameLength else {
            throw GPError(
                code: .badParams,
                message: "displayName exceeds \(ProjectEntry.maxDisplayNameLength) characters"
            )
        }
        guard (bundleId == nil) != (pid == nil) else {
            throw GPError(
                code: .badParams,
                message: "exactly one of bundleId or pid is required"
            )
        }
        let entry = ProjectEntry(
            projectId: OperationID.generateProjectLive(),
            displayName: displayName,
            bundleId: bundleId,
            pid: pid,
            recipeConfigPath: recipeConfigPath,
            calibrationAssetsPath: calibrationAssetsPath,
            evidenceStoragePath: evidenceStoragePath,
            createdAt: isoString(now())
        )
        projects.append(entry)
        do {
            try save()
        } catch {
            projects.removeLast()
            throw error
        }
        return entry
    }

    /// Update an existing project entry.
    @discardableResult
    public func update(
        projectId: String,
        displayName: String? = nil,
        bundleId: String? = nil,
        pid: Int32? = nil,
        recipeConfigPath: String? = nil,
        calibrationAssetsPath: String? = nil,
        evidenceStoragePath: String? = nil
    ) throws -> ProjectEntry {
        try requireWritable()
        guard let index = projects.firstIndex(where: { $0.projectId == projectId }) else {
            throw GPError(
                code: .notFound,
                message: "unknown projectId \(projectId)"
            )
        }
        // Snapshotted before the first mutation, so a failed write cannot leave
        // an entry that only exists in this process.
        let previous = projects
        if let displayName {
            guard !displayName.isEmpty else {
                throw GPError(code: .badParams, message: "displayName must not be empty")
            }
            guard displayName.count <= ProjectEntry.maxDisplayNameLength else {
                throw GPError(
                    code: .badParams,
                    message: "displayName exceeds \(ProjectEntry.maxDisplayNameLength) characters"
                )
            }
            projects[index].displayName = displayName
        }
        if let bundleId { projects[index].bundleId = bundleId }
        if let pid { projects[index].pid = pid }
        if let recipeConfigPath { projects[index].recipeConfigPath = recipeConfigPath }
        if let calibrationAssetsPath { projects[index].calibrationAssetsPath = calibrationAssetsPath }
        if let evidenceStoragePath { projects[index].evidenceStoragePath = evidenceStoragePath }
        let entry = projects[index]
        do {
            try save()
        } catch {
            projects = previous
            throw error
        }
        return entry
    }

    /// Remove a project by ID. Returns true if found and removed.
    @discardableResult
    public func remove(_ projectId: String) throws -> Bool {
        try requireWritable()
        guard let index = projects.firstIndex(where: { $0.projectId == projectId }) else {
            throw GPError(
                code: .notFound,
                message: "unknown projectId \(projectId)"
            )
        }
        let previous = projects
        projects.remove(at: index)
        do {
            try save()
        } catch {
            projects = previous
            throw error
        }
        return true
    }

    // MARK: - Persistence

    /// Loads the registry. A missing file is "nothing registered yet"; an
    /// existing file that cannot be read or decoded is recorded as
    /// `loadFailed` (§B-1) instead of being returned as an empty table.
    private func load() {
        guard FileManager.default.fileExists(atPath: filePath) else { return }
        let data: Data
        do {
            data = try Data(contentsOf: URL(fileURLWithPath: filePath))
        } catch {
            loadFailed = true
            loadFailure = "cannot be read (\(error))"
            return
        }
        do {
            projects = try JSONDecoder().decode([ProjectEntry].self, from: data)
        } catch {
            // The table stays empty on purpose (ApprovalGate's posture), but the
            // flag makes "empty" mean "unreadable" everywhere it is used.
            loadFailed = true
            loadFailure = "is not a decodable project list (\(error))"
        }
    }

    /// Refuses a whole-file rewrite while the previous load failed: `save()`
    /// writes exactly what is in memory, so the write would replace a damaged
    /// but recoverable file with the handful of entries this process holds.
    private func requireWritable() throws {
        guard loadFailed else { return }
        throw GPError(
            code: .internalError,
            message: "\(unreadableReport ?? "projects.json exists but could not be decoded") — refusing to overwrite it, because this process is holding an empty table read from that unreadable file (writing it would replace every stored registration with the \(projects.count) entry/entries this process holds). Writes stay refused until the process restarts. Remedy: make the file readable again (restore it from a copy), then restart the background service so it re-reads: `node <repo>/installer/cli.js --restore-launchd`, or the restart button in the GlassPane panel.",
            remedy: unreadableRemedy
        )
    }

    /// Atomic write: a unique temp file, then `replaceItemAt`. Throws when the
    /// registry did not reach the disk — an in-memory-only table disappears at
    /// the next restart while every caller was just told the write succeeded.
    private func save() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data: Data
        do {
            data = try encoder.encode(projects)
        } catch {
            throw GPError(
                code: .internalError,
                message: "the project registry could not be encoded (\(error)); nothing was written to \(filePath)",
                remedy: "this is a daemon-side defect, not a parameter problem: report the registry fields you passed (displayName/bundleId/pid and the three paths) — one of them carries a value the encoder rejected — and re-run after fixing it"
            )
        }
        let destination = URL(fileURLWithPath: filePath)
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        // The temp name is unique per write: three processes rewrite this file
        // (the daemon, the one-shot CLI and the Node shell), and a shared
        // `<file>.tmp` lets one writer rename another's half-written buffer
        // into place.
        let tmpPath = "\(filePath).tmp-\(getpid())-\(UUID().uuidString)"
        let tmpURL = URL(fileURLWithPath: tmpPath)
        do {
            try data.write(to: tmpURL)
            // The registry lists every project this machine may act on, with
            // paths and bundle ids; the umask default (`0644`) made it readable
            // by every local account (R5-04). Tightened while it is still the
            // temp file, so the published name is never world-readable.
            if let defect = StateRoot.isolateFile(at: tmpPath) {
                throw GPError(
                    code: .internalError,
                    message: "the project registry temp file \(tmpPath) could not be made owner-only: \(defect); nothing was published to \(filePath)",
                    remedy: "the directory holding \(filePath) is on a volume that ignores chmod (read-only mount, ACL or immutable flag): make the directory owner-only writable, or move the state root with --state-dir to one that honors permissions; the registry was not written either way"
                )
            }
            // `replaceItemAt` is the primitive this repo already uses for
            // registry/approval-ledger writes: it moves the temp item into
            // place and hands back the previous contents as a backup URL.
            let backup = try FileManager.default.replaceItemAt(destination, withItemAt: tmpURL)
            // Drop only a *genuinely different* superseded copy. On a first write
            // (no previous file) the URL handed back can name the item that was
            // just placed; removing it silently destroyed the write while every
            // caller was told it succeeded (regression caught by the roundtrip
            // suite on 2026-09-23). `.orig` litter must never cost data.
            if let backup,
               backup.standardizedFileURL.path != destination.standardizedFileURL.path {
                try? FileManager.default.removeItem(at: backup)
            }
            // Belt: the table has to be readable back off disk before the caller
            // hears "saved" — an in-memory-only registry is invisible to the next
            // process and evaporates on restart.
            try verifySaved(destination, expecting: projects.count)
        } catch {
            // No silent fallback write: the caller hears that the registry did
            // not reach disk, and our own half-written temp file is removed (or
            // the removal failure is reported inline rather than swallowed).
            var litter = ""
            if FileManager.default.fileExists(atPath: tmpPath) {
                do {
                    try FileManager.default.removeItem(atPath: tmpPath)
                } catch let cleanupError {
                    litter = "; the partial temporary file \(tmpPath) could not be removed either (\(cleanupError))"
                }
            }
            throw GPError(
                code: .internalError,
                message: "project registry write to \(filePath) failed (\(error)); the file on disk is unchanged and the change was rolled back in memory\(litter)",
                remedy: "check that the directory is writable and has free space (`ls -ld \(destination.deletingLastPathComponent().path)`, `df -k \(destination.deletingLastPathComponent().path)`), fix it, then repeat the call — until then the registry in the running daemon and the file disagree"
            )
        }
    }

    /// Read the live file back and refuse to claim success when it does not hold
    /// what was just written. An in-memory-only table is invisible to the next
    /// process (and to `attach`, which resolves projectId against the reloaded
    /// registry), so "saved" has to mean "readable from disk".
    private func verifySaved(_ destination: URL, expecting count: Int) throws {
        let data: Data
        do {
            data = try Data(contentsOf: destination)
        } catch {
            throw GPError(
                code: .internalError,
                message: "the project registry write to \(filePath) did not land: the file cannot be read back (\(error)); the \(count) entry/entries exist only in this process",
                remedy: "check the directory (`ls -ld \(destination.deletingLastPathComponent().path)`, `df -k \(destination.deletingLastPathComponent().path)`); the write must be retried before any caller relies on this registration"
            )
        }
        guard let decoded = try? JSONDecoder().decode([ProjectEntry].self, from: data) else {
            throw GPError(
                code: .internalError,
                message: "the project registry at \(filePath) was written but does not decode (\(data.count) bytes); this process's table and the file are now different representations",
                remedy: "inspect the file (`python3 -m json.tool \(filePath)`); until it decodes, restart the background service so no process trusts an in-memory-only registry"
            )
        }
        guard decoded.count == count else {
            throw GPError(
                code: .internalError,
                message: "the project registry write to \(filePath) reads back \(decoded.count) entry/entries instead of \(count)",
                remedy: "another writer likely replaced the file concurrently; re-read the registry (`glasspaned --list-projects`) before repeating the change"
            )
        }
    }

    // MARK: - Helpers

    private static let isoFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f
    }()

    private func isoString(_ date: Date) -> String {
        Self.isoFormatter.string(from: date)
    }
}