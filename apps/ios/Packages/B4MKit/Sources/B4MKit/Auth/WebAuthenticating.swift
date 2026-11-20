import Foundation

/// Presents the system web-auth sheet. The app adapts SwiftUI's `WebAuthenticationSession`
/// (an `ASWebAuthenticationSession`) to this; tests script the callback URL.
@MainActor
public protocol WebAuthenticating {
  /// Opens `url` and returns the URL the server redirected to once it matches `callbackURL`'s host and path.
  /// Throws `AuthError.cancelled` when the user dismisses the sheet.
  func authenticate(url: URL, callbackURL: URL) async throws -> URL
}
