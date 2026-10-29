import XCTest
import Foundation
import Darwin
@testable import GlassPaneEngine

// 2026-10-29 泳道 6b —— 探针那笔 `3c5c5ed6` 翻转了**写侧**，本文件钉的是**读侧**。
//
// 缺陷形状（半修）：探针把装不进线路的 `durationNs` 换成一条具名帧
// `{"t":"handlerDurationOverflow", …}`，并在 hello 里带 `durationOverflowCount`；而
// daemon 的 `ProbeWire.decode` 只走它认识的帧型，于是那条合法上报从 `default` 支掉进
// `.malformed("unknown frame type 'handlerDurationOverflow'")`，`ProbeSocketServer` 再把它
// 记进 `rejectedFrames`（"对端发了 malformed 帧"）——一次**读数丢失**被说成一次**协议
// 违规**；hello 里那个计数器则一个读者都没有。
//
// 判据分工（每条都注明什么改动会把它变红）：
//   * 帧解码：具名帧解成自己的 case，**同时**一条真 malformed 仍须判 malformed——
//     负例表不许只收能过的样本，否则"认不出的都放行"也能绿；
//   * hello：`durationOverflowCount` 读得出，坏形状不折成 0（`counter` 的规矩），
//     缺席的键在发布里**不存在**；
//   * 环形缓冲：溢出帧不进事件环——被 demote 成 `.handler` 就是 hitCount 虚增，
//     daemon 与新 case 的注释各点名禁止一次；
//   * 端到端：真 listener + 真 codec + 真 `serve` 线程，溢出帧让新计数器涨而
//     `rejectedFrames` 不动，真坏帧仍让 `rejectedFrames` 涨；
//   * 互锁：daemon 认的那个字符串与探针 `ProbeRuntime.durationOverflowFrameType`
//     一字不差（`stateFolderName` 先例，两条腿都读源码）。
final class Qoder20261029Swift6ProbeDurationOverflowReadSide: XCTestCase {

    // MARK: - 源码互锁的文件访问（向上三级到 engine 包根）

    private var engineRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }
        return url.path
    }

    private func read(_ path: String) throws -> String {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(path)；这一条在没有该文件的环境里不作数")
        }
        return text
    }

    /// 代码行 only：注释不算调用点证明（20261022 闸立的规矩；探针侧那份 `codeOnly`
    /// 是反向变异亲自抓出来的——漂移最爱活在解释漂移的注释里）。
    private func codeOnly(_ text: String) -> String {
        text.components(separatedBy: "\n")
            .filter {
                let trimmed = $0.trimmingCharacters(in: .whitespaces)
                return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("/*") && !trimmed.hasPrefix("*")
            }
            .joined(separator: "\n")
    }

    /// 一个声明的体：从声明行到同缩进的收尾花括号（同一先例的截取规则）。
    private func body(of declaration: String, in source: String) -> String? {
        let lines = source.components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: { $0.contains(declaration) }) else { return nil }
        let indent = lines[start].prefix(while: { $0 == " " || $0 == "\t" }).count
        var out: [String] = []
        for raw in lines[(start + 1)...] {
            let leading = raw.prefix(while: { $0 == " " || $0 == "\t" }).count
            if raw.trimmingCharacters(in: .whitespaces) == "}", leading == indent { break }
            out.append(raw)
        }
        return out.joined(separator: "\n")
    }

    private func probeWireCode() throws -> String {
        codeOnly(try read(engineRoot + "/Sources/GlassPaneEngine/ProbeWire.swift"))
    }

    private func socketServerCode() throws -> String {
        codeOnly(try read(engineRoot + "/Sources/GlassPaneEngine/ProbeSocketServer.swift"))
    }

    private func probeCode() throws -> String {
        codeOnly(try read(engineRoot + "/probe/Sources/GlassPaneProbe/GlassPaneProbe.swift"))
    }

    // MARK: - 夹具

    private func decode(_ json: String) -> ProbeInboundFrame {
        ProbeWire.decode(Data(json.utf8))
    }

    private func helloJSON(_ extra: String) -> String {
        "{\"t\":\"hello\",\"pid\":4242,\"appName\":\"Example\","
            + "\"probeVersion\":\"gp-probe/0.1.0\",\"capabilities\":[\"z1\"]" + extra + "}"
    }

    /// hello 帧走一遍真解码，再交出那份 `ProbeHello`——测的是读侧，不是构造函数。
    private func helloWire(_ extra: String) -> ProbeHello? {
        guard case let .hello(parsed) = decode(helloJSON(extra)) else {
            XCTFail("这一帧本该是合法 hello：\(helloJSON(extra))")
            return nil
        }
        return parsed
    }

    private func hello(
        pid: Int32 = 4242,
        capabilities: [String] = ["z1"],
        durationOverflowCount: Int? = nil
    ) -> ProbeHello {
        ProbeHello(
            pid: pid, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.1.0", capabilities: capabilities,
            durationOverflowCount: durationOverflowCount
        )
    }

    /// 日志的落笔处换成可读数组（`DailyRound20261022PanelGuardTests` 同一形状）。
    private final class Capture: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [String] = []

        var log: EngineLog {
            EngineLog(quiet: false, sink: { data in
                self.lock.lock()
                self.storage.append(String(decoding: data, as: UTF8.self))
                self.lock.unlock()
            })
        }

        var text: String {
            lock.lock(); defer { lock.unlock() }
            return storage.joined()
        }

        func occurrences(of needle: String) -> Int {
            text.components(separatedBy: needle).count - 1
        }
    }

    private enum FixtureError: Error {
        case couldNotConnect(String)
    }

    private func connectProbe(to path: String) throws -> Int32 {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let copied = path.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                guard let base = destination.baseAddress else { return false }
                _ = strncpy(base.assumingMemoryBound(to: CChar.self), source, destination.count)
                return true
            }
        }
        guard copied else { throw FixtureError.couldNotConnect("装不进 sockaddr_un 的名字") }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw FixtureError.couldNotConnect("socket() errno \(errno)") }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                Darwin.connect(fd, rebound, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            let code = errno
            close(fd)
            throw FixtureError.couldNotConnect("connect() errno \(code)")
        }
        return fd
    }

    private func writeLine(_ line: String, to fd: Int32) {
        line.withCString { pointer in
            let written = Darwin.write(fd, pointer, strlen(pointer))
            if written <= 0 {
                // 夹具自己没成立就说清楚：这一帧根本没交给 daemon。
                XCTFail("对端这一侧写不出去（fd \(fd), errno \(errno)）：\(line)")
            }
        }
    }

    private func waitUntil(_ predicate: () -> Bool, within limit: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(limit)
        while Date() < deadline {
            if predicate() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return predicate()
    }

    private func helloLine(durationOverflowCount: String?) -> String {
        "{\"t\":\"hello\",\"pid\":\(getpid()),\"appName\":\"Example\","
            + "\"probeVersion\":\"gp-probe/0.1.0\",\"capabilities\":[\"z1\"]"
            + (durationOverflowCount.map { ",\"durationOverflowCount\":\($0)" } ?? "") + "}\n"
    }

    // MARK: 6b-1 — 具名溢出帧解成自己的 case，未知类型仍然拒

    /// 今天红的那一条：`{"t":"handlerDurationOverflow"}` 现在解成
    /// `.malformed("unknown frame type 'handlerDurationOverflow'")`，于是探针的一次读数
    /// 丢失在 daemon 的账上是一次协议违规。修好后它是自己的 case。
    /// REVERSE：删掉 `ProbeWire.decode` 里 `case durationOverflowFrameType:` 那一支，
    /// 本条与 6b-5 端到端一起红。
    func testTheNamedOverflowFrameDecodesAsItsOwnCase() throws {
        // 只有帧型的一帧也必须解成新 case：帧的合法性由它自己的名字给出，缺同伴键
        // 是"说得更少"，不是"说了假话"，更不是 malformed。
        XCTAssertEqual(
            decode(#"{"t":"handlerDurationOverflow"}"#),
            .handlerDurationOverflow(file: nil, line: nil, ts: 0, rejectedDurationNs: nil),
            "光有帧型也必须认得——否则它又掉回 unknown frame type 那一支"
        )

        // 探针实际发的那一帧（`emitHandler`：t 换成具名类型、值搬到 `rejectedDurationNs`，
        // file/line/ts 原样带着）。越界的值是这条帧存在的全部理由，必须整值读得出。
        let past = Int(Int32.max) + 1
        XCTAssertEqual(
            decode(#"{"t":"handlerDurationOverflow","file":"Slow.swift","line":42,"ts":1.5,"rejectedDurationNs":\#(past)}"#),
            .handlerDurationOverflow(file: "Slow.swift", line: 42, ts: 1.5, rejectedDurationNs: past),
            "装不下的时长必须整值搬回来：折成 0 或折成 nil 都是把这次读数再丢一次"
        )

        // 负时长同样是装不下的时长（探针那一侧 `durationNs < 0` 也发这一帧）。
        XCTAssertEqual(
            decode(#"{"t":"handlerDurationOverflow","rejectedDurationNs":-1}"#),
            .handlerDurationOverflow(file: nil, line: nil, ts: 0, rejectedDurationNs: -1),
            "负值不许被 0…Int32.max 吞掉——那是 handler 帧 durationNs 的界，不是这一帧的"
        )

        // 大整数同样整值读（daemon 是 64 位，`boundedInt32` 的截断陷阱不能搬到这里）。
        XCTAssertEqual(
            decode(#"{"t":"handlerDurationOverflow","rejectedDurationNs":9223372036854775807}"#),
            .handlerDurationOverflow(file: nil, line: nil, ts: 0, rejectedDurationNs: Int.max),
            "Int64 上界的读数不许被折成一个更小的数"
        )

        // 形状对照：真 malformed 的负例表——不许把未知一律放行。
        guard case .malformed(let reason) = decode(#"{"t":"nonsense"}"#) else {
            return XCTFail("未知帧型仍须判 malformed，否则这一轮的闸门什么都没钉住")
        }
        XCTAssertTrue(
            reason.contains("unknown frame type 'nonsense'"),
            "拒的理由要把对端自己那个名字说回来：\(reason)"
        )
        guard case .malformed = decode(#"{"t":"handler"}"#) else {
            return XCTFail("handler 缺 file/line 必须照旧判 malformed：新 case 不是放行一切的后门")
        }
        guard case .malformed = decode("not json") else {
            return XCTFail("非 JSON 必须照旧判 malformed")
        }

        // `rejectedDurationNs: true` 不许桥成"值 1"（`scalar` 的布尔否决）。
        let boolean = decode(#"{"t":"handlerDurationOverflow","rejectedDurationNs":true}"#)
        guard case .handlerDurationOverflow(_, _, _, let rejected) = boolean else {
            return XCTFail("带布尔时长的溢出帧仍该是溢出帧，不该被折回 malformed：\(boolean)")
        }
        XCTAssertNil(rejected, "true 不是时长：读不出就是读不出，不许桥成 1")

        // 这条帧不携带线路的 entry/duration 判别键，daemon 也不许把它的名字换回
        // `handler`——`durationNs` 在环里被当成"一次命中的另一半"。
        if case .handler = decode(#"{"t":"handlerDurationOverflow","durationNs":5}"#) {
            XCTFail("具名溢出帧被认成 handler 帧：那就是被 demote 成另一种帧类型，hitCount 虚增")
        }
        XCTAssertEqual(
            decode(#"{"t":"handlerDurationOverflow","durationNs":5}"#),
            .handlerDurationOverflow(file: nil, line: nil, ts: 0, rejectedDurationNs: nil),
            "线路的判别键不能被借来当溢出帧的读数键"
        )
    }

    /// 帧型字符串在 daemon 侧只有一处定义，且解码支用的就是它（跨包互锁另有 6b-6）。
    /// REVERSE：把常量内联回 `case "handlerDurationOverflow":`，第一条红。
    func testTheDaemonNamesTheFrameTypeOnce() throws {
        XCTAssertEqual(ProbeWire.durationOverflowFrameType, "handlerDurationOverflow")
        let code = try probeWireCode()
        XCTAssertTrue(
            code.contains("case durationOverflowFrameType:"),
            "decode 不再走那个具名常量：字符串漂移就没有唯一的落点了"
        )
        XCTAssertTrue(
            code.contains("default:") && code.contains("unknown frame type '\\(type)'"),
            "未知帧型的拒支没了：这一轮的修复会变成'认不出的都放行'"
        )
    }

    // MARK: 6b-2 — hello 的计数器：读得出、坏形状不折 0、缺席不发布

    /// `ProbeWire.counter(...)` 那段注释讲的正是"读不出/坏形状不许折成 0"，这一条把
    /// 它用到新键上。REVERSE：把 `Self.counter(dict["durationOverflowCount"])` 换成
    /// `(dict["durationOverflowCount"] as? NSNumber)?.intValue ?? 0`，下面四个坏形状
    /// 与缺席那一行一起红。
    func testHelloReadsTheOverflowCountAndRefusesEveryBadShapeAsZero() throws {
        XCTAssertEqual(helloWire(",\"durationOverflowCount\":7")?.durationOverflowCount, 7)
        XCTAssertEqual(
            helloWire(",\"durationOverflowCount\":0")?.durationOverflowCount, 0,
            "0 是一句测量：它必须与'没上报'读得出来不同"
        )
        XCTAssertEqual(
            helloWire(",\"durationOverflowCount\":\(Int32.max)")?.durationOverflowCount,
            Int(Int32.max),
            "上界本身是探针能报的数，不许被误拒"
        )

        for bad in [
            "\"many\"",   // 字符串
            "false",      // 布尔：JSONSerialization 也答 NSNumber，`as? NSNumber` 会放行
            "4294967296", // 2^32：越出计数器自己的 Int32 界（`intValue` 会折成 0）
            "-1"          // 负次数
        ] {
            XCTAssertNil(
                helloWire(",\"durationOverflowCount\":\(bad)")?.durationOverflowCount,
                "坏形状 \(bad) 折成数字，就是把'读不出'说成'数过了'"
            )
        }

        // 缺席是第四种形状，而且与 0 必须是两个不同的答案。
        XCTAssertNil(
            helloWire("")?.durationOverflowCount,
            "老探针没报这一键：nil 是'未上报'，0 是'没丢过'——正是本项目按缺陷处理的那类混淆"
        )
    }

    // MARK: 6b-3 — 连接档案与发布：与 droppedWrites 同一形状

    /// REVERSE：把 `statusJSON` 里那句 `if let durationOverflowCount` 改成无条件
    /// `entry[...] = ... ?? 0`，"缺席不放键"那一行红；把 register 的合并行删掉，
    /// 6b-3 第二条红。
    func testTheConnectionProfilePublishesTheReportedCountAndStaysQuietWhenUnreported() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(hello(pid: 7, durationOverflowCount: 3))
        inbox.register(hello(pid: 22, durationOverflowCount: nil))

        let rows = inbox.statusJSON()
        let reported = try XCTUnwrap(rows.first { ($0["pid"] as? Int) == 7 })
        XCTAssertEqual(reported["durationOverflowCount"] as? Int, 3)

        let silent = try XCTUnwrap(rows.first { ($0["pid"] as? Int) == 22 })
        XCTAssertNil(
            silent["durationOverflowCount"],
            "探针没报这一键时，发布里不许出现它，更不许出现 0"
        )
        // daemon 侧的观察同样按 A-09 的规矩：没收到过溢出帧就不放键。
        XCTAssertNil(silent["durationOverflowFrames"])
        XCTAssertEqual(inbox.durationOverflowFrameCount, 0)

        // 溢出帧到达后才放键，且只按实到的条数放。
        inbox.ingest(pid: 22, frame: .handlerDurationOverflow(
            file: "Slow.swift", line: 42, ts: 0, rejectedDurationNs: Int(Int32.max) + 1
        ))
        let after = try XCTUnwrap(row(inbox, pid: 22))
        XCTAssertEqual(after["durationOverflowFrames"] as? Int, 1, "自报的键没被观察值改写：两个数是两件事")
        XCTAssertNil(after["durationOverflowCount"], "探针没说过的仍然不许出现")
    }

    private func row(_ inbox: ProbeInbox, pid: Int32) -> [String: Any]? {
        inbox.statusJSON().first { ($0["pid"] as? Int) == Int(pid) }
    }

    /// 能力变更公告那种"更啰嗦但对这一键更沉默"的 re-hello 不许把已报的测量抹回
    /// 未上报（`register` 合并注释讲的就是这条），而报了新值的 hello 必须赢。
    /// REVERSE：删掉 register 里 `hello.durationOverflowCount ?? existing…` 那一行，
    /// 第一条断言红。
    func testAQuieterReHelloKeepsTheOverflowCountTheProbeAlreadyReported() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(hello(durationOverflowCount: 5))
        inbox.register(hello(durationOverflowCount: nil))
        XCTAssertEqual(
            inbox.statusJSON().first?["durationOverflowCount"] as? Int, 5,
            "第二帧没提这一键就把已报的测量抹成未上报，正是 register 注释点名的那种蒸发"
        )

        inbox.register(hello(durationOverflowCount: 9))
        XCTAssertEqual(inbox.statusJSON().first?["durationOverflowCount"] as? Int, 9)

        // 真断开不走合并：档案跟着进程走，回收的 pid 从头开始。
        inbox.disconnect(pid: 4242, reason: "peer closed the connection (EOF)")
        inbox.register(hello(durationOverflowCount: nil))
        XCTAssertNil(
            inbox.statusJSON().first?["durationOverflowCount"],
            "新进程没上报过就该缺席，不许继承上一个进程的数"
        )
    }

    // MARK: 6b-4 — ingest：计数，但绝不进环形缓冲

    /// 溢出帧进环 = 一次命中 = hitCount 虚增，正是 `ProbeWire` 那句"never demoted to a
    /// different frame type"点名的形状。对照臂（同一段里）一条真 entry 帧必须照旧算
    /// 命中，否则"环里什么都不动"这种假绿也过得了这一条。
    /// REVERSE：把 `ingest` 那一支改成 `events[pid, default: []].append(...)`（demote 进
    /// 环），hitCount 与 eventsSeen 两处红。
    func testTheOverflowFrameIsCountedButNeverFilesAHandlerHit() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_overflow")

        inbox.ingest(pid: 4242, frame: .handlerDurationOverflow(
            file: "Slow.swift", line: 42, ts: 0, rejectedDurationNs: Int(Int32.max) + 1
        ))
        inbox.ingest(pid: 4242, frame: .handlerDurationOverflow(
            file: "Broken.swift", line: 7, ts: 0, rejectedDurationNs: -1
        ))

        let closed = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_overflow"))
        let signal = try XCTUnwrap(closed.handlerProbe)
        XCTAssertEqual(signal.hitCount, 0, "读数丢失不是命中：hitCount 是 T4/T5/T7 分支的那个数")
        XCTAssertTrue(signal.handlers.isEmpty, "被 demote 就会多出 handler 名目：\(signal.handlers)")

        XCTAssertEqual(inbox.durationOverflowFrameCount, 2, "两次溢出按次数计（帧只说'发生过'）")
        let row = try XCTUnwrap(inbox.statusJSON().first)
        XCTAssertEqual(row["durationOverflowFrames"] as? Int, 2)
        XCTAssertEqual(row["eventsSeen"] as? Int, 0, "溢出帧不是被看见的事件：它没进环")
        XCTAssertNil(row["durationOverflowCount"], "hello 没报这一键，发布里就没有这一键")

        // 对照臂：entry 帧照旧算一次命中、照旧进 eventsSeen——这条闸不是把计数全关。
        inbox.beginWindow(pid: 4242, opId: "op_control")
        inbox.ingest(pid: 4242, frame: .handler(file: "Fast.swift", line: 1, ts: 0, durationNs: nil))
        let control = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_control"))
        XCTAssertEqual(control.handlerProbe?.hitCount, 1, "对照臂：真 handler 帧仍该是命中")
        XCTAssertEqual(inbox.statusJSON().first?["eventsSeen"] as? Int, 1)
        XCTAssertEqual(inbox.durationOverflowFrameCount, 2, "对照臂不许也动溢出计数")
    }

    /// 进程-wide 的读数要活着跨过断开（`unmapableStateFrameCount` 与
    /// `ringEvictedEventsTotal` 各自就是这么收尾的），并且真有一个读者。
    /// REVERSE：删掉 `EngineCore.probeStatus()` 里那一行发布，第二条断言红。
    func testTheDaemonSideTotalSurvivesTheDropAndHasAReader() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(hello(durationOverflowCount: 1))
        inbox.ingest(pid: 4242, frame: .handlerDurationOverflow(
            file: "Slow.swift", line: 42, ts: 0, rejectedDurationNs: 5_000_000_000
        ))
        XCTAssertEqual(inbox.durationOverflowFrameCount, 1)

        inbox.disconnect(pid: 4242, reason: "peer closed the connection (EOF)")
        XCTAssertTrue(inbox.statusJSON().isEmpty, "断开就是断开：不许留一行假档案")
        XCTAssertEqual(inbox.durationOverflowFrameCount, 1, "总读数留着：它说的是发生过的那一次")

        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            settle: {},
            probeInbox: inbox
        )
        XCTAssertEqual(
            core.probeStatus()["durationOverflowFramesTotal"] as? Int, 1,
            "gp_probe_status 里没有这个键，这条计数器就又成了只有测试读过的账（X-3 那一族）"
        )
        // 没有 inbox 是这条通道的缺席，不是测到的 0。
        let bare = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            settle: {}
        )
        XCTAssertNil(bare.probeStatus()["durationOverflowFramesTotal"])
    }

    // MARK: 6b-5 — 端到端：真 listener、真 codec、真 reader 线程

    /// 这一条是本泳道真正的靶子：字节里出现那帧时 `rejectedFrames` 不许涨、新计数器
    /// 必须涨；同一段里再喂一条**真** malformed（`{"t":"nonsense"}`）证明那一支还活着。
    /// REVERSE：把 decode 的具名支删掉（回到今天的 daemon），第一半红；把 malformed 支
    /// 去掉或改成一律放行，第二半红。
    func testServedSocketCountsTheOverflowFrameApartFromRejectedFrames() throws {
        let directory = TestSandbox.directory("6b-overflow")
        let path = directory + "/p"
        let capture = Capture()
        let inbox = ProbeInbox(now: { Date() })
        let server = ProbeSocketServer(socketPath: path, inbox: inbox, log: capture.log)
        try server.start()
        var openFDs: [Int32] = []
        defer {
            for fd in openFDs { close(fd) }
            server.stop()
            try? FileManager.default.removeItem(atPath: directory)
        }

        // — 第一手：合法溢出帧。
        let firstFD = try connectProbe(to: path)
        openFDs.append(firstFD)
        writeLine(helloLine(durationOverflowCount: "1"), to: firstFD)
        XCTAssertTrue(
            waitUntil({ inbox.connection(for: getpid()) != nil }, within: 5),
            "夹具自检：hello 没被收下，后面每一条断言都测不到东西。日志：\(capture.text.debugDescription)"
        )

        writeLine(
            "{\"t\":\"handlerDurationOverflow\",\"file\":\"Slow.swift\",\"line\":42,"
                + "\"ts\":1.5,\"rejectedDurationNs\":\(Int(Int32.max) + 1)}\n",
            to: firstFD
        )
        XCTAssertTrue(
            waitUntil({ inbox.durationOverflowFrameCount == 1 }, within: 5),
            "真 socketpair/真 codec 路径上这一帧没被数进去。日志：\(capture.text.debugDescription)"
        )
        let row = try XCTUnwrap(inbox.statusJSON().first)
        XCTAssertEqual(row["durationOverflowFrames"] as? Int, 1, "daemon 自己观察到的条数")
        XCTAssertEqual(row["durationOverflowCount"] as? Int, 1, "hello 自报的那一键同样抵达")
        XCTAssertEqual(row["eventsSeen"] as? Int, 0, "溢出帧不是事件")
        XCTAssertEqual(
            capture.occurrences(of: "unknown frame type 'handlerDurationOverflow'"), 0,
            "具名帧仍被当成未知类型。日志：\(capture.text.debugDescription)"
        )

        close(firstFD)
        openFDs.removeLast()
        XCTAssertTrue(
            waitUntil({ capture.text.contains("handlerDurationOverflow frame(s)") }, within: 5),
            "收尾没把这帧的条数说出来。日志：\(capture.text.debugDescription)"
        )
        XCTAssertEqual(
            capture.occurrences(of: "frame(s) rejected"), 0,
            "一次读数丢失被记成了协议违规：\(capture.text.debugDescription)"
        )
        // 断开带走 per-pid 档案，进程-wide 的留着（与 A-09 同一条生命周期）。
        XCTAssertEqual(inbox.durationOverflowFrameCount, 1)

        // — 第二手：一条真 malformed。它仍该被拒、仍该进 rejectedFrames。
        let secondFD = try connectProbe(to: path)
        openFDs.append(secondFD)
        writeLine(helloLine(durationOverflowCount: nil), to: secondFD)
        XCTAssertTrue(
            waitUntil({ inbox.connection(for: getpid()) != nil }, within: 5),
            "夹具自检：第二手的 hello 没被收下。日志：\(capture.text.debugDescription)"
        )
        XCTAssertNil(
            inbox.statusJSON().first?["durationOverflowCount"],
            "第二手的 hello 没报这一键：活着的档案里不许凭空出现它，也不许出现 0"
        )
        writeLine("{\"t\":\"nonsense\"}\n", to: secondFD)
        XCTAssertTrue(
            waitUntil({ capture.text.contains("frame malformed from pid") }, within: 5),
            "负例没走 malformed 支：这一轮的闸门是不是把认不出的都放行了？日志：\(capture.text.debugDescription)"
        )
        close(secondFD)
        openFDs.removeLast()
        XCTAssertTrue(
            waitUntil({ capture.text.contains("had 1 frame(s) rejected") }, within: 5),
            "收尾没说出那一次真违规。日志：\(capture.text.debugDescription)"
        )
        XCTAssertEqual(inbox.durationOverflowFrameCount, 1, "真违规不许动溢出计数器")
        XCTAssertEqual(
            capture.occurrences(of: "handlerDurationOverflow frame(s)"), 1,
            "溢出帧的收尾句只该出现过一次——malformed 那一手不许也叫它"
        )
        XCTAssertNil(
            inbox.connection(for: getpid()),
            "两手都收口后 daemon 不许还留着一份活档案——那条行会是别人家的进程"
        )
    }

    // MARK: 6b-6 — 两侧字符串互锁（`stateFolderName` 先例）

    /// daemon 认的帧型字符串必须与探针 `ProbeRuntime.durationOverflowFrameType` 一字
    /// 不差，hello 那个键名同理。两条腿都读：只读常量会放行一个不再用它编码的 daemon，
    /// 只读调用点会放行一个改了名字的探针。
    /// REVERSE：把探针的常量改成 `"handlerDurationOver"`，或把 daemon 的常量改掉，
    /// 对应的两行红。
    func testTheOverflowFrameTypeNameIsLockedToTheProbesConstant() throws {
        let probe = try probeCode()
        XCTAssertTrue(
            probe.contains(#"static let durationOverflowFrameType = "handlerDurationOverflow""#),
            "探针的具名帧类型不再读得出：daemon 认的那个字符串就没有对表对象了"
        )
        XCTAssertEqual(ProbeWire.durationOverflowFrameType, "handlerDurationOverflow")

        // 探针确实在用它发帧，而不是只留着声明。
        let probeSourceText = try read(engineRoot + "/probe/Sources/GlassPaneProbe/GlassPaneProbe.swift")
        let emit = try XCTUnwrap(
            body(of: "func emitHandler(file: String, line: Int, durationNs: Int?)", in: probeSourceText),
            "emitHandler 的形状变了：这一条钉的正是它"
        )
        let emitCode = codeOnly(emit)
        XCTAssertTrue(emitCode.contains("durationOverflowFrameType"), "超界不再换具名溢出帧")
        XCTAssertTrue(emitCode.contains("rejectedDurationNs"), "越界的值不再搬到具名键上：daemon 读的就是那个键")

        // daemon 侧同一个拼写 + 真的走进那个 case。
        let wire = try probeWireCode()
        XCTAssertTrue(
            wire.contains(#"static let durationOverflowFrameType = "handlerDurationOverflow""#),
            "daemon 的字符串与探针的不再是同一个拼写"
        )
        XCTAssertTrue(
            wire.contains("case durationOverflowFrameType:")
                && wire.contains("case handlerDurationOverflow(")
                && wire.contains("return .handlerDurationOverflow("),
            "decode 不再产出/认这个 case：字符串互锁少了一腿"
        )

        // hello 的键名两侧同源，且 daemon 用的是那份现成的数字判据。
        XCTAssertTrue(probe.contains(#""durationOverflowCount":"#), "探针不再在 hello 里报这一键")
        XCTAssertTrue(
            wire.contains(#"Self.counter(dict["durationOverflowCount"])"#),
            "daemon 不再用那份现成的判据读它（新写一份数字判据就是下一次漂移的入口）"
        )

        // 服务端这一支必须在 malformed 之外独立计数，且 malformed 支的形状不许被动。
        let server = try socketServerCode()
        XCTAssertTrue(
            server.contains("durationOverflowFrames += 1"),
            "socket 层不再单独计数：溢出帧又只剩 rejectedFrames 那一个去处了"
        )
        XCTAssertTrue(
            server.contains("if case .malformed(let reason) = frame"),
            "malformed 支的形状变了：探针侧那条闸（Qoder20261029Swift5…）钉的就是这一句"
        )
    }
}
