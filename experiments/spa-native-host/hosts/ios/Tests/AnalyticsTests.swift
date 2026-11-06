import XCTest
import WebKit
@testable import SPAHost

@MainActor
final class AnalyticsTests: XCTestCase {
    var root: URL!
    override func setUp() async throws { root = FileManager.default.temporaryDirectory.appendingPathComponent("analytics-" + UUID().uuidString); try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true) }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: root) }
    func record(_ analytics: NativeAnalytics, _ name: String, properties: [String: Any] = [:]) async throws {
        _ = try await withCheckedThrowingContinuation { continuation in analytics.record(category: "custom", name: name, properties: properties, source: "web") { continuation.resume(with: $0) } }
    }
    func events(_ analytics: NativeAnalytics) async -> [[String: Any]] { await withCheckedContinuation { continuation in analytics.inspectForTesting { continuation.resume(returning: $0) } } }
    func status(_ analytics: NativeAnalytics) async throws -> [String: Any] { try await withCheckedThrowingContinuation { continuation in analytics.status { result in continuation.resume(with: result.map { $0 as! [String: Any] }) } } }
    func policy(_ revision: Int, names: [String] = ["*"], destination: String = "recording") -> [String: Any] {
        ["schemaVersion": 1, "revision": revision, "expiresAtMs": NativeAnalytics.now() + 60_000, "enabled": true, "categories": ["custom"], "names": names, "properties": [:], "sampleBasisPoints": 10_000, "lookbackSeconds": 604_800, "destinations": [destination]]
    }
    func select(_ analytics: NativeAnalytics, _ object: [String: Any], destination: String = "recording", ack: [String] = []) async throws -> [[String: Any]] {
        try await withCheckedThrowingContinuation { continuation in analytics.policyForTesting(object, destination: destination, acknowledge: ack) { continuation.resume(with: $0) } }
    }
    func testNativeJournalPersistsIdentityAndCommittedEventsAcrossOwners() async throws {
        var first: NativeAnalytics? = NativeAnalytics(root: root, configuration: AnalyticsConfiguration())
        try await record(first!, "custom.saved", properties: ["count": 2, "control": "save-draft"])
        let saved = await events(first!); XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(saved[0]["platform"] as? String, "ios"); XCTAssertEqual(saved[0]["source"] as? String, "web")
        XCTAssertNotNil(UUID(uuidString: saved[0]["id"] as! String)); XCTAssertNotNil(UUID(uuidString: saved[0]["installId"] as! String))
        first = nil
        let second = NativeAnalytics(root: root, configuration: AnalyticsConfiguration()); try await record(second, "custom.reopened")
        let restored = await events(second); XCTAssertEqual(restored.count, 2)
        XCTAssertEqual(restored[0]["id"] as? String, saved[0]["id"] as? String)
        XCTAssertEqual(restored[0]["installId"] as? String, restored[1]["installId"] as? String)
        XCTAssertEqual(restored[0]["sessionId"] as? String, restored[1]["sessionId"] as? String)
        let stats = try await status(second); XCTAssertEqual(stats["count"] as? Int, 2); XCTAssertEqual(stats["configured"] as? Bool, false)
    }
    func testSemanticAdmissionRejectsTextValuesAndUnknownProperties() async throws {
        let analytics = NativeAnalytics(root: root, configuration: AnalyticsConfiguration())
        for properties: [String: Any] in [["value": "password-secret"], ["url": "https://example.com/?token=secret"], ["control": "person@example.com"], ["count": true], ["durationMs": 600_001], ["screen": "/hosted/person-secret/"]] {
            do { try await record(analytics, "custom.invalid", properties: properties); XCTFail("Private/invalid field was admitted") } catch let error as HostFailure { XCTAssertEqual(error.code, "INVALID_REQUEST") }
        }
        let rejected = await events(analytics); XCTAssertTrue(rejected.isEmpty)
        XCTAssertEqual(AnalyticsSchema.screen("/compose/?token=secret"), "compose")
        XCTAssertEqual(AnalyticsSchema.screen("/hosted/item/person-secret/?token=secret"), "hosted")
        XCTAssertEqual(AnalyticsSchema.sample("hello"), 1723)
    }
    func testPolicyChangesSelectRetainedEventsAndReceiptsArePerDestination() async throws {
        var config = AnalyticsConfiguration(); config.destinations = ["recording", "secondary"]
        var analytics: NativeAnalytics? = NativeAnalytics(root: root, configuration: config)
        try await record(analytics!, "custom.first", properties: ["count": 1]); try await record(analytics!, "custom.second", properties: ["count": 2])
        let onePolicy = policy(1, names: ["custom.first"])
        let first = try await select(analytics!, onePolicy); XCTAssertEqual(first.count, 1)
        let firstID = first[0]["id"] as! String
        _ = try await select(analytics!, onePolicy, ack: [firstID])
        let remaining = try await select(analytics!, policy(2)); XCTAssertEqual(remaining.map { $0["name"] as! String }, ["custom.second"])
        let retry = try await select(analytics!, policy(2)); XCTAssertEqual(retry[0]["id"] as? String, remaining[0]["id"] as? String)
        do { _ = try await select(analytics!, policy(2), ack: [UUID().uuidString]); XCTFail("Unknown ACK admitted") } catch let error as HostFailure { XCTAssertEqual(error.code, "INVALID_REQUEST") }
        let secondaryPolicy = policy(3, destination: "secondary")
        let secondary = try await select(analytics!, secondaryPolicy, destination: "secondary"); XCTAssertEqual(secondary.count, 2)
        analytics = nil
        let reopened = NativeAnalytics(root: root, configuration: config)
        do { _ = try await select(reopened, policy(1)); XCTFail("Rollback policy admitted") } catch let error as HostFailure { XCTAssertEqual(error.code, "INVALID_REQUEST") }
        let afterRestart = try await select(reopened, policy(4)); XCTAssertEqual(afterRestart.count, 1)
        XCTAssertEqual(afterRestart[0]["id"] as? String, remaining[0]["id"] as? String)
        let restartedStatus = try await status(reopened); XCTAssertEqual(restartedStatus["acknowledged"] as? Int, 1)
        let retained = await events(reopened); XCTAssertEqual(retained.count, 2)
    }
    func testNativeBoundsAndExpiryEvictWithoutUsingUserKVQuota() async throws {
        var config = AnalyticsConfiguration(); config.maxEvents = 2
        let analytics = NativeAnalytics(root: root, configuration: config)
        for index in 0..<3 { try await record(analytics, "custom.bound", properties: ["count": index]) }
        let stats = try await status(analytics); XCTAssertEqual(stats["count"] as? Int, 2); XCTAssertEqual(stats["dropped"] as? Int, 1)
        var short = AnalyticsConfiguration(); short.retentionSeconds = 1
        let expiring = NativeAnalytics(root: root.appendingPathComponent("expiry"), configuration: short)
        try await record(expiring, "custom.expiring"); try await Task.sleep(nanoseconds: 1_100_000_000)
        let expiredStatus = try await status(expiring); XCTAssertEqual(expiredStatus["count"] as? Int, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("analytics.sqlite").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("storage.sqlite").path))
    }
    func testAllJournalOperationsKeepAdmissionUntilWriterActuallyFinishes() async throws {
        let analytics = NativeAnalytics(root: root, configuration: AnalyticsConfiguration())
        let gate = DispatchSemaphore(value: 0)
        await withCheckedContinuation { continuation in analytics.holdWriterForTesting(entered: { continuation.resume() }, until: gate) }
        var busyStatuses = 0, busyFlush = false
        let completed = expectation(description: "All admitted status work drains after release"); completed.expectedFulfillmentCount = 128
        for _ in 0..<128 {
            analytics.status { result in if case .failure(let failure) = result { XCTAssertEqual(failure.code, "BUSY"); busyStatuses += 1 }; completed.fulfill() }
        }
        analytics.flush { result in if case .failure(let failure) = result { busyFlush = failure.code == "BUSY" } }
        XCTAssertEqual(busyStatuses, 1); XCTAssertTrue(busyFlush)
        // Caller disposal/cancellation cannot remove any of these real queued
        // jobs: the writer remains held and admission must remain saturated.
        var stillFull = false
        analytics.status { result in if case .failure(let failure) = result { stillFull = failure.code == "BUSY" } }
        XCTAssertTrue(stillFull)
        gate.signal()
        await fulfillment(of: [completed], timeout: 10)
        let recovered = try await status(analytics); XCTAssertEqual(recovered["count"] as? Int, 0)
    }
    func testCommittedRouteDedupPreservesDistinctHostedAndNativeVisits() async throws {
        let analytics = NativeAnalytics(root: root, configuration: AnalyticsConfiguration())
        analytics.screen("/hosted/item/42/?token=secret", tab: "overview", surface: "first")
        analytics.screen("/hosted/item/42/?token=secret", tab: "overview", surface: "first")
        analytics.screen("/hosted/item/43/?token=secret", tab: "overview", surface: "first")
        analytics.screen("/hosted/item/43/?token=secret", tab: "overview", surface: "new-native-surface")
        let captured = await events(analytics); XCTAssertEqual(captured.count, 3)
        XCTAssertTrue(captured.allSatisfy { ($0["properties"] as? [String: Any])?["screen"] as? String == "hosted" })
        let serialized = String(data: try AnalyticsSchema.encode(captured), encoding: .utf8)!
        XCTAssertFalse(serialized.contains("secret")); XCTAssertFalse(serialized.contains("/hosted/")); XCTAssertFalse(serialized.contains("new-native-surface"))
    }
    func testPolicyCacheAndRevisionAreBoundToCollectorOrigin() async throws {
        var firstConfiguration = AnalyticsConfiguration(); firstConfiguration.origin = URL(string: "https://collector-a.example")
        var first: NativeAnalytics? = NativeAnalytics(root: root, configuration: firstConfiguration)
        try await record(first!, "custom.origin")
        _ = try await select(first!, policy(10)); first = nil
        let offline = NativeAnalytics(root: root, configuration: AnalyticsConfiguration())
        let offlineState = try await status(offline); XCTAssertEqual(offlineState["policyRevision"] as? Int, 10)
        var secondConfiguration = AnalyticsConfiguration(); secondConfiguration.origin = URL(string: "https://collector-b.example")
        let second = NativeAnalytics(root: root, configuration: secondConfiguration)
        let secondState = try await status(second)
        XCTAssertEqual(secondState["policyRevision"] as? Int, 0); XCTAssertTrue(secondState["policyExpiresAtMs"] is NSNull)
        XCTAssertEqual(secondState["count"] as? Int, 1)
        _ = try await select(second, policy(1))
        let rebound = try await status(second); XCTAssertEqual(rebound["policyRevision"] as? Int, 1)
        var canonical = secondConfiguration; canonical.origin = URL(string: "https://COLLECTOR-B.example:443/")
        let equivalent = NativeAnalytics(root: root, configuration: canonical)
        let equivalentState = try await status(equivalent); XCTAssertEqual(equivalentState["policyRevision"] as? Int, 1)
    }
    func testPolicyRejectsExpiryEscalationRollbackAndSameRevisionMutation() async throws {
        let analytics = NativeAnalytics(root: root, configuration: AnalyticsConfiguration())
        try await record(analytics, "custom.policy")
        let valid = policy(5); _ = try await select(analytics, valid)
        var modified = valid; modified["names"] = ["custom.other"]
        var expired = policy(6); expired["expiresAtMs"] = NativeAnalytics.now() - 1
        var distant = policy(6); distant["expiresAtMs"] = NativeAnalytics.now() + 86_460_000
        var escalated = policy(6); escalated["destinations"] = ["not-bundled"]
        var extra = policy(6); extra["url"] = "https://foreign.example"
        var wrongType = policy(6); wrongType["revision"] = true
        for invalid in [modified, expired, distant, escalated, extra, wrongType] {
            do { _ = try await select(analytics, invalid); XCTFail("Invalid policy admitted") } catch let error as HostFailure { XCTAssertEqual(error.code, "INVALID_REQUEST") }
        }
        let unchangedStatus = try await status(analytics); XCTAssertEqual(unchangedStatus["policyRevision"] as? Int, 5)
        var paused = policy(6); paused["enabled"] = false
        let excluded = try await select(analytics, paused); XCTAssertTrue(excluded.isEmpty)
        let retained = await events(analytics); XCTAssertEqual(retained.count, 1)
    }
}

@MainActor
final class AnalyticsBridgeTests: XCTestCase {
    var window: UIWindow!
    var host: HostViewController!
    var root: URL!
    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("analytics-bridge-" + UUID().uuidString)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        host = HostViewController(dataRoot: root)
        window = UIWindow(windowScene: scene); window.rootViewController = UINavigationController(rootViewController: host); window.makeKeyAndVisible()
        host.loadViewIfNeeded()
        for _ in 0..<150 {
            if (try? await js("return Boolean(window.platform && document.readyState==='complete')")) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Real WebView did not finish loading")
    }
    override func tearDown() async throws { window?.isHidden = true; window = nil; host = nil; try? FileManager.default.removeItem(at: root) }
    func js(_ body: String) async throws -> Any { try await withCheckedThrowingContinuation { continuation in host.webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { continuation.resume(with: $0) } } }
    func testRealBridgeSemanticAdmissionNoAnalyticsRecursionAndForegroundOwnership() async throws {
        let recorded = try await js("return await platform.call('analytics.track',{name:'custom.bridge',properties:{control:'native-save',count:1}})") as? [String: Any]
        XCTAssertEqual(recorded?["recorded"] as? Bool, true)
        let observed = try await js("return await platform.call('analytics.observe',{type:'click',kind:'button',control:'native-save'})") as? [String: Any]
        XCTAssertEqual(observed?["recorded"] as? Bool, true)
        let rejected = try await js("let errors=[];for(const args of [{name:'app.started'},{name:'custom.bad',properties:{value:'secret'}},{name:'custom.bad',properties:{control:'person@example.com'}}]){try{await platform.call('analytics.track',args);errors.push('accepted')}catch(e){errors.push(e.code)}}return errors") as? [String]
        XCTAssertEqual(rejected, ["INVALID_REQUEST", "INVALID_REQUEST", "INVALID_REQUEST"])
        // No returned IDs/raw events, and these status requests cannot recursively
        // add bridge.completed events to their own journal.
        try await Task.sleep(nanoseconds: 500_000_000)
        let first = try await js("return await platform.call('analytics.status',{})") as? [String: Any]
        _ = try await js("for(let i=0;i<10;i++)await platform.call('analytics.status',{});return true")
        let after = try await js("return await platform.call('analytics.status',{})") as? [String: Any]
        XCTAssertEqual(first?["count"] as? Int, after?["count"] as? Int)
        XCTAssertNil(after?["events"]); XCTAssertNil(after?["installId"])
        let unconfigured = try await js("try{await platform.call('analytics.flush',{});return 'bad'}catch(e){return e.code}") as? String; XCTAssertEqual(unconfigured, "UNAVAILABLE")
        window.isHidden = true
        let hidden = try await js("try{await platform.call('analytics.observe',{type:'click',kind:'button'});return 'bad'}catch(e){return e.code}") as? String; XCTAssertEqual(hidden, "UNAUTHORIZED")
    }

    func testTelemetryLaneDoesNotExhaustBusinessRequestLimit() async throws {
        executionTimeAllowance = 60
        let business = try await js("for(let i=0;i<4100;i++)await platform.call('analytics.status',{});return (await platform.chrome.state()).mode") as? String
        XCTAssertEqual(business, "standard")
        XCTAssertNil(HostViewController.analyticsSequence("0")); XCTAssertNil(HostViewController.analyticsSequence("01")); XCTAssertNil(HostViewController.analyticsSequence("9007199254740992")); XCTAssertNil(HostViewController.analyticsSequence("1.0")); XCTAssertNil(HostViewController.analyticsSequence("1e2"))
        XCTAssertEqual(HostViewController.analyticsSequence("9007199254740991"), 9_007_199_254_740_991)
    }
}

// Explicit two-process collector acceptance. The parent changes only the local
// server policy file between these selectively invoked tests. Baseline suites
// skip them unless that exact dev policy/phase is enabled.
@MainActor
final class AnalyticsHTTPTests: XCTestCase {
    private let origin = URL(string: "http://127.0.0.1:18797")!
    var root: URL { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("analytics-http-acceptance", isDirectory: true) }
    func configuredPhase(_ revision: Int, name: String) async throws {
        var request = URLRequest(url: origin.appendingPathComponent("api/analytics/policy/")); request.timeoutInterval = 2
        guard let (data, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["revision"] as? Int == revision,
              object["enabled"] as? Bool == true, object["names"] as? [String] == [name] else { throw XCTSkip("Local analytics collector is not configured for acceptance phase \(revision)") }
    }
    func engine() -> NativeAnalytics { var config = AnalyticsConfiguration(); config.origin = origin; return NativeAnalytics(root: root, configuration: config) }
    func record(_ analytics: NativeAnalytics, _ name: String) async throws { _ = try await withCheckedThrowingContinuation { continuation in analytics.record(category: "custom", name: name, properties: ["control": "acceptance-fixture"], source: "web") { continuation.resume(with: $0) } } }
    func flush(_ analytics: NativeAnalytics) async throws -> [String: Any] { try await withCheckedThrowingContinuation { continuation in analytics.flush { continuation.resume(with: $0.map { $0 as! [String: Any] }) } } }
    func status(_ analytics: NativeAnalytics) async throws -> [String: Any] { try await withCheckedThrowingContinuation { continuation in analytics.status { continuation.resume(with: $0.map { $0 as! [String: Any] }) } } }
    func events(_ analytics: NativeAnalytics) async -> [[String: Any]] { await withCheckedContinuation { continuation in analytics.inspectForTesting { continuation.resume(returning: $0) } } }
    func receipt(_ name: String, _ value: [String: Any]) throws {
        let data = try AnalyticsSchema.encode(value); try data.write(to: root.appendingPathComponent(name + ".json"), options: .atomic)
        print("ANALYTICS_HTTP_\(name): " + String(data: data, encoding: .utf8)!)
    }
    func testPhaseOneUploadSelectedEvent() async throws {
        try await configuredPhase(1, name: "custom.analytics_keep")
        try? FileManager.default.removeItem(at: root)
        let analytics = engine()
        try await record(analytics, "custom.analytics_keep"); try await record(analytics, "custom.analytics_later")
        let response = try await flush(analytics), stats = try await status(analytics), saved = await events(analytics)
        XCTAssertEqual(response["accepted"] as? Int, 1); XCTAssertEqual(response["policyRevision"] as? Int, 1)
        XCTAssertEqual(stats["acknowledged"] as? Int, 1); XCTAssertEqual(stats["count"] as? Int, 2)
        XCTAssertEqual(saved.count, 2)
        try receipt("phase1", ["response": response, "status": stats, "events": saved, "pid": ProcessInfo.processInfo.processIdentifier])
    }
    func testPhaseTwoSelectRetainedEventAfterRestart() async throws {
        try await configuredPhase(2, name: "custom.analytics_later")
        let prior = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("phase1.json"))) as? [String: Any])
        XCTAssertNotEqual(prior["pid"] as? Int, Int(ProcessInfo.processInfo.processIdentifier))
        let analytics = engine(), before = await events(analytics)
        XCTAssertEqual(before.count, 2)
        let response = try await flush(analytics), stats = try await status(analytics), after = await events(analytics)
        XCTAssertEqual(response["accepted"] as? Int, 1); XCTAssertEqual(response["policyRevision"] as? Int, 2)
        XCTAssertEqual(stats["acknowledged"] as? Int, 2); XCTAssertEqual(stats["count"] as? Int, 2)
        XCTAssertEqual(before.map { $0["id"] as! String }, after.map { $0["id"] as! String })
        try receipt("phase2", ["response": response, "status": stats, "events": after, "pid": ProcessInfo.processInfo.processIdentifier])
    }
}
