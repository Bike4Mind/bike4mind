package com.bike4mind.kit.approvals

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.briefs.BriefWire
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.UpgradeRequiredException
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable

/**
 * The two answers to an agent's pending action. [wire] is the route name, and the shared action identifier the
 * server puts in the `approval_needed` push (`PENDING_ACTION_DECISIONS`).
 */
enum class PendingActionDecision(val wire: String) { APPROVE("approve"), DENY("deny") }

/**
 * The pending action a decision applies to: the quest it is parked on and the `ts` (epoch ms) the user was shown.
 * The server applies a decision to exactly that action, never to a newer one that replaced it.
 */
data class PendingActionTarget(val questId: String, val pendingActionTs: Long)

/** What a decision did. [toolSucceeded] false means the action was approved but the tool reported a failure. */
data class PendingActionResult(val decision: PendingActionDecision, val toolSucceeded: Boolean = true, val message: String? = null)

/**
 * Why a decision did not go through. The app turns each case into its own text. The lifecycle cases are final:
 * answering again cannot help. Twin of apps/ios PendingActionFailure.
 */
sealed interface PendingActionFailure {
    /** Whether a retry could succeed (a dropped connection or a busy server), as opposed to a settled answer. */
    val isRetryable: Boolean get() = false

    /** A newer approval on the same quest replaced the one that was shown. */
    data object Replaced : PendingActionFailure

    /** The 15-minute window closed before the answer arrived. */
    data object Expired : PendingActionFailure

    /** Someone (another device, the web) already answered it. */
    data object AlreadyResolved : PendingActionFailure

    /** No such action for this user: the quest is gone, or it is not theirs. */
    data object NotFound : PendingActionFailure

    /** Nothing usable to answer (a malformed quest id or `ts`). */
    data object Unavailable : PendingActionFailure

    /** Refused for a reason that will not change on retry; [reason] is the server's own text, if it sent one. */
    data class Refused(val reason: String?) : PendingActionFailure

    data object Offline : PendingActionFailure {
        override val isRetryable get() = true
    }

    data object RateLimited : PendingActionFailure {
        override val isRetryable get() = true
    }

    data object ServerError : PendingActionFailure {
        override val isRetryable get() = true
    }

    data object SignedOut : PendingActionFailure

    data object UpgradeRequired : PendingActionFailure
}

sealed interface PendingActionOutcome {
    data class Answered(val result: PendingActionResult) : PendingActionOutcome
    data class Failed(val failure: PendingActionFailure) : PendingActionOutcome
}

fun interface PendingActionApi {
    suspend fun respond(target: PendingActionTarget, decision: PendingActionDecision): PendingActionOutcome
}

/**
 * Hand-written client for `POST /api/v1/pending-actions/{questId}/approve|deny` (JWT bearer via [http]'s
 * B4MTransport): the operations are not in `client/operations.txt`. Twin of apps/ios PendingActionClient. The body
 * is `{pendingActionTs}`; the server checks the session owner against the access token on every call.
 */
class PendingActionWire(private val environment: ServerEnvironment, private val http: HttpClient) : PendingActionApi {
    @Serializable
    private data class Request(val pendingActionTs: Long)

    override suspend fun respond(target: PendingActionTarget, decision: PendingActionDecision): PendingActionOutcome {
        if (!BriefWire.isValidId(target.questId) || target.pendingActionTs <= 0) {
            return PendingActionOutcome.Failed(PendingActionFailure.Unavailable)
        }
        return try {
            val response = http.post("${environment.baseUrl}/api/v1/pending-actions/${target.questId}/${decision.wire}") {
                contentType(ContentType.Application.Json)
                setBody(B4MClientJson.encodeToString(Request.serializer(), Request(target.pendingActionTs)))
            }
            outcome(response.status.value, response.bodyAsText(), decision)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (upgrade: UpgradeRequiredException) {
            PendingActionOutcome.Failed(PendingActionFailure.UpgradeRequired)
        } catch (offline: IOException) {
            PendingActionOutcome.Failed(PendingActionFailure.Offline)
        }
    }

    companion object {
        @Serializable
        private data class Success(val success: Boolean? = null, val message: String? = null)

        @Serializable
        private data class ErrorEnvelope(val errorCode: String? = null, val error: String? = null)

        private fun <T> parse(body: String, serializer: KSerializer<T>): T? =
            runCatching { B4MClientJson.decodeFromString(serializer, body) }.getOrNull()

        /** Maps one answer of the route. Twin of apps/ios PendingActionWire.result. */
        fun outcome(status: Int, body: String, decision: PendingActionDecision): PendingActionOutcome {
            val failure = when (status) {
                in 200..299 -> {
                    val parsed = parse(body, Success.serializer())
                    return PendingActionOutcome.Answered(
                        PendingActionResult(decision, toolSucceeded = parsed?.success ?: true, message = parsed?.message),
                    )
                }
                401 -> PendingActionFailure.SignedOut
                404 -> PendingActionFailure.NotFound
                409 -> when (parse(body, ErrorEnvelope.serializer())?.errorCode) {
                    "action_replaced" -> PendingActionFailure.Replaced
                    "action_expired" -> PendingActionFailure.Expired
                    // Also the safe reading of a bare 409: never offer a retry.
                    else -> PendingActionFailure.AlreadyResolved
                }
                426 -> PendingActionFailure.UpgradeRequired
                429 -> PendingActionFailure.RateLimited
                in 400..499 -> PendingActionFailure.Refused(
                    parse(body, ErrorEnvelope.serializer())?.error?.trim()?.ifEmpty { null },
                )
                else -> PendingActionFailure.ServerError
            }
            return PendingActionOutcome.Failed(failure)
        }
    }
}
