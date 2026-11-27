package com.bike4mind.kit.approvals

/**
 * What the transcript's approval card shows for one pending action, beyond what the stored turn says. Twin of
 * apps/ios ApprovalCardState.
 */
sealed interface ApprovalCardState {
    /** Nothing answered from this screen yet: the card offers approve and deny. */
    data object Open : ApprovalCardState

    data class Submitting(val decision: PendingActionDecision) : ApprovalCardState

    /** Answered here. The turn keeps its pending action until the quest moves on, so this is what hides the buttons. */
    data class Answered(val result: PendingActionResult) : ApprovalCardState

    /** The server refused or the call failed. A retryable failure keeps the buttons; a settled one does not. */
    data class Failed(val failure: PendingActionFailure) : ApprovalCardState

    /** Whether the card still offers approve and deny. */
    val offersDecision: Boolean
        get() = when (this) {
            Open -> true
            is Failed -> failure.isRetryable
            is Submitting, is Answered -> false
        }
}
