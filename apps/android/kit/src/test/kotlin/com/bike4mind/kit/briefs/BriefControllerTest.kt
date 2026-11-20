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

}
