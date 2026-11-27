package com.bike4mind.kit.chat

import com.bike4mind.kit.agents.AgentRunReceipt
import com.bike4mind.kit.agents.AgentRunStarter
import com.bike4mind.kit.approvals.ApprovalCardState
import com.bike4mind.kit.approvals.PendingActionDecision
import com.bike4mind.kit.approvals.PendingActionFailure
import com.bike4mind.kit.approvals.PendingActionOutcome
import com.bike4mind.kit.approvals.PendingActionResult
import com.bike4mind.kit.approvals.PendingActionTarget
import com.bike4mind.kit.networking.ApiException
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
        var sendFailure: Exception? = null
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
        override suspend fun send(message: String, sessionId: String?, fileIds: List<String>): ChatReceipt {
            sent += message to sessionId
            sendFailure?.let { throw it }
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

    @Test
    fun aFailedSendIsKeptAndRetriesWithTheSameText() = runTest {
        val backend = FakeBackend().apply { sendFailure = java.io.IOException("offline") }
        val chat = controller(backend, sessionId = "s1")
        var accepted = 0

        chat.send("Hi", listOf("f1")) { accepted++ }
        runCurrent()
        val failed = chat.state.value.failedSends.single()
        assertEquals(FailedSend(failed.id, "Hi", listOf("f1")), failed)
        assertFalse(chat.state.value.sending)
        assertTrue(chat.state.value.turns.isEmpty())
        assertEquals(0, accepted)

        backend.sendFailure = null
        chat.retry(failed.id)
        runCurrent()
        assertEquals(listOf<Pair<String, String?>>("Hi" to "s1", "Hi" to "s1"), backend.sent.toList())
        assertTrue(chat.state.value.failedSends.isEmpty())
        assertEquals("Hi", chat.state.value.turns.single().prompt)
        assertEquals(1, accepted)
    }

    @Test
    fun aRetryThatFailsAgainKeepsTheMessageForAnotherTry() = runTest {
        val backend = FakeBackend().apply { sendFailure = java.io.IOException("offline") }
        val chat = controller(backend, sessionId = "s1")

        chat.send("Hi")
        runCurrent()
        val failed = chat.state.value.failedSends.single()
        chat.retry(failed.id)
        runCurrent()

        assertEquals(listOf(failed), chat.state.value.failedSends)
        assertEquals(2, backend.sent.size)
        assertFalse(chat.state.value.sending)
    }

    @Test
    fun aRetryWhileSendingIsIgnored() = runTest {
        val backend = FakeBackend().apply { sendFailure = java.io.IOException("offline") }
        val chat = controller(backend, sessionId = "s1")
        chat.send("First")
        runCurrent()
        val failed = chat.state.value.failedSends.single()

        backend.sendFailure = null
        chat.send("Second")
        chat.retry(failed.id)
        runCurrent()

        assertEquals(listOf("First", "Second"), backend.sent.map { it.first })
        assertEquals(listOf(failed), chat.state.value.failedSends)
    }

    @Test
    fun aRetryOfAnUnknownIdDoesNothing() = runTest {
        val backend = FakeBackend()
        val chat = controller(backend, sessionId = "s1")

        chat.retry("failed-99")
        runCurrent()

        assertTrue(backend.sent.isEmpty())
        assertFalse(chat.state.value.sending)
    }

    @Test
    fun onAcceptedRunsOnceAfterRepeatedFailures() = runTest {
        val backend = FakeBackend().apply { sendFailure = java.io.IOException("offline") }
        val chat = controller(backend, sessionId = "s1")
        var accepted = 0

        chat.send("Hi") { accepted++ }
        runCurrent()
        chat.retry(chat.state.value.failedSends.single().id)
        runCurrent()
        backend.sendFailure = null
        chat.retry(chat.state.value.failedSends.single().id)
        runCurrent()

        assertEquals(1, accepted)
        assertTrue(chat.state.value.failedSends.isEmpty())
    }

    @Test
    fun aServerErrorKeepsItsReasonAndAnOfflineSendHasNone() = runTest {
        val backend = FakeBackend().apply { sendFailure = ApiException(403) }
        val chat = controller(backend, sessionId = "s1")

        chat.send("Hi")
        runCurrent()
        assertEquals("The server answered HTTP 403", chat.state.value.failedSends.single().reason)

        backend.sendFailure = java.io.IOException("offline")
        chat.send("Again")
        runCurrent()
        assertNull(chat.state.value.failedSends.last().reason)
    }

    private class FakeRuns(var receipt: AgentRunReceipt = AgentRunReceipt("e1", "q-run", "s1")) : AgentRunStarter {
        val started = mutableListOf<Triple<String, String, String>>()
        var failure: Exception? = null

        override suspend fun start(sessionId: String, title: String, message: String): AgentRunReceipt {
            started += Triple(sessionId, title, message)
            failure?.let { throw it }
            return receipt
        }
    }

    private fun TestScope.agentController(backend: FakeBackend, runs: FakeRuns, sessionId: String?) =
        ChatController(sessionId, backend, backgroundScope, now = { testScheduler.currentTime }, agentRuns = runs).also { it.start() }

    @Test
    fun anAgentRunSendsThroughTheRunRouteOnceThenFallsBackToChat() = runTest {
        val backend = FakeBackend().apply { receipt = ChatReceipt.Accepted("q2", "s1") }
        val runs = FakeRuns()
        val chat = agentController(backend, runs, "s1")

        chat.setSendsAsAgentRun(true)
        chat.send(" Audit this ")
        runCurrent()

        assertEquals(listOf(Triple("s1", "Audit this", "Audit this")), runs.started.toList())
        assertTrue(backend.sent.isEmpty())
        val turn = chat.state.value.turns.single()
        assertEquals("q-run", turn.id)
        assertEquals(QuestStatus.PENDING, turn.status)
        assertFalse(chat.state.value.sendsAsAgentRun)

        chat.send("Thanks")
        runCurrent()
        assertEquals(listOf<Pair<String, String?>>("Thanks" to "s1"), backend.sent.toList())
        assertEquals(1, runs.started.size)
    }

    @Test
    fun aLongRunKeepsSettlingPastAChatTurnsPollBudget() = runTest {
        fun run(status: QuestStatus, reply: String?) = Quest("q-run", "s1", null, reply, status, "message", null)
        val backend = FakeBackend().apply { polled = run(QuestStatus.PENDING, null) }
        val chat = agentController(backend, FakeRuns(), "s1")

        chat.setSendsAsAgentRun(true)
        chat.send("Audit this")
        runCurrent()
        advanceTimeBy(20 * 60 * 1_000L)
        runCurrent()
        assertEquals(QuestStatus.PENDING, chat.state.value.turns.single().status)

        backend.polled = run(QuestStatus.DONE, "Audited")
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals("Audited", chat.state.value.turns.single().reply)
        assertEquals(QuestStatus.DONE, chat.state.value.turns.single().status)
    }

    @Test
    fun anAgentRunWithAttachmentsIsRefusedNotSentWithoutThem() = runTest {
        val backend = FakeBackend()
        val runs = FakeRuns()
        val chat = agentController(backend, runs, "s1")
        var accepted = false

        chat.setSendsAsAgentRun(true)
        chat.send("Read this", listOf("f1")) { accepted = true }
        runCurrent()

        assertTrue(runs.started.isEmpty())
        assertTrue(backend.sent.isEmpty())
        assertFalse(accepted, "the composer keeps its attachments")
        assertEquals(ChatError.Failed(ChatController.AGENT_RUN_ATTACHMENTS_UNSUPPORTED), chat.state.value.error)
        assertTrue(chat.state.value.sendsAsAgentRun)
    }

    @Test
    fun aRunWithoutAQuestSettlesAsStarted() = runTest {
        val runs = FakeRuns(AgentRunReceipt("e1", null, "s1"))
        val chat = agentController(FakeBackend(), runs, "s1")
        chat.setSendsAsAgentRun(true)
        chat.send("go")
        runCurrent()
        val turn = chat.state.value.turns.single()
        assertEquals(QuestStatus.DONE, turn.status)
        assertEquals(ChatController.UNTRACKED_RUN_REPLY, turn.reply)
    }

    @Test
    fun aFailedStartKeepsTheToggleOnForARetry() = runTest {
        val runs = FakeRuns().apply { failure = IllegalStateException("409") }
        val chat = agentController(FakeBackend(), runs, "s1")
        chat.setSendsAsAgentRun(true)
        chat.send("go")
        runCurrent()
        assertTrue(chat.state.value.sendsAsAgentRun)
        assertTrue(chat.state.value.error is ChatError.Failed)
        assertTrue(chat.state.value.turns.isEmpty())
    }

    @Test
    fun aNewChatCannotStartAnAgentRun() = runTest {
        val chat = agentController(FakeBackend(), FakeRuns(), sessionId = null)
        assertFalse(chat.canStartAgentRun(chat.state.value))
        chat.setSendsAsAgentRun(true)
        assertFalse(chat.state.value.sendsAsAgentRun)
        val plain = controller(FakeBackend(), sessionId = "s1")
        assertFalse(plain.canStartAgentRun(plain.state.value))
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
