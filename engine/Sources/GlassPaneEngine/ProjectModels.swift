import Foundation

// MARK: - Project Entry (P1 spec v1.4 §1.1)

/// A registered project in the GlassPane project registry.
public struct ProjectEntry: Codable, Equatable {
    public static let maxDisplayNameLength = 256
    public static let maxProjects = 128

    public let projectId: String
    public var displayName: String
    public var bundleId: String?
    public var pid: Int32?
    public var recipeConfigPath: String?
    public var calibrationAssetsPath: String?
    public var evidenceStoragePath: String?
    public var createdAt: String

    public init(
        projectId: String,
        displayName: String,
        bundleId: String? = nil,
        pid: Int32? = nil,
        recipeConfigPath: String? = nil,
        calibrationAssetsPath: String? = nil,
        evidenceStoragePath: String? = nil,
        createdAt: String
    ) {
        self.projectId = projectId
        self.displayName = displayName
        self.bundleId = bundleId
        self.pid = pid
        self.recipeConfigPath = recipeConfigPath
        self.calibrationAssetsPath = calibrationAssetsPath
        self.evidenceStoragePath = evidenceStoragePath
        self.createdAt = createdAt
    }
}
