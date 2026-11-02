import Foundation
import Observation

/// Drives the "Delete account" screen: the typed confirmation, the request, and the 409 "transfer your
/// organizations first" branch. A successful request ends the local session through `endSession`.
@MainActor
@Observable
public final class AccountDeletionViewModel {
  public enum State: Equatable, Sendable {
    case idle
    case deleting
    case blockedByOrganizations([AccountOrganization])
    case notPermitted
    case failed(APIError)
    case completed(scheduledFor: Date?)
  }

  /// The word the user types to arm the button, matching the web app.
  public static let confirmationPhrase = "DELETE"
  public static let gracePeriodDays = 30

  public var confirmation = ""
  public private(set) var state: State = .idle

  @ObservationIgnored private let api: any AccountAPI
  @ObservationIgnored private let endSession: @MainActor () async -> Void

  /// `endSession` must tear the session down locally: end Live Activities, unregister push, clear the
  /// Keychain. It runs only after the server accepted the request.
  public init(api: any AccountAPI, endSession: @escaping @MainActor () async -> Void) {
    self.api = api
    self.endSession = endSession
  }

  public var isConfirmed: Bool {
    confirmation.trimmingCharacters(in: .whitespacesAndNewlines) == Self.confirmationPhrase
  }

  public var isDeleting: Bool { state == .deleting }

  public var canSubmit: Bool {
    guard isConfirmed else { return false }
    switch state {
    case .deleting, .completed: return false
    case .idle, .blockedByOrganizations, .notPermitted, .failed: return true
    }
  }

  public func submit() async {
    guard canSubmit else { return }
    state = .deleting
    do {
      let receipt = try await api.requestDeletion()
      state = .completed(scheduledFor: receipt.scheduledFor)
      await endSession()
    } catch let failure as AccountDeletionFailure {
      switch failure {
      case .organizationTransferRequired(let organizations): state = .blockedByOrganizations(organizations)
      case .notPermitted: state = .notPermitted
      case .api(let error): state = .failed(error)
      }
    } catch let error as APIError {
      state = .failed(error)
    } catch {
      state = .failed(.malformedResponse)
    }
  }
}

/// Drives the restore screen shown while the account is waiting to be deleted.
@MainActor
@Observable
public final class AccountRestoreViewModel {
  public enum State: Equatable, Sendable {
    case idle
    case restoring
    case failed(APIError)
  }

  public private(set) var state: State = .idle

  @ObservationIgnored private let api: any AccountAPI
  @ObservationIgnored private let didRestore: @MainActor () -> Void

  public init(api: any AccountAPI, didRestore: @escaping @MainActor () -> Void) {
    self.api = api
    self.didRestore = didRestore
  }

  public var isRestoring: Bool { state == .restoring }

  public func restore() async {
    guard !isRestoring else { return }
    state = .restoring
    do {
      try await api.restoreDeletion()
      state = .idle
      didRestore()
    } catch let error as APIError {
      state = .failed(error)
    } catch {
      state = .failed(.malformedResponse)
    }
  }
}
