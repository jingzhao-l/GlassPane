import XCTest
import Darwin
@testable import GlassPaneEngine

/// 2026-10-12 续轮 · 引擎侧四项，每项都给得出能红的对照。
final class DailyRound20261012Tests: XCTestCase {

    private func tempRoot(_ tag: String) throws -> URL {
        let base = URL(fileURLWithPath: TestSandbox.directory("d12-\(tag.prefix(8))"), isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    // MARK: - 回包的绝对预算（`SO_SNDTIMEO` 是单次 syscall 的超时，每轮重置）

    /// 假时钟：时限"已经走过"。真 socketpair 提供"另一端不读"这件事的另一半。
    func testWriteBoundedStopsAtTheAbsoluteBudget() throws {
        var fds: Int32 = 0
        var pair = [Int32](repeating: 0, count: 2)
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0, "夹具要能真开一对 socket")
        fds = pair[0]
        defer { close(fds); close(pair[1]) }

        let payload = Data(repeating: 0x41, count: 4096)
        var notes: [String] = []
        let started = Date().timeIntervalSince1970
        // 假时钟要**会跳**：`SocketDeadline` 在 init 里取一次 now() 当起点，常量时钟会让
        // elapsed 恒等于 0，那条时限就永远不会到期（这条测试第一次跑就是这么假绿的）。
        var ticks = 0
        let clock: () -> TimeInterval = {
            ticks += 1
            return ticks == 1 ? started : started + 31
        }
        // 时钟"已经"走完 30s 预算：这一帧必须立刻判失败，而不是继续等那个每轮重置的
        // `SO_SNDTIMEO`——从前一个每 29s 读一字节的对端可以无限期钉住这个单客户端 daemon。
        let ok = SocketServer.writeBounded(fds, payload,
                                           deadline: SocketDeadline(seconds: 30, now: clock),
                                           budgetSeconds: 30,
                                           note: { notes.append($0) })
        XCTAssertFalse(ok, "预算已过还继续写，等于把唯一的客户端位置交给不读的对端")
        XCTAssertEqual(notes.count, 1, notes.joined(separator: "\n"))
        XCTAssertTrue(notes[0].contains("absolute budget"), notes[0])

        // 对照：时钟没走过、数据也写得下时必须算成功——否则这条判据只是永远失败。
        let fresh = SocketServer.writeBounded(fds, Data(repeating: 0x42, count: 16),
                                              deadline: SocketDeadline(seconds: 30, now: { started }),
                                              budgetSeconds: 30,
                                              note: { notes.append($0) })
        XCTAssertTrue(fresh, "正常回包要照写出去")
        XCTAssertEqual(notes.count, 1, "对照那一侧不该留下任何一句放弃的话：\(notes.joined(separator: " | "))")
    }

    // MARK: - 读不回台账时的载荷：不许把"看不见"报成"空"

    func testPruneUnreadablePayloadStopsInventingTheCount() {
        let payload = ProjectRegistry.pruneUnreadablePayload(total: 7, matched: 3, registryPath: "/tmp/x/projects.json")
        XCTAssertEqual(payload["loadFailed"] as? Bool, true)
        XCTAssertNil(payload["remaining"], "拒绝的那一跑同时说\"读不回来\"，就不能报\"剩下 0 条\"")
        XCTAssertNil(payload["projects"], "同理：看不见的表不得作为空表交出去")
        XCTAssertEqual(payload["pruned"] as? Int, 0, "pruned: 0 是真话（一条都没被确认删掉）")
        XCTAssertEqual(payload["failed"] as? Int, 3, "matched 全算没做成")
        XCTAssertEqual(payload["registryPath"] as? String, "/tmp/x/projects.json", "现场路径要留给读者")
        let next = payload["next"] as? String ?? ""
        XCTAssertTrue(next.contains("/tmp/x/projects.json"), "下一步要点名是哪份文件：\(next)")
    }

    // MARK: - methodNotFound 要点名它拒绝的是哪份清单

    func testMethodNotFoundNamesTheCapabilityList() throws {
        let frame = Data(#"{"id":9,"method":"gp_checkpoint","params":{}}"#.utf8)
        switch RequestParser.parse(frame) {
        case .success:
            XCTFail("未实现的方法必须被拒")
        case .failure(let failure):
            let message = failure.error.message
            XCTAssertFalse(message.contains("the whitelist") && !message.contains("capabilities"),
                           "只说 \"not in the whitelist\" 而不点名是哪份清单、也不给下一步：\(message)")
            for name in EngineMethod.capabilityWireNames {
                XCTAssertTrue(message.contains(name), "清单要逐项数出来，缺 \(name)：\(message)")
            }
            XCTAssertTrue(message.contains("hello"), "下一步要写得出来：读一次 hello")
        }
    }

    // MARK: - 档案目录被换成符号链接时不得 chmod 过去

    func testArchiveDirectoryPredicateRefusesSymlinksAndNonDirectories() throws {
        let dir = try tempRoot("archdir")
        defer { try? FileManager.default.removeItem(at: dir) }
        let fm = FileManager.default

        let outside = dir.appendingPathComponent("outside", isDirectory: true)
        try fm.createDirectory(at: outside, withIntermediateDirectories: true)
        XCTAssertTrue(EvidenceStore.nameIsUsableArchiveDirectory(outside.path), "对照：真目录必须可用")

        let link = dir.appendingPathComponent("archive")
        try fm.createSymbolicLink(atPath: link.path, withDestinationPath: outside.lastPathComponent)
        XCTAssertFalse(EvidenceStore.nameIsUsableArchiveDirectory(link.path),
                       "符号链接一律不可接管——chmod 会跟着它改到声明半径之外的目录")

        let file = dir.appendingPathComponent("plain")
        fm.createFile(atPath: file.path, contents: Data())
        XCTAssertFalse(EvidenceStore.nameIsUsableArchiveDirectory(file.path))

        XCTAssertTrue(EvidenceStore.nameIsUsableArchiveDirectory(dir.appendingPathComponent("gone").path),
                      "名字不存在算可用：接下来就是 createDirectory，没有东西会被碰到")
    }
}
