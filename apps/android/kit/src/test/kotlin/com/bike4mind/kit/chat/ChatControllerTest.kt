package com.bike4mind.kit.chat

import com.bike4mind.kit.realtime.RealtimeFrames.StreamedCompletion
import com.bike4mind.kit.sessions.Quest
import com.bike4mind.kit.sessions.QuestStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class ChatControllerTest {
    private class FakeBackend : ChatBackend {
        val frames = Channel<StreamedCompletion>(Channel.UNLIMITED)
        var receipt: ChatReceipt = ChatReceipt.Accepted("q1", "s-new")
        var polled: Quest? = null
        var polls = 0
        val sent = mutableListOf<Pair<String, String?>>()

        override suspend fun transcript(sessionId: String) = emptyList<Quest>()
        override suspend fun quest(id: String): Quest {
            polls++
            return polled ?: error("not polled in this test")
        }
        override suspend fun send(message: String, sessionId: String?): ChatReceipt {
            sent += message to sessionId
            return receipt
        }
        override fun completions(): Flow<StreamedCompletion> = frames.receiveAsFlow()
    }

    private fun quest(status: QuestStatus, reply: String?, session: String = "s-new") =
        Quest("q1", session, null, reply, status, "message", null)

    private fun TestScope.controller(backend: FakeBackend, sessionId: String? = null) =
        ChatController(sessionId, backend, backgroundScope, now = { testScheduler.currentTime }).also { it.start() }

    @Test
    fun aNewChatStreamsTheReplyToCompletion() = runTest {
        val backend = FakeBackend()
        val chat = controller(backend)

        chat.send("  Hi there ")
        runCurrent()
        assertEquals(listOf<Pair<String, String?>>("Hi there" to null), backend.sent.toList())
        assertEquals("s-new", chat.state.value.sessionId)

        backend.frames.send(StreamedCompletion(quest(QuestStatus.RUNNING, "Hel"), "Thinking"))
        runCurrent()
        assertEquals("Hel", chat.state.value.turns.single().reply)
        assertEquals("Thinking", chat.state.value.statusMessage)

        backend.frames.send(StreamedCompletion(quest(QuestStatus.RUNNING, null), null))
        backend.frames.send(StreamedCompletion(quest(QuestStatus.DONE, "Hello"), null))
        runCurrent()
        val turn = chat.state.value.turns.single()
        assertEquals("Hi there", turn.prompt)
        assertEquals("Hello", turn.reply)
        assertEquals(QuestStatus.DONE, turn.status)
        assertNull(chat.state.value.statusMessage)
    }

    @Test
    fun framesForOtherSessionsAreIgnored() = runTest {
        val backend = FakeBackend()
        val chat = controller(backend, sessionId = "s1")

        backend.frames.send(StreamedCompletion(Quest("other", "s2", "x", "y", QuestStatus.DONE, null, null), null))
        runCurrent()

        assertEquals(emptyList<Quest>(), chat.state.value.turns)
    }

    @Test
    fun aSilentQuestIsSettledByPolling() = runTest {
        val backend = FakeBackend()
        backend.polled = quest(QuestStatus.DONE, "Polled reply")
        val chat = controller(backend)

        chat.send("Hi")
        runCurrent()
        advanceTimeBy(9_000)
        assertEquals(0, backend.polls)

        advanceTimeBy(3_000)
        runCurrent()
        assertEquals(1, backend.polls)
        assertEquals("Polled reply", chat.state.value.turns.single().reply)
        assertEquals(QuestStatus.DONE, chat.state.value.turns.single().status)
    }

    @Test
    fun aRefusedSendSurfacesTheReason() = runTest {
        val backend = FakeBackend()
        backend.receipt = ChatReceipt.Refused("insufficient_credits", "Out of credits")
        val chat = controller(backend)

        chat.send("Hi")
        runCurrent()

        assertEquals(ChatError.Refused("insufficient_credits", "Out of credits"), chat.state.value.error)
        assertEquals(emptyList<Quest>(), chat.state.value.turns)
    }
}
