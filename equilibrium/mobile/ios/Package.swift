// swift-tools-version: 5.10
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "EquilibriumMiner",
    platforms: [
        .iOS(.v16),    // BackgroundTasks API requires iOS 13+; we target 16 for SwiftUI
    ],
    products: [
        .library(
            name: "EquilibriumMiner",
            targets: ["EquilibriumMiner"]
        ),
    ],
    targets: [
        // ── Swift mining service ──────────────────────────────────────────────
        .target(
            name: "EquilibriumMiner",
            dependencies: ["EquilibriumCore"],
            path: "Equilibrium/Sources/EquilibriumMiner",
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency"),
            ]
        ),

        // ── Rust FFI bridge (built via cargo-swift) ───────────────────────────
        //
        // Build steps:
        //   cd equilibrium && cargo swift package --platforms ios --name EquilibriumCore
        //   cp -r EquilibriumCore ../mobile/ios/
        //
        // Then uncomment the binaryTarget below and remove the stub target.
        //
        // .binaryTarget(
        //     name: "EquilibriumCore",
        //     path: "EquilibriumCore.xcframework"
        // ),

        // Stub target until the cargo-swift xcframework is built:
        .target(
            name: "EquilibriumCore",
            path: "Equilibrium/Sources/EquilibriumCoreStub"
        ),

        // ── Tests ─────────────────────────────────────────────────────────────
        .testTarget(
            name: "EquilibriumMinerTests",
            dependencies: ["EquilibriumMiner"],
            path: "Equilibrium/Tests"
        ),
    ]
)
