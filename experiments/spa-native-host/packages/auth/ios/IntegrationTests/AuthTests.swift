import XCTest
import WebKit
import CryptoKit
@testable import SPAHost
@testable import NativeHostAuth

private final class AuthMockProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, [String: String], [String: Any]))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.cannotConnectToHost) }
            let (status, headers, value) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: value)); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor
final class AuthTests: XCTestCase {
    private var origin: URL!
    private var store: AuthCredentialStore!
    private var native: NativeAuth!
    private var services: ApplicationServices!
    private var cookies: WKHTTPCookieStore!
    private var websiteDataStore: WKWebsiteDataStore!
    private var temporary: URL!
    private let presenter = UIViewController()
    override func setUp() async throws {
        temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        origin = URL(string: "https://auth-" + UUID().uuidString.lowercased() + ".example")!
        store = AuthCredentialStore(origin: origin)
        let config = HostConfiguration(); let settings = AuthConfiguration(enabled: true, origin: origin, providers: ["example"], rpID: "example.com")
        services = ApplicationServices(root: temporary, configuration: config)
        let network = URLSessionConfiguration.ephemeral; network.protocolClasses = [AuthMockProtocol.self]
        native = NativeAuth(configuration: settings, services: services, networkConfiguration: network)
        websiteDataStore = WKWebsiteDataStore.nonPersistent(); cookies = websiteDataStore.httpCookieStore
    }
    override func tearDown() async throws {
        try store?.clear(); native = nil; services = nil; cookies = nil; websiteDataStore = nil; AuthMockProtocol.handler = nil
        if let temporary { try? FileManager.default.removeItem(at: temporary) }
    }
    private var summary: [String: Any] { ["authenticated": true, "user": ["id": "test-user", "name": "Test user"], "expiresAt": 9999999999999] }
    private func credentials(access: String = "access_token_0123456789", refresh: String = "refresh_token_0123456789") -> [String: Any] { ["accessToken": access, "refreshToken": refresh, "session": summary] }
    private func run(_ action: String, args: [String: Any] = [:]) async throws -> [String: Any] {
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            do { try native.run(action: action, args: args, owner: "test-owner", requestID: UUID().uuidString, presenter: presenter, cookieStore: cookies, hostedOrigin: origin, returnPath: "/hosted/") { continuation.resume(with: $0) } }
            catch { continuation.resume(throwing: error) }
        }
        return try XCTUnwrap(result as? [String: Any])
    }
    func testProofAndCallbackValidation() throws {
        let first = try AuthEncoding.proof(), next = try AuthEncoding.proof()
        XCTAssertNotEqual(first.verifier, next.verifier)
        XCTAssertEqual(try AuthEncoding.decode(first.verifier).count, 32)
        XCTAssertEqual(first.challenge, AuthEncoding.encode(Data(SHA256.hash(data: Data(first.verifier.utf8)))))
        XCTAssertEqual(try AuthEncoding.callbackCode(URL(string: "spahost-auth://callback?code=12345678901234567890")!), "12345678901234567890")
        for url in ["spahost-auth://evil?code=12345678901234567890", "spahost-auth://callback?code=12345678901234567890&code=duplicate", "https://callback?code=12345678901234567890", "spahost-auth://callback?code=12345678901234567890#fragment"] {
            XCTAssertThrowsError(try AuthEncoding.callbackCode(URL(string: url)!))
        }
        XCTAssertThrowsError(try AuthEncoding.decode("abc="))
    }
    func testConfigurationRequiresApprovedOriginAndRelyingParty() throws {
        XCTAssertFalse(try AuthConfiguration.parse(nil).enabled)
        XCTAssertThrowsError(try AuthConfiguration.parse(["enabled": true, "origin": "http://remote.example", "providers": [], "rpId": NSNull()]))
        XCTAssertThrowsError(try AuthConfiguration.parse(["enabled": true, "origin": "https://app.example.com", "providers": ["example", "example"], "rpId": "example.com"]))
        XCTAssertThrowsError(try AuthConfiguration.parse(["enabled": true, "origin": "https://app.example.com", "providers": [], "rpId": "different.example"]))
        XCTAssertTrue(try AuthConfiguration.parse(["enabled": true, "origin": "https://app.example.com", "providers": ["example"], "rpId": "example.com"]).enabled)
        XCTAssertEqual(try AuthConfiguration.parse(["enabled": true, "origin": "https://app.example.com", "providers": ["enterprise_oidc"], "rpId": "example.com"]).providers, ["enterprise_oidc"])
    }
    func testDisabledAuthenticationReportsUnavailableWithoutNetwork() async throws {
        native = NativeAuth(configuration: AuthConfiguration(), services: services)
        AuthMockProtocol.handler = { _ in XCTFail("Disabled authentication contacted service"); return (500, [:], [:]) }
        let result = try await run("auth.status")
        XCTAssertEqual(result["authenticated"] as? Bool, false); XCTAssertEqual(result["configured"] as? Bool, false)
        do { _ = try await run("auth.signIn", args: ["method": "oauth", "provider": "example"]); XCTFail("Unconfigured provider succeeded") }
        catch { XCTAssertEqual((error as? HostFailure)?.code, "UNAVAILABLE") }
    }
    func testAuthChangedBuffersOnlyCurrentSnapshot() {
        services.publish("auth.changed", summary)
        services.publish("auth.changed", ["authenticated": false])
        var received: [[String: Any]] = []
        services.drain("auth.changed") { received.append($0); return true }
        XCTAssertEqual(received.count, 1); XCTAssertEqual(received.first?["authenticated"] as? Bool, false)
    }
    func testMissingNativeVaultWithPriorWebCookieResetsBeforeOAuthStarts() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene); window.rootViewController = presenter; window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let cookie = try XCTUnwrap(HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "__Host-spa_session=previous-account; Path=/; Secure; HttpOnly; SameSite=Lax"], for: origin).first)
        await withCheckedContinuation { continuation in cookies.setCookie(cookie) { continuation.resume() } }
        AuthMockProtocol.handler = { _ in XCTFail("Prior web identity reached OAuth"); return (500, [:], [:]) }
        do { _ = try await run("auth.signIn", args: ["method": "oauth", "provider": "example"]); XCTFail("Old web realm was promoted into OAuth") }
        catch { XCTAssertEqual((error as? HostFailure)?.code, "UNAUTHORIZED") }
        XCTAssertNil(try store.read()); XCTAssertNil(presenter.presentedViewController)
        XCTAssertEqual(services.sessionRevision, 1)
        let remaining = await withCheckedContinuation { continuation in cookies.getAllCookies { continuation.resume(returning: $0) } }
        XCTAssertFalse(remaining.contains { $0.name == "__Host-spa_session" })
    }
    func testStatusStripsCredentialsAndUsesAuthorizationHeader() async throws {
        try store.write(credentials())
        let response = summary.merging(["accessToken": "must-not-cross-bridge", "unexpected": "hidden"], uniquingKeysWith: { _, last in last })
        AuthMockProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/auth/native/session")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access_token_0123456789")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            return (200, [:], response)
        }
        let result = try await run("auth.status")
        XCTAssertEqual(result["authenticated"] as? Bool, true)
        XCTAssertNil(result["accessToken"]); XCTAssertNil(result["unexpected"])
        XCTAssertEqual(result["configured"] as? Bool, true)
    }
    func testExpiredAccessRefreshesOnceAndPersistsRotationBeforeRetry() async throws {
        try store.write(credentials())
        let replacement = credentials(access: "new_access_0123456789", refresh: "new_refresh_0123456789")
        let response = summary
        var calls = 0
        let secure = store!
        AuthMockProtocol.handler = { request in
            calls += 1
            if calls == 1 { return (401, [:], [:]) }
            if calls == 2 { XCTAssertEqual(request.url?.path, "/api/auth/native/refresh"); return (200, [:], replacement) }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer new_access_0123456789")
            XCTAssertEqual(try secure.read()?["refreshToken"] as? String, "new_refresh_0123456789")
            return (200, [:], response)
        }
        let result = try await run("auth.status")
        XCTAssertEqual(result["authenticated"] as? Bool, true)
        XCTAssertEqual(calls, 3)
    }
    func testRejectedRefreshClearsNativeSession() async throws {
        try store.write(credentials())
        AuthMockProtocol.handler = { _ in (401, [:], [:]) }
        let result = try await run("auth.status")
        XCTAssertEqual(result["authenticated"] as? Bool, false)
        XCTAssertNil(try store.read())
    }
    func testSecureStorageIsPartitionedByOrigin() throws {
        try store.write(credentials())
        let other = AuthCredentialStore(origin: URL(string: "https://other-" + UUID().uuidString + ".example")!)
        XCTAssertNil(try other.read()); XCTAssertNotNil(try store.read())
    }
    func testCookieImportRejectsWeakenedOrForeignCookies() throws {
        func response(_ raw: String) -> HTTPURLResponse { HTTPURLResponse(url: origin.appendingPathComponent("api/auth/native/web-session/"), statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": raw])! }
        let valid = "__Host-spa_session=opaque; Path=/; Secure; HttpOnly; SameSite=Lax"
        XCTAssertEqual(try NativeAuth.sessionCookie(response(valid), origin: origin).name, "__Host-spa_session")
        for invalid in [valid + "; Domain=" + origin.host!, "other=opaque; Path=/; Secure; HttpOnly; SameSite=Lax", "__Host-spa_session=opaque; Path=/; HttpOnly; SameSite=Lax", "__Host-spa_session=opaque; Path=/; Secure; SameSite=Lax", "__Host-spa_session=opaque; Path=/; Secure; HttpOnly; SameSite=None"] {
            XCTAssertThrowsError(try NativeAuth.sessionCookie(response(invalid), origin: origin))
        }
    }
    func testSignOutClearsLocalCredentialsWhenServerUnavailable() async throws {
        try store.write(credentials())
        let cookie = HTTPCookie(properties: [.domain: origin.host!, .path: "/", .name: "__Host-spa_session", .value: "test", .secure: "TRUE"])!
        await withCheckedContinuation { continuation in cookies.setCookie(cookie) { continuation.resume() } }
        AuthMockProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        let result = try await run("auth.signOut")
        XCTAssertEqual(result["authenticated"] as? Bool, false); XCTAssertEqual(result["revoked"] as? Bool, false)
        XCTAssertNil(try store.read())
        let remaining = await withCheckedContinuation { continuation in cookies.getAllCookies { continuation.resume(returning: $0) } }
        XCTAssertFalse(remaining.contains { $0.name == "__Host-spa_session" })
    }
    func testWebSyncRefreshesExpiredAccessAndImportsOnlySessionCookie() async throws {
        try store.write(credentials())
        let response = summary, replacement = credentials(access: "new_access_0123456789", refresh: "new_refresh_0123456789")
        var calls = 0
        AuthMockProtocol.handler = { request in
            calls += 1
            switch calls {
            case 1: return (401, [:], [:])
            case 2: XCTAssertEqual(request.url?.path, "/api/auth/native/refresh"); return (200, [:], replacement)
            case 3:
                XCTAssertEqual(request.url?.path, "/api/auth/native/web-ticket")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer new_access_0123456789")
                return (200, [:], ["ticket": "single_use_ticket_0123456789"])
            default:
                XCTAssertEqual(request.url?.path, "/api/auth/native/web-session")
                return (200, ["Set-Cookie": "__Host-spa_session=opaque; Path=/; Secure; HttpOnly; SameSite=Lax"], response)
            }
        }
        let result = try await run("auth.syncWebSession")
        XCTAssertEqual(result["synchronized"] as? Bool, true); XCTAssertNil(result["ticket"])
        let saved = await withCheckedContinuation { continuation in cookies.getAllCookies { continuation.resume(returning: $0) } }
        XCTAssertEqual(saved.filter { $0.name == "__Host-spa_session" }.count, 1)
        XCTAssertEqual(calls, 4)
    }
    func testSignOutRefreshesExpiredAccessWithoutRestoringLocalCredentials() async throws {
        try store.write(credentials())
        let replacement = credentials(access: "new_access_0123456789", refresh: "new_refresh_0123456789"), secure = store!
        var calls = 0
        AuthMockProtocol.handler = { request in
            calls += 1; XCTAssertNil(try secure.read())
            if calls == 1 { return (401, [:], [:]) }
            if calls == 2 { XCTAssertEqual(request.url?.path, "/api/auth/native/refresh"); return (200, [:], replacement) }
            XCTAssertEqual(request.url?.path, "/api/auth/native/logout")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer new_access_0123456789")
            return (200, [:], ["authenticated": false])
        }
        let result = try await run("auth.signOut")
        XCTAssertEqual(result["revoked"] as? Bool, true); XCTAssertNil(try store.read()); XCTAssertEqual(calls, 3)
    }
    func testCancelledRefreshCheckpointsRotationAndBlocksCompetingRefresh() async throws {
        try store.write(credentials())
        let entered = expectation(description: "refresh admitted"), gate = DispatchSemaphore(value: 0)
        let replacement = credentials(access: "new_access_0123456789", refresh: "new_refresh_0123456789"), response = summary
        var calls = 0
        AuthMockProtocol.handler = { request in
            calls += 1
            if calls == 1 { return (401, [:], [:]) }
            if calls == 2 {
                entered.fulfill(); _ = gate.wait(timeout: .now() + 5)
                return (200, [:], replacement)
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer new_access_0123456789")
            return (200, [:], response)
        }
        let pending = Task { try await run("auth.status") }
        await fulfillment(of: [entered], timeout: 5)
        native.cancel(owner: "test-owner")
        do { _ = try await pending.value; XCTFail("Cancelled request succeeded") } catch { XCTAssertEqual((error as? HostFailure)?.code, "CANCELLED") }
        do { _ = try await run("auth.status"); XCTFail("Competing refresh admitted") } catch { XCTAssertEqual((error as? HostFailure)?.code, "BUSY") }
        gate.signal()
        for _ in 0..<100 {
            if try store.read()?["refreshToken"] as? String == "new_refresh_0123456789" { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(try store.read()?["refreshToken"] as? String, "new_refresh_0123456789")
        let result = try await run("auth.status")
        XCTAssertEqual(result["authenticated"] as? Bool, true); XCTAssertEqual(calls, 3)
    }
}
