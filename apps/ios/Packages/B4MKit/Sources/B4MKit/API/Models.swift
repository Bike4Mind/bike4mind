import Foundation

/// One page of a cursor-paginated listing. `nextCursor == nil` means the listing is exhausted.
public struct Page<Item: Sendable>: Sendable {
  public let items: [Item]
  public let nextCursor: String?

  public init(items: [Item], nextCursor: String?) {
    self.items = items
    self.nextCursor = nextCursor
  }
}

extension Page: Equatable where Item: Equatable {}

/// A session ("notebook" in the web UI) as the list shows it.
public struct SessionSummary: Identifiable, Hashable, Sendable, Codable {
  public let id: String
  public let name: String
  public let lastUsedModel: String?
  public let firstCreated: Date
  public let lastUpdated: Date

  public init(id: String, name: String, lastUsedModel: String?, firstCreated: Date, lastUpdated: Date) {
    self.id = id
    self.name = name
    self.lastUsedModel = lastUsedModel
    self.firstCreated = firstCreated
    self.lastUpdated = lastUpdated
  }

  /// The name to show for the session; a session nobody has named yet reads "Untitled".
  public var title: String { name.isEmpty ? "Untitled" : name }
}

/// One turn of a conversation: what was sent, the visible reply, and where the turn stands.
public struct QuestTurn: Identifiable, Hashable, Sendable {
  public enum Status: String, Hashable, Sendable {
    case pending, running, done, stopped

    public var isTerminal: Bool { self == .done || self == .stopped }
  }

  public enum Kind: String, Hashable, Sendable {
    case message, oob, error, system
    case voiceTranscript = "voice_transcript"
  }

  public enum ErrorCode: String, Hashable, Sendable {
    case insufficientCredits = "insufficient_credits"
    case spendCapExceeded = "spend_cap_exceeded"
  }

  public let id: String
  public let prompt: String?
  public let reply: String?
  /// `nil` on turns written before status tracking; treat as done.
  public let status: Status?
  public let kind: Kind?
  public let errorCode: ErrorCode?
  public let createdAt: Date
  public let creditsUsed: Double?
  public let pendingAction: PendingAction?

  public init(
    id: String,
    prompt: String?,
    reply: String?,
    status: Status? = nil,
    kind: Kind? = nil,
    errorCode: ErrorCode? = nil,
    createdAt: Date,
    creditsUsed: Double? = nil,
    pendingAction: PendingAction? = nil
  ) {
    self.id = id
    self.prompt = prompt
    self.reply = reply
    self.status = status
    self.kind = kind
    self.errorCode = errorCode
    self.createdAt = createdAt
    self.creditsUsed = creditsUsed
    self.pendingAction = pendingAction
  }
}

/// A tool call waiting for the owner's approval. Approval itself arrives with chat (M3).
public struct PendingAction: Hashable, Sendable {
  /// Approval requests lapse after this long.
  public static let lifetime: TimeInterval = 15 * 60

  public let tool: String
  /// Argument names to a display string; enough to show what is being asked, not to execute it.
  public let parameters: [String: String]
  public let requestedAt: Date

  public init(tool: String, parameters: [String: String], requestedAt: Date) {
    self.tool = tool
    self.parameters = parameters
    self.requestedAt = requestedAt
  }

  public func hasLapsed(at date: Date) -> Bool {
    date.timeIntervalSince(requestedAt) > Self.lifetime
  }
}

public struct CreditBalance: Hashable, Sendable {
  public let credits: Double

  public init(credits: Double) {
    self.credits = credits
  }
}
