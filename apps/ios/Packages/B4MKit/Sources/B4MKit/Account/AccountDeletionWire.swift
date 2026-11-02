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

/// Hand-written wire format for account deletion. These routes are not in the committed OpenAPI
/// snapshot (the server work lands separately), so the generated client has no operations for them.
/// Keep in sync with the server routes when the spec snapshot next updates:
///
/// - `DELETE /api/users/me`: JWT bearer, no body. 2xx means deletion was requested with a 30-day grace
///   period and every session, this one included, was revoked. An impersonating admin gets 403.
///   409 with `code: "account_deletion_org_transfer_required"` and `organizations: [{id, name}]` means the
///   user still owns organizations that need a new owner.
/// - `POST /api/users/me/restore-deletion`: cancels a pending deletion for a signed-in pending account.
///
/// While deletion is pending, most other routes answer 403 `{accountDeletionPending: true,
/// deletionScheduledFor}`; `AccountDeletionPendingDetector` recognizes that shape.
enum AccountDeletionWire {
  static let deletePath = "api/users/me"
  static let restorePath = "api/users/me/restore-deletion"
  static let orgTransferRequiredCode = "account_deletion_org_transfer_required"

  private struct ErrorEnvelope: Decodable {
    struct Organization: Decodable {
      let id: String?
      let name: String?
    }

    struct Details: Decodable {
      let organizations: [Organization]?
    }

    let code: String?
    let errorCode: String?
    let organizations: [Organization]?
    let details: Details?
  }

  private struct Receipt: Decodable {
    let deletionScheduledFor: String?
  }

  /// Maps the response of `DELETE /api/users/me`.
  static func deletionResult(status: Int, body: Data) throws -> AccountDeletionReceipt {
    switch status {
    case 200..<300:
      let receipt = try? JSONDecoder().decode(Receipt.self, from: body)
      return AccountDeletionReceipt(scheduledFor: receipt?.deletionScheduledFor.flatMap(parseDate))
    case 403:
      throw AccountDeletionFailure.notPermitted
    case 409:
      if let organizations = organizationsBlockingDeletion(body: body) {
        throw AccountDeletionFailure.organizationTransferRequired(organizations)
      }
      throw AccountDeletionFailure.api(.server(status: 409))
    default:
      throw AccountDeletionFailure.api(APIError(status: status))
    }
  }

  /// Maps the response of `POST /api/users/me/restore-deletion`.
  static func restoreResult(status: Int) throws {
    guard (200..<300).contains(status) else { throw APIError(status: status) }
  }

  /// The organizations listed by a 409 `account_deletion_org_transfer_required` envelope, or nil for any
  /// other body. Looks at the top level and under `details`, because the envelope extension point is
  /// not pinned down in the contract conventions.
  static func organizationsBlockingDeletion(body: Data) -> [AccountOrganization]? {
    guard let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: body),
      (envelope.code ?? envelope.errorCode) == orgTransferRequiredCode
    else { return nil }
    let raw = envelope.organizations ?? envelope.details?.organizations ?? []
    return raw.compactMap { organization in
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
