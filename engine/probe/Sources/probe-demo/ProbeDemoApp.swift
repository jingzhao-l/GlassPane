import SwiftUI
import GlassPaneProbe

// probe-demo — the P6 spec v6.0 §4 synthetic control app: one button per
// diagnosis class so real-machine smoke can pin T3/T4/T5/T7/T8 + NO_ANOMALY
// and the tier-1 checkpoint path end to end.

final class DemoModel: NSObject, ObservableObject {
    static let shared = DemoModel()

    /// KVC-observable via @objc dynamic; shown in the UI (baseline channel).
    @objc dynamic var count: Int = 0 { didSet { objectWillChange.send() } }
    /// KVC-observable but NOT shown: writes prove "state moved, UI stayed"
    /// (T5, SwiftUI dependency loss).
    @objc dynamic var hidden: Int = 0 { didSet { objectWillChange.send() } }
    /// Shown but NOT registered with the probe: "UI moved, state silent"
    /// (T7, view-model decoupling from the probe's point of view).
    var drift: Int = 0 { didSet { objectWillChange.send() } }

    static func noOp() -> Int { 0 }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("count: \(model.count)").accessibilityIdentifier("count-label")
            Text("drift: \(model.drift)").accessibilityIdentifier("drift-label")
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
        }
        .padding()
    }
}
