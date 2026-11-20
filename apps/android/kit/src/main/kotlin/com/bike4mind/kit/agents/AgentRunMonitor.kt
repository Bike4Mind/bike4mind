package com.bike4mind.kit.agents

import com.bike4mind.kit.networking.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A run the app is following: enough to title its notification and open its chat. */
data class AgentRunWatch(val trackingId: String, val executionId: String, val sessionId: String, val title: String)

/** Where the monitor reports. The app implements it with the ongoing notification. */
interface AgentRunTracker {
    fun runChanged(run: AgentRunWatch, progress: AgentRunProgress)

    /** Watching stopped, whatever the reason: a terminal state, a refusal, the poll cap or [AgentRunMonitor.stopAll]. */
    fun runEnded(run: AgentRunWatch) {}
}

/**
 * Follows started agent runs by polling `GET /api/v1/agent-executions/{id}` and reports each poll to [tracker].
 * Twin of apps/ios B4MKit/Agents/AgentRunMonitor.swift. REST-started runs have no realtime stream, so polling is
 * the only signal. [scope] must outlive any screen: a run is fire-and-forget, so leaving the chat keeps watching.
 */
class AgentRunMonitor(
    private val api: AgentRunApi,
    private val tracker: AgentRunTracker,
    private val scope: CoroutineScope,
    private val intervalMs: Long = 5_000,
    /** Hard stop per run. */
    private val maxPolls: Int = (FOLLOW_FOR_MS / intervalMs).toInt(),
) {
    companion object {
        /** How long a run is followed at most. ChatController follows the run's turn for as long. */
        const val FOLLOW_FOR_MS = 60 * 60 * 1_000L
    }

    private val watching = mutableMapOf<String, Job>()

    val watchedExecutionIds: Set<String> get() = synchronized(watching) { watching.keys.toSet() }

    fun watch(run: AgentRunWatch) {
        val job = synchronized(watching) {
            if (run.executionId in watching) return
            // Lazy, so the job is recorded before its finally block can run and remove it.
            scope.launch(start = CoroutineStart.LAZY) {
                try {
                    poll(run)
                } finally {
                    synchronized(watching) { watching.remove(run.executionId) }
                    tracker.runEnded(run)
                }
            }.also { watching[run.executionId] = it }
        }
        job.start()
    }

    fun stopAll() {
        val jobs = synchronized(watching) { watching.values.toList().also { watching.clear() } }
        jobs.forEach { it.cancel() }
    }

    private suspend fun poll(run: AgentRunWatch) {
        repeat(maxPolls) {
            delay(intervalMs)
            val status = try {
                api.run(run.executionId)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (refused: ApiException) {
                // A 4xx will not heal by asking again (the run is gone or not ours); a 5xx might.
                if (refused.status in 400..499 && refused.status != 408 && refused.status != 429) return
                return@repeat
            } catch (transient: Exception) {
                return@repeat
            }
            tracker.runChanged(run, AgentRunProgress.from(status))
            if (status.state.isTerminal) return
        }
    }
}

/** Starts an agent run for a session. Screens depend on this, not on the API and monitor behind it. */
fun interface AgentRunStarter {
    suspend fun start(sessionId: String, title: String, message: String): AgentRunReceipt
}

/** The fire-and-forget run: start it over REST, show its notification, and keep that notification current. */
class AgentRunService(
    private val api: AgentRunApi,
    private val tracker: AgentRunTracker,
    private val monitor: AgentRunMonitor,
) : AgentRunStarter {
    override suspend fun start(sessionId: String, title: String, message: String): AgentRunReceipt {
        val receipt = api.start(sessionId, message)
        val watch = AgentRunWatch(receipt.trackingId, receipt.executionId, receipt.sessionId, title)
        tracker.runChanged(watch, AgentRunProgress.starting)
        monitor.watch(watch)
        return receipt
    }
}
