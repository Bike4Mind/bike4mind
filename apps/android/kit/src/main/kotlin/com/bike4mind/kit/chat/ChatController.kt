package com.bike4mind.kit.chat

import com.bike4mind.kit.agents.AgentRunMonitor
import com.bike4mind.kit.agents.AgentRunReceipt
import com.bike4mind.kit.agents.AgentRunStarter
import com.bike4mind.kit.agents.AgentRunTitle
import com.bike4mind.kit.approvals.ApprovalCardState
import com.bike4mind.kit.approvals.PendingActionApi
import com.bike4mind.kit.approvals.PendingActionDecision
import com.bike4mind.kit.approvals.PendingActionFailure
import com.bike4mind.kit.approvals.PendingActionOutcome
import com.bike4mind.kit.approvals.PendingActionTarget
import com.bike4mind.kit.realtime.RealtimeFrames
import com.bike4mind.kit.sessions.PendingAction
import com.bike4mind.kit.sessions.Quest
import com.bike4mind.kit.sessions.QuestStatus
import com.bike4mind.kit.sessions.SessionsRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class ChatState(
    val sessionId: String?,
    val turns: List<Quest> = emptyList(),
    val loading: Boolean = false,
    val sending: Boolean = false,
    val statusMessage: String? = null,
    val error: ChatError? = null,
    /** The next send starts an agent run instead of a chat turn. Resets once a run starts. */
    val sendsAsAgentRun: Boolean = false,
    /** Answers given from this screen, by the action they answered. */
    val approvals: Map<PendingActionTarget, ApprovalCardState> = emptyMap(),
    /** Messages that never reached the server, oldest first, each kept for [ChatController.retry]. */
    val failedSends: List<FailedSend> = emptyList(),
) {
    fun approval(questId: String, action: PendingAction): ApprovalCardState =
        approvals[PendingActionTarget(questId, action.requestedAtMs)] ?: ApprovalCardState.Open
}

/**
 * A message the server never received: shown under the transcript with a retry. Twin of the iOS failed live turn.
 * [reason] is the server's answer when the send got one; null means the request never completed (offline).
 */
data class FailedSend(val id: String, val message: String, val fileIds: List<String>, val reason: String? = null)

sealed interface ChatError {
    data class Refused(val errorCode: String?, val message: String?) : ChatError
    data class Failed(val message: String) : ChatError
}

/** The seams [ChatController] depends on, so the suite drives it without a server. */
interface ChatBackend {
    suspend fun transcript(sessionId: String): List<Quest>
    suspend fun quest(id: String): Quest
    suspend fun send(message: String, sessionId: String?, fileIds: List<String>): ChatReceipt
    suspend fun respond(target: PendingActionTarget, decision: PendingActionDecision): PendingActionOutcome

    /** One socket's worth of frames; completes when the socket closes. */
    fun completions(): Flow<RealtimeFrames.StreamedCompletion>
}

class LiveChatBackend(
    private val sessions: SessionsRepository,
    private val wire: ChatSendWire,
    private val realtime: com.bike4mind.kit.realtime.RealtimeConnection,
    private val pendingActions: PendingActionApi,
) : ChatBackend {
    override suspend fun transcript(sessionId: String) = sessions.quests(sessionId)
    override suspend fun quest(id: String) = sessions.quest(id)
    override suspend fun send(message: String, sessionId: String?, fileIds: List<String>) =
        wire.send(message, sessionId, fileIds)
    override fun completions() = realtime.completions()
    override suspend fun respond(target: PendingActionTarget, decision: PendingActionDecision) =
        pendingActions.respond(target, decision)
}

/**
 * One chat session's transcript and the send -> stream -> complete round trip. Replies stream over the
 * realtime socket; a quest no frame has mentioned for [staleAfterMs] is polled over REST instead, which is
 * also what settles it across a dropped socket. Twin of apps/ios Chat/ChatViewModel.swift.
 */
class ChatController(
    sessionId: String?,
    private val backend: ChatBackend,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val pollIntervalMs: Long = 2_000,
    private val staleAfterMs: Long = 10_000,
    private val maxPolls: Int = 300,
    private val reconnectDelayMs: Long = 3_000,
    private val agentRuns: AgentRunStarter? = null,
) {
    private val mutableState = MutableStateFlow(ChatState(sessionId = sessionId))
    val state: StateFlow<ChatState> = mutableState.asStateFlow()

    private val lastHeard = mutableMapOf<String, Long>()
    private val onRetryAccepted = mutableMapOf<String, () -> Unit>()
    private var failedSendCount = 0
    private var socket: Job? = null

    fun start() {
        mutableState.value.sessionId?.let { scope.launch { loadTranscript(it) } }
        if (socket == null) socket = scope.launch { listen() }
    }

    fun stop() {
        socket?.cancel()
        socket = null
    }

    /** An agent run needs an existing session (`session_id` is required), as on iOS. */
    fun canStartAgentRun(state: ChatState): Boolean = agentRuns != null && state.sessionId != null

    fun setSendsAsAgentRun(on: Boolean) {
        mutableState.update { it.copy(sendsAsAgentRun = on && canStartAgentRun(it)) }
    }

    /** [onAccepted] runs once the server took the turn, e.g. to let go of the composer's attachments. */
    fun send(message: String, fileIds: List<String> = emptyList(), onAccepted: () -> Unit = {}) {
        val text = message.trim()
        if (text.isEmpty() || mutableState.value.sending) return
        val runSessionId = mutableState.value.takeIf { it.sendsAsAgentRun }?.sessionId
        if (agentRuns != null && runSessionId != null) {
            // The agent-executions route takes no files, so a run with attachments is refused rather than sent without them.
            if (fileIds.isNotEmpty()) return mutableState.update { it.copy(error = ChatError.Failed(AGENT_RUN_ATTACHMENTS_UNSUPPORTED)) }
            return startAgentRun(agentRuns, runSessionId, text)
        }
        mutableState.update { it.copy(sending = true, error = null) }
        submit(FailedSend("failed-${++failedSendCount}", text, fileIds), onAccepted)
    }

    /** Sends a failed message again; the same [onAccepted] the first send was given runs once the server takes it. */
    fun retry(failedSendId: String) {
        val state = mutableState.value
        val failed = state.failedSends.firstOrNull { it.id == failedSendId } ?: return
        if (state.sending) return
        mutableState.update { current -> current.copy(sending = true, error = null, failedSends = current.failedSends - failed) }
        submit(failed, onRetryAccepted.remove(failedSendId) ?: {})
    }

    private fun submit(attempt: FailedSend, onAccepted: () -> Unit) {
        scope.launch {
            try {
                when (val receipt = backend.send(attempt.message, mutableState.value.sessionId, attempt.fileIds)) {
                    is ChatReceipt.Refused -> mutableState.update {
                        it.copy(sending = false, error = ChatError.Refused(receipt.errorCode, receipt.message))
                    }
                    is ChatReceipt.Accepted -> {
                        onAccepted()
                        lastHeard[receipt.questId] = now()
                        mutableState.update { state ->
                            state.copy(
                                sessionId = state.sessionId ?: receipt.sessionId,
                                sending = false,
                                turns = state.turns + Quest(
                                    id = receipt.questId,
                                    sessionId = receipt.sessionId,
                                    prompt = attempt.message,
                                    reply = null,
                                    status = QuestStatus.PENDING,
                                    type = null,
                                    errorCode = null,
                                ),
                            )
                        }
                        pollWhileStale(receipt.questId)
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                // The composer has already let go of the text, so the message is kept here rather than dropped.
                onRetryAccepted[attempt.id] = onAccepted
                val kept = attempt.copy(reason = if (error is java.io.IOException) null else error.message)
                mutableState.update { it.copy(sending = false, failedSends = it.failedSends + kept) }
            }
        }
    }

    private fun startAgentRun(agentRuns: AgentRunStarter, sessionId: String, text: String) {
        mutableState.update { it.copy(sending = true, error = null) }
        scope.launch {
            try {
                val receipt = agentRuns.start(sessionId, AgentRunTitle.fromPrompt(text), text)
                // A run is a deliberate, costly choice: the next message is a plain chat turn again.
                mutableState.update { it.copy(sending = false, sendsAsAgentRun = false, turns = it.turns + runTurn(receipt, text)) }
                receipt.questId?.let {
                    lastHeard[it] = now()
                    // A run outlasts a chat turn: keep settling it for as long as its notification follows it.
                    pollWhileStale(it, polls = (AgentRunMonitor.FOLLOW_FOR_MS / pollIntervalMs).toInt())
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                // The toggle stays on, so sending again retries the run rather than a chat turn.
                mutableState.update { it.copy(sending = false, error = ChatError.Failed(error.message ?: "Could not start the agent")) }
            }
        }
    }

    /**
     * The quest gains the reply when the run completes. The server writes it best effort; without one nothing
     * would ever settle the turn, so it shows as started and the run's notification carries the progress.
     */
    private fun runTurn(receipt: AgentRunReceipt, prompt: String): Quest {
        val questId = receipt.questId
        return Quest(
            id = questId ?: "run-${receipt.executionId}",
            sessionId = receipt.sessionId,
            prompt = prompt,
            reply = if (questId == null) UNTRACKED_RUN_REPLY else null,
            status = if (questId == null) QuestStatus.DONE else QuestStatus.PENDING,
            type = null,
            errorCode = null,
        )
    }

    /**
     * Approves or denies the pending action a turn shows. The server decides whether it is still current: a lapsed,
     * replaced or already-answered action comes back as a settled failure, after which the transcript is reloaded so
     * the card shows what really happened. Twin of apps/ios ChatViewModel.respond.
     */
    fun respond(questId: String, action: PendingAction, decision: PendingActionDecision) {
        val target = PendingActionTarget(questId, action.requestedAtMs)
        if (!mutableState.value.approval(questId, action).offersDecision) return
        setApproval(target, ApprovalCardState.Submitting(decision))
        scope.launch {
            val outcome = try {
                backend.respond(target, decision)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                PendingActionOutcome.Failed(PendingActionFailure.ServerError)
            }
            when (outcome) {
                is PendingActionOutcome.Answered -> setApproval(target, ApprovalCardState.Answered(outcome.result))
                is PendingActionOutcome.Failed -> setApproval(target, ApprovalCardState.Failed(outcome.failure))
            }
            val settled = outcome !is PendingActionOutcome.Failed || !outcome.failure.isRetryable
            if (settled) mutableState.value.sessionId?.let { loadTranscript(it) }
        }
    }

    private fun setApproval(target: PendingActionTarget, card: ApprovalCardState) {
        mutableState.update { it.copy(approvals = it.approvals + (target to card)) }
    }

    private suspend fun loadTranscript(sessionId: String) {
        mutableState.update { it.copy(loading = true) }
        try {
            val loaded = backend.transcript(sessionId)
            mutableState.update { state ->
                val known = loaded.map { it.id }.toSet()
                state.copy(loading = false, turns = loaded + state.turns.filter { it.id !in known })
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            mutableState.update { it.copy(loading = false, error = ChatError.Failed(error.message ?: "Could not load")) }
        }
    }

    private suspend fun listen() {
        while (scope.isActive) {
            try {
                backend.completions().collect { frame -> apply(frame.quest, statusMessage = frame.statusMessage) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                // A failed handshake or a dropped socket: retry below; pollWhileStale covers in-flight quests meanwhile.
            }
            delay(reconnectDelayMs)
        }
    }

    private suspend fun pollWhileStale(questId: String, polls: Int = maxPolls) {
        repeat(polls) {
            delay(pollIntervalMs)
            val current = mutableState.value.turns.firstOrNull { it.id == questId } ?: return
            if (current.status.isTerminal) return
            if (now() - (lastHeard[questId] ?: 0) < staleAfterMs) return@repeat
            val polled = try {
                backend.quest(questId)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                return@repeat
            }
            apply(polled, heard = false, statusMessage = mutableState.value.statusMessage)
        }
    }

    /** Merges a snapshot into the transcript; returns false when it belongs to another session. */
    private fun apply(update: Quest, heard: Boolean = true, statusMessage: String? = null): Boolean {
        val state = mutableState.value
        val index = state.turns.indexOfFirst { it.id == update.id }
        val sameSession = update.sessionId != null && update.sessionId == state.sessionId
        if (index < 0 && !sameSession) return false
        if (heard) lastHeard[update.id] = now()
        mutableState.update { current ->
            val turns = current.turns.toMutableList()
            val existing = turns.getOrNull(turns.indexOfFirst { it.id == update.id })
            val merged = update.copy(
                prompt = update.prompt ?: existing?.prompt,
                // Replies are cumulative: replace, and keep the last text when a frame carries none.
                reply = update.reply ?: existing?.reply,
                // A frame carries the current action (or none); a REST poll carries none, so keep it. The server parks actions on done quests, so status does not clear it.
                pendingAction = when {
                    heard -> update.pendingAction
                    else -> update.pendingAction ?: existing?.pendingAction
                },
            )
            if (existing == null) turns += merged else turns[turns.indexOf(existing)] = merged
            current.copy(turns = turns, statusMessage = if (merged.status.isTerminal) null else statusMessage)
        }
        return true
    }

    companion object {
        const val UNTRACKED_RUN_REPLY = "The agent run started. Its progress shows in its notification rather than in this conversation."
        const val AGENT_RUN_ATTACHMENTS_UNSUPPORTED = "An agent run cannot take attachments. Remove them, or turn off Agent."
    }
}
