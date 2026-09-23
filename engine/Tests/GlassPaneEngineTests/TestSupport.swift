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
    /// 逐次返回的存活序列（非 nil 时覆盖 `alive`）。用于表达"操作前活着、
    /// 操作后没了"这种真崩溃形态——单一 `alive` 只能造出 before==after，
    /// 于是崩溃类判定此前无法被单测覆盖。
    var aliveSequence: [Bool]?
    var aliveCallCount = 0
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
        if let sequence = aliveSequence {
            let index = min(aliveCallCount, sequence.count - 1)
            aliveCallCount += 1
            return sequence[index]
        }
        return alive
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
