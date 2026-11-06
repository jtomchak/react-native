import XCTest
@testable import SPAHost
@testable import NativeHostStorage

@MainActor
extension AnalyticsBridgeTests {
    func testCommittedStorageOutcomeSurvivesRetiredDocumentAndDuplicateCompletion() async throws {
        let analytics = host.analyticsForTesting
        let plugin = try XCTUnwrap(host.pluginForTesting("storage") as? StoragePlugin)
        let storage = plugin.backendForTesting
        let gate = DispatchSemaphore(value: 0)
        await withCheckedContinuation { continuation in storage.holdWriterForTesting(entered: { continuation.resume() }, until: gate) }
        _ = try await js("platform.storage.set('private-key','private-value').catch(()=>{});return true")
        for _ in 0..<100 { if host.pendingForTesting("storage.set") != nil { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        let request = try XCTUnwrap(host.pendingForTesting("storage.set"))
        host.invalidateSurface()
        gate.signal()
        let stored: Any = try await withCheckedThrowingContinuation { continuation in storage.perform(action: "storage.get", key: "private-key", value: nil) { continuation.resume(with: $0) } }
        XCTAssertEqual(stored as? String, "private-value")
        request.recordOutcome(.success(NSNull()))
        try await Task.sleep(nanoseconds: 100_000_000)
        let captured = await withCheckedContinuation { continuation in analytics.inspectForTesting { continuation.resume(returning: $0) } }
        let completions = captured.filter { ($0["properties"] as? [String: Any])?["action"] as? String == "storage.set" }
        XCTAssertEqual(completions.count, 1)
        XCTAssertEqual((completions.first?["properties"] as? [String: Any])?["outcome"] as? String, "ok")
        let serialized = String(data: try AnalyticsSchema.encode(captured), encoding: .utf8)!
        XCTAssertFalse(serialized.contains("private-key")); XCTAssertFalse(serialized.contains("private-value"))
    }
}
