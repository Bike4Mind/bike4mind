package com.bike4mind.kit.briefs

import com.bike4mind.kit.networking.ApiException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class BriefControllerTest {
    private class FakeApi : BriefApi {
        var listed: List<Brief> = emptyList()
        val byId = mutableMapOf<String, ArrayDeque<Brief>>()
        var composed: Brief? = null
        var failure: Exception? = null
        var composeCalls = 0
        var responseDelayMillis = 0L
        var neverRespond = false
        var cancelledReads = 0
        val fetchedIds = mutableListOf<String>()
        var followUpStarted: Brief? = null
        val followUpTranscripts = mutableListOf<String>()
        var resolveResult: () -> BriefDecision = { error("no resolve result") }
        var editResult: () -> BriefDecision = { error("no edit result") }
        val resolveCalls = mutableListOf<BriefDecisionOutcome>()
        var resolveDelayMillis = 0L

        override suspend fun followUp(transcript: String, timeZone: String?): Brief {
            followUpTranscripts += transcript
            return followUpStarted!!
        }

        override suspend fun editDecision(briefId: String, decisionId: String, edit: BriefDecisionEdit): BriefDecision = editResult()

        override suspend fun resolveDecision(briefId: String, decisionId: String, outcome: BriefDecisionOutcome): BriefDecision {
            resolveCalls += outcome
            delay(resolveDelayMillis)
            return resolveResult()
        }

        override suspend fun compose(): Brief {
            composeCalls++
            failure?.let { throw it }
            return composed!!
        }

        override suspend fun list(): List<Brief> {
            failure?.let { throw it }
            return listed
        }

        override suspend fun brief(id: String): Brief {
            fetchedIds += id
            return try {
                delay(responseDelayMillis)
                if (neverRespond) awaitCancellation()
                failure?.let { throw it }
                val queue = byId.getValue(id)
                if (queue.size > 1) queue.removeFirst() else queue.first()
            } catch (cancelled: CancellationException) {
                cancelledReads++
                throw cancelled
            }
        }
    }

    private fun brief(id: String, status: BriefStatus, headline: String? = "Headline") =
        Brief(id = id, status = status, createdAt = null, periodStart = null, periodEnd = null, headline = headline)

    private fun TestScope.controller(api: FakeApi, briefId: String? = null) =
        BriefController(api, briefId, backgroundScope, pollIntervalMillis = 2_000, pollWindowMillis = 10_000)

    @Test
    fun aPushTapLoadsThatBrief() = runTest {
        val api = FakeApi().apply { byId["b1"] = ArrayDeque(listOf(brief("b1", BriefStatus.READY))) }
        val controller = controller(api, briefId = "b1")

        controller.load()
        runCurrent()

        assertEquals("b1", controller.state.value.brief?.id)
        assertFalse(controller.state.value.loading)
        assertEquals(listOf("b1"), api.fetchedIds)
    }

    @Test
    fun navigationShowsTheLatestReadyBriefOverANewerComposingOne() = runTest {
        val api = FakeApi().apply { listed = listOf(brief("new", BriefStatus.COMPOSING), brief("old", BriefStatus.READY)) }
        val controller = controller(api)

        controller.load()
        runCurrent()

        assertEquals("old", controller.state.value.brief?.id)
        assertFalse(controller.state.value.composing)
    }

    @Test
    fun noBriefsIsTheEmptyStateNotAnError() = runTest {
        val controller = controller(FakeApi())

        controller.load()
        runCurrent()

        assertNull(controller.state.value.brief)
        assertNull(controller.state.value.error)
        assertFalse(controller.state.value.loading)
    }

    @Test
    fun composePollsUntilTheBriefIsReady() = runTest {
        val api = FakeApi().apply {
            composed = brief("b2", BriefStatus.COMPOSING, headline = null)
            byId["b2"] = ArrayDeque(listOf(brief("b2", BriefStatus.COMPOSING, headline = null), brief("b2", BriefStatus.READY)))
        }
        val controller = controller(api)

        controller.compose()
        runCurrent()
        assertTrue(controller.state.value.composing)

        advanceTimeBy(2_001)
        assertEquals(BriefStatus.COMPOSING, controller.state.value.brief?.status)
        advanceTimeBy(2_000)
        assertEquals(BriefStatus.READY, controller.state.value.brief?.status)
        assertFalse(controller.state.value.composing)
        assertFalse(controller.state.value.composeTimedOut)
    }

    @Test
    fun aComposeThatNeverSettlesTimesOut() = runTest {
        val api = FakeApi().apply {
            composed = brief("b2", BriefStatus.COMPOSING)
            byId["b2"] = ArrayDeque(listOf(brief("b2", BriefStatus.COMPOSING)))
        }
        val controller = controller(api)

        controller.compose()
        // Four polls finish before the 10s deadline; no request starts at the deadline.
        advanceTimeBy(10_001)

        assertTrue(controller.state.value.composeTimedOut)
        assertFalse(controller.state.value.composing)
        assertEquals(4, api.fetchedIds.size)
    }

    @Test
    fun aSecondComposeWhileOneIsInFlightIsIgnored() = runTest {
        val api = FakeApi().apply {
            composed = brief("b2", BriefStatus.COMPOSING)
            byId["b2"] = ArrayDeque(listOf(brief("b2", BriefStatus.COMPOSING)))
        }
        val controller = controller(api)

        controller.compose()
        runCurrent()
        controller.compose()
        runCurrent()

        assertEquals(1, api.composeCalls)
    }

    @Test
    fun aFailedRefreshKeepsTheBriefOnScreen() = runTest {
        val api = FakeApi().apply { byId["b1"] = ArrayDeque(listOf(brief("b1", BriefStatus.READY))) }
        val controller = controller(api, briefId = "b1")
        controller.load()
        runCurrent()

        api.failure = ApiException(500)
        controller.load()
        runCurrent()

        assertEquals("b1", controller.state.value.brief?.id)
        assertEquals("The server could not load the brief (HTTP 500).", controller.state.value.error)
    }

    @Test
    fun aMissingBriefSaysSo() = runTest {
        val api = FakeApi().apply { failure = ApiException(404) }
        val controller = controller(api, briefId = "gone")

        controller.load()
        runCurrent()

        assertNull(controller.state.value.brief)
        assertEquals("This brief is no longer available.", controller.state.value.error)
    }
    @Test
    fun aSlowPollCannotExtendTheWholePollingDeadline() = runTest {
        val api = FakeApi().apply {
            composed = brief("b2", BriefStatus.COMPOSING)
            byId["b2"] = ArrayDeque(listOf(brief("b2", BriefStatus.COMPOSING)))
            responseDelayMillis = 3_000
        }
        val controller = controller(api)
        controller.compose()
        advanceTimeBy(10_001)

        assertTrue(controller.state.value.composeTimedOut)
        assertFalse(controller.state.value.composing)
        assertEquals(2, api.fetchedIds.size)
        assertEquals(1, api.cancelledReads)
    }

    @Test
    fun aHungPollIsCancelledAtTheWholePollingDeadline() = runTest {
        val api = FakeApi().apply {
            composed = brief("b2", BriefStatus.COMPOSING)
            neverRespond = true
        }
        val controller = controller(api)
        controller.compose()
        advanceTimeBy(10_001)

        assertTrue(controller.state.value.composeTimedOut)
        assertFalse(controller.state.value.composing)
        assertEquals(listOf("b2"), api.fetchedIds)
        assertEquals(1, api.cancelledReads)
    }

    @Test
    fun leavingTheScreenCancelsTheReadWithoutClaimingADeadlineFailure() = runTest {
        val api = FakeApi().apply {
            composed = brief("b2", BriefStatus.COMPOSING)
            neverRespond = true
        }
        val controller = controller(api)
        controller.compose()
        advanceTimeBy(2_001)
        backgroundScope.cancel()
        runCurrent()
        advanceTimeBy(10_000)

        assertEquals(1, api.cancelledReads)
        assertFalse(controller.state.value.composeTimedOut)
    }

    @Test
    fun aFailedComposingPollCanReloadTheExistingBriefWithoutComposingAgain() = runTest {
        val api = FakeApi().apply { byId["b1"] = ArrayDeque(listOf(brief("b1", BriefStatus.COMPOSING))) }
        val controller = controller(api, briefId = "b1")
        controller.load()
        runCurrent()
        api.failure = ApiException(500)
        advanceTimeBy(2_001)

        assertEquals(BriefStatus.COMPOSING, controller.state.value.brief?.status)
        assertEquals("The server could not load the brief (HTTP 500).", controller.state.value.error)
        assertFalse(controller.state.value.composing)
        api.failure = null
        api.byId["b1"] = ArrayDeque(listOf(brief("b1", BriefStatus.READY)))
        controller.load()
        runCurrent()

        assertEquals(BriefStatus.READY, controller.state.value.brief?.status)
        assertNull(controller.state.value.error)
        assertEquals(0, api.composeCalls)
    }

    @Test
    fun retryingAManuallyComposedBriefDoesNotSwitchToAnOlderReadyBrief() = runTest {
        val api = FakeApi().apply {
            composed = brief("b2", BriefStatus.COMPOSING)
            listed = listOf(brief("b2", BriefStatus.COMPOSING), brief("b1", BriefStatus.READY))
            byId["b2"] = ArrayDeque(listOf(brief("b2", BriefStatus.COMPOSING)))
        }
        val controller = controller(api)
        controller.compose()
        runCurrent()
        api.failure = ApiException(500)
        advanceTimeBy(2_001)
        assertEquals("b2", controller.state.value.brief?.id)
        assertTrue(controller.state.value.error != null)

        api.failure = null
        api.byId["b2"] = ArrayDeque(listOf(brief("b2", BriefStatus.READY)))
        controller.load()
        runCurrent()

        assertEquals("b2", controller.state.value.brief?.id)
        assertEquals(BriefStatus.READY, controller.state.value.brief?.status)
        assertNull(controller.state.value.error)
        assertEquals(listOf("b2", "b2"), api.fetchedIds)
        assertEquals(1, api.composeCalls)
    }


    private val draft = BriefDraftReply("sam@example.com", "Notes", "Here they are.")

    private fun email(state: FollowUpState) =
        BriefDecision("fu-email", "Send follow-up to Sam", followUp = BriefFollowUp(FollowUpKind.FOLLOW_UP_EMAIL, state), draftReply = draft)

    private fun followUpBrief(vararg decisions: BriefDecision) =
        Brief(id = "b2", status = BriefStatus.READY, createdAt = null, periodStart = null, periodEnd = null, headline = "Follow-ups", decisions = decisions.toList())

    @Test
    fun startFollowUpShowsTheComposingBriefAndPollsItToReady() = runTest {
        val api = FakeApi()
        api.followUpStarted = brief("b2", BriefStatus.COMPOSING)
        api.byId["b2"] = ArrayDeque(listOf(followUpBrief(email(FollowUpState.PENDING))))
        val controller = controller(api, briefId = "b2")
        controller.startFollowUp("  Email Sam the notes  ")
        advanceTimeBy(2_001)
        runCurrent()
        assertEquals(listOf("Email Sam the notes"), api.followUpTranscripts)
        assertEquals(BriefStatus.READY, controller.state.value.brief?.status)
        assertFalse(controller.state.value.composing)
    }

    @Test
    fun aRefreshAfterAMemoKeepsTheMemoBriefOverTheOpenedOrListedOne() = runTest {
        for (openedId in listOf("b1", null)) {
            val api = FakeApi()
            api.listed = listOf(brief("b1", BriefStatus.READY))
            api.byId["b1"] = ArrayDeque(listOf(brief("b1", BriefStatus.READY)))
            api.followUpStarted = brief("b2", BriefStatus.COMPOSING)
            api.byId["b2"] = ArrayDeque(listOf(followUpBrief(email(FollowUpState.PENDING))))
            val controller = controller(api, briefId = openedId)
            controller.load()
            runCurrent()
            controller.startFollowUp("Email Sam the notes")
            advanceTimeBy(2_001)
            runCurrent()
            controller.load()
            runCurrent()
            assertEquals("b2", controller.state.value.brief?.id)
        }
    }

    @Test
    fun approvingAnEmailIsSingleFlightAndHandsOffTheDraft() = runTest {
        val api = FakeApi()
        api.byId["b2"] = ArrayDeque(listOf(followUpBrief(email(FollowUpState.PENDING))))
        api.resolveResult = { email(FollowUpState.APPROVED) }
        api.resolveDelayMillis = 1_000
        val controller = controller(api, briefId = "b2")
        controller.load()
        runCurrent()
        val handed = mutableListOf<BriefDraftReply>()
        controller.resolveFollowUp(email(FollowUpState.PENDING), BriefDecisionOutcome.APPROVE) { handed += it }
        runCurrent()
        assertTrue("fu-email" in controller.state.value.followUpBusy)
        controller.resolveFollowUp(email(FollowUpState.PENDING), BriefDecisionOutcome.APPROVE) { handed += it }
        advanceTimeBy(1_001)
        runCurrent()
        assertEquals(listOf(BriefDecisionOutcome.APPROVE), api.resolveCalls)
        assertEquals(listOf(draft), handed)
        assertEquals(FollowUpState.APPROVED, controller.state.value.brief?.decisions?.single()?.followUp?.state)
        assertTrue(controller.state.value.followUpBusy.isEmpty())
    }

    @Test
    fun aClosedDecisionRefetchesWithoutAnError() = runTest {
        val api = FakeApi()
        api.byId["b2"] = ArrayDeque(listOf(followUpBrief(email(FollowUpState.PENDING)), followUpBrief(email(FollowUpState.DISMISSED))))
        api.resolveResult = { throw DecisionClosedException() }
        val controller = controller(api, briefId = "b2")
        controller.load()
        runCurrent()
        controller.resolveFollowUp(email(FollowUpState.PENDING), BriefDecisionOutcome.APPROVE)
        runCurrent()
        assertEquals(FollowUpState.DISMISSED, controller.state.value.brief?.decisions?.single()?.followUp?.state)
        assertTrue(controller.state.value.followUpErrors.isEmpty())
    }

    @Test
    fun dismissAndAFailedEditKeepTheirOwnOutcomes() = runTest {
        val api = FakeApi()
        api.byId["b2"] = ArrayDeque(listOf(followUpBrief(email(FollowUpState.PENDING))))
        api.editResult = { throw InvalidDecisionException("Edit the recipient to an email address first") }
        api.resolveResult = { email(FollowUpState.DISMISSED) }
        val controller = controller(api, briefId = "b2")
        controller.load()
        runCurrent()
        var saved = false
        controller.editFollowUp(email(FollowUpState.PENDING), BriefDecisionEdit(text = "New text")) { saved = true }
        runCurrent()
        assertFalse(saved)
        assertEquals("Edit the recipient to an email address first", controller.state.value.followUpErrors["fu-email"])
        assertEquals(email(FollowUpState.PENDING), controller.state.value.brief?.decisions?.single())
        val handed = mutableListOf<BriefDraftReply>()
        controller.resolveFollowUp(email(FollowUpState.PENDING), BriefDecisionOutcome.DISMISS) { handed += it }
        runCurrent()
        assertTrue(handed.isEmpty())
        assertEquals(FollowUpState.DISMISSED, controller.state.value.brief?.decisions?.single()?.followUp?.state)
        controller.resolveFollowUp(email(FollowUpState.DISMISSED), BriefDecisionOutcome.APPROVE)
        runCurrent()
        assertEquals(listOf(BriefDecisionOutcome.DISMISS), api.resolveCalls)
    }
}
