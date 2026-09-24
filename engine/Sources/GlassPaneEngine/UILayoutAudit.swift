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

    public init(
        verdict: LayoutVerdict,
        findings: [LayoutFinding],
        coverage: LayoutCoverage,
        minHitTargetPt: Double,
        overlapScanTruncated: Bool
    ) {
        self.verdict = verdict
        self.findings = findings
        self.coverage = coverage
        self.minHitTargetPt = minHitTargetPt
        self.overlapScanTruncated = overlapScanTruncated
    }
}

public enum UILayoutAudit {
    /// Apple 人机界面指南的 44pt 最小可点击目标；这里作为默认阈值，可被调用方覆盖。
    public static let defaultMinHitTargetPt = 44.0

    /// 重叠扫描的两两比较上限；超过则截断并如实标记。
    static let overlapPairBudget = 300

    /// 覆盖率达到多少才允许给出 `pass`。低于它就是 `insufficient`。
    static let passCoverageRatio = 0.8

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

        for (node, frame) in measuredInteractive {
            if frame.width <= 0 || frame.height <= 0 {
                findings.append(LayoutFinding(
                    rule: "zeroSizedInteractive",
                    severity: .blocking,
                    elementPath: node.path,
                    role: node.role,
                    title: node.title,
                    detail: "可交互元素的尺寸为 0，点不到也就用不了。",
                    measured: ["width": frame.width, "height": frame.height]
                ))
                continue
            }
            if frame.width < minHitTargetPt || frame.height < minHitTargetPt {
                findings.append(LayoutFinding(
                    rule: "tinyHitTarget",
                    severity: .advisory,
                    elementPath: node.path,
                    role: node.role,
                    title: node.title,
                    detail: "命中目标小于常见的 \(Int(minHitTargetPt))pt 习惯；不必然坏，但容易被误点或点不中。",
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
            findings.append(LayoutFinding(
                rule: "noInteractiveElements",
                severity: .advisory,
                elementPath: nil,
                role: nil,
                title: nil,
                detail: "整棵树里没有任何可交互角色。可能确实是只读界面；若预期能操作，说明控件没暴露到无障碍层。",
                measured: ["nodeCount": Double(snapshot.nodes.count)]
            ))
        }

        var truncated = false
        if measuredInteractive.count > 1 {
            let candidates = Array(measuredInteractive.prefix(overlapPairBudget))
            truncated = measuredInteractive.count > candidates.count
            for i in 0 ..< candidates.count {
                for j in (i + 1) ..< candidates.count {
                    let (_, a) = candidates[i]
                    let (_, b) = candidates[j]
                    guard a.area > 0, b.area > 0 else { continue }
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
        } else if findings.isEmpty && !truncated {
            verdict = .pass
        } else {
            verdict = .advisory
        }

        return LayoutAuditResult(
            verdict: verdict,
            findings: findings,
            coverage: coverage,
            minHitTargetPt: minHitTargetPt,
            overlapScanTruncated: truncated
        )
    }

    /// 元素在窗口内的可见面积占比。
    static func visibleRatio(of frame: AxFrame, in window: AxFrame) -> Double {
        guard frame.area > 0 else { return 0 }
        return min(1, frame.intersectionArea(with: window) / frame.area)
    }
}
