import XCTest
@testable import glasspane_settings

/// 「更新」页判定层的验收（自动更新规格 §4 用户可见面、§5 默认开一键关、
/// §7 那一行 JSON 与退出码）。
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

    @MainActor
    private func waitUntil(timeoutSeconds: Int = 15, _ condition: () -> Bool) async {
        for _ in 0..<(timeoutSeconds * 20) {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        _ = condition()
    }
}
