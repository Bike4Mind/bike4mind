package com.bike4mind.kit.obligations

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.capture.CaptureRejectedException
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import java.math.BigDecimal
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Serializable
data class ObligationAmount(val value: Double, val currency: String)

@Serializable
data class ObligationDestination(@SerialName("lake_id") val lakeId: String, val name: String)

/** What the assistant read off a handed-off document (obligations.contract.ts). [summary] is model-written. */
@Serializable
data class Obligation(
    val id: String,
    val status: String = "pending",
    @SerialName("document_kind") val documentKind: String = "other",
    @SerialName("file_id") val fileId: String,
    val amount: ObligationAmount? = null,
    val payee: String? = null,
    /** `YYYY-MM-DD`, a calendar day with no time zone. */
    @SerialName("due_date") val dueDate: String? = null,
    val destination: ObligationDestination? = null,
    val summary: String = "",
)

/** A lake the user can file into. */
data class LakeOption(val id: String, val name: String)

/**
 * A correction to an obligation. A field left [Unchanged] is not sent; [Set] with `null` clears it.
 */
sealed interface PatchField<out T> {
    data object Unchanged : PatchField<Nothing>
    data class Set<T>(val value: T?) : PatchField<T>
}

data class ObligationPatch(
    val amount: PatchField<Pair<BigDecimal, String>> = PatchField.Unchanged,
    val payee: PatchField<String> = PatchField.Unchanged,
    val dueDate: PatchField<String> = PatchField.Unchanged,
    val destinationLakeId: PatchField<String> = PatchField.Unchanged,
    val status: String? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        val amount = amount
        if (amount is PatchField.Set) {
            put(
                "amount",
                amount.value?.let { (value, currency) ->
                    buildJsonObject {
                        put("value", JsonPrimitive(value))
                        put("currency", currency)
                    }
                } ?: JsonNull,
            )
        }
        field("payee", payee)
        field("due_date", dueDate)
        field("destination_lake_id", destinationLakeId)
        status?.let { put("status", it) }
    }

    private fun JsonObjectBuilder.field(key: String, field: PatchField<String>) {
        if (field is PatchField.Set) put(key, field.value?.let { JsonPrimitive(it) } ?: JsonNull)
    }
}

/** The upload is still being checked (HTTP 409 on hand-off); retrying shortly succeeds. */
class StillCheckingException : Exception("The upload is still being checked")

/** The obligation was dismissed and can no longer change (HTTP 409 on update). */
class ObligationDismissedException : Exception("The obligation was dismissed")

interface ObligationsApi {
    /** Idempotent per file: a second call returns the obligation the first one made, without a new charge. */
    suspend fun handOff(fileId: String, text: String?): Obligation
    suspend fun update(id: String, patch: ObligationPatch): Obligation
    /** The user's lakes, without built-in (read-only) ones. */
    suspend fun lakes(): List<LakeOption>
}

/**
 * Hand-written client for obligations.contract.ts (`POST /api/v1/obligations`, `PATCH /api/v1/obligations/{id}`)
 * and dataLakes.contract.ts (`GET /api/v1/data-lakes`, first page only).
 */
class ObligationsWire(private val environment: ServerEnvironment, private val http: HttpClient) : ObligationsApi {
    override suspend fun handOff(fileId: String, text: String?): Obligation {
        val response = http.post("${environment.baseUrl}/api/v1/obligations") {
            contentType(ContentType.Application.Json)
            setBody(
                buildJsonObject {
                    put("file_id", fileId)
                    text?.let { put("text", it) }
                }.toString(),
            )
        }
        if (response.status.value == 409) throw StillCheckingException()
        return obligation(response, setOf(200, 201))
    }

    override suspend fun update(id: String, patch: ObligationPatch): Obligation {
        val response = http.patch("${environment.baseUrl}/api/v1/obligations/$id") {
            contentType(ContentType.Application.Json)
            setBody(patch.toJson().toString())
        }
        if (response.status.value == 409) throw ObligationDismissedException()
        return obligation(response, setOf(200))
    }

    override suspend fun lakes(): List<LakeOption> {
        val response = http.get("${environment.baseUrl}/api/v1/data-lakes") { parameter("limit", 100) }
        val body = response.bodyAsText()
        if (response.status.value != 200) throw ApiException(response.status.value)
        val page = runCatching { B4MClientJson.decodeFromString(LakePage.serializer(), body) }.getOrNull()
            ?: throw ApiException(response.status.value)
        return page.data.filter { it.canManage && !it.builtIn }.map { LakeOption(it.id, it.name) }
    }

    private suspend fun obligation(response: HttpResponse, accepted: Set<Int>): Obligation {
        val status = response.status.value
        val body = response.bodyAsText()
        if (status !in accepted) {
            if (status == 400 || status == 422 || status == 502) {
                val error = runCatching { B4MClientJson.decodeFromString(ErrorReply.serializer(), body) }.getOrNull()
                throw CaptureRejectedException(error?.error)
            }
            throw ApiException(status)
        }
        return runCatching { B4MClientJson.decodeFromString(Obligation.serializer(), body) }.getOrNull()
            ?: throw ApiException(status)
    }

    @Serializable
    private data class ErrorReply(val error: String? = null)

    @Serializable
    private data class Lake(
        val id: String,
        val name: String,
        @SerialName("built_in") val builtIn: Boolean = false,
        @SerialName("can_manage") val canManage: Boolean = false,
    )

    @Serializable
    private data class LakePage(val data: List<Lake> = emptyList())
}
