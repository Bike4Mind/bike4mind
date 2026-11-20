package com.bike4mind.kit.briefs

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.links.Route
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import java.time.Instant
import java.time.format.DateTimeParseException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException

/** The three brief calls the app makes. */
interface BriefApi {
    /** Starts composing a brief. Idempotent on the server while one is already composing. */
    suspend fun compose(): Brief

    /** The user's recent briefs, newest first. */
    suspend fun list(): List<Brief>

    suspend fun brief(id: String): Brief
}

/** A 2xx answer whose body is not a brief. */
class MalformedBriefException(cause: Throwable) : Exception("The server sent a brief this build cannot read", cause)

/**
 * Hand-written client for `/api/v1/briefs` (JWT bearer via [http]'s B4MTransport): the operations are not in
 * `client/operations.txt`. Twin of apps/ios BriefClient. The `brief_ready` push carries only an id; the content
 * is always fetched here with the user's own credentials.
 */
class BriefWire(private val environment: ServerEnvironment, private val http: HttpClient) : BriefApi {
    override suspend fun compose(): Brief =
        decode(http.post(url()), WireBrief.serializer()).toBrief()

    override suspend fun list(): List<Brief> =
        decode(http.get(url()), WireList.serializer()).briefs.map(WireBrief::toBrief)

    override suspend fun brief(id: String): Brief {
        // The id may come from a push; anything that is not a plain id never reaches the URL.
        if (!isValidId(id)) throw ApiException(404)
        return decode(http.get(url("/$id")), WireBrief.serializer()).toBrief()
    }

    private suspend fun <T> decode(response: HttpResponse, serializer: KSerializer<T>): T {
        if (!response.status.isSuccess()) throw ApiException(response.status.value)
        return try {
            B4MClientJson.decodeFromString(serializer, response.bodyAsText())
        } catch (malformed: SerializationException) {
            throw MalformedBriefException(malformed)
        } catch (malformed: IllegalArgumentException) {
            throw MalformedBriefException(malformed)
        }
    }

    private fun url(suffix: String = "") = environment.baseUrl + "/api/v1/briefs" + suffix

    companion object {
        fun isValidId(id: String): Boolean = Route.isValidId(id)
    }
}

@Serializable
private data class WireList(val briefs: List<WireBrief>)

@Serializable
private data class WireItem(val id: String, val text: String)

@Serializable
private data class WireApproval(val questId: String, val sessionId: String, val pendingActionTs: Long)

@Serializable
private data class WireDecision(val id: String, val text: String, val approval: WireApproval? = null)

@Serializable
private data class WireBrief(
    val id: String,
    val status: String,
    val createdAt: String? = null,
    val composedAt: String? = null,
    val periodStart: String? = null,
    val periodEnd: String? = null,
    val headline: String? = null,
    val happened: List<WireItem> = emptyList(),
    val handled: List<WireItem> = emptyList(),
    val decisions: List<WireDecision> = emptyList(),
) {
    fun toBrief() = Brief(
        id = id,
        status = BriefStatus.from(status),
        createdAt = instant(createdAt),
        composedAt = instant(composedAt),
        periodStart = instant(periodStart),
        periodEnd = instant(periodEnd),
        headline = headline,
        happened = happened.map { BriefItem(it.id, it.text) },
        handled = handled.map { BriefItem(it.id, it.text) },
        decisions = decisions.map { decision ->
            BriefDecision(
                decision.id,
                decision.text,
                decision.approval?.let { BriefApprovalRef(it.questId, it.sessionId, it.pendingActionTs) },
            )
        },
    )
}

/** A timestamp is display-only here, so an unparseable one is dropped rather than failing the whole brief. */
private fun instant(raw: String?): Instant? = raw?.let {
    try {
        Instant.parse(it)
    } catch (unparseable: DateTimeParseException) {
        null
    }
}
