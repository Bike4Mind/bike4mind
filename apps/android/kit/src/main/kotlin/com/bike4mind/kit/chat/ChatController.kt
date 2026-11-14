package com.bike4mind.kit.chat

import com.bike4mind.kit.realtime.RealtimeFrames
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
)

sealed interface ChatError {
    data class Refused(val errorCode: String?, val message: String?) : ChatError
    data class Failed(val message: String) : ChatError
}

/** The seams [ChatController] depends on, so the suite drives it without a server. */
interface ChatBackend {
    suspend fun transcript(sessionId: String): List<Quest>
    suspend fun quest(id: String): Quest
    suspend fun send(message: String, sessionId: String?): ChatReceipt

    /** One socket's worth of frames; completes when the socket closes. */
    fun completions(): Flow<RealtimeFrames.StreamedCompletion>
}

class LiveChatBackend(
    private val sessions: SessionsRepository,
    private val wire: ChatSendWire,
    private val realtime: com.bike4mind.kit.realtime.RealtimeConnection,
) : ChatBackend {
    override suspend fun transcript(sessionId: String) = sessions.quests(sessionId)
    override suspend fun quest(id: String) = sessions.quest(id)
    override suspend fun send(message: String, sessionId: String?) = wire.send(message, sessionId)
    override fun completions() = realtime.completions()
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
) {
    private val mutableState = MutableStateFlow(ChatState(sessionId = sessionId))
    val state: StateFlow<ChatState> = mutableState.asStateFlow()

    private val lastHeard = mutableMapOf<String, Long>()
    private var socket: Job? = null

    fun start() {
        mutableState.value.sessionId?.let { scope.launch { loadTranscript(it) } }
        if (socket == null) socket = scope.launch { listen() }
    }

    fun stop() {
        socket?.cancel()
        socket = null
    }

    fun send(message: String) {
        val text = message.trim()
        if (text.isEmpty() || mutableState.value.sending) return
        mutableState.update { it.copy(sending = true, error = null) }
        scope.launch {
            try {
                when (val receipt = backend.send(text, mutableState.value.sessionId)) {
                    is ChatReceipt.Refused -> mutableState.update {
                        it.copy(sending = false, error = ChatError.Refused(receipt.errorCode, receipt.message))
                    }
                    is ChatReceipt.Accepted -> {
                        lastHeard[receipt.questId] = now()
                        mutableState.update { state ->
                            state.copy(
                                sessionId = state.sessionId ?: receipt.sessionId,
                                sending = false,
                                turns = state.turns + Quest(
                                    id = receipt.questId,
                                    sessionId = receipt.sessionId,
                                    prompt = text,
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
                mutableState.update { it.copy(sending = false, error = ChatError.Failed(error.message ?: "Send failed")) }
            }
        }
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

    private suspend fun pollWhileStale(questId: String) {
        repeat(maxPolls) {
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
            )
            if (existing == null) turns += merged else turns[turns.indexOf(existing)] = merged
            current.copy(turns = turns, statusMessage = if (merged.status.isTerminal) null else statusMessage)
        }
        return true
    }
}
