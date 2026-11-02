import B4MKit
import Foundation

/// Where a tap on a widget lands. These are the same https links `DeepLinkRouter` already routes, so a
/// widget needs no URL scheme of its own.
enum WidgetDestination {
  static func session(_ id: String) -> URL { link("sessions/\(id)") }
  static var sessions: URL { link("sessions") }
  static var media: URL { link("media") }
  static var settings: URL { link("settings") }

  private static func link(_ path: String) -> URL {
    URL(string: "https://\(DeepLinkRouter.appHost)/\(path)")!
  }
}
