import Foundation
import UserNotifications

/// The notification categories the server selects with `aps.category` on a `brief_ready` push: approve/deny or
/// reply when the brief holds exactly one decision, Listen alone otherwise. Identifiers must stay in sync with
/// BRIEF_ACTION_CATEGORIES and BRIEF_LISTEN_CATEGORY in apps/workers/src/events/sendPush.ts.
public enum BriefNotificationCategory {
  public static let approvalIdentifier = "brief_ready_approval"
  public static let replyIdentifier = "brief_ready_reply"
  /// Sent for a brief with no single answerable decision, so the Listen button is still offered.
  public static let listenIdentifier = "brief_ready_listen"

  /// Distinct from the `approval_needed` buttons, so ApprovalNotificationHandler never claims a brief action.
  public enum Action: String, Sendable {
    case approve = "brief_approve"
    case deny = "brief_deny"
    case reply = "brief_reply"
    case listen = "brief_listen"
  }

  /// Same unlock rules as ApprovalNotificationCategory: approve and reply spend tools and credits, deny only stops.
  public static func makeCategories() -> [UNNotificationCategory] {
    let approve = UNNotificationAction(
      identifier: Action.approve.rawValue, title: "Approve", options: [.authenticationRequired])
    let deny = UNNotificationAction(identifier: Action.deny.rawValue, title: "Deny", options: [.destructive])
    let reply = UNTextInputNotificationAction(
      identifier: Action.reply.rawValue, title: "Reply", options: [.authenticationRequired],
      textInputButtonTitle: "Send", textInputPlaceholder: "Your reply")
    let listen = UNNotificationAction(identifier: Action.listen.rawValue, title: "Listen", options: [.foreground])
    return [
      UNNotificationCategory(
        identifier: approvalIdentifier, actions: [approve, deny, listen], intentIdentifiers: [], options: []),
      UNNotificationCategory(
        identifier: replyIdentifier, actions: [reply, listen], intentIdentifiers: [], options: []),
      UNNotificationCategory(identifier: listenIdentifier, actions: [listen], intentIdentifiers: [], options: []),
    ]
  }
}

public enum BriefNotificationOutcome: Equatable, Sendable {
  /// Not a brief action; the caller routes the response elsewhere.
  case notHandled
  /// Answered, or reported as no longer answerable; the result was posted as feedback.
  case handled
  /// Nothing could be answered from the notification; the caller should open the brief.
  case openBrief
  /// The user asked to hear the brief; the caller opens voice mode reading it.
  case listen(briefID: String)
}

/// Handles a brief notification's buttons. Listen only names the brief for voice mode, with no fetch. The
/// others answer the brief's single decision: the handler re-fetches it with the user's token and acts only
/// when exactly one decision is still pending, so a stale notification never answers something that moved on.
@MainActor
public final class BriefNotificationHandler {
  private let briefs: any BriefAPI
  private let pendingActions: any PendingActionAPI
  private let feedback: any ApprovalFeedbackPosting

  public init(briefs: any BriefAPI, pendingActions: any PendingActionAPI, feedback: any ApprovalFeedbackPosting) {
    self.briefs = briefs
    self.pendingActions = pendingActions
    self.feedback = feedback
  }

  @discardableResult
  public func handle(
    actionIdentifier: String, replyText: String?, payload: NotificationPayload
  ) async
    -> BriefNotificationOutcome
  {
    guard let action = BriefNotificationCategory.Action(rawValue: actionIdentifier) else { return .notHandled }
    if action == .listen {
      return payload.briefID.map { .listen(briefID: $0) } ?? .openBrief
    }
    guard let briefID = payload.briefID else {
      await feedback.post(title: Self.failureTitle(for: action), body: PendingActionFailure.unavailable.message)
      return .handled
    }
    let brief: Brief
    do {
      brief = try await briefs.brief(id: briefID)
    } catch {
      let failure = (error as? APIError).map(PendingActionFailure.api) ?? .unavailable
      await feedback.post(title: Self.failureTitle(for: action), body: failure.message)
      return .openBrief
    }
    guard brief.decisions.count == 1, let decision = brief.decisions.first else { return .openBrief }

    switch action {
    case .approve, .deny:
      guard let approval = decision.approval else { return .openBrief }
      return await answer(approval, decision: action == .approve ? .approve : .deny)
    case .reply:
      guard let question = decision.question else { return .openBrief }
      return await reply(question, briefID: brief.id, decisionID: decision.id, text: replyText ?? "")
    case .listen:
      return .listen(briefID: brief.id)
    }
  }

  private func answer(_ approval: BriefApprovalRef, decision: PendingActionDecision) async -> BriefNotificationOutcome {
    guard approval.state == .pending else {
      let (title, body) = Self.closed(approval.state)
      await feedback.post(title: title, body: body)
      return .handled
    }
    do {
      let result = try await pendingActions.respond(to: approval.target, decision: decision)
      let (title, body) = ApprovalNotificationHandler.success(for: result)
      await feedback.post(title: title, body: body)
    } catch let failure as PendingActionFailure {
      await feedback.post(title: ApprovalNotificationHandler.failureTitle(for: decision), body: failure.message)
    } catch {
      await feedback.post(
        title: ApprovalNotificationHandler.failureTitle(for: decision),
        body: PendingActionFailure.api(.malformedResponse).message)
    }
    return .handled
  }

  private func reply(
    _ question: BriefQuestionRef, briefID: String, decisionID: String, text: String
  ) async
    -> BriefNotificationOutcome
  {
    guard question.state == .open else {
      let failure: BriefReplyFailure = question.state == .answered ? .closed : .notFound
      await feedback.post(title: Self.failureTitle(for: .reply), body: failure.message)
      return .handled
    }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      await feedback.post(title: Self.failureTitle(for: .reply), body: BriefReplyFailure.invalid.message)
      return .handled
    }
    do {
      _ = try await briefs.reply(briefID: briefID, decisionID: decisionID, text: trimmed, choiceIndex: nil)
      await feedback.post(title: "Reply sent", body: "The agent is continuing.")
    } catch let failure as BriefReplyFailure {
      await feedback.post(title: Self.failureTitle(for: .reply), body: failure.message)
    } catch {
      await feedback.post(
        title: Self.failureTitle(for: .reply), body: BriefReplyFailure.api(.malformedResponse).message)
    }
    return .handled
  }

  private static func failureTitle(for action: BriefNotificationCategory.Action) -> String {
    switch action {
    case .approve: ApprovalNotificationHandler.failureTitle(for: .approve)
    case .deny: ApprovalNotificationHandler.failureTitle(for: .deny)
    case .reply: "Couldn't send your reply"
    case .listen: "Couldn't open your brief"
    }
  }

  /// A lapsed or replaced approval is reported as what happened to it, not as an error.
  private static func closed(_ state: BriefApprovalState) -> (title: String, body: String) {
    switch state {
    case .replaced: ("Approval replaced", PendingActionFailure.replaced.message)
    case .lapsed: ("Approval lapsed", PendingActionFailure.expired.message)
    case .pending, .approved, .denied, .resolved: ("Already answered", PendingActionFailure.alreadyResolved.message)
    }
  }
}
