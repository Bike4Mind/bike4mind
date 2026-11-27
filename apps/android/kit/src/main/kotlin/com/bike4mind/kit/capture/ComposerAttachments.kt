package com.bike4mind.kit.capture

import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.UpgradeRequiredException
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ComposerAttachment(val id: String, val name: String, val mimeType: String, val phase: Phase) {
    sealed interface Phase {
        data object Uploading : Phase
        data class Ready(val fileId: String) : Phase
        data class Failed(val failure: CaptureFailure) : Phase
    }
}

/** The file ids to send with the next turn, or null while any attachment is still uploading or failed. */
fun List<ComposerAttachment>.readyFileIds(): List<String>? =
    map { (it.phase as? ComposerAttachment.Phase.Ready)?.fileId ?: return null }

/**
 * The files waiting in a chat composer. Each one uploads as soon as it is added (mint, PUT, wait for a clean
 * scan), so the turn that carries them goes out through the ordinary send and streams like any other. The
 * local copies are owned here and deleted once they are no longer needed.
 */
class ComposerAttachments(
    private val api: CaptureApi,
    private val scope: CoroutineScope,
    private val pollIntervalMs: Long = 2_000,
    private val maxPolls: Int = 30,
) {
    private data class Source(val file: File, val name: String, val mimeType: String)

    private val mutableState = MutableStateFlow<List<ComposerAttachment>>(emptyList())
    val state: StateFlow<List<ComposerAttachment>> = mutableState.asStateFlow()

    private val sources = mutableMapOf<String, Source>()

    /** Files whose PUT landed: a retry after a scan timeout resumes the poll rather than uploading again. */
    private val uploaded = mutableMapOf<String, String>()
    private val uploads = mutableMapOf<String, Job>()

    fun add(file: File, name: String, mimeType: String) {
        val id = UUID.randomUUID().toString()
        sources[id] = Source(file, name, mimeType)
        mutableState.update { it + ComposerAttachment(id, name, mimeType, ComposerAttachment.Phase.Uploading) }
        start(id)
    }

    fun retry(id: String) {
        if (state.value.none { it.id == id && it.phase is ComposerAttachment.Phase.Failed }) return
        setPhase(id, ComposerAttachment.Phase.Uploading)
        start(id)
    }

    fun remove(id: String) {
        uploads.remove(id)?.cancel()
        uploaded.remove(id)
        sources.remove(id)?.file?.delete()
        mutableState.update { list -> list.filterNot { it.id == id } }
    }

    /** After the turn went out: the files are on the server, so the local copies go. */
    fun clear() {
        state.value.map { it.id }.forEach(::remove)
    }

    /** After a turn carrying [fileIds] went out: lets go of just those files, so attachments added since stay. */
    fun clear(fileIds: Collection<String>) {
        state.value.filter { (it.phase as? ComposerAttachment.Phase.Ready)?.fileId in fileIds }.forEach { remove(it.id) }
    }

    private fun start(id: String) {
        val source = sources[id] ?: return
        uploads[id] = scope.launch {
            val phase = try {
                ComposerAttachment.Phase.Ready(upload(id, source))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                ComposerAttachment.Phase.Failed(describe(error))
            }
            if (phase is ComposerAttachment.Phase.Ready) source.file.delete()
            setPhase(id, phase)
        }
    }

    private suspend fun upload(id: String, source: Source): String {
        val fileId = uploaded[id] ?: run {
            val ticket = api.createUpload(source.name, source.mimeType, source.file.length())
            api.upload(ticket, source.file, source.mimeType)
            ticket.fileId.also { uploaded[id] = it }
        }
        repeat(maxPolls) { poll ->
            when (api.fileStatus(fileId)) {
                RemoteFileStatus.CLEAN, RemoteFileStatus.UNSCANNED -> return fileId
                RemoteFileStatus.BLOCKED -> throw BlockedException()
                RemoteFileStatus.PENDING, RemoteFileStatus.SCANNING -> if (poll < maxPolls - 1) delay(pollIntervalMs)
            }
        }
        throw StillScanningException()
    }

    private fun setPhase(id: String, phase: ComposerAttachment.Phase) {
        mutableState.update { list -> list.map { if (it.id == id) it.copy(phase = phase) else it } }
    }

    internal class BlockedException : Exception("Blocked by the scan")
    internal class StillScanningException : Exception("Still being scanned")

    companion object {
        fun describe(error: Throwable): CaptureFailure = when (error) {
            is BlockedException -> CaptureFailure.Blocked
            is StillScanningException -> CaptureFailure.StillScanning
            is CaptureRejectedException -> CaptureFailure.Rejected(error.message)
            is UpgradeRequiredException -> CaptureFailure.UpgradeRequired
            is IOException -> CaptureFailure.Offline
            is ApiException -> when (error.status) {
                401 -> CaptureFailure.SignedOut
                403, 404 -> CaptureFailure.DestinationGone
                else -> CaptureFailure.Failed
            }
            else -> CaptureFailure.Failed
        }
    }
}
