import XCTest
@testable import GlassPaneProbe

// 2026-10-29 泳道 6（S6-1 / S6-2）—— 探针侧的两条"说不出口"：
//
//   S6-1：`emitHandler` 从前把 `durationNs` 原样发出，而 daemon 的 `ProbeWire` 把该键
//         夹在 `0...(Int32.max)`，超界整帧判 malformed、`ProbeSocketServer` 只记日志并
//         丢弃（不进 `ProbeInbox` 环形缓冲）。探针侧的 `droppedWrites` 不动、`hello`
//         干净 ⇒ "有 entry 帧、没有时长"被读成"这次没有 >1ms"，而不是"时长被线路丢吃"。
//   S6-2：`connect(to:)` 从前对 `sun_path` 装不下的名字直接 `return -1`，与"对端没起来"
//         共用同一个返回值 ⇒ 探针按三次尝试 1 s、2 s、3 s 再 30 s 一周期的日程永久重试
//         一个永远不可能拨出去的名字，事件全落 offline 缓冲，`isConnected` 只说"没连上"。
//
// 每条都能被驱动的都驱动了（离线缓冲、真 listener、真 hello 帧、纯函数边界）；只有
// daemon 侧的夹界与丢弃形状是读源码的（那是另一个包，探针测试不链它），互锁走
// `Qoder20261022ProbeReportingAndPackagingGates` 的 `stateFolderName` 先例。

final class Qoder20261029Swift5ProbeWireAndDialGates: XCTestCase {

    override func setUp() {
        super.setUp()
        GP.runtime.resetForTests()
    }

    override func tearDown() {
        GP.runtime.resetForTests()
        super.tearDown()
    }

    // MARK: File access（与 20261022 闸同形：#filePath 编译期固化，向上五级到仓根）

    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.path
    }

    private func read(_ relative: String) throws -> String {
        let path = repoRoot + "/" + relative
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(relative)；这一条在没有该文件的环境里不作数")
        }
        return text
    }

    /// 一个函数的体：从声明行到同缩进的收尾花括号（20261022 闸的同一条截取规则）。
    /// 整文件扫描会让"证明"活在注释里而不是调用点上。
    private func body(of declaration: String, in source: String) -> String? {
        let lines = source.components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: {
            $0.contains(declaration) && !$0.contains("static func")
        }) else { return nil }
        let indent = lines[start].prefix(while: { $0 == " " || $0 == "\t" }).count
        var out: [String] = []
        for raw in lines[(start + 1)...] {
            let leading = raw.prefix(while: { $0 == " " || $0 == "\t" }).count
            if raw.trimmingCharacters(in: .whitespaces) == "}", leading == indent { break }
            out.append(raw)
        }
        return out.joined(separator: "\n")
    }

    /// Swift 代码行 only：注释行不算调用点证明。20261022 闸立的规矩——扫描不许让
    /// "证明"活在解释修复的注释里。（本条是本轮反向变异 M-D 亲自抓出来的：把
    /// `connect` 里的 `socketNameProblem` 调用换回内联长度校验后，只有注释还留着
    /// 那个名字，一个不过滤注释的扫描会绿着放行漂移。）
    private func codeOnly(_ text: String) -> String {
        text.components(separatedBy: "\n")
            .filter {
                let trimmed = $0.trimmingCharacters(in: .whitespaces)
                return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("/*") && !trimmed.hasPrefix("*")
            }
            .joined(separator: "\n")
    }

    private func probeSource() throws -> String {
        try read("engine/probe/Sources/GlassPaneProbe/GlassPaneProbe.swift")
    }

    // MARK: Fixtures

    private func scratchSocketPath(_ name: String) -> String {
        NSTemporaryDirectory() + "gp-s6-\(name)-\(ProcessInfo.processInfo.processIdentifier).sock"
    }

    private func waitUntil(_ seconds: Double, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return condition()
    }

    private func makeListener(path: String) -> Int32 {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return -1 }
        unlink(path)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        path.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { slot in
                _ = strncpy(slot.baseAddress!.assumingMemoryBound(to: CChar.self), source, slot.count)
            }
        }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { name in
                Darwin.bind(descriptor, name, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(descriptor, 4) == 0 else {
            close(descriptor)
            return -1
        }
        return descriptor
    }

    private func acceptConnection(_ listenFD: Int32, within seconds: Double) -> Int32 {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            var slot = pollfd(fd: listenFD, events: Int16(POLLIN), revents: 0)
            if poll(&slot, 1, 100) > 0 { return accept(listenFD, nil, nil) }
        }
        return -1
    }

    private func offlineFrames(_ type: String) -> [[String: Any]] {
        GP.runtime.debugOfflineSnapshot().filter { $0["t"] as? String == type }
    }

    // MARK: S6-1 — 装不下的时长不许冒充"没有 >1ms"

    /// 超界的 `durationNs` 不得作为可携带时长离程：帧型换成具名溢出帧、值搬到
    /// `rejectedDurationNs`（明确不是线路认的那个键）、`durationOverflowCount` +1，
    /// 而 `droppedWrites` 纹丝不动——这**不是**送达丢失，是读数丢失。
    /// REVERSE：把 `emitHandler` 恢复成 `if let durationNs { frame["durationNs"] = durationNs }`
    /// 的原样转发，本条与下面两条一起红。
    func testDurationPastTheWireCapLeavesTheProcessAsANamedOverflowFrame() throws {
        let past = Int(Int32.max) + 1
        GP.runtime.emitHandler(file: "Slow.swift", line: 42, durationNs: past)

        XCTAssertEqual(offlineFrames("handler").count, 0,
                       "超界的时长不许再披着 handler 帧出门——那正是一条 daemon 会整帧丢弃的帧")
        let overflow = try XCTUnwrap(offlineFrames(ProbeRuntime.durationOverflowFrameType).first,
                                     "超界必须换成一条具名溢出帧，而不是安静地消失")
        XCTAssertEqual(overflow["file"] as? String, "Slow.swift")
        XCTAssertEqual(overflow["line"] as? Int, 42)
        XCTAssertNil(overflow["durationNs"],
                     "具名溢出帧不许携带 `durationNs` 键——那是线路的 entry/duration 判别键")

        // 过一道真实的 NDJSON 编码：值不许在序列化里被折成别的数（daemon 侧
        // `boundedInt32` 的注释把那种折叠叫"two truncations posing as one check"）。
        let line = try XCTUnwrap(ProbeRuntime.frameLine(overflow), "溢出帧必须能过 NDJSON 编码")
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: line) as? [String: Any])
        XCTAssertEqual(decoded["rejectedDurationNs"] as? Int, past)
        XCTAssertEqual(decoded["t"] as? String, ProbeRuntime.durationOverflowFrameType)

        XCTAssertEqual(GP.durationOverflowCount, 1, "读数丢失必须记账，且记在自己的名目下")
        XCTAssertEqual(GP.droppedWriteCount, 0, "这不是送达丢失，不许混进 droppedWrites")

        // 负值同样越出 daemon 的 `0…` 下界。
        GP.runtime.emitHandler(file: "Broken.swift", line: 7, durationNs: -1)
        XCTAssertEqual(GP.durationOverflowCount, 2, "负时长同样是装不下的时长")
        XCTAssertEqual(offlineFrames("handler").count, 0)
    }

    /// 帽内（含边界 0 与 Int32.max）照常携带：修超界不能顺手把正常读数改窄。
    func testDurationInsideTheWireCapStillTravelsAsADuration() throws {
        GP.runtime.emitHandler(file: "Fast.swift", line: 1, durationNs: 0)
        GP.runtime.emitHandler(file: "Edge.swift", line: 2, durationNs: Int(ProbeRuntime.durationNsWireCap))
        XCTAssertEqual(GP.durationOverflowCount, 0)
        let handlers = offlineFrames("handler")
        XCTAssertEqual(handlers.count, 2, "帽内的时长必须还是时长帧")
        XCTAssertEqual(handlers[0]["durationNs"] as? Int, 0)
        XCTAssertEqual(handlers[1]["durationNs"] as? Int, Int(Int32.max),
                       "边界值 Int32.max 是 daemon 夹得住的，不许被误拒")

        // entry 帧（无时长）不经过这条闸——它本来就没有 durationNs 键。
        GP.runtime.emitHandler(file: "Entry.swift", line: 3, durationNs: nil)
        let entry = try XCTUnwrap(offlineFrames("handler").last)
        XCTAssertNil(entry["durationNs"])
    }

    /// 端到端：离线期间烧掉一次超界，连上 daemon 后 `hello` 必须带着
    /// `durationOverflowCount`（daemon 现版解码器忽略陌生 hello 键，所以这一条对
    /// 现网无伤害；daemon 侧把它读进 gp_probe_status 是交接项），随后具名溢出帧
    /// 随离线缓冲排空抵达。REVERSE：删掉 sendHello 里的那一键，本条红。
    func testHelloAnnouncesTheOverflowCounterAndTheNamedFrameDrains() throws {
        let path = scratchSocketPath("overflow-hello")
        XCTAssertLessThan(path.utf8.count, ProbeRuntime.sunPathBytes, "夹具名要可拨：\(path)")

        GP.runtime.backoffOverrideMs = 50
        GP.start(socketPath: path, appName: "unit-test") // 还没有人听：帧落离线缓冲
        GP.runtime.emitHandler(file: "Slow.swift", line: 9, durationNs: Int(Int32.max) + 1)

        let listener = makeListener(path: path)
        defer { close(listener); unlink(path) }
        XCTAssertGreaterThanOrEqual(listener, 0, "夹具 listener 没能绑上 \(path)")
        let client = acceptConnection(listener, within: 5)
        defer { if client >= 0 { close(client) } }
        XCTAssertGreaterThanOrEqual(client, 0, "探针必须连上后来出现的 listener")

        let reader = GateFrameReader(client)
        let hello = try XCTUnwrap(reader.nextJSON(), "第一个帧是 hello")
        XCTAssertEqual(hello["t"] as? String, "hello")
        XCTAssertEqual(hello["durationOverflowCount"] as? Int, 1,
                       "超界次数必须随 hello 抵达，否则'有 entry 帧没有时长'与'没有 >1ms'仍旧同形")

        // 离线缓冲排空：那条具名溢出帧要真的到线路上。
        var sawOverflow = false
        for _ in 0..<8 {
            guard let frame = try? reader.nextJSON(2) else { break }
            if frame["t"] as? String == ProbeRuntime.durationOverflowFrameType {
                XCTAssertEqual(frame["rejectedDurationNs"] as? Int, Int(Int32.max) + 1)
                sawOverflow = true
                break
            }
        }
        XCTAssertTrue(sawOverflow, "溢出帧必须随离线缓冲一起排空抵达，而不是留在缓冲里变旧")
    }

    /// 源码互锁（`stateFolderName` 先例）：探针的帽与 daemon 的夹界必须是同一个数。
    /// daemon 把 `durationNs` 的夹界改了、或探针的 `emitHandler` 不再用那个具名常量，
    /// 本条红——两条腿缺一不可：只读文本会放行一个不再使用常量的探针，只读常量会
    /// 放行一个改了夹界的 daemon。
    func testTheWireCapIsLockedToTheDaemonsClampInProbeWireSource() throws {
        let wire = codeOnly(try read("engine/Sources/GlassPaneEngine/ProbeWire.swift"))
        XCTAssertTrue(
            wire.contains("boundedInt32(dict[\"durationNs\"], in: 0...(Int32.max))"),
            "daemon 对 durationNs 的夹界不再是 0…Int32.max：探针的 \(ProbeRuntime.durationNsWireCap) 帽指的是别处"
        )
        // 夹界超出的帧在 daemon 侧是**丢弃**（malformed → 日志 + continue），不是截断。
        let server = codeOnly(try read("engine/Sources/GlassPaneEngine/ProbeSocketServer.swift"))
        XCTAssertTrue(
            server.contains("if case .malformed(let reason) = frame"),
            "daemon 的 malformed 分支形状变了：这一条闸钉的'daemon 会整帧丢弃'需要重新核对"
        )
        XCTAssertEqual(ProbeRuntime.durationNsWireCap, Int32.max,
                       "探针的帽不再等于 daemon 的 Int32.max 夹界")

        let source = try probeSource()
        let emit = try XCTUnwrap(
            body(of: "func emitHandler(file: String, line: Int, durationNs: Int?)", in: source),
            "emitHandler 的形状变了，这一条钉的正是它")
        let emitCode = codeOnly(emit)
        XCTAssertTrue(emitCode.contains("durationNsWireCap"),
                      "emitHandler 不再经过具名常量发闸——帽与调用点脱钩")
        XCTAssertTrue(emitCode.contains("durationOverflowFrameType"),
                      "超界不再换具名溢出帧")
    }

    // MARK: S6-2 — "这个名字根本拨不出去"必须当场说出来

    /// 纯函数边界：103 字节放行、104 字节拒（`sun_path` 容量 104，留隐式 NUL），
    /// 内嵌 NUL 拒，多字节按 UTF-8 字节数计。REVERSE：把 `>=` 改成 `>`，104 那行红。
    func testSocketNameProblemPassesAt103AndRefusesAt104Bytes() throws {
        XCTAssertEqual(ProbeRuntime.sunPathBytes, 104, "Darwin 的 sun_path 容量变了：边界要重新对表")
        let fits = String(repeating: "a", count: 103)
        XCTAssertNil(ProbeRuntime.socketNameProblem(fits), "103 字节是可拨名的上界，不许误拒")

        let oneTooFar = String(repeating: "b", count: 104)
        let problem = ProbeRuntime.socketNameProblem(oneTooFar)
        XCTAssertNotNil(problem, "104 字节装不进 sun_path，必须当场说出来而不是留给 -1")
        XCTAssertTrue(problem?.contains("sun_path") ?? false, "\(String(describing: problem))")

        XCTAssertNotNil(ProbeRuntime.socketNameProblem("/tmp/a\0b.sock"), "内嵌 NUL 会在它处截断成另一个名字")

        // 按 UTF-8 字节计，不按字符计：40 个 CJK 字符是 120 字节，同样装不下。
        let wide = String(repeating: "堵", count: 40)
        XCTAssertEqual(wide.utf8.count, 120)
        XCTAssertNotNil(ProbeRuntime.socketNameProblem(wide),
                        "字符数 40 骗不过 sun_path：线路按字节装名字")
    }

    /// `start(socketPath: 超长)` 的整条行为：当场把原因写进 `GP.socketProblem`，
    /// **不进**重试循环——`debugFailedCycleCount` 不增长（今天它照样把三次尝试加一周
    /// 期烧光、无话可说），不建连接线程，名字本身照记录在案。REVERSE：删掉 start 里
    /// 的 socketNameProblem 预检，本条红（problem 为 nil 且周期照样被烧）。
    func testStartWithAnUndialableNameRefusesOnTheSpotWithoutBurningRetryCycles() throws {
        let undialable = "/var/tmp/gp-s6-" + String(repeating: "x", count: 100)
        XCTAssertGreaterThanOrEqual(undialable.utf8.count, ProbeRuntime.sunPathBytes,
                                    "夹具名必须真的装不下：\(undialable.utf8.count)")

        GP.runtime.backoffOverrideMs = 50 // 若误入重试循环，一个周期 ~200ms 内就能被烧出来
        GP.start(socketPath: undialable, appName: "unit-test")

        let problem = try XCTUnwrap(GP.socketProblem,
                                    "拨不出去的名字必须当场有名有姓——isConnected 只说'没连上'说不清这一半")
        XCTAssertTrue(problem.contains("sun_path"), problem)
        XCTAssertEqual(GP.runtime.debugSocketPathForTests, undialable, "被拒的名字也要可查，否则读数在撒谎")
        XCTAssertFalse(GP.isConnected)

        Thread.sleep(forTimeInterval: 1.0) // 若进了循环：50ms×3 次尝试 + 50ms 周期，早已 failedCycles >= 1
        XCTAssertEqual(GP.runtime.debugFailedCycleCount, 0,
                       "不可拨的名字不许烧重试周期——每一圈都是拿'对端没起来'的形状冒充自己")

        // 事件面不受牵连：离线缓冲照常是诚实的降级。
        GP.recordHandler(file: "While-Refused.swift", line: 1)
        XCTAssertGreaterThan(GP.bufferedEventCount, 0, "拒拨不等于拒收：事件仍落离线缓冲，可见")
    }

    /// 单一真源：`connect` 的拒拨判据必须走同一份 `socketNameProblem`，不许留第二份
    /// 手写的长度校验（两份判据＝一条可以只修一半的漂移）。REVERSE：把 connect 里的
    /// 调用换回原样的内联 `path.utf8.count < MemoryLayout.size(...)`，本条红。
    func testConnectDefersToTheSharedSocketNameProblemCheck() throws {
        let source = try probeSource()
        let connect = codeOnly(try XCTUnwrap(
            body(of: "private func connect(to path: String) -> Int32", in: source)))
        XCTAssertTrue(connect.contains("socketNameProblem"),
                      "connect 不再走那份单一真源：名字判据又成了两处各写一份")

        let start = codeOnly(try XCTUnwrap(
            body(of: "func start(socketPath: String?, appName: String?)", in: source)))
        XCTAssertTrue(start.contains("socketNameProblem"),
                      "start 不再当场判定：不可拨的名字又回到只有 -1 可说")
        XCTAssertTrue(start.contains("socketProblemValue"),
                      "start 判定出的原因没有落到 GP.socketProblem 的读源")
    }
}

/// 读 NDJSON 的最小具读者（与各套件的 FrameReader 同形，私有于本文件）。
private final class GateFrameReader {
    private let fd: Int32
    private var pending = Data()

    init(_ fd: Int32) { self.fd = fd }

    func nextJSON(_ seconds: Double = 5) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(seconds)
        while true {
            if let newline = pending.firstIndex(of: UInt8(ascii: "\n")) {
                let line = Data(pending[pending.startIndex..<newline])
                pending.removeSubrange(pending.startIndex...newline)
                let object = try JSONSerialization.jsonObject(with: line)
                return try XCTUnwrap(object as? [String: Any], "frame is not a JSON object")
            }
            guard Date() < deadline else {
                throw NSError(domain: "GateFrameReader", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "no frame before the deadline"])
            }
            var slot = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&slot, 1, 100) > 0 else { continue }
            var buffer = [UInt8](repeating: 0, count: 4096)
            let received = read(fd, &buffer, buffer.count)
            guard received > 0 else {
                throw NSError(domain: "GateFrameReader", code: 2,
                              userInfo: [NSLocalizedDescriptionKey: "对端在凑满一帧之前关了这条 socket"])
            }
            pending.append(contentsOf: buffer[0..<received])
        }
    }
}
