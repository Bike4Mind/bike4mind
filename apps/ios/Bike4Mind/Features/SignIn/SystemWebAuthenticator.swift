import AuthenticationServices
import B4MKit
import SwiftUI

/// Adapts SwiftUI's `WebAuthenticationSession` (backed by `ASWebAuthenticationSession`) to B4MKit.
/// The https callback form needs iOS 17.4 and the `webcredentials:` associated domain.
struct SystemWebAuthenticator: WebAuthenticating {
  let session: WebAuthenticationSession

  func authenticate(url: URL, callbackURL: URL) async throws -> URL {
    guard let host = callbackURL.host() else { throw AuthError.invalidCallback }
    do {
      return try await session.authenticate(
        using: url,
        callback: .https(host: host, path: callbackURL.path()),
        // Shared session so an existing web SSO login on this device is reused.
        preferredBrowserSession: .shared,
        additionalHeaderFields: [:]
      )
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      throw AuthError.cancelled
    } catch is ASWebAuthenticationSessionError {
      // presentationContextNotProvided / presentationContextInvalid: the sheet never appeared.
      throw AuthError.webSessionFailedToStart
    }
  }
}
