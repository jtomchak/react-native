import Foundation
import NativeHostPluginAPI

public final class StoragePlugin: NativePlugin {
    public let id = "storage"
    public let actions = [PluginAction(name: "storage.get"), PluginAction(name: "storage.set"), PluginAction(name: "storage.remove")]
    public let events: [String] = []
    private let storage: Storage
    public init(environment: PluginEnvironment) throws {
        if let raw = environment.configuration[id] { guard let raw = raw as? [String: Any], raw.isEmpty else { throw PluginFailure("INVALID_REQUEST", "Storage has no page-configurable paths or limits") } }
        // Keep the existing host-owned path. Moving under a plug-in directory
        // would silently abandon data written by the original native service.
        storage = Storage(root: environment.dataRoot)
    }
    public func handle(action: String, arguments: [String: Any], context: PluginCallContext, completion: @escaping (Result<Any, PluginFailure>) -> Void) throws {
        guard actions.contains(where: { $0.name == action }) else { throw PluginFailure("UNSUPPORTED", "Unknown storage action") }
        let keys = Set(arguments.keys), expected: Set<String> = action == "storage.set" ? ["key", "value"] : ["key"]
        guard keys == expected, let key = arguments["key"] as? String, !key.isEmpty, key.utf8.count <= 128 else { throw PluginFailure("INVALID_REQUEST", "Storage requires a nonempty key of at most 128 UTF-8 bytes") }
        var value: String?
        if action == "storage.set" {
            guard let supplied = arguments["value"] as? String, supplied.utf8.count <= 32768 else { throw PluginFailure("INVALID_REQUEST", "Storage value must be a string of at most 32768 UTF-8 bytes") }
            value = supplied
        }
        storage.perform(action: action, key: key, value: value, completion: completion)
    }
    public func cancel(surfaceID: String, requestID: String?) {
        // Accepted disk work keeps its queue slot until it really completes.
        // The host's document/request guard suppresses retired JS delivery;
        // completion still records the actual committed analytics outcome.
    }
    #if DEBUG
    var backendForTesting: Storage { storage }
    #endif
}
