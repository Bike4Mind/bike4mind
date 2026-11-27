import Foundation

/// An organization the user owns that blocks account deletion until ownership moves elsewhere.
public struct AccountOrganization: Equatable, Sendable, Identifiable {
  public let id: String
  public let name: String

  public init(id: String, name: String) {
    self.id = id
    self.name = name
  }
}

/// Hand-written wire format for account deletion. Server counterparts: apps/client/pages/api/account/deletion.ts,
/// apps/client/server/users/accountDeletion.ts and packages/server-utils/src/auth/deletionPendingGate.ts.
///
/// `/api/account/deletion` (JWT bearer only):
/// - `POST` requests deletion. 202 `{deletion: {requestedAt, scheduledFor, source}, canceledSubscriptions}`,
///   after which every session, this one included, is revoked. Behind a step-up gate: 403
///   `{code: "step_up_required" | "step_up_unavailable"}` until the session passes
///   `POST /api/auth/step-up` (a fresh sign-in alone does not count); `step_up_unavailable` means the
///   token has no session id.
///   403 without a code: an impersonating admin. 409 `{code: "ACCOUNT_DELETION_ORG_OWNER",
///   organizations: [{id, name}]}`: owned organizations need a new owner first; 409 without it: already
///   scheduled.
/// - `DELETE` cancels a pending deletion: 204. 404 means nothing was scheduled; 409 means the purge has
///   started and it can no longer be cancelled.
///
/// While deletion is pending, other routes answer 403 `{code: "ACCOUNT_DELETION_PENDING", scheduledFor}`;
/// `AccountDeletionPendingDetector` recognizes that shape.
enum AccountDeletionWire {
  static let path = "api/account/deletion"
  static let orgOwnerCode = "ACCOUNT_DELETION_ORG_OWNER"
  static let pendingCode = "ACCOUNT_DELETION_PENDING"
  static let stepUpRequiredCode = "step_up_required"
  static let stepUpUnavailableCode = "step_up_unavailable"

  private struct ErrorEnvelope: Decodable {
    struct Organization: Decodable {
      let id: String?
      let name: String?
    }

    let code: String?
    let organizations: [Organization]?
  }

  private struct Receipt: Decodable {
    struct Deletion: Decodable {
      let scheduledFor: String?
    }

    let deletion: Deletion?
  }

  /// Maps the response of `POST /api/account/deletion`.
  static func deletionResult(status: Int, body: Data) throws -> AccountDeletionReceipt {
    switch status {
    case 200..<300:
      let receipt = try? JSONDecoder().decode(Receipt.self, from: body)
      return AccountDeletionReceipt(scheduledFor: receipt?.deletion?.scheduledFor.flatMap(parseDate))
    case 403:
      switch errorCode(body: body) {
      case stepUpRequiredCode: throw AccountDeletionFailure.stepUpRequired
      case stepUpUnavailableCode: throw AccountDeletionFailure.stepUpUnavailable
      default: throw AccountDeletionFailure.notPermitted
      }
    case 409:
      if let organizations = organizationsBlockingDeletion(body: body) {
        throw AccountDeletionFailure.organizationTransferRequired(organizations)
      }
      throw AccountDeletionFailure.alreadyScheduled
    default:
      throw AccountDeletionFailure.api(APIError(status: status))
    }
  }

  /// Maps the response of `DELETE /api/account/deletion`. A 404 (nothing scheduled) is the state the
  /// caller wants, so it counts as restored.
  static func restoreResult(status: Int) throws {
    switch status {
    case 200..<300, 404: return
    default: throw APIError(status: status)
    }
  }

  static func errorCode(body: Data) -> String? {
    (try? JSONDecoder().decode(ErrorEnvelope.self, from: body))?.code
  }

  /// The organizations listed by a 409 `ACCOUNT_DELETION_ORG_OWNER` envelope, or nil for any other body.
  static func organizationsBlockingDeletion(body: Data) -> [AccountOrganization]? {
    guard let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: body), envelope.code == orgOwnerCode
    else { return nil }
    return (envelope.organizations ?? []).compactMap { organization in
      guard let id = organization.id, !id.isEmpty else { return nil }
      let name = organization.name?.trimmingCharacters(in: .whitespacesAndNewlines)
      return AccountOrganization(id: id, name: name.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled organization")
    }
  }

  static func parseDate(_ value: String) -> Date? {
    if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value) { return date }
    return try? Date.ISO8601FormatStyle().parse(value)
  }
}
