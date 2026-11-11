import Foundation

/// The OAuth client the app signs in as. Must stay in sync with the server-side
/// `b4m-ios-app` OAuthClient registration, which lists both redirect URIs below (exact match).
public struct OAuthConfiguration: Sendable, Equatable {
  public var clientID: String
  /// Fixed per build, never per server: a DEBUG build pointed at staging still redirects here.
  public var redirectURI: URL
  public var scope: String

  public init(clientID: String, redirectURI: URL, scope: String) {
    self.clientID = clientID
    self.redirectURI = redirectURI
    self.scope = scope
  }

  /// Release: a claimed https universal link. Needs a signed build with the associated domain and the
  /// apple-app-site-association file served from app.bike4mind.com.
  public static let iosApp = OAuthConfiguration(
    clientID: "b4m-ios-app",
    redirectURI: URL(string: "https://app.bike4mind.com/ios/auth-callback")!,
    scope: "openid email profile"
  )

  /// DEBUG: a private-use URI scheme (RFC 8252 section 7.1), so unsigned simulator builds can sign in.
  /// PKCE binds the code to this app's verifier, so another app claiming the scheme gains nothing.
  public static let iosAppDevelopment = OAuthConfiguration(
    clientID: iosApp.clientID,
    redirectURI: URL(string: "com.bike4mind.app://auth-callback")!,
    scope: iosApp.scope
  )
}
