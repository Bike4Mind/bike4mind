import Foundation

/// What a screen can act on when an API call fails. Generated per-operation response enums are
/// collapsed into this once, in `APIClient`, so views never switch over generated types.
public enum APIError: Error, Equatable, Sendable {
  /// The session is over (a refresh was rejected or the server answered 401 to a fresh token).
  /// `AuthController` has already moved to the signed-out state.
  case signedOut
  case forbidden
  case notFound
  case rateLimited
  case server(status: Int)
  /// The device could not reach the server.
  case offline
  /// The server answered, but not with a body this client understands.
  case malformedResponse

  public var isRetryable: Bool {
    switch self {
    case .offline, .rateLimited, .server: true
    case .signedOut, .forbidden, .notFound, .malformedResponse: false
    }
  }
}

extension APIError {
  init(status: Int) {
    switch status {
    case 401: self = .signedOut
    case 403: self = .forbidden
    case 404: self = .notFound
    case 429: self = .rateLimited
    default: self = .server(status: status)
    }
  }
}

extension APIError {
  /// Token-layer failures as a screen sees them. Only a session the server ended reads as signed out.
  init(_ authError: AuthError) {
    switch authError {
    case .rateLimited: self = .rateLimited
    case .server(let status): self = .server(status: status)
    case .invalidResponse: self = .malformedResponse
    case .signedOut, .refreshRejected, .cancelled, .authorizationDenied, .authorizationFailed, .stateMismatch,
      .invalidCallback, .tokenExchangeFailed:
      self = .signedOut
    }
  }

  /// The Keychain is not readable yet (launched before first unlock). Surfaced as retryable `.offline`:
  /// the session is intact and the call works once the device is unlocked.
  init(_ keychainError: KeychainError) {
    self = keychainError.isTransient ? .offline : .malformedResponse
  }
}
