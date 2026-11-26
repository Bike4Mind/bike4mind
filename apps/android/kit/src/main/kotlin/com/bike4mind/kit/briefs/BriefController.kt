package com.bike4mind.kit.briefs

import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.UpgradeRequiredException
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

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
    /** Follow-up decisions with an edit, approve or dismiss in flight; a second tap on one is ignored. */
    val followUpBusy: Set<String> = emptySet(),
    /** Why the last edit, approve or dismiss of a follow-up failed, by decision id. */
    val followUpErrors: Map<String, String> = emptyMap(),
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
    private val pollWindowMillis: Long = 90_000,
) {
    private val mutableState = MutableStateFlow(BriefState())
    val state: StateFlow<BriefState> = mutableState.asStateFlow()

    init {
        require(pollIntervalMillis > 0) { "pollIntervalMillis must be positive" }
        require(pollWindowMillis > 0) { "pollWindowMillis must be positive" }
    }

    private var job: Job? = null

    /** A memo brief started here. The list only carries activity briefs, so it stays reachable by id alone. */
    private var memoBriefId: String? = null

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
            memoBriefId = null
            mutableState.update { it.copy(loading = false, brief = composed) }
            pollWhileComposing()
        }
    }

    /** Sends a dictated follow-up memo, then shows the brief it starts and polls it until it settles. */
    fun startFollowUp(transcript: String) {
        val trimmed = transcript.trim().take(FOLLOW_UP_TRANSCRIPT_MAX)
        if (trimmed.isEmpty() || state.value.composing) return
        launchExclusive {
            mutableState.update { it.copy(composing = true, composeTimedOut = false, error = null) }
            val started = attempt { api.followUp(trimmed, ZoneId.systemDefault().id) } ?: return@launchExclusive
            memoBriefId = started.id
            mutableState.update { it.copy(loading = false, brief = started) }
            pollWhileComposing()
        }
    }

    /** Saves an edit to a pending follow-up; [onSaved] runs only when it was saved, so a form can stay open. */
    fun editFollowUp(decision: BriefDecision, edit: BriefDecisionEdit, onSaved: () -> Unit = {}) {
        if (edit.isEmpty) return
        submitFollowUp(decision, { briefId -> api.editDecision(briefId, decision.id, edit) }) { onSaved() }
    }

    /**
     * Approves or dismisses a pending follow-up. An approved email's draft goes to [onEmailApproved] for the device
     * mail app; the server never sends it.
     */
    fun resolveFollowUp(decision: BriefDecision, outcome: BriefDecisionOutcome, onEmailApproved: (BriefDraftReply) -> Unit = {}) {
        submitFollowUp(decision, { briefId -> api.resolveDecision(briefId, decision.id, outcome) }) { resolved ->
            if (outcome == BriefDecisionOutcome.APPROVE && resolved.followUp?.kind == FollowUpKind.FOLLOW_UP_EMAIL) {
                resolved.draftReply?.let(onEmailApproved)
            }
        }
    }

    private fun submitFollowUp(decision: BriefDecision, call: suspend (String) -> BriefDecision, onDone: (BriefDecision) -> Unit) {
        val brief = state.value.brief ?: return
        val current = brief.decisions.firstOrNull { it.id == decision.id } ?: return
        if (current.followUp?.isActionable != true || decision.id in state.value.followUpBusy) return
        mutableState.update { it.copy(followUpBusy = it.followUpBusy + decision.id, followUpErrors = it.followUpErrors - decision.id) }
        scope.launch {
            try {
                val updated = call(brief.id)
                mutableState.update { s ->
                    s.copy(
                        brief = s.brief?.let { shown -> if (shown.id == brief.id) shown.replacing(updated) else shown },
                        followUpBusy = s.followUpBusy - decision.id,
                    )
                }
                onDone(updated)
            } catch (cancelled: CancellationException) {
                mutableState.update { it.copy(followUpBusy = it.followUpBusy - decision.id) }
                throw cancelled
            } catch (closed: DecisionClosedException) {
                // Settled elsewhere (another device, a double tap): the refetched live state shows what became of it.
                mutableState.update { it.copy(followUpBusy = it.followUpBusy - decision.id) }
                val fresh = attempt { api.brief(brief.id) } ?: return@launch
                mutableState.update { s -> if (s.brief?.id == brief.id) s.copy(brief = fresh) else s }
            } catch (failure: Exception) {
                mutableState.update {
                    it.copy(followUpBusy = it.followUpBusy - decision.id, followUpErrors = it.followUpErrors + (decision.id to decisionMessage(failure)))
                }
            }
        }
    }

    private fun launchExclusive(block: suspend () -> Unit) {
        job?.cancel()
        job = scope.launch { block() }
    }

    private suspend fun fetch() {
        // A retry/refresh keeps a memo started here and the in-progress brief, even if an older ready one is listed.
        val requestedId = memoBriefId ?: briefId ?: state.value.brief?.takeIf { it.status == BriefStatus.COMPOSING }?.id
        val brief = attempt {
            if (requestedId != null) {
                api.brief(requestedId)
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
        // One deadline includes both the intervals and every suspended HTTP read.
        val completed = withTimeoutOrNull(pollWindowMillis) {
            while (state.value.brief?.status == BriefStatus.COMPOSING) {
                delay(pollIntervalMillis)
                val id = state.value.brief?.id ?: return@withTimeoutOrNull
                val current = attempt { api.brief(id) } ?: return@withTimeoutOrNull
                mutableState.update { it.copy(brief = current) }
            }
        }
        mutableState.update { it.copy(composing = false, composeTimedOut = completed == null) }
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

        // Must match BRIEF_LIMITS.followUpTranscript in b4m-core/common/src/schemas/brief.ts.
        const val FOLLOW_UP_TRANSCRIPT_MAX = 6_000

        fun decisionMessage(failure: Exception): String = when {
            failure is InvalidDecisionException -> failure.message ?: BriefWire.FALLBACK_INVALID
            failure is ApiException && failure.status == 404 -> "This follow-up is no longer available."
            failure is ApiException && failure.status == 429 -> "Too many requests. Try again in a moment."
            failure is ApiException -> "The server could not save that (HTTP ${failure.status})."
            failure is MalformedBriefException -> "This follow-up needs a newer version of Bike4Mind."
            else -> "Couldn't reach Bike4Mind. Check your connection and try again."
        }

        fun message(failure: Exception): String = when {
            failure is ApiException && failure.status == 404 -> "This brief is no longer available."
            failure is ApiException && failure.status == 429 -> "Too many requests. Try again in a moment."
            failure is ApiException -> "The server could not load the brief (HTTP ${failure.status})."
            failure is MalformedBriefException -> "This brief needs a newer version of Bike4Mind."
            else -> "Couldn't reach Bike4Mind. Check your connection and try again."
        }
    }
}
