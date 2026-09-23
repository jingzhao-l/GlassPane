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
        let resolved = try resolvedLocation(location)
        return "GlassPaneProbe.GP.instrument(file: \(raw: resolved.file), line: \(raw: resolved.line)) { \(raw: argument) }"
    }

    /// R3-18: no location means the expansion site cannot be localized — and a
    /// Z1 hit is *only* evidence because it names a real `fileID:line`. Emitting
    /// a fabricated `"<unknown>":0` would report a handler hit at a location
    /// that exists in no source file, which is worse than not expanding: the
    /// daemon happily aggregates it and the evidence reads as observed. Fail the
    /// expansion instead; the compiler surfaces `DiagnosticError` as an error.
    /// `public` only so the unit tests can pin this branch (a macro test
    /// harness always has a location, so `expansion` itself cannot reach nil).
    public static func resolvedLocation(_ location: AbstractSourceLocation?) throws -> AbstractSourceLocation {
        guard let location else {
            throw DiagnosticError(
                "#gpHandler could not resolve the source location of its expansion site; "
                    + "refusing to emit instrument(file: \"<unknown>\", line: 0) because the "
                    + "resulting Z1 evidence would point at a location that exists in no file"
            )
        }
        return location
    }
}

public struct DiagnosticError: Error, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}
