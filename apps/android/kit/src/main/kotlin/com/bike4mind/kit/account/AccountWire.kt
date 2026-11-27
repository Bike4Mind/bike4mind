package com.bike4mind.kit.account

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.UpgradeRequiredException
import com.bike4mind.kit.push.NotificationCategory
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** An organization the user owns that must get a new owner before the account can be deleted. */
data class AccountOrganization(val id: String, val name: String?)

/** Why `POST /api/account/deletion` did not go through. Twin of apps/ios AccountDeletionFailure. */
sealed interface AccountDeletionFailure {
    data class OrganizationTransferRequired(val organizations: List<AccountOrganization>) : AccountDeletionFailure

    /** The server refuses this session (an impersonating admin). */
    data object NotPermitted : AccountDeletionFailure

    /** The gate wants fresh proof of identity: a passed `POST /api/auth/step-up`, not a fresh sign-in. */
    data object StepUpRequired : AccountDeletionFailure

    /** The token has no session id, so it cannot be stepped up; only signing in again helps. */
    data object StepUpUnavailable : AccountDeletionFailure

    data object AlreadyScheduled : AccountDeletionFailure
    data object Offline : AccountDeletionFailure
    data object SignedOut : AccountDeletionFailure
    data object UpgradeRequired : AccountDeletionFailure
    data class Server(val status: Int) : AccountDeletionFailure
}

sealed interface AccountDeletionOutcome {
    /** Accepted: every session, this one included, is now revoked. [scheduledFor] is the purge date, if given. */
    data class Scheduled(val scheduledFor: Instant?) : AccountDeletionOutcome
    data class Failed(val failure: AccountDeletionFailure) : AccountDeletionOutcome
}

/**
 * The account calls behind Settings. [profile], [setPushCategory] and [restoreDeletion] throw [ApiException] for
 * a refusal, [IOException] when offline and [UpgradeRequiredException] for a 426.
 */
interface AccountApi {
    suspend fun profile(): AccountProfile
    suspend fun setPushCategory(category: NotificationCategory, enabled: Boolean)
    suspend fun requestDeletion(): AccountDeletionOutcome
    suspend fun restoreDeletion()
}

/**
 * Hand-written client for the account routes, twin of apps/ios AccountClient. Server counterparts:
 * - `GET /api/users/{id}` (self view: name, email, `preferences.pushNotifications`);
 * - `PUT /api/users/{id}/update` with `{preferences: {pushNotifications: {<category>: bool}}}`, which the server
 *   merges per category (b4m-core/services/src/userService/update.ts mergePreferences);
 * - `POST /api/account/deletion` requests deletion with a 30-day grace period: 202
 *   `{deletion: {scheduledFor}}`, then every session is revoked. 403 `{code: step_up_required |
 *   step_up_unavailable}` until the session passes step-up, 403 without a code for an impersonating admin, 409
 *   `{code: ACCOUNT_DELETION_ORG_OWNER, organizations}` for owned organizations, 409 otherwise when already
 *   scheduled (apps/client/pages/api/account/deletion.ts);
 * - `DELETE /api/account/deletion` cancels it: 204, or 404 when nothing was scheduled.
 * [userId] reads the signed-in user's id from the access token.
 */
class AccountWire(
    private val environment: ServerEnvironment,
    private val http: HttpClient,
    private val userId: () -> String?,
) : AccountApi {
    override suspend fun profile(): AccountProfile {
        val id = userId() ?: throw ApiException(401)
        val response = http.get("${environment.baseUrl}/api/users/$id")
        val body = response.bodyAsText()
        if (response.status.value !in 200..299) throw ApiException(response.status.value)
        return AccountProfile.fromUserJson(body) ?: throw ApiException(response.status.value)
    }

    override suspend fun setPushCategory(category: NotificationCategory, enabled: Boolean) {
        val id = userId() ?: throw ApiException(401)
        val body = buildJsonObject {
            putJsonObject("preferences") { putJsonObject("pushNotifications") { put(category.wire, enabled) } }
        }
        val response = http.put("${environment.baseUrl}/api/users/$id/update") {
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }
        if (response.status.value !in 200..299) throw ApiException(response.status.value)
    }

    override suspend fun requestDeletion(): AccountDeletionOutcome = try {
        val response: HttpResponse = http.post("${environment.baseUrl}/$DELETION_PATH")
        deletionOutcome(response.status.value, response.bodyAsText())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (upgrade: UpgradeRequiredException) {
        AccountDeletionOutcome.Failed(AccountDeletionFailure.UpgradeRequired)
    } catch (offline: IOException) {
        AccountDeletionOutcome.Failed(AccountDeletionFailure.Offline)
    }

    override suspend fun restoreDeletion() {
        val status = http.delete("${environment.baseUrl}/$DELETION_PATH").status.value
        // 404: nothing was scheduled, which is the state the caller wants.
        if (status !in 200..299 && status != 404) throw ApiException(status)
    }

    companion object {
        const val DELETION_PATH = "api/account/deletion"
        const val ORG_OWNER_CODE = "ACCOUNT_DELETION_ORG_OWNER"
        const val STEP_UP_REQUIRED_CODE = "step_up_required"
        const val STEP_UP_UNAVAILABLE_CODE = "step_up_unavailable"

        @Serializable
        private data class WireOrganization(val id: String? = null, val name: String? = null)

        @Serializable
        private data class ErrorEnvelope(val code: String? = null, val organizations: List<WireOrganization>? = null)

        @Serializable
        private data class Deletion(val scheduledFor: String? = null)

        @Serializable
        private data class Receipt(val deletion: Deletion? = null)

        /** Maps one answer of `POST /api/account/deletion`. Twin of apps/ios AccountDeletionWire.deletionResult. */
        fun deletionOutcome(status: Int, body: String): AccountDeletionOutcome {
            val envelope = runCatching { B4MClientJson.decodeFromString(ErrorEnvelope.serializer(), body) }.getOrNull()
            val failure = when (status) {
                in 200..299 -> {
                    val receipt = runCatching { B4MClientJson.decodeFromString(Receipt.serializer(), body) }.getOrNull()
                    return AccountDeletionOutcome.Scheduled(receipt?.deletion?.scheduledFor?.let(::parseInstant))
                }
                401 -> AccountDeletionFailure.SignedOut
                403 -> when (envelope?.code) {
                    STEP_UP_REQUIRED_CODE -> AccountDeletionFailure.StepUpRequired
                    STEP_UP_UNAVAILABLE_CODE -> AccountDeletionFailure.StepUpUnavailable
                    else -> AccountDeletionFailure.NotPermitted
                }
                409 -> if (envelope?.code == ORG_OWNER_CODE) {
                    AccountDeletionFailure.OrganizationTransferRequired(
                        envelope.organizations.orEmpty().mapNotNull { organization ->
                            val id = organization.id?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                            AccountOrganization(id, organization.name?.trim()?.ifEmpty { null })
                        },
                    )
                } else {
                    AccountDeletionFailure.AlreadyScheduled
                }
                else -> AccountDeletionFailure.Server(status)
            }
            return AccountDeletionOutcome.Failed(failure)
        }
    }
}
