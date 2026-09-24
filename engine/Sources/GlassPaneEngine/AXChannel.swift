import Foundation
import AppKit
import CoreGraphics
import ApplicationServices

/// Production RuntimeChannel backed by the macOS Accessibility API and
/// CGWindow capture (the "eyes and hands" of the Z5 channel). Requires the
/// daemon to hold accessibility permission; screen-recording permission is
/// only needed for captureWindow, and its absence degrades to
/// pixelCaptureDenied (P0 spec §8).
public final class AXChannel: RuntimeChannel {

    // The budget constants are internal (not private) so the unit tests can
    // pin the arithmetic without a live AX target.

    /// AX messaging timeout in seconds — mirrors EngineCore.pingTimeoutMs.
    static let messagingTimeoutSeconds: CFTimeInterval = 2.0
    /// Total wall-clock budget for one tree walk (`treeSnapshot`) or one
    /// selector search (`performAction`/`readProperty`). A hung app can stall
    /// every attribute read up to the messaging timeout, so without a
    /// cumulative budget observe would block for minutes (seen on real apps).
    /// The budget is a *hard* bound: every AX call issued inside a walk gets a
    /// timeout scaled down to what is left (`messagingTimeout(remaining:)`),
    /// so the walk cannot overshoot it (R2-19).
    static let treeTimeoutSeconds: CFTimeInterval = 10.0
    /// Shortest per-call timeout still worth issuing a call with. Below this
    /// the remaining budget counts as spent — and a zero timeout must never
    /// reach `AXUIElementSetMessagingTimeout`, where it means "restore the
    /// system default" and would silently break the bound above.
    static let minMessagingTimeoutSeconds: CFTimeInterval = 0.1
    /// Selector searches walk the full AX hierarchy but never deeper than
    /// this guard (observe is separately bounded by maxDepth).
    private static let searchMaxDepth = 24

    private var appElement: AXUIElement?
    private var attached: AttachedApp?

    public init() {}

    // MARK: - RuntimeChannel

    public func attach(bundleId: String?, pid: pid_t?) throws -> AttachedApp {
        let running = try resolveRunningApplication(bundleId: bundleId, pid: pid)
        guard AXIsProcessTrusted() else {
            throw ChannelError.axUnavailable(
                reason: "accessibility permission not granted to the daemon process"
            )
        }
        let app = AttachedApp(
            pid: running.processIdentifier,
            bundleId: running.bundleIdentifier,
            appName: running.localizedName ?? "pid-\(running.processIdentifier)"
        )
        let element = AXUIElementCreateApplication(app.pid)
        AXUIElementSetMessagingTimeout(element, Float(Self.messagingTimeoutSeconds))
        appElement = element
        attached = app
        return app
    }

    public func ping() throws -> Double {
        let element = try requireAppElement()
        let started = CFAbsoluteTimeGetCurrent()
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value)
        let elapsedMs = (CFAbsoluteTimeGetCurrent() - started) * 1000
        switch error {
        case .success, .attributeUnsupported, .noValue, .notImplemented:
            // Any answer — even "no role" — proves the app's AX server is
            // serving requests within the messaging timeout.
            return elapsedMs
        case .cannotComplete:
            throw Self.permissionOrPingTimeout(
                action: "ping", processTrusted: AXIsProcessTrusted()
            )
        case .apiDisabled:
            throw ChannelError.axUnavailable(reason: "AX API is disabled")
        default:
            throw ChannelError.axUnavailable(reason: "AX ping failed (kAXError \(error.rawValue))")
        }
    }

    public func treeSnapshot(maxDepth: Int) throws -> AxTreeSnapshot {
        let element = try requireAppElement()
        let started = CFAbsoluteTimeGetCurrent()
        // Abort the whole walk if cumulative AX reads exceed the budget,
        // so observe can never block past treeTimeout even on a hung app.
        let deadline = started + Self.treeTimeoutSeconds
        // 预算闸会逐次改写元素的 messaging timeout（见 `enforceBudget`）；app 元素
        // 是跨调用保留的，所以走完树必须把它调回默认值，否则下一次 ping/act 会继承
        // 一次中止遍历时的残余小超时。
        defer { AXUIElementSetMessagingTimeout(element, Float(Self.messagingTimeoutSeconds)) }
        let root = try buildNode(for: element, depth: 0, maxDepth: maxDepth, deadline: deadline)
        let roots = [root]
        let latencyMs = (CFAbsoluteTimeGetCurrent() - started) * 1000
        return AxTreeSnapshot(
            roots: roots,
            digest: try TreeDigest.digest(roots),
            nodeCount: TreeDigest.nodeCount(roots),
            latencyMs: latencyMs
        )
    }

    /// 几何遍历：role/title/identifier + position/size，扁平输出并带索引路径。
    ///
    /// 与 `treeSnapshot` 共用同一套预算纪律（`enforceBudget` 逐次压超时），
    /// 但每个元素的几何读是**独立降级**的：一个元素读不到几何不会作废整次
    /// 审计，它变成一个 `unread` 计入覆盖率——审计因此只能把结论降级为
    /// `insufficient`，而不是把没看到的当成没毛病。
    public func geometrySnapshot(maxDepth: Int) throws -> AxGeometrySnapshot {
        let element = try requireAppElement()
        let started = CFAbsoluteTimeGetCurrent()
        let deadline = started + Self.treeTimeoutSeconds
        defer { AXUIElementSetMessagingTimeout(element, Float(Self.messagingTimeoutSeconds)) }
        var nodes: [AxGeometryNode] = []
        try walkGeometry(for: element, path: "", depth: 0, maxDepth: maxDepth, deadline: deadline, into: &nodes)
        let windowFrame: AxFrame? = attached.flatMap { app in
            frontmostOnScreenWindow(of: app.pid).flatMap { (_, rect) in
                AxFrame(x: Double(rect.minX), y: Double(rect.minY), width: Double(rect.width), height: Double(rect.height))
            }
        }
        let latencyMs = (CFAbsoluteTimeGetCurrent() - started) * 1000
        return AxGeometrySnapshot(nodes: nodes, window: windowFrame, latencyMs: latencyMs)
    }

    private func walkGeometry(
        for element: AXUIElement,
        path: String,
        depth: Int,
        maxDepth: Int,
        deadline: CFTimeInterval,
        into nodes: inout [AxGeometryNode]
    ) throws {
        let role = try attributeString(element, kAXRoleAttribute, deadline: deadline) ?? ""
        let title = try attributeString(element, kAXTitleAttribute, deadline: deadline)
        let identifier = try attributeString(element, kAXIdentifierAttribute, deadline: deadline)
        nodes.append(AxGeometryNode(
            path: path.isEmpty ? "0" : path,
            role: role,
            title: title,
            identifier: identifier,
            geometry: try readFrame(of: element, deadline: deadline)
        ))
        guard depth < maxDepth, let children = try childElements(of: element, deadline: deadline) else { return }
        for (index, child) in children.enumerated() {
            try walkGeometry(
                for: child,
                path: path.isEmpty ? "\(index)" : "\(path)/\(index)",
                depth: depth + 1,
                maxDepth: maxDepth,
                deadline: deadline,
                into: &nodes
            )
        }
    }

    /// position + size 合成一个读数。两个属性里**任一**没读出来就是 unread，
    /// 不能被"另一个读到了"掩盖成部分成功：半个矩形既不能判命中目标，也不能判
    /// 出界，只会被算成量到了。
    private func readFrame(of element: AXUIElement, deadline: CFTimeInterval) throws -> GeometryRead {
        let (positionOutcome, positionValue) = try readAttribute(
            element, kAXPositionAttribute, deadline: deadline, action: "reading element position"
        )
        let (sizeOutcome, sizeValue) = try readAttribute(
            element, kAXSizeAttribute, deadline: deadline, action: "reading element size"
        )
        if case let .unreadable(channelError) = positionOutcome { return .unread(reason: describe(channelError)) }
        if case let .unreadable(channelError) = sizeOutcome { return .unread(reason: describe(channelError)) }
        guard positionOutcome == .answered, sizeOutcome == .answered,
              let rawPosition = positionValue, let rawSize = sizeValue else {
            return .absent
        }
        guard let valuePosition = rawPosition as! AXValue?, let valueSize = rawSize as! AXValue? else {
            return .unread(reason: "geometry came back as something that is not an AXValue")
        }
        var point = CGPoint.zero
        var cgSize = CGSize.zero
        guard AXValueGetValue(valuePosition, .cgPoint, &point),
              AXValueGetValue(valueSize, .cgSize, &cgSize) else {
            return .unread(reason: "geometry AXValue could not be decoded into a point and a size")
        }
        return .measured(AxFrame(
            x: Double(point.x), y: Double(point.y),
            width: Double(cgSize.width), height: Double(cgSize.height)
        ))
    }

    /// 一次属性读，按 `classifyAttributeRead` 的既有判据归类，同时把原值带回。
    /// 不新写一套错误分类：树遍历与选择器搜索过去就对同一个失败给过不同结论
    /// （R2-06），几何不能成为第三个各说各话的地方。
    private func readAttribute(
        _ element: AXUIElement,
        _ attribute: String,
        deadline: CFTimeInterval,
        action: String
    ) throws -> (AttributeReadOutcome, CFTypeRef?) {
        try Self.enforceBudget(on: element, deadline: deadline, what: action)
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        let outcome = Self.classifyAttributeRead(
            error: error,
            hasValue: value != nil,
            processTrusted: AXIsProcessTrusted(),
            action: action
        )
        return (outcome, value)
    }

    /// 未知值原样落进 unread 原因里，而不是被 `.answered` 分支的强转崩在运行时。
    private func describe(_ error: ChannelError) -> String {
        switch error {
        case let .axUnavailable(reason): return reason
        case let .treeCaptureFailed(reason): return reason
        case let .actRejected(reason): return reason
        case let .attributeUnavailable(reason): return reason
        case let .pixelCaptureDenied(reason): return reason
        case .appNotFound: return "the app is gone"
        case .assertTargetNotFound: return "target not found"
        case .pingTimeout: return "the accessibility ping timed out"
        }
    }

    public func performAction(selector: Selector, action: Action) throws {
        let element = try requireAppElement()
        // 选择器搜索同样受墙钟预算约束（R2-19）：搜索里的每一次属性读取
        // 与每一次 AXChildren 读取都带自己的超时，无上界时一次 act 可以挂几分钟。
        let deadline = CFAbsoluteTimeGetCurrent() + Self.treeTimeoutSeconds
        defer { AXUIElementSetMessagingTimeout(element, Float(Self.messagingTimeoutSeconds)) }
        // findElement 抛错时上抛（"我没读到" ≠ "界面上没有"，R2-06）；返回 nil
        // 现在只有一个含义：整棵树被完整读完且确实没有匹配项。
        guard let target = try findElement(
            matching: selector, root: element, deadline: deadline
        ) else {
            throw ChannelError.actRejected(reason: "no element matches the selector")
        }
        let actionName = Self.axActionName(for: action)
        try Self.enforceBudget(on: target, deadline: deadline, what: "performing '\(actionName)'")
        let error = AXUIElementPerformAction(target, actionName as CFString)
        guard error == .success else {
            throw ChannelError.actRejected(
                reason: Self.performFailureReason(error: error, action: action)
            )
        }
    }

    public func readProperty(selector: Selector, property: AssertionProperty) throws -> StringOrBool {
        let element = try requireAppElement()
        let deadline = CFAbsoluteTimeGetCurrent() + Self.treeTimeoutSeconds
        defer { AXUIElementSetMessagingTimeout(element, Float(Self.messagingTimeoutSeconds)) }
        guard let target = try findElement(
            matching: selector, root: element, deadline: deadline
        ) else {
            throw ChannelError.assertTargetNotFound
        }
        let attribute = Self.axAttribute(for: property)
        try Self.enforceBudget(on: target, deadline: deadline, what: "reading \(attribute)")
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(target, attribute as CFString, &value)
        switch error {
        case .success:
            // 读到了什么就报什么；读不出可比对的值时上抛，不替界面造一个
            // "false"/""（R2-15）—— 那会让 expected:false 的断言在一次失败的读上判过。
            return try Self.stringOrBool(from: value, attribute: attribute, property: property)
        case .noValue:
            // 空值就是空值：属性存在但元素没有值，这是一次**未观测**，
            // 不能折成任何可判定的字符串（与 stringOrBool 的 nil 分支同口径）。
            throw ChannelError.attributeUnavailable(
                reason: "element does not expose \(attribute) (no value)"
            )
        case .attributeUnsupported, .notImplemented:
            throw ChannelError.attributeUnavailable(reason: "element does not expose \(attribute)")
        case .cannotComplete:
            throw Self.permissionOrPingTimeout(
                action: "read \(attribute)", processTrusted: AXIsProcessTrusted()
            )
        case .apiDisabled:
            throw ChannelError.axUnavailable(reason: "AX API is disabled")
        default:
            throw ChannelError.axUnavailable(
                reason: "reading \(attribute) failed (kAXError \(error.rawValue))"
            )
        }
    }

    public func isProcessAlive() -> Bool {
        guard let attached else { return false }
        return kill(attached.pid, 0) == 0 || errno != ESRCH
    }

    public func captureWindow() throws -> WindowCapture {
        guard let attached else {
            throw ChannelError.pixelCaptureDenied(reason: "no app attached to the channel")
        }
        guard let (windowId, bounds) = frontmostOnScreenWindow(of: attached.pid) else {
            throw ChannelError.pixelCaptureDenied(
                reason: "no on-screen window owned by pid \(attached.pid)"
            )
        }
        // P1: pixel capture migrated from deprecated CGWindowListCreateImage
        // to ScreenCaptureKit (GlassPane_P1_实施规格_v1.0_SCK迁移.md §2).
        let image = try SCKCapturer.captureWindow(
            ownerPid: attached.pid,
            windowId: windowId
        )
        return WindowCapture(
            windowId: windowId,
            bounds: Bounds(x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height),
            image: image
        )
    }

    // MARK: - Attachment resolution

    private func resolveRunningApplication(bundleId: String?, pid: pid_t?) throws -> NSRunningApplication {
        if let pid {
            guard let running = NSRunningApplication(processIdentifier: pid) else {
                throw ChannelError.appNotFound
            }
            return running
        }
        if let bundleId {
            guard let running = NSWorkspace.shared.runningApplications.first(where: {
                $0.bundleIdentifier == bundleId
            }) else {
                throw ChannelError.appNotFound
            }
            return running
        }
        throw ChannelError.appNotFound
    }

    private func requireAppElement() throws -> AXUIElement {
        guard let appElement else {
            throw ChannelError.axUnavailable(reason: "no app attached to the channel")
        }
        return appElement
    }

    // MARK: - Tree walking

    /// Recursive depth-bounded assembly. maxDepth is protocol-limited to
    /// 1–10 (ParamValidation), so recursion depth is bounded by construction.
    /// Every AX call inside the walk passes the `deadline` through
    /// `enforceBudget`, which caps that call's messaging timeout at the time
    /// left — that is what makes `treeTimeoutSeconds` an actual wall-clock
    /// bound instead of a per-node suggestion (R2-19).
    private func buildNode(
        for element: AXUIElement,
        depth: Int,
        maxDepth: Int,
        deadline: CFTimeInterval
    ) throws -> AxNode {
        let role = try attributeString(element, kAXRoleAttribute, deadline: deadline) ?? ""
        let title = try attributeString(element, kAXTitleAttribute, deadline: deadline)
        let identifier = try attributeString(element, kAXIdentifierAttribute, deadline: deadline)
        var children: [AxNode] = []
        if depth < maxDepth, let childElements = try childElements(of: element, deadline: deadline) {
            children = try childElements.map {
                try buildNode(for: $0, depth: depth + 1, maxDepth: maxDepth, deadline: deadline)
            }
        }
        return AxNode(role: role, title: title, identifier: identifier, children: children)
    }

    /// Reads AXChildren. nil means "this element says it has no children
    /// attribute" — a definitive answer. A read that never completed throws
    /// through the same classifier as every other attribute read, so the tree
    /// walk and the selector search cannot disagree about one failure
    /// (R2-06: they used to, and `observe` reported "leaf" where it should
    /// have reported "unread").
    private func childElements(
        of element: AXUIElement,
        deadline: CFTimeInterval
    ) throws -> [AXUIElement]? {
        try Self.enforceBudget(on: element, deadline: deadline, what: "reading \(kAXChildrenAttribute)")
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(
            element, kAXChildrenAttribute as CFString, &value
        )
        switch Self.classifyAttributeRead(
            error: error,
            hasValue: value != nil,
            processTrusted: AXIsProcessTrusted(),
            action: "walking children"
        ) {
        case .answered:
            // 分档已保证 `.answered` 只在拿到值时出现；这里只做类型收窄。
            guard let read = value else { return nil }
            return (read as? [AXUIElement]) ?? []
        case .noAnswer:
            return nil
        case .unreadable(let channelError):
            throw channelError
        }
    }

    /// Iterative selector search; the first match wins. nil means "the whole
    /// tree was read and nothing matched" — a failed read throws instead
    /// (R2-06), otherwise a busy main thread turns into the false statement
    /// "no element matches the selector" and the search can also skip the real
    /// target and hand back a later node with the same role.
    private func findElement(
        matching selector: Selector,
        root: AXUIElement,
        deadline: CFTimeInterval
    ) throws -> AXUIElement? {
        var stack: [(element: AXUIElement, depth: Int)] = [(root, 0)]
        while let (current, depth) = stack.popLast() {
            // depth 0 是 app 元素本身，不参与匹配：选择器打的是界面里的控件。
            if depth > 0 {
                let matched = try elementMatches(selector, current, deadline: deadline)
                if matched { return current }
            }
            if depth < Self.searchMaxDepth,
               let children = try childElements(of: current, deadline: deadline) {
                stack.append(contentsOf: children.reversed().map { ($0, depth + 1) })
            }
        }
        return nil
    }

    private func elementMatches(
        _ selector: Selector,
        _ element: AXUIElement,
        deadline: CFTimeInterval
    ) throws -> Bool {
        guard let role = try attributeString(element, kAXRoleAttribute, deadline: deadline) else {
            return false
        }
        if !Self.roleMatches(selectorRole: selector.role, axRole: role) {
            return false
        }
        if let wantedTitle = selector.title {
            let title = try attributeString(element, kAXTitleAttribute, deadline: deadline)
            if title != wantedTitle { return false }
        }
        if let wantedIdentifier = selector.identifier {
            let identifier = try attributeString(
                element, kAXIdentifierAttribute, deadline: deadline
            )
            if identifier != wantedIdentifier { return false }
        }
        return true
    }

    // MARK: - Attribute helpers

    /// Single-attribute string read used by every walk. `nil` now means only
    /// "the element definitively has no string value for this attribute"
    /// (unsupported / no value / a non-string answer); every other outcome —
    /// timeout, API disabled, stale element — throws (R2-06). Those were
    /// previously folded into "does not match", which is what turned an
    /// unreadable app into a reported-absent element and a dead click.
    private func attributeString(
        _ element: AXUIElement,
        _ attribute: String,
        deadline: CFTimeInterval
    ) throws -> String? {
        try Self.enforceBudget(on: element, deadline: deadline, what: "reading \(attribute)")
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        switch Self.classifyAttributeRead(
            error: error,
            hasValue: value != nil,
            processTrusted: AXIsProcessTrusted(),
            action: "reading \(attribute)"
        ) {
        case .answered:
            guard let read = value else { return nil }
            // 值读到了但不是字符串 —— 那是"这个属性没有字符串答案"的确定事实。
            return read as? String
        case .noAnswer:
            return nil
        case .unreadable(let channelError):
            throw channelError
        }
    }

    /// 一次属性读取的三种结局。区分它们是本文件的存在理由：前两种是关于
    /// **目标界面**的事实，第三种是关于**我们这次读**的事实，绝不能互相冒充。
    enum AttributeReadOutcome: Equatable {
        /// 读到了一个值（类型是否可用由调用方判）。
        case answered
        /// 元素明确不回答这个属性：不支持、无值、或该属性根本未实现。
        /// 这是"界面上没有"的确定答案，可以当不匹配/空处理。
        case noAnswer
        /// 读取本身失败了（超时、API 被关闭、元素已失效……）——
        /// 关于界面什么都没测到，必须作为错误传播。
        case unreadable(ChannelError)
    }

    /// 纯分档函数（`processTrusted` 注入，可在无 AX 目标下单测）。
    /// 只有 `attributeUnsupported` / `noValue` / `notImplemented` 是确定答案；
    /// 其余一律 `unreadable`，并与本文件既有的抛错口径一致。
    static func classifyAttributeRead(
        error: AXError,
        hasValue: Bool,
        processTrusted: Bool,
        action: String
    ) -> AttributeReadOutcome {
        switch error {
        case .success:
            return hasValue ? .answered : .noAnswer
        case .attributeUnsupported, .noValue, .notImplemented:
            return .noAnswer
        case .cannotComplete:
            return .unreadable(
                permissionOrPingTimeout(action: action, processTrusted: processTrusted)
            )
        case .apiDisabled:
            return .unreadable(ChannelError.axUnavailable(reason: "AX API is disabled"))
        case .invalidUIElement:
            return .unreadable(ChannelError.axUnavailable(
                reason: "the element went away while trying to \(action); re-attach and retry"
            ))
        default:
            return .unreadable(ChannelError.axUnavailable(
                reason: "trying to \(action) failed (kAXError \(error.rawValue))"
            ))
        }
    }

    /// 预算闸 + 逐调用超时缩放（R2-19）：在**每一次** AX 调用之前查剩余预算，
    /// 并把该次调用的 messaging timeout 压进剩余时间里。因为"第 k 次调用的超时
    /// ≤ 第 k 次开始时的剩余"，整次遍历的累计耗时不可能超过预算；旧实现只在节点
    /// 入口查一次，而同一个节点要发 3 次属性读 + 1 次 children 读，各带自己的
    /// 超时（子元素还从未继承 attach 时设的值），所以宣称的硬上界可以超好几倍。
    static func enforceBudget(
        on element: AXUIElement,
        deadline: CFTimeInterval,
        what: String
    ) throws {
        let remaining = deadline - CFAbsoluteTimeGetCurrent()
        guard let timeout = messagingTimeout(remaining: remaining) else {
            throw ChannelError.treeCaptureFailed(
                reason: "the \(treeTimeoutSeconds)s accessibility budget ran out before \(what)"
            )
        }
        // 返回值不检查：设置超时失败最常见的原因是元素已失效，
        // 而那会紧接着被下一次读取以 kAXError 形态报出来（不会静默）。
        AXUIElementSetMessagingTimeout(element, timeout)
    }

    /// 纯函数：剩余预算 → 下一次 AX 调用允许的 messaging timeout（秒）。
    /// nil = 剩余不足以再发一次调用，调用方必须中止，而不是"顺手再读一次"。
    /// 上限是 `messagingTimeoutSeconds`；下限是 `minMessagingTimeoutSeconds`
    /// （低于它就不发，避免把 0 交给 API —— 0 的语义是"恢复系统默认超时"）。
    static func messagingTimeout(remaining: CFTimeInterval) -> Float? {
        guard remaining >= minMessagingTimeoutSeconds else { return nil }
        return Float(min(remaining, messagingTimeoutSeconds))
    }

    /// Distinguishes "app hung" from "permission revoked mid-session" for
    /// kAXErrorCannotComplete, which can mean both.
    static func permissionOrPingTimeout(action: String, processTrusted: Bool) -> ChannelError {
        guard processTrusted else {
            return ChannelError.axUnavailable(
                reason: "accessibility permission revoked while trying to \(action)"
            )
        }
        return ChannelError.pingTimeout
    }

    /// Accepts "AXButton", "button" and "Button" spellings for the same role.
    private static func roleMatches(selectorRole: String, axRole: String) -> Bool {
        let expected = selectorRole.lowercased()
        let actual = axRole.lowercased()
        return actual == expected || actual == "ax" + expected || expected == "ax" + actual
    }

    private static func axActionName(for action: Action) -> String {
        switch action {
        case .press: return kAXPressAction
        case .increment: return kAXIncrementAction
        case .decrement: return kAXDecrementAction
        case .showMenu: return kAXShowMenuAction
        case .confirm: return kAXConfirmAction
        case .cancel: return kAXCancelAction
        case .pick: return kAXPickAction
        }
    }

    private static func axAttribute(for property: AssertionProperty) -> String {
        switch property {
        case .title: return kAXTitleAttribute
        case .value: return kAXValueAttribute
        case .role: return kAXRoleAttribute
        case .enabled: return kAXEnabledAttribute
        case .focused: return kAXFocusedAttribute
        }
    }

    /// Converts a value that *was* read into the comparable assertion shape.
    /// Nothing is ever synthesised: no value, or a value whose type cannot
    /// answer the asked-for property, throws (R2-15). The old form handed back
    /// `.string("")` for a NULL boolean attribute and `.bool(false)` for
    /// anything non-boolean, so an assertion of `expected: false` could PASS on
    /// an attribute that never answered — an observation invented out of a
    /// failed read.
    static func stringOrBool(
        from value: CFTypeRef?,
        attribute: String,
        property: AssertionProperty
    ) throws -> StringOrBool {
        // 读不出可比对答案时的统一措辞：缺失就表达为缺失，绝不给一个空串或 false。
        func unobservable(_ because: String) -> ChannelError {
            ChannelError.attributeUnavailable(
                reason: "element's \(attribute) gave no \(property.rawValue) answer (\(because))"
            )
        }
        guard let value else {
            throw unobservable("the attribute answered with no value")
        }
        switch property {
        case .role, .title:
            if let string = value as? String { return .string(string) }
            throw unobservable("answer is \(type(of: value)), not text")
        case .value:
            if let string = value as? String { return .string(string) }
            if let number = value as? NSNumber { return .string(number.stringValue) }
            throw unobservable("answer is \(type(of: value)), neither text nor number")
        case .enabled, .focused:
            if let bool = value as? Bool { return .bool(bool) }
            if let number = value as? NSNumber { return .bool(number.boolValue) }
            throw unobservable("answer is \(type(of: value)), not a boolean")
        }
    }

    private static func performFailureReason(error: AXError, action: Action) -> String {
        switch error {
        case .actionUnsupported:
            return "element does not support action '\(action.rawValue)'"
        case .invalidUIElement:
            return "element became invalid before the action ran"
        default:
            return "AX action '\(action.rawValue)' failed (kAXError \(error.rawValue))"
        }
    }

    private func frontmostOnScreenWindow(of pid: pid_t) -> (Int, CGRect)? {
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly], kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }
        for window in windowList {
            guard let ownerPid = window[Self.windowOwnerPIDKey] as? Int,
                  ownerPid == Int(pid),
                  let windowId = window[Self.windowNumberKey] as? Int,
                  let bounds = Self.rect(fromWindowBounds: window[Self.windowBoundsKey]),
                  bounds.width > 0, bounds.height > 0 else {
                continue
            }
            return (windowId, bounds)
        }
        return nil
    }

    /// CGWindowInfo dictionary keys (values from CGWindow.h; the Swift
    /// constants are unavailable in the current SDK).
    private static let windowNumberKey = "kCGWindowNumber"
    private static let windowOwnerPIDKey = "PID"
    private static let windowBoundsKey = "Bounds"

    private static func rect(fromWindowBounds raw: Any?) -> CGRect? {
        guard let dict = raw as? [String: Any],
              let x = dict["X"] as? Double,
              let y = dict["Y"] as? Double,
              let width = dict["Width"] as? Double,
              let height = dict["Height"] as? Double else {
            return nil
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }
}
