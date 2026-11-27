package com.bike4mind.kit.capture

import com.bike4mind.kit.chat.ChatReceipt
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class CaptureEngineTest {
    private val root: File = createTempDirectory("capture-engine").toFile()
    private val store = CaptureJobStore(root)
    private val api = FakeApi()
    private val sender = FakeSender()
    private var clock = 1_000L

    @AfterTest
    fun cleanUp() {
        root.deleteRecursively()
    }

    private class FakeApi : CaptureApi {
        val calls = mutableListOf<String>()
        val uploadedBytes = mutableMapOf<String, ByteArray>()
        var createFailure: Exception? = null
        var status: RemoteFileStatus = RemoteFileStatus.CLEAN
        var lookup: SentTurnLookup = SentTurnLookup.NotFound

        /** When set, a scan poll waits on it, which holds a run in the middle of its network work. */
        var scanGate: CompletableDeferred<Unit>? = null
        private var counter = 0

        override suspend fun createUpload(fileName: String, mimeType: String, byteCount: Long): UploadTicket {
            calls += "create:$fileName"
            createFailure?.let { throw it }
            counter++
            return UploadTicket("file-$counter", "https://s3.example.test/$counter", null)
        }

        override suspend fun upload(ticket: UploadTicket, file: File, mimeType: String) {
            calls += "put:${ticket.fileId}"
            uploadedBytes[ticket.fileId] = file.readBytes()
        }

        override suspend fun fileStatus(fileId: String): RemoteFileStatus {
            calls += "status:$fileId"
            scanGate?.await()
            return status
        }

        override suspend fun findSentTurn(sessionId: String, message: String): SentTurnLookup {
            calls += "find:$sessionId"
            return lookup
        }
    }

    private class FakeSender : TurnSender {
        data class Sent(val message: String, val sessionId: String?, val fileIds: List<String>)

        val sent = mutableListOf<Sent>()
        val outcomes = ArrayDeque<() -> ChatReceipt>()

        override suspend fun send(message: String, sessionId: String?, fileIds: List<String>): ChatReceipt {
            sent += Sent(message, sessionId, fileIds)
            val outcome = outcomes.removeFirstOrNull() ?: return ChatReceipt.Accepted("q1", sessionId ?: "new-session")
            return outcome()
        }
    }

    private fun TestScope.engine(maxFailures: Int = 10, maxPolls: Int = 2, dir: CaptureJobStore = store) = CaptureEngine(
        dir,
        api,
        sender,
        now = { clock++ },
        pollIntervalMs = 0,
        maxPollsPerPass = maxPolls,
        maxFailures = maxFailures,
        io = UnconfinedTestDispatcher(testScheduler),
    )

    private fun incoming(name: String, bytes: ByteArray, mime: String = "image/png") =
        IncomingFile(name, mime) { ByteArrayInputStream(bytes) }

    private val session = CaptureDestination.Session("s1", "Notes")

    private suspend fun CaptureEngine.enqueueOne(destination: CaptureDestination = session) =
        enqueue(destination, "  look at this  ", listOf(incoming("a.png", byteArrayOf(1, 2, 3))))

    private fun CaptureEngine.onlyJob() = jobs.value.single()

    @Test
    fun aSessionShareUploadsEveryFileAndSendsOneTurn() = runTest {
        val engine = engine()
        val job = engine.enqueue(
            session,
            " see these ",
            listOf(incoming("a.png", byteArrayOf(1, 2, 3)), incoming("b.pdf", ByteArray(10) { it.toByte() }, "application/pdf")),
        )

        assertEquals(listOf(3L, 10L), job.files.map { it.byteCount })
        assertEquals("see these", job.message)
        assertContentEquals(byteArrayOf(1, 2, 3), store.payloadFile(job.id, "a.png").readBytes())
        assertTrue(api.calls.isEmpty())

        assertEquals(CaptureEngine.RunResult.SETTLED, engine.runPending())

        assertEquals(listOf(FakeSender.Sent("see these", "s1", listOf("file-1", "file-2"))), sender.sent)
        val done = engine.onlyJob()
        assertEquals(CaptureStage.DONE, done.stage)
        assertEquals("s1", done.sessionId)
        assertNull(done.lastFailure)
        assertEquals(setOf("file-1", "file-2"), api.uploadedBytes.keys)
        assertContentEquals(byteArrayOf(1, 2, 3), api.uploadedBytes.getValue("file-1"))
        assertFalse(File(File(root, "payloads"), job.id).exists())
    }

    @Test
    fun duplicateAndUnsafeNamesAreMadeUnique() = runTest {
        val job = engine().enqueue(
            session,
            "m",
            listOf(incoming("../x/a.png", byteArrayOf(1)), incoming("a.png", byteArrayOf(2)), incoming("c:d?.png", byteArrayOf(3))),
        )

        assertEquals(listOf("a.png", "a (2).png", "c_d_.png"), job.files.map { it.name })
    }

    @Test
    fun aNewChatShareSendsWithoutASessionAndRecordsTheReceiptsSession() = runTest {
        val engine = engine()
        engine.enqueueOne(CaptureDestination.NewChat)

        engine.runPending()

        assertNull(sender.sent.single().sessionId)
        val job = engine.onlyJob()
        assertEquals(CaptureStage.DONE, job.stage)
        assertEquals("new-session", job.sessionId)
    }

    @Test
    fun aLostAnswerKeepsTheJobPendingWithTheSendRecorded() = runTest {
        sender.outcomes += { throw IOException("dropped") }
        val engine = engine()
        engine.enqueueOne()

        assertEquals(CaptureEngine.RunResult.RETRY_LATER, engine.runPending())

        val saved = store.loadAll().single()
        assertEquals(CaptureStage.PENDING, saved.stage)
        assertNotNull(saved.sendAttemptedAtMs)
        assertEquals(CaptureFailure.Offline, saved.lastFailure)
    }

    @Test
    fun aRecordedSendIsReconciledAndAFoundTurnIsNotSentAgain() = runTest {
        sender.outcomes += { throw IOException("dropped") }
        val engine = engine()
        engine.enqueueOne()
        engine.runPending()
        api.calls.clear()
        api.lookup = SentTurnLookup.Found("q5")

        assertEquals(CaptureEngine.RunResult.SETTLED, engine.runPending())

        assertEquals(1, sender.sent.size)
        assertEquals("find:s1", api.calls.first())
        val job = engine.onlyJob()
        assertEquals(CaptureStage.DONE, job.stage)
        assertEquals("s1", job.sessionId)
    }

    @Test
    fun aRecordedSendThatIsNotFoundIsSentAgain() = runTest {
        sender.outcomes += { throw IOException("dropped") }
        val engine = engine()
        engine.enqueueOne()
        engine.runPending()
        api.lookup = SentTurnLookup.NotFound

        engine.runPending()

        assertEquals(2, sender.sent.size)
        assertEquals(CaptureStage.DONE, engine.onlyJob().stage)
    }

    @Test
    fun anInconclusiveLookupFailsAsDeliveryUnknown() = runTest {
        sender.outcomes += { throw IOException("dropped") }
        val engine = engine()
        engine.enqueueOne()
        engine.runPending()
        api.lookup = SentTurnLookup.Inconclusive

        engine.runPending()

        assertEquals(1, sender.sent.size)
        val job = engine.onlyJob()
        assertEquals(CaptureStage.FAILED, job.stage)
        assertEquals(CaptureFailure.DeliveryUnknown, job.lastFailure)
    }

    @Test
    fun aNewChatWithARecordedSendFailsAsDeliveryUnknownUntilTheUserRetries() = runTest {
        sender.outcomes += { throw IOException("dropped") }
        val engine = engine()
        val job = engine.enqueueOne(CaptureDestination.NewChat)
        engine.runPending()

        assertEquals(CaptureEngine.RunResult.SETTLED, engine.runPending())

        assertEquals(1, sender.sent.size)
        assertFalse(api.calls.any { it.startsWith("find") })
        val failed = engine.onlyJob()
        assertEquals(CaptureStage.FAILED, failed.stage)
        assertEquals(CaptureFailure.DeliveryUnknown, failed.lastFailure)
        assertNotNull(failed.sendAttemptedAtMs)

        engine.retry(job.id)
        val retried = engine.onlyJob()
        assertEquals(CaptureStage.PENDING, retried.stage)
        assertNull(retried.sendAttemptedAtMs)
        assertEquals(0, retried.failures)

        engine.runPending()

        assertEquals(2, sender.sent.size)
        assertEquals(CaptureStage.DONE, engine.onlyJob().stage)
    }

    @Test
    fun retryLeavesAJobThatIsNotFailedAlone() = runTest {
        val engine = engine()
        val job = engine.enqueueOne()

        engine.retry(job.id)

        assertEquals(job, engine.onlyJob())
    }

    @Test
    fun aRefusedReceiptFailsWithTheServersMessageAndClearsTheSend() = runTest {
        sender.outcomes += { ChatReceipt.Refused("insufficient_credits", "Out of credits") }
        val engine = engine()
        engine.enqueueOne()

        assertEquals(CaptureEngine.RunResult.SETTLED, engine.runPending())

        val job = engine.onlyJob()
        assertEquals(CaptureStage.FAILED, job.stage)
        assertEquals(CaptureFailure.Rejected("Out of credits"), job.lastFailure)
        assertNull(job.sendAttemptedAtMs)
    }

    @Test
    fun aBlockedScanFailsWithoutSending() = runTest {
        api.status = RemoteFileStatus.BLOCKED
        val engine = engine()
        engine.enqueueOne()

        engine.runPending()

        assertTrue(sender.sent.isEmpty())
        val job = engine.onlyJob()
        assertEquals(CaptureStage.FAILED, job.stage)
        assertEquals(CaptureFailure.Blocked, job.lastFailure)
    }

    @Test
    fun aScanThatOutlastsThePassWaitsForTheNext() = runTest {
        api.status = RemoteFileStatus.SCANNING
        val engine = engine(maxPolls = 2)
        engine.enqueueOne()

        assertEquals(CaptureEngine.RunResult.RETRY_LATER, engine.runPending())

        assertEquals(2, api.calls.count { it.startsWith("status") })
        val waiting = engine.onlyJob()
        assertEquals(CaptureStage.PENDING, waiting.stage)
        assertEquals(CaptureFailure.StillScanning, waiting.lastFailure)
        assertTrue(sender.sent.isEmpty())

        api.status = RemoteFileStatus.CLEAN
        api.calls.clear()
        assertEquals(CaptureEngine.RunResult.SETTLED, engine.runPending())

        assertFalse(api.calls.any { it.startsWith("create") })
        assertEquals(CaptureStage.DONE, engine.onlyJob().stage)
    }

    @Test
    fun transientFailuresStayPendingUntilTheLimit() = runTest {
        api.createFailure = IOException("offline")
        val engine = engine(maxFailures = 3)
        engine.enqueueOne()

        assertEquals(CaptureEngine.RunResult.RETRY_LATER, engine.runPending())
        assertEquals(CaptureStage.PENDING, engine.onlyJob().stage)
        assertEquals(CaptureEngine.RunResult.RETRY_LATER, engine.runPending())
        assertEquals(2, engine.onlyJob().failures)

        assertEquals(CaptureEngine.RunResult.SETTLED, engine.runPending())

        val job = engine.onlyJob()
        assertEquals(CaptureStage.FAILED, job.stage)
        assertEquals(CaptureFailure.Offline, job.lastFailure)
        assertTrue(sender.sent.isEmpty())
    }

    @Test
    fun aRemovedPayloadFailsPermanently() = runTest {
        val engine = engine()
        val job = engine.enqueueOne()
        store.discardPayload(job.id)

        engine.runPending()

        assertEquals(CaptureFailure.PayloadMissing, engine.onlyJob().lastFailure)
        assertEquals(CaptureStage.FAILED, engine.onlyJob().stage)
    }

    @Test
    fun enqueueAndDiscardDoNotWaitForARunThatIsMidScan() = runTest {
        val engine = engine()
        val first = engine.enqueueOne()
        val gate = CompletableDeferred<Unit>()
        api.scanGate = gate
        val run = async { engine.runPending() }
        runCurrent()
        assertEquals("status:file-1", api.calls.last())

        // Both return while the run is still waiting on the scan.
        val second = engine.enqueue(session, "second", listOf(incoming("b.png", byteArrayOf(4))))
        engine.discard(first.id)
        assertEquals(listOf(second.id), engine.jobs.value.map { it.id })

        api.scanGate = null
        gate.complete(Unit)
        assertEquals(CaptureEngine.RunResult.SETTLED, run.await())

        // The discarded job is not written back, and the one queued mid-run went out in the same run.
        assertEquals(listOf("second"), sender.sent.map { it.message })
        assertEquals(listOf(second.id), engine.jobs.value.map { it.id })
        assertEquals(CaptureStage.DONE, engine.onlyJob().stage)
        assertNull(store.load(first.id))
    }

    @Test
    fun aFreshEngineSeesTheSavedJobs() = runTest {
        val first = engine()
        val job = first.enqueueOne()

        val second = engine()
        assertTrue(second.jobs.value.isEmpty())
        second.load()

        assertEquals(listOf(job), second.jobs.value)
        assertEquals(CaptureEngine.RunResult.SETTLED, second.runPending())
        assertEquals(CaptureStage.DONE, second.onlyJob().stage)
    }

    @Test
    fun anOldDoneJobIsPruned() = runTest {
        val engine = CaptureEngine(store, api, sender, now = { clock }, pollIntervalMs = 0, doneRetentionMs = 100)
        engine.enqueueOne()
        engine.runPending()
        assertEquals(1, engine.jobs.value.size)

        clock += 1_000
        engine.runPending()

        assertTrue(engine.jobs.value.isEmpty())
    }

    @Test
    fun discardRemovesOneJobAndItsPayload() = runTest {
        val engine = engine()
        val job = engine.enqueueOne()

        engine.discard(job.id)

        assertTrue(engine.jobs.value.isEmpty())
        assertFalse(store.payloadFile(job.id, "a.png").exists())
    }

    @Test
    fun discardAllEmptiesJobsAndTheDirectory() = runTest {
        val engine = engine()
        engine.enqueueOne()
        engine.enqueueOne(CaptureDestination.NewChat)

        engine.discardAll()

        assertTrue(engine.jobs.value.isEmpty())
        assertTrue(root.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun anUnreadableSourceLeavesNoPayloadBehind() = runTest {
        val engine = engine()

        val result = runCatching {
            engine.enqueue(session, "m", listOf(IncomingFile("a.png", "image/png") { throw IOException("grant revoked") }))
        }

        assertTrue(result.exceptionOrNull() is IOException)
        assertTrue(engine.jobs.value.isEmpty())
        assertTrue(File(root, "payloads").listFiles().orEmpty().isEmpty())
    }

    @Test
    fun isTransientClassifiesErrors() {
        assertTrue(CaptureEngine.isTransient(IOException()))
        assertTrue(CaptureEngine.isTransient(UploadPutException(403)))
        assertTrue(CaptureEngine.isTransient(UploadPutException(503)))
        assertFalse(CaptureEngine.isTransient(UploadPutException(400)))
        assertTrue(CaptureEngine.isTransient(com.bike4mind.kit.networking.ApiException(429)))
        assertFalse(CaptureEngine.isTransient(com.bike4mind.kit.networking.ApiException(404)))
        assertFalse(CaptureEngine.isTransient(CaptureRejectedException("no")))
    }
}
