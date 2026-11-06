import Foundation
import UIKit
import AuthenticationServices
import Security
import CryptoKit
import WebKit
import NativeHostPluginAPI

struct AuthConfiguration {
    var enabled = false
    var origin: URL?
    var providers: [String] = []
    var rpID: String?
    var passkeysFeature = false
    var passkeys: Bool { enabled && rpID != nil && passkeysFeature }
    static func parse(_ raw: Any?) throws -> AuthConfiguration {
        guard let raw else { return AuthConfiguration() }
        guard let value = raw as? [String: Any], Set(value.keys) == Set(["enabled", "origin", "providers", "rpId"]),
              let enabled = value["enabled"] as? Bool, let providers = value["providers"] as? [String], providers.count <= 8,
              Set(providers).count == providers.count,
              providers.allSatisfy({ $0.range(of: "^[a-z][a-z0-9_-]{0,31}$", options: .regularExpression) != nil }) else { throw PluginFailure("INVALID_REQUEST", "Invalid native auth configuration") }
        var result = AuthConfiguration(); result.enabled = enabled; result.providers = providers
        if !(value["origin"] is NSNull) {
            guard let raw = value["origin"] as? String, let url = PluginOriginValidator.validOrigin(raw) else { throw PluginFailure("INVALID_REQUEST", "Auth requires an exact HTTPS origin") }
            result.origin = url
        }
        if !(value["rpId"] is NSNull) {
            guard let rp = value["rpId"] as? String, validRP(rp) else { throw PluginFailure("INVALID_REQUEST", "Invalid passkey relying party") }
            result.rpID = rp
        }
        guard !enabled || result.origin != nil else { throw PluginFailure("INVALID_REQUEST", "Auth origin is not configured") }
        if let rp = result.rpID, let host = result.origin?.host {
            guard host == rp || host.hasSuffix("." + rp) else { throw PluginFailure("INVALID_REQUEST", "Passkey relying party does not match auth origin") }
        }
        return result
    }
    static func validRP(_ value: String) -> Bool {
        value.utf8.count <= 253 && value.range(of: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$", options: .regularExpression) != nil
    }
}

enum AuthEncoding {
    static func encode(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    static func decode(_ value: Any?, maximum: Int = 16384) throws -> Data {
        guard let value = value as? String, !value.isEmpty, value.utf8.count <= maximum,
              value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw PluginFailure("INVALID_REQUEST", "Invalid credential encoding") }
        let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)
        guard let bytes = Data(base64Encoded: padded), encode(bytes) == value else { throw PluginFailure("INVALID_REQUEST", "Invalid credential encoding") }
        return bytes
    }
    static func proof() throws -> (verifier: String, challenge: String) {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw PluginFailure("IO_ERROR", "Secure randomness unavailable") }
        let verifier = encode(Data(bytes)); return (verifier, encode(Data(SHA256.hash(data: Data(verifier.utf8)))))
    }
    static func callbackCode(_ url: URL) throws -> String {
        guard url.scheme == "spahost-auth", url.host == "callback", url.path.isEmpty || url.path == "/", url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let items = parts.queryItems, items.count == 1, items[0].name == "code",
              let code = items[0].value, code.utf8.count <= 512, code.range(of: "^[A-Za-z0-9_-]{16,512}$", options: .regularExpression) != nil else { throw PluginFailure("UNAUTHORIZED", "Invalid authentication callback") }
        return code
    }
}

// A separate Keychain namespace for each service prevents a configuration change
// from sending an old deployment's credentials to a new origin.
final class AuthCredentialStore {
    private let service: String
    init(origin: URL) { service = "dev.spahost.auth." + AuthEncoding.encode(Data(SHA256.hash(data: Data(origin.absoluteString.utf8)))) }
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "session"] }
    func read() throws -> [String: Any]? {
        var lookup = query; lookup[kSecReturnData as String] = true; lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let result = SecItemCopyMatching(lookup as CFDictionary, &item)
        if result == errSecItemNotFound { return nil }
        guard result == errSecSuccess, let data = item as? Data, data.count <= 32768, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw PluginFailure("IO_ERROR", "Secure session storage is unavailable") }
        return value
    }
    func write(_ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        guard data.count <= 32768 else { throw PluginFailure("QUOTA_EXCEEDED", "Secure session exceeds limit") }
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let result = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if result == errSecItemNotFound {
            var insert = query; attributes.forEach { insert[$0] = $1 }
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw PluginFailure("IO_ERROR", "Could not store native session") }
        } else if result != errSecSuccess { throw PluginFailure("IO_ERROR", "Could not store native session") }
    }
    func clear() throws { let result = SecItemDelete(query as CFDictionary); guard result == errSecSuccess || result == errSecItemNotFound else { throw PluginFailure("IO_ERROR", "Could not clear native session") } }
}

private final class AuthNetworkDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

final class NativeAuth: NSObject, ASWebAuthenticationPresentationContextProviding, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private final class Operation {
        let id = UUID().uuidString
        let owner: String
        let requestID: String
        let completion: (Result<Any, PluginFailure>) -> Void
        var lease: String?
        var task: URLSessionDataTask?
        var browser: ASWebAuthenticationSession?
        var controller: ASAuthorizationController?
        weak var window: UIWindow?
        var timer: DispatchWorkItem?
        var transaction: String?
        var registration = false
        var refreshing = false
        var cookieStore: WKHTTPCookieStore?
        init(owner: String, requestID: String, completion: @escaping (Result<Any, PluginFailure>) -> Void) { self.owner = owner; self.requestID = requestID; self.completion = completion }
    }
    private weak var services: PluginHostServices?
    private let configuration: AuthConfiguration
    private let credentialStore: AuthCredentialStore?
    private let networkConfiguration: URLSessionConfiguration?
    private let delegate = AuthNetworkDelegate()
    private lazy var network: URLSession = {
        let config = networkConfiguration ?? URLSessionConfiguration.ephemeral; config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData; config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 25
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }()
    private var operation: Operation?
    private var refreshInFlight: String?
    init(configuration: AuthConfiguration, services: PluginHostServices, networkConfiguration: URLSessionConfiguration? = nil) {
        self.configuration = configuration; self.services = services
        self.networkConfiguration = networkConfiguration
        credentialStore = configuration.origin.map { AuthCredentialStore(origin: $0) }
        super.init()
    }
    deinit { network.invalidateAndCancel() }
    private func credentials() throws -> [String: Any]? { try credentialStore?.read() }
    static func summary(_ value: Any?) throws -> [String: Any] {
        guard let value = value as? [String: Any], let authenticated = value["authenticated"] as? Bool else { throw PluginFailure("IO_ERROR", "Invalid authentication response") }
        if !authenticated { return ["authenticated": false] }
        guard let user = value["user"] as? [String: Any], let id = user["id"] as? String, !id.isEmpty, id.utf8.count <= 256,
              let name = user["name"] as? String, name.utf8.count <= 256,
              let expiry = value["expiresAt"] as? NSNumber, CFGetTypeID(expiry) != CFBooleanGetTypeID(), expiry.doubleValue.isFinite, expiry.doubleValue > 0 else { throw PluginFailure("IO_ERROR", "Invalid authentication response") }
        return ["authenticated": true, "user": ["id": id, "name": name], "expiresAt": expiry]
    }
    private func decorated(_ value: [String: Any]) -> [String: Any] {
        var result = value; result["configured"] = configuration.enabled; result["providers"] = configuration.providers; result["passkeys"] = configuration.passkeys; return result
    }
    private func finish(_ op: Operation, _ result: Result<Any, PluginFailure>) {
        guard operation === op else { return }; operation = nil
        op.timer?.cancel()
        // A rotating refresh must receive its bounded response even after the
        // UI request retires. Its replacement is checkpointed only if the old
        // refresh credential is still current; logout can never be resurrected.
        if !op.refreshing { op.task?.cancel() }
        op.browser?.cancel(); op.controller?.cancel()
        if let lease = op.lease { services?.release(lease) }
        op.completion(result)
    }
    func cancel(owner: String, requestID: String? = nil) {
        guard let op = operation, op.owner == owner, requestID == nil || op.requestID == requestID else { return }
        finish(op, .failure(PluginFailure("CANCELLED", "Authentication operation cancelled")))
    }
    private func begin(owner: String, requestID: String, interactive: Bool, presenter: UIViewController, completion: @escaping (Result<Any, PluginFailure>) -> Void) throws -> Operation {
        guard operation == nil, refreshInFlight == nil else { throw PluginFailure("BUSY", "Another authentication operation is in progress") }
        let op = Operation(owner: owner, requestID: requestID, completion: completion)
        if interactive {
            guard let window = presenter.viewIfLoaded?.window, window.windowScene?.activationState == .foregroundActive, presenter.presentedViewController == nil else { throw PluginFailure("UNAUTHORIZED", "Authentication requires a visible native presenter") }
            op.window = window; op.lease = try services?.acquire(owner: owner, requestID: requestID)
        }
        operation = op
        let timer = DispatchWorkItem { [weak self, weak op] in guard let self, let op else { return }; self.finish(op, .failure(PluginFailure("TIMEOUT", "Authentication did not complete"))) }
        op.timer = timer; DispatchQueue.main.asyncAfter(deadline: .now() + (interactive ? 115 : 60), execute: timer)
        return op
    }
    private func post(_ path: String, _ body: [String: Any], token: String? = nil, op: Operation, failure: ((PluginFailure) -> Void)? = nil, complete: @escaping ([String: Any], HTTPURLResponse) throws -> Void) {
        guard operation === op, let origin = configuration.origin, let url = URL(string: origin.absoluteString + "/api/auth/" + path + "/") else { return }
        do {
            var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body)
            guard request.httpBody!.count <= 65536 else { throw PluginFailure("QUOTA_EXCEEDED", "Authentication request exceeds limit") }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
            op.refreshing = path == "native/refresh"
            if op.refreshing { refreshInFlight = op.id }
            op.task = network.dataTask(with: request) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if path == "native/refresh", self.refreshInFlight == op.id { self.refreshInFlight = nil }
                    if path == "native/refresh", error == nil, let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode), response.url == url,
                       let data, data.count <= 131072, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let oldRefresh = body["refreshToken"] as? String, let current = try? self.credentials(), current["refreshToken"] as? String == oldRefresh {
                        // Do not publish an event or finish a retired request.
                        // A subsequent active callback reports storage failures.
                        _ = try? self.saveCredentials(value)
                    }
                    guard self.operation === op else { return }
                    do {
                        guard error == nil, let response = response as? HTTPURLResponse, response.url == url, let data, data.count <= 131072,
                              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw PluginFailure("IO_ERROR", "Authentication service is unavailable") }
                        guard (200...299).contains(response.statusCode) else {
                            // Never forward provider errors, callback codes, or tokens to JS.
                            throw PluginFailure(response.statusCode == 401 ? "UNAUTHORIZED" : response.statusCode == 409 ? "BUSY" : response.statusCode == 503 ? "UNAVAILABLE" : "IO_ERROR", "Authentication request was rejected")
                        }
                        try complete(object, response)
                    } catch let error as PluginFailure { if let failure { failure(error) } else { self.finish(op, .failure(error)) } }
                    catch { let error = PluginFailure("IO_ERROR", "Invalid authentication response"); if let failure { failure(error) } else { self.finish(op, .failure(error)) } }
                }
            }
            op.task?.resume()
        } catch let error as PluginFailure { if let failure { failure(error) } else { finish(op, .failure(error)) } }
        catch { let error = PluginFailure("IO_ERROR", "Authentication request failed"); if let failure { failure(error) } else { finish(op, .failure(error)) } }
    }
    private func token(_ value: Any?) throws -> String {
        guard let value = value as? String, value.utf8.count >= 16, value.utf8.count <= 16384, value.range(of: "^[A-Za-z0-9._~-]+$", options: .regularExpression) != nil else { throw PluginFailure("IO_ERROR", "Invalid native credential") }; return value
    }
    private func saveCredentials(_ value: [String: Any]) throws -> [String: Any] {
        let access = try token(value["accessToken"]), refresh = try token(value["refreshToken"]), session = try Self.summary(value["session"])
        guard session["authenticated"] as? Bool == true else { throw PluginFailure("UNAUTHORIZED", "Authentication did not establish a session") }
        try credentialStore?.write(["accessToken": access, "refreshToken": refresh, "session": session])
        return session
    }
    private func accept(_ value: [String: Any], op: Operation) throws {
        let session = try saveCredentials(value)
        changeSession(session, op: op) { [weak self] in self?.finish(op, .success(self?.decorated(session) ?? session)) }
    }
    private func changeSession(_ summary: [String: Any], op: Operation, completion: @escaping () -> Void) {
        let revision = services?.beginSessionChange(owner: op.owner) ?? 0
        let done = { [weak self] in
            guard let self else { return }
            self.services?.completeSessionChange(revision, owner: op.owner)
            guard self.operation === op else { return }
            self.services?.publish("auth.changed", summary); completion()
        }
        if let cookies = op.cookieStore { clearCookies(cookies, completion: done) } else { done() }
    }
    func run(action: String, args: [String: Any], owner: String, requestID: String, presenter: UIViewController, cookieStore: WKHTTPCookieStore, hostedOrigin: URL?, returnPath: String, completion: @escaping (Result<Any, PluginFailure>) -> Void) throws {
        if action == "auth.status", !configuration.enabled { completion(.success(decorated(["authenticated": false]))); return }
        guard configuration.enabled else { throw PluginFailure("UNAVAILABLE", "Native authentication is not configured") }
        if action == "auth.signOut", let previous = operation { finish(previous, .failure(PluginFailure("CANCELLED", "Signing out"))) }
        let op = try begin(owner: owner, requestID: requestID, interactive: ["auth.signIn", "auth.registerPasskey"].contains(action), presenter: presenter, completion: completion)
        op.cookieStore = cookieStore
        do {
            let saved = try credentials()
            switch action {
            case "auth.status":
                guard let saved else { finish(op, .success(decorated(["authenticated": false]))); return }
                session(saved, op: op)
            case "auth.signIn":
                guard saved == nil else { throw PluginFailure("BUSY", "Sign out before switching accounts") }
                // A native vault loss must not promote an old authenticated web
                // realm into a different user's session. Clear it and require
                // a fresh anonymous document before starting any provider flow.
                cookieStore.getAllCookies { [weak self] cookies in DispatchQueue.main.async {
                    guard let self, self.operation === op else { return }
                    if cookies.contains(where: { self.isSessionCookie($0) }) {
                        self.changeSession(["authenticated": false], op: op) {
                            self.finish(op, .failure(PluginFailure("UNAUTHORIZED", "Previous web session cleared; retry sign-in from the refreshed page")))
                        }
                        return
                    }
                    do {
                        if args["method"] as? String == "oauth" {
                            guard let provider = args["provider"] as? String, self.configuration.providers.contains(provider) else { throw PluginFailure("INVALID_REQUEST", "Provider is not approved") }
                            try self.oauth(provider, op: op)
                        } else { try self.passkey(register: false, saved: nil, op: op) }
                    } catch let error as PluginFailure { self.finish(op, .failure(error)) }
                    catch { self.finish(op, .failure(PluginFailure("IO_ERROR", "Sign-in could not start"))) }
                } }
            case "auth.registerPasskey": try passkey(register: true, saved: saved, op: op)
            case "auth.syncWebSession":
                guard let origin = configuration.origin, hostedOrigin == origin, let saved else { throw PluginFailure("UNAUTHORIZED", "A native session and matching hosted origin are required") }
                _ = saved
                let proof = try AuthEncoding.proof()
                authorizedPost("native/web-ticket", ["challenge": proof.challenge, "returnPath": returnPath], op: op) { [weak self] value, _ in
                    guard let self else { return }; let ticket = try self.token(value["ticket"])
                    self.authorizedPost("native/web-session", ["ticket": ticket, "verifier": proof.verifier], op: op) { [weak self] value, response in
                        guard let self else { return }; let summary = try Self.summary(value)
                        let cookie = try Self.sessionCookie(response, origin: origin)
                        let revision = self.services?.beginSessionChange(owner: op.owner) ?? 0
                        self.services?.awaitSessionRealms(revision) { [weak self] retirement in
                            guard let self, self.operation === op else { return }
                            guard case .success = retirement else { self.finish(op, .failure(PluginFailure("UNAVAILABLE", "Previous authentication document could not be retired"))); return }
                            cookieStore.setCookie(cookie) { [weak self] in DispatchQueue.main.async {
                                guard let self else { return }; self.services?.completeSessionChange(revision, owner: op.owner)
                                guard self.operation === op else { return }; self.finish(op, .success(["synchronized": true, "session": summary]))
                            } }
                        }
                    }
                }
            case "auth.signOut":
                // Clear local credentials even if remote revocation fails. Cookie
                // removal is restricted to our agreed cookie and service host.
                try credentialStore?.clear()
                let revision = services?.beginSessionChange(owner: op.owner) ?? 0
                clearCookies(cookieStore) { [weak self] in
                    guard let self else { return }; self.services?.completeSessionChange(revision, owner: op.owner)
                    guard self.operation === op else { return }
                    self.services?.publish("auth.changed", ["authenticated": false])
                    guard let saved else { self.finish(op, .success(["authenticated": false, "revoked": true])); return }
                    self.logout(saved, op: op)
                }
            default: throw PluginFailure("UNSUPPORTED", "Unknown authentication operation")
            }
        } catch let error as PluginFailure { finish(op, .failure(error)) }
        catch { finish(op, .failure(PluginFailure("IO_ERROR", "Authentication operation failed"))) }
    }
    private func session(_ saved: [String: Any], op: Operation, mayRefresh: Bool = true) {
        do {
            let access = try token(saved["accessToken"])
            post("native/session", [:], token: access, op: op, failure: { [weak self] error in
                guard let self, self.operation === op else { return }
                guard error.code == "UNAUTHORIZED" else { self.finish(op, .failure(error)); return }
                guard mayRefresh, let refresh = try? self.token(saved["refreshToken"]) else { self.invalidateSession(op); return }
                self.post("native/refresh", ["refreshToken": refresh], op: op, failure: { [weak self] error in
                    guard let self else { return }; if error.code == "UNAUTHORIZED" { self.invalidateSession(op) } else { self.finish(op, .failure(error)) }
                }) { [weak self] value, _ in
                    guard let self else { return }
                    // Persist the rotated credential before any subsequent request.
                    _ = try self.saveCredentials(value)
                    self.session(value, op: op, mayRefresh: false)
                }
            }) { [weak self] value, _ in
                guard let self else { return }; let summary = try Self.summary(value)
                self.finish(op, .success(self.decorated(summary)))
            }
        } catch let error as PluginFailure { finish(op, .failure(error)) }
        catch { finish(op, .failure(PluginFailure("IO_ERROR", "Native session unavailable"))) }
    }
    private func invalidateSession(_ op: Operation) {
        do { try credentialStore?.clear() } catch { finish(op, .failure(PluginFailure("IO_ERROR", "Could not clear expired native session"))); return }
        changeSession(["authenticated": false], op: op) { [weak self] in self?.finish(op, .success(self?.decorated(["authenticated": false]) ?? ["authenticated": false])) }
    }
    private func authorizedPost(_ path: String, _ body: [String: Any], op: Operation, mayRefresh: Bool = true, complete: @escaping ([String: Any], HTTPURLResponse) throws -> Void) {
        do {
            guard let saved = try credentials() else { throw PluginFailure("UNAUTHORIZED", "Native session is unavailable") }
            let access = try token(saved["accessToken"])
            post(path, body, token: access, op: op, failure: { [weak self] error in
                guard let self, self.operation === op else { return }
                guard error.code == "UNAUTHORIZED", mayRefresh, let refresh = try? self.token(saved["refreshToken"]) else { self.finish(op, .failure(error)); return }
                self.post("native/refresh", ["refreshToken": refresh], op: op) { [weak self] value, _ in
                    guard let self else { return }; _ = try self.saveCredentials(value)
                    self.authorizedPost(path, body, op: op, mayRefresh: false, complete: complete)
                }
            }, complete: complete)
        } catch let error as PluginFailure { finish(op, .failure(error)) }
        catch { finish(op, .failure(PluginFailure("IO_ERROR", "Native session unavailable"))) }
    }
    private func logout(_ saved: [String: Any], op: Operation) {
        // Convert transport/server failure to an explicit revocation result;
        // local signout has already completed and must not be rolled back.
        let callback = op.completion
        let replacement = Operation(owner: op.owner, requestID: op.requestID) { result in
            switch result { case .success: callback(.success(["authenticated": false, "revoked": true])); case .failure: callback(.success(["authenticated": false, "revoked": false])) }
        }
        op.timer?.cancel(); operation = replacement
        let timer = DispatchWorkItem { [weak self, weak replacement] in guard let self, let replacement else { return }; self.finish(replacement, .failure(PluginFailure("TIMEOUT", "Revocation pending"))) }
        replacement.timer = timer; DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: timer)
        func revoke(_ access: String, mayRefresh: Bool) {
            post("native/logout", [:], token: access, op: replacement, failure: { [weak self] error in
                guard let self, self.operation === replacement else { return }
                guard error.code == "UNAUTHORIZED", mayRefresh, let refresh = try? self.token(saved["refreshToken"]) else { self.finish(replacement, .failure(error)); return }
                self.post("native/refresh", ["refreshToken": refresh], op: replacement) { [weak self] value, _ in
                    guard let self else { return }; revoke(try self.token(value["accessToken"]), mayRefresh: false)
                }
            }) { [weak self] _, _ in self?.finish(replacement, .success(NSNull())) }
        }
        guard let access = try? token(saved["accessToken"]) else { finish(replacement, .failure(PluginFailure("IO_ERROR", "Native session unavailable"))); return }
        revoke(access, mayRefresh: true)
    }
    private func oauth(_ provider: String, op: Operation) throws {
        let proof = try AuthEncoding.proof()
        post("native/start", ["provider": provider, "challenge": proof.challenge, "callbackURL": "spahost-auth://callback"], op: op) { [weak self] value, _ in
            guard let self, let origin = self.configuration.origin, let raw = value["authorizationURL"] as? String, let url = URL(string: raw),
                  url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port, url.user == nil, url.password == nil, url.fragment == nil,
                  URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath == "/api/auth/oauth/authorize/" else { throw PluginFailure("UNAUTHORIZED", "Invalid authorization service URL") }
            let browser = ASWebAuthenticationSession(url: url, callbackURLScheme: "spahost-auth") { [weak self, weak op] callback, error in
                DispatchQueue.main.async {
                    guard let self, let op, self.operation === op else { return }
                    do {
                        guard error == nil, let callback else { throw PluginFailure("CANCELLED", "Sign-in cancelled") }
                        let code = try AuthEncoding.callbackCode(callback)
                        self.post("native/redeem", ["code": code, "verifier": proof.verifier], op: op) { [weak self] value, _ in try self?.accept(value, op: op) }
                    } catch let error as PluginFailure { self.finish(op, .failure(error)) }
                    catch { self.finish(op, .failure(PluginFailure("IO_ERROR", "Sign-in failed"))) }
                }
            }
            op.browser = browser; browser.presentationContextProvider = self
            guard browser.start() else { throw PluginFailure("UNAVAILABLE", "System authentication browser is unavailable") }
        }
    }
    private func passkey(register: Bool, saved: [String: Any]?, op: Operation) throws {
        guard configuration.passkeys, configuration.rpID != nil else { throw PluginFailure("UNAVAILABLE", "Passkeys require configured domain associations") }
        if register && saved == nil { throw PluginFailure("UNAUTHORIZED", "Sign in before registering a passkey") }
        op.registration = register
        let complete: ([String: Any], HTTPURLResponse) throws -> Void = { [weak self] value, _ in
            guard let self, let rp = self.configuration.rpID, let options = value["options"] as? [String: Any], let transaction = value["transaction"] as? String, transaction.utf8.count <= 512 else { throw PluginFailure("IO_ERROR", "Invalid passkey options") }
            op.transaction = transaction
            let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp)
            let challenge = try AuthEncoding.decode(options["challenge"], maximum: 1024)
            let request: ASAuthorizationRequest
            if register {
                guard let user = options["user"] as? [String: Any], let name = user["name"] as? String, name.utf8.count <= 256,
                      let relyingParty = options["rp"] as? [String: Any], relyingParty["id"] as? String == rp else { throw PluginFailure("IO_ERROR", "Invalid passkey registration options") }
                let registration = provider.createCredentialRegistrationRequest(challenge: challenge, name: name, userID: try AuthEncoding.decode(user["id"], maximum: 128))
                registration.userVerificationPreference = .required
                if let display = user["displayName"] as? String { registration.displayName = String(display.prefix(256)) }
                request = registration
            } else {
                guard options["rpId"] as? String == rp else { throw PluginFailure("UNAUTHORIZED", "Unexpected passkey relying party") }
                let assertion = provider.createCredentialAssertionRequest(challenge: challenge); assertion.userVerificationPreference = .required
                if let allowed = options["allowCredentials"] as? [[String: Any]] {
                    guard allowed.count <= 32 else { throw PluginFailure("QUOTA_EXCEEDED", "Too many passkey descriptors") }
                    assertion.allowedCredentials = try allowed.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: try AuthEncoding.decode($0["id"])) }
                }
                request = assertion
            }
            let controller = ASAuthorizationController(authorizationRequests: [request]); op.controller = controller
            controller.delegate = self; controller.presentationContextProvider = self; controller.performRequests()
        }
        if register { authorizedPost("passkeys/options", ["operation": "register"], op: op, complete: complete) }
        else { post("passkeys/options", ["operation": "authenticate"], op: op, complete: complete) }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { operation?.window ?? ASPresentationAnchor() }
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { operation?.window ?? ASPresentationAnchor() }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let op = operation, op.controller === controller, let transaction = op.transaction else { return }
        do {
            var credential: [String: Any]
            if let result = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
                credential = ["id": AuthEncoding.encode(result.credentialID), "rawId": AuthEncoding.encode(result.credentialID), "type": "public-key", "clientExtensionResults": [:], "response": ["clientDataJSON": AuthEncoding.encode(result.rawClientDataJSON), "authenticatorData": AuthEncoding.encode(result.rawAuthenticatorData), "signature": AuthEncoding.encode(result.signature), "userHandle": AuthEncoding.encode(result.userID)]]
            } else if let result = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration, let attestation = result.rawAttestationObject {
                credential = ["id": AuthEncoding.encode(result.credentialID), "rawId": AuthEncoding.encode(result.credentialID), "type": "public-key", "clientExtensionResults": [:], "response": ["clientDataJSON": AuthEncoding.encode(result.rawClientDataJSON), "attestationObject": AuthEncoding.encode(attestation), "transports": ["internal"]]]
            } else { throw PluginFailure("IO_ERROR", "Unexpected passkey credential") }
            let complete: ([String: Any], HTTPURLResponse) throws -> Void = { [weak self] value, _ in
                guard let self else { return }
                if op.registration { guard value["registered"] as? Bool == true else { throw PluginFailure("IO_ERROR", "Passkey registration failed") }; self.finish(op, .success(["registered": true])) }
                else { try self.accept(value, op: op) }
            }
            if op.registration { authorizedPost("passkeys/verify", ["transaction": transaction, "credential": credential], op: op, complete: complete) }
            else { post("passkeys/verify", ["transaction": transaction, "credential": credential], op: op, complete: complete) }
        } catch let error as PluginFailure { finish(op, .failure(error)) }
        catch { finish(op, .failure(PluginFailure("IO_ERROR", "Passkey verification failed"))) }
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let op = operation, op.controller === controller else { return }
        finish(op, .failure(PluginFailure((error as? ASAuthorizationError)?.code == .canceled ? "CANCELLED" : "UNAVAILABLE", "Passkey operation did not complete")))
    }
    static func sessionCookie(_ response: HTTPURLResponse, origin: URL) throws -> HTTPCookie {
        let debug = origin.scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(origin.host ?? "")
        let expected = debug ? "spa_dev_session" : "__Host-spa_session"
        guard response.url?.scheme == origin.scheme, response.url?.host == origin.host, response.url?.port == origin.port,
              let raw = response.value(forHTTPHeaderField: "Set-Cookie"), raw.utf8.count <= 8192,
              raw.range(of: "(?:^|;)\\s*Domain\\s*=", options: .caseInsensitive.union(.regularExpression)) == nil,
              raw.range(of: "(?:^|;)\\s*SameSite=Lax(?:;|$)", options: .caseInsensitive.union(.regularExpression)) != nil,
              let cookie = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": raw], for: origin).first,
              cookie.name == expected, cookie.domain.lowercased() == origin.host?.lowercased(), cookie.path == "/", cookie.isHTTPOnly, (debug || cookie.isSecure), !cookie.value.isEmpty else { throw PluginFailure("UNAUTHORIZED", "Invalid web session cookie") }
        return cookie
    }
    private func clearCookies(_ store: WKHTTPCookieStore, completion: @escaping () -> Void) {
        store.getAllCookies { cookies in
            let selected = cookies.filter { self.isSessionCookie($0) }
            let group = DispatchGroup()
            for cookie in selected { group.enter(); store.delete(cookie) { group.leave() } }
            group.notify(queue: .main, execute: completion)
        }
    }
    private func isSessionCookie(_ cookie: HTTPCookie) -> Bool {
        ["__Host-spa_session", "spa_dev_session"].contains(cookie.name) && cookie.domain.lowercased() == configuration.origin?.host?.lowercased()
    }
}
