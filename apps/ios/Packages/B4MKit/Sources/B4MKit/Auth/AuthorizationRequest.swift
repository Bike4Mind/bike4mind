import Foundation

/// One PKCE authorization attempt: the URL to open in the web sheet plus the secrets needed to
/// validate its callback and redeem the code.
public struct AuthorizationRequest: Sendable {
  public let url: URL
  public let state: String
  public let pkce: PKCEPair
  public let configuration: OAuthConfiguration

  public init(
    baseURL: URL,
    configuration: OAuthConfiguration,
    pkce: PKCEPair = .generate(),
    state: String? = nil
  ) {
    let state = state ?? randomURLSafeString(byteCount: 16)
    self.state = state
    self.pkce = pkce
    self.configuration = configuration

    // /oauth/authorize is the web app's consent page, not an API route: it bounces through the
    // normal web login (OTC, SSO, MFA) and redirects back with ?code=&state=.
    var components = URLComponents(
      url: baseURL.appending(path: "oauth/authorize"),
      resolvingAgainstBaseURL: false
    )!
    components.queryItems = [
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "client_id", value: configuration.clientID),
      URLQueryItem(name: "redirect_uri", value: configuration.redirectURI.absoluteString),
      URLQueryItem(name: "scope", value: configuration.scope),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "code_challenge", value: pkce.challenge),
      URLQueryItem(name: "code_challenge_method", value: pkce.method),
    ]
    self.url = components.url!
  }

  /// Validates the redirect the web sheet returned and extracts the authorization code.
  public func authorizationCode(from callbackURL: URL) throws -> String {
    guard
      let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
      callbackURL.host() == configuration.redirectURI.host(),
      callbackURL.path() == configuration.redirectURI.path()
    else {
      throw AuthError.invalidCallback
    }
    let items = components.queryItems ?? []
    func value(_ name: String) -> String? { items.first { $0.name == name }?.value }

    guard value("state") == state else {
      throw AuthError.stateMismatch
    }
    if let error = value("error") {
      throw error == "access_denied" ? AuthError.authorizationDenied : AuthError.authorizationFailed(code: error)
    }
    guard let code = value("code"), !code.isEmpty else {
      throw AuthError.invalidCallback
    }
    return code
  }
}
