import Foundation
import LocalAuthentication

/// The optional App Lock check. Biometrics unlock the UI; they are not a sign-in factor.
public protocol BiometricGate: Sendable {
  func canEvaluate() -> Bool
  func evaluate(reason: String) async -> Bool
}

public struct LocalAuthenticationGate: BiometricGate {
  public init() {}

  /// `.deviceOwnerAuthentication` falls back to the passcode, so a failed Face ID never locks the user out.
  public func canEvaluate() -> Bool {
    LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
  }

  public func evaluate(reason: String) async -> Bool {
    do {
      return try await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
    } catch {
      return false
    }
  }
}
