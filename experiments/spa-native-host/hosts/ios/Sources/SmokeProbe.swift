#if DEBUG
import UIKit
import WebKit

/// Fixed local diagnostics activated only by native launch arguments. No eval API
/// or network listener is exposed to a document or remote process.
@MainActor
final class SmokeProbe {
    private weak var host: HostViewController?
    private let phase: String
    private let token: String
    private var checks = [[String: Any]]()
    init(host: HostViewController, phase: String, token: String) { self.host = host; self.phase = phase; self.token = token }
    func start() { Task { await run() } }
    private func evaluate(_ source: String) async throws -> Any {
        guard let host else { throw HostFailure("UNAVAILABLE", "Host disappeared") }
        return try await withCheckedThrowingContinuation { continuation in
            host.webView.callAsyncJavaScript(source, arguments: [:], in: nil, in: .page) { continuation.resume(with: $0) }
        }
    }
    private func wait(_ expression: String) async throws {
        let end = Date().addingTimeInterval(20)
        while Date() < end {
            if (try? await evaluate("return Boolean(" + expression + ")")) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw HostFailure("TIMEOUT", "Smoke condition timed out")
    }
    private func check(_ name: String, _ passed: Bool, value: Any = NSNull()) throws {
        checks.append(["name": name, "passed": passed, "value": value])
        if !passed { throw HostFailure("IO_ERROR", "Smoke assertion failed: " + name) }
    }
    private func run() async {
        var failure: String?
        do {
            try await wait("window.platform && document.readyState === 'complete'")
            let ready = try await evaluate("return (await platform.ready()).platform") as? String
            try check("real-webview-native-hello", ready == "ios", value: ready ?? "missing")
            let encodedToken = String(data: try JSONSerialization.data(withJSONObject: [token]), encoding: .utf8)!
            if phase == "read" {
                let restored = try await evaluate("return await platform.storage.get('physical-smoke')") as? String
                try check("acknowledged-storage-survives-process-relaunch", restored == token, value: restored ?? "missing")
            } else {
                _ = try await evaluate("await platform.storage.set('physical-smoke', " + encodedToken + "[0]); return true")
                let stored = try await evaluate("return await platform.storage.get('physical-smoke')") as? String
                try check("native-sqlite-read-after-commit", stored == token, value: stored ?? "missing")
                let invalid = try await evaluate("try { await platform.call('storage.set',{key:'rejected-smoke',value:'bad',extra:true}); return 'accepted'; } catch(e) { return e.code; }") as? String
                try check("native-argument-validation", invalid == "INVALID_REQUEST", value: invalid ?? "missing")
                _ = try await evaluate("await platform.navigation.present({screen:'native-demo'}); return true")
                try check("actual-native-sheet-presented", host?.presentedViewController is UINavigationController)
                _ = try await evaluate("await platform.navigation.dismiss(); return true")
                try check("actual-native-sheet-dismissed", host?.presentedViewController == nil)
                #if !targetEnvironment(simulator)
                _ = try await evaluate("await platform.haptics.impact({style:'light'}); return true")
                try check("native-haptic-api-invoked-not-perceived", host?.hapticInvocations == 1)
                #endif
                let nonce = try await evaluate("window.__smokeDocument = String(Math.random()); return window.__smokeDocument") as? String
                _ = try await evaluate("document.querySelector('a[href=\"/compose/\"]').click(); return true")
                try await wait("location.pathname === '/compose/'")
                let after = try await evaluate("return window.__smokeDocument") as? String
                try check("next-client-route-preserves-document", nonce != nil && after == nonce)
                let backDeadline = Date().addingTimeInterval(10)
                while host?.navigationItem.leftBarButtonItem?.isEnabled != true && Date() < backDeadline { try await Task.sleep(nanoseconds: 50_000_000) }
                try check("native-back-enabled-after-route-commit", host?.navigationItem.leftBarButtonItem?.isEnabled == true)
                _ = try await evaluate("await platform.navigation.back(); return true")
                try await wait("location.pathname === '/'")
                try check("native-coordinator-back-acknowledged", true)
            }
        } catch let error as HostFailure { failure = error.code + ": " + error.message }
        catch { failure = String(describing: error) }
        let report: [String: Any] = ["schemaVersion": 1, "phase": phase, "token": token, "pid": ProcessInfo.processInfo.processIdentifier, "passed": failure == nil, "checks": checks, "failure": failure as Any? ?? NSNull(), "evidence": "Fixed in-app WK/native probe; not independent OS touch or camera/perceived-haptic evidence"]
        let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let file = root.appendingPathComponent("spa-smoke-" + phase + ".json")
        if let bytes = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) { try? bytes.write(to: file, options: .atomic) }
        print("SPA_SMOKE_FINISHED phase=\(phase) passed=\(failure == nil)")
    }
}
#endif
