import Foundation
import WebKit

/// 自定义 scheme：`viewer://local/...` 提供 bundle 内查看器资源，
/// `viewer://files/<绝对路径>` 代理读取本地模型文件。
/// 彻底绕开 WKWebView 对 file:// 协议的 ES 模块 / fetch 限制。
final class ViewerSchemeHandler: NSObject, WKURLSchemeHandler {

    static let scheme = "viewer"
    private let baseURL: URL

    init(baseURL: URL) {
        self.baseURL = baseURL.standardizedFileURL
        super.init()
    }

    /// 把本地文件路径转成 viewer://files URL
    static func filesURL(for fileURL: URL) -> URL {
        let encoded = fileURL.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? fileURL.path
        return URL(string: "viewer://files\(encoded)")!
    }

    static func register(into config: WKWebViewConfiguration, viewerResourceDir: URL) {
        config.setURLSchemeHandler(ViewerSchemeHandler(baseURL: viewerResourceDir),
                                   forURLScheme: scheme)
    }

    static var pageURL: URL { URL(string: "viewer://local/index.html")! }

    // MARK: - WKURLSchemeHandler

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return fail(task) }

        let file: URL
        if url.host == "files" {
            file = URL(fileURLWithPath: url.path)
        } else {
            let rel = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
            let candidate = baseURL.appendingPathComponent(rel).standardizedFileURL
            guard candidate.path.hasPrefix(baseURL.path) else { return fail(task) }
            file = candidate
        }

        guard let data = try? Data(contentsOf: file) else { return fail(task) }

        let mime: String
        switch url.pathExtension.lowercased() {
        case "html": mime = "text/html"
        case "js", "mjs": mime = "text/javascript"
        case "css": mime = "text/css"
        case "wasm": mime = "application/wasm"
        case "json": mime = "application/json"
        case "png": mime = "image/png"
        case "jpg", "jpeg": mime = "image/jpeg"
        case "webp": mime = "image/webp"
        case "ktx2": mime = "image/ktx2"
        case "bin": mime = "application/octet-stream"
        default: mime = "application/octet-stream"
        }

        // HTTPURLResponse + CORS 头：页面 polyfill 的 XHR 需要（跨 host 到 viewer://files）
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": mime,
                                                      "Access-Control-Allow-Origin": "*",
                                                      "Cache-Control": "no-cache"]) ?? URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8")
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask) {
        task.didFailWithError(NSError(domain: "ViewerScheme", code: 404,
                                      userInfo: [NSLocalizedDescriptionKey: "resource not found"]))
    }
}
