package com.bike4mind.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import com.bike4mind.app.R
import com.bike4mind.kit.approvals.ApprovalCardState
import com.bike4mind.kit.approvals.PendingActionDecision
import com.bike4mind.kit.approvals.PendingActionFailure
import com.bike4mind.kit.sessions.PendingAction
import kotlinx.coroutines.delay

/**
 * Shows which tool the agent is waiting on and with what, and answers it. The server decides whether the request
 * is still current, so a late, replaced or already-answered request comes back as a message here, never as a
 * silent no-op. Twin of the PendingActionCard in apps/ios MessageBubble.swift.
 */
@Composable
fun ApprovalCard(action: PendingAction, state: ApprovalCardState, onRespond: (PendingActionDecision) -> Unit) {
    // Re-read the clock every 30 s so an unanswered card turns into "expired" without a new frame.
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(LAPSE_CHECK_MS)
            value = System.currentTimeMillis()
        }
    }
    val lapsed = action.hasLapsed(now)

    OutlinedCard(modifier = Modifier.fillMaxWidth().testTag("message-pending-action")) {
        Column(modifier = Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Text(action.tool, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            action.params.toSortedMap().forEach { (name, value) ->
                Text(
                    stringResource(R.string.approval_param, name, value),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    status(state, lapsed),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (state is ApprovalCardState.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f, fill = false).testTag("message-approval-status"),
                )
                if (state is ApprovalCardState.Submitting) CircularProgressIndicator(modifier = Modifier.size(Spacing.m))
            }
            if (state.offersDecision && !lapsed) {
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    Button(onClick = { onRespond(PendingActionDecision.APPROVE) }, modifier = Modifier.testTag("message-approve-btn")) {
                        Text(stringResource(R.string.approval_approve))
                    }
                    OutlinedButton(
                        onClick = { onRespond(PendingActionDecision.DENY) },
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                        modifier = Modifier.testTag("message-deny-btn"),
                    ) {
                        Text(stringResource(R.string.approval_deny))
                    }
                }
            }
        }
    }
}

@Composable
private fun status(state: ApprovalCardState, lapsed: Boolean): String = when (state) {
    ApprovalCardState.Open -> stringResource(if (lapsed) R.string.approval_lapsed else R.string.approval_open)
    is ApprovalCardState.Submitting -> stringResource(
        if (state.decision == PendingActionDecision.APPROVE) R.string.approval_approving else R.string.approval_denying,
    )
    is ApprovalCardState.Answered -> when {
        state.result.decision == PendingActionDecision.DENY -> stringResource(R.string.approval_denied)
        state.result.toolSucceeded -> stringResource(R.string.approval_approved)
        else -> stringResource(R.string.approval_approved_tool_failed)
    }
    is ApprovalCardState.Failed -> failure(state.failure)
}

@Composable
private fun failure(failure: PendingActionFailure): String = when (failure) {
    PendingActionFailure.Replaced -> stringResource(R.string.approval_failed_replaced)
    PendingActionFailure.Expired -> stringResource(R.string.approval_failed_expired)
    PendingActionFailure.AlreadyResolved -> stringResource(R.string.approval_failed_already_answered)
    PendingActionFailure.NotFound -> stringResource(R.string.approval_failed_not_found)
    PendingActionFailure.Unavailable -> stringResource(R.string.approval_failed_unavailable)
    is PendingActionFailure.Refused -> failure.reason ?: stringResource(R.string.approval_failed_unavailable)
    PendingActionFailure.Offline -> stringResource(R.string.approval_failed_offline)
    PendingActionFailure.RateLimited -> stringResource(R.string.approval_failed_rate_limited)
    PendingActionFailure.ServerError -> stringResource(R.string.approval_failed_server)
    PendingActionFailure.SignedOut -> stringResource(R.string.approval_failed_signed_out)
    PendingActionFailure.UpgradeRequired -> stringResource(R.string.approval_failed_upgrade)
}

private const val LAPSE_CHECK_MS = 30_000L
