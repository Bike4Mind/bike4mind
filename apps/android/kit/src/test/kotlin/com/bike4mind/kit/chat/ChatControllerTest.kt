package com.bike4mind.kit.chat

import com.bike4mind.kit.approvals.ApprovalCardState
import com.bike4mind.kit.approvals.PendingActionDecision
import com.bike4mind.kit.approvals.PendingActionFailure
import com.bike4mind.kit.approvals.PendingActionOutcome
import com.bike4mind.kit.approvals.PendingActionResult
import com.bike4mind.kit.approvals.PendingActionTarget
import com.bike4mind.kit.realtime.RealtimeFrames.StreamedCompletion
import com.bike4mind.kit.sessions.PendingAction
import com.bike4mind.kit.sessions.Quest
import com.bike4mind.kit.sessions.QuestStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
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

        var transcript = emptyList<Quest>()
        var transcriptLoads = 0
        var outcome: PendingActionOutcome = PendingActionOutcome.Answered(PendingActionResult(PendingActionDecision.APPROVE))
        val answers = mutableListOf<Pair<PendingActionTarget, PendingActionDecision>>()

        override suspend fun transcript(sessionId: String): List<Quest> {
            transcriptLoads++
            return transcript
        }
        override suspend fun respond(target: PendingActionTarget, decision: PendingActionDecision): PendingActionOutcome {
            answers += target to decision
            return outcome
        }
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

    private val action = PendingAction("web_search", mapOf("query" to "weather"), requestedAtMs = 1_000)
    private val parked = Quest("q1", "s1", "Search", null, QuestStatus.DONE, "message", null, action)

    @Test
    fun approvingAnswersThatActionAndReloadsTheTranscript() = runTest {
        val backend = FakeBackend()
        backend.transcript = listOf(parked)
        val chat = controller(backend, sessionId = "s1")
        runCurrent()
        assertEquals(action, chat.state.value.turns.single().pendingAction)
        assertEquals(1, backend.transcriptLoads)

        chat.respond("q1", action, PendingActionDecision.APPROVE)
        assertEquals(ApprovalCardState.Submitting(PendingActionDecision.APPROVE), chat.state.value.approval("q1", action))
        runCurrent()

        assertEquals(listOf(PendingActionTarget("q1", 1_000) to PendingActionDecision.APPROVE), backend.answers.toList())
        assertEquals(
            ApprovalCardState.Answered(PendingActionResult(PendingActionDecision.APPROVE)),
            chat.state.value.approval("q1", action),
        )
        assertEquals(2, backend.transcriptLoads)
    }

    @Test
    fun anAnsweredCardIgnoresASecondTap() = runTest {
        val backend = FakeBackend()
        backend.transcript = listOf(parked)
        val chat = controller(backend, sessionId = "s1")
        runCurrent()

        chat.respond("q1", action, PendingActionDecision.APPROVE)
        chat.respond("q1", action, PendingActionDecision.DENY)
        runCurrent()
        chat.respond("q1", action, PendingActionDecision.DENY)
        runCurrent()

        assertEquals(1, backend.answers.size)
    }

    @Test
    fun aRetryableFailureKeepsTheButtonsWithoutReloading() = runTest {
        val backend = FakeBackend()
        backend.transcript = listOf(parked)
        backend.outcome = PendingActionOutcome.Failed(PendingActionFailure.Offline)
        val chat = controller(backend, sessionId = "s1")
        runCurrent()

        chat.respond("q1", action, PendingActionDecision.DENY)
        runCurrent()

        val card = chat.state.value.approval("q1", action)
        assertEquals(ApprovalCardState.Failed(PendingActionFailure.Offline), card)
        assertTrue(card.offersDecision)
        assertEquals(1, backend.transcriptLoads)
    }

    @Test
    fun aSettledFailureHidesTheButtonsAndReloads() = runTest {
        val backend = FakeBackend()
        backend.transcript = listOf(parked)
        backend.outcome = PendingActionOutcome.Failed(PendingActionFailure.Expired)
        val chat = controller(backend, sessionId = "s1")
        runCurrent()

        chat.respond("q1", action, PendingActionDecision.APPROVE)
        runCurrent()

        assertFalse(chat.state.value.approval("q1", action).offersDecision)
        assertEquals(2, backend.transcriptLoads)
    }

    @Test
    fun framesSetAndClearThePendingAction() = runTest {
        val backend = FakeBackend()
        val chat = controller(backend, sessionId = "s1")
        runCurrent()

        backend.frames.send(StreamedCompletion(parked, null))
        runCurrent()
        assertEquals(action, chat.state.value.turns.single().pendingAction)

        backend.frames.send(StreamedCompletion(parked.copy(pendingAction = null), null))
        runCurrent()
        assertNull(chat.state.value.turns.single().pendingAction)
    }

    @Test
    fun aPolledDoneTurnKeepsItsAction() = runTest {
        val backend = FakeBackend()
        backend.polled = quest(QuestStatus.DONE, "Polled reply")
        val chat = controller(backend)
        chat.send("Hi")
        runCurrent()

        backend.frames.send(StreamedCompletion(parked.copy(sessionId = "s-new", status = QuestStatus.RUNNING), null))
        runCurrent()
        advanceTimeBy(12_000)
        runCurrent()
        assertEquals(QuestStatus.DONE, chat.state.value.turns.single().status)
        assertEquals(action, chat.state.value.turns.single().pendingAction)
    }
}
