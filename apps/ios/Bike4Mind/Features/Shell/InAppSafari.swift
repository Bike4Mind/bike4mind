import SafariServices
import SwiftUI

extension View {
  /// Shows `url` in an in-app Safari view. Used for pages on the app's own universal-link host: handing those
  /// to `openURL` can route them straight back into the app (and into `.web` again), while
  /// `SFSafariViewController` never follows universal links. Device verification is tracked in DEVICE_TESTING.md.
  func inAppSafari(url: Binding<URL?>) -> some View {
    fullScreenCover(
      item: Binding(
        get: { url.wrappedValue.flatMap(SafariPage.init) },
        set: { if $0 == nil { url.wrappedValue = nil } })
    ) { page in
      SafariView(url: page.url, onFinish: { url.wrappedValue = nil }).ignoresSafeArea()
    }
  }
}

private struct SafariPage: Identifiable {
  let url: URL
  var id: URL { url }

  /// `SFSafariViewController` raises on any other scheme.
  init?(url: URL) {
    guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
    self.url = url
  }
}

private struct SafariView: UIViewControllerRepresentable {
  let url: URL
  let onFinish: @MainActor () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

  func makeUIViewController(context: Context) -> SFSafariViewController {
    let controller = SFSafariViewController(url: url)
    controller.delegate = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}

  /// Done must clear the binding; otherwise SwiftUI still thinks the cover is up. UIKit calls the delegate on
  /// the main thread, but the protocol is not annotated, hence `@preconcurrency`.
  @MainActor
  final class Coordinator: NSObject, @preconcurrency SFSafariViewControllerDelegate {
    private let onFinish: @MainActor () -> Void

    init(onFinish: @escaping @MainActor () -> Void) {
      self.onFinish = onFinish
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
      onFinish()
    }
  }
}
