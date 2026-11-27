package com.bike4mind.kit.briefs

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.links.Route
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import java.time.Instant
import java.time.format.DateTimeParseException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException

/** The brief calls the app makes. */
interface BriefApi {
    /** Starts composing a brief. Idempotent on the server while one is already composing. */
    suspend fun compose(): Brief

    /** The user's recent briefs, newest first. */
    suspend fun list(): List<Brief>

    suspend fun brief(id: String): Brief

    /** Starts composing a follow-up brief from a dictated transcript; the returned brief is usually COMPOSING. */
    suspend fun followUp(transcript: String, timeZone: String?): Brief

    /** @throws DecisionClosedException, InvalidDecisionException, ApiException */
    suspend fun editDecision(briefId: String, decisionId: String, edit: BriefDecisionEdit): BriefDecision

    /** @throws DecisionClosedException, InvalidDecisionException, ApiException */
    suspend fun resolveDecision(briefId: String, decisionId: String, outcome: BriefDecisionOutcome): BriefDecision
}

/** The follow-up was already approved or dismissed (409 `decision_closed`). Final: refetch to show its state. */
class DecisionClosedException : Exception("This follow-up was already settled.")

/** The server rejected the change (400), e.g. approving an email whose recipient is not an address yet. */
class InvalidDecisionException(message: String) : Exception(message)

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

    override suspend fun followUp(transcript: String, timeZone: String?): Brief {
        val response = http.post(url("/follow-ups")) {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(WireFollowUpRequest.serializer(), WireFollowUpRequest(transcript, timeZone)))
        }
        return decode(response, WireBrief.serializer()).toBrief()
    }

    override suspend fun editDecision(briefId: String, decisionId: String, edit: BriefDecisionEdit): BriefDecision {
        if (!isValidId(briefId) || !isValidId(decisionId)) throw ApiException(404)
        val body = WireEdit(
            text = edit.text,
            draftReply = edit.draftReply?.let { WireDraftReply(it.to, it.subject, it.body) },
            remindAt = edit.remindAt?.toString(),
        )
        val response = http.patch(url("/$briefId/decisions/$decisionId")) {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(WireEdit.serializer(), body))
        }
        return decodeDecision(response)
    }

    override suspend fun resolveDecision(briefId: String, decisionId: String, outcome: BriefDecisionOutcome): BriefDecision {
        if (!isValidId(briefId) || !isValidId(decisionId)) throw ApiException(404)
        val response = http.post(url("/$briefId/decisions/$decisionId/resolve")) {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(WireResolve.serializer(), WireResolve(outcome.wire)))
        }
        return decodeDecision(response)
    }

    private suspend fun decodeDecision(response: HttpResponse): BriefDecision {
        if (!response.status.isSuccess()) {
            val envelope = try {
                B4MClientJson.decodeFromString(WireErrorEnvelope.serializer(), response.bodyAsText())
            } catch (unreadable: SerializationException) {
                null
            } catch (unreadable: IllegalArgumentException) {
                null
            }
            when {
                response.status.value == 409 && envelope?.errorCode == DECISION_CLOSED_ERROR_CODE -> throw DecisionClosedException()
                response.status.value == 400 -> throw InvalidDecisionException(envelope?.error?.trim()?.takeIf { it.isNotEmpty() } ?: FALLBACK_INVALID)
                else -> throw ApiException(response.status.value)
            }
        }
        return decode(response, WireDecision.serializer()).toDecision()
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

        // Must match BRIEF_DECISION_CLOSED_ERROR_CODE in b4m-core/common/src/apiErrorCodes.ts.
        const val DECISION_CLOSED_ERROR_CODE = "decision_closed"
        const val FALLBACK_INVALID = "That change could not be saved. Check the follow-up and try again."
    }
}

@Serializable
private data class WireList(val briefs: List<WireBrief>)

@Serializable
private data class WireItem(val id: String, val text: String)

@Serializable
private data class WireApproval(val questId: String, val sessionId: String, val pendingActionTs: Long)

@Serializable
private data class WireFollowUp(val kind: String, val state: String, val remindAt: String? = null)

@Serializable
private data class WireDraftReply(val to: String, val subject: String, val body: String)

@Serializable
private data class WireDecision(
    val id: String,
    val text: String,
    val approval: WireApproval? = null,
    val followUp: WireFollowUp? = null,
    val draftReply: WireDraftReply? = null,
) {
    fun toDecision() = BriefDecision(
        id = id,
        text = text,
        approval = approval?.let { BriefApprovalRef(it.questId, it.sessionId, it.pendingActionTs) },
        followUp = followUp?.let { BriefFollowUp(FollowUpKind.from(it.kind), FollowUpState.from(it.state), instant(it.remindAt)) },
        draftReply = draftReply?.let { BriefDraftReply(it.to, it.subject, it.body) },
    )
}

@Serializable
private data class WireFollowUpRequest(val transcript: String, val timeZone: String? = null)

@Serializable
private data class WireEdit(val text: String? = null, val draftReply: WireDraftReply? = null, val remindAt: String? = null)

@Serializable
private data class WireResolve(val outcome: String)

@Serializable
private data class WireErrorEnvelope(val errorCode: String? = null, val error: String? = null)

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
        decisions = decisions.map(WireDecision::toDecision),
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
