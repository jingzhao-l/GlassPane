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

    /// The registry's home-derived path, as a **value with no default behind
    /// it**: the routes to it are the named factory below or a caller that
    /// spells it out, because a `filePath:` default silently handed every
    /// location-less construction — including a test helper forwarding its own
    /// optional — the developer's real `projects.json`, which is how 71 live
    /// registrations were replaced by two synthetic ones (R7-02/B2).
    public static let defaultProjectsPath = StateRoot.homeDefault().projectsFile

    public let filePath: String
    private var projects: [ProjectEntry] = []

    /// True when `filePath` existed but could not be read or decoded. Read
    /// surfaces (attach/project lookup) must answer "unmeasurable", never
    /// "no such project"; write surfaces refuse outright.
    public private(set) var loadFailed = false

    /// Why the load failed, phrased for the agent-facing message.
    public private(set) var loadFailure: String?

    /// The cheap identity of the bytes this process last read: modification time
    /// (to the nanosecond) plus size. nil when there was no file at load.
    ///
    /// `save()` serialises the *whole* table and `verifySaved` can only compare
    /// the count this process just wrote, so without a baseline here a file
    /// changed by another writer in between — `glasspaned --project-prune` is a
    /// documented one — was silently reverted by the long-lived daemon's next
    /// create/update, and that create still reported success.
    private var loadedIdentity: OnDiskIdentity?

    /// The table lives where the caller says it lives — there is no default.
    ///
    /// `filePath:` is required (P8, the shape `EvidenceStore.init(directory:)`
    /// already has): an argument left *out* is not a location anybody chose, and
    /// on this type the un-chosen location was the developer's own registry.
    public init(filePath: String) {
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

    /// The **only** way to bind a registry to `defaultProjectsPath` by name.
    /// Kept named on purpose: reaching the per-user table is a decision a reader
    /// has to see at the call site, not the outcome of leaving an argument out —
    /// and `TestIsolationGateTests` bans this name anywhere under `engine/Tests`.
    public static func atProductionDefault() -> ProjectRegistry {
        ProjectRegistry(filePath: ProjectRegistry.defaultProjectsPath)
    }

    /// All registered projects (snapshot). Empty when `loadFailed` — check the
    /// flag before presenting this as "no projects registered".
    public var all: [ProjectEntry] { projects }

    /// What a reader may actually publish about the table. Two shapes that look
    /// identical through `all` — "nothing is registered" and "the file cannot be
    /// read" — are separated here, because every surface that prints a list has
    /// to say which of the two it measured. `glasspaned --list-projects` used to
    /// print `[]` + exit 0 for the second case.
    public enum RegistryListing {
        case registered([ProjectEntry])
        case unreadable(reason: String)
    }

    public func listing() -> RegistryListing {
        if loadFailed {
            return .unreadable(reason: unreadableReport ?? "projects.json at \(filePath) could not be read")
        }
        return .registered(projects)
    }

    /// The read-back verdict a destructive command is allowed to report:
    /// `removed` may only ever mean "this process re-read the disk and the entry
    /// is not on it". An unreadable read-back answers nothing, and reporting
    /// `removed: true` there is the false success this function exists to stop —
    /// `all` is empty in exactly that case, so a bare `!all.contains(…)` is
    /// always true when nothing can be seen.
    public func removalVerdict(projectId: String) -> (answerable: Bool, removed: Bool) {
        if loadFailed { return (false, false) }
        // 读不回文件不等于看见它空了。`load()` 把"文件不存在"当成"还没注册任何东西"，
        // 那对**读侧**（`--list-projects` 刚开机时确实没表）是对的；对**写后回读**是同一种
        // 撒谎的另一张脸：一次没落盘的写、或事后被人整份删掉的表，都会让 `projects` 是空的，
        // 于是 `!contains` 恒真，命令就报"确认已删除"并退 0。看不见盘的时候，唯一诚实的回答
        // 是不回答——CLI 那侧回的是 exit 1 + `loadFailed`，与读不开同一条路径。
        guard FileManager.default.fileExists(atPath: filePath) else { return (false, false) }
        return (true, !projects.contains { $0.projectId == projectId })
    }

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
        // The identity is taken from the bytes just read, so a refusal can only
        // be raised for a change this process did not make itself. A write that
        // lands between the read and this stat is not seen: this narrows the
        // window from "the whole life of the daemon" to one read, it does not
        // close it.
        loadedIdentity = Self.identity(ofPath: filePath)
        do {
            projects = try JSONDecoder().decode([ProjectEntry].self, from: data)
        } catch {
            // The table stays empty on purpose (ApprovalGate's posture), but the
            // flag makes "empty" mean "unreadable" everywhere it is used.
            loadFailed = true
            loadFailure = "is not a decodable project list (\(error))"
        }
    }

    /// What "changed since this process read it" is measured against: mtime to
    /// the nanosecond plus size. Nothing is hashed — a full-table prune is
    /// microseconds of work next to a `replaceItemAt`, and the pair is enough to
    /// notice a rewrite by someone else.
    private struct OnDiskIdentity: Equatable {
        let modificationNs: Int64
        let size: Int64
    }

    /// nil when the path cannot be stat'ed — which is "the file is gone", and
    /// that is a change too (see `requireUnchangedSinceLoad`).
    private static func identity(ofPath path: String) -> OnDiskIdentity? {
        var info = stat()
        guard stat(path, &info) == 0 else { return nil }
        return OnDiskIdentity(
            modificationNs: Int64(info.st_mtimespec.tv_sec) * 1_000_000_000
                + Int64(info.st_mtimespec.tv_nsec),
            size: Int64(info.st_size)
        )
    }

    /// Refuse to publish the in-memory table over bytes this process never read.
    ///
    /// The other writer here is not hypothetical: `glasspaned --project-prune`
    /// and `--project-remove` are one-shot processes over the same file, and the
    /// reply they print already says `requiresDaemonRestart`. Renaming over their
    /// result would put the pruned registrations back and report the create as
    /// verified, because `verifySaved` only counts what this process wrote.
    private func requireUnchangedSinceLoad() throws {
        let current = Self.identity(ofPath: filePath)
        guard current != loadedIdentity else { return }
        throw ConcurrentWriteRefusal(
            detail: current == nil
                ? "it is gone: the file this process read (\(loadedIdentity.map { "\($0.size) bytes" } ?? "no file at all")) is no longer there"
                : "it now holds \(current?.size ?? -1) bytes with a newer modification time than the \(loadedIdentity.map { "\($0.size) bytes" } ?? "file this process read did not exist") it was read with"
        )
    }

    /// The refusal itself, carried as its own type so the generic `catch` below
    /// — which reports disk faults and rolls the table back — cannot rewrite "a
    /// concurrent writer owns this file now" into "the write failed".
    private struct ConcurrentWriteRefusal: Error {
        let detail: String
    }

    /// Drop the staged copy on the way out of a failed write, reporting the case
    /// where even that does not work instead of swallowing it — a `.tmp-*` left
    /// in the state root is a table nobody asked for.
    private func discardStagedCopy(_ tmpPath: String) -> String {
        guard FileManager.default.fileExists(atPath: tmpPath) else { return "" }
        do {
            try FileManager.default.removeItem(atPath: tmpPath)
            return ""
        } catch let cleanupError {
            return "; the partial temporary file \(tmpPath) could not be removed either (\(cleanupError))"
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
            // temp file, so the name that is *created* is never world-readable —
            // and the published name is judged again after the rename below,
            // because a replacement keeps the mode of what it replaced.
            if let defect = StateRoot.isolateFile(at: tmpPath) {
                throw GPError(
                    code: .internalError,
                    message: "the project registry temp file \(tmpPath) could not be made owner-only: \(defect); nothing was published to \(filePath)",
                    remedy: "the directory holding \(filePath) is on a volume that ignores chmod (read-only mount, ACL or immutable flag): make the directory owner-only writable, or move the state root with --state-dir to one that honors permissions; the registry was not written either way"
                )
            }
            // Last look before the item is published: everything above this line
            // touched only our own temporary name.
            try requireUnchangedSinceLoad()
            // `replaceItemAt` is the primitive this repo already uses for
            // registry/approval-ledger writes: it moves the temp item into
            // place and hands back the previous contents as a backup URL.
            let backup = try FileManager.default.replaceItemAt(destination, withItemAt: tmpURL)
            // The table on disk is now *this* process's bytes, so the baseline
            // moves with them — otherwise the next legitimate write would refuse
            // against a change this registry itself made.
            loadedIdentity = Self.identity(ofPath: filePath)
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
        } catch let clash as ConcurrentWriteRefusal {
            // The refusal is the outcome, so it is reported as itself: the staged
            // copy goes, the file stays exactly as the other writer left it, and
            // the in-memory table is rolled back by the caller (`create`,
            // `update`, `remove` all undo a throwing write).
            throw GPError(
                code: .internalError,
                message: "project registry write to \(filePath) refused: the file changed after this process read it (\(clash.detail)) — nothing was published, because renaming the \(projects.count) entry/entries this process holds over it would silently revert the other writer's result while every caller was told this write verified. Writes stay refused until a process re-reads the file\(discardStagedCopy(tmpPath))",
                remedy: "re-read the table (`glasspaned --list-projects`) and repeat the change against what is on disk now; the background service has to restart to pick the file up (`launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon`, or the restart button in the GlassPane panel). Do not delete \(filePath) — the newer registrations are only in it"
            )
        } catch {
            // No silent fallback write: the caller hears that the registry did
            // not reach disk, and our own half-written temp file is removed (or
            // the removal failure is reported inline rather than swallowed).
            throw GPError(
                code: .internalError,
                message: "project registry write to \(filePath) failed (\(error)); the file on disk is unchanged and the change was rolled back in memory\(discardStagedCopy(tmpPath))",
                remedy: "check that the directory is writable and has free space (`ls -ld \(destination.deletingLastPathComponent().path)`, `df -k \(destination.deletingLastPathComponent().path)`), fix it, then repeat the call — until then the registry in the running daemon and the file disagree"
            )
        }
        // The table is on disk and reads back; the last thing that can still be
        // false is *who can read it*. `replaceItemAt` hands the destination's
        // attributes to the item that lands (measured on APFS: a 0644
        // destination stays 0644 when an 0600 temp file replaces it), so a
        // registry that predates R5-04 — or one first created by the MCP shell,
        // which uses the default mode — keeps that mode through every rewrite
        // while the temp file's check reports success. Judged here, on the
        // published name: the normal volume answers by tightening it, and a
        // volume that will not is refused out loud instead of silently keeping a
        // world-readable project list.
        if let defect = StateRoot.isolateFile(at: filePath) {
            throw GPError(
                code: .internalError,
                message: "the project registry at \(filePath) landed but is not owner-only: \(defect) — every local account can read the project list this daemon acts on, and the write is reported as failed rather than as saved",
                remedy: "chmod 600 \(filePath) and make its directory owner-only (`ls -ld \(destination.deletingLastPathComponent().path)`); if the volume still ignores chmod (read-only mount, ACL or immutable flag) move the state root with --state-dir to one that honors permissions and restart the background service (`launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon`). Nothing was deleted: the table on disk is the new one, it is simply not private."
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