import Foundation

// MARK: - Evidence persistent store (P1 spec v1.5 §9, archive lifecycle v1.6 §12)

/// Aggregate archive size snapshot (spec v1.6 §12.3): number of evidence
/// entries and their total on-disk bytes in the active directory.
public struct EvidenceArchiveStats: Equatable {
    public let count: Int
    public let totalBytes: Int
    /// R6-08: nil means the listing completed, so `count: 0` is the statement
    /// "this archive holds nothing". Non-nil means the archive could **not** be
    /// read, and the two zeros below are then the zeros of "nothing was
    /// measured" — which `glasspaned --evidence-stats` publishes as null.
    public let listFailure: String?

    public init(count: Int, totalBytes: Int, listFailure: String? = nil) {
        self.count = count
        self.totalBytes = totalBytes
        self.listFailure = listFailure
    }
}

/// File-persisted store for evidence packs. Each operation keeps its own
/// JSON file (`<dir>/<operationId>.json`) so individual entries are readable,
/// replaceable and independently corruptible without affecting the rest.
///
/// Layout and semantics (spec v1.5 §9.2):
/// - one file per operationId, key-sorted JSON via `EvidencePack.encoder`;
/// - atomic write via tmp + rename (same pattern as `ProjectRegistry.save`);
/// - `read` decodes and validates; missing/corrupt returns nil (never throws);
/// - directory is created on first write, and is brought to (or proven) 0700
///   before any pack lands in it — an archive that cannot be made private to
///   this account refuses writes instead (R5-04).
///
/// Archive lifecycle (spec v1.6 §12.2–§12.3):
/// - writes prune the oldest entries by mtime when the archive exceeds
///   `maxFiles`, keeping the active directory bounded;
/// - `stats()` exposes `{count, totalBytes}` for observation;
/// - `clear()` removes every entry in the active directory on demand.
///
/// Deletion radius (P0 §8.1 blast-radius review): the archive directory is
/// configurable per project, so every destructive pass below is limited to
/// entries this store actually created — a regular, non-symlink file named
/// exactly `<opId>.json`. A directory that happens to end in `.json`, a
/// foreign `settings.json`, or a link out of the archive is therefore never a
/// deletion candidate, because `FileManager.removeItem` recurses. An entry
/// whose age cannot be measured is likewise never treated as expired.
///
/// This is pure logic + local file I/O with no AX dependency, so it is fully
/// unit-testable against an injected temporary directory.
public final class EvidenceStore {

    /// The per-user archive location (spec v1.5 §9.2). A *value*, not an
    /// initializer default: no construction resolves to it unless a caller
    /// names it (`atProductionDefault()`, or `at(stateRoot:)` with the
    /// home-derived root) or passes it as `directory`.
    ///
    /// Derived from `StateRoot` rather than composed here: the home lookup
    /// behind it ignores a `HOME` override, so this string must have exactly
    /// one named source across the module.
    public static let defaultDirectory = StateRoot.homeDefault().evidenceDirectory

    /// Default archive retention cap (spec v1.6 §12.2). Large enough that the
    /// default "audit everything first" semantics keep holding, but bounded so
    /// a long-running daemon cannot grow the archive without limit.
    public static let defaultMaxFiles = 10_000

    /// Separator kept distinct from the Crockford opId alphabet, so file
    /// names derived solely from opId are filesystem-safe with no path risk.
    public static let fileExtension = "json"

    /// The name shape of an archive entry, i.e. exactly what `write(_:)`
    /// creates: `op_` + 26 Crockford characters + `.json`. The prefix,
    /// alphabet and length are read from `OperationID` (the only generator of
    /// these ids) rather than restated here, so the deletion scope cannot drift
    /// away from the write path.
    static let entryNamePattern =
        "^" + OperationID.prefix
        + "[\(String(OperationID.crockfordAlphabet))]"
        + "{\(OperationID.totalLength)}\\." + fileExtension + "$"

    private static let entryNameRegex = try! NSRegularExpression(pattern: entryNamePattern)

    /// Exact UTF-16 length of a conforming entry name: `op_` + 26 characters
    /// + `.` + `json`. Checked before the regex because `$` in an
    /// `NSRegularExpression` pattern also matches before a trailing newline.
    private static let entryNameLength =
        OperationID.prefix.utf16.count + OperationID.totalLength + fileExtension.utf16.count + 1

    /// Whether `name` is the file name this store writes for an evidence pack.
    static func isEntryName(_ name: String) -> Bool {
        guard name.utf16.count == entryNameLength else { return false }
        let range = NSRange(name.startIndex..., in: name)
        return entryNameRegex.firstMatch(in: name, range: range) != nil
    }

    /// Deletion identity for every destructive pass: an entry this store owns
    /// is a *regular, non-symlink file* whose name matches `entryNamePattern`.
    /// Anything that cannot be measured (stat failed, entry vanished mid-list)
    /// is reported as not deletable — this store never deletes on a guess,
    /// since removing a directory removes its contents with it.
    static func isDeletableEntry(_ url: URL) -> Bool {
        guard isEntryName(url.lastPathComponent) else { return false }
        guard let values = try? url.resourceValues(
            forKeys: [.isRegularFileKey, .isSymbolicLinkKey]
        ) else {
            return false
        }
        return values.isRegularFile == true && values.isSymbolicLink != true
    }

    private(set) var directory: String
    /// 构造时给定的目录——`useDefaultDirectory()` 的落点。
    private let constructionDirectory: String

    /// Archive retention cap. Writes exceeding this prune the oldest entries
    /// (by mtime) so the active directory stays bounded (spec v1.6 §12.2).
    public private(set) var maxFiles: Int

    /// Age-based TTL retention (P5 spec v5.0 §9.2). nil = never expire by age
    /// (default — legacy "full archive, no expiry" semantics unchanged).
    /// Non-nil values below 1 are clamped to nil (disabled): "expire after 0
    /// days = delete on write" is a misconfiguration, mirrored reversed from
    /// the maxFiles clamp (≥1).
    public private(set) var maxAgeDays: Int?

    /// Injectable "now" for age computation (P5 §9.2): tests pin a fixed clock
    /// so TTL pruning is deterministic without sleeping.
    private let now: () -> Date

    /// Where isolation failures and out-of-home gaps are reported. Defaults to
    /// non-quiet: a refused write must never become the silent kind (R5-04).
    private let log: EngineLog

    /// Directory value whose isolation verdict (0700 established, or the
    /// honest out-of-home gap) was last recorded. Cached per directory so a
    /// long-running daemon chmods/stat-checks once, not per
    /// pack; failures are never cached, so every write re-measures until the
    /// operator fixes the permission.
    private var isolatedDirectory: String?

    /// The isolation verdict for one finished pack, as a single named step.
    ///
    /// Production always answers with `StateRoot.isolateFile`, and this exists
    /// only so that the *refusals* in `write` are branches a test can execute:
    /// the volume condition they refuse (a mount that ignores `chmod` — read-only,
    /// ACL-enforced, immutable-flagged) cannot be reproduced without root or a
    /// second filesystem, and every non-root construction that reaches a
    /// publication leaves a plain `0644` regular file that `chmod(0600)` fixes on
    /// the spot. `StatePermissionTests` measured that candidate space (directory,
    /// non-empty directory, `uchg` file, FIFO, dangling symlink, symlink loop,
    /// symlink to an immutable file, inherited `deny writeattr` ACL) and
    /// documented the results next to the case; a refusal no test has ever
    /// reached is the shape R5-04's own review keeps rejecting, so this seam is
    /// internal and `@testable`-reachable exactly like `isExpired`, which is
    /// internal for the same reason.
    var isolationCheck: (String) -> String? = StateRoot.isolateFile(at:)

    /// The archive lives where the caller says it lives — there is no default.
    ///
    /// - Parameters:
    ///   - directory: evidence storage directory, **required**. C-02/C-03: this
    ///     used to be `String? = nil` folded into `defaultDirectory`, so every
    ///     caller that named no location — including every test helper that
    ///     forwarded its own optional — got the developer's real archive. The
    ///     production location is now reachable only by name, through
    ///     `atProductionDefault()`.
    ///   - maxFiles: retention cap; values ≤ 0 are clamped up to 1 so a caller
    ///     can never accidentally configure "delete everything on every write".
    ///   - maxAgeDays: age-based TTL; nil disables ageing. Values < 1 are
    ///     clamped to nil (disabled) rather than "delete on write".
    ///   - now: clock for age computation (defaults to the wall clock).
    /// 档案目录必须显式给出。`directory: nil` 曾默认回落到
    /// `~/.glasspane/evidence/`，于是任何一次"忘了传目录"的构造——尤其是单测——
    /// 都会往用户的真实证据档案里写、并按保留策略删里面的旧件。生产侧的真实
    /// 目录只有一个入口：`live()`（见 `ProjectRegistryIsolationTests`）。
    ///   - log: sink for the isolation verdicts (R5-04).
    public init(
        directory: String,
        maxFiles: Int? = nil,
        maxAgeDays: Int? = nil,
        now: @escaping () -> Date = { Date() },
        log: EngineLog = EngineLog(quiet: false)
    ) {
        self.directory = directory
        self.constructionDirectory = directory
        let requested = maxFiles ?? EvidenceStore.defaultMaxFiles
        self.maxFiles = max(requested, 1)
        self.maxAgeDays = maxAgeDays.map { $0 >= 1 ? $0 : nil } ?? nil
        self.now = now
        self.log = log
    }

    /// The **only** way to bind a store to `defaultDirectory` by name. Kept
    /// named on purpose: reaching the per-user archive is a decision a reader
    /// must see in the call site, not a side effect of leaving an argument out.
    ///
    /// C-02/C-03 kept, X-22 added: `glasspaned` resolves one `StateRoot` per
    /// process and builds every archive through `at(stateRoot:)`, so this is
    /// what it means when nothing was injected — the same value, named. Tests
    /// have no route here at all — `TestIsolationGateTests` rejects this name
    /// anywhere under `engine/Tests`, so a test that really needs the live
    /// archive has to delete that guard first and say why.
    public static func atProductionDefault(
        maxFiles: Int? = nil,
        maxAgeDays: Int? = nil,
        now: @escaping () -> Date = { Date() },
        log: EngineLog = EngineLog(quiet: false)
    ) -> EvidenceStore {
        at(
            stateRoot: StateRoot.homeDefault(),
            maxFiles: maxFiles,
            maxAgeDays: maxAgeDays,
            now: now,
            log: log
        )
    }

    /// A store over the evidence archive of a named state root — the location
    /// `<root>/evidence/` and nothing else. X-22: a smoke run or a second
    /// installation that passes `--state-dir` gets an archive inside the root
    /// it named, and one that names nothing gets the home-derived per-user
    /// archive, which is the same call with a different argument rather than a
    /// different code path.
    public static func at(
        stateRoot: StateRoot,
        maxFiles: Int? = nil,
        maxAgeDays: Int? = nil,
        now: @escaping () -> Date = { Date() },
        log: EngineLog = EngineLog(quiet: false)
    ) -> EvidenceStore {
        EvidenceStore(
            directory: stateRoot.evidenceDirectory,
            maxFiles: maxFiles,
            maxAgeDays: maxAgeDays,
            now: now,
            log: log
        )
    }

    /// 生产档案根：`~/.glasspane/evidence/`。仅 daemon 使用。
    public static func live() -> EvidenceStore {
        EvidenceStore(directory: defaultDirectory)
    }

    /// Update the active store directory (called when the active project
    /// changes on attach; spec v1.5 §9.3). The isolation verdict is dropped
    /// with the old directory so the new one is re-measured before its first
    /// write (R5-04).
    public func setDirectory(_ dir: String) {
        directory = dir
        isolatedDirectory = nil
    }

    /// 回到**本档案被构造时**的目录。
    ///
    /// 切换活跃项目时"这个项目没配档案路径"要复位，但复位的终点不是
    /// `EvidenceStore.defaultDirectory`（那是 `~/.glasspane/evidence/`，会把一个
    /// 注入的临时档案重定向到用户的真实档案里），而是这个实例自己的起点。
    public func useDefaultDirectory() {
        directory = constructionDirectory
    }

    /// Update the age-based TTL retention (P5 §9.2). Values < 1 are clamped
    /// to a disabled state (nil) — never "delete on write".
    public func setRetention(maxAgeDays: Int?) {
        self.maxAgeDays = maxAgeDays.map { $0 >= 1 ? $0 : nil } ?? nil
    }

    // MARK: - Persistence

    /// Write a pack atomically to `<dir>/<operationId>.json`. The directory is
    /// created on demand and must first be brought to 0700 (R5-04, see
    /// `ensureIsolatedDirectory`). `write` does not throw: callers must not let
    /// a disk fault break the main act/assert pipeline (spec v1.5 §11.2).
    /// Returns whether the write actually landed, so tests can assert on
    /// failure path — a directory that cannot be proven private reports a
    /// measured failure (false) instead of writing readable-by-everyone packs.
    ///
    /// Every step that can publish answers to that claim, on the name it
    /// published: the rename route isolates the temporary file *before* it is
    /// renamed and judges the published name *after* it lands (a replacement
    /// keeps the mode of what it replaced — measured, see the comment there), and
    /// the fallback route isolates the file it wrote and **takes the publication
    /// back** when isolation fails. The fallback used to log the defect and
    /// `return true` anyway, which made "cannot be isolated ⇒ refuse the write" a
    /// claim only the branch that never runs honoured: on a read-only mount, an
    /// ACL-enforced or immutable-flagged volume, every pack still reached the
    /// archive world readable and `EngineCore` was told `evidencePersisted: true`.
    @discardableResult
    public func write(_ pack: EvidencePack) -> Bool {
        guard let data = try? pack.jsonData() else { return false }
        guard ensureIsolatedDirectory() else { return false }
        let filePath = path(for: pack.operationId)
        let destination = URL(fileURLWithPath: filePath)
        // Nothing may be published *onto* something that is not one of this
        // archive's own entries. Measured: when the entry name is held by a
        // directory, `replaceItemAt` does not fail politely — it takes the
        // directory's contents with it, which contradicts this type's declared
        // blast radius (only `op_<26 chars>.json`, only ever deleted by an
        // explicit prune). Refusing on sight is the only shape that keeps that
        // promise; a rewrite of a real entry stays allowed.
        if FileManager.default.fileExists(atPath: filePath), !Self.isDeletableEntry(destination) {
            log.error("evidence entry \(filePath) exists but is not an archive entry this store wrote — refusing to write, and leaving it exactly as found")
            return false
        }
        let tmpPath = filePath + ".tmp"
        do {
            try data.write(to: URL(fileURLWithPath: tmpPath), options: .atomic)
            // Owner-only *before* the rename, so an evidence pack is never — not
            // even briefly — readable by another local account. The archive is
            // the audit trail the panel and `gp_export_evidence` publish, and
            // `Data.write(.atomic)` creates with the process umask (R5-04).
            if let defect = isolationCheck(tmpPath) {
                log.error("evidence pack \(tmpPath) could not be made owner-only: \(defect) — refusing to publish it into the archive")
                removeAfterRefusal(tmpPath)
                return false
            }
            _ = try FileManager.default.replaceItemAt(
                URL(fileURLWithPath: filePath),
                withItemAt: URL(fileURLWithPath: tmpPath)
            )
            // Best-effort cleanup if rename succeeded but the tmp lingers.
            try? FileManager.default.removeItem(atPath: tmpPath)
            // The rename is **not** the end of the isolation question: measured on
            // APFS, `replaceItemAt` hands the *destination's* attributes to the item
            // that lands there, so replacing a pack that was ever published 0644 —
            // an installation that predates R5-04, or one written by the fallback
            // below — leaves the new pack 0644 while the temporary file's check
            // reports success. Judging only the temp would therefore claim an
            // invariant the published archive does not hold, which is the same
            // failure spoken-and-not-acted shape as the fallback's.
            if let defect = isolationCheck(filePath) {
                log.error(isolationRefusalReport(filePath, defect: defect, route: "rename"))
                removeAfterRefusal(filePath)
                return false
            }
            pruneIfNeeded()
            pruneExpiredIfNeeded()
            return true
        } catch {
            // Fallback: direct write (see ProjectRegistry.save). Reached when the
            // temporary name cannot be used at all — which is what a full,
            // wedged or partially read-only volume looks like from here — so the
            // pack goes straight to its final name.
            do {
                try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
            } catch {
                return false
            }
            if let defect = isolationCheck(filePath) {
                log.error(isolationRefusalReport(filePath, defect: defect, route: "fallback"))
                removeAfterRefusal(filePath)
                return false
            }
            pruneIfNeeded()
            pruneExpiredIfNeeded()
            return true
        }
    }

    /// The refusal an isolation failure on the published name raises. It names
    /// itself as a **permission judgment** and not as a disk fault, because the
    /// bytes did land: a reader who concludes "out of space, retry later" from
    /// this line walks away from a world-readable audit trail. The verdict the
    /// caller gets is `false`, which `EngineCore` surfaces as
    /// `evidencePersisted: false` plus `lastEvidencePersistenceFailure`, so this
    /// is a failed write and not a missing probe.
    private func isolationRefusalReport(
        _ path: String, defect: String, route: String
    ) -> String {
        "evidence pack \(path) is not owner-only after the \(route) write: \(defect) — permission judgment, not a full disk: the bytes landed and were then withdrawn from \(directory), which is on a volume that will not isolate a file it is given (read-only mount, ACL or immutable flag). Nothing was left published; re-run after the directory is owner-only writable, or point the run at such a root with --state-dir"
    }

    /// Undo a publication the isolation verdict refused, and say so out loud
    /// when the undo itself fails: the write is reported as failed either way,
    /// but a pack that is still sitting there world-readable is a different
    /// incident for the operator, and swallowing it is how "refused" becomes
    /// another word for "published".
    private func removeAfterRefusal(_ path: String) {
        do {
            try FileManager.default.removeItem(atPath: path)
        } catch {
            log.error("refused evidence file \(path) could not be removed after the isolation failure (\(error)) — it is still on disk and it is NOT owner-only; delete that one file by name")
        }
    }

    /// Read and validate a pack by operationId. Missing or corrupt files
    /// return nil (the caller maps this to GP_E_NO_EVIDENCE); `read` itself
    /// never throws so a single bad entry cannot crash the daemon.
    public func read(operationId: String) -> EvidencePack? {
        let filePath = path(for: operationId)
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: filePath)) else {
            return nil
        }
        return try? EvidencePack.decodeAndValidate(data)
    }

    /// OperationId of the most recently written file, by file modification
    /// time. Returns nil when the directory is empty or missing.
    public func lastOnDisk() -> String? {
        let urls = archiveEntryURLs(keys: [.contentModificationDateKey])
        let newest = urls.max { a, b in
            (modificationDate(of: a) ?? .distantPast) < (modificationDate(of: b) ?? .distantPast)
        }
        guard let newest else { return nil }
        return newest.deletingPathExtension().lastPathComponent
    }

    // MARK: - Archive lifecycle (spec v1.6 §12)

    /// Aggregate size of the active archive: entry count and total on-disk bytes,
    /// plus whether that count was obtained at all. A missing or empty directory
    /// reports 0/0 with `listFailure == nil`; a directory that exists but cannot
    /// be read reports `listFailure`, because publishing 0 there is what let
    /// `--evidence-stats` certify an unreadable archive as empty. Never throws.
    public func stats() -> EvidenceArchiveStats {
        switch archiveListing(keys: [.fileSizeKey]) {
        case .absent:
            return EvidenceArchiveStats(count: 0, totalBytes: 0)
        case let .unreadable(path):
            return EvidenceArchiveStats(
                count: 0, totalBytes: 0,
                listFailure: "cannot read the evidence archive at \(path) to count it"
            )
        case let .entries(urls):
            var totalBytes = 0
            for url in urls {
                if let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) {
                    totalBytes += size
                }
            }
            return EvidenceArchiveStats(count: urls.count, totalBytes: totalBytes)
        }
    }

    /// Remove every evidence entry in the active directory, returning the
    /// number actually removed (spec v1.6 §12.3). Scope is `isDeletableEntry`:
    /// only files this store wrote under its own naming convention go, so a
    /// `.json`-named directory or a foreign config file in the same directory
    /// is left in place. Best-effort: a single file that cannot be removed is
    /// skipped without aborting the rest; a never-created or already-empty
    /// directory returns 0.
    @discardableResult
    public func clear() -> Int {
        let urls = archiveEntryURLs(keys: [])
        var removed = 0
        for url in urls {
            if (try? FileManager.default.removeItem(at: url)) != nil {
                removed += 1
            }
        }
        return removed
    }

    /// Enforce the archive cap: when the evidence entry count exceeds
    /// `maxFiles`, delete the oldest `count - maxFiles` entries by mtime
    /// (FIFO-by-mtime, spec v1.6 §12.2). Best-effort; returns how many were
    /// actually removed. The just-written entry is never a victim because the
    /// victims are chosen strictly from the oldest excess, and an entry whose
    /// mtime cannot be read sorts as newest so it is never picked as old.
    @discardableResult
    private func pruneIfNeeded() -> Int {
        let urls = archiveEntryURLs(keys: [.contentModificationDateKey])
        let excess = urls.count - maxFiles
        guard excess > 0 else { return 0 }
        let oldestFirst = urls.sorted { a, b in
            let dateA = modificationDate(of: a) ?? .distantFuture
            let dateB = modificationDate(of: b) ?? .distantFuture
            return dateA < dateB
        }
        var removed = 0
        for url in oldestFirst.prefix(excess) {
            if (try? FileManager.default.removeItem(at: url)) != nil {
                removed += 1
            }
        }
        return removed
    }

    // MARK: - Age-based TTL retention (P5 spec v5.0 §9.2)

    /// Expiry threshold window, in seconds, for `maxAgeDays` days.
    private static let secondsPerDay: TimeInterval = 86_400

    /// ISO-8601 (millisecond, UTC) parser matching `EvidencePack.createdAt`.
    static let isoDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    /// Parse an evidence createdAt string to a `Date`; nil when malformed.
    static func isoDate(_ string: String) -> Date? {
        isoDateFormatter.date(from: string)
    }

    /// Remove entries older than the configured `maxAgeDays` (write-time
    /// pruning, §9.2). Disabled (nil) TTL is a no-op.
    @discardableResult
    private func pruneExpiredIfNeeded() -> Int {
        removeExpired(effectiveMaxAgeDays: maxAgeDays, now: now())
    }

    /// One-shot age prune at an explicit day threshold — the maintenance and
    /// project-dimension entry point (CLI batch four). Values below 1 clamp to
    /// a no-op: "prune after 0 days" must never mean "delete everything".
    @discardableResult
    public func prune(olderThanDays: Int) -> Int {
        guard olderThanDays >= 1 else { return 0 }
        return removeExpired(effectiveMaxAgeDays: olderThanDays, now: now())
    }

    /// How many entries `prune(olderThanDays:)` *would* remove, using the
    /// identical judgment path with deletion skipped — backs the CLI --dry-run
    /// contract (P5 §12.2: same-source count, not an estimate).
    public func countExpired(olderThanDays: Int) -> Int {
        guard olderThanDays >= 1 else { return 0 }
        let current = now()
        return archiveEntryURLs(keys: [.contentModificationDateKey]).filter {
            isExpired(url: $0, maxAgeDays: olderThanDays, now: current)
        }.count
    }

    /// Actual deletion pass over every entry older than the effective TTL.
    private func removeExpired(effectiveMaxAgeDays: Int?, now: Date) -> Int {
        guard let effectiveMaxAgeDays else { return 0 }
        let urls = archiveEntryURLs(keys: [.contentModificationDateKey])
        guard !urls.isEmpty else { return 0 }
        var removed = 0
        for url in urls {
            if isExpired(url: url, maxAgeDays: effectiveMaxAgeDays, now: now),
               (try? FileManager.default.removeItem(at: url)) != nil {
                removed += 1
            }
        }
        return removed
    }

    /// Age judgment (P5 §9.2): expiry = created/reference date is more than
    /// `maxAgeDays` before `now`. Prefers the entry's own `createdAt`; corrupt
    /// entries fall back to the file mtime (same basis as FIFO pruning).
    /// When *neither* can be read the entry is kept: an age that was never
    /// measured must not be folded into "infinitely old" and deleted.
    /// Internal so the unmeasurable-age branch is unit-testable without racing
    /// the file against its own enumeration.
    func isExpired(url: URL, maxAgeDays: Int, now: Date) -> Bool {
        let cutoffSeconds = TimeInterval(maxAgeDays) * Self.secondsPerDay
        guard let reference = createdDate(url: url) ?? modificationDate(of: url) else {
            return false
        }
        return now.timeIntervalSince(reference) > cutoffSeconds
    }

    /// Preferred age source: the pack's own createdAt (ISO-8601, UTC).
    /// Malformed/corrupt entries decode to nil (honest fallback to mtime).
    private func createdDate(url: URL) -> Date? {
        let operationId = url.deletingPathExtension().lastPathComponent
        guard let pack = read(operationId: operationId) else { return nil }
        return Self.isoDate(pack.createdAt)
    }

    /// File mtime, or nil when it cannot be read. Callers must handle nil as
    /// "age unknown", never as a specific point in the past.
    private func modificationDate(of url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate
    }

    // MARK: - Helpers

    /// The three things a listing can say. `absent` and `unreadable` used to be
    /// the same answer (`[]`), which is the shape this project keeps having to
    /// remove: an archive that was never created genuinely holds nothing, while
    /// an archive behind a directory this process may not read holds *unknown*.
    /// Measured on this machine, the two are distinguishable at the error level:
    /// `NSCocoaErrorDomain` 260 is ENOENT and 257 is EACCES.
    enum ArchiveListing {
        case entries([URL])
        case absent
        case unreadable(String)
    }

    /// Why the **last** listing failed, or nil when it completed. The maintenance
    /// CLI builds one store per invocation and reads this immediately after the
    /// call, which is how a published `0` turns into "could not count"; internal
    /// serving-thread callers get a `log.error` instead, because a shared flag
    /// there would not say whose listing it described.
    private(set) var listingFailure: String?

    /// List the archive's entries in the active directory, requesting the given
    /// resource keys. An entry is a file this store created — see
    /// `isDeletableEntry` — so foreign `.json` files and `.json`-named
    /// directories are excluded here once, for every consumer (observation and
    /// deletion alike). Never throws; a failed listing is an outcome, not an
    /// exception.
    private func archiveListing(keys: [URLResourceKey]) -> ArchiveListing {
        do {
            let urls = try FileManager.default.contentsOfDirectory(
                at: URL(fileURLWithPath: directory),
                includingPropertiesForKeys: keys + [.isRegularFileKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles]
            )
            listingFailure = nil
            return .entries(urls.filter { Self.isDeletableEntry($0) })
        } catch let failure as NSError where failure.domain == NSCocoaErrorDomain
            && failure.code == NSFileReadNoSuchFileError {
            listingFailure = nil
            return .absent
        } catch {
            listingFailure = "cannot list the evidence archive at \(directory) (\(error))"
            return .unreadable(directory)
        }
    }

    /// The form callers use when a failed listing must not change what they do:
    /// they see no entries, and the reason is both in `listingFailure` (for a
    /// published number) and in the log (for a serving-thread path). Deleting or
    /// counting for the CLI has to consult one of the two — see `stats()`.
    private func archiveEntryURLs(keys: [URLResourceKey]) -> [URL] {
        switch archiveListing(keys: keys) {
        case let .entries(urls):
            return urls
        case .absent:
            return []
        case .unreadable:
            log.error(listingFailure ?? "listing failed at \(directory)")
            return []
        }
    }

    // MARK: - Directory isolation (R5-04)

    /// Enforce the 0700 isolation this archive requires, mirroring
    /// `SocketServer.prepareSocketDirectory` (same rule, same enforcement
    /// scope, same honest gap reporting).
    ///
    /// `createDirectory(attributes:)` only applies to directories **this call
    /// creates** — `~/.glasspane` and `~/.glasspane/evidence` are normally
    /// already there (the mcp-shell registry creates them with the default
    /// mode), so without a chmod-after-create the documented isolation is
    /// silently false and every other local account can read the evidence
    /// packs.
    ///
    /// What scopes the enforcement is **ownership, not home membership**. The
    /// rule used to be "inside `NSHomeDirectory()`", which `--state-dir` broke
    /// open: a maintenance run that names a root under `/var/folders` or `/tmp`
    /// fell into the outside-home branch, logged `0700 is NOT enforced`, and
    /// **wrote anyway** — the one shape of run that most needs the invariant was
    /// the one that silently skipped it. Now: tighten when the path is ours
    /// (`chmod` answers that directly — it fails when we do not own it), and
    /// refuse the write when it is not, because adding world-readable packs to
    /// a directory we cannot isolate is the failure this rule exists to prevent.
    ///
    /// When isolation cannot be established the write is **refused** (returns
    /// false — the failure mode `EngineCore` already surfaces as a degraded
    /// `evidenceId` warning). Refusal is the non-destructive failure shape:
    /// nothing on this path ever deletes, rewrites or "recreates" what is
    /// already in the archive; the daemon simply does not add world-readable
    /// packs to it.
    private func ensureIsolatedDirectory() -> Bool {
        let probe = directory
        if isolatedDirectory == probe { return true }
        let path = URL(fileURLWithPath: directory).path // drops the trailing slash
        if !FileManager.default.fileExists(atPath: path) {
            do {
                try FileManager.default.createDirectory(
                    atPath: path,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700]
                )
            } catch {
                log.error("evidence directory \(path) cannot be created: \(error.localizedDescription) — refusing to write; nothing existing was touched")
                return false
            }
        }
        let home = NSHomeDirectory()
        if path != home, !path.hasPrefix(home + "/") {
            // Not an exemption: a statement that this run put its archive
            // outside the per-user folder, so the reader of the log can tell
            // which directory was tightened by whom.
            log.info("evidence directory \(path) is outside \(home) — isolating it by ownership instead of by home scope")
        }
        guard chmod(path, 0o700) == 0 else {
            log.error("chmod(0700) \(path) failed: \(String(cString: strerror(errno))) — refusing to write evidence other accounts could read")
            return false
        }
        let attributes = (try? FileManager.default.attributesOfItem(atPath: path)) ?? [:]
        guard !attributes.isEmpty else {
            log.error("evidence directory \(path): attributes unreadable after chmod — refusing to write")
            return false
        }
        guard attributes[.type] as? FileAttributeType == .typeDirectory else {
            log.error("evidence directory \(path) is not a directory — refusing to write")
            return false
        }
        let owner = attributes[.ownerAccountName] as? String ?? "an unknown account"
        guard owner == NSUserName() else {
            // Someone else planted the directory we are about to archive into.
            log.error("evidence directory \(path) is owned by \(owner), not \(NSUserName()) — refusing to write")
            return false
        }
        let mode = (attributes[.posixPermissions] as? NSNumber)?.int16Value ?? -1
        guard mode == 0o700 else {
            // chmod claimed success yet the directory is still reachable by
            // group/other (read-only volume, immutable flag, ACL override):
            // continuing to archive into it would publish every pack to other
            // accounts. Refusing writes is the non-destructive failure: an
            // existing archive under this path stays untouched on disk.
            log.error("evidence directory \(path) permission is \(String(format: "%04o", Int(mode))) and cannot be set to 0700 — refusing to write; existing entries were left untouched")
            return false
        }
        isolatedDirectory = probe
        return true
    }

    private func path(for operationId: String) -> String {
        directory + "/" + operationId + "." + EvidenceStore.fileExtension
    }
}