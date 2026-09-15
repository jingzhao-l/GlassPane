import Foundation
import CoreGraphics

/// The runtime surface EngineCore depends on. The AX adapter is the real
/// implementation (requires accessibility permission at runtime); tests use
/// a scripted fake. Splitting here keeps the act pipeline, evidence assembly
/// and protocol layer 100% unit-testable (5.8 R45).
public struct AttachedApp: Equatable {
    public let pid: pid_t
    public let bundleId: String?
    public let appName: String

    public init(pid: pid_t, bundleId: String?, appName: String) {
        self.pid = pid
        self.bundleId = bundleId
        self.appName = appName
    }
}

public struct AxTreeSnapshot: Equatable {
    public let roots: [AxNode]
    public let digest: String
    public let nodeCount: Int
    public let latencyMs: Double

    public init(roots: [AxNode], digest: String, nodeCount: Int, latencyMs: Double) {
        self.roots = roots
        self.digest = digest
        self.nodeCount = nodeCount
        self.latencyMs = latencyMs
    }
}

public struct WindowCapture {
    public let windowId: Int
    public let bounds: Bounds
    public let image: CGImage

    public init(windowId: Int, bounds: Bounds, image: CGImage) {
        self.windowId = windowId
        self.bounds = bounds
        self.image = image
    }
}

public enum ChannelError: Error, Equatable {
    /// AX API unavailable — typically missing accessibility permission.
    case axUnavailable(reason: String)
    case appNotFound
    /// The element exists but rejected the action.
    case actRejected(reason: String)
    case assertTargetNotFound
    /// Tree capture failed partially (timeout on subtree); channel alive.
    case treeCaptureFailed(reason: String)
    /// The element exists but does not expose the asserted AX attribute.
    case attributeUnavailable(reason: String)
    /// Screen recording denied or the window is not on screen.
    case pixelCaptureDenied(reason: String)
    /// AX ping exceeded the messaging timeout.
    case pingTimeout
}

public protocol RuntimeChannel: AnyObject {
    func attach(bundleId: String?, pid: pid_t?) throws -> AttachedApp
    /// Returns the ping round-trip in milliseconds; throws .pingTimeout.
    func ping() throws -> Double
    func treeSnapshot(maxDepth: Int) throws -> AxTreeSnapshot
    func performAction(selector: Selector, action: Action) throws
    func readProperty(selector: Selector, property: AssertionProperty) throws -> StringOrBool
    func isProcessAlive() -> Bool
    func captureWindow() throws -> WindowCapture
}
