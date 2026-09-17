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

    /// Archive retention cap. Writes exceeding this prune the oldest entries
    /// (by mtime) so the active directory stays bounded (spec v1.6 §12.2).
    public private(set) var maxFiles: Int

    /// - Parameters:
    ///   - directory: evidence storage directory (defaults to `defaultDirectory`).
    ///   - maxFiles: retention cap; values ≤ 0 are clamped up to 1 so a caller
    ///     can never accidentally configure "delete everything on every write".
    public init(directory: String? = nil, maxFiles: Int? = nil) {
        self.directory = directory ?? EvidenceStore.defaultDirectory
        let requested = maxFiles ?? EvidenceStore.defaultMaxFiles
        self.maxFiles = max(requested, 1)
    }

    /// Update the active store directory (called when the active project
    /// changes on attach; spec v1.5 §9.3).
    public func setDirectory(_ dir: String) {
        directory = dir
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
            return true
        } catch {
            // Fallback: direct write (see ProjectRegistry.save).
            do {
                try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
                pruneIfNeeded()
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