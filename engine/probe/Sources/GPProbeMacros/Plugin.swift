import SwiftCompilerPlugin
import SwiftSyntax
import SwiftSyntaxMacros
import GPProbeMacroImpl

/// Registration face: the compiler resolves
/// `#externalMacro(module: "GPProbeMacros", type: "HandlerMacro")` by the
/// *defining module* of the provided type, so the plugin exposes its own
/// thin wrapper over the imported implementation.
public struct HandlerMacro: ExpressionMacro {
    public static func expansion(
        of node: some FreestandingMacroExpansionSyntax,
        in context: some MacroExpansionContext
    ) throws -> ExprSyntax {
        try GPProbeMacroImpl.HandlerMacro.expansion(of: node, in: context)
    }
}

@main
struct GPProbeMacrosPlugin: CompilerPlugin {
    let providingMacros: [Macro.Type] = [HandlerMacro.self]
}
