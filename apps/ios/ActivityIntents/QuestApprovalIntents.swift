import AppIntents
import B4MKit

/// The Live Activity's approve and deny buttons. This folder is compiled into both the app and the widget
/// extension: the extension draws the buttons, and because the app contains the intents too, the system performs
/// them in the app's process, where `LiveActivityApprovals` reaches the signed-in services. Like the approval
/// notification, approve needs the device unlocked and deny does not.
struct ApproveQuestActionIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Approve agent action"
  static let isDiscoverable = false
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Quest") var questID: String
  @Parameter(title: "Pending action") var pendingActionTs: Int

  init() {}

  init(target: PendingActionTarget) {
    questID = target.questID
    pendingActionTs = Int(target.pendingActionTs)
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    await LiveActivityApprovals.submit(questID: questID, pendingActionTs: Int64(pendingActionTs), decision: .approve)
    return .result()
  }
}

struct DenyQuestActionIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Deny agent action"
  static let isDiscoverable = false

  @Parameter(title: "Quest") var questID: String
  @Parameter(title: "Pending action") var pendingActionTs: Int

  init() {}

  init(target: PendingActionTarget) {
    questID = target.questID
    pendingActionTs = Int(target.pendingActionTs)
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    await LiveActivityApprovals.submit(questID: questID, pendingActionTs: Int64(pendingActionTs), decision: .deny)
    return .result()
  }
}
