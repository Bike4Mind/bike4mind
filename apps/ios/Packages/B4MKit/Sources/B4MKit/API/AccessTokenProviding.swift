import Foundation

/// The slice of `AuthController` the API layer needs. A protocol so tests drive the 401 path
/// without a Keychain or a refresh endpoint.
public protocol AccessTokenProviding: Sendable {
  /// A bearer token valid right now, refreshing if needed.
  func accessToken() async throws -> String
  /// The server rejected `token` (one `accessToken()` returned): drop it, if it is still the current one,
  /// so the next call refreshes.
  func invalidateAccessToken(_ token: String) async
  /// The server rejected a freshly minted token: the session is dead.
  func sessionRejected() async
}
