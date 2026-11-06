import UIKit
import WebKit
import AVFoundation
import LocalAuthentication
import UserNotifications
import NativeHostPluginAPI

private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var owner: HostViewController?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) { owner?.receive(message) }
}

final class Request {
    let id: String
    let document: String
    let session: String
    let action: String
    let args: [String: Any]
    private let lock = NSLock()
    private var terminal = false
    private var analytics: NativeAnalytics?
    private var started: TimeInterval = 0
    init(id: String, document: String, session: String, action: String, args: [String: Any]) { self.id = id; self.document = document; self.session = session; self.action = action; self.args = args }
    func observe(using analytics: NativeAnalytics) { self.analytics = analytics; started = ProcessInfo.processInfo.systemUptime }
    func recordOutcome(_ result: Result<Any, HostFailure>) {
        lock.lock(); guard !terminal else { lock.unlock(); return }; terminal = true; let analytics = analytics; self.analytics = nil; lock.unlock()
        guard let analytics else { return }
        var properties: [String: Any] = ["action": action, "durationMs": min(600_000, max(0, Int((ProcessInfo.processInfo.systemUptime - started) * 1000))), "outcome": "ok"]
        if case .failure(let failure) = result { properties["outcome"] = failure.code == "CANCELLED" ? "cancelled" : failure.code == "UNAVAILABLE" ? "unavailable" : "error"; if AnalyticsSchema.token(failure.code) { properties["code"] = failure.code } }
        analytics.record(category: "bridge", name: "bridge.completed", properties: properties)
    }
}

final class HostViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIAdaptivePresentationControllerDelegate {
    private(set) var webView: WKWebView!
    private(set) var hapticInvocations = 0
    private var assets: Assets!
    private var storage: Storage!
    private let handler = WeakHandler()
    #if DEBUG
    private var smokeProbe: SmokeProbe?
    #endif
    private var session: String?
    private var document: String?
    private var seen = Set<String>()
    private var analyticsSequence: Int64 = 0
    private var pending: [String: Request] = [:]
    private var toolbarRegistration: String?
    private var toolbarActions: [[String: String]] = []
    private var route = "/"
    private var canGoBack = false
    private var routeTitle = "SPA Host"
    private var back: (token: String, request: Request?)?
    private var backTimer: DispatchWorkItem?
    private var keyboardVisible = false
    private var photoQueue: DispatchQueue { appServices.photoQueue }
    private weak var activePicker: UIImagePickerController?
    private var initialRoute: String?
    private var camera: Request?
    private var demo: UIViewController?
    weak var shell: HostShellCoordinator?
    let surfaceID = UUID().uuidString
    var tabID = "overview"
    var statusStyle = "default"
    var chromeTabBarHidden = false
    var chromeToolbarHidden = false
    var contentMode: String { devOrigin == nil ? "packaged" : "hosted" }
    var currentPath: String { route }
    var hasWebHistory: Bool { canGoBack }
    private var subscriptions: [String: String] = [:]
    private let configuration: HostConfiguration
    private let appServices: ApplicationServices
    private var cameraWaitingForPermission = false
    private var cameraLease: String?
    private var demoLease: String?
    private var errorPanel: UIView?
    private var progressView: UIProgressView!
    private var progressObservation: NSKeyValueObservation?
    private var renderedSessionRevision: Int
    private var sessionLoadRevision: Int?
    private var sessionNavigation: WKNavigation?
    private var sessionShield: UILabel?
    private var awaitingWebSession = false
    private var devOrigin: URL?
    private let assetRoot: URL
    private let dataRoot: URL
    private var checkpoint: URL { dataRoot.appendingPathComponent("route.json") }
    private var photos: URL { dataRoot.appendingPathComponent("photos", isDirectory: true) }
    private let baseCapabilities = ["navigation.back", "navigation.update", "navigation.present", "navigation.dismiss", "toolbar.set", "toolbar.clear", "haptics.impact", "storage.get", "storage.set", "storage.remove", "camera.capture", "files.previewURL", "files.remove", "cancel"]

    init(assetRoot: URL? = nil, dataRoot: URL? = nil, configuration: HostConfiguration? = nil, services: ApplicationServices? = nil, initialPath: String? = nil) {
        let assets = assetRoot ?? Bundle.main.bundleURL.appendingPathComponent("web")
        let root = dataRoot ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("SPAHost", isDirectory: true)
        let chosen = configuration ?? (assetRoot == nil ? (try? HostConfiguration.load(assetRoot: assets)) : nil) ?? HostConfiguration()
        self.configuration = chosen
        self.devOrigin = chosen.contentMode == "hosted" ? chosen.origin : nil
        self.assetRoot = assets; self.dataRoot = root
        self.appServices = services ?? ApplicationServices(root: root, configuration: chosen)
        self.renderedSessionRevision = self.appServices.sessionReadyRevision
        self.initialRoute = initialPath
        super.init(nibName: nil, bundle: nil)
        appServices.registerSessionSurface(surfaceID) { [weak self] revision, ready, owner in self?.sessionInvalidated(revision, ready: ready, owner: owner) }
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { statusStyle == "light" ? .lightContent : statusStyle == "dark" ? .darkContent : .default }
    private var active: Bool { shell?.isActive(self) ?? (viewIfLoaded?.window?.isHidden == false && UIApplication.shared.applicationState == .active) }
    private var capabilities: [String] {
        baseCapabilities + ["chrome.state", "chrome.update", "chrome.selectTab", "events.subscribe", "events.unsubscribe", "notifications.status", "notifications.requestPermission", "notifications.register", "links.getInitial", "share.present", "biometrics.status", "biometrics.authenticate", "analytics.track", "analytics.observe", "analytics.status", "analytics.flush"] + appServices.pluginActions.map { $0.name } + (configuration.navigationMode == "native" ? ["navigation.visit"] : [])
    }
    #if DEBUG
    var analyticsForTesting: NativeAnalytics { appServices.analytics }
    var storageForTesting: Storage { appServices.storage }
    func pendingForTesting(_ action: String) -> Request? { pending.values.first { $0.action == action } }
    #endif
    required init?(coder: NSCoder) { fatalError("Use init") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardShown), name: UIResponder.keyboardDidShowNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardHidden), name: UIResponder.keyboardDidHideNotification, object: nil)
        setDisplayTitle("SPA Host")
        try? FileManager.default.createDirectory(at: photos, withIntermediateDirectories: true)
        // Camera writes in memory first; no pending file survives an abandoned capture.
        storage = appServices.storage
        assets = Assets(root: assetRoot, photos: photos)
        installWebView()
        progressView = UIProgressView(progressViewStyle: .bar)
        progressView.translatesAutoresizingMaskIntoConstraints = false; progressView.accessibilityIdentifier = "native-loading-progress"
        view.addSubview(progressView)
        NSLayoutConstraint.activate([progressView.leadingAnchor.constraint(equalTo: view.leadingAnchor), progressView.trailingAnchor.constraint(equalTo: view.trailingAnchor), progressView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)])
        observeWebProgress()
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Back", style: .plain, target: self, action: #selector(nativeBack))
        navigationItem.leftBarButtonItem?.accessibilityIdentifier = "native-back"
        navigationItem.leftBarButtonItem?.isEnabled = false
        let restored = (try? Data(contentsOf: checkpoint)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["path"]
        load(path: initialRoute ?? restored.flatMap { Self.validRoute($0) ? $0 : nil } ?? "/")
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--spa-smoke"), arguments.indices.contains(index + 1), ["write", "read", "dev"].contains(arguments[index + 1]),
           let tokenIndex = arguments.firstIndex(of: "--spa-smoke-token"), arguments.indices.contains(tokenIndex + 1), Self.identifier(arguments[tokenIndex + 1]) != nil {
            smokeProbe = SmokeProbe(host: self, phase: arguments[index + 1], token: arguments[tokenIndex + 1])
            smokeProbe?.start()
        }
        #endif
    }
    private func installWebView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(assets, forURLScheme: "spa")
        handler.owner = self
        config.userContentController.add(handler, name: "spa")
        let bootstrap = """
        Object.defineProperty(window, '__SPA_TRANSPORT__', {value: Object.freeze({postMessage: function(message) {window.webkit.messageHandlers.spa.postMessage(message);}}), configurable: false, writable: false});
        """
        config.userContentController.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let sdk = try? String(contentsOf: assetRoot.appendingPathComponent("platform-sdk.js"), encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: sdk, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.accessibilityIdentifier = "spa-webview"
        if #available(iOS 16.4, *) {
            #if DEBUG
            webView.isInspectable = true
            #endif
        }
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor), webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        if progressView != nil { observeWebProgress(); view.bringSubviewToFront(progressView) }
    }
    private func observeWebProgress() {
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            self?.progressView.progress = Float(web.estimatedProgress); self?.progressView.isHidden = web.estimatedProgress >= 1
        }
    }
    private func retireHostedDocument() {
        guard contentMode == "hosted", webView != nil else { return }
        resetDocument(); progressObservation = nil
        webView.stopLoading()
        appServices.retireSessionRealm(webView)
        webView.removeFromSuperview(); webView = nil
        sessionNavigation = nil; sessionLoadRevision = nil
    }
    var sessionContentConcealed: Bool { webView == nil || webView.isHidden }
    deinit { appServices.unregisterSessionSurface(surfaceID); handler.owner = nil; backTimer?.cancel(); NotificationCenter.default.removeObserver(self) }
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); prepareSessionVisibility() }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); appServices.cancel(owner: surfaceID) }
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); updateBackChrome() }
    func updateBackChrome() {
        let nativePop = (navigationController?.viewControllers.count ?? 1) > 1
        if nativePop && !canGoBack {
            navigationItem.leftBarButtonItem = nil
        } else {
            let modalRoot = navigationController?.presentingViewController != nil
            let button = UIBarButtonItem(title: modalRoot && !canGoBack ? "Done" : "Back", style: .plain, target: self, action: #selector(nativeBack))
            button.accessibilityIdentifier = modalRoot && !canGoBack ? "native-modal-done" : "native-back"; button.isEnabled = canGoBack || nativePop || modalRoot || presentedViewController != nil
            navigationItem.leftBarButtonItem = button
        }
        if navigationController?.topViewController === self { navigationController?.interactivePopGestureRecognizer?.isEnabled = configuration.backGestures && nativePop && !canGoBack }
    }
    @objc private func keyboardShown() { keyboardVisible = true }
    @objc private func keyboardHidden() { keyboardVisible = false }
    private func concealSessionContent() {
        guard contentMode == "hosted", let webView else { return }
        webView.isHidden = true; webView.isUserInteractionEnabled = false
        setDisplayTitle("SPA Host"); navigationItem.rightBarButtonItems = []
        toolbarRegistration = nil; toolbarActions = []
        if sessionShield == nil {
            let label = UILabel(); label.text = "Updating session…"; label.textAlignment = .center; label.numberOfLines = 0
            label.accessibilityIdentifier = "native-session-shield"; label.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(label)
            NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: view.centerXAnchor), label.centerYAnchor.constraint(equalTo: view.centerYAnchor), label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 20), label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -20)])
            sessionShield = label
        }
        sessionShield?.isHidden = false
        sessionShield?.text = appServices.sessionRealmRetirementFailed ? "Restart the app to finish updating this session." : "Updating session…"
        if let sessionShield { view.bringSubviewToFront(sessionShield) }
    }
    private func sessionInvalidated(_ revision: Int, ready: Bool, owner: String) {
        guard contentMode == "hosted", renderedSessionRevision < revision else { return }
        concealSessionContent()
        if !ready {
            sessionNavigation = nil; sessionLoadRevision = nil
            awaitingWebSession = owner == surfaceID && pending.values.contains(where: { appServices.actionDefinition($0.action)?.handoffCaller == true })
            if owner != surfaceID { retireHostedDocument() }
        }
        // The initiating document stays alive until its native response has
        // executed. A sign-in -> sync chain can run while its pixels are hidden.
        if ready && active && !pending.values.contains(where: { appServices.actionDefinition($0.action)?.coordinatesSession == true }) { prepareSessionVisibility() }
    }
    func prepareSessionVisibility() {
        guard contentMode == "hosted", renderedSessionRevision < appServices.sessionRevision else { return }
        concealSessionContent()
        guard isViewLoaded, !awaitingWebSession, appServices.sessionReadyRevision == appServices.sessionRevision,
              sessionLoadRevision != appServices.sessionRevision else { return }
        retireHostedDocument(); installWebView(); concealSessionContent()
        sessionLoadRevision = appServices.sessionRevision
        guard let origin = devOrigin, let url = URL(string: origin.absoluteString + route) else { return }
        sessionNavigation = webView.load(URLRequest(url: url))
    }
    func load(path: String) {
        guard HostConfiguration.validRoute(path, hosted: contentMode == "hosted"), let url = URL(string: (devOrigin?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? "spa://app") + path) else { return }
        route = path
        guard webView != nil else { initialRoute = path; if isViewLoaded { prepareSessionVisibility() }; return }
        errorPanel?.removeFromSuperview(); errorPanel = nil
        if contentMode == "hosted", renderedSessionRevision < appServices.sessionRevision {
            concealSessionContent()
            guard !awaitingWebSession, appServices.sessionReadyRevision == appServices.sessionRevision else { return }
            retireHostedDocument(); installWebView(); concealSessionContent()
            sessionLoadRevision = appServices.sessionRevision; sessionNavigation = webView.load(URLRequest(url: url))
        } else { webView.load(URLRequest(url: url)) }
    }
    static func validRoute(_ path: String) -> Bool {
        HostConfiguration.validRoute(path, hosted: false)
    }
    private func resetDocument() {
        if !cameraWaitingForPermission, activePicker != nil { camera?.recordOutcome(.failure(HostFailure("CANCELLED", "Camera owner retired"))) }
        back?.request?.recordOutcome(.failure(HostFailure("CANCELLED", "Navigation owner retired")))
        appServices.cancel(owner: surfaceID)
        if !cameraWaitingForPermission, let cameraLease { appServices.release(cameraLease); self.cameraLease = nil }
        if let demoLease { appServices.release(demoLease); self.demoLease = nil }
        session = nil; document = nil; seen.removeAll(); analyticsSequence = 0; pending.removeAll(); subscriptions.removeAll()
        toolbarRegistration = nil; toolbarActions = []; navigationItem.rightBarButtonItems = []
        back = nil; backTimer?.cancel(); backTimer = nil
        camera = nil; activePicker = nil
        canGoBack = false; navigationItem.leftBarButtonItem?.isEnabled = false
        if let controller = presentedViewController, controller === demo || controller is UIImagePickerController || controller is UIActivityViewController { controller.dismiss(animated: false) }
        demo = nil
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        resetDocument()
        if contentMode == "hosted", renderedSessionRevision < appServices.sessionRevision {
            concealSessionContent()
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView, contentMode == "hosted", sessionNavigation === navigation, sessionLoadRevision == appServices.sessionRevision,
              appServices.sessionReadyRevision == appServices.sessionRevision, !awaitingWebSession else { return }
        renderedSessionRevision = appServices.sessionRevision; sessionNavigation = nil; sessionLoadRevision = nil
        webView.isHidden = false; webView.isUserInteractionEnabled = true; sessionShield?.isHidden = true
        if active { didActivate() }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { guard webView === self.webView else { return }; resetDocument(); load(path: route) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard webView === self.webView, let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.targetFrame?.isMainFrame == true, contentMode == "hosted", renderedSessionRevision < appServices.sessionRevision,
           (appServices.sessionReadyRevision != appServices.sessionRevision || awaitingWebSession) { decisionHandler(.cancel); return }
        let local: Bool
        if let devOrigin { local = url.scheme == devOrigin.scheme && url.host == devOrigin.host && effectivePort(url) == effectivePort(devOrigin) }
        else { local = url.scheme == "spa" && url.host == "app" && Assets.safePath(url) != nil }
        if local && navigationAction.targetFrame?.isMainFrame == true { decisionHandler(.allow); return }
        if navigationAction.targetFrame?.isMainFrame == true, ["http", "https"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if webView === self.webView { showLoadFailure(error) } }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if webView === self.webView { showLoadFailure(error) } }
    private func showLoadFailure(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled, contentMode == "hosted" else { return }
        resetDocument()
        progressView.isHidden = true
        errorPanel?.removeFromSuperview()
        let panel = UIStackView(); panel.axis = .vertical; panel.spacing = 16; panel.alignment = .center; panel.translatesAutoresizingMaskIntoConstraints = false
        let label = UILabel(); label.text = "Unable to load hosted content"; label.accessibilityIdentifier = "hosted-load-error"
        let retry = UIButton(type: .system); retry.setTitle("Retry", for: .normal); retry.addTarget(self, action: #selector(retryHosted), for: .touchUpInside)
        let packaged = UIButton(type: .system); packaged.setTitle("Use packaged app", for: .normal); packaged.addTarget(self, action: #selector(usePackaged), for: .touchUpInside)
        [label, retry, packaged].forEach { panel.addArrangedSubview($0) }; view.addSubview(panel)
        NSLayoutConstraint.activate([panel.centerXAnchor.constraint(equalTo: view.centerXAnchor), panel.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        errorPanel = panel
    }
    @objc private func retryHosted() { load(path: route) }
    @objc private func usePackaged() {
        if let shell { shell.usePackaged(from: self) }
        else { resetDocument(); devOrigin = nil; load(path: HostConfiguration.validRoute(route, hosted: false) ? route : "/") }
    }
    func invalidateSurface() { handler.owner = nil; webView?.stopLoading(); resetDocument(); shell = nil }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    private func effectivePort(_ url: URL) -> Int { url.port ?? (url.scheme == "https" ? 443 : url.scheme == "http" ? 80 : 0) }
    private func authorized(_ origin: WKSecurityOrigin) -> Bool {
        guard let devOrigin else { return origin.protocol == "spa" && origin.host == "app" && origin.port == 0 }
        let nativePort = origin.port == 0 ? (origin.protocol == "https" ? 443 : 80) : origin.port
        return origin.protocol == devOrigin.scheme && origin.host == devOrigin.host && nativePort == effectivePort(devOrigin)
    }
    private static func identifier(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty, value.utf8.count <= 128,
              value.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }) else { return nil }
        return value
    }
    static func analyticsSequence(_ value: String) -> Int64? {
        guard value.range(of: "^[1-9][0-9]{0,15}$", options: .regularExpression) != nil, let sequence = Int64(value), sequence <= 9_007_199_254_740_991 else { return nil }; return sequence
    }
    private func expected(_ args: [String: Any], _ keys: Set<String>, optional: Set<String> = []) throws {
        let actual = Set(args.keys)
        guard keys.isSubset(of: actual), actual.isSubset(of: keys.union(optional)) else { throw HostFailure("INVALID_REQUEST", "Unexpected action arguments") }
    }
    private func string(_ args: [String: Any], _ key: String, max: Int = 128, empty: Bool = false, allowNUL: Bool = false) throws -> String {
        guard let value = args[key] as? String, value.utf8.count <= max, (empty || !value.isEmpty), (allowNUL || !value.contains("\0")) else { throw HostFailure("INVALID_REQUEST", "Invalid " + key) }
        return value
    }
    func receive(_ message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, authorized(origin),
              message.webView === webView,
              let text = message.body as? String, text.utf8.count <= 131_072,
              let data = text.data(using: .utf8), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(body.keys) == Set(["v", "id", "document", "session", "action", "args"]),
              let version = body["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let id = Self.identifier(body["id"]), let nonce = Self.identifier(body["document"]),
              let action = body["action"] as? String, action.utf8.count <= 64,
              let args = body["args"] as? [String: Any] else { return }
        if action == "hello" {
            guard args.isEmpty, body["session"] is NSNull else { return }
            if let document, document != nonce { return }
            if session == nil { session = UUID().uuidString; document = nonce }
        }
        guard document == nonce, let session else { return }
        let request = Request(id: id, document: nonce, session: session, action: action, args: args)
        guard action == "hello" || body["session"] as? String == session else { respond(request, .failure(HostFailure("UNAUTHORIZED", "Invalid session"))); return }
        let telemetryPrefix = nonce + "-a"
        if action.hasPrefix("analytics.") || (action == "cancel" && id.hasPrefix(telemetryPrefix)) {
            guard id.hasPrefix(telemetryPrefix), let sequence = Self.analyticsSequence(String(id.dropFirst(telemetryPrefix.count))), sequence > analyticsSequence else { respond(request, .failure(HostFailure("INVALID_REQUEST", "Duplicate or invalid analytics sequence"))); return }
            if action == "cancel" {
                guard let target = args["requestId"] as? String, target.hasPrefix(telemetryPrefix), let targetSequence = Self.analyticsSequence(String(target.dropFirst(telemetryPrefix.count))), targetSequence < sequence else { respond(request, .failure(HostFailure("INVALID_REQUEST", "Invalid analytics cancellation"))); return }
            }
            analyticsSequence = sequence
        } else {
            guard !id.hasPrefix(telemetryPrefix) else { respond(request, .failure(HostFailure("INVALID_REQUEST", "Reserved analytics identifier"))); return }
            guard !seen.contains(id), seen.count < 4096 else { respond(request, .failure(HostFailure("INVALID_REQUEST", "Duplicate request or session limit"))); return }
            seen.insert(id)
        }
        guard pending.count < 64 else { respond(request, .failure(HostFailure("BUSY", "Too many requests"))); return }
        pending[id] = request
        if !action.hasPrefix("analytics."), !["hello", "cancel", "events.subscribe", "events.unsubscribe"].contains(action), AnalyticsSchema.token(action) { request.observe(using: appServices.analytics) }
        do { try dispatch(request) }
        catch let failure as HostFailure { finish(request, .failure(failure)) }
        catch { finish(request, .failure(HostFailure("IO_ERROR", "Native operation failed"))) }
    }
    func setDisplayTitle(_ value: String) { title = value; restoreTabLabel() }
    func restoreTabLabel() {
        if let label = configuration.tabs.first(where: { $0.id == tabID })?.title { tabBarItem.title = label; navigationController?.tabBarItem.title = label }
    }
    func didActivate() {
        prepareSessionVisibility()
        if active { appServices.analytics.screen(route, tab: tabID, surface: surfaceID) }
        restoreTabLabel()
        updateBackChrome()
        if let metadata = shell?.metadata(self) { deliverEvent("navigation.changed", ["reason": "activated", "host": metadata]) }
        for name in Set(subscriptions.values) { appServices.drain(name) { [weak self] data in self?.deliverEvent(name, data) ?? false } }
    }
    @discardableResult func deliverEvent(_ name: String, _ data: [String: Any]) -> Bool {
        if contentMode == "hosted", renderedSessionRevision < appServices.sessionRevision, !appServices.pluginStateEvents.contains(name) { return false }
        guard active, let session, let document else { return false }
        let matching = subscriptions.filter { $0.value == name }
        for (id, _) in matching { send(["v": 1, "session": session, "document": document, "event": name, "data": data, "subscription": id]) }
        return !matching.isEmpty
    }
    private func emit(_ name: String, _ data: [String: Any]) {
        guard let session, let document else { return }
        send(["v": 1, "session": session, "document": document, "event": name, "data": data])
    }
    private func send(_ payload: [String: Any], completion: (() -> Void)? = nil) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed]), let json = String(data: data, encoding: .utf8) else { completion?(); return }
        webView.evaluateJavaScript("window.__spaReceive && window.__spaReceive(" + json + ")") { _, _ in completion?() }
    }
    private func respond(_ request: Request, _ result: Result<Any, HostFailure>, completion: (() -> Void)? = nil) {
        guard session == request.session, document == request.document else { completion?(); return }
        var reply: [String: Any] = ["v": 1, "id": request.id, "document": request.document, "session": request.session]
        switch result {
        case .success(let value): reply["ok"] = true; reply["result"] = value
        case .failure(let error): reply["ok"] = false; reply["error"] = ["code": error.code, "message": error.message]
        }
        send(reply, completion: completion)
    }
    private func finish(_ request: Request, _ result: Result<Any, HostFailure>, afterDelivery: (() -> Void)? = nil) {
        request.recordOutcome(result)
        guard session == request.session, document == request.document,
              let admitted = pending[request.id], admitted === request else { afterDelivery?(); return }
        pending.removeValue(forKey: request.id)
        respond(request, result, completion: afterDelivery)
    }
    private func dispatch(_ request: Request) throws {
        let args = request.args
        if let failure = appServices.pluginStartupFailure { throw failure }
        let definition = appServices.actionDefinition(request.action)
        if definition?.requiresFresh == true, contentMode == "hosted", renderedSessionRevision < appServices.sessionRevision {
            throw HostFailure("UNAUTHORIZED", "This operation requires a fresh session document")
        }
        if contentMode == "hosted", renderedSessionRevision < appServices.sessionRevision,
           definition?.permitsStale != true, !["hello", "cancel", "events.subscribe", "events.unsubscribe"].contains(request.action) {
            throw HostFailure("UNAUTHORIZED", "Document session context is stale")
        }
        let visibleActions: Set<String> = ["haptics.impact", "navigation.visit", "navigation.back", "navigation.present", "navigation.dismiss", "chrome.update", "chrome.selectTab", "notifications.requestPermission", "share.present", "biometrics.authenticate", "camera.capture", "analytics.track", "analytics.observe", "analytics.flush"]
        if (visibleActions.contains(request.action) || definition?.visible == true) && !active { throw HostFailure("UNAUTHORIZED", "Only visible content may invoke native UI") }
        if let plugin = appServices.plugin(for: request.action) {
            let context = PluginCallContext(surfaceID: surfaceID, requestID: request.id, presenter: self, cookieStore: webView.configuration.websiteDataStore.httpCookieStore, hostedOrigin: devOrigin, returnPath: route)
            try plugin.handle(action: request.action, arguments: args, context: context) { [weak self] result in
                request.recordOutcome(result)
                if case .failure = result, definition?.releaseHandoffOnFailure == true { self?.awaitingWebSession = false }
                self?.finish(request, result, afterDelivery: { [weak self] in self?.prepareSessionVisibility() })
            }
            return
        }
        switch request.action {
        case "analytics.track":
            try expected(args, ["name"], optional: ["properties"])
            let name = try string(args, "name", max: 64)
            guard name.hasPrefix("custom."), AnalyticsSchema.name(name) else { throw AnalyticsSchema.invalid() }
            let properties: [String: Any]
            if let supplied = args["properties"] { guard let value = supplied as? [String: Any] else { throw AnalyticsSchema.invalid() }; properties = try AnalyticsSchema.properties(value) } else { properties = [:] }
            appServices.analytics.record(category: "custom", name: name, properties: properties, source: "web") { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "analytics.observe":
            try expected(args, ["type", "kind"], optional: ["control"])
            let type = try string(args, "type", max: 16), kind = try string(args, "kind", max: 16)
            guard ["click", "submit", "change"].contains(type) else { throw AnalyticsSchema.invalid() }
            var properties: [String: Any] = ["kind": kind]
            if let control = args["control"] { guard let value = control as? String else { throw AnalyticsSchema.invalid() }; properties["control"] = value }
            _ = try AnalyticsSchema.properties(properties)
            appServices.analytics.record(category: "interaction", name: "interaction." + type, properties: properties, source: "web") { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "analytics.status":
            try expected(args, []); appServices.analytics.status { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "analytics.flush":
            try expected(args, []); appServices.analytics.flush { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "hello":
            let metadata = shell?.metadata(self) ?? ["apiVersion": 2, "contentMode": contentMode, "navigationMode": configuration.navigationMode, "chromeMode": configuration.chromeMode, "surfaceId": surfaceID, "activeTab": tabID]
            finish(request, .success(["platform": "ios", "capabilities": capabilities, "host": metadata]))
        case "haptics.impact":
            try expected(args, ["style"])
            let name = try string(args, "style")
            let styles: [String: UIImpactFeedbackGenerator.FeedbackStyle] = ["light": .light, "medium": .medium, "heavy": .heavy]
            guard let style = styles[name] else { throw HostFailure("INVALID_REQUEST", "Unknown haptic style") }
            #if targetEnvironment(simulator)
            throw HostFailure("UNAVAILABLE", "Haptics require physical hardware")
            #else
            let generator = UIImpactFeedbackGenerator(style: style)
            generator.prepare(); generator.impactOccurred(); hapticInvocations += 1
            finish(request, .success(NSNull()))
            #endif
        case "storage.get", "storage.set", "storage.remove":
            try expected(args, request.action == "storage.set" ? ["key", "value"] : ["key"])
            let key = try string(args, "key", allowNUL: true)
            let value = request.action == "storage.set" ? try string(args, "value", max: 32768, empty: true, allowNUL: true) : nil
            storage.perform(action: request.action, key: key, value: value) { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "navigation.update":
            try expected(args, ["path", "title", "canGoBack"], optional: ["ack"])
            let path = try string(args, "path", max: 2048)
            let newTitle = try string(args, "title", max: 128, empty: true)
            guard HostConfiguration.validRoute(path, hosted: contentMode == "hosted"), let isBack = args["canGoBack"] as? NSNumber, CFGetTypeID(isBack) == CFBooleanGetTypeID() else { throw HostFailure("INVALID_REQUEST", "Invalid route state") }
            if let ack = args["ack"] {
                guard let token = ack as? String, let back, token == back.token else { throw HostFailure("INVALID_REQUEST", "Stale navigation acknowledgment") }
            }
            route = path; canGoBack = isBack.boolValue; routeTitle = newTitle
            if active { appServices.analytics.screen(path, tab: tabID, surface: surfaceID) }
            if toolbarRegistration == nil { setDisplayTitle(newTitle) }
            updateBackChrome()
            shell?.routeChanged(self)
            if let ack = args["ack"] as? String, let back, ack == back.token {
                self.back = nil; backTimer?.cancel(); backTimer = nil
                if let caller = back.request { finish(caller, .success(NSNull())) }
            }
            if let data = try? JSONSerialization.data(withJSONObject: ["path": path]) { try? data.write(to: checkpoint, options: [.atomic]) }
            finish(request, .success(NSNull()))
        case "navigation.back": try expected(args, []); requestBack(request)
        case "navigation.present":
            try expected(args, ["screen"])
            guard try string(args, "screen") == "native-demo" else { throw HostFailure("UNSUPPORTED", "Unknown native screen") }
            guard presentedViewController == nil else { throw HostFailure("BUSY", "A native screen is already open") }
            demoLease = try appServices.acquire(owner: surfaceID, requestID: request.id)
            let controller = UIViewController()
            controller.view.backgroundColor = .systemGroupedBackground
            controller.title = "Native sheet"
            let label = UILabel(); label.text = "This is native UIKit"; label.font = .preferredFont(forTextStyle: .title2); label.translatesAutoresizingMaskIntoConstraints = false
            label.accessibilityIdentifier = "native-demo-label"
            controller.view.addSubview(label)
            NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor), label.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor)])
            let nav = UINavigationController(rootViewController: controller)
            controller.navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Done", style: .done, target: self, action: #selector(closeDemo))
            controller.navigationItem.rightBarButtonItem?.accessibilityIdentifier = "native-demo-done"
            demo = nav
            present(nav, animated: true) { [weak self] in request.recordOutcome(.success(NSNull())); self?.finish(request, .success(NSNull())) }
            nav.presentationController?.delegate = self
        case "navigation.dismiss":
            try expected(args, [])
            guard camera == nil else { throw HostFailure("BUSY", "Camera is in progress") }
            if presentedViewController != nil { dismiss(animated: true) { [weak self] in request.recordOutcome(.success(NSNull())); self?.releaseDemo(); self?.finish(request, .success(NSNull())) } }
            else { _ = shell?.pop(self); finish(request, .success(NSNull())) }
        case "toolbar.set":
            try expected(args, ["registration", "title", "actions"])
            let registration = try string(args, "registration")
            let newTitle = try string(args, "title", max: 128, empty: true)
            guard let actions = args["actions"] as? [[String: Any]], actions.count <= 2 else { throw HostFailure("INVALID_REQUEST", "Too many toolbar actions") }
            var checked = [[String: String]](); var ids = Set<String>()
            for action in actions {
                try expected(action, ["id", "title"])
                let id = try string(action, "id")
                guard ids.insert(id).inserted else { throw HostFailure("INVALID_REQUEST", "Duplicate toolbar action") }
                checked.append(["id": id, "title": try string(action, "title", max: 64)])
            }
            toolbarRegistration = registration; toolbarActions = checked; setDisplayTitle(newTitle)
            navigationItem.rightBarButtonItems = checked.enumerated().map { index, action in
                let button = UIBarButtonItem(title: action["title"], style: .plain, target: self, action: #selector(toolbarClick(_:)))
                button.tag = index; button.accessibilityIdentifier = "native-toolbar-" + action["id"]!
                return button
            }
            finish(request, .success(NSNull()))
        case "toolbar.clear":
            try expected(args, ["registration"])
            if try string(args, "registration") == toolbarRegistration { toolbarRegistration = nil; toolbarActions = []; navigationItem.rightBarButtonItems = []; setDisplayTitle(routeTitle) }
            finish(request, .success(NSNull()))
        case "camera.capture": try expected(args, []); try capture(request)
        case "files.previewURL", "files.remove":
            try expected(args, ["file"])
            let handle = try string(args, "file")
            guard Assets.photoHandle(handle) else { throw HostFailure("INVALID_REQUEST", "Invalid photo handle") }
            let file = photos.appendingPathComponent(handle.lowercased() + ".jpg")
            guard FileManager.default.fileExists(atPath: file.path) else { throw HostFailure("UNAVAILABLE", "Photo does not exist") }
            if request.action == "files.remove" { try FileManager.default.removeItem(at: file); finish(request, .success(NSNull())) }
            else { finish(request, .success("spa://app/__photos/" + handle.lowercased() + ".jpg")) }
        case "navigation.visit":
            try expected(args, ["path", "presentation"])
            guard let shell else { throw HostFailure("UNSUPPORTED", "Native visit shell is unavailable") }
            try shell.visit(try string(args, "path", max: 2048), presentation: try string(args, "presentation"), from: self) { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "chrome.state":
            try expected(args, [])
            finish(request, .success(shell?.chromeState(self) ?? ["mode": "standard", "activeTab": tabID, "surfaceId": surfaceID, "depth": 1, "tabs": []]))
        case "chrome.selectTab":
            try expected(args, ["id"])
            guard let shell else { throw HostFailure("UNSUPPORTED", "Native tabs are unavailable") }
            try shell.selectTab(try string(args, "id"), from: self); finish(request, .success(NSNull()))
        case "chrome.update":
            guard let shell else { throw HostFailure("UNSUPPORTED", "Native shell options are unavailable") }
            try shell.updateChrome(args, from: self); finish(request, .success(NSNull()))
        case "events.subscribe":
            try expected(args, ["event", "subscription"])
            let name = try string(args, "event"), id = try string(args, "subscription")
            guard (["navigation.changed", "chrome.tabSelected", "links.opened", "notifications.token", "notifications.received", "notifications.opened"].contains(name) || appServices.pluginEvents.contains(name)), subscriptions[id] == nil, subscriptions.count < 32 else { throw HostFailure("INVALID_REQUEST", "Invalid native subscription") }
            subscriptions[id] = name; finish(request, .success(NSNull()))
            appServices.drain(name) { [weak self] data in self?.deliverEvent(name, data) ?? false }
        case "events.unsubscribe":
            try expected(args, ["subscription"]); subscriptions.removeValue(forKey: try string(args, "subscription")); finish(request, .success(NSNull()))
        case "links.getInitial":
            try expected(args, []); finish(request, .success(appServices.initialLink.map { ["path": $0] } as Any? ?? NSNull()))
        case "notifications.status":
            try expected(args, []); appServices.notificationStatus { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "notifications.requestPermission":
            try expected(args, []); try appServices.requestNotificationPermission(owner: surfaceID, requestID: request.id) { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "notifications.register":
            try expected(args, []); appServices.registerNotifications(owner: surfaceID, requestID: request.id) { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "biometrics.status":
            try expected(args, []); finish(request, .success(appServices.biometricStatus()))
        case "biometrics.authenticate":
            try expected(args, ["reason"]); try appServices.authenticate(owner: surfaceID, requestID: request.id, reason: try string(args, "reason", max: 256)) { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "share.present":
            try expected(args, [], optional: ["text", "url", "file"])
            var items: [Any] = []
            if args["text"] != nil { items.append(try string(args, "text", max: 32768)) }
            if args["url"] != nil { let raw = try string(args, "url", max: 2048); guard let url = URL(string: raw), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { throw HostFailure("INVALID_REQUEST", "Invalid share URL") }; items.append(url) }
            if args["file"] != nil { let handle = try string(args, "file"); guard Assets.photoHandle(handle) else { throw HostFailure("INVALID_REQUEST", "Invalid photo handle") }; let file = photos.appendingPathComponent(handle.lowercased() + ".jpg"); guard FileManager.default.fileExists(atPath: file.path) else { throw HostFailure("UNAVAILABLE", "Photo does not exist") }; items.append(file) }
            guard !items.isEmpty else { throw HostFailure("INVALID_REQUEST", "Sharing requires content") }
            try appServices.share(owner: surfaceID, requestID: request.id, items: items, presenter: self) { [weak self] result in request.recordOutcome(result); self?.finish(request, result) }
        case "cancel":
            try expected(args, ["requestId"])
            let id = try string(args, "requestId")
            if id != request.id {
                pending.removeValue(forKey: id)
                appServices.cancel(owner: surfaceID, requestID: id)
                if camera?.id == id {
                    if !cameraWaitingForPermission, activePicker != nil { camera?.recordOutcome(.failure(HostFailure("CANCELLED", "Capture cancelled"))) }
                    camera = nil; activePicker = nil
                    let lease = cameraLease
                    if !cameraWaitingForPermission {
                        cameraLease = nil
                        if presentedViewController is UIImagePickerController { dismiss(animated: true) { [services = appServices] in if let lease { services.release(lease) } } }
                        else if let lease { appServices.release(lease) }
                    }
                }
                if back?.request?.id == id { back?.request?.recordOutcome(.failure(HostFailure("CANCELLED", "Navigation cancelled"))); back = nil; backTimer?.cancel(); backTimer = nil }
            }
            finish(request, .success(NSNull()))
        default: throw HostFailure("UNSUPPORTED", "Unsupported action")
        }
    }
    @objc private func toolbarClick(_ button: UIBarButtonItem) {
        guard let registration = toolbarRegistration, toolbarActions.indices.contains(button.tag), let id = toolbarActions[button.tag]["id"] else { return }
        emit("toolbar.action", ["registration": registration, "id": id])
    }
    private func releaseDemo() { demo = nil; if let demoLease { appServices.release(demoLease); self.demoLease = nil } }
    @objc private func closeDemo() { dismiss(animated: true) { [weak self] in self?.releaseDemo() } }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { releaseDemo() }
    @objc private func nativeBack() { requestBack(nil) }
    private func requestBack(_ request: Request?) {
        if keyboardVisible { view.endEditing(true); if let request { finish(request, .success(NSNull())) }; return }
        if camera != nil { if let request { finish(request, .failure(HostFailure("BUSY", "Camera is in progress"))) }; return }
        if presentedViewController != nil {
            dismiss(animated: true) { [weak self] in self?.releaseDemo(); if let request { request.recordOutcome(.success(NSNull())); self?.finish(request, .success(NSNull())) } }; return
        }
        guard back == nil else { if let request { finish(request, .failure(HostFailure("BUSY", "Navigation is in progress"))) }; return }
        guard canGoBack else { _ = shell?.pop(self); if let request { finish(request, .success(NSNull())) }; return }
        let token = UUID().uuidString
        back = (token, request)
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, let back = self.back, back.token == token else { return }
            self.back = nil
            if let caller = back.request { self.finish(caller, .failure(HostFailure("TIMEOUT", "Navigation acknowledgment timed out"))) }
        }
        backTimer = deadline; DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: deadline)
        emit("navigation.back", ["token": token])
    }
    private func capture(_ request: Request) throws {
        #if targetEnvironment(simulator)
        throw HostFailure("UNAVAILABLE", "Camera requires physical hardware")
        #else
        guard camera == nil, presentedViewController == nil else { throw HostFailure("BUSY", "A native presentation is in progress") }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { throw HostFailure("UNAVAILABLE", "Camera is unavailable") }
        let lease = try appServices.acquire(owner: surfaceID, requestID: request.id)
        cameraLease = lease
        camera = request
        let services = appServices
        let launch = { [weak self] (granted: Bool) in
            DispatchQueue.main.async {
                guard let self else { request.recordOutcome(.failure(HostFailure("CANCELLED", "Camera owner is no longer active"))); services.release(lease); return }
                self.cameraWaitingForPermission = false
                guard self.camera?.id == request.id, self.pending[request.id] != nil, self.session == request.session, self.active else {
                    services.release(lease); if self.cameraLease == lease { self.cameraLease = nil }
                    self.finish(request, .failure(HostFailure("CANCELLED", "Camera owner is no longer active"))); return
                }
                guard granted else { self.camera = nil; services.release(lease); self.cameraLease = nil; self.finish(request, .failure(HostFailure("UNAUTHORIZED", "Camera permission was denied"))); return }
                let picker = UIImagePickerController(); picker.sourceType = .camera; picker.mediaTypes = ["public.image"]; picker.delegate = self
                picker.modalPresentationStyle = .fullScreen
                self.activePicker = picker
                self.present(picker, animated: true)
            }
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: launch(true)
        case .notDetermined: cameraWaitingForPermission = true; AVCaptureDevice.requestAccess(for: .video, completionHandler: launch)
        default: launch(false)
        }
        #endif
    }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        guard picker === activePicker else { return }
        activePicker = nil
        let lease = cameraLease; cameraLease = nil
        let caller = camera; camera = nil
        picker.dismiss(animated: true) { [weak self, services = appServices] in if let lease { services.release(lease) }; if let caller { caller.recordOutcome(.failure(HostFailure("CANCELLED", "Capture cancelled"))); self?.finish(caller, .failure(HostFailure("CANCELLED", "Capture cancelled"))) } }
    }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        guard picker === activePicker else { return }
        activePicker = nil
        let lease = cameraLease; cameraLease = nil
        let caller = camera; camera = nil
        picker.dismiss(animated: true) { [weak self, services = appServices] in
            guard let self else { caller?.recordOutcome(.failure(HostFailure("CANCELLED", "Camera owner is no longer active"))); if let lease { services.release(lease) }; return }
            self.persistPhoto(info, caller: caller, lease: lease)
        }
    }
    private func persistPhoto(_ info: [UIImagePickerController.InfoKey: Any], caller: Request?, lease: String?) {
        guard let caller, pending[caller.id] != nil, session == caller.session, document == caller.document else { caller?.recordOutcome(.failure(HostFailure("CANCELLED", "Camera owner is no longer active"))); if let lease { appServices.release(lease) }; return }
        guard let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.85), data.count <= 20 * 1024 * 1024 else { if let lease { appServices.release(lease) }; finish(caller, .failure(HostFailure("QUOTA_EXCEEDED", "Photo exceeds size limit"))); return }
        let capturedSession = caller.session
        let destination = photos
        photoQueue.async { [weak self, services = appServices] in
            let result: Result<Any, HostFailure>
            let handle = UUID().uuidString.lowercased()
            let file = destination.appendingPathComponent(handle + ".jpg")
            do {
                let existing = try FileManager.default.contentsOfDirectory(at: destination, includingPropertiesForKeys: [.fileSizeKey])
                let total = try existing.reduce(0) { try $0 + ($1.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) }
                guard total + data.count <= 100 * 1024 * 1024 else { throw HostFailure("QUOTA_EXCEEDED", "Photo storage quota exceeded") }
                try data.write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
                result = .success(["file": handle, "mimeType": "image/jpeg"])
            } catch let failure as HostFailure { result = .failure(failure) }
            catch { result = .failure(HostFailure("IO_ERROR", "Could not save photo")) }
            DispatchQueue.main.async {
                if let lease { services.release(lease) }
                caller.recordOutcome(result)
                guard let self, self.pending[caller.id] != nil, self.session == capturedSession, self.document == caller.document else { try? FileManager.default.removeItem(at: file); return }
                self.finish(caller, result)
            }
        }
    }
}
