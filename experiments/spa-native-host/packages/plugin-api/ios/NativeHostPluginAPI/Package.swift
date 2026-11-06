// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NativeHostPluginAPI",
    platforms: [.iOS(.v16)],
    products: [.library(name: "NativeHostPluginAPI", targets: ["NativeHostPluginAPI"])],
    targets: [.target(name: "NativeHostPluginAPI")]
)
