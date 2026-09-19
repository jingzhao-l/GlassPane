import Foundation

// MARK: - Z1 macro declaration (P6 spec v6.0 §1)

/// Instrument one expression as a handler call site: records entry (and
/// duration when >1ms) on the probe channel, then evaluates the expression
/// exactly once and passes its value through. No reflection, no allocation
/// beyond the event frame; build-time cost is governed by the C1 inflation
/// budget measured in P6 §8 H7.
///
/// ```swift
/// Button("Count") { #gpHandler(model.count += 1) }
/// ```
@freestanding(expression)
public macro gpHandler<T>(_ expression: T) -> T = #externalMacro(module: "GPProbeMacros", type: "HandlerMacro")
