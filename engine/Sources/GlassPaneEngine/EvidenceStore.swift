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
    /// 2026-10-29 S2-3：这个档案柜的**年龄闸到底作不作数**，由引擎自己说。
    ///
    /// 之前这一面只有 `{count, totalBytes}`，而 `maxAgeDays` 在 `engine/Sources` 里一个调用者
    /// 都没有（`grep -rn "maxAgeDays\|setRetention" engine/Sources` 只命中本文件），于是每次写
    /// 都跑的 `pruneExpiredIfNeeded()` 在生产恒为 no-op——但模块头与 `retentionNotice` 里那句
    /// "older than N day(s)" 让读者以为档案会按年龄到期。这条读数把事实放在引擎答得出来的
    /// 那一面上：默认就是"daemon 不做年龄到期，按年龄删只有 `--prune-evidence --older-than`
    /// 一条路"。它不新增任何配置入口（不扩产品面），只发布已经成立的事实。
    public let ageRetention: String

    public init(
        count: Int, totalBytes: Int, listFailure: String? = nil,
        ageRetention: String = EvidenceStore.ageRetentionNotEnforced
    ) {
        self.count = count
        self.totalBytes = totalBytes
        self.listFailure = listFailure
        self.ageRetention = ageRetention
    }
}

/// `glasspaned --prune-evidence` 的对外形状（spec v1.6 §12.3 的删除侧）。
///
/// `pruned == nil` 与 `pruned == 0` 不是一件事：前者是"归档读不了，所以没数出来"，
/// 后者是"数了，里面没有过期的"。`stats()` 因为同一句话挨过批评（R6-08：读不了的归档
/// 不许被报成空的），而删除这条路从前把 `.unreadable` 折成 `[]` 之后照旧发布
/// `{"pruned":0}` + exit 0——一次"其实什么都没删"的清理就这样被读成"清理完成"。
public enum EvidencePruneReport {
    public static func payload(
        pruned: Int?,
        dryRun: Bool,
        project: String?,
        dir: String,
        listFailure: String?
    ) -> [String: Any] {
        [
            "pruned": pruned.map { $0 as Any } ?? NSNull(),
            "dryRun": dryRun,
            "project": project ?? NSNull(),
            "dir": dir,
            "listFailure": listFailure ?? NSNull(),
        ]
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
/// - `stats()` exposes `{count, totalBytes, ageRetention}` for observation;
/// - `clear()` removes every entry in the active directory on demand.
///
/// Age is **not** one of the write-time passes a daemon runs (2026-10-29 S2-3, measured):
/// `maxAgeDays` has no caller anywhere in `engine/Sources`, so `pruneExpiredIfNeeded()` is a
/// permanent no-op in production and the only route that deletes by age is the explicit
/// `glasspaned --prune-evidence --older-than <days>`. That fact is published rather than
/// implied — through `stats()`'s `ageRetention` reading and through the sentence appended to
/// `retentionNotice` when no age gate is set — and no new configuration surface was added to
/// say it.
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

    /// 引擎对"档案会不会按年龄到期"这一句的唯一实话（2026-10-29 S2-3）。
    ///
    /// 量出来的事实：`maxAgeDays` 与 `setRetention(maxAgeDays:)` 在整个 `engine/Sources` 里
    /// **零个调用者**（`grep -rn "maxAgeDays\|setRetention" engine/Sources` 只命中本文件——
    /// 声明、折算与那条内部 TTL 自己），所以每次写都跑的 `pruneExpiredIfNeeded()` 在生产
    /// 恒为 no-op。不扩产品面（不加新的配置入口），只把这件事放到读得见的地方。
    public static let ageRetentionNotEnforced =
        "not enforced by the daemon; --prune-evidence --older-than <days> is the only age path"

    /// 年龄闸此刻的读数：设了就说谁设的（不是 daemon 的旗），没设就说没设。
    static func ageRetentionReading(maxAgeDays: Int?) -> String {
        guard maxAgeDays != nil else { return ageRetentionNotEnforced }
        return "age gate of \(maxAgeDays!) day(s) set in this process by a caller of EvidenceStore — "
            + "no daemon flag or configuration path sets one, so a daemon started from the CLI runs with "
            + ageRetentionNotEnforced
    }

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
    ///
    /// A3 的同源要求：判定本身不在这里写第二遍，走 `ParamValidation.matchesWhole`——
    /// 与 `requireOperationId` 校验"能被拼成这个名字"的那个函数是同一个。此前这里是
    /// "先比长度、再 `firstMatch`"，而参数侧是"裸 `range(of:…)`"，同一个字面量两套
    /// 判据：参数侧放过 `"op_…\n"`（`$` 也匹配结尾换行之前），这个名字写进档案后
    /// `isEntryName` 又认不出它，于是 `clear()`、两种 prune 与 `stats()` 一起跳过它，
    /// 一次落盘、永不清理。共用一个判据才是"要么整条是 id，要么不算"。
    static func isEntryName(_ name: String) -> Bool {
        ParamValidation.matchesWhole(name, regex: entryNameRegex, utf16Length: entryNameLength)
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
    ///
    /// Read the default as a *fact about the daemon*, not a knob waiting to be
    /// turned: nothing in `engine/Sources` ever passes a value here (S2-3), so
    /// `nil` is what every real archive runs with, and `stats().ageRetention`
    /// says so on the surface the engine can answer from.
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

    /// 临时名怎么起。默认带 pid 与 UUID：这份档案柜有多个写者（daemon，以及对着
    /// 同一个 `--state-dir` 跑的一次性 CLI），共用 `<file>.tmp` 允许一个写者把另一个
    /// 写者半开的缓冲 rename 到位；而且 `.tmp` 结尾过不了 `isEntryName`，`clear()`、
    /// 两种 prune 与 `stats()` 都会把崩溃留下的那个当不存在。
    ///
    /// 可注入，与 `isolationCheck` 同一个理由：`StatePermissionTests` 要走到
    /// "临时名不可用而最终名可写"那条 fallback 分支，非 root 环境里唯一的造法就是在
    /// 一个**已知的**临时名上放目录；名字随机之后那个夹具再也指不到东西，而它守着的
    /// 是 fallback 的拒绝分支——没有夹具等于那条分支没人测过。注入只改名字的
    /// **形状**，不改"独占创建、写前收紧、写坏即删"这套落盘判定。
    var temporaryPath: (String) -> String = {
        $0 + ".tmp-\(getpid())-\(UUID().uuidString)"
    }

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
        // Defect 7: `replaceItemAt` publishes *onto* the existing entry, and the
        // post-publish isolation verdict only runs afterwards — so a refusal there
        // used to `removeAfterRefusal(filePath)` and leave **no entry where one
        // existed**. Rewriting one's own pack is the normal route
        // (`EngineCore.diagnose` → `replace` → `persist`), so the normal route
        // could destroy the audit trail it was refusing to modify.
        //
        // The rule R5-04 already states is "do not publish what you cannot prove
        // isolated"; applied to a replacement, that proof has to be had *before*
        // the overwrite, on the name that is about to be overwritten (measured:
        // `replaceItemAt` hands the destination's attributes to the item that lands
        // there, so this judgment is the one that decides the published mode). The
        // bytes of the existing entry are kept as the second line of defence for
        // the branch where the verdict contradicts itself mid-write.
        //
        // What the gate is: the **name**, not the read. Gating the pre-flight on
        // `priorBytes != nil` (the shape until 2026-10-22) asked the backup whether
        // the overwrite was allowed, and an entry this store cannot read — mode 000,
        // a foreign `deny read` ACL, anything that makes `Data(contentsOf:)` throw —
        // answered "no backup", so the pre-flight was skipped entirely. Then
        // `replaceItemAt` published over the pre-existing entry (its bytes gone with
        // the destination it replaced), the post-publish verdict failed, and with no
        // prior bytes to restore the refusal ran `removeAfterRefusal(filePath)` and
        // unlinked the name too. The audit pack that existed before the call did not
        // exist after it — the exact outcome the comment above forbids. `priorBytes`
        // therefore decides only whether a refused overwrite can be rolled back; it
        // decides nothing about whether the overwrite may be attempted.
        let nameHoldsEntry = Self.isDeletableEntry(destination)
        let priorBytes: Data? = nameHoldsEntry ? try? Data(contentsOf: destination) : nil
        if nameHoldsEntry, let defect = isolationCheck(filePath) {
            // When the previous entry could not be read, this refusal is the only
            // thing that stood between the archive and a lost entry, and the reader
            // has to be told both halves: nothing was published, and nothing here
            // could have rolled a publication back.
            let unbacked = priorBytes == nil
                ? " — the entry already under that name could NOT be read by this process, so this refusal is not backed by a copy of it: nothing was published and that entry stands exactly as it was"
                : ""
            log.error("""
            evidence entry \(filePath) cannot be isolated, so nothing may be published onto it: \
            \(defect) — the existing entry was left exactly as it was, and this write is refused \
            rather than replaced-then-undone (a refusal that removed the published name destroyed \
            the audit trail instead of protecting it)\(unbacked)
            """)
            return false
        }
        // The temp name is unique per write, for the same reason `ProjectRegistry.save`
        // moved off `<file>.tmp`: this archive is written by more than one process
        // (the daemon, and a one-shot CLI run against the same `--state-dir`), and a
        // shared temp name lets one writer rename another's half-written buffer into
        // place. The old fixed name also left an orphan nothing reclaims — `.tmp`
        // fails `isEntryName`, so `clear()`, both prunes and `stats()` walk straight
        // past whatever it left behind.
        let tmpPath = temporaryPath(filePath)
        do {
            // 落盘走 `DurableFileWrite`：独占创建 → 写全 → **fsync** → close，然
            // 后才轮到隔离判定与改名。`Data.write(.atomic)` 只保证"读者看不见半份
            // 文件"，不保证"断电后这份文件还在"，而 `true` 会被 `EngineCore` 说成
            // `evidencePersisted: true`。
            try DurableFileWrite.stage(data, to: tmpPath, operations: durableWriteOperations)
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
                // Defect 7's second line: this branch can only be reached when the
                // pre-flight above passed and the published name then contradicted
                // it (somebody changed the attributes mid-write). Removing the name
                // would still delete a pack that was in the archive a moment ago, so
                // the bytes that were there come back first — and when this process
                // never got those bytes, nothing is removed at all.
                undoPublishedRefusal(
                    filePath: filePath, priorBytes: priorBytes,
                    nameHoldsEntry: nameHoldsEntry, operationId: pack.operationId
                )
                return false
            }
            // 改名的持久化点在**目录项**上：pack 的字节已经 fsync 过，而"这个名字
            // 指向这些字节"这件事要到目录也 sync 才算落。放在隔离判定之后，是因为
            // 判定不过的那一次根本不该被发布出去。
            try DurableFileWrite.syncPublished(atPath: filePath, operations: durableWriteOperations)
            reportRetention(capRemoved: pruneIfNeeded(), ttlRemoved: pruneExpiredIfNeeded())
            return true
        } catch let fault as DurableFileWrite.Failure where fault.isDurabilityFault {
            // 名字能用、盘却说"这些字节没有落"。**不许**走下面那条 fallback：
            // 它一次 fsync 都不做，用它把这次写成 true 正是本条缺陷的形状——
            // 与"chmod 没粘住就报成失败的写"同一条口径。
            log.error(durabilityRefusalReport(filePath, fault: fault))
            // 失败在改名之前（staged 那一步）时，那份临时件是本进程写的、没人认领的
            // 字节——按既有规矩撤掉它。失败在改名之后时 tmpPath 早就不在了，这里
            // 不去假装删了什么。
            if FileManager.default.fileExists(atPath: tmpPath) {
                removeAfterRefusal(tmpPath)
            }
            // 不删已发布的 pack：内容层面它是完好的档案，删掉一次未被证实的持久化
            // 是拿审计数据换一个不存在的保证。调用方拿到的是 `false`，也就是
            // `evidencePersisted: false` + `lastEvidencePersistenceFailure`。
            return false
        } catch {
            // A4/A11：走到这里的是**非持久性**的落盘失败（`open` 抢不到名字、`write`
            // 回 ENOSPC/EDQUOT/EIO……），fallback 直写最终名是既有设计。但从前这条路
            // 两件事都没做：
            //   1. 没撤 `<op>.json.tmp-<pid>-<uuid>`。`stage()` 的 `open(O_CREAT|O_EXCL)`
            //      已经把那个名字创建了，`write` 才失败——于是盘上留下一件本进程写的、
            //      没人认领的半份字节。而 `.tmp-*` 过不了 `isEntryName`，所以 `clear()`、
            //      两种 prune 与 `stats()` 全部跳过它：一块满盘每写一次多一件，永远堆积。
            //   2. 没留主失败原因。调用方最后拿到的 `false` 背后是什么（盘满？名字被
            //      占？），没人知道——同形状的 `ApprovalGate.persist()` 一直留了那句
            //      "falling back"（ApprovalGate.swift:396-398），这里补上同一条口径。
            // 撤 tmp 的写法照 `ApprovalGate.swift:404-410`：删不掉要说出来，不许吞。
            let primary = error
            log.error("evidence pack staging via \(tmpPath) failed: \(primary) — falling back to an atomic write of \(filePath)")
            discardStagedTemp(tmpPath)
            do {
                try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
            } catch {
                log.error("evidence pack \(filePath) failed both routes (staged: \(primary); direct: \(error)) — nothing was published by the fallback, and this write is reported as failed rather than as saved")
                return false
            }
            if let defect = isolationCheck(filePath) {
                log.error(isolationRefusalReport(filePath, defect: defect, route: "fallback"))
                // The same rule as the rename route, and the same three facts: the
                // fallback overwrites a pre-existing entry just as `replaceItemAt`
                // does, so an entry it cannot put back is an entry it must not remove.
                undoPublishedRefusal(
                    filePath: filePath, priorBytes: priorBytes,
                    nameHoldsEntry: nameHoldsEntry, operationId: pack.operationId
                )
                return false
            }
            // 兜底这条路同样不能把"没落盘"写成"存好了"：`Data.write(.atomic)` 之后
            // 补一次文件 + 目录的 fsync，判不过就报 false。
            do {
                try DurableFileWrite.syncPublished(atPath: filePath, operations: durableWriteOperations)
            } catch let fault as DurableFileWrite.Failure {
                log.error(durabilityRefusalReport(filePath, fault: fault))
                return false
            } catch {
                log.error("evidence pack \(filePath) reached its final name by the fallback route but could not be re-synced (\(error)) — the write is reported as failed, not as saved")
                return false
            }
            reportRetention(capRemoved: pruneIfNeeded(), ttlRemoved: pruneExpiredIfNeeded())
            return true
        }
    }

    /// 撤掉**本进程这一趟**写在临时名上的那份字节（A4/A11）。
    ///
    /// 只碰普通文件、不碰符号链接，也不碰目录——判据与 `isDeletableEntry` 同一条：
    /// `stage()` 用 `O_CREAT|O_EXCL` 独占创建，所以"这个名字归我"的唯一证据就是它是一
    /// 个普通文件。这个名字上如果蹲着别人的东西（`StatePermissionTests
    /// .testFallbackWriteRefusesAPackItCannotIsolate` 的夹具就是一个蹲在临时名上的目录，
    /// 它存在的意义正是让 rename 失败），一次"顺手清理"会把别人的数据整棵树带走，而本
    /// 类型对外声明的半径是"只动自己的 `op_<26>.json`"。删不掉要说出来，不许吞。
    private func discardStagedTemp(_ path: String) {
        var info = stat()
        guard lstat(path, &info) == 0 else { return }   // 名字已经不在了：没什么要撤的
        guard (info.st_mode & S_IFMT) == S_IFREG else {
            log.error("the staging name \(path) is not a regular file this process created, so nothing was removed — the fallback below writes only \(path)")
            return
        }
        do {
            try FileManager.default.removeItem(atPath: path)
        } catch {
            log.error("the staged evidence temp file \(path) could not be removed (\(error)) — nothing will ever reclaim it: a `.tmp-*` name is not an archive entry, so `clear()`, both prunes and `stats()` skip it. Delete that one file by name.")
        }
    }

    /// 持久化判定的系统调用面，默认是 `DurableFileWrite.Operations.live`。
    ///
    /// 与 `isolationCheck`/`temporaryPath` 完全同一个理由：单测（非 root）造不出
    /// "fsync 返 EIO 的卷"，而那条拒绝分支若从未被执行过，它就只是一个写在这里的
    /// 承诺。`DurableFileWriteTests` 用它把 `fsync` 换成失败，检验
    /// `write` 回 false、且这份档案没有被写成 `true`。
    var durableWriteOperations = DurableFileWrite.Operations.live

    /// 一次持久化失败对外说的那句话。它与 `isolationRefusalReport` 的区别要留在
    /// 文本里：那条是权限判定（字节在、谁能读不对），这条是**字节没有落**。
    private func durabilityRefusalReport(
        _ path: String, fault: DurableFileWrite.Failure
    ) -> String {
        "evidence pack \(path) was not persisted: \(fault.message) — the write is reported as failed, not as saved, so `evidencePersisted` says what was measured (nothing) rather than what was hoped; the archive directory \(directory) has to be on a volume that answers fsync"
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

    /// 自动留存删掉的东西必须说出来。`write` 回 true 让 `EngineCore` 报
    /// `evidencePersisted: true`——那一句说的是**这一次的操作**存下了，是诚实的；
    /// 但同一次调用还顺手删掉了 N 份旧档案，而 CLI 那条路（`--prune-evidence`）
    /// 是逐条报数的。静默删除审计档案与"删了并说出来"在事后读起来是两件事。
    private func reportRetention(capRemoved: Int, ttlRemoved: Int) {
        guard let notice = Self.retentionNotice(
            capRemoved: capRemoved, ttlRemoved: ttlRemoved,
            maxFiles: maxFiles, maxAgeDays: maxAgeDays, directory: directory
        ) else { return }
        log.info(notice)
    }

    /// 留存结论的折算（纯函数，供单测）：没删东西就回 nil，删了多少就按各自的
    /// 判据说多少条——命中数与删除数在两个方向上都不许互相冒充。
    ///
    /// 没有年龄闸那一条也必须说清楚（2026-10-29 S2-3）：`maxAgeDays == nil` 时"automatic
    /// retention"这句只可能是按条数上限删的，而模块头与 §9.2 让读者以为档案会按年龄到期，
    /// 于是"这次删了 3 条"会被读成"按龄也一直在删"。这里把唯一那条按年龄的路点名，
    /// 不新增任何配置入口。设了年龄闸的那一支一个字不改：它本来就在说自己那半。
    nonisolated static func retentionNotice(
        capRemoved: Int, ttlRemoved: Int, maxFiles: Int, maxAgeDays: Int?, directory: String
    ) -> String? {
        var removed: [String] = []
        if capRemoved > 0 { removed.append("\(capRemoved) over the \(maxFiles)-entry cap") }
        if ttlRemoved > 0, let maxAgeDays { removed.append("\(ttlRemoved) older than \(maxAgeDays) day(s)") }
        guard !removed.isEmpty else { return nil }
        let ageClause = maxAgeDays == nil
            ? "; \(ageRetentionNotEnforced)"
            : ""
        return "automatic retention removed \(removed.joined(separator: " and ")) from \(directory); the archive the panel and gp_export_evidence read is smaller than it was before this write" + ageClause
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

    /// Undo a publication the isolation verdict refused *after* it landed, without
    /// ever removing an entry that was in the archive before the call.
    ///
    /// Three facts, in this order, because the honest answer differs for each:
    /// - this process holds the bytes that were there → put them back;
    /// - the name held an entry but this process never got its bytes → there is
    ///   nothing to restore and no licence to delete: leave the name and report the
    ///   exposure. After the pre-flight in `write` this arm is unreachable (a name
    ///   holding one of this archive's entries is refused before anything is
    ///   published onto it), so it is written to say **which fact it could not
    ///   restore** and never to unlink — unlinking here is defect 7 itself, an
    ///   entry deleted by a refusal that was refusing to modify it;
    /// - the name did not pre-exist → this call published it, so withdrawing the
    ///   publication removes only what this call created.
    private func undoPublishedRefusal(
        filePath: String, priorBytes: Data?, nameHoldsEntry: Bool, operationId: String
    ) {
        if let priorBytes {
            restorePriorBytes(priorBytes, to: filePath, operationId: operationId)
            return
        }
        guard nameHoldsEntry else {
            removeAfterRefusal(filePath)
            return
        }
        log.error("""
        evidence pack \(filePath) failed the isolation verdict after it had been published, and the \
        archive entry that stood under that name before this call could not be read, so there were no \
        prior bytes to restore — the name was LEFT ON DISK rather than unlinked (unlinking it would \
        have removed an entry this write never held the contents of). What is under that name now are \
        the refused bytes: check that one file by hand, and delete it by name only if you accept that
        """)
    }

    /// Put back the bytes a refused replacement had overwritten (defect 7).
    ///
    /// Which of the two failure shapes this is matters to the operator: the write
    /// is still reported as failed — nothing here claims persistence — but an
    /// archive entry that existed before the call must exist after it. The undo
    /// re-runs the isolation check on the restored name and reports the exposure
    /// itself when that fails; silently leaving a world-readable *new* pack, or
    /// silently deleting the old one, are both answers this type has already
    /// refused once in review.
    private func restorePriorBytes(_ prior: Data, to path: String, operationId: String) {
        do {
            try prior.write(to: URL(fileURLWithPath: path), options: .atomic)
        } catch {
            log.error("evidence pack \(operationId) could not be restored to \(path) after the isolation refusal (\(error)) — the refused bytes are what is on disk now; the archive entry was NOT recoverable by this write and the operator must check that name by hand")
            return
        }
        if let defect = isolationCheck(path) {
            log.error("restored evidence pack \(path) is still not owner-only: \(defect) — the pre-existing entry is back on disk and readable by whoever could read it before; this write is reported as failed")
            return
        }
        do {
            try DurableFileWrite.syncPublished(atPath: path, operations: durableWriteOperations)
            log.info("evidence pack \(operationId): refused replacement rolled back to the bytes that were archived before it")
        } catch {
            log.error("restored evidence pack \(path) could not be re-synced (\(error)) — the old bytes are on disk; the durability of that restore is not proven, so it is said rather than claimed")
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
        guard let pack = try? EvidencePack.decodeAndValidate(data) else { return nil }
        // The file answers for the operation its **name** states, so the pack has to
        // agree: without this, copying or renaming `op_A.json` over `op_B.json` makes
        // gp_last_evidence{op_B}, the archive scan and the HTML report all present A's
        // measurement as B's — a "verified" claim about an operation it never ran.
        // A same-user writer can recompute the bytes, which is why this is stated as
        // detectability of a misfiled record, not as tamper-proofing.
        guard pack.operationId == operationId else {
            log.error("evidence pack \(filePath) carries operationId \(pack.operationId): refusing to answer it as \(operationId)")
            return nil
        }
        // A pre-fix archive that never wrote `pixelDiff.bounds` stays readable (the
        // audit trail is not to be narrowed by a code change) but is handed back with
        // that blank named, so no downstream reader takes it for "no pixel changed".
        return pack.markingMissingBoundsProvenance()
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
    ///
    /// 2026-10-27 finding A7c closes the other half of that same sentence. Listing
    /// succeeded here, but each entry's **size** is a second read: `if let size =
    /// try? …` used to drop any entry that would not report one, so the total came
    /// back short — a number — while `listFailure` stayed nil. The caller then
    /// published `totalBytes` as a measurement of an archive whose bytes had only
    /// been partly counted. R6-08's rule is not "report what you managed to add up",
    /// it is "an un-obtained figure is not a zero", so a partial read now reports
    /// failure, names how many entries and which one first, and lets
    /// `--evidence-stats` answer null + exit 1 the way it already does for an
    /// unreadable directory.
    ///
    /// `sizeOf` is the seam that makes that arm testable without racing the
    /// filesystem (a deleted-between-listing-and-stat entry is not a fixture an
    /// author can write deterministically). Its default is the real `URL` resource
    /// value read, so production behavior is the one under test.
    public func stats(sizeOf: (URL) -> Int? = { url in
        (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
    }) -> EvidenceArchiveStats {
        // S2-3：这一面的每一条回答都带着"年龄闸到底作不作数"，包括读不了的那几条。
        let ageRetention = Self.ageRetentionReading(maxAgeDays: maxAgeDays)
        switch archiveListing(keys: [.fileSizeKey]) {
        case .absent:
            return EvidenceArchiveStats(count: 0, totalBytes: 0, ageRetention: ageRetention)
        case let .unreadable(path):
            return EvidenceArchiveStats(
                count: 0, totalBytes: 0,
                listFailure: "cannot read the evidence archive at \(path) to count it",
                ageRetention: ageRetention
            )
        case let .entries(urls):
            var totalBytes = 0
            var uncounted: [String] = []
            for url in urls {
                if let size = sizeOf(url) {
                    totalBytes += size
                } else {
                    uncounted.append(url.lastPathComponent)
                }
            }
            if !uncounted.isEmpty {
                return EvidenceArchiveStats(
                    count: urls.count,
                    totalBytes: 0,
                    listFailure: "\(uncounted.count) of \(urls.count) archive entries would not report a size "
                        + "(first: \(uncounted.first ?? "")), so totalBytes is not obtained — this is reported as "
                        + "null with exit 1 rather than as the smaller total of the entries that did answer",
                    ageRetention: ageRetention
                )
            }
            return EvidenceArchiveStats(count: urls.count, totalBytes: totalBytes, ageRetention: ageRetention)
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
    /// 最近一次归档列举失败的原因。删除与统计两条 CLI 都要读它，所以对外只读；
    /// `private(set)` 是必须的——写入只发生在 `archiveListing` 里，别处不许伪造"读失败了"。
    public private(set) var listingFailure: String?

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
        // chmod 会跟着符号链接走。`fileExists` 与 `createDirectory` 同样跟：一个被放在这里的
        // 链接能让这一层把 0700 加到链接**指向**的那份目录上——那是声明半径之外的一次改动，
        // 而且证据会落进一个不再由这条路径保证属主的目录。同文件的 `isDeletableEntry` 早就
        // 按 `isSymbolicLink` 判过条目，这里把它补到目录本身。
        guard Self.nameIsUsableArchiveDirectory(path) else {
            var info = stat()
            let kind = lstat(path, &info) == 0
                ? ((info.st_mode & S_IFMT) == S_IFLNK ? "a symlink" : "not a directory (mode 0o\(String(info.st_mode & S_IFMT, radix: 8)))")
                : "unreadable (lstat: \(String(cString: strerror(errno))))"
            log.error("evidence directory \(path) is \(kind) — refusing to chmod through it or archive into it; move that name aside, or point the daemon at another root with --state-dir")
            return false
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
extension EvidenceStore {
    /// 这个名字能不能由本层接管为档案目录（纯 IO 谓词，可单测）。
    ///
    /// 判据只有一条：`lstat` 看见的是**目录本身**。符号链接一律不算——`chmod`、
    /// `fileExists`、`createDirectory` 都会跟着链接走，于是"把档案目录收紧到 0700"
    /// 会变成去改链接指向的那一份（声明半径之外），而证据落进的目录也不再由这条路径
    /// 保证属主。名字不存在算可用：下面就是 `createDirectory`，没有东西会被碰到。
    public static func nameIsUsableArchiveDirectory(_ path: String) -> Bool {
        var info = stat()
        guard lstat(path, &info) == 0 else {
            return errno == ENOENT
        }
        return (info.st_mode & S_IFMT) == S_IFDIR
    }
}
