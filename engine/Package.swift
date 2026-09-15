// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "GlassPaneEngine",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(name: "GlassPaneEngine", targets: ["GlassPaneEngine"]),
        .executable(name: "glasspaned", targets: ["glasspaned"]),
        .executable(name: "glasspane-settings", targets: ["glasspane-settings"])
    ],
    targets: [
        .target(
            name: "GlassPaneEngine",
            path: "Sources/GlassPaneEngine"
        ),
        .executableTarget(
            name: "glasspaned",
            dependencies: ["GlassPaneEngine"],
            path: "Sources/glasspaned"
        ),
        .executableTarget(
            name: "glasspane-settings",
            dependencies: ["GlassPaneEngine"],
            path: "Sources/glasspane-settings"
        ),
        .testTarget(
            name: "GlassPaneEngineTests",
            dependencies: ["GlassPaneEngine"],
            path: "Tests/GlassPaneEngineTests"
        )
    ]
)
