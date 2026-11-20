import B4MKit

extension AuthError {
  /// `nil` when the error needs no message (the user cancelled on purpose).
  var userMessage: String? {
    switch self {
    case .cancelled:
      nil
    case .webSessionFailedToStart:
      "Sign-in could not start on this device. Please try again."
    case .authorizationDenied:
      "Access was not granted. Try signing in again."
    case .stateMismatch, .invalidCallback:
      "Sign-in could not be verified. Please try again."
    case .rateLimited:
      "Too many attempts. Wait a moment and try again."
    case .signedOut, .refreshRejected:
      "Your session ended. Please sign in again."
    case .authorizationFailed, .tokenExchangeFailed, .server, .invalidResponse:
      "Bike4Mind could not complete sign-in. Please try again."
    }
  }
}
