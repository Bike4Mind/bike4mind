package com.bike4mind.kit.capture

import com.bike4mind.kit.chat.ChatReceipt
import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.UpgradeRequiredException
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** A file handed over by another app, read once while this process still holds the grant to it. */
class IncomingFile(val name: String, val mimeType: String, val open: () -> InputStream)

/** Sends a chat turn; `ChatSendWire.send` in the app. */
fun interface TurnSender {
    suspend fun send(message: String, sessionId: String?, fileIds: List<String>): ChatReceipt
}

/**
 * Drives shared captures to the server: upload every file, wait for clean scans, then send one turn. All state
 * is in the [store], so a fresh engine in a relaunched process carries on where the last one stopped; the app
 * runs [runPending] from a WorkManager job so a share finishes after the app is gone. Twin of apps/ios
 * Capture/CaptureEngine.swift.
 */
class CaptureEngine(
    private val store: CaptureJobStore,
    private val api: CaptureApi,
    private val sender: TurnSender,
    private val now: () -> Long = System::currentTimeMillis,
    private val pollIntervalMs: Long = 2_000,
    /** Scan polls per pass; a file still scanning waits for the next pass. */
    private val maxPollsPerPass: Int = 15,
    /** Transient failures tolerated before a job fails. */
    private val maxFailures: Int = 10,
    private val doneRetentionMs: Long = 24 * 60 * 60 * 1000L,
    /** Where the store's file work runs; tests pass their own. */
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    enum class RunResult { SETTLED, RETRY_LATER }

    // Two locks: [passLock] keeps two runs from overlapping and is held across the network calls; [storeLock]
    // guards each store read or write and is held only for that, so enqueue, retry, discard and sign-out never
    // wait behind an upload, a scan or a send.
    private val passLock = Mutex()
    private val storeLock = Mutex()
    private val mutableJobs = MutableStateFlow<List<CaptureJob>>(emptyList())

    /** Empty until [load], a run, or any change. */
    val jobs: StateFlow<List<CaptureJob>> = mutableJobs.asStateFlow()

    /** Reads the saved jobs, e.g. at launch. */
    suspend fun load() = stored { refresh() }

    /** Copies [files] into a new job; nothing leaves the device until [runPending]. */
    suspend fun enqueue(destination: CaptureDestination, message: String, files: List<IncomingFile>): CaptureJob {
        // A fresh id: nothing else touches this payload directory, so the copy needs no lock.
        val id = UUID.randomUUID().toString()
        val staged = withContext(io) {
            val names = mutableSetOf<String>()
            try {
                files.map { incoming ->
                    val name = uniqueName(safeName(incoming.name), names)
                    val target = store.payloadFile(id, name)
                    target.parentFile.mkdirs()
                    val bytes = incoming.open().use { input -> target.outputStream().use { input.copyTo(it) } }
                    CaptureFile(name, incoming.mimeType, bytes)
                }
            } catch (error: Exception) {
                store.discardPayload(id)
                throw error
            }
        }
        val job = CaptureJob(id, destination, message.trim(), staged, createdAtMs = now(), updatedAtMs = now())
        stored {
            store.save(job)
            refresh()
        }
        return job
    }

    /**
     * Pushes every pending job as far as it goes, including jobs queued while the run is under way.
     * [RunResult.RETRY_LATER] while any is still pending.
     */
    suspend fun runPending(): RunResult = passLock.withLock {
        stored { prune() }
        val attempted = mutableSetOf<String>()
        while (true) {
            val next = stored { store.loadAll() }.firstOrNull { it.stage == CaptureStage.PENDING && it.id !in attempted } ?: break
            attempted += next.id
            advance(next)
        }
        stored {
            refresh()
            if (store.loadAll().any { it.stage == CaptureStage.PENDING }) RunResult.RETRY_LATER else RunResult.SETTLED
        }
    }

    /** A failed job goes back in the queue. The user's retry is also the go-ahead to resend an unsure turn. */
    suspend fun retry(id: String) = stored {
        val job = store.load(id)?.takeIf { it.stage == CaptureStage.FAILED } ?: return@stored
        val resend = job.lastFailure == CaptureFailure.DeliveryUnknown
        store.save(
            job.copy(
                stage = CaptureStage.PENDING,
                failures = 0,
                lastFailure = null,
                sendAttemptedAtMs = if (resend) null else job.sendAttemptedAtMs,
                updatedAtMs = now(),
            ),
        )
        refresh()
    }

    suspend fun discard(id: String) = stored {
        store.remove(id)
        refresh()
    }

    /** Sign-out: shares belong to the account that made them. */
    suspend fun discardAll() = stored {
        store.removeAll()
        refresh()
    }

    private suspend fun advance(initial: CaptureJob) {
        var job = initial
        try {
            job = upload(job)
            job = awaitClean(job) ?: return
            job = sendTurn(job)
            stored { store.discardPayload(job.id) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (discarded: DiscardedException) {
            return
        } catch (error: Exception) {
            fail(job, error)
        }
    }

    private suspend fun upload(initial: CaptureJob): CaptureJob {
        var job = initial
        for ((index, file) in job.files.withIndex()) {
            if (file.uploaded) continue
            val payload = store.payloadFile(job.id, file.name)
            if (!stored { payload.exists() }) throw PermanentFailure(CaptureFailure.PayloadMissing)
            // A ticket is never reused: it expires in minutes, and the PUT it signs is create-only.
            val ticket = api.createUpload(file.name, file.mimeType, file.byteCount)
            api.upload(ticket, payload, file.mimeType)
            job = save(job.withFile(index, file.copy(fileId = ticket.fileId, uploaded = true)))
        }
        return job
    }

    /** Null when a file is still scanning; the job then waits for the next pass. */
    private suspend fun awaitClean(initial: CaptureJob): CaptureJob? {
        var job = initial
        for ((index, file) in job.files.withIndex()) {
            if (file.clean) continue
            val fileId = file.fileId ?: throw PermanentFailure(CaptureFailure.PayloadMissing)
            if (!scanClean(fileId)) {
                fail(job, ComposerAttachments.StillScanningException())
                return null
            }
            job = save(job.withFile(index, file.copy(clean = true)))
        }
        return job
    }

    private suspend fun scanClean(fileId: String): Boolean {
        repeat(maxPollsPerPass) { poll ->
            when (api.fileStatus(fileId)) {
                RemoteFileStatus.CLEAN, RemoteFileStatus.UNSCANNED -> return true
                RemoteFileStatus.BLOCKED -> throw PermanentFailure(CaptureFailure.Blocked)
                RemoteFileStatus.PENDING, RemoteFileStatus.SCANNING -> if (poll < maxPollsPerPass - 1) delay(pollIntervalMs)
            }
        }
        return false
    }

    private suspend fun sendTurn(initial: CaptureJob): CaptureJob {
        var job = initial
        val sessionId = (job.destination as? CaptureDestination.Session)?.id
        if (job.sendAttemptedAtMs != null) {
            // An earlier attempt went out and its answer was lost. A new chat cannot be looked up.
            if (sessionId == null) throw PermanentFailure(CaptureFailure.DeliveryUnknown)
            when (api.findSentTurn(sessionId, job.message)) {
                is SentTurnLookup.Found -> return save(job.copy(stage = CaptureStage.DONE, lastFailure = null, sessionId = sessionId))
                SentTurnLookup.Inconclusive -> throw PermanentFailure(CaptureFailure.DeliveryUnknown)
                SentTurnLookup.NotFound -> Unit
            }
        }
        job = save(job.copy(sendAttemptedAtMs = now()))
        return when (val receipt = sender.send(job.message, sessionId, job.files.mapNotNull { it.fileId })) {
            is ChatReceipt.Accepted -> save(
                job.copy(stage = CaptureStage.DONE, lastFailure = null, sessionId = receipt.sessionId ?: sessionId),
            )
            // Refused up front, so nothing was posted: the next attempt need not reconcile.
            is ChatReceipt.Refused -> throw PermanentFailure(CaptureFailure.Rejected(receipt.message), clearSend = true)
        }
    }

    private suspend fun fail(stale: CaptureJob, error: Exception) = stored {
        // The saved record, not the caller's copy: a send recorded just before the error must not be forgotten.
        // No record means the job was discarded meanwhile, and it stays gone.
        val job = store.load(stale.id) ?: return@stored
        val permanent = error as? PermanentFailure
        val failure = permanent?.failure ?: ComposerAttachments.describe(error)
        val failures = job.failures + 1
        val stage = if (permanent != null || !isTransient(error) || failures >= maxFailures) CaptureStage.FAILED else CaptureStage.PENDING
        store.save(
            job.copy(
                stage = stage,
                failures = failures,
                lastFailure = failure,
                sendAttemptedAtMs = if (permanent?.clearSend == true) null else job.sendAttemptedAtMs,
                updatedAtMs = now(),
            ),
        )
        refresh()
    }

    private fun prune() {
        val cutoff = now() - doneRetentionMs
        store.loadAll().filter { it.stage == CaptureStage.DONE && it.updatedAtMs < cutoff }.forEach { store.remove(it.id) }
    }

    /** Saves a step of a run, unless the job was discarded since the run picked it up. */
    private suspend fun save(job: CaptureJob): CaptureJob = stored {
        if (store.load(job.id) == null) throw DiscardedException()
        val stamped = job.copy(updatedAtMs = now())
        store.save(stamped)
        refresh()
        stamped
    }

    /** Callers hold [storeLock]. */
    private fun refresh() {
        mutableJobs.value = store.loadAll()
    }

    private suspend fun <T> stored(block: () -> T): T = withContext(io) { storeLock.withLock { block() } }

    private fun CaptureJob.withFile(index: Int, file: CaptureFile) =
        copy(files = files.toMutableList().also { it[index] = file })

    private class DiscardedException : Exception("The job was discarded during the run")

    private class PermanentFailure(val failure: CaptureFailure, val clearSend: Boolean = false) : Exception(failure.toString())

    companion object {
        /** Worth another pass later: no connection, a busy or failing server, a scan still running, a lapsed sign-in. */
        fun isTransient(error: Throwable): Boolean = when (error) {
            is UpgradeRequiredException -> false
            is IOException, is ComposerAttachments.StillScanningException -> true
            is UploadPutException -> error.status >= 500 || error.status == 403
            is ApiException -> error.status == 401 || error.status == 429 || error.status >= 500
            else -> false
        }

        /** Keeps a shared file's name usable as a file name here and on the server. */
        internal fun safeName(name: String): String =
            name.substringAfterLast('/').replace(Regex("[\\\\:*?\"<>|\\u0000-\\u001f]"), "_").trim().ifEmpty { "file" }.take(120)

        private fun uniqueName(name: String, taken: MutableSet<String>): String {
            var candidate = name
            var counter = 2
            while (!taken.add(candidate)) {
                val dot = name.lastIndexOf('.')
                candidate = if (dot > 0) "${name.substring(0, dot)} ($counter)${name.substring(dot)}" else "$name ($counter)"
                counter++
            }
            return candidate
        }
    }
}
