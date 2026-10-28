import Testing
import Foundation
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 2026-10-28 · 设置面板五件 UI 缺陷的闸（B 面：文案与持久状态）。
///
/// 与同一批日常轮同一条分工：视图在单测里起不来（`EvidenceTabView` / `ApprovalsTabView`
/// 要 `@EnvironmentObject`，真窗口要 TCC），所以判据一律长在**折算层**（`ConsoleModel` /
/// `UpdatePanel` / `RecipesTabView` 那些 `nonisolated static` 纯函数）上，再各配一把源码
/// 形状闸钉住"视图画的确实是这一份判据"——只测折算函数不看视图，在本仓就是半修。
///
/// 五件共同的那件事：屏幕上每一枚能按的控件、每一句下一步、每一份留在本机的状态，
/// 都必须说得出它自己是什么、以及它替谁说话。
@MainActor
@Suite("Daily round 2026-10-28: panel controls, copy and persisted state")
struct DailyRound20261028PanelUiDefectTests {

    // MARK: - 夹具

    /// 一条读得出的档案（最小合法形状，与 `Qoder20261019PanelDefectsTests` 同源）。
    private static let pack = EvidencePack(
        operationId: "op_0123456789ABCDEFGHJKMNPQRS",
        createdAt: "2026-10-28T04:00:00.000Z",
        attribution: Attribution(level: .soft, contaminated: false),
        circuitBreaker: CircuitBreaker(level: .normal),
        signals: Signals(act: ActSignal(
            selector: Selector(role: "AXButton", title: "Submit"),
            action: .press,
            actConfirmed: true
        ))
    )

    /// 一条审批记录：`hash` 是它在签名链上的内容哈希，也是折叠状态里指认它的那个名字。
    private func ledgerRecord(
        _ approvalId: String, hash: String, type: String = "restore"
    ) -> ApprovalRecord {
        ApprovalRecord(
            approvalId: approvalId,
            operationRef: "op_0123456789ABCDEFGHJKMNPQRS",
            operationType: type,
            riskTier: .high,
            decision: .approve,
            approvedBy: ApprovalGate.autoApprover,
            reason: "回滚前登记",
            timestamp: "2026-10-28T04:00:00.000Z",
            prevHash: "",
            hash: hash
        )
    }

    private let updaterPath = "/Users/x/.glasspane/runtime/1.6.0/updater/cli.js"
    private let shownRoot = "/Users/x/work/other-machine/.glasspane"

    // MARK: - 缺陷 1：一枚能按却什么都不做的按钮（无声的 `return`）

    /// 拒绝那一支**走得到**，并且说得出"缺的是什么 + 下一步做什么"。
    ///
    /// 这一种帧是这一页自己承认存在的：`packLoad` 说这条档案已经读到，手里那份 `pack`
    /// 却是 nil（详情页 `packPendingOrFailed` 的 `.loaded` 那一支画的就是它）。控件的启用
    /// 判据只读 `packLoad`，正文读 `pack`，所以这一支不是纸上的分支。
    /// REVERSE：把 `openHTMLReport` 换回 `guard let pack else { return }`（下面那把形状闸红）；
    /// 把 `reportAction` 在 `pack == nil` 时改成回 `.render`（编译器就过不去，因为整包不存在）；
    /// 把那句话改成只说"报告没有写出来"（`下一步` 与 `刷新` 那两条红）。
    @Test("The report button's refusal branch speaks instead of returning silently")
    func reportRefusalBranchNamesWhatIsMissingAndTheNextStep() {
        let loaded = ConsoleModel.PackLoad.loaded(Self.pack)
        guard case .refuse(let message) = ConsoleModel.reportAction(pack: nil, packLoad: loaded)
        else {
            Issue.record("整包没到手时这一支必须拒绝：\(ConsoleModel.reportAction(pack: nil, packLoad: loaded))")
            return
        }
        #expect(!message.isEmpty, "一句空白的拒绝等于没说")
        #expect(message.contains("报告没有写出来"), "要说清这件事没做成，不许演成已经打开了：\(message)")
        #expect(message.contains("下一步"), "禁用态那句必须给得出下一步：\(message)")
        #expect(message.contains("刷新"), "给的下一步得是这一屏真做得动的那一步：\(message)")
        for forbidden in ["§", "packLoad", "P0", "R35", "specs/", "EvidencePack"] {
            #expect(!message.contains(forbidden), "给人读的一句话里不许有内部说法 \(forbidden)：\(message)")
        }
        // 整包在手是另一件事：不许把手里有的东西也拒掉。
        if case .render(let handed) = ConsoleModel.reportAction(pack: Self.pack, packLoad: loaded) {
            #expect(handed.operationId == Self.pack.operationId, "拒了一件做得成的事")
        } else {
            Issue.record("整包在手时这一支必须交出去")
        }
        // 按不动那三形态被绕过灰掉按钮点到时，说的还是这一枚自己那句禁用理由：
        // 一句话只有一个作者，不在这里现编第二套说法。
        for load in [ConsoleModel.PackLoad.none, .loading, .failed(reason: "这条档案读不出内容 ")] {
            guard case .refuse(let carried) = ConsoleModel.reportAction(pack: nil, packLoad: load) else {
                Issue.record("\(load) 这一支不该交出整包")
                continue
            }
            #expect(carried == ConsoleModel.reportButtonControl(packLoad: load).help,
                    "同一枚控件的两处说法漂开了：\(carried)")
        }
    }

    /// 形状闸：视图真的把那句拒绝接到了**已被渲染**的那条横幅上。
    /// REVERSE：恢复 `guard let pack else { return }` → 第一条红；把 `.refuse` 那一支丢掉
    /// 或改成 `return`（不写 `lastActionMessage`）→ 第二、三条红。
    @Test("Shape: the report button routes its refusal into the rendered readout")
    func ShapeTheReportButtonRoutesItsRefusalIntoTheRenderedReadout() throws {
        let view = try PanelSourceText.code("EvidenceTabView.swift")
        #expect(!view.contains("guard let pack else { return }"),
                "那一句无声的 return 回来了：控件看着能按、按下去什么都不发生")
        #expect(view.contains("ConsoleModel.reportAction(pack: pack, packLoad: packLoad)"),
                "这一枚的结局不再来自那份共用的判据，下一步就又是一处自写规则")
        #expect(view.contains("model.lastActionMessage = message"),
                "拒绝那句话没接到已被渲染的横幅——算好了却没读者，正是 lastActionMessage 当年的形状")
        // 启用判据仍是那一份（这次改动不许悄悄把控件改成永按不动来"修"无声）。
        #expect(view.contains("ConsoleModel.reportButtonControl(packLoad: packLoad)"),
                "「打开报告」的启用判据被搬走了：它得继续由这一页读到的读取结局决定")
    }

    // MARK: - 缺陷 2：给人读的句子夹带内部辩白，而命令指向另一个根

    /// 这一屏给出的**每一条**命令都带着这一页正在显示的那个状态根。
    ///
    /// 从前 `status` 那一句不带 `--state-dir`，而隔壁 `apply` 那一句带——两条命令读的是
    /// 两个根，屏幕上那份读数与用户敲出去那条命令答的就不是同一件事。
    /// REVERSE：把 `rootArgument` 只接到 `apply` 那一句上（`status` 又不带根）→ 第一条红；
    /// 把 `RemedyCommand.quote` 换成裸插值 → 第二条红（空格把一个参数切成两个）。
    @Test("Every command the consent screen prints names the root this screen shows")
    func TranscribedCommandsCarryTheShownRoot() {
        let statusOnly = UpdatePanel.consentGateNextStepText(
            updaterPath: updaterPath, stateRoot: shownRoot, code: "release-unsigned"
        )
        #expect(
            statusOnly.contains("node \(updaterPath) status --state-dir \(RemedyCommand.quote(shownRoot))"),
            "读状态那一句没带这一页显示的根：\(statusOnly)"
        )
        let gated = UpdatePanel.consentGateNextStepText(
            updaterPath: updaterPath, stateRoot: shownRoot, code: UpdatePanel.nonDefaultStateDirCode
        )
        #expect(gated.contains("apply --state-dir \(RemedyCommand.quote(shownRoot)) --consent state-dir"),
                "更新器备的那条命令要点名同一个根：\(gated)")
        #expect(gated.contains(RemedyCommand.quote(shownRoot)), "根要按 shell 规则包好：\(gated)")
        // 两句都带根 ⇒ 读的是同一份东西。
        #expect(gated.allCommands(carrying: "--state-dir"),
                "这一屏给出的命令里，有哪一条不带这一页显示的根：\(gated)")

        // 根没量到那一帧：不补一个尖括号模板（那是一条敲不出去的命令），改成把"没量到"说出来。
        let noRoot = UpdatePanel.consentGateNextStepText(
            updaterPath: updaterPath, stateRoot: nil, code: UpdatePanel.nonDefaultStateDirCode
        )
        #expect(!noRoot.contains("<"), "不许给人一个占位符：\(noRoot)")
        #expect(!noRoot.contains("--state-dir"), "根没量到时不许给半条命令：\(noRoot)")
        #expect(noRoot.contains("还没量到"), "要把「这一屏没量到根」说出来：\(noRoot)")
        #expect(noRoot.contains(updaterPath), "认得出程序还是要认出来：\(noRoot)")
    }

    /// 给人读的文案里没有规格章节号，也没有"面板不替这台机器签字"那一类这一侧的立场声明：
    /// 读者要的是这一枚按下去发生什么、那一条命令动起来做什么。
    /// REVERSE：把「不替这台机器签字、也不替它跑，只把原话转述在这里」那半句接回去 → 红。
    @Test("The consent copy states the reader's next move, not the panel's own defence")
    func ConsentCopyCarriesNoInternalArgument() {
        let known = [
            UpdatePanel.consentGateNextStepText(
                updaterPath: updaterPath, stateRoot: shownRoot, code: UpdatePanel.nonDefaultStateDirCode),
            UpdatePanel.consentGateNextStepText(updaterPath: updaterPath, stateRoot: shownRoot, code: nil),
            UpdatePanel.consentGateNextStepText(updaterPath: nil, stateRoot: shownRoot, code: nil),
        ]
        for text in known {
            for forbidden in ["§", "specs/", "policy.js", "面板不替这台机器签字", "也不替它跑",
                              "只把原话转述在这里", "不在面板手里", "P0"] {
                #expect(!text.contains(forbidden), "给人读的句子夹带了内部说法 \(forbidden)：\(text)")
            }
            #expect(!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "空句子不算下一步")
        }
        // 说清这一枚按下去发生什么，仍然要说——那是事实，不是辩白。
        let gated = UpdatePanel.consentGateNextStepText(
            updaterPath: updaterPath, stateRoot: shownRoot, code: UpdatePanel.nonDefaultStateDirCode
        )
        #expect(gated.contains("按下去不会发生任何事"), "读数：\(gated)")
        #expect(gated.contains("跑不跑由你决定"), "读数：\(gated)")

        // 禁用理由那一行（用户真正读到的那一条）也带根，也不写立场声明。
        let buttons = UpdatePanel.buttons(for: .reading(
            .needsConsent, staged: false, current: "1.6.2", stagedVersion: "1.6.3",
            code: UpdatePanel.nonDefaultStateDirCode, updaterPath: updaterPath, stateRoot: shownRoot
        ))
        let reason = buttons.applyReason ?? ""
        #expect(reason.contains("status --state-dir"), "理由里那条命令要读同一个根：\(reason)")
        #expect(!reason.contains("面板不替它签字"), "立场声明不是用户文案：\(reason)")
        confirmStaysOutOfThePanelsHands(buttons)
    }

    // MARK: - 缺陷 3：把后台服务自己那句话抄进面板的 label

    /// 「合法」那一屏现在**读** daemon 的 `notes` 数组，而不是把它的作者那句话抄一遍。
    ///
    /// 那句话的作者：引擎侧 `RecipeLoader.executionNote` / `vocabularyNote`；`glasspaned
    /// --recipe-validate` 把它们放在回话的 `notes` 里；MCP 侧（`mcp-shell/src/tools.ts`）
    /// 转述的也是同一份。面板抄一遍就是第二份说法，两份一定会漂。
    /// REVERSE：`foldValidation` 不再读 `object["notes"]` → 前两条红；把抄本那句接回
    /// 结论正文（`body: Self.validVerdictBody`）→ 形状闸红。
    @Test("The valid verdict reads the daemon notes instead of restating them")
    func ValidVerdictReadsTheDaemonsOwnNotes() throws {
        let payload = """
        {"valid":true,"recipeName":"x","errors":[],"notes":["note one","note two"]}
        """
        guard case .verdict(let valid, _, _, let carried) =
                RecipesTabView.foldValidation(stdout: payload, stderr: "", exitCode: 0) else {
            Issue.record("带 notes 的回话必须折成 verdict")
            return
        }
        #expect(valid)
        #expect(carried == ["note one", "note two"], "notes 没被读出来：\(carried)")

        let body = RecipesTabView.verdictBody(notes: carried)
        #expect(body != RecipesTabView.validVerdictBody, "有 notes 时还在用本页那份抄本当正文")
        #expect(body.contains("形状"), "本页只说自己做过的那一半：\(body)")
        #expect(body.contains("notes"), "要说清下面那几条是谁说的话：\(body)")
        for note in carried {
            #expect(!body.contains(note), "notes 是数据，要被**照录**出来，不是被折进 label 的散文里：\(body)")
        }
        // 一条 notes 都没交出来（旧版 daemon / 回话里没那个键）才用兜底那句。
        #expect(RecipesTabView.verdictBody(notes: []) == RecipesTabView.validVerdictBody,
                "兜底那一支不见了：没有数据的一帧又会只剩「校验通过」那三个字")

        // 跨侧对照：引擎那份结果编码出去长什么样，面板读回来的就是同样的两条。
        let result = RecipeLoader.validate(Data(RecipeTemplates.minStep.utf8))
        let encoded = String(data: try JSONEncoder().encode(result), encoding: .utf8)!
        guard case .verdict(_, _, _, let engineNotes) =
                RecipesTabView.foldValidation(stdout: encoded, stderr: "", exitCode: 0) else {
            Issue.record("引擎真交出的那份结论没能折成 verdict")
            return
        }
        #expect(engineNotes == result.notes, "面板读的不再是后台服务交出的那一份数据")
        #expect(engineNotes.contains(RecipeLoader.executionNote), "\(engineNotes)")
    }

    /// 形状闸：notes 由 `daemonNotesReadout` 作为数据摊出来，结论正文不再指向那份手抄句子。
    /// REVERSE：删掉 `daemonNotesReadout(notes)` 那两行调用 → 第一条红；把正文换回
    /// `Self.validVerdictBody` → 第二条红。
    @Test("Shape: notes reach the screen as data, not as the panel's own sentence")
    func ShapeNotesReachTheScreenAsData() throws {
        let view = try PanelSourceText.code("RecipesTabView.swift")
        #expect(view.contains("daemonNotesReadout(notes)"),
                "notes 又被收回成一句散文、或者整块不再画出来了")
        #expect(view.contains("Self.verdictBody(notes: notes)"), "「合法」那一屏的正文不再跟着 notes 走")
        #expect(!view.contains("body: Self.validVerdictBody"),
                "本页那份手抄又成了正身：两份说法一定漂")
        #expect(view.contains("accessibilityIdentifier(\"gp-recipe-daemon-notes\")"),
                "那一份数据得有个可指认的出口，冒烟与自动化才找得到它")
    }

    // MARK: - 缺陷 4：一条台账记录一个 UserDefaults 键

    /// 一万条记录**不能**写出一万个默认值键：整页只有一份键，里面是最多 N 条内容哈希。
    ///
    /// REVERSE：把 `storingLedgerCollapse` 的容量上限去掉（回到无界增长）→ 第一条红；
    /// 把展开那一支也写进串（`collapsed == false` 时不去重不删除）→ 第二、三条红。
    @Test("A ten-thousand-record ledger cannot write ten-thousand defaults keys")
    func LedgerCollapseStoreIsBounded() {
        var stored = ""
        let total = 10_000
        for index in 0..<total {
            let record = ledgerRecord("appr_\(index)", hash: String(repeating: "a", count: 63) + "\(index % 10)")
            stored = ConsoleModel.storingLedgerCollapse(
                stored, token: ConsoleModel.ledgerCollapseToken(record), collapsed: true
            )
        }
        let kept = ConsoleModel.ledgerCollapseTokens(stored: stored)
        #expect(kept.count <= ConsoleModel.ledgerCollapseCapacity,
                "一份只增不减的台账把键撑成了 \(kept.count) 条")
        #expect(Set(kept).count == kept.count, "同一条记录在同一路里被记了两遍")
        // 那一串本身就是**唯一**的键的内容：键位只有一个，长度有上限。
        #expect(stored.split(separator: ",").count <= ConsoleModel.ledgerCollapseCapacity)
        #expect(stored.count <= ConsoleModel.ledgerCollapseCapacity * 64,
                "这一串自己也不该长成无界的形状")

        // 展开只做减法：一串里没有这一条时，展开它不会让串变长。
        let untouched = ConsoleModel.storingLedgerCollapse(
            stored, token: "not-in-there", collapsed: false
        )
        #expect(untouched == stored, "展开一条没收起来的记录，却往串里添了东西")

        // 反复开合同一条，不会一次次把它的名字叠起来。
        var toggled = ""
        let one = ledgerRecord("appr_one", hash: String(repeating: "b", count: 64))
        let token = ConsoleModel.ledgerCollapseToken(one)
        for _ in 0..<200 {
            toggled = ConsoleModel.storingLedgerCollapse(toggled, token: token, collapsed: true)
            toggled = ConsoleModel.storingLedgerCollapse(toggled, token: token, collapsed: false)
        }
        #expect(toggled.isEmpty, "开了又关的那一条仍然占着位置：\(toggled)")
    }

    /// 条目取每条记录**自己的**链上内容哈希：它只由这一条决定，与行号、台账长度、
    /// 哪一个状态根都无关；哈希拿不到时才退回审批号，且不许塞进分隔符。
    /// REVERSE：把 token 改成 `approval-<行号>`（追加一条就把所有已收起的行都改了名字）→ 红。
    @Test("Ledger collapse entries are derived from the record content")
    func LedgerCollapseTokensAreContentDerived() {
        let first = ledgerRecord("appr_AAAA", hash: String(repeating: "c", count: 64))
        #expect(ConsoleModel.ledgerCollapseToken(first) == ConsoleModel.ledgerCollapseToken(first))
        let second = ledgerRecord("appr_AAAA", hash: String(repeating: "d", count: 64))
        #expect(ConsoleModel.ledgerCollapseToken(first) != ConsoleModel.ledgerCollapseToken(second),
                "同一个审批号、两份内容，指认却相同：收起的那一条会指到另一条头上")
        #expect(!ConsoleModel.ledgerCollapseToken(first).contains(","),
                "分隔符出现在条目里，那一路就读不出条数了")
        // 哈希形状不对（混进非十六进制）：先把脏字符滤干净，滤空了才退回审批号。
        let messy = ledgerRecord("appr_MESSY", hash: "not-a-hash-at-all")
        let messyToken = ConsoleModel.ledgerCollapseToken(messy)
        #expect(!messyToken.isEmpty && !messyToken.contains(","), "读数：\(messyToken)")
        // 完全没有哈希（读不出形状的那一类）：退回审批号，两种形状都是内容派生的。
        let noHash = ledgerRecord("appr_NONE", hash: "")
        #expect(ConsoleModel.ledgerCollapseToken(noHash) == "id:appr_NONE")
        // 收起状态跟着名字走，不跟着这一行排在第几走。
        var stored = ConsoleModel.storingLedgerCollapse("", token: messyToken, collapsed: true)
        #expect(ConsoleModel.ledgerRowIsCollapsed(stored, token: messyToken))
        #expect(!ConsoleModel.ledgerRowIsCollapsed(stored, token: "abcdef0123456789"))
        stored = ConsoleModel.storingLedgerCollapse(stored, token: messyToken, collapsed: false)
        #expect(!ConsoleModel.ledgerRowIsCollapsed(stored, token: messyToken))
    }

    /// 形状闸：审批行**不再**享有那份"每个 key 一个 UserDefaults 键"的默认存放。
    /// REVERSE：把 `collapse: collapseBinding` 那一个实参删掉（回到一记录一键）→ 这一条红，
    /// 而上面那两条行为闸也跟着失效——这正是本仓禁止的"算了却从没接到屏上"。
    @Test("Shape: approval rows are wired to the single bounded store")
    func ShapeApprovalRowsUseTheBoundedStore() throws {
        let approvals = try PanelSourceText.code("ApprovalsTabView.swift")
        #expect(approvals.contains("collapse: collapseBinding"),
                "审批行又走回那份一记录一键的默认存放：一万条记录就是一万个永久键")
        #expect(approvals.contains("@AppStorage(ConsoleModel.ledgerCollapseDefaultsKey)"),
                "整页那唯一的键不再被这一页读写")
        #expect(approvals.contains("ConsoleModel.storingLedgerCollapse"),
                "写入不再走那份有界的判据")
        #expect(approvals.contains("ConsoleModel.ledgerCollapseToken(record)"),
                "条目不再由这一条记录的内容决定")
        let theme = try PanelSourceText.code("ConsoleTheme.swift")
        #expect(theme.contains("collapse: Binding<Bool>? = nil"),
                "PanelCard 那份外来的开合存放不见了——上面那把闸就只是文字")
        #expect(theme.contains("externalCollapse?.wrappedValue ?? storedCollapsed"),
                "卡片不再优先用外来的存放：默认那份一键还会照写")
    }

    // MARK: - 缺陷 5：一次切页就消失的状态

    /// 校验结论的持久化折算：每一支都要能原样回来，解不出来的当"没有结论"，不猜一个。
    /// REVERSE：把 `.verdict` 的 `notes` 从编码里漏掉（结论还在、它带的那份数据没了）→ 红；
    /// 把 `decodeOutcome` 的兜底改成 `.idle`（读不懂就说"这一页刚清过结论"）→ 红。
    @Test("The validation verdict round-trips through the persisted draft's own mechanism")
    func VerdictRoundTripsThroughStorage() {
        let cases: [RecipesTabView.RecipeValidationOutcome] = [
            .idle, .notJSON("Unexpected character"), .noDaemon, .writeFailed, .daemonUnavailable,
            .verdict(valid: true, recipeName: "最小单步", errors: [], notes: ["note one"]),
            .verdict(valid: false, recipeName: nil, errors: ["'steps' is required"], notes: []),
            .daemonRefused(reason: "file not found: /tmp/a.json", exitCode: 2),
        ]
        for one in cases {
            let stored = RecipesTabView.encodeOutcome(one)
            #expect(stored != RecipesTabView.RecipeValidationOutcome.noVerdictStored,
                    "一句真结论被编码成了「没有结论」：\(one)")
            #expect(RecipesTabView.decodeOutcome(stored) == one, "切页回来结论换了：\(one) → \(stored)")
        }
        // nil（还没点过校验）与"这一串读不懂"都落成同一个形状：没有结论。
        #expect(RecipesTabView.encodeOutcome(nil)
                == RecipesTabView.RecipeValidationOutcome.noVerdictStored)
        #expect(RecipesTabView.decodeOutcome(
            RecipesTabView.RecipeValidationOutcome.noVerdictStored) == nil)
        for junk in ["", "{not json}", "[]", "{\"case\":\"verdict\"}", "{\"case\":\"made-up\"}"] {
            #expect(RecipesTabView.decodeOutcome(junk) == nil, "读不懂却替后台服务编一个结论：\(junk)")
        }
        // 「合法」那一屏的结论**连同它那份 notes** 一起活过来：只活结论、丢掉数据，
        // 切一次页就等于替后台服务把话说了半句。
        let withNotes = RecipesTabView.encodeOutcome(
            .verdict(valid: true, recipeName: "x", errors: [], notes: ["a", "b"])
        )
        if case .verdict(_, _, _, let notes) = RecipesTabView.decodeOutcome(withNotes) {
            #expect(notes == ["a", "b"], "notes 没跟着结论活过这一次切页：\(notes)")
        } else {
            Issue.record("带 notes 的结论没能解回来")
        }
    }

    /// 形状闸：结论走的是本页其余持久控件那一个机制（`@AppStorage`），不再是 `@State`；
    /// 权限页那一组「不勾选会怎样」的开合同样接在同一套机制上（同胞 `PanelCard` 与
    /// `PermissionExplain` 都记着，唯独它没有）。
    /// REVERSE：把 `outcome` 换回 `@State private var outcome` → 第一条红；把
    /// `DisclosureGroup(isExpanded:)` 那一个实参删掉 → 第三条红。
    @Test("Shape: verdict and disclosure state are persisted like their siblings")
    func ShapePersistedControlsUseAppStorage() throws {
        let recipes = try PanelSourceText.code("RecipesTabView.swift")
        #expect(!recipes.contains("@State private var outcome"),
                "结论又回到跟着视图一起销毁：草稿还在、结论没了")
        #expect(recipes.contains("@AppStorage(RecipesTabView.outcomeDefaultsKey)"),
                "结论的持久化不再走本页其余控件那一个机制")
        #expect(recipes.contains("Self.decodeOutcome(persistedOutcome)"),
                "读写绕开了那一对纯函数——持久化又变成只有视图知道的事")

        let panel = try PanelSourceText.code("SettingsPanelView.swift")
        #expect(panel.contains("DisclosureGroup(isExpanded: $degradationExpanded)"),
                "「不勾选会怎样」那一组的开合又没有记忆了：切一次页就自己合上")
        #expect(panel.contains("@AppStorage(\"glasspane.card.permissions-degradation.expanded\")"),
                "这一组的开合状态不再由本机那一份存放承担")
        #expect(!panel.contains("DisclosureGroup {"),
                "这一面还留着另一个没有记忆的 DisclosureGroup")
    }
}

private extension String {
    /// 这一屏给出的**每一条** `node …` 命令是否都带着那个旗标（缺陷 2 的判据：缺一条就是
    /// 那条命令在读另一个根，与屏幕上这份读数不是同一件事）。
    func allCommands(carrying flag: String) -> Bool {
        let commands = self.components(separatedBy: "node ").dropFirst()
        return !commands.isEmpty && commands.allSatisfy { $0.contains(flag) }
    }
}

/// 按不动的那一枚也要保持"按不动"：确认参数不许偷偷带上，能做的动作不许指错地方。
private func confirmStaysOutOfThePanelsHands(_ buttons: UpdatePanel.Buttons) {
    #expect(!buttons.applyEnabled, "面板无权代签的门，那枚「安装更新」必须按不动")
    #expect(buttons.applyArguments.isEmpty, "按不动的按钮不许偷偷带上 --consent")
    #expect(!buttons.consentEnabled, "这一道门不是面板能代签的那两种")
}
