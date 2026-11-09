import B4MKit
import Foundation

/// Where a tap on a widget lands. These are the same https links `DeepLinkRouter` already routes, so a
/// widget needs no URL scheme of its own.
enum WidgetDestination {
  static func session(_ id: String) -> URL { link("sessions/\(id)") }
  /// The web app's canonical notebook link, which `DeepLinkRouter` maps to the session; a Live Activity uses
  /// it so the same URL still works in Safari when the app is not installed.
  static func notebook(_ id: String) -> URL { link("notebooks/\(id)") }
  static var sessions: URL { link("sessions") }
  static var media: URL { link("media") }
  static var settings: URL { link("settings") }

  private static func link(_ path: String) -> URL {
    // An id with a space or '%' makes `URL(string:)` return nil; fall back to the app root rather than crash.
    URL(string: "https://\(DeepLinkRouter.appHost)/\(path)") ?? URL(string: "https://\(DeepLinkRouter.appHost)/")!
  }
}
