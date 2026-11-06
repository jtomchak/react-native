// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NativeHostAuth",
    platforms: [.iOS(.v16)],
    products: [.library(name: "NativeHostAuth", targets: ["NativeHostAuth"])],
    dependencies: [.package(path: "../../../plugin-api/ios/NativeHostPluginAPI")],
    targets: [.target(name: "NativeHostAuth", dependencies: [.product(name: "NativeHostPluginAPI", package: "NativeHostPluginAPI")])]
)
