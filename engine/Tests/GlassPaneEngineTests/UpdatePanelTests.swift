import XCTest
@testable import glasspane_settings

/// 「更新」页判定层的验收（自动更新规格 §4 用户可见面、§5 默认开一键关、
/// §7 那一行 JSON 与退出码、§9.3 面板 spawn 带上本机那份根证书束、
/// §9.7 那份束的五个态与"从没导出过"各有一句说法）。
///
/// 每条测试都写明**什么改动会把它变红**：抓不住反向改动的断言等于没写。
/// 需要"活的更新器"的地方用的是一个照契约回一行的脚本夹具，
/// 不依赖更新器内部的任何模块。
final class UpdatePanelTests: XCTestCase {

    /// 契约里的封闭枚举（`updater/lib/codes.js` 的 `STATUSES`，按同一顺序）。
    /// 这份清单是**测试侧抄的**：更新器增删成员而面板没接住时必须变红。
    private static let contractStatuses = [
        "up-to-date", "available", "staged", "applied", "deferred", "needs-consent",
        "check-overdue", "rolled-back", "check-failed", "staged-build-failed",
        "apply-failed", "rollback-failed", "disabled", "installer-pointer-stale",
    ]

    private let now = Date(timeIntervalSince1970: 1_800_000_000)  // 2027-01-15 08:00:00Z

    private func iso(_ offsetSeconds: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: now.addingTimeInterval(offsetSeconds))
    }

    /// 64 位十六进制的暂存校验和（面板原样显示它，供人与发布页核对）。
    private let digest = String(repeating: "0a1b2c3d4e5f6071", count: 4)

    /// 状态文件里 `caRoots.status` 的封闭取值（同样是**测试侧抄的**：
    /// `updater/lib/ca-bundle.js` 增删成员而面板没接住时必须变红）。
    private static let contractCaStatuses = ["ok", "empty", "unavailable", "write-unverified", "probe-failed"]

    /// 状态文件里 `runtime.status` 的封闭取值（**测试侧抄的**：`updater/lib/runtime.js`
    /// 的 `RUNTIME_STATUSES` 增删成员而面板没接住时必须变红）。
    private static let contractRuntimeStatuses = ["refreshed", "failed", "kept", "skipped"]

    /// 更新器自己那份副本的落地位置，与换版之前那一份（面板只显示记录里真的写了的）。
    private static let runtimeCli = "/Users/x/.glasspane/runtime/1.5.2/updater/cli.js"
    private static let previousRuntimeCli = "/Users/x/GlassPane/updater/cli.js"

    /// 一张证书的形状就够了：面板数的是 `-----BEGIN CERTIFICATE-----` 的出现次数。
    private let pemBundle = """
    -----BEGIN CERTIFICATE-----
    MIIC T H I S I S A N O N C E R T I F I C A T E F O R A T E S T
    -----END CERTIFICATE-----
    """

    // MARK: - 封闭枚举

    /// 反向变异：往 `UpdatePanel.Status` 里塞一个更新器不会发的成员，或把认不出的
    /// 状态"就近映射"到某个成员上（猜错状态的按钮会替用户点掉一次换版）。
    func testClosedStatusEnumMatchesTheContract() {
        XCTAssertEqual(UpdatePanel.Status.allCases.map { $0.rawValue }, Self.contractStatuses)
        for raw in Self.contractStatuses {
            XCTAssertNotNil(UpdatePanel.Status.parse(raw), "\(raw) 必须认得")
            XCTAssertFalse(UpdatePanel.Status.parse(raw)!.caption.isEmpty)
        }
        XCTAssertNil(UpdatePanel.Status.parse("staged-ish"), "认不出的状态只能算读不到")
        XCTAssertNil(UpdatePanel.Status.parse(nil))
        XCTAssertNil(UpdatePanel.Status.parse(""))
    }

    // MARK: - 按钮开关

    /// 反向变异：**无条件放开「安装更新」**（`applyEnabled = true`）——于是
    /// "已是最新""检查已过期""上次没能准备好版本"这三种手上没东西可装的状态下
    /// 按钮都能按，用户按下只拿到一句"什么都没暂存"。
    func testApplyButtonOpensOnlyForStagedOrJustFound() {
        let mustOpen: Set<UpdatePanel.Status> = [.available, .staged]
        for status in UpdatePanel.Status.allCases {
            let buttons = UpdatePanel.buttons(for: .reading(status, staged: false))
            XCTAssertEqual(
                buttons.applyEnabled, mustOpen.contains(status),
                "「安装更新」在 \(status.rawValue)（手上没有已校验的暂存版本）下的开关不对"
            )
        }
    }

    /// 反向变异：**「立即检查」跟着状态一起灰掉**（比如"自动更新已关闭"就把检查
    /// 也禁了）——手动通道本该不受自动开关约束，用户就再也问不到东西了。
    /// 唯一让「立即检查」按不动的原因是找不到更新器本身，那是另外一条测试。
    func testCheckButtonIsAlwaysReachableWhenTheUpdaterIs() {
        for status in UpdatePanel.Status.allCases where status != .installerPointerStale {
            let buttons = UpdatePanel.buttons(for: .reading(status, staged: false))
            XCTAssertTrue(buttons.checkEnabled, "「立即检查」不得在 \(status.rawValue) 下被禁掉")
            XCTAssertTrue(buttons.toggleEnabled, "「自动更新」开关不得在 \(status.rawValue) 下被禁掉")
        }
    }

    /// 反向变异：**删掉禁用理由，只留一个灰按钮**（规格 §4 明确"不可用是带原因
    /// 的禁用，不是隐藏"；没有理由的灰按钮在用户眼里就是界面坏了）。
    func testEveryDisabledControlCarriesAVisibleReason() {
        for status in UpdatePanel.Status.allCases {
            for staged in [false, true] {
                let buttons = UpdatePanel.buttons(for: .reading(status, staged: staged))
                assertReason(buttons.applyReason, enabled: buttons.applyEnabled,
                             "\(status.rawValue)/staged=\(staged)/安装更新")
                assertReason(buttons.checkReason, enabled: buttons.checkEnabled,
                             "\(status.rawValue)/staged=\(staged)/立即检查")
                assertReason(buttons.toggleReason, enabled: buttons.toggleEnabled,
                             "\(status.rawValue)/staged=\(staged)/自动更新")
            }
        }
        let blocked = UpdatePanel.buttons(for: .reading(.staged, running: true))
        assertReason(blocked.applyReason, enabled: blocked.applyEnabled, "在途/安装更新")
        let stale = UpdatePanel.buttons(for: .reading(.staged, pointerReady: false))
        assertReason(stale.checkReason, enabled: stale.checkEnabled, "找不到更新器/立即检查")
    }

    private func assertReason(_ reason: String?, enabled: Bool, _ label: String) {
        if enabled {
            XCTAssertNil(reason, "\(label) 可用时不该带理由")
            return
        }
        guard let reason else { return XCTFail("\(label) 不可用却没有理由") }
        XCTAssertFalse(reason.trimmingCharacters(in: .whitespaces).isEmpty, "\(label) 的理由是空的")
    }

    /// 反向变异：**只要上次失败就一律禁掉「安装更新」**（手上明明还有一份校验过的
    /// 版本，"后台服务当时在忙"本该能再按一次），或反过来一律放开。
    func testStagedOfferDecidesTheRetryShapedStatuses() {
        for status in [UpdatePanel.Status.deferred, .rolledBack, .checkFailed, .disabled] {
            XCTAssertTrue(
                UpdatePanel.buttons(for: .reading(status, staged: true)).applyEnabled,
                "\(status.rawValue) 且已有一份暂存版本时必须让人能再按一次"
            )
            XCTAssertFalse(
                UpdatePanel.buttons(for: .reading(status, staged: false)).applyEnabled,
                "\(status.rawValue) 且没有暂存版本时不能按"
            )
        }
        // 这几个状态下"再按一次安装"没有意义，暂存在与不在都一样。
        for status in [UpdatePanel.Status.upToDate, .applied, .checkOverdue, .stagedBuildFailed, .rollbackFailed] {
            XCTAssertFalse(
                UpdatePanel.buttons(for: .reading(status, staged: true)).applyEnabled,
                "\(status.rawValue) 不该放开「安装更新」"
            )
        }
    }

    /// 反向变异：**把退出码 5 当成"还能再按一次"**（规格 §7：换版失败且自动退回
    /// 也没成时必须由人来处理，再按一次是拿一台状态不明的机器赌）。
    func testExitFiveAndRollbackFailureDemandAPerson() {
        let manual = UpdatePanel.buttons(for: .reading(.applyFailed, staged: true, exitCode: 5))
        XCTAssertFalse(manual.applyEnabled)
        XCTAssertTrue(manual.applyReason!.contains("人工"), "理由要说清这一步得人来：\(manual.applyReason ?? "")")
        XCTAssertTrue(manual.checkEnabled, "读状态的手续没坏，「立即检查」仍可用")

        let retried = UpdatePanel.buttons(for: .reading(.applyFailed, staged: true, exitCode: 3))
        XCTAssertTrue(retried.applyEnabled, "现场已核对退回原版本时允许再按一次")

        for exitCode in [nil, 0, 3, 4, 5] {
            XCTAssertFalse(
                UpdatePanel.buttons(for: .reading(.rollbackFailed, staged: true, exitCode: exitCode)).applyEnabled,
                "rollback-failed 在任何退出码下都不能再按「安装更新」"
            )
        }
    }

    /// 反向变异：**给每一次 apply 都附上 `--consent major`**（等于面板替用户把所有
    /// 跨大版本的确认都预先签掉），或反过来跨大版本也不附、按钮按下只再吃一次拒绝。
    func testMajorConsentTravelsOnlyWithTheButtonPressThatGrantsIt() {
        let major = UpdatePanel.buttons(for: .reading(
            .needsConsent, staged: true, current: "1.4.0", stagedVersion: "2.0.0"
        ))
        XCTAssertTrue(major.applyEnabled, "跨大版本要的就是人按这一下")
        XCTAssertEqual(major.applyArguments, ["--consent", "major"])

        let minor = UpdatePanel.buttons(for: .reading(
            .needsConsent, staged: true, current: "1.4.0", stagedVersion: "1.5.0"
        ))
        XCTAssertFalse(minor.applyEnabled, "不是跨大版本的那种确认（比如后台服务写的是别人的状态根）不由面板代签")
        XCTAssertEqual(minor.applyArguments, [])

        XCTAssertEqual(
            UpdatePanel.buttons(for: .reading(.needsConsent, staged: true)).applyArguments, [],
            "读不出版本时不要附带确认参数"
        )
        XCTAssertTrue(UpdatePanel.isMajorBump(current: "1.9.9", candidate: "2.0.0"))
        XCTAssertFalse(UpdatePanel.isMajorBump(current: "1.9.9", candidate: "1.10.0"))
        XCTAssertFalse(UpdatePanel.isMajorBump(current: nil, candidate: "2.0.0"))
    }

    /// 反向变异：**去掉在途闸门**（两次「立即检查」叠着跑，后一轮会踩掉前一轮的
    /// 暂存目录与状态文件）。
    func testInFlightRunBlocksEveryControl() {
        let buttons = UpdatePanel.buttons(for: .reading(.staged, staged: true, running: true))
        XCTAssertFalse(buttons.checkEnabled)
        XCTAssertFalse(buttons.applyEnabled)
        XCTAssertFalse(buttons.toggleEnabled)
        XCTAssertEqual(buttons.checkReason, UpdatePanel.runningText)
        XCTAssertEqual(buttons.applyReason, UpdatePanel.runningText)
        XCTAssertEqual(buttons.toggleReason, UpdatePanel.runningText)
    }

    /// 反向变异：**没找到更新器也照样显示两个能点的按钮**（按下只会静默失败，
    /// 而规格 §7 要的是 `installer-pointer-stale` 连同那句重装指引）。
    func testPointerNotReadyDisablesBothButtons() {
        let statuses: [UpdatePanel.Status?] = UpdatePanel.Status.allCases + [nil]
        for status in statuses {
            let buttons = UpdatePanel.buttons(for: .reading(status, pointerReady: false))
            XCTAssertFalse(buttons.checkEnabled, "\(String(describing: status))：找不到更新器时不能给一个按了没反应的按钮")
            XCTAssertFalse(buttons.applyEnabled)
            XCTAssertFalse(buttons.toggleEnabled)
            XCTAssertTrue(buttons.checkReason!.contains("重新"), "要给出重装这句话：\(buttons.checkReason ?? "")")
        }
        // 状态自己报出指针失效时，即使指针看着可用也要禁掉（两处口径不能打架）。
        let reported = UpdatePanel.buttons(for: .reading(.installerPointerStale, staged: true))
        XCTAssertFalse(reported.applyEnabled)
        XCTAssertFalse(reported.checkEnabled)
        XCTAssertTrue(reported.applyReason!.contains("installer-pointer-stale"))
    }

    // MARK: - 过期判定（"到点时电脑是关的"）

    /// 反向变异：**把 36 小时阈值改成 ∞**（这一页就永远不说"过期了"，而对关机
    /// 错过的那一次定时任务正是它唯一的兜底）。
    func testCheckOverdueAfterThirtySixHoursAsksForAction() {
        XCTAssertTrue(UpdatePanel.isCheckOverdue(lastCheckAt: iso(-37 * 3600), now: now))
        XCTAssertFalse(UpdatePanel.isCheckOverdue(lastCheckAt: iso(-35 * 3600), now: now))
        XCTAssertTrue(UpdatePanel.isCheckOverdue(lastCheckAt: nil, now: now), "从没检查过更要提醒")
        XCTAssertTrue(UpdatePanel.isCheckOverdue(lastCheckAt: "不像时刻的字符串", now: now))

        var snapshot = UpdatePanel.Snapshot(reportedStatus: .upToDate, storedStatus: .upToDate)
        snapshot.lastCheckAt = iso(-37 * 3600)
        snapshot.current = "1.4.0"
        snapshot.latest = "1.4.0"
        let status = UpdatePanel.effectiveStatus(snapshot, now: now)
        XCTAssertEqual(status, .checkOverdue)

        let prompt = UpdatePanel.promptText(snapshot: snapshot, status: status, now: now)
        XCTAssertNotNil(prompt)
        XCTAssertTrue(prompt!.contains("立即检查"), "提示必须给出下一步动作：\(prompt ?? "")")
        XCTAssertTrue(prompt!.contains("上次检查"), "要告诉用户上次是什么时候：\(prompt ?? "")")

        let buttons = UpdatePanel.buttons(for: .reading(.checkOverdue, staged: false))
        XCTAssertTrue(buttons.checkEnabled, "过期时「立即检查」必须能按")
        XCTAssertFalse(buttons.applyEnabled, "过期时手上没有可装的版本，先把这一问补上")
        // 35 小时不算过期，也不该出这句提示。
        snapshot.lastCheckAt = iso(-35 * 3600)
        XCTAssertEqual(UpdatePanel.effectiveStatus(snapshot, now: now), .upToDate)
        XCTAssertNil(UpdatePanel.promptText(snapshot: snapshot, status: .upToDate, now: now))
    }

    /// 反向变异：**过期判定把手上待装的版本、或上一次被拒的结论盖掉**——用户就
    /// 看不到"有一个具体版本在等你装"，那句被拒的原话也一起没了。
    func testOverdueNeverOverwritesAnOutstandingOfferOrARefusal() {
        for status in UpdatePanel.Status.allCases {
            var snapshot = UpdatePanel.Snapshot(reportedStatus: status, storedStatus: status)
            snapshot.lastCheckAt = iso(-80 * 3600)
            let expected: UpdatePanel.Status?
            switch status {
            case .upToDate, .applied: expected = .checkOverdue
            default: expected = status
            }
            XCTAssertEqual(UpdatePanel.effectiveStatus(snapshot, now: now), expected,
                           "\(status.rawValue) 过期后不该被换掉")
        }
        let empty = UpdatePanel.Snapshot()
        XCTAssertEqual(UpdatePanel.effectiveStatus(empty, now: now), .checkOverdue, "什么都没记着＝从没检查过")
        XCTAssertNil(UpdatePanel.effectiveStatus(nil, now: now))
    }

    /// 反向变异：**关掉自动更新后还 nag"检查已过期"**（定时任务是用户自己关的，
    /// 这一页要说的是"已关闭（上次检查 X）"，与更新器同一口径）。
    func testDisabledSwitchReportsShutdownNotOverdue() {
        var snapshot = UpdatePanel.Snapshot(reportedStatus: .upToDate, storedStatus: .upToDate)
        snapshot.lastCheckAt = iso(-80 * 3600)
        snapshot.disabled = true
        XCTAssertFalse(UpdatePanel.isCheckOverdue(lastCheckAt: snapshot.lastCheckAt, now: now, disabled: true))
        XCTAssertEqual(UpdatePanel.effectiveStatus(snapshot, now: now), .disabled)

        let prompt = UpdatePanel.promptText(snapshot: snapshot, status: .disabled, now: now)
        XCTAssertTrue(prompt?.contains("自动更新已关闭") == true, "\(prompt ?? "")")
        XCTAssertTrue(prompt?.contains("立即检查") == true, "关掉自动后手动通道仍要说得通：\(prompt ?? "")")
        XCTAssertTrue(UpdatePanel.buttons(for: .reading(.disabled, staged: true)).applyEnabled,
                      "关闭状态下手动安装仍然可用")
    }

    func testCheckAgeText() {
        XCTAssertEqual(UpdatePanel.checkAgeText(lastCheckAt: nil, now: now), "从没检查过")
        XCTAssertEqual(UpdatePanel.checkAgeText(lastCheckAt: iso(-40 * 60), now: now), "40 分钟前")
        XCTAssertEqual(UpdatePanel.checkAgeText(lastCheckAt: iso(-5 * 3600), now: now), "5 小时前")
        XCTAssertEqual(UpdatePanel.checkAgeText(lastCheckAt: iso(-3 * 86_400), now: now), "3 天前")
        XCTAssertEqual(UpdatePanel.lastCheckText(nil, now: now), "读不到")
    }

    // MARK: - 那一行 JSON 的解析

    /// 反向变异：**把解析不出来的 stdout 当成功**——页面上就会出现"一切正常"，
    /// 而其实什么都没读到（规格 §7 点名要显示"读不到更新状态"）。
    func testUnparseableStdoutIsNeverSuccess() {
        for garbage in ["", "   \n  ", "not json at all", "{", "[1,2,3]", "读不到"] {
            XCTAssertEqual(
                UpdatePanel.parseLine(garbage), .failure(.unreadable),
                "读不出来的输入必须落在 unreadable：\(garbage.debugDescription)"
            )
        }
        XCTAssertEqual(UpdatePanel.failureText(.unreadable), "读不到更新状态")
        // 封闭枚举之外的状态也是"读不到"，不是"就近取一个"。
        XCTAssertEqual(
            UpdatePanel.parseLine(documentedLine(command: "check", status: "totally-new",
                                                 code: nil, exitCode: 0, ok: true,
                                                 message: nil, state: nil)),
            .failure(.unreadable)
        )
        XCTAssertEqual(
            UpdatePanel.parseLine(documentedLine(command: "check", status: nil,
                                                 code: nil, exitCode: 0, ok: true,
                                                 message: nil, state: ["status": "who-knows"])),
            .failure(.unreadable)
        )
        // 什么都没读到时的按钮：只留一条能自救的路。
        let buttons = UpdatePanel.buttons(for: .reading(nil))
        XCTAssertTrue(buttons.checkEnabled)
        XCTAssertFalse(buttons.applyEnabled)
        XCTAssertTrue(buttons.applyReason!.contains("立即检查"))
    }

    /// 反向变异：**只读外层字段、把 `state` 丢掉**（当前/最新/暂存校验和与
    /// `lastError` 全没了），或**顺手改写 `lastError.message`**（用户复制不到
    /// 原话，也没法拿这句去问人）。
    func testDocumentedLineDecodesIntoThePanelRows() throws {
        let message = "the daemon did not answer the idle probe (connection refused), so no version was swapped"
        let line = documentedLine(
            command: "apply", status: "deferred", code: "busy-or-unreachable", exitCode: 3, ok: false,
            message: message,
            state: [
                "schemaVersion": 1,
                "lastCheckAt": iso(-600),
                "current": "1.4.0",
                "latest": "1.5.0",
                "status": "deferred",
                "code": "busy-or-unreachable",
                "staged": ["version": "1.5.0", "dir": "/tmp/staging", "digest": digest, "at": iso(-600)],
                "lastError": ["code": "busy-or-unreachable", "message": message, "at": iso(-60)],
                "disabled": false,
                "autoApply": true,
                "history": [["at": iso(-600), "action": "check", "result": "staged", "digest": String(digest.prefix(12))]],
                "updatedAt": iso(-60),
            ]
        )
        guard case .success(let snapshot) = UpdatePanel.parseLine(line) else {
            return XCTFail("契约那一行必须读得出来")
        }
        XCTAssertEqual(snapshot.reportedStatus, .deferred)
        XCTAssertEqual(snapshot.storedStatus, .deferred)
        XCTAssertEqual(snapshot.current, "1.4.0")
        XCTAssertEqual(snapshot.latest, "1.5.0")
        XCTAssertEqual(snapshot.stagedVersion, "1.5.0")
        XCTAssertEqual(snapshot.stagedDigest, digest)
        XCTAssertEqual(snapshot.exitCode, 3)
        XCTAssertEqual(snapshot.disabled, false)
        XCTAssertTrue(snapshot.autoApply)
        XCTAssertEqual(snapshot.lastCheckAt, iso(-600))
        // 逐字：一个字符都不能差。
        XCTAssertEqual(UpdatePanel.errorText(snapshot: snapshot), message)
        // 面板显示的状态：一次刚跑完的 apply 被拒，过期与否都要留着这句拒绝。
        XCTAssertEqual(UpdatePanel.effectiveStatus(snapshot, now: now.addingTimeInterval(120)), .deferred)
    }

    /// `state` 缺失（外层就有状态）也要读得出来，不能整行作废。
    /// 反向变异：**要求 `state` 必须存在，否则算读不到**。
    func testLineWithoutStateStillReads() {
        let line = documentedLine(command: "check", status: "check-failed", code: "release-unreachable",
                                  exitCode: 3, ok: false,
                                  message: "could not reach the release list", state: [:])
        guard case .success(let snapshot) = UpdatePanel.parseLine(line) else {
            return XCTFail("外层就有状态：\(line)")
        }
        XCTAssertEqual(snapshot.reportedStatus, .checkFailed)
        XCTAssertNil(snapshot.current)
        XCTAssertNil(snapshot.stagedDigest)
        XCTAssertEqual(UpdatePanel.errorText(snapshot: snapshot), "could not reach the release list")
    }

    /// 反向变异：**`lastError` 为空时编一句"一切正常"**。
    func testErrorLineFallsBackToTheCommandSentenceAndThenToNothing() {
        var snapshot = UpdatePanel.Snapshot(reportedStatus: .checkFailed, storedStatus: .checkFailed)
        XCTAssertNil(UpdatePanel.errorText(snapshot: snapshot))
        snapshot.commandMessage = "could not reach the release list"
        XCTAssertEqual(UpdatePanel.errorText(snapshot: snapshot), "could not reach the release list")
        snapshot.lastErrorMessage = "the release carries no SHA256SUMS file (assets-missing)"
        XCTAssertEqual(UpdatePanel.errorText(snapshot: snapshot), snapshot.lastErrorMessage,
                       "有原话时以状态文档里的那句为准")
        XCTAssertNil(UpdatePanel.errorText(snapshot: nil))
    }

    // MARK: - 安装指针

    /// 反向变异：**指针文件没了也发起一次检查，然后把空输出当成"没有新版本"**
    /// （静默失败——用户以为查过了）。
    func testMissingPointerReportsStaleConditionAndReinstall() {
        let read = UpdatePanel.readPointer(json: nil) { _ in true }
        XCTAssertEqual(read, .failed(.missingPointer))
        let text = UpdatePanel.failureText(.missingPointer)
        XCTAssertTrue(text.contains("installer-pointer-stale"), "要把这个条件原样报出来：\(text)")
        XCTAssertTrue(text.contains("重新运行安装程序"), "要给出重装这句话：\(text)")
        XCTAssertFalse(text.contains("读不到更新状态"), "指针缺失不是解析失败，两句话不能混")
    }

    /// 反向变异：**指针在、但它指的脚本不在了仍按可用处理**。
    func testPointerToAbsentScriptIsStale() {
        let json = #"{"updaterCli":"/opt/glasspane/updater/cli.js","installRoot":"/opt/glasspane"}"#
        let missing = UpdatePanel.readPointer(json: json) { _ in false }
        XCTAssertEqual(missing, .failed(.stalePointer(path: "/opt/glasspane/updater/cli.js")))
        let text = UpdatePanel.failureText(.stalePointer(path: "/opt/glasspane/updater/cli.js"))
        XCTAssertTrue(text.contains("/opt/glasspane/updater/cli.js"), "要说清它指向哪儿：\(text)")
        XCTAssertTrue(text.contains("installer-pointer-stale"))
        XCTAssertTrue(text.contains("重新运行安装程序"))
        XCTAssertTrue(UpdatePanel.readPointer(json: json) { _ in true }.isReady)
        XCTAssertEqual(UpdatePanel.readPointer(json: json) { _ in true }.cliPath, "/opt/glasspane/updater/cli.js")
        XCTAssertEqual(UpdatePanel.buttons(for: .reading(.staged, pointerReady: false)).applyReason?
                       .contains("重新") ?? false, true)
    }

    /// 反向变异：**指针读不出 updaterCli 时退回一个猜的默认路径**。
    func testPointerWithoutScriptPathIsUnreadable() {
        for body in ["not json", "", #"{"installRoot":"/opt/glasspane"}"#, #"{"updaterCli":"   "}"#] {
            XCTAssertEqual(UpdatePanel.readPointer(json: body) { _ in true }, .failed(.unreadablePointer),
                           "\(body.debugDescription) 不能算可用")
        }
        XCTAssertTrue(UpdatePanel.failureText(.unreadablePointer).contains("重新运行安装程序"))
    }

    /// 反向变异：**node 找不到时把命令发出去再把失败说成成功**。
    func testNodeResolutionFailsHonestly() {
        let candidates = ["/nope/node", "/also-nope/node"]
        XCTAssertNil(UpdatePanel.resolveNode(candidates: candidates) { _ in false })
        XCTAssertEqual(UpdatePanel.resolveNode(candidates: candidates) { $0 == "/also-nope/node" }, "/also-nope/node")
        let text = UpdatePanel.failureText(.nodeMissing)
        XCTAssertTrue(text.contains("node"))
        XCTAssertTrue(text.contains("重新"))
        let preferred = UpdatePanel.nodeCandidates(env: ["GLASSPANE_NODE_BIN": "~/bin/node", "PATH": "/x"],
                                                  home: "/Users/me")
        XCTAssertEqual(preferred.first, "/Users/me/bin/node", "显式指定的那个要排在最前")
        XCTAssertTrue(preferred.contains("/opt/homebrew/bin/node"))
    }

    /// 超时与起不来这两种失败也各有说法（都不是"没有新版本"）。
    func testTimeoutAndLaunchFailureHaveTheirOwnText() {
        XCTAssertNotEqual(UpdatePanel.failureText(.timedOut), UpdatePanel.unreadableText)
        XCTAssertTrue(UpdatePanel.failureText(.timedOut).contains("立即检查"))
        XCTAssertTrue(UpdatePanel.failureText(.launchFailed).contains("立即检查"))
    }

    // MARK: - 开关与命令映射

    /// 反向变异：**开与关都发 `check`**；或**只认点击方向、不认盘上的
    /// `disabled: true`**（那正是"一键关"没生效的假象）。
    func testToggleMapsToEnableDisableAndFollowsTheDisk() {
        XCTAssertEqual(UpdateModel.arguments(for: .enable, stateRoot: "/tmp/root"),
                       ["enable", "--state-dir", "/tmp/root", "--json"])
        XCTAssertEqual(UpdateModel.arguments(for: .disable, stateRoot: "/tmp/root"),
                       ["disable", "--state-dir", "/tmp/root", "--json"])
        XCTAssertEqual(UpdateModel.arguments(for: .check, stateRoot: "/tmp/root"),
                       ["check", "--state-dir", "/tmp/root", "--json"])
        XCTAssertEqual(UpdateModel.arguments(for: .status, stateRoot: "/tmp/root"),
                       ["status", "--state-dir", "/tmp/root", "--json"])
        XCTAssertEqual(UpdateModel.arguments(for: .apply, stateRoot: "/tmp/root", extra: ["--consent", "major"]),
                       ["apply", "--state-dir", "/tmp/root", "--json", "--consent", "major"])

        var off = UpdatePanel.Snapshot(reportedStatus: .disabled, storedStatus: .disabled)
        off.disabled = true
        XCTAssertEqual(UpdatePanel.autoUpdateOn(off), false, "盘上写着关闭，开关就必须是关")
        var on = UpdatePanel.Snapshot(reportedStatus: .upToDate, storedStatus: .upToDate)
        on.disabled = false
        XCTAssertEqual(UpdatePanel.autoUpdateOn(on), true)
        XCTAssertNil(UpdatePanel.autoUpdateOn(nil), "什么都没读到时不假装它是开着的")
    }

    /// 面板只说这五条子命令：它不重启后台服务，也不自己实现下载或换版。
    /// 反向变异：**面板加一条 `kickstart`/`restart` 之类的第六个子命令**。
    func testPanelOnlySpeaksTheDocumentedSubcommands() {
        XCTAssertEqual(Set(UpdateModel.Command.allCases.map { $0.rawValue }),
                       ["status", "check", "apply", "enable", "disable"])
    }

    // MARK: - 状态根与文件名

    /// 反向变异：**面板自己拼一个 `~/.glasspane`**（更新器读的是另一个根，两边
    /// 各自看着都对）。
    func testStateRootAndPointerFileAgreeWithTheUpdater() {
        XCTAssertEqual(UpdatePanel.stateRoot(env: ["GLASSPANE_STATE_DIR": "/tmp/other"]), "/tmp/other")
        XCTAssertTrue(UpdatePanel.stateRoot(env: [:]).hasSuffix("/.glasspane"))
        XCTAssertEqual(UpdatePanel.pointerFile(stateRoot: "/tmp/root"), "/tmp/root/update-install.json")
        XCTAssertEqual(UpdatePanel.pointerFile(stateRoot: "/tmp/root/"), "/tmp/root/update-install.json")
        XCTAssertEqual(UpdatePanel.pointerFileName, "update-install.json")
    }

    // MARK: - 真子进程：用"照契约回一行"的脚本夹具驱动

    /// 反向变异：**只信退出码 0、把非 0 那一行丢掉**（拒绝的原话就没了），
    /// 或**把 stderr 当结论**。
    func testFixtureUpdaterAnswerParsesFromARealProcess() throws {
        let sandbox = try makeSandbox()
        let cli = sandbox.appendingPathComponent("cli.js").path
        try "".write(toFile: cli, atomically: true, encoding: .utf8)
        let message = "version 2.0.0 is a major upgrade from 1.4.0: contract changes need a person"
        let line = documentedLine(
            command: "apply", status: "needs-consent", code: "consent-required", exitCode: 3, ok: false,
            message: message,
            state: [
                "lastCheckAt": iso(-600), "current": "1.4.0", "latest": "2.0.0",
                "status": "needs-consent", "code": "consent-required",
                "staged": ["version": "2.0.0", "dir": "/tmp/stage", "digest": digest, "at": iso(-600)],
                "lastError": ["code": "consent-required", "message": message, "at": iso(-60)],
                "disabled": false, "autoApply": true,
            ]
        )
        let node = try writeFixtureNode(dir: sandbox, jsonLine: line, exitCode: 3)

        let outcome = UpdateModel.runUpdater(
            node: node.path,
            arguments: [cli] + UpdateModel.arguments(for: .apply, stateRoot: sandbox.path,
                                                     extra: ["--consent", "major"]),
            timeoutSeconds: 30
        )
        guard case .completed(let stdout, let exit) = outcome else {
            return XCTFail("子进程该回话：\(outcome)")
        }
        XCTAssertEqual(exit, 3, "退出码是契约的一部分，不能吞")
        guard case .success(let snapshot) = UpdatePanel.parseLine(stdout) else {
            return XCTFail("非 0 退出的那一行同样是结论")
        }
        XCTAssertEqual(snapshot.reportedStatus, .needsConsent)
        XCTAssertEqual(UpdatePanel.errorText(snapshot: snapshot), message)
        let buttons = UpdatePanel.buttons(for: .reading(
            snapshot.reportedStatus, staged: snapshot.stagedVersion != nil,
            exitCode: snapshot.exitCode, current: snapshot.current, stagedVersion: snapshot.stagedVersion
        ))
        XCTAssertTrue(buttons.applyEnabled)
        XCTAssertEqual(buttons.applyArguments, ["--consent", "major"])
        let args = try readArgsLog(in: sandbox)
        XCTAssertTrue(args.contains("apply --state-dir \(sandbox.path) --json --consent major"),
                      "发出去的命令长这样：\(args)")
    }

    /// 反向变异：**输出不是 JSON 时页面继续显示上一次的成功结论而不提失败**。
    func testFixtureSilentScriptIsReadAsUnparseable() throws {
        let sandbox = try makeSandbox()
        let cli = sandbox.appendingPathComponent("cli.js").path
        try "".write(toFile: cli, atomically: true, encoding: .utf8)
        let node = try writeFixtureNode(dir: sandbox,
                                       jsonLine: "gate refused: assets-missing — no SHA256SUMS",
                                       exitCode: 0)
        let outcome = UpdateModel.runUpdater(node: node.path,
                                             arguments: [cli] + UpdateModel.arguments(for: .check, stateRoot: sandbox.path),
                                             timeoutSeconds: 30)
        guard case .completed(let stdout, let exit) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(exit, 0)
        XCTAssertEqual(UpdatePanel.parseLine(stdout), .failure(.unreadable),
                       "退出码 0 也不等于读到了结论")
        XCTAssertEqual(UpdatePanel.failureText(.unreadable), "读不到更新状态")
    }

    /// 端到端（模型层）：开关发的是 `disable`，回的那一行写着 `disabled: true`
    /// 时页面上的开关就得是关——点之前的方向不算数。
    /// 反向变异：**先把滑块挪到用户点的那个方向，再不管盘上写着什么**。
    @MainActor
    func testToggleThroughTheModelFollowsWhatTheDiskSays() async throws {
        let sandbox = try makeSandbox()
        let cli = sandbox.appendingPathComponent("cli.js").path
        try "".write(toFile: cli, atomically: true, encoding: .utf8)
        try documentedPointer(in: sandbox, cli: cli).write(toFile: pointerFile(in: sandbox), atomically: true, encoding: .utf8)

        let line = documentedLine(
            command: "disable", status: "disabled", code: nil, exitCode: 0, ok: true,
            message: "automatic update is off: updater check and updater apply still work by hand",
            state: [
                "lastCheckAt": iso(-7200), "current": "1.4.0", "latest": "1.5.0",
                "status": "disabled", "code": nil, "staged": nil, "lastError": nil,
                "disabled": true, "autoApply": false,
            ]
        )
        let node = try writeFixtureNode(dir: sandbox, jsonLine: line, exitCode: 0)

        let model = UpdateModel(stateRoot: sandbox.path, nodePath: node.path, clock: { [self] in self.now })
        XCTAssertEqual(model.autoUpdateOn, nil, "还没读过盘上的状态，不假称它是开着的")
        model.setAutoUpdate(false)
        await waitUntil { !model.isRunning }
        XCTAssertFalse(model.isRunning, "子进程该回话了")
        XCTAssertEqual(model.autoUpdateOn, false, "开关位置跟盘上的 disabled 走")
        XCTAssertEqual(model.status, .disabled)
        XCTAssertNil(model.readFailure)
        XCTAssertTrue(model.buttons.checkEnabled, "关掉自动更新后手动检查仍可用")
        XCTAssertFalse(model.buttons.applyEnabled, "这份状态里没有暂存版本，「安装更新」按不动")
        XCTAssertNotNil(model.buttons.applyReason)
        let args = try readArgsLog(in: sandbox)
        XCTAssertTrue(args.contains("disable --state-dir \(sandbox.path) --json"), "开关发的是 disable：\(args)")
    }

    /// 端到端（模型层）：没有安装指针时这一页显示的是重装条件，不是"已是最新"。
    /// 反向变异：**指针缺失时静默什么都不显示**（用户以为这页还没加载）。
    @MainActor
    func testModelWithNoPointerShowsTheStaleCondition() async throws {
        let sandbox = try makeSandbox()
        let model = UpdateModel(stateRoot: sandbox.path, nodePath: "/usr/bin/true", clock: { [self] in self.now })
        model.refresh()
        await waitUntil { model.readFailure != nil }
        XCTAssertEqual(model.readFailure, .missingPointer)
        XCTAssertNil(model.snapshot)
        XCTAssertTrue(UpdatePanel.failureText(model.readFailure!).contains("重新运行安装程序"))
        XCTAssertFalse(model.buttons.checkEnabled)
        XCTAssertFalse(model.buttons.applyEnabled)
        XCTAssertFalse(model.buttons.toggleEnabled)
    }

    // MARK: - 起子进程时那份根证书束（§9.3：面板是束的两个消费者之一）

    /// 反向变异：**把路径按家目录再拼一遍**，或者换个文件名（安装器写的是状态根下
    /// 那一个 `ca-roots.pem`，面板找错地方就等于每一次都不带这个键）。
    func testCaBundlePathIsTheStateRootPlusThatOneFileName() {
        XCTAssertEqual(UpdatePanel.caBundleFileName, "ca-roots.pem")
        XCTAssertEqual(UpdatePanel.extraCaCertsKey, "NODE_EXTRA_CA_CERTS")
        XCTAssertEqual(UpdatePanel.caBundleFile(stateRoot: "/tmp/root"), "/tmp/root/ca-roots.pem")
        XCTAssertEqual(UpdatePanel.caBundleFile(stateRoot: "/tmp/root/"), "/tmp/root/ca-roots.pem")
        // 束与指针认的是同一个根：两个文件不可能一个在状态根、一个在别的根。
        let root = UpdatePanel.stateRoot(env: ["GLASSPANE_STATE_DIR": "/tmp/other"])
        XCTAssertTrue(UpdatePanel.caBundleFile(stateRoot: root).hasPrefix("/tmp/other/"))
        XCTAssertEqual(UpdatePanel.caBundleFile(stateRoot: root),
                       (root as NSString).appendingPathComponent(UpdatePanel.caBundleFileName))
    }

    /// 反向变异：**"文件在"就当能用**（一份 0 字节、或满是空白却没有证书的束被交给
    /// `NODE_EXTRA_CA_CERTS`：实测 node v26.4.0 不崩也不报错，它照常启动、照常握手，只是
    /// 一张额外的根都没加——见 `updater/test/ca-bundle.test.mjs` 里那条实测控制。危险不是
    /// "起不来"，是"看着做了其实什么都没做"，而状态里会记成"束已导出"）。
    func testCaBundleOnDiskIsJudgedByCertificatesNotByPresence() {
        let pem = """
        -----BEGIN CERTIFICATE-----
        MIIB T H I S I S A N O N C E R T I I C A T E
        -----END CERTIFICATE-----
        """
        XCTAssertEqual(UpdatePanel.judgeCaBundle(path: "/r/ca-roots.pem", text: nil), .absent)
        XCTAssertEqual(UpdatePanel.judgeCaBundle(path: "/r/ca-roots.pem", text: ""),
                       .empty(path: "/r/ca-roots.pem"), "0 字节不是束")
        XCTAssertEqual(UpdatePanel.judgeCaBundle(path: "/r/ca-roots.pem", text: "\n\n   \n"),
                       .empty(path: "/r/ca-roots.pem"), "有字节但一张证书也没有，同样不能交出去")
        XCTAssertEqual(UpdatePanel.judgeCaBundle(path: "/r/ca-roots.pem", text: pem),
                       .usable(path: "/r/ca-roots.pem", certificates: 1))
        XCTAssertEqual(UpdatePanel.judgeCaBundle(path: "/r/ca-roots.pem", text: pem + "\n" + pem),
                       .usable(path: "/r/ca-roots.pem", certificates: 2), "张数要数对，那句人话指着它")
    }

    /// 反向变异：**把路径写成别的键**、或**只发这一个键**（子进程没了 PATH 之类的底子，
    /// 更新器读到的状态根也跟着变）。
    func testCaBundleEnvironmentHandsThatExactPathOverTheWholeBase() {
        let bundle = UpdatePanel.caBundleFile(stateRoot: "/tmp/root")
        let env = UpdatePanel.caBundleEnvironment(
            base: ["PATH": "/usr/bin:/bin", "GLASSPANE_STATE_DIR": "/tmp/root"],
            bundle: .usable(path: bundle, certificates: 163)
        )
        XCTAssertEqual(env[UpdatePanel.extraCaCertsKey], "/tmp/root/ca-roots.pem")
        XCTAssertEqual(env["PATH"], "/usr/bin:/bin", "底子要原样带过去，不是只给这一个键")
        XCTAssertEqual(env["GLASSPANE_STATE_DIR"], "/tmp/root")
    }

    /// 反向变异：**无条件设置这个键**（束不在也把路径写进去），或**用空串"表示没有"**
    /// （空串不会让 node 崩——实测它与没设表现一致；它的问题是**把操作者从终端带进来的那一份
    /// 信任静默覆盖掉**，所以"不写这个键"与"写一个空值"必须分成两件事）。
    func testCaBundleEnvironmentLeavesTheKeyOutWhenThereIsNoBundle() {
        for bundle in [UpdatePanel.CaBundleOnDisk.absent,
                       UpdatePanel.CaBundleOnDisk.empty(path: "/tmp/root/ca-roots.pem")] {
            let env = UpdatePanel.caBundleEnvironment(base: ["PATH": "/usr/bin"], bundle: bundle)
            XCTAssertFalse(env.keys.contains(UpdatePanel.extraCaCertsKey),
                           "\(bundle) 时这个键必须根本不出现，而不是出现一个空值：\(env)")
            XCTAssertNil(env[UpdatePanel.extraCaCertsKey])
            XCTAssertEqual(env, ["PATH": "/usr/bin"], "束不在时那份环境一个字都不能改")
        }
        // 人从终端带进来的那份信任不由面板代他取消（面板无权替这台机器决定信什么）。
        let inherited = UpdatePanel.caBundleEnvironment(
            base: [UpdatePanel.extraCaCertsKey: "/mine/roots.pem"], bundle: .absent
        )
        XCTAssertEqual(inherited[UpdatePanel.extraCaCertsKey], "/mine/roots.pem")
        // 束能用时也不许把人那份悄悄留着不改方向：指向的是状态根下这一份。
        let handed = UpdatePanel.caBundleEnvironment(
            base: [UpdatePanel.extraCaCertsKey: "/mine/roots.pem"],
            bundle: .usable(path: "/tmp/root/ca-roots.pem", certificates: 3)
        )
        XCTAssertEqual(handed[UpdatePanel.extraCaCertsKey], "/tmp/root/ca-roots.pem")
        // 张数为 0 的那一份就算被别的调用点造出来也不许交出去。
        let zeroed = UpdatePanel.caBundleEnvironment(base: [:], bundle: .usable(path: "/r/ca-roots.pem", certificates: 0))
        XCTAssertFalse(zeroed.keys.contains(UpdatePanel.extraCaCertsKey), "0 张的束等于没有束：\(zeroed)")
    }

    /// 真子进程：面板按下「立即检查」，子进程**自己**报它收到的那个环境变量。
    /// 反向变异：**面板算了环境却没把它交给 `Process`**（`process.environment` 忘了设），
    /// 或**设的是别的键/别的路径**——这一条只有真起进程才看得见，纯函数看不见。
    @MainActor
    func testPanelSpawnHandsTheBundlePathToTheChildProcess() async throws {
        let sandbox = try makeSandbox()
        let cli = sandbox.appendingPathComponent("cli.js").path
        try "".write(toFile: cli, atomically: true, encoding: .utf8)
        try documentedPointer(in: sandbox, cli: cli).write(toFile: pointerFile(in: sandbox), atomically: true, encoding: .utf8)
        let bundle = try writeCaBundle(in: sandbox, text: pemBundle)
        let node = try writeEnvironmentAwareNode(dir: sandbox, jsonLine: documentedLine(
            command: "check", status: "up-to-date", code: nil, exitCode: 0, ok: true,
            message: nil, state: ["status": "up-to-date", "current": "1.4.0", "latest": "1.4.0",
                                  "lastCheckAt": iso(-60), "disabled": false, "autoApply": true]
        ), exitCode: 0)

        let model = UpdateModel(stateRoot: sandbox.path, nodePath: node.path,
                                clock: { [self] in self.now },
                                baseEnvironment: ["PATH": "/usr/bin:/bin"])
        XCTAssertEqual(model.caBundleFile, bundle, "面板找的那个束就是状态根下这一个")
        model.checkNow()
        await waitUntil { !model.isRunning }
        XCTAssertNil(model.readFailure, "子进程该回话：\(String(describing: model.readFailure))")
        let log = try readEnvLog(in: sandbox)
        XCTAssertEqual(log, "ca-present:\(bundle)\n",
                       "面板必须把那个键连同状态根下那个路径交给子进程：\(log.debugDescription)")
    }

    /// 束不在、以及束在但 0 字节：子进程**收不到这个键**（不是收到一个空串）。
    /// 反向变异：**不存在也照样设上这个键**、或**0 字节当有效束交出去**、
    /// 或**设成空串来表示没有**——三种都把"每天检查失败一次"换成"node 根本起不来"。
    @MainActor
    func testPanelSpawnOmitsTheKeyWhenTheBundleIsAbsentOrEmpty() async throws {
        for caseNamed in ["absent", "empty-bytes"] {
            let sandbox = try makeSandbox()
            let cli = sandbox.appendingPathComponent("cli.js").path
            try "".write(toFile: cli, atomically: true, encoding: .utf8)
            try documentedPointer(in: sandbox, cli: cli).write(toFile: pointerFile(in: sandbox), atomically: true, encoding: .utf8)
            if caseNamed == "empty-bytes" {
                _ = try writeCaBundle(in: sandbox, text: "")
                XCTAssertTrue(FileManager.default.fileExists(atPath: UpdatePanel.caBundleFile(stateRoot: sandbox.path)),
                              "这一步要造的就是「文件在但空着」，不然测的是上一条")
            }
            let node = try writeEnvironmentAwareNode(dir: sandbox, jsonLine: documentedLine(
                command: "check", status: "up-to-date", code: nil, exitCode: 0, ok: true,
                message: nil, state: ["status": "up-to-date", "current": "1.4.0", "latest": "1.4.0",
                                      "lastCheckAt": iso(-60), "disabled": false, "autoApply": true]
            ), exitCode: 0)
            let model = UpdateModel(stateRoot: sandbox.path, nodePath: node.path,
                                    clock: { [self] in self.now },
                                    baseEnvironment: ["PATH": "/usr/bin:/bin"])
            model.checkNow()
            await waitUntil { !model.isRunning }
            XCTAssertNil(model.readFailure, "\(caseNamed)：子进程该回话")
            let log = try readEnvLog(in: sandbox)
            XCTAssertEqual(log, "ca-absent\n",
                             "\(caseNamed) 时这个键不能出现在子进程环境里：\(log.debugDescription)")
        }
    }

    // MARK: - 束的导出记录怎么显示（§9.7：五个态 + 没记录过，各有一句人话）

    /// 反向变异：**面板这边少接一个成员**（并一个到 `ok`、或漏一个），或**认不出的状态
    /// 就近映射成某个成员**——被拦的机器就会显示成"一切正常"。
    func testCaRootsStatusEnumMatchesTheContract() {
        XCTAssertEqual(UpdatePanel.CaRootsStatus.allCases.map { $0.rawValue }, Self.contractCaStatuses)
        for raw in Self.contractCaStatuses {
            XCTAssertNotNil(UpdatePanel.CaRootsStatus.parse(raw), "\(raw) 必须认得")
        }
        XCTAssertNil(UpdatePanel.CaRootsStatus.parse("ok-ish"), "枚举外的只能算读不懂")
        XCTAssertNil(UpdatePanel.CaRootsStatus.parse("verified"))
        XCTAssertNil(UpdatePanel.CaRootsStatus.parse(nil))
        XCTAssertNil(UpdatePanel.CaRootsStatus.parse(""))
    }

    /// 反向变异：**把 `ok` 那句的证书数写死或丢掉**（这一句的全部作用就是让人核对
    /// "导出了多少张"，实测那台机器是 163 张）。
    func testCaRootsOkLineShowsTheCertificateCount() throws {
        let recorded = try caRootsSnapshot(status: "ok", certs: 163, detail: nil)
        XCTAssertTrue(UpdatePanel.caRootsIsUsable(recorded), "只有 ok 算备好")
        let text = UpdatePanel.caRootsText(recorded)
        XCTAssertTrue(text.contains("163"), "张数要在这句里：\(text)")
        XCTAssertFalse(text.contains("读不到"), "读到了就别说读不到：\(text)")
        XCTAssertFalse(text.contains("连不上发布站点"), "备好了不该说失败的话：\(text)")

        // 张数没记着也不能编一个数出来。
        let noCount = try caRootsSnapshot(status: "ok", certs: nil, detail: nil)
        XCTAssertTrue(UpdatePanel.caRootsIsUsable(noCount))
        XCTAssertTrue(UpdatePanel.caRootsText(noCount).contains("没写张数"),
                      "没有张数就如实说没有：\(UpdatePanel.caRootsText(noCount))")
    }

    /// 反向变异：**四个失败态并成一句**（"束是空的"与"束写坏了"与"写好了仍连不通"是
    /// 三件不同的事，各自的下一步也不同），或**把 `detail` 原文吞掉**。
    func testEachCaRootsFailureStateSaysItsOwnThing() throws {
        let detail = "read back 0 certificate(s) of the 163 written"
        let distinguishing = [
            "empty": "一张也没拿到",
            "unavailable": "没有导出系统根证书所需的工具",
            "write-unverified": "读回来",
            "probe-failed": "仍然连不上发布站点",
        ]
        var said: [String: String] = [:]
        for (status, fingerprint) in distinguishing {
            let snapshot = try caRootsSnapshot(status: status, certs: 7, detail: detail)
            let text = UpdatePanel.caRootsText(snapshot)
            XCTAssertFalse(UpdatePanel.caRootsIsUsable(snapshot), "\(status) 不算备好")
            XCTAssertTrue(text.contains(status), "\(status) 要把状态原样带出来好跟日志核对：\(text)")
            XCTAssertTrue(text.contains(fingerprint), "\(status) 少了它自己那句：\(text)")
            XCTAssertTrue(text.contains(detail), "\(status) 把失败原因原文吞了：\(text)")
            XCTAssertTrue(text.contains("请"), "\(status) 要给一个做得动的下一步：\(text)")
            said[status] = text
        }
        for (a, left) in said {
            for (b, right) in said where a != b {
                XCTAssertNotEqual(left, right, "\(a) 与 \(b) 不能并成同一句话")
            }
        }
    }

    /// 反向变异：**把 `<那份束的路径>` 这类占位符留在界面上**（1.5.1 之前的 `unavailable`
    /// 那句就是这么显示给用户的——那是一句让人自己去猜路径的话，不是一个做得动的动作）。
    /// 这一页要么给出真实路径，要么用中文说清去哪儿查；尖括号里的模板字符串一律算违规。
    func testCaRootsCopyNeverShowsAnAngleBracketPlaceholder() throws {
        let shapes: [(String, UpdatePanel.Snapshot?)] = [
            ("ok", try caRootsSnapshot(status: "ok", certs: 163, detail: nil)),
            ("empty", try caRootsSnapshot(status: "empty", certs: 0, detail: "security printed nothing")),
            ("unavailable", try caRootsSnapshot(status: "unavailable", certs: 0, detail: "no security tool")),
            ("write-unverified", try caRootsSnapshot(status: "write-unverified", certs: 12, detail: "read back 0 of 12")),
            ("probe-failed", try caRootsSnapshot(status: "probe-failed", certs: 163, detail: "UNABLE_TO_VERIFY_LEAF_SIGNATURE")),
            ("认不出的状态", try caRootsSnapshot(status: "looks-fine", certs: 1, detail: nil)),
            ("旧安装（记录为 null）", try snapshotWithNullCaRoots()),
            ("没读到状态", nil),
        ]
        for (label, snapshot) in shapes {
            let text = UpdatePanel.caRootsText(snapshot)
            XCTAssertFalse(text.contains("<"), "\(label) 的文案里有尖括号占位符，用户按它做不了任何事：\(text)")
            XCTAssertFalse(text.contains(">"), "\(label) 的文案里有尖括号占位符：\(text)")
            XCTAssertFalse(text.contains("stateRoot"), "\(label) 把内部变量名当成了给用户看的句子：\(text)")
        }
    }

    /// 反向变异：**把 `null` 读成 `ok`**（这就是这台机器"面板每天看着都正常、
    /// 其实一次都没连上"的形状），或缺失时显示成"没有这个问题"。
    func testMissingOrNullCaRootsReadsAsAnOldInstallNotAsFine() throws {
        let absentRecord = try snapshotWithoutCaRoots()
        let nulledRecord = try snapshotWithNullCaRoots()
        for (label, snapshot) in ["缺失": absentRecord, "null": nulledRecord] {
            XCTAssertNil(snapshot.caRoots, "\(label) 都该读成没有这份记录")
            XCTAssertFalse(UpdatePanel.caRootsIsUsable(snapshot), "\(label) 不能算备好")
            let text = UpdatePanel.caRootsText(snapshot)
            XCTAssertTrue(text.contains("未记录过导出结果"), "\(label) 要说清是没记录过：\(text)")
            XCTAssertTrue(text.contains("旧安装"), "\(label) 要指出这是旧安装：\(text)")
            XCTAssertFalse(text.contains("系统根证书（共"), "\(label) 显示成了正常态：\(text)")
            XCTAssertTrue(text.contains("请"), "\(label) 也要给出下一步：\(text)")
        }
        // 连一份状态都没读到，是另外一句——不能借用"旧安装"这句话假装读到了什么。
        let nothing = UpdatePanel.caRootsText(nil)
        XCTAssertTrue(nothing.contains("读不到"), "\(nothing)")
        XCTAssertFalse(nothing.contains("旧安装"))
    }

    /// 反向变异：**枚举外的状态当 `ok` 显示**，或把它悄悄折算成某个认得的成员。
    func testUnrecognizedCaRootsStatusIsNotReadAsOk() throws {
        let snapshot = try caRootsSnapshot(status: "looks-fine", certs: 163, detail: "exporter said so")
        XCTAssertNil(snapshot.caRoots?.status, "认不出的取值只能读成 nil")
        XCTAssertEqual(snapshot.caRoots?.rawStatus, "looks-fine", "原文要留着，人才查得动")
        XCTAssertFalse(UpdatePanel.caRootsIsUsable(snapshot), "认不出来绝不能当成备好")
        let text = UpdatePanel.caRootsText(snapshot)
        XCTAssertTrue(text.contains("looks-fine"), "要把原文报出来：\(text)")
        XCTAssertTrue(text.contains("认不出来"), "\(text)")
        XCTAssertTrue(text.contains("exporter said so"), "这一态也该看得见原话：\(text)")
    }

    /// 这一项读不懂时，其余那一行照常有效：不能因为它就把版本与按钮理由一起丢掉。
    /// 反向变异：**`caRoots` 里多一个没声明的键、或状态认不出，就整行判成读不到**。
    func testUnreadableCaRootsDoesNotVoidTheWholeLine() throws {
        let line = documentedLine(
            command: "status", status: "staged", code: nil, exitCode: 0, ok: true, message: nil,
            state: [
                "status": "staged", "current": "1.4.0", "latest": "1.5.0",
                "lastCheckAt": iso(-60), "disabled": false, "autoApply": true,
                "staged": ["version": "1.5.0", "dir": "/tmp/stage", "digest": digest, "at": iso(-60)],
                "caRoots": ["status": "who-knows", "extraKeyNobodyDeclared": true],
            ]
        )
        guard case .success(let snapshot) = UpdatePanel.parseLine(line) else {
            return XCTFail("这一行其余部分读得出来：\(line)")
        }
        XCTAssertEqual(snapshot.reportedStatus, .staged)
        XCTAssertEqual(snapshot.current, "1.4.0")
        XCTAssertEqual(snapshot.stagedVersion, "1.5.0")
        XCTAssertNil(snapshot.caRoots?.status)
        XCTAssertFalse(UpdatePanel.caRootsIsUsable(snapshot))
    }

    // MARK: - 更新器自身的换版怎么显示（§11.9：四个态 + 从没记录过，各有一句人话）

    /// 反向变异：**面板这边少接一个成员**（把两个并成一个、或漏一个），或**认不出的状态
    /// 就近映射成某个成员**——那台机器上"修更新器的那次发版"就会显示成已经送到了，
    /// 而它每天跑的其实还是装进来那一份。
    func testRuntimeStatusEnumMatchesTheContract() {
        XCTAssertEqual(UpdatePanel.RuntimeStatus.allCases.map { $0.rawValue }, Self.contractRuntimeStatuses)
        for raw in Self.contractRuntimeStatuses {
            XCTAssertNotNil(UpdatePanel.RuntimeStatus.parse(raw), "\(raw) 必须认得")
        }
        XCTAssertNil(UpdatePanel.RuntimeStatus.parse("self-updated"), "枚举外的只能算读不懂")
        XCTAssertNil(UpdatePanel.RuntimeStatus.parse("ok"), "根证书那一套取值不能串到这里来")
        XCTAssertNil(UpdatePanel.RuntimeStatus.parse(nil))
        XCTAssertNil(UpdatePanel.RuntimeStatus.parse(""))
    }

    /// 反向变异：**只看 `status` 就说"已换上"**（不看在册任务有没有被读回来核对），
    /// 或**把记录里的真实路径丢掉**（这一句的全部作用就是让人核对跑的是哪一份）。
    func testRuntimeRefreshedWithVerifiedAgentIsTheOnlyGoodNews() throws {
        let snapshot = try runtimeSnapshot(runtimeRecord(status: "refreshed", agentVerified: true))
        XCTAssertEqual(snapshot.runtime?.status, .refreshed)
        XCTAssertEqual(snapshot.runtime?.agentVerified, true)
        XCTAssertEqual(snapshot.runtime?.cliPath, Self.runtimeCli, "路径要原样留着，人才查得动")
        XCTAssertTrue(UpdatePanel.runtimeIsUsable(snapshot), "换上 + 在册任务核对过，只有这一对算换上")
        XCTAssertEqual(UpdatePanel.runtimeAttention(snapshot), .confirmed)
        let text = UpdatePanel.runtimeText(snapshot)
        XCTAssertTrue(text.contains("已换上"), "核对过的 refreshed 就该说换上：\(text)")
        XCTAssertTrue(text.contains(Self.runtimeCli), "真实路径要在这句里：\(text)")
        XCTAssertTrue(text.contains("在册的定时任务读回来的就是这一份"), "\(text)")
        XCTAssertFalse(text.contains("送不到这台机器上"), "换上了不该说失败的话：\(text)")
        XCTAssertFalse(text.contains("重新运行安装程序"), "换上了不该叫人来一次重装：\(text)")
    }

    /// 反向变异：**把"记录说换上了"当成"这台机器已经在跑新那一份"**——`agentVerified`
    /// 写着 false、写着 null、干脆没这个键，三种都不能冒出那句肯定的话。规格点名的正是
    /// "读不到就当成功"这一条。
    func testRefreshedWithoutAgentVerificationNeverReadsAsSwappedIn() throws {
        let notVerified = runtimeRecord(status: "refreshed", agentVerified: false)
        let nulled = runtimeRecord(status: "refreshed", agentVerified: NSNull())
        var keyMissing = runtimeRecord(status: "refreshed", agentVerified: true)
        keyMissing.removeValue(forKey: "agentVerified")
        for (label, record) in ["false": notVerified, "null": nulled, "缺键": keyMissing] {
            let snapshot = try runtimeSnapshot(record)
            XCTAssertEqual(snapshot.runtime?.status, .refreshed, "\(label)：状态本身不许被改写成药能认的那个")
            XCTAssertNotEqual(snapshot.runtime?.agentVerified, true, "\(label) 都不等于核对过：\(String(describing: snapshot.runtime?.agentVerified))")
            XCTAssertFalse(UpdatePanel.runtimeIsUsable(snapshot), "\(label) 不能算换上")
            XCTAssertEqual(UpdatePanel.runtimeAttention(snapshot), .attention, "\(label) 是要人做点什么的")
            let text = UpdatePanel.runtimeText(snapshot)
            XCTAssertFalse(text.contains("已换上"), "\(label) 不能出现那句肯定的话：\(text)")
            XCTAssertTrue(text.contains("refreshed"), "\(label) 要把原值带出来好跟日志核对：\(text)")
            XCTAssertTrue(text.contains("不能说它已经在跑"), "\(label) 少了它自己那句：\(text)")
            XCTAssertTrue(text.contains(Self.runtimeCli), "\(label) 也该看得见是哪一份：\(text)")
            XCTAssertTrue(text.contains("关掉再打开一次"), "\(label) 要给这一页上做得动的动作：\(text)")
            XCTAssertTrue(text.contains("请重新运行安装程序"), "\(label) 也要给另一条路：\(text)")
        }
    }

    /// 反向变异：**三个非好消息并成一句**（"没换上"与"开关关着"与"这轮没尝试"是三件不同的
    /// 事，下一步也各不相同），或**把 `detail` 原文吞掉**。
    func testEachRuntimeStateSaysItsOwnThing() throws {
        let detail = "the loaded job still names the old command line"
        let distinguishing: [String: String] = [
            "failed": "更新装上了，但更新器自身没换上",
            "kept": "没有登记定时任务",
            "skipped": "这一轮没有去动更新器自身",
        ]
        var said: [String: String] = [:]
        for (status, fingerprint) in distinguishing {
            let snapshot = try runtimeSnapshot(runtimeRecord(status: status, detail: detail))
            XCTAssertFalse(UpdatePanel.runtimeIsUsable(snapshot), "\(status) 不算换上")
            let text = UpdatePanel.runtimeText(snapshot)
            XCTAssertTrue(text.contains(status), "\(status) 要把状态原样带出来好跟日志核对：\(text)")
            XCTAssertTrue(text.contains(fingerprint), "\(status) 少了它自己那句：\(text)")
            XCTAssertTrue(text.contains(detail), "\(status) 把失败原因原文吞了：\(text)")
            XCTAssertTrue(text.contains("请"), "\(status) 要给一个做得动的下一步：\(text)")
            XCTAssertFalse(text.contains("已换上"), "\(status) 不能借用核对过那一句：\(text)")
            said[status] = text
        }
        for (a, left) in said {
            for (b, right) in said where a != b {
                XCTAssertNotEqual(left, right, "\(a) 与 \(b) 不能并成同一句话")
            }
        }
        // 规格点名的那一句原话：这不是"更新失败"，新版本确实装上了。
        let failed = said["failed"]!
        XCTAssertTrue(failed.contains("这不是「更新失败」"), failed)
        XCTAssertTrue(failed.contains("请重新运行安装程序"), failed)
        XCTAssertTrue(failed.contains(Self.previousRuntimeCli), "回退目标也要看得见：\(failed)")
        // `kept` 既不是失败也不是好消息：它说的是这台机器自己的开关。
        let kept = said["kept"]!
        XCTAssertTrue(kept.contains("把自动更新关着"), kept)
        XCTAssertTrue(kept.contains("不是失败"), kept)
        XCTAssertTrue(kept.contains("请把「自动更新」开关打开"), kept)
        XCTAssertFalse(kept.contains("重新运行安装程序"), "开关一开就解决了，不必重装：\(kept)")
        // `skipped`（定时那一次主动跳过交接）：不许被读成换上了，也不许被读成失败，
        // 但必须说清交接是谁做的——1.6.0 之前这句写的是"下一次装成功"，那是不存在的语义。
        let skipped = said["skipped"]!
        XCTAssertTrue(skipped.contains("enable"), "要说清下一次接手靠什么：\(skipped)")
        XCTAssertTrue(skipped.contains("开关"), "面板上做得动的那一下也要看得见：\(skipped)")
        XCTAssertFalse(skipped.contains("这不是「更新失败」"), "这一轮压根没尝试，谈不上失败：\(skipped)")
    }

    /// 反向变异：**没有路径时也印出一个路径**（自己拼一个、或留一个模板），
    /// 或者干脆什么都不说，让人以为这一项没问题。
    func testRuntimeWithoutAPathSaysSoInsteadOfNamingOne() throws {
        let snapshot = try runtimeSnapshot(
            runtimeRecord(status: "failed", version: nil, cliPath: nil, previousCliPath: nil)
        )
        XCTAssertNil(snapshot.runtime?.cliPath)
        XCTAssertNil(snapshot.runtime?.version)
        XCTAssertFalse(UpdatePanel.runtimeIsUsable(snapshot))
        let text = UpdatePanel.runtimeText(snapshot)
        XCTAssertTrue(text.contains("记录里没有它的路径"), text)
        XCTAssertFalse(text.contains("/Users/x"), "没记着的路径不能凭空印一个：\(text)")
        XCTAssertTrue(text.contains("请重新运行安装程序"), text)
    }

    /// 反向变异：**把 `null` 读成 `refreshed`**（这就是"面板每天看着都正常、其实那份代码
    /// 从来没换过版"的形状），或缺失时显示成"没有这个问题"。
    func testMissingOrNullRuntimeReadsAsAnOldInstallNotAsSwappedIn() throws {
        let absentRecord = try snapshotWithoutRuntime()
        let nulledRecord = try snapshotWithNullRuntime()
        for (label, snapshot) in ["缺失": absentRecord, "null": nulledRecord] {
            XCTAssertNil(snapshot.runtime, "\(label) 都该读成没有这份记录")
            XCTAssertFalse(UpdatePanel.runtimeIsUsable(snapshot), "\(label) 不能算换上")
            XCTAssertEqual(UpdatePanel.runtimeAttention(snapshot), .attention,
                           "\(label) 要人来一次重装，不是中性的一项")
            let text = UpdatePanel.runtimeText(snapshot)
            XCTAssertTrue(text.contains("未记录过更新器自身的换版"), "\(label) 要说清是没记录过：\(text)")
            XCTAssertTrue(text.contains("旧安装"), "\(label) 要指出这是旧安装：\(text)")
            XCTAssertTrue(text.contains("请重新运行安装程序"), "\(label) 也要给出下一步：\(text)")
            XCTAssertFalse(text.contains("已换上"), "\(label) 显示成了正常态：\(text)")
            XCTAssertFalse(text.contains("这一项现在不用管"), "\(label) 不该让人放手：\(text)")
        }
        // 连一份状态都没读到，是另外一句——不能借用"旧安装"这句话假装读到了什么。
        let nothing = UpdatePanel.runtimeText(nil)
        XCTAssertTrue(nothing.contains("还没读到更新状态"), nothing)
        XCTAssertFalse(nothing.contains("旧安装"))
        XCTAssertEqual(UpdatePanel.runtimeAttention(nil), .unknown)
    }

    /// 反向变异：**枚举外的状态当 `refreshed` 显示**，或把它悄悄折算成某个认得的成员。
    /// 这里连 `agentVerified: true` 都给了：核对过的那个字段**不能**替一个认不出的状态说话。
    func testUnrecognizedRuntimeStatusIsNotReadAsRefreshed() throws {
        let snapshot = try runtimeSnapshot(
            runtimeRecord(status: "self-updated", agentVerified: true, detail: "updater said so")
        )
        XCTAssertNil(snapshot.runtime?.status, "认不出的取值只能读成 nil")
        XCTAssertEqual(snapshot.runtime?.rawStatus, "self-updated", "原文要留着，人才查得动")
        XCTAssertFalse(UpdatePanel.runtimeIsUsable(snapshot), "认不出来绝不能当成换上")
        XCTAssertEqual(UpdatePanel.runtimeAttention(snapshot), .attention)
        let text = UpdatePanel.runtimeText(snapshot)
        XCTAssertTrue(text.contains("self-updated"), "要把原文报出来：\(text)")
        XCTAssertTrue(text.contains("认不出来"), text)
        XCTAssertFalse(text.contains("已换上"), text)
        XCTAssertTrue(text.contains("updater said so"), "这一态也该看得见原话：\(text)")
        XCTAssertTrue(text.contains("请重新运行安装程序"), text)
    }

    /// 反向变异：**把 `<那份更新器的路径>` 这类占位符留在界面上**（根证书那一卡曾经就这么
    /// 显示过），或把内部变量名当成给用户看的句子。这一页要么给出真实路径，要么用中文说清
    /// 去哪儿做；尖括号里的模板字符串一律算违规。
    func testRuntimeCopyNeverShowsAnAngleBracketPlaceholder() throws {
        let shapes: [(String, UpdatePanel.Snapshot?)] = [
            ("refreshed 核对过", try runtimeSnapshot(runtimeRecord(status: "refreshed", agentVerified: true))),
            ("refreshed 没核对", try runtimeSnapshot(runtimeRecord(status: "refreshed", agentVerified: false))),
            ("failed", try runtimeSnapshot(runtimeRecord(status: "failed", code: "runtime-stale",
                                                          detail: "the loaded job still names the old command line"))),
            ("failed 且没有路径", try runtimeSnapshot(
                runtimeRecord(status: "failed", version: nil, cliPath: nil, previousCliPath: nil))),
            ("kept", try runtimeSnapshot(runtimeRecord(status: "kept", code: "auto-disabled"))),
            ("skipped", try runtimeSnapshot(
                runtimeRecord(status: "skipped", version: nil, cliPath: nil, previousCliPath: nil))),
            ("认不出的状态", try runtimeSnapshot(runtimeRecord(status: "looks-refreshed"))),
            ("旧安装（记录为 null）", try snapshotWithNullRuntime()),
            ("没读到状态", nil),
        ]
        for (label, snapshot) in shapes {
            let text = UpdatePanel.runtimeText(snapshot)
            XCTAssertFalse(text.contains("<"), "\(label) 的文案里有尖括号占位符，用户按它做不了任何事：\(text)")
            XCTAssertFalse(text.contains(">"), "\(label) 的文案里有尖括号占位符：\(text)")
            XCTAssertFalse(text.contains("stateRoot"), "\(label) 把内部变量名当成了给用户看的句子：\(text)")
            XCTAssertFalse(text.contains("cliPath"), "\(label) 报的是字段名而不是路径：\(text)")
            XCTAssertFalse(text.contains("agentVerified"), "\(label) 该用中文说这件事：\(text)")
        }
    }

    /// 这一项读不懂时，其余那一行照常有效：不能因为它就把版本与按钮理由一起丢掉
    /// （与根证书那一卡同一条规矩）。
    /// 反向变异：**`runtime` 里多一个没声明的键、或状态认不出，就整行判成读不到**。
    func testUnreadableRuntimeDoesNotVoidTheWholeLine() throws {
        let line = documentedLine(
            command: "status", status: "applied", code: nil, exitCode: 0, ok: true, message: nil,
            state: [
                "status": "applied", "current": "1.5.2", "latest": "1.5.2",
                "lastCheckAt": iso(-60), "disabled": false, "autoApply": true,
                "runtime": ["status": "who-knows", "extraKeyNobodyDeclared": true, "agentVerified": true],
            ]
        )
        guard case .success(let snapshot) = UpdatePanel.parseLine(line) else {
            return XCTFail("这一行其余部分读得出来：\(line)")
        }
        XCTAssertEqual(snapshot.reportedStatus, .applied)
        XCTAssertEqual(snapshot.current, "1.5.2")
        XCTAssertNil(snapshot.runtime?.status, "认不出的状态只能读成读不懂")
        XCTAssertEqual(snapshot.runtime?.rawStatus, "who-knows")
        XCTAssertFalse(UpdatePanel.runtimeIsUsable(snapshot))
        XCTAssertFalse(UpdatePanel.runtimeText(snapshot).contains("已换上"))
    }

    // MARK: - 夹具

    private func pointerFile(in sandbox: URL) -> String {
        sandbox.appendingPathComponent(UpdatePanel.pointerFileName).path
    }

    private func documentedPointer(in sandbox: URL, cli: String) -> String {
        let body: [String: Any] = [
            "updaterCli": cli,
            "installRoot": sandbox.path,
            "agentLabel": "com.glasspane.update",
            "registeredAt": iso(-86_400),
        ]
        return jsonData(body)
    }

    private func readArgsLog(in sandbox: URL) throws -> String {
        let path = sandbox.appendingPathComponent("args.log").path
        return (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
    }

    /// The sandbox comes from `TestSandbox`, not from a hand-composed
    /// `NSTemporaryDirectory()`: the isolation gate bans peeking at the temp root
    /// by hand (round 7's rule — being under shared temp is a naming convention
    /// any other process may also pick, not isolation), and that gate reddened on
    /// the first version of this file. `TestSandbox.directory` is the admitted
    /// route and runtime-checks every path it hands out.
    private func makeSandbox() throws -> URL {
        let directory = URL(fileURLWithPath: TestSandbox.directory("update-panel"), isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    /// 一个"照契约回一行、按契约退出"的假 node：它不看 `$1` 指向的那个脚本，
    /// 只把收到的参数记进 `args.log`，打印那一行，然后以给定码退出。
    private func writeFixtureNode(dir: URL, jsonLine: String, exitCode: Int32) throws -> URL {
        let path = dir.appendingPathComponent("node").path
        let body = """
        #!/bin/sh
        dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
        printf '%s\\n' "$*" >> "$dir/args.log"
        printf '%s\\n' '\(shellSingleQuoted(jsonLine))'
        exit \(exitCode)
        """
        try body.write(toFile: path, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        return URL(fileURLWithPath: path)
    }

    private func shellSingleQuoted(_ text: String) -> String {
        text.replacingOccurrences(of: "'", with: "'\\''")
    }

    /// 契约那一行的构造器：外层是命令结论，`state` 里是状态文档。
    private func documentedLine(
        command: String, status: String?, code: String?, exitCode: Int, ok: Bool,
        message: String?, state: [String: Any]?
    ) -> String {
        var wrapper: [String: Any] = ["command": command, "exitCode": exitCode, "ok": ok]
        wrapper["status"] = status
        wrapper["code"] = code
        wrapper["message"] = message
        if let state { wrapper["state"] = state }
        return jsonData(wrapper)
    }

    private func jsonData(_ object: [String: Any]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: object, options: [])
        return String(data: data, encoding: .utf8)!
    }

    // MARK: - 束与 caRoots 的夹具

    /// 状态根下写一份束，返回面板应当找到的那个路径。
    private func writeCaBundle(in sandbox: URL, text: String) throws -> String {
        let path = sandbox.appendingPathComponent(UpdatePanel.caBundleFileName).path
        try text.write(toFile: path, atomically: true, encoding: .utf8)
        return path
    }

    /// 假 node 报回来的那一句：它只说自己有没有收到那个键。
    private func readEnvLog(in sandbox: URL) throws -> String {
        try String(contentsOfFile: sandbox.appendingPathComponent("env.log").path, encoding: .utf8)
    }

    /// 一个"把自己收到的那个变量原样报回来"的假 node。
    ///
    /// 与 `writeFixtureNode` 分开写而不是改它：这批测试要看的正是多出来的那一句，
    /// 而 `${VAR+set}` 分得清"根本没这个键"与"有一个空值"——面板的规矩是不设而非设空
    /// （设空会静默覆盖操作者从终端带进来的那一份信任），光看 `$VAR` 分不出这两种。
    private func writeEnvironmentAwareNode(dir: URL, jsonLine: String, exitCode: Int32) throws -> URL {
        let path = dir.appendingPathComponent("node").path
        let body = """
        #!/bin/sh
        dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
        if [ -n "${NODE_EXTRA_CA_CERTS+set}" ]; then
          printf 'ca-present:%s\\n' "$NODE_EXTRA_CA_CERTS" >> "$dir/env.log"
        else
          printf 'ca-absent\\n' >> "$dir/env.log"
        fi
        printf '%s\\n' '\(shellSingleQuoted(jsonLine))'
        exit \(exitCode)
        """
        try body.write(toFile: path, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        return URL(fileURLWithPath: path)
    }

    /// 那一行里 `caRoots` 的三种存在方式：整个没有（传 nil）、写着 null（传 `NSNull()`）、
    /// 带着一份记录（传一个字典）。三者走的是同一条真解析路径。
    private func caStateLine(caRoots: Any?) -> String {
        var state: [String: Any] = [
            "status": "up-to-date", "current": "1.4.0", "latest": "1.4.0",
            "lastCheckAt": iso(-60), "disabled": false, "autoApply": true,
        ]
        if let caRoots { state["caRoots"] = caRoots }
        return documentedLine(command: "status", status: "up-to-date", code: nil, exitCode: 0, ok: true,
                              message: nil, state: state)
    }

    /// 投影一律由 `parseLine` 造：手搓 Snapshot 会把"解码这一环"漏在测试外面。
    private func parsed(_ line: String) throws -> UpdatePanel.Snapshot {
        var value: UpdatePanel.Snapshot?
        if case .success(let snapshot) = UpdatePanel.parseLine(line) { value = snapshot }
        return try XCTUnwrap(value, "这一行该读得出来：\(line)")
    }

    private func caRootsSnapshot(status: String, certs: Int?, detail: String?) throws -> UpdatePanel.Snapshot {
        var record: [String: Any] = [
            "status": status,
            "path": "/Users/x/.glasspane/ca-roots.pem",
            "exportedAt": iso(-300),
        ]
        // 没给的那个字段写成 JSON `null`（不是把键省掉）：这一项的两面都要被读到过。
        if let certs { record["certs"] = certs } else { record["certs"] = NSNull() }
        if let detail { record["detail"] = detail } else { record["detail"] = NSNull() }
        return try parsed(caStateLine(caRoots: record))
    }

    private func snapshotWithoutCaRoots() throws -> UpdatePanel.Snapshot {
        return try parsed(caStateLine(caRoots: nil))
    }

    /// 这一项整个写着 `null`：契约里它与"没有这一项"是同一个意思，但它是另一种输入，
    /// 必须单独造一次（把 `null` 读成一份记录、或读成 `ok`，只有这一条抓得住）。
    private func snapshotWithNullCaRoots() throws -> UpdatePanel.Snapshot {
        return try parsed(caStateLine(caRoots: NSNull()))
    }

    // MARK: - runtime 的夹具

    /// 那一行里 `runtime` 的三种存在方式：整个没有（传 nil）、写着 null（传 `NSNull()`）、
    /// 带着一份记录（传一个字典）。三者走的是同一条真解析路径。
    private func runtimeStateLine(runtime: Any?) -> String {
        var state: [String: Any] = [
            "status": "applied", "current": "1.5.2", "latest": "1.5.2",
            "lastCheckAt": iso(-60), "disabled": false, "autoApply": true,
        ]
        if let runtime { state["runtime"] = runtime }
        return documentedLine(command: "status", status: "applied", code: nil, exitCode: 0, ok: true,
                              message: nil, state: state)
    }

    /// 一份按契约写全的换版记录：必填的五个键都在，没给的字段写成 JSON `null`
    /// （不是把键省掉）——与 `caRootsSnapshot` 同一做法，两种存在方式都要被读到过。
    /// 要造"某个键整个不存在"就在返回的字典上 `removeValue(forKey:)`。
    private func runtimeRecord(status: String,
                               version: Any? = "1.5.2",
                               cliPath: Any? = UpdatePanelTests.runtimeCli,
                               previousCliPath: Any? = UpdatePanelTests.previousRuntimeCli,
                               agentVerified: Any? = nil,
                               code: Any? = nil,
                               detail: Any? = nil) -> [String: Any] {
        var record: [String: Any] = ["status": status, "at": iso(-300)]
        record["version"] = version ?? NSNull()
        record["cliPath"] = cliPath ?? NSNull()
        record["previousCliPath"] = previousCliPath ?? NSNull()
        record["agentVerified"] = agentVerified ?? NSNull()
        record["code"] = code ?? NSNull()
        record["detail"] = detail ?? NSNull()
        return record
    }

    private func runtimeSnapshot(_ record: [String: Any]) throws -> UpdatePanel.Snapshot {
        try parsed(runtimeStateLine(runtime: record))
    }

    /// 这份安装是在"更新器自己换版"之前装出来的：状态里根本没有这一项。
    private func snapshotWithoutRuntime() throws -> UpdatePanel.Snapshot {
        try parsed(runtimeStateLine(runtime: nil))
    }

    /// 这一项整个写着 `null`：与"没有这一项"同一意思，但它是另一种输入，必须单独造一次。
    private func snapshotWithNullRuntime() throws -> UpdatePanel.Snapshot {
        try parsed(runtimeStateLine(runtime: NSNull()))
    }

    @MainActor
    private func waitUntil(timeoutSeconds: Int = 15, _ condition: () -> Bool) async {
        for _ in 0..<(timeoutSeconds * 20) {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        _ = condition()
    }
}
