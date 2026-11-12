import Foundation
import Observation

/// The composer for a conversation that has no session yet: the first send creates it server-side and
/// returns its id, which the caller then opens.
@MainActor
@Observable
public final class NewConversationViewModel {
  public var draft: String
  public private(set) var isSending = false
  public private(set) var failure: APIError?
  /// The server's reason when it recorded the turn as refused up front (out of credits, spend cap).
  public private(set) var refusal: String?

  @ObservationIgnored private let api: any B4MAPI
  @ObservationIgnored private let activities: (any QuestActivityTracking)?
  @ObservationIgnored private let now: @Sendable () -> Date

  public init(
    draft: String = "", api: any B4MAPI, activities: (any QuestActivityTracking)? = nil,
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.draft = draft
    self.api = api
    self.activities = activities
    self.now = now
  }

  public var canSend: Bool {
    !isSending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// - Returns: the new session's id when the server accepted the message; `nil` on failure, with
  ///   `failure` or `refusal` set so the screen can explain. The draft is kept either way until accepted.
  public func send() async -> String? {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !isSending else { return nil }
    isSending = true
    failure = nil
    refusal = nil
    defer { isSending = false }
    do {
      let receipt = try await api.sendChatMessage(ChatSendRequest(message: text, target: .newConversation))
      guard !receipt.isRefused else {
        refusal = receipt.message ?? "The message was refused."
        return nil
      }
      guard let sessionID = receipt.sessionID else {
        failure = .malformedResponse
        return nil
      }
      draft = ""
      activities?.questStarted(
        QuestActivityStart(
          questID: receipt.questID, sessionID: sessionID, title: QuestActivityTitle.fromPrompt(text),
          startedAt: now(), initialState: QuestActivityContentState(phase: .running)))
      return sessionID
    } catch {
      failure = (error as? APIError) ?? .malformedResponse
      return nil
    }
  }
}
