package com.bike4mind.kit.briefs

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import java.time.Instant
import java.time.format.DateTimeParseException
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException

interface BusyBlocksApi {
    suspend fun state(): BusyBlocksState

    /** Replaces the stored blocks; `enabled = false` also clears them on the server. */
    suspend fun save(enabled: Boolean, blocks: List<BusyBlock>): BusyBlocksState
}

/** A 2xx answer whose body is not a busy-blocks state. */
class MalformedBusyBlocksException(cause: Throwable) : Exception("The server sent busy blocks this build cannot read", cause)

/**
 * Hand-written client for `GET`/`PUT /api/v1/briefs/busy-blocks` (JWT bearer via [http]'s B4MTransport): the
 * operations are not in `client/operations.txt`. Twin of apps/ios BusyBlocksClient.
 */
class BusyBlocksWire(private val environment: ServerEnvironment, private val http: HttpClient) : BusyBlocksApi {
    override suspend fun state(): BusyBlocksState = decode(http.get(url()))

    override suspend fun save(enabled: Boolean, blocks: List<BusyBlock>): BusyBlocksState {
        val body = WirePut(enabled, blocks.map { WireBlock(it.start.toString(), it.end.toString()) })
        val response = http.put(url()) {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(WirePut.serializer(), body))
        }
        return decode(response)
    }

    private suspend fun decode(response: HttpResponse): BusyBlocksState {
        if (!response.status.isSuccess()) throw ApiException(response.status.value)
        return try {
            B4MClientJson.decodeFromString(WireState.serializer(), response.bodyAsText()).toState()
        } catch (malformed: SerializationException) {
            throw MalformedBusyBlocksException(malformed)
        } catch (malformed: IllegalArgumentException) {
            throw MalformedBusyBlocksException(malformed)
        } catch (malformed: DateTimeParseException) {
            throw MalformedBusyBlocksException(malformed)
        }
    }

    private fun url() = environment.baseUrl + "/api/v1/briefs/busy-blocks"
}

@Serializable
private data class WireBlock(val start: String, val end: String)

@Serializable
private data class WirePut(val enabled: Boolean, val blocks: List<WireBlock>)

@Serializable
private data class WireState(val enabled: Boolean, val blocks: List<WireBlock>, val nextBlockBriefAt: String? = null) {
    // Instant.parse takes the server's toISOString() shape and whole seconds alike.
    fun toState() = BusyBlocksState(
        enabled = enabled,
        blocks = blocks.map { BusyBlock(Instant.parse(it.start), Instant.parse(it.end)) },
        nextBlockBriefAt = nextBlockBriefAt?.let(Instant::parse),
    )
}
