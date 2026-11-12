import Foundation
import Observation

/// Drives the "Confirm it's you" sheet: loads the usable methods, collects one proof and reports success
/// through `didVerify`, which the caller uses to retry whatever the step-up gate refused.
@MainActor
@Observable
public final class StepUpViewModel {
  public enum Phase: Equatable, Sendable {
    case loading
    case loadFailed(APIError)
    /// The account has no method this app can collect (for example a passkey-only user).
    case noMethodAvailable
    case ready
    case verified
  }

  public private(set) var phase: Phase = .loading
  public private(set) var methods: [StepUpMethod] = []
  public private(set) var selectedMethod: StepUpMethod?
  /// Set once an emailed code is on its way; the code field replaces the "Send code" button.
  public private(set) var pendingToken: String?
  public private(set) var isSendingCode = false
  public private(set) var isSubmitting = false
  public private(set) var errorMessage: String?

  public var password = ""
  public var code = ""

  @ObservationIgnored private let api: any StepUpAPI
  @ObservationIgnored private let didVerify: @MainActor () async -> Void
  @ObservationIgnored private let now: @Sendable () -> Date

  public init(
    api: any StepUpAPI, now: @escaping @Sendable () -> Date = { Date() },
    didVerify: @escaping @MainActor () async -> Void
  ) {
    self.api = api
    self.now = now
    self.didVerify = didVerify
  }

  public var needsMethodPicker: Bool { methods.count > 1 }
  public var isBusy: Bool { isSendingCode || isSubmitting }

  public var canSubmit: Bool {
    guard phase == .ready, !isBusy, let selectedMethod else { return false }
    switch selectedMethod {
    case .password: return !password.isEmpty
    case .totp: return !trimmedCode.isEmpty
    case .email: return pendingToken != nil && !trimmedCode.isEmpty
    }
  }

  private var trimmedCode: String { code.trimmingCharacters(in: .whitespacesAndNewlines) }

  public func load() async {
    phase = .loading
    errorMessage = nil
    do {
      let options = try await api.fetchOptions()
      // An unexpired window means the gate would already pass: nothing to prove.
      if let until = options.stepUpUntil, until > now() {
        phase = .verified
        await didVerify()
        return
      }
      methods = options.methods
      selectedMethod = options.methods.first
      phase = options.methods.isEmpty ? .noMethodAvailable : .ready
    } catch let error as APIError {
      phase = .loadFailed(error)
    } catch {
      phase = .loadFailed(.malformedResponse)
    }
  }

  public func select(_ method: StepUpMethod) {
    guard methods.contains(method), method != selectedMethod else { return }
    selectedMethod = method
    password = ""
    code = ""
    errorMessage = nil
  }

  public func sendEmailCode() async {
    guard phase == .ready, !isBusy else { return }
    isSendingCode = true
    errorMessage = nil
    defer { isSendingCode = false }
    do {
      pendingToken = try await api.sendEmailCode()
      code = ""
    } catch let error as APIError {
      errorMessage = Self.message(for: error)
    } catch {
      errorMessage = Self.message(for: .malformedResponse)
    }
  }

  public func submit() async {
    guard canSubmit, let selectedMethod else { return }
    let proof: StepUpProof
    switch selectedMethod {
    case .password: proof = .password(password)
    case .totp: proof = .totp(trimmedCode)
    case .email:
      guard let pendingToken else { return }
      proof = .email(pendingToken: pendingToken, code: trimmedCode)
    }

    isSubmitting = true
    errorMessage = nil
    do {
      _ = try await api.verify(proof)
      isSubmitting = false
      phase = .verified
      password = ""
      code = ""
      await didVerify()
    } catch let failure as StepUpFailure {
      isSubmitting = false
      errorMessage = Self.message(for: failure)
      // A password is never worth keeping after a rejection; a code can be corrected in place.
      password = ""
    } catch {
      isSubmitting = false
      errorMessage = Self.message(for: .malformedResponse)
    }
  }

  private static func message(for failure: StepUpFailure) -> String {
    switch failure {
    case .rejected(let serverMessage, let attemptsRemaining):
      let base = serverMessage ?? "That didn't work."
      guard let attemptsRemaining, attemptsRemaining > 0 else { return base }
      let noun = attemptsRemaining == 1 ? "attempt" : "attempts"
      return "\(base) \(attemptsRemaining) \(noun) remaining."
    case .rateLimited:
      return "Too many attempts. Try again in a few minutes."
    case .api(let error):
      return message(for: error)
    }
  }

  private static func message(for error: APIError) -> String {
    switch error {
    case .signedOut: "Your session has ended. Sign in again."
    case .rateLimited: "Too many attempts. Try again in a few minutes."
    case .offline: "You're offline. Check your connection and try again."
    default: "Something went wrong. Try again."
    }
  }
}
