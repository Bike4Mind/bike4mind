import Foundation

/// What the transcript's approval card shows for one quest, beyond what the stored turn says.
public enum ApprovalCardState: Equatable, Sendable {
  /// Nothing answered from this screen yet: the card offers approve and deny.
  case open
  case submitting(PendingActionDecision)
  /// Answered here. The turn keeps its pending action until the quest settles, so this is what hides the buttons.
  case answered(PendingActionResult)
  /// The server refused or the call failed. A retryable failure keeps the buttons; a settled one does not.
  case failed(PendingActionFailure)

  public var isSubmitting: Bool {
    if case .submitting = self { return true }
    return false
  }

  /// Whether the card still offers approve and deny.
  public var offersDecision: Bool {
    switch self {
    case .open: true
    case .failed(let failure): failure.isRetryable
    case .submitting, .answered: false
    }
  }
}
