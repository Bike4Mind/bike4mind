package com.bike4mind.kit.account

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.UpgradeRequiredException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable

/** A way to re-prove identity. Passkey is left to the web, as on iOS: the server never offers it alone. */
enum class StepUpMethod(val wire: String) {
    PASSWORD("password"),
    TOTP("totp"),
    EMAIL("email"),
    ;

    companion object {
        fun fromWire(value: String): StepUpMethod? = entries.firstOrNull { it.wire == value }
    }
}

/** [methods]: the ones this app can collect, in the server's order. [stepUpUntil]: set while already inside the window. */
data class StepUpOptions(val methods: List<StepUpMethod>, val stepUpUntil: Instant?)

/** The proof the user typed, one case per accepted `method` of `POST /api/auth/step-up`. */
sealed interface StepUpProof {
    data class Password(val password: String) : StepUpProof
    data class Totp(val code: String) : StepUpProof
    data class Email(val pendingToken: String, val code: String) : StepUpProof
}

sealed interface StepUpFailure {
    /** 400 `step_up_failed`: wrong or expired. [attemptsRemaining] is null when the server does not count. */
    data class Rejected(val message: String?, val attemptsRemaining: Int?) : StepUpFailure

    /** 429, or 423 when the shared second-factor lockout is reached. */
    data object RateLimited : StepUpFailure

    /** Too many wrong passwords revoked the session, or it cannot be stepped up: the app signs out. */
    data object SessionEnded : StepUpFailure

    data object Offline : StepUpFailure
    data object UpgradeRequired : StepUpFailure
    data class Server(val status: Int) : StepUpFailure
}

sealed interface StepUpOutcome {
    data class Verified(val until: Instant?) : StepUpOutcome
    data class Failed(val failure: StepUpFailure) : StepUpOutcome
}

/** [options] and [sendEmailCode] throw [ApiException], [IOException] or [UpgradeRequiredException]. */
interface StepUpApi {
    suspend fun options(): StepUpOptions

    /** Emails a code; returns the pending token that [verify] needs alongside it. */
    suspend fun sendEmailCode(): String

    suspend fun verify(proof: StepUpProof): StepUpOutcome
}

/**
 * Hand-written client for the step-up routes (not in the OpenAPI contract). Server counterparts:
 * apps/client/pages/api/auth/step-up/index.ts, options.ts and email/send.ts. Twin of apps/ios StepUpClient.
 */
class StepUpWire(private val environment: ServerEnvironment, private val http: HttpClient) : StepUpApi {
    @Serializable
    private data class OptionsEnvelope(val methods: List<String>? = null, val stepUpUntil: String? = null)

    @Serializable
    private data class SendEnvelope(val pendingToken: String? = null)

    @Serializable
    private data class Body(
        val method: String,
        val password: String? = null,
        val code: String? = null,
        val pendingToken: String? = null,
    )

    override suspend fun options(): StepUpOptions {
        val response = http.get("${environment.baseUrl}/$OPTIONS_PATH")
        val body = response.bodyAsText()
        if (response.status.value != 200) throw ApiException(response.status.value)
        val envelope = runCatching { B4MClientJson.decodeFromString(OptionsEnvelope.serializer(), body) }.getOrNull()
            ?: throw ApiException(response.status.value)
        return StepUpOptions(
            methods = envelope.methods.orEmpty().mapNotNull(StepUpMethod::fromWire),
            stepUpUntil = envelope.stepUpUntil?.let(::parseInstant),
        )
    }

    override suspend fun sendEmailCode(): String {
        val response = http.post("${environment.baseUrl}/$EMAIL_SEND_PATH")
        val body = response.bodyAsText()
        if (response.status.value != 200) throw ApiException(response.status.value)
        return runCatching { B4MClientJson.decodeFromString(SendEnvelope.serializer(), body) }.getOrNull()
            ?.pendingToken?.takeIf { it.isNotEmpty() }
            ?: throw ApiException(response.status.value)
    }

    override suspend fun verify(proof: StepUpProof): StepUpOutcome = try {
        val response = http.post("${environment.baseUrl}/$VERIFY_PATH") {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(Body.serializer(), encode(proof)))
        }
        verifyOutcome(response.status.value, response.bodyAsText(), proof)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (upgrade: UpgradeRequiredException) {
        StepUpOutcome.Failed(StepUpFailure.UpgradeRequired)
    } catch (offline: IOException) {
        StepUpOutcome.Failed(StepUpFailure.Offline)
    }

    companion object {
        const val VERIFY_PATH = "api/auth/step-up"
        const val OPTIONS_PATH = "api/auth/step-up/options"
        const val EMAIL_SEND_PATH = "api/auth/step-up/email/send"
        private const val FAILED_CODE = "step_up_failed"
        private const val UNAVAILABLE_CODE = "step_up_unavailable"

        @Serializable
        private data class Verified(val stepUpUntil: String? = null)

        @Serializable
        private data class FailureEnvelope(
            val error: String? = null,
            val code: String? = null,
            val attemptsRemaining: Int? = null,
        )

        private fun encode(proof: StepUpProof) = when (proof) {
            is StepUpProof.Password -> Body(method = StepUpMethod.PASSWORD.wire, password = proof.password)
            is StepUpProof.Totp -> Body(method = StepUpMethod.TOTP.wire, code = proof.code)
            is StepUpProof.Email -> Body(method = StepUpMethod.EMAIL.wire, code = proof.code, pendingToken = proof.pendingToken)
        }

        /** Maps one answer of `POST /api/auth/step-up`. Twin of apps/ios StepUpWire.verifyResult. */
        fun verifyOutcome(status: Int, body: String, proof: StepUpProof): StepUpOutcome {
            val envelope = runCatching { B4MClientJson.decodeFromString(FailureEnvelope.serializer(), body) }.getOrNull()
            val failure = when (status) {
                200 -> {
                    val verified = runCatching { B4MClientJson.decodeFromString(Verified.serializer(), body) }.getOrNull()
                    return StepUpOutcome.Verified(verified?.stepUpUntil?.let(::parseInstant))
                }
                400 -> when {
                    envelope?.code != FAILED_CODE -> StepUpFailure.Server(status)
                    // Only a password failure ends the session; for a code, zero means "ask for a new one".
                    proof is StepUpProof.Password && envelope.attemptsRemaining == 0 -> StepUpFailure.SessionEnded
                    else -> StepUpFailure.Rejected(envelope.error?.trim()?.ifEmpty { null }, envelope.attemptsRemaining)
                }
                401 -> StepUpFailure.SessionEnded
                403 -> if (envelope?.code == UNAVAILABLE_CODE) StepUpFailure.SessionEnded else StepUpFailure.Server(status)
                423, 429 -> StepUpFailure.RateLimited
                else -> StepUpFailure.Server(status)
            }
            return StepUpOutcome.Failed(failure)
        }
    }
}
