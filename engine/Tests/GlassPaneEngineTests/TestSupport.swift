import XCTest
import CoreGraphics
@testable import GlassPaneEngine

// XCTest transitively exposes ObjectiveC.Selector on macOS; pin the engine's
// selector type module-wide for the test target.
typealias Selector = GlassPaneEngine.Selector

// MARK: - Scripted fake channel

/// Scripted RuntimeChannel: every method returns queued results, falling
/// back to stable defaults once the queue is exhausted. Records call counts
/// so tests can assert on engine behavior without any AX dependency.
final class ScriptedChannel: RuntimeChannel {

    var app: AttachedApp
    var attachError: ChannelError?
    var alive = true
    var pingResult: Result<Double, ChannelError> = .success(3)
    var treeResults: [Result<AxTreeSnapshot, ChannelError>] = []
    var fallbackTree: AxTreeSnapshot
    var actionError: ChannelError?
    var propertyResult: Result<StringOrBool, ChannelError> = .success(.bool(true))
    var captureResults: [Result<CGImage, ChannelError>] = []
    var fallbackCapture: CGImage?

    private(set) var attachCallCount = 0
    private(set) var pingCallCount = 0
    private(set) var treeCallCount = 0
    private(set) var actionCallCount = 0
    private(set) var propertyCallCount = 0
    private(set) var captureCallCount = 0

    init(
        app: AttachedApp = AttachedApp(
            pid: 4242, bundleId: "com.example.app", appName: "Example"
        ),
        fallbackTree: AxTreeSnapshot
    ) {
        self.app = app
        self.fallbackTree = fallbackTree
    }

    func attach(bundleId: String?, pid: pid_t?) throws -> AttachedApp {
        attachCallCount += 1
        if let attachError { throw attachError }
        return app
    }

    func ping() throws -> Double {
        pingCallCount += 1
        return try pingResult.get()
    }

    func treeSnapshot(maxDepth: Int) throws -> AxTreeSnapshot {
        treeCallCount += 1
        if !treeResults.isEmpty {
            return try treeResults.removeFirst().get()
        }
        return fallbackTree
    }

    func performAction(selector: Selector, action: Action) throws {
        actionCallCount += 1
        if let actionError { throw actionError }
    }

    func readProperty(selector: Selector, property: AssertionProperty) throws -> StringOrBool {
        propertyCallCount += 1
        return try propertyResult.get()
    }

    func isProcessAlive() -> Bool {
        alive
    }

    func captureWindow() throws -> WindowCapture {
        captureCallCount += 1
        var image: CGImage
        if !captureResults.isEmpty {
            image = try captureResults.removeFirst().get()
        } else if let fallbackCapture {
            image = fallbackCapture
        } else {
            throw ChannelError.pixelCaptureDenied(reason: "no capture scripted")
        }
        return WindowCapture(
            windowId: 12,
            bounds: Bounds(x: 0, y: 0, width: 32, height: 32),
            image: image
        )
    }
}

// MARK: - Test trees

enum TestTrees {

    static func snapshot(_ roots: [AxNode]) -> AxTreeSnapshot {
        AxTreeSnapshot(
            roots: roots,
            digest: (try? TreeDigest.digest(roots)) ?? "",
            nodeCount: TreeDigest.nodeCount(roots),
            latencyMs: 1
        )
    }

    /// A small representative tree: window > (button, staticText, checkbox).
    static let standard: AxTreeSnapshot = snapshot([
        AxNode(
            role: "AXWindow", title: "Main",
            children: [
                AxNode(role: "AXButton", title: "Submit", identifier: "submit-button"),
                AxNode(role: "AXStaticText", title: "Hello"),
                AxNode(role: "AXCheckBox", title: "Agree", identifier: "agree-checkbox"),
            ]
        )
    ])

    /// Same shape as `standard` but with the button retitled — a digest change.
    static let buttonRetitled: AxTreeSnapshot = snapshot([
        AxNode(
            role: "AXWindow", title: "Main",
            children: [
                AxNode(role: "AXButton", title: "Submitted", identifier: "submit-button"),
                AxNode(role: "AXStaticText", title: "Hello"),
                AxNode(role: "AXCheckBox", title: "Agree", identifier: "agree-checkbox"),
            ]
        )
    ])
}

// MARK: - Synthetic images

enum TestImages {

    static let sideLength = 32

    static func image(
        width: Int = sideLength,
        height: Int = sideLength,
        paint: (Int, Int) -> (UInt8, UInt8, UInt8, UInt8)
    ) -> CGImage {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let (r, g, b, a) = paint(x, y)
                let offset = (y * width + x) * 4
                pixels[offset] = r
                pixels[offset + 1] = g
                pixels[offset + 2] = b
                pixels[offset + 3] = a
            }
        }
        let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        return context.makeImage()!
    }

    static func solid(
        _ value: UInt8,
        width: Int = sideLength,
        height: Int = sideLength
    ) -> CGImage {
        image(width: width, height: height) { _, _ in (value, value, value, 255) }
    }

    /// Same as `solid`, but the top-left quadrant is brightened by `delta`.
    static func quadrantChanged(
        base: UInt8,
        delta: Int,
        width: Int = sideLength,
        height: Int = sideLength
    ) -> CGImage {
        let half = width / 2
        return image(width: width, height: height) { x, y in
            if x < half && y < half {
                return (UInt8(clamping: Int(base) + delta), base, base, 255)
            }
            return (base, base, base, 255)
        }
    }
}

// MARK: - State-file isolation (P8: R7-02 + B2)

/// The only sanctioned source of paths for the three file-backed state objects
/// of this target (project registry, evidence archive, approval ledger).
///
/// This is not a style rule. Each of those types falls back to a production
/// location when it is constructed without one, and that location is the
/// projects/approvals/evidence state under the home directory. The home
/// lookup behind those defaults does not honour a `HOME` override, so
/// pointing `HOME` at a sandbox before running the suite protects nothing:
/// on 2026-09-23 a `swift test` run replaced the developer's real
/// `projects.json` (71 entries) with the two synthetic entries a test creates
/// and wrote packs into the real evidence archive. An after-the-fact check is
/// worthless here — detection after destruction is not isolation — so the
/// rule is structural: no test may build a state object with a production
/// default. `TestIsolationGateTests` fails the target when such a
/// construction reappears in test source; everything below is checked at
/// runtime by `assertIsolated`.
enum TestSandbox {

    /// Process-scoped root under the system temp directory. `swift test` runs
    /// the whole target in one process, so tests never share a path with each
    /// other and never reuse a leftover directory.
    static let root = NSTemporaryDirectory() + "gp-t\(ProcessInfo.processInfo.processIdentifier)"

    /// A unique directory for one purpose, created on demand. A sandbox that
    /// could not be created is reported as such — every later assertion of the
    /// test would otherwise read as a defect in the code under test.
    static func directory(_ label: String = "state") -> String {
        let path = "\(root)/\(token(label))-\(UUID().uuidString.prefix(8))"
        assertIsolated(path, label: label)
        do {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        } catch {
            XCTFail("test sandbox could not create \(path): \(error)")
        }
        return path
    }

    /// A unique path for single-file state (the registry table, the approval
    /// ledger). The parent directory is created here; the file is not —
    /// neither type treats a missing file as damage.
    static func filePath(_ label: String = "state") -> String {
        directory(label) + "/\(token(label)).json"
    }

    /// A registry over an empty file in the temp directory. Hand one to every
    /// `EngineCore` a test builds: without a `projectRegistry:` argument the
    /// engine initializer creates its own, and that one reads the real state
    /// file, so a test's project lookups would depend on this machine.
    static func projectRegistry(_ label: String = "registry") -> ProjectRegistry {
        ProjectRegistry(filePath: filePath(label))
    }

    /// An archive bound to a fresh temp directory. The route new tests should
    /// take: the parameter is a non-optional `String`, so no caller can
    /// forward a nil default into the archive location, and the path is
    /// checked by `assertIsolated` before the store is built.
    static func evidenceStore(at directory: String, maxFiles: Int? = nil) -> EvidenceStore {
        assertIsolated(directory, label: "evidence")
        return EvidenceStore(directory: directory, maxFiles: maxFiles)
    }

    /// A file-persisted approval ledger at a fresh temp path, plus that path
    /// (the type keeps its own path private, and the isolation contract is
    /// only checkable from outside). Exists so a test that needs a *persisted*
    /// ledger has a safe route: a bare `ApprovalGate()` is in-memory only,
    /// while the production ledger path must never be appended to by a test.
    static func approvalLedger(
        _ label: String = "approvals"
    ) -> (gate: ApprovalGate, path: String) {
        let path = filePath(label)
        return (ApprovalGate(path: path), path)
    }

    /// The runtime half of the isolation gate (design (b)): a state path must
    /// sit inside the system temp directory and must never carry a component
    /// of the production state folder. Called on every path handed out above.
    static func assertIsolated(
        _ path: String,
        label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(
            path.hasPrefix(NSTemporaryDirectory()),
            "test state path \(path) for \(label) is outside NSTemporaryDirectory(); "
                + "it can reach the real per-user state",
            file: file,
            line: line
        )
        XCTAssertFalse(
            // Spelled in pieces on purpose: the source gate of
            // `TestIsolationGateTests` reads this file too.
            path.contains("/." + "glasspane"),
            "test state path \(path) for \(label) names the production state folder",
            file: file,
            line: line
        )
    }

    /// A filesystem-safe fragment of a test label.
    private static func token(_ label: String) -> String {
        String(label.filter { $0.isLetter || $0.isNumber }.prefix(12)).lowercased()
    }
}

// MARK: - Kernel fixtures (C35 shared truth set)

enum KernelFixtures {

    static func data(_ name: String) throws -> Data {
        let testFile = URL(fileURLWithPath: #filePath)
        let fixturesURL = testFile
            .deletingLastPathComponent()  // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // engine
            .deletingLastPathComponent()  // repo root
            .appendingPathComponent("kernel/fixtures/\(name)")
        return try Data(contentsOf: fixturesURL)
    }
}

/// Canonicalizes arbitrary JSON bytes: parse, then re-serialize with sorted
/// keys and no whitespace — the same normalization rule the kernel tests use.
func canonicalJSON(_ data: Data) throws -> Data {
    let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}
