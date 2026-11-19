import Foundation

/// Where a server-composed brief is in its life. An unrecognised value (a status a newer server added)
/// decodes to `.unknown` so an old build keeps working and treats the brief as not yet readable.
public enum BriefStatus: Equatable, Sendable {
  case composing
  case ready
  case failed
  case unknown(String)
}

extension BriefStatus: Decodable {
  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    switch raw {
    case "composing": self = .composing
    case "ready": self = .ready
    case "failed": self = .failed
    default: self = .unknown(raw)
    }
  }
}

public struct BriefItem: Equatable, Hashable, Sendable, Decodable, Identifiable {
  public let id: String
  public let text: String

  public init(id: String, text: String) {
    self.id = id
    self.text = text
  }
}

/// The pending agent approval a decision refers to. The approval card itself lives in the session transcript.
public struct BriefApprovalRef: Equatable, Hashable, Sendable, Decodable {
  public let questID: String
  public let sessionID: String
  /// Epoch milliseconds, as on the wire.
  public let pendingActionTs: Int64

  public init(questID: String, sessionID: String, pendingActionTs: Int64) {
    self.questID = questID
    self.sessionID = sessionID
    self.pendingActionTs = pendingActionTs
  }

  private enum CodingKeys: String, CodingKey {
    case questID = "questId"
    case sessionID = "sessionId"
    case pendingActionTs
  }
}

public struct BriefDecision: Equatable, Hashable, Sendable, Decodable, Identifiable {
  public let id: String
  public let text: String
  public let approval: BriefApprovalRef?

  public init(id: String, text: String, approval: BriefApprovalRef? = nil) {
    self.id = id
    self.text = text
    self.approval = approval
  }
}

/// A server-composed summary of what happened, what was handled and what needs the user.
public struct Brief: Equatable, Sendable, Decodable, Identifiable {
  public let id: String
  public let status: BriefStatus
  public let createdAt: Date
  public let composedAt: Date?
  public let periodStart: Date
  public let periodEnd: Date
  public let headline: String?
  public let happened: [BriefItem]
  public let handled: [BriefItem]
  public let decisions: [BriefDecision]

  public init(
    id: String, status: BriefStatus, createdAt: Date, composedAt: Date? = nil, periodStart: Date, periodEnd: Date,
    headline: String? = nil, happened: [BriefItem] = [], handled: [BriefItem] = [], decisions: [BriefDecision] = []
  ) {
    self.id = id
    self.status = status
    self.createdAt = createdAt
    self.composedAt = composedAt
    self.periodStart = periodStart
    self.periodEnd = periodEnd
    self.headline = headline
    self.happened = happened
    self.handled = handled
    self.decisions = decisions
  }

  /// Nothing worth showing: a ready brief with no headline and no items.
  public var isEmpty: Bool {
    (headline ?? "").isEmpty && happened.isEmpty && handled.isEmpty && decisions.isEmpty
  }
}
