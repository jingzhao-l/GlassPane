import SwiftSyntax
import SwiftSyntaxBuilder
import SwiftSyntaxMacros

/// `#gpHandler(expr)` → `GlassPaneProbe.GP.instrument(file:, line:) { expr }`
/// (P6 spec v6.0 §1 Z1). Source location is resolved at the expansion site
/// so the daemon can localize handlers as `fileID:line` (five-clue index,
/// 综述 §5.3 第 2 环). Lives in a plain library target so unit tests can
/// import it (macro plugin modules are not importable).
public struct HandlerMacro: ExpressionMacro {

    public init() {}

    public static func expansion(
        of node: some FreestandingMacroExpansionSyntax,
        in context: some MacroExpansionContext
    ) throws -> ExprSyntax {
        guard let argument = node.arguments.first?.expression else {
            throw DiagnosticError("#gpHandler requires exactly one expression argument")
        }
        let location = context.location(of: node, at: .afterLeadingTrivia, filePathMode: .fileID)
        let file = location?.file ?? ExprSyntax("\"<unknown>\"")
        let line = location?.line ?? ExprSyntax("0")
        return "GlassPaneProbe.GP.instrument(file: \(raw: file), line: \(raw: line)) { \(raw: argument) }"
    }
}

public struct DiagnosticError: Error, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}
