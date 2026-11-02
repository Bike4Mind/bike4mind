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
