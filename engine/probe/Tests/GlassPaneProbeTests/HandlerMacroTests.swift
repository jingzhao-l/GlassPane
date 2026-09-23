import XCTest
import SwiftSyntaxMacros
import SwiftSyntaxMacrosTestSupport
import GPProbeMacroImpl

/// P6 §1: the macro must evaluate the wrapped expression exactly once and
/// pass its value through, recording the expansion-site fileID:line. The two
/// failure branches are pinned too — a `#gpHandler` that cannot name its call
/// site or its argument must fail the build, never emit a plausible-looking
/// instrument() call (Z1 evidence is only evidence while it is localized).
final class GPHandlerMacroTests: XCTestCase {

    let testMacros: [String: Macro.Type] = ["gpHandler": HandlerMacro.self]

    func testExpansionShape() {
        assertMacroExpansion(
            """
            #gpHandler(model.count += 1)
            """,
            expandedSource: """
            GlassPaneProbe.GP.instrument(file: "TestModule/test.swift", line: 1) {
                model.count += 1
            }
            """,
            macros: testMacros
        )
    }

    /// R3-18: `context.location(of:)` returning nil used to be folded into a
    /// fabricated `file: "<unknown>", line: 0` call site, which put a handler
    /// hit in the evidence at a location that exists in no source file.
    func testMissingSourceLocationThrowsInsteadOfFabricatingACallSite() {
        XCTAssertThrowsError(try HandlerMacro.resolvedLocation(nil)) { error in
            guard let diagnostic = error as? DiagnosticError else {
                XCTFail("expected DiagnosticError, got \(type(of: error)): \(error)")
                return
            }
            XCTAssertTrue(
                diagnostic.message.contains("could not resolve the source location"),
                "the error must name what failed: \(diagnostic.message)"
            )
            XCTAssertTrue(
                diagnostic.message.contains("<unknown>"),
                "the error must say which fabricated location it is refusing: \(diagnostic.message)"
            )
            // The compiler renders the thrown error through `description`
            // (String(describing:) in SwiftDiagnostics), so that is the text a
            // human/agent actually sees.
            XCTAssertEqual(diagnostic.description, diagnostic.message)
        }
    }

    /// A `nil` location is only reachable through a context that lost the
    /// source root, so the harness can pin the *other* guard: no argument.
    func testMissingArgumentFailsExpansion() {
        assertMacroExpansion(
            """
            #gpHandler
            """,
            expandedSource: """
            #gpHandler
            """,
            diagnostics: [
                DiagnosticSpec(
                    message: "#gpHandler requires exactly one expression argument",
                    line: 1,
                    column: 1
                )
            ],
            macros: testMacros
        )
    }
}
