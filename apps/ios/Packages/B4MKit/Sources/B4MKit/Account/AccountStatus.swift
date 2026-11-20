import Foundation
import Observation

/// Whether the signed-in account is waiting to be deleted. `RootView` swaps the shell for the restore
/// screen while it is `.deletionPending`.
@MainActor
@Observable
public final class AccountStatus {
  public enum State: Equatable, Sendable {
    case active
    case deletionPending(scheduledFor: Date?)
  }

  public private(set) var state: State = .active
  /// Set while the app signs out after a successful deletion request: the revoked session's last
  /// calls answer 403 pending, and must not flash the restore screen on the way out.
  @ObservationIgnored private var isIgnoringNotices = false

  public init(signal: AccountDeletionSignal = .shared) {
    signal.observe { [weak self] notice in
      Task { @MainActor in self?.receive(notice) }
    }
  }

  public var isDeletionPending: Bool {
    if case .deletionPending = state { return true }
    return false
  }

  public func receive(_ notice: AccountDeletionNotice) {
    guard !isIgnoringNotices else { return }
    state = .deletionPending(scheduledFor: notice.scheduledFor)
  }

  public func beginSignOutAfterDeletion() {
    isIgnoringNotices = true
  }

  /// A restored account, or a new session: nothing is pending any more.
  public func reset() {
    isIgnoringNotices = false
    state = .active
  }
}
