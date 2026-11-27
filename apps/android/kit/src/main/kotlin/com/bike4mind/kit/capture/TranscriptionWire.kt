package com.bike4mind.kit.capture

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import java.io.File
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Why a recording did not become text. Twin of apps/ios TranscriptionError. */
sealed class TranscriptionException(message: String?) : Exception(message) {
    /** Empty, over [TranscriptionWire.MAX_BYTES], or a type the server does not take. */
    class UnusableRecording : TranscriptionException("The recording can't be transcribed")

    /** The deployment has no speech model configured. */
    class Unavailable : TranscriptionException("Transcription is unavailable")
    class InsufficientCredits : TranscriptionException("Not enough credits")
    class Failed(message: String?) : TranscriptionException(message)
}

fun interface Transcriber {
    suspend fun transcribe(audio: File, mimeType: String): String
}

/**
 * Server-side transcription over the public contracts (transcription.contract.ts): `POST
 * /api/v1/transcriptions/uploads` mints a presigned S3 POST, the audio is POSTed to it as multipart form data,
 * then `POST /api/v1/transcriptions` with the `file_key` returns the text. Synchronous server-side (45 s budget),
 * so it suits short voice notes. Twin of apps/ios Capture/Transcription.swift. [storage] is a bare client.
 */
class TranscriptionWire(
    private val environment: ServerEnvironment,
    private val http: HttpClient,
    private val storage: HttpClient,
) : Transcriber {
    override suspend fun transcribe(audio: File, mimeType: String): String {
        val bytes = audio.readBytes()
        if (bytes.isEmpty() || bytes.size > MAX_BYTES) throw TranscriptionException.UnusableRecording()

        val mint = http.post("${environment.baseUrl}/api/v1/transcriptions/uploads") {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(UploadRequest.serializer(), UploadRequest(mimeType, bytes.size.toLong())))
        }
        val mintBody = mint.bodyAsText()
        require(mint.status.value, mintBody, 201)
        val ticket = runCatching { B4MClientJson.decodeFromString(UploadReply.serializer(), mintBody) }.getOrNull()
            ?: throw ApiException(mint.status.value)

        val posted = storage.post(ticket.uploadUrl) { setBody(form(ticket.uploadFields, audio.name, bytes, mimeType)) }
        if (posted.status.value !in 200..299) throw TranscriptionException.Failed(null)

        val response = http.post("${environment.baseUrl}/api/v1/transcriptions") {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(TranscribeRequest.serializer(), TranscribeRequest(ticket.fileKey)))
        }
        val body = response.bodyAsText()
        require(response.status.value, body, 200)
        val reply = runCatching { B4MClientJson.decodeFromString(TextReply.serializer(), body) }.getOrNull()
            ?: throw ApiException(response.status.value)
        return reply.text.trim()
    }

    private fun require(status: Int, body: String, expected: Int) {
        if (status == expected) return
        val error = runCatching { B4MClientJson.decodeFromString(ErrorReply.serializer(), body) }.getOrNull()
        throw when (status) {
            422 -> if (error?.errorCode == "insufficient_credits") {
                TranscriptionException.InsufficientCredits()
            } else {
                TranscriptionException.UnusableRecording()
            }
            503 -> TranscriptionException.Unavailable()
            502, 504 -> TranscriptionException.Failed(error?.error)
            else -> ApiException(status)
        }
    }

    @Serializable
    private data class UploadRequest(
        @SerialName("mime_type") val mimeType: String,
        @SerialName("file_size") val fileSize: Long,
    )

    @Serializable
    private data class UploadReply(
        @SerialName("upload_url") val uploadUrl: String,
        @SerialName("upload_fields") val uploadFields: Map<String, String> = emptyMap(),
        @SerialName("file_key") val fileKey: String,
    )

    @Serializable
    private data class TranscribeRequest(@SerialName("file_key") val fileKey: String)

    @Serializable
    private data class TextReply(val text: String)

    @Serializable
    private data class ErrorReply(val error: String? = null, val errorCode: String? = null)

    companion object {
        /** The server's cap (`TRANSCRIPTION_MAX_BYTES`), 25 MiB. */
        const val MAX_BYTES = 25 * 1024 * 1024

        /** Presigned POST: every policy field first, the file last (storage ignores anything after it). */
        internal fun form(fields: Map<String, String>, fileName: String, bytes: ByteArray, mimeType: String) =
            MultiPartFormDataContent(
                formData {
                    fields.toSortedMap().forEach { (name, value) -> append(name, value) }
                    append(
                        "file",
                        bytes,
                        Headers.build {
                            append(HttpHeaders.ContentType, fields["Content-Type"] ?: mimeType)
                            append(HttpHeaders.ContentDisposition, "filename=\"$fileName\"")
                        },
                    )
                },
            )
    }
}
