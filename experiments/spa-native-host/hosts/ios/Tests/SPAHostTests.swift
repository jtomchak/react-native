import XCTest
import WebKit
import UserNotifications
@testable import SPAHost

@MainActor
private func sceneWindow() -> UIWindow {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
        preconditionFailure("App-hosted tests require a connected UIWindowScene")
    }
    return UIWindow(windowScene: scene)
}

@MainActor
private func waitForNative(_ description: String, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line, diagnostics: @autoclosure () -> String = "", until predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if predicate() { return }
        try await Task.sleep(nanoseconds: 100_000_000)
    }
    let details = diagnostics()
    XCTFail("Timed out waiting for " + description + (details.isEmpty ? "" : ": " + details), file: file, line: line)
    throw HostFailure("TIMEOUT", description)
}

@MainActor
private func presentationDiagnostics(_ presenter: UIViewController, window: UIWindow) -> String {
    let windows = window.windowScene?.windows.map {
        "root=\(String(describing: $0.rootViewController)),key=\($0.isKeyWindow),hidden=\($0.isHidden)"
    } ?? []
    return "presenter=\(presenter),presented=\(String(describing: presenter.presentedViewController)),viewWindow=\(String(describing: presenter.viewIfLoaded?.window)),key=\(window.isKeyWindow),scene=\(String(describing: window.windowScene?.activationState)),app=\(UIApplication.shared.applicationState.rawValue),windows=\(windows)"
}

@MainActor
final class SPAHostTests: XCTestCase {
    private var window: UIWindow!
    private var host: HostViewController!
    private var temporary: URL!
    override func setUp() async throws {
        executionTimeAllowance = 45
        temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    }
    override func tearDown() async throws {
        window?.isHidden = true; window = nil; host = nil
        if let temporary { try? FileManager.default.removeItem(at: temporary) }
    }
    private func start(root: URL? = nil) {
        host = HostViewController(assetRoot: root, dataRoot: temporary.appendingPathComponent("data"))
        window = sceneWindow()
        window.rootViewController = UINavigationController(rootViewController: host)
        window.makeKeyAndVisible()
        host.loadViewIfNeeded()
    }
    private func js(_ source: String) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            host.webView.evaluateJavaScript(source) { value, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value ?? NSNull()) }
            }
        }
    }
    private func asyncJS(_ source: String) async throws -> Any {
        print("SPA_TEST_ASYNC: " + source)
        return try await withCheckedThrowingContinuation { continuation in
            host.webView.callAsyncJavaScript(source, arguments: [:], in: nil, in: .page) { result in print("SPA_TEST_RESULT: \(result)"); continuation.resume(with: result) }
        }
    }
    private func waitFor(_ predicate: String, timeout: TimeInterval = 15) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (try? await js("Boolean(" + predicate + ")")) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Timed out waiting for " + predicate)
        throw HostFailure("TIMEOUT", "Test timed out")
    }
    private func fixtureRoot() throws -> URL {
        let root = temporary.appendingPathComponent("fixture")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let sdk = Bundle.main.bundleURL.appendingPathComponent("web/platform-sdk.js")
        try FileManager.default.copyItem(at: sdk, to: root.appendingPathComponent("platform-sdk.js"))
        try "<!doctype html><html><head><script src='/platform-sdk.js'></script></head><body>Native contract fixture</body></html>".write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        return root
    }
    func testSceneManifestAndTestWindowUseConnectedScene() {
        start()
        XCTAssertNotNil(window.windowScene)
        XCTAssertTrue(window.windowScene?.windows.contains(where: { $0 === window }) == true)
        XCTAssertGreaterThan(window.bounds.width, 0)
        XCTAssertGreaterThan(window.bounds.height, 0)
        let manifest = Bundle.main.object(forInfoDictionaryKey: "UIApplicationSceneManifest") as? [String: Any]
        XCTAssertEqual(manifest?["UIApplicationSupportsMultipleScenes"] as? Bool, false)
        let configurations = manifest?["UISceneConfigurations"] as? [String: Any]
        let application = configurations?["UIWindowSceneSessionRoleApplication"] as? [[String: Any]]
        XCTAssertEqual(application?.first?["UISceneDelegateClassName"] as? String, "SPAHost.SceneDelegate")
    }
    func testDocumentStartSDKWithoutSDKScriptTag() async throws {
        let root = try fixtureRoot()
        try "<!doctype html><html><head><script>window.sdkBeforePageCode = !!window.platform && !!window.__SPA_TRANSPORT__;</script></head><body>No SDK script tag</body></html>".write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        start(root: root)
        try await waitFor("document.readyState === 'complete' && typeof window.sdkBeforePageCode !== 'undefined'")
        let injected = try await js("window.sdkBeforePageCode") as? Bool
        XCTAssertEqual(injected, true)
        let ready = try await asyncJS("return (await platform.ready()).platform") as? String
        XCTAssertEqual(ready, "ios")
    }
    func testPackagedPlainHTMLReceivesInjectedSDK() async throws {
        start()
        host.webView.load(URLRequest(url: URL(string: "spa://app/injected.html")!))
        try await waitFor("document.readyState === 'complete' && window.__injectedReady !== null && typeof window.__injectedReady !== 'undefined'")
        let injected = try await js("window.__sdkInjectedBeforePage") as? Bool
        XCTAssertEqual(injected, true)
        let ready = try await js("window.__injectedReady.platform") as? String
        XCTAssertEqual(ready, "ios")
    }
    func testRouteAndTraversalValidation() {
        XCTAssertEqual(AppDelegate.deepLinkPath(URL(string: "spahost://app/compose/?draft=warm%20proof")!), "/compose/?draft=warm%20proof")
        XCTAssertEqual(AppDelegate.deepLinkPath(URL(string: "spahost://app/library/")!), "/library/")
        XCTAssertNil(AppDelegate.deepLinkPath(URL(string: "spahost://evil/compose/")!))
        XCTAssertNil(AppDelegate.deepLinkPath(URL(string: "spahost://app/hosted/%2f%2fevil")!, hosted: true))
        XCTAssertTrue(HostViewController.validRoute("/compose/?draft=123"))
        XCTAssertFalse(HostViewController.validRoute("//evil.test/"))
        XCTAssertFalse(HostViewController.validRoute("/unknown/"))
        XCTAssertNil(Assets.safePath(URL(string: "spa://app/%2e%2e/private")!))
        XCTAssertNil(Assets.safePath(URL(string: "spa://app/%252e%252e/private")!))
        XCTAssertNil(Assets.safePath(URL(string: "spa://app/a%5cb")!))
        XCTAssertNil(Assets.safePath(URL(string: "spa://evil/index.html")!))
    }
    func testRealSDKStorageAndNativePresentation() async throws {
        start(root: try fixtureRoot())
        try await waitFor("window.platform && document.readyState === 'complete'")
        let platform = try await asyncJS("return (await platform.ready()).platform") as? String
        XCTAssertEqual(platform, "ios")
        _ = try await asyncJS("await platform.storage.set('native-test', 'persisted'); return true")
        let value = try await asyncJS("return await platform.storage.get('native-test')") as? String
        XCTAssertEqual(value, "persisted")
        _ = try await asyncJS("await platform.storage.remove('native-test'); return true")
        let removed = try await asyncJS("return (await platform.storage.get('native-test')) === null") as? Bool
        XCTAssertEqual(removed, true)
        _ = try await asyncJS("await platform.navigation.present({screen:'native-demo'}); return true")
        XCTAssertNotNil(host.presentedViewController as? UINavigationController)
        _ = try await asyncJS("await platform.navigation.dismiss(); return true")
        XCTAssertNil(host.presentedViewController)
        let missingCamera = try await asyncJS("try { await platform.camera.capture(); return 'unexpected'; } catch (e) { return e.code; }") as? String
        #if targetEnvironment(simulator)
        XCTAssertEqual(missingCamera, "UNAVAILABLE")
        #endif
        _ = try await asyncJS("await platform.storage.set('survives', 'restart'); return true")
        let oldWindow = window
        start(root: try fixtureRootForRestart())
        oldWindow?.isHidden = true
        try await waitFor("window.platform && document.readyState === 'complete'")
        let restored = try await asyncJS("return await platform.storage.get('survives')") as? String
        XCTAssertEqual(restored, "restart")
    }
    private func fixtureRootForRestart() throws -> URL { temporary.appendingPathComponent("fixture") }
    func testSQLitePreservesEmbeddedNULAndUTF8WithoutKeyCollision() async throws {
        let storage = Storage(root: temporary.appendingPathComponent("nul-storage"))
        func operation(_ action: String, _ key: String, _ value: String? = nil) async throws -> Any {
            try await withCheckedThrowingContinuation { continuation in
                storage.perform(action: action, key: key, value: value) { result in
                    switch result {
                    case .success(let value): continuation.resume(returning: value)
                    case .failure(let error): continuation.resume(throwing: error)
                    }
                }
            }
        }
        let key = "prefix\u{0}🔑"
        let value = "before\u{0}📷after"
        _ = try await operation("storage.set", "prefix", "plain prefix")
        _ = try await operation("storage.set", key, value)
        let full = try await operation("storage.get", key) as? String
        let prefix = try await operation("storage.get", "prefix") as? String
        XCTAssertEqual(full, value)
        XCTAssertEqual(prefix, "plain prefix")
        _ = try await operation("storage.remove", key)
        let missing = try await operation("storage.get", key)
        let untouched = try await operation("storage.get", "prefix") as? String
        XCTAssertTrue(missing is NSNull)
        XCTAssertEqual(untouched, "plain prefix")
        // Exercise JSON -> native argument validation -> SQLite -> JSON too.
        start(root: try fixtureRoot())
        try await waitFor("window.platform && document.readyState === 'complete'")
        let roundtrip = try await asyncJS("const key='json'+String.fromCharCode(0)+'🔑'; const value='before'+String.fromCharCode(0)+'📷after'; await platform.storage.set('json','plain'); await platform.storage.set(key,value); return (await platform.storage.get(key)) === value && (await platform.storage.get('json')) === 'plain';") as? Bool
        XCTAssertEqual(roundtrip, true)
    }
    func testStorageQuotaRollsBackRejectedWrite() async throws {
        start(root: try fixtureRoot())
        try await waitFor("document.readyState === 'complete' && window.platform")
        let outcome = try await asyncJS("const value='x'.repeat(32768); for(let i=0;i<31;i++) await platform.storage.set('quota-'+i,value); try { await platform.storage.set('quota-over',value); return 'accepted'; } catch(e) { return e.code; }") as? String
        XCTAssertEqual(outcome, "QUOTA_EXCEEDED")
        let rolledBack = try await asyncJS("return (await platform.storage.get('quota-over')) === null") as? Bool
        XCTAssertEqual(rolledBack, true)
    }
    func testNativeValidationAndSubframeCannotClaimSession() async throws {
        start(root: try fixtureRoot())
        try await waitFor("document.readyState === 'complete' && window.platform")
        _ = try await js("""
        const iframe = document.createElement('iframe');
        iframe.srcdoc = `<script>window.webkit.messageHandlers.spa.postMessage(JSON.stringify({v:1,id:'iframe-hello',document:'iframe-nonce',session:null,action:'hello',args:{}}));</script>`;
        document.body.appendChild(iframe); true
        """)
        try await Task.sleep(nanoseconds: 300_000_000)
        // If the subframe claimed the host session, root ready would fail.
        let established = try await asyncJS("return (await platform.ready()).platform") as? String
        XCTAssertEqual(established, "ios")
        let invalid = try await asyncJS("try { await platform.call('storage.set',{key:'rejected',value:'wrong',extra:true}); return 'accepted'; } catch(e) { return e.code; }") as? String
        XCTAssertEqual(invalid, "INVALID_REQUEST")
        let absent = try await asyncJS("return (await platform.storage.get('rejected')) === null") as? Bool
        XCTAssertEqual(absent, true)
        let invalidRoute = try await asyncJS("try { await platform.call('navigation.update',{path:'/escape/',title:'bad',canGoBack:false}); return 'accepted'; } catch(e) { return e.code; }") as? String
        XCTAssertEqual(invalidRoute, "INVALID_REQUEST")
        let unsupported = try await asyncJS("try { await platform.call('unknown.action',{}); return 'accepted'; } catch(e) { return e.code; }") as? String
        XCTAssertEqual(unsupported, "UNSUPPORTED")
    }
    func testPackagedNextOriginAndRoutePayloadFetch() async throws {
        start()
        try await waitFor("document.readyState === 'complete' && window.platform && document.querySelector('a[href=\"/compose/\"]')")
        let ready = try await asyncJS("return (await platform.ready()).platform") as? String
        XCTAssertEqual(ready, "ios")
        let documentNonce = try await js("window.__testDocument = Math.random().toString(); window.__testDocument") as? String
        let response = try await asyncJS("const r = await fetch('/compose/'); return {ok:r.ok,text:(await r.text()).includes('</html>')};") as? [String: Any]
        XCTAssertEqual(response?["ok"] as? Bool, true)
        XCTAssertEqual(response?["text"] as? Bool, true)
        _ = try await js("document.querySelector('a[href=\"/compose/\"]').click(); true")
        try await waitFor("location.pathname === '/compose/'")
        let nextNonce = try await js("window.__testDocument") as? String
        XCTAssertEqual(nextNonce, documentNonce)
        // A client route must leave the same SDK/native session live.
        let afterRoute = try await asyncJS("return (await platform.ready()).platform") as? String
        XCTAssertEqual(afterRoute, "ios")
        host.webView.reload()
        try await waitFor("document.readyState === 'complete' && location.pathname === '/compose/' && window.platform")
    }
}

@MainActor
final class NativeShellTests: XCTestCase {
    private var window: UIWindow!
    private var root: URL!
    private var shell: NativeShell!
    override func setUp() async throws { root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true) }
    override func tearDown() async throws { window?.isHidden = true; window = nil; shell = nil; try? FileManager.default.removeItem(at: root) }
    private func start(chrome: String = "tabs", hosted: Bool = false) {
        var config = HostConfiguration(); config.chromeMode = chrome; config.navigationMode = "native"
        if hosted { config.contentMode = "hosted"; config.origin = URL(string: "http://127.0.0.1:18797") }
        shell = NativeShell(configuration: config, assetRoot: Bundle.main.bundleURL.appendingPathComponent("web"), dataRoot: root)
        window = sceneWindow(); window.rootViewController = shell.rootController; window.makeKeyAndVisible()
    }
    private func js(_ host: HostViewController, _ code: String) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in host.webView.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { continuation.resume(with: $0) } }
    }
    private func loaded(_ host: HostViewController) async throws {
        host.loadViewIfNeeded()
        for _ in 0..<150 {
            if (try? await js(host, "return Boolean(window.platform && document.readyState === 'complete')")) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw HostFailure("TIMEOUT", "Shell WebView did not become ready")
    }
    func testConfigurationRejectsUntrustedOriginsAndKeepsDefaults() throws {
        XCTAssertNil(HostConfiguration.validOrigin("http://example.com", debug: true))
        XCTAssertNil(HostConfiguration.validOrigin("https://user:pass@example.com"))
        XCTAssertNil(HostConfiguration.validOrigin("https://example.com/path"))
        XCTAssertNotNil(HostConfiguration.validOrigin("http://127.0.0.1:18797", debug: true))
        XCTAssertNil(HostConfiguration.validOrigin("http://127.0.0.1:18797"))
        XCTAssertFalse(HostConfiguration.validRoute("/hosted/", hosted: false))
        XCTAssertTrue(HostConfiguration.validRoute("/hosted/?item=one", hosted: true))
        XCTAssertTrue(HostConfiguration.validRoute("/hosted/item/42/", hosted: true))
        XCTAssertFalse(HostConfiguration.validRoute("/hosted/item/42/", hosted: false))
        XCTAssertFalse(HostConfiguration.validRoute("/hosted/%2e%2e/private/", hosted: true))
        XCTAssertFalse(HostConfiguration.validRoute("/hosted/%252e%252e/private/", hosted: true))
        XCTAssertFalse(HostConfiguration.validRoute("/hosted/%00/", hosted: true))
        XCTAssertFalse(HostConfiguration.validRoute("/hosted/%2f%2fevil", hosted: true))
    }
    func testUniversalLinkRequiresExplicitHTTPSOriginAndCanonicalRoute() {
        var config = HostConfiguration(); config.contentMode = "hosted"; config.origin = URL(string: "https://app.example.test")
        XCTAssertEqual(AppDelegate.universalLinkPath(URL(string: "https://app.example.test/compose/?draft=a%20b")!, configuration: config), "/compose/?draft=a%20b")
        XCTAssertNil(AppDelegate.universalLinkPath(URL(string: "https://foreign.example.test/compose/")!, configuration: config))
        XCTAssertNil(AppDelegate.universalLinkPath(URL(string: "http://app.example.test/compose/")!, configuration: config))
        XCTAssertNil(AppDelegate.universalLinkPath(URL(string: "https://app.example.test:444/compose/")!, configuration: config))
        XCTAssertNil(AppDelegate.universalLinkPath(URL(string: "https://app.example.test/unknown/")!, configuration: config))
        XCTAssertEqual(AppDelegate.universalLinkPath(URL(string: "https://app.example.test/hosted/item/42/")!, configuration: config), "/hosted/item/42/")
        XCTAssertNil(AppDelegate.universalLinkPath(URL(string: "https://app.example.test/hosted/%2f%2fevil")!, configuration: config))
    }
    func testActualNativeTabsRetainIndependentDocumentsAndDenyHiddenUI() async throws {
        start(); let first = shell.activeHost!; try await loaded(first)
        _ = try await js(first, "await platform.ready(); window.shellNonce='retained-root'; return true")
        try shell.selectTab("compose", from: first)
        let compose = shell.activeHost!; try await loaded(compose)
        XCTAssertFalse(first === compose)
        let denied = try await js(first, "try { await platform.haptics.impact({style:'light'}); return 'bad'; } catch(e) { return e.code }") as? String
        XCTAssertEqual(denied, "UNAUTHORIZED")
        try shell.selectTab("overview", from: compose)
        XCTAssertTrue(shell.activeHost === first)
        let retained = try await js(first, "return window.shellNonce") as? String; XCTAssertEqual(retained, "retained-root")
        XCTAssertTrue(shell.rootController is UITabBarController)
        XCTAssertTrue(shell.rootController.childForStatusBarStyle === first.navigationController)
        XCTAssertEqual((shell.rootController as? UITabBarController)?.tabBar.items?.first?.title, "Overview")
    }
    func testActualNativeVisitPushPopAndChromeUpdate() async throws {
        start(chrome: "standard"); let first = shell.activeHost!; try await loaded(first)
        _ = try await js(first, "await platform.ready(); window.shellNonce='native-root'; return true")
        let result = try await js(first, "return await platform.call('navigation.visit',{path:'/compose/',presentation:'push'})") as? [String: Any]
        XCTAssertEqual(result?["path"] as? String, "/compose/")
        let second = shell.activeHost!; try await loaded(second)
        XCTAssertFalse(first === second)
        XCTAssertEqual(second.navigationController?.viewControllers.count, 2)
        XCTAssertTrue(second.navigationController?.interactivePopGestureRecognizer?.isEnabled == true)
        let shared = try await js(second, "await platform.storage.set('shared-shell', 'one-store'); return true") as? Bool
        XCTAssertEqual(shared, true)
        _ = try await js(second, "return await platform.call('chrome.update',{title:'Native detail',largeTitle:false})")
        XCTAssertEqual(second.title, "Native detail")
        _ = try await js(second, "return await platform.call('toolbar.set',{registration:'owned-title',title:'Owned toolbar',actions:[]})")
        _ = try await js(second, "return await platform.call('navigation.update',{path:'/compose/',title:'Generic route acknowledgement',canGoBack:false})")
        XCTAssertEqual(second.title, "Owned toolbar")
        _ = try await js(second, "return await platform.call('toolbar.clear',{registration:'owned-title'})")
        XCTAssertEqual(second.title, "Generic route acknowledgement")
        _ = try await js(second, "return await platform.call('chrome.update',{statusBarStyle:'light'})")
        XCTAssertTrue(second.navigationController?.childForStatusBarStyle === second)
        XCTAssertEqual(second.preferredStatusBarStyle, .lightContent)
        _ = try await js(second, "return await platform.navigation.back()")
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertTrue(shell.activeHost === first)
        let nativeRoot = try await js(first, "return window.shellNonce") as? String; XCTAssertEqual(nativeRoot, "native-root")
        let stored = try await js(first, "return await platform.storage.get('shared-shell')") as? String; XCTAssertEqual(stored, "one-store")
    }
    func testShareValidationPushUnconfiguredAndBiometricsAreRealCapabilities() async throws {
        start(chrome: "standard"); let host = shell.activeHost!; try await loaded(host)
        let push: [String: Any]?
        do {
            push = try await js(host, "return await platform.call('notifications.status',{})") as? [String: Any]
        } catch {
            // Distinguish an OS service that never calls back from a retired
            // WebView reply owner without changing either runtime path.
            var nativeAuthorization: String?
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                DispatchQueue.main.async { nativeAuthorization = String(settings.authorizationStatus.rawValue) }
            }
            let deadline = Date().addingTimeInterval(2)
            while nativeAuthorization == nil && Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
            let document = try? await js(host, "return {url:location.href,ready:document.readyState,platform:!!window.platform,transport:!!window.__SPA_TRANSPORT__}")
            print("SPA_NOTIFICATION_STATUS_FAILURE: nativeAuthorization=\(nativeAuthorization ?? "no callback within 2s"),document=\(String(describing: document)),\(presentationDiagnostics(host, window: window))")
            throw error
        }
        XCTAssertEqual(push?["configured"] as? Bool, false)
        let unavailable = try await js(host, "try { await platform.call('notifications.register',{}); return 'bad'; }catch(e){return e.code}") as? String
        XCTAssertEqual(unavailable, "UNAVAILABLE")
        let invalidShare = try await js(host, "try { await platform.call('share.present',{url:'file:///private/a'}); return 'bad'; }catch(e){return e.code}") as? String
        XCTAssertEqual(invalidShare, "INVALID_REQUEST")
        let status = try await js(host, "return await platform.call('biometrics.status',{})") as? [String: Any]
        XCTAssertNotNil(status?["available"] as? Bool)
    }
    func testSurfaceChromeRestoresAndHiddenRouteCannotDisableVisiblePop() async throws {
        start(); let first = shell.activeHost!; try await loaded(first)
        // document.readyState can precede React hydration and toolbar registration.
        try await waitForNative("hydrated home toolbar", diagnostics: "title=\(String(describing: first.title))") { first.title == "Native actions" }
        _ = try await js(first, "await platform.ready();return await platform.call('chrome.update',{toolbarHidden:true,tabBarHidden:true})")
        let title = first.title
        let invalid = try await js(first, "try {await platform.call('chrome.update',{title:'must-not-apply',largeTitle:'invalid'});return 'bad';}catch(e){return e.code}") as? String
        XCTAssertEqual(invalid, "INVALID_REQUEST"); XCTAssertEqual(first.title, title)
        _ = try await js(first, "return await platform.call('navigation.visit',{path:'/compose/',presentation:'push'})")
        let child = shell.activeHost!; try await loaded(child)
        XCTAssertEqual(child.navigationController?.isNavigationBarHidden, false)
        XCTAssertEqual((shell.rootController as? UITabBarController)?.tabBar.isHidden, false)
        _ = try await js(first, "return await platform.call('navigation.update',{path:'/',title:'Hidden root',canGoBack:true})")
        XCTAssertEqual(child.navigationController?.interactivePopGestureRecognizer?.isEnabled, true)
        _ = try await js(child, "return await platform.navigation.back()")
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertTrue(shell.activeHost === first)
        XCTAssertEqual(first.navigationController?.isNavigationBarHidden, true)
        XCTAssertEqual((shell.rootController as? UITabBarController)?.tabBar.isHidden, true)
        _ = try await js(first, "return await platform.call('chrome.update',{toolbarHidden:false,tabBarHidden:false})")
        try shell.selectTab("library", from: first)
        let library = shell.activeHost!; try await loaded(library)
        XCTAssertEqual(library.navigationController?.isNavigationBarHidden, false)
        XCTAssertEqual((shell.rootController as? UITabBarController)?.tabBar.isHidden, false)
    }
    func testAdaptiveNativeSidebarAndDetail() async throws {
        start(chrome: "adaptive"); let first = shell.activeHost!; try await loaded(first)
        if UIDevice.current.userInterfaceIdiom == .pad {
            guard let split = shell.rootController as? UISplitViewController else { return XCTFail("iPad must use a real native split view") }
            let primary = split.viewController(for: .primary) as? UINavigationController
            XCTAssertTrue(primary?.topViewController is UITableViewController)
            try shell.selectTab("compose", from: first)
            XCTAssertTrue(split.viewController(for: .secondary) === shell.activeHost?.navigationController)
            XCTAssertTrue(split.childForStatusBarStyle === shell.activeHost?.navigationController)
        } else { XCTAssertTrue(shell.rootController is UITabBarController) }
    }
    func testNativeEventsReachOnlyActiveSubscribedDocumentAndStripInvalidRoute() async throws {
        start(); let first = shell.activeHost!; try await loaded(first)
        _ = try await js(first, "await platform.ready();window.nativeEvents=[];window.stopNativeEvents=platform.on('notifications.received',event=>nativeEvents.push(event));return true")
        try await Task.sleep(nanoseconds: 150_000_000)
        shell.services.handleNotification(["path":"//foreign.example/", "aps":["alert":"Adapter fixture"]], opened: false, identifier: "invalid-route")
        try await Task.sleep(nanoseconds: 150_000_000)
        let sanitized = try await js(first, "return nativeEvents.length === 1 && !('path' in nativeEvents[0])") as? Bool
        XCTAssertEqual(sanitized, true)
        let invalidScope = try await js(first, "try{await platform.call('events.subscribe',{event:'unapproved.event',subscription:'invalid-scope'});return 'bad'}catch(e){return e.code}") as? String
        XCTAssertEqual(invalidScope, "INVALID_REQUEST")
        try shell.selectTab("compose", from: first)
        let second = shell.activeHost!; try await loaded(second)
        _ = try await js(second, "await platform.ready();window.nativeEvents=[];window.stopNativeEvents=platform.on('notifications.received',event=>nativeEvents.push(event));return true")
        try await Task.sleep(nanoseconds: 150_000_000)
        shell.services.handleNotification(["path":"/compose/"], opened: false, identifier: "active-route")
        try await Task.sleep(nanoseconds: 150_000_000)
        let hiddenCount = try await js(first, "return nativeEvents.length") as? Int
        let foregroundPath = try await js(second, "return nativeEvents[0]?.path") as? String
        XCTAssertEqual(hiddenCount, 1); XCTAssertEqual(foregroundPath, "/compose/")
    }
    func testHostedProductionServerAndNativeSDK() async throws {
        let health = URLRequest(url: URL(string: "http://127.0.0.1:18797/api/health")!, timeoutInterval: 2)
        guard let (_, response) = try? await URLSession.shared.data(for: health), (response as? HTTPURLResponse)?.statusCode == 200 else { throw XCTSkip("Production Next server on 18797 is not running") }
        start(chrome: "standard", hosted: true); let host = shell.activeHost!; host.load(path: "/hosted/"); try await loaded(host)
        let meta = try await js(host, "return (await platform.ready()).host") as? [String: Any]
        XCTAssertEqual(meta?["contentMode"] as? String, "hosted")
        let body = try await js(host, "return document.body.innerText") as? String
        XCTAssertTrue(body?.contains("hosted") == true || body?.contains("server") == true)
        let nativeStored = try await js(host, "await platform.storage.set('hosted-native','real');return await platform.storage.get('hosted-native')") as? String; XCTAssertEqual(nativeStored, "real")
        _ = try await js(host, "return await platform.call('navigation.visit',{path:'/hosted/item/42/',presentation:'push'})")
        let item = shell.activeHost!; try await loaded(item)
        let itemID = try await js(item, "return document.querySelector('[data-testid=server-item-id]')?.textContent") as? String
        XCTAssertEqual(itemID, "42")
        for _ in 0..<30 { if item.title == "Item 42" { break }; try await Task.sleep(nanoseconds: 100_000_000) }
        XCTAssertEqual(item.title, "Item 42")
    }
}

@MainActor
final class NativeOwnershipTests: XCTestCase {
    func testRequestCancellationDoesNotDismissAnotherRequestShareSheet() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let services = ApplicationServices(root: root, configuration: HostConfiguration())
        let presenter = UIViewController(); let window = sceneWindow()
        window.rootViewController = presenter; window.makeKeyAndVisible()
        defer { window.isHidden = true; try? FileManager.default.removeItem(at: root) }
        window.layoutIfNeeded()
        try await waitForNative("foreground key presentation window", diagnostics: presentationDiagnostics(presenter, window: window)) {
            presenter.viewIfLoaded?.window === window && window.isKeyWindow && window.windowScene?.activationState == .foregroundActive
        }
        try services.share(owner: "surface", requestID: "share", items: ["Native share test"], presenter: presenter) { _ in }
        try await waitForNative("actual UIActivityViewController presentation", diagnostics: presentationDiagnostics(presenter, window: window)) {
            presenter.presentedViewController is UIActivityViewController
        }
        let sheet = presenter.presentedViewController
        services.cancel(owner: "surface", requestID: "unrelated-storage-request")
        // Let dismissal callbacks run before asserting the same sheet is retained.
        await Task.yield()
        XCTAssertTrue(presenter.presentedViewController is UIActivityViewController, presentationDiagnostics(presenter, window: window))
        XCTAssertTrue(presenter.presentedViewController === sheet)
        XCTAssertTrue(services.presentationMatches(owner: "surface", requestID: "share"))
        services.cancel(owner: "surface", requestID: "share")
        try await waitForNative("share dismissal", diagnostics: presentationDiagnostics(presenter, window: window)) {
            presenter.presentedViewController == nil
        }
        let next = try services.acquire(owner: "other", requestID: "next")
        services.release(next)
    }
    func testInitialPathAndAppWidePackagedFallback() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        var config = HostConfiguration(); config.contentMode = "hosted"; config.origin = URL(string: "http://127.0.0.1:18797"); config.initialPath = "/compose/"; config.navigationMode = "native"; config.chromeMode = "tabs"
        let shell = NativeShell(configuration: config, assetRoot: Bundle.main.bundleURL.appendingPathComponent("web"), dataRoot: root)
        let window = sceneWindow(); window.rootViewController = shell.rootController; window.makeKeyAndVisible()
        defer { window.isHidden = true; try? FileManager.default.removeItem(at: root) }
        let original = shell.activeHost!; original.loadViewIfNeeded()
        for _ in 0..<30 { if shell.isActive(original) { break }; try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertTrue(shell.isActive(original))
        XCTAssertEqual(shell.activeTab, "compose")
        XCTAssertEqual(original.currentPath, "/compose/")
        shell.usePackaged(from: original)
        XCTAssertEqual(shell.configuration.contentMode, "packaged")
        let packaged = shell.activeHost!; packaged.loadViewIfNeeded(); XCTAssertFalse(packaged === original)
        for _ in 0..<30 { if shell.isActive(packaged) { break }; try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertTrue(shell.isActive(packaged))
        try shell.selectTab("library", from: packaged)
        let library = shell.activeHost!; library.loadViewIfNeeded()
        XCTAssertEqual(library.contentMode, "packaged")
        XCTAssertEqual(library.currentPath, "/library/")
    }
}
