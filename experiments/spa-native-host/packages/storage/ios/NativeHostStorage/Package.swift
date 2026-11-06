// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NativeHostStorage",
    platforms: [.iOS(.v16)],
    products: [.library(name: "NativeHostStorage", targets: ["NativeHostStorage"])],
    dependencies: [.package(path: "../../../plugin-api/ios/NativeHostPluginAPI")],
    targets: [.target(name: "NativeHostStorage", dependencies: [.product(name: "NativeHostPluginAPI", package: "NativeHostPluginAPI")], linkerSettings: [.linkedLibrary("sqlite3")])]
)
