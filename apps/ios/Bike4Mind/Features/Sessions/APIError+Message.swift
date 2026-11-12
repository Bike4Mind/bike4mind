import B4MKit

extension APIError {
  /// User-facing copy. Signed-out never reaches a screen (the root view swaps to sign-in), but the
  /// switch stays exhaustive so a new case forces a decision here.
  var message: String {
    switch self {
    case .offline: "You appear to be offline. Check your connection and try again."
    case .rateLimited: "Too many requests. Wait a moment and try again."
    case .server: "Bike4Mind had a problem. Try again in a moment."
    case .notFound: "This item no longer exists."
    case .forbidden: "You don't have access to this."
    case .signedOut: "Your session ended. Sign in again."
    case .malformedResponse: "Bike4Mind sent something this version of the app can't read. Try updating the app."
    case .upgradeRequired: "This version of the app is no longer supported. Update Bike4Mind to continue."
    }
  }
}
