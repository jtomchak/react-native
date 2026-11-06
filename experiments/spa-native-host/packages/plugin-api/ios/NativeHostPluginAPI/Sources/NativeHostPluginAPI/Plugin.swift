import Foundation
import UIKit
import WebKit

public struct PluginFailure: Error {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

public struct PluginAction {
    public let name: String
    public let visible: Bool
    public let permitsStale: Bool
    public let requiresFresh: Bool
    public let coordinatesSession: Bool
    public let handoffCaller: Bool
    public let releaseHandoffOnFailure: Bool
    public init(name: String, visible: Bool = false, permitsStale: Bool = false, requiresFresh: Bool = false, coordinatesSession: Bool = false, handoffCaller: Bool = false, releaseHandoffOnFailure: Bool = false) {
        self.name = name; self.visible = visible; self.permitsStale = permitsStale; self.requiresFresh = requiresFresh
        self.coordinatesSession = coordinatesSession; self.handoffCaller = handoffCaller; self.releaseHandoffOnFailure = releaseHandoffOnFailure
    }
}

public struct PluginCallContext {
    public let surfaceID: String
    public let requestID: String
    public let presenter: UIViewController
    public let cookieStore: WKHTTPCookieStore
    public let hostedOrigin: URL?
    public let returnPath: String
    public init(surfaceID: String, requestID: String, presenter: UIViewController, cookieStore: WKHTTPCookieStore, hostedOrigin: URL?, returnPath: String) {
        self.surfaceID = surfaceID; self.requestID = requestID; self.presenter = presenter; self.cookieStore = cookieStore; self.hostedOrigin = hostedOrigin; self.returnPath = returnPath
    }
}

// All calls are made on the host's main queue. The host owns presentation and
// document retirement; a plug-in cannot replace these services or bypass them.
public protocol PluginHostServices: AnyObject {
    func acquire(owner: String, requestID: String) throws -> String
    func release(_ id: String)
    func publish(_ event: String, _ data: [String: Any])
    @discardableResult func beginSessionChange(owner: String) -> Int
    func completeSessionChange(_ revision: Int, owner: String)
    func awaitSessionRealms(_ revision: Int, completion: @escaping (Result<Void, PluginFailure>) -> Void)
}

public struct PluginEnvironment {
    public let configuration: [String: Any]
    public let services: PluginHostServices
    public let debug: Bool
    public let features: Set<String>
    public let arguments: [String]
    public init(configuration: [String: Any], services: PluginHostServices, debug: Bool, features: Set<String>, arguments: [String] = ProcessInfo.processInfo.arguments) {
        self.configuration = configuration; self.services = services; self.debug = debug; self.features = features; self.arguments = arguments
    }
}

public protocol NativePlugin: AnyObject {
    var id: String { get }
    var actions: [PluginAction] { get }
    var events: [String] { get }
    var stateEvents: [String] { get }
    func handle(action: String, arguments: [String: Any], context: PluginCallContext, completion: @escaping (Result<Any, PluginFailure>) -> Void) throws
    func cancel(surfaceID: String, requestID: String?)
}
public extension NativePlugin { var stateEvents: [String] { [] } }

public enum PluginOriginValidator {
    public static func validOrigin(_ value: String, debug: Bool = false) -> URL? {
        guard let parts = URLComponents(string: value), let scheme = parts.scheme, let host = parts.host,
              !host.isEmpty, parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              ["", "/"].contains(parts.path), parts.port.map({ $0 > 0 && $0 < 65536 }) ?? true else { return nil }
        let loopback = ["127.0.0.1", "localhost", "::1"].contains(host)
        guard scheme == "https" || (debug && scheme == "http" && loopback) else { return nil }
        var normalized = parts; normalized.path = ""
        return normalized.url
    }
}
