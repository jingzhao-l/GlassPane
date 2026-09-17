import Foundation

// MARK: - Evidence persistent store (P1 spec v1.5 §9)

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
/// This is pure logic + local file I/O with no AX dependency, so it is fully
/// unit-testable against an injected temporary directory.
public final class EvidenceStore {

    /// Default evidence root when no project path is configured (spec v1.5 §9.2).
    public static let defaultDirectory =
        NSHomeDirectory() + "/.glasspane/evidence/"

    /// Separator kept distinct from the Crockford opId alphabet, so file
    /// names derived solely from opId are filesystem-safe with no path risk.
    public static let fileExtension = "json"

    private(set) var directory: String

    public init(directory: String? = nil) {
        self.directory = directory ?? EvidenceStore.defaultDirectory
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
            return true
        } catch {
            // Fallback: direct write (see ProjectRegistry.save).
            do {
                try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
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
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: URL(fileURLWithPath: directory),
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }
        let newest = urls
            .filter { $0.pathExtension == EvidenceStore.fileExtension }
            .max { a, b in
                let dateA = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let dateB = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return dateA < dateB
            }
        guard let newest else { return nil }
        return newest.deletingPathExtension().lastPathComponent
    }

    // MARK: - Helpers

    private func path(for operationId: String) -> String {
        directory + "/" + operationId + "." + EvidenceStore.fileExtension
    }

    private func dirExists() -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: directory, isDirectory: &isDir) && isDir.boolValue
    }
}