import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var hasEnteredActive = false
    private var app: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = app?.shell?.rootController ?? configurationErrorController()
        self.window = window
        window.makeKeyAndVisible()

        // Scene connection options own cold UI entry; application launch options
        // no longer report custom URLs or browsing activities after scene adoption.
        for context in connectionOptions.urlContexts.sorted(by: { $0.url.absoluteString < $1.url.absoluteString }) {
            if app?.open(context.url, initial: true) == true { return }
        }
        for activity in connectionOptions.userActivities {
            if app?.continueActivity(activity, initial: true) == true { return }
        }
        if let response = connectionOptions.notificationResponse {
            let notification = response.notification
            // The same real request ID is also used by the UN delegate, allowing
            // its existing deduplication to reject a repeated open callback.
            app?.shell?.services.handleNotification(notification.request.content.userInfo, opened: true, identifier: notification.request.identifier)
        }
    }
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts.sorted(by: { $0.url.absoluteString < $1.url.absoluteString }) {
            if app?.open(context.url, initial: !hasEnteredActive) == true { return }
        }
    }
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        app?.continueActivity(userActivity, initial: !hasEnteredActive)
    }
    func sceneDidBecomeActive(_ scene: UIScene) {
        hasEnteredActive = true
        app?.shell?.services.analytics.foreground(true)
        app?.shell?.activeHost?.didActivate()
    }
    func sceneDidEnterBackground(_ scene: UIScene) { app?.shell?.services.analytics.foreground(false) }
    func sceneDidDisconnect(_ scene: UIScene) { window = nil }

    private func configurationErrorController() -> UIViewController {
        let controller = UIViewController(); controller.view.backgroundColor = .systemBackground
        let label = UILabel(); label.numberOfLines = 0
        label.text = "Host configuration is invalid. Rebuild with an approved source."
        label.translatesAutoresizingMaskIntoConstraints = false
        controller.view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            label.topAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.topAnchor, constant: 40)
        ])
        return controller
    }
}
