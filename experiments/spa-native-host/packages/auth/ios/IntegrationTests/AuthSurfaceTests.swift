import XCTest
import WebKit
@testable import SPAHost

@MainActor
final class AuthSurfaceTests: XCTestCase {
    private var window: UIWindow!
    private var shell: NativeShell!
    private var temporary: URL!
    override func setUp() async throws {
        temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        let request = URLRequest(url: URL(string: "http://127.0.0.1:18803/api/health/")!, timeoutInterval: 2)
        guard let (_, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 else { throw XCTSkip("Owned hosted Next.js test server on18803 is not running") }
    }
    override func tearDown() async throws {
        window?.isHidden = true; window = nil; shell = nil
        if let temporary { try? FileManager.default.removeItem(at: temporary) }
    }
    private func start(chrome: String) throws {
        var config = HostConfiguration(); config.contentMode = "hosted"; config.origin = URL(string: "http://127.0.0.1:18803")
        config.chromeMode = chrome; config.navigationMode = "native"
        shell = NativeShell(configuration: config, assetRoot: Bundle.main.bundleURL.appendingPathComponent("web"), dataRoot: temporary)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene); window.rootViewController = shell.rootController; window.makeKeyAndVisible()
        shell.activeHost?.loadViewIfNeeded()
    }
    private func js(_ host: HostViewController, _ code: String) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            host.webView.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { continuation.resume(with: $0) }
        }
    }
    private func ready(_ host: HostViewController) async throws {
        host.loadViewIfNeeded()
        for _ in 0..<150 {
            if shell.isActive(host), !host.sessionContentConcealed, !host.webView.isLoading,
               (try? await js(host, "return Boolean(window.platform && document.readyState === 'complete')")) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Current auth revision never became visible"); throw HostFailure("TIMEOUT", "Auth surface reload failed")
    }
    private func exerciseRetainedSurfaces(chrome: String) async throws {
        try start(chrome: chrome)
        let overview = try XCTUnwrap(shell.activeHost); try await ready(overview)
        _ = try await js(overview, "window.__priorUserDocument = true; return true")
        try shell.selectTab("compose", from: overview)
        let compose = try XCTUnwrap(shell.activeHost); try await ready(compose)
        _ = try await js(compose, "window.__priorUserDocument = true; window.__oldTimer = setInterval(() => { window.__oldTicks = (window.__oldTicks || 0) + 1 }, 10); return true")
        try shell.selectTab("overview", from: compose)
        try await ready(overview)
        try shell.updateChrome(["badge": ["id": "compose", "value": "9"]], from: overview)
        XCTAssertEqual(compose.navigationController?.tabBarItem.badgeValue, "9")
        let retiredOverview = try XCTUnwrap(overview.webView)
        let retiredCompose = try XCTUnwrap(compose.webView)

        let revision = shell.services.beginSessionChange(owner: "external-auth-transition")
        XCTAssertTrue(overview.sessionContentConcealed); XCTAssertTrue(compose.sessionContentConcealed)
        XCTAssertNil(overview.webView)
        XCTAssertNil(compose.navigationController?.tabBarItem.badgeValue)
        shell.services.completeSessionChange(revision, owner: "external-auth-transition")
        XCTAssertTrue(overview.sessionContentConcealed)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in shell.services.awaitSessionRealms(revision) { continuation.resume(with: $0.mapError { $0 as Error }) } }
        for retired in [retiredOverview, retiredCompose] {
            let oldRealm: Any = try await withCheckedThrowingContinuation { continuation in retired.evaluateJavaScript("Boolean(window.__priorUserDocument || window.__oldTimer || window.__oldTicks)") { value, error in if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: value ?? NSNull()) } } }
            XCTAssertEqual(oldRealm as? Bool, false)
            XCTAssertEqual(retired.url?.scheme, "about")
        }
        try await ready(overview)
        let oldOverview = try await js(overview, "return Boolean(window.__priorUserDocument)") as? Bool
        XCTAssertEqual(oldOverview, false); XCTAssertTrue(compose.sessionContentConcealed)

        try shell.selectTab("compose", from: overview)
        XCTAssertTrue(compose.sessionContentConcealed)
        try await ready(compose)
        let oldCompose = try await js(compose, "return Boolean(window.__priorUserDocument)") as? Bool
        XCTAssertEqual(oldCompose, false)

        _ = try await js(compose, "window.__priorUserDocument = true; return true")
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            do { try shell.visit("/hosted/item/42/", presentation: "push", from: compose) { result in continuation.resume(with: result.map { _ in () }.mapError { $0 as Error }) } }
            catch { continuation.resume(throwing: error) }
        }
        let item = try XCTUnwrap(shell.activeHost); try await ready(item)
        let nextRevision = shell.services.beginSessionChange(owner: "external-cookie-sync")
        XCTAssertTrue(compose.sessionContentConcealed); XCTAssertTrue(item.sessionContentConcealed)
        shell.services.completeSessionChange(nextRevision, owner: "external-cookie-sync")
        try await ready(item)
        XCTAssertTrue(shell.pop(item)); XCTAssertTrue(compose.sessionContentConcealed)
        try await ready(compose)
        let oldBackDocument = try await js(compose, "return Boolean(window.__priorUserDocument)") as? Bool
        XCTAssertEqual(oldBackDocument, false)
    }
    func testTabsAndBackCannotRevealPriorAuthDocument() async throws { try await exerciseRetainedSurfaces(chrome: "tabs") }
    func testAdaptiveDetailCannotRevealPriorAuthDocument() async throws { try await exerciseRetainedSurfaces(chrome: "adaptive") }
    func testInitiatingStaleDocumentCanOnlyCoordinateAuthentication() async throws {
        try start(chrome: "standard")
        let host = try XCTUnwrap(shell.activeHost); try await ready(host)
        _ = try await js(host, "await platform.ready(); return true")
        let revision = shell.services.beginSessionChange(owner: host.surfaceID)
        XCTAssertTrue(host.sessionContentConcealed)
        for action in ["storage.get", "camera.capture", "navigation.back", "auth.signIn"] {
            let args = action == "storage.get" ? "{key:'private-draft'}" : action == "auth.signIn" ? "{method:'oauth',provider:'example'}" : "{}"
            let code = try await js(host, "try { await platform.call('\(action)', \(args)); return 'ALLOWED'; } catch (error) { return error.code; }") as? String
            XCTAssertEqual(code, "UNAUTHORIZED")
        }
        let status = try await js(host, "return await platform.auth.status()") as? [String: Any]
        XCTAssertEqual(status?["configured"] as? Bool, false)
        XCTAssertFalse(host.deliverEvent("notifications.received", ["title": "new account data"]))
        shell.services.completeSessionChange(revision, owner: host.surfaceID)
        try await ready(host)
    }
}
