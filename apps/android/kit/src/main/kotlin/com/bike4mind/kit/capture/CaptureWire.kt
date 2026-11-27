package com.bike4mind.kit.capture

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.content.OutgoingContent
import io.ktor.http.contentType
import io.ktor.utils.io.ByteWriteChannel
import io.ktor.utils.io.writeFully
import java.io.File
import java.time.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** The presigned upload the server minted for one file: a one-shot PUT bound to the exact byte count. */
data class UploadTicket(val fileId: String, val uploadUrl: String, val expiresAt: Instant?)

/** The server's scan state of an uploaded file; a file is usable once it is [CLEAN] or [UNSCANNED]. */
enum class RemoteFileStatus { PENDING, SCANNING, CLEAN, BLOCKED, UNSCANNED }

/** Whether a session already holds the turn a capture tried to send. */
sealed interface SentTurnLookup {
    data class Found(val questId: String) : SentTurnLookup
    data object NotFound : SentTurnLookup

    /** The session's turns could not all be read, so a resend might duplicate the turn. */
    data object Inconclusive : SentTurnLookup
}

/** The server refused an upload on its merits (400/422); [message] is its explanation, safe to show. */
class CaptureRejectedException(override val message: String?) : Exception(message)

/** Storage refused the bytes (the PUT answered [status]). */
class UploadPutException(val status: Int) : Exception("The upload answered HTTP $status")

/**
 * What capture asks of the backend. Throws [ApiException] for other refusals and `IOException` when offline.
 * Twin of apps/ios B4MKit Capture/CaptureAPI.swift.
 */
interface CaptureApi {
    suspend fun createUpload(fileName: String, mimeType: String, byteCount: Long): UploadTicket
    suspend fun upload(ticket: UploadTicket, file: File, mimeType: String)
    suspend fun fileStatus(fileId: String): RemoteFileStatus

    /**
     * Looks for a turn in [sessionId] whose prompt is [message]. The quest list carries no timestamp, so an
     * identical earlier prompt also matches, as on iOS; a capture's prompt names its files, which keeps that rare.
     */
    suspend fun findSentTurn(sessionId: String, message: String): SentTurnLookup
}

/**
 * Hand-written client for the public upload contracts (b4m-core/common/src/api-contract/contracts):
 * - `POST /api/v1/files` createFileUpload (files.contract.ts), then a `PUT` of the raw bytes to `upload_url`;
 * - `GET /api/v1/files/{id}` getFile, polled until `moderation_status` is `clean`;
 * - `GET /api/v1/sessions/{id}/quests` listSessionQuests (sessionQuests.contract.ts), oldest first.
 * [http] carries the B4MTransport; [storage] is a bare client, since the URL signature is the PUT's only
 * credential and storage rejects a request that also carries a bearer token.
 */
class CaptureWire(
    private val environment: ServerEnvironment,
    private val http: HttpClient,
    private val storage: HttpClient,
) : CaptureApi {
    override suspend fun createUpload(fileName: String, mimeType: String, byteCount: Long): UploadTicket {
        val response = http.post("${environment.baseUrl}/api/v1/files") {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(CreateUpload.serializer(), CreateUpload(fileName, mimeType, byteCount)))
        }
        val body = response.bodyAsText()
        requireOk(response.status.value, body, 201)
        val reply = runCatching { B4MClientJson.decodeFromString(UploadReply.serializer(), body) }.getOrNull()
            ?: throw ApiException(response.status.value)
        return UploadTicket(reply.id, reply.uploadUrl, reply.uploadUrlExpiresAt?.let { runCatching { Instant.parse(it) }.getOrNull() })
    }

    override suspend fun upload(ticket: UploadTicket, file: File, mimeType: String) {
        val status = storage.put(ticket.uploadUrl) {
            // Signed into the URL: without it storage refuses the PUT, and with it a repeat PUT cannot overwrite.
            header(HttpHeaders.IfNoneMatch, "*")
            setBody(FileContent(file, ContentType.parse(mimeType)))
        }.status.value
        // 412: an earlier attempt already landed these bytes, which is the state this call wants.
        if (status !in 200..299 && status != 412) throw UploadPutException(status)
    }

    override suspend fun fileStatus(fileId: String): RemoteFileStatus {
        val response = http.get("${environment.baseUrl}/api/v1/files/$fileId")
        val body = response.bodyAsText()
        requireOk(response.status.value, body, 200)
        val reply = runCatching { B4MClientJson.decodeFromString(FileReply.serializer(), body) }.getOrNull()
            ?: throw ApiException(response.status.value)
        return when (reply.moderationStatus) {
            null -> RemoteFileStatus.UNSCANNED
            "clean" -> RemoteFileStatus.CLEAN
            "blocked" -> RemoteFileStatus.BLOCKED
            "scanning" -> RemoteFileStatus.SCANNING
            else -> RemoteFileStatus.PENDING
        }
    }

    override suspend fun findSentTurn(sessionId: String, message: String): SentTurnLookup {
        val wanted = message.trim()
        var cursor: String? = null
        repeat(MAX_RECONCILE_PAGES) {
            val response = http.get("${environment.baseUrl}/api/v1/sessions/$sessionId/quests") {
                parameter("limit", 100)
                cursor?.let { parameter("cursor", it) }
            }
            val body = response.bodyAsText()
            requireOk(response.status.value, body, 200)
            val page = runCatching { B4MClientJson.decodeFromString(QuestPage.serializer(), body) }.getOrNull()
                ?: throw ApiException(response.status.value)
            val match = page.data.firstOrNull { it.prompt?.trim() == wanted }
            if (match != null) return SentTurnLookup.Found(match.id)
            cursor = page.nextCursor ?: return SentTurnLookup.NotFound
        }
        return SentTurnLookup.Inconclusive
    }

    private fun requireOk(status: Int, body: String, expected: Int) {
        if (status == expected) return
        if (status == 400 || status == 422) {
            val error = runCatching { B4MClientJson.decodeFromString(ErrorReply.serializer(), body) }.getOrNull()
            throw CaptureRejectedException(error?.error)
        }
        throw ApiException(status)
    }

    @Serializable
    private data class CreateUpload(
        @SerialName("file_name") val fileName: String,
        @SerialName("mime_type") val mimeType: String,
        @SerialName("file_size") val fileSize: Long,
    )

    @Serializable
    private data class UploadReply(
        val id: String,
        @SerialName("upload_url") val uploadUrl: String,
        @SerialName("upload_url_expires_at") val uploadUrlExpiresAt: String? = null,
    )

    @Serializable
    private data class FileReply(@SerialName("moderation_status") val moderationStatus: String? = null)

    @Serializable
    private data class ErrorReply(val error: String? = null)

    @Serializable
    private data class QuestSummary(val id: String, val prompt: String? = null)

    @Serializable
    private data class QuestPage(
        val data: List<QuestSummary> = emptyList(),
        @SerialName("next_cursor") val nextCursor: String? = null,
    )

    companion object {
        /** Pages read when reconciling a send; a longer session reports [SentTurnLookup.Inconclusive]. */
        const val MAX_RECONCILE_PAGES = 10
    }
}

/** Streams [file] as the request body, so a large scan is never held in memory whole. */
internal class FileContent(private val file: File, override val contentType: ContentType) : OutgoingContent.WriteChannelContent() {
    override val contentLength: Long = file.length()

    override suspend fun writeTo(channel: ByteWriteChannel) {
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                channel.writeFully(buffer, 0, read)
            }
        }
    }
}
