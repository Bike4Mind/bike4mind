import Foundation
import UserNotifications

/// The notification category the server selects with `aps.category` on an `approval_needed` push, and its
/// two buttons. Approve requires the device to be unlocked (it spends the user's tools and credits); deny only
/// ever stops something, so it may act from the lock screen.
public enum ApprovalNotificationCategory {
  public static let identifier = NotificationCategory.approvalNeeded.rawValue

  public static func makeCategory() -> UNNotificationCategory {
    let approve = UNNotificationAction(
      identifier: PendingActionDecision.approve.rawValue, title: "Approve", options: [.authenticationRequired])
    let deny = UNNotificationAction(
      identifier: PendingActionDecision.deny.rawValue, title: "Deny", options: [.destructive])
    return UNNotificationCategory(
      identifier: identifier, actions: [approve, deny], intentIdentifiers: [], options: [])
  }

  /// The decision a tapped button stands for; `nil` for the default tap, dismissal or anything unknown.
  public static func decision(forActionIdentifier identifier: String) -> PendingActionDecision? {
    PendingActionDecision(rawValue: identifier)
  }
}

/// Tells the user how a lock-screen answer ended. A notification button has no screen of its own, so the
/// result (above all a failure) comes back as a local notification.
@MainActor
public protocol ApprovalFeedbackPosting: AnyObject {
  func post(title: String, body: String) async
}

public final class SystemApprovalFeedback: ApprovalFeedbackPosting {
  private let center: UNUserNotificationCenter

  public init(center: UNUserNotificationCenter = .current()) {
    self.center = center
  }

  public func post(title: String, body: String) async {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    try? await center.add(request)
  }
}

/// Answers an approval from a notification button. The decision, quest and `ts` come from the push, but
/// they only say WHICH action the user meant: the server authorizes every answer from the access token.
@MainActor
public final class ApprovalNotificationHandler {
  private let api: any PendingActionAPI
  private let feedback: any ApprovalFeedbackPosting

  public init(api: any PendingActionAPI, feedback: any ApprovalFeedbackPosting) {
    self.api = api
    self.feedback = feedback
  }

  /// - Returns: whether the response was an approve/deny button (handled here), so the caller routes
  ///   everything else (a plain tap) as a navigation.
  @discardableResult
  public func handle(actionIdentifier: String, payload: NotificationPayload) async -> Bool {
    guard let decision = ApprovalNotificationCategory.decision(forActionIdentifier: actionIdentifier) else {
      return false
    }
    guard let approval = payload.approval else {
      await feedback.post(title: Self.failureTitle(for: decision), body: PendingActionFailure.unavailable.message)
      return true
    }
    do {
      let result = try await api.respond(to: approval, decision: decision)
      let (title, body) = Self.success(for: result)
      await feedback.post(title: title, body: body)
    } catch let failure as PendingActionFailure {
      await feedback.post(title: Self.failureTitle(for: decision), body: failure.message)
    } catch {
      await feedback.post(
        title: Self.failureTitle(for: decision), body: PendingActionFailure.api(.malformedResponse).message)
    }
    return true
  }

  private static func failureTitle(for decision: PendingActionDecision) -> String {
    switch decision {
    case .approve: "Couldn't approve"
    case .deny: "Couldn't deny"
    }
  }

  private static func success(for result: PendingActionResult) -> (title: String, body: String) {
    switch result.decision {
    case .deny: ("Denied", "The agent will not run that action.")
    case .approve:
      result.toolSucceeded
        ? ("Approved", result.message ?? "The agent is continuing.")
        : ("Approved, but it didn't finish", result.message ?? "The tool reported a problem.")
    }
  }
}
