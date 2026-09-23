import Foundation

// MARK: - Evidence persistent store (P1 spec v1.5 §9, archive lifecycle v1.6 §12)

/// Aggregate archive size snapshot (spec v1.6 §12.3): number of `.json`
/// entries and their total on-disk bytes in the active directory.
public struct EvidenceArchiveStats: Equatable {
    public let count: Int
    public let totalBytes: Int
    public init(count: Int, totalBytes: Int) {
        self.count = count
        self.totalBytes = totalBytes
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
/// - directory is created on first write.
///
/// Archive lifecycle (spec v1.6 §12.2–§12.3):
/// - writes prune the oldest entries by mtime when the archive exceeds
///   `maxFiles`, keeping the active directory bounded;
/// - `stats()` exposes `{count, totalBytes}` for observation;
/// - `clear()` removes every entry in the active directory on demand.
///
/// This is pure logic + local file I/O with no AX dependency, so it is fully
/// unit-testable against an injected temporary directory.
public final class EvidenceStore {

    /// Default evidence root when no project path is configured (spec v1.5 §9.2).
    public static let defaultDirectory =
        NSHomeDirectory() + "/.glasspane/evidence/"

    /// Default archive retention cap (spec v1.6 §12.2). Large enough that the
    /// default "audit everything first" semantics keep holding, but bounded so
    /// a long-running daemon cannot grow the archive without limit.
    public static let defaultMaxFiles = 10_000

    /// Separator kept distinct from the Crockford opId alphabet, so file
    /// names derived solely from opId are filesystem-safe with no path risk.
    public static let fileExtension = "json"

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

    /// - Parameters:
    ///   - directory: evidence storage directory (defaults to `defaultDirectory`).
    ///   - maxFiles: retention cap; values ≤ 0 are clamped up to 1 so a caller
    ///     can never accidentally configure "delete everything on every write".
    ///   - maxAgeDays: age-based TTL; nil disables ageing. Values < 1 are
    ///     clamped to nil (disabled) rather than "delete on write".
    ///   - now: clock for age computation (defaults to the wall clock).
    /// 档案目录必须显式给出。`directory: nil` 曾默认回落到
    /// `~/.glasspane/evidence/`，于是任何一次"忘了传目录"的构造——尤其是单测——
    /// 都会往用户的真实证据档案里写、并按保留策略删里面的旧件。生产侧的真实
    /// 目录只有一个入口：`live()`（见 `ProjectRegistryIsolationTests`）。
    public init(
        directory: String,
        maxFiles: Int? = nil,
        maxAgeDays: Int? = nil,
        now: @escaping () -> Date = { Date() }
    ) {
        self.directory = directory
        self.constructionDirectory = directory
        let requested = maxFiles ?? EvidenceStore.defaultMaxFiles
        self.maxFiles = max(requested, 1)
        self.maxAgeDays = maxAgeDays.map { $0 >= 1 ? $0 : nil } ?? nil
        self.now = now
    }

    /// 生产档案根：`~/.glasspane/evidence/`。仅 daemon 使用。
    public static func live() -> EvidenceStore {
        EvidenceStore(directory: defaultDirectory)
    }

    /// Update the active store directory (called when the active project
    /// changes on attach; spec v1.5 §9.3).
    public func setDirectory(_ dir: String) {
        directory = dir
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
    /// created on demand. `write` does not throw: callers must not let a disk
    /// fault break the main act/assert pipeline (spec v1.5 §11.2). Returns
    /// whether the write actually landed, so tests can assert on failure path.
    @discardableResult
    public func write(_ pack: EvidencePack) -> Bool {
        guard let data = try? pack.jsonData() else { return false }
        if !dirExists() {
            do {
                try FileManager.default.createDirectory(
                    atPath: directory,
                    withIntermediateDirectories: true
                )
            } catch {
                return false
            }
        }
        let filePath = path(for: pack.operationId)
        let tmpPath = filePath + ".tmp"
        do {
            try data.write(to: URL(fileURLWithPath: tmpPath), options: .atomic)
            _ = try FileManager.default.replaceItemAt(
                URL(fileURLWithPath: filePath),
                withItemAt: URL(fileURLWithPath: tmpPath)
            )
            // Best-effort cleanup if rename succeeded but the tmp lingers.
            try? FileManager.default.removeItem(atPath: tmpPath)
            pruneIfNeeded()
            pruneExpiredIfNeeded()
            return true
        } catch {
            // Fallback: direct write (see ProjectRegistry.save).
            do {
                try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
                pruneIfNeeded()
                pruneExpiredIfNeeded()
                return true
            } catch {
                return false
            }
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
        let urls = jsonFileURLs(keys: [.contentModificationDateKey])
        let newest = urls.max { a, b in
            let dateA = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let dateB = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return dateA < dateB
        }
        guard let newest else { return nil }
        return newest.deletingPathExtension().lastPathComponent
    }

    // MARK: - Archive lifecycle (spec v1.6 §12)

    /// Aggregate size of the active archive: `.json` entry count and total
    /// on-disk bytes. Missing/empty directories report 0/0 and never throw.
    public func stats() -> EvidenceArchiveStats {
        let urls = jsonFileURLs(keys: [.fileSizeKey])
        var totalBytes = 0
        for url in urls {
            if let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) {
                totalBytes += size
            }
        }
        return EvidenceArchiveStats(count: urls.count, totalBytes: totalBytes)
    }

    /// Remove every `.json` entry in the active directory, returning the
    /// number actually removed (spec v1.6 §12.3). Best-effort: a single file
    /// that cannot be removed is skipped without aborting the rest; a never-
    /// created or already-empty directory returns 0.
    @discardableResult
    public func clear() -> Int {
        let urls = jsonFileURLs(keys: [])
        var removed = 0
        for url in urls {
            if (try? FileManager.default.removeItem(at: url)) != nil {
                removed += 1
            }
        }
        return removed
    }

    /// Enforce the archive cap: when the `.json` entry count exceeds
    /// `maxFiles`, delete the oldest `count - maxFiles` entries by mtime
    /// (FIFO-by-mtime, spec v1.6 §12.2). Best-effort; returns how many were
    /// actually removed. The just-written entry is never a victim because the
    /// victims are chosen strictly from the oldest excess.
    @discardableResult
    private func pruneIfNeeded() -> Int {
        let urls = jsonFileURLs(keys: [.contentModificationDateKey])
        let excess = urls.count - maxFiles
        guard excess > 0 else { return 0 }
        let oldestFirst = urls.sorted { a, b in
            let dateA = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantFuture
            let dateB = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantFuture
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
        return jsonFileURLs(keys: [.contentModificationDateKey]).filter {
            isExpired(url: $0, maxAgeDays: olderThanDays, now: current)
        }.count
    }

    /// Actual deletion pass over every entry older than the effective TTL.
    private func removeExpired(effectiveMaxAgeDays: Int?, now: Date) -> Int {
        guard let effectiveMaxAgeDays else { return 0 }
        let urls = jsonFileURLs(keys: [.contentModificationDateKey])
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
    private func isExpired(url: URL, maxAgeDays: Int, now: Date) -> Bool {
        let cutoffSeconds = TimeInterval(maxAgeDays) * Self.secondsPerDay
        let reference = createdDate(url: url) ?? fallbackModificationDate(url: url)
        return now.timeIntervalSince(reference) > cutoffSeconds
    }

    /// Preferred age source: the pack's own createdAt (ISO-8601, UTC).
    /// Malformed/corrupt entries decode to nil (honest fallback to mtime).
    private func createdDate(url: URL) -> Date? {
        let operationId = url.deletingPathExtension().lastPathComponent
        guard let pack = read(operationId: operationId) else { return nil }
        return Self.isoDate(pack.createdAt)
    }

    private func fallbackModificationDate(url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
            ?? .distantPast
    }

    // MARK: - Helpers

    /// List the `.json` evidence files in the active directory, requesting the
    /// given resource keys. Returns `[]` when the directory is missing (never
    /// throws), so iterative listing is safe on a never-created archive.
    private func jsonFileURLs(keys: [URLResourceKey]) -> [URL] {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: URL(fileURLWithPath: directory),
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }
        return urls.filter { $0.pathExtension == EvidenceStore.fileExtension }
    }

    private func path(for operationId: String) -> String {
        directory + "/" + operationId + "." + EvidenceStore.fileExtension
    }

    private func dirExists() -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: directory, isDirectory: &isDir) && isDir.boolValue
    }
}