// wedgie.dev in a WKWebView, plus `window.wedgieDrive` for the page (only on wedgie.dev):
//   wedgieDrive.status()      -> {state: "unpicked"|"away"|"here", name}
//   wedgieDrive.send(line)    -> the REQ file name it wrote (one JSON request; an "id" is added if missing)
//   wedgieDrive.list()        -> [{name, size}]
//   wedgieDrive.read(name)    -> the file's text, or null
//   wedgieDrive.panel()       -> opens the app's drive panel (where the person picks the drive)
// The page can tell it's in the app by window.wedgieDrive (or "wedgie-app" in the user agent).
import SwiftUI
import WebKit

let home = URL(string: "https://wedgie.dev/")!

private let bridgeJS = """
(() => {
  const call = (op, arg) => window.webkit.messageHandlers.wedgieDrive.postMessage({ op, arg });
  window.wedgieDrive = {
    status: () => call("status"),
    send: (line) => call("send", typeof line === "string" ? line : JSON.stringify(line)),
    list: () => call("list"),
    read: (name) => call("read", name),
    panel: () => call("panel"),
  };
  window.dispatchEvent(new Event("wedgiedrive"));
})();
"""

struct WebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.applicationNameForUserAgent = "wedgie-app"
        cfg.allowsInlineMediaPlayback = true
        cfg.userContentController.addUserScript(WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "wedgieDrive")

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.uiDelegate = context.coordinator
        wv.navigationDelegate = context.coordinator
        wv.allowsBackForwardNavigationGestures = true
        wv.scrollView.refreshControl = {
            let r = UIRefreshControl()
            r.addAction(UIAction { [weak wv, weak r] _ in wv?.reload(); r?.endRefreshing() }, for: .valueChanged)
            return r
        }()
        wv.load(URLRequest(url: home))
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
        /// A wallet link (rainbow://...) opens the wallet a moment late: WalletConnect sends the request and opens the
        /// wallet at the same time, and once this app is behind the wallet its page stops, request half sent.
        /// The wallet then sat for a minute before it could sign (Austin, 10-10).
        static func openOutside(_ u: URL) {
            if u.scheme?.hasPrefix("http") == true { return UIApplication.shared.open(u) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { UIApplication.shared.open(u) }
        }

        static func ours(_ host: String?) -> Bool {
            guard let h = host?.lowercased() else { return false }
            return h == "wedgie.dev" || h.hasSuffix(".wedgie.dev")
        }

        @MainActor
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                                   replyHandler: @escaping (Any?, String?) -> Void) {
            guard Self.ours(message.frameInfo.securityOrigin.host),
                  let body = message.body as? [String: Any], let op = body["op"] as? String else {
                return replyHandler(nil, "not allowed")
            }
            let arg = body["arg"] as? String
            let drive = Drive.shared
            Task { @MainActor in
                do {
                    switch op {
                    case "status":
                        replyHandler(["state": drive.state.rawValue, "name": drive.name], nil)
                    case "send":
                        guard let arg, let file = await drive.send(arg) else { return replyHandler(nil, "send failed") }
                        replyHandler(file, nil)
                    case "list":
                        replyHandler(try await drive.io.list().map { ["name": $0.name, "size": $0.size] }, nil)
                    case "read":
                        replyHandler(try await drive.io.read(arg ?? "ANSWER.TXT"), nil)
                    case "panel":
                        drive.showPanel = true
                        replyHandler(true, nil)
                    default:
                        replyHandler(nil, "unknown op \(op)")
                    }
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }
        }

        // window.open / target=_blank → Safari.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let u = navigationAction.request.url, u.scheme != nil, u.scheme != "about" { Self.openOutside(u) }   // a site, or a wallet (rainbow://)
            return nil
        }

        // A tapped link off wedgie.dev goes to Safari; the site itself stays here.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // A wallet's own link (rainbow://, metamask://, wc:): WalletConnect opening the wallet app.
            if let u = navigationAction.request.url, let sch = u.scheme?.lowercased(),
               !["http", "https", "about", "blob", "data", "javascript"].contains(sch) {
                Self.openOutside(u)
                return decisionHandler(.cancel)
            }
            if navigationAction.navigationType == .linkActivated,
               let u = navigationAction.request.url, u.scheme?.hasPrefix("http") == true, !Self.ours(u.host) {
                UIApplication.shared.open(u)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            present(UIAlertController(title: nil, message: message, preferredStyle: .alert), ok: { completionHandler() })
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            present(a, ok: { completionHandler(true) })
        }

        private func present(_ a: UIAlertController, ok: @escaping () -> Void) {
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in ok() })
            let root = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow?.rootViewController }.first
            var top = root
            while let p = top?.presentedViewController { top = p }
            guard let top else { return ok() }
            top.present(a, animated: true)
        }
    }
}
