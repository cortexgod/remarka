// swift-tools-version:5.9
// Пакет для редактирования и юнит-тестов (`swift build`, `swift test`).
// Боевая сборка сайдкара — tap/build.sh (swiftc напрямую, см. README.md).
import PackageDescription

let package = Package(
    name: "remarka-tap",
    platforms: [.macOS("14.4")],
    targets: [
        .executableTarget(
            name: "remarka-tap",
            path: "Sources/remarka-tap",
            linkerSettings: [.linkedFramework("CoreAudio")]
        ),
        .testTarget(
            name: "remarka-tapTests",
            dependencies: ["remarka-tap"],
            path: "Tests/remarka-tapTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
