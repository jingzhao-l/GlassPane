import XCTest
@testable import GlassPaneEngine

/// `sockaddr_un.sun_path` 的容量判定。
///
/// 这条闸对着的缺陷：四个 bind/connect 点都是同一段代码——"`strncpy` 拷进
/// `sun_path`，然后检查拷没拷成功"。`strncpy` 对超长输入**静默截断**并返回目标
/// 指针，所以那个检查恒为真——两处写在文档里的 `invalidPath` 拒绝，在它自己注释
/// 所说的场景里**永远走不到**（一条没法红的闸）。真长的路径于是绑成一个截短的名字，
/// 随后 chmod/unlink 打在全名上双双 ENOENT；connect 那侧报"没有监听者"而真名上有人。
///
/// 路径一律从 `TestSandbox` 取（`TestIsolationGateTests` 不许测试自己拼临时目录名）。
final class SocketPathCapacityTests: XCTestCase {

    /// 一个沙盒目录 + 一个满到装不下自己的名字（沙盒根约 60 字节 + 这一串）。
    private func overlongPath(_ label: String = "toolong") -> String {
        TestSandbox.directory(label) + "/" + String(repeating: "glasspane-toolong", count: 12)
    }

    func testCapacityIsTheSunPathSlotNotAnAssumption() {
        let probe = sockaddr_un()
        XCTAssertEqual(UnixSocketAddress.capacity, MemoryLayout.size(ofValue: probe.sun_path))
        XCTAssertEqual(UnixSocketAddress.capacity, 104, "macOS 的 sun_path 是 104 字节")
    }

    /// 边界必须正好卡在"能不能原样放进去"，不许差一。
    func testFitsStopsAtTheLastByteThatRoundTrips() {
        let directory = TestSandbox.directory("fit")
        let used = directory.utf8.count + 1  // 目录后面还有那个 "/"
        XCTAssertGreaterThan(used, 10, "沙盒根太短，这一组边界样本测不出东西")
        XCTAssertTrue(
            UnixSocketAddress.fits(
                directory + "/" + String(repeating: "a", count: UnixSocketAddress.capacity - used - 1)),
            "最后一个可放下的名字（总长 capacity-1，留出终结符）必须放行")
        XCTAssertFalse(
            UnixSocketAddress.fits(
                directory + "/" + String(repeating: "a", count: UnixSocketAddress.capacity - used)),
            "占满终结符位的那一个名字必须被拒")
    }

    func testAddressRoundTripsTheExactName() throws {
        let path = TestSandbox.filePath("roundtrip")
        var address = try XCTUnwrap(UnixSocketAddress.address(for: path))
        let stored = withUnsafeBytes(of: &address.sun_path) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        XCTAssertEqual(stored, path, "槽里装的必须就是调用方给的那个名字")
    }

    func testOverlongAndEmbeddedNulNamesAreRefused() {
        XCTAssertNil(UnixSocketAddress.address(for: overlongPath("refuse")))
        XCTAssertNil(UnixSocketAddress.address(for: "a\u{0000}b"))
    }

    /// 行为的一半：探针监听器在超长路径上必须**真的**回它文档里承诺的那个错误。
    /// 修之前这里绑出一个截短名并成功启动，`invalidPath` 一次都没被构造过。
    func testProbeServerRefusesANameThatDoesNotFit() {
        let path = overlongPath("probe-bind")
        let server = ProbeSocketServer(
            socketPath: path,
            inbox: ProbeInbox(),
            log: EngineLog(quiet: true)
        )
        XCTAssertThrowsError(try server.start()) { error in
            guard let probeError = error as? ProbeServerError,
                  case .invalidPath(let refused) = probeError else {
                return XCTFail("超长探针路径本该回 invalidPath，实际回 \(error)")
            }
            XCTAssertEqual(refused, path,
                "拒绝必须说原名字，说截短后的名字等于把同一个缺陷搬进报错里")
        }
    }

    /// 连侧：一个放不进 `sun_path` 的名字**绝不许**被判成"有人听着但不开口"或
    /// "答了话"——截断后去连那个短名字，正是把一个无关进程当成答案的那条形。
    func testLivenessOnAnUnrepresentableNameIsNeverOccupied() {
        switch DaemonProbe().liveness(socketPath: overlongPath("probe-live"), waitForHello: false) {
        case .noListener(let reason):
            XCTAssertTrue(reason.contains("sockaddr_un") || reason.contains("no socket file"),
                "拒绝的理由必须说得出是哪一个原因，实到 \(reason)")
        case .presentButNotAnswering(let reason):
            XCTFail("放不下、因而根本连不出去的名字被判成有人占着：\(reason)")
        case .answered(let summary):
            XCTFail("一个连 sockaddr_un 都装不下的名字答回了 hello：pid \(summary.pid ?? -1)")
        }
    }

    /// 结构闸：`engine/Sources` 里只许有一处在往 `sun_path` 上写，就是
    /// `UnixSocketAddress` 自己。新增第二个 bind/connect 点若绕开它，就又拿到一份
    /// 会静默截断的拷贝。（探针自己那份在 `engine/probe`，是另一个包，带同判定。）
    func testNoProductionSiteCopiesIntoSunPathByHand() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let sourcesDir = url.appendingPathComponent("engine/Sources").path
        guard let enumerator = FileManager.default.enumerator(
            at: URL(fileURLWithPath: sourcesDir), includingPropertiesForKeys: nil) else {
            throw XCTSkip("读不到 \(sourcesDir)；这一条对照在没有该目录的环境里不作数")
        }
        var copiers: [String] = []
        var scanned = 0
        for case let fileURL as URL in enumerator where fileURL.pathExtension == "swift" {
            scanned += 1
            guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else { continue }
            if fileURL.lastPathComponent == "UnixSocketAddress.swift" { continue }
            for line in text.split(separator: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("//") || trimmed.hasPrefix("///") { continue }
                if trimmed.contains("sun_path") {
                    copiers.append("\(fileURL.lastPathComponent): \(trimmed)")
                }
            }
        }
        XCTAssertGreaterThanOrEqual(scanned, 40,
            "只扫到 \(scanned) 个源文件，这条闸已经在看不到东西的地方")
        XCTAssertTrue(copiers.isEmpty,
            "这些地方还在手搓 sun_path 拷贝，绕开了容量判定：" + copiers.joined(separator: " / "))
    }
}
