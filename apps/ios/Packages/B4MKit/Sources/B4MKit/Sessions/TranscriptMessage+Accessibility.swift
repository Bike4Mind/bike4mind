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
  @MainActor public func accessibilityLabel(now: Date = .now, approval: ApprovalCardState = .open) -> String {
    var parts: [String] = []
    let speaker = role == .user ? "You" : "Bike4Mind"
    parts.append(text.isEmpty ? speaker : "\(speaker): \(text)")
    if let badge { parts.append(badge.title) }
    if let pendingAction { parts.append(contentsOf: Self.describe(pendingAction, now: now, state: approval)) }
    parts.append(RelativeTime.describe(createdAt, now: now))
    if role == .assistant, let creditsUsed { parts.append("\(CreditsViewModel.formatted(creditsUsed)) credits") }
    return parts.joined(separator: ", ")
  }

  /// Mirrors `PendingActionCard` in the app: the tool, where the request stands, and its parameters.
  private static func describe(_ action: PendingAction, now: Date, state: ApprovalCardState) -> [String] {
    var parts = ["Waiting for approval to run \(action.tool)"]
    parts.append(Self.status(of: action, now: now, state: state))
    parts += action.parameters.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }
    return parts
  }

  /// The card's one status line, shared by the card and VoiceOver so they never disagree.
  public static func status(of action: PendingAction, now: Date, state: ApprovalCardState) -> String {
    switch state {
    case .submitting(let decision): return decision == .approve ? "Approving" : "Denying"
    case .answered(let result):
      switch result.decision {
      case .deny: return "Denied"
      case .approve: return result.toolSucceeded ? "Approved" : "Approved, but the tool reported a problem"
      }
    case .failed(let failure): return failure.message
    case .open: return action.hasLapsed(at: now) ? "This request expired" : "Approve or deny this request"
    }
  }
}
