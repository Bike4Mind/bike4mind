import Foundation

/// An OAuth client the app signs in as. Each must stay in sync with its server-side OAuthClient
/// registration, whose redirect URI is checked by exact match.
public struct OAuthConfiguration: Sendable, Equatable {
  public var clientID: String
  public var redirectURI: URL
  public var scope: String

  public init(clientID: String, redirectURI: URL, scope: String) {
    self.clientID = clientID
    self.redirectURI = redirectURI
    self.scope = scope
  }

  /// The first-party client, on a claimed https universal link. Needs a signed build with the associated domain
  /// and the apple-app-site-association file on app.bike4mind.com. The only client production knows.
  public static let iosApp = OAuthConfiguration(
    clientID: "b4m-ios-app",
    redirectURI: URL(string: "https://app.bike4mind.com/ios/auth-callback")!,
    scope: "openid email profile"
  )

  /// Development client on a private-use scheme (RFC 8252 section 7.1), so unsigned simulator builds can sign in.
  /// A separate client because any app can claim a custom scheme: it must never carry the first-party client's
  /// auto-approved consent, so the server registers it on non-production deploys only.
  public static let iosAppDevelopment = OAuthConfiguration(
    clientID: "b4m-ios-app-dev",
    redirectURI: URL(string: "com.bike4mind.app://auth-callback")!,
    scope: iosApp.scope
  )

  /// The client a DEBUG build uses: production only ever sees `iosApp`; any other server gets the development client.
  public static func debugBuild(for environment: ServerEnvironment) -> OAuthConfiguration {
    environment == .production ? .iosApp : .iosAppDevelopment
  }
}
