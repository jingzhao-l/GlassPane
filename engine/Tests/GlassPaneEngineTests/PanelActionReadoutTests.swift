import XCTest
@testable import glasspane_settings

/// 面板的"写了没人读"闸 + 重启动作的实测结论。
///
/// 这条闸存在的原因是一次真实的静默失效：`ConsoleModel` 把清理/删除的全部结论
/// 折算进 `lastActionMessage`（`ConsoleCliChannelTests` 还逐条测过它算得对不对），
/// 而**没有任何视图读它**。于是"确认清理"点下去只是关掉确认表：删了几条、失败在
/// 哪、要不要重启，用户一个都看不到。消息算得越仔细，测试越绿，界面上就越安静。
///
/// 判据形状抄 `PanelDaemonCommandContractTests`：从源码文本对照两张表，而不是
/// 信任何一方的自述。注释先行剥除——把结论写在注释里不算有人读了它，
/// 一条会把注释当读者的闸，等于鼓励删注释换绿。
final class PanelActionReadoutTests: XCTestCase {

    /// 仓库根：测试文件在 `engine/Tests/GlassPaneEngineTests/` 下。
    private var panelDir: String {
        var url = URL(fileURLWithPath: #filePath)
        // …/engine/Tests/GlassPaneEngineTests/<this>.swift → 上溯四级到仓库根
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("engine/Sources/glasspane-settings").path
    }

    private func sources() throws -> [String: String] {
        guard let names = try? FileManager.default.contentsOfDirectory(
            at: URL(fileURLWithPath: panelDir), includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]) else {
            throw XCTSkip("读不到面板源码目录 \(panelDir)；这一条对照在没有该目录的环境里不作数")
        }
        var out: [String: String] = [:]
        for url in names {
            let name = url.lastPathComponent
            guard name.hasSuffix(".swift"),
                  let text = try? String(
                    contentsOfFile: panelDir + "/" + name, encoding: .utf8) else { continue }
            out[name] = Self.stripComments(text)
        }
        XCTAssertGreaterThanOrEqual(out.count, 10,
            "面板源码只扫到 \(out.count) 个文件，这条闸已经在看不到东西的地方")
        return out
    }

    /// 整行注释与行尾注释一律先去掉。判定"有没有人读过这个状态"只许看代码。
    nonisolated static func stripComments(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).map { rawLine in
            var line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("///") || trimmed.hasPrefix("//")
                || trimmed.hasPrefix("/*") || trimmed.hasPrefix("*") {
                return ""
            }
            if let slash = line.range(of: "//"),
               !String(line[..<slash.lowerBound]).contains("\"") {
                line = String(line[..<slash.lowerBound])
            }
            return line
        }.joined(separator: "\n")
    }

    /// 模型文件（状态真源）与视图文件（状态的读者）分开算，免得模型内部
    /// 一处自读自写被当成"有人消费了它"。
    private func splitFiles(_ sources: [String: String]) -> (models: [String: String], views: [String: String]) {
        var models: [String: String] = [:]
        var views: [String: String] = [:]
        for (name, text) in sources {
            if name.hasSuffix("Model.swift") { models[name] = text } else { views[name] = text }
        }
        return (models, views)
    }

    nonisolated static func publishedNames(in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(
            pattern: #"@Published\s+(?:private\(set\)\s+)?var\s+([A-Za-z_][A-Za-z0-9_]*)"#) else {
            XCTFail("正则写坏了")
            return []
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        var names: [String] = []
        regex.enumerateMatches(in: text, range: range) { match, _, _ in
            guard let match, match.numberOfRanges > 1,
                  let group = Range(match.range(at: 1), in: text) else { return }
            names.append(String(text[group]))
        }
        return names
    }

    /// 这个属性在这个文件里有没有被**读**过：出现它的那一行，既不是它的声明，
    /// 也不是对它的赋值。
    nonisolated static func hasRead(name: String, in text: String) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: name)
        guard let occurrence = try? NSRegularExpression(pattern: "\\b" + escaped + "\\b"),
              let assignment = try? NSRegularExpression(
                pattern: "^(?:self\\.)?" + escaped + "\\s*=(?!=)") else {
            XCTFail("正则写坏了：\(name)")
            return false
        }
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine).trimmingCharacters(in: .whitespaces)
            let lineRange = NSRange(line.startIndex..<line.endIndex, in: line)
            guard occurrence.firstMatch(in: line, range: lineRange) != nil else { continue }
            // 声明行与对它的赋值都不算读者
            if line.contains("@Published") { continue }
            if line.hasPrefix("var " + name) { continue }
            if assignment.firstMatch(in: line, range: lineRange) != nil { continue }
            return true
        }
        return false
    }

    /// 主闸：面板模型里每一个 `@Published` 状态，都必须至少有一个读者。
    func testEveryPublishedPanelStateIsReadSomewhere() throws {
        let (models, views) = splitFiles(try sources())
        var scanned = 0
        var unread: [String] = []
        for (name, text) in models.sorted(by: { $0.key < $1.key }) {
            for property in Self.publishedNames(in: text) {
                scanned += 1
                let readInOwnFile = Self.hasRead(name: property, in: text)
                let readInView = views.values.contains { Self.hasRead(name: property, in: $0) }
                if !readInOwnFile && !readInView {
                    unread.append("\(name).\(property)")
                }
            }
        }
        // 反向闸：扫描本身也要能被证伪。扫不到足够多的状态，说明写法变了、
        // 这条闸已经在看不到东西的地方——那必须炸，不许静默"全通过"。
        XCTAssertGreaterThanOrEqual(scanned, 30,
            "只扫到 \(scanned) 个 @Published 状态，这条闸已经不作数了")
        XCTAssertTrue(unread.isEmpty,
            "这些面板状态被写入却没有任何读者，用户看不见它们承载的结论：" + unread.joined(separator: ", "))
    }

    /// 具名的一半：清理/删除的结论必须落在控制台根视图上（挂在页签之外，所以从
    /// 任何一页按下的动作都看得见），且带着可自动化找到的标识与一个关闭入口
    /// （否则一次结论会永久挂着，下一次动作换没换都看不出来）。
    func testPruneAndRemoveVerdictsAreRenderedWithAnIdentifier() throws {
        let sources = try sources()
        let root = try XCTUnwrap(sources["ConsoleRootView.swift"])
        XCTAssertTrue(root.contains("console.lastActionMessage"),
            "控制台不再渲染动作结论：清理/删除按钮按下去又没有结果了")
        // 只"读到"还不够：反向破坏证明过——把 .safeAreaInset 那一行摘掉，结论条就
        // 变成一个算好了却不在视图树里的分支，而上面那条断言照样绿。挂点必须一起钉。
        XCTAssertTrue(root.contains("{ actionOutcomeStrip }"),
            "结论条算出来了却没挂进视图树：它仍然只是一个没人渲染的分支")
        XCTAssertTrue(root.contains("gp-action-message"),
            "动作结论必须有可指认的标识，否则面板验证点不到它")
        XCTAssertTrue(root.contains("console.dismissActionMessage()"),
            "动作结论收不掉，下一次动作的结论就无法核对")
        let model = try XCTUnwrap(sources["ConsoleModel.swift"])
        for action in ["previewTestResiduePrune", "confirmPrune", "removeProject"] {
            XCTAssertTrue(model.contains("func " + action),
                "\(action) 不在了：这条闸的正向一半（写入动作仍在产生结论）失效")
        }
        // 闸本身不许只看一眼就过：模型里那个"没有 daemon 就不许假装执行"的守卫
        // 必须在三个动作上都成立。
        XCTAssertEqual(
            model.split(separator: "\n").filter {
                $0.contains("guard canRunDaemonCLI else")
            }.count, 3,
            "写入动作里只有部分设了 daemon 闸：剩下的那一条会在读不到程序路径时静默关掉确认表")
    }
}

// MARK: - 重启动作：只有实测才允许收起"需要重启"

/// `restartDaemon()` 从前是 `try? process.run()` 加一句定时 hello：起没起来、
/// 换没换进程都不落进状态，调用方（项目页横幅）因此一律按"重启好了"清旗。
/// 这里钉住折算规则本身——两个纯函数就是那条指示器唯一的点亮条件。
@MainActor
final class DaemonRestartOutcomeTests: XCTestCase {

    func testVerdictRequiresAnActualPidChange() {
        XCTAssertEqual(
            SettingsModel.restartVerdict(pidBefore: 100, pidAfter: 200),
            .confirmed(previousPid: 100, currentPid: 200))
        // daemon 本来读不到，重启后有了进程号：这也算换新进程。
        XCTAssertEqual(
            SettingsModel.restartVerdict(pidBefore: nil, pidAfter: 200),
            .confirmed(previousPid: nil, currentPid: 200))
        XCTAssertEqual(
            SettingsModel.restartVerdict(pidBefore: 100, pidAfter: 100),
            .unchanged(pid: 100),
            "同一个进程号回话＝没换过进程，不许点亮")
    }

    /// 诚实性的那一条：读不到回话**不是**成功。
    func testVerdictWithoutAReadbackIsNeverAConfirmation() {
        XCTAssertEqual(
            SettingsModel.restartVerdict(pidBefore: 100, pidAfter: nil),
            .unchanged(pid: 100),
            "hello 没答话时不许把指示器点亮")
        XCTAssertEqual(
            SettingsModel.restartVerdict(pidBefore: nil, pidAfter: nil),
            .unchanged(pid: nil))
    }

    func testLaunchctlStepOutcomeIsSplitFromThePidCheck() {
        // 起不了进程与退出码非 0 是两件事，各自都得挡住"重启成功"。
        XCTAssertEqual(SettingsModel.restartLaunchStepOutcome(nil), .spawnFailed)
        XCTAssertEqual(
            SettingsModel.restartLaunchStepOutcome((output: "", errorOutput: "Could not find service", status: 3)),
            .launchctlFailed(status: 3, detail: "Could not find service"))
        XCTAssertNil(SettingsModel.restartLaunchStepOutcome((output: "", errorOutput: "", status: 0)),
                     "退出码 0 才交给 pid 对照去判")
    }

    /// 每一个失败结局都必须自己给出下一步：禁用/失败态不许只说一句"失败了"。
    func testEveryFailureOutcomeNamesTheNextMove() {
        let cases: [(SettingsModel.DaemonRestartOutcome, String)] = [
            (.launchctlFailed(status: 3, detail: "Could not find service."), "launchctl"),
            (.unchanged(pid: nil), "launchctl print"),
            (.unchanged(pid: 4242), "重启后台服务"),
            (.spawnFailed, "手动退出"),
            (.inFlight, "正在重启"),
            (.confirmed(previousPid: 1, currentPid: 2), "新进程"),
        ]
        for (outcome, needle) in cases {
            let text = SettingsModel.restartOutcomeText(
                for: outcome, uid: 501, jobLabel: SettingsModel.launchdLabel)
            XCTAssertNotNil(text, "\(outcome) 没有面向用户的说法")
            XCTAssertTrue(text?.contains(needle) == true,
                "\(outcome) 的文案里没有下一步动作 \(needle)：\(text ?? "nil")")
        }
        XCTAssertNil(SettingsModel.restartOutcomeText(
            for: .idle, uid: 501, jobLabel: SettingsModel.launchdLabel),
            "还没重启过时不许凭空出现一句结论")
    }

    /// 那句"核对作业"必须指得到真实作业标签与真实 uid，否则它是一条走不通的出路。
    func testTheNextMovePointsAtTheRealJob() {
        let text = SettingsModel.restartOutcomeText(
            for: .unchanged(pid: nil), uid: 501, jobLabel: SettingsModel.launchdLabel) ?? ""
        XCTAssertTrue(text.contains("gui/501/com.glasspane.daemon"),
            "重启失败时给出的核对入口指不到真实作业：\(text)")
    }
}
