import Foundation

/// Where the Live Activity's approve and deny intents hand their answer. A `LiveActivityIntent` the app also
/// contains runs in the app's process, so the app installs `answer` at launch with its signed-in services. With
/// no handler (before launch finished, or in the widget extension) the answer is dropped and the activity keeps
/// its buttons, so nothing is ever answered without the user's own credentials.
@MainActor
public enum LiveActivityApprovals {
  public static var answer: (@MainActor (PendingActionTarget, PendingActionDecision) async -> Void)?

  /// - Returns: whether a handler took the answer.
  @discardableResult
  public static func submit(questID: String, pendingActionTs: Int64, decision: PendingActionDecision) async -> Bool {
    guard let answer else { return false }
    await answer(PendingActionTarget(questID: questID, pendingActionTs: pendingActionTs), decision)
    return true
  }
}
