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
    /// 文件存在但读不回（损坏/截断/字段不符）时为 true。
    ///
    /// 没有这个标记时，损坏的 projects.json 会被 `load()` 静默当成"0 个项目"，
    /// 而紧接着的任何一次 `create()`/`remove()` 就把空表覆写上去——用户的注册项
    /// 无声丢失，且再也找不回。同仓 `ApprovalGate.loadFailed` 已是这个口径
    /// （P5 §3.4「不把损坏读成空台账」），两处标准此前不一致，现在对齐：
    /// 载入失败 → 拒绝覆写，直到进程重启重新读取。
    ///
    /// 这个锁**故意不做自动解锁**：调用方此刻内存里是一份"从损坏文件得来的空表"，
    /// 而磁盘可能已被用户手工修好并装有真实条目。要么自动重读（丢掉本次刚写的
    /// 那一条），要么照旧覆写（丢掉文件里全部真条目）——两个方向都是无声丢数据，
    /// 所以唯一诚实的处理是拒绝写入并让人重启进程，让读取和写入来自同一份状态。
    public private(set) var loadFailed = false

    /// 路径必须显式给出。这是有意的：`swift test` 曾因默认路径而每次运行都往
    /// 开发者的真实 `~/.glasspane/projects.json` 里写假项目（审计 A-1，实测造成
    /// 一次不可恢复的覆盖）。生产侧的"真实路径"只有 `live()` 这一个入口，
    /// 单测侧则必须注入临时目录（`Tests` 里的 `ephemeralProjectRegistry()`）。
    public init(filePath: String) {
        self.filePath = filePath
        load()
    }

    /// 生产注册表：`~/.glasspane/projects.json`。仅 daemon 与其一次性 CLI 子命令
    /// 使用；任何测试构造它都应当被判为缺陷（`ProjectRegistryIsolationTests`）。
    public static func live() -> ProjectRegistry {
        ProjectRegistry(filePath: defaultProjectsPath)
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
        // 先落盘、成功后才改内存：`projects.remove(at:)` 先行的话，一旦写入抛错
        // 内存里就没有了这条而磁盘上还在——长驻的 daemon 会带着这份幻影继续
        // 应答（`--project-prune` 的 pruned 计数也正是从这里读的）。
        var candidate = projects
        candidate.append(entry)
        try save(candidate)
        projects = candidate
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
        var candidate = projects
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
            candidate[index].displayName = displayName
        }
        if let bundleId { candidate[index].bundleId = bundleId }
        if let pid { candidate[index].pid = pid }
        if let recipeConfigPath { candidate[index].recipeConfigPath = recipeConfigPath }
        if let calibrationAssetsPath { candidate[index].calibrationAssetsPath = calibrationAssetsPath }
        if let evidenceStoragePath { candidate[index].evidenceStoragePath = evidenceStoragePath }
        let entry = candidate[index]
        try save(candidate)
        projects = candidate
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
        var candidate = projects
        candidate.remove(at: index)
        try save(candidate)
        projects = candidate
        return true
    }

    // MARK: - Persistence

    private func load() {
        guard FileManager.default.fileExists(atPath: filePath) else { return }
        guard let data = FileManager.default.contents(atPath: filePath) else {
            loadFailed = true
            return
        }
        guard let decoded = try? JSONDecoder().decode([ProjectEntry].self, from: data) else {
            loadFailed = true
            return
        }
        projects = decoded
    }

    /// 写入的是 `candidate`（还没生效的那份表），成功之后调用方才 adopt 它——
    /// 失败时内存状态保持与磁盘一致，长驻的 daemon 不会带着幻影条目继续应答。
    ///
    /// 载入失败即拒绝覆写（否则一次写入就把全部注册项抹平）。三条都是
    /// "报成功之前先确认真的成功了"：编码失败、写入失败不再被 `try?` 咽掉
    /// （此前 `create()` 会在什么都没落盘的情况下返回成功）；写完读回比对
    /// （磁盘满/权限改过/替换中断，都只会让 `write` 不抛错而内容不对）；
    /// `replaceItemAt` 留下的备份件必须清掉，否则每次写入都在目录里留一份
    /// 含全部注册项的旧副本。
    private func save(_ candidate: [ProjectEntry]) throws {
        guard !loadFailed else {
            throw GPError(
                code: .internalError,
                message: "registry at \(filePath) exists but could not be decoded; refusing to overwrite it, because this process is holding an empty table read from that unreadable file. Remedy: make the file readable again (restore it from a copy), then restart the background service so it re-reads: `node <repo>/installer/cli.js --restore-launchd`, or the restart button in the GlassPane panel. Writes stay refused until the process restarts."
            )
        }
        let data: Data
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            data = try encoder.encode(candidate)
        } catch {
            throw GPError(
                code: .internalError,
                message: "could not encode registry (\(candidate.count) entries) for \(filePath): \(error.localizedDescription)"
            )
        }
        // Atomic write: tmp + rename (same filesystem ⇒ atomic on macOS).
        // 临时文件名必须唯一：daemon 与一次性 CLI 进程共用同一个 projects.json，
        // 固定的 ".tmp" 后缀会让两个写入者互相踩对方的中间文件。
        let tmpPath = filePath + ".\(UUID().uuidString).tmp"
        let destination = URL(fileURLWithPath: filePath)
        do {
            try data.write(to: URL(fileURLWithPath: tmpPath), options: [.atomic])
            if let backup = try? FileManager.default.replaceItemAt(
                destination,
                withItemAt: URL(fileURLWithPath: tmpPath)
            ), backup != destination {
                // 被换下来的原件以备份名留在原地；留着它就是留一份旧注册表副本。
                try? FileManager.default.removeItem(at: backup)
            } else {
                // replaceItemAt 失败：中间文件必须清掉，不能留下 .tmp 让下次写入踩到。
                try? FileManager.default.removeItem(atPath: tmpPath)
                try data.write(to: destination, options: [.atomic])
            }
        } catch {
            try? FileManager.default.removeItem(atPath: tmpPath)
            throw GPError(
                code: .internalError,
                message: "could not write registry to \(filePath): \(error.localizedDescription)"
            )
        }
        try verifySaved(data, to: filePath)
    }

    /// 读回校验：文件里的字节必须与刚编码出的那份一致。
    /// 不一致即抛错——注册表的语义是"这条注册项已经存好了"，说成了却没存就是
    /// 在审计面上撒谎。
    private func verifySaved(_ data: Data, to path: String) throws {
        guard FileManager.default.fileExists(atPath: path) else {
            throw GPError(code: .internalError, message: "registry write reported no error but \(path) does not exist")
        }
        guard let onDisk = FileManager.default.contents(atPath: path) else {
            throw GPError(code: .internalError, message: "registry written but \(path) could not be read back for verification")
        }
        guard onDisk == data else {
            throw GPError(
                code: .internalError,
                message: "registry write did not land: \(path) holds \(onDisk.count) bytes, expected \(data.count)"
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
