import B4MKit
import SwiftUI
import UIKit

/// Thin shell: loads the shared attachments, builds the capture stack and hosts `ShareComposerView`.
/// Everything with logic lives in B4MKit.
final class ShareViewController: UIViewController {
  private var host: UIHostingController<AnyView>?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    Task { await present() }
  }

  private func present() async {
    let staging = FileManager.default.temporaryDirectory.appending(path: "share-\(UUID().uuidString)")
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    let loaded = await ShareItemLoader().load(
      providers.map { ItemProviderAttachment(provider: $0, stagingDirectory: staging) })

    let content: AnyView
    if loaded.items.isEmpty {
      content = AnyView(
        ContentUnavailableView(
          "Nothing to save", systemImage: "tray",
          description: Text("Bike4Mind can't save this kind of item.")))
    } else {
      content = AnyView(composer(items: loaded.items))
    }
    show(content)
  }

  @MainActor
  private func composer(items: [ShareItem]) -> some View {
    let stack = Self.makeStack()
    return ShareComposerView(
      model: stack.composerModel(items: items),
      onFinish: { [weak self] in self?.complete() },
      onCancel: { [weak self] in self?.cancel() })
  }

  /// The extension shares the app's server choice, session and destination memory through the App Group
  /// and the shared keychain group (both fall back gracefully when unsigned, see B4MKit `SharedContainer`).
  @MainActor
  private static func makeStack() -> CaptureStack {
    #if DEBUG
      if ProcessInfo.processInfo.environment["B4M_UI_FIXTURES"] == "1" { return .fixture() }
    #endif
    #if DEBUG
      let environment = SharedServerEnvironment.store().load()
    #else
      let environment = ServerEnvironment.production
    #endif
    let auth = AuthController(
      environment: environment, tokenStore: KeychainTokenStore(accessGroup: KeychainAccessGroup.resolved()))
    auth.restore()
    return .live(
      baseURL: environment.baseURL, tokens: auth, ownIdentifier: BackgroundSessionIdentifier.shareExtension)
  }

  private func show(_ content: AnyView) {
    let controller = UIHostingController(rootView: content)
    addChild(controller)
    controller.view.frame = view.bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(controller.view)
    controller.didMove(toParent: self)
    host = controller
  }

  private func complete() {
    extensionContext?.completeRequest(returningItems: nil)
  }

  private func cancel() {
    extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
  }
}
