import Foundation

// MARK: - Project Registry (P1 spec v1.4 §1.2)

/// In-memory + file-persisted registry of registered projects.
/// Atomic write via tmp + rename; file is loaded on init if it exists.
public final class ProjectRegistry {

    /// Default path for the projects file.
    public static let defaultProjectsPath =
        NSHomeDirectory() + "/.glasspane/projects.json"

    public let filePath: String
    private var projects: [ProjectEntry] = []

    public init(filePath: String = ProjectRegistry.defaultProjectsPath) {
        self.filePath = filePath
        load()
    }

    /// All registered projects (snapshot).
    public var all: [ProjectEntry] { projects }

    /// Current count.
    public var count: Int { projects.count }

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
        save()
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
        guard let index = projects.firstIndex(where: { $0.projectId == projectId }) else {
            throw GPError(
                code: .notFound,
                message: "unknown projectId \(projectId)"
            )
        }
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
        save()
        return entry
    }

    /// Remove a project by ID. Returns true if found and removed.
    @discardableResult
    public func remove(_ projectId: String) throws -> Bool {
        guard let index = projects.firstIndex(where: { $0.projectId == projectId }) else {
            throw GPError(
                code: .notFound,
                message: "unknown projectId \(projectId)"
            )
        }
        projects.remove(at: index)
        save()
        return true
    }

    // MARK: - Persistence

    private func load() {
        guard FileManager.default.fileExists(atPath: filePath) else { return }
        guard let data = FileManager.default.contents(atPath: filePath) else { return }
        guard let decoded = try? JSONDecoder().decode([ProjectEntry].self, from: data) else { return }
        projects = decoded
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(projects) else { return }
        // Atomic write: tmp + rename (same filesystem ⇒ atomic on macOS).
        let tmpPath = filePath + ".tmp"
        do {
            try data.write(to: URL(fileURLWithPath: tmpPath))
            _ = try FileManager.default.replaceItemAt(
                URL(fileURLWithPath: filePath),
                withItemAt: URL(fileURLWithPath: tmpPath)
            )
        } catch {
            // Fallback: direct write.
            try? data.write(to: URL(fileURLWithPath: filePath))
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
