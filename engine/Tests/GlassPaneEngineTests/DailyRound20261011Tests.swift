import XCTest
import Darwin
@testable import GlassPaneEngine

/// 2026-10-11 每日轮的三条引擎修复，各配一个能变红的对照。
///
/// 夹具形状一律来自真过程：真的 `lstat` 目标（普通文件、目录、符号链接、FIFO、真 bind 出来的
/// socket 文件），真的 `timeIntervalSince1970` 量级时间戳，真的写坏一次的台账文件。不在桩里
/// 编形状。
final class DailyRound20261011Tests: XCTestCase {

    private func tempRoot(_ tag: String) throws -> URL {
        // 路径要短：sun_path 只有 104 字节，长 temp 路径会让 bind 在测试里先失败，
        // 那时红的是夹具而不是被测的那条规矩。
        let base = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .appendingPathComponent("gp-\(tag)-\(UUID().uuidString.prefix(6))", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    // MARK: - 删除之前先证明那名字是个 socket

    func testNameIsClearableSocketNameRejectsEveryNonSocketShape() throws {
        let dir = try tempRoot("namekind")
        defer { try? FileManager.default.removeItem(at: dir) }
        let fm = FileManager.default

        let regular = dir.appendingPathComponent("regular").path
        fm.createFile(atPath: regular, contents: Data())
        XCTAssertFalse(DaemonProbe.nameIsClearableSocketName(regular), "普通文件不许被删")

        let nested = dir.appendingPathComponent("adir", isDirectory: true)
        try fm.createDirectory(at: nested, withIntermediateDirectories: true)
        XCTAssertFalse(DaemonProbe.nameIsClearableSocketName(nested.path), "目录不许被删")

        let linkTarget = dir.appendingPathComponent("target").path
        let link = dir.appendingPathComponent("link").path
        fm.createFile(atPath: linkTarget, contents: Data())
        try fm.createSymbolicLink(atPath: link, withDestinationPath: linkTarget)
        XCTAssertFalse(DaemonProbe.nameIsClearableSocketName(link), "符号链接不许被删——删掉它等于删别人的名字")

        let dangling = dir.appendingPathComponent("dangling").path
        try fm.createSymbolicLink(atPath: dangling, withDestinationPath: "/no/such/place-anywhere")
        XCTAssertFalse(DaemonProbe.nameIsClearableSocketName(dangling), "悬空链接同样不许")

        let fifo = dir.appendingPathComponent("fifo").path
        XCTAssertEqual(mkfifo(fifo, 0o600), 0, "夹具要能造出 FIFO，否则这一档没被扫到")
        XCTAssertFalse(DaemonProbe.nameIsClearableSocketName(fifo), "FIFO 不许被删")

        // 对照的一半：读不到的名字（压根不存在）算可清——没有东西要删，bind 自己会建。
        XCTAssertTrue(DaemonProbe.nameIsClearableSocketName(dir.appendingPathComponent("gone").path),
                      "名字不存在时不得拒绝启动")
    }

    /// 真 bind 一个 unix socket 再只关 fd、不 unlink ——这就是合法的 A-18 残留，必须仍可清。
    private func makeStaleSocket(at path: String) throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThan(fd, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        XCTAssertLessThan(bytes.count + 1, MemoryLayout.size(ofValue: addr.sun_path),
                          "夹具路径太长，sun_path 会先截断")
        withUnsafeMutablePointer(to: &addr.sun_path) { slot in
            _ = slot.withMemoryRebound(to: CChar.self, capacity: bytes.count) { memcpy($0, bytes, bytes.count) }
        }
        let bound = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        XCTAssertEqual(bound, 0, "夹具要能真 bind 出一个 socket 名字")
        close(fd) // 不 unlink：留下残留
    }

    func testProbeClearsARealStaleSocketButRefusesARegularFile() throws {
        let dir = try tempRoot("probename")
        defer { try? FileManager.default.removeItem(at: dir) }

        let stale = dir.appendingPathComponent("probe.sock").path
        try makeStaleSocket(at: stale)
        XCTAssertTrue(FileManager.default.fileExists(atPath: stale))
        // 三态探针在这里是真跑的：残留 socket 上 connect() 回 ECONNREFUSED → noListener，
        // 于是这条走的是产品真正的判定，不是注入。
        let live = ProbeSocketServer(socketPath: stale, inbox: ProbeInbox(), log: EngineLog(quiet: true))
        XCTAssertNoThrow(try live.start(), "真残留 socket 必须仍能清掉并重绑——否则这条闸只会拒绝")
        live.stop()

        let file = dir.appendingPathComponent("plain.sock").path
        FileManager.default.createFile(atPath: file, contents: Data("somebody else's file".utf8))
        let blocked = ProbeSocketServer(socketPath: file, inbox: ProbeInbox(), log: EngineLog(quiet: true))
        XCTAssertThrowsError(try blocked.start()) { error in
            guard case ProbeServerError.nameOccupied(let detail) = error else {
                return XCTFail("普通文件占名要报 nameOccupied，实得 \(error)")
            }
            XCTAssertTrue(detail.contains("regular file"), detail)
        }
        let survivors = try Data(contentsOf: URL(fileURLWithPath: file))
        XCTAssertEqual(String(decoding: survivors, as: UTF8.self), "somebody else's file",
                       "被拒之后那个文件必须一个字节都没动")
    }

    // MARK: - 斜率：原始 epoch 上做最小二乘，量量都是舍入噪声

    func testMemorySlopeIsTheSameNumberAtEpochAndAtSmallTimestamps() {
        // 生产喂进来的 x 是 `clock().timeIntervalSince1970`（~1.79e9）。同一条 2000 B/s 的
        // 真实增长，把时间轴搬到 epoch 上再算一次必须给出同一个斜率——从前不是：
        // `count*sumXX - sumX*sumX` 的两项都在 1e21 量级，双精度间距约 2e5，实测 288 个时钟
        // 相位里 115 个直接回 nil，其余 −335…+336 B/s，全在 512 B/s 地板之下，于是
        // `judged:true` 替一条真泄漏认证了"量过了，健康"。
        let epoch: Double = 1_792_000_000
        let growth: Double = 2_000

        func tracker(startedAt base: Double) -> DegradationTracker {
            let watch = DegradationTracker()
            for index in 0..<64 {
                let offset = Double(index) * 0.5
                watch.record(DegradationSample(
                    timestamp: base + offset,
                    pingMs: 1.0,
                    memoryBytes: Int64(1_500_000_000 + growth * offset),
                    handleCount: nil
                ))
            }
            return watch
        }

        let small = tracker(startedAt: 1_000).verdict()
        let epochVerdict = tracker(startedAt: epoch).verdict()
        guard let smallSlope = small.memorySlopeBytesPerSec, let epochSlope = epochVerdict.memorySlopeBytesPerSec else {
            return XCTFail("两种时间轴都必须量得出斜率：small=\(String(describing: small.memorySlopeBytesPerSec)) epoch=\(String(describing: epochVerdict.memorySlopeBytesPerSec))")
        }
        XCTAssertEqual(smallSlope, growth, accuracy: growth * 0.02, "小 x 一侧的基准：\(smallSlope)")
        XCTAssertEqual(epochSlope, smallSlope, accuracy: growth * 0.02,
                       "搬到 epoch 上必须是同一个数：small=\(smallSlope) epoch=\(epochSlope)")
        XCTAssertTrue(epochVerdict.judged, "64 样本 / 31.5s 跨度是量过了，不是不足统计")
    }

    // MARK: - 读不出来的台账不许被重新锚定

    func testCorruptLedgerIsNeverReanchoredAndTheFileSurvivesAnAppendAttempt() throws {
        let dir = try tempRoot("approval-latch")
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("approvals.json")
        let corrupt = Data("this is not JSON at all".utf8)
        try corrupt.write(to: file, options: .atomic)

        let gate = ApprovalGate(path: file.path, clock: { Date(timeIntervalSince1970: 1_760_000_000) })
        XCTAssertTrue(gate.loadFailed, "读失败的台账必须带旗标（这条既有）")
        XCTAssertEqual(gate.chain().count, 0)

        // 从前 `append` 不看旗标：以空链重新锚定，`persist()` 把内存覆写回文件——审计链被本次
        // 运行销毁，而 `--approval-verify` 读那份覆写结果形状完好，于是给刚被截断的台账判"通过"。
        XCTAssertNil(gate.append(
            operationRef: "op-1",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: "daemon:auto",
            reason: "the append that must not rewrite history"
        ), "读不出时追加必须被拒，而不是从空链记起")

        XCTAssertEqual(try Data(contentsOf: file), corrupt, "原文件必须一个字节都没动——它现在是人唯一的现场")
        XCTAssertNotNil(gate.persistFailed, "这一拒必须有读者：面板与 --approval-verify 都看这个字段")
    }
}
