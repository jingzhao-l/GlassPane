import XCTest
@testable import GlassPaneEngine

/// P1 v1.2 §11「权限主体修正」的纯逻辑验收：授权主体身份解析、daemon 自报
/// 席位的线上往返、面板 → daemon 的申请命令构造、拖拽源选择与文案主体。
///
/// 全部走注入式钩子，不触碰真实 TCC / 系统面板 / GUI，可在无权限环境直测
/// （对齐 P1-C1/C2 的探针层口径）。
final class PermissionSubjectTests: XCTestCase {

    // MARK: - §11.1 授权主体身份

    func testBareBinarySubjectHasNoBundleIdentityAndUsesFileName() {
        let subject = PermissionSubject(binaryPath: "/Volumes/Eng-Dev/GlassPane/engine/.build/release/glasspaned")
        XCTAssertFalse(subject.hasBundleIdentity, "裸二进制不得伪装成 bundle 身份")
        XCTAssertEqual(subject.tccEntryName, "glasspaned", "裸二进制在系统设置里只能显示文件名")
    }

    func testBundleSubjectNameComesFromBundleDirectory() {
        let subject = PermissionSubject(
            binaryPath: "/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned",
            bundleIdentifier: "com.glasspane.daemon",
            bundlePath: "/Users/dev/Applications/GlassPane Daemon.app"
        )
        XCTAssertTrue(subject.hasBundleIdentity)
        XCTAssertEqual(subject.tccEntryName, "GlassPane Daemon", "bundle 身份应显示可读名（系统据此带图标）")
    }

    func testSubjectWireRoundtripPreservesIdentity() {
        let subject = PermissionSubject(
            binaryPath: "/a/b/GlassPane Daemon.app/Contents/MacOS/glasspaned",
            bundleIdentifier: "com.glasspane.daemon",
            bundlePath: "/a/b/GlassPane Daemon.app"
        )
        let restored = PermissionSubject.from(wireValue: subject.wireValue)
        XCTAssertEqual(restored, subject)
    }

    func testSubjectWireOmitsNilBundleFields() {
        let wire = PermissionSubject(binaryPath: "/x/glasspaned").wireValue
        XCTAssertNil(wire["bundleIdentifier"], "裸二进制的 bundle 字段必须省略而不是塞假值")
        XCTAssertNil(wire["bundlePath"])
        XCTAssertEqual(wire["hasBundleIdentity"] as? Bool, false)
    }

    func testSubjectFromWireRejectsMissingBinaryPath() {
        XCTAssertNil(PermissionSubject.from(wireValue: nil))
        XCTAssertNil(PermissionSubject.from(wireValue: ["bundleIdentifier": "com.glasspane.daemon"]))
    }

    // MARK: - §11.2 权限类别 CLI 取值（面板与 daemon 共用真源）

    func testPermissionKindCliValuesAreFrozen() {
        XCTAssertEqual(
            PermissionKind.allCases.map(\.cliValue),
            ["accessibility", "input-monitoring", "screen-recording", "developer-tools"]
        )
    }

    func testPermissionKindCliValueRoundtrip() {
        for kind in PermissionKind.allCases {
            XCTAssertEqual(PermissionKind.from(cliValue: kind.cliValue), kind)
        }
        XCTAssertNil(PermissionKind.from(cliValue: "unknown-kind"))
    }

    func testDaemonRequestCommandTargetsLaunchctlSubmitWithDaemonBinary() {
        let command = PermissionGuide.daemonRequestCommand(
            for: .screenRecording,
            daemonBinaryPath: "/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned",
            nonce: "1700-42"
        )
        XCTAssertEqual(command.launchPath, Launchctl.path)
        XCTAssertEqual(
            command.arguments,
            [
                "submit",
                "-l", "com.glasspane.guide.screen-recording.1700-42",
                "--", "/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned",
                "--request-permission", "screen-recording",
            ],
            "必须经 launchd 起一过性任务：面板直接 spawn 会让 TCC 判定继承面板 app"
        )
        XCTAssertEqual(command.jobLabel, "com.glasspane.guide.screen-recording.1700-42")
    }

    func testDaemonRequestLabelsAreUniquePerKindAndNonce() {
        let labels = Set(
            PermissionKind.allCases.flatMap { kind in
                [
                    PermissionGuide.daemonRequestCommand(for: kind, daemonBinaryPath: "/b", nonce: "n1").jobLabel,
                    PermissionGuide.daemonRequestCommand(for: kind, daemonBinaryPath: "/b", nonce: "n2").jobLabel,
                ]
            }
        )
        XCTAssertEqual(labels.count, PermissionKind.allCases.count * 2)
    }

    func testDaemonRequestCleanupUsesRemove() {
        let command = PermissionGuide.daemonRequestCleanupCommand(jobLabel: "com.glasspane.guide.accessibility.1-2")
        XCTAssertEqual(command.launchPath, Launchctl.path)
        XCTAssertEqual(command.arguments, ["remove", "com.glasspane.guide.accessibility.1-2"])
    }

    // MARK: - §11.3 拖拽源

    func testDragSourceUsesDaemonBundleWhenItHasBundleIdentity() {
        let subject = PermissionSubject(
            binaryPath: "/x/GlassPane Daemon.app/Contents/MacOS/glasspaned",
            bundleIdentifier: "com.glasspane.daemon",
            bundlePath: "/x/GlassPane Daemon.app"
        )
        XCTAssertEqual(
            PermissionGuide.dragSource(for: subject),
            .bundleURL("/x/GlassPane Daemon.app"),
            "daemon 有 bundle 身份时拖真身，系统设置才会显示带图标的可读条目"
        )
    }

    func testDragSourceFallsBackToPlainTextWithoutBundleIdentity() {
        XCTAssertEqual(
            PermissionGuide.dragSource(for: nil),
            .plainText("GlassPane"),
            "daemon 未上报身份时不得把设置面板自己的 app 当拖拽源"
        )
        XCTAssertEqual(
            PermissionGuide.dragSource(for: PermissionSubject(binaryPath: "/x/glasspaned")),
            .plainText("GlassPane")
        )
    }

    // MARK: - 引导文案的主体

    func testInstructionNamesTheDaemonSubject() {
        let bundled = PermissionGuide.instruction(for: .accessibility, subjectName: "GlassPane Daemon", hasBundleIdentity: true)
        XCTAssertTrue(bundled.contains("GlassPane Daemon"))
        XCTAssertFalse(bundled.contains("未打包"), "bundle 身份不该出现未打包告警")

        let bare = PermissionGuide.instruction(for: .screenRecording, subjectName: "glasspaned", hasBundleIdentity: false)
        XCTAssertTrue(bare.contains("glasspaned"))
        XCTAssertTrue(bare.contains("未打包"), "未打包形态必须告知条目只显示文件名")
        XCTAssertTrue(bare.contains("只显示文件名"))
    }

    func testDeveloperToolsInstructionStaysHonest() {
        let text = PermissionGuide.instruction(for: .developerTools, subjectName: "glasspaned", hasBundleIdentity: false)
        XCTAssertTrue(text.contains("不提供查询"), "开发者工具状态无查询接口这一事实必须告知用户")
        XCTAssertTrue(text.contains("未验证"), "卡片必须默认如实显示未验证")
    }

    // MARK: - §11.2 席位快照与线上往返

    private func fakeProbes(
        accessibilityTrusted: Bool = false,
        inputGranted: Bool = false,
        screenGranted: Bool = false
    ) -> (PermissionProbeSet, Recorder) {
        let recorder = Recorder()
        let set = PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(
                trustCheck: { accessibilityTrusted },
                prompt: { recorder.accessibilityPromptCalls += 1 },
                openPane: { recorder.accessibilityPaneCalls += 1 }
            ),
            inputMonitoring: InputMonitoringPermissionProbe(
                preflight: { inputGranted },
                requestAccess: { recorder.inputRequestCalls += 1 },
                openPane: { recorder.inputPaneCalls += 1 }
            ),
            screenRecording: ScreenCapturePermissionProbe(
                preflight: { screenGranted },
                requestAccess: { recorder.screenRequestCalls += 1 }
            ),
            developerTools: DeveloperToolsPermissionProbe(openPane: { recorder.developerToolsPaneCalls += 1 }),
            subjectProvider: {
                PermissionSubject(
                    binaryPath: "/x/GlassPane Daemon.app/Contents/MacOS/glasspaned",
                    bundleIdentifier: "com.glasspane.daemon",
                    bundlePath: "/x/GlassPane Daemon.app"
                )
            }
        )
        return (set, recorder)
    }

    final class Recorder {
        var accessibilityPromptCalls = 0
        var accessibilityPaneCalls = 0
        var inputRequestCalls = 0
        var inputPaneCalls = 0
        var screenRequestCalls = 0
        var developerToolsPaneCalls = 0
    }

    func testSnapshotCoversAllFourKindsWithProbeTruth() {
        let (set, _) = fakeProbes(accessibilityTrusted: true, inputGranted: false, screenGranted: true)
        let snapshot = set.snapshot()
        XCTAssertEqual(snapshot.status(for: .accessibility), .granted)
        XCTAssertEqual(snapshot.status(for: .inputMonitoring), .notDetermined)
        XCTAssertEqual(snapshot.status(for: .screenRecording), .granted)
        XCTAssertEqual(snapshot.status(for: .developerTools), .unverifiable)
        XCTAssertEqual(snapshot.subject.tccEntryName, "GlassPane Daemon")
    }

    func testSnapshotWireCoversAllKinds() {
        let (set, _) = fakeProbes(accessibilityTrusted: true, inputGranted: true, screenGranted: false)
        XCTAssertEqual(
            set.snapshot().permissionsWire,
            [
                "accessibility": "granted",
                "inputMonitoring": "granted",
                "screenRecording": "notDetermined",
                "developerTools": "unverifiable",
            ]
        )
    }

    func testStatusesFromWireIgnoresUnknownAndMalformed() {
        let statuses = DaemonPermissionSnapshot.statuses(from: [
            "accessibility": "granted",
            "screenRecording": "bogus",
            "someFutureKind": "granted",
            "inputMonitoring": 42,
        ])
        XCTAssertEqual(statuses, [.accessibility: .granted])
        XCTAssertTrue(DaemonPermissionSnapshot.statuses(from: nil).isEmpty)
    }

    func testRequestFiresPromptOnlyAndNeverPanelNavigation() {
        // 申请动作只唤起系统申请面；跳转面板由设置 GUI 负责（职责分离，且
        // daemon 侧不产生 `open` 副作用）。
        let (set, recorder) = fakeProbes()
        XCTAssertEqual(set.request(.accessibility), .notDetermined)
        XCTAssertEqual(recorder.accessibilityPromptCalls, 1)
        XCTAssertEqual(recorder.accessibilityPaneCalls, 0)

        XCTAssertEqual(set.request(.inputMonitoring), .denied, "请求后仍未授权 → 三态近似落到 denied")
        XCTAssertEqual(recorder.inputRequestCalls, 1)
        XCTAssertEqual(recorder.inputPaneCalls, 0)

        _ = set.request(.screenRecording)
        XCTAssertEqual(recorder.screenRequestCalls, 1)

        XCTAssertEqual(set.request(.developerTools), .unverifiable)
        XCTAssertEqual(recorder.developerToolsPaneCalls, 0, "开发者工具无申请接口，不伪造申请动作")
    }

    func testRequestIsNoOpWhenAlreadyGranted() {
        let (set, recorder) = fakeProbes(accessibilityTrusted: true, inputGranted: true, screenGranted: true)
        XCTAssertEqual(set.request(.accessibility), .granted)
        XCTAssertEqual(set.request(.inputMonitoring), .granted)
        XCTAssertEqual(set.request(.screenRecording), .granted)
        XCTAssertEqual(recorder.inputRequestCalls, 0, "已授权时不得重复弹申请")
        XCTAssertEqual(recorder.screenRequestCalls, 0)
    }

    // MARK: - §11.4 席位重探（区分"没授权"与"授权了没重启"）

    func testReprobeScriptCallsDaemonBinaryAndWritesJSON() {
        let script = PermissionReprobe.script(
            daemonBinaryPath: "/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned",
            outputPath: "/tmp/out.json"
        )
        XCTAssertTrue(script.contains("#!/bin/zsh"))
        XCTAssertTrue(script.contains("\"/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned\" --permissions"))
        XCTAssertTrue(script.contains("> \"/tmp/out.json\""), "带空格路径必须整体加引号")
    }

    func testReprobeSubmitCommandGoesThroughLaunchd() {
        let command = PermissionReprobe.submitCommand(scriptPath: "/tmp/gp.zsh", nonce: "42")
        XCTAssertEqual(command.launchPath, Launchctl.path)
        XCTAssertEqual(command.arguments, ["submit", "-l", "com.glasspane.reprobe.42", "--", "/tmp/gp.zsh"])
    }

    func testReprobeParseReadsSubjectAndStatuses() {
        let text = "{\"subject\":{\"binaryPath\":\"/x/GlassPane Daemon.app/Contents/MacOS/glasspaned\",\"bundleIdentifier\":\"com.glasspane.daemon\",\"bundlePath\":\"/x/GlassPane Daemon.app\",\"hasBundleIdentity\":true},\"permissions\":{\"accessibility\":\"granted\",\"inputMonitoring\":\"granted\",\"screenRecording\":\"notDetermined\"}}"
        let result = PermissionReprobe.parse(text)
        XCTAssertEqual(result?.subject.tccEntryName, "GlassPane Daemon")
        XCTAssertEqual(result?.statuses[.accessibility], .granted)
        XCTAssertNil(PermissionReprobe.parse("not json"))
        XCTAssertNil(PermissionReprobe.parse("{\"permissions\":{\"accessibility\":\"granted\"}}"), "缺 subject 不猜身份")
        XCTAssertNil(PermissionReprobe.parse("{\"subject\":{\"binaryPath\":\"/x\"}}"), "无席位数据 → nil")
    }

    func testKindsNeedingRestartIsolatesGrantedElsewhereButNotYetVisible() {
        let reprobed = PermissionReprobe.Result(
            subject: PermissionSubject(binaryPath: "/x/glasspaned"),
            statuses: [.accessibility: .granted, .inputMonitoring: .granted, .screenRecording: .notDetermined]
        )
        let running: [PermissionKind: PermissionStatus] = [
            .accessibility: .notDetermined,
            .inputMonitoring: .notDetermined,
            .screenRecording: .notDetermined,
            .developerTools: .unverifiable,
        ]
        XCTAssertEqual(
            PermissionReprobe.kindsNeedingRestart(running: running, reprobed: reprobed),
            [.accessibility, .inputMonitoring]
        )
        XCTAssertTrue(PermissionReprobe.kindsNeedingRestart(running: running, reprobed: nil).isEmpty,
                      "重探失败时不得假称待重启")
        let allGranted: [PermissionKind: PermissionStatus] = [.accessibility: .granted, .inputMonitoring: .granted]
        XCTAssertTrue(PermissionReprobe.kindsNeedingRestart(running: allGranted, reprobed: PermissionReprobe.Result(
            subject: PermissionSubject(binaryPath: "/x/glasspaned"), statuses: allGranted
        )).isEmpty)
    }

    func testRestartCommandIsKickstartForLaunchdJob() {
        let command = PermissionGuide.daemonRestartCommand(uid: 501)
        XCTAssertEqual(command.launchPath, Launchctl.path)
        XCTAssertEqual(command.arguments, ["kickstart", "-k", "gui/501/com.glasspane.daemon"])
    }

    func testRestartTextNamesThePendingPermissions() {
        let text = PermissionGuide.restartNeededText([.accessibility, .screenRecording])
        XCTAssertTrue(text.contains("辅助功能"))
        XCTAssertTrue(text.contains("屏幕录制"))
        XCTAssertTrue(text.contains("重启后台服务"))
    }

    func testSubjectInstructionDeclaresRestartSemantics() {
        // 真机实测：已运行的 daemon 读的是它启动时的 TCC 判定，因此三类权限的
        // 文案都必须声明"需重启生效"，不能承诺"开启后即变绿"。
        for kind in [PermissionKind.accessibility, .inputMonitoring, .screenRecording] {
            let text = PermissionGuide.instruction(for: kind, subjectName: "GlassPane Daemon", hasBundleIdentity: true)
            XCTAssertTrue(text.contains("重启后台服务"), "\(kind) 文案应声明重启才生效")
        }
    }

    // MARK: - 输入监控条目登记（申请 ≠ 列表出现条目）

    func testInputMonitoringRequestAlsoRegistersViaTapProbe() {
        var tapCalls = 0
        let set = PermissionProbeSet(
            inputMonitoring: InputMonitoringPermissionProbe(
                preflight: { false },
                requestAccess: { },
                openPane: { }
            ),
            inputTapProbe: { tapCalls += 1; return false },
            subjectProvider: { PermissionSubject(binaryPath: "/x/glasspaned") }
        )
        XCTAssertEqual(set.request(.inputMonitoring), .denied)
        XCTAssertEqual(tapCalls, 1, "必须尝试创建一次 tap，否则列表里不会出现该主体")
    }

    func testInputMonitoringTapProbeSkippedWhenAlreadyGranted() {
        var tapCalls = 0
        let set = PermissionProbeSet(
            inputMonitoring: InputMonitoringPermissionProbe(preflight: { true }, requestAccess: { }, openPane: { }),
            inputTapProbe: { tapCalls += 1; return true },
            subjectProvider: { PermissionSubject(binaryPath: "/x/glasspaned") }
        )
        XCTAssertEqual(set.request(.inputMonitoring), .granted)
        XCTAssertEqual(tapCalls, 0, "已授权时不再建 tap（避免无谓的会话级监听）")
    }

    // MARK: - remedy 与成因一致（错误码不动）

    func testTreeCaptureBudgetFailureRemedyIsNotPermissionAdvice() {
        let mapped = EngineCore.map(.treeCaptureFailed(reason: "tree capture exceeded the total 10.0s budget"))
        XCTAssertEqual(mapped.code, .axUnavailable, "码表冻结：错误码不变")
        XCTAssertTrue(mapped.remedy.contains("maxDepth"), "remedy 必须指向可执行的缩小范围动作")
        XCTAssertFalse(mapped.remedy.contains("--grant-accessibility"),
                       "通道存活时不得把用户支去重新授予辅助功能（幻影 remedy）")
        XCTAssertTrue(mapped.remedy.contains("--check-accessibility"), "给出自查手段而非盲动")
    }

    func testTreeCapturePermissionFailureFallsBackToDaemonScopedRemedy() {
        // R2-13 重钉（原断言"非预算类失败沿用授权引导"已失效且方向相反）：
        // `--grant-accessibility` 申请的是调用方的席位、阻塞 300s 还打印假成功，
        // 现在只允许出现在 GP_E_AX_UNAVAILABLE remedy 的显式禁令句里。代码此刻
        // 刻意的行为是：非预算成因回落冻结 remedy 表（daemon 自己的可执行路径
        // --restore-launchd / kickstart / --request-permission），不是私有副本。
        let mapped = EngineCore.map(.treeCaptureFailed(reason: "AX element is disabled: api disabled"))
        XCTAssertEqual(mapped.code, .axUnavailable, "码表冻结：错误码不变")
        XCTAssertEqual(mapped.remedy, GPError.remedy(for: .axUnavailable),
                       "非预算成因 = remedy 表默认文案，逐字一致（不得另抄一份漂移）")
        XCTAssertTrue(mapped.remedy.contains("--restore-launchd"),
                      "回落文案必须指向作用在 daemon 身份上的路径，而不是调用方")
        let lowered = mapped.remedy.lowercased()
        if let at = lowered.range(of: "--grant-accessibility") {
            XCTAssertTrue(lowered[lowered.startIndex..<at.lowerBound].contains("do not"),
                          "--grant-accessibility 只许出现在否定语里（幻影 remedy 禁令）")
        }
    }

    func testPixelCaptureDeniedRemedyPointsAtScreenRecording() {
        let mapped = EngineCore.map(.pixelCaptureDenied(reason: "no window on screen"))
        XCTAssertTrue(mapped.remedy.contains("Screen Recording"))
        XCTAssertTrue(mapped.remedy.contains("--check-screen-permission"))
        // 原来这里钉的是"remedy 必须解释 pixelDiff 会降级成 INCONCLUSIVE"。那是默认文案，
        // 而全仓唯一把像素拒绝抛成错误的调用方是 `capture_view`——它没有 pixelDiff 可降级。
        // gp_verify 的降级形态由证据包（熔断标签）与 `Classifier.pixelAbsentNextStep` 说，
        // 不由这条错误路径说。默认文案于是成了：给一个不存在的通路作承诺。
        XCTAssertFalse(mapped.remedy.contains("pixelDiff"),
                       "没有调用方补话时不许替它声明降级形态：\(mapped.remedy)")
        let verifyShaped = EngineCore.map(
            .pixelCaptureDenied(reason: "no window on screen"),
            degradation: "pixelDiff stays null and T6 is INCONCLUSIVE"
        )
        XCTAssertTrue(verifyShaped.remedy.contains("INCONCLUSIVE"),
                      "由真正拥有 pixelDiff 的调用方补话时，这句话必须原样出现在 remedy 里")
    }

    // MARK: - §11.7 面板渲染的机器核验面（identifier 真源）

    func testStatusIdentifiersAreStableAndUnique() {
        var seen = Set<String>()
        for kind in PermissionKind.allCases {
            for status in PermissionStatus.allCases {
                let id = PermissionGuide.statusIdentifier(kind: kind, status: status)
                XCTAssertTrue(id.hasPrefix("gp-perm-\(kind.cliValue)-"), id)
                XCTAssertTrue(id.hasSuffix("-\(status.rawValue)"), id)
                XCTAssertTrue(seen.insert(id).inserted, "标识必须逐卡逐态唯一: \(id)")
            }
        }
        XCTAssertEqual(
            PermissionGuide.statusIdentifier(kind: .inputMonitoring, status: .granted),
            "gp-perm-input-monitoring-granted"
        )
        XCTAssertEqual(
            PermissionGuide.restartPendingIdentifier(kind: .accessibility),
            "gp-perm-accessibility-restart-pending"
        )
    }

    func testStatusIconsAreDistinctPerStatus() {
        let icons = Set(PermissionStatus.allCases.map { PermissionGuide.statusIcon(for: $0) })
        XCTAssertEqual(icons.count, PermissionStatus.allCases.count, "四种状态各自的形状不得相同")
    }

    // MARK: - §11.5 开发者工具席位的机器探测呈现

    private let capabilityJSON = """
        {"capability":"developer-tools-debug","launch":{"state":"ok"},"attach":{"state":"spawnFailed"},
         "granted":true,"note":"..."}
        """

    func testCapabilityReportMapsThreeStates() {
        let at = Date(timeIntervalSince1970: 1_700_000_000)
        let report = DeveloperToolsCapability.parse(capabilityJSON, observedAt: at)
        XCTAssertEqual(report?.status, .granted, "任一侧 ok 即 granted（与 P6 Snapshot.granted 同口径）")
        XCTAssertEqual(report?.launch, "ok")
        XCTAssertEqual(report?.attach, "spawnFailed")

        let denied = DeveloperToolsCapability.Report(launch: "denied", attach: "denied", granted: false, observedAt: at)
        XCTAssertEqual(denied.status, .denied)

        let unknown = DeveloperToolsCapability.Report(launch: "timeout", attach: "spawnFailed", granted: false, observedAt: at)
        XCTAssertEqual(unknown.status, .unverifiable, "未知失败绝不折算成权限结论（P6 口径）")
    }

    func testCapabilityParseRejectsForeignShapes() {
        let at = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertNil(DeveloperToolsCapability.parse("not json", observedAt: at))
        XCTAssertNil(DeveloperToolsCapability.parse(
            "{\"permissions\":{\"accessibility\":\"granted\"}}", observedAt: at), "席位 JSON 不得被当能力 JSON")
        XCTAssertNil(DeveloperToolsCapability.parse(
            "{\"capability\":\"developer-tools-debug\",\"launch\":{\"state\":\"ok\"}}", observedAt: at),
            "缺 attach/granted 不猜")
    }

    func testCapabilitySummaryNeverClaimsRealtime() {
        let report = DeveloperToolsCapability.Report(
            launch: "ok", attach: "denied", granted: true, observedAt: Date(timeIntervalSince1970: 1_700_000_000))
        let text = report.summaryText()
        XCTAssertTrue(text.contains("一次性验证结果"), "必须声明这是带时刻的一次验证")
        XCTAssertTrue(text.contains("启动调试器 成功"))
        XCTAssertTrue(text.contains("附加进程 被系统拒绝"))
    }

    func testReprobeScriptCarriesDeveloperToolsArguments() {
        let script = PermissionReprobe.script(
            daemonBinaryPath: "/x/GlassPane Daemon.app/Contents/MacOS/glasspaned",
            outputPath: "/tmp/out.json",
            arguments: PermissionReprobe.developerToolsArguments
        )
        XCTAssertTrue(script.contains("--check-developer-tools"), "能力探测走 P6 的 CLI，不在面板进程里跑 lldb")
        XCTAssertFalse(script.contains("--permissions"), "参数被替换而非追加，避免一次任务跑两件事")
        // 默认参数仍是席位快照（回归保护）。
        XCTAssertTrue(PermissionReprobe.script(daemonBinaryPath: "/x/glasspaned", outputPath: "/tmp/o.json")
            .contains("--permissions"))
    }

    func testDeveloperToolsInstructionOffersMachineVerification() {
        let text = PermissionGuide.instruction(
            for: .developerTools, subjectName: "GlassPane Daemon", hasBundleIdentity: true)
        XCTAssertTrue(text.contains("验证调试能力"))
        XCTAssertFalse(text.contains("无系统总开关"), "旧断言已按真机核对废止")
    }

    // MARK: - DaemonProbe 解析增量字段（向后兼容）

    private func helloJSON(_ result: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: ["id": 0, "result": result])
    }

    func testParseHelloReadsSubjectAndPermissions() {
        let data = helloJSON([
            "engine": "glasspaned",
            "version": "0.1.0",
            "protocolVersion": "0",
            "pid": 42,
            "identity": [
                "binaryPath": "/x/GlassPane Daemon.app/Contents/MacOS/glasspaned",
                "bundleIdentifier": "com.glasspane.daemon",
                "bundlePath": "/x/GlassPane Daemon.app",
                "hasBundleIdentity": true,
            ],
            "permissions": ["accessibility": "granted", "screenRecording": "denied"],
        ])
        let summary = DaemonProbe.parseHelloResponse(data)
        XCTAssertEqual(summary?.subject?.tccEntryName, "GlassPane Daemon")
        XCTAssertEqual(summary?.permissions, [.accessibility: .granted, .screenRecording: .denied])
    }

    func testParseHelloStaysCompatibleWithOldDaemon() {
        let data = helloJSON([
            "engine": "glasspaned",
            "version": "0.1.0",
            "protocolVersion": "0",
            "pid": 42,
        ])
        let summary = DaemonProbe.parseHelloResponse(data)
        XCTAssertNil(summary?.subject, "旧 daemon 不上报身份 → nil，面板据此显示未验证")
        XCTAssertTrue(summary?.permissions.isEmpty ?? false)
    }

    // MARK: - EngineCore.hello 自报席位

    func testHelloCarriesIdentityAndPermissionsWhenInjected() {
        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            settle: {},
            permissionsReport: {
                DaemonPermissionSnapshot(
                    subject: PermissionSubject(
                        binaryPath: "/x/GlassPane Daemon.app/Contents/MacOS/glasspaned",
                        bundleIdentifier: "com.glasspane.daemon",
                        bundlePath: "/x/GlassPane Daemon.app"
                    ),
                    statuses: [.accessibility: .granted, .inputMonitoring: .notDetermined]
                )
            }
        )
        let payload = core.hello()
        XCTAssertEqual((payload["permissions"] as? [String: String])?["accessibility"], "granted")
        XCTAssertEqual((payload["identity"] as? [String: Any])?["bundleIdentifier"] as? String, "com.glasspane.daemon")
        // 既有字段不回归。
        XCTAssertEqual(payload["engine"] as? String, "glasspaned")
        XCTAssertEqual(payload["version"] as? String, core.version)
    }

    func testHelloOmitsPermissionFieldsWithoutReportHook() {
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard), settle: {})
        let payload = core.hello()
        XCTAssertNil(payload["permissions"])
        XCTAssertNil(payload["identity"])
    }
    func testControlIdentifiersLetAutomationPressButtons() {
        XCTAssertEqual(PermissionGuide.guideIdentifier(for: .accessibility), "gp-guide-accessibility")
        XCTAssertEqual(PermissionGuide.guideIdentifier(for: .inputMonitoring), "gp-guide-input-monitoring")
        XCTAssertEqual(Set(PermissionKind.allCases.map { PermissionGuide.guideIdentifier(for: $0) }).count,
                     PermissionKind.allCases.count, "每张卡的控件标识必须互不相同")
        XCTAssertEqual(PermissionGuide.verifyCapabilityIdentifier, "gp-verify-developer-tools")
        XCTAssertEqual(PermissionGuide.restartDaemonIdentifier, "gp-restart-daemon")
        XCTAssertEqual(PermissionGuide.refreshIdentifier, "gp-refresh")
    }

    func testCapabilityMarkersNeverImpersonateEachOther() {
        XCTAssertEqual(PermissionGuide.capabilityIdentifier(.pending), "gp-devtools-pending")
        XCTAssertEqual(PermissionGuide.capabilityIdentifier(.failed(.spawnFailed)), "gp-devtools-failed-spawn")
        XCTAssertEqual(PermissionGuide.capabilityIdentifier(.concluded(.granted)), "gp-devtools-granted")
        var distinct = Set([
            PermissionGuide.capabilityIdentifier(.pending),
            PermissionGuide.capabilityIdentifier(.concluded(.granted)),
            PermissionGuide.capabilityIdentifier(.concluded(.denied)),
            PermissionGuide.capabilityIdentifier(.concluded(.unverifiable)),
        ])
        for failure in CapabilityFailure.allCases {
            distinct.insert(PermissionGuide.capabilityIdentifier(.failed(failure)))
            XCTAssertTrue(failure.fallbackText.contains("未验证"), "失败说明必须落回不伪造状态")
        }
        XCTAssertEqual(distinct.count, 8, "在途/四类失败/四类结论共 8 个标识，不得有任何两个互相冒充")
    }

    func testLaunchctlPathResolvesToRealBinary() {
        // 面板全部 launchd 动作共享同一条已验证存在的路径（/usr/bin 假路径曾致
        // 静默全失败——此测试把"不许硬编码猜路径"钉死）。
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: Launchctl.path))
        let req = PermissionGuide.daemonRequestCommand(for: .accessibility, daemonBinaryPath: "/tmp/x", nonce: "n")
        XCTAssertEqual(req.launchPath, Launchctl.path)
        let cleanup = PermissionGuide.daemonRequestCleanupCommand(jobLabel: req.jobLabel)
        XCTAssertEqual(cleanup.launchPath, Launchctl.path)
        let restart = PermissionGuide.daemonRestartCommand(uid: 501)
        XCTAssertEqual(restart.launchPath, Launchctl.path)
    }

    // MARK: - 共用证据档案构造（R2-13 文本闸 / R5-04 隔离面）

    private func makeMinimalPack() -> EvidencePack {
        let selector = Selector(role: "AXButton", title: "Submit")
        return EvidencePack(
            operationId: "op_0123456789ABCDEFGHJKMNPQRS",
            createdAt: "2026-09-14T12:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .channelFault),
            signals: Signals(
                act: ActSignal(selector: selector, action: .press, actConfirmed: true),
                axEvent: AxEventSignal(
                    treeDigestBefore: "aa", treeDigestAfter: "bb",
                    nodeCount: 10, axChanged: true, latencyMs: 5
                ),
                pixelDiff: PixelDiffSignal(
                    changedPixelRatio: 0.1,
                    bounds: Bounds(x: 1, y: 1, width: 2, height: 2),
                    windowId: 12
                ),
                crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
            )
        )
    }

    func testClassifierT0GuidanceNamesDaemonScopedCommands() {
        // R2-13 的另一半：T0 的 next: 会进 agent 可见的诊断报告。旧文案指去
        // `glasspaned --grant-accessibility`——那条申请的是**调用方**的席位，正是
        // remedy 表现今显式禁止的幻影 remedy。这里钉住新文案只用已验证的、作用在
        // daemon 身份上的命令，且 --grant-accessibility 只许死在禁令句里。
        let (diagnosisClass, report) = Classifier.classify(makeMinimalPack())
        XCTAssertEqual(diagnosisClass, .t0)
        XCTAssertTrue(report.next.contains("--restore-launchd"),
                      "T0 指引必须给出 node installer/cli.js --restore-launchd 这条已验证路径")
        XCTAssertTrue(report.next.contains("--request-permission accessibility"),
                      "daemon 无 TCC 条目时的登记命令也必须出现（经 launchctl submit 跑 daemon 二进制）")
        let lowered = report.next.lowercased()
        guard let at = lowered.range(of: "--grant-accessibility") else {
            return XCTFail("禁令句不见了：文案必须显式劝阻 --grant-accessibility，否则读者会以为它仍然可用")
        }
        XCTAssertTrue(lowered[lowered.startIndex..<at.lowerBound].contains("never"),
                      "--grant-accessibility 只许出现在 Never/Do NOT 的否定语里")
    }

    // MARK: - R5-04 证据档案目录的 0700 隔离（SocketServer 同口径）

    /// These three cases are about the *mode* an archive ends up with, not about
    /// which directory it lives in, so they take sandbox paths like every other
    /// state in this suite. The older shape composed a unique folder under
    /// `NSHomeDirectory` and deleted it afterwards: writing and `removeItem`-ing
    /// a home-relative tree is exactly what the isolation gate exists to stop,
    /// and "the name I picked will not collide" is not isolation. The outside-home
    /// premise has its own case (`testStoreOutsideHomeIsStillIsolated`).
    private func archivePathUnderTest(_ tag: String) -> String {
        TestSandbox.pendingDirectory("r504-" + tag)
    }

    private func posixMode(of path: String) -> Int {
        let attributes = (try? FileManager.default.attributesOfItem(atPath: path)) ?? [:]
        return ((attributes[.posixPermissions] as? NSNumber)?.int16Value).map(Int.init) ?? -1
    }

    func testFreshArchiveIsCreatedPrivateBeforeFirstPack() throws {
        let dir = archivePathUnderTest("fresh")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = EvidenceStore(directory: dir, log: EngineLog(quiet: true))
        XCTAssertTrue(store.write(makeMinimalPack()), "隔离可建立时不得挡写入")
        XCTAssertEqual(posixMode(of: dir), 0o700, "R5-04：第一份档案落地前档案目录必须私有")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir + "/op_0123456789ABCDEFGHJKMNPQRS.json"))
    }

    func testPreexistingWorldReadableArchiveIsTightenedThenWritten() throws {
        // R5-04 的真实形态：~/.glasspane 由 mcp-shell 以默认模式先建，而
        // createDirectory(attributes:) 对**已存在**目录是 no-op——修复只剩
        // chmod-after-create 这一条路，此测试把这条路径与"没修"区分开。
        let dir = archivePathUnderTest("tighten")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        chmod(dir, 0o755)
        XCTAssertEqual(posixMode(of: dir), 0o755, "前置条件：已存在的共享档案目录")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = EvidenceStore(directory: dir, log: EngineLog(quiet: true))
        XCTAssertTrue(store.write(makeMinimalPack()))
        XCTAssertEqual(posixMode(of: dir), 0o700, "写入完成前隔离已被拉回 0700")
    }

    func testUnprotectableArchivePathRefusesWriteWithoutTouchingExistingData() throws {
        // 权限建立不起来时的失败形态：拒绝写入（write 返回 false，EngineCore 侧
        // 现成地呈现为 degraded + "make the evidence directory writable" remedy），
        // 既不静默继续世界可读地写，也不删掉重来。
        let planted = archivePathUnderTest("planted")
        FileManager.default.createFile(atPath: planted, contents: Data("precious".utf8))
        defer { try? FileManager.default.removeItem(atPath: planted) }
        let store = EvidenceStore(directory: planted, log: EngineLog(quiet: true))
        XCTAssertFalse(store.write(makeMinimalPack()), "档案路径不是目录时必须拒写")
        XCTAssertEqual(try? String(contentsOfFile: planted, encoding: .utf8), "precious",
                       "拒写不得销毁既有数据")
    }

    // MARK: - A-18 probe.sock 抢占判定（bind → 三态判定 → 只清无主名字）

    private func makeProbeTestPath(_ tag: String) throws -> String {
        // `sockaddr_un.sun_path` is 104 bytes, so the bound name has to stay
        // short. Asserted rather than assumed: the path now comes from the
        // process-scoped sandbox root, and a root that grows would otherwise
        // show up as a bind failure that reads like a defect in the guard under
        // test.
        let dir = TestSandbox.pendingDirectory("a18" + tag)
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = dir + "/probe.sock"
        XCTAssertLessThan(path.utf8.count, 104, "socket path exceeds sun_path: \(path)")
        return path
    }

    /// 一个占住名字的裸监听 fd：模拟先起 daemon 的 probe.sock（按协议它永不在
    /// hello 之前回话，所以真实护栏对它用 waitForHello: false）。
    private func makeStubListener(at path: String) -> Int32? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let copied = path.withCString { source -> Bool in
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                guard let base = destination.baseAddress else { return false }
                _ = strncpy(base.assumingMemoryBound(to: CChar.self), source, destination.count)
                return true
            }
        }
        guard copied else { close(fd); return nil }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                Darwin.bind(fd, rebound, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(fd, 4) == 0 else { close(fd); unlink(path); return nil }
        return fd
    }

    func testProbeStartRefusesToStealNameFromLiveListener() throws {
        let path = try makeProbeTestPath("refuse")
        let listenerDir = (path as NSString).deletingLastPathComponent
        defer { unlink(path); try? FileManager.default.removeItem(atPath: listenerDir) }
        let stubFD = try XCTUnwrap(makeStubListener(at: path))
        defer { close(stubFD) }
        let server = ProbeSocketServer(
            socketPath: path, inbox: ProbeInbox(), log: EngineLog(quiet: true),
            livenessProbe: { _ in .presentButNotAnswering(reason: "listener accepted the connection") }
        )
        XCTAssertThrowsError(try server.start()) { error in
            guard case ProbeServerError.nameOccupied(let detail) = error else {
                return XCTFail("被占的名字必须报 nameOccupied（main.swift 据此 Z5-only 降级），实得 \(error)")
            }
            XCTAssertTrue(detail.contains("listener accepted"), "拒绝理由必须带上测到的占名者")
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: path),
                      "有主的名字不许被 unlink——这正是 A-18 脑裂的成因")
    }

    func testProbeStartClearsDemonstrablyUnownedName() throws {
        // 残留：名字处是个普通文件（bind 必 EADDRINUSE）。判定为 noListener 时必须
        // 清掉残留并成功 bind——A-18 里合法的另一半：无主的名字本来就该清。
        // connect 对普通文件的 errno 有平台歧义（ECONNREFUSED/ENOTSOCK 之外的
        // 分类风险），所以判定注入而非真探；真探侧的三态本身已由
        // HumanInterventionAuditTests 钉住。
        let path = try makeProbeTestPath("stale")
        let listenerDir = (path as NSString).deletingLastPathComponent
        defer { try? FileManager.default.removeItem(atPath: listenerDir) }
        FileManager.default.createFile(atPath: path, contents: Data())
        let server = ProbeSocketServer(
            socketPath: path, inbox: ProbeInbox(), log: EngineLog(quiet: true),
            livenessProbe: { _ in .noListener(reason: "connect: connection refused") }
        )
        XCTAssertNoThrow(try server.start())
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "重绑后名字归新监听者")
        server.stop()
    }

    func testProbeForceFlagPreemptsWithoutConsultingTheProbe() throws {
        let path = try makeProbeTestPath("force")
        let listenerDir = (path as NSString).deletingLastPathComponent
        defer { try? FileManager.default.removeItem(atPath: listenerDir) }
        let stubFD = try XCTUnwrap(makeStubListener(at: path))
        defer { close(stubFD) }
        var probeWasConsulted = false
        let server = ProbeSocketServer(
            socketPath: path, inbox: ProbeInbox(), log: EngineLog(quiet: true),
            preemptsExistingSocket: true,
            livenessProbe: { _ in
                probeWasConsulted = true
                return .presentButNotAnswering(reason: "must not be reached")
            }
        )
        XCTAssertNoThrow(try server.start(), "--force-probe-socket 就是显式抢占，先赢先用")
        XCTAssertFalse(probeWasConsulted, "force 路径直接 unlink+bind，不做抢占判定（同 SocketServer）")
        server.stop()
    }
}