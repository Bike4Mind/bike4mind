package com.bike4mind.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.bike4mind.app.R
import com.bike4mind.kit.approvals.ApprovalCardState
import com.bike4mind.kit.approvals.PendingActionDecision
import com.bike4mind.kit.approvals.PendingActionFailure
import com.bike4mind.kit.approvals.PendingActionResult
import com.bike4mind.kit.sessions.PendingAction
import com.bike4mind.kit.sessions.PendingActionConnector
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ApprovalCardTest {
    @get:Rule
    val compose = createComposeRule()

    private val fresh = PendingAction("create_issue", mapOf("title" to "Bug", "repo" to "web"), System.currentTimeMillis())

    private fun string(id: Int, vararg args: Any) = RuntimeEnvironment.getApplication().getString(id, *args)

    private fun show(state: ApprovalCardState, action: PendingAction = fresh, onRespond: (PendingActionDecision) -> Unit = {}) =
        compose.setContent { ApprovalCard(action, state, onRespond) }

    private fun assertButtons(shown: Boolean) {
        val count = if (shown) 1 else 0
        assertEquals(count, compose.onAllNodesWithTagCount("message-approve-btn"))
        assertEquals(count, compose.onAllNodesWithTagCount("message-deny-btn"))
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTagCount(tag: String) =
        onAllNodes(androidx.compose.ui.test.hasTestTag(tag)).fetchSemanticsNodes().size

    @Test
    fun anOpenCardShowsTheToolItsSortedParamsAndBothButtons() {
        val answers = mutableListOf<PendingActionDecision>()
        show(ApprovalCardState.Open) { answers += it }

        compose.onNodeWithText("create_issue").assertIsDisplayed()
        compose.onNodeWithText(string(R.string.approval_param, "repo", "web")).assertIsDisplayed()
        compose.onNodeWithText(string(R.string.approval_param, "title", "Bug")).assertIsDisplayed()
        compose.onNodeWithTag("message-approval-status").assertTextEquals(string(R.string.approval_open))
        assertButtons(shown = true)

        compose.onNodeWithTag("message-approve-btn").performClick()
        compose.onNodeWithTag("message-deny-btn").performClick()
        assertEquals(listOf(PendingActionDecision.APPROVE, PendingActionDecision.DENY), answers)
    }

    @Test
    fun aCustomConnectorCardNamesTheConnectorAndHost() {
        show(ApprovalCardState.Open, fresh.copy(connector = PendingActionConnector("Acme", "mcp.acme.test")))

        compose.onNodeWithTag("message-approval-connector")
            .assertTextEquals(string(R.string.approval_connector, "Acme", "mcp.acme.test"))
    }

    @Test
    fun aBuiltInCardShowsNoConnectorAndNoExpandButton() {
        show(ApprovalCardState.Open)

        assertEquals(0, compose.onAllNodesWithTagCount("message-approval-connector"))
        assertEquals(0, compose.onAllNodesWithTagCount("message-approval-expand-btn"))
        compose.onNodeWithTag("message-approve-btn").assertIsEnabled()
    }

    @Test
    fun aClippedArgumentMustBeShownInFullBeforeApprove() {
        val long = (1..6).joinToString("\n") { "line $it" }
        show(ApprovalCardState.Open, fresh.copy(params = mapOf("body" to long)))

        compose.onNodeWithTag("message-approve-btn").assertIsNotEnabled()
        compose.onNodeWithTag("message-approval-expand-btn").performClick()
        compose.onNodeWithText(string(R.string.approval_param, "body", long)).assertIsDisplayed()
        compose.onNodeWithTag("message-approve-btn").assertIsEnabled()
    }

    @Test
    fun aLapsedRequestSaysSoAndHidesTheButtons() {
        show(ApprovalCardState.Open, fresh.copy(requestedAtMs = System.currentTimeMillis() - PendingAction.LIFETIME_MS - 1))

        compose.onNodeWithTag("message-approval-status").assertTextEquals(string(R.string.approval_lapsed))
        assertButtons(shown = false)
    }

    @Test
    fun submittingAndAnsweredCardsHideTheButtons() {
        show(ApprovalCardState.Submitting(PendingActionDecision.DENY))
        compose.onNodeWithTag("message-approval-status").assertTextEquals(string(R.string.approval_denying))
        assertButtons(shown = false)
    }

    @Test
    fun anApprovedActionWhoseToolFailedSaysSo() {
        show(ApprovalCardState.Answered(PendingActionResult(PendingActionDecision.APPROVE, toolSucceeded = false)))
        compose.onNodeWithTag("message-approval-status").assertTextEquals(string(R.string.approval_approved_tool_failed))
        assertButtons(shown = false)
    }

    @Test
    fun aRetryableFailureKeepsTheButtons() {
        show(ApprovalCardState.Failed(PendingActionFailure.Offline))
        compose.onNodeWithTag("message-approval-status").assertTextEquals(string(R.string.approval_failed_offline))
        assertButtons(shown = true)
    }

    @Test
    fun aSettledFailureHidesTheButtons() {
        show(ApprovalCardState.Failed(PendingActionFailure.Replaced))
        compose.onNodeWithTag("message-approval-status").assertTextEquals(string(R.string.approval_failed_replaced))
        assertButtons(shown = false)
    }

    @Test
    fun aRefusalShowsTheServerTextOrAFallback() {
        show(ApprovalCardState.Failed(PendingActionFailure.Refused("Repository not enabled")))
        compose.onNodeWithTag("message-approval-status").assertTextEquals("Repository not enabled")
    }

    @Test
    fun aRefusalWithoutTextFallsBack() {
        show(ApprovalCardState.Failed(PendingActionFailure.Refused(null)))
        compose.onNodeWithTag("message-approval-status").assertTextEquals(string(R.string.approval_failed_unavailable))
    }
}
