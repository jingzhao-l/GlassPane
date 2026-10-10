import XCTest
import Foundation
@testable import GlassPaneEngine

/// 2026-10-09 每日审查的落地闸。每条都对应一处本轮修掉的失效模式，并且各自要求
/// "撤掉那处修复就变红"——绿灯本身不是证据，能红的绿灯才是。
///
/// 状态根一律走 `TestSandbox`：在共享临时目录下自己拼一个唯一名字不算隔离
/// （`TestIsolationGateTests` 的 location-peek 规则正是为此而存在，它第一版就
/// 把我最初写的"手拼 NSTemporaryDirectory"助手判成违规）。
final class ReviewFixes20261009Tests: XCTestCase {

    // MARK: - 1. 退化斜率：对消噪声不能当成测量

    /// 每 5 s 一个样本、8 个点、真实斜率 +500 B/s、时间戳取真 epoch 秒。
    /// 修之前的累加式（`n*Σxy - Σx*Σy`）在这个量级上只剩舍入噪声，测不出这个数。
    func testMemorySlopeIsResolvedNotCancellationNoise() {
        let tracker = DegradationTracker()
        let epochNow = Date().timeIntervalSince1970
        let baseMemory: Int64 = 240_000_000
        for step in 0..<8 {
            let elapsed = Double(step) * 5.0
            tracker.record(DegradationSample(
                timestamp: epochNow + elapsed,
                pingMs: nil,
                memoryBytes: baseMemory + Int64((500.0 * elapsed).rounded()),
                handleCount: nil
            ))
        }
        let verdict = tracker.verdict()
        XCTAssertTrue(verdict.judged, "窗口本来就该够判：\(verdict.basis)")
        guard let slope = verdict.memorySlopeBytesPerSec else {
            return XCTFail("真泄漏 +500 B/s 必须给出读数：\(verdict.basis)")
        }
        XCTAssertEqual(slope, 500.0, accuracy: 25.0,
            "真实 500 B/s 泄漏测成 \(slope)——回归一旦回到原始累加式就会落在这里")
    }

    /// 反面对照：常量内存加 ±200 的抖动，斜率必须贴着 0，不能被噪声凑出一个大正数。
    func testMemorySlopeOfJitterStaysNearZero() {
        let tracker = DegradationTracker()
        let epochNow = Date().timeIntervalSince1970
        let constant: Int64 = 240_000_000
        let jitter: [Int64] = [0, 200, -180, 150, -200, 60, -40, 120]
        for step in 0..<8 {
            tracker.record(DegradationSample(
                timestamp: epochNow + Double(step) * 5.0,
                pingMs: nil,
                memoryBytes: constant + jitter[step],
                handleCount: nil
            ))
        }
        guard let slope = tracker.verdict().memorySlopeBytesPerSec else { return XCTFail("应有读数") }
        XCTAssertLessThan(abs(slope), 60.0, "±200 的抖动被测成 \(slope) B/s")
    }

    // MARK: - 2. 死点击的归类与措辞（一条被规格推翻的指控，钉成闸防止再被报一遍）

    private func pack(axChanged: Bool?, pixelDiff: PixelDiffSignal?) -> EvidencePack {
        let selector = Selector(role: "AXButton", title: "Submit")
        let axEvent: AxEventSignal?
        if let axChanged {
            axEvent = AxEventSignal(
                treeDigestBefore: "aa", treeDigestAfter: axChanged ? "bb" : "aa",
                nodeCount: 10, axChanged: axChanged, latencyMs: 5
            )
        } else {
            axEvent = nil
        }
        return EvidencePack(
            operationId: "op_0123456789ABCDEFGHJKMNPQRS",
            createdAt: "2026-09-14T12:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(selector: selector, action: .press, actConfirmed: true),
                axEvent: axEvent,
                pixelDiff: pixelDiff,
                responsiveness: ResponsivenessSignal(responsive: true, pingMs: 3),
                crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
            )
        )
    }

    /// 审查指控说：`axChanged == false` 且 `pixelDiff == nil` 落到 T3＝替没测过的通道作答，应改判
    /// INCONCLUSIVE。查过真值之后撤回：`specs/GlassPane_P0_实施规格_v1.0.md:294` 与
    /// `specs/GlassPane_P1_实施规格_v1.0_SCK迁移.md:80` 写的都是"屏幕录制权限拒绝 →
    /// pixelDiff=null：T3 判定仍可用（树+操作确认），T6 退化 INCONCLUSIVE"，
    /// `specs/GlassPane_Audit_2026-09-22_全量审查与UI迭代.md` 的 A-7 也处理过同一处，结论是
    /// "改文案、归类保持保守不变"。诚实由措辞保证：没有测量时那一行必须写 unavailable，
    /// 不许写成"像素没变"。
    func testDeadClickStaysDecidableWithoutPixelsButMustSaySo() {
        let unmeasured = pack(axChanged: false, pixelDiff: nil)
        let (diagnosisClass, report) = Classifier.classify(unmeasured)
        XCTAssertEqual(diagnosisClass, .t3,
            "P0 §9 授权 T3 只依赖树与操作确认；这里改成不可判定就是与规格相反：\(report.anomaly)")
        XCTAssertTrue(report.evidence.contains("pixelDiff=unavailable"),
            "未测量的像素通道不许写成\"没变\"：\(report.evidence)")
        XCTAssertFalse(report.evidence.contains("changedPixelRatio"),
            "一次都没测到的比例不许出现在证据行里：\(report.evidence)")

        // 对照：真测到 0 变化时才给得出数字，否则上面那条断言只是"永远说不测"。
        let measured = pack(axChanged: false, pixelDiff: PixelDiffSignal(
            changedPixelRatio: 0.0, bounds: nil, windowId: 12
        ))
        let (measuredClass, measuredReport) = Classifier.classify(measured)
        XCTAssertEqual(measuredClass, .t3, measuredReport.anomaly)
        XCTAssertTrue(measuredReport.evidence.contains("changedPixelRatio=0.0"), measuredReport.evidence)
    }

    // MARK: - 3. 读不开的审批台账：追加必须被拒，盘上字节一个都不能少

    /// 台账存在但解不开时，从前 `append` 照旧执行：`prevHash` 从空链重新锚定，
    /// `persist()` 再把整份文件换成这一条记录——盘上所有历史记录被删，
    /// 而 `--approval-verify` 拿这条孤记录回放会回 `valid: true`。
    func testCorruptLedgerRefusesAppendAndLeavesTheFileUntouched() throws {
        let ledger = TestSandbox.filePath("corrupt-ledger")
        let corrupt = Data("[{\"approvalId\":\"appr_".utf8)
        try corrupt.write(to: URL(fileURLWithPath: ledger), options: .atomic)

        let gate = ApprovalGate(path: ledger)
        XCTAssertTrue(gate.loadFailed, "半截 JSON 必须被记成读不开")
        let appended = gate.append(
            operationRef: "op_0123456789ABCDEFGHJKMNPQRS",
            operationType: "restore",
            riskTier: .high,
            decision: .approve,
            approvedBy: ApprovalGate.autoApprover,
            reason: "这条追加必须被拒"
        )
        XCTAssertNil(appended, "台账读不开时追加等于用一条孤记录覆写整份审计链")
        XCTAssertEqual(gate.count, 0)
        let after = try Data(contentsOf: URL(fileURLWithPath: ledger))
        XCTAssertEqual(after, corrupt, "被拒的追加不许动盘上那半份还能看的档案")
        guard let failure = gate.persistFailed else {
            return XCTFail("拒绝必须留下可查的原因（点名台账路径与下一步）")
        }
        XCTAssertTrue(failure.contains(ledger), "拒绝理由要点名被拒的是哪一个文件")
        XCTAssertTrue(failure.lowercased().contains("refused"), failure)
        XCTAssertTrue(failure.contains(ledger), "拒绝理由要点名被拒的是哪一个文件")
        // 出路不许是"删掉它"：那是把审计链换成一次清理。
        XCTAssertFalse(failure.contains("rm ") && !failure.contains("do not delete"), failure)
        XCTAssertTrue(failure.lowercased().contains("do not delete"), failure)
    }

    /// 对照：健康的台账在同一个闸后面必须照常追加，否则这条守卫只是把写路堵死。
    func testHealthyLedgerStillAppends() throws {
        let ledger = TestSandbox.filePath("healthy-ledger")
        let first = ApprovalGate(path: ledger)
        XCTAssertNotNil(first.append(
            operationRef: "op_0123456789ABCDEFGHJKMNPQRS", operationType: "restore",
            riskTier: .low, decision: .approve,
            approvedBy: ApprovalGate.autoApprover, reason: "第一条"
        ))
        let reopened = ApprovalGate(path: ledger)
        XCTAssertFalse(reopened.loadFailed)
        XCTAssertEqual(reopened.count, 1)
        XCTAssertNotNil(reopened.append(
            operationRef: "op_0123456789ABCDEFGHJKMNPQRT", operationType: "restore",
            riskTier: .low, decision: .approve,
            approvedBy: ApprovalGate.autoApprover, reason: "第二条"
        ))
        XCTAssertEqual(reopened.count, 2)
        XCTAssertTrue(reopened.verifyChain().valid)
        XCTAssertNil(reopened.persistFailed)
    }

    // MARK: - 4. 规范化 JSON：非有限值与 2^53 以上的整数不能两种语言两种拼法

    func testNonFiniteNumbersCanonicaliseToNullLikeJsonStringify() {
        XCTAssertEqual(
            CanonicalJSON.stringify(["v": Double.nan]), "{\"v\":null}",
            "`nan` 不是合法 JSON，而 TS 侧 JSON.stringify 给的是 null"
        )
        XCTAssertEqual(CanonicalJSON.stringify(["v": Double.infinity]), "{\"v\":null}")
        XCTAssertEqual(CanonicalJSON.stringify(["v": -Double.infinity]), "{\"v\":null}")
    }

    func testLargeIntegralNumberUsesFixedNotationLikeJsonStringify() {
        // JSON.stringify(9e15) == "9000000000000000"；Swift 的 description 给指数形态。
        XCTAssertEqual(
            CanonicalJSON.stringify(["v": 9.0e15]), "{\"v\":9000000000000000}",
            "同一个树在两侧算出不同的规范化字节，treeDigest 就分了家"
        )
        XCTAssertEqual(CanonicalJSON.stringify(["v": 1.0e6]), "{\"v\":1000000}")
    }

    // MARK: - 5. 接管一个名字之前：那不是 socket 的 inode 一律拒绝，且绝不删

    func testNonSocketInodeKindsAreNamedAndAbsentIsSilent() throws {
        let directory = TestSandbox.directory("socket-name")
        let regular = directory + "/id_rsa"
        let secret = Data("secret".utf8)
        try secret.write(to: URL(fileURLWithPath: regular))
        XCTAssertEqual(SocketServer.nonSocketInodeKind(at: regular), "a regular file")

        // 拒绝路径本身也必须把文件留在原地；真正"接管前不 unlink"由
        // ReviewLifecycleTests 起真监听的用例证明。
        XCTAssertThrowsError(try SocketServer.refuseNonSocketNameAtTakeover(site: regular)) { error in
            let text = String(describing: error)
            XCTAssertTrue(text.contains("id_rsa"), "拒绝必须点名那个名字：\(text)")
            XCTAssertTrue(text.lowercased().contains("regular"), text)
        }
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: regular)), secret)

        let missing = directory + "/nothing-here"
        XCTAssertNil(SocketServer.nonSocketInodeKind(at: missing), "不存在＝没有名字，不是拒绝")
        XCTAssertEqual(SocketServer.nonSocketInodeKind(at: directory), "a directory")

        let link = directory + "/link.sock"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: regular)
        XCTAssertEqual(SocketServer.nonSocketInodeKind(at: link), "a symlink")

        // 真 socket 必须放行，否则这条闸只是把 bind 关掉。路径超出 sockaddr_un 容限时
        // 如实跳过并说话，而不是让对照静默默成"通过"。
        let realSocket = directory + "/engine.sock"
        guard realSocket.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
            throw XCTSkip("沙箱路径 \(realSocket.utf8.count) 字节，超出 sun_path 容量，"
                + "这条对照在本环境跑不了（不是通过）")
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThan(fd, 0)
        defer { close(fd) }
        boundTestSocket(fd: fd, path: realSocket)
        XCTAssertNil(SocketServer.nonSocketInodeKind(at: realSocket))
    }

    /// 用真 bind 造一个真 socket，免得"是 socket 就放行"那半边只是断言的空转。
    private func boundTestSocket(fd: Int32, path: String) {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        path.withCString { source in
            withUnsafeMutableBytes(of: &addr.sun_path) { destination in
                _ = strncpy(destination.baseAddress!.assumingMemoryBound(to: CChar.self),
                            source, destination.count)
            }
        }
        let bound = withUnsafePointer(to: &addr) { typed in
            typed.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                Darwin.bind(fd, generic, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        XCTAssertEqual(bound, 0, "真 socket 没 bind 上，这条对照就是空的（errno \(errno)）")
    }
}
