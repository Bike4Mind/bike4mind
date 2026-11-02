import Foundation

/// The slice of `AuthController` the API layer needs. A protocol so tests drive the 401 path
/// without a Keychain or a refresh endpoint.
public protocol AccessTokenProviding: Sendable {
  /// A bearer token valid right now, refreshing if needed.
  func accessToken() async throws -> String
  /// The server rejected the token that `accessToken()` last returned: drop it so the next call refreshes.
  func invalidateAccessToken() async
  /// The server rejected a freshly minted token: the session is dead.
  func sessionRejected() async
}
