import Foundation

/// The server's "this account is waiting to be deleted" answer.
public struct AccountDeletionNotice: Equatable, Sendable {
  public let scheduledFor: Date?

  public init(scheduledFor: Date?) {
    self.scheduledFor = scheduledFor
  }
}

/// Recognizes the 403 body a pending-deletion account gets from most routes:
/// `{"code": "ACCOUNT_DELETION_PENDING", "scheduledFor": "<ISO date>", "error": "..."}`
/// (packages/server-utils/src/auth/deletionPendingGate.ts on the server).
public enum AccountDeletionPendingDetector {
  private struct Body: Decodable {
    let code: String?
    let scheduledFor: String?
  }

  public static func notice(status: Int, body: Data) -> AccountDeletionNotice? {
    guard status == 403, !body.isEmpty,
      let decoded = try? JSONDecoder().decode(Body.self, from: body),
      decoded.code == AccountDeletionWire.pendingCode
    else { return nil }
    return AccountDeletionNotice(scheduledFor: decoded.scheduledFor.flatMap(AccountDeletionWire.parseDate))
  }
}

/// Broadcasts pending-deletion answers seen anywhere on the wire. `URLSessionTransport` reports into
/// `shared`, so every client (generated or hand-written) is covered without per-call plumbing.
public final class AccountDeletionSignal: @unchecked Sendable {
  public static let shared = AccountDeletionSignal()

  private let lock = NSLock()
  private var observers: [@Sendable (AccountDeletionNotice) -> Void] = []

  public init() {}

  public func observe(_ handler: @escaping @Sendable (AccountDeletionNotice) -> Void) {
    lock.withLock { observers.append(handler) }
  }

  public func report(_ notice: AccountDeletionNotice) {
    let snapshot = lock.withLock { observers }
    for observer in snapshot { observer(notice) }
  }
}
