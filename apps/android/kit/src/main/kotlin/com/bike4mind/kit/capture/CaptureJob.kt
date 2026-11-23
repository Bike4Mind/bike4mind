package com.bike4mind.kit.capture

import com.bike4mind.client.B4MClientJson
import java.io.File
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Where a share lands. The chat's name is carried so the list of pending shares can show it without a fetch. */
@Serializable
sealed interface CaptureDestination {
    @Serializable @SerialName("session")
    data class Session(val id: String, val name: String?) : CaptureDestination

    @Serializable @SerialName("new_chat")
    data object NewChat : CaptureDestination
}

enum class CaptureStage { PENDING, DONE, FAILED }

/** One shared file. Its bytes live in the job's payload directory until the turn is sent. */
@Serializable
data class CaptureFile(
    val name: String,
    val mimeType: String,
    val byteCount: Long,
    val fileId: String? = null,
    /** The PUT landed; [fileId] names the server's record. */
    val uploaded: Boolean = false,
    val clean: Boolean = false,
)

/**
 * One share from another app: its files and the message they go out with, as a single chat turn. Saved on every
 * step so a killed process picks up where it stopped. Twin of apps/ios Capture/UploadJob.swift, which keeps one
 * job per item; one per share here, so a share of several files to a new chat opens one chat, not several.
 */
@Serializable
data class CaptureJob(
    val id: String,
    val destination: CaptureDestination,
    val message: String,
    val files: List<CaptureFile>,
    val createdAtMs: Long,
    val updatedAtMs: Long,
    val stage: CaptureStage = CaptureStage.PENDING,
    /** Transient failures so far; bounds a server that keeps failing. */
    val failures: Int = 0,
    /** The latest problem, whether the job waits to retry or has failed. */
    val lastFailure: CaptureFailure? = null,
    /**
     * Set just before `POST /api/chat` goes out. The route is not idempotent, so a job found with this set may
     * already have its turn on the server and is reconciled before it is sent again.
     */
    val sendAttemptedAtMs: Long? = null,
    /** The chat the turn landed in, once sent. */
    val sessionId: String? = null,
)

/** One JSON file per job plus a payload directory per job, under [root]. Writes go through a rename. */
class CaptureJobStore(private val root: File) {
    private val jobs get() = File(root, "jobs")

    fun loadAll(): List<CaptureJob> =
        jobs.listFiles { file -> file.extension == "json" }.orEmpty()
            // A damaged record must not hide every other job.
            .mapNotNull { file -> runCatching { decode(file.readText()) }.getOrNull() }
            .sortedWith(compareBy({ it.createdAtMs }, { it.id }))

    fun load(id: String): CaptureJob? = File(jobs, "$id.json").takeIf { it.exists() }?.let { runCatching { decode(it.readText()) }.getOrNull() }

    fun save(job: CaptureJob) {
        jobs.mkdirs()
        val target = File(jobs, "${job.id}.json")
        val temp = File(jobs, "${job.id}.json.tmp")
        temp.writeText(B4MClientJson.encodeToString(CaptureJob.serializer(), job))
        if (!temp.renameTo(target)) {
            temp.delete()
            error("Could not save capture job ${job.id}")
        }
    }

    fun remove(id: String) {
        discardPayload(id)
        File(jobs, "$id.json").delete()
    }

    fun removeAll() {
        root.deleteRecursively()
    }

    fun payloadFile(jobId: String, name: String): File = File(File(File(root, "payloads"), jobId), name)

    fun discardPayload(jobId: String) {
        File(File(root, "payloads"), jobId).deleteRecursively()
    }

    private fun decode(text: String) = B4MClientJson.decodeFromString(CaptureJob.serializer(), text)
}
