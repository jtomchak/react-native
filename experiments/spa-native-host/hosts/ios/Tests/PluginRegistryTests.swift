import XCTest
import NativeHostPluginAPI
@testable import SPAHost

@MainActor
final class PluginRegistryTests: XCTestCase {
    func testBridgeAdvertisesExactlyTheSelectedPluginCapabilities() async throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let services = ApplicationServices(root: temporary, configuration: HostConfiguration())
        XCTAssertNil(services.pluginStartupFailure)
        let host = HostViewController(configuration: HostConfiguration(), services: services)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene); window.rootViewController = UINavigationController(rootViewController: host); window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.loadViewIfNeeded()
        for _ in 0..<150 {
            let ready: Bool = (try? await withCheckedThrowingContinuation { continuation in host.webView.evaluateJavaScript("Boolean(window.platform && document.readyState === 'complete')") { value, error in if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: value as? Bool ?? false) } } }) ?? false
            if ready { break }; try await Task.sleep(nanoseconds: 100_000_000)
        }
        let result: Any = try await withCheckedThrowingContinuation { continuation in host.webView.callAsyncJavaScript("return (await platform.ready()).capabilities", arguments: [:], in: nil, in: .page) { continuation.resume(with: $0) } }
        let advertised = try XCTUnwrap(result as? [String])
        let core = Set(["navigation", "toolbar", "haptics", "camera", "files", "cancel", "chrome", "events", "notifications", "links", "share", "biometrics", "analytics"])
        let nonCore = Set(advertised.filter { !core.contains(String($0.split(separator: ".").first ?? "")) })
        XCTAssertEqual(nonCore, Set(services.pluginActions.map(\.name)))
        for action in services.pluginActions { XCTAssertTrue(advertised.contains(action.name)) }
        let namespaces: Any = try await withCheckedThrowingContinuation { continuation in
            host.webView.callAsyncJavaScript("return Object.keys(platform).filter(key => typeof platform[key] === 'object' && !['navigation','toolbar','haptics','camera','files','chrome','notifications','links','share','biometrics','analytics'].includes(key))", arguments: [:], in: nil, in: .page) { continuation.resume(with: $0) }
        }
        XCTAssertEqual(Set(try XCTUnwrap(namespaces as? [String])), Set(services.plugins.map(\.id)))
        if !services.plugins.contains(where: { $0.id == "storage" }) {
            let missing: Any = try await withCheckedThrowingContinuation { continuation in host.webView.callAsyncJavaScript("try { await platform.call('storage.get', {key:'removed-plugin-probe'}); return 'ALLOWED'; } catch (error) { return error.code; }", arguments: [:], in: nil, in: .page) { continuation.resume(with: $0) } }
            XCTAssertEqual(missing as? String, "UNSUPPORTED")
        }
        if services.plugins.contains(where: { $0.id == "auth" }) {
            let retained: Any = try await withCheckedThrowingContinuation { continuation in host.webView.callAsyncJavaScript("return typeof (await platform.auth.status()).authenticated", arguments: [:], in: nil, in: .page) { continuation.resume(with: $0) } }
            XCTAssertEqual(retained as? String, "boolean")
        }
    }
}
