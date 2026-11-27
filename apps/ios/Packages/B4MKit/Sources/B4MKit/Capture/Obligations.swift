import Foundation

public struct ObligationAmount: Equatable, Hashable, Sendable, Codable {
  public let value: Decimal
  /// ISO 4217, upper case.
  public let currency: String

  public init(value: Decimal, currency: String) {
    self.value = value
    self.currency = currency
  }
}

public struct ObligationDestination: Equatable, Hashable, Sendable, Decodable {
  public let lakeID: String
  public let name: String

  public init(lakeID: String, name: String) {
    self.lakeID = lakeID
    self.name = name
  }

  private enum CodingKeys: String, CodingKey {
    case lakeID = "lake_id"
    case name
  }
}

/// What the assistant read off a handed-off document (`obligations.contract.ts`). `summary` is model-written.
public struct Obligation: Equatable, Hashable, Sendable, Decodable, Identifiable {
  public let id: String
  public let status: String
  public let documentKind: String
  public let fileID: String
  public let amount: ObligationAmount?
  public let payee: String?
  /// `YYYY-MM-DD`, a calendar day with no time zone.
  public let dueDate: String?
  public let destination: ObligationDestination?
  public let summary: String

  public init(
    id: String, status: String = "pending", documentKind: String = "invoice", fileID: String,
    amount: ObligationAmount? = nil, payee: String? = nil, dueDate: String? = nil,
    destination: ObligationDestination? = nil, summary: String = ""
  ) {
    self.id = id
    self.status = status
    self.documentKind = documentKind
    self.fileID = fileID
    self.amount = amount
    self.payee = payee
    self.dueDate = dueDate
    self.destination = destination
    self.summary = summary
  }

  private enum CodingKeys: String, CodingKey {
    case id, status, amount, payee, destination, summary
    case documentKind = "document_kind"
    case fileID = "file_id"
    case dueDate = "due_date"
  }
}

/// A correction to an obligation. A `nil` property is left out of the request; `.some(nil)` clears the field.
public struct ObligationPatch: Equatable, Sendable, Encodable {
  public var amount: ObligationAmount??
  public var payee: String??
  public var dueDate: String??
  public var destinationLakeID: String??
  public var status: String?

  public init(
    amount: ObligationAmount?? = nil, payee: String?? = nil, dueDate: String?? = nil,
    destinationLakeID: String?? = nil, status: String? = nil
  ) {
    self.amount = amount
    self.payee = payee
    self.dueDate = dueDate
    self.destinationLakeID = destinationLakeID
    self.status = status
  }

  private enum CodingKeys: String, CodingKey {
    case amount, payee, status
    case dueDate = "due_date"
    case destinationLakeID = "destination_lake_id"
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    if let amount { try container.encode(amount, forKey: .amount) }
    if let payee { try container.encode(payee, forKey: .payee) }
    if let dueDate { try container.encode(dueDate, forKey: .dueDate) }
    if let destinationLakeID { try container.encode(destinationLakeID, forKey: .destinationLakeID) }
    try container.encodeIfPresent(status, forKey: .status)
  }
}

public enum ObligationError: Error, Equatable, Sendable {
  /// The upload is still being checked (HTTP 409 on hand-off); retrying shortly succeeds.
  case stillChecking
  /// The obligation was dismissed and can no longer change (HTTP 409 on update).
  case dismissed
  /// The server refused on its merits (400/422/502); `message` is safe to show.
  case rejected(message: String)
}

/// Hands an uploaded document to the assistant and corrects or confirms what it read.
public protocol ObligationHandingOff: FileUploading {
  /// Idempotent per file: a second call returns the obligation the first one made, without a new charge.
  func handOff(fileID: String, text: String?) async throws -> Obligation
  func update(id: String, patch: ObligationPatch) async throws -> Obligation
}
