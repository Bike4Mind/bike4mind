import Foundation

public struct AccountDeletionReceipt: Equatable, Sendable {
  /// When the account is purged, if the server said (30 days after the request).
  public let scheduledFor: Date?

  public init(scheduledFor: Date?) {
    self.scheduledFor = scheduledFor
  }
}

/// Why `POST /api/account/deletion` did not go through.
public enum AccountDeletionFailure: Error, Equatable, Sendable {
  /// The user owns organizations that must be transferred first.
  case organizationTransferRequired([AccountOrganization])
  /// The server refuses this session (an impersonating admin).
  case notPermitted
  /// The step-up gate wants proof of a recent sign-in: signing in again satisfies it.
  case recentSignInRequired
  /// Deletion is already pending for this account.
  case alreadyScheduled
  case api(APIError)
}

public protocol AccountAPI: Sendable {
  /// Requests deletion with a 30-day grace period. On success the server has revoked every session.
  func requestDeletion() async throws -> AccountDeletionReceipt
  /// Cancels a pending deletion. Canceled subscriptions are not reinstated.
  func restoreDeletion() async throws
}

/// Hand-written client for the account deletion routes (see `AccountDeletionWire`). Same bearer and
/// single-401-retry policy as `APIClient`.
public struct AccountClient: AccountAPI {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  public func requestDeletion() async throws -> AccountDeletionReceipt {
    let response: AuthorizedRequester.Response
    do {
      response = try await requester.send(method: "POST", path: AccountDeletionWire.path)
    } catch let error as APIError {
      throw AccountDeletionFailure.api(error)
    }
    return try AccountDeletionWire.deletionResult(status: response.status, body: response.body)
  }

  public func restoreDeletion() async throws {
    let response = try await requester.send(method: "DELETE", path: AccountDeletionWire.path)
    try AccountDeletionWire.restoreResult(status: response.status)
  }
}
