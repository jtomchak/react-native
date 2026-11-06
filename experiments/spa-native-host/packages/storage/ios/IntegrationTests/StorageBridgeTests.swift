import XCTest
import UIKit
import WebKit
@testable import SPAHost
@testable import NativeHostStorage

@MainActor
extension SPAHostTests {
    func fixtureRootForRestart() throws -> URL { temporary.appendingPathComponent("fixture") }
    func testRealSDKStorageAndNativePresentation() async throws {
        start(root: try fixtureRoot())
        try await waitFor("window.platform && document.readyState === 'complete'")
        let platform = try await asyncJS("return (await platform.ready()).platform") as? String
        XCTAssertEqual(platform, "ios")
        _ = try await asyncJS("await platform.storage.set('native-test', 'persisted'); return true")
        let value = try await asyncJS("return await platform.storage.get('native-test')") as? String
        XCTAssertEqual(value, "persisted")
        _ = try await asyncJS("await platform.storage.remove('native-test'); return true")
        let removed = try await asyncJS("return (await platform.storage.get('native-test')) === null") as? Bool
        XCTAssertEqual(removed, true)
        _ = try await asyncJS("await platform.navigation.present({screen:'native-demo'}); return true")
        XCTAssertNotNil(host.presentedViewController as? UINavigationController)
        _ = try await asyncJS("await platform.navigation.dismiss(); return true")
        XCTAssertNil(host.presentedViewController)
        let missingCamera = try await asyncJS("try { await platform.camera.capture(); return 'unexpected'; } catch (e) { return e.code; }") as? String
        #if targetEnvironment(simulator)
        XCTAssertEqual(missingCamera, "UNAVAILABLE")
        #endif
        _ = try await asyncJS("await platform.storage.set('survives', 'restart'); return true")
        let oldWindow = window
        start(root: try fixtureRootForRestart())
        oldWindow?.isHidden = true
        try await waitFor("window.platform && document.readyState === 'complete'")
        let restored = try await asyncJS("return await platform.storage.get('survives')") as? String
        XCTAssertEqual(restored, "restart")
    }
    func testSQLitePreservesEmbeddedNULAndUTF8WithoutKeyCollision() async throws {
        let storage = Storage(root: temporary.appendingPathComponent("nul-storage"))
        func operation(_ action: String, _ key: String, _ value: String? = nil) async throws -> Any {
            try await withCheckedThrowingContinuation { continuation in
                storage.perform(action: action, key: key, value: value) { result in
                    switch result {
                    case .success(let value): continuation.resume(returning: value)
                    case .failure(let error): continuation.resume(throwing: error)
                    }
                }
            }
        }
        let key = "prefix\u{0}🔑"
        let value = "before\u{0}📷after"
        _ = try await operation("storage.set", "prefix", "plain prefix")
        _ = try await operation("storage.set", key, value)
        let full = try await operation("storage.get", key) as? String
        let prefix = try await operation("storage.get", "prefix") as? String
        XCTAssertEqual(full, value)
        XCTAssertEqual(prefix, "plain prefix")
        _ = try await operation("storage.remove", key)
        let missing = try await operation("storage.get", key)
        let untouched = try await operation("storage.get", "prefix") as? String
        XCTAssertTrue(missing is NSNull)
        XCTAssertEqual(untouched, "plain prefix")
        // Exercise JSON -> native argument validation -> SQLite -> JSON too.
        start(root: try fixtureRoot())
        try await waitFor("window.platform && document.readyState === 'complete'")
        let roundtrip = try await asyncJS("const key='json'+String.fromCharCode(0)+'🔑'; const value='before'+String.fromCharCode(0)+'📷after'; await platform.storage.set('json','plain'); await platform.storage.set(key,value); return (await platform.storage.get(key)) === value && (await platform.storage.get('json')) === 'plain';") as? Bool
        XCTAssertEqual(roundtrip, true)
    }
    func testStorageQuotaRollsBackRejectedWrite() async throws {
        start(root: try fixtureRoot())
        try await waitFor("document.readyState === 'complete' && window.platform")
        let outcome = try await asyncJS("const value='x'.repeat(32768); for(let i=0;i<31;i++) await platform.storage.set('quota-'+i,value); try { await platform.storage.set('quota-over',value); return 'accepted'; } catch(e) { return e.code; }") as? String
        XCTAssertEqual(outcome, "QUOTA_EXCEEDED")
        let rolledBack = try await asyncJS("return (await platform.storage.get('quota-over')) === null") as? Bool
        XCTAssertEqual(rolledBack, true)
    }
}
