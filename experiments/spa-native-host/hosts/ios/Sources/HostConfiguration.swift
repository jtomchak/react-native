import Foundation
import NativeHostPluginAPI

struct HostTab: Codable {
    let id: String
    let title: String
    let path: String
    let icon: String
}

struct HostConfiguration {
    var contentMode = "packaged"
    var origin: URL?
    var initialPath = "/"
    var navigationMode = "web"
    var chromeMode = "standard"
    var largeTitles = true
    var backGestures = true
    var maxSurfaces = 8
    var maxDepth = 4
    var notificationsEnabled = false
    var analytics = AnalyticsConfiguration()
    var pluginConfigurations: [String: Any] = [:]
    var tabs = [HostTab(id: "overview", title: "Overview", path: "/", icon: "house"), HostTab(id: "compose", title: "Compose", path: "/compose/", icon: "square.and.pencil"), HostTab(id: "library", title: "Library", path: "/library/", icon: "photo")]

    static func validOrigin(_ value: String, debug: Bool = false) -> URL? {
        PluginOriginValidator.validOrigin(value, debug: debug)
    }
    static func validRoute(_ path: String, hosted: Bool) -> Bool {
        guard path.utf8.count <= 2048, path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("#"), !path.contains("\\"),
              !path.unicodeScalars.contains(where: { $0.value < 32 }), let parts = URLComponents(string: "spa://app" + path),
              parts.scheme == "spa", parts.host == "app", parts.user == nil, parts.password == nil, parts.port == nil else { return false }
        guard !parts.percentEncodedPath.lowercased().contains("%2f"), !parts.percentEncodedPath.lowercased().contains("%5c"), !parts.path.contains("%"), !parts.path.contains("//"), !parts.path.contains("\\"), !parts.path.unicodeScalars.contains(where: { $0.value < 32 }),
              !parts.path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) else { return false }
        return ["/", "/compose/", "/library/"].contains(parts.path) || (hosted && parts.path.hasPrefix("/hosted/"))
    }
    static func load(assetRoot: URL, arguments: [String] = ProcessInfo.processInfo.arguments) throws -> HostConfiguration {
        var result = HostConfiguration()
        let file = assetRoot.appendingPathComponent("host-config.json")
        if FileManager.default.fileExists(atPath: file.path) {
            let data = try Data(contentsOf: file)
            guard data.count <= 16384, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object["schemaVersion"] as? Int == 1,
                  let content = object["content"] as? [String: Any], let navigation = object["navigation"] as? [String: Any], let chrome = object["chrome"] as? [String: Any],
                  let mode = content["mode"] as? String, ["packaged", "hosted"].contains(mode),
                  let nav = navigation["mode"] as? String, ["web", "native"].contains(nav),
                  let layout = chrome["mode"] as? String, ["standard", "tabs", "adaptive"].contains(layout) else { throw HostFailure("INVALID_REQUEST", "Invalid bundled host configuration") }
            result.contentMode = mode; result.navigationMode = nav; result.chromeMode = layout
            if let raw = content["origin"] as? String {
                guard let origin = validOrigin(raw) else { throw HostFailure("INVALID_REQUEST", "Hosted origin must be HTTPS") }
                result.origin = origin
            }
            result.initialPath = content["initialPath"] as? String ?? "/"
            result.largeTitles = chrome["largeTitles"] as? Bool ?? true
            result.backGestures = chrome["backGestures"] as? Bool ?? true
            let surfaces = navigation["maxLiveSurfaces"] as? Int ?? 8, depth = navigation["maxDepthPerTab"] as? Int ?? 4
            guard (1...8).contains(surfaces), (1...4).contains(depth) else { throw HostFailure("INVALID_REQUEST", "Invalid native surface limits") }
            result.maxSurfaces = surfaces; result.maxDepth = depth
            if let entries = chrome["tabs"] {
                let encoded = try JSONSerialization.data(withJSONObject: entries)
                let tabs = try JSONDecoder().decode([HostTab].self, from: encoded)
                guard (1...5).contains(tabs.count), Set(tabs.map(\.id)).count == tabs.count,
                      tabs.allSatisfy({ !$0.id.isEmpty && $0.id.utf8.count <= 64 && !$0.title.isEmpty && $0.title.utf8.count <= 64 && ["house", "square.and.pencil", "photo", "list.bullet", "gearshape"].contains($0.icon) && validRoute($0.path, hosted: mode == "hosted") }) else { throw HostFailure("INVALID_REQUEST", "Invalid native destinations") }
                result.tabs = tabs
            }
            result.notificationsEnabled = (object["notifications"] as? [String: Any])?["enabled"] as? Bool ?? false
            if let analytics = object["analytics"] { guard let settings = analytics as? [String: Any] else { throw AnalyticsSchema.invalid() }; result.analytics = try AnalyticsConfiguration.parse(settings) }
            if let plugins = object["plugins"] { guard let plugins = plugins as? [String: Any] else { throw HostFailure("INVALID_REQUEST", "Invalid plug-in configuration") }; result.pluginConfigurations = plugins }
        }
        #if DEBUG
        func argument(_ key: String) -> String? { guard let i = arguments.firstIndex(of: key), arguments.indices.contains(i + 1) else { return nil }; return arguments[i + 1] }
        if let raw = argument("--spa-analytics-origin") { guard let origin = validOrigin(raw, debug: true) else { throw AnalyticsSchema.invalid() }; result.analytics.origin = origin }
        if let mode = argument("--spa-content") { guard ["packaged", "hosted"].contains(mode) else { throw HostFailure("INVALID_REQUEST", "Invalid content mode") }; result.contentMode = mode }
        if let raw = argument("--spa-hosted-url") ?? argument("--spa-dev-url") {
            guard let origin = validOrigin(raw, debug: true) else { throw HostFailure("INVALID_REQUEST", "Invalid Debug hosted origin") }
            result.origin = origin; result.contentMode = "hosted"
        }
        if let nav = argument("--spa-navigation") { guard ["web", "native"].contains(nav) else { throw HostFailure("INVALID_REQUEST", "Invalid navigation mode") }; result.navigationMode = nav }
        if let chrome = argument("--spa-chrome") { guard ["standard", "tabs", "adaptive"].contains(chrome) else { throw HostFailure("INVALID_REQUEST", "Invalid chrome mode") }; result.chromeMode = chrome }
        #endif
        guard result.contentMode != "hosted" || result.origin != nil, validRoute(result.initialPath, hosted: result.contentMode == "hosted") else { throw HostFailure("INVALID_REQUEST", "Hosted source is not configured") }
        return result
    }
}
