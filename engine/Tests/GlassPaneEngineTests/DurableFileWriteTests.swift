import XCTest
import Foundation
@testable import GlassPaneEngine

/// `DurableFileWrite`（落盘判定的原语）与三个写者（`EvidenceStore` /
/// `ApprovalGate` / `ProjectRegistry`）对它的接线。
///
/// 缺陷形状（P2，实测于 HEAD）：全仓 `fsync|F_FULLFSYNC` **零调用点**
/// （`engine/Sources`、`mcp-shell/src`、`updater/lib`、`installer`、`bridge` 都
/// grep 过），而 `Data.write(.atomic)` / `replaceItemAt` 保证的是**改名的可见性**，
/// 不是**持久性**：断电之后文件可以在、内容却可能是旧的或零长，而 daemon 早就回答了
/// `evidencePersisted: true` / "确认已删除" / "已记录进审计链"。
///
/// 口径沿用本仓已经成立的先例："chmod 没粘住的那次写要报成失败的写，不是报成存好了"
/// （`EvidenceStore.isolationRefusalReport`、`ProjectRegistry` 的 published-mode 拒绝）。
///
/// 夹具不是 stub：注入的 `Operations` 每一歩都打到真 fd 上，只是在系统调用外面记
/// 一笔，所以"序列里有 fsync"是可证的而不是恒真。
final class DurableFileWriteTests: XCTestCase {

    private final class Recorder {
        private let lock = NSLock()
        private(set) var events: [String] = []
        /// true 时 `fsync` 这一步失败（模拟一块不回答 fsync 的卷）。
        var failFsync = false

        func record(_ event: String) {
            lock.lock(); events.append(event); lock.unlock()
        }

        var operations: DurableFileWrite.Operations {
            DurableFileWrite.Operations(
                open: { [weak self] path, flags, mode in
                    let fd = path.withCString { Darwin.open($0, flags, mode) }
                    self?.record("open(\(Self.kind(fd: fd, path: path)):\((path as NSString).lastPathComponent))")
                    return fd
                },
                write: { [weak self] fd, data, offset in
                    self?.record("write")
                    return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Int in
                        guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return -1 }
                        return Darwin.write(fd, base + offset, data.count - offset)
                    }
                },
                fsync: { [weak self] fd in
                    self?.record("fsync")
                    // 夹具模拟的是**一次真的系统调用失败**：连 errno 一起给，
                    // 否则拒绝报文里会出现一个本夹具从未产生的错误号（那正是本仓
                    // 拒绝的"没说测量的事"）。
                    if self?.failFsync == true {
                        errno = EIO
                        return -1
                    }
                    return Darwin.fsync(fd)
                },
                close: { [weak self] fd in
                    self?.record("close")
                    return Darwin.close(fd)
                },
                lastErrno: { errno }
            )
        }

        /// 打开的那个东西究竟是文件还是目录——判据来自 fstat，不是来自我给的 flag。
        private static func kind(fd: Int32, path: String) -> String {
            if fd < 0 { return "?" }
            var info = stat()
            if fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR { return "D" }
            if path.contains(".tmp-") { return "TMP" }
            return "F"
        }

        var sequence: String { events.joined(separator: ">") }
        var fsyncCount: Int { events.filter { $0 == "fsync" }.count }
        func opened(_ name: String) -> Bool { events.contains { $0.hasPrefix("open(") && $0.contains(":\(name))") } }
    }

    private let injectedNow = Date(timeIntervalSince1970: 1_800_000_000)

    private func opId(_ seed: UInt64) -> String {
        OperationID.generate(
            milliseconds: seed,
            entropy: [UInt8](repeating: UInt8(seed & 0xFF), count: 10),
            prefix: "op_"
        )
    }

    /// 一份**真实落过盘**的证据包：先用健康卷写进档案，再从盘上读回来当夹具。
    /// （规则：夹具的形状必须来自真文件或真响应，而不是测试里凭空拼的形状。）
    private func packOffDisk(seed: UInt64, in directory: String) throws -> EvidencePack {
        let writer = EvidenceStore(directory: directory, now: { self.injectedNow }, log: EngineLog(quiet: true))
        let made = EvidencePack(
            operationId: opId(seed),
            createdAt: EvidenceStore.isoDateFormatter.string(from: injectedNow),
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "Durable"),
                    action: .press,
                    actConfirmed: true
                )
            )
        )
        XCTAssertTrue(writer.write(made), "前置条件：健康卷上这份档案写得出去")
        return try XCTUnwrap(
            writer.read(operationId: made.operationId),
            "前置条件失败：写出去的档案读不回来，夹具无从谈起"
        )
    }

    // MARK: - 1. 调用序列：独占创建 → 写 → fsync → close

    func testStageFsyncsTheBytesBeforeReturning() throws {
        let rec = Recorder()
        let path = TestSandbox.filePath("durable-stage")
        defer { try? FileManager.default.removeItem(atPath: path) }

        try DurableFileWrite.stage(Data("hello durable".utf8), to: path, operations: rec.operations)

        XCTAssertEqual(
            rec.events,
            [rec.events.first ?? "", "write", "fsync", "close"],
            "落盘顺序必须恰好是 创建 → 写 → fsync → close 四步，一步不多（尤其不许在 fsync 之前就发布）：\(rec.sequence)"
        )
        XCTAssertTrue(rec.events[0].hasPrefix("open("), "第一步得是打开临时名：\(rec.sequence)")
        let mode = (try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.int16Value
        XCTAssertEqual(mode, 0o600, "临时名从被 created 的那一瞬起就不许人人可读")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), Data("hello durable".utf8))
    }

    // MARK: - 2. fsync 失败必须是一次数得上号的失败

    func testFsyncFailureRaisesATypedDurabilityFault() throws {
        let rec = Recorder()
        rec.failFsync = true
        let path = TestSandbox.filePath("durable-fsync-fail")
        defer { try? FileManager.default.removeItem(atPath: path) }

        XCTAssertThrowsError(try DurableFileWrite.stage(Data("x".utf8), to: path, operations: rec.operations)) { error in
            guard let fault = error as? DurableFileWrite.Failure else {
                return XCTFail("抛出的必须是可分型的持久化失败，而不是笼统的 \(type(of: error))")
            }
            XCTAssertEqual(fault.step, .fsync)
            XCTAssertTrue(fault.isDurabilityFault,
                          "fsync 的失败必须被认成持久化失败，fallback 不许把它掩盖成成功")
        }
        XCTAssertTrue(rec.events.contains("fsync"), "失败的这一步得真的被执行过：\(rec.sequence)")
        XCTAssertEqual(rec.events.last, "close", "fsync 失败后 fd 仍要关掉，不许泄漏")
    }

    // MARK: - 3. EvidenceStore：fsync 失败 = write 回 false（不是 evidencePersisted:true）

    func testEvidenceStoreRefusesTheWriteWhenFsyncFails() throws {
        let dir = TestSandbox.directory("durable-store-bad")
        let pack = try packOffDisk(seed: 71, in: TestSandbox.directory("durable-store-source"))
        let rec = Recorder()
        rec.failFsync = true
        let store = EvidenceStore(directory: dir, now: { self.injectedNow }, log: EngineLog(quiet: true))
        store.durableWriteOperations = rec.operations

        XCTAssertFalse(store.write(pack), "fsync 失败却回 true，就是把没落盘说成存好了")
        XCTAssertNil(store.read(operationId: pack.operationId), "拒绝之后档案里不该有这一份")
    }

    func testEvidenceStoreStillWritesAndSyncsThePublishedName() throws {
        let dir = TestSandbox.directory("durable-store-ok")
        let pack = try packOffDisk(seed: 72, in: TestSandbox.directory("durable-store-source2"))
        let rec = Recorder()
        let store = EvidenceStore(directory: dir, now: { self.injectedNow }, log: EngineLog(quiet: true))
        store.durableWriteOperations = rec.operations

        XCTAssertTrue(store.write(pack), "健康卷上的正常写必须仍然成功（拒绝不是恒真）")
        XCTAssertNotNil(store.read(operationId: pack.operationId))
        let published = pack.operationId + "." + EvidenceStore.fileExtension
        XCTAssertTrue(rec.opened(published),
                      "发布名自己没有再 fsync 一次：改名之后那份 inode 的字节仍没被承诺 \(rec.sequence)")
        XCTAssertTrue(rec.opened((dir as NSString).lastPathComponent),
                      "目录项没有 fsync：rename 本身就不算落盘 \(rec.sequence)")
        XCTAssertGreaterThanOrEqual(rec.fsyncCount, 3,
                                    "临时件 + 发布件 + 目录，至少三次：\(rec.sequence)")
    }

    // MARK: - 4. ApprovalGate：fsync 失败记进 persistFailed，不是静默成功

    func testApprovalGateReportsPersistenceFailureWhenFsyncFails() throws {
        let path = TestSandbox.filePath("durable-ledger")
        let rec = Recorder()
        rec.failFsync = true
        let gate = ApprovalGate(path: path, clock: { self.injectedNow }, log: EngineLog(quiet: true))
        gate.durableWriteOperations = rec.operations
        gate.append(
            operationRef: opId(73), operationType: "restore", riskTier: .high,
            decision: .deny, approvedBy: "gate", reason: "durability probe"
        )
        let failure = try XCTUnwrap(gate.persistFailed, "fsync 失败必须留下一个可查询的拒绝")
        XCTAssertTrue(failure.contains("fsync"), "拒绝的话得点名失败的那一步：\(failure)")
        XCTAssertFalse(FileManager.default.fileExists(atPath: path),
                       "拒绝之后不许留下发布名")
    }

    func testApprovalGateStillRecordsWhenTheVolumeAnswers() throws {
        let path = TestSandbox.filePath("durable-ledger-ok")
        let rec = Recorder()
        let gate = ApprovalGate(path: path, clock: { self.injectedNow }, log: EngineLog(quiet: true))
        gate.durableWriteOperations = rec.operations
        gate.append(
            operationRef: opId(74), operationType: "restore", riskTier: .high,
            decision: .deny, approvedBy: "gate", reason: "durability ok"
        )
        XCTAssertNil(gate.persistFailed, "健康卷上的一次追加不该被报成失败：\(gate.persistFailed ?? "")")
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        let reloaded = ApprovalGate(path: path, clock: { self.injectedNow }, log: EngineLog(quiet: true))
        XCTAssertEqual(reloaded.count, 1, "写完得能从盘上读回这一条")
    }

    // MARK: - 5. ProjectRegistry：fsync 失败 = 抛拒绝，不留发布名

    func testProjectRegistryRefusesToClaimSuccessWhenFsyncFails() throws {
        let path = TestSandbox.filePath("durable-registry")
        let rec = Recorder()
        rec.failFsync = true
        let registry = ProjectRegistry(filePath: path)
        registry.durableWriteOperations = rec.operations

        XCTAssertThrowsError(try registry.create(
            displayName: "Durability Probe", bundleId: "com.example.durable",
            now: { self.injectedNow }
        )) { error in
            guard let gp = error as? GPError else {
                return XCTFail("注册表的写失败必须报成 GPError，实得 \(type(of: error))")
            }
            XCTAssertEqual(gp.code, .internalError)
            XCTAssertTrue(gp.message.contains("fsync"), "拒绝里必须点名没落盘这件事：\(gp.message)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: path), "拒绝之后不许留下发布名")
    }

    func testProjectRegistryStillPersistsOnAVolumeThatAnswers() throws {
        let path = TestSandbox.filePath("durable-registry-ok")
        let rec = Recorder()
        let registry = ProjectRegistry(filePath: path)
        registry.durableWriteOperations = rec.operations
        let entry = try registry.create(
            displayName: "Answers fsync", bundleId: "com.example.durable2",
            now: { self.injectedNow }
        )
        let reread = ProjectRegistry(filePath: path)
        XCTAssertNotNil(reread.get(entry.projectId), "回读必须看得见这一条")
        XCTAssertTrue(rec.opened((path as NSString).lastPathComponent),
                      "发布名没被 fsync：\(rec.sequence)")
    }
}
