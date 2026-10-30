import Foundation

/// The OAuth client the app signs in as. Must stay in sync with the server-side
/// `b4m-ios-app` OAuthClient registration (first-party, universal-link redirect).
public struct OAuthConfiguration: Sendable, Equatable {
  public var clientID: String
  /// Universal link, so it stays on app.bike4mind.com even when a DEBUG build targets another server.
  public var redirectURI: URL
  public var scope: String

  public init(clientID: String, redirectURI: URL, scope: String) {
    self.clientID = clientID
    self.redirectURI = redirectURI
    self.scope = scope
  }

  public static let iosApp = OAuthConfiguration(
    clientID: "b4m-ios-app",
    redirectURI: URL(string: "https://app.bike4mind.com/ios/auth-callback")!,
    scope: "openid email profile"
  )
}
