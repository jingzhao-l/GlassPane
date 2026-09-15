// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "GlassPaneEngine",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(name: "GlassPaneEngine", targets: ["GlassPaneEngine"]),
        .executable(name: "glasspaned", targets: ["glasspaned"])
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
        .testTarget(
            name: "GlassPaneEngineTests",
            dependencies: ["GlassPaneEngine"],
            path: "Tests/GlassPaneEngineTests"
        )
    ]
)
