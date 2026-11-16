package com.bike4mind.kit.chat

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** What POST /api/chat answered: the quest that will stream, or why it never will. */
sealed interface ChatReceipt {
    data class Accepted(val questId: String, val sessionId: String?) : ChatReceipt

    /** Refused up front (`type: "error"`), e.g. `insufficient_credits` or `spend_cap_exceeded`. */
    data class Refused(val errorCode: String?, val message: String?) : ChatReceipt
}

/**
 * Hand-written POST /api/chat. The generated client leaves `sendChatMessage` out (see client/operations.txt).
 * Twin of apps/ios Chat/ChatSendWire.swift; [http] carries the B4MTransport (auth, identity, 426).
 */
class ChatSendWire(private val environment: ServerEnvironment, private val http: HttpClient) {
    @Serializable
    private data class Request(
        val message: String,
        val sessionId: String? = null,
        val newConversation: Boolean? = null,
        // No default: B4MClientJson omits default values, and the server must see `stream: true`.
        val stream: Boolean,
        val fileIds: List<String>? = null,
    )

    @Serializable
    private data class TrackingInfo(@SerialName("quest_id") val questId: String? = null)

    @Serializable
    private data class Response(
        val id: String? = null,
        val sessionId: String? = null,
        val type: String? = null,
        val errorCode: String? = null,
        val message: String? = null,
        @SerialName("tracking_info") val trackingInfo: TrackingInfo? = null,
    )

    /** Sends into [sessionId], or starts a new session when it is null (the receipt then names it). */
    suspend fun send(message: String, sessionId: String?): ChatReceipt {
        val request = Request(
            message = message,
            sessionId = sessionId,
            newConversation = if (sessionId == null) true else null,
            stream = true,
        )
        val response = http.post(environment.baseUrl + "/api/chat") {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(Request.serializer(), request))
        }
        if (!response.status.isSuccess()) throw ApiException(response.status.value)
        val body = B4MClientJson.decodeFromString(Response.serializer(), response.bodyAsText())
        if (body.type == "error") return ChatReceipt.Refused(body.errorCode, body.message)
        val questId = body.id ?: body.trackingInfo?.questId ?: throw ApiException(response.status.value)
        return ChatReceipt.Accepted(questId, body.sessionId ?: sessionId)
    }
}
