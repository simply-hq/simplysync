// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "SimplySync",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(name: "SimplySync", targets: ["SimplySync"]),
    ],
    targets: [
        .target(
            name: "SimplySync",
            linkerSettings: [
                .linkedLibrary("sqlite3"),
                .linkedFramework("Security"),
            ]
        ),
        .testTarget(
            name: "SimplySyncTests",
            dependencies: ["SimplySync"],
            path: "apps/todolist/swift/Tests/SimplySyncTests"
        ),
    ]
)
