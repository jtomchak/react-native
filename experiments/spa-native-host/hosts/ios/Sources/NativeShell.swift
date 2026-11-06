import UIKit

protocol HostShellCoordinator: AnyObject {
    func isActive(_ host: HostViewController) -> Bool
    func metadata(_ host: HostViewController) -> [String: Any]
    func visit(_ path: String, presentation: String, from host: HostViewController, completion: @escaping (Result<Any, HostFailure>) -> Void) throws
    func pop(_ host: HostViewController) -> Bool
    func chromeState(_ host: HostViewController) -> [String: Any]
    func selectTab(_ id: String, from host: HostViewController) throws
    func updateChrome(_ options: [String: Any], from host: HostViewController) throws
    func routeChanged(_ host: HostViewController)
    func usePackaged(from host: HostViewController)
}

final class ShellNavigationController: UINavigationController {
    override var childForStatusBarStyle: UIViewController? { topViewController }
    override var childForStatusBarHidden: UIViewController? { topViewController }
}
private final class ShellTabBarController: UITabBarController {
    override var childForStatusBarStyle: UIViewController? { selectedViewController }
    override var childForStatusBarHidden: UIViewController? { selectedViewController }
}
private final class ShellSplitViewController: UISplitViewController {
    override var childForStatusBarStyle: UIViewController? { viewController(for: .secondary) }
    override var childForStatusBarHidden: UIViewController? { viewController(for: .secondary) }
}

private final class DestinationList: UITableViewController {
    let tabs: [HostTab]
    var selected: String
    var choose: ((String) -> Void)?
    init(tabs: [HostTab], selected: String) { self.tabs = tabs; self.selected = selected; super.init(style: .insetGrouped); title = "Destinations" }
    required init?(coder: NSCoder) { fatalError("Use init") }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { tabs.count }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let tab = tabs[indexPath.row]; let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        cell.textLabel?.text = tab.title; cell.imageView?.image = UIImage(systemName: tab.icon)
        cell.accessoryType = tab.id == selected ? .checkmark : .none
        cell.isAccessibilityElement = true; cell.accessibilityLabel = tab.title
        cell.accessibilityTraits = tab.id == selected ? [.button, .selected] : [.button]
        cell.accessibilityIdentifier = "native-sidebar-" + tab.id
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) { choose?(tabs[indexPath.row].id) }
}

final class NativeShell: NSObject, HostShellCoordinator, UITabBarControllerDelegate, UINavigationControllerDelegate, UIGestureRecognizerDelegate, UIAdaptivePresentationControllerDelegate {
    private(set) var configuration: HostConfiguration
    let services: ApplicationServices
    let assetRoot: URL
    private(set) var rootController: UIViewController!
    private(set) var activeTab: String
    private var navigators: [String: UINavigationController] = [:]
    private var tabController: UITabBarController?
    private var splitController: UISplitViewController?
    private var sidebar: DestinationList?
    private var modalNavigator: UINavigationController?
    private var ready = false
    private let sessionObserverID = "shell-" + UUID().uuidString
    init(configuration: HostConfiguration, assetRoot: URL, dataRoot: URL) {
        self.configuration = configuration; self.assetRoot = assetRoot
        self.services = ApplicationServices(root: dataRoot, configuration: configuration)
        activeTab = configuration.tabs.first(where: { $0.path.components(separatedBy: "?").first == configuration.initialPath.components(separatedBy: "?").first })?.id ?? configuration.tabs.first!.id
        super.init()
        services.registerSessionSurface(sessionObserverID) { [weak self] _, ready, _ in
            guard let self, !ready else { return }
            for navigator in Array(self.navigators.values) + (self.modalNavigator.map { [$0] } ?? []) { navigator.tabBarItem.badgeValue = nil }
        }
        services.eventSink = { [weak self] name, data in
            guard let self else { return false }
            if name == "notifications.opened", let path = data["path"] as? String { self.open(path: path) }
            return self.activeHost?.deliverEvent(name, data) ?? false
        }
        build()
    }
    deinit { services.unregisterSessionSurface(sessionObserverID) }
    private var activeNavigator: UINavigationController? { modalNavigator ?? navigators[activeTab] }
    var activeHost: HostViewController? { activeNavigator?.topViewController as? HostViewController }
    private var allHosts: [HostViewController] {
        (Array(navigators.values) + (modalNavigator.map { [$0] } ?? [])).flatMap { $0.viewControllers.compactMap { $0 as? HostViewController } }
    }
    private func makeHost(path: String, tab: String) -> HostViewController {
        let host = HostViewController(assetRoot: assetRoot, dataRoot: services.root, configuration: configuration, services: services, initialPath: path)
        host.shell = self; host.tabID = tab; return host
    }
    private func makeNavigator(_ tab: HostTab) -> UINavigationController {
        let nav = ShellNavigationController(rootViewController: makeHost(path: !ready && tab.id == activeTab ? configuration.initialPath : tab.path, tab: tab.id))
        nav.delegate = self; nav.navigationBar.prefersLargeTitles = configuration.largeTitles
        nav.interactivePopGestureRecognizer?.delegate = self
        nav.tabBarItem = UITabBarItem(title: tab.title, image: UIImage(systemName: tab.icon), selectedImage: nil)
        nav.tabBarItem.accessibilityIdentifier = "native-tab-" + tab.id
        return nav
    }
    private func navigator(_ id: String) -> UINavigationController? {
        if let nav = navigators[id] { return nav }
        guard let tab = configuration.tabs.first(where: { $0.id == id }), allHosts.count < configuration.maxSurfaces else { return nil }
        let nav = makeNavigator(tab); navigators[id] = nav; return nav
    }
    private func build() {
        let first = navigator(activeTab)!
        if configuration.chromeMode == "standard" { rootController = first }
        else if configuration.chromeMode == "adaptive" && UIDevice.current.userInterfaceIdiom == .pad {
            let list = DestinationList(tabs: configuration.tabs, selected: activeTab)
            list.choose = { [weak self] id in try? self?.chooseTab(id) }
            let split = ShellSplitViewController(style: .doubleColumn)
            split.preferredDisplayMode = .oneBesideSecondary; split.preferredSplitBehavior = .tile
            split.minimumPrimaryColumnWidth = 240; split.maximumPrimaryColumnWidth = 360
            split.setViewController(ShellNavigationController(rootViewController: list), for: .primary)
            split.setViewController(first, for: .secondary)
            sidebar = list; splitController = split; rootController = split
        } else {
            let tabs = ShellTabBarController(); tabs.delegate = self
            // Roots are bounded by the configured <=5 tabs. Each controller loads
            // its WebView lazily, preserving independent documents without a pool.
            tabs.viewControllers = configuration.tabs.compactMap { navigator($0.id) }
            tabs.selectedIndex = configuration.tabs.firstIndex(where: { $0.id == activeTab }) ?? 0
            tabController = tabs; rootController = tabs
        }
        ready = true
    }
    func usePackaged(from host: HostViewController) {
        guard isActive(host), let window = host.viewIfLoaded?.window else { return }
        allHosts.forEach { $0.invalidateSurface() }
        modalNavigator?.dismiss(animated: false); modalNavigator = nil
        navigators = [:]; tabController = nil; splitController = nil; sidebar = nil
        configuration.contentMode = "packaged"; configuration.origin = nil; configuration.initialPath = "/"
        activeTab = configuration.tabs.first!.id; ready = false
        build(); window.rootViewController = rootController
    }
    func isActive(_ host: HostViewController) -> Bool { activeHost === host && host.viewIfLoaded?.window?.isHidden == false && UIApplication.shared.applicationState == .active }
    func metadata(_ host: HostViewController) -> [String: Any] {
        ["apiVersion": 2, "contentMode": host.contentMode, "navigationMode": configuration.navigationMode, "chromeMode": configuration.chromeMode, "surfaceId": host.surfaceID, "activeTab": activeTab]
    }
    func chromeState(_ host: HostViewController) -> [String: Any] {
        ["mode": configuration.chromeMode, "activeTab": activeTab, "surfaceId": host.surfaceID, "depth": host.navigationController?.viewControllers.count ?? 1,
         "tabs": configuration.tabs.map { ["id": $0.id, "title": $0.title] }, "largeTitle": host.navigationItem.largeTitleDisplayMode != .never,
         "tabBarHidden": tabController?.tabBar.isHidden ?? false, "toolbarHidden": host.navigationController?.isNavigationBarHidden ?? false]
    }
    func visit(_ path: String, presentation: String, from host: HostViewController, completion: @escaping (Result<Any, HostFailure>) -> Void) throws {
        guard configuration.navigationMode == "native" else { throw HostFailure("UNSUPPORTED", "Native visits are not enabled") }
        guard isActive(host), let nav = activeNavigator, nav.transitionCoordinator == nil else { throw HostFailure("BUSY", "Native navigation is not active or is transitioning") }
        guard HostConfiguration.validRoute(path, hosted: host.contentMode == "hosted"), ["push", "replace", "modal"].contains(presentation) else { throw HostFailure("INVALID_REQUEST", "Invalid native visit") }
        guard allHosts.count < configuration.maxSurfaces, presentation != "push" || nav.viewControllers.count < configuration.maxDepth else { throw HostFailure("QUOTA_EXCEEDED", "Native surface limit reached") }
        let target = makeHost(path: path, tab: activeTab)
        if presentation == "modal" {
            guard modalNavigator == nil, host.presentedViewController == nil else { throw HostFailure("BUSY", "A native presentation is open") }
            let modal = ShellNavigationController(rootViewController: target); modal.delegate = self
            modal.navigationBar.prefersLargeTitles = configuration.largeTitles
            modal.interactivePopGestureRecognizer?.delegate = self
            modalNavigator = modal
            target.navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Done", style: .done, target: self, action: #selector(dismissRouteModal))
            host.present(modal, animated: true) { completion(.success(["surfaceId": target.surfaceID, "path": path])) }
            modal.presentationController?.delegate = self
        } else {
            if presentation == "replace" { var controllers = nav.viewControllers; controllers[controllers.count - 1] = target; nav.setViewControllers(controllers, animated: true) }
            else { nav.pushViewController(target, animated: true) }
            if let coordinator = nav.transitionCoordinator {
                coordinator.animate(alongsideTransition: nil) { _ in completion(.success(["surfaceId": target.surfaceID, "path": path])) }
            } else { completion(.success(["surfaceId": target.surfaceID, "path": path])) }
        }
    }
    func pop(_ host: HostViewController) -> Bool {
        guard isActive(host), let nav = activeNavigator, nav.transitionCoordinator == nil else { return false }
        if nav.viewControllers.count > 1 { (nav.viewControllers[nav.viewControllers.count - 2] as? HostViewController)?.prepareSessionVisibility(); nav.popViewController(animated: true); return true }
        if modalNavigator != nil { dismissRouteModal(); return true }
        return false
    }
    @objc private func dismissRouteModal() {
        (navigators[activeTab]?.topViewController as? HostViewController)?.prepareSessionVisibility()
        modalNavigator?.dismiss(animated: true) { [weak self] in self?.modalNavigator = nil; self?.routeChanged(self?.activeHost) }
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { modalNavigator = nil; routeChanged(activeHost) }
    func selectTab(_ id: String, from host: HostViewController) throws {
        guard isActive(host), configuration.chromeMode != "standard" else { throw HostFailure("UNSUPPORTED", "Native tabs are not enabled") }
        try chooseTab(id)
    }
    private func chooseTab(_ id: String) throws {
        guard modalNavigator == nil, let nav = navigator(id) else { throw HostFailure("INVALID_REQUEST", "Unknown or unavailable tab") }
        (nav.topViewController as? HostViewController)?.prepareSessionVisibility()
        let changed = activeTab != id
        activeTab = id
        if changed { services.analytics.record(category: "navigation", name: "navigation.tab", properties: ["tab": id, "state": "selected"]) }
        if let tabs = tabController, let index = tabs.viewControllers?.firstIndex(where: { $0 === nav }) { tabs.selectedIndex = index }
        splitController?.setViewController(nav, for: .secondary)
        if let splitController, splitController.isCollapsed { splitController.show(.secondary) }
        sidebar?.selected = id; sidebar?.tableView.reloadData()
        activate(activeHost); activeHost?.deliverEvent("chrome.tabSelected", ["id": id])
    }
    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        guard let id = navigators.first(where: { $0.value === viewController })?.key else { return }
        let changed = activeTab != id; activeTab = id
        if changed { services.analytics.record(category: "navigation", name: "navigation.tab", properties: ["tab": id, "state": "selected"]) }
        activate(activeHost); activeHost?.deliverEvent("chrome.tabSelected", ["id": id])
    }
    func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
        guard modalNavigator == nil else { return false }
        ((viewController as? UINavigationController)?.topViewController as? HostViewController)?.prepareSessionVisibility()
        return true
    }
    func updateChrome(_ options: [String: Any], from host: HostViewController) throws {
        guard isActive(host) else { throw HostFailure("UNAUTHORIZED", "Only visible content owns native chrome") }
        let allowed = Set(["title", "largeTitle", "tabBarHidden", "toolbarHidden", "statusBarStyle", "badge"])
        guard Set(options.keys).isSubset(of: allowed) else { throw HostFailure("INVALID_REQUEST", "Unknown chrome option") }
        if let value = options["title"] { guard let text = value as? String, text.utf8.count <= 128, !text.contains("\0") else { throw HostFailure("INVALID_REQUEST", "Invalid title") } }
        for key in ["largeTitle", "tabBarHidden", "toolbarHidden"] {
            if let value = options[key] { guard let bool = value as? NSNumber, CFGetTypeID(bool) == CFBooleanGetTypeID() else { throw HostFailure("INVALID_REQUEST", "Invalid chrome boolean") } }
        }
        if let value = options["statusBarStyle"] { guard let style = value as? String, ["default", "light", "dark"].contains(style) else { throw HostFailure("INVALID_REQUEST", "Invalid status bar style") } }
        var badgeUpdate: (String, String?)?
        if let value = options["badge"] {
            guard let badge = value as? [String: Any], Set(badge.keys) == ["id", "value"], let id = badge["id"] as? String, configuration.tabs.contains(where: { $0.id == id }) else { throw HostFailure("INVALID_REQUEST", "Invalid tab badge") }
            if badge["value"] is NSNull { badgeUpdate = (id, nil) }
            else { guard let label = badge["value"] as? String, label.utf8.count <= 12, !label.contains("\0") else { throw HostFailure("INVALID_REQUEST", "Invalid badge value") }; badgeUpdate = (id, label) }
        }
        // Apply only after the whole request validates; invalid trailing fields
        // cannot partially mutate visible native controls or allocate surfaces.
        if let title = options["title"] as? String { host.setDisplayTitle(title) }
        if let value = options["largeTitle"] as? Bool { host.navigationItem.largeTitleDisplayMode = value ? .always : .never }
        if let value = options["tabBarHidden"] as? Bool { host.chromeTabBarHidden = value }
        if let value = options["toolbarHidden"] as? Bool { host.chromeToolbarHidden = value }
        if let style = options["statusBarStyle"] as? String { host.statusStyle = style; host.setNeedsStatusBarAppearanceUpdate(); rootController.setNeedsStatusBarAppearanceUpdate() }
        if let badgeUpdate { navigator(badgeUpdate.0)?.tabBarItem.badgeValue = badgeUpdate.1 }
        applyChrome(host)
    }
    func routeChanged(_ host: HostViewController) { routeChanged(Optional(host)) }
    private func routeChanged(_ host: HostViewController?) {
        guard ready, let host else { return }
        host.updateBackChrome()
        host.deliverEvent("navigation.changed", ["reason": "route", "path": host.currentPath, "depth": host.navigationController?.viewControllers.count ?? 1, "surfaceId": host.surfaceID])
    }
    func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) { activate(viewController as? HostViewController) }
    private func activate(_ host: HostViewController?) { guard ready, let host else { return }; host.prepareSessionVisibility(); applyChrome(host); host.didActivate() }
    private func applyChrome(_ host: HostViewController) {
        guard activeNavigator?.topViewController === host else { return }
        tabController?.tabBar.isHidden = host.chromeTabBarHidden
        host.navigationController?.setNavigationBarHidden(host.chromeToolbarHidden, animated: false)
    }
    func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
        if let host = viewController as? HostViewController { host.prepareSessionVisibility(); if activeNavigator === navigationController { applyChrome(host) } }
    }
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard configuration.backGestures, let nav = activeNavigator, nav.viewControllers.count > 1, let host = nav.topViewController as? HostViewController else { return false }
        (nav.viewControllers[nav.viewControllers.count - 2] as? HostViewController)?.prepareSessionVisibility()
        return !host.hasWebHistory && host.presentedViewController == nil
    }
    func open(path: String) {
        guard HostConfiguration.validRoute(path, hosted: configuration.contentMode == "hosted") else { return }
        if let modalNavigator { modalNavigator.dismiss(animated: false); self.modalNavigator = nil }
        if configuration.chromeMode != "standard", let tab = configuration.tabs.first(where: { $0.path.components(separatedBy: "?").first == path.components(separatedBy: "?").first }) { try? chooseTab(tab.id) }
        activeNavigator?.popToRootViewController(animated: false)
        activeHost?.load(path: path)
    }
}
