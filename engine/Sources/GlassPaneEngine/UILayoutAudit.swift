import Foundation

/// 界面可操作性的确定性审计：输入一次几何遍历，输出"这个界面是不是能用"的判定。
///
/// 这里**不做审美判断**，也不调用任何模型。规则只覆盖那些能靠数字说话、且错了会
/// 直接阻塞使用的形状问题（零尺寸、点不到的目标、跑到窗口外、互相遮挡）。审美
/// 是另一件事，把它混进来会让"实测"这两个字失去含义。
///
/// 判定值 `insufficient` 与 `pass` 严格分开：读不到几何就报"通过"，等于给没看过的
/// 东西发合格证——这是本项目最不允许的一种绿。
public enum LayoutSeverity: String, Codable, Equatable {
    /// 基本可以断定用不了：点不到、看不见、尺寸为零。
    case blocking
    /// 违背常见范式或可疑，但不必然坏：目标过小、被裁切、互相重叠、静态窗口。
    case advisory
}

public enum LayoutVerdict: String, Codable, Equatable {
    case pass
    case advisory
    case blocking
    /// 证据不足：几何覆盖率不够或有未完成的读，无法给出干净结论。
    case insufficient
}

public struct LayoutFinding: Codable, Equatable {
    public let rule: String
    public let severity: LayoutSeverity
    public let elementPath: String?
    public let role: String?
    public let title: String?
    public let detail: String
    /// 判定时用到的数字。留下数字，代理和人才有可能复核结论而不是接受结论。
    public let measured: [String: Double]

    public init(
        rule: String,
        severity: LayoutSeverity,
        elementPath: String? = nil,
        role: String? = nil,
        title: String? = nil,
        detail: String,
        measured: [String: Double] = [:]
    ) {
        self.rule = rule
        self.severity = severity
        self.elementPath = elementPath
        self.role = role
        self.title = title
        self.measured = measured
        self.detail = detail
    }
}

public struct LayoutCoverage: Codable, Equatable {
    public let total: Int
    public let measured: Int
    public let absent: Int
    public let unread: Int
    /// measured / total。分母含 absent（应用明确不给几何的元素），因为那部分
    /// 永远量不到，把它说成"已覆盖"就是虚报。
    public let ratio: Double

    public init(total: Int, measured: Int, absent: Int, unread: Int) {
        self.total = total
        self.measured = measured
        self.absent = absent
        self.unread = unread
        self.ratio = total == 0 ? 0 : Double(measured) / Double(total)
    }
}

public struct LayoutAuditResult: Codable, Equatable {
    public let verdict: LayoutVerdict
    public let findings: [LayoutFinding]
    public let coverage: LayoutCoverage
    public let minHitTargetPt: Double
    /// 重叠扫描是否因规模被截断。截断过就不能声称"没有遮挡"。
    public let overlapScanTruncated: Bool
    /// 每条规则的完整计数（样本可能被截，计数不截）。
    public let ruleCounts: [String: Int]

    public init(
        verdict: LayoutVerdict,
        findings: [LayoutFinding],
        coverage: LayoutCoverage,
        minHitTargetPt: Double,
        overlapScanTruncated: Bool,
        ruleCounts: [String: Int] = [:]
    ) {
        self.verdict = verdict
        self.findings = findings
        self.coverage = coverage
        self.minHitTargetPt = minHitTargetPt
        self.overlapScanTruncated = overlapScanTruncated
        self.ruleCounts = ruleCounts
    }
}

public enum UILayoutAudit {
    /// 默认命中目标阈值。**出处要写清**：44pt 来自 Apple 面向触控的 iOS HIG，
    /// macOS 的菜单栏/工具条控件通常只有 20 出头 pt，所以这个默认值对 Mac 界面偏严——
    /// 真机跑 Finder 时它一口气报了 9 条。它是一条线索，不是裁决：调用方应当按自己
    /// 目标的界面密度传 `minHitTargetPt`（工具栏密集的应用传 20 也完全合理）。
    public static let defaultMinHitTargetPt = 44.0

    /// 同一条规则最多列几个样本。49 条 finding 一次倒给模型，等于没有 finding：
    /// 真正被读的是头几条，其余把上下文挤掉。超出部分按规则汇总进 ruleCounts。
    static let maxExamplesPerRule = 5

    /// 重叠扫描的两两比较上限；超过则截断并如实标记。
    static let overlapPairBudget = 300

    /// 覆盖率达到多少才允许给出 `pass`。低于它就是 `insufficient`。
    static let passCoverageRatio = 0.8

    /// 菜单族角色：在菜单被打开之前，它们在无障碍树里就是 0 尺寸 —— 真机第一次跑
    /// 就证实了这点（审计给出的 5 条 blocking 全是 AXMenuItem，如"关于本机"）。
    /// 所以这类元素不判"点不到"：没有 frame 不等于坏，只等于现在没展开。
    /// 它们仍参与重叠/覆盖率等其他判定。
    static let framelessUntilShownRoles: Set<String> = [
        "menuitem", "menu bar", "menubar", "menu", "menu extra",
    ]

    /// 可交互角色：只有名单内的角色才承担"点得到吗"的责任。
    /// 名单外的角色（分组、静态文本、容器）不参与零尺寸/命中目标类判定——
    /// 宁可少报，也不要拿一个本来就不可点的元素报出"目标太小"。
    static let interactiveRoles: Set<String> = [
        "button", "checkbox", "radiobutton", "menubutton", "pop-up button", "popupbutton",
        "link", "slider", "incrementor", "stepper", "textfield", "textarea", "combobox",
        "menuitem", "tab", "disclosuretriangle", "drawer", "toggle", "switch", "rating",
    ]

    /// "AXButton" / "button" / "Button" 都归一到 "button"，与 AXChannel 的宽容读法一致。
    static func normalizedRole(_ raw: String) -> String {
        var role = raw.trimmingCharacters(in: .whitespaces).lowercased()
        if role.hasPrefix("ax") { role = String(role.dropFirst(2)) }
        return role
    }

    static func isInteractive(_ node: AxGeometryNode) -> Bool {
        interactiveRoles.contains(normalizedRole(node.role))
    }

    /// 供几何走查复用：只有可交互角色才值得多花一次 AX 读去取 title。
    /// 判定与审计共用同一个名单，避免"走查以为是容器、审计以为是控件"这类分裂。
    static func isInteractiveRole(_ raw: String) -> Bool {
        interactiveRoles.contains(normalizedRole(raw))
    }

    public static func audit(
        _ snapshot: AxGeometrySnapshot,
        minHitTargetPt: Double = defaultMinHitTargetPt
    ) -> LayoutAuditResult {
        var findings: [LayoutFinding] = []
        var measuredCount = 0
        var absentCount = 0
        var unreadCount = 0

        for node in snapshot.nodes {
            switch node.geometry {
            case .measured: measuredCount += 1
            case .absent: absentCount += 1
            case let .unread(reason):
                unreadCount += 1
                findings.append(LayoutFinding(
                    rule: "geometryUnread",
                    severity: .advisory,
                    elementPath: node.path,
                    role: node.role,
                    title: node.title,
                    detail: "几何没读到（\(reason)）；这一条不计入通过，只计入未知。",
                    measured: [:]
                ))
            }
        }
        let coverage = LayoutCoverage(
            total: snapshot.nodes.count,
            measured: measuredCount,
            absent: absentCount,
            unread: unreadCount
        )

        let interactive = snapshot.nodes.filter { isInteractive($0) }
        let measuredInteractive = interactive.compactMap { node -> (AxGeometryNode, AxFrame)? in
            guard let frame = node.geometry.frame else { return nil }
            return (node, frame)
        }

        let framelessUntilShown: (AxGeometryNode) -> Bool = { node in
            framelessUntilShownRoles.contains(normalizedRole(node.role))
        }
        for (node, frame) in measuredInteractive {
            if frame.width <= 0 || frame.height <= 0 {
                if framelessUntilShown(node) { continue }
                findings.append(LayoutFinding(
                    rule: "zeroSizedInteractive",
                    severity: snapshot.window == nil ? .advisory : .blocking,
                    elementPath: node.path,
                    role: node.role,
                    title: node.title,
                    detail: snapshot.window == nil
                        ? "可交互元素的尺寸为 0。当前读不到窗口边界（缺屏幕录制授权时很常见），"
                            + "因此只能报可疑，不能断定点不到。"
                        : "可交互元素的尺寸为 0，点不到也就用不了。",
                    measured: ["width": frame.width, "height": frame.height]
                ))
                continue
            }
            if frame.width < minHitTargetPt || frame.height < minHitTargetPt {
                findings.append(LayoutFinding(
                    rule: "smallHitTarget",
                    severity: .advisory,
                    elementPath: node.path,
                    role: node.role,
                    title: node.title,
                    detail: "命中目标小于本次阈值 \(Int(minHitTargetPt))pt（默认值取自 iOS 触控标准，"
                        + "对 Mac 的菜单栏/工具条偏严）；不必然坏，但容易被误点或点不中。",
                    measured: ["width": frame.width, "height": frame.height, "minPt": minHitTargetPt]
                ))
            }
            if let window = snapshot.window, !frame.centerInside(window) {
                findings.append(LayoutFinding(
                    rule: "outsideWindow",
                    severity: .blocking,
                    elementPath: node.path,
                    role: node.role,
                    title: node.title,
                    detail: "元素中心落在窗口之外，用户看不见也点不到。",
                    measured: ["x": frame.x, "y": frame.y, "width": frame.width, "height": frame.height]
                ))
            } else if let window = snapshot.window, !frame.contained(in: window), frame.area > 0 {
                findings.append(LayoutFinding(
                    rule: "clippedByWindow",
                    severity: .advisory,
                    elementPath: node.path,
                    role: node.role,
                    title: node.title,
                    detail: "元素被窗口边界裁掉一部分。",
                    measured: [
                        "visibleRatio": visibleRatio(of: frame, in: window),
                        "width": frame.width,
                        "height": frame.height,
                    ]
                ))
            }
        }

        if !snapshot.nodes.isEmpty, interactive.isEmpty {
            // "整棵树里没有可交互角色"是一个关于**应用**的断言，只有走完整次遍历才配说。
            // 遍历不完整时它只能关于"我看到的部分"——否则一条没走过的子树就能让结论
            // 从"没看到控件"变成"这个应用没有控件"。
            findings.append(LayoutFinding(
                rule: "noInteractiveElements",
                severity: .advisory,
                elementPath: nil,
                role: nil,
                title: nil,
                detail: snapshot.complete
                    ? "整棵树里没有任何可交互角色。可能确实是只读界面；若预期能操作，说明控件没暴露到无障碍层。"
                    : "在本次**走过的**部分里没有任何可交互角色（遍历未完成：\(snapshot.stopReason ?? "原因未知")）。"
                        + "这不是一棵没有控件的树，只是一段没看到控件的走查。",
                measured: [
                    "nodeCount": Double(snapshot.nodes.count),
                    "walkComplete": snapshot.complete ? 1 : 0,
                ]
            ))
        }

        var truncated = false
        if measuredInteractive.count > 1 {
            let candidates = Array(measuredInteractive.prefix(overlapPairBudget))
            truncated = measuredInteractive.count > candidates.count
            for i in 0 ..< candidates.count {
                for j in (i + 1) ..< candidates.count {
                    let (nodeA, a) = candidates[i]
                    let (nodeB, b) = candidates[j]
                    guard a.area > 0, b.area > 0 else { continue }
                    // 同父且同角色 = 一个控件的若干组成部分（分段控件/单选组的子
                    // AXRadioButton 就是真机 Finder 那 36 条 overlap 的全部来源），
                    // 它们共享矩形是设计如此，不是谁盖住谁。判据必须同时看父路径与角色：
                    // 只看父路径会把根层两个真控件也豁免掉（既有单测当场抓到过一次）。
                    if parentPath(nodeA.path) == parentPath(nodeB.path),
                       normalizedRole(nodeA.role) == normalizedRole(nodeB.role) { continue }
                    let overlap = a.intersectionArea(with: b)
                    let smaller = min(a.area, b.area)
                    guard overlap / smaller > 0.5 else { continue }
                    findings.append(LayoutFinding(
                        rule: "overlappingInteractiveTargets",
                        severity: .advisory,
                        elementPath: candidates[i].0.path,
                        role: candidates[i].0.role,
                        title: candidates[i].0.title,
                        detail: "两个可交互目标位置重叠超过小者的 50%（启发式判定：无障碍树里没有层级顺序，"
                            + "看不出谁盖住谁，只能报形状冲突）。overlap=\(candidates[j].0.path)",
                        measured: ["overlapRatio": overlap / smaller]
                    ))
                }
            }
        }

        if snapshot.window == nil {
            findings.append(LayoutFinding(
                rule: "windowBoundsUnavailable",
                severity: .advisory,
                elementPath: nil, role: nil, title: nil,
                detail: "读不到窗口边界（通常是没有屏幕录制授权），越界与裁切两类检查没有执行。"
                    + "本结论不覆盖「元素是否落在屏幕内」。",
                measured: [:]
            ))
        }

        if !snapshot.complete {
            // 走查没走完就下"通过"，等于对没看过的部分发合格证。
            findings.append(LayoutFinding(
                rule: "geometryScanIncomplete",
                severity: .advisory,
                elementPath: nil,
                role: nil,
                title: nil,
                detail: "几何遍历未走完（\(snapshot.stopReason ?? "原因未知")）；已量的部分仍然报，"
                    + "但整体结论不能是干净。",
                measured: ["nodesCollected": Double(snapshot.nodes.count)]
            ))
        }

        if truncated {
            // 只比对了前 overlapPairBudget 个目标：剩下的配对没看过。
            // 因此"没发现遮挡"这句话不成立，必须留一条 finding 并把结论压到
            // advisory 以下——截断是测量的边界，不是干净的理由。
            findings.append(LayoutFinding(
                rule: "overlapScanTruncated",
                severity: .advisory,
                elementPath: nil,
                role: nil,
                title: nil,
                detail: "可交互目标超过 \(overlapPairBudget) 个，重叠扫描只比对了前 \(overlapPairBudget) 个；"
                    + "未比对的配对不能声称没有遮挡。",
                measured: ["interactiveMeasured": Double(measuredInteractive.count)]
            ))
        }

        let hasBlocking = findings.contains { $0.severity == .blocking }
        let verdict: LayoutVerdict
        if hasBlocking {
            verdict = .blocking
        } else if coverage.measured == 0 || coverage.ratio < passCoverageRatio {
            verdict = .insufficient
        } else if findings.isEmpty && !truncated && snapshot.complete && snapshot.window != nil {
            verdict = .pass
        } else {
            verdict = .advisory
        }

        // 先汇总，再截样：ruleCounts 保住"这类问题一共几条"这个数字，
        // findings 只留前几条样本，免得一次调用把调用方的上下文吃掉。
        var ruleCounts: [String: Int] = [:]
        for finding in findings { ruleCounts[finding.rule, default: 0] += 1 }
        var seen: [String: Int] = [:]
        var examples: [LayoutFinding] = []
        var droppedAny = false
        for finding in findings {
            let count = seen[finding.rule, default: 0]
            if count >= maxExamplesPerRule { droppedAny = true; continue }
            seen[finding.rule] = count + 1
            examples.append(finding)
        }
        if droppedAny {
            examples.append(LayoutFinding(
                rule: "findingsAggregated",
                severity: .advisory,
                elementPath: nil, role: nil, title: nil,
                detail: "同类问题只列了前 \(maxExamplesPerRule) 条样本，完整条数见 ruleCounts；"
                    + "计数没有被截断，被截的只是样本。",
                measured: ruleCounts.mapValues(Double.init)
            ))
        }

        return LayoutAuditResult(
            verdict: verdict,
            findings: examples,
            coverage: coverage,
            minHitTargetPt: minHitTargetPt,
            overlapScanTruncated: truncated,
            ruleCounts: ruleCounts
        )
    }

    /// "0/3/1" → "0/3"；根节点返回空串。
    static func parentPath(_ path: String) -> String {
        guard let last = path.lastIndex(of: "/") else { return "" }
        return String(path[..<last])
    }

    /// 元素在窗口内的可见面积占比。
    static func visibleRatio(of frame: AxFrame, in window: AxFrame) -> Double {
        guard frame.area > 0 else { return 0 }
        return min(1, frame.intersectionArea(with: window) / frame.area)
    }
}
