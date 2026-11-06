import Foundation
import WebKit
import UniformTypeIdentifiers

final class Assets: NSObject, WKURLSchemeHandler {
    let root: URL
    let photos: URL
    init(root: URL, photos: URL) { self.root = root; self.photos = photos }
    static func safePath(_ url: URL) -> String? {
        guard url.scheme == "spa", url.host == "app", url.user == nil, url.password == nil, url.port == nil,
              let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath,
              let path = raw.removingPercentEncoding,
              !path.contains("\\"), !path.contains("\0"), !path.contains("%"),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        return path
    }
    static func photoHandle(_ string: String) -> Bool {
        guard string.count == 36, let uuid = UUID(uuidString: string) else { return false }
        return uuid.uuidString.lowercased() == string.lowercased()
    }
    func resource(_ url: URL) -> URL? {
        guard let path = Self.safePath(url) else { return nil }
        let file: URL
        let base: URL
        if path.hasPrefix("/__photos/") {
            let name = String(path.dropFirst("/__photos/".count))
            guard name.hasSuffix(".jpg"), Self.photoHandle(String(name.dropLast(4))) else { return nil }
            base = photos
            file = base.appendingPathComponent(name)
        } else {
            base = root
            let relative = path.hasSuffix("/") ? path + "index.html" : path
            file = base.appendingPathComponent(String(relative.drop(while: { $0 == "/" })))
        }
        let resolved = file.resolvingSymlinksInPath().standardizedFileURL
        guard resolved.path.hasPrefix(base.resolvingSymlinksInPath().standardizedFileURL.path + "/"),
              (try? resolved.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
        return resolved
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, let file = resource(url), let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist)); return
        }
        let ext = file.pathExtension
        let mime: String
        switch ext {
        case "js", "mjs": mime = "application/javascript"
        case "css": mime = "text/css"
        case "html": mime = "text/html"
        case "json": mime = "application/json"
        case "txt": mime = "text/plain"
        default: mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime + (["html", "js", "mjs", "json", "css", "txt"].contains(ext) ? "; charset=utf-8" : ""), "Content-Length": String(data.count), "Cache-Control": "no-store"])!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
