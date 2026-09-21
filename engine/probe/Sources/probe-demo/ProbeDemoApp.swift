import SwiftUI
import GlassPaneProbe
#if canImport(MetalKit)
import MetalKit
#endif

// probe-demo — the P6 spec v6.0 §4 synthetic control app: one button per
// diagnosis class so real-machine smoke can pin T3/T4/T5/T7/T8 + NO_ANOMALY
// and the tier-1 checkpoint path end to end.
//
// 2026-09-21 (Phase B 前置补数)：三个 spike 缺的合成分面——
//   H5：LazyVStack 动态容器（屏外行不实例化，选择器索引失效率可观测）；
//   H6：可重放的观测型 store（rollback 直写 value，onAppear 计数若增加即
//       说明重放触发了生命周期副作用——真重放型抑制判定）；
//   H4：MTKView + env 门控的 capture 场景自采（GP_DEMO_CAPTURE_SCENARIOS=1
//       + GP_DEMO_CAPTURE_MANIFEST=<path>），三场景结果写 JSON 供 results.md。
//
// ReplayStore 用 ObservableObject+objectWillChange 手动触发（视图重渲真实、
// 不依赖 Observation 宏的部署门槛），H6 判定的是"重放路径不重发生命周期"，
// 与 @Observable/ ObservableObject 的选择无关——此口径在 results.md 标注。

final class DemoModel: NSObject, ObservableObject {
    static let shared = DemoModel()

    @objc dynamic var count: Int = 0 { didSet { objectWillChange.send() } }
    @objc dynamic var hidden: Int = 0 { didSet { objectWillChange.send() } }
    var drift: Int = 0 { didSet { objectWillChange.send() } }

    static func noOp() -> Int { 0 }
}

final class ReplayStore: ObservableObject {
    static let shared = ReplayStore()
    var value: Int = 0 { didSet { objectWillChange.send() } }
    var appearCount: Int = 0 { didSet { objectWillChange.send() } }
}

final class LazyRows: ObservableObject {
    static let shared = LazyRows()
    @Published var items: [String] = (1...3).map { "row-\($0)" }
}

@main
struct ProbeDemoApp: App {
    @ObservedObject private var model = DemoModel.shared

    init() {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.regular)
        GP.start(appName: "probe-demo")
        GP.registerKVCObject(DemoModel.shared, label: "demo", keys: ["count", "hidden"])
        GP.registerCheckpoint(
            domain: "count-domain",
            get: { ["count": String(DemoModel.shared.count)] },
            set: { values in
                if let raw = values["count"], let parsed = Int(raw) {
                    DemoModel.shared.count = parsed
                }
            }
        )
        let replay = ReplayStore.shared
        GP.registerCheckpoint(
            domain: "replay-domain",
            get: { ["value": String(replay.value)] },
            set: { values in
                if let raw = values["value"], let parsed = Int(raw) {
                    replay.value = parsed  // direct write: replay path, no lifecycle events
                }
            }
        )
        if ProcessInfo.processInfo.environment["GP_DEMO_CAPTURE_SCENARIOS"] == "1" {
            CaptureScenarioRunner.scheduleIfNeeded()
        }
    }

    var body: some Scene {
        WindowGroup("GlassPane Probe Demo") {
            ContentView(model: model)
                .frame(minWidth: 360, minHeight: 320)
        }
    }
}

struct ContentView: View {
    @ObservedObject var model: DemoModel
    @ObservedObject private var rows = LazyRows.shared
    @ObservedObject private var replay = ReplayStore.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("count: \(model.count)").accessibilityIdentifier("count-label")
                Text("drift: \(model.drift)").accessibilityIdentifier("drift-label")
                // ---- H6: replay panel (side-effect suppression subject) ----
                Text("replay").font(.headline)
                ReplayPanel(store: replay)
                Button("Replay Write") { #gpHandler(replay.value += 1) }
                    .accessibilityIdentifier("replay-write")

                // Structural markers: the AX tree digest only carries
                // role/title/identifier (SwiftUI Text content lives in AXValue,
                // 2026-09-19 真机发现), so "UI moved" is expressed as node-count
                // changes the classifier can actually observe.
                HStack {
                    ForEach(0 ..< min(model.count, 6), id: \.self) { _ in
                        Image(systemName: "circle.fill")
                    }
                }
                .accessibilityIdentifier("count-marker-row")
                HStack {
                    ForEach(0 ..< min(model.drift, 6), id: \.self) { _ in
                        Image(systemName: "star.fill")
                    }
                }
                .accessibilityIdentifier("drift-marker-row")

                // NO_ANOMALY + strong attribution: handler, state and UI all move.
                Button("OK Press") { #gpHandler(model.count += 1) }
                    .accessibilityIdentifier("ok-press")

                // T4 logic bug: instrumented handler runs, nothing else moves.
                Button("Dead Handler") { #gpHandler(DemoModel.noOp()) }
                    .accessibilityIdentifier("dead-handler")

                // T5 dependency loss: state moves (KVC), no UI element bound to it.
                Button("Hidden Write") { #gpHandler(model.hidden += 1) }
                    .accessibilityIdentifier("hidden-write")

                // T7 view-model decoupling: UI moves, the probe sees no state.
                Button("UI Only") { #gpHandler(model.drift += 1) }
                    .accessibilityIdentifier("ui-only")

                // T8 async timing: the only instrumented call lands 1.2s late —
                // beyond the worst-case act window (~0.7 s with a 171-node tree)
                // yet inside the 2 s late-arrival grace (P6 §2.3, 真机校准 0.4→1.2).
                Button("Delayed") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                        #gpHandler(model.count += 1)
                    }
                }
                .accessibilityIdentifier("delayed")

                // T3 dead click: uninstrumented handler that changes nothing.
                Button("Nothing") { _ = "no-op, not annotated" }
                    .accessibilityIdentifier("nothing")

                // ---- H5: lazy container / dynamic content ----
                Text("lazy rows").font(.headline)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(rows.items, id: \.self) { item in
                            HStack {
                                Image(systemName: "square")
                                Text(item)
                            }
                            .accessibilityIdentifier("lazy-row-\(item)")
                        }
                    }
                }
                .frame(height: 110)
                .accessibilityIdentifier("lazy-scroller")
                HStack {
                    Button("Add 20 Rows") {
                        #gpHandler(model.count += 1)
                        let base = rows.items.count
                        rows.items.append(contentsOf: (1...20).map { "row-\(base + $0)" })
                    }
                    .accessibilityIdentifier("add-rows")
                    Button("Remove Rows") {
                        #gpHandler(model.count += 1)
                        rows.items = Array(rows.items.prefix(3))
                    }
                    .accessibilityIdentifier("remove-rows")
                }

                // ---- H4: metal canvas (capture baseline channel) ----
                Text("metal canvas").font(.headline)
                MetalCanvas()
                    .frame(width: 90, height: 90)
                    .accessibilityIdentifier("metal-canvas")
            }
            .padding()
        }
    }
}

struct ReplayPanel: View {
    let store: ReplayStore

    var body: some View {
        VStack(alignment: .leading) {
            Text("replay: \(store.value)").accessibilityIdentifier("replay-label")
            Image(systemName: store.value.isMultiple(of: 2) ? "circle" : "circle.fill")
                .accessibilityIdentifier("replay-marker")
            // appearCount 做成结构节点行数：rollback 若重发生命周期，这行的
            // Image 数量会在 observe 树里可见地增长（H6 真重放判定面）。
            HStack(spacing: 1) {
                ForEach(0 ..< min(store.appearCount, 8), id: \.self) { i in
                    // observe 序列化不含无标识 Image；用带 identifier 的按钮做
                    // tick，保证 H6 判定面在树里可见（计数=onAppear 触发次数）。
                    Button("") {}
                        .buttonStyle(.borderless)
                        .frame(width: 8)
                        .accessibilityIdentifier("appear-tick-\(i)")
                }
            }
            .accessibilityIdentifier("replay-appear-row")
        }
        .onAppear { store.appearCount += 1 }
    }
}

struct MetalCanvas: NSViewRepresentable {
    func makeNSView(context: Context) -> MTKView {
        let view = MTKView()
        view.device = MTLCreateSystemDefaultDevice()
        view.clearColor = MTLClearColorMake(0.1, 0.3, 0.6, 1.0)
        view.enableSetNeedsDisplay = false
        view.isPaused = false
        view.preferredFramesPerSecond = 30
        return view
    }

    func updateNSView(_ nsView: MTKView, context: Context) {}
}

// MARK: - H4 scenario runner (env-gated; every GP.onMetalCaptureResult frame
// accumulates, scenarios slice the frame log by window)

enum CaptureScenarioRunner {
    private static let framesLock = NSLock()
    private static var frames: [[String: Any]] = []

    private static func record(_ path: String?, _ error: String?) {
        framesLock.lock()
        frames.append(["path": path ?? NSNull(), "error": error ?? NSNull()])
        framesLock.unlock()
    }

    private static func count() -> Int {
        framesLock.lock()
        defer { framesLock.unlock() }
        return frames.count
    }

    private static func slice(_ from: Int, _ to: Int) -> [[String: Any]] {
        framesLock.lock()
        defer { framesLock.unlock() }
        let lo = min(from, frames.count)
        let hi = min(max(to, lo), frames.count)
        return Array(frames[lo..<hi])
    }

    static func scheduleIfNeeded() {
        guard let manifestPath = ProcessInfo.processInfo.environment["GP_DEMO_CAPTURE_MANIFEST"],
              !manifestPath.isEmpty else { return }
        GP.onMetalCaptureResult = { path, error in record(path, error) }

        func runScenario(label: String, dest: URL?, holdMs: Double, animate: Bool, next: @escaping () -> Void) {
            let beginAt = count()
            GP.beginMetalCapture(destinationURL: dest)
            let afterBegin = count()
            DispatchQueue.main.asyncAfter(deadline: .now() + holdMs / 1000.0) {
                GP.endMetalCapture()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    let afterEnd = count()
                    let beginFrames = slice(beginAt, afterBegin)
                    let endFrames = slice(max(afterBegin, afterEnd - 1), afterEnd)
                    var info: [String: Any] = [
                        "beginFrames": beginFrames,
                        "endFrames": endFrames,
                        "animate": animate,
                    ]
                    if let first = beginFrames.first, let path = first["path"] as? String {
                        info["exists"] = FileManager.default.fileExists(atPath: path)
                    }
                    resultsLock.lock()
                    results[label] = info
                    let snapshot = results
                    resultsLock.unlock()
                    writeManifest(manifestPath, snapshot)
                    next()
                }
            }
        }

        let tmp = FileManager.default.temporaryDirectory
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
            runScenario(label: "A-static",
                        dest: tmp.appendingPathComponent("gp-capture-A.gputrace"),
                        holdMs: 800, animate: false) {
                runScenario(label: "B-animating",
                            dest: tmp.appendingPathComponent("gp-capture-B.gputrace"),
                            holdMs: 1200, animate: true) {
                    runScenario(label: "C-invalid-dest",
                                dest: URL(fileURLWithPath: "/nonexistent-dir-xyz/gp-capture-C.gputrace"),
                                holdMs: 400, animate: false) {
                        exit(0)  // scenario mode: the manifest is the only output
                    }
                }
            }
        }
    }

    private static let resultsLock = NSLock()
    private static var results: [String: Any] = [:]

    private static func writeManifest(_ path: String, _ results: [String: Any]) {
        let payload: [String: Any] = [
            "channel": "z4.5-baseline",
            "sdk": "gp-probe/0.1.0",
            "scenarios": results,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload,
                                                     options: [.prettyPrinted, .sortedKeys])
        else { return }
        try? data.write(to: URL(fileURLWithPath: path))
    }
}
