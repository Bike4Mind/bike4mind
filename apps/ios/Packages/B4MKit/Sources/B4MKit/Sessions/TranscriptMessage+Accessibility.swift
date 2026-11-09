import Foundation

extension TranscriptMessage.Badge {
  /// Short status text shown beside a bubble and spoken by VoiceOver.
  public var title: String {
    switch self {
    case .queued: "Queued"
    case .working: "Working"
    case .stopped: "Stopped"
    case .failed: "Failed"
    case .awaitingApproval: "Needs approval"
    case .outOfCredits(let code): code == .spendCapExceeded ? "Spend cap reached" : "Out of credits"
    }
  }
}

extension TranscriptMessage {
  /// One VoiceOver utterance for the whole bubble: who spoke, what was said, the turn's status, when, and
  /// the credits it cost. A bubble is a single element, so everything visible in it has to be in here.
  @MainActor public func accessibilityLabel(now: Date = .now) -> String {
    var parts: [String] = []
    let speaker = role == .user ? "You" : "Bike4Mind"
    parts.append(text.isEmpty ? speaker : "\(speaker): \(text)")
    if let badge { parts.append(badge.title) }
    if let pendingAction { parts.append(contentsOf: Self.describe(pendingAction, now: now)) }
    parts.append(RelativeTime.describe(createdAt, now: now))
    if role == .assistant, let creditsUsed { parts.append("\(CreditsViewModel.formatted(creditsUsed)) credits") }
    return parts.joined(separator: ", ")
  }

  /// Mirrors `PendingActionCard` in the app: the tool, whether the request lapsed or where to answer it, and
  /// its parameters.
  private static func describe(_ action: PendingAction, now: Date) -> [String] {
    var parts = ["Waiting for approval to run \(action.tool)"]
    parts.append(
      action.hasLapsed(at: now) ? "This request expired" : "Approve or deny this on Bike4Mind for the web")
    parts += action.parameters.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }
    return parts
  }
}
