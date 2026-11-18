package com.bike4mind.kit.briefs

import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.UpgradeRequiredException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class BriefState(
    /** True until the first load settles. */
    val loading: Boolean = true,
    /** The brief on screen; null after a load that found none (the empty state). */
    val brief: Brief? = null,
    /** The last load or compose failed. Kept alongside [brief] so a failed refresh does not blank the screen. */
    val error: String? = null,
    /** A compose request or a poll of a composing brief is in flight. */
    val composing: Boolean = false,
    /** The poll gave up waiting. The brief may still finish: a refresh looks again. */
    val composeTimedOut: Boolean = false,
)

/**
 * The brief screen's state. With [briefId] (a push tap) it shows that brief; without one (in-app navigation) the
 * latest ready brief, else the latest. A brief still composing is polled until it settles. Twin of apps/ios
 * BriefViewModel; [scope] is the screen's, so leaving the screen stops the poll.
 */
class BriefController(
    private val api: BriefApi,
    private val briefId: String?,
    private val scope: CoroutineScope,
    private val pollIntervalMillis: Long = 2_000,
    pollWindowMillis: Long = 90_000,
) {
    private val mutableState = MutableStateFlow(BriefState())
    val state: StateFlow<BriefState> = mutableState.asStateFlow()

    private val maxPolls = (pollWindowMillis / pollIntervalMillis).toInt().coerceAtLeast(1)
    private var job: Job? = null

    fun load() = launchExclusive {
        fetch()
        pollWhileComposing()
    }

    /** Asks the server to compose a fresh brief, then polls until it is ready or failed. */
    fun compose() {
        if (state.value.composing) return
        launchExclusive {
            mutableState.update { it.copy(composing = true, composeTimedOut = false, error = null) }
            val composed = attempt { api.compose() } ?: return@launchExclusive
            mutableState.update { it.copy(loading = false, brief = composed) }
            pollWhileComposing()
        }
    }

    private fun launchExclusive(block: suspend () -> Unit) {
        job?.cancel()
        job = scope.launch { block() }
    }

    private suspend fun fetch() {
        val brief = attempt {
            if (briefId != null) {
                api.brief(briefId)
            } else {
                val briefs = api.list()
                briefs.firstOrNull { it.status == BriefStatus.READY } ?: briefs.firstOrNull() ?: NONE
            }
        } ?: return
        mutableState.update { it.copy(loading = false, brief = brief.takeUnless { brief === NONE }, error = null) }
    }

    private suspend fun pollWhileComposing() {
        if (state.value.brief?.status != BriefStatus.COMPOSING || state.value.error != null) {
            mutableState.update { it.copy(composing = false) }
            return
        }
        mutableState.update { it.copy(composing = true, composeTimedOut = false) }
        repeat(maxPolls) {
            delay(pollIntervalMillis)
            val id = state.value.brief?.id ?: return
            val current = attempt { api.brief(id) } ?: return
            mutableState.update { it.copy(brief = current) }
            if (current.status != BriefStatus.COMPOSING) {
                mutableState.update { it.copy(composing = false) }
                return
            }
        }
        mutableState.update { it.copy(composing = false, composeTimedOut = true) }
    }

    /** Runs [call]; on failure records the error, ends any compose in flight and returns null. */
    private suspend fun <T> attempt(call: suspend () -> T): T? = try {
        call()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (upgrade: UpgradeRequiredException) {
        // The upgrade screen covers the app; there is nothing to say here.
        mutableState.update { it.copy(loading = false, composing = false) }
        null
    } catch (failure: Exception) {
        mutableState.update { it.copy(loading = false, composing = false, error = message(failure)) }
        null
    }

    private companion object {
        /** Marks "the list was empty" apart from a failed call (null). */
        val NONE = Brief(id = "", status = BriefStatus.UNKNOWN, createdAt = null, periodStart = null, periodEnd = null)

        fun message(failure: Exception): String = when {
            failure is ApiException && failure.status == 404 -> "This brief is no longer available."
            failure is ApiException && failure.status == 429 -> "Too many requests. Try again in a moment."
            failure is ApiException -> "The server could not load the brief (HTTP ${failure.status})."
            failure is MalformedBriefException -> "This brief needs a newer version of Bike4Mind."
            else -> "Couldn't reach Bike4Mind. Check your connection and try again."
        }
    }
}
