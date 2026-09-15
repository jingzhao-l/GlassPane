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

    /// AX messaging timeout in seconds — mirrors EngineCore.pingTimeoutMs.
    private static let messagingTimeoutSeconds: CFTimeInterval = 2.0
    /// Total wall-clock budget for one treeSnapshot before it aborts. A hung
    /// app can stall every child read up to messagingTimeout, so without a
    /// cumulative budget observe would block for minutes (seen on real apps).
    private static let treeTimeoutSeconds: CFTimeInterval = 10.0
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
            throw Self.permissionOrPingTimeout(action: "ping")
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

    public func performAction(selector: Selector, action: Action) throws {
        let element = try requireAppElement()
        guard let target = try findElement(matching: selector, root: element) else {
            throw ChannelError.actRejected(reason: "no element matches the selector")
        }
        let actionName = Self.axActionName(for: action)
        let error = AXUIElementPerformAction(target, actionName as CFString)
        guard error == .success else {
            throw ChannelError.actRejected(
                reason: Self.performFailureReason(error: error, action: action)
            )
        }
    }

    public func readProperty(selector: Selector, property: AssertionProperty) throws -> StringOrBool {
        let element = try requireAppElement()
        guard let target = try findElement(matching: selector, root: element) else {
            throw ChannelError.assertTargetNotFound
        }
        let attribute = Self.axAttribute(for: property)
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(target, attribute as CFString, &value)
        switch error {
        case .success:
            return Self.stringOrBool(from: value, property: property)
        case .noValue:
            // An absent value is an honest empty string for text properties,
            // but cannot be invented for booleans.
            if property == .value || property == .title {
                return .string("")
            }
            throw ChannelError.attributeUnavailable(reason: "element does not expose \(attribute)")
        case .attributeUnsupported, .notImplemented:
            throw ChannelError.attributeUnavailable(reason: "element does not expose \(attribute)")
        case .cannotComplete:
            throw Self.permissionOrPingTimeout(action: "read \(attribute)")
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
    /// The wall-clock deadline caps cumulative AX reads across the whole walk.
    private func buildNode(
        for element: AXUIElement,
        depth: Int,
        maxDepth: Int,
        deadline: CFTimeInterval
    ) throws -> AxNode {
        if CFAbsoluteTimeGetCurrent() > deadline {
            throw ChannelError.treeCaptureFailed(
                reason: "tree capture exceeded the total \(Self.treeTimeoutSeconds)s budget"
            )
        }
        let role = attributeString(element, kAXRoleAttribute) ?? ""
        let title = attributeString(element, kAXTitleAttribute)
        let identifier = attributeString(element, kAXIdentifierAttribute)
        var children: [AxNode] = []
        if depth < maxDepth, let childElements = try childElements(of: element) {
            children = try childElements.map {
                try buildNode(for: $0, depth: depth + 1, maxDepth: maxDepth, deadline: deadline)
            }
        }
        return AxNode(role: role, title: title, identifier: identifier, children: children)
    }

    /// Reads AXChildren; nil means "leaf or attribute unsupported".
    private func childElements(of element: AXUIElement) throws -> [AXUIElement]? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(
            element, kAXChildrenAttribute as CFString, &value
        )
        guard error == .success, let value else {
            switch error {
            case .cannotComplete:
                throw Self.permissionOrPingTimeout(action: "walk children")
            case .apiDisabled:
                throw ChannelError.axUnavailable(reason: "AX API is disabled")
            default:
                return nil
            }
        }
        return (value as? [AXUIElement]) ?? []
    }

    /// Iterative selector search; the first match wins.
    private func findElement(matching selector: Selector, root: AXUIElement) throws -> AXUIElement? {
        var stack: [(element: AXUIElement, depth: Int)] = [(root, 0)]
        while let (current, depth) = stack.popLast() {
            if depth > 0 && elementMatches(selector, current) {
                return current
            }
            if depth < Self.searchMaxDepth, let children = try childElements(of: current) {
                stack.append(contentsOf: children.reversed().map { ($0, depth + 1) })
            }
        }
        return nil
    }

    private func elementMatches(_ selector: Selector, _ element: AXUIElement) -> Bool {
        guard let role = attributeString(element, kAXRoleAttribute),
              Self.roleMatches(selectorRole: selector.role, axRole: role) else {
            return false
        }
        if let wantedTitle = selector.title,
           attributeString(element, kAXTitleAttribute) != wantedTitle {
            return false
        }
        if let wantedIdentifier = selector.identifier,
           attributeString(element, kAXIdentifierAttribute) != wantedIdentifier {
            return false
        }
        return true
    }

    // MARK: - Attribute helpers

    /// Single-attribute string read. nil = missing / unsupported / non-string.
    private func attributeString(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard error == .success, let value else { return nil }
        return value as? String
    }

    /// Distinguishes "app hung" from "permission revoked mid-session" for
    /// kAXErrorCannotComplete, which can mean both.
    private static func permissionOrPingTimeout(action: String) -> ChannelError {
        guard AXIsProcessTrusted() else {
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

    private static func stringOrBool(from value: CFTypeRef?, property: AssertionProperty) -> StringOrBool {
        guard let value else { return .string("") }
        switch property {
        case .role, .title:
            return .string((value as? String) ?? "")
        case .value:
            if let string = value as? String { return .string(string) }
            if let number = value as? NSNumber { return .string(number.stringValue) }
            return .string("")
        case .enabled, .focused:
            if let bool = value as? Bool { return .bool(bool) }
            if let number = value as? NSNumber { return .bool(number.boolValue) }
            return .bool(false)
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
