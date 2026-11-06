import UIKit
import UserNotifications
import LocalAuthentication
import WebKit
import NativeHostPluginAPI

final class ApplicationServices: NSObject, UNUserNotificationCenterDelegate, PluginHostServices {
    let root: URL
    let photoQueue = DispatchQueue(label: "dev.spahost.photos", qos: .userInitiated)
    let analytics: NativeAnalytics
    let configuration: HostConfiguration
    private(set) var plugins: [NativePlugin] = []
    private(set) var pluginStartupFailure: HostFailure?
    var pluginActions: [PluginAction] { plugins.flatMap { $0.actions } }
    var pluginEvents: Set<String> { Set(plugins.flatMap { $0.events }) }
    var pluginStateEvents: Set<String> { Set(plugins.flatMap { $0.stateEvents }) }
    func actionDefinition(_ name: String) -> PluginAction? { pluginActions.first { $0.name == name } }
    func plugin(for action: String) -> NativePlugin? { plugins.first { $0.actions.contains { $0.name == action } } }
    private(set) var sessionRevision = 0
    private(set) var sessionReadyRevision = 0
    private var sessionSurfaces: [String: (Int, Bool, String) -> Void] = [:]
    private var retiringSessionRealms: [SessionRealmRetirement] = []
    private var sessionRealmFailed = false
    var sessionRealmRetirementFailed: Bool { sessionRealmFailed }
    var eventSink: ((String, [String: Any]) -> Bool)?
    private(set) var initialLink: String?
    private var buffered: [(String, [String: Any])] = []
    private var notificationIDs = Set<String>()
    private var token: String?
    private struct TokenWaiter { let id: String; let owner: String; let requestID: String; let completion: (Result<Any, HostFailure>) -> Void }
    private var tokenWaiters: [TokenWaiter] = []
    private var lease: (id: String, owner: String, requestID: String)?
    private var authContext: LAContext?
    private weak var shareController: UIActivityViewController?
    private var shareCancellation: (() -> Void)?
    init(root: URL, configuration: HostConfiguration) {
        self.root = root; self.configuration = configuration
        self.analytics = NativeAnalytics(root: root.appendingPathComponent("analytics", isDirectory: true), configuration: configuration.analytics)
        super.init()
        #if DEBUG
        let debug = true
        #else
        let debug = false
        #endif
        var features = Set<String>()
        #if SPA_PASSKEYS_ENABLED
        features.insert("passkeys")
        #endif
        do {
            plugins = try GeneratedPluginRegistry.make(environment: PluginEnvironment(configuration: configuration.pluginConfigurations, services: self, dataRoot: root, debug: debug, features: features))
            let actions = plugins.flatMap { $0.actions.map { $0.name } }, ids = plugins.map { $0.id }
            guard Set(ids).count == ids.count, Set(actions).count == actions.count, !actions.contains("hello"), !actions.contains("cancel"),
                  plugins.allSatisfy({ Set($0.stateEvents).isSubset(of: Set($0.events)) }) else { throw HostFailure("INVALID_REQUEST", "Conflicting native plug-in registration") }
        } catch { plugins = []; pluginStartupFailure = error as? HostFailure ?? HostFailure("UNAVAILABLE", "Native plug-in startup failed") }
    }
    func acquire(owner: String, requestID: String) throws -> String {
        guard lease == nil else { throw HostFailure("BUSY", "Another native interaction is open") }
        let id = UUID().uuidString; lease = (id, owner, requestID); return id
    }
    func release(_ id: String) { if lease?.id == id { lease = nil; authContext = nil; shareController = nil; shareCancellation = nil } }
    func cancel(owner: String, requestID: String? = nil) {
        plugins.forEach { $0.cancel(surfaceID: owner, requestID: requestID) }
        tokenWaiters.removeAll { $0.owner == owner && (requestID == nil || $0.requestID == requestID) }
        if let lease, lease.owner == owner, requestID == nil || lease.requestID == requestID {
            authContext?.invalidate()
            if let shareController { let cancellation = shareCancellation; shareCancellation = nil; shareController.dismiss(animated: false); release(lease.id); cancellation?() }
        }
    }
    func presentationMatches(owner: String, requestID: String) -> Bool { lease?.owner == owner && lease?.requestID == requestID }
    func publish(_ event: String, _ data: [String: Any]) {
        // State events retain the current snapshot rather than old identities.
        if pluginStateEvents.contains(event) { buffered.removeAll { $0.0 == event } }
        if eventSink?(event, data) != true { buffered.append((event, data)); if buffered.count > 32 { buffered.removeFirst() } }
    }
    func registerSessionSurface(_ id: String, observer: @escaping (Int, Bool, String) -> Void) { sessionSurfaces[id] = observer }
    func unregisterSessionSurface(_ id: String) { sessionSurfaces.removeValue(forKey: id) }
    @discardableResult func beginSessionChange(owner: String) -> Int {
        sessionRevision += 1
        for observer in Array(sessionSurfaces.values) { observer(sessionRevision, false, owner) }
        return sessionRevision
    }
    func completeSessionChange(_ revision: Int, owner: String) {
        guard revision == sessionRevision else { return }
        awaitSessionRealms(revision) { [weak self] result in
            guard let self, revision == self.sessionRevision, case .success = result else { return }
            self.sessionReadyRevision = revision
            for observer in Array(self.sessionSurfaces.values) { observer(revision, true, owner) }
        }
    }
    func retireSessionRealm(_ web: WKWebView) {
        let retirement = SessionRealmRetirement(web)
        retiringSessionRealms.append(retirement)
        retirement.start { [weak self, weak retirement] result in
            guard let self else { return }
            if case .failure = result { self.sessionRealmFailed = true }
            self.retiringSessionRealms.removeAll { $0 === retirement }
        }
    }
    func awaitSessionRealms(_ revision: Int, completion: @escaping (Result<Void, HostFailure>) -> Void) {
        guard !sessionRealmFailed else { completion(.failure(HostFailure("UNAVAILABLE", "Previous authentication document could not be retired; restart the app"))); return }
        let pending = retiringSessionRealms
        if pending.isEmpty { completion(revision == sessionRevision ? .success(()) : .failure(HostFailure("CANCELLED", "Authentication context changed"))); return }
        let group = DispatchGroup(); var failure: HostFailure?
        for realm in pending { group.enter(); realm.wait { result in if case .failure(let error) = result { failure = error }; group.leave() } }
        group.notify(queue: .main) { [weak self] in
            guard let self, revision == self.sessionRevision else { completion(.failure(HostFailure("CANCELLED", "Authentication context changed"))); return }
            if let failure { completion(.failure(failure)) } else if self.sessionRealmFailed { completion(.failure(HostFailure("UNAVAILABLE", "Authentication document retirement failed"))) } else { completion(.success(())) }
        }
    }
    func drain(_ event: String, deliver: ([String: Any]) -> Bool) {
        var retained: [(String, [String: Any])] = []
        for entry in buffered { if entry.0 != event || !deliver(entry.1) { retained.append(entry) } }
        buffered = retained
    }
    func link(_ path: String, initial: Bool = false) {
        if initial && initialLink == nil { initialLink = path }
        publish("links.opened", ["path": path])
    }
    private var pushEnvironment: String { Bundle.main.object(forInfoDictionaryKey: "SPAAPNsEnvironment") as? String == "production" ? "production" : "development" }
    private var pushEntitled: Bool {
        #if SPA_PUSH_ENABLED
        return configuration.notificationsEnabled
        #else
        return false
        #endif
    }
    func notificationStatus(_ completion: @escaping (Result<Any, HostFailure>) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                let authorization: String
                switch settings.authorizationStatus { case .authorized: authorization = "authorized"; case .provisional, .ephemeral: authorization = "provisional"; case .denied: authorization = "denied"; default: authorization = "notDetermined" }
                completion(.success(["authorization": authorization, "provider": "apns", "configured": self.pushEntitled]))
            }
        }
    }
    func requestNotificationPermission(owner: String, requestID: String, completion: @escaping (Result<Any, HostFailure>) -> Void) throws {
        let id = try acquire(owner: owner, requestID: requestID)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { allowed, error in
            DispatchQueue.main.async { self.release(id); if error != nil { completion(.failure(HostFailure("IO_ERROR", "Notification authorization failed"))) } else { completion(.success(["authorization": allowed ? "authorized" : "denied"])) } }
        }
    }
    func registerNotifications(owner: String, requestID: String, completion: @escaping (Result<Any, HostFailure>) -> Void) {
        guard pushEntitled else { completion(.failure(HostFailure("UNAVAILABLE", "APNs entitlement/provider configuration is unavailable"))); return }
        if let token { completion(.success(["provider": "apns", "token": token, "environment": pushEnvironment])); return }
        guard tokenWaiters.count < 64 else { completion(.failure(HostFailure("BUSY", "Notification registration is busy"))); return }
        let waiterID = UUID().uuidString
        tokenWaiters.append(TokenWaiter(id: waiterID, owner: owner, requestID: requestID, completion: completion))
        UIApplication.shared.registerForRemoteNotifications()
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            guard let index = self.tokenWaiters.firstIndex(where: { $0.id == waiterID }) else { return }
            let callback = self.tokenWaiters.remove(at: index).completion
            callback(.failure(HostFailure("TIMEOUT", "APNs registration did not complete")))
        }
    }
    func didRegister(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        let result: [String: Any] = ["provider": "apns", "token": token!, "environment": pushEnvironment]
        let waiting = tokenWaiters; tokenWaiters = []; waiting.forEach { $0.completion(.success(result)) }
        publish("notifications.token", result)
    }
    func didFailRegistration() {
        let waiting = tokenWaiters; tokenWaiters = []
        waiting.forEach { $0.completion(.failure(HostFailure("UNAVAILABLE", "APNs registration failed"))) }
    }
    func handleNotification(_ info: [AnyHashable: Any], opened: Bool, identifier: String) {
        let unique = (opened ? "opened:" : "received:") + identifier
        guard notificationIDs.insert(unique).inserted else { return }
        if notificationIDs.count > 256 { notificationIDs = [unique] }
        var data: [String: Any] = ["id": String(identifier.prefix(128)), "provider": "apns"]
        if let path = info["path"] as? String, HostConfiguration.validRoute(path, hosted: configuration.contentMode == "hosted") { data["path"] = path }
        if let alert = (info["aps"] as? [String: Any])?["alert"] {
            if let text = alert as? String { data["title"] = String(text.prefix(512)) }
            if let fields = alert as? [String: Any] {
                if let title = fields["title"] as? String { data["title"] = String(title.prefix(512)) }
                if let body = fields["body"] as? String { data["body"] = String(body.prefix(2048)) }
            }
        }
        publish(opened ? "notifications.opened" : "notifications.received", data)
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async { self.handleNotification(notification.request.content.userInfo, opened: false, identifier: notification.request.identifier); completionHandler([.banner, .sound]) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async { self.handleNotification(response.notification.request.content.userInfo, opened: true, identifier: response.notification.request.identifier); completionHandler() }
    }
    func biometricStatus() -> [String: Any] {
        let context = LAContext(); var failure: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &failure)
        return ["available": available, "enrolled": available, "kind": context.biometryType == .faceID ? "face" : context.biometryType == .touchID ? "fingerprint" : "none"]
    }
    func authenticate(owner: String, requestID: String, reason: String, completion: @escaping (Result<Any, HostFailure>) -> Void) throws {
        let context = LAContext(); var failure: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &failure) else { throw HostFailure("UNAVAILABLE", "Biometric authentication is unavailable or not enrolled") }
        let id = try acquire(owner: owner, requestID: requestID); authContext = context
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
            DispatchQueue.main.async {
                self.release(id)
                if success { completion(.success(["authenticated": true])) }
                else { completion(.failure(HostFailure((error as? LAError)?.code == .userCancel || (error as? LAError)?.code == .appCancel ? "CANCELLED" : "UNAUTHORIZED", "Biometric authentication did not succeed"))) }
            }
        }
    }
    func share(owner: String, requestID: String, items: [Any], presenter: UIViewController, completion: @escaping (Result<Any, HostFailure>) -> Void) throws {
        guard presenter.presentedViewController == nil else { throw HostFailure("BUSY", "A native presentation is open") }
        let id = try acquire(owner: owner, requestID: requestID)
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let popover = controller.popoverPresentationController { popover.sourceView = presenter.view; popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1); popover.permittedArrowDirections = [] }
        shareController = controller
        shareCancellation = { completion(.failure(HostFailure("CANCELLED", "Sharing was cancelled"))) }
        controller.completionWithItemsHandler = { activity, completed, _, error in
            DispatchQueue.main.async {
                self.release(id)
                if error != nil { completion(.failure(HostFailure("IO_ERROR", "System sharing failed"))) }
                else { completion(.success(["status": completed ? "selected" : "cancelled", "activity": activity?.rawValue as Any? ?? NSNull()])) }
            }
        }
        presenter.present(controller, animated: true)
    }
}
