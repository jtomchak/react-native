import Foundation
import WebKit

// Removing a WKWebView from the hierarchy does not synchronously destroy its
// JavaScript realm. Commit an inert document and wait before changing cookies.
final class SessionRealmRetirement: NSObject, WKNavigationDelegate {
    private var web: WKWebView?
    private var navigation: WKNavigation?
    private var result: Result<Void, HostFailure>?
    private var waiters: [(Result<Void, HostFailure>) -> Void] = []
    private var timer: DispatchWorkItem?
    init(_ web: WKWebView) { self.web = web; super.init() }
    func wait(_ completion: @escaping (Result<Void, HostFailure>) -> Void) { if let result { completion(result) } else { waiters.append(completion) } }
    func start(_ completion: @escaping (Result<Void, HostFailure>) -> Void) {
        wait(completion)
        guard let web else { finish(.success(())); return }
        web.stopLoading(); web.configuration.userContentController.removeAllUserScripts()
        web.configuration.userContentController.removeScriptMessageHandler(forName: "spa")
        web.navigationDelegate = self; web.uiDelegate = nil
        navigation = web.loadHTMLString("<!doctype html><title>Session retired</title>", baseURL: nil)
        let timer = DispatchWorkItem { [weak self] in self?.finish(.failure(HostFailure("TIMEOUT", "Previous authentication document could not be retired"))) }
        self.timer = timer; DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timer)
    }
    private func finish(_ result: Result<Void, HostFailure>) {
        guard self.result == nil else { return }; self.result = result; timer?.cancel()
        web?.navigationDelegate = nil; web = nil
        let callbacks = waiters; waiters = []; callbacks.forEach { $0(result) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, preferences: WKWebpagePreferences, decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        preferences.allowsContentJavaScript = false
        decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel, preferences)
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { if self.navigation === navigation { finish(.success(())) } }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if self.navigation === navigation { finish(.failure(HostFailure("IO_ERROR", "Could not retire authentication document"))) } }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if self.navigation === navigation { finish(.failure(HostFailure("IO_ERROR", "Could not retire authentication document"))) } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(.success(())) }
}

