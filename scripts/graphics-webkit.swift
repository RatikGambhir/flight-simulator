import AppKit
import WebKit

@MainActor
final class GraphicsTest: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    let url: URL
    var window: NSWindow?

    init(url: URL) { self.url = url }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "graphics")
        let bounds = NSRect(x: 0, y: 0, width: 520, height: 520)
        let view = WKWebView(frame: bounds, configuration: configuration)
        view.navigationDelegate = self
        window = NSWindow(contentRect: bounds, styleMask: [.titled], backing: .buffered, defer: false)
        window?.title = "GeoFlight graphics test"
        window?.contentView = view
        window?.orderFront(nil)
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        DispatchQueue.main.asyncAfter(deadline: .now() + 55) {
            fputs("Graphics test timed out waiting for WebKit.\n", stderr)
            exit(1)
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any], let name = body["snapshot"] as? String,
           let encoded = body["data"] as? String, let data = Data(base64Encoded: encoded) {
            try? data.write(to: url.deletingLastPathComponent().appendingPathComponent("\(name).png"))
            return
        }
        guard let body = message.body as? [String: Any], let passed = body["passed"] as? Bool else {
            fputs("Unexpected WebKit graphics test result.\n", stderr)
            exit(1)
        }
        for result in body["results"] as? [String] ?? [] { print("PASS \(result)") }
        if let error = body["error"] as? String { fputs("\(error)\n", stderr) }
        exit(passed ? 0 : 1)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        fputs("\(error)\n", stderr)
        exit(1)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fputs("WebKit graphics test content process exited.\n", stderr)
        exit(1)
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let test = GraphicsTest(url: URL(fileURLWithPath: CommandLine.arguments[1]))
    app.delegate = test
    app.run()
}
