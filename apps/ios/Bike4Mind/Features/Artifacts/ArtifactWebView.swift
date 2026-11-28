import B4MKit
import SwiftUI
import WebKit

/// Renders sanitized artifact HTML. Hardening, beyond the Content-Security-Policy `ArtifactWebDocument` installs:
/// an ephemeral website data store (no cookies or storage shared with anything else), no script message
/// handlers (so the page has no bridge into the app), no navigation away from the loaded document, and
/// links tapped inside it open in the system browser instead of in this view.
struct ArtifactWebView: UIViewRepresentable {
  let html: String
  let onOpenLink: (URL) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onOpenLink: onOpenLink) }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = .all
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.scrollView.backgroundColor = .clear
    webView.allowsBackForwardNavigationGestures = false
    return webView
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    guard context.coordinator.loadedHTML != html else { return }
    context.coordinator.loadedHTML = html
    context.coordinator.onOpenLink = onOpenLink
    // A nil base URL gives the document an opaque origin, so it cannot reach app or server resources.
    webView.loadHTMLString(html, baseURL: nil)
  }

  final class Coordinator: NSObject, WKNavigationDelegate {
    var loadedHTML: String?
    var onOpenLink: (URL) -> Void

    init(onOpenLink: @escaping (URL) -> Void) {
      self.onOpenLink = onOpenLink
    }

    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
      // Only our own loadHTMLString (about:blank) may load in this view; everything else is a navigation
      // the artifact asked for.
      guard navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url else {
        decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel)
        return
      }
      if let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" { onOpenLink(url) }
      decisionHandler(.cancel)
    }
  }
}
