// swift-tools-version: 6.0

// Linux-host tests for LojoMailCore (models, envelope crypto, grouping). `Sources/LojoMailCore` is a
// symlink to the app's sources, so the phone and these tests compile the same files.
// Run: ios/scripts/test-core.sh
import PackageDescription

let package = Package(
    name: "LojoMailCoreTests",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"5.0.0"),
    ],
    targets: [
        .target(
            name: "LojoMailCore",
            dependencies: [.product(name: "Crypto", package: "swift-crypto")]
        ),
        .testTarget(
            name: "LojoMailCoreTests",
            dependencies: ["LojoMailCore"]
        ),
    ]
)
