// Runs one GeoFlight benchmark scenario in a WKWebView window (the engine the
// Tauri app uses on macOS) and writes its JSON result and a screenshot.
// Usage: swift bench-webkit.swift <url> <out-dir> [width height]
import AppKit
import WebKit

@MainActor
final class Bench: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    let url: URL
    let out: URL
    let size: NSSize
    var window: NSWindow?
    var view: WKWebView?
    var activity: NSObjectProtocol?

    init(url: URL, out: URL, size: NSSize) {
        self.url = url
        self.out = out
        self.size = size
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "bench")
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        // Keep rendering at full rate while another app is in front of the window.
        if #available(macOS 14.0, *) { configuration.preferences.inactiveSchedulingPolicy = .none }
        let bounds = NSRect(origin: .zero, size: size)
        let view = WKWebView(frame: bounds, configuration: configuration)
        view.navigationDelegate = self
        // WebKit stops painting occluded windows; the benchmark must keep measuring.
        view.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        self.view = view
        let window = NSWindow(contentRect: bounds, styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "GeoFlight benchmark"
        window.contentView = view
        window.center()
        // Show without taking focus from whatever the user is doing.
        window.orderFrontRegardless()
        self.window = window
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "GeoFlight benchmark")
        view.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 420) {
            fputs("Benchmark timed out.\n", stderr)
            exit(1)
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "log":
            print("[bench] \(body["text"] ?? "")")
        case "error":
            fputs("[bench error] \(body["text"] ?? "")\n", stderr)
        case "snapshot":
            let name = body["name"] as? String ?? "snapshot"
            view?.takeSnapshot(with: nil) { image, _ in
                guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: self.out.appendingPathComponent("\(name).png"))
            }
        case "result":
            let name = body["name"] as? String ?? "result"
            if let result = body["result"], let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: out.appendingPathComponent("\(name).json"))
            }
        case "done":
            // Let a pending snapshot finish writing.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) }
        default:
            break
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        fputs("\(error)\n", stderr)
        exit(1)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fputs("WebKit content process exited (likely out of memory).\n", stderr)
        exit(2)
    }
}

MainActor.assumeIsolated {
    let args = CommandLine.arguments
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let width = args.count > 4 ? Double(args[3]) ?? 1600 : 1600
    let height = args.count > 4 ? Double(args[4]) ?? 960 : 960
    let bench = Bench(url: URL(string: args[1])!, out: URL(fileURLWithPath: args[2]), size: NSSize(width: width, height: height))
    app.delegate = bench
    app.run()
}
