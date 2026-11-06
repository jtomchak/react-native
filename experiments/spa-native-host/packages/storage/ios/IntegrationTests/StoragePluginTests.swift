import XCTest
import UIKit
import WebKit
import SQLite3
import NativeHostPluginAPI
@testable import SPAHost
@testable import NativeHostStorage

@MainActor
final class StoragePluginTests: XCTestCase {
    var root: URL!
    var services: ApplicationServices!
    var plugin: StoragePlugin!
    var dataStore: WKWebsiteDataStore!
    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("storage-plugin-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        services = ApplicationServices(root: root, configuration: HostConfiguration())
        dataStore = WKWebsiteDataStore.nonPersistent()
        plugin = try makePlugin()
    }
    override func tearDown() async throws {
        plugin = nil; services = nil; dataStore = nil
        if let root { try? FileManager.default.removeItem(at: root) }
    }
    func makePlugin() throws -> StoragePlugin {
        try StoragePlugin(environment: PluginEnvironment(configuration: ["storage": [:]], services: services, dataRoot: root, debug: true, features: []))
    }
    func context() -> PluginCallContext {
        PluginCallContext(surfaceID: "storage-test", requestID: UUID().uuidString, presenter: UIViewController(), cookieStore: dataStore.httpCookieStore, hostedOrigin: nil, returnPath: "/")
    }
    func call(_ action: String, _ args: [String: Any]) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            do { try plugin.handle(action: action, arguments: args, context: context()) { continuation.resume(with: $0) } }
            catch { continuation.resume(throwing: error) }
        }
    }
    func testLegacyDatabaseIsReadInPlaceAndSurvivesPluginRecreation() async throws {
        let file = root.appendingPathComponent("storage.sqlite")
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(file.path, &db), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(db, "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv(key,value) VALUES('legacy','before-plugin');", nil, nil, nil), SQLITE_OK)
        XCTAssertEqual(sqlite3_close(db), SQLITE_OK)
        let legacy = try await call("storage.get", ["key": "legacy"])
        XCTAssertEqual(legacy as? String, "before-plugin")
        _ = try await call("storage.set", ["key": "legacy", "value": "after-plugin"])
        plugin = nil; plugin = try makePlugin()
        let reopened = try await call("storage.get", ["key": "legacy"])
        XCTAssertEqual(reopened as? String, "after-plugin")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("plugins").path))
    }
    func testNativeArgumentValidationCannotMutateExistingValue() async throws {
        _ = try await call("storage.set", ["key": "guarded", "value": "original"])
        let invalid: [(String, [String: Any])] = [
            ("storage.get", [:]), ("storage.get", ["key": ""]),
            ("storage.get", ["key": String(repeating: "a", count: 129)]),
            ("storage.get", ["key": String(repeating: "😀", count: 33)]),
            ("storage.set", ["key": "guarded", "value": 17]),
            ("storage.set", ["key": "guarded", "value": "bad", "extra": true]),
            ("storage.set", ["key": "guarded", "value": String(repeating: "a", count: 32769)]),
            ("storage.remove", ["key": "guarded", "extra": true]),
        ]
        for (action, args) in invalid {
            do { _ = try await call(action, args); XCTFail("Malformed storage arguments were accepted") }
            catch { XCTAssertEqual((error as? PluginFailure)?.code, "INVALID_REQUEST") }
        }
        let preserved = try await call("storage.get", ["key": "guarded"])
        XCTAssertEqual(preserved as? String, "original")
        _ = try await call("storage.set", ["key": String(repeating: "😀", count: 32), "value": ""])
        let empty = try await call("storage.get", ["key": String(repeating: "😀", count: 32)])
        XCTAssertEqual(empty as? String, "")
        do { _ = try await call("storage.clear", [:]); XCTFail("Unknown action accepted") }
        catch { XCTAssertEqual((error as? PluginFailure)?.code, "UNSUPPORTED") }
    }
    func testCancellationDoesNotReleaseAcceptedDiskWorkCapacity() async throws {
        let gate = DispatchSemaphore(value: 0), completed = expectation(description: "accepted storage work completes")
        completed.expectedFulfillmentCount = 64
        await withCheckedContinuation { continuation in plugin.backendForTesting.holdWriterForTesting(entered: { continuation.resume() }, until: gate) }
        defer { gate.signal() }
        for index in 0..<64 {
            try plugin.handle(action: "storage.get", arguments: ["key": "queued-\(index)"], context: context()) { result in
                if case .failure(let error) = result { XCTFail("Accepted work failed: " + error.code) }
                completed.fulfill()
            }
            plugin.cancel(surfaceID: "storage-test", requestID: nil)
        }
        do { _ = try await call("storage.get", ["key": "overflow"]); XCTFail("Cancelled requests released disk admission slots") }
        catch { XCTAssertEqual((error as? PluginFailure)?.code, "BUSY") }
        gate.signal()
        await fulfillment(of: [completed], timeout: 5)
        let fresh = try await call("storage.get", ["key": "after-drain"])
        XCTAssertTrue(fresh is NSNull)
    }
}
