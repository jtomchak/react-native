import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    private(set) var shell: NativeShell?
    static func deepLinkPath(_ url: URL, hosted: Bool = false) -> String? {
        guard url.scheme == "spahost", url.host == "app", url.user == nil, url.password == nil, url.port == nil, url.fragment == nil, let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let path = (components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath) + (components.percentEncodedQuery.map { "?" + $0 } ?? "")
        return HostConfiguration.validRoute(path, hosted: hosted) ? path : nil
    }
    static func universalLinkPath(_ url: URL, configuration: HostConfiguration) -> String? {
        guard let approved = configuration.origin, approved.scheme == "https", url.scheme == "https", url.host == approved.host,
              (url.port ?? 443) == (approved.port ?? 443), url.user == nil, url.password == nil, url.fragment == nil,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let path = (parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath) + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
        return HostConfiguration.validRoute(path, hosted: configuration.contentMode == "hosted") ? path : nil
    }
    @discardableResult
    func open(_ url: URL, initial: Bool = false) -> Bool {
        guard let shell, let path = Self.deepLinkPath(url, hosted: shell.configuration.contentMode == "hosted") else { return false }
        shell.services.link(path, initial: initial); shell.open(path: path); return true
    }
    @discardableResult
    func continueActivity(_ activity: NSUserActivity, initial: Bool = false) -> Bool {
        guard activity.activityType == NSUserActivityTypeBrowsingWeb, let url = activity.webpageURL, let shell,
              let path = Self.universalLinkPath(url, configuration: shell.configuration) else { return false }
        shell.services.link(path, initial: initial); shell.open(path: path); return true
    }
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let assets = Bundle.main.bundleURL.appendingPathComponent("web")
        let data = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("SPAHost", isDirectory: true)
        do {
            let configuration = try HostConfiguration.load(assetRoot: assets)
            let shell = NativeShell(configuration: configuration, assetRoot: assets, dataRoot: data)
            self.shell = shell
            shell.services.analytics.record(category: "lifecycle", name: "app.started", properties: ["state": "started"])
            UNUserNotificationCenter.current().delegate = shell.services
        } catch {
            // SceneDelegate presents the configuration error in its own window.
            shell = nil
        }
        return true
    }
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        shell?.services.handleNotification(userInfo, opened: false, identifier: userInfo["messageId"] as? String ?? UUID().uuidString)
        completionHandler(.noData)
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { shell?.services.didRegister(deviceToken) }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { shell?.services.didFailRegistration() }
}
