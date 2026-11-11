import Foundation

public enum AuthError: Error, Equatable, Sendable {
  /// No session exists; the user has to sign in.
  case signedOut
  /// The user dismissed the sign-in sheet.
  case cancelled
  /// The system web-auth sheet ended before anyone could use it (see `StartFailureDetectingAuthenticator`).
  case webSessionFailedToStart
  case authorizationDenied
  case authorizationFailed(code: String)
  /// The callback's `state` did not match the request: possible injection, never accept the code.
  case stateMismatch
  case invalidCallback
  case tokenExchangeFailed(status: Int, code: String?)
  /// The server refused the refresh token (revoked, expired or replayed past the grace window). The session is over.
  case refreshRejected
  /// Too many refresh attempts; retryable later, the session is still valid.
  case rateLimited
  case server(status: Int)
  case invalidResponse
}
