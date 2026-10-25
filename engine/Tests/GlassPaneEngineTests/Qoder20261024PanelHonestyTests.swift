import XCTest
import Foundation
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 2026-10-24 面板诚实度这一泳道的四条闸（E4 / E5 / E2 / F1 的另一半）。
///
/// 共同形状是同一句话：**面板只许呈现后台服务与更新器实测到的结果**，并且给出的
/// 下一步必须真的走得通。四条发现各自是这一句话的一种破法：
///  · **E4** 更新器的英文原话让人按 "Install update"，这一屏那枚写着「安装更新」——
///    两个名字对不上号，读者手上就没有下一步（`updater/lib/policy.js:70`、`apply.js:1438`）。
///  · **E5** `needs-consent` 的 `non-default-state-dir` 那一档只把人支去读 status，
///    而更新器自己早就备了一条走得完的 `apply --state-dir … --consent state-dir`：
///    一道**人签了字就过得去**的门被说成一扇只能看的门。
///  · **E2** 配方那一屏把"形状合法"写成"daemon 校验通过"，而本构建没有任何一层执行配方
///    （`RecipeLoader.validate` 唯一调用点是 `main.swift:1195` 的 `--recipe-validate`）；
///    内置模板的 `observe` 步还写着 `observe` 根本不读的 `selector`。
///  · **F1 的另一半** `UpdateModel` 采纳 `hello.stateRoot` 时没有闸，而同一条判据
///    （`StateRootArgument.rejection(for:)`）已经接到 `ConsoleModel` 的采纳点上——
///    两条腿各自采纳同一个值时，只装一处就是半修。
///
/// REVERSE 总表（每条测试自己再写一遍）：
///  · 把按钮标题/标识在视图里另写一份 → `testApplyButtonTitleAndItsIdentifierHaveASingleAuthor` 红；
///  · 把那句英文原话的指认去掉、或让它无条件出现 → `testTheEnglishRemedyIsIdentifiedAs…` 红；
///  · 把 `.none` 档里 `code`/`stateRoot` 的转述接回去（只留 `… status`）→
///    `testStateDirGateTranscribes…` 与 `…SaysWhatPressingItWouldDo` 红；
///  · 反过来给别的门也编一条命令 → `testNoCommandIsTranscribed…` 红；
///  · 模板的 `observe` params 改回 `{"selector":{…}}` → 第 9、10 条红（一张表都指不过）；
///  · 校验结论回到"daemon 校验通过。" → `testValidVerdictSaysTheShapeOnly…` 红；
///  · 把 `UpdateModel` 采纳点那句 `StateRootArgument.rejection(for:)` 去掉 → F1 三条全红。
///
/// 判定层（`UpdatePanel`、`RecipesTabView` 的纯函数、`UpdateModel`）是直接**跑**的；
/// 只有单测点不到的 SwiftUI 表面才退回读源码，那几条名字里都带 `Author`/`OnScreen`。
final class Qoder20261024PanelHonestyTests: XCTestCase {

    private let updater = "/Users/x/.glasspane/runtime/1.6.0/updater/cli.js"
    private let root = "/Users/x/.glasspane"

    // MARK: - E4：英文 remedy 与中文按钮名必须指着同一枚

    /// 这一枚的名字与标识**只有一个作者**（`UpdatePanel`），视图从那里取。
    /// 两处各写一遍就是这条缺陷的根因：改了名字的那一处，另一处不会跟着改。
    ///
    /// REVERSE：把视图里那枚改回 `Button("安装更新")` 硬编码（或把标识写成第二个
    /// `"gp-update-apply"` 字面量、或把标识挪到「立即检查」那枚）→ 这一条红。
    func testApplyButtonTitleAndItsIdentifierHaveASingleAuthor() throws {
        XCTAssertEqual(UpdatePanel.applyButtonTitle, "安装更新",
                       "规格钉的是这四个字，不许为迁就英文原话改成英文")
        XCTAssertEqual(UpdatePanel.applyButtonIdentifier, "gp-update-apply",
                       "自动化与无障碍按这个标识选元素，改名等于把它们的路删了")

        let source = try readSource("engine/Sources/glasspane-settings/UpdateTabView.swift")
        guard let buttonAt = source.range(of: "Button(UpdatePanel.applyButtonTitle)") else {
            return XCTFail("按钮标题必须取自 UpdatePanel.applyButtonTitle，否则文案与标题会各自漂移")
        }
        let chained = source[buttonAt.lowerBound...].prefix(400)
        XCTAssertTrue(chained.contains(".accessibilityIdentifier(UpdatePanel.applyButtonIdentifier)"),
                      "被标识的那一枚必须就是标题取自常量的那一枚：\(chained)")
        XCTAssertFalse(source.contains("Button(\"安装更新\")"),
                       "标题在视图里又写了一遍：常量与屏幕从此可以各自漂移")
        XCTAssertFalse(source.contains("\"gp-update-apply\""),
                       "标识在视图里又写了一遍：同上")
        // 禁用理由那一行挂的名字与按钮同名，否则「『X』现在按不动」指的是另一枚。
        XCTAssertTrue(source.contains("reasonLine(key: \"apply\", title: UpdatePanel.applyButtonTitle"),
                      "禁用理由的标题也要取自同一个常量")
        // 那句指认要真的上屏：挂在没人读的常量上等于没说。
        XCTAssertTrue(source.contains("UpdatePanel.remedyButtonGloss(forVerbatim: text)"),
                      "原样显示更新器英文原话的那一张卡，必须把指认接在旁边")
    }

    /// 原样显示更新器英文原话的地方，必须把那句里的 "Install update" 指到这一屏那枚上。
    /// 判据是"这句话里真的出现过那个英文名"——所以它不会出现在别的失败句下面。
    ///
    /// REVERSE：去掉 `contains(updaterEnglishButtonName)` 那道判据（指认无条件出现）→
    /// 第二条红；把 `applyButtonTitle` 换了名字而指认还写旧名字 → 第一条红（指认落空）。
    func testTheEnglishRemedyIsIdentifiedAsTheButtonThisPageDraws() {
        // 更新器那两句的原话形状（`policy.js:70` 与 `apply.js:1438`）。
        let majorSentence = "version 2.0.0 is a major upgrade from 1.4.0: contract changes need a person, "
            + "so press \"Install update\" when you want it."
        let deferredSentence = "automatic update is switched off, so nothing was applied. "
            + "Press \"Install update\" in the GlassPane panel to do it by hand."
        for verbatim in [majorSentence, deferredSentence] {
            guard let gloss = UpdatePanel.remedyButtonGloss(forVerbatim: verbatim) else {
                return XCTFail("英文原话点到那一枚时必须有指认，否则读者对不上号：\(verbatim)")
            }
            XCTAssertTrue(gloss.contains(UpdatePanel.updaterEnglishButtonName), gloss)
            XCTAssertTrue(gloss.contains(UpdatePanel.applyButtonTitle),
                          "指认要说出屏幕上看得见的那几个字：\(gloss)")
            XCTAssertTrue(gloss.contains("标着"), "描述性指代：让读者按屏幕上的字找到它：\(gloss)")
            XCTAssertFalse(gloss.contains("Install update button"),
                           "不许把界面文案改成英文去迁就原话：\(gloss)")
        }
        // 别的失败句里没有那个名字，就不许凭空长出一句指认。
        XCTAssertNil(UpdatePanel.remedyButtonGloss(
            forVerbatim: "the running daemon is busy; nothing was replaced"
        ), "无关的句子上不出现指认")
    }

    /// 面板自己那句"该做什么"也必须用同一个名字，且整句仍是用户语言。
    ///
    /// REVERSE：把 `promptText` 那一支改回另一套叫法（例如「立即安装」）→ 这一条红：
    /// 屏幕上同时存在两种叫法，读者就不知道它们是不是同一枚。
    func testPanelCopyThatNamesTheButtonUsesTheSameName() {
        let staged = UpdatePanel.Snapshot(reportedStatus: .available, storedStatus: .available,
                                          stagedVersion: "1.6.3")
        let prompt = UpdatePanel.promptText(snapshot: staged, status: .available,
                                           now: Date(timeIntervalSince1970: 1_800_000_000)) ?? ""
        XCTAssertTrue(prompt.contains(UpdatePanel.applyButtonTitle), prompt)
        XCTAssertFalse(prompt.contains(UpdatePanel.updaterEnglishButtonName),
                       "这一页的下一步要用这一页的名字：\(prompt)")
    }

    // MARK: - E5：`non-default-state-dir` 那一档要给一条走得完的命令

    /// 更新器在那条拒绝里自己带的命令，面板**原样转述**（`updater` 换成这一页认出的那一份
    /// 程序——这台机器上没有叫 `updater` 的可执行文件），并说清跑不跑由人决定。
    ///
    /// REVERSE：把 `.none` 档里传给 `consentGateNextStepText` 的 `code`/`stateRoot` 接回去
    /// （回到只有一句 `… status`）→ 这一条红：那一档又只剩"这一道门只能看"。
    func testStateDirGateTranscribesTheUpdaterOwnRunnableCommand() {
        let buttons = UpdatePanel.buttons(for: .reading(
            .needsConsent, staged: false, current: "1.6.2", stagedVersion: "1.6.3",
            code: UpdatePanel.nonDefaultStateDirCode, updaterPath: updater, stateRoot: root
        ))
        let reason = buttons.applyReason ?? ""
        XCTAssertTrue(reason.contains("apply --state-dir"),
                      "更新器备着的那条走完这扇门的命令必须出现在面板上：\(reason)")
        XCTAssertTrue(reason.contains("--consent state-dir"),
                      "旗标名要照更新器写的说，不许在这一侧另发明一个：\(reason)")
        XCTAssertTrue(reason.contains(root), "转述的命令要点名这一页认的那个根：\(reason)")
        XCTAssertTrue(reason.contains(updater), "命令要点名这一页认出的那一份程序：\(reason)")
        XCTAssertFalse(reason.contains("`updater status`"), "不许指一条这台机器走不通的路：\(reason)")
        // 不代签、不代跑：面板这一侧的按钮仍是按不动的，也不带任何确认参数。
        XCTAssertFalse(buttons.applyEnabled, "面板不许替这台机器签这一道字")
        XCTAssertEqual(buttons.applyArguments, [], "按不动的按钮不许偷偷带上 --consent")
        XCTAssertFalse(buttons.consentEnabled, "这一道门不是面板能代签的那两种")
    }

    /// 那句转述必须把"这一枚按下去会发生什么"说清：这一枚什么都不会发生，
    /// 会动它的是人自己敲出去的那一条；确认只跟着那一次运行，定时那一次永远不带它。
    ///
    /// REVERSE：删掉说"会发生什么"的那半句（只留一条命令）→ 这一条红：
    /// 读者拿着一条会改动安装状态的命令，却不知道它动起来做什么、不做什么。
    func testStateDirGateSaysWhatPressingTheButtonWouldAndWouldNotDo() {
        let text = UpdatePanel.consentGateNextStepText(
            updaterPath: updater, stateRoot: root, code: UpdatePanel.nonDefaultStateDirCode
        )
        XCTAssertTrue(text.contains("按下去不会发生任何事"),
                      "要说清这一枚按下去会发生什么：\(text)")
        XCTAssertTrue(text.contains("跑不跑由你决定"), "不代跑：\(text)")
        XCTAssertTrue(text.contains("由你自己敲出去"), "跑它的是人，不是面板：\(text)")
        XCTAssertTrue(text.contains("定时"), "确认不写进默认值，定时那一次永远不带它：\(text)")
        XCTAssertTrue(text.contains("空闲"), "换版仍然只在后台服务空闲时动手：\(text)")
        XCTAssertFalse(text.contains("已执行") || text.contains("已经跑过"),
                       "不许把没跑过的说成跑过：\(text)")
        XCTAssertFalse(text.contains("立即检查"), "这一道门重跑检查只会原样再拒一次：\(text)")
    }

    /// 另外两道门与读不出根的那一帧**没有**这条命令，面板就不许现造一条：
    /// 转述的判据是"这一道门的作者真的备了它"，不是"给点什么总比给一半好"。
    ///
    /// REVERSE：把 `guard code == nonDefaultStateDirCode` 那道判据放宽（任何门都附命令）
    /// → 这一条红：面板把一条不存在的口令说成更新器给的。
    func testNoCommandIsTranscribedForGatesThatDoNotCarryOne() {
        let codes: [String?] = ["some-future-code", "release-unsigned", nil]
        for code in codes {
            let text = UpdatePanel.consentGateNextStepText(
                updaterPath: updater, stateRoot: root, code: code
            )
            XCTAssertFalse(text.contains("apply --state-dir"),
                           "code=\(code ?? "nil") 这一道门没备那条命令，面板不许替它编：\(text)")
            XCTAssertTrue(text.contains(updater), "读 status 那一句照旧点名这一页认出的程序：\(text)")
        }
        // 这一页连根都没认出来时，命令的 `--state-dir` 只能是半成品，所以整条都不给。
        let noRoot = UpdatePanel.consentGateNextStepText(
            updaterPath: updater, stateRoot: nil, code: UpdatePanel.nonDefaultStateDirCode
        )
        XCTAssertFalse(noRoot.contains("apply --state-dir"),
                       "没有根就不要给半条命令：\(noRoot)")
        XCTAssertTrue(noRoot.contains(updater))
    }

    /// 那个根是从 `hello` 与 `--state-dir` 进来的**不受信字节**，转述时必须按更新器自己
    /// 那条单引号规则包好——否则"下一步"本身就是一条注入。
    ///
    /// REVERSE：把 `RemedyCommand.quote(...)` 换成裸插值（或改成双引号）→ 这一条红。
    func testTranscribedStateDirIsQuotedSoTheNextStepStaysInert() {
        let nasty = "/tmp/a b/$(touch pwned)/it's here"
        let text = UpdatePanel.consentGateNextStepText(
            updaterPath: updater, stateRoot: nasty, code: UpdatePanel.nonDefaultStateDirCode
        )
        XCTAssertTrue(text.contains(RemedyCommand.quote(nasty)),
                      "根要按更新器那条单引号规则原样包好：\(text)")
        XCTAssertFalse(text.contains("--state-dir \(nasty)"),
                       "裸插值会让空格把一个参数切成两个：\(text)")
        XCTAssertTrue(text.contains("'\\''"), "单引号本身要按 shell 规则转义：\(text)")
        XCTAssertFalse(text.contains("<"), "不许给人一个尖括号模板：\(text)")
    }

    // MARK: - E2：配方那一半——"合法"只许说形状，模板形状要能被读它的那一层吃下

    /// 内置模板的 `params` 只许写**那一步点名的方法真读的键**。判据取自引擎那张表
    /// （`Dispatcher.acceptedParamKeys`，逐 handler 反查；`observe` 那两个键出自
    /// `Dispatcher.swift:164-171`），方法名对照在测试侧抄一份：`assert` 是配方词汇表，
    /// 线上叫 `assert_element`，两张表漂开时这条必须变红。
    ///
    /// REVERSE：把 `observe` 那一步的 params 改回 `{"selector":{"role":…,"title":…}}`
    /// → 这一条红（`selector` 不在 `observe` 读的那两个键里）。
    func testBuiltinTemplatesOnlyUseParamKeysTheNamedMethodReads() throws {
        // 配方词汇表 → 线上方法：`assert` 是文件里的名字，线上答的是 `assert_element`。
        // 这张对照是**测试侧抄的**（与 `UpdatePanelTests` 里那几份封闭清单同一写法）：
        // 两边漂开时必须变红，而不是跟着被测代码一起自证。
        let methodForKind: [String: EngineMethod] = [
            "observe": .observe, "act": .act, "assert": .assertElement,
        ]
        let claimed: [String: Set<String>] = [
            "observe": ["maxDepth", "role"],
            "act": ["selector", "action", "degrade"],
            "assert": ["selector", "property", "expected"],
        ]
        for (kind, expected) in claimed {
            XCTAssertEqual(Set(Dispatcher.acceptedParamKeys[methodForKind[kind]!] ?? []), expected,
                           "测试抄的「哪个方法读哪些键」与引擎那张表不一致：看 Dispatcher.swift:117-129")
        }
        let templates = RecipeTemplates.all + [
            RecipeTemplate(key: "slot", title: "编辑器首次占位", contents: RecipeTemplates.emptyEditorSlot)
        ]
        for template in templates {
            let steps = stepsOf(template.contents, template: template.key)
            XCTAssertFalse(steps.isEmpty, "\(template.key)：模板一步都没有")
            for (index, step) in steps.enumerated() {
                guard let method = methodForKind[step.kind] else {
                    XCTFail("\(template.key) 的第 \(index) 步用了这张对照表里没有的方法：\(step.kind)")
                    continue
                }
                let accepted = Set(Dispatcher.acceptedParamKeys[method] ?? [])
                for key in step.params.keys where !accepted.contains(key) {
                    XCTFail("\(template.key) 的第 \(index) 步（\(step.kind) → \(method.rawValue)）写了它不读的键 "
                        + "'\(key)'；那个方法只读 \(accepted.sorted().joined(separator: ", "))——"
                        + "形状过得了校验、真正读它的那一层接不下，这份模板就不是起点而是坑")
                }
            }
        }
    }

    /// 模板必须真的过本构建 ships 的那一层校验（`RecipeLoader.validate`），且**不**带
    /// "能跑"这种话：能跑与能校验是两件事。
    ///
    /// REVERSE：同上改回 `selector` 那份 params → 这一条也红（校验层按同一张表判缺陷）。
    func testBuiltinTemplatesPassTheValidatorThisBuildShips() throws {
        for template in RecipeTemplates.all + [
            RecipeTemplate(key: "slot", title: "编辑器首次占位", contents: RecipeTemplates.emptyEditorSlot)
        ] {
            let result = RecipeLoader.validate(Data(template.contents.utf8))
            XCTAssertTrue(result.valid, "\(template.key) 这份模板过不了自己的校验：\(result.errors)")
            XCTAssertTrue(result.errors.isEmpty, "\(template.key)：\(result.errors)")
        }
    }

    /// 「合法」那一屏的正文只说测到的事：形状合法、这一份构建没有运行它的入口、
    /// 刚才那一趟没执行任何一步，并且**不假装下一步存在**——这一页没有那枚按钮，
    /// 这句话就得直说没有。文案是用户语言：没有规格编号，也没有 `§`。
    ///
    /// REVERSE：把正文改回"daemon 校验通过。" → 这一条红（三句实话一起没了）。
    func testValidVerdictSaysTheShapeOnlyAndDeniesARunnerThatIsNotThere() throws {
        let body = RecipesTabView.validVerdictBody
        XCTAssertTrue(body.contains("形状"), body)
        XCTAssertTrue(body.contains("不会替你"), "要说清它不替你执行任何一步：\(body)")
        XCTAssertTrue(body.contains("这一页上没有「运行这份配方」那枚按钮"),
                      "不许假装这一页有那个入口：\(body)")
        XCTAssertTrue(body.contains("构建里也没有别的入口"),
                      "整份构建都没有，不只是这一页：\(body)")
        XCTAssertFalse(body.contains("daemon 校验通过"), "那句误导的假话不许回来：\(body)")
        XCTAssertFalse(body.contains("§"), "对外文案不许带规格编号：\(body)")
        XCTAssertNil(body.range(of: #"[RS]\d+-\d+"#, options: .regularExpression),
                     "对外文案不许带批次编号：\(body)")
        // 结论那一行的标题也跟着收窄：只说形状，不说「能跑」。
        let source = try readSource("engine/Sources/glasspane-settings/RecipesTabView.swift")
        XCTAssertTrue(source.contains("\"形状合法\""),
                      "标题也要说形状（读不出这一句就是那一行标题还写着光秃秃的「合法」）")
        XCTAssertTrue(source.contains("只校验结构、不执行这份配方"), "编辑器那一行也要说清不执行")
    }

    // MARK: - F1 的另一半：`UpdateModel` 采纳 `hello.stateRoot` 的闸

    /// 过闸用的判据**不在这一侧重抄**：采纳与否只跟着 `StateRootArgument.rejection(for:)` 的
    /// 答案走（同一个函数，`ConsoleModel` 的采纳点用的是它，daemon 的 `--state-dir` 也用它）。
    ///
    /// REVERSE：把 `adoptDaemonReport` 里那次 `rejection(for:)` 判断删掉（无条件采纳）→
    /// 这一条与下面两条红。
    @MainActor
    func testAdoptionFollowsTheEnginesJudgementAndNotACopyOfIt() {
        let kept = sandboxRoot("kept-judgement")
        for reported in ["/", "not/absolute/root", "--state-dir", sandboxRoot("usable-judgement")] {
            let model = UpdateModel(stateRoot: kept, nodePath: "/usr/bin/true", clock: Date.init)
            model.adoptDaemonReport(daemonStateRoot: reported, answered: true)
            let refused = StateRootArgument.rejection(for: reported) != nil
            XCTAssertEqual(model.refusedDaemonStateRoot != nil, refused,
                           "报 \(reported) 时这一侧的结论与引擎判据不一致（判据：\(refused)）")
            XCTAssertEqual(model.stateRoot == StateRoot(path: reported).path, !refused,
                           "被拒的根被采纳了，或能用的根没被采纳：\(reported)")
        }
    }

    /// 拒收时**保留上一个根**：这一页手里那个路径、指针位置、根证书束位置都不许跟着
    /// 那个不能信的自报值走（`engine.sock` 无 peer 鉴权，同用户一帧回话就能把更新器
    /// 的指针与那份束写到 `~` 这一类目录里）。
    ///
    /// REVERSE：拒收时仍把 `stateRootPath` 换掉（或把 `stateRootSource` 升格成
    /// `.daemonReported`）→ 这一条红。
    @MainActor
    func testARefusedReportedRootMovesNothingOnTheUpdatePage() {
        let kept = sandboxRoot("kept-nothing-moves")
        let model = UpdateModel(stateRoot: kept, nodePath: "/usr/bin/true", clock: Date.init)
        model.adoptDaemonReport(daemonStateRoot: "/", answered: true)

        XCTAssertEqual(model.stateRoot, kept, "被拒的根把这一页的根换掉了")
        XCTAssertEqual(model.pointerFile, kept + "/" + UpdatePanel.pointerFileName,
                       "更新器指针跟着被拒的根走：那份安装记录会落到不属于这台安装的地方")
        XCTAssertEqual(model.caBundleFile, kept + "/" + UpdatePanel.caBundleFileName)
        XCTAssertEqual(model.stateRootSource, .panelComputed, "被拒的一帧不许把出处升格成「这一帧上报的」")
        XCTAssertEqual(model.refusedDaemonStateRoot, "/")
        // 交给更新器的那条命令点名的仍是手里那个根。
        XCTAssertEqual(UpdateModel.arguments(for: .status, stateRoot: model.stateRoot)[2], kept)
    }

    /// 那一拒要说给屏幕上看：点名被拒的值、手里那个仍是上一个根、以及一个做得动的下一步。
    /// 措辞与 `ConsoleModel.refusedDaemonStateRootCaption` 同源（同一件事在两扇门上不许讲成两个故事）。
    ///
    /// REVERSE：只把它写进 stderr 而不进 `stateRootCaption` → 这一条红：屏幕上那一行
    /// 读起来仍像"这一页按的就是服务报的那个根"。
    @MainActor
    func testTheRefusalIsOnTheScreenWithTheValueAndTheNextStep() {
        let kept = sandboxRoot("kept-caption")
        let model = UpdateModel(stateRoot: kept, nodePath: "/usr/bin/true", clock: Date.init)
        model.adoptDaemonReport(daemonStateRoot: "/", answered: true)
        let caption = model.stateRootCaption
        XCTAssertTrue(caption.contains("拒"), "被拒这件事要在屏幕上看得见：\(caption)")
        XCTAssertTrue(caption.contains("后台服务这一帧报的根 /"), "要点名被拒的那一个值：\(caption)")
        XCTAssertTrue(caption.contains(kept), "要说清这一行讲的是上一个被采纳的根：\(caption)")
        XCTAssertTrue(caption.contains("--state-dir"), "下一步要给出做得动的那一条：\(caption)")
        XCTAssertTrue(caption.contains("刷新"), "下一步要说到重连那个动作：\(caption)")
        XCTAssertTrue(model.refusedDaemonStateRootCaption.hasPrefix("后台服务自报的状态根不能被这个面板采用"),
                      "措辞与 ConsoleModel 那句同源：\(model.refusedDaemonStateRootCaption)")
    }

    /// 一帧坏的不等于这一页失去写入能力：下一帧报来一个能用的根，拒绝要清掉、根要跟上。
    ///
    /// REVERSE：拒收后不再复位 `refusedDaemonStateRoot`（一次坏帧永久挂在屏上）→ 这一条红。
    @MainActor
    func testALaterUsableRootClearsTheRefusal() {
        let kept = sandboxRoot("kept-then-next")
        let model = UpdateModel(stateRoot: kept, nodePath: "/usr/bin/true", clock: Date.init)
        model.adoptDaemonReport(daemonStateRoot: "/", answered: true)
        XCTAssertNotNil(model.refusedDaemonStateRoot)
        let next = sandboxRoot("next-usable-root")
        model.adoptDaemonReport(daemonStateRoot: next, answered: true)
        XCTAssertEqual(model.stateRoot, next)
        XCTAssertNil(model.refusedDaemonStateRoot, "上一帧的拒绝不许跟着新根一直挂在屏幕上")
        XCTAssertFalse(model.refusedDaemonStateRootCaption.contains("拒"),
                       "没有拒绝时那一行不许留半个「拒」字")
        XCTAssertEqual(model.stateRootSource, .daemonReported)
    }

    /// 一个已经过 `StateRoot` 规整的沙箱根：模型的 init 存的是**交进去的那一份**，
    /// 而采纳点存的是规整后的那一份，先规整一次两条断言才是同一个数。
    private func sandboxRoot(_ label: String) -> String {
        StateRoot(path: TestSandbox.directory(label)).path
    }

    // MARK: - 夹具

    /// 仓库根：测试文件在 `engine/Tests/GlassPaneEngineTests/` 下。
    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.path
    }

    private func readSource(_ relative: String) throws -> String {
        let path = repoRoot + "/" + relative
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(relative)；这一条对照在没有该文件的环境里不作数")
        }
        return text
    }

    /// 一步的形状：`kind` 与它那份 `params` 的键名。读不出形状就报红，不猜。
    private struct TemplateStep {
        let kind: String
        let params: [String: Any]
    }

    private func stepsOf(_ json: String, template: String) -> [TemplateStep] {
        guard let root = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let raw = root["steps"] as? [[String: Any]] else {
            XCTFail("\(template)：这份模板读不出 {steps:[{kind, params}]} 的形状")
            return []
        }
        var steps: [TemplateStep] = []
        for (index, step) in raw.enumerated() {
            guard let kind = step["kind"] as? String,
                  let params = step["params"] as? [String: Any] else {
                XCTFail("\(template) 的第 \(index) 步没有 {kind, params} 这一对")
                continue
            }
            steps.append(TemplateStep(kind: kind, params: params))
        }
        return steps
    }
}
