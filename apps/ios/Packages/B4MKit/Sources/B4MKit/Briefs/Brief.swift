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

/// What has become of an approval since the brief was composed, read live on every fetch. Only `.pending` can
/// be answered. An unrecognised or missing value decodes to `.resolved` so no build offers a stale button.
public enum BriefApprovalState: String, Equatable, Hashable, Sendable, CaseIterable {
  case pending
  case approved
  case denied
  case replaced
  case lapsed
  case resolved
}

extension BriefApprovalState: Decodable {
  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = BriefApprovalState(rawValue: raw) ?? .resolved
  }
}

/// The pending agent approval a decision refers to. The approval card itself lives in the session transcript.
public struct BriefApprovalRef: Equatable, Hashable, Sendable, Decodable {
  public let questID: String
  public let sessionID: String
  /// Epoch milliseconds, as on the wire.
  public let pendingActionTs: Int64
  public let state: BriefApprovalState

  public init(questID: String, sessionID: String, pendingActionTs: Int64, state: BriefApprovalState = .resolved) {
    self.questID = questID
    self.sessionID = sessionID
    self.pendingActionTs = pendingActionTs
    self.state = state
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    questID = try container.decode(String.self, forKey: .questID)
    sessionID = try container.decode(String.self, forKey: .sessionID)
    pendingActionTs = try container.decode(Int64.self, forKey: .pendingActionTs)
    state = try container.decodeIfPresent(BriefApprovalState.self, forKey: .state) ?? .resolved
  }

  public var target: PendingActionTarget { PendingActionTarget(questID: questID, pendingActionTs: pendingActionTs) }

  private enum CodingKeys: String, CodingKey {
    case questID = "questId"
    case sessionID = "sessionId"
    case pendingActionTs
    case state
  }
}

/// What has become of an agent question since the brief was composed. Only `.open` can be replied to; an
/// unrecognised or missing value decodes to `.superseded`.
public enum BriefQuestionState: String, Equatable, Hashable, Sendable, CaseIterable {
  case open
  case answered
  case superseded
}

extension BriefQuestionState: Decodable {
  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = BriefQuestionState(rawValue: raw) ?? .superseded
  }
}

/// A question an agent asked, answered through the brief's reply route.
public struct BriefQuestionRef: Equatable, Hashable, Sendable, Decodable {
  public let questID: String
  public let sessionID: String
  /// Suggested answers, in order; a reply's `choiceIndex` refers to this list.
  public let options: [String]
  public let state: BriefQuestionState

  public init(questID: String, sessionID: String, options: [String] = [], state: BriefQuestionState = .superseded) {
    self.questID = questID
    self.sessionID = sessionID
    self.options = options
    self.state = state
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    questID = try container.decode(String.self, forKey: .questID)
    sessionID = try container.decode(String.self, forKey: .sessionID)
    options = try container.decodeIfPresent([String].self, forKey: .options) ?? []
    state = try container.decodeIfPresent(BriefQuestionState.self, forKey: .state) ?? .superseded
  }

  private enum CodingKeys: String, CodingKey {
    case questID = "questId"
    case sessionID = "sessionId"
    case options
    case state
  }
}

public struct BriefDecision: Equatable, Hashable, Sendable, Decodable, Identifiable {
  public let id: String
  public let text: String
  public let approval: BriefApprovalRef?
  public let question: BriefQuestionRef?

  public init(id: String, text: String, approval: BriefApprovalRef? = nil, question: BriefQuestionRef? = nil) {
    self.id = id
    self.text = text
    self.approval = approval
    self.question = question
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
