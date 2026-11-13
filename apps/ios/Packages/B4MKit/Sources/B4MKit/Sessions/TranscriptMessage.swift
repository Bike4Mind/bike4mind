import Foundation

/// One bubble in a conversation transcript. M2 builds these from stored turns; M3 feeds the same type
/// from live streaming by replacing a message's `text` as the cumulative reply grows.
public struct TranscriptMessage: Identifiable, Hashable, Sendable {
  public enum Role: Hashable, Sendable {
    case user
    case assistant
  }

  public let id: String
  public let questID: String
  public let role: Role
  public let text: String
  public let createdAt: Date
  /// Status of the turn this message belongs to. Only the assistant bubble shows it.
  public let status: QuestTurn.Status?
  public let kind: QuestTurn.Kind?
  public let errorCode: QuestTurn.ErrorCode?
  public let creditsUsed: Double?
  public let pendingAction: PendingAction?

  public init(
    id: String,
    questID: String,
    role: Role,
    text: String,
    createdAt: Date,
    status: QuestTurn.Status? = nil,
    kind: QuestTurn.Kind? = nil,
    errorCode: QuestTurn.ErrorCode? = nil,
    creditsUsed: Double? = nil,
    pendingAction: PendingAction? = nil
  ) {
    self.id = id
    self.questID = questID
    self.role = role
    self.text = text
    self.createdAt = createdAt
    self.status = status
    self.kind = kind
    self.errorCode = errorCode
    self.creditsUsed = creditsUsed
    self.pendingAction = pendingAction
  }

  /// A turn that is still working or failed deserves a visible badge; a finished one stays quiet.
  public var badge: Badge? {
    guard role == .assistant else { return nil }
    if pendingAction != nil { return .awaitingApproval }
    if kind == .error { return errorCode == nil ? .failed : .outOfCredits(errorCode) }
    switch status {
    case .pending: return .queued
    case .running: return .working
    case .stopped: return .stopped
    case .done, nil: return nil
    }
  }

  public enum Badge: Hashable, Sendable {
    case queued
    case working
    case stopped
    case failed
    case awaitingApproval
    case outOfCredits(QuestTurn.ErrorCode?)
  }
}

public enum TranscriptMapper {
  /// Expands turns into bubbles, preserving the order given (the API returns oldest first).
  /// A turn with no prompt or an empty reply contributes only the side it has, except that a turn
  /// still in flight or awaiting approval always shows an assistant bubble so its badge has a home.
  public static func messages(from turns: [QuestTurn]) -> [TranscriptMessage] {
    turns.flatMap(messages(for:))
  }

  public static func messages(for turn: QuestTurn) -> [TranscriptMessage] {
    var result: [TranscriptMessage] = []
    if let prompt = turn.prompt, !prompt.isEmpty {
      result.append(
        TranscriptMessage(
          id: turn.id + ".prompt", questID: turn.id, role: .user, text: prompt, createdAt: turn.createdAt))
    }

    let reply = turn.reply ?? ""
    let inFlight = turn.status.map { !$0.isTerminal } ?? false
    if !reply.isEmpty || inFlight || turn.pendingAction != nil {
      result.append(
        TranscriptMessage(
          id: turn.id + ".reply", questID: turn.id, role: .assistant, text: reply, createdAt: turn.createdAt,
          status: turn.status, kind: turn.kind, errorCode: turn.errorCode, creditsUsed: turn.creditsUsed,
          pendingAction: turn.pendingAction))
    }
    return result
  }
}
