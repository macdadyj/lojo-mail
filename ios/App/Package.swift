// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "LojoMail",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "LojoMail",
            targets: ["LojoMail"]
        ),
    ],
    targets: [
        .target(
            name: "LojoMailCore"
        ),
        .target(
            name: "LojoMail",
            dependencies: ["LojoMailCore"]
        ),
    ]
)
