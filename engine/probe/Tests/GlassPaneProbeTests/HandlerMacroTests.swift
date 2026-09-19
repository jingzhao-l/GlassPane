import XCTest
import SwiftSyntaxMacros
import SwiftSyntaxMacrosTestSupport
import GPProbeMacroImpl

/// P6 §1: the macro must evaluate the wrapped expression exactly once and
/// pass its value through, recording the expansion-site fileID:line.
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
}
