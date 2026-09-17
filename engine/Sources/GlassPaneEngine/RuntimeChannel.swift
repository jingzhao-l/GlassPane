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

/// An in-memory baseline of the attached app's observable state
/// (P1 spec v1.1 §1.5). Kept digest-only — no tree copy — so the retention
/// cap stays bounded.
public struct AppStateSnapshot: Equatable {
    public let snapshotId: String
    public let treeDigest: String
    public let nodeCount: Int
    public let capturedAt: String
    /// Z5 probe payload captured alongside the tree baseline (P5 v5.0 §6.2).
    /// Nil for snapshots taken without a probe; engine-internal shape — never
    /// written into an evidence schema.
    public let probeInfo: SnapshotProbeInfo?

    public init(
        snapshotId: String,
        treeDigest: String,
        nodeCount: Int,
        capturedAt: String,
        probeInfo: SnapshotProbeInfo? = nil
    ) {
        self.snapshotId = snapshotId
        self.treeDigest = treeDigest
        self.nodeCount = nodeCount
        self.capturedAt = capturedAt
        self.probeInfo = probeInfo
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
