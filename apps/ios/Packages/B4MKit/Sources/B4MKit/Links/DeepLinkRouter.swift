import Foundation

/// Maps `https://app.bike4mind.com/...` URLs (universal links, notification payload `deepLink`s) to
/// in-app routes. Pure and synchronous, so the whole matrix is unit-testable.
public enum DeepLinkRouter {
  /// The only host whose links this app claims (matches the `applinks:` entitlement).
  public static let appHost = "app.bike4mind.com"

  /// - Returns: `nil` for anything that is not an https link to `appHost`. A link to the app host with
  ///   no native screen becomes `.web(url)`, so it opens in Safari instead of doing nothing.
  public static func route(url: URL) -> Route? {
    guard url.scheme?.lowercased() == "https",
      url.host()?.lowercased() == appHost,
      url.user() == nil, url.password() == nil
    else { return nil }

    let segments = url.pathComponents.filter { $0 != "/" }
    guard let first = segments.first?.lowercased() else { return .sessions }
    let identifier = segments.dropFirst().first

    switch first {
    // The web app (and the server's push deep links) call a session a notebook.
    case "sessions", "notebooks":
      guard let identifier else { return .sessions }
      return isValidIdentifier(identifier) ? .session(id: identifier) : .web(url)
    case "lakes":
      guard let identifier else { return .lakes }
      return isValidIdentifier(identifier) ? .lake(id: identifier) : .web(url)
    case "media":
      return .media
    case "settings":
      return .settings
    default:
      return .web(url)
    }
  }

  /// Server ids are Mongo object ids today; accept any conservative slug so a format change is not an outage,
  /// but never let path punctuation through into a navigation value.
  static func isValidIdentifier(_ value: String) -> Bool {
    guard !value.isEmpty, value.count <= 64 else { return false }
    return value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
  }
}
