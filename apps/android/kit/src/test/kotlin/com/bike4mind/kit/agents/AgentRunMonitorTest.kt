package com.bike4mind.kit.agents

import com.bike4mind.kit.agents.AgentRunStatus.State
import com.bike4mind.kit.agents.AgentRunStatus.Step
import com.bike4mind.kit.networking.ApiException
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

private class FakeAgentRunApi : AgentRunApi {
    val results = ArrayDeque<Result<AgentRunStatus>>()
    var startResult: Result<AgentRunReceipt> = Result.success(AgentRunReceipt("exec-1", "quest-1", "s1"))
    val polled = mutableListOf<String>()
    val started = mutableListOf<Pair<String, String>>()

    override suspend fun start(sessionId: String, message: String): AgentRunReceipt {
        started += sessionId to message
        return startResult.getOrThrow()
    }

    override suspend fun run(id: String): AgentRunStatus {
        polled += id
        val next = if (results.size > 1) results.removeFirst() else results.first()
        return next.getOrThrow()
    }
}

private class RecordingTracker : AgentRunTracker {
    val changes = mutableListOf<Pair<AgentRunWatch, AgentRunProgress>>()
    val ended = mutableListOf<AgentRunWatch>()

    override fun runChanged(run: AgentRunWatch, progress: AgentRunProgress) {
        changes += run to progress
    }

    override fun runEnded(run: AgentRunWatch) {
        ended += run
    }
}

/** backgroundScope work is invisible to advanceUntilIdle, so virtual time is moved past every poll instead. */
private fun TestScope.settle() {
    advanceTimeBy(60_000)
    runCurrent()
}

private fun status(state: State, steps: List<Step> = emptyList(), iterations: Int? = null) =
    Result.success(AgentRunStatus("exec-1", state, steps, iterations = iterations))

class AgentRunMonitorTest {
    private val watch = AgentRunWatch("quest-1", "exec-1", "s1", "Quarterly review")

    private fun TestScope.monitor(api: FakeAgentRunApi, tracker: RecordingTracker, maxPolls: Int = 720) =
        AgentRunMonitor(api, tracker, backgroundScope, intervalMs = 5_000, maxPolls = maxPolls)

    @Test
    fun pollsReportEachStateAndStopAtTheTerminalOne() = runTest {
        val api = FakeAgentRunApi().apply {
            results += status(State.RUNNING, listOf(Step(Step.Kind.ACTION, "web_search")), iterations = 1)
            results += status(State.AWAITING_PERMISSION)
            results += status(State.COMPLETED)
        }
        val tracker = RecordingTracker()
        val monitor = monitor(api, tracker)

        monitor.watch(watch)
        monitor.watch(watch)
        advanceTimeBy(60_000)
        runCurrent()

        assertEquals(listOf(watch, watch, watch), tracker.changes.map { it.first })
        assertEquals(
            listOf(AgentRunPhase.RUNNING, AgentRunPhase.APPROVAL_NEEDED, AgentRunPhase.COMPLETED),
            tracker.changes.map { it.second.phase },
        )
        assertEquals(AgentRunProgress(AgentRunPhase.RUNNING, "Using web_search", 1), tracker.changes.first().second)
        assertEquals(3, api.polled.size, "no polling past the terminal state, and one watcher per run")
        assertTrue(monitor.watchedExecutionIds.isEmpty())
        assertEquals(listOf(watch), tracker.ended)
    }

    @Test
    fun aTransientErrorKeepsPollingButARefusalStops() = runTest {
        val api = FakeAgentRunApi().apply {
            results += Result.failure(IOException("offline"))
            results += Result.failure(ApiException(503))
            results += status(State.COMPLETED)
        }
        val tracker = RecordingTracker()
        monitor(api, tracker).watch(watch)
        settle()
        assertEquals(listOf(AgentRunPhase.COMPLETED), tracker.changes.map { it.second.phase })

        val gone = FakeAgentRunApi().apply { results += Result.failure(ApiException(404)) }
        val goneTracker = RecordingTracker()
        val goneMonitor = monitor(gone, goneTracker)
        goneMonitor.watch(watch)
        settle()
        assertTrue(goneTracker.changes.isEmpty())
        assertEquals(1, gone.polled.size)
        assertTrue(goneMonitor.watchedExecutionIds.isEmpty())
        assertEquals(listOf(watch), goneTracker.ended, "a refusal still ends the run's notification")
    }

    @Test
    fun pollingIsBounded() = runTest {
        val api = FakeAgentRunApi().apply { results += status(State.RUNNING) }
        val tracker = RecordingTracker()
        val monitor = monitor(api, tracker, maxPolls = 4)
        monitor.watch(watch)
        settle()
        assertEquals(4, api.polled.size)
        assertTrue(monitor.watchedExecutionIds.isEmpty())
        assertEquals(listOf(watch), tracker.ended)
    }

    @Test
    fun stopAllCancelsEveryWatcher() = runTest {
        val api = FakeAgentRunApi().apply { results += status(State.RUNNING) }
        val tracker = RecordingTracker()
        val monitor = monitor(api, tracker)
        monitor.watch(watch)
        runCurrent()
        monitor.stopAll()
        advanceTimeBy(60_000)
        assertTrue(api.polled.isEmpty())
        assertTrue(monitor.watchedExecutionIds.isEmpty())
        assertEquals(listOf(watch), tracker.ended)
    }
}

class AgentRunServiceTest {
    @Test
    fun startingARunReportsItAsStartingBeforeWatchingIt() = runTest {
        val api = FakeAgentRunApi().apply { results += status(State.COMPLETED) }
        val tracker = RecordingTracker()
        val monitor = AgentRunMonitor(api, tracker, backgroundScope)
        val service = AgentRunService(api, tracker, monitor)

        val receipt = service.start("s1", "Quarterly review", "Audit this")
        settle()

        assertEquals(listOf("s1" to "Audit this"), api.started)
        assertEquals("quest-1", receipt.trackingId)
        val expected = AgentRunWatch("quest-1", "exec-1", "s1", "Quarterly review")
        assertEquals(
            listOf(expected to AgentRunProgress.starting, expected to AgentRunProgress(AgentRunPhase.COMPLETED)),
            tracker.changes,
        )
    }

    @Test
    fun aRunTheServerRefusesShowsNothing() = runTest {
        val api = FakeAgentRunApi().apply { startResult = Result.failure(ApiException(409)) }
        val tracker = RecordingTracker()
        val monitor = AgentRunMonitor(api, tracker, backgroundScope)
        assertFailsWith<ApiException> { AgentRunService(api, tracker, monitor).start("s1", "t", "go") }
        assertTrue(tracker.changes.isEmpty())
        assertTrue(monitor.watchedExecutionIds.isEmpty())
    }
}

class AgentRunProgressTest {
    private fun progress(state: State, steps: List<Step> = emptyList(), error: String? = null) =
        AgentRunProgress.from(AgentRunStatus("e1", state, steps, error))

    @Test
    fun eachStateMapsToTheLiveActivityPhase() {
        assertEquals(AgentRunPhase.COMPLETED, progress(State.COMPLETED).phase)
        assertEquals(AgentRunPhase.FAILED, progress(State.FAILED).phase)
        assertEquals(AgentRunPhase.STOPPED, progress(State.ABORTED).phase)
        assertEquals(AgentRunProgress(AgentRunPhase.APPROVAL_NEEDED, "Waiting for your approval"), progress(State.AWAITING_PERMISSION))
        assertEquals(AgentRunProgress(AgentRunPhase.PAUSED, "Waiting for your input"), progress(State.PAUSED))
        for (state in listOf(State.PENDING, State.RUNNING, State.CONTINUING, State.AWAITING_SUBAGENT, State.AWAITING_DAG_CHILDREN)) {
            assertEquals(AgentRunPhase.RUNNING, progress(state).phase, state.wire)
        }
        assertTrue(AgentRunPhase.APPROVAL_NEEDED.needsUser && AgentRunPhase.PAUSED.needsUser)
        assertTrue(!AgentRunPhase.RUNNING.needsUser && !AgentRunPhase.RUNNING.isTerminal)
    }

    @Test
    fun theStageLabelFollowsTheLastTool() {
        val using = listOf(Step(Step.Kind.THOUGHT), Step(Step.Kind.ACTION, "web_search"))
        assertEquals("Using web_search", progress(State.RUNNING, using).stageLabel)
        assertEquals("Finished web_search", progress(State.RUNNING, using + Step(Step.Kind.OBSERVATION)).stageLabel)
        assertEquals(null, progress(State.RUNNING, listOf(Step(Step.Kind.OBSERVATION), Step(Step.Kind.ACTION, ""))).stageLabel)
        assertEquals("Using " + "t".repeat(51) + "...", progress(State.RUNNING, listOf(Step(Step.Kind.ACTION, "t".repeat(80)))).stageLabel)
    }

    @Test
    fun aStepTotalIsCarriedOnlyWhenTheServerSendsOne() {
        val known = AgentRunStatus("e1", State.RUNNING, iterations = 4, stepProgress = StepProgress(1, 3))
        assertEquals(AgentRunProgress(AgentRunPhase.RUNNING, null, 4, StepProgress(1, 3)), AgentRunProgress.from(known))
        assertNull(progress(State.RUNNING).steps)
    }

    @Test
    fun aStepCountIsCappedAtItsTotalAndAnUndrawableOneIsDropped() {
        assertEquals(StepProgress(3, 3), StepProgress.of(7, 3))
        assertNull(StepProgress.of(1, 0))
        assertNull(StepProgress.of(-1, 3))
        assertNull(StepProgress.of(null, 3))
    }

    @Test
    fun aFailureCarriesItsReasonAsTheLabel() {
        assertEquals("Tool needs approval: web_browse", progress(State.FAILED, error = " Tool needs approval: web_browse ").stageLabel)
    }

    @Test
    fun titlesComeFromTheOpeningOfThePrompt() {
        assertEquals("Audit the Q3 numbers", AgentRunTitle.fromPrompt("  Audit   the\nQ3 numbers "))
        assertEquals("Bike4Mind", AgentRunTitle.fromPrompt("   "))
        assertEquals("a".repeat(37) + "...", AgentRunTitle.fromPrompt("a".repeat(50)))
    }
}
