// swift-tools-version:6.0
import PackageDescription
import CompilerPluginSupport

// GlassPaneProbe — the P6 spec v6.0 white-box probe SDK (§4).
//
// This is a deliberate *separate* package: swift-syntax (the Z1 macro plugin
// dependency) must never enter the daemon build graph (glasspaned stays a
// fast, dependency-free build; installer UX unchanged). Target apps integrate
// `GlassPaneProbe`; the daemon speaks only the §2 wire format.
let package = Package(
    name: "GlassPaneProbe",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(name: "GlassPaneProbe", targets: ["GlassPaneProbe"]),
        .executable(name: "probe-demo", targets: ["probe-demo"])
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-syntax", exact: "603.0.2")
    ],
    targets: [
        .target(
            name: "GlassPaneProbe",
            dependencies: ["GPProbeMacros"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .target(
            name: "GPProbeMacroImpl",
            dependencies: [
                .product(name: "SwiftSyntaxMacros", package: "swift-syntax"),
                .product(name: "SwiftSyntaxBuilder", package: "swift-syntax")
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .macro(
            name: "GPProbeMacros",
            dependencies: [
                "GPProbeMacroImpl",
                .product(name: "SwiftCompilerPlugin", package: "swift-syntax")
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "probe-demo",
            dependencies: ["GlassPaneProbe"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "GlassPaneProbeTests",
            dependencies: [
                "GlassPaneProbe",
                "GPProbeMacroImpl",
                .product(name: "SwiftSyntaxMacrosTestSupport", package: "swift-syntax"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
