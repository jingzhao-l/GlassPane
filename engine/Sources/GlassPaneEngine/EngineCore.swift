import Foundation

/// Engine orchestration: attachment state, the act pipeline (P0 spec §3.3
/// 语义细则), evidence assembly, and the bounded in-memory evidence history.
/// All observable behavior goes through RuntimeChannel, so the complete
/// walking-skeleton loop is unit-testable without accessibility permission.
public final class EngineCore {

    /// Settle interval between performing the action and the post-capture.
    public static let actSettleInterval: TimeInterval = 0.15
    /// X-10: one definition, not two. This *is* the messaging timeout `AXChannel`
    /// installs on the app element, so it is derived from that constant: a lone
    /// edit there used to leave the reported ping latency disagreeing with the
    /// real hang budget. `performanceLatencyBudgetMs` is NOT a copy of
    /// `AXChannel.treeTimeoutSeconds` despite both reading 10 s: one budgets the
    /// whole act pipeline, the other a single tree walk.
    public static let pingTimeoutMs: Double = AXChannel.messagingTimeoutSeconds * 1000
    /// Evidence packs kept in memory (P0: recent entries only, never on disk).
    public static let historyLimit = 64
    /// Performance circuit-breaker budget (P1 spec v1.1 §2.2): an act whose
    /// full pipeline exceeds this wall-clock budget is flagged so diagnosis
    /// can separate "channel slow" from "channel broken".
    public static let performanceLatencyBudgetMs: Double = 10_000
    /// In-memory snapshot retention cap (P1 spec v1.1 §1.5).
    public static let snapshotHistoryLimit = 8

    public let version = "1.3.0"
    public let protocolVersion = "0"
    public private(set) var attachedApp: AttachedApp?
    /// Currently active project (P1 spec v1.4 §1.3). Set via attach with projectId.
    public private(set) var activeProjectId: String?
    public private(set) var shutdownRequested = false

    private let channel: RuntimeChannel
    private let clock: () -> Date
    private let settle: () -> Void
    private var history: [EvidencePack] = []
    /// Recent app-state snapshots (P1 spec v1.1 §1.5); FIFO-evicted.
    private var snapshots: [AppStateSnapshot] = []
    /// Project registry (P1 spec v1.4 §1). `nil` means **this engine instance
    /// has no registry at all** — it does not open a file. C-03: the initializer
    /// used to fold `nil` into `ProjectRegistry()`, i.e. the developer's own
    /// `~/.glasspane/projects.json`, and 47 of the test call sites never passed
    /// the argument, which is how a `swift test` run replaced 71 real
    /// registrations with two fixtures. A registry-less engine answers every
    /// project lookup with `GP_E_NOT_FOUND` and says that in the message.
    public let projectRegistry: ProjectRegistry?
    /// File-persisted evidence archive (P1 spec v1.5 §9). Empty disk side
    /// when `nil` is injected — used to disable persistence in tests that
    /// assert pure in-memory behavior.
    private let evidenceStore: EvidenceStore?
    /// Concurrency attribution guard (P2 spec v2.0 §15.4). Nil disables C33 —
    /// act() then behaves exactly like v1.6.
    private let attributionGuard: AttributionGuard?
    /// Progressive degradation tracker (P2 spec v2.1 §18.3). Nil disables T9 —
    /// act() then behaves exactly like v2.0.
    private let degradationTracker: DegradationTracker?
    /// Process metrics adapter feeding memory/handle signals into the tracker.
    /// Nil means those signals are absent: the joint verdict can then never
    /// reach .degrading (honest degradation instead of fake slopes).
    private let metricsProbe: ProcessMetricsProviding?
    /// Approval ledger (P5 spec v5.0 §3.5): nil disables registration and
    /// restore behaves exactly as before. Non-nil registers a high-risk record
    /// before each executed restore.
    private let approvalGate: ApprovalGate?
    /// Tier-1 probe signal slot (P5 spec v5.0 §6.4): invoked at every snapshot
    /// capture to attach a `SnapshotProbeInfo` payload. The daemon does not
    /// inject a probe (this repo ships none), so it yields nil; tests inject
    /// scripted payloads to exercise the rollback_full pipeline.
    private let snapshotProbe: (() -> SnapshotProbeInfo?)?
    /// Probe inbox (P6 spec v6.0 §5.2). Nil or connection-less means the
    /// Z5-only black-box form: handlerProbe/stateDiff stay null and act()
    /// behaves exactly like v5.0 — the honest absence is preserved verbatim.
    private let probeInbox: ProbeInbox?
    /// TCC 席位自报钩子（P1 spec v1.2 §11.2）：daemon 注入自身探针，`hello`
    /// 因此带上 `identity` + `permissions`，让设置面板读到的是**授权主体
    /// （daemon 进程）**的状态而非面板进程的。缺省 nil 表示不上报（旧行为，
    /// 面板据此如实降级为"未验证"，不猜测）。
    private let permissionsReport: (() -> DaemonPermissionSnapshot?)?
    /// A-08: why this instance has **no** `attributionGuard`, stated by the
    /// daemon that built it (`--no-c33`, or the event tap could not be created).
    ///
    /// Without a guard the contamination of an act window is not measured, and
    /// the archive used to record that as `contaminated: false` + `.soft` while
    /// the sibling path — a tap that stops mid-window — records the conservative
    /// `true` + `.weak`. One state, two conclusions, and the lying one was the
    /// artifact. With a reason supplied both paths now answer the same way;
    /// `nil` stays only where no daemon made the claim (an engine built by a
    /// test), and the act response says so instead of inventing a cause.
    private let inputMonitorAbsenceReason: String?
    /// R3-1: the operator's **declaration** that no human input reaches this
    /// machine during the window (`--unattended-window`). It is not a
    /// measurement, and it can never override one: it changes the verdict only
    /// where nothing was watched at all, so a window with an observed human
    /// event stays `contaminated: true` no matter what was declared.
    ///
    /// Why a declaration is allowed to stand where a measurement may not: the
    /// `contaminated: true` that an unwatched window produces is an *inference*
    /// from the absence of a channel ("we cannot rule it out"), not a fact the
    /// daemon observed. A maintenance run — a smoke harness, a CI box, a headless
    /// host — knows something the daemon does not: that there is nobody at the
    /// keyboard. Without that third input, the strongest attribution level
    /// (`.strong`, P6 §2.3) is unreachable for every daemon started with
    /// `--no-c33`, which is exactly how the only end-to-end probe gate
    /// (`engine/.p6_smoke.py`) was pinned red: it asserted a `.strong` canary
    /// against a daemon that could only ever answer `.weak`. The declaration is
    /// recorded in the archive as a declaration (`contaminationBasis`), so a
    /// reader can always tell "nobody was there" from "somebody watched and saw
    /// nothing".
    private let declaresUnattendedWindow: Bool
    /// A-01: per-snapshot record of a checkpoint export that **ran and failed**,
    /// keyed by snapshotId, so `restore(mode: rollback_full)` can distinguish
    /// "this snapshot has no probe payload because nothing was exported" from
    /// "the probe answered and the answer was unusable". Bounded with the
    /// snapshot ring it belongs to.
    private var checkpointExportFailures: [String: String] = [:]
    /// 上一次证据**落盘失败**（R1-07）。`EvidenceStore.write` 返回 Bool，`persist()`
    /// 过去把它丢掉：档案没落盘时响应照旧带 `evidenceId`，整段审计只在内存 64
    /// 环里、重启即蒸发。写盘仍按规范不抛（v1.5 §11.2），失败改由这个面表达。
    public struct EvidencePersistenceFailure: Equatable {
        public let operationId: String
        public let directory: String
        public let at: String
    }
    public private(set) var lastEvidencePersistenceFailure: EvidencePersistenceFailure?
    /// 最近一次 act 实测到的污染输入（R1-09）。冻结的 evidence schema 是
    /// strictObject，装不下这些事件，所以它们走 act 响应与 `hello` 的增量键。
    public struct ContaminationRecord: Equatable {
        public let operationId: String
        public let events: [InputEvent]
    }
    public private(set) var lastContamination: ContaminationRecord?
    /// `humanInputEvents` 的投递上限；`humanInputEventCount` 始终是真实总数
    /// （样本可截断，计数不截断）。
    public static let humanEventWireLimit = 32
    /// Busy-input retry budget before surfacing GP_E_BUSY_INPUT.
    public static let idleRetryCount = 5
    /// Interval between busy-input retries.
    public static let idleRetryInterval: Double = 0.05
    /// op_end → window-close drain slack for probe-delivered state diffs.
    public static let probeEndDrainSeconds: TimeInterval = 0.06

    public init(
        channel: RuntimeChannel,
        clock: @escaping () -> Date = { Date() },
        settle: (() -> Void)? = nil,
        projectRegistry: ProjectRegistry? = nil,
        evidenceStore: EvidenceStore? = nil,
        attributionGuard: AttributionGuard? = nil,
        degradationTracker: DegradationTracker? = nil,
        metricsProbe: ProcessMetricsProviding? = nil,
        approvalGate: ApprovalGate? = nil,
        snapshotProbe: (() -> SnapshotProbeInfo?)? = nil,
        probeInbox: ProbeInbox? = nil,
        permissionsReport: (() -> DaemonPermissionSnapshot?)? = nil,
        inputMonitorAbsenceReason: String? = nil,
        declaresUnattendedWindow: Bool = false
    ) {
        self.channel = channel
        self.clock = clock
        self.settle = settle ?? { Thread.sleep(forTimeInterval: EngineCore.actSettleInterval) }
        self.projectRegistry = projectRegistry
        self.evidenceStore = evidenceStore
        self.attributionGuard = attributionGuard
        self.degradationTracker = degradationTracker
        self.metricsProbe = metricsProbe
        self.approvalGate = approvalGate
        self.snapshotProbe = snapshotProbe
        self.probeInbox = probeInbox
        self.permissionsReport = permissionsReport
        self.inputMonitorAbsenceReason = inputMonitorAbsenceReason
        self.declaresUnattendedWindow = declaresUnattendedWindow
    }

    // MARK: - ISO-8601 timestamp

    private static let isoFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    private func nowISO() -> String {
        Self.isoFormatter.string(from: clock())
    }

    // MARK: - Methods (P0 spec §3.3)

    public func hello() -> [String: Any] {
        var payload: [String: Any] = [
            "engine": "glasspaned",
            "version": version,
            "protocolVersion": protocolVersion,
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "capabilities": ["act", "observe", "assert_element", "audit_ui", "capture_view", "diagnose", "snapshot", "restore", "probe"]
        ]
        // P1 v1.2 §11.2：带上 daemon 自身的授权主体与四类席位（未注入钩子时
        // 整段省略——面板据此如实显示"未验证"，不以面板进程的权限冒充）。
        if let snapshot = permissionsReport?() {
            payload["identity"] = snapshot.subject.wireValue
            payload["permissions"] = snapshot.permissionsWire
        }
        // R1-07 / R1-09：两个"已经测到但冻结证据 schema 装不下"的事实走同一
        // 先例（hello 的增量可选键，方法表未变，旧客户端忽略即可）。
        // 读者现状，如实记录（A-12）：本仓库里**没有**这两个键的消费者。面板走
        // `DaemonProbe.parseHelloResponse`，它只挑 version/protocolVersion/pid/
        // identity/permissions 五个字段；协议方法表里也没有 `gp_hello` 工具，
        // 所以面板与 gp_act 都读不到它们。两键的同一事实另有两条**有读者**的
        // 出口：act 响应的 `evidencePersisted` / `humanInputEvents`，以及
        // `lastEvidencePersistenceFailure` / `lastContamination`（本类属性）。
        // 保留键本身不是为了兼容既有读者，而是给任何直接读 socket 帧的对端；
        // 接线一个真读者属于后续批次。
        if let failure = lastEvidencePersistenceFailure {
            payload["evidencePersistenceError"] = [
                "operationId": failure.operationId,
                "directory": failure.directory,
                "at": failure.at,
                "message": "the last evidence archive write failed; that operation exists only in the bounded in-memory history and is lost on daemon restart",
                "remedy": "make the evidence directory writable and check its free space (the archive directory is reported above), then re-run the operation; until then treat evidenceId values as non-durable"
            ]
        }
        if let contamination = lastContamination {
            payload["contamination"] = [
                "operationId": contamination.operationId,
                "count": contamination.events.count,
                "events": Self.humanEventsWire(contamination.events),
                "message": "human input events measured inside the last act window (attribution weak + contaminated=true)"
            ]
        }
        return payload
    }

    public func attach(bundleId: String?, pid: pid_t?, projectId: String? = nil) throws -> [String: Any] {
        // R1-01: the state transition is atomic. `channel.attach` rebinds the
        // AX target for the whole daemon, so the projectId is resolved against
        // the *requested* target BEFORE that rebind, and the checks that need
        // the resolved app roll the channel back on every throw. Before this, a
        // rejected projectId left the channel pointed at app B while
        // `attachedApp` still named app A: the next act went into the app the
        // user believes is untouched, with crash signals from B and attribution
        // recorded for A.
        let entry: ProjectEntry?
        if let projectId {
            let registry = try requireRegistry()
            guard let found = registry.get(projectId) else {
                throw GPError(code: .notFound, message: "unknown projectId \(projectId)")
            }
            if let mismatch = Self.projectTargetMismatch(
                projectId: projectId, entry: found, bundleId: bundleId, pid: pid
            ) {
                throw mismatch
            }
            // A-14 belt, checked *before* the channel rebinds so the refusal
            // cannot leave the AX target pointed at an app nobody approved
            // (same atomicity rule as R1-01).
            if let refusal = Self.evidenceStorageRefusal(projectId: projectId, entry: found) {
                throw refusal
            }
            entry = found
        } else {
            entry = nil
        }

        let previousApp = attachedApp
        let app: AttachedApp
        do {
            app = try channel.attach(bundleId: bundleId, pid: pid)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }

        // Attaching by pid says nothing about bundleId and attaching by bundleId
        // says nothing about a moved pid: the resolved app can still contradict
        // the registry entry. That rejection must not outlive the rebind.
        if let projectId, let entry, let mismatch = Self.projectMismatch(
            app: app, projectId: projectId, entry: entry
        ) {
            throw restoreChannel(afterFailed: mismatch, previous: previousApp)
        }

        // State commit happens only after every check passed. The stickiness of
        // `activeProjectId`/store directory on a projectId-less attach is the
        // existing (registered A-2) semantics and is deliberately untouched.
        if let projectId {
            activeProjectId = projectId
        }
        // The stored path was vetted by `evidenceStorageRefusal` before the
        // rebind; the only fall-through left is a project that never named one
        // (spec v1.5 §9.3). The directory is **reset on every attach**: a
        // project without an `evidenceStoragePath` returns the store to its
        // default directory, otherwise "attach A (has path) then attach B (no
        // path)" keeps writing B's evidence into A's archive — cross-project
        // cross-write, and the attribution is wrong on the record (v1.5 §9.3).
        if let evidenceStore {
            if let dir = entry?.evidenceStoragePath {
                evidenceStore.setDirectory(dir)
            } else {
                evidenceStore.useDefaultDirectory()
            }
        }
        // Re-attach to the same app is idempotent; a different app
        // invalidates the evidence history and the degradation window
        // (T9 traces are scoped to the app-under-test session, §18.3).
        if attachedApp != app {
            attachedApp = app
            history.removeAll()
            degradationTracker?.reset()
        }
        return attachResult(app)
    }

    /// Every project surface goes through here, so "no registry" and "registry
    /// unreadable" are both answered instead of being silently treated as an
    /// empty table.
    ///
    /// B-1 read half: a registry that could not be loaded reads as an empty
    /// table, so answering "unknown projectId" from it would be a fabricated
    /// negative — the registration may exist and be perfectly attachable. The
    /// refusal says what was measured instead (nothing), with the repair path.
    /// C-03 adds the other absence: an engine built without a registry has no
    /// file to be wrong about, and says that rather than opening one.
    private func requireRegistry() throws -> ProjectRegistry {
        guard let projectRegistry else {
            throw GPError(
                code: .internalError,
                message: "no project registry is configured for this engine instance, so no projectId can be resolved and nothing can be registered — this is not an answer about \(ProjectRegistry.defaultProjectsPath): nothing was read and nothing was written",
                remedy: Self.noRegistryRemedy
            )
        }
        guard !projectRegistry.loadFailed else {
            throw GPError(
                code: .internalError,
                message: "the daemon cannot answer any project lookup: \(projectRegistry.unreadableReport ?? "projects.json is unreadable"), so the \(projectRegistry.count) entries it holds are not the registered set",
                remedy: projectRegistry.unreadableRemedy
            )
        }
        return projectRegistry
    }

    /// The one answer every surface gives for a registry-less engine, so the
    /// lookup refusal and the list note cannot drift apart.
    static let noRegistryRemedy = "call the daemon started by `glasspaned` (it always configures a registry) and check what it sees with `glasspaned --list-projects`; attaching without projectId also works — that path needs no registry at all"

    // MARK: - Evidence archive location (A-14: the daemon is the last line)

    /// Trees that are never project data, checked against the *resolved* path.
    /// Mirrors `PROTECTED_SUBTREES` in mcp-shell/src/project-registry.ts: that
    /// guard only sees writes made through the shell, so a project registered
    /// before it existed — or by any other writer of projects.json — can still
    /// name one of these, and the daemon both writes evidence into the
    /// directory and deletes expired entries out of it.
    static let systemOwnedStorageTrees: [String] = [
        "/System", "/Applications", "/Library", "/private/etc",
        "/usr", "/bin", "/sbin", "/dev",
    ]

    /// Listed explicitly because `realpath` maps `/tmp` onto `/private/tmp`, a
    /// two-component path the generic "top-level directory" rule lets through.
    static let sharedScratchStoragePaths: [String] = [
        "/tmp", "/private/tmp", "/private/var/tmp",
    ]

    /// APFS firmlink: `realpath` reports data-resident paths as
    /// `/System/Volumes/Data/...`. Un-map it before the location rule, or every
    /// real path under the user's home reads as "inside /System".
    static let firmlinkPrefix = "/System/Volumes/Data"

    /// Why the stored shape itself is unusable, or nil. Pure — no filesystem.
    static func storedPathShapeDefect(_ stored: String) -> String? {
        guard stored.hasPrefix("/") else { return "is not an absolute path" }
        for component in stored.split(separator: "/", omittingEmptySubsequences: true)
        where component == "." || component == ".." {
            return "contains a \"\(component)\" component"
        }
        return nil
    }

    /// Why a *resolved* location is unusable, or nil when it is. Pure, so the
    /// whole rule set is testable without touching the filesystem.
    static func resolvedStoragePathDefect(
        resolved: String, home: String = NSHomeDirectory()
    ) -> String? {
        let stripped = stripFirmlink(resolved)
        let components = stripped.split(separator: "/", omittingEmptySubsequences: true)
        if components.isEmpty { return "the filesystem root" }
        // Subtree-matched, exactly like `systemOwnedStorageTrees` below. It used
        // to be `sharedScratchStoragePaths.contains(stripped)` — an equality
        // test — so `/private/tmp/x` passed here while the MCP shell (which
        // treats the same names as trees) refused it: the round that unified the
        // two *lists* left the *matching* apart, and a shared scratch directory
        // one level down is the same exposure as the directory itself.
        for scratch in sharedScratchStoragePaths
        where stripped == scratch || stripped.hasPrefix(scratch + "/") {
            return "inside the world-writable shared scratch directory \(scratch)"
        }
        if components.count == 1 { return "the top-level directory /\(components[0]) of the boot volume" }
        if components[0] == "Volumes", components.count == 2 { return "the root of a mounted volume" }
        for tree in systemOwnedStorageTrees where stripped == tree || stripped.hasPrefix(tree + "/") {
            return "inside the system-owned tree \(tree)"
        }
        let strippedHome = stripFirmlink(home)
        if stripped == strippedHome { return "the current user's home directory itself" }
        if stripped == "\(strippedHome)/Library" || stripped.hasPrefix("\(strippedHome)/Library/") {
            return "inside the current user's Library folder"
        }
        // Somebody else's home, and the shared one. The MCP shell has refused
        // these since B-13 while the daemon's list-based rule let them through,
        // so the same stored value passed the process that *writes*
        // `projects.json` and failed the one that archives into the directory —
        // the split this round is closing (J). This stays a name rule (pure, so
        // the whole set is testable without a filesystem); the ownership and
        // world-writable checks the shell performs need `stat` and are recorded
        // as the remaining gap, not silently claimed here.
        if components[0] == "Users", components.count >= 2 {
            let owner = String(components[1])
            if owner == "Shared" {
                return "the shared home tree /Users/Shared, which every local account can read"
            }
            if "/Users/" + owner != strippedHome {
                return "another user's home directory (/Users/\(owner))"
            }
        }
        return nil
    }

    static func stripFirmlink(_ path: String) -> String {
        if path == firmlinkPrefix { return "/" }
        if path.hasPrefix(firmlinkPrefix + "/") {
            return "/" + path.dropFirst(firmlinkPrefix.count + 1)
        }
        return path
    }

    /// `realpath` of the nearest existing ancestor with the not-yet-created tail
    /// re-appended (the sibling of `resolveExistingAncestor` in
    /// mcp-shell/src/project-registry.ts), so a link above the archive is judged
    /// on where it lands. nil = unmeasurable, and unmeasurable is refused.
    static func resolveStoragePath(_ stored: String) -> String? {
        var cursor = URL(fileURLWithPath: stored, isDirectory: true)
        var missingTail: [String] = []
        while true {
            do {
                let values = try cursor.resourceValues(forKeys: [.canonicalPathKey])
                guard let canonical = values.canonicalPath else { return nil }
                var url = URL(fileURLWithPath: canonical, isDirectory: true)
                for component in missingTail.reversed() {
                    url = url.appendingPathComponent(component, isDirectory: true)
                }
                return url.path
            } catch {
                let parent = cursor.deletingLastPathComponent()
                if parent.path == cursor.path { return nil }
                missingTail.append(cursor.lastPathComponent)
                cursor = parent
            }
        }
    }

    /// Why a location is not safely ours to archive into, judged by **ownership**
    /// on the nearest existing ancestor.
    ///
    /// The name rules in `resolvedStoragePathDefect` are a deny list; a deny list
    /// only ever covers what somebody thought to name. Measured on this machine:
    ///   * a real per-user temp dir (`getconf DARWIN_USER_TEMP_DIR`) is
    ///     `drwx------` owned by the user — admissible, and this must not refuse it;
    ///   * `/Users/Shared` is `drwxrwxrwt` owned by root — world-writable, so a
    ///     pack written "into a directory nobody owns" is readable-and-replaceable
    ///     by every local account;
    ///   * `/private/var/folders` is `drwxr-xr-x` owned by root, so a *fabricated*
    ///     `<folders>/<zz>/<zy>/T/<name>` path (which the name rules let through,
    ///     since `/T/` looks private) has no ancestor this process owns at all.
    ///
    /// That last case is a deliberate change to a previously-accepted shape: the
    /// MCP shell already refuses it (`project-registry.ts` ownership rule, tested
    /// at `project-registry.test.mjs:494`), and the daemon accepting what the
    /// write path refuses is the same split R4/J has been closing. The asymmetry
    /// was never safe — evidence archives are the audit trail, and one written
    /// into a directory another account can write can be edited by that account.
    ///
    /// Not pure (it stats the filesystem), so it is a separate predicate from
    /// `resolvedStoragePathDefect`, which stays a pure name rule the whole table
    /// can be tested against without touching disk.
    ///
    /// Two outcomes of a `stat` are not one absence. Measured on this machine:
    /// a path that is not there fails with `NSCocoaErrorDomain` 260 (POSIX ENOENT)
    /// while a path behind a directory the process may not search fails with 257
    /// (EACCES) — including the case where *nothing* under that directory can be
    /// named. The loop used to fold both into an empty attribute set and climb to
    /// the parent, so an unsearchable ancestor quietly certified everything below
    /// it. That is the same mistake the ledger fix made in the other direction
    /// ("cannot read" reported as "private"): the check's answer has to be about
    /// what it saw.
    static func ownabilityDefect(path: String) -> String? {
        var cursor = URL(fileURLWithPath: path, isDirectory: true)
        while true {
            let attributes: [FileAttributeKey: Any]
            do {
                attributes = try FileManager.default.attributesOfItem(atPath: cursor.path)
            } catch let failure as NSError where failure.domain == NSCocoaErrorDomain
                && failure.code == NSFileReadNoSuchFileError {
                attributes = [:]  // genuinely not there: ask the directory above it
            } catch let failure as NSError {
                return "\(cursor.path) cannot be examined (\(failure.domain) \(failure.code)), "
                    + "so nothing here can say who would be able to write into it"
            } catch {
                return "\(cursor.path) cannot be examined (unclassified stat failure), "
                    + "so nothing here can say who would be able to write into it"
            }
            if !attributes.isEmpty {
                guard let number = attributes[.posixPermissions] as? NSNumber else {
                    return "\(cursor.path) exists but its permissions cannot be read"
                }
                let mode = Int(truncating: number)
                if mode & 0o022 != 0 {
                    return "\(cursor.path) is writable by group or other (mode "
                        + String(format: "%04o", mode) + "), so an evidence pack under it is not tamper-evident"
                }
                let owner = attributes[.ownerAccountID] as? NSNumber
                if (owner?.intValue ?? -1) != Int(getuid()) {
                    return "\(cursor.path) is owned by uid \(owner?.intValue ?? -1), not this process (uid \(getuid()))"
                }
                return nil
            }
            let parent = cursor.deletingLastPathComponent()
            if parent.path == cursor.path {
                return "\(path) has no existing ancestor this process can examine"
            }
            cursor = parent
        }
    }

    /// Everything wrong with a stored `evidenceStoragePath` (nil = adoptable).
    /// Public because the `glasspaned` maintenance CLI is a second *deleting*
    /// reader of the same stored value and must apply this exact rule (A-07).
    public static func evidenceStoragePathDefect(_ stored: String) -> String? {
        if let shape = storedPathShapeDefect(stored) { return shape }
        guard let resolved = resolveStoragePath(stored) else {
            return "cannot be located (`realpath` failed all the way up its path), and the daemon will not archive into or prune a directory it cannot resolve"
        }
        if let nameDefect = resolvedStoragePathDefect(resolved: resolved) { return nameDefect }
        // Ownership last: it is the one step that touches disk, and it answers the
        // question the deny list cannot — "is this directory ours to archive into".
        return ownabilityDefect(path: resolved)
    }

    /// The refusal, worded so the caller sees both honest options: fix the
    /// registration, or attach without a project.
    public static func evidenceStorageRefusal(projectId: String, entry: ProjectEntry) -> GPError? {
        guard let stored = entry.evidenceStoragePath else { return nil }
        guard let defect = evidenceStoragePathDefect(stored) else { return nil }
        return GPError(
            code: .badParams,
            message: "project \(projectId) stores evidenceStoragePath \"\(stored)\", which \(defect). The daemon writes evidence files into that directory and deletes expired ones out of it, so it refuses to adopt the stored value — and it will not quietly archive somewhere else while reporting this project's path either.",
            remedy: evidenceStorageRemedy
        )
    }

    /// A project that never named a directory owns no archive. Pruning
    /// `EvidenceStore.defaultDirectory` in its place would delete from an
    /// archive the caller never pointed at.
    public static func noArchiveRefusal(projectId: String) -> GPError {
        GPError(
            code: .badParams,
            message: "project \(projectId) has no evidenceStoragePath, so it owns no evidence archive of its own; the shared default directory (\(EvidenceStore.defaultDirectory)) is not its substitute and nothing was deleted",
            remedy: "name the archive you mean instead of leaving the target implicit. This project's own: gp_project_set with \"evidenceStoragePath\": \"\(evidenceStorageExample)\" and then restart the background service (`launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon`) so it reloads projects.json. The shared archive: `glasspaned --prune-evidence --older-than <days>` with no `--project` — that is the process which owns it; an engine instance built without one has no shared archive to fall back to and says so, and leaving projectId out of a call on such an instance deletes nothing."
        )
    }

    /// The same rule seen from the other side: an engine that was handed **no
    /// archive** owns no directory to prune or to measure. `pruneEvidence` used
    /// to fold that absence into `EvidenceStore.defaultDirectory` and delete
    /// aged entries from the shared archive, which is the substitution
    /// `noArchiveRefusal` already refuses for a project that named no directory
    /// — and the textual isolation gate cannot see it, because the shared
    /// archive is reached by *omitting* an argument rather than by naming a
    /// path token. "No store injected" means no disk side effect.
    ///
    /// Public for the same reason as `noArchiveRefusal`: the words are a
    /// contract a test pins by equality, and they have to send the agent to the
    /// surface that *does* own the shared archive — `glasspaned --prune-evidence`
    /// with no `--project` — instead of to a store this instance lacks.
    public static func noStoreArchiveRefusal() -> GPError {
        GPError(
            code: .badParams,
            message: "this engine instance has no evidence archive injected, so it has no directory to prune or measure: the shared default directory (\(EvidenceStore.defaultDirectory)) is not its substitute and nothing was deleted",
            remedy: "name the archive you mean. Either give this instance one where it is built — EngineCore(evidenceStore:) with a store over a directory, the way the background service injects EvidenceStore.at(stateRoot:) with the root --state-dir named (or the home default when nothing was named) — or scope the call to a project that owns one: gp_project_set {\"projectId\": \"<that prj_…>\", \"displayName\": …, \"bundleId\" or \"pid\": …, \"evidenceStoragePath\": \"\(evidenceStorageExample)\"} (repeat the project's other fields — the update replaces them), restart the background service so it reloads projects.json (`launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon`), then call again with that projectId. To prune the shared archive itself use the process that owns it: `glasspaned --prune-evidence --older-than <days>`, after looking at what is there with `glasspaned --evidence-stats` and counting without deleting via `--dry-run`"
        )
    }

    /// The single resolution of "which archive directory does this project
    /// own", or the refusal that says why none may be touched. Shared by
    /// `pruneEvidence` (engine method) and `glasspaned --prune-evidence` /
    /// `--evidence-stats --project` (A-07/C-06): the half that deletes used to
    /// hand the stored value straight to `EvidenceStore` while `attach` refused
    /// to adopt the same value.
    public static func projectArchiveDirectory(
        projectId: String, entry: ProjectEntry
    ) -> Result<String, GPError> {
        if let refusal = evidenceStorageRefusal(projectId: projectId, entry: entry) {
            return .failure(refusal)
        }
        guard let stored = entry.evidenceStoragePath else {
            return .failure(noArchiveRefusal(projectId: projectId))
        }
        return .success(stored)
    }

    static let evidenceStorageExample = "/Users/you/work/notes-app/.glasspane/evidence"

    /// The same remedy for whichever of the three path fields was refused.
    ///
    /// `evidenceStorageRemedy` spells its own key exactly once (pinned by
    /// `EngineCoreTests.testAllThreePathFieldsAreCheckedAtWriteTimeAndTheRemedyNamesTheRightOne`),
    /// so naming the rejected field here is a substitution on that single
    /// occurrence rather than a second copy of the sentence that could drift. An
    /// agent told to re-set `evidenceStoragePath` after `recipeConfigPath` was
    /// refused would run a command that changes nothing about its own error.
    public static func pathRemedy(field: String) -> String {
        evidenceStorageRemedy.replacingOccurrences(of: "\"evidenceStoragePath\":", with: "\"\(field)\":")
    }

    public static let evidenceStorageRemedy = "re-point the registration at a project-owned directory and reload: gp_project_set with {\"projectId\": \"<that prj_…>\", \"displayName\": …, \"bundleId\" or \"pid\": …, \"evidenceStoragePath\": \"\(evidenceStorageExample)\"} (repeat the project's other fields — the update replaces them), then restart the background service, which read projects.json once at startup: `launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon`. Attaching without projectId is the other honest choice: the daemon then keeps its own archive directory instead of adopting this project's."

    /// 注册表条目与**请求参数**的对照（`channel.attach` 之前，R1-01）。
    /// 只能判断两侧都给出了同一个字段的情形；跨字段（attach by pid vs
    /// entry.bundleId）留给 `projectMismatch`。
    private static func projectTargetMismatch(
        projectId: String, entry: ProjectEntry, bundleId: String?, pid: pid_t?
    ) -> GPError? {
        if let expectedBundleId = entry.bundleId, let bundleId, expectedBundleId != bundleId {
            return GPError(
                code: .badParams,
                message: "projectId \(projectId) expects bundleId '\(expectedBundleId)' but attach requested '\(bundleId)'"
            )
        }
        if let expectedPid = entry.pid, let pid, expectedPid != pid {
            return GPError(
                code: .badParams,
                message: "projectId \(projectId) expects pid \(expectedPid) but attach requested pid \(pid)"
            )
        }
        return nil
    }

    /// 注册表条目与**已解析 app**的对照（`channel.attach` 之后，R1-01）；
    /// 错误码与文案沿用既有口径。
    private static func projectMismatch(
        app: AttachedApp, projectId: String, entry: ProjectEntry
    ) -> GPError? {
        if let expectedBundleId = entry.bundleId {
            guard expectedBundleId == app.bundleId else {
                return GPError(
                    code: .badParams,
                    message: "projectId \(projectId) expects bundleId '\(expectedBundleId)' but attached '\(app.bundleId ?? "nil")'"
                )
            }
        }
        if let expectedPid = entry.pid {
            guard expectedPid == app.pid else {
                return GPError(
                    code: .badParams,
                    message: "projectId \(projectId) expects pid \(expectedPid) but attached \(app.pid)"
                )
            }
        }
        return nil
    }

    /// R1-01: a rejected attach after the channel already rebound must put the
    /// channel back where it was. Best-effort re-attach to the previous app
    /// (pid wins in `AXChannel.resolveRunningApplication`, so it is the same
    /// process). When even that fails, the engine drops its attachment: acting
    /// on a channel whose target cannot be vouched for is exactly the failure
    /// this fix exists to prevent, so `act`/`observe` now fail closed with
    /// GP_E_NOT_ATTACHED until the caller attaches again — and the thrown error
    /// says so.
    private func restoreChannel(
        afterFailed rejection: GPError, previous: AttachedApp?
    ) -> GPError {
        guard let previous else {
            // Nothing was attached before: `attachedApp` stays nil, so every
            // channel-using method already refuses with GP_E_NOT_ATTACHED.
            return rejection
        }
        do {
            _ = try channel.attach(bundleId: previous.bundleId, pid: previous.pid)
            return rejection
        } catch {
            attachedApp = nil
            return GPError(
                code: rejection.code,
                message: rejection.message + "; the previously attached app '\(previous.appName)' (pid \(previous.pid)) could not be restored either",
                remedy: rejection.remedy + "; the engine dropped its attachment — call attach again (act/observe fail with GP_E_NOT_ATTACHED until then)"
            )
        }
    }

    /// `degrade`（P6 §11 / R21）：输入窗口忙时不再抛 GP_E_BUSY_INPUT，而是
    /// 放行并把本次证据如实标注 weak + contaminated=true——remedy 里承诺的
    /// "proceed in degrade mode" 从此是真参数。缺省 false：既有语义逐字不变。
    public func act(selector: Selector, action: Action, degrade: Bool = false) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        // C33 concurrency attribution protection (P2 spec v2.0 §15.4): the
        // daemon must hold the operation right before acting. If real user
        // input keeps the input window busy, retry a bounded number of times
        // then surface GP_E_BUSY_INPUT instead of silently running polluted —
        // unless the caller declared `degrade`, which admits the act with the
        // contamination charged into evidence (never silently clean).
        var contaminationVerdict: OperationRightVerdict?
        if let attributionGuard {
            var acquisition: OperationRightAcquisition = .idleNotMet
            var attempts = 0
            while attributionGuard.isHolding == false {
                acquisition = attributionGuard.acquireOperationRight(degradeOnBusy: degrade)
                if acquisition == .acquired {
                    break
                }
                attempts += 1
                guard attempts < EngineCore.idleRetryCount else { break }
                Thread.sleep(forTimeInterval: EngineCore.idleRetryInterval)
                acquisition = .idleNotMet
            }
            guard acquisition == .acquired else {
                throw GPError(
                    code: .busyInput,
                    message: "input window stayed busy for \(attempts) retries; refusing a possibly contaminated act"
                )
            }
        }
        // Safety net: any throw path below still releases the operation right.
        defer {
            if let attributionGuard, attributionGuard.isHolding {
                _ = attributionGuard.releaseOperationRight()
            }
        }

        let started = clock()
        // P6 §2.3: the operationId is generated up-front so probe events can
        // be windowed against it. Still a fresh ULID per act, same contract.
        let operationId = OperationID.generateLive()

        let aliveBefore = channel.isProcessAlive()

        // AX responsiveness probe.
        var responsiveness: ResponsivenessSignal
        do {
            let pingMs = try channel.ping()
            responsiveness = ResponsivenessSignal(responsive: true, pingMs: pingMs)
        } catch let error as ChannelError where error == .pingTimeout {
            responsiveness = ResponsivenessSignal(responsive: false, pingMs: Self.pingTimeoutMs)
        } catch let error as ChannelError {
            // R1-04: every other channel fault (Accessibility seat revoked
            // mid-session, `apiDisabled`, …) maps onto its protocol code like
            // the sibling sites below. Left unmapped it escaped as a bare
            // ChannelError, which the dispatcher folds into
            // GP_E_INTERNAL/"check the daemon log" — dropping the
            // GP_E_AX_UNAVAILABLE remedy the agent can actually execute.
            throw EngineCore.map(error)
        }

        // Pre-capture.
        var treeBefore: AxTreeSnapshot?
        if aliveBefore && responsiveness.responsive {
            do {
                treeBefore = try channel.treeSnapshot(maxDepth: Self.defaultObserveDepth)
            } catch let error as ChannelError {
                if case .axUnavailable = error { throw EngineCore.map(error) }
                treeBefore = nil
            }
        }
        var captureBefore: WindowCapture?
        // X-6: why a capture did not happen is itself a measurement, and
        // `SCKCapturer` now states it precisely; `captureBefore == nil` alone
        // mis-diagnosed three different failures as a missing seat.
        var captureBeforeFailure: String?
        if aliveBefore && responsiveness.responsive {
            do {
                captureBefore = try channel.captureWindow()
            } catch {
                captureBefore = nil
                captureBeforeFailure = Self.pixelCaptureFailureReason(for: error)
            }
        }

        // P6 §5.2: open the probe attribution window right before the action
        // is performed. A window only exists for a live probe connection to
        // the attached pid; otherwise the Z5-only form proceeds untouched.
        let probePid: Int32? = {
            guard let inbox = probeInbox, let app = attachedApp,
                  inbox.connection(for: app.pid) != nil else { return nil }
            return app.pid
        }()
        // X-11: `sendCommand` answers whether the bytes left the daemon. A
        // probe never told the window opened cannot have diffed it, so the
        // silence that explains is never reported as an observation.
        var probeCommandFailure: String?
        if let inbox = probeInbox, let pid = probePid {
            inbox.beginWindow(pid: pid, opId: operationId)
            if !inbox.sendCommand("op_begin", to: pid) {
                probeCommandFailure = inbox.lastDeliveryError ?? "op_begin was never delivered to pid \(pid)"
            }
        }

        // Perform the action.
        var actConfirmed = false
        var actRejectReason: String?
        var actRejectRemedy: String?
        if !aliveBefore {
            actRejectReason = "target process is not alive"
        } else if !responsiveness.responsive {
            actRejectReason = "app unresponsive (AX ping timeout)"
        } else {
            do {
                try channel.performAction(selector: selector, action: action)
                actConfirmed = true
            } catch let error as ChannelError {
                if case .axUnavailable = error { throw EngineCore.map(error) }
                // X-9: the reason alone used to carry no remedy, so every
                // rejection answered with GP_E_ACT_FAILED's default "try
                // another action or verify the selector" — wrong advice for a
                // channel that timed out mid-search.
                let rejection = Self.actRejection(for: error)
                actRejectReason = rejection.reason
                actRejectRemedy = rejection.remedy
            }
        }

        // Settle, then post-capture.
        if actConfirmed {
            settle()
        }
        var treeAfter: AxTreeSnapshot?
        var axAfterCaptureFailure: String?
        if treeBefore != nil, aliveBefore, actConfirmed {
            do {
                treeAfter = try channel.treeSnapshot(maxDepth: Self.defaultObserveDepth)
            } catch {
                // R1-03: the post-action tree is a *measurement*, and this is
                // the case where it did not happen. Folding it into
                // `axChanged: false` reported "the UI did not react" — an
                // unmeasured verdict — while the breaker stayed green.
                axAfterCaptureFailure = "\(error)"
            }
        }
        var captureAfter: WindowCapture?
        var captureAfterFailure: String?
        if captureBefore != nil, aliveBefore {
            do {
                captureAfter = try channel.captureWindow()
            } catch {
                captureAfter = nil
                captureAfterFailure = Self.pixelCaptureFailureReason(for: error)
            }
        }

        // P6 §2.3: close the probe window after the post-captures (t1) and
        // pull the [t0, t1] handler/state signals out of the inbox.
        var probeSignals: (handlerProbe: HandlerProbeSignal?, stateDiff: StateDiffSignal?)?
        if let inbox = probeInbox, let pid = probePid {
            let opEndDelivered = inbox.sendCommand("op_end", to: pid)
            if !opEndDelivered {
                let reason = inbox.lastDeliveryError ?? "op_end was never delivered to pid \(pid)"
                probeCommandFailure = probeCommandFailure.map { "\($0); \(reason)" } ?? reason
            }
            // Drain slack: the probe emits its op_end-baseline mirror diff
            // synchronously on command handling; 60 ms covers loopback
            // delivery before the window closes (P6 §2.3, probe-connected
            // acts only — Z5-only acts pay nothing). A command that never
            // left has nothing to wait for.
            if opEndDelivered {
                Thread.sleep(forTimeInterval: EngineCore.probeEndDrainSeconds)
            }
            probeSignals = inbox.endWindow(pid: pid, opId: operationId)
            // X-11: `changed == false` after an undelivered op_begin/op_end is
            // not "the state did not move", it is "the probe was never asked".
            // A diff that *did* report movement stays (those frames are their
            // own measurement, §3.1 presence rule). The handler count needs no
            // command — the SDK emits Z1 frames unconditionally — so a measured
            // zero stays a measurement and is kept verbatim.
            if probeCommandFailure != nil {
                if var signals = probeSignals, signals.stateDiff?.changed == false {
                    signals.stateDiff = nil
                    probeSignals = signals
                }
            }
        }

        let latencyMs = clock().timeIntervalSince(started) * 1000

        // Signals.
        let axChanged = Self.axChanged(before: treeBefore, after: treeAfter)
        let axEvent: AxEventSignal?
        if let before = treeBefore, let after = treeAfter, let axChanged {
            axEvent = AxEventSignal(
                treeDigestBefore: before.digest,
                treeDigestAfter: after.digest,
                nodeCount: after.nodeCount,
                axChanged: axChanged,
                latencyMs: latencyMs
            )
        } else {
            axEvent = nil
        }
        let pixelDiff: PixelDiffSignal?
        // nil = 像素通道没有给出测量（R1-03 同一口径：未测量不折算成 false）。
        var pixelChanged: Bool?
        // X-6: the diff itself can fail after both captures succeeded. That is
        // a third fact, and it used to be reported with the capture's label.
        var pixelDiffFailure: String?
        if let before = captureBefore, let after = captureAfter, before.windowId != after.windowId {
            // 前后两次截的**不是同一个窗口**（应用换窗、新开了一个同尺寸窗口）。
            // 逐像素比出来的数字仍然在 0...1 之间，看起来完全像一次正常测量，但它说的是
            // "两个不同窗口的差别"，不是"这次操作改变了界面"——那是伪造的证据。
            // 这条路径在 2026-09-25 之前从未被走到（窗口查找的键名写错，捕获恒失败），
            // 现在它真的会跑到，所以这里必须能拒绝。
            // 标签由 `pixelCaptureFailureLabel` 生成，不自己拼一个：像素通路的成因
            // 分类只能有一套（R2-06 的教训）。
            pixelDiff = nil
            pixelChanged = nil
            let raw = "the frontmost window changed between captures: before=\(before.windowId) after=\(after.windowId)"
            pixelDiffFailure = "\(Self.pixelCaptureFailureLabel(reason: raw)): \(raw)"
        } else if let before = captureBefore, let after = captureAfter {
            do {
                let outcome = try PixelDiffer.diff(before: before.image, after: after.image)
                pixelDiff = PixelDiffSignal(
                    changedPixelRatio: outcome.changedPixelRatio,
                    bounds: outcome.bounds.map {
                        Bounds(x: $0.x, y: $0.y, width: $0.width, height: $0.height)
                    },
                    windowId: before.windowId
                )
                pixelChanged = outcome.changedPixelRatio > 0
            } catch let error as PixelDiffError {
                // 尺寸不同＝没有共同定义域可比：报"未测量"并说清是哪两个尺寸，
                // 而不是让差分函数替它编一个 1.0 极值冒充测量结果。
                pixelDiff = nil
                pixelChanged = nil
                switch error {
                case let .geometryChanged(bw, bh, aw, ah):
                    pixelDiffFailure = "pixel-capture-window-resized: the two captures have no common "
                        + "pixel domain (before=\(bw)x\(bh), after=\(aw)x\(ah)); no ratio was measured"
                case .bitmapUnavailable:
                    pixelDiffFailure = "pixel-diff-computation-failed: \(error)"
                }
            } catch {
                pixelDiff = nil
                pixelChanged = nil
                pixelDiffFailure = "pixel-diff-computation-failed: \(error)"
            }
        } else {
            pixelDiff = nil
            pixelChanged = nil
        }

        // Circuit breaker level: 3 > 2 > 1 > 0 (P0 spec §3.3/P0 熔断口径).
        var level: CircuitBreakerLevel = .normal
        var reasons: [String] = []
        if !aliveBefore {
            level = .actFailedChannelAlive
            reasons.append("process-exited")
        } else if !responsiveness.responsive {
            level = .actFailedChannelAlive
            reasons.append("ax-ping-timeout")
        } else if !actConfirmed {
            level = .actFailedChannelAlive
            if let actRejectReason { reasons.append(actRejectReason) }
        } else {
            // R1-03: a missing post-action tree capture is a channel degradation
            // in its own right — the verdict it would have supported ("the UI
            // did not react") must never be reported as a measurement. Each
            // unmeasured channel is named independently.
            if let axAfterCaptureFailure {
                level = .degraded
                reasons.append("ax-after-capture-failed: \(axAfterCaptureFailure)")
            }
            if pixelDiff == nil, treeBefore != nil {
                level = .degraded
                // X-6: whichever pixel-channel fact actually happened, in its
                // own words. `captureBefore == nil` used to mean exactly one
                // label — "screen-recording-denied" — so a capture that timed
                // out, an app with no on-screen window and a window outside
                // every display were all reported (and diagnosed) as a missing
                // Screen Recording seat.
                reasons.append(
                    captureBeforeFailure ?? captureAfterFailure ?? pixelDiffFailure ?? "pixel-capture-failed"
                )
            }
            if treeBefore == nil {
                level = .degraded
                reasons.append("ax-tree-capture-failed")
            }
            if let probeCommandFailure {
                // X-11: the probe window is a measurement channel too, and this
                // one did not run. Naming it here is what keeps a dropped
                // `stateDiff` from reading as "no state change".
                level = .degraded
                reasons.append("probe-window-command-not-delivered: \(probeCommandFailure)")
            }
        }
        let reason: String? = reasons.isEmpty ? nil : reasons.joined(separator: "; ")

        // Performance circuit breaker (P1 spec v1.1 §2): an act that exceeded
        // the wall-clock budget is flagged. Escalation only — never lowers an
        // existing channel-fault level, and level 2/3 are untouched by max.
        var finalLevel: CircuitBreakerLevel
        var finalReason: String?
        if latencyMs > Self.performanceLatencyBudgetMs {
            finalLevel = CircuitBreakerLevel(rawValue: max(level.rawValue, CircuitBreakerLevel.degraded.rawValue)) ?? level
            let perfReason = "performance-act-latency-over-budget: \(Int(latencyMs.rounded()))ms > \(Int(Self.performanceLatencyBudgetMs))ms"
            finalReason = reason.map { "performance|" + $0 } ?? perfReason
        } else {
            finalLevel = level
            finalReason = reason
        }

        // T9 progressive degradation (P2 spec v2.1 §18.3): record a sample,
        // then let the joint verdict escalate the circuit breaker level —
        // escalation only, never lowering an existing channel-fault level.
        if let degradationTracker, let attached = attachedApp {
            let probeMetrics = metricsProbe?.metrics(for: attached.pid)
            degradationTracker.record(
                DegradationSample(
                    timestamp: clock().timeIntervalSince1970,
                    pingMs: responsiveness.responsive ? responsiveness.pingMs : nil,
                    memoryBytes: probeMetrics?.memoryBytes,
                    handleCount: probeMetrics?.handleCount
                )
            )
            let t9Verdict = degradationTracker.verdict()
            if t9Verdict.tier == .degrading {
                finalLevel = CircuitBreakerLevel(
                    rawValue: max(finalLevel.rawValue, CircuitBreakerLevel.degraded.rawValue)
                ) ?? finalLevel
                let degradation = "degradation|" + t9Verdict.drivers.joined(separator: "+")
                    + "; longSession=\(t9Verdict.longSession)"
                finalReason = finalReason.map { degradation + "; " + $0 } ?? degradation
            }
        }

        // C33 verdict: scan the input stream for the whole operation window,
        // then release the operation right. Contamination downgrades the
        // attribution to weak + contaminated=true (spec v2.0 §15.4).
        if let attributionGuard {
            attributionGuard.monitorInput()
            contaminationVerdict = attributionGuard.releaseOperationRight()
        }
        // X-17 + A-08: `contaminated == false` means two opposite things
        // depending on whether anything was watching the input stream, and the
        // archive used to carry the *optimistic* one whenever no guard existed
        // (`false` + `.soft`) while a tap that dropped mid-window produced the
        // conservative one (`true` + `.weak`). Same unmeasured state, two
        // conclusions, and the artifact — what diagnosis and export actually
        // read — was the lying side. One rule now: **not measured is not
        // observable**, so every window nobody watched records the conservative
        // verdict, and the reason travels in `circuitBreaker.reason`, the field
        // this pack already has for "a measurement channel that did not run"
        // (the frozen `Attribution` schema is `additionalProperties: false`, and
        // `circuitBreaker.reason` is an unconstrained string inside it).
        //
        // One rule, two causes. A monitor that existed and stopped reporting
        // mid-window is a channel fault; no monitor at all is a *declared*
        // startup state — the operator opted out with `--no-c33` (P4 v4.0 §33.1:
        // an explicit maintenance switch, act never waits on user input) or the
        // tap could not be created for lack of Input Monitoring. P2 v2.0 §17.2
        // folds every one of those into the same pure-operation-right-mutex
        // form, so they share the verdict and differ only in the reason text —
        // which is why they carry different labels rather than different
        // attributions: "somebody turned this off" and "it broke" must stay
        // tellable apart from the archive alone, without a second evidence shape.
        // Which of the two startup forms it was stays in the daemon's own words,
        // because the string below is the only thing it hands over.
        //
        // Stated precisely, because there is a third shape and it is not the
        // conservative one: an engine with **no monitor and no stated reason**
        // (`inputMonitorAbsenceReason == nil`, `contaminationVerdict == nil`)
        // answers `contaminated: false` + `.soft`, and only the act response's
        // `contaminationBasis` says "'false' here is not an observation". That is
        // deliberate — inventing a reason nobody gave would be the fabricated
        // default this block exists to remove — but it means the one-rule claim
        // above holds for *a daemon*, not for every embedding. A `glasspaned`
        // process cannot reach it: both branches that leave the guard out set a
        // reason, which is what
        // `EngineCoreTests.testDaemonAlwaysStatesAReasonWhenNoMonitorRuns` pins.
        let contaminationMonitored = contaminationVerdict?.monitored ?? false
        let monitorWasLost = contaminationVerdict?.monitored == false
        let monitorFault: String? = {
            if let contaminationVerdict {
                guard !contaminationVerdict.monitored else { return nil }
                return contaminationVerdict.monitoringFault
                    ?? "the input monitor stopped reporting mid-window and named no reason"
            }
            return inputMonitorAbsenceReason
        }()
        // R3-1: the declaration reaches only the inference, never an
        // observation. An event the guard actually caught keeps the verdict
        // `contaminated: true` whatever was declared, and a window that really
        // was watched is decided by what the watch saw.
        let observedHumanInput = !(contaminationVerdict?.humanEvents ?? []).isEmpty
        let declaredUnattended =
            declaresUnattendedWindow && !contaminationMonitored && !observedHumanInput
        let contaminated = declaredUnattended
            ? false
            : (contaminationVerdict?.contaminated ?? (monitorFault != nil))
        let contaminationBasis: String
        if declaredUnattended {
            // No new response key: `contaminationMonitored: false` together with
            // `contaminated: false` is already an unambiguous pair — it can only
            // mean "the window was watched by nobody and somebody declared that
            // as unattended", because every other unwatched path above answers
            // `true`. The monitor's own fault stays quoted in this same string,
            // so declaring a window unattended cannot launder a broken channel
            // into a clean one, and `circuitBreaker.reason` keeps its
            // `input-contamination-*` label (see below) either way.
            contaminationBasis = "no input monitor watched this window and the operator declared it unattended (--unattended-window): the contaminated=false verdict here is a declaration, not a measurement"
                + (monitorFault.map { " — the monitor's own state stays on record: \($0)" } ?? "")
        } else if contaminationMonitored {
            contaminationBasis = "the input stream was watched for the whole operation window"
        } else if monitorWasLost, let monitorFault {
            contaminationBasis = "the input monitor stopped reporting inside this window: \(monitorFault) — the contaminated=true verdict is the absence of a watching channel, not an observed input"
        } else if let monitorFault {
            contaminationBasis = "no input monitor was installed for this window: \(monitorFault) — the contaminated=true verdict is the absence of a monitor, not an observed input"
        } else {
            contaminationBasis = "no input monitor is installed and this engine instance reported no reason for it; contamination was not measured, so \"false\" here is not an observation"
        }
        if let monitorFault {
            let label = monitorWasLost
                ? "input-contamination-monitor-lost"
                : "input-contamination-not-monitored"
            let basis = "\(label): \(monitorFault)"
            finalReason = finalReason.map { $0 + "; " + basis } ?? basis
        }
        // R1-09: AttributionGuard already measured *which* human inputs
        // contaminated this window; dropping them left a disputed attribution
        // unable to tell a real click from a stray one. The frozen evidence
        // schema is `additionalProperties: false` (kernel
        // evidence-pack.schema.json), so the events cannot join the pack
        // without breaking it — they ride the act response and `hello`
        // alongside the persistence failure, and stay readable through
        // `lastContamination`.
        if let humanEvents = contaminationVerdict?.humanEvents, !humanEvents.isEmpty {
            lastContamination = ContaminationRecord(operationId: operationId, events: humanEvents)
        } else {
            lastContamination = nil
        }
        // P6 §2.3: an in-window probe event (handler hit OR state change)
        // upgrades soft → strong (first hard attribution surface);
        // contamination still dominates → weak. State-only strong covers the
        // real-world binding-write paths (SwiftUI `$state` writes the author
        // cannot annotate — Z1b), where the state channel is the only, yet
        // genuinely operation-attributable, evidence (P6 §8 H1/H3 refinement).
        var attributionLevel: AttributionLevel = contaminated ? .weak : .soft
        if !contaminated, let signals = probeSignals,
           (signals.handlerProbe?.hitCount ?? 0) > 0 || (signals.stateDiff?.changed ?? false) {
            attributionLevel = .strong
        }
        let attribution = Attribution(
            level: attributionLevel,
            contaminated: contaminated
        )
        let pack = EvidencePack(
            operationId: operationId,
            createdAt: nowISO(),
            attribution: attribution,
            circuitBreaker: CircuitBreaker(level: finalLevel, reason: finalReason),
            signals: Signals(
                act: ActSignal(selector: selector, action: action, actConfirmed: actConfirmed),
                axEvent: axEvent,
                handlerProbe: probeSignals?.handlerProbe,
                stateDiff: probeSignals?.stateDiff,
                pixelDiff: pixelDiff,
                responsiveness: responsiveness,
                crash: CrashSignal(processAliveBefore: aliveBefore, processAliveAfter: channel.isProcessAlive())
            )
        )
        let persistence = store(pack)

        guard actConfirmed else {
            if let actRejectRemedy {
                throw GPError(
                    code: .actFailed,
                    message: actRejectReason ?? "action failed",
                    remedy: actRejectRemedy
                )
            }
            throw GPError(code: .actFailed, message: actRejectReason ?? "action failed")
        }
        var result: [String: Any] = [
            "operationId": operationId,
            "actConfirmed": actConfirmed,
            "latencyMs": latencyMs,
            "evidenceId": operationId
        ]
        // R1-03: `axChanged`/`pixelChanged` are measurements, not defaults. When
        // a capture did not run or failed, the key is *absent* — the same honest
        // encoding the frozen schema uses for the optional `signals.axEvent`
        // (absence, never a fabricated false) — so the agent cannot read
        // "nothing happened" out of "nothing was measured".
        if let axChanged { result["axChanged"] = axChanged }
        if let pixelChanged { result["pixelChanged"] = pixelChanged }
        // R1-07: an evidenceId that never reached the archive is not an audit
        // trail. Absent only when no archive is configured at all.
        if let persistence { result["evidencePersisted"] = persistence }
        // R1-09: the measured contamination, not just the boolean verdict.
        if contaminated, let record = lastContamination {
            result["humanInputEventCount"] = record.events.count
            result["humanInputEvents"] = Self.humanEventsWire(record.events)
        }
        // X-17: always present — the reader must be able to tell "clean, because
        // it was watched" from "unknown, because nothing watched it".
        result["contaminationMonitored"] = contaminationMonitored
        result["contaminationBasis"] = contaminationBasis
        return result
    }

    /// 一次性视觉审查通道：把当前窗口编成 PNG 交给**调用方的**模型看一眼。
    ///
    /// 引擎自己**不落盘**——这套工具对外的主张是"证据里只有测量数字，没有原始截图"，
    /// 而视觉审查要的只是"给模型看一眼"，不是"把画面存下来"。因此这里刻意没有
    /// `path` 之类的落盘参数：那会把一个由模型输出驱动的任意文件写入口放进协议里。
    /// 要留档由调用方自己从会话里存。
    ///
    /// 尺寸受 socket 帧上限约束（见 PngEncoding.defaultMaxBytes）；超限报
    /// GP_E_PAYLOAD_TOO_LARGE 并附建议倍率，而不是悄悄降分辨率——悄悄降会让模型
    /// 以为它看清了，实际看清的是压缩过的版本。
    public func captureView(scale: Double) throws -> [String: Any] {
        // 没挂接时通道会给一句 pixelCaptureDenied("no app attached to the channel")，
        // 而像素拒绝的 remedy 默认讲的是屏幕录制席位——于是"你还没调用 gp_attach"
        // 会被回答成"去系统设置里授权"。和其他需要挂接的方法同一道闸。
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        let capture: WindowCapture
        do {
            capture = try channel.captureWindow()
        } catch let error as ChannelError {
            // 这句话必须换成视觉通道自己的：这里没有 pixelDiff 可降级，
            // 让代理以为"像素测量还在，只是没了"是另一种假装看过。
            throw Self.map(error, degradation: Self.captureViewDegradation)
        }
        let encoded: PngEncoding.Result
        do {
            encoded = try PngEncoding.encode(capture.image, scale: scale)
        } catch let error as PngEncoding.EncodingError {
            switch error {
            case let .tooLarge(byteCount, limit, suggested):
                throw GPError(
                    code: .payloadTooLarge,
                    message: "the PNG came out at \(byteCount) bytes, over the \(limit)-byte frame budget",
                    remedy: "retry with scale: \(suggested) (smaller windows or lower scale keep the image legible to a vision model without breaking the frame limit)"
                )
            case .encoderUnavailable:
                throw GPError(
                    code: .internalError,
                    message: "ImageIO could not produce a PNG destination",
                    remedy: "report this: the capture existed but the encoder refused it"
                )
            }
        }
        return [
            "pngBase64": encoded.base64,
            "mimeType": "image/png",
            "byteCount": encoded.byteCount,
            "pixelWidth": encoded.pixelWidth,
            "pixelHeight": encoded.pixelHeight,
            "windowId": capture.windowId,
            // 两个都说：`scale` 是请求的，`appliedScale` 是图像**真的**被缩到的。
            // 只报请求值时，一次静默的降采样失败会让模型以为自己在看 0.6 的版本。
            "scale": scale,
            "appliedScale": encoded.appliedScale,
            "persisted": false,
            "pointSize": [
                "width": capture.bounds.width,
                "height": capture.bounds.height,
            ],
        ]
    }

    /// 界面可操作性审计：一次几何遍历 + `UILayoutAudit` 的确定性规则。
    /// 返回值刻意带 `coverage`：没量到的比例越大，结论越弱；量不到就没有"通过"。
    public func auditUI(maxDepth: Int, minHitTargetPt: Double?) throws -> [String: Any] {
        let snapshot: AxGeometrySnapshot
        do {
            snapshot = try channel.geometrySnapshot(maxDepth: maxDepth)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }
        let result = UILayoutAudit.audit(
            snapshot,
            minHitTargetPt: minHitTargetPt ?? UILayoutAudit.defaultMinHitTargetPt
        )
        let data = try JSONEncoder().encode(result)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GPError(code: .internalError, message: "the layout audit did not serialize to an object")
        }
        var payload = object
        payload["latencyMs"] = snapshot.latencyMs
        payload["windowKnown"] = snapshot.window != nil
        // 遍历没走完必须能被机器读到，而不是只躺在某条 finding 的文字里：
        // README 对外承诺的就是这两个字段。截断（overlapScanTruncated）早就有
        // 一等布尔值，不完整却没有——两边不对称，读的人只会以为"没有那条 finding
        // 就是看全了"。
        payload["complete"] = snapshot.complete
        payload["stopReason"] = snapshot.stopReason ?? NSNull()
        return payload
    }

    public func observe(maxDepth: Int, role: String?) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        // R5-06: the degradation window used to advance only on `act`, so a
        // read-only agent — one that observes, diagnoses and exports but never
        // clicks — could run for hours against a leaking app and see nothing,
        // because nothing was ever sampled. Sampling measures the attached
        // process, not the click, so it belongs on any request that reaches one.
        // `pingMs` is nil here on purpose: observe does not pay for a
        // responsiveness round trip, and nil is an honest absence rather than a
        // number borrowed from another operation.
        if let degradationTracker, let attached = attachedApp {
            let probeMetrics = metricsProbe?.metrics(for: attached.pid)
            degradationTracker.record(
                DegradationSample(
                    timestamp: clock().timeIntervalSince1970,
                    pingMs: nil,
                    memoryBytes: probeMetrics?.memoryBytes,
                    handleCount: probeMetrics?.handleCount
                )
            )
        }
        let snapshot: AxTreeSnapshot
        do {
            snapshot = try channel.treeSnapshot(maxDepth: maxDepth)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }
        let roots: [AxNode]
        let nodeCount: Int
        let digest: String
        if let role {
            roots = EngineCore.prune(snapshot.roots, matchingRole: role)
            nodeCount = TreeDigest.nodeCount(roots)
            digest = (try? TreeDigest.digest(roots)) ?? snapshot.digest
        } else {
            roots = snapshot.roots
            nodeCount = snapshot.nodeCount
            digest = snapshot.digest
        }
        let treeData = try AxNode.arrayEncoder.encode(roots)
        let treeObject = try JSONSerialization.jsonObject(with: treeData)
        return [
            "axTree": treeObject,
            "nodeCount": nodeCount,
            "digest": digest,
            "latencyMs": snapshot.latencyMs
        ]
    }

    public func assertElement(
        selector: Selector,
        property: AssertionProperty,
        expected: StringOrBool
    ) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        guard let context = latestPack() else {
            // P0 §3.3：assert 证据的 signals 复用最近一次 act 的上下文，因此它不能
            // 成为会话的第一个操作。错误码保持 GP_E_NO_OPERATION（错误码表冻结），
            // 但 remedy 必须可执行——原文案"run act or assert_element first"对这条
            // 路径是自指的（真机踩过：用它核验设置面板时循环无解）。
            throw GPError(
                code: .noOperation,
                message: "no prior operation to reuse signal context from",
                remedy: "run act first — assert_element reuses the most recent act's signal context (P0 spec §3.3)"
            )
        }
        let actual: StringOrBool
        do {
            actual = try channel.readProperty(selector: selector, property: property)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }
        let passed = actual == expected
        let operationId = OperationID.generateLive()
        // Signal context is reused from the referenced operation (spec §3.3).
        let pack = EvidencePack(
            operationId: operationId,
            createdAt: nowISO(),
            attribution: context.attribution,
            circuitBreaker: context.circuitBreaker,
            signals: context.signals,
            assertion: Assertion(
                selector: selector,
                property: property,
                expected: expected,
                actual: actual,
                passed: passed
            )
        )
        store(pack)
        return [
            "passed": passed,
            "actual": Self.wireValue(actual),
            "operationId": operationId,
            "evidenceId": operationId
        ]
    }

    public func diagnose(operationId: String?) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        // R1-06: existence is answered by the same resolver `last_evidence`
        // uses (memory ring + disk archive); only the error code stays
        // diagnose's own.
        guard let resolved = resolvedPack(operationId: operationId) else {
            throw GPError(
                code: .noOperation,
                message: operationId.map { "unknown operationId \($0)" } ?? "no operation to diagnose"
            )
        }
        var target = resolved
        // P6 §3.1: late probe arrivals (async handlers finishing after the
        // act window) only become visible by diagnose time — refresh the
        // stored signal before classifying so T8 is decidable, then persist.
        if let inbox = probeInbox, let refreshed = inbox.refreshedHandlerProbe(for: target) {
            target.signals.handlerProbe = refreshed
            replace(target)
        }
        let (diagnosisClass, report) = Classifier.classify(target)
        var updated = target
        updated.diagnosis = Diagnosis(class: diagnosisClass, report: report)
        replace(updated)
        return [
            "class": diagnosisClass.rawValue,
            "report": [
                "path": report.path,
                "anomaly": report.anomaly,
                "evidence": report.evidence,
                "next": report.next
            ]
        ]
    }

    /// P6 §5.4: probe connectivity snapshot. Agents use this to learn whether
    /// T4/T5/T7/T8 verdicts are decidable for the attached app *before*
    /// spending a cycle, and to surface the GP_E_PROBE_UNAVAILABLE remedy.
    public func probeStatus() -> [String: Any] {
        let probes = probeInbox?.statusJSON() ?? []
        var attachedHasProbe = false
        if let inbox = probeInbox, let app = attachedApp, inbox.connection(for: app.pid) != nil {
            attachedHasProbe = true
        }
        var payload: [String: Any] = [
            "probes": probes,
            "attachedHasProbe": attachedHasProbe,
        ]
        // X-13: `ProbeInbox` has recorded every drop-off since start; without
        // this number the list of currently-live probes still cannot tell an
        // agent "this one keeps coming and going" from "connected since
        // attach". Omitted when no inbox is wired at all — that is the absence
        // of the surface, not a measured zero.
        if let inbox = probeInbox {
            payload["disconnections"] = inbox.recordedDisconnectionCount
            // A-10: `probes` keeps its frozen meaning ("live registrations") so a
            // reader cannot treat a dropped probe as an attached one; the drop
            // history — with its reason and per-pid counts — rides its own key.
            payload["recentDisconnections"] = inbox.recentDisconnectionsJSON()
            // X-3, closed: a state frame whose `source` token this daemon cannot
            // map is counted process-wide, and until now the count had no reader
            // at all — the same class of defect as a `hitCount: 0` that silently
            // includes frames that never arrived. Per-pid rows carry
            // `stateFramesUnmappedSource` (only when non-zero); this is the total
            // that survives a probe disconnecting. Like `disconnections` just
            // above it, the key exists only when an inbox exists — `--no-probe`
            // is the absence of the surface, and a measured zero needs something
            // that measures.
            payload["unmapableStateFrames"] = inbox.unmapableStateFrameCount
        }
        // R5-06, second half: T9 escalates the circuit breaker only when two
        // drivers trend together (`drivers.count >= 2`), a deliberate false-alarm
        // guard — but until now a single trending channel, and the whole `watch`
        // tier, were invisible to any reader, because the escalation only ever
        // surfaced inside an act's evidence. Publishing the verdict here turns
        // "memory is climbing, handles are not, tier=watch" into an observable
        // fact instead of silence that reads as health. Absent when no tracker is
        // wired (an engine built without T9): never a fabricated zero.
        if let degradationTracker {
            let watch = degradationTracker.verdict()
            var block: [String: Any] = [
                "tier": watch.tier.rawValue,
                // R6-01: `tier` on its own cannot tell "measured clean" from
                // "nothing was judged yet" — and now that this key has readers,
                // that ambiguity would be a published false positive. `judged`
                // says which it is; `basis` carries the measured numbers that
                // explain it, and the two thresholds travel with the reading so
                // nobody has to know the defaults to interpret `samples`.
                "judged": watch.judged,
                "basis": watch.basis,
                "samples": watch.sampleCount,
                "minimumSamples": watch.minimumSamplesForTrend,
                "spanSeconds": watch.elapsedSeconds,
                "minimumSpanSeconds": watch.minimumTrendSpanSeconds,
                "longSession": watch.longSession,
            ]
            if !watch.drivers.isEmpty { block["drivers"] = watch.drivers }
            // A channel with no slope is absent here rather than `0`, the same
            // convention the probe counters use: `memoryBytesPerSec: 0` is a
            // measurement, a missing key means the metrics probe never read it
            // (or read a dead pid), and `pingMsPerSec` means every sample in the
            // window was an unresponsive round trip or an `observe`.
            var slopes: [String: Any] = [:]
            if let ping = watch.pingSlopeMsPerSec { slopes["pingMsPerSec"] = ping }
            if let memory = watch.memorySlopeBytesPerSec { slopes["memoryBytesPerSec"] = memory }
            if let handles = watch.handleSlopePerSec { slopes["handlesPerSec"] = handles }
            if !slopes.isEmpty { block["slopes"] = slopes }
            payload["degradation"] = block
        }
        return payload
    }

    public func lastEvidence(operationId: String?) throws -> EvidencePack {
        // R1-06: the same resolver backs `diagnose`, so the two method surfaces
        // can never disagree about whether an operationId exists.
        if let target = resolvedPack(operationId: operationId) {
            return target
        }
        // P1 v1.3: a lookup miss means "no such evidence in the bounded
        // history" — a distinct code from "no operation to diagnose".
        switch operationId {
        case .some(let id):
            throw GPError(code: .noEvidence, message: "unknown operationId \(id)")
        case .none:
            throw GPError(code: .noEvidence, message: "no evidence recorded yet")
        }
    }

    public func shutdown() -> [String: Any] {
        shutdownRequested = true
        return ["bye": true]
    }

    // MARK: - P1 project registry (spec v1.4 §1)

    /// 没有注册表时的统一口径：**报错**，不是回一份空表。
    /// 空列表在 agent 与面板眼里等于"用户没有注册任何项目"，那是一个引擎并没有
    /// 测量过的结论（P0 §8 禁止的就是这个）。生产 daemon 一定注入注册表
    /// （`glasspaned` 里的 `ProjectRegistry.live()`），所以这条只在"核心被脱离了
    /// 它的存储面来使用"时触发。
    private func registryOrThrow(_ doing: String) throws -> ProjectRegistry {
        guard let projectRegistry else {
            throw GPError(
                code: .internalError,
                message: "no project registry is configured for this engine; cannot \(doing)"
            )
        }
        return projectRegistry
    }

    /// List all registered projects.
    public func projectList() throws -> [String: Any] {
        guard let projectRegistry else {
            // C-03, main-facing contract: with no registry there is nothing to
            // enumerate, and "nothing is registered" is a verdict no measurement
            // supports — refuse rather than answer an empty table.
            throw GPError(
                code: .internalError,
                message: "no project registry is configured for this engine; cannot list projects",
                remedy: Self.noRegistryRemedy
            )
        }
        let entries: [[String: Any]] = projectRegistry.all.map { entry in
            var dict: [String: Any] = [
                "projectId": entry.projectId,
                "displayName": entry.displayName,
                "createdAt": entry.createdAt
            ]
            if let bundleId = entry.bundleId { dict["bundleId"] = bundleId }
            if let pid = entry.pid { dict["pid"] = Int(pid) }
            if let v = entry.recipeConfigPath { dict["recipeConfigPath"] = v }
            if let v = entry.calibrationAssetsPath { dict["calibrationAssetsPath"] = v }
            if let v = entry.evidenceStoragePath { dict["evidenceStoragePath"] = v }
            return dict
        }
        // B-1: an unreadable registry lists zero rows, and zero rows with no
        // note read as "nothing is registered". The absence is stated instead.
        if let unreadable = projectRegistry.unreadableReport {
            return [
                "projects": entries,
                "registryReadable": false,
                "registryFailure": unreadable,
                "remedy": projectRegistry.unreadableRemedy,
            ]
        }
        return ["projects": entries]
    }

    /// Register or update a project.
    public func projectSet(
        projectId: String?,
        displayName: String,
        bundleId: String?,
        pid: Int32?,
        recipeConfigPath: String?,
        calibrationAssetsPath: String?,
        evidenceStoragePath: String?
    ) throws -> [String: Any] {
        // A-14 on the daemon's own write side: the shell validates paths, but
        // this method is a second writer of the same file, and a path stored
        // here is what `attach` and `pruneEvidence` later act on.
        //
        // All three path fields, not just the archive. The MCP shell already
        // checked the other two; the daemon checked one, so a value that the
        // shell would refuse could still reach `projects.json` through this
        // method — and `recipeConfigPath` is read back out and validated by
        // `--recipe-validate` later, which makes it a live input, not a comment.
        for (field, stored) in [
            ("evidenceStoragePath", evidenceStoragePath),
            ("recipeConfigPath", recipeConfigPath),
            ("calibrationAssetsPath", calibrationAssetsPath),
        ] {
            guard let stored, let defect = Self.evidenceStoragePathDefect(stored) else { continue }
            throw GPError(
                code: .badParams,
                message: "\(field) \"\(stored)\" \(defect). Nothing was registered.",
                remedy: Self.pathRemedy(field: field)
            )
        }
        // C-03: with no registry there is nothing to write into, and creating a
        // file under the home directory as a side effect of a registration call
        // is exactly the shape this round removed.
        let registry = try requireRegistry()
        let entry: ProjectEntry
        if let projectId {
            // Update existing.
            entry = try registry.update(
                projectId: projectId,
                displayName: displayName,
                bundleId: bundleId,
                pid: pid,
                recipeConfigPath: recipeConfigPath,
                calibrationAssetsPath: calibrationAssetsPath,
                evidenceStoragePath: evidenceStoragePath
            )
        } else {
            // Create new.
            entry = try registry.create(
                displayName: displayName,
                bundleId: bundleId,
                pid: pid,
                recipeConfigPath: recipeConfigPath,
                calibrationAssetsPath: calibrationAssetsPath,
                evidenceStoragePath: evidenceStoragePath,
                now: clock
            )
        }
        var dict: [String: Any] = [
            "projectId": entry.projectId,
            "displayName": entry.displayName,
            "createdAt": entry.createdAt
        ]
        if let bundleId = entry.bundleId { dict["bundleId"] = bundleId }
        if let pid = entry.pid { dict["pid"] = Int(pid) }
        if let v = entry.recipeConfigPath { dict["recipeConfigPath"] = v }
        if let v = entry.calibrationAssetsPath { dict["calibrationAssetsPath"] = v }
        if let v = entry.evidenceStoragePath { dict["evidenceStoragePath"] = v }
        return ["project": dict]
    }

    /// Get a project by ID.
    public func projectGet(projectId: String) throws -> [String: Any] {
        guard let entry = try requireRegistry().get(projectId) else {
            throw GPError(code: .notFound, message: "unknown projectId \(projectId)")
        }
        var dict: [String: Any] = [
            "projectId": entry.projectId,
            "displayName": entry.displayName,
            "createdAt": entry.createdAt
        ]
        if let bundleId = entry.bundleId { dict["bundleId"] = bundleId }
        if let pid = entry.pid { dict["pid"] = Int(pid) }
        if let v = entry.recipeConfigPath { dict["recipeConfigPath"] = v }
        if let v = entry.calibrationAssetsPath { dict["calibrationAssetsPath"] = v }
        if let v = entry.evidenceStoragePath { dict["evidenceStoragePath"] = v }
        return ["project": dict]
    }

    // MARK: - P5 evidence maintenance (spec v5.0 §9.3)

    /// Age-prune evidence, either on a registered project's
    /// `evidenceStoragePath` directory or, with `projectId` nil, on the archive
    /// injected into this instance. Returns the number of entries removed; a
    /// missing directory counts 0. Storage-layer primitive — no socket frame,
    /// no method-table change.
    ///
    /// An instance built with `evidenceStore: nil` has no archive to prune and
    /// refuses (`noStoreArchiveRefusal`) rather than falling back to the shared
    /// default directory: the fallback deleted aged entries from
    /// `~/.glasspane/evidence/` on one omitted argument's say-so, which is the
    /// substitution this round's own `noArchiveRefusal` refuses from the project
    /// side.
    public func pruneEvidence(projectId: String?, olderThanDays: Int) throws -> Int {
        let dir: String
        if let projectId {
            guard let entry = try requireRegistry().get(projectId) else {
                throw GPError(code: .notFound, message: "unknown projectId \(projectId)")
            }
            // Second adoption site, and the destructive one: pruning deletes.
            // Same resolver the CLI maintenance branch uses (A-07).
            switch Self.projectArchiveDirectory(projectId: projectId, entry: entry) {
            case .success(let stored):
                dir = stored
            case .failure(let refusal):
                throw refusal
            }
        } else {
            guard let evidenceStore else { throw Self.noStoreArchiveRefusal() }
            dir = evidenceStore.directory
        }
        // A temporary store over the resolved directory — never mutates the
        // active store's own directory/retention state (P5 §9.3). The engine's
        // injected clock drives age judgment, keeping TTL deterministic in
        // tests that pin `now`.
        return EvidenceStore(directory: dir, now: clock).prune(olderThanDays: olderThanDays)
    }

    /// 解析"该动哪个档案目录"。
    ///
    /// 绝不回落到 `EvidenceStore.defaultDirectory`：那是一条"核心没有档案，
    /// 却去删 `~/.glasspane/evidence/`"的路径——从任何一个个测都能触到用户的
    /// 真实证据档案，而删除是不可逆的（与 A-1 同形状，只是后果更重）。
    /// 没配 `evidenceStoragePath` 的项目，证据本就写在活跃档案的目录里
    /// （attach 时的 `setDirectory(path ?? 活跃目录)`，同口径）。
    private func archiveDirectory(for configured: String?, subject: String) throws -> String {
        if let configured, !configured.isEmpty { return configured }
        guard let evidenceStore else {
            throw GPError(
                code: .internalError,
                message: "no evidence archive is configured for this engine; refusing to prune \(subject)"
            )
        }
        return evidenceStore.directory
    }

    // MARK: - P1 snapshot/restore (spec v1.1 §1)

    /// Captures a digest-only baseline of the attached app's AX tree and
    /// stores it in the bounded in-memory snapshot store (§1.2 snapshot).
    public func snapshot(maxDepth: Int) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        let started = clock()
        let tree: AxTreeSnapshot
        do {
            tree = try channel.treeSnapshot(maxDepth: maxDepth)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }
        // P6 §5.5: probe checkpoint export gives snapshots a *real* tier-1
        // probe payload (gpz1-json-v1). The P5 scripted `snapshotProbe` hook
        // keeps priority so existing unit tests stay verbatim; daemon ships it
        // nil.
        //
        // A-01: an export that ran and was refused used to vanish here and then
        // get reported by `rollback_full` as "the snapshot has none — attach the
        // probe and re-snapshot", i.e. a live probe answering with a digest
        // mismatch was laundered into "no probe", and the agent looped on
        // re-snapshotting a probe that was there all along. The reason is now
        // kept with the snapshot and named on both faces.
        let snapshotId = OperationID.generateSnapshotLive()
        var probeInfo = snapshotProbe?()
        var exportFailure: String?
        if probeInfo == nil, let inbox = probeInbox, let pid = attachedApp?.pid,
           let connection = inbox.connection(for: pid) {
            if !connection.hello.capabilities.contains("checkpoint") {
                exportFailure = "no export was attempted: the probe attached to pid \(pid) (\(connection.hello.probeVersion)) does not advertise the `checkpoint` capability"
            } else if let exported = inbox.checkpointExport(pid: pid, ref: snapshotId) {
                probeInfo = SnapshotProbeInfo(
                    probeVersion: connection.hello.probeVersion,
                    exportedDomains: exported.domains.keys.sorted(),
                    stateDigest: exported.digest,
                    checkpointFormat: "gpz1-json-v1",
                    capturedAt: nowISO()
                )
            } else {
                exportFailure = "export attempted and failed: \(inbox.lastCheckpointError ?? "the probe returned nothing and named no reason")"
            }
        }
        let snapshot = AppStateSnapshot(
            snapshotId: snapshotId,
            treeDigest: tree.digest,
            nodeCount: tree.nodeCount,
            capturedAt: nowISO(),
            probeInfo: probeInfo
        )
        storeSnapshot(snapshot)
        let latencyMs = clock().timeIntervalSince(started) * 1000
        var result: [String: Any] = [
            "snapshotId": snapshot.snapshotId,
            "treeDigest": snapshot.treeDigest,
            "nodeCount": snapshot.nodeCount,
            "capturedAt": snapshot.capturedAt,
            "latencyMs": latencyMs
        ]
        if let exportFailure {
            result["checkpointExportError"] = exportFailure
            checkpointExportFailures[snapshot.snapshotId] = exportFailure
        }
        return result
    }

    /// Restores from a stored snapshot. With `steps`, replays them via the
    /// standard act pipeline (tier-2 ffwd); without steps, compares the
    /// current tree digest against the baseline. Tier-1 full snapshot
    /// restore requires the Z5 probe SDK and is rejected by design (§1.2).
    public func restore(
        snapshotId: String,
        steps: [(Selector, Action)]?,
        mode: String? = nil
    ) throws -> [String: Any] {
        guard attachedApp != nil else {
            throw GPError(code: .notAttached, message: "no app attached")
        }
        if mode == "restore_snapshot" {
            // Tier-1 full-snapshot restore depends on the Z5 probe SDK
            // (综述 §5.7 不可快照区). Not entered in P1 — surface the honest
            // boundary as a structured error with a concrete remedy.
            throw GPError(
                code: .restoreUnsupported,
                message: "mode 'restore_snapshot' (tier-1 full snapshot restore) requires the Z5 probe SDK, which is not in P1"
            )
        }
        if mode == "rollback_full" {
            // P5 v5.0 §6.4 tier-1 pipeline: noSnapshot invariant first, then
            // no-probe → structured refusal (same code/semantics as the P1
            // tier-1 boundary), probe present → plan + validate. A returned
            // plan carries rollbackExecuted: false — the rollback execution
            // surface is the probe runtime, which this daemon does not ship.
            guard let snapshot = snapshot(withId: snapshotId) else {
                throw GPError(code: .noSnapshot, message: "unknown snapshotId \(snapshotId)")
            }
            guard let probe = snapshot.probeInfo else {
                // A-01: "nothing was attached" and "the probe answered and the
                // answer was unusable" are different facts, and only the first
                // one is fixed by attaching a probe.
                if let reason = checkpointExportFailures[snapshotId] {
                    throw GPError(
                        code: .restoreUnsupported,
                        message: "tier-1 restore requires a Z5 probe payload; snapshot '\(snapshotId)' has none because the export never produced one — \(reason)",
                        remedy: "the probe is attached; re-snapshotting alone changes nothing until the reported cause is fixed. For a digest mismatch the state moved underneath the export, so take the snapshot again while the app is quiet. For a delivery/timeout reason run gp_probe_status and read `recentDisconnections` — that is the drop history, one row per dropped registration with its `pid`, `disconnectReason`, `disconnectedAt` and a per-pid `drops` count; `disconnections` is only the total number of drops since start, and `probes` lists live registrations (every row `connected: true`), so a probe that has dropped is simply absent from it rather than flagged inside it. Then re-establish the probe (GP.start() in the app) or restart the background service with `launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon`. For a missing `checkpoint` capability the attached probe SDK predates checkpoint export: update the app's SDK. Tier-2 ffwd needs none of that — pass `steps` and the rollback runs on the UI"
                    )
                }
                throw GPError(
                    code: .restoreUnsupported,
                    message: "tier-1 restore requires a Z5 probe payload; snapshot '\(snapshotId)' has none — attach the probe and re-snapshot"
                )
            }
            guard let plan = RestorePipeline.plan(snapshot: snapshot) else {
                throw GPError(
                    code: .restoreUnsupported,
                    message: "tier-1 restore plan unbuildable for snapshot '\(snapshotId)' (cyclic or inconsistent probe domains)"
                )
            }
            let validation = RestorePipeline.validate(plan: plan, snapshot: snapshot)
            guard validation.valid else {
                throw GPError(
                    code: .restoreUnsupported,
                    message: "tier-1 restore plan invalid for snapshot '\(snapshotId)': \(validation.issues.joined(separator: "; "))"
                )
            }

            // P6 §5.5: gpz1 checkpoints have a live execution surface — the
            // probe retained the export under this snapshot's ref, so the
            // daemon can command a rewrite and verify the post-restore digest
            // against the plan. Any other format keeps the P5 plan-only answer.
            if probe.checkpointFormat == "gpz1-json-v1",
               let inbox = probeInbox, let pid = attachedApp?.pid,
               inbox.connection(for: pid) != nil {
                if let post = inbox.checkpointRestore(pid: pid, ref: snapshot.snapshotId, domains: plan.domains) {
                    registerRestoreApproval(
                        snapshotId: snapshotId, mode: "rollback_full", hasSteps: false,
                        outcome: "executed via gp-probe"
                    )
                    return [
                        "snapshotId": snapshot.snapshotId,
                        "baselineTreeDigest": snapshot.treeDigest,
                        "domains": plan.domains,
                        "postStateDigest": post,
                        "rollbackExecuted": true,
                        "executionSurface": "gp-probe",
                        "probeVersion": probe.probeVersion,
                        "consistent": post == plan.expectedStateDigest
                    ]
                }
                // X-13: "refused by probe" and "never reached the probe" are two
                // different facts. `sendCommand` answers delivery and the inbox
                // keeps the reason, so the wording can name the one that
                // actually happened instead of telling the agent to go argue
                // with a probe that never heard the request.
                let undelivered = inbox.lastDeliveryError != nil
                let why = inbox.lastResultError ?? inbox.lastDeliveryError ?? "no result"
                throw GPError(
                    code: .restoreUnsupported,
                    message: undelivered
                        ? "tier-1 restore command was never delivered to the probe: \(why)"
                        : "tier-1 restore execution refused by probe: \(why)",
                    remedy: undelivered
                        ? "nothing was rewritten and the app's state is untouched: the checkpoint_restore bytes did not leave the daemon (\(why)). Run gp_probe_status and read `recentDisconnections` — the drop history, one row per dropped registration with its `pid`, `disconnectReason`, `disconnectedAt` and a per-pid `drops` count — because that is where a gone socket shows: `disconnections` is only the total number of drops since start, and `probes` carries live registrations only (every row `connected: true`), so this pid is absent from it rather than listed in it as disconnected. Re-establish the probe (GP.start() in the app, or restart the background service with `launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon`), take a fresh gp_snapshot, then restore again; or roll back on the UI with tier-2 ffwd by passing `steps`"
                        : "the probe answered and refused the rewrite (\(why)): re-snapshot with gp_snapshot against the live probe and restore again, or roll back on the UI with tier-2 ffwd by passing `steps`"
                )
            }
            registerRestoreApproval(
                snapshotId: snapshotId, mode: "rollback_full", hasSteps: false,
                outcome: "planned only (no execution surface)"
            )
            return [
                "snapshotId": snapshot.snapshotId,
                "baselineTreeDigest": snapshot.treeDigest,
                "plan": [
                    "domains": plan.domains,
                    "steps": plan.steps.map { step -> [String: Any] in
                        [
                            "domain": step.domain,
                            "checkpointRef": step.checkpointRef,
                            "action": step.action,
                            "preconditions": step.preconditions
                        ]
                    },
                    "expectedStateDigest": plan.expectedStateDigest,
                    "domainCount": plan.domainCount
                ],
                "planValid": true,
                "rollbackExecuted": false,
                "executionSurface": "z5-probe-runtime",
                "probeVersion": probe.probeVersion,
                // P5 §6.4 原文要求计划态回 consistent:true。这里保留该字段
                // （不改方法表），但补一个 basis 说明它表达的是"计划自洽"，
                // 不是"实测到状态一致"——面板与 agent 都不该把它读成后者。
                "consistent": true,
                "consistentBasis": "plan-only, state not re-measured"
            ]
        }
        guard let snapshot = snapshot(withId: snapshotId) else {
            throw GPError(code: .noSnapshot, message: "unknown snapshotId \(snapshotId)")
        }

        // P5 §3.5: 高风险操作的审批登记。登记是 best-effort——台账是审计面，
        // 不是闸门：写失败或原因被拒都不该改变 restore 语义。
        // 但**登记的时机**必须晚于被测动作：此前它在动作之前就写下
        // "restore executed: …"，而 ffwd 可能中途失败、档 1 计划态根本没执行，
        // 于是一条不可抵赖的链上留下了没发生过的事（P5 §3.2 的定位恰是防抵赖）。
        guard let steps else {
            // Baseline-consistency form: compare current tree against the
            // snapshot digest. confirmed/total stay 0 — no step ran.
            let tree = try currentTreeDigest()
            let consistent = tree.digest == snapshot.treeDigest
            registerRestoreApproval(
                snapshotId: snapshotId, mode: mode, hasSteps: false,
                outcome: "executed"
            )
            return [
                "snapshotId": snapshot.snapshotId,
                "baselineTreeDigest": snapshot.treeDigest,
                "steps": [],
                "confirmed": 0,
                "total": 0,
                "targetDigest": tree.digest,
                "consistent": consistent
            ]
        }

        var stepResults: [[String: Any]] = []
        stepResults.reserveCapacity(steps.count)
        for (index, step) in steps.enumerated() {
            do {
                let outcome = try act(selector: step.0, action: step.1)
                // act() throws GP_E_ACT_FAILED on rejection; reaching here
                // means the step was confirmed.
                stepResults.append([
                    "selector": ["role": step.0.role, "title": step.0.title ?? "", "identifier": step.0.identifier ?? ""],
                    "action": step.1.rawValue,
                    "actConfirmed": true,
                    "operationId": outcome["operationId"] as? String ?? ""
                ])
            } catch {
                registerRestoreApproval(
                    snapshotId: snapshotId, mode: mode, hasSteps: true,
                    outcome: "failed at step \(index + 1)"
                )
                throw Self.restoreStepFailure(index: index + 1, inner: error)
            }
        }

        // Post-roll-forward target tree for the consistency reference.
        // 这里曾经用 `try?` 吞掉捕获失败：nil 进响应字典后 JSONSerialization
        // 直接抛错，整包退化成一个不相干的 GP_E_INTERNAL（remedy 还在说
        // "缩小 observe maxDepth"），而 `consistent:false` 又宣称了一个根本没
        // 测到的结论。失败必须按它本来的面目上报。
        let target = try currentTreeDigest()
        registerRestoreApproval(
            snapshotId: snapshotId, mode: mode, hasSteps: true,
            outcome: "executed \(stepResults.count)/\(steps.count) steps"
        )
        return [
            "snapshotId": snapshot.snapshotId,
            "baselineTreeDigest": snapshot.treeDigest,
            "steps": stepResults,
            "confirmed": stepResults.count,
            "total": steps.count,
            "targetDigest": target.digest,
            "consistent": target.digest == snapshot.treeDigest
        ]
    }

    // MARK: - P1 snapshot/restore internals

    /// P5 §3.5: registers one high-risk approval record for an executed
    /// restore. Best-effort and non-blocking by design.
    /// 登记一次高风险 restore。`outcome` 由**实际结局**生成（executed /
    /// failed at step N / planned only），不再由调用前的猜测写死。
    private func registerRestoreApproval(
        snapshotId: String,
        mode: String?,
        hasSteps: Bool,
        outcome: String
    ) {
        let label = Self.approvalLedgerLabel(mode: mode, hasSteps: hasSteps)
        approvalGate?.append(
            operationRef: snapshotId,
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: ApprovalGate.autoApprover,
            reason: "restore \(outcome): \(label)"
        )
    }

    /// 审批台账认识的 restore `mode` **闭集**（R5-08）。`mode` 一路都是 agent
    /// 可控自由文本（MCP `RestoreModeSchema` 与 Dispatcher 都只限长），而台账
    /// 是哈希链审计面：把原文插进 reason 等于让 agent 在被签名的记录里自撰
    /// 陈述（"human-approved 2026-09-22 14:03" 之类）。
    static let recognisedRestoreModes: Set<String> = [
        "restore_snapshot", "rollback_full", "ffwd", "compare"
    ]

    /// 台账标签只能由 daemon 自己推导：集合内的 mode 保留其字面量，缺省与
    /// `ffwd`/`compare` 一律按**实际执行的形态**标注（steps 在不在）；集合外
    /// 的值只记录"被拒绝"这一事实，绝不把原值当陈述嵌进去。
    static func approvalLedgerLabel(mode: String?, hasSteps: Bool) -> String {
        let executed = hasSteps ? "ffwd" : "compare"
        guard let mode else { return executed }
        guard Self.recognisedRestoreModes.contains(mode) else {
            return "unrecognised-mode-rejected [\(executed) executed; the agent-supplied mode value was rejected because it is not one of restore_snapshot/rollback_full/ffwd/compare and is therefore not recorded here]"
        }
        if mode == "rollback_full" || mode == "restore_snapshot" {
            return mode
        }
        return executed
    }

    private func snapshot(withId snapshotId: String) -> AppStateSnapshot? {
        snapshots.first { $0.snapshotId == snapshotId }
    }

    private func storeSnapshot(_ snapshot: AppStateSnapshot) {
        snapshots.append(snapshot)
        if snapshots.count > EngineCore.snapshotHistoryLimit {
            snapshots.removeFirst(snapshots.count - EngineCore.snapshotHistoryLimit)
        }
        // A-01: an export failure is only ever asked about alongside its
        // snapshot, so it ages out with it instead of accumulating per id.
        let live = Set(snapshots.map { $0.snapshotId })
        checkpointExportFailures = checkpointExportFailures.filter { live.contains($0.key) }
    }

    private func currentTreeDigest() throws -> AxTreeSnapshot {
        // Tree capture failures surface as GP_E_AX_UNAVAILABLE, matching
        // observe's error vocabulary (§1.2 restore error codes).
        do {
            return try channel.treeSnapshot(maxDepth: Self.defaultObserveDepth)
        } catch let error as ChannelError {
            throw EngineCore.map(error)
        }
    }

    // MARK: - Internals

    static let defaultObserveDepth = 6

    private func attachResult(_ app: AttachedApp) -> [String: Any] {
        var result: [String: Any] = [
            "pid": Int(app.pid),
            "appName": app.appName
        ]
        if let bundleId = app.bundleId {
            result["bundleId"] = bundleId
        }
        return result
    }

    private func latestPack() -> EvidencePack? {
        history.last
    }

    private func pack(withId operationId: String) -> EvidencePack? {
        history.last { $0.operationId == operationId }
    }

    /// 单个 operationId 的**唯一**解析口径（R1-06）：内存 64 环优先，未命中再回
    /// 磁盘档案。`diagnose` 过去只用内存环，而 `last_evidence` 有磁盘回落，于是
    /// 超 64 次或重启后对磁盘上确实存在的档案报 GP_E_NO_OPERATION —— 同一存在
    /// 性问题给出两个相反答案，还连带封死 T8 的迟到事件刷新。两处现在共用它。
    private func resolvedPack(operationId: String?) -> EvidencePack? {
        if let operationId {
            if let found = pack(withId: operationId) {
                return found
            }
            return evidenceStore?.read(operationId: operationId)
        }
        if let latest = latestPack() {
            return latest
        }
        // Memory is empty (fresh daemon / history evicted): fall back to the
        // most recently written archive entry so the audit trail survives.
        if let evidenceStore, let newestId = evidenceStore.lastOnDisk() {
            return evidenceStore.read(operationId: newestId)
        }
        return nil
    }

    @discardableResult
    private func store(_ pack: EvidencePack) -> Bool? {
        history.append(pack)
        if history.count > EngineCore.historyLimit {
            history.removeFirst(history.count - EngineCore.historyLimit)
        }
        return persist(pack)
    }

    private func replace(_ pack: EvidencePack) {
        if let index = history.lastIndex(where: { $0.operationId == pack.operationId }) {
            history[index] = pack
        } else {
            history.append(pack)
        }
        // A diagnosed archive entry is appended above, so the documented
        // in-memory bound has to be enforced here too (R1-06 made diagnose able
        // to resolve packs that live only on disk).
        if history.count > EngineCore.historyLimit {
            history.removeFirst(history.count - EngineCore.historyLimit)
        }
        _ = persist(pack)
    }

    /// Best-effort archive write (spec v1.5 §9.3): never throws so a disk
    /// fault cannot break the main pipeline. Returns nil when persistence is
    /// disabled (`evidenceStore == nil`, i.e. "no archive configured" — not a
    /// failure) and otherwise the actual outcome, which is also recorded in
    /// `lastEvidencePersistenceFailure` (R1-07).
    private func persist(_ pack: EvidencePack) -> Bool? {
        guard let evidenceStore else { return nil }
        if evidenceStore.write(pack) {
            lastEvidencePersistenceFailure = nil
            return true
        }
        lastEvidencePersistenceFailure = EvidencePersistenceFailure(
            operationId: pack.operationId,
            directory: evidenceStore.directory,
            at: nowISO()
        )
        return false
    }

    /// `nil` = 没有测量（任一次树采集缺席），绝不是"界面没有变化"（R1-03）。
    private static func axChanged(before: AxTreeSnapshot?, after: AxTreeSnapshot?) -> Bool? {
        guard let before, let after else { return nil }
        return before.digest != after.digest
    }

    /// R1-09 的投递形状：`count` 始终是真实总数，数组按
    /// `humanEventWireLimit` 截断（不静默丢数）。
    static func humanEventsWire(_ events: [InputEvent]) -> [[String: Any]] {
        events.prefix(Self.humanEventWireLimit).map { event in
            ["timestamp": event.timestamp, "source": event.source.rawValue]
        }
    }

    /// R1-05: wraps a failed roll-forward step. `GPError` is **not** a
    /// `LocalizedError`, so the previous `error.localizedDescription`
    /// interpolation destroyed the inner code/message/remedy (the agent saw
    /// "The operation couldn't be completed. (GPError error 0.)") and
    /// GP_E_BUSY_INPUT's `degrade: true` escape hatch never arrived. The
    /// wrapper keeps the frozen code GP_E_RESTORE_STEP_FAILED and carries the
    /// inner error verbatim.
    static func restoreStepFailure(index: Int, inner: Error) -> GPError {
        let prefix = "ffwd step \(index) failed"
        guard let inner = inner as? GPError else {
            return GPError(code: .restoreStepFailed, message: "\(prefix): \(inner)")
        }
        return GPError(
            code: .restoreStepFailed,
            message: "\(prefix): \(inner.code.rawValue) \(inner.message)",
            remedy: "step \(index) reported \(inner.code.rawValue): \(inner.remedy) — fix that, then re-run restore with the corrected steps"
        )
    }

    /// `performAction` 的失败成因 + 与该成因一致的 remedy（X-9 后半）。W3-B 之后
    /// `performAction` 会抛 `pingTimeout`（应用在 AX 调用里没答完）与
    /// `treeCaptureFailed`（选择器搜索耗尽预算），两者过去都落进
    /// "action failed: …" 配上 GP_E_ACT_FAILED 的默认文案（"换个动作或核对选择器"）,
    /// 把通道超时说成选择器问题。错误码不动（码表冻结）。
    static func actRejection(for error: ChannelError) -> (reason: String, remedy: String?) {
        switch error {
        case .actRejected(let reason):
            return ("action rejected: \(reason)", nil)
        case .pingTimeout:
            // A-14: since R2-19 the selector search inside `performAction` runs
            // under its own wall-clock budget and every AX call in it is capped
            // at what is left of that budget, so a `pingTimeout` here can be the
            // *search* aborting mid-tree. The old wording asserted the opposite
            // ("the search finished", one fixed duration) and sent the agent to
            // wait on an app that may never have been asked to click.
            return (
                "action not performed: an accessibility call did not answer within its budget (per-call timeout anywhere between \(AXChannel.minMessagingTimeoutSeconds)s and \(AXChannel.messagingTimeoutSeconds)s, inside a search bounded by \(AXChannel.treeTimeoutSeconds)s)",
                "the app did not answer an accessibility call, and this engine cannot tell whether the selector search had already finished: a pingTimeout is also what a search aborted mid-tree reports, so treat the element as never located rather than as clicked-or-ruled-out. Sample the app to see whether its main thread is blocked (`sample <pid>`), and confirm the seat with `glasspaned --check-accessibility` before changing anything. If the app answers, repeat the act; narrow the selector (title/identifier) or lower maxDepth only when the reason names the accessibility time budget running out, which is the search itself. Until an answer arrives the outcome is unmeasured, so report diagnose's T2 rather than a dead click"
            )
        case .treeCaptureFailed(let reason):
            return (
                "action not attempted: \(reason)",
                "the selector search ran out of the accessibility time budget, so nothing was clicked and no element was ruled out: retry with a narrower selector (title/identifier) or a shallower tree. The AX channel is alive — verify the seat with `glasspaned --check-accessibility` and do not re-grant it on this error alone"
            )
        default:
            return ("action failed: \(error)", nil)
        }
    }

    /// X-6: one unmeasured pixel channel, in its own words. The label classifies
    /// so an agent can branch on it; the verbatim reason follows after the colon
    /// so the true cause survives into the evidence and the report. A new
    /// `ChannelError.pixelCaptureDenied` reason therefore reaches a caller
    /// instead of being folded into the Screen Recording guess.
    static func pixelCaptureFailureReason(for error: Error) -> String {
        guard let channelError = error as? ChannelError else {
            return "pixel-capture-failed: \(error)"
        }
        guard case let .pixelCaptureDenied(reason) = channelError else {
            return "pixel-capture-failed: \(channelError)"
        }
        return "\(pixelCaptureFailureLabel(reason: reason)): \(reason)"
    }

    /// Pure half of the above: which named failure a capture reason states.
    ///
    /// 顺序是有意的：**具体成因先于席位词**。原因文本里有一大半来自 Apple 的
    /// `localizedDescription`（SCKCapturer 会把原文附在稳定主语后面），而"denied /
    /// permission"这种词出现在那里的句子里并不等于"屏幕录制没给"。把席位判断放前面，
    /// 等于让一句偶然的英文措辞把代理支去系统设置——那条路径比"没测到"更贵。
    static func pixelCaptureFailureLabel(reason: String) -> String {
        let lowered = reason.lowercased()
        if lowered.contains("window-changed") || lowered.contains("window changed") {
            return "pixel-capture-window-changed"
        }
        if lowered.contains("window-resized") || lowered.contains("no common pixel domain") {
            return "pixel-capture-window-resized"
        }
        if lowered.contains("timed out") || lowered.contains("timeout") {
            return "pixel-capture-timeout"
        }
        // R7 更正 R6-双失败 的归并：那条理由（不落进通用 `pixel-capture-failed`，
        // 因为通用标签既不在 p6 的容忍表也不给成因）仍然成立，但它被塞进的标签说的是
        // 一句本文件明知为假的事实——窗口是被 `SCShareableContent` 解析出来的，所以它
        // **在屏**，失败的是"拿不到它这张图"（被盖住，且独立窗口采集也失败）。
        // 标签错，下一步就错：`pixel-capture-no-onscreen-window` 的出路是"取消最小化
        // 或重开窗口"，对一只本来就显示的窗口毫无用处。所以给它自己的标签与自己的出路。
        if lowered.contains("no capture surface") || lowered.contains("is on screen but is covered") {
            return "pixel-capture-no-surface"
        }
        if lowered.contains("no on-screen") || lowered.contains("scwindow") {
            return "pixel-capture-no-onscreen-window"
        }
        if lowered.contains("scdisplay") {
            return "pixel-capture-window-outside-display"
        }
        if lowered.contains("permission") || lowered.contains("not granted") || lowered.contains("denied") {
            return "screen-recording-denied"
        }
        return "pixel-capture-failed"
    }

    /// 像素失败被**抛成错误**时，调用方自己补一句"这次失败对你那条通路意味着什么"。
    ///
    /// 这里刻意不留默认值。以前默认写的是 gp_verify 的话（"pixelDiff 保持 null、T6
    /// 降级 INCONCLUSIVE"），而全仓唯一会把 `pixelCaptureDenied` 抛出去的调用方是
    /// `capture_view` — 它根本没有 pixelDiff 可降级；gp_verify 那边捕获失败是被记进
    /// 证据包与熔断原因的（`pixel-capture-*` 标签 + `Classifier.pixelAbsentNextStep`），
    /// 从不经过这个映射。于是一句默认文案服务不存在的调用方，还让"两边共用"的注释
    /// 变成假的。现在没有调用方补话，错误里就没有那句话——不发明任何主张。
    static let captureViewDegradation =
        "gp_capture_view has no fallback: this visual review did not happen, so report it as not-seen — never infer from a missing image that the interface is fine"

    /// Maps channel failures onto protocol error codes (P0 spec §3.4).
    static func map(_ error: ChannelError, degradation: String? = nil) -> GPError {
        switch error {
        case .axUnavailable(let reason):
            return GPError(code: .axUnavailable, message: reason)
        case .appNotFound:
            return GPError(code: .appNotFound, message: "no running app matches the given bundleId/pid")
        case .actRejected(let reason):
            return GPError(code: .actFailed, message: "action rejected: \(reason)")
        case .assertTargetNotFound:
            return GPError(code: .assertTargetNotFound, message: "no element matches the selector")
        case .attributeUnavailable(let reason):
            // X-9: "I could not read this attribute" is a statement about the
            // read, never about the element. It used to answer
            // GP_E_ASSERT_TARGET_NOT_FOUND — "no element matches the selector" —
            // which hands the agent a fabricated negative: a control that is
            // plainly there gets reported as absent, and the retry advice
            // ("verify the selector") points away from the real cause. The code
            // table is frozen, so the distinction rides on `axUnavailable`, the
            // one existing code that means "the accessibility channel did not
            // answer", with a remedy that denies the absence claim.
            return GPError(
                code: .axUnavailable,
                message: "the attribute could not be read: \(reason) — this is NOT evidence that the element is missing",
                remedy: "the element may be exactly where you expect it; the accessibility channel gave no answer for this one attribute. Run gp_observe to see the node and its role, then repeat gp_assert_element — a busy main thread or a view rebuilt under the selector both read as 'no answer'. Change the asserted `property` only when the app genuinely does not expose it, and do not re-grant Accessibility on this error alone: verify the seat with `glasspaned --check-accessibility`"
            )
        case .treeCaptureFailed(let reason):
            // 错误码保持 GP_E_AX_UNAVAILABLE（码表冻结），但 remedy 必须与**成因**
            // 一致：`treeCaptureFailed` 按定义是"通道活着、树抓取部分失败/超时"
            // （RuntimeChannel 注释），此时叫用户去授予辅助功能既是幻影指引又会
            // 把人引向死路（真机踩到：辅助功能已 granted 却被告知去 --grant-accessibility）。
            if Self.isBudgetFailure(reason) {
                return GPError(
                    code: .axUnavailable,
                    message: "tree capture failed: \(reason)",
                    remedy: "narrow the scope: retry observe/snapshot with a smaller maxDepth (1...10) or a more specific selector; the AX channel is alive — only this capture hit its time budget. Do not re-grant Accessibility: verify the seat with `glasspaned --check-accessibility`"
                )
            }
            return GPError(code: .axUnavailable, message: "tree capture failed: \(reason)")
        case .pixelCaptureDenied(let reason):
            // X-6 (same rule as the act path): the capture's real cause is part
            // of the answer, and only a cause that actually names the seat gets
            // the grant-the-seat advice. Every variant keeps the honest
            // degradation statement (pixelDiff null → T6 INCONCLUSIVE).
            let label = Self.pixelCaptureFailureLabel(reason: reason)
            let seatAdvice = "grant Screen Recording to the daemon (System Settings > Privacy & Security > Screen Recording), then restart the daemon to pick it up; verify with `glasspaned --check-screen-permission`"
            let advice: String
            switch label {
            case "screen-recording-denied":
                advice = seatAdvice
            case "pixel-capture-timeout":
                advice = "the capture query itself ran out of its time budget, so this is not a missing Screen Recording seat (confirm in one line with `glasspaned --check-screen-permission` and do not re-grant on this error alone): the window server or ScreenCaptureKit did not answer in time — retry the operation after the app stops redrawing, and narrow the observed window if it repeats"
            case "pixel-capture-no-onscreen-window":
                advice = "the target owns no on-screen window right now, which no permission grant can fix (the seat is verifiable with `glasspaned --check-screen-permission`): unminimise or reopen the window, or attach to the pid that owns it, then retry"
            case "pixel-capture-window-outside-display":
                advice = "the window frame intersects no display, so the capture area is off every screen: move the window back on screen (or check its saved frame) and retry — the Screen Recording seat is not the problem, verify it with `glasspaned --check-screen-permission` if unsure"
            // R9: `pixel-capture-no-surface` used to fall into `default:`, whose
            // text sends the agent to re-grant Screen Recording and restart the
            // daemon. The MCP shell forwards daemon remedies verbatim, so a
            // covered window produced a restart order — and a restart cancels
            // any act in flight. The classifier already rules on this label
            // (`Classifier.pixelAbsentNextStep`); the advice must say the same
            // thing the label does: the window is on screen, the cover is the
            // cause, and no seat or daemon state is involved.
            case "pixel-capture-no-surface":
                advice = "the window is on screen — the daemon resolved it through SCShareableContent — but no picture of it exists: another window covers it and the window-isolated capture failed too. Nothing is minimised and no permission is missing, so there is nothing to re-grant here; bring the target above whatever covers it (raise it, click its title bar, or move the covering window aside) and retry. Until a capture succeeds the visual channel is not measured: read the structure with gp_observe and report the visual check as not-done rather than as passed"
            case "pixel-capture-window-changed":
                advice = "the frontmost window differed between the two captures, so there is no pixel pair to compare: keep the target window frontmost for the whole operation (a mid-operation click that moves focus re-triggers this) and retry; gp_observe confirms which window is frontmost without needing a capture"
            case "pixel-capture-window-resized":
                advice = "the window changed size during the operation, so the two captures share no pixel domain: retry while the window keeps its size — a live-autosizing or animating window will keep hitting this — or take a baseline with gp_snapshot before the operation and compare against the AX tree when the size cannot be held"
            case "pixel-capture-failed":
                advice = "the capture failed with a cause this classifier cannot name: the verbatim reason after the label is the daemon's own words and it is the only trustworthy guide here — act on what it states, confirm the seat reads back granted with `glasspaned --check-screen-permission` before changing anything about permissions, and report the visual channel as not measured until a capture succeeds"
            default:
                advice = "\(seatAdvice); if that seat is already granted the failure is in the capture path itself, so read the reason above verbatim instead of re-granting"
            }
            return GPError(
                code: .axUnavailable,
                message: "window capture unavailable (\(label)): \(reason)",
                remedy: degradation.map { "\(advice). \($0)" } ?? advice
            )
        case .pingTimeout:
            return GPError(code: .actFailed, message: "app unresponsive (AX ping timeout)")
        }
    }

    /// 是否为"时间预算耗尽"类失败（而非权限缺失）。按 reason 文本判定，与
    /// `AXChannel` 的预算措辞同源；未知形态保守回落默认 remedy（不硬猜）。
    static func isBudgetFailure(_ reason: String) -> Bool {
        let lowered = reason.lowercased()
        return lowered.contains("budget") || lowered.contains("timeout") || lowered.contains("timed out")
    }

    /// Keeps subtrees rooted at nodes whose role matches (observe role filter).
    static func prune(_ roots: [AxNode], matchingRole role: String) -> [AxNode] {
        var result: [AxNode] = []
        for node in roots {
            if node.role == role {
                result.append(node)
            } else {
                result.append(contentsOf: prune(node.children, matchingRole: role))
            }
        }
        return result
    }

    private static func wireValue(_ value: StringOrBool) -> Any {
        switch value {
        case .string(let string): return string
        case .bool(let bool): return bool
        }
    }
}

extension AxNode {
    static let arrayEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}
