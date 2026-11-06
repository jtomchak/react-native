import Foundation
import NativeHostPluginAPI

public final class AuthPlugin: NativePlugin {
    public let id = "auth"
    public let actions = [
        PluginAction(name: "auth.status", permitsStale: true, coordinatesSession: true),
        PluginAction(name: "auth.signIn", visible: true, requiresFresh: true, coordinatesSession: true, handoffCaller: true, releaseHandoffOnFailure: true),
        PluginAction(name: "auth.registerPasskey", visible: true, coordinatesSession: true),
        PluginAction(name: "auth.signOut", visible: true, permitsStale: true, coordinatesSession: true),
        PluginAction(name: "auth.syncWebSession", visible: true, permitsStale: true, coordinatesSession: true, releaseHandoffOnFailure: true),
    ]
    public let events = ["auth.changed"]
    public let stateEvents = ["auth.changed"]
    private let auth: NativeAuth

    public init(environment: PluginEnvironment) throws {
        var config = try AuthConfiguration.parse(environment.configuration["auth"])
        config.passkeysFeature = environment.features.contains("passkeys")
        if environment.debug {
            func argument(_ key: String) -> String? {
                guard let index = environment.arguments.firstIndex(of: key), environment.arguments.indices.contains(index + 1) else { return nil }
                return environment.arguments[index + 1]
            }
            if let raw = argument("--spa-auth-origin") {
                guard let origin = PluginOriginValidator.validOrigin(raw, debug: true) else { throw PluginFailure("INVALID_REQUEST", "Invalid Debug auth origin") }
                config.origin = origin; config.enabled = true
            }
            if let raw = argument("--spa-auth-providers") {
                let providers = raw.split(separator: ",").map(String.init)
                guard providers.count <= 8, Set(providers).count == providers.count, providers.allSatisfy({ $0.range(of: "^[a-z][a-z0-9_-]{0,31}$", options: .regularExpression) != nil }) else { throw PluginFailure("INVALID_REQUEST", "Invalid Debug auth providers") }
                config.providers = providers
            }
            if let raw = argument("--spa-auth-rp-id") {
                guard AuthConfiguration.validRP(raw), let host = config.origin?.host, host == raw || host.hasSuffix("." + raw) else { throw PluginFailure("INVALID_REQUEST", "Invalid Debug relying party") }
                config.rpID = raw
            }
        }
        auth = NativeAuth(configuration: config, services: environment.services)
    }
    public func cancel(surfaceID: String, requestID: String?) { auth.cancel(owner: surfaceID, requestID: requestID) }
    public func handle(action: String, arguments: [String: Any], context: PluginCallContext, completion: @escaping (Result<Any, PluginFailure>) -> Void) throws {
        guard actions.contains(where: { $0.name == action }) else { throw PluginFailure("UNSUPPORTED", "Unknown auth capability") }
        if action == "auth.signIn" {
            let method = arguments["method"] as? String
            let keys = Set(arguments.keys)
            guard method == "passkey" ? keys == ["method"] : method == "oauth" && keys == ["method", "provider"] && arguments["provider"] is String else { throw PluginFailure("INVALID_REQUEST", "Invalid sign-in method") }
        } else if !arguments.isEmpty { throw PluginFailure("INVALID_REQUEST", "Authentication operation takes no arguments") }
        try auth.run(action: action, args: arguments, owner: context.surfaceID, requestID: context.requestID, presenter: context.presenter, cookieStore: context.cookieStore, hostedOrigin: context.hostedOrigin, returnPath: context.returnPath, completion: completion)
    }
}
